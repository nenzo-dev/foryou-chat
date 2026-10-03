// The full-screen call overlay: one-to-one calls (with an incoming-call screen reachable from anywhere
// in the app) and group room calls. Owns nothing about chat/rooms itself -- chat.js and room.js just
// call startDirectCall(peer) / startGroupCall(room), and app.js forwards ring events here.
import { CallSession, getLocalMedia, mediaSupport, explainMediaError, hasSeveralCameras } from '../lib/rtc.js';
import { GroupCall } from '../lib/groupcall.js';
import { avatarUrl, supabase } from '../lib/db.js';
import { ringUser } from '../lib/ring.js';
import { startRing, stopRing } from '../lib/ringtone.js';
import { notify } from '../lib/notify.js';
import { watchLevel, audioContext, SPEAKING } from '../lib/audiolevel.js';
import { isPhone } from '../lib/callhealth.js';
import { toast, friendlyError } from '../lib/ui.js';
import { initials, duration, escapeHtml, pickColor, cssColor } from '../lib/util.js';
import { ICON } from '../lib/icons.js';
import { nameOf } from '../lib/contacts.js';
import { inAndroidApp, androidIncomingCall, androidEndIncomingCall, androidInCall, androidTakePendingCall } from '../lib/android.js';
import { state } from '../state.js';

let overlay = null;
let session = null;      // active CallSession (direct calls)
let group = null;        // active GroupCall (room calls)
let timers = [];
let cleanups = [];
let incomingAlertEl = null;
let incomingTimer = null;
let pendingInvite = null; // the invite we are ringing out with, so it can be cancelled
let busyElsewhere = false;
let incoming = null;      // { roomKey, accept, decline } for the call ringing right now
let overlaySeq = 0;       // bumps on every open/close so a late close animation never wipes a newer call

const RING_TIMEOUT_MS = 45000;

// A <video> playing someone else's mic audio isn't muted, and mobile Chrome silently blocks autoplay
// of unmuted media without a very fresh user gesture -- the call still "connects" underneath, but the
// element just never starts, forever black, with no error anywhere. Play it muted first (always
// allowed) so the picture shows up immediately, then drop the mute a moment later; if that specific
// unmute is what the browser objects to, the picture stays visible either way and only the audio needs
// one more tap (any tap on the call screen counts as a fresh gesture and unmutes it).
export function playRemote(v, stream) {
  v.dataset.callRemote = '1';
  if (v.srcObject !== stream) v.srcObject = stream;
  v.muted = true;
  v.play().catch(() => {});
  setTimeout(() => {
    v.muted = false;
    v.play().catch(() => {});
  }, 300);
}

function unmuteOnTap(root) {
  root.addEventListener('click', () => {
    audioContext();
    root.querySelectorAll('video[data-call-remote], audio[data-call-remote]').forEach((v) => { if (v.muted) { v.muted = false; v.play().catch(() => {}); } });
  });
}

function el() {
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'call-overlay';
    overlay.className = 'call-overlay hidden';
    document.body.appendChild(overlay);
  }
  return overlay;
}

// A blind date (js/views/date.js) is a call too; while one is open, incoming calls get "busy".
export function setBusyElsewhere(v) { busyElsewhere = !!v; }
export function isBusy() { return !!(session || group || busyElsewhere); }

function avatarHtml(person, cls = '') {
  const name = person.full_name || person.name || '?';
  if (person.avatar_path) return `<img class="avatar ${cls}" src="${escapeHtml(avatarUrl(person.avatar_path))}" alt="">`;
  return `<div class="avatar ${cls}" style="background:${cssColor(person.avatar_color, pickColor(person.id || name))}">${escapeHtml(initials(name))}</div>`;
}

const qualityBars = '<i></i><i></i><i></i>';

/* ---------------------------- incoming call screen ---------------------------- */

