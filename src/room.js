import { DurableObject } from 'cloudflare:workers';
import {
  LIMITS, ROOM_TTL_MS, str, points, uniqueName, currentQuestion,
  hostView, playerView, leaderboard,
} from './quiz.js';

// One Durable Object per room code. Sockets use the hibernation API, so the
// object can be evicted between messages; everything that matters lives in
// storage and is reloaded in the constructor.
//
// Storage layout:
//   meta                -> room state (quiz, phase, players, ...)
//   ans:<q>:<playerId>  -> { option, ms } for question q
//
// Socket attachment: { role: 'host' | 'player' | null, playerId }

export class QuizRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    this.answers = new Map(); // answers for the current question only
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('meta')) || null;
      if (this.state && this.state.index >= 0) await this.loadAnswers(this.state.index);
    });
  }

  async loadAnswers(index) {
    const prefix = `ans:${index}:`;
    const rows = await this.ctx.storage.list({ prefix });
    this.answers = new Map([...rows].map(([k, v]) => [k.slice(prefix.length), v]));
  }

  save() {
    this.state.touched = Date.now();
    this.ctx.storage.put('meta', this.state);
  }

  async scheduleAlarm() {
    const s = this.state;
    const at = s.phase === 'question' && s.deadline ? s.deadline + 250 : s.touched + ROOM_TTL_MS;
    await this.ctx.storage.setAlarm(at);
  }

  // ---- RPC from the Worker ----

  async init(code, quiz, joinUrl, qrSvg) {
    if (this.state) return { ok: false, taken: true };
    const hostToken = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.state = {
      code, joinUrl, qrSvg, hostToken, quiz,
      phase: 'lobby', // lobby | question | results | leaderboard | ended
      index: -1, startedAt: 0, deadline: null, players: {}, touched: Date.now(),
    };
    this.save();
    await this.scheduleAlarm();
    return { ok: true, hostToken };
  }

  // ---- WebSocket plumbing ----

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    if (!this.state) {
      // Unknown room: a plain (non-hibernating) socket so the close frame is
      // actually delivered, then nothing is kept.
      server.accept();
      server.send(JSON.stringify({ t: 'error', error: 'No quiz with that code. Check the code and try again.' }));
      server.close(4404, 'room not found');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: null, playerId: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  sockets(exclude) {
    return this.ctx.getWebSockets().filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN);
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket already gone */ }
  }

  broadcast(exclude) {
    const s = this.state;
    const sockets = this.sockets(exclude).map((ws) => [ws, ws.deserializeAttachment() || {}]);
    const connected = new Set(sockets.filter(([, a]) => a.role === 'player').map(([, a]) => a.playerId));
    const board = leaderboard(s);
    let host = null;
    for (const [ws, a] of sockets) {
      if (a.role === 'host') {
        host ??= JSON.stringify({ t: 'state', data: hostView(s, this.answers, connected) });
        try { ws.send(host); } catch { /* gone */ }
      } else if (a.role === 'player' && s.players[a.playerId]) {
        this.send(ws, { t: 'state', data: playerView(s, this.answers, s.players[a.playerId], board) });
      }
    }
  }

  connectedPlayerIds(exclude) {
    const ids = new Set();
    for (const ws of this.sockets(exclude)) {
      const a = ws.deserializeAttachment() || {};
      if (a.role === 'player') ids.add(a.playerId);
    }
    return ids;
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.ev !== 'string') return;
    let res;
    try {
      if (!this.state) throw new Error('This quiz no longer exists.');
      const handler = HANDLERS[msg.ev];
      if (!handler) throw new Error('Unknown action.');
      const att = ws.deserializeAttachment() || {};
      if (msg.ev.startsWith('host:') && msg.ev !== 'host:resume' && att.role !== 'host') {
        throw new Error('Not the presenter of this room.');
      }
      res = { ok: true, ...((await handler.call(this, ws, att, msg.data || {})) || {}) };
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (msg.id !== undefined) this.send(ws, { t: 'ack', id: msg.id, res });
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'closing'); } catch { /* already closed */ }
    const a = ws.deserializeAttachment() || {};
    if (this.state && a.role === 'player') this.broadcast(ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }

  // ---- timers ----

  async alarm() {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    if (s.phase === 'question' && s.deadline && now >= s.deadline) this.closeQuestion();
    if (now - s.touched >= ROOM_TTL_MS) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(4410, 'room expired'); } catch { /* ignore */ } }
      await this.ctx.storage.deleteAll();
      this.state = null;
      return;
    }
    await this.scheduleAlarm();
  }

  // ---- game flow ----

  openQuestion(index) {
    const s = this.state;
    s.index = index;
    s.phase = 'question';
    s.startedAt = Date.now();
    const q = currentQuestion(s);
    s.deadline = q.timeLimit ? s.startedAt + q.timeLimit * 1000 : null;
    for (const p of Object.values(s.players)) { p.lastGain = 0; p.lastCorrect = null; }
    this.answers = new Map();
    this.save();
    this.broadcast();
  }

  closeQuestion() {
    const s = this.state;
    if (s.phase !== 'question') return;
    const q = currentQuestion(s);
    for (const p of Object.values(s.players)) {
      const a = this.answers.get(p.id);
      if (q.correct === null) { p.lastCorrect = null; p.lastGain = 0; continue; }
      p.lastCorrect = !!a && a.option === q.correct;
      p.lastGain = points(p.lastCorrect, a ? a.ms : 0, q.timeLimit);
      p.score += p.lastGain;
    }
    s.phase = 'results';
    s.deadline = null;
    this.save();
    this.broadcast();
  }
}

