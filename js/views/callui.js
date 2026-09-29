// The full-screen call overlay: one-to-one calls (with an incoming-call ring reachable from anywhere
// in the app) and group room calls. Owns nothing about chat/rooms itself -- chat.js and room.js just
// call startDirectCall(peer) / startGroupCall(room), and app.js forwards ring events here.
import { CallSession, getLocalMedia, mediaSupport, explainMediaError } from '../lib/rtc.js';
import { GroupCall } from '../lib/groupcall.js';
import { avatarUrl } from '../lib/db.js';
import { ringUser } from '../lib/ring.js';
import { startRing, stopRing } from '../lib/ringtone.js';
import { toast } from '../lib/ui.js';
import { initials, duration, escapeHtml } from '../lib/util.js';
import { state } from '../state.js';

let overlay = null;
let session = null;      // active CallSession (direct calls)
let group = null;        // active GroupCall (room calls)
let durationTimer = null;
let incomingAlertEl = null;
let pendingInvite = null; // the invite we are currently ringing for, so we can reply "declined"

function el() {
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'call-overlay';
    overlay.className = 'call-overlay hidden';
    document.body.appendChild(overlay);
  }
  return overlay;
}

export function isBusy() { return !!(session || group); }

/* ---------------------------- incoming call alert ---------------------------- */

export function handleRingEvent(payload) {
  if (!payload || payload.from === state.user?.id) return;
  if (payload.type === 'invite') {
    if (isBusy() || incomingAlertEl) { ringUser(payload.from, { type: 'decline', from: state.user.id, reason: 'busy' }); return; }
    showIncomingAlert(payload);
  } else if (payload.type === 'decline') {
    if (session && pendingInvite && pendingInvite.roomKey === payload.roomKey) {
      toast(payload.reason === 'busy' ? 'They are on another call.' : 'Call declined.');
      endDirectCall('declined');
    }
  } else if (payload.type === 'cancel') {
    if (incomingAlertEl && payload.roomKey === incomingAlertEl.dataset.roomKey) dismissIncomingAlert();
  }
}

