// Site-wide settings. Everything here is safe to publish (no secrets) -- the Supabase anon key is
// designed to be public; every real permission check happens in the database (row-level security
// and the SECURITY DEFINER functions in supabase/schema.sql), never in this file.
const SUPABASE = {
  url: 'https://mkcyowrofmrlnmlypjou.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rY3lvd3JvZm1ybG5tbHlwam91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2MjkyNDYsImV4cCI6MjEwNjIwNTI0Nn0.839uFGVmvpE8RpkOSLQgdtAsLrGFmS4yVLKTjbGNguo',
};

function savedSetup() {
  try {
    const b = JSON.parse(localStorage.getItem('fy_bootstrap') || 'null');
    if (b && /^https:\/\/[\w.-]+$/.test(b.url || '') && typeof b.anonKey === 'string' && b.anonKey.length > 20) return b;
  } catch { /* storage unavailable */ }
  return null;
}
const chosen = SUPABASE.url && SUPABASE.anonKey ? SUPABASE : savedSetup();

export const CONFIG = {
  shortName: 'ForYou',
  fullName: 'ForYou — Chat, Connect, Belong',
  siteUrl: 'https://foryou-chat.pages.dev/',
  supabase: chosen ? { url: chosen.url.replace(/\/+$/, ''), anonKey: chosen.anonKey } : { url: '', anonKey: '' },
  // Public STUN only (no relay) by default -- works for most direct connections. A call between two
  // devices on a network that blocks direct peer-to-peer (some mobile carriers, some offices) would
  // need a TURN relay added here later; same shape as MindCare's own ice.js so one can be added the
  // same way without changing how the rest of the app calls currentIce().
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

export function saveBootstrap(url, anonKey) {
  try { localStorage.setItem('fy_bootstrap', JSON.stringify({ url, anonKey })); } catch { /* ignore */ }
}
