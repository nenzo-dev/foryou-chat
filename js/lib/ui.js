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

// A caught error's own .message is a raw string from Postgres, the network layer or the browser --
// never meant for someone using the app to read. This is the one place that turns any of those into
// something a person can actually make sense of; the real error still goes to the console for anyone
// looking. Use this everywhere a catch block would otherwise have shown e.message.
export function friendlyError(e) {
  console.error(e);
  return "Something went wrong on our end — our team is looking into it. Please try again in a moment.";
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
