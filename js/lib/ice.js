// Which servers a video call uses to find a path between two people.
//
// When the site's Cloudflare TURN key is set up (functions/api/turn-credentials.js), every call asks it
// for short-lived relay credentials first: Cloudflare's relays sit close to both people and get through
// the mobile-data and campus-WiFi networks that block a direct connection. If that isn't available --
// not configured yet, running locally, or the request fails -- calls fall back to the free servers in
// js/config.js, exactly as before. The TURN key's own secret never reaches the browser.
import { CONFIG } from '../config.js';
import { supabase } from './db.js';

const STUN_ONLY = CONFIG.iceServers.filter((s) => [].concat(s.urls).every((u) => u.startsWith('stun:')));
let cloudflare = null;   // iceServers from Cloudflare
let fetchedAt = 0;
let inflight = null;

// Cloudflare's credentials live for 24 hours (the ttl asked for in the function); fetch fresh ones well
// before that so a long call never starts on a nearly expired pair.
const MAX_AGE_MS = 12 * 3600 * 1000;

export const currentIce = () => (cloudflare ? [...cloudflare, ...STUN_ONLY] : CONFIG.iceServers);
export const usingCloudflare = () => !!cloudflare;

export async function refreshIce() {
  if (cloudflare && Date.now() - fetchedAt < MAX_AGE_MS) return currentIce();
  if (!inflight) inflight = fetchCloudflare().finally(() => { inflight = null; });
  await inflight;
  return currentIce();
}

async function fetchCloudflare() {
  if (!/^https?:$/.test(location.protocol) || !supabase) return;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data && data.session && data.session.access_token;
    if (!token) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(new URL('api/turn-credentials', location.href.split('#')[0]), {
      headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return;
    const body = await res.json();
    const list = Array.isArray(body && body.iceServers) ? body.iceServers : [];
    // Port 53 is blocked by browsers and only makes candidate gathering wait for a timeout.
    const clean = list.map((srv) => ({ ...srv, urls: [].concat(srv.urls || []).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((srv) => srv.urls.length);
    if (clean.some((srv) => srv.urls.some((u) => u.startsWith('turn')))) {
      cloudflare = clean;
      fetchedAt = Date.now();
    }
  } catch { /* keep the fallback servers */ }
}
