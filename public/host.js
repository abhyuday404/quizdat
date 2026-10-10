'use strict';
/* global connectRoom, el, store, toast, makeCountdown, renderBars, setChildren, SHAPES */

const DRAFT_KEY = 'qrquiz.draft';
const SESSION_KEY = 'qrquiz.hostSession';
const TIME_CHOICES = [[null, 'No timer'], [10, '10 s'], [20, '20 s'], [30, '30 s'], [45, '45 s'], [60, '60 s'], [90, '90 s'], [120, '2 min']];

const SAMPLE = {
  title: 'Warm-up trivia',
  questions: [
    { text: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Mercury'], correct: 1, timeLimit: 20 },
    { text: 'What does “HTTP” stand for?', options: ['HyperText Transfer Protocol', 'High Transfer Text Process', 'Hyperlink Text Transport Program', 'Home Tool Transfer Protocol'], correct: 0, timeLimit: 20 },
    { text: 'How many sides does a hexagon have?', options: ['5', '6', '7', '8'], correct: 1, timeLimit: 15 },
    { text: 'Which one do you prefer?', options: ['Tea', 'Coffee', 'Neither'], correct: null, timeLimit: null },
  ],
};

const blankQuestion = () => ({ text: '', options: ['', '', '', ''], correct: null, timeLimit: 20 });

let quiz = loadDraft();
let state = null;
let socket = null; // connection to the current room, if any

// ---------------- editor ----------------

function loadDraft() {
  try {
    const d = JSON.parse(store('local', DRAFT_KEY));
    if (d && Array.isArray(d.questions) && d.questions.length) return d;
  } catch { /* ignore */ }
  return JSON.parse(JSON.stringify(SAMPLE));
}
const saveDraft = () => store('local', DRAFT_KEY, JSON.stringify(quiz));

function renderEditor() {
  document.getElementById('quizTitle').value = quiz.title || '';
  const list = document.getElementById('questions');
  list.replaceChildren(...quiz.questions.map((q, qi) => questionCard(q, qi)));
}

function questionCard(q, qi) {
  const changed = () => saveDraft();
  const structural = () => { saveDraft(); renderEditor(); };

  const optionRows = q.options.map((opt, oi) =>
    el('div', { class: 'opt-row' },
      el('div', { class: `swatch o${oi}`, text: SHAPES[oi] }),
      el('input', {
        value: opt, maxlength: 120, placeholder: `Option ${oi + 1}`,
        oninput: (e) => { q.options[oi] = e.target.value; changed(); },
      }),
      el('div', { class: 'row', style: 'gap:6px' },
        el('label', { class: 'correct-toggle' },
          el('input', {
            type: 'checkbox', checked: q.correct === oi,
            onchange: (e) => { q.correct = e.target.checked ? oi : null; structural(); },
          }), 'correct'),
        el('button', {
          class: 'ghost icon', title: 'Remove option', disabled: q.options.length <= 2,
          onclick: () => {
            q.options.splice(oi, 1);
            if (q.correct === oi) q.correct = null; else if (q.correct > oi) q.correct--;
            structural();
          },
        }, '✕'))));

  const timeSelect = el('select', {
    onchange: (e) => { q.timeLimit = e.target.value ? Number(e.target.value) : null; changed(); },
  }, TIME_CHOICES.map(([v, label]) => el('option', { value: v ?? '', selected: (q.timeLimit ?? null) === v }, label)));

  return el('div', { class: 'card qcard' },
    el('div', { class: 'qhead' },
      el('span', { class: 'qnum', text: `Q${qi + 1}` }),
      el('span', { class: 'qkind', text: q.correct === null ? 'Poll' : 'Scored' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost icon', title: 'Move up', disabled: qi === 0, onclick: () => { quiz.questions.splice(qi - 1, 0, quiz.questions.splice(qi, 1)[0]); structural(); } }, '↑'),
      el('button', { class: 'ghost icon', title: 'Move down', disabled: qi === quiz.questions.length - 1, onclick: () => { quiz.questions.splice(qi + 1, 0, quiz.questions.splice(qi, 1)[0]); structural(); } }, '↓'),
      el('button', { class: 'ghost icon', title: 'Duplicate', onclick: () => { quiz.questions.splice(qi + 1, 0, JSON.parse(JSON.stringify(q))); structural(); } }, '⧉'),
      el('button', { class: 'danger icon', title: 'Delete question', disabled: quiz.questions.length <= 1, onclick: () => { quiz.questions.splice(qi, 1); structural(); } }, '🗑')),
    el('textarea', {
      maxlength: 300, rows: 2, placeholder: 'Type the question…',
      oninput: (e) => { q.text = e.target.value; changed(); },
    }, q.text),
    optionRows,
    el('div', { class: 'qfoot' },
      el('button', { class: 'ghost', disabled: q.options.length >= 6, onclick: () => { q.options.push(''); structural(); } }, '+ Option'),
      el('span', { class: 'spacer' }),
      el('label', { class: 'small', style: 'margin:0' }, '⏱ Time limit'),
      timeSelect));
}

function validateQuiz() {
  for (const [i, q] of quiz.questions.entries()) {
    if (!q.text.trim()) return `Question ${i + 1} has no text.`;
    const filled = q.options.filter((o) => o.trim());
    if (filled.length < 2) return `Question ${i + 1} needs at least two options.`;
    if (filled.length !== q.options.length) return `Question ${i + 1} has an empty option. Fill it in or remove it.`;
  }
  return null;
}

function wireEditor() {
  document.getElementById('quizTitle').addEventListener('input', (e) => { quiz.title = e.target.value; saveDraft(); });
  document.getElementById('addQuestion').addEventListener('click', () => {
    quiz.questions.push(blankQuestion()); saveDraft(); renderEditor();
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  });
  document.getElementById('loadSample').addEventListener('click', () => {
    quiz = JSON.parse(JSON.stringify(SAMPLE)); saveDraft(); renderEditor();
  });
  document.getElementById('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(quiz, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${(quiz.title || 'quiz').replace(/[^\w-]+/g, '_')}.json` });
    document.body.append(a); a.click(); a.remove();
  });
  const fileInput = document.getElementById('importFile');
  document.getElementById('importBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.questions) || !d.questions.length) throw new Error('No questions in file.');
      quiz = {
        title: String(d.title || ''),
        questions: d.questions.map((q) => ({
          text: String(q.text || ''),
          options: (Array.isArray(q.options) ? q.options : []).slice(0, 6).map(String),
          correct: Number.isInteger(q.correct) ? q.correct : null,
          timeLimit: Number(q.timeLimit) > 0 ? Number(q.timeLimit) : null,
        })),
      };
      while (quiz.questions.some((q) => q.options.length < 2)) quiz.questions.find((q) => q.options.length < 2).options.push('');
      saveDraft(); renderEditor();
      toast(`Imported ${quiz.questions.length} questions.`);
    } catch (e) {
      toast(`Import failed: ${e.message}`);
    }
  });
  document.getElementById('startSession').addEventListener('click', () => {
    const err = validateQuiz();
    const errEl = document.getElementById('editorError');
    errEl.textContent = err || '';
    if (err) return;
    const btn = document.getElementById('startSession');
    btn.disabled = true;
    createRoom()
      .then((res) => {
        const session = { code: res.code, hostToken: res.hostToken };
        store('session', SESSION_KEY, JSON.stringify(session));
        attach(session);
      })
      .catch((e) => { errEl.textContent = e.message; })
      .finally(() => { btn.disabled = false; });
  });
}