export function handleRingEvent(payload) {
  if (!payload || payload.from === state.user?.id) return;
  if (payload.type === 'invite') {
    // The same call can arrive twice (live channel and phone push): that's not a second caller.
    if (incomingAlertEl && incomingAlertEl.dataset.roomKey === payload.roomKey) return;
    if (session && session.roomKey === payload.roomKey) return;
    if (isBusy() || incomingAlertEl) { ringUser(payload.from, { type: 'decline', from: state.user.id, roomKey: payload.roomKey, reason: 'busy' }); return; }
    showIncomingAlert(payload);
  } else if (payload.type === 'decline') {
    if (session && pendingInvite && pendingInvite.roomKey === payload.roomKey) {
      toast(payload.reason === 'busy' ? "They're on another call right now." : 'Call declined');
      endDirectCall();
    }
  } else if (payload.type === 'cancel') {
    if (incomingAlertEl && payload.roomKey === incomingAlertEl.dataset.roomKey) {
      dismissIncomingAlert();
      notify('Missed video call', nameOf(payload.from, payload.fromName) + ' tried to call you', 'foryou-missed-call');
    }
  }
}

function showIncomingAlert(payload) {
  stopRing(); startRing();
  // The custom two-tone ring (js/lib/ringtone.js) only plays while this tab is actually open and its
  // audio isn't suspended -- a real OS notification is what gets the phone's own ringtone/notification
  // sound and vibration to fire even when the app is backgrounded or another tab is in front.
  // Your saved name for the caller when you have one (lib/contacts.js).
  const callerName = nameOf(payload.from, payload.fromName);
  if (inAndroidApp()) androidIncomingCall(payload.roomKey, callerName);
  else notify('Incoming video call', callerName + ' is calling you', 'foryou-incoming-call');
  const caller = { id: payload.from, full_name: callerName, avatar_color: payload.fromAvatarColor, avatar_path: payload.fromAvatarPath };
  incomingAlertEl = document.createElement('div');
  incomingAlertEl.className = 'call-overlay incoming';
  incomingAlertEl.dataset.roomKey = payload.roomKey;
  incomingAlertEl.style.setProperty('--tint', cssColor(caller.avatar_color, pickColor(caller.id)));
  incomingAlertEl.innerHTML = `
    <div class="call-backdrop"></div>
    <div class="call-hero">
      <div class="hero-avatar ringing"><span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span>${avatarHtml(caller, 'xxl')}</div>
      <div class="hero-kicker">${ICON.video} Incoming video call</div>
      <div class="hero-name">${escapeHtml(caller.full_name)}</div>
    </div>
    <div class="incoming-actions">
      <div class="ia"><button class="dock-btn end big" id="ic-decline" aria-label="Decline">${ICON.phoneDown}</button><span>Decline</span></div>
      <div class="ia"><button class="dock-btn accept big" id="ic-accept" aria-label="Accept">${ICON.video}</button><span>Accept</span></div>
    </div>`;
  document.body.appendChild(incomingAlertEl);
  const decline = () => {
    ringUser(payload.from, { type: 'decline', from: state.user.id, roomKey: payload.roomKey });
    dismissIncomingAlert();
  };
  const accept = () => {
    dismissIncomingAlert();
    answerDirectCall(payload);
  };
  incomingAlertEl.querySelector('#ic-decline').onclick = decline;
  incomingAlertEl.querySelector('#ic-accept').onclick = accept;
  incoming = { roomKey: payload.roomKey, accept, decline };
  clearTimeout(incomingTimer);
  incomingTimer = setTimeout(() => { if (incomingAlertEl && incomingAlertEl.dataset.roomKey === payload.roomKey) dismissIncomingAlert(); }, RING_TIMEOUT_MS + 5000);
}

function dismissIncomingAlert() {
  stopRing();
  clearTimeout(incomingTimer);
  incoming = null;
  if (incomingAlertEl) {
    androidEndIncomingCall(incomingAlertEl.dataset.roomKey);
    const node = incomingAlertEl;
    incomingAlertEl = null;
    node.classList.add('closing');
    setTimeout(() => node.remove(), 220);
  }
}

