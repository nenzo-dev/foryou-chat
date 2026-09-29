// Tells a specific person "someone is calling you" -- separate from the call's own signalling channel
// (js/lib/rtc.js), because the callee is not necessarily looking at that chat yet. Every signed-in
// client keeps one of these listening on its own user id for as long as the app is open, so a call can
// reach them from anywhere in the app.
import { channel } from './db.js';

let inbox = null;
let handler = null;

export function startRingListener(myId, onEvent) {
  if (inbox || !myId) return;
  handler = onEvent;
  inbox = channel('ring-' + myId);
  inbox.on('ring', (payload) => { if (handler) handler(payload); });
  inbox.ready.catch((e) => console.error('ring listener', e));
}

export function stopRingListener() {
  if (inbox) inbox.close();
  inbox = null; handler = null;
}

export async function ringUser(targetId, payload) {
  const out = channel('ring-' + targetId);
  out.on('ring', () => {});
  await out.ready;
  out.send('ring', payload);
  setTimeout(() => out.close(), 5000);
}
