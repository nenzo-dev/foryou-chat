// A thin wrapper around the official Supabase JS client, loaded straight from a CDN as an ES module
// (no build step, no bundler). Every real permission check lives in the database (RLS + the
// SECURITY DEFINER functions in supabase/schema.sql); this file just gives the rest of the app
// short, readable calls instead of repeating Supabase's own API shape everywhere.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG } from '../config.js';

export const hasSupabase = !!(CONFIG.supabase.url && CONFIG.supabase.anonKey);

export const supabase = hasSupabase
  ? createClient(CONFIG.supabase.url, CONFIG.supabase.anonKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

// A database error raised with hint 'fy:show' (see supabase/migrations/07) was written to be read by
// people, e.g. "Both dater seats are taken." -- it is marked so friendlyError() passes it through.
export async function rpc(name, args = {}) {
  if (!supabase) throw new Error('This app is not connected to a database yet.');
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const e = new Error(error.message || 'Something went wrong.');
    if (error.hint === 'fy:show') e.show = true;
    throw e;
  }
  return data;
}

export async function signUp(email, password) {
  if (!supabase) throw new Error('This app is not connected to a database yet.');
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(error.message || 'Sign-up failed.');
  return data;
}
export async function signIn(email, password) {
  if (!supabase) throw new Error('This app is not connected to a database yet.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message || 'Sign-in failed.');
  return data.user;
}
export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}
export async function currentUser() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data && data.user ? data.user : null;
}

// avatars is a public bucket, so this is just a URL, not a signed request.
export function avatarUrl(path) {
  if (!path || !supabase) return '';
  return supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
}

// attachments is a private bucket (chat photos, files, voice notes) -- readable only by that
// conversation's/room's own members, per the storage policies in schema.sql.
export async function attachmentUrl(path, expiresIn = 3600) {
  if (!path || !supabase) return '';
  const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, expiresIn);
  if (error) throw new Error(error.message || 'Could not load that file.');
  return data.signedUrl;
}

// A named Supabase Realtime broadcast channel -- used for WebRTC call signalling (js/lib/rtc.js) and
// for live typing indicators. Not a database table: messages sent here are never stored, just relayed
// to whoever else is subscribed to the same channel name right now.
export function channel(name) {
  const handlers = [];
  let raw = null;
  let started = null;
  const api = {
    on(event, fn) { handlers.push([event, fn]); return api; },
    get ready() {
      if (!started) {
        started = (async () => {
          raw = supabase.channel(name, { config: { broadcast: { self: false } } });
          for (const [event, fn] of handlers) raw.on('broadcast', { event }, ({ payload }) => fn(payload));
          await new Promise((resolve, reject) => {
            raw.subscribe((status) => {
              if (status === 'SUBSCRIBED') resolve();
              else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error('Could not connect to the live connection service.'));
            });
          });
        })();
      }
      return started;
    },
    send(event, payload) { if (raw) raw.send({ type: 'broadcast', event, payload }); },
    close() { if (raw && supabase) supabase.removeChannel(raw); raw = null; handlers.length = 0; },
  };
  return api;
}