/* ---------------------------- calls that reached the Android app by push ---------------------------- */

// Answer / Decline pressed on the Android app's own ringing screen.
window.__foryouCall = (action, roomKey) => {
  if (incoming && incoming.roomKey === roomKey) {
    androidTakePendingCall(); // used up
    if (action === 'accept') incoming.accept(); else if (action === 'decline') incoming.decline();
  } else if (action === 'accept') {
    checkAndroidPendingCall();
  }
};

// A call pushed while the app was closed or out of sight: answer it if Answer was already pressed,
// otherwise show it ringing here. Called once the app is signed in, and whenever it comes back to front.
export function checkAndroidPendingCall() {
  if (!state.user || !inAndroidApp()) return;
  const p = androidTakePendingCall();
  const invite = p && p.invite;
  if (!invite || !invite.roomKey || invite.from === state.user.id) return;
  if (p.action === 'accept') {
    if (incoming && incoming.roomKey === invite.roomKey) { incoming.accept(); return; }
    if (!isBusy()) answerDirectCall(invite);
  } else if (!incomingAlertEl && !isBusy()) {
    showIncomingAlert(invite);
  }
}
window.__foryouCheckCall = checkAndroidPendingCall;

// Rings (or stops ringing) the other person's phone through the push function, for when their app is
// closed. Their open app hears about the call over the live channel anyway, so a failure here is quiet.
function pushCall(type, to, roomKey) {
  if (!supabase) return;
  supabase.functions.invoke('push', { body: { type, to, roomKey } }).catch(() => {});
}

/* ---------------------------- one-to-one calls ---------------------------- */

export async function startDirectCall(peer) {
  if (isBusy()) { toast("You're already on a call."); return; }
  const sup = mediaSupport();
  if (!sup.getUserMedia || !sup.peer) { toast("This browser can't make video calls. Try Chrome, Edge, Firefox or Safari."); return; }
  const roomKey = crypto.randomUUID().replace(/-/g, '');
  pendingInvite = { roomKey, peer };
  const opened = await openDirectOverlay({ role: 'host', roomKey, peer });
  if (!opened) { pendingInvite = null; return; }
  ringUser(peer.id, {
    type: 'invite', from: state.user.id, roomKey,
    fromName: state.profile?.full_name || 'Someone', fromAvatarColor: state.profile?.avatar_color, fromAvatarPath: state.profile?.avatar_path,
  });
  pushCall('call', peer.id, roomKey);
}

export async function answerDirectCall(invite) {
  if (isBusy()) return;
  await openDirectOverlay({ role: 'guest', roomKey: invite.roomKey, peer: { id: invite.from, full_name: nameOf(invite.from, invite.fromName), avatar_color: invite.fromAvatarColor, avatar_path: invite.fromAvatarPath } });
}