function showIncomingAlert(payload) {
  stopRing(); startRing();
  incomingAlertEl = document.createElement('div');
  incomingAlertEl.className = 'call-overlay';
  incomingAlertEl.dataset.roomKey = payload.roomKey;
  incomingAlertEl.innerHTML = `
    <div class="call-status" style="position:static;margin-top:auto;padding-bottom:8px">Incoming video call<span class="sub">${escapeHtml(payload.fromName || 'Someone')}</span></div>
    <div style="margin:0 auto 8px;width:96px;height:96px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:700;color:#1a1400;background:${payload.fromAvatarColor || '#F5C400'}">
      ${payload.fromAvatarPath ? `<img src="${escapeHtml(avatarUrl(payload.fromAvatarPath))}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : escapeHtml(initials(payload.fromName || '?'))}
    </div>
    <div class="call-controls" style="margin-top:auto">
      <button class="btn-icon end" id="ic-decline" aria-label="Decline">&#128222;</button>
      <button class="btn-icon" style="background:var(--ok);color:#fff" id="ic-accept" aria-label="Accept">&#128241;</button>
    </div>`;
  document.body.appendChild(incomingAlertEl);
  incomingAlertEl.querySelector('#ic-decline').onclick = () => {
    ringUser(payload.from, { type: 'decline', from: state.user.id, roomKey: payload.roomKey });
    dismissIncomingAlert();
  };
  incomingAlertEl.querySelector('#ic-accept').onclick = () => {
    dismissIncomingAlert();
    answerDirectCall(payload);
  };
}

function dismissIncomingAlert() {
  stopRing();
  if (incomingAlertEl) { incomingAlertEl.remove(); incomingAlertEl = null; }
}

/* ---------------------------- one-to-one calls ---------------------------- */

export async function startDirectCall(peer) {
  if (isBusy()) { toast('You are already in a call.'); return; }
  const sup = mediaSupport();
  if (!sup.getUserMedia || !sup.peer) { toast('This browser cannot make video calls.'); return; }
  const roomKey = crypto.randomUUID().replace(/-/g, '');
  await openDirectOverlay({ role: 'host', roomKey, peer });
  pendingInvite = { roomKey, peer };
  ringUser(peer.id, {
    type: 'invite', from: state.user.id, roomKey,
    fromName: state.profile?.full_name || 'Someone', fromAvatarColor: state.profile?.avatar_color, fromAvatarPath: state.profile?.avatar_path,
  });
}

export async function answerDirectCall(invite) {
  if (isBusy()) return;
  await openDirectOverlay({ role: 'guest', roomKey: invite.roomKey, peer: { id: invite.from, full_name: invite.fromName, avatar_color: invite.fromAvatarColor } });
}

async function openDirectOverlay({ role, roomKey, peer }) {
  const root = el();
  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="call-status" id="call-status">${role === 'host' ? 'Calling' : 'Connecting'}&hellip;<span class="sub">${escapeHtml(peer.full_name || 'Someone')}</span></div>
    <div class="call-video-wrap">
      <video class="remote" id="call-remote" autoplay playsinline></video>
      <video class="local" id="call-local" autoplay playsinline muted></video>
    </div>
    <div class="call-controls">
      <button class="btn-icon" id="call-mute" aria-label="Mute">&#127908;</button>
      <button class="btn-icon" id="call-cam" aria-label="Camera">&#128249;</button>
      <button class="btn-icon" id="call-screen" aria-label="Share screen">&#128421;&#65039;</button>
      <button class="btn-icon end" id="call-end" aria-label="End call">&#128222;</button>
    </div>`;

  let media;
  try { media = await getLocalMedia({}); }
  catch (e) { toast(explainMediaError(e)); closeOverlay(); return; }
  if (media.note) toast(media.note);

  root.querySelector('#call-local').srcObject = media.stream;

  session = new CallSession({ roomKey, me: { id: state.user.id, full_name: state.profile?.full_name || 'Me' }, role, peerId: peer.id });
  const statusEl = () => root.querySelector('#call-status');

  session.on('state', (s) => {
    const map = { idle: '', waiting: 'Ringing…', open: 'Calling…', connecting: 'Connecting…', connected: '', reconnecting: 'Reconnecting…', failed: 'Call failed', ended: 'Call ended', left: '' };
    if (s === 'connected') {
      stopRing();
      clearInterval(durationTimer);
      const start = Date.now();
      const tick = () => { const st = statusEl(); if (st) st.innerHTML = `${duration((Date.now() - start) / 1000)}`; };
      tick(); durationTimer = setInterval(tick, 1000);
    } else {
      const st = statusEl();
      if (st) st.innerHTML = `${map[s] || s}<span class="sub">${escapeHtml(peer.full_name || 'Someone')}</span>`;
    }
    if (s === 'failed' || s === 'ended') setTimeout(() => closeOverlay(), 1400);
  });
  session.on('remote-stream', (stream) => { const v = root.querySelector('#call-remote'); if (v) v.srcObject = stream; });
  session.on('denied', () => { toast('Call was not answered.'); closeOverlay(); });
  session.on('remote-left', () => { toast('The other person left.'); closeOverlay(); });

  root.querySelector('#call-mute').onclick = (e) => {
    const muted = e.currentTarget.classList.toggle('off');
    session.setMuted(muted);
    e.currentTarget.innerHTML = muted ? '&#128263;' : '&#127908;';
  };
  root.querySelector('#call-cam').onclick = (e) => {
    const off = e.currentTarget.classList.toggle('off');
    session.setCameraOff(off);
    e.currentTarget.innerHTML = off ? '&#128248;' : '&#128249;';
  };
  root.querySelector('#call-screen').onclick = async (e) => {
    try {
      if (session.screenTrack) { await session.stopScreen(); e.currentTarget.classList.remove('off'); }
      else { await session.startScreen(); e.currentTarget.classList.add('off'); }
    } catch { /* the user cancelled the screen picker */ }
  };
  root.querySelector('#call-end').onclick = () => endDirectCall();

  await session.join(media.stream);
}

