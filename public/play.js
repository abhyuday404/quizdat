'use strict';
/* global connectRoom, el, store, toast, makeCountdown, renderBars, setChildren, SHAPES */

const params = new URLSearchParams(location.search);
const form = document.getElementById('joinForm');
const codeInput = document.getElementById('code');
const nameInput = document.getElementById('name');
const joinError = document.getElementById('joinError');
const view = document.getElementById('view');
const whoPill = document.getElementById('whoPill');

let code = (params.get('code') || '').toUpperCase();
let joined = false;
let state = null;
let pendingAnswer = null; // option chosen but not yet confirmed by the server
let socket = null; // connection to the room in `code`
let wantedName = ''; // name typed in the form, used for the first join

const playerKey = (c) => `quizdat.player.${c}`;

const ANIME_NAMES = [
  'Naruto', 'Sasuke', 'Sakura', 'Kakashi', 'Itachi', 'Hinata', 'Shikamaru', 'Gaara',
  'Goku', 'Vegeta', 'Gohan', 'Bulma', 'Piccolo', 'Trunks',
  'Luffy', 'Zoro', 'Nami', 'Sanji', 'Robin', 'Chopper', 'Usopp', 'Franky', 'Brook', 'Ace',
  'Ichigo', 'Rukia', 'Light', 'L', 'Ryuk', 'Misa',
  'Eren', 'Mikasa', 'Armin', 'Levi', 'Erwin', 'Hange', 'Sasha', 'Jean',
  'Edward', 'Alphonse', 'Winry', 'Mustang', 'Hawkeye',
  'Saitama', 'Genos', 'Tatsumaki', 'Mob', 'Reigen',
  'Tanjiro', 'Nezuko', 'Zenitsu', 'Inosuke', 'Giyu', 'Shinobu', 'Rengoku',
  'Gojo', 'Megumi', 'Nobara', 'Yuji', 'Nanami', 'Sukuna',
  'Deku', 'Bakugo', 'Todoroki', 'Ochaco', 'Iida', 'Kirishima',
  'Spike', 'Faye', 'Jet', 'Ed', 'Asuka', 'Rei', 'Shinji', 'Misato',
  'Killua', 'Gon', 'Kurapika', 'Leorio', 'Hisoka', 'Lelouch', 'Kallen', 'Suzaku',
  'Kirito', 'Asuna', 'Totoro', 'Chihiro', 'Haku', 'Howl', 'Sophie', 'Kiki', 'Ponyo', 'Nausicaa',
  'Rem', 'Emilia', 'Subaru', 'Saber', 'Rin', 'Shirou', 'Yato', 'Hiyori',
  'Senku', 'Chika', 'Kaguya', 'Anya', 'Loid', 'Yor', 'Bond',
  'Denji', 'Power', 'Makima', 'Aki', 'Thorfinn', 'Askeladd',
  'Violet', 'Rimuru', 'Ainz', 'Kaneki', 'Touka', 'Yusuke', 'Kurama', 'Hiei',
  'Inuyasha', 'Kagome', 'Usagi', 'Sailor Mars', 'Vash', 'Alucard', 'Guts', 'Griffith',
  'Lucy', 'Natsu', 'Erza', 'Gray', 'Yugi', 'Kaiba', 'Ash', 'Misty', 'Brock',
  'Astro Boy', 'Akira', 'Kaneda', 'Tetsuo', 'Motoko', 'Batou', 'Hanako', 'Nagisa',
  'Frieren', 'Fern', 'Stark', 'Himmel', 'Marcille', 'Laios', 'Senshi', 'Chilchuck',
];
const randomName = () => ANIME_NAMES[Math.floor(Math.random() * ANIME_NAMES.length)];

const countdown = makeCountdown((left) => {
  const t = document.getElementById('ptimer');
  if (t) t.textContent = left === null ? '' : `⏱ ${left}s`;
});

function showForm() {
  joined = false;
  whoPill.classList.add('hidden');
  setChildren(view, );
  form.classList.remove('hidden');
  codeInput.value = code;
  nameInput.value = randomName();
  (code ? nameInput : codeInput).focus();
}

const btn = document.getElementById('joinBtn');

// Join (or rejoin) on the current connection: with the saved seat if we have
// one, otherwise with the name from the form.
function join() {
  const saved = store('local', playerKey(code));
  const payload = saved ? { playerId: saved } : { name: wantedName };
  if (!saved && !wantedName) { showForm(); return; }
  joinError.textContent = '';
  btn.disabled = true;
  socket.emit('player:join', payload, (res) => {
    btn.disabled = false;
    if (!res || !res.ok) {
      const err = (res && res.error) || 'Could not join.';
      if (err === 'Connection lost.') return; // the reconnect will retry
      if (saved) { store('local', playerKey(code), null); if (wantedName) { join(); return; } }
      showForm();
      joinError.textContent = saved ? '' : err;
      return;
    }
    joined = true;
    store('local', playerKey(code), res.playerId);
    history.replaceState(null, '', `/play?code=${code}`);
    form.classList.add('hidden');
  });
}