async function openDirectOverlay({ role, roomKey, peer }) {
  const root = el();
  overlaySeq++;
  const name = peer.full_name || 'Someone';
  root.className = 'call-overlay direct';
  root.dataset.phase = 'calling';
  root.style.setProperty('--tint', cssColor(peer.avatar_color, pickColor(peer.id)));
  root.innerHTML = `
    <div class="call-stage">
      <div class="call-backdrop"></div>
      <video class="remote" id="call-remote" autoplay playsinline></video>
      <div class="call-hero" id="call-hero">
        <div class="hero-avatar"><span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span>${avatarHtml(peer, 'xxl')}</div>
        <div class="hero-name">${escapeHtml(name)}</div>
        <div class="hero-status" id="call-hero-status">${role === 'host' ? 'Calling' : 'Connecting'}&hellip;</div>
      </div>
    </div>
    <div class="call-top">
      <div class="call-title"><span class="ct-name">${escapeHtml(name)}</span><span class="ct-sub" id="call-sub">${role === 'host' ? 'Calling' : 'Connecting'}&hellip;</span></div>
      <div class="call-quality hidden" id="call-quality" data-level="good" title="Connection quality">${qualityBars}</div>
    </div>
    <div class="call-note hidden" id="call-note"></div>
    <div class="call-pip" id="call-pip"><video id="call-local" class="mirror" autoplay playsinline muted></video><span class="pip-off">${ICON.videoOff}</span></div>
    <div class="call-dock">
      <button class="dock-btn" id="call-mute" aria-label="Mute microphone">${ICON.mic}</button>
      <button class="dock-btn" id="call-cam" aria-label="Turn camera off">${ICON.video}</button>
      <button class="dock-btn hidden" id="call-flip" aria-label="Switch camera">${ICON.flip}</button>
      <button class="dock-btn hidden" id="call-screen" aria-label="Share your screen">${ICON.screen}</button>
      <button class="dock-btn end" id="call-end" aria-label="End call">${ICON.phoneDown}</button>
    </div>`;
  root.classList.remove('hidden');
  androidInCall(true);
  unmuteOnTap(root);
  wireIdle(root);
  // Tap the small picture to swap it with the big one; tap the small one again to swap back.
  const swap = () => { if (root.dataset.phase === 'live' || root.classList.contains('swapped')) root.classList.toggle('swapped'); };
  makeDraggable(root.querySelector('#call-pip'), { onTap: swap, canDrag: () => !root.classList.contains('swapped') });
  root.querySelector('#call-remote').addEventListener('click', (e) => { if (root.classList.contains('swapped')) { e.stopPropagation(); swap(); } });

  let media;
  try { media = await getLocalMedia({}); }
  catch (e) { toast(explainMediaError(e)); closeOverlay(); return false; }
  if (media.note) toast(media.note, 4200);

  const localV = root.querySelector('#call-local');
  localV.srcObject = media.stream;
  if (!media.hasVideo) root.querySelector('#call-pip').classList.add('off');

  session = new CallSession({ roomKey, me: { id: state.user.id, full_name: state.profile?.full_name || 'Me' }, role, peerId: peer.id });
  const sub = () => root.querySelector('#call-sub');
  const heroStatus = () => root.querySelector('#call-hero-status');
  const note = root.querySelector('#call-note');
  const remoteV = root.querySelector('#call-remote');
  let connectedOnce = false;

  const setText = (t) => { if (sub()) sub().textContent = t; if (heroStatus()) heroStatus().textContent = t; };
  const showRemote = () => {
    const rm = session && session.remoteMedia;
    const camOff = !!(rm && rm.video === false && !rm.screen);
    const picture = remoteV.videoWidth > 0 && !camOff;
    root.dataset.phase = !connectedOnce ? 'calling' : picture ? 'live' : 'audio';
    if (connectedOnce && !picture && heroStatus()) heroStatus().textContent = camOff ? 'Camera off' : 'Starting video…';
  };
  remoteV.addEventListener('playing', showRemote);
  remoteV.addEventListener('resize', showRemote);

  // Nobody answering is its own ending, not an error: stop ringing after a while.
  if (role === 'host') {
    timers.push(setTimeout(() => {
      if (session && !connectedOnce) { toast(`${name} didn't answer`); endDirectCall(); }
    }, RING_TIMEOUT_MS));
  }

  session.on('state', (s) => {
    const map = { waiting: 'Connecting…', open: 'Ringing…', connecting: 'Connecting…', reconnecting: 'Reconnecting…', failed: "Call couldn't connect", ended: 'Call ended' };
    if (s === 'connected') {
      stopRing();
      note.classList.add('hidden');
      if (!connectedOnce) {
        connectedOnce = true;
        pendingInvite = null;
        const start = Date.now();
        const tick = () => { if (sub()) sub().textContent = duration((Date.now() - start) / 1000); };
        tick(); timers.push(setInterval(tick, 1000));
        root.querySelector('#call-quality').classList.remove('hidden');
      }
      showRemote();
    } else if (s === 'reconnecting') {
      note.textContent = 'Reconnecting…'; note.classList.remove('hidden');
    } else if (map[s] && !connectedOnce) {
      setText(map[s]);
    }
    if (s === 'failed' || s === 'ended') { setText(map[s]); setTimeout(() => closeOverlay(), 1400); }
  });
  session.on('remote-stream', (stream) => playRemote(remoteV, stream));
  session.on('remote-media', showRemote);
  session.on('quality', ({ level }) => { const q = root.querySelector('#call-quality'); if (q) q.dataset.level = level; });
  session.on('denied', () => { toast("The call wasn't answered."); closeOverlay(); });
  session.on('remote-left', () => { toast(`${name} left the call`); closeOverlay(); });
  session.on('screen', (s) => root.querySelector('#call-screen').classList.toggle('on', !!s));

  wireDock(root, {
    mute: (on) => session.setMuted(on),
    cam: (off) => { session.setCameraOff(off); root.querySelector('#call-pip').classList.toggle('off', off); },
    flip: () => session.switchCamera(),
    localVideo: localV, stream: media.stream,
    end: () => endDirectCall(),
  });
  const screenBtn = root.querySelector('#call-screen');
  if (mediaSupport().screen && !isPhone()) {
    screenBtn.classList.remove('hidden');
    screenBtn.onclick = async () => {
      try { if (session.screenTrack) await session.stopScreen(); else await session.startScreen(); }
      catch { /* the picker was cancelled */ }
    };
  }

  await session.join(media.stream);
  return true;
}