function endDirectCall(reason) {
  if (session) { session.leave(true); session = null; }
  if (pendingInvite) { pendingInvite = null; }
  stopRing();
  closeOverlay();
}

/* ---------------------------- group room calls ---------------------------- */

export async function startGroupCall(room) {
  if (isBusy()) { toast('You are already in a call.'); return; }
  const sup = mediaSupport();
  if (!sup.getUserMedia || !sup.peer) { toast('This browser cannot make video calls.'); return; }
  const root = el();
  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="call-status" id="gc-status">Joining the call&hellip;<span class="sub">${escapeHtml(room.name)}</span></div>
    <div class="grid-call" id="gc-grid"></div>
    <video id="gc-local" autoplay playsinline muted style="display:none"></video>
    <div class="call-controls">
      <button class="btn-icon" id="gc-mute" aria-label="Mute">&#127908;</button>
      <button class="btn-icon" id="gc-cam" aria-label="Camera">&#128249;</button>
      <button class="btn-icon end" id="gc-end" aria-label="Leave call">&#128222;</button>
    </div>`;

  let media;
  try { media = await getLocalMedia({ small: true }); }
  catch (e) { toast(explainMediaError(e)); closeOverlay(); return; }

  group = new GroupCall({ roomId: room.id, me: { id: state.user.id, full_name: state.profile?.full_name || 'Me' } });

  const renderGrid = (peers) => {
    const grid = root.querySelector('#gc-grid');
    if (!grid) return;
    const n = peers.length + 1;
    grid.style.gridTemplateColumns = `repeat(${n <= 1 ? 1 : n <= 4 ? 2 : 3}, 1fr)`;
    grid.innerHTML = '';
    const me = document.createElement('div');
    me.className = 'tile';
    me.innerHTML = `<video autoplay playsinline muted></video><span class="tag">You</span>`;
    me.querySelector('video').srcObject = media.stream;
    grid.appendChild(me);
    for (const p of peers) {
      const t = document.createElement('div');
      t.className = 'tile';
      t.innerHTML = `<video autoplay playsinline></video><span class="tag">${escapeHtml(p.name || 'Guest')}</span>`;
      t.querySelector('video').srcObject = p.stream;
      grid.appendChild(t);
    }
    const status = root.querySelector('#gc-status');
    if (status) status.textContent = n === 1 ? 'Waiting for others to join…' : `${n} in the call`;
  };

  group.on('peers', renderGrid);
  group.on('kicked', () => { toast('This call is full.'); closeOverlay(); });

  root.querySelector('#gc-mute').onclick = (e) => {
    const muted = e.currentTarget.classList.toggle('off');
    group.setMuted(muted);
    e.currentTarget.innerHTML = muted ? '&#128263;' : '&#127908;';
  };
  root.querySelector('#gc-cam').onclick = (e) => {
    const off = e.currentTarget.classList.toggle('off');
    group.setCameraOff(off);
    e.currentTarget.innerHTML = off ? '&#128248;' : '&#128249;';
  };
  root.querySelector('#gc-end').onclick = () => endGroupCall();

  try { await group.join(media.stream); renderGrid([]); }
  catch (e) { toast(e.message || 'Could not join the call.'); closeOverlay(); }
}

function endGroupCall() {
  if (group) { group.leave(); group = null; }
  closeOverlay();
}

/* ---------------------------- shared teardown ---------------------------- */

function closeOverlay() {
  clearInterval(durationTimer);
  stopRing();
  if (overlay) { overlay.classList.add('hidden'); overlay.innerHTML = ''; }
  session = null; group = null; pendingInvite = null;
}
