// Full-screen lock shown instead of the normal app shell while profiles.suspended is true. A suspended
// person can still sign in (they need to, to submit an appeal) but can't reach chats, rooms or calls --
// app.js checks this right after fetching the profile and mounts this screen instead of buildShell().
import { supabase, rpc, signOut } from '../lib/db.js';
import { escapeHtml } from '../lib/util.js';
import { state } from '../state.js';

export async function renderSuspended(root) {
  const me = state.profile;
  const { data: pending } = await supabase.from('account_appeals').select('*')
    .eq('user_id', me.id).eq('status', 'pending').maybeSingle();

  root.innerHTML = `
    <div class="auth-screen"><div class="auth-card">
      <img src="icons/logo.webp" class="auth-logo" alt="">
      <h1 class="auth-title">Account suspended</h1>
      ${me.suspended_reason ? `<p class="auth-sub">Reason given: ${escapeHtml(me.suspended_reason)}</p>` : `<p class="auth-sub">Your account has been suspended.</p>`}
      <div id="sp-body"></div>
      <button class="btn btn-ghost btn-block" style="margin-top:18px" id="sp-signout">Sign out</button>
    </div></div>`;

  const body = root.querySelector('#sp-body');
  if (pending) {
    body.innerHTML = `<p class="form-msg ok" style="text-align:center">Your appeal was submitted and is waiting for review.</p>
      <p class="muted small" style="text-align:center;margin-top:8px">${escapeHtml(pending.message)}</p>`;
  } else {
    body.innerHTML = `
      <label for="sp-message">Explain why your account should be reinstated</label>
      <textarea id="sp-message" rows="4" placeholder="Tell us what happened…"></textarea>
      <button class="btn btn-gold btn-block" style="margin-top:12px" id="sp-submit">Submit appeal</button>
      <div id="sp-msg" class="form-msg"></div>`;
    root.querySelector('#sp-submit').addEventListener('click', async () => {
      const text = root.querySelector('#sp-message').value.trim();
      const msg = root.querySelector('#sp-msg');
      const btn = root.querySelector('#sp-submit');
      if (!text) { msg.className = 'form-msg err'; msg.textContent = 'Write a short message first.'; return; }
      btn.disabled = true;
      try {
        await rpc('submit_appeal', { p_message: text });
        renderSuspended(root);
      } catch (e) {
        msg.className = 'form-msg err'; msg.textContent = e.message || 'Could not submit your appeal.';
        btn.disabled = false;
      }
    });
  }

  root.querySelector('#sp-signout').addEventListener('click', async () => { await signOut(); });
}
