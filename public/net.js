'use strict';
// Tiny Socket.IO-style client over a plain WebSocket to one room's Durable Object.
//   const room = connectRoom('ABCDE');
//   room.on('state', fn); room.emit('player:join', {...}, (res) => ...);
// Events: connect, disconnect, state, answers, kicked, roomerror(msg), gone(code)
function connectRoom(code) {
  const listeners = {};
  const pending = new Map();
  let ws = null;
  let seq = 0;
  let retry = 0;
  let retryTimer = null;
  let pingTimer = null;
  let isOpen = false;
  let closedByUser = false;
  let gone = false;

  const fire = (ev, ...args) => (listeners[ev] || []).forEach((fn) => fn(...args));

  function open() {
    clearTimeout(retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?code=${encodeURIComponent(code)}`);
    ws.onopen = () => {
      isOpen = true;
      retry = 0;
      fire('connect');
      // The server answers "ping" without waking the room; keeps NATs and proxies happy.
      pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 25000);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'ack') {
        const cb = pending.get(m.id);
        pending.delete(m.id);
        if (cb) cb(m.res);
      } else if (m.t === 'state') fire('state', m.data);
      else if (m.t === 'answers') fire('answers', m.data);
      else if (m.t === 'kicked') fire('kicked');
      else if (m.t === 'error') fire('roomerror', m.error);
    };
    ws.onclose = (e) => {
      clearInterval(pingTimer);
      const wasOpen = isOpen;
      isOpen = false;
      for (const cb of pending.values()) cb({ ok: false, error: 'Connection lost.' });
      pending.clear();
      if (wasOpen) fire('disconnect');
      if (closedByUser) return;
      if (e.code === 4404 || e.code === 4410) { gone = true; fire('gone', e.code); return; }
      const delay = Math.min(10000, 500 * 2 ** retry++) + Math.random() * 300;
      retryTimer = setTimeout(open, delay);
    };
  }

  // Phones drop sockets when the screen locks; reconnect as soon as they're back.
  const wake = () => {
    if (!closedByUser && !gone && !document.hidden && ws && ws.readyState === WebSocket.CLOSED) open();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);

  open();

  return {
    code,
    on(ev, fn) { (listeners[ev] ||= []).push(fn); return this; },
    emit(ev, data, cb) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (cb) cb({ ok: false, error: 'Not connected yet. Trying again…' });
        return;
      }
      const id = ++seq;
      if (cb) pending.set(id, cb);
      ws.send(JSON.stringify({ id, ev, data }));
    },
    close() {
      closedByUser = true;
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      if (ws) ws.close(1000, 'bye');
    },
    get connected() { return isOpen; },
  };
}