function endDirectCall() {
  if (pendingInvite && session && session.role === 'host') {
    ringUser(pendingInvite.peer.id, { type: 'cancel', from: state.user.id, roomKey: pendingInvite.roomKey, fromName: state.profile?.full_name || 'Someone' }).catch(() => {});
    pushCall('cancel', pendingInvite.peer.id, pendingInvite.roomKey);
  }
  if (session) { session.leave(true); session = null; }
  pendingInvite = null;
  stopRing();
  closeOverlay();
}

/* ---------------------------- group room calls ---------------------------- */

export async function startGroupCall(room) {
  if (isBusy()) { toast("You're already on a call."); return; }
  const sup = mediaSupport();
  if (!sup.getUserMedia || !sup.peer) { toast("This browser can't make video calls. Try Chrome, Edge, Firefox or Safari."); return; }
  const root = el();
  overlaySeq++;
  root.className = 'call-overlay group';
  root.dataset.phase = 'live';
  root.innerHTML = `
    <div class="call-top">
      <div class="call-title"><span class="ct-name">${escapeHtml(room.name)}</span><span class="ct-sub" id="gc-sub">Joining the call…</span></div>
    </div>
    <div class="grid-call" id="gc-grid"></div>
    <div class="call-dock">
      <button class="dock-btn" id="call-mute" aria-label="Mute microphone">${ICON.mic}</button>
      <button class="dock-btn" id="call-cam" aria-label="Turn camera off">${ICON.video}</button>
      <button class="dock-btn hidden" id="call-flip" aria-label="Switch camera">${ICON.flip}</button>
      <button class="dock-btn end" id="call-end" aria-label="Leave call">${ICON.phoneDown}</button>
    </div>`;
  root.classList.remove('hidden');
  androidInCall(true);
  unmuteOnTap(root);

  let media;
  try { media = await getLocalMedia({ small: true }); }
  catch (e) { toast(explainMediaError(e)); closeOverlay(); return; }
  if (media.note) toast(media.note, 4200);

  group = new GroupCall({ roomId: room.id, me: { id: state.user.id, full_name: state.profile?.full_name || 'Me' } });
  const grid = root.querySelector('#gc-grid');
  const tiles = new Map(); // id -> { el, video, stream, stopLevel }
  const meTile = makeTile({ id: state.user.id, name: 'You', person: state.profile || {}, self: true });
  meTile.video.srcObject = media.stream;
  meTile.video.muted = true;
  meTile.video.classList.add('mirror');
  meTile.stopLevel = watchLevel(media.stream, (lv) => meTile.el.classList.toggle('speaking', lv > SPEAKING && group && group.mediaState.audio));
  grid.appendChild(meTile.el);
  cleanups.push(() => meTile.stopLevel());

  // Tap someone to give them the big screen, with everyone else in a row underneath; tap again to go back.
  function focusTile(tileEl) {
    const on = !tileEl.classList.contains('focused');
    grid.querySelectorAll('.tile.focused').forEach((x) => x.classList.remove('focused'));
    if (on) tileEl.classList.add('focused');
    grid.classList.toggle('spotlight', on);
    grid.style.setProperty('--strip', String(Math.max(1, grid.children.length - 1)));
  }

  function makeTile({ id, name, person, self }) {
    const t = document.createElement('div');
    t.addEventListener('click', () => focusTile(t));
    t.className = 'tile' + (self ? ' self' : '');
    t.innerHTML = `<video autoplay playsinline ${self ? 'muted' : ''}></video>
      <div class="tile-off">${avatarHtml({ ...person, id, full_name: name }, 'lg')}</div>
      <span class="tag"><span class="tag-mic">${ICON.micOff}</span><span class="tag-name">${escapeHtml(name)}</span></span>`;
    return { el: t, video: t.querySelector('video'), stream: null, stopLevel: () => {} };
  }

  const renderGrid = (peers) => {
    const ids = new Set(peers.map((p) => p.id));
    for (const [id, t] of tiles) {
      if (ids.has(id)) continue;
      if (t.el.classList.contains('focused')) grid.classList.remove('spotlight');
      t.stopLevel(); t.el.remove(); tiles.delete(id);
    }
    grid.style.setProperty('--strip', String(Math.max(1, peers.length)));
    for (const p of peers) {
      let t = tiles.get(p.id);
      if (!t) { t = makeTile({ id: p.id, name: nameOf(p.id, p.name || 'Guest'), person: {} }); tiles.set(p.id, t); grid.appendChild(t.el); }
      if (p.stream && t.stream !== p.stream) {
        t.stream = p.stream;
        playRemote(t.video, p.stream);
        t.stopLevel();
        t.stopLevel = watchLevel(p.stream, (lv) => t.el.classList.toggle('speaking', lv > SPEAKING && p.media && p.media.audio !== false));
      }
      t.el.classList.toggle('cam-off', !!(p.media && p.media.video === false));
      t.el.classList.toggle('mic-off', !!(p.media && p.media.audio === false));
      t.el.classList.toggle('connecting', p.state !== 'connected');
      t.el.querySelector('.tag-name').textContent = nameOf(p.id, p.name || 'Guest');
    }
    const n = peers.length + 1;
    grid.dataset.count = String(Math.min(n, 9));
    const sub = root.querySelector('#gc-sub');
    if (sub) sub.textContent = n === 1 ? 'Waiting for others to join…' : `${n} people on the call`;
  };
  cleanups.push(() => { for (const t of tiles.values()) t.stopLevel(); tiles.clear(); });

  group.on('peers', renderGrid);
  group.on('kicked', () => { toast('This call is full.'); endGroupCall(); });

  wireDock(root, {
    mute: (on) => { group.setMuted(on); meTile.el.classList.toggle('mic-off', on); },
    cam: (off) => { group.setCameraOff(off); meTile.el.classList.toggle('cam-off', off); },
    flip: () => group.switchCamera(),
    localVideo: meTile.video, stream: media.stream,
    end: () => endGroupCall(),
  });

  try { await group.join(media.stream); renderGrid([]); }
  catch (e) { toast(friendlyError(e)); endGroupCall(); }
}