// ---------------- live stage ----------------

const countdown = makeCountdown((left) => {
  const t = document.getElementById('timer');
  if (!t) return;
  t.textContent = left === null ? '∞' : String(left);
  t.classList.toggle('low', left !== null && left <= 5);
});

function showEditor() {
  state = null;
  countdown.stop();
  document.getElementById('stage').classList.add('hidden');
  document.getElementById('editor').classList.remove('hidden');
  renderEditor();
}

function send(event) {
  if (!socket) return;
  socket.emit(event, {}, (res) => { if (res && !res.ok) toast(res.error); });
}

function renderStage(s) {
  state = s;
  document.getElementById('editor').classList.add('hidden');
  document.getElementById('stage').classList.remove('hidden');
  document.getElementById('quizTitlePill').textContent = s.title;
  document.getElementById('codePill').textContent = s.code;
  document.getElementById('countPill').textContent = `${s.players.length} ${s.players.length === 1 ? 'player' : 'players'}`;

  const main = document.getElementById('stageMain');
  const primary = document.getElementById('primaryBtn');
  const secondary = document.getElementById('secondaryBtn');
  const hint = document.getElementById('hint');
  const miniQr = document.getElementById('miniQr');
  secondary.classList.add('hidden');
  primary.classList.remove('hidden');
  primary.disabled = false;
  miniQr.classList.toggle('hidden', s.phase === 'lobby' || s.phase === 'ended');
  if (!miniQr.dataset.code || miniQr.dataset.code !== s.code) {
    miniQr.innerHTML = s.qrSvg; // server-generated SVG, no user content
    miniQr.append(el('div', { text: s.code }));
    miniQr.dataset.code = s.code;
  }
  const isLast = s.index >= s.total - 1;
  const nextLabel = isLast ? 'Final results' : (s.index < 0 ? 'Start quiz' : 'Next question');
  const nextAction = isLast && s.index >= 0 ? 'host:end' : 'host:next';
  countdown.stop();

  if (s.phase === 'lobby') {
    const qr = el('div', { class: 'qr-box' });
    qr.innerHTML = s.qrSvg;
    setChildren(main, el('div', { class: 'lobby' },
      qr,
      el('div', { class: 'join-info' },
        el('div', { class: 'step', text: 'Scan the code, or open' }),
        el('div', { class: 'url', text: s.joinUrl.replace(/\?code=.*/, '') }),
        el('div', { class: 'step', text: 'and enter the room code' }),
        el('div', { class: 'code', text: s.code }),
        el('h3', {}, `${s.players.length} joined`),
        s.players.length === 0 ? el('div', { class: 'muted', text: 'Waiting for players…' }) : null,
        el('div', { class: 'players' }, s.players.map((p) => playerChip(p))))));
    primary.textContent = 'Start quiz';
    primary.disabled = s.total === 0;
    primary.dataset.action = 'host:next';
    hint.innerHTML = 'Click a name to remove a player · <span class="kbd">Space</span> next · <span class="kbd">F</span> full screen';
  } else if (s.phase === 'question') {
    const q = s.question;
    setChildren(main, 
      el('div', { class: 'timer', id: 'timer' }),
      el('div', { class: 'q-meta' },
        el('span', { class: 'pill', text: `Question ${s.index + 1} of ${s.total}` }),
        el('span', { class: 'pill', id: 'answered', text: `${s.answeredCount} of ${s.players.length} answered` })),
      el('h2', { class: 'q-title', text: q.text }),
      el('div', { class: 'opt-grid' }, q.options.map((o, i) =>
        el('div', { class: `opt-tile o${i}` }, el('span', { class: 'shape', text: SHAPES[i] }), el('span', { text: o })))));
    countdown.start(s.deadline, s.serverNow);
    primary.textContent = 'Show results';
    primary.dataset.action = 'host:close';
    hint.textContent = q.timeLimit ? 'Voting closes when the timer ends or everyone has answered.' : 'Voting closes when everyone has answered, or when you close it.';
  } else if (s.phase === 'results') {
    const q = s.question;
    setChildren(main, 
      el('div', { class: 'q-meta' },
        el('span', { class: 'pill', text: `Question ${s.index + 1} of ${s.total}` }),
        el('span', { class: 'pill', text: `${s.distribution.reduce((a, b) => a + b, 0)} of ${s.players.length} answered` }),
        q.correct === null ? el('span', { class: 'pill', text: 'Poll' }) : null),
      el('h2', { class: 'q-title', text: q.text }),
      renderBars(q, s.distribution));
    primary.textContent = nextLabel;
    primary.dataset.action = nextAction;
    if (s.leaderboard && s.leaderboard.some((p) => p.score > 0) && !isLast) {
      secondary.classList.remove('hidden');
      secondary.textContent = 'Leaderboard';
      secondary.dataset.action = 'host:leaderboard';
    }
    hint.innerHTML = '<span class="kbd">Space</span> next';
  } else if (s.phase === 'leaderboard') {
    setChildren(main, el('h2', { class: 'q-title', text: 'Leaderboard' }), board(s.leaderboard));
    primary.textContent = nextLabel;
    primary.dataset.action = nextAction;
    hint.innerHTML = '<span class="kbd">Space</span> next';
  } else if (s.phase === 'ended') {
    const anyScore = s.leaderboard && s.leaderboard.some((p) => p.score > 0);
    setChildren(main, 
      el('h2', { class: 'q-title', text: anyScore ? 'Final results' : 'Thanks for taking part' }),
      anyScore ? board(s.leaderboard) : el('p', { class: 'center muted', text: `${s.players.length} people took part.` }));
    primary.textContent = 'New quiz';
    primary.dataset.action = 'new';
    hint.textContent = '';
  }
  document.getElementById('endBtn').classList.toggle('hidden', s.phase === 'ended');
}

