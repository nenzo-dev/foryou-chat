// One-to-one and group video calls, with screen sharing. Ported from MindCare's own rtc.js (the
// WebRTC "perfect negotiation" logic, adaptive bitrate and camera recovery have nothing
// therapy-specific about them) -- the only change is what happens on state change: instead of
// MindCare's "tell waiting clients the therapist is busy", ForYou just updates the caller's own
// presence row (touch_seen) so their contacts see "In a call".
import { channel, rpc } from './db.js';
import { randomToken } from './util.js';
import { currentIce, refreshIce } from './ice.js';
import { isPhone, cameraConstraints, sendLimits, readStats, makeStallWatch, makeAdaptor } from './callhealth.js';

export function mediaSupport() {
  return {
    secure: window.isSecureContext,
    getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    peer: 'RTCPeerConnection' in window,
    screen: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
    sinkId: 'setSinkId' in HTMLMediaElement.prototype,
  };
}

export function explainMediaError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Permission was blocked. Allow camera and microphone access in your browser settings (usually the lock icon next to the address), then try again.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera or microphone was found. Plug one in, or join without video.';
  if (n === 'NotReadableError' || n === 'AbortError') return 'Your camera or microphone is being used by another app. Close it and try again.';
  return (e && e.message) || 'Could not access your camera or microphone.';
}

export async function getLocalMedia({ audioDeviceId, videoDeviceId, small = false } = {}) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}) };
  const video = { ...cameraConstraints(isPhone() || small), facingMode: 'user', ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}) };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video });
    return { stream, hasVideo: true, hasAudio: true, note: '' };
  } catch (e1) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      return { stream, hasVideo: false, hasAudio: true, note: 'Camera unavailable. You will join with audio only. ' + explainMediaError(e1) };
    } catch (e2) { throw e1.name === 'NotAllowedError' ? e1 : e2; }
  }
}

