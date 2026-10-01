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
  fullName: 'ForYou: Chat, Connect, Belong',
  siteUrl: 'https://foryou-chat.pages.dev/',
  supabase: chosen ? { url: chosen.url.replace(/\/+$/, ''), anonKey: chosen.anonKey } : { url: '', anonKey: '' },
  // STUN discovers a direct path between two devices, which is all that's needed on open WiFi -- but
  // phones on mobile data usually sit behind carrier-grade NAT, where no direct path exists and a call
  // needs a TURN relay to fall back to instead. Openrelay is a free, publicly documented community TURN
  // service (these credentials are meant to be public, not a secret) -- good enough as a default; swap
  // in a paid TURN provider here later for higher reliability without touching how rtc.js calls this.
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

export function saveBootstrap(url, anonKey) {
  try { localStorage.setItem('fy_bootstrap', JSON.stringify({ url, anonKey })); } catch { /* ignore */ }
}
