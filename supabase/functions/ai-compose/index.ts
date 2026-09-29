// Rewrites the message a signed-in user is currently typing into something shorter, using the shared
// AI key from Settings. Unlike ai-reply (called from a database trigger with no user attached), this
// one is called directly from the browser, so ordinary JWT verification is enough to know who's asking
// -- no shared secret needed here.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Called straight from the browser (unlike ai-reply, which only a database trigger ever calls), so it
// needs its own CORS headers -- otherwise the browser's preflight OPTIONS request gets refused before
// the real POST is even sent.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Sign in first' }, 401);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(jwt);
  if (userErr || !userData.user) return json({ error: 'Sign in first' }, 401);

  let payload: { text?: string };
  try { payload = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const text = String(payload.text || '').trim();
  if (!text) return json({ error: 'Nothing to shorten' }, 400);

  // Technical failures (a bad grant, a network hiccup, a malformed provider response) are logged here
  // for whoever reads the function's own logs, never shown to the person using the app -- they only
  // ever see a plain "AI is not set up" or a generic apology, never the underlying reason.
  const GENERIC = 'Something went wrong on our end — our team is looking into it. Please try again in a moment.';

  const { data: cfg, error: cfgErr } = await db.from('system_config').select('ai_provider, ai_api_key, ai_model').eq('id', 1).single();
  if (cfgErr) { console.error('ai-compose: system_config read failed', cfgErr); return json({ error: GENERIC }); }
  if (!cfg || !cfg.ai_api_key || cfg.ai_provider !== 'anthropic') {
    return json({ error: 'AI is not set up yet — ask the configurer to add a key in Settings.' });
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.ai_api_key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.ai_model || DEFAULT_MODEL,
        max_tokens: 300,
        system: 'Rewrite the given text as a short, natural text message -- same meaning, same language, noticeably shorter. No quotes, no markdown, no preamble. Reply with the rewritten text only.',
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!res.ok) { console.error('ai-compose: provider error', res.status, await res.text()); return json({ error: GENERIC }); }
    const data = await res.json();
    const out = (data.content || []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('').trim();
    return json({ text: out || text });
  } catch (e) {
    console.error('ai-compose: unexpected error', e);
    return json({ error: GENERIC });
  }
});
