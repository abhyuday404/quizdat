'use strict';
// Shared between presenter and phone pages.
const SHAPES = ['▲', '◆', '●', '■', '★', '⬢'];

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function store(kind, key, value) {
  try {
    const s = kind === 'session' ? sessionStorage : localStorage;
    if (value === undefined) return s.getItem(key);
    if (value === null) s.removeItem(key); else s.setItem(key, value);
  } catch { /* private mode etc. */ }
  return null;
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// Countdown that tolerates clock drift between phone/laptop and server.
function makeCountdown(onTick) {
  let handle = null;
  return {
    start(deadline, serverNow) {
      this.stop();
      if (!deadline) { onTick(null); return; }
      const offset = serverNow - Date.now();
      const tick = () => {
        const left = Math.max(0, Math.ceil((deadline - (Date.now() + offset)) / 1000));
        onTick(left);
        if (left <= 0) this.stop();
      };
      tick();
      handle = setInterval(tick, 250);
    },
    stop() { if (handle) clearInterval(handle); handle = null; },
  };
}

function renderBars(question, counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  const hasCorrect = question.correct !== null && question.correct !== undefined;
  const rows = question.options.map((opt, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    const right = hasCorrect && i === question.correct;
    const fill = el('div', { class: `bar-fill o${i}` });
    const row = el('div', { class: `bar-row ${hasCorrect ? (right ? 'right' : 'wrong') : ''}` },
      el('div', { class: 'bar-label' },
        el('span', { class: `shape o${i}`, text: SHAPES[i] }),
        el('span', { text: opt }),
        right ? el('span', { class: 'check', text: '✓' }) : null),
      el('div', { class: 'bar-track' }, fill),
      el('div', { class: 'bar-num' }, String(counts[i]), el('small', { text: `${pct}%` })));
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${(counts[i] / max) * 100}%`; }));
    return row;
  });
  return el('div', { class: 'bars' }, rows);
}

// replaceChildren() would print "null"/"false" for skipped parts; drop them.
function setChildren(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}
