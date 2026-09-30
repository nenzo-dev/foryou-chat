// One blind date (#/date/<id>): picking a seat, then the date itself, full screen.
//
//   Dater, before the reveal  a "You're blindfolded" screen: your date's voice (no picture, no name),
//                             the host in a small circle, and your own camera, which only the host gets.
//   Host                      both daters side by side, and the "Open blindfold" button.
//   The reveal                a 3-2-1 countdown on every screen, the blindfold falls away, and the two
//                             daters see each other ("Meet Chanda").
//
// With no host in the room, each dater gets an "I'm ready" button instead and the blindfold opens once
// both have pressed it. The database decides all of this (reveal_blind_date); this screen follows it.
import { avatarUrl } from '../lib/db.js';
import { getLocalMedia, mediaSupport, explainMediaError } from '../lib/rtc.js';
import { DateCall } from '../lib/datecall.js';
import { dateInfo, joinDate, dateBeat, revealDate, endDate, leaveDate, dateLink } from '../lib/dates.js';
import { watchLevel, audioContext, SPEAKING } from '../lib/audiolevel.js';
import { isBusy, setBusyElsewhere, wireDock, makeDraggable } from './callui.js';
import { BLINDFOLD_ART } from './dates.js';
import { toast, friendlyError, choose } from '../lib/ui.js';
import { escapeHtml, initials, duration, cssColor } from '../lib/util.js';
import { ICON } from '../lib/icons.js';
import { state } from '../state.js';

const BEAT_MS = 10000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

function avatarHtml(p, cls = '') {
  if (p && p.avatar_path) return `<img class="avatar ${cls}" src="${escapeHtml(avatarUrl(p.avatar_path))}" alt="">`;
  const label = p && p.name ? initials(p.name) : '?';
  return `<div class="avatar ${cls}" style="background:${cssColor(p && p.avatar_color, '#e0306b')}">${escapeHtml(label)}</div>`;
}

