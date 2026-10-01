// The Terms of use, Privacy policy and Disclaimer: as a page inside the app (#/legal/<doc>) for people
// who are signed in, and as a full-screen sheet from the sign-in screen for people who aren't.
import { LEGAL, renderLegal } from '../lib/legal.js';
import { ICON } from '../lib/icons.js';

const TABS = [['terms', 'Terms'], ['privacy', 'Privacy'], ['disclaimer', 'Disclaimer']];

function body(doc) {
  return `
    <nav class="legal-tabs">${TABS.map(([id, label]) => `<a href="#/legal/${id}" data-doc="${id}" class="${id === doc ? 'active' : ''}">${label}</a>`).join('')}</nav>
    <article class="legal-doc">${renderLegal(LEGAL[doc].text)}</article>`;
}

export async function mountLegal(root, doc) {
  if (!LEGAL[doc]) doc = 'terms';
  root.innerHTML = `
    <div class="thread-head">
      <button class="back-btn" id="lg-back" aria-label="Back">${ICON.back}</button>
      <div class="info"><span class="name">${LEGAL[doc].title}</span><span class="status">ForYou</span></div>
    </div>
    <div class="settings-body legal-body">${body(doc)}</div>`;
  root.querySelector('#lg-back').onclick = () => { location.hash = '#/settings'; };
  return () => {};
}

// For the sign-in screen, where there's no router: a sheet over everything, with its own tabs.
export function openLegalSheet(doc) {
  const sheet = document.createElement('div');
  sheet.className = 'legal-sheet';
  const paint = (d) => {
    sheet.innerHTML = `
      <div class="legal-sheet-head"><b>${LEGAL[d].title}</b><button class="legal-close" aria-label="Close">${ICON.close}</button></div>
      <div class="legal-sheet-body">${body(d)}</div>`;
    sheet.querySelector('.legal-close').onclick = close;
    sheet.querySelectorAll('[data-doc]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); paint(a.dataset.doc); }));
  };
  const close = () => { sheet.classList.add('out'); setTimeout(() => sheet.remove(), 200); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  paint(LEGAL[doc] ? doc : 'terms');
  document.body.appendChild(sheet);
}
