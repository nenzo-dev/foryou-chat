// Landing page for a group's invite link (or the same link scanned as a QR code): shows what you're
// about to join, then join_room() does the real membership check and is safe to call again if you're
// already a member (it just hands back the room id).
import { invitePreview, joinRoom } from '../lib/rooms.js';
import { escapeHtml } from '../lib/util.js';
import { toast } from '../lib/ui.js';

export async function mountJoinRoom(root, code) {
  root.innerHTML = `<div class="empty-state"><p class="muted">Loading invite…</p></div>`;
  let info;
  try { info = await invitePreview(code); }
  catch (e) { root.innerHTML = `<div class="empty-state"><p>${escapeHtml(e.message || 'Could not load that invite.')}</p></div>`; return () => {}; }
  if (!info) {
    root.innerHTML = `<div class="empty-state"><p>This invitation link is not valid any more.</p></div>`;
    return () => {};
  }

  root.innerHTML = `
    <div class="empty-state">
      <img src="icons/logo.webp" alt="" style="width:64px;opacity:.8">
      <h2 style="margin:6px 0 0">${escapeHtml(info.name)}</h2>
      <p class="muted">${escapeHtml(info.topic || '')}</p>
      <p class="muted small">${info.members} member${info.members === 1 ? '' : 's'}</p>
      <button class="btn btn-gold" id="jr-join">${info.already ? 'Open group' : 'Join group'}</button>
    </div>`;

  root.querySelector('#jr-join').addEventListener('click', async () => {
    try { const id = await joinRoom(code); location.hash = `#/room/${id}`; }
    catch (e) { toast(e.message || 'Could not join that group.'); }
  });

  return () => {};
}
