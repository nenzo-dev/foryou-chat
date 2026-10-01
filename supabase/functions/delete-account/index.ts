// Deletes a ForYou account and everything in it, for the admin panel (js/views/admin.js). Only the
// configurer can do this. The database removes the account and its data (delete_account(), see
// supabase/migrations/10), then this removes the person's photos and files from Storage.
//
//   POST { user }  with the configurer's own sign-in  ->  { ok: true, files }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Called from the browser, so it answers the browser's preflight and allows the page's origin.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const target = String(body.user || '');
  if (!UUID.test(target)) return json({ error: 'Bad request' }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  try {
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = await db.auth.getUser(jwt);
    const caller = who && who.user;
    if (!caller) return json({ error: 'Sign in first' }, 401);
    const { data: me } = await db.from('profiles').select('is_configurer').eq('id', caller.id).single();
    if (!me || !me.is_configurer) return json({ error: 'Only the administrator can delete accounts' }, 403);
    if (target === caller.id) return json({ error: "You can't delete your own account here" }, 400);

    const { data: files, error } = await db.rpc('delete_account', { p_user: target });
    if (error) {
      // The database's own reasons ("That account does not exist", ...) are written for people.
      const known = /does not exist|cannot be deleted/.test(error.message);
      if (!known) console.error(error);
      return json({ error: known ? error.message : 'Delete failed' }, known ? 400 : 500);
    }

    // The account is gone; now its files. A file that can't be removed is logged and left behind.
    const byBucket = new Map<string, string[]>();
    for (const f of (files || []) as { bucket: string; path: string }[]) {
      if (!byBucket.has(f.bucket)) byBucket.set(f.bucket, []);
      byBucket.get(f.bucket)!.push(f.path);
    }
    let removed = 0;
    for (const [bucket, paths] of byBucket) {
      for (let i = 0; i < paths.length; i += 100) {
        const { data, error: rmError } = await db.storage.from(bucket).remove(paths.slice(i, i + 100));
        if (rmError) console.error(bucket, rmError);
        removed += (data || []).length;
      }
    }
    return json({ ok: true, files: removed });
  } catch (e) {
    console.error(e);
    return json({ error: 'Delete failed' }, 500);
  }
});
