// Creating your own public.profiles row is normally done right after signUp() (see auth.js), but when
// the project requires email confirmation there is no session yet at that point -- the row has to be
// created later, the first time this browser sees a real session for that account (which may be right
// after they click the confirmation link, or the next time they sign in). The name/username they chose
// at sign-up is held in localStorage under their email until then, so it isn't lost in between.
import { supabase, rpc } from './db.js';
import { pickColor } from './util.js';

const PENDING_KEY = (email) => 'fy_pending_signup:' + email.toLowerCase();

export function stashPendingSignup(email, { full_name, username }) {
  try { localStorage.setItem(PENDING_KEY(email), JSON.stringify({ full_name, username })); } catch { /* ignore */ }
}

function takePendingSignup(email) {
  const key = PENDING_KEY(email);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    localStorage.removeItem(key);
    return JSON.parse(raw);
  } catch { return null; }
}

// Idempotent: safe to call on every sign-in, not just the first one. Returns { profile, error } --
// error is a user-facing message (e.g. a taken username) when the insert itself failed; profile is
// null in that case. Never throws.
export async function ensureProfile(user) {
  const existing = await supabase.from('profiles').select('*').eq('id', user.id).single();
  if (existing.data) return { profile: existing.data, error: null };

  const pending = takePendingSignup(user.email) || {};
  const full_name = pending.full_name || (user.email || '').split('@')[0];
  const username = pending.username || null;

  const { data, error } = await supabase.from('profiles').insert({
    id: user.id, email: user.email, full_name, username, avatar_color: pickColor(user.id),
  }).select().single();

  if (error) {
    if (/username/i.test(error.message)) {
      // Their username was taken by the time they confirmed -- create the row without one; they can
      // pick a different one in Settings. Not their fault, so this should never lose the account.
      const retry = await supabase.from('profiles').insert({
        id: user.id, email: user.email, full_name, username: null, avatar_color: pickColor(user.id),
      }).select().single();
      if (retry.error) return { profile: null, error: retry.error.message };
      await claimConfigurerQuietly();
      return { profile: retry.data, error: null };
    }
    return { profile: null, error: error.message };
  }
  await claimConfigurerQuietly();
  return { profile: data, error: null };
}

async function claimConfigurerQuietly() {
  try { return await rpc('claim_configurer'); } catch { return false; }
}
