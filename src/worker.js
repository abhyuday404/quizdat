import QRCode from 'qrcode';
import { CODE_RE, newRoomCode, sanitizeQuiz } from './quiz.js';

export { QuizRoom } from './room.js';

const MAX_BODY = 512 * 1024;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function createRoom(request, env) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ ok: false, error: 'Quiz is too large.' }, 413);
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ ok: false, error: 'Quiz is too large.' }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'Invalid request.' }, 400);
  }
  let quiz;
  try {
    quiz = sanitizeQuiz(body && body.quiz);
  } catch (e) {
    return json({ ok: false, error: e.message }, 400);
  }
  // Phones are sent to whatever host the presenter used, unless overridden.
  const base = (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/+$/, '');
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newRoomCode();
    const joinUrl = `${base}/play?code=${code}`;
    const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    const res = await env.ROOMS.get(env.ROOMS.idFromName(code)).init(code, quiz, joinUrl, qrSvg);
    if (res.ok) return json({ ok: true, code, hostToken: res.hostToken });
  }
  return json({ ok: false, error: 'Could not allocate a room code. Try again.' }, 503);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (!CODE_RE.test(code)) return new Response('Bad room code.', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade.', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }

    if (url.pathname === '/api/rooms') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
      return createRoom(request, env);
    }

    if (url.pathname === '/healthz') return json({ ok: true });

    return env.ASSETS.fetch(request);
  },
};
