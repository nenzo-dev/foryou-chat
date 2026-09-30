// The video call inside a blind date: up to three people, everybody connected to everybody (the same
// "mesh" and signalling as js/lib/groupcall.js), with one rule on top -- the blindfold. Until the date
// is revealed, a dater's camera is never sent to the other dater at all: the video sender for that
// connection carries no track (replaceTrack(null)), so there is nothing on the wire to peek at. The
// host's connections carry video both ways from the start. When the database says the blindfold is
// open, the camera is put on the dater-to-dater connection without renegotiating.
//
// People are addressed by seat id (blind_date_members.id), never by account id, and only seats the
// database has listed for this date are talked to (setPeople). Who is a host and who is a dater comes
// from the database too, never from the other side's own messages.
import { channel } from './db.js';
import { randomToken } from './util.js';
import { currentIce, refreshIce } from './ice.js';
import { isPhone, groupLimits } from './callhealth.js';
import { swapCameraTrack } from './rtc.js';

export class DateCall {
  constructor({ seat, role, revealed = false }) {
    this.seat = seat; this.role = role; this.revealed = revealed;
    this.nonce = randomToken(6); this.attempt = 0;
    this.handlers = {};
    this.peers = new Map();   // seat -> peer
    this.roles = new Map();   // seat -> 'host' | 'dater', from the database
    this.waiting = [];        // signals from seats the database hasn't listed yet
    this.local = null; this.ch = null; this.left = false;
    this.mediaState = { audio: true, video: true };
    this.phone = isPhone();
    this.facing = 'user';
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); return this; }
  emit(evt, data) { (this.handlers[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
  changed() { this.emit('peers', this.list()); }
  list() { return [...this.peers.values()].map((p) => ({ seat: p.id, role: this.roles.get(p.id), media: p.media, stream: p.stream, state: p.state })); }

  // A dater's picture goes to the host always, and to the other dater only once the blindfold is open.
  allowVideo(seat) { return !(this.role === 'dater' && this.roles.get(seat) !== 'host' && !this.revealed); }

  async join(localStream, secret) {
    this.local = localStream;
    await refreshIce();
    this.ch = channel('bdate-' + secret);
    this.ch.on('sig', (m) => this.onSignal(m));
    this.ch.on('room', (m) => { if (m && m.from !== this.seat) this.emit('room', m); });
    await this.ch.ready;
    this.hello();
    this.onHide = () => this.send({ type: 'bye' });
    addEventListener('pagehide', this.onHide);
  }

  // The database's list of who is in the date right now (people from blind_date_beat).
  setPeople(people, revealed) {
    this.roles = new Map(people.filter((p) => !p.is_me && p.active).map((p) => [p.seat, p.role]));
    for (const id of [...this.peers.keys()]) if (!this.roles.has(id)) this.dropPeer(id);
    const queued = this.waiting.splice(0);
    for (const m of queued) if (this.roles.has(m.from)) this.onSignal(m);
    // Anyone listed that we have no connection with yet gets a fresh hello (covers a missed one).
    for (const id of this.roles.keys()) if (!this.peers.has(id)) this.hello(id);
    if (revealed && !this.revealed) this.reveal();
  }

  tell(kind) { if (this.ch) this.ch.send('room', { from: this.seat, kind }); }

  stamp() { return `${this.nonce}:${this.attempt}`; }
  send(payload, to = null) { if (this.ch) this.ch.send('sig', { from: this.seat, to, stamp: this.stamp(), ...payload }); }
  hello(to = null) { this.send({ type: 'hello', media: this.mediaState }, to); }

  onSignal(m) {
    if (this.left || !m || !m.from || m.from === this.seat) return;
    if (m.to && m.to !== this.seat) return;
    if (!this.roles.has(m.from)) {
      if (m.type !== 'bye' && this.waiting.length < 60) this.waiting.push(m);
      this.emit('unknown-seat', m.from);
      return;
    }
    switch (m.type) {
      case 'hello':
        this.meet(m);
        this.send({ type: 'hi', media: this.mediaState }, m.from);
        break;
      case 'hi': this.meet(m); break;
      case 'desc': case 'ice': {
        const peer = this.peers.get(m.from) || this.createPeer(m.from, m);
        if (peer.stamp !== m.stamp) return;
        this.negotiate(peer, m);
        break;
      }
      case 'media': { const p = this.peers.get(m.from); if (p) { p.media = m.media || p.media; this.changed(); } break; }
      case 'bye': this.dropPeer(m.from); break;
      default: break;
    }
  }

  meet(m) {
    const have = this.peers.get(m.from);
    if (have && have.stamp === m.stamp) { have.media = m.media || have.media; this.changed(); return have; }
    if (have) this.dropPeer(m.from, false);
    return this.createPeer(m.from, m);
  }

  createPeer(id, info) {
    const peer = {
      id, media: info.media || { audio: true, video: true }, stamp: info.stamp,
      pc: null, stream: new MediaStream(), state: 'connecting', polite: this.seat > id, makingOffer: false, ignoreOffer: false, sender: null, retryTimer: null,
    };
    const pc = new RTCPeerConnection({ iceServers: currentIce(), iceCandidatePoolSize: 1 });
    peer.pc = pc;
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.send({ type: 'ice', candidate: candidate.toJSON() }, id); };
    pc.ontrack = (e) => {
      const s = e.streams && e.streams[0];
      if (s) peer.stream = s; else peer.stream.addTrack(e.track);
      this.changed();
    };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ type: 'desc', description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }, id);
      } catch (e) { console.error('negotiation', e); } finally { peer.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => this.onPeerState(peer);
    if (this.local) {
      for (const t of this.local.getTracks()) {
        const sender = pc.addTrack(t, this.local);
        if (t.kind === 'video') {
          peer.sender = sender;
          // Blindfolded: the connection exists, but no picture goes down it.
          if (!this.allowVideo(id)) sender.replaceTrack(null).catch(() => {});
        }
      }
    }
    this.peers.set(id, peer);
    this.applyLimits();
    this.changed();
    return peer;
  }

  async negotiate(peer, m) {
    const pc = peer.pc;
    if (!pc) return;
    try {
      if (m.type === 'desc') {
        const d = m.description;
        const collision = d.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          await pc.setLocalDescription();
          this.send({ type: 'desc', description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }, peer.id);
        }
      } else if (m.candidate) {
        try { await pc.addIceCandidate(m.candidate); } catch (e) { if (!peer.ignoreOffer) throw e; }
      }
    } catch (e) { console.error('signal handling', e); }
  }

  onPeerState(peer) {
    const s = peer.pc ? peer.pc.connectionState : 'closed';
    peer.state = s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : s === 'disconnected' ? 'reconnecting' : 'connecting';
    if (s === 'connected') { clearTimeout(peer.retryTimer); this.applyLimits(); }
    if ((s === 'failed' || s === 'disconnected') && this.seat < peer.id) {
      clearTimeout(peer.retryTimer);
      peer.retryTimer = setTimeout(() => this.retry(peer.id), s === 'failed' ? 1000 : 6000);
    }
    this.changed();
  }

  retry(id) {
    const peer = this.peers.get(id);
    if (!peer || this.left || (peer.pc && peer.pc.connectionState === 'connected')) return;
    this.dropPeer(id, false);
    this.attempt++;
    this.hello(id);
  }

  dropPeer(id, announce = true) {
    const peer = this.peers.get(id);
    if (!peer) return;
    clearTimeout(peer.retryTimer);
    if (peer.pc) {
      peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onnegotiationneeded = peer.pc.onconnectionstatechange = null;
      try { peer.pc.close(); } catch { /* already closed */ }
    }
    this.peers.delete(id);
    if (announce) this.changed(); else this.emit('peers', this.list());
  }

  // The blindfold comes off: put the camera on every connection that was holding it back.
  async reveal() {
    this.revealed = true;
    const track = this.local && this.local.getVideoTracks()[0];
    for (const peer of this.peers.values()) {
      if (peer.sender && track && peer.sender.track !== track && this.allowVideo(peer.id)) {
        try { await peer.sender.replaceTrack(track); } catch (e) { console.error(e); }
      }
    }
    this.applyLimits();
    this.changed();
  }

  async applyLimits() {
    const lim = groupLimits({ people: this.peers.size + 1, phone: this.phone });
    for (const peer of this.peers.values()) {
      const s = peer.sender;
      if (!s || !s.getParameters) continue;
      try {
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        Object.assign(p.encodings[0], lim);
        await s.setParameters(p);
      } catch { /* the browser keeps its own limits */ }
    }
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

  async switchCamera() {
    if (!this.local) return null;
    const got = await swapCameraTrack(this.local, this.facing === 'environment' ? 'user' : 'environment', this.phone, this.mediaState.video !== false);
    if (!got) return null;
    this.facing = got.facing;
    for (const peer of this.peers.values()) {
      if (peer.sender && this.allowVideo(peer.id)) { try { await peer.sender.replaceTrack(got.track); } catch (e) { console.error(e); } }
    }
    return got.facing;
  }

  leave() {
    if (this.left) return;
    this.left = true;
    if (this.onHide) removeEventListener('pagehide', this.onHide);
    this.send({ type: 'bye' });
    for (const id of [...this.peers.keys()]) this.dropPeer(id, false);
    if (this.local) this.local.getTracks().forEach((t) => t.stop());
    if (this.ch) this.ch.close();
  }
}
