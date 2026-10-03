// Calculator lock (Settings > Privacy). When it's on, ForYou opens to an ordinary, working calculator.
// Typing your code and pressing = shows ForYou (the sign-in page, or your chats if you're signed in),
// and ForYou goes back to the calculator the moment you leave it: another app, the home screen, another
// tab, the screen turning off, or closing it. Even a second away is enough.
//
// The code never leaves this device and is never stored as itself: only a random salt and a PBKDF2
// (SHA-256) hash of it are kept, so reading the browser's storage doesn't reveal it. Checking a code is
// slow on purpose, and it only happens when = is pressed on a plain 4 to 12 digit number.
import { androidSetPrivacyScreen } from './android.js';

const KEY = 'fy_cl';
const ITERATIONS = 200000;
const CALC_ICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2b2b2e"/>'
  + '<rect x="12" y="10" width="40" height="14" rx="3" fill="#9fd3a6"/>'
  + '<g fill="#d4d4d2"><circle cx="18" cy="34" r="4"/><circle cx="32" cy="34" r="4"/><circle cx="18" cy="48" r="4"/><circle cx="32" cy="48" r="4"/></g>'
  + '<g fill="#ff9f0a"><circle cx="46" cy="34" r="4"/><circle cx="46" cy="48" r="4"/></g></svg>');

let locked = false;
let lockEl = null;
let saved = null; // the page's own title, icon and theme colour while the calculator stands in for them

// ------------------------------------------------------------------ the stored code
function record() {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || 'null');
    return r && r.salt && r.hash && r.iter ? r : null;
  } catch { return null; }
}

export const calcLockOn = () => !!record();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(code, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, 256);
}

export const validCode = (code) => /^\d{4,12}$/.test(code);

/** Turns the lock on (or changes the code). Resolves true once it's saved. */
export async function setCalcCode(code) {
  if (!validCode(code) || !crypto.subtle) return false;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(code, salt, ITERATIONS);
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, salt: toB64(salt), iter: ITERATIONS, hash: toB64(hash) }));
  } catch { return false; }
  androidSetPrivacyScreen(true);
  return true;
}

export function turnOffCalcLock() {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable: nothing was saved */ }
  androidSetPrivacyScreen(false);
}

