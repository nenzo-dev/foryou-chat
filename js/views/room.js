// A group chat: the header (group name, members, group video call), a banner when people are already on
// a call, and the shared thread (js/lib/thread.js) for history, sending, replies, reactions, editing and
// deleting. The group owner can also remove anyone's message.
import { supabase, avatarUrl } from '../lib/db.js';
import { escapeHtml, initials, pickColor, cssColor } from '../lib/util.js';
import { mountThread } from '../lib/thread.js';
import { roomPeople, sendRoomMessage, inviteLink, whatsappLink, resetInvite, leaveRoom, removeMember, deleteRoom, roomCalls, ROOM_FOLDER } from '../lib/rooms.js';
import { startGroupCall } from './callui.js';
import { toast, openModal, closeModal, friendlyError, choose } from '../lib/ui.js';
import { ICON } from '../lib/icons.js';
import { state } from '../state.js';

export async function mountRoom(root, roomId) {
  root.innerHTML = `<div class="empty-state"><div class="thread-loading"><span></span><span></span><span></span></div></div>`;
  const { data: room, error } = await supabase.from('rooms').select('*').eq('id', roomId).single();
  if (error || !room) {
    root.innerHTML = `<div class="empty-state"><p>That group could not be opened.</p></div>`;
    return () => {};
  }
  const me = state.user.id;
  const isOwner = room.owner_id === me;

  root.innerHTML = `
    <div class="thread-head">
      <button class="back-btn" id="rm-back" aria-label="Back">${ICON.back}</button>
      <div class="head-avatar"><div class="avatar sm group-avatar">${ICON.people}</div></div>
      <button class="info" id="rm-info" type="button">
        <span class="name">${escapeHtml(room.name)}</span>
        <span class="status" id="rm-status">&nbsp;</span>
      </button>
      <button class="head-btn" id="rm-call" title="Group video call" aria-label="Group video call">${ICON.video}</button>
    </div>
    <div id="rm-call-banner"></div>
    <div class="thread-host" id="rm-thread"></div>`;

  root.querySelector('#rm-back').onclick = () => { location.hash = '#/'; };
  root.querySelector('#rm-call').onclick = () => startGroupCall(room);
  root.querySelector('#rm-info').onclick = () => openRoomInfo();

  let people = await roomPeople(roomId).catch(() => []);
  let byId = Object.fromEntries((people || []).map((p) => [p.user_id, p]));
  paintStatus();

  const nameFor = (uid) => (uid === me ? 'You' : (byId[uid] && byId[uid].full_name) || 'Someone');
  const avatarFor = (uid) => {
    const p = byId[uid];
    if (p && p.avatar_path) return `<img class="avatar xs" src="${escapeHtml(avatarUrl(p.avatar_path))}" alt="">`;
    return `<div class="avatar xs" style="background:${cssColor(p && p.avatar_color, pickColor(uid))}">${escapeHtml(initials((p && p.full_name) || '?'))}</div>`;
  };

  const thread = await mountThread(root.querySelector('#rm-thread'), {
    kind: 'room', id: roomId, folder: ROOM_FOLDER(roomId), me, nameFor, avatarFor, isOwner,
    send: ({ body, attachment, replyTo }) => sendRoomMessage({ room, body, attachment, replyTo }),
  });

  const callBeat = setInterval(paintCallBanner, 15000);
  paintCallBanner();

  return () => { thread.destroy(); clearInterval(callBeat); };

  function paintStatus() {
    const el = root.querySelector('#rm-status');
    if (!el) return;
    const n = (people || []).length;
    const online = (people || []).filter((p) => p.last_seen && Date.now() - Date.parse(p.last_seen) < 90000).length;
    el.textContent = `${n} member${n === 1 ? '' : 's'}${online ? ` · ${online} online` : ''}`;
  }

  async function paintCallBanner() {
    const banner = root.querySelector('#rm-call-banner');
    if (!banner) return;
    try {
      const counts = await roomCalls();
      const n = counts[roomId] || 0;
      banner.innerHTML = n
        ? `<button class="call-banner" id="rm-join-call" type="button"><span class="cb-pulse">${ICON.video}</span><span class="cb-txt"><b>Call in progress</b><span>${n} ${n === 1 ? 'person is' : 'people are'} on it</span></span><span class="btn btn-gold btn-sm">Join</span></button>`
        : '';
      const j = banner.querySelector('#rm-join-call');
      if (j) j.addEventListener('click', () => startGroupCall(room));
    } catch { /* try again next tick */ }
  }

  async function openRoomInfo() {
    const link = inviteLink(room.invite_code);
    const modal = openModal(`
      <div class="profile-card">
        <div class="avatar xl group-avatar">${ICON.people}</div>
        <h3>${escapeHtml(room.name)}</h3>
        <p class="muted small">${escapeHtml(room.topic || 'No topic set')}</p>
      </div>
      <div class="qr-box">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=6&data=${encodeURIComponent(link)}" alt="Invite QR code">
        <div class="qr-actions">
          <button class="btn btn-ghost btn-sm" id="ri-copy">${ICON.link} Copy link</button>
          <a class="btn btn-ghost btn-sm" href="${escapeHtml(whatsappLink(room, room.invite_code))}" target="_blank" rel="noopener">${ICON.share} WhatsApp</a>
        </div>
        ${isOwner ? '<button class="btn btn-plain btn-sm" id="ri-reset">Make a new invite link</button>' : ''}
      </div>
      <h4 class="section-label">Members · ${(people || []).length}</h4>
      <div id="ri-members"></div>
      <div style="margin-top:18px">
        ${isOwner ? '<button class="btn btn-danger btn-block" id="ri-delete">Delete group</button>' : '<button class="btn btn-danger btn-block" id="ri-leave">Leave group</button>'}
      </div>`);
    modal.querySelector('#ri-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch { toast(link); } });
    const resetBtn = modal.querySelector('#ri-reset');
    if (resetBtn) resetBtn.addEventListener('click', async () => {
      try { room.invite_code = await resetInvite(roomId); toast('The old link no longer works. Here is the new one.'); closeModal(); openRoomInfo(); } catch (e) { toast(friendlyError(e)); }
    });
    const membersEl = modal.querySelector('#ri-members');
    membersEl.innerHTML = (people || []).map((p) => {
      const online = p.last_seen && Date.now() - Date.parse(p.last_seen) < 90000;
      return `
      <div class="member-row">
        ${p.avatar_path ? `<img class="avatar sm" src="${escapeHtml(avatarUrl(p.avatar_path))}" alt="">` : `<div class="avatar sm" style="background:${cssColor(p.avatar_color, pickColor(p.user_id))}">${escapeHtml(initials(p.full_name))}</div>`}
        <div class="meta"><div class="name">${escapeHtml(p.full_name)}${p.user_id === me ? ' <span class="muted">(you)</span>' : ''}${p.is_owner ? ` <span class="pill-gold">${ICON.crown} Owner</span>` : ''}</div><div class="status${online ? ' online' : ''}">${online ? 'Online' : ''}</div></div>
        ${isOwner && !p.is_owner ? `<button class="btn btn-plain btn-sm" data-remove="${escapeHtml(p.user_id)}">Remove</button>` : ''}
      </div>`;
    }).join('');
    membersEl.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await removeMember(roomId, b.dataset.remove);
        people = await roomPeople(roomId).catch(() => people);
        byId = Object.fromEntries((people || []).map((p) => [p.user_id, p]));
        paintStatus(); toast('Removed from the group'); closeModal(); openRoomInfo();
      } catch (e) { toast(friendlyError(e)); }
    }));
    const leaveBtn = modal.querySelector('#ri-leave');
    if (leaveBtn) leaveBtn.addEventListener('click', async () => {
      const ok = await choose({ title: 'Leave this group?', text: "You won't get its messages any more.", actions: [{ id: 'leave', label: 'Leave group', danger: true }] });
      if (!ok) return;
      try { await leaveRoom(roomId); location.hash = '#/'; } catch (e) { toast(friendlyError(e)); }
    });
    const deleteBtn = modal.querySelector('#ri-delete');
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
      const ok = await choose({ title: 'Delete this group?', text: 'It will be deleted for everyone, with all its messages. This cannot be undone.', actions: [{ id: 'delete', label: 'Delete for everyone', danger: true }] });
      if (!ok) return;
      try { await deleteRoom(roomId); location.hash = '#/'; } catch (e) { toast(friendlyError(e)); }
    });
  }
}
