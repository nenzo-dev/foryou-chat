// Writes one AI reply on a user's behalf, in their own conversation. This only ever runs because a
// database trigger (public.maybe_ai_reply, in schema.sql) called it over HTTP right after someone sent
// that user a message -- and only when that user turned "Reply for me" on in Settings. It works whether
// or not that user's own browser is open, which is the whole point: the feature can keep a conversation
// going for them while they are busy elsewhere.
//
// Every reply is inserted with sent_by_ai = true (see ai_send_message in
// supabase/migrations/01_realtime_and_ai_insert.sql) so the app can always show a visible "Auto-reply"
// label on it -- nothing here is meant to pass as the person typing it themselves.
//
// This endpoint has no signed-in user to check (it's a background trigger, not a browser request), so
// JWT verification is off for it and a shared secret takes its place instead: maybe_ai_reply() reads the
// same value from Supabase Vault (see supabase/migrations/02_trigger_secret.sql) and sends it as a
// header. Without a match, this is just cost-abuse protection for the shared AI key, not a privacy
// boundary -- ai_send_message() still independently checks that reply_as is a real participant.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TRIGGER_SECRET = Deno.env.get('TRIGGER_SECRET');
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_HISTORY = 16;
const MAX_STYLE_SAMPLES = 24;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (TRIGGER_SECRET && req.headers.get('x-foryou-secret') !== TRIGGER_SECRET) return json({ error: 'Unauthorized' }, 401);

  let payload: { conversation_id?: string; message_id?: string; reply_as?: string };
  try { payload = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const conversationId = payload.conversation_id, messageId = payload.message_id, replyAs = payload.reply_as;
  if (!conversationId || !messageId || !replyAs) return json({ error: 'Missing fields' }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: cfg } = await db.from('system_config').select('ai_provider, ai_api_key, ai_model').eq('id', 1).single();
  if (!cfg || !cfg.ai_api_key || cfg.ai_provider !== 'anthropic') return json({ skipped: 'AI is not configured' });

  const { data: me } = await db.from('profiles').select('full_name, ai_auto_reply').eq('id', replyAs).single();
  if (!me || !me.ai_auto_reply) return json({ skipped: 'Auto-reply is off' });

  const { data: history } = await db
    .from('messages').select('sender_id, body, sent_by_ai')
    .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(MAX_HISTORY);
  const recent = (history || []).filter((m) => m.body).reverse();
  if (!recent.length) return json({ skipped: 'Nothing to reply to' });

  const { data: styleRows } = await db
    .from('messages').select('body')
    .eq('sender_id', replyAs).eq('sent_by_ai', false).neq('body', '')
    .order('created_at', { ascending: false }).limit(MAX_STYLE_SAMPLES);
  const styleSample = (styleRows || []).map((r) => r.body).reverse();

  const transcript = recent.map((m) => `${m.sender_id === replyAs ? 'Me' : 'Them'}: ${m.body}`).join('\n');
  const styleBlock = styleSample.length
    ? `Examples of how ${me.full_name || 'this person'} normally texts, to copy their tone, length and punctuation habits:\n${styleSample.map((s) => `- ${s}`).join('\n')}\n\n`
    : '';

  const system = `You are quietly texting on behalf of ${me.full_name || 'a ForYou user'}, who is busy right now and turned on auto-reply so their chat doesn't go cold. ${styleBlock}` +
    'Write ONE short reply continuing the conversation below, in their voice. Keep it as short as a real text message. ' +
    'Do not mention that you are an AI, a bot, or an assistant. Do not use markdown. Reply with the message text only, nothing else.';

  let text = '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.ai_api_key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.ai_model || DEFAULT_MODEL,
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: `Conversation so far:\n${transcript}\n\nReply as Me, continuing naturally.` }],
      }),
    });
    if (!res.ok) return json({ error: `AI provider error ${res.status}: ${await res.text()}` }, 200);
    const data = await res.json();
    text = (data.content || []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('').trim();
  } catch (e) {
    return json({ error: String(e) }, 200);
  }
  if (!text) return json({ skipped: 'Empty reply from the AI' });

  const { error } = await db.rpc('ai_send_message', { p_conversation: conversationId, p_sender: replyAs, p_body: text });
  if (error) return json({ error: error.message }, 200);
  return json({ ok: true });
});