async function codeMatches(code) {
  const r = record();
  if (!r || !validCode(code) || !crypto.subtle) return false;
  try {
    const got = new Uint8Array(await derive(code, fromB64(r.salt), r.iter));
    const want = fromB64(r.hash);
    if (got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
    return diff === 0;
  } catch { return false; }
}

// ------------------------------------------------------------------ locking and unlocking
/** Once, before anything else is drawn: lock now if the lock is on, and lock again whenever ForYou is left. */
export function initCalcLock() {
  const relock = () => { if (calcLockOn()) lock(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') relock(); });
  window.addEventListener('pagehide', relock);
  window.addEventListener('pageshow', (e) => { if (e.persisted) relock(); });
  window.__foryouLock = relock; // the Android app calls this as soon as it goes out of sight
  if (calcLockOn()) {
    androidSetPrivacyScreen(true);
    lock();
  }
}

function setPageLooks(title, icon, theme) {
  document.title = title;
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = icon;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme;
}

function lock() {
  if (locked) { reset(); return; }
  locked = true;
  if (!saved) {
    saved = {
      title: document.title,
      icon: (document.querySelector('link[rel="icon"]') || {}).href || '',
      theme: (document.querySelector('meta[name="theme-color"]') || {}).content || '',
    };
  }
  setPageLooks('Calculator', CALC_ICON, '#000000');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  document.body.classList.add('calc-locked');
  [...document.body.children].forEach((el) => { if (el.id !== 'calc-lock') el.inert = true; });
  if (!lockEl) build();
  lockEl.hidden = false;
  reset();
  document.addEventListener('keydown', onKey, true);
}

function unlock() {
  locked = false;
  document.removeEventListener('keydown', onKey, true);
  lockEl.hidden = true;
  reset();
  document.body.classList.remove('calc-locked');
  [...document.body.children].forEach((el) => { el.inert = false; });
  if (saved) setPageLooks(saved.title, saved.icon, saved.theme);
}

// ------------------------------------------------------------------ the calculator
const KEYS = [
  ['AC', 'fn'], ['⌫', 'fn'], ['%', 'fn'], ['÷', 'op'],
  ['7'], ['8'], ['9'], ['×', 'op'],
  ['4'], ['5'], ['6'], ['−', 'op'],
  ['1'], ['2'], ['3'], ['+', 'op'],
  ['±', 'fn'], ['0'], ['.'], ['=', 'op eq'],
];

let tokens = [];    // numbers and operators entered so far, e.g. [12, '+', 7, '×']
let entry = '';     // the number being typed
let typed = '';     // the keys behind that number exactly as pressed (so a code may start with 0)
let line = '';      // the small line above the result
let fresh = false;  // the big number is a result: a digit starts a new sum, an operator carries on with it

function build() {
  lockEl = document.createElement('div');
  lockEl.id = 'calc-lock';
  lockEl.className = 'calc';
  lockEl.setAttribute('role', 'application');
  lockEl.setAttribute('aria-label', 'Calculator');
  lockEl.innerHTML = `
    <div class="calc-screen">
      <div class="calc-line" id="calc-line"></div>
      <div class="calc-main" id="calc-main" aria-live="polite">0</div>
    </div>
    <div class="calc-keys">
      ${KEYS.map(([k, kind = 'num']) => `<button type="button" class="calc-key ${kind}" data-k="${k}">${k}</button>`).join('')}
    </div>`;
  lockEl.querySelectorAll('.calc-key').forEach((b) => b.addEventListener('click', () => press(b.dataset.k)));
  document.body.appendChild(lockEl);
}

function reset() {
  tokens = []; entry = ''; typed = ''; line = ''; fresh = false;
  paint();
}

function onKey(e) {
  if (!locked) return;
  const map = { '*': '×', x: '×', '/': '÷', '-': '−', '+': '+', '%': '%', '.': '.', ',': '.', Enter: '=', '=': '=', Backspace: '⌫', Escape: 'AC', Delete: 'AC' };
  const k = /^\d$/.test(e.key) ? e.key : map[e.key];
  if (!k) return;
  e.preventDefault();
  e.stopPropagation();
  press(k);
}

function press(k) {
  if (/^\d$/.test(k)) return digit(k);
  if (k === '.') return dot();
  if (k === 'AC') return clear();
  if (k === '⌫') return back();
  if (k === '±') return sign();
  if (k === '%') return percent();
  if (k === '=') return equals();
  return operator(k);
}

/** C clears the number being typed; AC (shown when there's nothing to clear) clears everything. */
function clear() {
  if (entry !== '' && !fresh) { entry = ''; typed = ''; paint(); } else reset();
}

function startFresh() {
  if (fresh) { tokens = []; entry = ''; typed = ''; line = ''; fresh = false; }
}

function digit(d) {
  startFresh();
  if (entry.replace(/[-.]/g, '').length >= 15) return;
  entry = entry === '0' ? d : entry === '-0' ? '-' + d : entry + d;
  typed += d;
  paint();
}

function dot() {
  startFresh();
  if (entry.includes('.')) return;
  entry = entry === '' || entry === '-' ? (entry || '') + '0.' : entry + '.';
  typed += '.';
  paint();
}

function back() {
  if (fresh) return;
  entry = entry.slice(0, -1);
  if (entry === '-') entry = '';
  typed = typed.slice(0, -1);
  paint();
}

function sign() {
  if (entry === '' || entry === 'Error') return;
  entry = entry.startsWith('-') ? entry.slice(1) : '-' + entry;
  typed = 'x'; // no longer just a typed number
  paint();
}

function percent() {
  if (entry === '' || entry === 'Error') return;
  entry = format(Number(entry) / 100, true);
  typed = 'x';
  paint();
}

function operator(op) {
  if (entry === 'Error') return;
  fresh = false;
  if (entry === '' || entry === '-') {
    if (tokens.length && typeof tokens[tokens.length - 1] === 'string') tokens[tokens.length - 1] = op;
    else if (!tokens.length) tokens = [0, op];
  } else {
    tokens.push(Number(entry), op);
  }
  entry = ''; typed = '';
  line = tokens.map(show).join(' ');
  paint();
}

function equals() {
  // The code, typed on its own and followed by =, opens ForYou. Anything else is just a sum. The check
  // runs alongside, so the calculator answers straight away like any other and never stops for it.
  if (!tokens.length && /^\d{4,12}$/.test(typed)) {
    codeMatches(typed).then((ok) => { if (ok && locked) unlock(); }).catch(() => {});
  }
  if (entry === 'Error') return reset();
  let list = tokens.slice();
  if (entry !== '' && entry !== '-') list.push(Number(entry));
  else if (typeof list[list.length - 1] === 'string') list.pop();
  if (!list.length) return;
  const result = evaluate(list);
  line = list.map(show).join(' ') + ' =';
  tokens = []; typed = ''; fresh = true;
  entry = Number.isFinite(result) ? format(result, true) : 'Error';
  paint();
}

/** × and ÷ before + and −, left to right, the way a phone calculator does it. */
function evaluate(list) {
  const nums = [list[0]];
  const ops = [];
  for (let i = 1; i < list.length; i += 2) {
    const op = list[i], n = list[i + 1];
    if (op === '×') nums[nums.length - 1] *= n;
    else if (op === '÷') nums[nums.length - 1] = n === 0 ? NaN : nums[nums.length - 1] / n;
    else { ops.push(op); nums.push(n); }
  }
  let total = nums[0];
  ops.forEach((op, i) => { total = op === '+' ? total + nums[i + 1] : total - nums[i + 1]; });
  return total;
}

/** A tidy number: no floating point noise (0.1 + 0.2 = 0.3), and very large or small ones in e-notation. */
function format(n, raw = false) {
  if (!Number.isFinite(n)) return 'Error';
  let v = Number.parseFloat(n.toPrecision(12));
  if (Object.is(v, -0)) v = 0;
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) return v.toExponential(8).replace(/\.?0+e/, 'e');
  return raw ? String(v) : group(String(v));
}

/** 1234567.5 shown as 1,234,567.5 */
function group(s) {
  if (s === 'Error' || /e/.test(s)) return s;
  const neg = s.startsWith('-');
  const [int, dec] = (neg ? s.slice(1) : s).split('.');
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + withCommas + (dec !== undefined ? '.' + dec : '');
}

const show = (t) => (typeof t === 'number' ? group(format(t, true)) : t);

function paint() {
  if (!lockEl) return;
  const main = entry === '' ? (tokens.length ? group(format(tokens[tokens.length - 2], true)) : '0') : group(entry);
  const mainEl = lockEl.querySelector('#calc-main');
  mainEl.textContent = main;
  mainEl.classList.toggle('small', main.length > 9);
  mainEl.classList.toggle('smaller', main.length > 13);
  lockEl.querySelector('#calc-line').textContent = line;
  lockEl.querySelector('[data-k="AC"]').textContent = entry !== '' && !fresh ? 'C' : 'AC';
}
