// Sends Android push notifications through Firebase Cloud Messaging (FCM), so a call rings and a new
// message arrives even while the ForYou app is closed.
//
//   { type: 'call',    to, roomKey }   from the caller's app, with the caller's own sign-in: rings `to`
//   { type: 'cancel',  to, roomKey }   from the caller's app: stops that ringing (they hung up)
//   { type: 'message', kind, id }      from the database (supabase/migrations/09) after a new message
//
// Needs one secret, FCM_SERVICE_ACCOUNT: the Firebase service account key (the whole JSON file). Without
// it nothing is sent and every request just answers "skipped". Push tokens live in device_tokens.fcm_token
// and are only ever read here, with the service role.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ACCOUNT_JSON = Deno.env.get('FCM_SERVICE_ACCOUNT');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------- Google sign-in for FCM
type Account = { client_email: string; private_key: string; project_id: string };
let account: Account | null = null;
let cached: { token: string; until: number } | null = null;

function b64url(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlText = (t: string) => b64url(new TextEncoder().encode(t));

function pemToDer(pem: string) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const a = account!;
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlText(JSON.stringify({
    iss: a.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(a.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`Google sign-in failed: ${res.status}`);
  const data = await res.json();
  cached = { token: data.access_token, until: Date.now() + (data.expires_in || 3600) * 1000 };
  return cached.token;
}

// One FCM message per phone. Data-only and high priority, so the app wakes up and shows it itself.
// Returns the tokens FCM says no longer exist, so they can be forgotten.
async function send(tokens: string[], data: Record<string, string>, ttlSeconds: number): Promise<string[]> {
  if (!tokens.length) return [];
  const bearer = await accessToken();
  const gone: string[] = [];
  await Promise.all(tokens.map(async (token) => {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account!.project_id}/messages:send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ message: { token, data, android: { priority: 'high', ttl: `${ttlSeconds}s` } } }),
    });
    if (res.status === 404 || res.status === 400) {
      // Only forget a token when FCM says the token itself is the problem, not the message.
      const text = await res.text();
      if (/UNREGISTERED|not a valid FCM registration token|registration token/i.test(text)) gone.push(token);
    }
  }));
  return gone;
}

const preview = (m: { body: string | null; attachment: { type?: string } | null; sent_by_ai?: boolean }) => {
  const t = (m.attachment && m.attachment.type) || '';
  const text = m.body || (t.startsWith('audio/') ? 'Voice message' : t.startsWith('image/') ? 'Photo' : 'Sent a file');
  return ((m.sent_by_ai ? 'AI auto-reply: ' : '') + text).slice(0, 300);
};
const firstName = (n: string | null) => String(n || '').trim().split(/\s+/)[0] || 'Someone';

// ---------------------------------------------------------------- requests
Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!ACCOUNT_JSON) return json({ skipped: 'push is not set up' });
  try {
    account = account || JSON.parse(ACCOUNT_JSON);
  } catch {
    return json({ error: 'FCM_SERVICE_ACCOUNT is not valid JSON' }, 500);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const tokensOf = async (users: string[]) => {
    if (!users.length) return [] as string[];
    const { data } = await db.from('device_tokens').select('fcm_token').in('user_id', users).not('fcm_token', 'is', null);
    return [...new Set((data || []).map((r) => r.fcm_token as string))];
  };
  const forget = async (gone: string[]) => {
    if (gone.length) await db.from('device_tokens').update({ fcm_token: null }).in('fcm_token', gone);
  };

  try {
    if (body.type === 'call' || body.type === 'cancel') {
      // Only a signed-in person can ring someone, and the push says who they really are.
      const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: who } = await db.auth.getUser(jwt);
      const caller = who && who.user;
      const to = String(body.to || ''), roomKey = String(body.roomKey || '');
      if (!caller) return json({ error: 'Sign in first' }, 401);
      if (!UUID.test(to) || !/^[0-9a-f]{32}$/.test(roomKey) || to === caller.id) return json({ error: 'Bad request' }, 400);
      const { data: me } = await db.from('profiles').select('full_name, avatar_color, avatar_path, suspended').eq('id', caller.id).single();
      if (!me || me.suspended) return json({ error: 'Not allowed' }, 403);
      const tokens = await tokensOf([to]);
      const data: Record<string, string> = body.type === 'call'
        ? { type: 'call', roomKey, from: caller.id, fromName: me.full_name || 'Someone', fromAvatarColor: me.avatar_color || '', fromAvatarPath: me.avatar_path || '', at: String(Date.now()) }
        : { type: 'cancel', roomKey, from: caller.id, fromName: me.full_name || 'Someone' };
      await forget(await send(tokens, data, body.type === 'call' ? 45 : 60));
      return json({ ok: true, phones: tokens.length });
    }

    if (body.type === 'message') {
      const id = String(body.id || '');
      if (!UUID.test(id)) return json({ error: 'Bad request' }, 400);
      // Only brand-new messages: a replayed request can't keep re-notifying people.
      const fresh = new Date(Date.now() - 2 * 60_000).toISOString();
      if (body.kind === 'dm') {
        const { data: m } = await db.from('messages').select('id, conversation_id, sender_id, body, attachment, sent_by_ai, deleted_at, created_at').eq('id', id).gt('created_at', fresh).single();
        if (!m || m.deleted_at) return json({ skipped: 'not found' });
        const { data: c } = await db.from('conversations').select('user_a_id, user_b_id').eq('id', m.conversation_id).single();
        if (!c) return json({ skipped: 'not found' });
        const to = c.user_a_id === m.sender_id ? c.user_b_id : c.user_a_id;
        const { data: from } = await db.from('profiles').select('full_name').eq('id', m.sender_id).single();
        const tokens = await tokensOf([to]);
        await forget(await send(tokens, {
          type: 'message', tag: `foryou-dm-${m.conversation_id}`, title: (from && from.full_name) || 'New message',
          body: preview(m), hash: `#/chat/${m.conversation_id}`,
        }, 3600));
        return json({ ok: true, phones: tokens.length });
      }
      if (body.kind === 'room') {
        const { data: m } = await db.from('room_messages').select('id, room_id, sender_id, body, attachment, deleted_at, created_at').eq('id', id).gt('created_at', fresh).single();
        if (!m || m.deleted_at) return json({ skipped: 'not found' });
        const [{ data: room }, { data: from }, { data: members }] = await Promise.all([
          db.from('rooms').select('name').eq('id', m.room_id).single(),
          db.from('profiles').select('full_name').eq('id', m.sender_id).single(),
          db.from('room_members').select('user_id').eq('room_id', m.room_id).neq('user_id', m.sender_id).limit(200),
        ]);
        const tokens = await tokensOf((members || []).map((r) => r.user_id as string));
        await forget(await send(tokens, {
          type: 'message', tag: `foryou-room-${m.room_id}`, title: (room && room.name) || 'New group message',
          body: `${firstName(from && from.full_name)}: ${preview(m)}`, hash: `#/room/${m.room_id}`,
        }, 3600));
        return json({ ok: true, phones: tokens.length });
      }
    }
    return json({ error: 'Unknown request' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: 'Push failed' }, 500);
  }
});
