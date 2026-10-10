// Boots `wrangler dev` and plays a full session over real WebSockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PORT = 8800 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let dev;
const clients = [];

test.before(async () => {
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', `.wrangler/test-${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
  });
  let log = '';
  dev.stdout.on('data', (d) => { log += d; });
  dev.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${log}`);
});

test.after(async () => {
  clients.forEach((c) => c.close());
  dev.kill('SIGTERM');
  const { rmSync } = await import('node:fs');
  rmSync(`.wrangler/test-${PORT}`, { recursive: true, force: true });
});

// Minimal client speaking the same protocol as public/net.js.
function client(code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?code=${code}`);
    const c = { ws, last: null, waiters: [], pending: new Map(), seq: 0, events: [] };
    c.call = (ev, data = {}) => new Promise((r) => { const id = ++c.seq; c.pending.set(id, r); ws.send(JSON.stringify({ id, ev, data })); });
    c.close = () => { try { ws.close(); } catch { /* ignore */ } };
    c.waitState = (pred, ms = 4000) => {
      if (c.last && pred(c.last)) return Promise.resolve(c.last);
      return new Promise((res, rej) => {
        const w = { pred, res };
        c.waiters.push(w);
        setTimeout(() => { c.waiters = c.waiters.filter((x) => x !== w); rej(new Error(`timeout, last phase ${c.last && c.last.phase}`)); }, ms);
      });
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') { c.events.push('pong'); return; }
      const m = JSON.parse(e.data);
      c.events.push(m.t);
      if (m.t === 'ack') { const r = c.pending.get(m.id); c.pending.delete(m.id); if (r) r(m.res); }
      if (m.t === 'error') c.error = m.error;
      if (m.t === 'state') {
        c.last = m.data;
        c.waiters = c.waiters.filter((w) => { if (w.pred(m.data)) { w.res(m.data); return false; } return true; });
      }
    };
    ws.onclose = (e) => { c.closeCode = e.code; };
    ws.onopen = () => resolve(c);
    ws.onerror = () => reject(new Error('socket error'));
    clients.push(c);
  });
}

async function createRoom(quiz) {
  const res = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quiz, origin: BASE }) });
  return { status: res.status, body: await res.json() };
}

const QUIZ = {
  title: 'Test quiz',
  questions: [
    { text: 'Q1?', options: ['A', 'B', 'C'], correct: 1, timeLimit: null },
    { text: 'Poll?', options: ['Yes', 'No'], correct: null, timeLimit: null },
    { text: 'Timed?', options: ['X', 'Y'], correct: 0, timeLimit: 5 },
  ],
};