// Handlers run with `this` bound to the room. Throwing sends { ok:false, error }.
const HANDLERS = {
  async 'host:resume'(ws, att, { hostToken }) {
    if (hostToken !== this.state.hostToken) throw new Error('Session not found.');
    ws.serializeAttachment({ role: 'host', playerId: null });
    this.send(ws, { t: 'state', data: hostView(this.state, this.answers, this.connectedPlayerIds()) });
    return { code: this.state.code };
  },

  async 'host:next'() {
    const s = this.state;
    if (s.phase === 'question') throw new Error('Close voting first.');
    if (s.phase === 'ended') throw new Error('The quiz has ended.');
    if (s.index + 1 >= s.quiz.questions.length) throw new Error('No more questions.');
    this.openQuestion(s.index + 1);
    await this.scheduleAlarm();
  },

  async 'host:close'() {
    if (this.state.phase !== 'question') throw new Error('No question is open.');
    this.closeQuestion();
    await this.scheduleAlarm();
  },

  async 'host:leaderboard'() {
    if (this.state.phase !== 'results') throw new Error('Show results first.');
    this.state.phase = 'leaderboard';
    this.save();
    this.broadcast();
  },

  async 'host:end'() {
    if (this.state.phase === 'question') this.closeQuestion();
    this.state.phase = 'ended';
    this.state.deadline = null;
    this.save();
    this.broadcast();
    await this.scheduleAlarm();
  },

  async 'host:kick'(ws, att, { name }) {
    const s = this.state;
    const victims = Object.values(s.players).filter((p) => p.name === name).map((p) => p.id);
    for (const sock of this.sockets()) {
      const a = sock.deserializeAttachment() || {};
      if (a.role === 'player' && victims.includes(a.playerId)) {
        this.send(sock, { t: 'kicked' });
        sock.serializeAttachment({ role: null, playerId: null });
      }
    }
    for (const id of victims) {
      delete s.players[id];
      this.answers.delete(id);
    }
    this.save();
    this.broadcast();
  },

  async 'player:join'(ws, att, { name, playerId }) {
    const s = this.state;
    const pid = str(playerId, 64);
    let p = pid && s.players[pid];
    if (!p) {
      if (pid && !name) throw new Error('Your earlier seat is gone. Join again.');
      let n = str(name, LIMITS.name).replace(/\s+/g, ' ');
      if (!n) throw new Error('Enter a name.');
      if (s.phase === 'ended') throw new Error('This quiz has already ended.');
      if (Object.keys(s.players).length >= LIMITS.players) throw new Error('This quiz is full.');
      n = uniqueName(n, Object.values(s.players).map((x) => x.name));
      p = { id: crypto.randomUUID(), name: n, score: 0, lastGain: 0, lastCorrect: null };
      s.players[p.id] = p;
      this.save();
    }
    ws.serializeAttachment({ role: 'player', playerId: p.id });
    this.broadcast();
    return { playerId: p.id, name: p.name };
  },

  async 'player:answer'(ws, att, { option, index }) {
    const s = this.state;
    if (att.role !== 'player' || !s.players[att.playerId]) throw new Error('Join the quiz first.');
    if (s.phase !== 'question') throw new Error('Voting is closed.');
    const q = currentQuestion(s);
    if (!Number.isInteger(option) || option < 0 || option >= q.options.length) throw new Error('Invalid option.');
    if (index !== s.index) throw new Error('That question is no longer open.');
    if (this.answers.has(att.playerId)) throw new Error('You already answered.');
    const now = Date.now();
    if (s.deadline && now > s.deadline + 500) throw new Error('Time is up.');
    const a = { option, ms: now - s.startedAt };
    this.answers.set(att.playerId, a);
    this.ctx.storage.put(`ans:${s.index}:${att.playerId}`, a);
    s.touched = now;

    const hostMsg = JSON.stringify({ t: 'answers', data: { answeredCount: this.answers.size, playerCount: Object.keys(s.players).length } });
    const connected = this.connectedPlayerIds();
    for (const sock of this.sockets()) {
      if ((sock.deserializeAttachment() || {}).role === 'host') { try { sock.send(hostMsg); } catch { /* gone */ } }
    }
    // Close early once everyone currently connected has answered.
    if (connected.size > 0 && [...connected].every((id) => this.answers.has(id))) {
      this.closeQuestion();
      await this.scheduleAlarm();
    }
    return { option };
  },
};
