// Your profile (what other people see), the AI auto-reply toggle (off until you turn it on, with a
// plain explanation of what it does), the configurer-only AI key form, notifications, and sign out.
import { supabase, rpc, avatarUrl, signOut } from '../lib/db.js';
import { escapeHtml, initials, uid, readFileAsDataURL, formatBytes } from '../lib/util.js';
import { notifySupported, notifyPermission, requestNotifyPermission } from '../lib/notify.js';
import { toast, friendlyError } from '../lib/ui.js';
import { ICON } from '../lib/icons.js';
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
      </div>

      <div class="settings-section">
        <h4>AI</h4>
        <div class="toggle-row">
          <div>
            <div class="label">Reply for me</div>
            <div class="hint">When you're away, the AI can reply in messages sent to you, written in your own style learned from your past messages. It's off until you turn it on — and while it's on, it may keep chatting with other people even while you're busy on a call or in another conversation. Every AI-sent reply is clearly labelled "Auto-reply" so the other person always knows.</div>
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
    root.querySelector('#st-ai-reply').addEventListener('change', (e) => saveAiReply(e.target.checked));
    root.querySelector('#st-notif-btn').addEventListener('click', enableNotifications);
    root.querySelector('#st-install').addEventListener('click', () => { location.hash = '#/install'; });
    root.querySelector('#st-signout').addEventListener('click', async () => { await signOut(); });
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
      el.textContent = s && s.configured ? `Configured (${s.provider}${s.model ? ', ' + s.model : ''})` : 'Not configured yet — replies stay off for everyone until this is set.';
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
    el.textContent = p === 'granted' ? 'Enabled.' : p === 'denied' ? 'Blocked — allow notifications for this site in your browser settings.' : 'Get notified about new messages and calls when the app is in the background.';
    btn.disabled = p !== 'default';
  }

  async function enableNotifications() {
    await requestNotifyPermission();
    paintNotif();
  }
}
