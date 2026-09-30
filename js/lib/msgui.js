// Shared message-thread rendering and interactions for js/views/chat.js and js/views/room.js: bubbles
// grouped by sender, day separators, edited/deleted states, replies, reactions, photos, voice notes,
// swipe-to-reply and the long-press message menu. Kept in one file so the two views never drift into
// two near-identical, easy-to-break copies of the same code.
import { attachmentUrl } from './db.js';
import { escapeHtml, fmtTime, userTimezone, formatBytes, pickColor } from './util.js';
import { isEmojiOnly } from './emoji.js';
import { ICON } from './icons.js';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const GROUP_GAP_MS = 5 * 60 * 1000;
const TZ = userTimezone();

// Short one-line description of a message, for reply quotes and the reply/edit bar.
export function previewText(m) {
  if (!m) return '';
  if (m.deleted_at) return 'Message deleted';
  if (m.body) return m.body;
  const t = (m.attachment && m.attachment.type) || '';
  if (t.startsWith('audio/')) return 'Voice message';
  if (t.startsWith('image/')) return 'Photo';
  return m.attachment ? (m.attachment.name || 'Attachment') : '';
}

export function dayLabel(iso) {
  const d = new Date(iso), now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

// Plain text with web links made clickable. Escapes everything else.
export function richText(body) {
  const re = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
  let out = '', last = 0;
  for (const m of String(body).matchAll(re)) {
    out += escapeHtml(body.slice(last, m.index));
    out += `<a href="${escapeHtml(m[0])}" target="_blank" rel="noopener noreferrer">${escapeHtml(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(body.slice(last));
}

/*
  opts:
    me          the signed-in person's id
    reactions   { messageId: [{ user_id, emoji }] }
    hidden      Set of message ids this person deleted for themselves
    fresh       Set of message ids that just arrived (they animate in)
    nameFor     (userId) => display name
    avatarFor   (userId) => avatar html (groups only)
    group       true in a group: sender names and avatars on incoming messages
    ticks       true in a DM: sent/read ticks on your own messages
*/
export function renderThread(messages, opts) {
  const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
  const shown = messages.filter((m) => !opts.hidden.has(m.id));
  let html = '', lastDay = '';
  for (let i = 0; i < shown.length; i++) {
    const m = shown[i], prev = shown[i - 1], next = shown[i + 1];
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay) { html += `<div class="day-sep"><span>${escapeHtml(dayLabel(m.created_at))}</span></div>`; lastDay = day; }
    html += renderMessage(m, { ...opts, byId, first: !joins(prev, m), last: !joins(m, next) });
  }
  return html;
}

function joins(a, b) {
  if (!a || !b || a.sender_id !== b.sender_id) return false;
  const ta = new Date(a.created_at), tb = new Date(b.created_at);
  return ta.toDateString() === tb.toDateString() && tb - ta < GROUP_GAP_MS;
}

function renderMessage(m, o) {
  const mine = m.sender_id === o.me;
  const deleted = !!m.deleted_at;
  const emojiOnly = !deleted && !m.attachment && isEmojiOnly(m.body);
  const onlyImage = !deleted && !m.body && m.attachment && (m.attachment.type || '').startsWith('image/') && !m.reply_to_id;
  const cls = ['msg-row', mine ? 'out' : 'in', o.first && 'first', o.last && 'last', emojiOnly && 'msg-emoji-only',
    deleted && 'deleted', onlyImage && 'only-image', o.fresh && o.fresh.has(m.id) && 'fresh'].filter(Boolean).join(' ');

  let inner = '';
  if (o.group && !mine && o.first) inner += `<span class="sender" style="color:${pickColor(m.sender_id)}">${escapeHtml(o.nameFor(m.sender_id))}</span>`;
  if (deleted) {
    inner += `<span class="deleted-note">${ICON.ban}<span>${mine ? 'You deleted this message' : 'This message was deleted'}</span></span>`;
  } else {
    if (m.sent_by_ai) inner += '<span class="ai-badge">Auto-reply</span>';
    if (m.reply_to_id) inner += renderReplyQuote(o.byId[m.reply_to_id], o);
    if (m.attachment) inner += renderAttachment(m.attachment, m.id);
    if (m.body) inner += `<span class="text">${richText(m.body)}</span>`;
  }
  const time = fmtTime(new Date(m.created_at).getTime(), TZ);
  const meta = `<span class="meta">${m.edited_at && !deleted ? '<span class="edited">edited</span>' : ''}<time>${time}</time>${o.ticks && mine && !deleted ? renderTicks(m) : ''}</span>`;
  const avatar = o.group && !mine ? `<div class="msg-avatar">${o.last ? o.avatarFor(m.sender_id) : ''}</div>` : '';
  return `<div class="${cls}" data-msg-id="${escapeHtml(m.id)}">${avatar}<div class="bubble-wrap"><span class="swipe-reply-icon">${ICON.reply}</span><div class="bubble">${inner}${meta}</div>${deleted ? '' : `<button class="msg-more" type="button" aria-label="Message options">${ICON.more}</button>${renderReactionChips(o.reactions[m.id], o.me)}`}</div></div>`;
}

export function renderTicks(m) {
  return `<span class="msg-tick${m.read_at ? ' read' : ''}" title="${m.read_at ? 'Read' : 'Sent'}">${m.read_at
    ? '<svg viewBox="0 0 24 24" fill="none"><path d="m2.5 12.5 4 4L15 8M10.5 15.5l1 1L20 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none"><path d="m6 12.5 4 4L18.5 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'}</span>`;
}

function renderReplyQuote(original, o) {
  if (!original) return '<span class="msg-reply-quote missing"><span class="rq-body">Earlier message</span></span>';
  const who = original.sender_id === o.me ? 'You' : o.nameFor(original.sender_id);
  const t = (original.attachment && original.attachment.type) || '';
  const icon = original.deleted_at ? ICON.ban : t.startsWith('audio/') ? ICON.mic : t.startsWith('image/') ? ICON.attach : '';
  return `<span class="msg-reply-quote" data-reply-jump="${escapeHtml(original.id)}"><span class="rq-name" style="color:${original.sender_id === o.me ? 'var(--gold)' : pickColor(original.sender_id)}">${escapeHtml(who)}</span><span class="rq-body">${icon ? `<i class="rq-ic">${icon}</i>` : ''}${escapeHtml(previewText(original))}</span></span>`;
}

export function renderReactionChips(list, myId) {
  if (!list || !list.length) return '';
  const byEmoji = {};
  for (const r of list) (byEmoji[r.emoji] ||= []).push(r.user_id);
  const chips = Object.entries(byEmoji).map(([emoji, users]) =>
    `<button type="button" class="reaction-chip${users.includes(myId) ? ' mine' : ''}" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)}${users.length > 1 ? `<span class="n">${users.length}</span>` : ''}</button>`
  ).join('');
  return `<div class="msg-reactions">${chips}</div>`;
}

function renderAttachment(att, msgId) {
  if (!att || !att.path) return '';
  const path = escapeHtml(att.path);
  if (att.type && att.type.startsWith('image/')) {
    const ratio = att.w > 0 && att.h > 0 ? Math.min(1.8, Math.max(0.6, att.w / att.h)).toFixed(3) : '1.333';
    return `<span class="msg-img-wrap" style="aspect-ratio:${ratio}"><img class="msg-img" data-attach-path="${path}" alt="${escapeHtml(att.name || 'Photo')}" loading="lazy"></span>`;
  }
  if (att.type && att.type.startsWith('audio/')) {
    const peaks = Array.isArray(att.peaks) && att.peaks.length ? att.peaks : Array(28).fill(0.3);
    const bars = peaks.map((v) => `<i style="height:${Math.round(Math.min(1, Math.max(0.08, v)) * 22) + 4}px"></i>`).join('');
    return `<span class="voice-msg" data-voice="${escapeHtml(msgId)}"><button class="vplay" type="button" aria-label="Play voice message">${ICON.play}</button><span class="vbars">${bars}</span><span class="vtime">${att.duration ? fmtSecs(att.duration) : ''}</span><span data-attach-path="${path}" hidden></span></span>`;
  }
  return `<a class="msg-file" data-attach-path="${path}" href="#"><span class="file-ic">${ICON.file}</span><span class="file-meta"><span class="file-name">${escapeHtml(att.name || 'File')}</span>${att.size ? `<span class="file-size">${formatBytes(att.size)}</span>` : ''}</span></a>`;
}

const fmtSecs = (s) => { const n = Math.max(0, Math.round(s)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };

// Signed URLs for private attachments, kept for most of their hour so repainting a thread doesn't
// ask the server again for every photo in it.
const urlCache = new Map();
async function signedUrl(path) {
  const hit = urlCache.get(path);
  if (hit && hit.until > Date.now()) return hit.url;
  const url = await attachmentUrl(path, 3600);
  urlCache.set(path, { url, until: Date.now() + 50 * 60 * 1000 });
  return url;
}

// Fills in photo/file/voice URLs and wires their clicks. Call after every paint of a thread.
export function hydrateThread(container) {
  container.querySelectorAll('[data-attach-path]').forEach((el) => {
    const path = el.dataset.attachPath;
    signedUrl(path).then((url) => {
      if (el.tagName === 'IMG') { el.src = url; el.addEventListener('load', () => el.parentElement.classList.add('loaded'), { once: true }); }
      else el.dataset.url = url;
    }).catch(() => { if (el.tagName === 'IMG') el.parentElement.classList.add('failed'); });
  });
  container.querySelectorAll('.msg-img').forEach((img) => img.addEventListener('click', (e) => { e.stopPropagation(); if (img.src) openLightbox(img.src, img.alt); }));
  container.querySelectorAll('.msg-file').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); if (a.dataset.url) window.open(a.dataset.url, '_blank', 'noopener'); }));
  container.querySelectorAll('.voice-msg').forEach(wireVoice);
}

let playing = null; // only one voice note plays at a time
function wireVoice(el) {
  const btn = el.querySelector('.vplay');
  const bars = [...el.querySelectorAll('.vbars i')];
  const timeEl = el.querySelector('.vtime');
  const total = timeEl.textContent;
  let audio = null;
  const paint = () => {
    const p = audio && audio.duration ? audio.currentTime / audio.duration : 0;
    bars.forEach((b, i) => b.classList.toggle('on', i / bars.length < p));
    if (audio && !audio.paused) timeEl.textContent = fmtSecs(audio.currentTime);
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!audio) {
      const src = el.querySelector('[data-attach-path]');
      if (!src || !src.dataset.url) return;
      audio = new Audio(src.dataset.url);
      audio.addEventListener('timeupdate', paint);
      audio.addEventListener('play', () => { btn.innerHTML = ICON.pause; el.classList.add('playing'); });
      audio.addEventListener('pause', () => { btn.innerHTML = ICON.play; el.classList.remove('playing'); });
      audio.addEventListener('ended', () => { timeEl.textContent = total; bars.forEach((b) => b.classList.remove('on')); });
    }
    if (audio.paused) {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  });
}

export function openLightbox(src, alt = '') {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"><button class="lightbox-close" aria-label="Close">${ICON.close}</button>`;
  const close = () => { box.classList.add('out'); setTimeout(() => box.remove(), 200); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
}

// Swipe the bubble right past a small threshold to reply to it. Pointer Events cover touch and mouse
// alike. A swipe is only recognised once the drag is clearly more horizontal than vertical, so normal
// vertical scrolling of the message list is never hijacked.
export function attachSwipeReply(rowEl, onReply) {
  const wrap = rowEl.querySelector('.bubble-wrap');
  if (!wrap) return;
  const THRESHOLD = 46, MAX = 64;
  let startX = 0, startY = 0, dx = 0, dragging = false, decided = false, isHorizontal = false;

  rowEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // mouse users reply from the menu instead
    startX = e.clientX; startY = e.clientY; dx = 0; dragging = true; decided = false; isHorizontal = false;
  });
  rowEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dxRaw = e.clientX - startX, dyRaw = e.clientY - startY;
    if (!decided) {
      if (Math.abs(dxRaw) < 6 && Math.abs(dyRaw) < 6) return;
      decided = true;
      isHorizontal = dxRaw > 0 && Math.abs(dxRaw) > Math.abs(dyRaw) * 1.3;
      if (!isHorizontal) { dragging = false; return; }
      rowEl.classList.add('swiping');
      wrap.style.transition = 'none';
    }
    if (!isHorizontal) return;
    dx = Math.max(0, Math.min(MAX, dxRaw));
    wrap.style.transform = `translateX(${dx}px)`;
    rowEl.classList.toggle('swipe-armed', dx >= THRESHOLD);
    e.preventDefault();
  }, { passive: false });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    wrap.style.transition = '';
    wrap.style.transform = '';
    rowEl.classList.remove('swiping', 'swipe-armed');
    if (isHorizontal && dx >= THRESHOLD) { if (navigator.vibrate) navigator.vibrate(10); onReply(); }
  };
  rowEl.addEventListener('pointerup', end);
  rowEl.addEventListener('pointercancel', end);
}