function connect(c) {
  if (socket && socket.code === c) { if (socket.connected) join(); return; }
  if (socket) socket.close();
  code = c;
  joined = false;
  btn.disabled = true;
  socket = connectRoom(c);
  socket.on('connect', join);
  socket.on('state', (s) => { pendingAnswer = null; render(s); });
  socket.on('kicked', onKicked);
  socket.on('disconnect', () => { if (joined) toast('Connection lost. Reconnecting…'); });
  socket.on('roomerror', (msg) => {
    store('local', playerKey(c), null);
    socket = null;
    btn.disabled = false;
    showForm();
    joinError.textContent = msg;
  });
  socket.on('gone', (why) => {
    if (why === 4410) { socket = null; joined = false; showForm(); joinError.textContent = 'That quiz has expired.'; }
  });
}

document.getElementById('shuffleName').addEventListener('click', () => { nameInput.value = randomName(); nameInput.focus(); });

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const c = codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const n = nameInput.value.trim();
  if (!c) { joinError.textContent = 'Enter the room code.'; return; }
  if (!/^[A-HJ-NP-Z2-9]{5}$/.test(c)) { joinError.textContent = 'Room codes are 5 letters and numbers.'; return; }
  if (!n) { joinError.textContent = 'Enter your name.'; return; }
  wantedName = n;
  connect(c);
});

function answer(option) {
  if (!state || state.phase !== 'question' || state.myAnswer !== null || pendingAnswer !== null) return;
  pendingAnswer = option;
  render(state);
  if (navigator.vibrate) navigator.vibrate(30);
  socket.emit('player:answer', { option, index: state.index }, (res) => {
    if (res && res.ok) { state.myAnswer = option; } else { toast((res && res.error) || 'Answer not saved.'); }
    pendingAnswer = null;
    render(state);
  });
}

function render(s) {
  state = s;
  whoPill.textContent = `${s.name} · ${s.score.toLocaleString()} pts`;
  whoPill.classList.remove('hidden');
  countdown.stop();
  const chosen = s.myAnswer ?? pendingAnswer;

  if (s.phase === 'lobby') {
    setChildren(view, el('div', { class: 'center' },
      el('h1', { text: "You're in" }),
      el('div', { class: 'spinner' })));
  } else if (s.phase === 'question') {
    const q = s.question;
    setChildren(view, 
      el('div', { class: 'row' },
        el('span', { class: 'pill', text: `Q ${s.index + 1}/${s.total}` }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'pill', id: 'ptimer' })),
      el('h2', { text: q.text }),
      el('div', { class: 'answer-grid' }, q.options.map((o, i) =>
        el('button', {
          class: `answer-btn o${i} ${chosen === i ? 'chosen' : ''} ${chosen !== null && chosen !== i ? 'dim' : ''}`,
          disabled: chosen !== null && chosen !== i,
          onclick: () => answer(i),
        }, el('span', { class: 'shape', text: SHAPES[i] }), el('span', { text: o })))),
      chosen !== null
        ? el('p', { class: 'center status', text: s.myAnswer !== null ? 'Locked in' : 'Sending…' })
        : null);
    countdown.start(s.deadline, s.serverNow);
  } else if (s.phase === 'results') {
    const q = s.question;
    let headline;
    if (q.correct === null) {
      headline = el('div', { class: 'center' },
        el('h1', { text: s.myAnswer === null ? 'No vote' : 'Vote counted' }));
    } else if (s.lastCorrect) {
      headline = el('div', { class: 'center' },
        el('h1', { class: 'result-good', text: 'Correct' }),
        el('p', { class: 'mono', text: `+${s.lastGain}` }));
    } else {
      headline = el('div', { class: 'center' },
        el('h1', { class: 'result-bad', text: s.myAnswer === null ? "Time's up" : 'Not quite' }),
        el('p', { class: 'muted' }, 'Answer: ', el('strong', { text: q.options[q.correct] })));
    }
    setChildren(view, headline, renderBars(q, s.distribution), scoreBox(s));
  } else if (s.phase === 'leaderboard') {
    setChildren(view, el('div', { class: 'center' },
      el('h1', { text: `#${s.rank}` })), scoreBox(s));
  } else if (s.phase === 'ended') {
    const scored = s.podium && s.podium.some((p) => p.score > 0);
    setChildren(view, el('div', { class: 'center' },
      el('h1', { text: 'Quiz over' }),
      scored ? el('p', { class: 'status', text: `#${s.rank} of ${s.playerCount}` }) : null),
    scored ? el('div', { class: 'board' }, s.podium.map((p, i) =>
      el('div', { class: `board-row r${i + 1}` },
        el('span', { class: 'rank', text: `#${i + 1}` }),
        el('span', { text: p.name }),
        el('span', { text: p.score.toLocaleString() })))) : null);
  }
}

function scoreBox(s) {
  return el('div', { class: 'score-box' },
    el('span', { class: 'pill', text: `${s.score.toLocaleString()} pts` }),
    s.rank ? el('span', { class: 'pill', text: `Rank #${s.rank} of ${s.playerCount}` }) : null);
}

function onKicked() {
  store('local', playerKey(code), null);
  joined = false;
  wantedName = '';
  whoPill.classList.add('hidden');
  setChildren(view, el('div', { class: 'center' },
    el('h1', { text: 'Removed by the host' }),
    el('button', { class: 'primary', onclick: showForm }, 'Join again')));
}

// Opening the QR link again (or refreshing) puts you back in your seat.
if (code && store('local', playerKey(code))) connect(code); else showForm();
