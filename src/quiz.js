// Pure quiz logic shared by the Durable Object and the tests. No I/O here.

export const LIMITS = {
  title: 120, question: 300, option: 120, name: 24,
  questions: 100, minOptions: 2, maxOptions: 6,
  minTime: 5, maxTime: 300, players: 500,
};

export const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // forget rooms idle for 6 hours

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;

export function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function sanitizeQuiz(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Quiz is missing.');
  const title = str(raw.title, LIMITS.title) || 'Untitled quiz';
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    throw new Error('Add at least one question.');
  }
  if (raw.questions.length > LIMITS.questions) {
    throw new Error(`A quiz can have at most ${LIMITS.questions} questions.`);
  }
  const questions = raw.questions.map((q, i) => {
    const text = str(q && q.text, LIMITS.question);
    if (!text) throw new Error(`Question ${i + 1} has no text.`);
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => str(o, LIMITS.option))
      .filter(Boolean);
    if (options.length < LIMITS.minOptions || options.length > LIMITS.maxOptions) {
      throw new Error(`Question ${i + 1} needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} options.`);
    }
    let correct = Number.isInteger(q.correct) ? q.correct : null;
    if (correct !== null && (correct < 0 || correct >= options.length)) correct = null;
    let timeLimit = Number(q.timeLimit);
    timeLimit = Number.isFinite(timeLimit) && timeLimit > 0
      ? Math.min(LIMITS.maxTime, Math.max(LIMITS.minTime, Math.round(timeLimit)))
      : null; // null = no timer, the presenter closes voting by hand
    return { text, options, correct, timeLimit };
  });
  return { title, questions };
}

// 1000 points for a correct answer, scaled down to 500 for the slowest answer
// on a timed question.
export function points(correct, ms, timeLimit) {
  if (!correct) return 0;
  if (!timeLimit) return 1000;
  return Math.round(1000 - 500 * Math.min(1, Math.max(0, ms) / (timeLimit * 1000)));
}

export function uniqueName(name, taken) {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  let n = 2;
  while (lower.has(`${name} ${n}`.toLowerCase())) n++;
  return `${name} ${n}`;
}

// ---- views over room state ----
// state = { code, joinUrl, qrSvg, hostToken, quiz, phase, index, startedAt,
//           deadline, players: {id: {id, name, score, lastGain, lastCorrect}}, touched }
// answers = Map<playerId, {option, ms}> for the current question

export function currentQuestion(state) {
  return state.index >= 0 ? state.quiz.questions[state.index] : null;
}

export function distribution(state, answers) {
  const q = currentQuestion(state);
  if (!q) return [];
  const counts = q.options.map(() => 0);
  for (const a of answers.values()) counts[a.option]++;
  return counts;
}

export function leaderboard(state) {
  return Object.values(state.players)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((p, i) => ({ id: p.id, name: p.name, score: p.score, rank: i + 1 }));
}

export function hostView(state, answers, connected) {
  const q = currentQuestion(state);
  const showResults = state.phase === 'results';
  return {
    role: 'host',
    code: state.code,
    joinUrl: state.joinUrl,
    qrSvg: state.qrSvg,
    title: state.quiz.title,
    phase: state.phase,
    index: state.index,
    total: state.quiz.questions.length,
    question: q && { text: q.text, options: q.options, correct: showResults ? q.correct : null, timeLimit: q.timeLimit },
    deadline: state.deadline,
    serverNow: Date.now(),
    answeredCount: answers.size,
    players: Object.values(state.players).map((p) => ({ name: p.name, connected: connected.has(p.id) })),
    distribution: showResults ? distribution(state, answers) : null,
    leaderboard: ['leaderboard', 'ended', 'results'].includes(state.phase) ? leaderboard(state).slice(0, 10) : null,
  };
}

export function playerView(state, answers, player, board = leaderboard(state)) {
  const q = currentQuestion(state);
  const mine = state.index >= 0 ? answers.get(player.id) : undefined;
  const me = board.find((p) => p.id === player.id);
  const showResults = state.phase === 'results';
  return {
    role: 'player',
    code: state.code,
    title: state.quiz.title,
    name: player.name,
    score: player.score,
    rank: me ? me.rank : null,
    playerCount: board.length,
    phase: state.phase,
    index: state.index,
    total: state.quiz.questions.length,
    question: q && { text: q.text, options: q.options, correct: showResults ? q.correct : null },
    deadline: state.deadline,
    serverNow: Date.now(),
    myAnswer: mine ? mine.option : null,
    lastGain: showResults ? player.lastGain : 0,
    lastCorrect: showResults ? player.lastCorrect : null,
    distribution: showResults ? distribution(state, answers) : null,
    podium: state.phase === 'ended' ? board.slice(0, 3).map(({ name, score }) => ({ name, score })) : null,
  };
}
