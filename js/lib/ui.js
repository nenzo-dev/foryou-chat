// Small view-independent UI helpers: toast messages, a generic modal, a choice sheet, and which pane a
// narrow (phone-width) screen is showing right now.
import { escapeHtml } from './util.js';

export function toast(msg, ms = 2600) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
}

// A caught error's own .message is a raw string from Postgres, the network layer or the browser --
// never meant for someone using the app to read. This is the one place that turns any of those into
// something a person can actually make sense of; the real error still goes to the console for anyone
// looking. The only exception is a database message written for people on purpose (e.show, see rpc()).
export function friendlyError(e) {
  if (e && e.show && e.message) return e.message;
  console.error(e);
  return "Sorry, we ran into a problem. It's not you, it's us. Please try again in a moment.";
}

export function openModal(innerHtml, { onMount, className = '' } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal ${className}">
    <button class="modal-close" id="modal-close" aria-label="Close">&times;</button>${innerHtml}</div></div>`;
  const backdrop = document.getElementById('modal-backdrop');
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.getElementById('modal-close').addEventListener('click', closeModal);
  if (onMount) onMount(root.querySelector('.modal'));
  return root.querySelector('.modal');
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
}

// A short list of choices, e.g. "Delete for everyone / Delete for me". Resolves with the chosen
// action's id, or null if dismissed. actions: [{ id, label, danger }]
export function choose({ title, text = '', actions }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
    const modal = openModal(`
      <div class="choice">
        <h3>${escapeHtml(title)}</h3>
        ${text ? `<p class="muted small">${escapeHtml(text)}</p>` : ''}
        <div class="choice-list">
          ${actions.map((a) => `<button class="btn ${a.danger ? 'btn-danger' : 'btn-ghost'} btn-block" data-choice="${escapeHtml(a.id)}">${escapeHtml(a.label)}</button>`).join('')}
          <button class="btn btn-plain btn-block" data-choice="">Cancel</button>
        </div>
      </div>`, { className: 'modal-sheet' });
    modal.querySelectorAll('[data-choice]').forEach((b) => b.addEventListener('click', () => finish(b.dataset.choice || null)));
    const backdrop = document.getElementById('modal-backdrop');
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null); });
    document.getElementById('modal-close').addEventListener('click', () => finish(null));
  });
}

// On a phone-width screen only one of the two panes (chat list vs. the open thread) is shown at a
// time; on a wide screen both stay visible and this is a no-op in effect (CSS shows both regardless).
export function showPane(name) {
  document.body.dataset.pane = name;
}
