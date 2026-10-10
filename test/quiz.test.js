import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeQuiz, points, uniqueName, newRoomCode, CODE_RE,
  hostView, playerView, leaderboard,
} from '../src/quiz.js';

test('sanitizeQuiz rejects bad input and clamps values', () => {
  assert.throws(() => sanitizeQuiz(null), /missing/);
  assert.throws(() => sanitizeQuiz({ questions: [] }), /at least one/);
  assert.throws(() => sanitizeQuiz({ questions: [{ text: 'x', options: ['only'] }] }), /2 to 6/);
  assert.throws(() => sanitizeQuiz({ questions: [{ text: 'x', options: ['1', '2', '3', '4', '5', '6', '7'] }] }), /2 to 6/);
  assert.throws(() => sanitizeQuiz({ questions: [{ text: '  ', options: ['a', 'b'] }] }), /no text/);
  const q = sanitizeQuiz({ questions: [{ text: ' x ', options: ['a', ' ', 'b'], correct: 9, timeLimit: 9999 }] });
  assert.equal(q.title, 'Untitled quiz');
  assert.deepEqual(q.questions[0], { text: 'x', options: ['a', 'b'], correct: null, timeLimit: 300 });
  assert.equal(sanitizeQuiz({ questions: [{ text: 'x', options: ['a', 'b'], timeLimit: 1 }] }).questions[0].timeLimit, 5);
  assert.equal(sanitizeQuiz({ questions: [{ text: 'x', options: ['a', 'b'], timeLimit: 0 }] }).questions[0].timeLimit, null);
});

test('points reward correct and fast answers', () => {
  assert.equal(points(false, 100, 20), 0);
  assert.equal(points(true, 0, null), 1000);
  assert.equal(points(true, 0, 20), 1000);
  assert.equal(points(true, 10000, 20), 750);
  assert.equal(points(true, 99999, 20), 500);
});

test('uniqueName adds a suffix, ignoring case', () => {
  assert.equal(uniqueName('Sam', []), 'Sam');
  assert.equal(uniqueName('sam', ['Sam']), 'sam 2');
  assert.equal(uniqueName('Sam', ['Sam', 'sam 2']), 'Sam 3');
});

test('room codes are 5 unambiguous characters', () => {
  for (let i = 0; i < 200; i++) assert.match(newRoomCode(), CODE_RE);
  assert.ok(!CODE_RE.test('ABCD0'), 'zero is excluded');
  assert.ok(!CODE_RE.test('ABCDI'), 'I is excluded');
});

test('views hide the answer while voting and reveal it after', () => {
  const state = {
    code: 'ABCDE', joinUrl: 'https://x/play?code=ABCDE', qrSvg: '<svg/>', hostToken: 't',
    quiz: { title: 'T', questions: [{ text: 'Q', options: ['a', 'b'], correct: 1, timeLimit: null }] },
    phase: 'question', index: 0, startedAt: 0, deadline: null,
    players: {
      p1: { id: 'p1', name: 'Ana', score: 0, lastGain: 0, lastCorrect: null },
      p2: { id: 'p2', name: 'Ben', score: 0, lastGain: 0, lastCorrect: null },
    },
  };
  const answers = new Map([['p1', { option: 1, ms: 5 }]]);
  let hv = hostView(state, answers, new Set(['p1']));
  assert.equal(hv.question.correct, null);
  assert.equal(hv.distribution, null);
  assert.equal(hv.answeredCount, 1);
  assert.deepEqual(hv.players, [{ name: 'Ana', connected: true }, { name: 'Ben', connected: false }]);
  assert.equal(playerView(state, answers, state.players.p1).question.correct, null);
  assert.equal(playerView(state, answers, state.players.p1).myAnswer, 1);
  assert.equal(hv.qrSvg, '<svg/>');
  assert.ok(!('hostToken' in hv), 'host token must never be sent back');

  state.phase = 'results';
  state.players.p1.score = 1000;
  hv = hostView(state, answers, new Set());
  assert.equal(hv.question.correct, 1);
  assert.deepEqual(hv.distribution, [0, 1]);
  assert.deepEqual(leaderboard(state).map((r) => r.name), ['Ana', 'Ben']);
  assert.equal(playerView(state, answers, state.players.p2).rank, 2);
});