function endGroupCall() {
  if (group) { group.leave(); group = null; }
  closeOverlay();
}

/* ---------------------------- shared pieces ---------------------------- */

// Mute / camera / flip / end buttons, the same on every kind of call.
export function wireDock(root, { mute, cam, flip, localVideo, stream, end }) {
  const muteBtn = root.querySelector('#call-mute');
  const camBtn = root.querySelector('#call-cam');
  const flipBtn = root.querySelector('#call-flip');
  muteBtn.onclick = () => {
    const on = !muteBtn.classList.contains('off');
    muteBtn.classList.toggle('off', on);
    muteBtn.innerHTML = on ? ICON.micOff : ICON.mic;
    muteBtn.setAttribute('aria-label', on ? 'Unmute microphone' : 'Mute microphone');
    mute(on);
  };
  camBtn.onclick = () => {
    const off = !camBtn.classList.contains('off');
    camBtn.classList.toggle('off', off);
    camBtn.innerHTML = off ? ICON.videoOff : ICON.video;
    camBtn.setAttribute('aria-label', off ? 'Turn camera on' : 'Turn camera off');
    cam(off);
  };
  if (flipBtn && isPhone()) {
    hasSeveralCameras().then((yes) => { if (yes) flipBtn.classList.remove('hidden'); });
    flipBtn.onclick = async () => {
      flipBtn.disabled = true;
      try {
        const facing = await flip();
        if (facing && localVideo) { localVideo.srcObject = stream; localVideo.classList.toggle('mirror', facing === 'user'); localVideo.play().catch(() => {}); }
      } finally { flipBtn.disabled = false; }
    };
  }
  root.querySelector('#call-end').onclick = end;
}