export async function mountDate(root, dateId) {
  let disposed = false;
  let teardown = () => {};
  root.innerHTML = `<div class="bd-page"><div class="empty-state"><div class="thread-loading"><span></span><span></span><span></span></div></div></div>`;

  let info;
  try { info = await dateInfo(dateId); }
  catch (e) { return notice('Something went wrong', friendlyError(e)); }
  if (disposed) return () => {};
  if (!info) return notice("This date isn't here any more", 'Everyone left, so the room closed. There are other rooms open in the lobby.');
  if (info.ended) return notice("That's a wrap", 'This blind date has ended.');

  const picked = readPick();
  if (info.my_role) enter(null);
  else if (picked) enter(picked);
  else paintJoin();

  return () => { disposed = true; teardown(); };

  function notice(title, text) {
    root.innerHTML = `<div class="bd-page"><div class="bd-notice">${BLINDFOLD_ART}<h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p><a class="btn btn-rose" href="#/dates">Back to blind dates</a></div></div>`;
    return () => { disposed = true; };
  }

  function readPick() {
    try {
      const v = JSON.parse(sessionStorage.getItem('fy_date_seat') || 'null');
      sessionStorage.removeItem('fy_date_seat');
      return v && v.id === dateId && (v.role === 'host' || v.role === 'dater') ? v.role : null;
    } catch { return null; }
  }

  function paintJoin(error = '') {
    const hostFree = info.host_open && !info.revealed;
    const daterFree = info.daters < 2 && !info.revealed;
    const choice = daterFree ? 'dater' : hostFree ? 'host' : null;
    root.innerHTML = `
    <div class="bd-page">
      <div class="thread-head bd-head">
        <button class="back-btn" id="bj-back" aria-label="Back">${ICON.back}</button>
        <div class="info"><span class="name">Blind date</span><span class="status">UNILUS</span></div>
      </div>
      <div class="bd-scroll">
        <section class="bd-join">
          <div class="bd-aurora"><i></i><i></i><i></i></div>
          ${BLINDFOLD_ART}
          <p class="bd-kicker">You're invited</p>
          <h1 class="bd-title sm">${escapeHtml(info.title || 'A blind date')}</h1>
          <p class="bd-lead">${info.host_name ? `Hosted by ${escapeHtml(firstName(info.host_name))}` : 'No host yet'} · ${info.daters} of 2 daters here</p>
          <div class="seat-pick">
            <button type="button" class="seat-opt${choice === 'dater' ? ' active' : ''}" data-role="dater" ${daterFree ? '' : 'disabled'}>${ICON.blindfold}<b>Dater</b><span>${daterFree ? 'Go in blindfolded' : 'Both seats taken'}</span></button>
            <button type="button" class="seat-opt${choice === 'host' ? ' active' : ''}" data-role="host" ${hostFree ? '' : 'disabled'}>${ICON.crown}<b>Host</b><span>${hostFree ? 'See both, open the blindfold' : 'Already has a host'}</span></button>
          </div>
          <button class="btn btn-rose btn-block" id="bj-go" ${choice ? '' : 'disabled'}>${choice ? 'Take my seat' : 'This room is full'}</button>
          <p class="form-msg err" id="bj-msg">${escapeHtml(error)}</p>
          <p class="bd-safety">${ICON.lock}<span>You'll be asked for your camera and microphone. Until the reveal, your camera only reaches the host.</span></p>
        </section>
      </div>
    </div>`;
    let role = choice;
    root.querySelector('#bj-back').onclick = () => { location.hash = '#/dates'; };
    root.querySelectorAll('.seat-opt').forEach((b) => b.addEventListener('click', () => {
      if (b.disabled) return;
      role = b.dataset.role;
      root.querySelectorAll('.seat-opt').forEach((x) => x.classList.toggle('active', x === b));
    }));
    root.querySelector('#bj-go').addEventListener('click', (e) => { if (role) { e.currentTarget.disabled = true; e.currentTarget.textContent = 'Getting your camera ready…'; enter(role); } });
  }

  async function enter(role) {
    if (isBusy()) { toast('Finish your call first, then come back to the date.'); if (!info.my_role) paintJoin(); return; }
    const sup = mediaSupport();
    if (!sup.getUserMedia || !sup.peer) { if (!info.my_role) paintJoin("This browser can't do video calls. Try Chrome, Edge, Firefox or Safari."); return; }
    let media;
    try { media = await getLocalMedia({ small: true }); }
    catch (e) { if (!disposed) { if (info.my_role) notice('Camera and microphone needed', explainMediaError(e)); else paintJoin(explainMediaError(e)); } return; }
    const stopMedia = () => media.stream.getTracks().forEach((t) => t.stop());
    if (disposed) { stopMedia(); return; }
    let joined, first;
    try {
      joined = await joinDate(dateId, role);
      first = await dateBeat(dateId);
    } catch (e) {
      stopMedia();
      if (disposed) return;
      let fresh = info;
      try { fresh = await dateInfo(dateId); } catch { /* keep the old info */ }
      if (!fresh) { notice("This date isn't here any more", 'Everyone left, so the room closed. There are other rooms open in the lobby.'); return; }
      if (fresh.ended) { notice("That's a wrap", 'This blind date has ended.'); return; }
      info = fresh;
      paintJoin(friendlyError(e));
      return;
    }
    if (disposed) { stopMedia(); leaveDate(dateId).catch(() => {}); return; }
    if (first.ended) { stopMedia(); notice("That's a wrap", 'This blind date has ended.'); return; }
    teardown = runStage(media, joined, first);
  }

  /* -------------------------------- the date itself -------------------------------- */

  function runStage(media, joined, first) {
    const myRole = joined.role;
    const call = new DateCall({ seat: joined.seat, role: myRole, revealed: first.revealed });
    setBusyElsewhere(true);
    let st = first, left = false, startedAt = null, revealShown = first.revealed, beatTimer = null, soonTimer = null;
    const audioEls = new Map();   // seat -> <audio>
    const watchers = new Map();   // seat -> { key, stop }
    const timers = [];

    const stage = document.createElement('div');
    stage.className = 'bd-stage';
    stage.dataset.role = myRole;
    stage.dataset.phase = first.revealed ? 'revealed' : 'blind';
    stage.innerHTML = `
      <div class="bd-aurora"><i></i><i></i><i></i></div>
      <header class="bd-bar">
        <button class="bd-round" id="bd-leave" aria-label="Leave the date">${ICON.close}</button>
        <div class="bd-bar-title"><span class="t">${escapeHtml(first.title || 'Blind date')}</span><span class="s" id="bd-sub">&nbsp;</span></div>
        <button class="bd-round" id="bd-invite" aria-label="Invite someone">${ICON.share}</button>
      </header>

      <section class="bd-blind">
        <div class="bd-blind-art">${BLINDFOLD_ART}</div>
        <h2 class="bd-blind-title">You're blindfolded</h2>
        <p class="bd-blind-text" id="bd-blind-text"></p>
        <div class="bd-voices">
          <div class="voice" id="bd-v-date"><div class="orb"><span class="rip"></span><span class="rip r2"></span><span class="q">?</span></div><b>Your date</b><span class="st" id="bd-v-date-st">Not here yet</span></div>
          <div class="voice me" id="bd-v-me"><div class="orb"><span class="hi" id="bd-v-me-hi"></span><video class="mirror" muted playsinline autoplay></video></div><b>You</b><span class="st" id="bd-v-me-st"></span></div>
          <div class="voice host hidden" id="bd-v-host"><div class="orb"><span class="rip"></span><span class="hi" id="bd-v-host-hi"></span><video muted playsinline autoplay></video></div><b id="bd-v-host-name">Host</b><span class="st">Host</span></div>
        </div>
        <button class="btn btn-rose hidden" id="bd-ready">${ICON.eye} I'm ready to see them</button>
      </section>

      <section class="bd-seen">
        <video class="bd-date-video" id="bd-date-video" muted playsinline autoplay></video>
        <div class="bd-date-off" id="bd-date-off"></div>
        <div class="bd-meet" id="bd-meet"><span>Meet</span><b id="bd-meet-name"></b></div>
        <div class="bd-host-pip hidden" id="bd-host-pip"><video muted playsinline autoplay></video><span id="bd-host-pip-name">Host</span></div>
      </section>

      <section class="bd-hostview">
        <div class="bd-pair">
          ${[0, 1].map((i) => `
          <div class="bd-tile empty" id="bd-t${i}">
            <video muted playsinline autoplay></video>
            <div class="bd-tile-off"></div>
            <div class="bd-tile-empty">${ICON.blindfold}<span>Waiting for a dater</span></div>
            <div class="bd-tile-tag"><b class="nm"></b><span class="chip-blind">${ICON.eyeOff}<span>Blindfolded</span></span></div>
          </div>${i === 0 ? `<div class="bd-link">${ICON.heartFill}</div>` : ''}`).join('')}
        </div>
        <div class="bd-open-wrap">
          <button class="bd-open" id="bd-open" disabled><span class="bd-open-glow"></span>${ICON.eye}<span>Open blindfold</span></button>
          <p class="bd-open-hint" id="bd-open-hint"></p>
        </div>
      </section>

      <div class="bd-tear" aria-hidden="true"><div class="half l">${BLINDFOLD_ART}</div><div class="half r">${BLINDFOLD_ART}</div></div>
      <div class="bd-countdown" id="bd-countdown" aria-live="assertive"></div>
      <div class="bd-self" id="bd-self"><video class="mirror" muted playsinline autoplay></video><span class="bd-self-note" id="bd-self-note"></span></div>
      <div class="call-dock bd-dock">
        <button class="dock-btn" id="call-mute" aria-label="Mute microphone">${ICON.mic}</button>
        <button class="dock-btn" id="call-cam" aria-label="Turn camera off">${ICON.video}</button>
        <button class="dock-btn hidden" id="call-flip" aria-label="Switch camera">${ICON.flip}</button>
        <button class="dock-btn end" id="call-end" aria-label="Leave the date">${ICON.phoneDown}</button>
      </div>
      <button class="bd-sound hidden" id="bd-sound" type="button">Tap to turn on sound</button>
      <div class="bd-ended hidden" id="bd-ended"></div>
      <div id="bd-audio" hidden></div>`;
    root.innerHTML = '';
    root.appendChild(stage);
    const $ = (sel) => stage.querySelector(sel);

    const selfV = $('#bd-self video');
    const orbV = $('#bd-v-me video');
    selfV.srcObject = media.stream;
    orbV.srcObject = media.stream;
    $('#bd-v-me-hi').textContent = initials((state.profile && state.profile.full_name) || 'You');
    if (!media.hasVideo) { $('#bd-self').classList.add('off'); $('#bd-v-me').classList.add('off'); }
    makeDraggable($('#bd-self'));
    stage.addEventListener('click', () => { audioContext(); });

    wireDock(stage, {
      mute: (on) => call.setMuted(on),
      cam: (off) => { call.setCameraOff(off); $('#bd-self').classList.toggle('off', off); $('#bd-v-me').classList.toggle('off', off); },
      flip: async () => {
        const facing = await call.switchCamera();
        if (facing) { orbV.srcObject = media.stream; orbV.classList.toggle('mirror', facing === 'user'); orbV.play().catch(() => {}); }
        return facing;
      },
      localVideo: selfV, stream: media.stream,
      end: () => leaveFlow(),
    });
    $('#bd-leave').onclick = () => leaveFlow();
    $('#bd-invite').onclick = invite;
    $('#bd-open').onclick = openBlindfold;
    $('#bd-ready').onclick = imReady;
    $('#bd-sound').onclick = () => { audioContext(); audioEls.forEach((a) => a.play().catch(() => {})); $('#bd-sound').classList.add('hidden'); };

    call.on('peers', () => { syncMedia(); paint(); });
    call.on('room', () => beatSoon());
    call.on('unknown-seat', () => beatSoon());

    call.setPeople(first.people, first.revealed);
    call.join(media.stream, joined.secret).catch((e) => { toast(friendlyError(e)); });
    beatTimer = setInterval(beat, BEAT_MS);
    timers.push(setInterval(paintSub, 1000));
    applyState(first);

    return (opts = {}) => stop(opts);

    /* ---- state ---- */

    function people() { return (st && st.people) || []; }
    function me() { return people().find((p) => p.is_me) || {}; }
    function host() { return people().find((p) => p.role === 'host' && p.active); }
    function daters() { return people().filter((p) => p.role === 'dater' && p.active); }
    function myDate() { return people().find((p) => p.role === 'dater' && !p.is_me && p.active); }
    function peerOf(seat) { return seat ? call.list().find((x) => x.seat === seat) : null; }

    async function beat() {
      if (left) return;
      try { applyState(await dateBeat(dateId)); }
      catch (e) { if (e && e.show) finish('removed'); /* otherwise a network blip: try again next time */ }
    }
    function beatSoon() { clearTimeout(soonTimer); soonTimer = setTimeout(beat, 250); }

    function applyState(next) {
      if (left) return;
      if (!next) { finish('removed'); return; }
      st = next;
      if (st.ended) { finish('ended'); return; }
      call.setPeople(st.people, st.revealed);
      if (!startedAt && daters().length === 2) startedAt = Date.now();
      if (st.revealed && !revealShown) runReveal();
      paint();
    }

    /* ---- sound and pictures ---- */

    function syncMedia() {
      const peers = call.list();
      const box = $('#bd-audio');
      const seen = new Set();
      for (const p of peers) {
        seen.add(p.seat);
        let a = audioEls.get(p.seat);
        if (!a) { a = document.createElement('audio'); a.autoplay = true; a.dataset.callRemote = '1'; box.appendChild(a); audioEls.set(p.seat, a); }
        if (p.stream && a.srcObject !== p.stream) {
          a.srcObject = p.stream;
          a.play().catch(() => $('#bd-sound').classList.remove('hidden'));
        }
        const key = p.stream ? `${p.stream.id}:${p.stream.getAudioTracks().length}` : '';
        const w = watchers.get(p.seat);
        if (p.stream && (!w || w.key !== key)) {
          if (w) w.stop();
          const seat = p.seat;
          watchers.set(seat, { key, stop: watchLevel(p.stream, (lv) => speaking(seat, lv > SPEAKING)) });
        }
      }
      for (const [seat, a] of audioEls) if (!seen.has(seat)) { a.srcObject = null; a.remove(); audioEls.delete(seat); }
      for (const [seat, w] of watchers) if (!seen.has(seat)) { w.stop(); watchers.delete(seat); }
    }

    function speaking(seat, on) {
      const h = host(), d = myDate();
      if (myRole === 'host') {
        daters().forEach((p, i) => { if (p.seat === seat) $(`#bd-t${i}`).classList.toggle('speaking', on); });
      } else {
        if (d && d.seat === seat) { $('#bd-v-date').classList.toggle('speaking', on); $('#bd-date-video').parentElement.classList.toggle('speaking', on); }
        if (h && h.seat === seat) { $('#bd-v-host').classList.toggle('speaking', on); $('#bd-host-pip').classList.toggle('speaking', on); }
      }
    }

    function setVideo(v, stream) {
      if (!v) return;
      if ((v.srcObject || null) === (stream || null)) return;
      v.srcObject = stream || null;
      if (stream) v.play().catch(() => {});
    }

    /* ---- painting ---- */

    function paint() {
      if (left) return;
      if (myRole === 'host') paintHost(); else paintDater();
      $('#bd-self-note').textContent = 'You';
      $('#bd-v-me-st').textContent = host() ? 'Only the host sees you' : 'No one sees you yet';
      paintSub();
    }

    function paintSub() {
      const sub = $('#bd-sub');
      if (!sub || !st) return;
      const t = startedAt ? duration((Date.now() - startedAt) / 1000) : '';
      const n = daters().length;
      if (stage.dataset.phase === 'countdown') sub.textContent = 'Opening the blindfold…';
      else if (st.revealed) sub.textContent = `Blindfold off${t ? ' · ' + t : ''}`;
      else if (myRole === 'host') sub.textContent = n === 2 ? `Both daters are here${t ? ' · ' + t : ''}` : n === 1 ? 'One dater is here' : 'Waiting for two daters';
      else sub.textContent = myDate() ? `Blindfolded${t ? ' · ' + t : ''}` : 'Waiting for your date…';
    }

    function paintDater() {
      const h = host(), d = myDate(), mine = me();
      const hp = h && peerOf(h.seat), dp = d && peerOf(d.seat);

      // Your date: a voice until the reveal.
      const dateSt = $('#bd-v-date-st');
      $('#bd-v-date').classList.toggle('present', !!d);
      dateSt.textContent = !d ? 'Not here yet' : !dp || dp.state !== 'connected' ? 'Connecting…' : (!h && d.ready ? 'Ready to see you' : 'Here with you');

      // The host: small circle, with picture (the host is never blindfolded).
      $('#bd-v-host').classList.toggle('hidden', !h);
      if (h) {
        $('#bd-v-host-name').textContent = firstName(h.name) || 'Host';
        $('#bd-v-host-hi').textContent = initials(h.name || 'Host');
        setVideo($('#bd-v-host video'), hp && hp.stream);
      }

      $('#bd-blind-text').textContent = !d
        ? (h ? `You're in. ${firstName(h.name) || 'The host'} can see you, and your date will join soon.` : "You're in. Your date will join soon.")
        : h
          ? `Say hi, your date can hear you. ${firstName(h.name) || 'The host'} will open the blindfold when the time is right.`
          : "Say hi, your date can hear you. There's no host in this room, so the blindfold opens once you both tap \"I'm ready\".";

      const ready = $('#bd-ready');
      const showReady = !h && !!d && !st.revealed;
      ready.classList.toggle('hidden', !showReady);
      if (showReady) {
        ready.disabled = !!mine.ready;
        ready.innerHTML = mine.ready ? `${ICON.check} Waiting for your date to be ready` : `${ICON.eye} I'm ready to see them`;
      }

      // After the reveal.
      if (st.revealed) {
        const v = $('#bd-date-video');
        setVideo(v, dp && dp.stream);
        const camOff = !!(dp && dp.media && dp.media.video === false);
        const noPicture = !dp || !dp.stream || !dp.stream.getVideoTracks().length || dp.state !== 'connected';
        const offText = !d ? 'Your date has left the room' : camOff ? `${firstName(d.name)}'s camera is off` : 'Connecting…';
        const off = $('#bd-date-off');
        if (off.dataset.text !== offText) { off.dataset.text = offText; off.innerHTML = `${d ? avatarHtml(d, 'xxl') : ''}<span>${escapeHtml(offText)}</span>`; }
        $('.bd-seen').classList.toggle('cam-off', !d || camOff || noPicture);
        $('#bd-meet-name').textContent = d ? firstName(d.name) : '';
        $('#bd-host-pip').classList.toggle('hidden', !h);
        if (h) { $('#bd-host-pip-name').textContent = firstName(h.name) || 'Host'; setVideo($('#bd-host-pip video'), hp && hp.stream); }
      }
    }

    function paintHost() {
      const ds = daters();
      [0, 1].forEach((i) => {
        const tile = $(`#bd-t${i}`);
        const d = ds[i];
        tile.classList.toggle('empty', !d);
        if (!d) { setVideo(tile.querySelector('video'), null); tile.classList.remove('speaking'); return; }
        const p = peerOf(d.seat);
        setVideo(tile.querySelector('video'), p && p.stream);
        tile.classList.toggle('cam-off', !p || !p.stream || !p.stream.getVideoTracks().length || !!(p.media && p.media.video === false));
        tile.classList.toggle('connecting', !p || p.state !== 'connected');
        tile.querySelector('.nm').textContent = firstName(d.name) || 'Dater';
        const off = tile.querySelector('.bd-tile-off');
        if (off.dataset.seat !== d.seat) { off.dataset.seat = d.seat; off.innerHTML = avatarHtml(d, 'xl'); }
        tile.querySelector('.chip-blind').innerHTML = st.revealed ? `${ICON.eye}<span>Can see each other</span>` : `${ICON.eyeOff}<span>Blindfolded</span>`;
      });
      const btn = $('#bd-open'), hint = $('#bd-open-hint');
      btn.classList.toggle('hidden', !!st.revealed);
      btn.disabled = ds.length < 2;
      hint.textContent = st.revealed
        ? `The blindfold is off. ${firstName(ds[0] && ds[0].name) || 'They'} and ${firstName(ds[1] && ds[1].name) || 'their date'} can see each other now.`
        : ds.length < 2 ? 'The button wakes up once both daters are here.' : "They can hear each other, but can't see each other. Open it when the moment's right.";
    }

    /* ---- the reveal ---- */

    async function openBlindfold() {
      const btn = $('#bd-open');
      btn.disabled = true;
      try { const s = await revealDate(dateId); call.tell('reveal'); applyState(s); }
      catch (e) { toast(friendlyError(e)); btn.disabled = false; }
    }

    async function imReady() {
      $('#bd-ready').disabled = true;
      try { const s = await revealDate(dateId); call.tell(s && s.revealed ? 'reveal' : 'ready'); applyState(s); }
      catch (e) { toast(friendlyError(e)); $('#bd-ready').disabled = false; }
    }

    async function runReveal() {
      revealShown = true;
      const cd = $('#bd-countdown');
      stage.dataset.phase = 'countdown';
      for (const n of [3, 2, 1]) {
        if (left) return;
        cd.innerHTML = `<span class="n">${n}</span>`;
        await wait(900);
      }
      if (left) return;
      cd.innerHTML = '';
      stage.dataset.phase = 'revealed';
      stage.classList.add('just-revealed');
      if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
      timers.push(setTimeout(() => stage.classList.remove('just-revealed'), 4200));
      paint();
    }

    /* ---- leaving ---- */

    async function leaveFlow() {
      if (myRole === 'host') {
        const pick = await choose({
          title: 'Leave the date?',
          text: 'You can end it for everyone, or just step out and let the daters carry on.',
          actions: [{ id: 'end', label: 'End it for everyone', danger: true }, { id: 'leave', label: 'Just leave' }],
        });
        if (!pick) return;
        if (pick === 'end') {
          try { await endDate(dateId); call.tell('ended'); } catch (e) { toast(friendlyError(e)); return; }
        }
      } else {
        const pick = await choose({
          title: 'Leave the date?',
          text: st.revealed || !myDate() ? '' : 'Your date will be left on their own.',
          actions: [{ id: 'leave', label: 'Leave', danger: true }],
        });
        if (!pick) return;
      }
      location.hash = '#/dates';
    }

    function finish(kind) {
      if (left) return;
      const titles = {
        ended: ["That's a wrap", myRole === 'host' ? 'You ended the date.' : 'The host ended the date. Hope it went well.'],
        removed: ["You've left this date", 'Your seat was given up after the connection dropped for a while.'],
      };
      const [title, text] = titles[kind] || titles.ended;
      stop({ keepStage: true, skipLeave: kind === 'removed' });
      const box = $('#bd-ended');
      box.innerHTML = `<div class="bd-ended-card">${ICON.heartFill}<h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p><a class="btn btn-rose" href="#/dates">Back to blind dates</a></div>`;
      box.classList.remove('hidden');
    }

    function invite() {
      const url = dateLink(dateId);
      if (navigator.share) {
        navigator.share({ title: 'A blind date on ForYou', text: 'Take a seat on this blind date:', url }).catch(() => {});
      } else {
        navigator.clipboard.writeText(url).then(() => toast('Invite link copied'), () => toast(url, 6000));
      }
    }

    function stop({ keepStage = false, skipLeave = false } = {}) {
      if (left) return;
      left = true;
      clearInterval(beatTimer); clearTimeout(soonTimer);
      timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      watchers.forEach((w) => w.stop()); watchers.clear();
      audioEls.forEach((a) => { a.srcObject = null; a.remove(); }); audioEls.clear();
      call.leave();
      media.stream.getTracks().forEach((t) => t.stop());
      setBusyElsewhere(false);
      if (!skipLeave) leaveDate(dateId).catch(() => {});
      if (!keepStage) stage.remove();
    }
  }
}
