// Configurer-only: browse every account and suspend/unsuspend them, and review pending appeals from
// suspended accounts. Reachable at #/admin, linked only from Settings for accounts where is_configurer
// is true -- but every RPC here is re-checked server-side (am_i_configurer()) regardless of how someone
// reached this screen.
import { rpc } from '../lib/db.js';
import { escapeHtml, initials, timeAgo } from '../lib/util.js';
import { toast, openModal, closeModal } from '../lib/ui.js';
import { state } from '../state.js';

export async function mountAdmin(root) {
  if (!state.profile.is_configurer) {
    root.innerHTML = `<div class="empty-state"><p>Only the configurer can see this page.</p></div>`;
    return () => {};
  }

  let tab = 'users';
  root.innerHTML = `
    <div class="thread-head">
      <button class="back-btn" id="ad-back">&larr;</button>
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
      content.innerHTML = `<p class="muted">${escapeHtml(e.message || 'Could not load that.')}</p>`;
    }
  }

  async function paintUsers(content) {
    const users = await rpc('admin_list_users');
    content.innerHTML = (users || []).map((u) => `
      <div class="member-row" style="border-bottom:1px solid #1a1a1c;padding:12px 0">
        <div class="avatar sm">${escapeHtml(initials(u.full_name))}</div>
        <div class="meta">
          <div class="name">${escapeHtml(u.full_name || u.username || u.email)}${u.is_configurer ? ' &#9733;' : ''}${u.suspended ? ' <span class="chip" style="color:var(--danger);border-color:var(--danger)">Suspended</span>' : ''}</div>
          <div class="status">${escapeHtml(u.email)}${u.username ? ' · @' + escapeHtml(u.username) : ''} · joined ${timeAgo(new Date(u.created_at).getTime())}</div>
          ${u.suspended && u.suspended_reason ? `<div class="status">Reason: ${escapeHtml(u.suspended_reason)}</div>` : ''}
        </div>
        ${u.is_configurer ? '' : u.suspended
          ? `<button class="btn btn-ghost btn-sm" data-unsuspend="${escapeHtml(u.id)}">Unsuspend</button>`
          : `<button class="btn btn-danger btn-sm" data-suspend="${escapeHtml(u.id)}" data-name="${escapeHtml(u.full_name || u.email)}">Suspend</button>`}
      </div>`).join('') || '<p class="muted">No accounts yet.</p>';

    content.querySelectorAll('[data-suspend]').forEach((b) => b.addEventListener('click', () => openSuspendModal(b.dataset.suspend, b.dataset.name)));
    content.querySelectorAll('[data-unsuspend]').forEach((b) => b.addEventListener('click', async () => {
      try { await rpc('admin_unsuspend_user', { p_user: b.dataset.unsuspend }); toast('Account unsuspended.'); render(); }
      catch (e) { toast(e.message || 'Could not unsuspend that account.'); }
    }));
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
      } catch (e) { toast(e.message || 'Could not suspend that account.'); }
    });
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
      catch (e) { toast(e.message || 'Could not resolve that appeal.'); }
    }));
    content.querySelectorAll('[data-deny]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Deny this appeal? The account stays suspended.')) return;
      try { await rpc('admin_resolve_appeal', { p_appeal: b.dataset.deny, p_approve: false }); toast('Appeal denied.'); render(); }
      catch (e) { toast(e.message || 'Could not resolve that appeal.'); }
    }));
  }
}
