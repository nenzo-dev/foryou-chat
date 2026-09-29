// Voice messages: recording with the microphone, and the bars that show how loud each moment was.
// Ported unchanged from MindCare's own voice.js.
//
//   VoiceRecorder   start() asks for the microphone and records; stop() gives { blob, mime, duration, peaks }; cancel() throws it away
//   downsample()    turns many loudness readings into `n` bars between 0 and 1
//   pickVoiceMime() the best audio format this browser can record (webm on Chrome and Firefox, mp4 on Safari)
export const MAX_VOICE_SECONDS = 180;
export const MIN_VOICE_SECONDS = 0.6;

export function pickVoiceMime(MR = globalThis.MediaRecorder) {
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MR.isTypeSupported(t)) || '';
}

export const extensionFor = (mime) => (/mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm');

// Bars: the loudest reading in each slice, scaled so the loudest bar is full height, never below 8 %.
export function downsample(values, n = 40) {
  if (!values.length) return Array(n).fill(0.08);
  const out = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * values.length) / n), to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / n));
    let m = 0;
    for (let j = from; j < to && j < values.length; j++) m = Math.max(m, values[j]);
    out.push(m);
  }
  const top = Math.max(...out, 0.0001);
  return out.map((v) => Math.round(Math.max(0.08, v / top) * 100) / 100);
}

export class VoiceRecorder {
  // Anything not given is taken from the browser; passing null means "not available" (used by the tests).
  constructor(opts = {}) {
    this.getUserMedia = 'getUserMedia' in opts ? opts.getUserMedia : (navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? (c) => navigator.mediaDevices.getUserMedia(c) : null);
    this.Recorder = 'Recorder' in opts ? opts.Recorder : globalThis.MediaRecorder;
    this.AudioCtx = 'AudioCtx' in opts ? opts.AudioCtx : (globalThis.AudioContext || globalThis.webkitAudioContext);
    this.samples = []; this.chunks = [];
    this.startedAt = 0; this.onLimit = null;
    this.level = 0;
  }

  async start() {
    if (!this.getUserMedia || !this.Recorder) throw new Error('This browser cannot record audio. Try Chrome, Edge, Firefox or Safari.');
    this.stream = await this.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.mime = pickVoiceMime(this.Recorder);
    const opts = { audioBitsPerSecond: 32000, ...(this.mime ? { mimeType: this.mime } : {}) };
    this.rec = new this.Recorder(this.stream, opts);
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    try {
      this.ac = new this.AudioCtx();
      const src = this.ac.createMediaStreamSource(this.stream);
      this.an = this.ac.createAnalyser(); this.an.fftSize = 256;
      src.connect(this.an);
      this.buf = new Uint8Array(this.an.fftSize);
    } catch { this.an = null; }
    this.startedAt = Date.now();
    this.rec.start(250);
    this.timer = setInterval(() => {
      this.level = this.read();
      this.samples.push(this.level);
      if (this.seconds() >= MAX_VOICE_SECONDS && this.onLimit) this.onLimit();
    }, 100);
  }

  seconds() { return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0; }

  read() {
    if (!this.an) return 0;
    this.an.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) { const x = (this.buf[i] - 128) / 128; sum += x * x; }
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 3);
  }

  cleanup() {
    clearInterval(this.timer);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ac && this.ac.close) { try { this.ac.close(); } catch { /* already closed */ } }
    this.stream = null; this.ac = null; this.an = null;
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.rec || this.rec.state === 'inactive') { this.cleanup(); reject(new Error('Nothing was recorded.')); return; }
      const duration = Math.min(this.seconds(), MAX_VOICE_SECONDS);
      const peaks = downsample(this.samples, 40);
      this.rec.onstop = () => {
        const mime = this.mime || this.rec.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mime });
        this.cleanup();
        resolve({ blob, mime, duration: Math.round(duration * 10) / 10, peaks });
      };
      this.rec.stop();
    });
  }

  cancel() {
    if (this.rec && this.rec.state !== 'inactive') { this.rec.onstop = null; try { this.rec.stop(); } catch { /* already stopped */ } }
    this.cleanup();
  }
}
