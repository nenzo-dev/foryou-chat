// UNILUS Blind Dates, the lobby: what it is, the rooms open right now, and starting a new one. A room
// has three seats -- one host and two daters. Taking a seat opens the date itself (js/views/date.js).
import { avatarUrl } from '../lib/db.js';
import { dateLobby, createDate } from '../lib/dates.js';
import { escapeHtml, initials, timeAgo, pickColor, cssColor } from '../lib/util.js';
import { openModal, closeModal, friendlyError } from '../lib/ui.js';
import { ICON } from '../lib/icons.js';

// The drawing at the top of the lobby and the join page: a silk blindfold with a heart knot.
export const BLINDFOLD_ART = `<svg class="bf-art" viewBox="0 0 320 170" aria-hidden="true">
  <defs>
    <linearGradient id="bf-silk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7aa2"/><stop offset=".55" stop-color="#e0306b"/><stop offset="1" stop-color="#8e1446"/></linearGradient>
    <linearGradient id="bf-sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="bf-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe27a"/><stop offset="1" stop-color="#d49a00"/></linearGradient>
    <clipPath id="bf-clip"><path d="M18 78c44-26 92-38 142-38s98 12 142 38v34c-44-20-92-30-142-30S62 92 18 112Z"/></clipPath>
  </defs>
  <g class="bf-tails"><path d="M262 92c14 18 22 40 20 66l-14-6c2-22-4-40-16-54Z" fill="#b21d57"/><path d="M270 88c22 10 38 28 44 52l-15 1c-6-20-18-34-36-44Z" fill="#d42a65"/></g>
  <g class="bf-band">
    <path d="M18 78c44-26 92-38 142-38s98 12 142 38v34c-44-20-92-30-142-30S62 92 18 112Z" fill="url(#bf-silk)"/>
    <path d="M18 84c44-24 92-35 142-35s98 11 142 35" stroke="#ffd0de" stroke-opacity=".35" stroke-width="2" fill="none"/>
    <path d="M18 104c44-18 92-27 142-27s98 9 142 27" stroke="#5c0a2c" stroke-opacity=".35" stroke-width="2" fill="none"/>
    <g class="bf-eyes" stroke="#ffe3ec" stroke-opacity=".8" stroke-width="2.6" stroke-linecap="round" fill="none">
      <path d="M88 63q22 13 44 0"/><path d="M95 70l-3 7M110 74v8M125 70l3 7"/>
      <path d="M188 63q22 13 44 0"/><path d="M195 70l-3 7M210 74v8M225 70l3 7"/>
    </g>
    <g clip-path="url(#bf-clip)"><rect class="bf-shine" x="-120" y="20" width="90" height="120" fill="url(#bf-sheen)" transform="skewX(-20)"/></g>
  </g>
  <g class="bf-knot"><path d="M254 72c10-10 26-8 28 4 2 12-12 22-24 32-12-10-26-20-24-32 2-12 18-14 20-4Z" fill="url(#bf-gold)"/></g>
  <g class="bf-sparks" fill="#ffd84d"><circle cx="46" cy="40" r="2.5"/><circle cx="92" cy="18" r="1.8"/><circle cx="214" cy="22" r="2.2"/><circle cx="300" cy="46" r="1.6"/><circle cx="28" cy="140" r="1.8"/></g>
</svg>`;