export class CallSession {
  constructor({ roomKey, me, role, peerId }) {
    this.roomKey = roomKey; this.me = me; this.role = role; this.peerId = peerId;
    this.polite = role === 'guest';
    this.nonce = randomToken(6);
    this.handlers = {};
    this.pc = null; this.dc = null; this.local = null; this.remote = new MediaStream();
    this.makingOffer = false; this.ignoreOffer = false;
    this.videoSender = null; this.screenTrack = null; this.screenStream = null;
    this.mediaState = { audio: true, video: true, screen: false };
    this.pending = [];
    this.guestNonce = null;
    this.state = 'idle';
    this.connectedAt = null;
    this.admitKey = 'fy_admit_' + roomKey;
    this.left = false;
    this.phone = isPhone();
    this.lowByLink = false; this.lowByPeer = false;
    this.recovering = false;
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); return this; }
  emit(evt, data) { (this.handlers[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
  setState(s) {
    if (this.state === s) return;
    this.state = s;
    rpc('touch_seen', { p_in_call: s === 'connected' || s === 'reconnecting' }).catch(() => {});
    this.emit('state', s);
  }

  async join(localStream) {
    this.local = localStream;
    this.watchCamera(localStream && localStream.getVideoTracks()[0]);
    this.onVisible = () => { if (!document.hidden) this.recoverCamera(); };
    document.addEventListener('visibilitychange', this.onVisible);
    await refreshIce();
    this.ch = channel('call-' + this.roomKey);
    this.ch.on('sig', (m) => this.onSignal(m));
    await this.ch.ready;
    this.setState(this.role === 'guest' ? 'waiting' : 'open');
    this.hello(false);
  }

  send(payload) { if (this.ch) this.ch.send('sig', { from: this.me.id, nonce: this.nonce, ...payload }); }
  hello(reply) { this.send({ type: 'hello', name: this.me.full_name, role: this.role, reply, media: this.mediaState }); }

  async onSignal(m) {
    if (this.left || !m || m.from === this.me.id) return;
    if (this.peerId && m.from !== this.peerId) return;
    switch (m.type) {
      case 'hello':
        if (!m.reply) this.hello(true);
        this.emit('peer-present', { name: m.name });
        if (m.media) { this.remoteMedia = m.media; this.emit('remote-media', m.media); }
        if (this.role === 'host') {
          if (this.guestNonce === m.nonce) return;
          this.guestNonce = m.nonce;
          this.guestName = m.name;
          this.admit();
        }
        break;
      case 'admit':
        if (this.role === 'guest') { this.emit('admitted'); this.startPeer(); }
        break;
      case 'deny':
        this.emit('denied');
        break;
      case 'desc': case 'ice':
        if (!this.pc) { this.pending.push(m); break; }
        await this.handleNegotiation(m);
        break;
      case 'media':
        this.remoteMedia = m.media;
        this.emit('remote-media', m.media);
        break;
      case 'video-report':
        this.lowByPeer = !!m.stalled;
        this.emit('my-video-stalled', this.lowByPeer);
        this.applySendLimits();
        break;
      case 'bye':
        this.closePeer();
        this.emit('remote-left', { ended: !!m.ended });
        if (m.ended) this.setState('ended');
        else this.setState(this.role === 'host' ? 'open' : 'waiting');
        if (this.role === 'host') this.guestNonce = null;
        break;
      default: break;
    }
  }

  admit() {
    if (this.role !== 'host') return;
    if (this.peerId) sessionStorage.setItem(this.admitKey, this.peerId);
    this.send({ type: 'admit' });
    this.emit('admitted');
    this.startPeer();
  }

  deny() { this.send({ type: 'deny' }); this.guestNonce = null; }

  startPeer() {
    this.closePeer();
    const pc = new RTCPeerConnection({ iceServers: currentIce(), iceCandidatePoolSize: 2 });
    this.pc = pc;
    this.remote = new MediaStream();
    this.emit('remote-stream', this.remote);
    this.makingOffer = false; this.ignoreOffer = false;
    this.lowByLink = false; this.lowByPeer = false;

    pc.onicecandidate = ({ candidate }) => { if (candidate) this.send({ type: 'ice', candidate: candidate.toJSON() }); };
    pc.ontrack = (e) => {
      const s = e.streams && e.streams[0];
      if (s) { if (this.remote !== s) { this.remote = s; this.emit('remote-stream', s); } }
      else { this.remote.addTrack(e.track); this.emit('remote-stream', this.remote); }
    };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ type: 'desc', description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      } catch (e) { console.error('negotiation', e); } finally { this.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => this.onConnectionState(pc);
    if (this.role === 'host') this.attachChannel(pc.createDataChannel('chat', { ordered: true }));
    else pc.ondatachannel = (e) => this.attachChannel(e.channel);

    if (this.local) {
      for (const t of this.local.getTracks()) {
        const sender = pc.addTrack(t, this.local);
        if (t.kind === 'video') this.videoSender = sender;
      }
    }
    this.setState('connecting');
    const queued = this.pending.splice(0);
    queued.reduce((p, m) => p.then(() => this.handleNegotiation(m)), Promise.resolve());
  }

  async handleNegotiation(m) {
    const pc = this.pc;
    try {
      if (m.type === 'desc') {
        const d = m.description;
        const collision = d.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          await pc.setLocalDescription();
          this.send({ type: 'desc', description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        }
      } else if (m.candidate) {
        try { await pc.addIceCandidate(m.candidate); } catch (e) { if (!this.ignoreOffer) throw e; }
      }
    } catch (e) { console.error('signal handling', e); }
  }

  onConnectionState(pc) {
    if (pc !== this.pc) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      clearTimeout(this.restartTimer);
      if (!this.connectedAt) this.connectedAt = Date.now();
      this.setState('connected');
      this.applySendLimits();
      this.startStats();
    } else if (s === 'connecting') {
      if (this.state !== 'connected') this.setState('connecting');
    } else if (s === 'disconnected') {
      this.setState('reconnecting');
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.tryRestart(), 4000);
    } else if (s === 'failed') {
      this.setState('reconnecting');
      this.tryRestart();
    }
  }

  tryRestart() {
    if (!this.pc || this.left) return;
    if (this.role === 'host' && this.pc.restartIce) { try { this.pc.restartIce(); } catch (e) { console.error(e); } }
    clearTimeout(this.failTimer);
    this.failTimer = setTimeout(() => { if (this.pc && this.pc.connectionState !== 'connected') { this.setState('failed'); this.emit('failed'); } }, 20000);
  }

  attachChannel(dc) {
    this.dc = dc;
    dc.onopen = () => this.emit('chat-open');
    dc.onclose = () => this.emit('chat-close');
    dc.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.t === 'chat') this.emit('chat', m); } catch { /* ignore */ } };
  }

  sendChat(text) {
    if (!this.dc || this.dc.readyState !== 'open') throw new Error('Chat is not connected yet.');
    const m = { t: 'chat', text, from: this.me.id, name: this.me.full_name, at: Date.now() };
    this.dc.send(JSON.stringify(m));
    return m;
  }

  startStats(everyMs = 3000) {
    clearInterval(this.statsTimer);
    let prev = {}, stalled = false;
    const watch = makeStallWatch(2), adapt = makeAdaptor();
    this.statsTimer = setInterval(async () => {
      if (!this.pc) return;
      try {
        const entries = [];
        (await this.pc.getStats()).forEach((r) => entries.push(r));
        const { level, rtt, loss, frames } = readStats(entries, prev);
        prev = { lost: prev.lost, recv: prev.recv, ...readStats(entries, prev).next };
        this.emit('quality', { level, rtt, loss });
        const low = adapt(level);
        if (low !== this.lowByLink) { this.lowByLink = low; this.applySendLimits(); }
        const rm = this.remoteMedia;
        const now = watch.look(frames, !rm || rm.video !== false || !!rm.screen);
        if (now !== stalled) { stalled = now; this.emit('video-stalled', now); this.send({ type: 'video-report', stalled: now }); }
      } catch { /* stats not available */ }
    }, everyMs);
  }

  async applySendLimits() {
    const sender = this.videoSender;
    if (!sender || !sender.getParameters || this.screenTrack) return;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      Object.assign(p.encodings[0], sendLimits({ phone: this.phone, low: this.lowByLink || this.lowByPeer }));
      await sender.setParameters(p);
    } catch { /* the browser keeps its own limits */ }
  }

  watchCamera(track) {
    if (track) track.addEventListener('ended', () => { if (!document.hidden) this.recoverCamera(); });
  }

  async recoverCamera() {
    const old = this.local && this.local.getVideoTracks()[0];
    if (this.left || this.recovering || !old || old.readyState !== 'ended' || this.screenTrack) return false;
    this.recovering = true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { ...cameraConstraints(this.phone), facingMode: 'user' } });
      const track = s.getVideoTracks()[0];
      if (!track) return false;
      track.enabled = this.mediaState.video !== false;
      this.local.removeTrack(old); this.local.addTrack(track);
      if (this.videoSender) await this.videoSender.replaceTrack(track);
      else if (this.pc) this.videoSender = this.pc.addTrack(track, this.local);
      this.watchCamera(track);
      this.applySendLimits();
      this.emit('camera-restarted');
      return true;
    } catch { return false; } finally { this.recovering = false; }
  }

  announce() { this.send({ type: 'media', media: this.mediaState }); }

  setMuted(muted) {
    const t = this.local && this.local.getAudioTracks()[0];
    if (t) t.enabled = !muted;
    this.mediaState = { ...this.mediaState, audio: !muted };
    this.announce();
  }

  setCameraOff(off) {
    const t = this.local && this.local.getVideoTracks()[0];
    if (t) t.enabled = !off;
    this.mediaState = { ...this.mediaState, video: !off };
    this.announce();
  }

  async startScreen() {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = s.getVideoTracks()[0];
    track.onended = () => this.stopScreen();
    this.screenTrack = track; this.screenStream = s;
    if (this.videoSender) await this.videoSender.replaceTrack(track);
    else if (this.pc) this.videoSender = this.pc.addTrack(track, s);
    this.mediaState = { ...this.mediaState, screen: true };
    this.announce();
    this.emit('screen', s);
  }

  async stopScreen() {
    if (!this.screenTrack) return;
    const cam = (this.local && this.local.getVideoTracks()[0]) || null;
    try { if (this.videoSender) await this.videoSender.replaceTrack(cam); } catch (e) { console.error(e); }
    this.screenTrack.stop(); this.screenTrack = null; this.screenStream = null;
    this.mediaState = { ...this.mediaState, screen: false };
    this.announce();
    this.applySendLimits();
    this.emit('screen', null);
  }

  closePeer() {
    clearInterval(this.statsTimer); clearTimeout(this.restartTimer); clearTimeout(this.failTimer);
    if (this.dc) { try { this.dc.close(); } catch { /* already closed */ } this.dc = null; }
    if (this.pc) {
      this.pc.onicecandidate = this.pc.ontrack = this.pc.onnegotiationneeded = this.pc.onconnectionstatechange = null;
      try { this.pc.close(); } catch { /* already closed */ }
      this.pc = null;
    }
    this.videoSender = null;
  }

  leave(ended = false) {
    if (this.left) return;
    this.send({ type: 'bye', ended });
    if (ended) sessionStorage.removeItem(this.admitKey);
    this.left = true;
    if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
    this.closePeer();
    if (this.screenTrack) { this.screenTrack.stop(); this.screenTrack = null; }
    if (this.local) this.local.getTracks().forEach((t) => t.stop());
    if (this.ch) this.ch.close();
    this.setState('left');
    rpc('touch_seen', { p_in_call: false }).catch(() => {});
  }
}
