// Online status for everyone you talk to: "Online", or "Last seen 5 min ago".
//
// Every signed-in person's open ForYou page reports to the database every 30 seconds (touch_seen). The
// database gives back, through contacts_presence(), the last-seen time of the people you have a
// conversation or a room with, using its own clock, and leaves out anyone who turned "Show when I am
// online" off in Settings. Closing the app means the reports stop, and after 90 seconds the person shows
// as last seen. Trimmed from MindCare's own seen.js: no Preact hooks here, plain polling instead.
import { rpc } from './db.js';
import { fmtDateShort, userTimezone } from './util.js';

export const ONLINE_MS = 90000;
const BEAT_MS = 30000;

// ms = last-seen time (or nothing when it is hidden or unknown). Returns { state: 'online' | 'away' | 'unknown', text }.
export function statusOf(ms, now = Date.now(), tz = userTimezone()) {
  if (!ms || Number.isNaN(ms)) return { state: 'unknown', online: false, text: '' };
  const age = Math.max(0, now - ms);
  if (age < ONLINE_MS) return { state: 'online', online: true, text: 'Online' };
  const min = Math.max(1, Math.round(age / 60000));
  if (min < 60) return { state: 'away', online: false, text: `Last seen ${min} min ago` };
  const hours = Math.round(age / 3600000);
  if (hours < 24) return { state: 'away', online: false, text: `Last seen ${hours} h ago` };
  if (hours < 48) return { state: 'away', online: false, text: 'Last seen yesterday' };
  return { state: 'away', online: false, text: `Last seen ${fmtDateShort(ms, tz)}` };
}

// Starts the reports for the signed-in person. Returns a function that stops them.
export function startSeen() {
  const beat = async () => { try { await rpc('touch_seen'); } catch { /* try again in 30 seconds */ } };
  beat();
  const timer = setInterval(beat, BEAT_MS);
  const back = () => { if (!document.hidden) beat(); };
  document.addEventListener('visibilitychange', back);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', back); };
}

// { personId: { lastSeen: ms, inCall } } for the people this person talks to.
export async function fetchSeen() {
  const rows = await rpc('contacts_presence');
  return Object.fromEntries((rows || []).map((r) => [r.user_id, { lastSeen: Date.parse(r.last_seen), inCall: !!r.in_call }]));
}

// Polls contacts_presence on an interval and calls onUpdate(map) each time. Returns a stop function.
export function watchSeen(onUpdate, everyMs = 20000) {
  let stopped = false;
  const tick = async () => { try { const m = await fetchSeen(); if (!stopped) onUpdate(m); } catch { /* keep the last answer */ } };
  tick();
  const timer = setInterval(tick, everyMs);
  return () => { stopped = true; clearInterval(timer); };
}
