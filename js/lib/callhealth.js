// How a video call copes with a weak connection. Plain functions, no browser objects are made here.
// Ported unchanged from MindCare's own callhealth.js -- this logic has nothing therapy-specific in it.
//
//   isPhone()            a phone or tablet: it sends a smaller picture, because mobile data is the weak link
//   cameraConstraints()  the picture size asked from the camera
//   sendLimits()         the most one side sends (bit rate, frames a second, picture size)
//   groupLimits()        the same for one picture in a group call, by the number of people
//   readStats()          connection quality from one getStats() result (loss is measured over the last few seconds)
//   makeStallWatch()     tells when the other person's video has stopped arriving
//   makeAdaptor()        decides when to send a smaller picture, and when to go back

export function isPhone(nav = globalThis.navigator, win = globalThis) {
  const ua = (nav && nav.userAgent) || '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  return !!(win.matchMedia && win.matchMedia('(pointer: coarse)').matches && (win.innerWidth || 1024) < 900);
}

export const cameraConstraints = (phone) => phone
  ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }
  : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };

export const sendLimits = ({ phone = false, low = false } = {}) => low
  ? { maxBitrate: 250000, maxFramerate: 15, scaleResolutionDownBy: 2 }
  : { maxBitrate: phone ? 600000 : 1500000, maxFramerate: 24, scaleResolutionDownBy: 1 };

// Group video is a mesh: everybody sends their picture to each of the others, so the more people, the less each picture gets.
export const groupLimits = ({ people = 2, phone = false } = {}) => {
  const others = Math.max(1, people - 1);
  const budget = phone ? 500000 : 1200000;
  return { maxBitrate: Math.max(120000, Math.round(budget / others)), maxFramerate: others > 2 ? 15 : 24, scaleResolutionDownBy: others > 2 ? 2 : 1 };
};

export function readStats(entries, prev = {}) {
  let rtt = null, lost = 0, recv = 0, frames = null;
  for (const r of entries) {
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
    if (r.type === 'inbound-rtp') {
      lost += r.packetsLost || 0; recv += r.packetsReceived || 0;
      if ((r.kind || r.mediaType) === 'video') frames = (frames || 0) + (r.framesDecoded || 0);
    }
  }
  const dLost = Math.max(0, lost - (prev.lost || 0)), dRecv = Math.max(0, recv - (prev.recv || 0));
  const loss = dRecv + dLost > 0 ? (dLost / (dRecv + dLost)) * 100 : 0;
  const level = rtt == null ? 'good' : rtt < 0.18 && loss < 3 ? 'good' : rtt < 0.45 && loss < 10 ? 'fair' : 'poor';
  return { level, rtt, loss, frames, next: { lost, recv } };
}

export function makeStallWatch(limit = 2) {
  let last = null, still = 0;
  return {
    look(frames, expected) {
      if (!expected || frames == null) { last = frames; still = 0; return false; }
      still = last != null && frames <= last ? still + 1 : 0;
      last = frames;
      return still >= limit;
    },
  };
}

export function makeAdaptor({ down = 3, up = 6 } = {}) {
  let low = false, bad = 0, good = 0;
  return (level) => {
    if (level === 'poor') { bad++; good = 0; } else if (level === 'good') { good++; bad = 0; } else { bad = 0; good = 0; }
    if (!low && bad >= down) { low = true; bad = 0; }
    else if (low && good >= up) { low = false; good = 0; }
    return low;
  };
}
