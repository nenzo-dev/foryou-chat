// Small, framework-free helpers shared across the app. Trimmed from MindCare's own util.js down to
// the parts that have nothing therapy- or booking-specific about them.

export const cx = (...a) => a.flat().filter(Boolean).join(' ');

export function uid() {
  if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export const nowIso = () => new Date().toISOString();

export function randomToken(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function debounce(fn, ms = 80) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const groupBy = (arr, keyFn) => arr.reduce((m, x) => { (m[keyFn(x)] ||= []).push(x); return m; }, {});
export const uniq = (arr) => [...new Set(arr)];
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

export function initials(name = '') {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

export function userTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

const fmt = (ms, tz, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(new Date(ms));
export const fmtDate = (ms, tz) => fmt(ms, tz, { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtDateShort = (ms, tz) => fmt(ms, tz, { day: 'numeric', month: 'short', year: 'numeric' });
export const fmtTime = (ms, tz) => fmt(ms, tz, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s/g, ' ').toLowerCase();
export const fmtDateTime = (ms, tz) => `${fmtDate(ms, tz)}, ${fmtTime(ms, tz)}`;

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return fmtDateShort(ms, userTimezone());
}

export function duration(secs) {
  const s = Math.max(0, Math.floor(secs));
  const pad2 = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ':' : '') + pad2(m) + ':' + pad2(r);
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e || '');

export function passwordProblem(pw) {
  if (!pw || pw.length < 8) return 'Use at least 8 characters.';
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Include at least one letter and one number.';
  return '';
}

export function baseUrl() {
  return location.href.split('#')[0];
}

// Only a plain hex colour is used in a style attribute; anything else falls back. (avatar_color is free
// text a person sets on their own profile, and ring payloads come from whoever sends them.)
export const cssColor = (c, fallback = '#F5C400') => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : fallback);

// A stable colour for a user's avatar circle, picked from their own id so it never changes.
export function pickColor(seed = '') {
  const colors = ['#F5C400', '#e0473c', '#2ea6a1', '#8a5cf6', '#f2823c', '#3b82c4', '#d94f8c', '#57a648'];
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return colors[h % colors.length];
}