// Long-press (touch), right-click, or the little "..." button on hover opens the message menu.
export function attachMessageMenu(rowEl, open) {
  let timer = null, sx = 0, sy = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  rowEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('a, button, .voice-msg')) return;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { timer = null; if (navigator.vibrate) navigator.vibrate(12); open(); }, 430);
  });
  rowEl.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); });
  rowEl.addEventListener('pointerup', cancel);
  rowEl.addEventListener('pointercancel', cancel);
  rowEl.addEventListener('contextmenu', (e) => { if (e.target.closest('a')) return; e.preventDefault(); open(); });
  const more = rowEl.querySelector('.msg-more');
  if (more) more.addEventListener('click', (e) => { e.stopPropagation(); open(); });
}

export function closeMessageMenu() {
  document.querySelectorAll('.msg-menu-scrim, .msg-menu').forEach((el) => el.remove());
  document.querySelectorAll('.msg-row.menu-open').forEach((el) => el.classList.remove('menu-open'));
}

// actions: [{ id, label, icon, danger }]. onReact(emoji) is omitted for messages that can't take one.
export function openMessageMenu(rowEl, { actions, onAction, onReact }) {
  closeMessageMenu();
  const bubble = rowEl.querySelector('.bubble') || rowEl;
  // The scrim dims the thread, the pressed message is lifted above it, and the menu sits above both.
  const scrim = document.createElement('div');
  scrim.className = 'msg-menu-scrim';
  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    ${onReact ? `<div class="mm-reactions">${QUICK_REACTIONS.map((e) => `<button type="button" data-react="${e}">${e}</button>`).join('')}</div>` : ''}
    <div class="mm-actions">${actions.map((a) => `<button type="button" role="menuitem" class="${a.danger ? 'danger' : ''}" data-action="${a.id}"><span>${escapeHtml(a.label)}</span>${a.icon || ''}</button>`).join('')}</div>`;
  document.body.appendChild(scrim);
  document.body.appendChild(menu);
  rowEl.classList.add('menu-open');

  const r = bubble.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight, pad = 10, vw = innerWidth, vh = innerHeight;
  let top = r.bottom + 8 + mh < vh - pad ? r.bottom + 8 : r.top - 8 - mh;
  top = Math.max(pad, Math.min(vh - mh - pad, top));
  let left = rowEl.classList.contains('out') ? r.right - mw : r.left;
  left = Math.max(pad, Math.min(vw - mw - pad, left));
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
  menu.style.transformOrigin = `${rowEl.classList.contains('out') ? 'right' : 'left'} ${top > r.top ? 'top' : 'bottom'}`;

  const close = () => { closeMessageMenu(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  scrim.addEventListener('wheel', close, { passive: true });
  menu.querySelectorAll('[data-react]').forEach((b) => b.addEventListener('click', () => { close(); onReact(b.dataset.react); }));
  menu.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => { close(); onAction(b.dataset.action); }));
}

export function jumpToMessage(container, id) {
  const el = container.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('jump-flash');
  setTimeout(() => el.classList.remove('jump-flash'), 1100);
}