test('HTTP: pages, 404, bad requests', async () => {
  for (const p of ['/', '/host', '/play', '/style.css', '/net.js', '/common.js', '/healthz']) {
    assert.equal((await fetch(BASE + p)).status, 200, p);
  }
  assert.equal((await fetch(`${BASE}/missing-page`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/rooms`)).status, 405);
  assert.equal((await fetch(`${BASE}/ws?code=bad`)).status, 400);
  assert.equal((await fetch(`${BASE}/ws?code=ABCDE`)).status, 426);
  const bad = await createRoom({ questions: [] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /at least one/);
});

test('unknown room code is refused over the socket', async () => {
  const c = await client('ZZZZZ');
  await new Promise((r) => setTimeout(r, 300));
  assert.match(c.error, /No quiz/);
  assert.equal(c.closeCode, 4404);
});

test('full session: join, answer, distribution, scoring, reconnect, timer, kick, end', async () => {
  const { body: room } = await createRoom(QUIZ);
  assert.ok(room.ok, room.error);
  const { code, hostToken } = room;

  const intruder = await client(code);
  assert.equal((await intruder.call('host:resume', { hostToken: 'nope' })).ok, false);
  assert.match((await intruder.call('host:next')).error, /Not the presenter/);

  const host = await client(code);
  assert.ok((await host.call('host:resume', { hostToken })).ok);
  let hs = await host.waitState((s) => s.phase === 'lobby');
  assert.equal(hs.joinUrl, `${BASE}/play?code=${code}`);
  assert.match(hs.qrSvg, /^<svg/);

  const [p1, p2, p3] = await Promise.all([client(code), client(code), client(code)]);
  const j1 = await p1.call('player:join', { name: 'Ana' });
  const j2 = await p2.call('player:join', { name: 'Ben' });
  const j3 = await p3.call('player:join', { name: 'ana' });
  assert.ok(j1.ok && j2.ok && j3.ok);
  assert.equal(j3.name, 'ana 2');
  await host.waitState((s) => s.players.length === 3);

  // Keep-alive pings are answered without a round trip through the room.
  p1.ws.send('ping');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(p1.events.includes('pong'));

  // Q1: scored, untimed. The presenter closes before p3 answers.
  assert.ok((await host.call('host:next')).ok);
  const q1 = await p1.waitState((s) => s.phase === 'question' && s.index === 0);
  assert.equal(q1.question.correct, null, 'answer must not leak while voting');
  assert.ok((await p1.call('player:answer', { option: 1, index: 0 })).ok);
  assert.match((await p1.call('player:answer', { option: 0, index: 0 })).error, /already/);
  assert.match((await p2.call('player:answer', { option: 9, index: 0 })).error, /Invalid/);
  assert.ok((await p2.call('player:answer', { option: 1, index: 0 })).ok);
  assert.ok((await host.call('host:close')).ok);
  hs = await host.waitState((s) => s.phase === 'results' && s.index === 0);
  assert.deepEqual(hs.distribution, [0, 2, 0]);
  assert.equal(hs.question.correct, 1);
  const r1 = await p1.waitState((s) => s.phase === 'results');
  assert.equal(r1.lastGain, 1000);
  assert.deepEqual(r1.distribution, [0, 2, 0]);
  assert.equal((await p3.waitState((s) => s.phase === 'results')).lastCorrect, false);
  assert.match((await p3.call('player:answer', { option: 1, index: 0 })).error, /closed/);

  assert.ok((await host.call('host:leaderboard')).ok);
  hs = await host.waitState((s) => s.phase === 'leaderboard');
  assert.deepEqual(hs.leaderboard.map((r) => r.score), [1000, 1000, 0]);

  // Q2: poll. Closes by itself once everyone has answered.
  assert.ok((await host.call('host:next')).ok);
  await p1.waitState((s) => s.phase === 'question' && s.index === 1);
  assert.match((await p1.call('player:answer', { option: 0, index: 0 })).error, /no longer open/);
  await p1.call('player:answer', { option: 0, index: 1 });
  await p2.call('player:answer', { option: 1, index: 1 });
  await p3.call('player:answer', { option: 0, index: 1 });
  hs = await host.waitState((s) => s.phase === 'results' && s.index === 1);
  assert.deepEqual(hs.distribution, [2, 1]);
  assert.equal((await p2.waitState((s) => s.phase === 'results' && s.index === 1)).score, 1000);

  // A player reconnects with their saved id and keeps their score.
  p2.close();
  await host.waitState((s) => s.players.some((p) => p.name === 'Ben' && !p.connected));
  const p2b = await client(code);
  const back = await p2b.call('player:join', { playerId: j2.playerId });
  assert.equal(back.name, 'Ben');
  assert.equal((await p2b.waitState(() => true)).score, 1000);
  assert.match((await (await client(code)).call('player:join', { playerId: 'gone' })).error, /seat is gone/);

  // The presenter refreshes and resumes.
  const host2 = await client(code);
  assert.ok((await host2.call('host:resume', { hostToken })).ok);
  await host2.waitState((s) => s.phase === 'results' && s.index === 1);

  // Q3: timed. One answer, then the alarm closes voting.
  assert.ok((await host2.call('host:next')).ok);
  const q3 = await p1.waitState((s) => s.phase === 'question' && s.index === 2);
  assert.ok(q3.deadline > q3.serverNow);
  await p1.call('player:answer', { option: 0, index: 2 });
  const r3 = await p1.waitState((s) => s.phase === 'results' && s.index === 2, 9000);
  assert.ok(r3.lastGain > 500 && r3.lastGain <= 1000, `speed bonus ${r3.lastGain}`);
  assert.match((await host2.call('host:next')).error, /No more/);

  // Kick, then end.
  assert.ok((await host2.call('host:kick', { name: 'ana 2' })).ok);
  await host2.waitState((s) => s.players.length === 2);
  assert.ok(p3.events.includes('kicked'));
  assert.ok((await host2.call('host:end')).ok);
  const end = await p1.waitState((s) => s.phase === 'ended');
  assert.equal(end.rank, 1);
  assert.equal(end.podium[0].name, 'Ana');
  assert.match((await (await client(code)).call('player:join', { name: 'Late' })).error, /ended/);
});