export async function mountDates(root) {
  root.innerHTML = `
  <div class="bd-page">
    <div class="thread-head bd-head">
      <button class="back-btn" id="bd-back" aria-label="Back">${ICON.back}</button>
      <div class="info"><span class="name">Blind dates</span><span class="status">UNILUS</span></div>
    </div>
    <div class="bd-scroll">
      <section class="bd-hero">
        <div class="bd-aurora"><i></i><i></i><i></i></div>
        ${BLINDFOLD_ART}
        <p class="bd-kicker">UNILUS</p>
        <h1 class="bd-title">Blind Dates</h1>
        <p class="bd-lead">Talk first, see later. Two people meet blindfolded and get to know each other by voice, while a host keeps the date going. When the moment feels right, the host lifts the blindfold.</p>
        <div class="bd-cta">
          <button class="btn btn-rose" id="bd-go">${ICON.blindfold} Go on a date</button>
          <button class="btn btn-ghost-rose" id="bd-host">${ICON.crown} Host one</button>
        </div>
      </section>

      <section class="bd-section">
        <div class="bd-section-head"><h2>Rooms open now</h2><span class="bd-live"><i></i>Live</span></div>
        <div id="bd-rooms" class="bd-rooms"><div class="thread-loading"><span></span><span></span><span></span></div></div>
      </section>

      <section class="bd-section">
        <h2>How it works</h2>
        <ol class="bd-steps">
          <li><span class="n">1</span><div><b>Take a seat</b><p>Join a room as one of the two daters, or as the host.</p></div></li>
          <li><span class="n">2</span><div><b>Talk blindfolded</b><p>The daters hear each other but can't see each other, and names stay hidden. The host sees and hears you both.</p></div></li>
          <li><span class="n">3</span><div><b>The reveal</b><p>The host opens the blindfold and you finally see who you've been talking to. No host in the room? It opens once you both tap "I'm ready".</p></div></li>
        </ol>
        <p class="bd-safety">${ICON.lock}<span>Until the blindfold opens, your camera only reaches the host. Your date gets your voice, nothing else. You can leave at any time.</span></p>
      </section>
    </div>
  </div>`;

  root.querySelector('#bd-back').onclick = () => { location.hash = '#/'; };
  root.querySelector('#bd-host').onclick = () => openCreate('host');
  root.querySelector('#bd-go').onclick = goOnADate;

  let rooms = [];
  let stopped = false;
  await load();
  const timer = setInterval(load, 8000);
  return () => { stopped = true; clearInterval(timer); };

  async function load() {
    try {
      rooms = await dateLobby();
      if (!stopped) paint();
    } catch (e) {
      const el = root.querySelector('#bd-rooms');
      if (el && !rooms.length) el.innerHTML = `<p class="bd-empty">${escapeHtml(friendlyError(e))}</p>`;
    }
  }

  function paint() {
    const el = root.querySelector('#bd-rooms');
    if (!el) return;
    if (!rooms.length) {
      el.innerHTML = `<div class="bd-empty"><div class="bd-empty-ic">${ICON.heart}</div><b>No rooms open right now</b><span>Start one and it shows up here for everyone.</span></div>`;
      return;
    }
    el.innerHTML = rooms.map((r) => {
      const daterOpen = r.daters < 2 && !r.revealed;
      const host = r.host_open
        ? `<span class="seat host open" title="Host seat free">${ICON.crown}</span>`
        : `<span class="seat host filled" title="${escapeHtml(r.host_name || 'Host')}">${r.host_avatar_path ? `<img src="${escapeHtml(avatarUrl(r.host_avatar_path))}" alt="">` : `<b style="background:${cssColor(r.host_avatar_color, pickColor(r.id))}">${escapeHtml(initials(r.host_name || '?'))}</b>`}</span>`;
      const daters = [0, 1].map((i) => `<span class="seat dater ${i < r.daters ? 'filled' : 'open'}" title="${i < r.daters ? 'Dater seat taken' : 'Dater seat free'}">${ICON.blindfold}</span>`).join('');
      const actions = r.mine
        ? `<button class="btn btn-rose btn-sm" data-open="${escapeHtml(r.id)}">Rejoin</button>`
        : `${daterOpen ? `<button class="btn btn-rose btn-sm" data-join="${escapeHtml(r.id)}" data-role="dater">Take a dater seat</button>` : ''}${r.host_open && !r.revealed ? `<button class="btn btn-ghost-rose btn-sm" data-join="${escapeHtml(r.id)}" data-role="host">Host</button>` : ''}`;
      return `<article class="bd-card${r.mine ? ' mine' : ''}">
        <div class="bd-card-top"><h3>${escapeHtml(r.title || 'Blind date')}</h3><span class="bd-age">${escapeHtml(timeAgo(new Date(r.created_at).getTime()))}</span></div>
        <div class="bd-card-mid">
          <div class="bd-seats">${host}<span class="seat-sep"></span>${daters}</div>
          <span class="bd-card-note">${r.revealed ? 'Blindfold is off' : r.host_open ? 'No host yet' : `Hosted by ${escapeHtml((r.host_name || '').split(' ')[0] || 'someone')}`}</span>
        </div>
        <div class="bd-card-actions">${actions || '<span class="muted small">Full</span>'}</div>
      </article>`;
    }).join('');
    el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/date/${b.dataset.open}`; }));
    el.querySelectorAll('[data-join]').forEach((b) => b.addEventListener('click', () => {
      sessionStorage.setItem('fy_date_seat', JSON.stringify({ id: b.dataset.join, role: b.dataset.role }));
      location.hash = `#/date/${b.dataset.join}`;
    }));
  }

  function goOnADate() {
    const open = rooms.find((r) => !r.mine && !r.revealed && r.daters < 2);
    if (open) {
      sessionStorage.setItem('fy_date_seat', JSON.stringify({ id: open.id, role: 'dater' }));
      location.hash = `#/date/${open.id}`;
    } else {
      openCreate('dater', "No one's waiting right now. Open a room and the next person to join is your date.");
    }
  }
}

function openCreate(role, note = '') {
  const modal = openModal(`
    <div class="bd-create">
      <h3>Open a blind date</h3>
      ${note ? `<p class="muted small">${escapeHtml(note)}</p>` : ''}
      <label for="cd-title">Room name</label>
      <input id="cd-title" type="text" maxlength="60" placeholder="e.g. Friday night, main campus">
      <label>Your seat</label>
      <div class="seat-pick">
        <button type="button" class="seat-opt${role === 'dater' ? ' active' : ''}" data-role="dater">${ICON.blindfold}<b>Dater</b><span>Go in blindfolded and meet someone by voice</span></button>
        <button type="button" class="seat-opt${role === 'host' ? ' active' : ''}" data-role="host">${ICON.crown}<b>Host</b><span>See both daters and lift the blindfold</span></button>
      </div>
      <div class="toggle-row">
        <div><div class="label">Show it in the lobby</div><div class="hint">Off means only people you send the link to can join.</div></div>
        <label class="switch"><input type="checkbox" id="cd-public" checked><span class="track"><span class="thumb"></span></span></label>
      </div>
      <button class="btn btn-rose btn-block" id="cd-go">Open the room</button>
      <div id="cd-msg" class="form-msg"></div>
    </div>`, { className: 'modal-rose' });
  let pick = role;
  modal.querySelectorAll('.seat-opt').forEach((b) => b.addEventListener('click', () => {
    pick = b.dataset.role;
    modal.querySelectorAll('.seat-opt').forEach((x) => x.classList.toggle('active', x === b));
  }));
  modal.querySelector('#cd-go').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const made = await createDate({ title: modal.querySelector('#cd-title').value.trim(), role: pick, isPublic: modal.querySelector('#cd-public').checked });
      closeModal();
      location.hash = `#/date/${made.id}`;
    } catch (err) {
      const msg = modal.querySelector('#cd-msg');
      msg.className = 'form-msg err'; msg.textContent = friendlyError(err);
      btn.disabled = false;
    }
  });
}

