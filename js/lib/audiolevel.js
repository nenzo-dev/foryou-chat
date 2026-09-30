// How loud someone is right now, for the "speaking" glow on call tiles and blind-date voices. One shared
// AudioContext for the whole app (browsers limit how many a page may open); it only listens, it never
// plays anything, so it doesn't affect what anyone hears.
let ctx = null;

export function audioContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Calls onLevel(0..1) about ten times a second. Returns a function that stops listening.
export function watchLevel(stream, onLevel) {
  const c = audioContext();
  if (!c || !stream || !stream.getAudioTracks().length) return () => {};
  let src, an;
  try {
    src = c.createMediaStreamSource(stream);
    an = c.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
  } catch { return () => {}; }
  const buf = new Uint8Array(an.fftSize);
  let smooth = 0;
  const timer = setInterval(() => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
    const now = Math.min(1, Math.sqrt(sum / buf.length) * 4);
    smooth = Math.max(now, smooth * 0.82);
    onLevel(smooth);
  }, 100);
  return () => { clearInterval(timer); try { src.disconnect(); } catch { /* already gone */ } };
}

export const SPEAKING = 0.09;
