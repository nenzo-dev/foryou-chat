// One shared realtime subscription for the whole app (started after sign-in, stopped on sign-out).
// Row-level security applies to these events exactly as it does to a normal query, so a broad
// subscription with no filter still only ever delivers rows this signed-in person is allowed to see
// (their own conversations, their own rooms) -- the database does the filtering, not this file.
import { supabase } from './db.js';

const TABLES = ['messages', 'room_messages', 'conversations', 'rooms', 'room_members'];
const targets = new Map();
let ch = null;

function set(table) {
  if (!targets.has(table)) targets.set(table, new Set());
  return targets.get(table);
}

// Calls fn(payload) whenever `table` changes; payload is Supabase's { eventType, new, old }. Returns an unsubscribe function.
export function onLive(table, fn) {
  const s = set(table);
  s.add(fn);
  return () => s.delete(fn);
}

export function startLive() {
  if (ch || !supabase) return;
  ch = supabase.channel('fy-live');
  for (const table of TABLES) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
      for (const fn of set(table)) { try { fn(payload); } catch (e) { console.error(e); } }
    });
  }
  ch.subscribe();
}

export function stopLive() {
  if (ch && supabase) supabase.removeChannel(ch);
  ch = null;
  targets.clear();
}