function playerChip(p) {
  const chip = el('span', { class: `player-chip ${p.connected ? '' : 'off'}`, title: 'Click to remove', text: p.name });
  let armed = false;
  chip.addEventListener('click', () => {
    if (!armed) {
      armed = true; chip.textContent = `Remove ${p.name}?`;
      setTimeout(() => { armed = false; chip.textContent = p.name; }, 2500);
      return;
    }
    if (socket) socket.emit('host:kick', { name: p.name }, (res) => { if (res && !res.ok) toast(res.error); });
  });
  return chip;
}

function board(rows) {
  if (!rows || !rows.length) return el('p', { class: 'center muted', text: 'No players yet.' });
  return el('div', { class: 'board' }, rows.map((r, i) =>
    el('div', { class: `board-row r${r.rank}`, style: `animation-delay:${i * 60}ms` },
      el('span', { class: 'rank', text: `#${r.rank}` }),
      el('span', { text: r.name }),
      el('span', { text: r.score.toLocaleString() }))));
}

function runAction(action) {
  if (!action) return;
  if (action === 'new') { detach(); showEditor(); return; }
  send(action);
}

function wireStage() {
  document.getElementById('primaryBtn').addEventListener('click', (e) => runAction(e.currentTarget.dataset.action));
  document.getElementById('secondaryBtn').addEventListener('click', (e) => runAction(e.currentTarget.dataset.action));
  const endBtn = document.getElementById('endBtn');
  let armed = null;
  endBtn.addEventListener('click', () => {
    if (!armed) {
      endBtn.textContent = 'Click again to end';
      armed = setTimeout(() => { armed = null; endBtn.textContent = 'End quiz'; }, 3000);
      return;
    }
    clearTimeout(armed); armed = null; endBtn.textContent = 'End quiz';
    send('host:end');
  });
  document.getElementById('fullscreenBtn').addEventListener('click', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if (!state || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      const p = document.getElementById('primaryBtn');
      if (!p.disabled && !p.classList.contains('hidden')) runAction(p.dataset.action);
    } else if (e.key === 'f' || e.key === 'F') {
      toggleFullscreen();
    }
  });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

