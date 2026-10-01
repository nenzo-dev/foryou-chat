// Sign in / create an account. A brand-new account also creates its own public.profiles row (there is
// no database trigger for this -- the RLS insert policy expects the signed-in person to do it themselves).
// If the project requires email confirmation there's no session yet right after sign-up, so the name and
// username are stashed and picked up later by ensureProfile() (see app.js) the first time this browser
// actually gets a session for that account.
import { signIn, signUp } from '../lib/db.js';
import { isValidEmail, passwordProblem } from '../lib/util.js';
import { ensureProfile, stashPendingSignup } from '../lib/profile.js';
import { toast } from '../lib/ui.js';
import { openLegalSheet } from './legal.js';

const USERNAME_RE = /^[a-z0-9_.]{3,24}$/;

export function renderAuth(root, { onSignedIn }) {
  let tab = 'signin';
  let banner = ''; // survives one render() call across a tab switch (e.g. "check your email" after sign-up)

  function render() {
    root.innerHTML = `
    <div class="auth-screen"><div class="auth-card">
      <img src="icons/logo.webp" class="auth-logo" alt="">
      <h1 class="auth-title">ForYou</h1>
      <p class="auth-sub">Chat, Connect, Belong</p>
      <div class="auth-tabs">
        <div class="auth-tab ${tab === 'signin' ? 'active' : ''}" data-tab="signin">Sign in</div>
        <div class="auth-tab ${tab === 'signup' ? 'active' : ''}" data-tab="signup">Create account</div>
      </div>
      ${tab === 'signin' ? signinForm() : signupForm()}
      <p class="auth-legal"><a href="#" data-legal="terms">Terms of use</a><span>·</span><a href="#" data-legal="privacy">Privacy policy</a><span>·</span><a href="#" data-legal="disclaimer">Disclaimer</a></p>
    </div></div>`;

    root.querySelectorAll('.auth-tab').forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; banner = ''; render(); }));
    root.querySelectorAll('[data-legal]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openLegalSheet(a.dataset.legal); }));
    if (tab === 'signin') wireSignin(); else wireSignup();

    if (banner) {
      const msg = root.querySelector(tab === 'signin' ? '#si-msg' : '#su-msg');
      if (msg) { msg.className = 'form-msg ok'; msg.textContent = banner; }
      banner = '';
    }
  }

  function signinForm() {
    return `
      <label for="si-email">Email</label>
      <input id="si-email" type="email" autocomplete="username">
      <label for="si-password">Password</label>
      <input id="si-password" type="password" autocomplete="current-password">
      <button class="btn btn-gold btn-block" style="margin-top:16px" id="si-submit">Sign in</button>
      <div id="si-msg" class="form-msg"></div>`;
  }

  function signupForm() {
    return `
      <label for="su-name">Your name</label>
      <input id="su-name" placeholder="e.g. Chanda Mumba">
      <label for="su-username">Username</label>
      <input id="su-username" placeholder="lowercase, e.g. chanda_m">
      <label for="su-email">Email</label>
      <input id="su-email" type="email" autocomplete="username">
      <label for="su-password">Password</label>
      <input id="su-password" type="password" autocomplete="new-password">
      <label class="agree"><input type="checkbox" id="su-agree"><span>I'm 16 or older, and I agree to the <a href="#" data-legal="terms">Terms of use</a> and <a href="#" data-legal="privacy">Privacy policy</a>.</span></label>
      <button class="btn btn-gold btn-block" style="margin-top:16px" id="su-submit">Create account</button>
      <div id="su-msg" class="form-msg"></div>`;
  }

  async function finishSignIn(user, msgEl) {
    const { profile, error } = await ensureProfile(user);
    if (!profile) {
      if (msgEl) { msgEl.className = 'form-msg err'; msgEl.textContent = error || 'Could not set up your account.'; }
      return;
    }
    if (profile.is_configurer) toast("You're ForYou's configurer. You can add the shared AI key any time in Settings.");
    onSignedIn(user, profile);
  }

  function wireSignin() {
    root.querySelector('#si-submit').addEventListener('click', async () => {
      const email = root.querySelector('#si-email').value.trim();
      const password = root.querySelector('#si-password').value;
      const msg = root.querySelector('#si-msg');
      msg.className = 'form-msg'; msg.textContent = '';
      if (!isValidEmail(email)) { msg.className = 'form-msg err'; msg.textContent = 'Enter a valid email address.'; return; }
      const btn = root.querySelector('#si-submit');
      btn.disabled = true;
      try {
        const user = await signIn(email, password);
        await finishSignIn(user, msg);
      } catch (e) {
        msg.className = 'form-msg err'; msg.textContent = e.message || 'Could not sign in.';
      } finally { btn.disabled = false; }
    });
  }

  function wireSignup() {
    root.querySelector('#su-submit').addEventListener('click', async () => {
      const full_name = root.querySelector('#su-name').value.trim();
      const username = root.querySelector('#su-username').value.trim().toLowerCase();
      const email = root.querySelector('#su-email').value.trim();
      const password = root.querySelector('#su-password').value;
      const msg = root.querySelector('#su-msg');
      msg.className = 'form-msg'; msg.textContent = '';

      if (full_name.length < 2) { msg.className = 'form-msg err'; msg.textContent = 'Tell us your name.'; return; }
      if (!USERNAME_RE.test(username)) { msg.className = 'form-msg err'; msg.textContent = 'Username: 3-24 characters, lowercase letters, numbers, "." or "_" only.'; return; }
      if (!isValidEmail(email)) { msg.className = 'form-msg err'; msg.textContent = 'Enter a valid email address.'; return; }
      const pwProblem = passwordProblem(password);
      if (pwProblem) { msg.className = 'form-msg err'; msg.textContent = pwProblem; return; }
      if (!root.querySelector('#su-agree').checked) { msg.className = 'form-msg err'; msg.textContent = 'Tick the box to agree to the Terms of use and Privacy policy.'; return; }

      const btn = root.querySelector('#su-submit');
      btn.disabled = true;
      try {
        stashPendingSignup(email, { full_name, username });
        const data = await signUp(email, password);
        if (!data.session) {
          banner = 'Account created. Check your email to confirm it, then sign in.';
          tab = 'signin'; render();
          return;
        }
        await finishSignIn(data.user, msg);
      } catch (e) {
        msg.className = 'form-msg err'; msg.textContent = e.message || 'Could not create your account.';
      } finally { btn.disabled = false; }
    });
  }

  render();
}