// On a call the controls fade away after a few quiet seconds so the picture has the whole screen;
// any touch or mouse movement brings them back.
function wireIdle(root) {
  let t = null;
  const wake = () => {
    root.classList.remove('idle');
    clearTimeout(t);
    t = setTimeout(() => { if (root.dataset.phase === 'live') root.classList.add('idle'); }, 4000);
  };
  ['pointermove', 'pointerdown', 'keydown'].forEach((ev) => root.addEventListener(ev, wake));
  wake();
  cleanups.push(() => clearTimeout(t));
}

// The small self-view can be dragged anywhere and settles in the nearest corner. A tap (a press that
// barely moves) calls onTap instead.
export function makeDraggable(pip, { onTap, canDrag } = {}) {
  if (!pip) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, down = false, dragging = false;
  pip.addEventListener('pointerdown', (e) => {
    down = true; dragging = false;
    const r = pip.getBoundingClientRect();
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
  });
  pip.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < 8 || (canDrag && !canDrag())) return;
      dragging = true;
      pip.setPointerCapture(e.pointerId);
      pip.classList.add('dragging');
    }
    pip.style.left = ox + e.clientX - sx + 'px'; pip.style.top = oy + e.clientY - sy + 'px';
    pip.style.right = 'auto'; pip.style.bottom = 'auto';
  });
  const drop = (e) => {
    if (!down) return;
    down = false;
    if (!dragging) { if (onTap && e.type === 'pointerup') { e.stopPropagation(); onTap(); } return; }
    dragging = false;
    pip.classList.remove('dragging');
    const r = pip.getBoundingClientRect();
    const right = r.left + r.width / 2 > innerWidth / 2, bottom = r.top + r.height / 2 > innerHeight / 2;
    pip.style.left = pip.style.top = pip.style.right = pip.style.bottom = '';
    pip.dataset.corner = `${bottom ? 'b' : 't'}${right ? 'r' : 'l'}`;
  };
  pip.addEventListener('pointerup', drop);
  pip.addEventListener('pointercancel', drop);
}

function closeOverlay() {
  androidInCall(false);
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  timers = [];
  cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  cleanups = [];
  stopRing();
  if (overlay) {
    const node = overlay, seq = ++overlaySeq;
    node.classList.add('closing');
    setTimeout(() => { if (seq !== overlaySeq) return; node.classList.add('hidden'); node.classList.remove('closing', 'idle', 'swapped'); node.innerHTML = ''; }, 200);
  }
  session = null; group = null; pendingInvite = null;
}
