// Your profile (what other people see), the AI auto-reply toggle (off until you turn it on, with a
// plain explanation of what it does), the calculator lock, the configurer-only AI key form,
// notifications, and sign out.
import { supabase, rpc, avatarUrl, signOut } from '../lib/db.js';
import { escapeHtml, initials, uid, readFileAsDataURL, formatBytes } from '../lib/util.js';
import { notifySupported, notifyPermission, requestNotifyPermission } from '../lib/notify.js';
import { toast, friendlyError, openModal, closeModal, choose } from '../lib/ui.js';
import { calcLockOn, setCalcCode, turnOffCalcLock, validCode } from '../lib/calclock.js';
import { ICON } from '../lib/icons.js';
import { inAndroidApp, androidInfo } from '../lib/android.js';
import { availableUpdate, startAppUpdate, checkForAppUpdate } from './appupdate.js';
import { state } from '../state.js';

const SWATCHES = ['#F5C400', '#e0473c', '#2ea6a1', '#8a5cf6', '#f2823c', '#3b82c4', '#d94f8c', '#57a648'];

export async function mountSettings(root) {
  const me = state.profile;
  render();
  return () => {};

  function render() {
    root.innerHTML = `
    <div class="thread-head">
      <button class="back-btn" id="st-back" aria-label="Back">${ICON.back}</button>
      <div class="info"><div class="name">Settings</div></div>
    </div>
    <div class="settings-body">
      <div class="settings-section center">
        <div class="avatar lg" id="st-avatar" style="margin:0 auto 10px;cursor:pointer"></div>
        <input type="file" id="st-avatar-file" accept="image/*" class="hidden">
        <button class="btn btn-ghost btn-sm" id="st-avatar-btn">Change photo</button>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:10px" id="st-swatches"></div>
      </div>

      <div class="settings-section">
        <h4>Public profile</h4>
        <label for="st-name">Name</label>
        <input id="st-name" value="${escapeHtml(me.full_name || '')}">
        <label for="st-username">Username</label>
        <input id="st-username" value="${escapeHtml(me.username || '')}">
        <label for="st-bio">About</label>
        <textarea id="st-bio" placeholder="What should people see about you?">${escapeHtml(me.bio || '')}</textarea>
        <button class="btn btn-gold" style="margin-top:12px" id="st-save-profile">Save profile</button>
        <div id="st-profile-msg" class="form-msg"></div>
      </div>

      <div class="settings-section">
        <h4>Privacy</h4>
        <div class="toggle-row">
          <div><div class="label">Show when I'm online</div><div class="hint">Lets people you chat with see "Online" / "Last seen".</div></div>
          <label class="switch"><input type="checkbox" id="st-show-online" ${me.prefs?.show_online !== false ? 'checked' : ''}><span class="track"><span class="thumb"></span></span></label>
        </div>
        <div class="toggle-row">
          <div>
            <div class="label">Calculator lock</div>
            <div class="hint">ForYou opens as a working calculator. Type your code and press = to get in. It goes back to the calculator as soon as you leave ForYou, even for a second. The code is kept on this phone or computer only.</div>
          </div>
          <label class="switch"><input type="checkbox" id="st-calc-lock" ${calcLockOn() ? 'checked' : ''}><span class="track"><span class="thumb"></span></span></label>
        </div>
        <button class="btn btn-ghost btn-sm ${calcLockOn() ? '' : 'hidden'}" id="st-calc-change" type="button">Change code</button>
      </div>

      <div class="settings-section">
        <h4>AI</h4>
        <div class="toggle-row">
          <div>
            <div class="label">Reply for me</div>
            <div class="hint">When you're away from ForYou, AI can answer messages sent to you, in a style learned from your own past messages. Every reply it sends is labelled as written by AI, and ForYou reminds you to follow up when you're back. It's off until you turn it on.</div>
          </div>
          <label class="switch"><input type="checkbox" id="st-ai-reply" ${me.ai_auto_reply ? 'checked' : ''}><span class="track"><span class="thumb"></span></span></label>
        </div>
      </div>

      ${me.is_configurer ? `
      <div class="settings-section" id="st-configurer">
        <h4>AI setup (configurer only)</h4>
        <p class="muted small">You're the first account created on this app, so you're the only one who can set the shared AI key everyone's "Reply for me" uses.</p>
        <div id="st-ai-status" class="chip">Checking…</div>
        <label for="st-ai-key">Anthropic API key</label>
        <input id="st-ai-key" type="password" placeholder="sk-ant-...">
        <label for="st-ai-model">Model (optional)</label>
        <input id="st-ai-model" placeholder="claude-haiku-4-5-20251001">
        <button class="btn btn-ghost" style="margin-top:12px" id="st-save-ai">Save AI key</button>
        <div id="st-ai-msg" class="form-msg"></div>
      </div>
      <div class="settings-section">
        <h4>Admin (configurer only)</h4>
        <p class="muted small">Browse every account, suspend one, or review a pending appeal.</p>
        <button class="btn btn-ghost" id="st-admin">Open admin panel</button>
      </div>` : ''}

      <div class="settings-section">
        <h4>Notifications</h4>
        <p class="muted small" id="st-notif-status"></p>
        <button class="btn btn-ghost" id="st-notif-btn">Enable notifications</button>
      </div>

      <div class="settings-section">
        <h4>Get the app</h4>
        <button class="btn btn-ghost" id="st-install">Install / QR code</button>
      </div>

      ${inAndroidApp() ? `
      <div class="settings-section">
        <h4>App</h4>
        <div class="toggle-row">
          <div><div class="label">ForYou for Android</div><div class="hint" id="st-version"></div></div>
          <button class="btn btn-ghost btn-sm" id="st-update-check" type="button">Check for updates</button>
        </div>
        <button class="btn btn-gold btn-block hidden" id="st-update-go" type="button">Update</button>
      </div>` : ''}

      <div class="settings-section">
        <h4>Help and legal</h4>
        <button class="settings-link" id="st-contact" type="button">Contact ForYou<span>Send the ForYou team a message</span></button>
        <a class="settings-link" href="#/legal/terms">Terms of use</a>
        <a class="settings-link" href="#/legal/privacy">Privacy policy</a>
        <a class="settings-link" href="#/legal/disclaimer">Disclaimer</a>
      </div>

      <div class="settings-section">
        <button class="btn btn-danger btn-block" id="st-signout">Sign out</button>
      </div>
    </div>`;

    paintAvatar();
    paintSwatches();
    paintNotif();
    if (me.is_configurer) paintAiStatus();

    root.querySelector('#st-back').onclick = () => { location.hash = '#/'; };
    root.querySelector('#st-avatar-btn').onclick = () => root.querySelector('#st-avatar-file').click();
    root.querySelector('#st-avatar').onclick = () => root.querySelector('#st-avatar-file').click();
    root.querySelector('#st-avatar-file').addEventListener('change', onAvatarChosen);
    root.querySelector('#st-save-profile').addEventListener('click', saveProfile);
    root.querySelector('#st-show-online').addEventListener('change', (e) => savePrefs({ show_online: e.target.checked }));
    root.querySelector('#st-calc-lock').addEventListener('change', onCalcLockToggle);
    root.querySelector('#st-calc-change').addEventListener('click', () => askForCode('Change your calculator code', 'Save new code'));
    root.querySelector('#st-ai-reply').addEventListener('change', (e) => saveAiReply(e.target.checked));
    root.querySelector('#st-notif-btn').addEventListener('click', enableNotifications);
    root.querySelector('#st-install').addEventListener('click', () => { location.hash = '#/install'; });
    root.querySelector('#st-signout').addEventListener('click', async () => { await signOut(); });
    root.querySelector('#st-contact').addEventListener('click', contactTeam);
    if (inAndroidApp()) {
      paintVersion();
      root.querySelector('#st-update-check').addEventListener('click', () => {
        root.querySelector('#st-version').textContent = 'Checking…';
        checkForAppUpdate();
      });
      root.querySelector('#st-update-go').addEventListener('click', startAppUpdate);
      window.addEventListener('foryouapp', paintVersion);
    }
    const saveAi = root.querySelector('#st-save-ai');
    if (saveAi) saveAi.addEventListener('click', saveAiKey);
    const adminBtn = root.querySelector('#st-admin');
    if (adminBtn) adminBtn.addEventListener('click', () => { location.hash = '#/admin'; });
  }

  function paintAvatar() {
    const el = root.querySelector('#st-avatar');
    if (me.avatar_path) el.innerHTML = `<img src="${escapeHtml(avatarUrl(me.avatar_path))}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    else { el.style.background = me.avatar_color || '#F5C400'; el.textContent = initials(me.full_name || '?'); }
  }

  function paintSwatches() {
    const wrap = root.querySelector('#st-swatches');
    wrap.innerHTML = SWATCHES.map((c) => `<button type="button" data-c="${c}" style="width:26px;height:26px;border-radius:50%;background:${c};border:2px solid ${c === (me.avatar_color || '#F5C400') ? '#fff' : 'transparent'};cursor:pointer"></button>`).join('');
    wrap.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
      try {
        await supabase.from('profiles').update({ avatar_color: b.dataset.c }).eq('id', me.id);
        me.avatar_color = b.dataset.c; state.profile = me;
        paintAvatar(); paintSwatches();
      } catch { toast('Could not update your colour.'); }
    }));
  }

  async function onAvatarChosen() {
    const file = root.querySelector('#st-avatar-file').files[0];
    root.querySelector('#st-avatar-file').value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast(`That photo is ${formatBytes(file.size)} — keep it under 5 MB.`); return; }
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${me.id}/${uid()}.${ext}`;
    try {
      const { error: upErr } = await supabase.storage.from('avatars').upload(path, file, { contentType: file.type || 'image/jpeg', upsert: true });
      if (upErr) throw new Error(upErr.message);
      const { error: updErr } = await supabase.from('profiles').update({ avatar_path: path }).eq('id', me.id);
      if (updErr) throw new Error(updErr.message);
      me.avatar_path = path; state.profile = me;
      paintAvatar();
      toast('Profile photo updated.');
    } catch (e) { toast(friendlyError(e)); }
  }

  async function saveProfile() {
    const full_name = root.querySelector('#st-name').value.trim();
    const username = root.querySelector('#st-username').value.trim().toLowerCase();
    const bio = root.querySelector('#st-bio').value.trim();
    const msg = root.querySelector('#st-profile-msg');
    msg.className = 'form-msg'; msg.textContent = '';
    if (full_name.length < 1) { msg.className = 'form-msg err'; msg.textContent = 'Enter your name.'; return; }
    if (!/^[a-z0-9_.]{3,24}$/.test(username)) { msg.className = 'form-msg err'; msg.textContent = 'Username: 3-24 characters, lowercase letters, numbers, "." or "_" only.'; return; }
    try {
      const { error } = await supabase.from('profiles').update({ full_name, username, bio }).eq('id', me.id);
      if (error) {
        if (/username/i.test(error.message)) throw new Error('That username is taken.');
        throw error;
      }
      Object.assign(me, { full_name, username, bio }); state.profile = me;
      msg.className = 'form-msg ok'; msg.textContent = 'Saved.';
    } catch (e) {
      msg.className = 'form-msg err';
      msg.textContent = e.message === 'That username is taken.' ? e.message : friendlyError(e);
    }
  }

  async function savePrefs(patch) {
    const prefs = { ...(me.prefs || {}), ...patch };
    try {
      await supabase.from('profiles').update({ prefs }).eq('id', me.id);
      me.prefs = prefs; state.profile = me;
    } catch { toast('Could not save that setting.'); }
  }

  async function saveAiReply(on) {
    try {
      await supabase.from('profiles').update({ ai_auto_reply: on }).eq('id', me.id);
      me.ai_auto_reply = on; state.profile = me;
      toast(on ? 'Reply for me is on.' : 'Reply for me is off.');
    } catch { toast('Could not save that setting.'); }
  }

  async function paintAiStatus() {
    const el = root.querySelector('#st-ai-status');
    if (!el) return;
    try {
      const rows = await rpc('ai_key_status');
      const s = rows && rows[0];
      el.textContent = s && s.configured ? `Configured (${s.provider}${s.model ? ', ' + s.model : ''})` : 'Not set up yet. Auto-replies stay off for everyone until a key is saved.';
    } catch { el.textContent = ''; }
  }

  async function saveAiKey() {
    const key = root.querySelector('#st-ai-key').value.trim();
    const model = root.querySelector('#st-ai-model').value.trim();
    const msg = root.querySelector('#st-ai-msg');
    if (!key) { msg.className = 'form-msg err'; msg.textContent = 'Paste a key first.'; return; }
    try {
      await rpc('admin_set_ai_key', { p_key: key, p_provider: 'anthropic', p_model: model || null });
      root.querySelector('#st-ai-key').value = '';
      msg.className = 'form-msg ok'; msg.textContent = 'Saved.';
      paintAiStatus();
    } catch (e) { msg.className = 'form-msg err'; msg.textContent = friendlyError(e); }
  }

  function paintNotif() {
    const el = root.querySelector('#st-notif-status');
    const btn = root.querySelector('#st-notif-btn');
    if (!notifySupported()) { el.textContent = 'Not supported in this browser.'; btn.disabled = true; return; }
    const p = notifyPermission();
    el.textContent = p === 'granted' ? 'On.' : p === 'denied' ? 'Blocked. Allow notifications for ForYou in your browser or phone settings.' : 'Get told about new messages and calls when ForYou is in the background.';
    btn.disabled = p !== 'default';
  }

  function paintVersion() {
    const el = root.querySelector('#st-version');
    if (!el) { window.removeEventListener('foryouapp', paintVersion); return; }
    const info = androidInfo();
    const u = availableUpdate();
    el.textContent = u
      ? `Version ${info.version || ''}. Version ${u.versionName} is ready, and this version will no longer be supported.`
      : `Version ${info.version || ''}. You have the latest version.`;
    root.querySelector('#st-update-go').classList.toggle('hidden', !u);
  }

  // "Contact ForYou" opens a chat with the app's administrator (the configurer account).
  async function contactTeam() {
    try {
      const { data } = await supabase.from('profiles').select('id').eq('is_configurer', true).limit(1);
      const admin = data && data[0];
      if (!admin) { toast("There's no one to contact yet."); return; }
      if (admin.id === me.id) { toast("You're the ForYou administrator, so messages to the team come to you."); return; }
      const cid = await rpc('ensure_conversation', { p_other: admin.id });
      location.hash = `#/chat/${encodeURIComponent(cid)}`;
    } catch (e) { toast(friendlyError(e)); }
  }

  // ---------------------------------------------------------------- calculator lock
  async function onCalcLockToggle(e) {
    const box = e.target;
    if (box.checked) {
      box.checked = await askForCode('Set a calculator code', 'Turn on the lock');
    } else {
      const pick = await choose({
        title: 'Turn off the calculator lock?',
        text: 'ForYou will open straight to your chats again on this device.',
        actions: [{ id: 'off', label: 'Turn it off', danger: true }],
      });
      if (pick === 'off') { turnOffCalcLock(); toast('Calculator lock is off.'); } else box.checked = true;
    }
    paintCalcLock();
  }

  function paintCalcLock() {
    const on = calcLockOn();
    const box = root.querySelector('#st-calc-lock');
    if (box) box.checked = on;
    const change = root.querySelector('#st-calc-change');
    if (change) change.classList.toggle('hidden', !on);
  }

  /** The code form. Resolves true once a code is saved, false if it's closed first. */
  function askForCode(title, button) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (done) return; done = true; closeModal(); paintCalcLock(); resolve(ok); };
      const modal = openModal(`
        <div class="calc-setup">
          <h3>${title}</h3>
          <p class="muted small">Use 4 to 12 digits. To open ForYou, type the code on the calculator and press =.</p>
          <label for="cl-code">Code</label>
          <input id="cl-code" type="password" inputmode="numeric" autocomplete="off" maxlength="12">
          <label for="cl-code2">Type it again</label>
          <input id="cl-code2" type="password" inputmode="numeric" autocomplete="off" maxlength="12">
          <p class="muted small">If you forget it, ForYou can't be opened on this device until you clear its data (site data in your browser, or storage in the Android app's settings). That signs you out here, but your account and messages are kept.</p>
          <button class="btn btn-gold btn-block" id="cl-save" type="button">${button}</button>
          <div class="form-msg" id="cl-msg"></div>
        </div>`);
      document.getElementById('modal-close').addEventListener('click', () => finish(false));
      const backdrop = document.getElementById('modal-backdrop');
      backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) finish(false); });
      const msg = modal.querySelector('#cl-msg');
      const fail = (text) => { msg.className = 'form-msg err'; msg.textContent = text; };
      modal.querySelector('#cl-code').focus();
      modal.querySelector('#cl-save').addEventListener('click', async () => {
        const a = modal.querySelector('#cl-code').value.trim();
        const b = modal.querySelector('#cl-code2').value.trim();
        if (!validCode(a)) return fail('Use 4 to 12 digits, numbers only.');
        if (a !== b) return fail("The two codes don't match.");
        const btn = modal.querySelector('#cl-save');
        btn.disabled = true;
        const ok = await setCalcCode(a).catch(() => false);
        btn.disabled = false;
        if (!ok) return fail("Sorry, we ran into an error. It's not you, it's us. Please try again in a moment.");
        toast('Calculator lock is on. Leave ForYou and come back to see it.', 4000);
        finish(true);
      });
    });
  }

  async function enableNotifications() {
    await requestNotifyPermission();
    paintNotif();
  }
}
