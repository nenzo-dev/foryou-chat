// GET /api/turn-credentials -- short-lived Cloudflare TURN relay credentials for a video call.
//
// Runs on Cloudflare Pages (deployed with the site, from this functions/ folder). The TURN key's API
// token is a secret: it lives only in the Pages project's environment variables and is used here,
// server-side, to mint credentials that expire after a day. Only a signed-in ForYou account can ask:
// the caller's Supabase access token is checked with Supabase before anything is minted.
//
// Environment variables (Cloudflare dashboard > Workers & Pages > foryou-chat > Settings > Variables):
//   TURN_KEY_ID          the TURN key's ID (Realtime > TURN Server)
//   TURN_KEY_API_TOKEN   the TURN key's API token -- add it as a Secret, not plain text
//   SUPABASE_URL / SUPABASE_ANON_KEY  optional; default to this project's public values below

const DEFAULT_SUPABASE_URL = 'https://mkcyowrofmrlnmlypjou.supabase.co';
const DEFAULT_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rY3lvd3JvZm1ybG5tbHlwam91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2MjkyNDYsImV4cCI6MjEwNjIwNTI0Nn0.839uFGVmvpE8RpkOSLQgdtAsLrGFmS4yVLKTjbGNguo';
const TTL_SECONDS = 86400;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function onRequestGet({ request, env }) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ iceServers: null, reason: 'not-configured' }, 503);

  const auth = request.headers.get('Authorization') || '';
  if (!/^Bearer\s+[\w-]+\.[\w-]+\.[\w-]+$/.test(auth)) return json({ error: 'sign-in-required' }, 401);

  const supabaseUrl = env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY || DEFAULT_ANON_KEY;
  try {
    const who = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: auth } });
    if (!who.ok) return json({ error: 'sign-in-required' }, 401);
  } catch {
    return json({ error: 'auth-unavailable' }, 502);
  }

  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    });
    if (!res.ok) return json({ error: 'turn-unavailable' }, 502);
    const data = await res.json();
    // generate-ice-servers answers with a list; the older generate endpoint with a single object.
    const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
    return json({ iceServers: list, ttl: TTL_SECONDS });
  } catch {
    return json({ error: 'turn-unavailable' }, 502);
  }
}
