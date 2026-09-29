// Shared message-bubble interactions used by both js/views/chat.js and js/views/room.js: swipe right
// to reply, long-press to react, read-receipt ticks, and the little quoted-reply block inside a bubble.
// Pulled into one file specifically so chat.js and room.js don't drift into two near-identical, easy-to-
// break copies of the same gesture code.
import { escapeHtml } from './util.js';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export function renderTicks(m, mine) {
  if (!mine) return '';
  return `<span class="msg-tick${m.read_at ? ' read' : ''}">${m.read_at ? '&#10003;&#10003;' : '&#10003;'}</span>`;
}

// `original` is the already-loaded message this one replies to (or null if it wasn't found locally --
// e.g. it was outside the loaded history window). `whoName` is the display name to show for its sender.
export function renderReplyQuote(original, whoName) {
  if (!original) return '';
  const text = original.body
    ? escapeHtml(original.body)
    : (original.attachment ? (original.attachment.type && original.attachment.type.startsWith('audio/') ? '&#127908; Voice message' : '&#128206; Attachment') : '');
  return `<span class="msg-reply-quote" data-reply-jump="${escapeHtml(original.id)}"><span class="rq-name">${escapeHtml(whoName)}</span><span class="rq-body">${text}</span></span>`;
}

// `list` is the raw rows from message_reactions/room_message_reactions for one message: [{user_id, emoji}].
export function renderReactionChips(list, myId) {
  if (!list || !list.length) return '';
  const byEmoji = {};
  for (const r of list) (byEmoji[r.emoji] ||= []).push(r.user_id);
  const chips = Object.entries(byEmoji).map(([emoji, users]) =>
    `<span class="reaction-chip${users.includes(myId) ? ' mine' : ''}" data-emoji="${escapeHtml(emoji)}">${emoji}${users.length > 1 ? `<span class="n">${users.length}</span>` : ''}</span>`
  ).join('');
  return `<div class="msg-reactions">${chips}</div>`;
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
    if (e.pointerType === 'mouse' && e.button !== 0) return;
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
    e.preventDefault();
  }, { passive: false });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    wrap.style.transition = '';
    wrap.style.transform = '';
    rowEl.classList.remove('swiping');
    if (isHorizontal && dx >= THRESHOLD) onReply();
  };
  rowEl.addEventListener('pointerup', end);
  rowEl.addEventListener('pointercancel', end);
}

function closeReactionBars() { document.querySelectorAll('.react-bar').forEach((b) => b.remove()); }

// Long-press (or right-click) a message to open a small emoji strip above it.
export function attachReactionPicker(rowEl, onPick, quick = QUICK_REACTIONS) {
  let timer = null, moved = false;
  const cancel = () => clearTimeout(timer);
  rowEl.addEventListener('pointerdown', () => { moved = false; timer = setTimeout(() => { if (!moved) openBar(); }, 420); });
  rowEl.addEventListener('pointermove', () => { moved = true; cancel(); });
  rowEl.addEventListener('pointerup', cancel);
  rowEl.addEventListener('pointercancel', cancel);
  rowEl.addEventListener('contextmenu', (e) => { e.preventDefault(); openBar(); });

  function openBar() {
    closeReactionBars();
    const anchor = rowEl.querySelector('.bubble-wrap') || rowEl;
    const bar = document.createElement('div');
    bar.className = 'react-bar';
    bar.innerHTML = quick.map((e) => `<button type="button">${e}</button>`).join('');
    anchor.appendChild(bar);
    bar.querySelectorAll('button').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onPick(b.textContent);
      bar.remove();
    }));
    setTimeout(() => {
      const closeOnOutside = (ev) => { if (!bar.contains(ev.target)) { bar.remove(); document.removeEventListener('pointerdown', closeOnOutside, true); } };
      document.addEventListener('pointerdown', closeOnOutside, true);
    }, 0);
  }
}

export function jumpToMessage(container, id) {
  const el = container.querySelector(`[data-msg-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('jump-flash');
  setTimeout(() => el.classList.remove('jump-flash'), 900);
}
