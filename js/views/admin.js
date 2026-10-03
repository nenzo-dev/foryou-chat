// Configurer-only: browse every account and rename, suspend, unsuspend or delete them, and review pending appeals from
// suspended accounts. Reachable at #/admin, linked only from Settings for accounts where is_configurer
// is true -- but every RPC here is re-checked server-side (am_i_configurer()) regardless of how someone
// reached this screen.
import { rpc, supabase } from '../lib/db.js';
import { escapeHtml, initials, timeAgo } from '../lib/util.js';
import { toast, openModal, closeModal, friendlyError } from '../lib/ui.js';
import { ICON } from '../lib/icons.js';
import { state } from '../state.js';

export async function mountAdmin(root) {
  if (!state.profile.is_configurer) {
    root.innerHTML = `<div class="empty-state"><p>Only the configurer can see this page.</p></div>`;
    return () => {};
  }

  let tab = 'users';
  root.innerHTML = `
    <div class="thread-head">
      <button class="back-btn" id="ad-back" aria-label="Back">${ICON.back}</button>
      <div class="info"><div class="name">Admin</div></div>
    </div>
    <div class="settings-body" style="max-width:640px">
      <div class="auth-tabs" style="max-width:260px">
        <div class="auth-tab" id="ad-tab-users">Users</div>
        <div class="auth-tab" id="ad-tab-appeals">Appeals</div>
      </div>
      <div id="ad-content" style="margin-top:18px"></div>
    </div>`;
  root.querySelector('#ad-back').onclick = () => { location.hash = '#/'; };
  root.querySelector('#ad-tab-users').addEventListener('click', () => { tab = 'users'; render(); });
  root.querySelector('#ad-tab-appeals').addEventListener('click', () => { tab = 'appeals'; render(); });

  render();
  return () => {};

  async function render() {
    root.querySelector('#ad-tab-users').classList.toggle('active', tab === 'users');
    root.querySelector('#ad-tab-appeals').classList.toggle('active', tab === 'appeals');
    const content = root.querySelector('#ad-content');
    content.innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (tab === 'users') await paintUsers(content); else await paintAppeals(content);
    } catch (e) {
      content.innerHTML = `<p class="muted">${escapeHtml(friendlyError(e))}</p>`;
    }
  }

  async function paintUsers(content) {
    const users = await rpc('admin_list_users');
    content.innerHTML = (users || []).map((u) => `
      <div class="member-row" style="border-bottom:1px solid #1a1a1c;padding:12px 0;align-items:flex-start">
        <div class="avatar sm">${escapeHtml(initials(u.full_name))}</div>
        <div class="meta">
          <div class="name">${escapeHtml(u.full_name || u.username || u.email)}${u.is_configurer ? ' &#9733;' : ''}${u.suspended ? ' <span class="chip" style="color:var(--danger);border-color:var(--danger)">Suspended</span>' : ''}</div>
          <div class="status">${escapeHtml(u.email)}${u.username ? ' · @' + escapeHtml(u.username) : ''} · joined ${timeAgo(new Date(u.created_at).getTime())}</div>
          ${u.suspended && u.suspended_reason ? `<div class="status">Reason: ${escapeHtml(u.suspended_reason)}</div>` : ''}
          <div class="ad-actions"><button class="btn btn-ghost btn-sm" data-rename="${escapeHtml(u.id)}" data-full="${escapeHtml(u.full_name || '')}" data-user="${escapeHtml(u.username || '')}">Edit name</button>
            ${u.is_configurer ? '' : `${u.suspended
            ? `<button class="btn btn-ghost btn-sm" data-unsuspend="${escapeHtml(u.id)}">Unsuspend</button>`
            : `<button class="btn btn-ghost btn-sm" data-suspend="${escapeHtml(u.id)}" data-name="${escapeHtml(u.full_name || u.email)}">Suspend</button>`}
            <button class="btn btn-danger btn-sm" data-delete="${escapeHtml(u.id)}" data-name="${escapeHtml(u.full_name || u.email)}">Delete</button>`}</div>
        </div>
      </div>`).join('') || '<p class="muted">No accounts yet.</p>';

    content.querySelectorAll('[data-suspend]').forEach((b) => b.addEventListener('click', () => openSuspendModal(b.dataset.suspend, b.dataset.name)));
    content.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', () => openRenameModal(b.dataset.rename, b.dataset.full, b.dataset.user)));
    content.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', () => openDeleteModal(b.dataset.delete, b.dataset.name)));
    content.querySelectorAll('[data-unsuspend]').forEach((b) => b.addEventListener('click', async () => {
      try { await rpc('admin_unsuspend_user', { p_user: b.dataset.unsuspend }); toast('Account unsuspended.'); render(); }
      catch (e) { toast(friendlyError(e)); }
    }));
  }

  // Changes the name and username everyone sees. The database checks the rules again (admin_rename_user).
  function openRenameModal(userId, fullName, username) {
    const modal = openModal(`
      <h3>Edit name</h3>
      <p class="muted small">Everyone on ForYou will see the new name.</p>
      <label for="ad-rn-name">Name</label>
      <input id="ad-rn-name" maxlength="60" value="${escapeHtml(fullName)}">
      <label for="ad-rn-user">Username (optional)</label>
      <input id="ad-rn-user" maxlength="24" autocapitalize="none" spellcheck="false" value="${escapeHtml(username)}">
      <button class="btn btn-gold btn-block" style="margin-top:12px" id="ad-rn-save">Save</button>
      <div id="ad-rn-msg" class="form-msg"></div>`);
    modal.querySelector('#ad-rn-save').addEventListener('click', async () => {
      const msg = modal.querySelector('#ad-rn-msg');
      const name = modal.querySelector('#ad-rn-name').value.trim();
      const user = modal.querySelector('#ad-rn-user').value.trim().toLowerCase().replace(/^@/, '');
      if (!name) { msg.className = 'form-msg err'; msg.textContent = 'Enter a name.'; return; }
      try {
        await rpc('admin_rename_user', { p_user: userId, p_full_name: name, p_username: user || null });
        if (userId === state.user.id) Object.assign(state.profile, { full_name: name, username: user || null });
        toast('Name updated.');
        closeModal();
        render();
      } catch (e) { msg.className = 'form-msg err'; msg.textContent = friendlyError(e); }
    });
  }

  function openSuspendModal(userId, name) {
    const modal = openModal(`
      <h3>Suspend ${escapeHtml(name)}?</h3>
      <p class="muted small">They'll be signed out of the normal app and shown a screen where they can appeal.</p>
      <label for="ad-reason">Reason (optional, shown to them)</label>
      <textarea id="ad-reason" rows="3" placeholder="Why is this account being suspended?"></textarea>
      <button class="btn btn-danger btn-block" style="margin-top:12px" id="ad-confirm-suspend">Suspend account</button>`);
    modal.querySelector('#ad-confirm-suspend').addEventListener('click', async () => {
      const reason = modal.querySelector('#ad-reason').value.trim();
      try {
        await rpc('admin_suspend_user', { p_user: userId, p_reason: reason || null });
        toast('Account suspended.');
        closeModal();
        render();
      } catch (e) { toast(friendlyError(e)); }
    });
  }

  // Deleting can't be undone, so the admin types DELETE first. The "delete-account" Edge Function
  // does the work (supabase/functions/delete-account): the account, its data and its files.
  function openDeleteModal(userId, name) {
    const modal = openModal(`
      <h3>Delete ${escapeHtml(name)}'s account?</h3>
      <p class="muted small">This deletes their account for good: their chats and messages, their photos and files, and their profile. Groups they made pass to the member who has been in them longest. This can't be undone.</p>
      <label for="ad-del-word">Type DELETE to confirm</label>
      <input id="ad-del-word" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="DELETE">
      <button class="btn btn-danger btn-block" style="margin-top:12px" id="ad-confirm-delete" disabled>Delete account</button>`);
    const word = modal.querySelector('#ad-del-word');
    const go = modal.querySelector('#ad-confirm-delete');
    word.addEventListener('input', () => { go.disabled = word.value.trim().toUpperCase() !== 'DELETE'; });
    word.focus();
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Deleting…';
      try {
        const { error } = await supabase.functions.invoke('delete-account', { body: { user: userId } });
        if (error) throw await readableError(error);
        toast(`${name}'s account was deleted.`);
        closeModal();
        render();
      } catch (e) {
        toast(friendlyError(e));
        go.disabled = false;
        go.textContent = 'Delete account';
      }
    });
  }

  // The function's own reasons ("That account does not exist", ...) are written to be shown.
  async function readableError(error) {
    try {
      const body = await error.context.json();
      if (body && body.error && body.error !== 'Delete failed') return Object.assign(new Error(body.error), { show: true });
    } catch { /* not JSON: fall through */ }
    return error;
  }

  async function paintAppeals(content) {
    const appeals = await rpc('admin_list_appeals', { p_status: 'pending' });
    content.innerHTML = (appeals || []).map((a) => `
      <div class="member-row" style="border-bottom:1px solid #1a1a1c;padding:12px 0;align-items:flex-start">
        <div class="avatar sm">${escapeHtml(initials(a.full_name))}</div>
        <div class="meta">
          <div class="name">${escapeHtml(a.full_name || a.email)}${a.username ? ' · @' + escapeHtml(a.username) : ''}</div>
          <div class="status">${escapeHtml(a.email)} · ${timeAgo(new Date(a.created_at).getTime())}</div>
          <p style="margin:8px 0 0;font-size:13.5px">${escapeHtml(a.message)}</p>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn btn-gold btn-sm" data-approve="${escapeHtml(a.id)}">Approve &amp; reinstate</button>
            <button class="btn btn-ghost btn-sm" data-deny="${escapeHtml(a.id)}">Deny</button>
          </div>
        </div>
      </div>`).join('') || '<p class="muted">No pending appeals.</p>';

    content.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
      try { await rpc('admin_resolve_appeal', { p_appeal: b.dataset.approve, p_approve: true }); toast('Account reinstated.'); render(); }
      catch (e) { toast(friendlyError(e)); }
    }));
    content.querySelectorAll('[data-deny]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Deny this appeal? The account stays suspended.')) return;
      try { await rpc('admin_resolve_appeal', { p_appeal: b.dataset.deny, p_approve: false }); toast('Appeal denied.'); render(); }
      catch (e) { toast(friendlyError(e)); }
    }));
  }
}
