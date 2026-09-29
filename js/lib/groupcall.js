// A group video call for a room. Everybody connects to everybody else (a "mesh"), which is why the
// database caps a call at 8 people: with 8 people each sends its picture 7 times. Ported unchanged
// from MindCare's own groupcall.js -- only the import paths change.
//
// Signalling uses a live channel named after the call's secret (only room members are given it). Every
// message says who it is for. When someone arrives they say hello to everybody; each person answers, and
// the pair sets up a direct connection. `stamp` marks one attempt to connect: a new stamp means "start
// again", and answers to an older attempt are ignored.
import { channel } from './db.js';
import { randomToken } from './util.js';
import { currentIce, refreshIce } from './ice.js';
import { isPhone, groupLimits } from './callhealth.js';
import { joinCall, leaveCall } from './rooms.js';

const HEARTBEAT_MS = 15000;

export class GroupCall {
  constructor({ roomId, me }) {
    this.roomId = roomId; this.me = me;
    this.nonce = randomToken(6); this.attempt = 0;
    this.handlers = {};
    this.peers = new Map();
    this.local = null; this.ch = null; this.secret = null;
    this.mediaState = { audio: true, video: true };
    this.phone = isPhone();
    this.left = false;
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); return this; }
  emit(evt, data) { (this.handlers[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
  changed() { this.emit('peers', this.list()); }

  list() { return [...this.peers.values()].map((p) => ({ id: p.id, name: p.name, media: p.media, stream: p.stream, state: p.state })); }

  async join(localStream) {
    this.local = localStream;
    this.secret = await joinCall(this.roomId);
    await refreshIce();
    this.ch = channel('gcall-' + this.secret);
    this.ch.on('sig', (m) => this.onSignal(m));
    await this.ch.ready;
    this.hello();
    this.beat = setInterval(async () => { try { await joinCall(this.roomId); } catch (e) { this.emit('kicked', e); } }, HEARTBEAT_MS);
    this.onHide = () => this.send({ type: 'bye' });
    addEventListener('pagehide', this.onHide);
  }

  stamp() { return `${this.nonce}:${this.attempt}`; }
  send(payload, to = null) { if (this.ch) this.ch.send('sig', { from: this.me.id, to, stamp: this.stamp(), ...payload }); }
  hello(to = null) { this.send({ type: 'hello', name: this.me.full_name, media: this.mediaState }, to); }

  onSignal(m) {
    if (this.left || !m || !m.from || m.from === this.me.id) return;
    if (m.to && m.to !== this.me.id) return;
    switch (m.type) {
      case 'hello':
        this.meet(m);
        this.send({ type: 'hi', name: this.me.full_name, media: this.mediaState }, m.from);
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
    if (have && have.stamp === m.stamp) { have.name = m.name || have.name; have.media = m.media || have.media; this.changed(); return have; }
    if (have) this.dropPeer(m.from, false);
    return this.createPeer(m.from, m);
  }

  createPeer(id, info) {
    const peer = {
      id, name: info.name || 'Guest', media: info.media || { audio: true, video: true }, stamp: info.stamp,
      pc: null, stream: new MediaStream(), state: 'connecting', polite: this.me.id > id, makingOffer: false, ignoreOffer: false, sender: null, retryTimer: null,
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
        if (t.kind === 'video') peer.sender = sender;
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
    if ((s === 'failed' || s === 'disconnected') && this.me.id < peer.id) {
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
    this.applyLimits();
    if (announce) this.changed(); else this.emit('peers', this.list());
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

  async leave() {
    if (this.left) return;
    this.left = true;
    clearInterval(this.beat);
    if (this.onHide) removeEventListener('pagehide', this.onHide);
    this.send({ type: 'bye' });
    for (const id of [...this.peers.keys()]) this.dropPeer(id, false);
    if (this.local) this.local.getTracks().forEach((t) => t.stop());
    if (this.ch) this.ch.close();
    try { await leaveCall(this.roomId); } catch { /* the place frees itself after 45 seconds */ }
  }
}