// ---------------- connection ----------------

async function createRoom() {
  let res;
  try {
    res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quiz }),
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'Could not start the session.');
  return data;
}

function attach(session) {
  detach(false);
  socket = connectRoom(session.code);
  socket.on('connect', () => {
    // Runs again after every reconnect, which re-authenticates as presenter.
    socket.emit('host:resume', { hostToken: session.hostToken }, (res) => {
      if (res && !res.ok && res.error !== 'Connection lost.') { detach(); showEditor(); toast(res.error); }
    });
  });
  socket.on('state', renderStage);
  socket.on('answers', ({ answeredCount, playerCount }) => {
    const a = document.getElementById('answered');
    if (a) a.textContent = `${answeredCount} of ${playerCount} answered`;
  });
  socket.on('disconnect', () => toast('Connection lost. Reconnecting…'));
  socket.on('gone', () => { detach(); showEditor(); toast('That session has expired.'); });
}

function detach(forget = true) {
  if (socket) socket.close();
  socket = null;
  if (forget) store('session', SESSION_KEY, null);
}

wireEditor();
wireStage();
{
  // Re-attach to a running session after a refresh.
  let saved = null;
  try { saved = JSON.parse(store('session', SESSION_KEY)); } catch { /* ignore */ }
  if (saved && saved.code && saved.hostToken) attach(saved); else showEditor();
}
