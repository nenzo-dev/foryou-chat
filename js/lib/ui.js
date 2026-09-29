// Small view-independent UI helpers: toast messages, a generic modal, and which pane a narrow
// (phone-width) screen is showing right now.

export function toast(msg, ms = 2600) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function openModal(innerHtml, { onMount } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal">
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

// On a phone-width screen only one of the two panes (chat list vs. the open thread) is shown at a
// time; on a wide screen both stay visible and this is a no-op in effect (CSS shows both regardless).
export function showPane(name) {
  document.body.dataset.pane = name;
}
