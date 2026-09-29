// The persistent left-hand pane: search bar, the combined list of DMs and rooms (sorted like WhatsApp,
// most recent activity first), and the "new chat" / "new room" / "join by code" flows.
import { rpc, avatarUrl } from '../lib/db.js';
import { onLive } from '../lib/live.js';
import { watchSeen, statusOf } from '../lib/seen.js';
import { createRoom, joinRoom } from '../lib/rooms.js';
import { initials, timeAgo, escapeHtml, debounce } from '../lib/util.js';
import { openModal, closeModal, toast } from '../lib/ui.js';
import { state } from '../state.js';

let seenMap = {};
let stopWatchingSeen = null;
let rows = [];

export function mountChatList(root) {
  root.innerHTML = `
    <div class="topbar">
      <div class="brand"><img src="icons/logo.webp" alt=""> ForYou</div>
      <div class="spacer"></div>
      <button class="btn-icon" id="cl-install" title="Get the app">&#8595;</button>
      <button class="btn-icon" id="cl-settings" title="Settings"></button>
    </div>
    <div class="searchbar"><input id="cl-search" type="search" placeholder="Search chats"></div>
    <div class="list" id="cl-list"><p class="muted center" style="padding:20px">Loading…</p></div>
    <button class="fab" id="cl-new" aria-label="New chat">+</button>`;

  paintMyAvatar();
  root.querySelector('#cl-settings').addEventListener('click', () => { location.hash = '#/settings'; });
  root.querySelector('#cl-install').addEventListener('click', () => { location.hash = '#/install'; });
  root.querySelector('#cl-new').addEventListener('click', openNewChatModal);
  root.querySelector('#cl-search').addEventListener('input', debounce((e) => renderList(e.target.value), 120));

  const refresh = debounce(() => load(), 200);
  const offs = ['messages', 'conversations', 'room_messages', 'rooms', 'room_members'].map((t) => onLive(t, refresh));
  stopWatchingSeen = watchSeen((m) => { seenMap = m; renderList(root.querySelector('#cl-search')?.value || ''); }, 20000);
  window.addEventListener('hashchange', highlightActive);

  load();

  return () => {
    offs.forEach((off) => off());
    if (stopWatchingSeen) stopWatchingSeen();
    window.removeEventListener('hashchange', highlightActive);
  };

  function paintMyAvatar() {
    const btn = root.querySelector('#cl-settings');
    const p = state.profile;
    if (p && p.avatar_path) btn.innerHTML = `<img src="${escapeHtml(avatarUrl(p.avatar_path))}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    else { btn.style.background = (p && p.avatar_color) || 'var(--gold)'; btn.style.color = '#1a1400'; btn.textContent = initials((p && p.full_name) || '?'); }
  }

  async function load() {
    try {
      const [convs, myRooms] = await Promise.all([rpc('my_conversations'), rpc('my_rooms')]);
      rows = [
        ...(convs || []).map((c) => ({
          type: 'dm', id: c.id, otherId: c.other_id, name: c.other_name || c.other_username || 'Someone',
          avatarPath: c.other_avatar_path, avatarColor: c.other_avatar_color,
          lastAt: c.last_message_at, preview: c.last_message_preview, unread: c.unread,
        })),
        ...(myRooms || []).map((r) => ({
          type: 'room', id: r.id, name: r.name, members: r.members,
          lastAt: r.last_message_at, preview: r.last_message_preview, unread: r.unread,
        })),
      ].sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
      renderList(root.querySelector('#cl-search')?.value || '');
    } catch (e) {
      root.querySelector('#cl-list').innerHTML = `<p class="muted center" style="padding:20px">${escapeHtml(e.message || 'Could not load chats.')}</p>`;
    }
  }

  function renderList(filter) {
    const listEl = root.querySelector('#cl-list');
    if (!listEl) return;
    const q = String(filter || '').trim().toLowerCase();
    const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
    if (!shown.length) {
      listEl.innerHTML = `<div class="empty-state" style="padding:40px 20px"><p>${q ? 'No chats match your search.' : "No chats yet — tap + to start one."}</p></div>`;
      return;
    }
    listEl.innerHTML = shown.map((r) => {
      const href = r.type === 'dm' ? `#/chat/${encodeURIComponent(r.id)}` : `#/room/${r.id}`;
      const online = r.type === 'dm' && seenMap[r.otherId] && statusOf(seenMap[r.otherId].lastSeen).online;
      const avatar = r.avatarPath
        ? `<img class="avatar" src="${escapeHtml(avatarUrl(r.avatarPath))}" alt="">`
        : `<div class="avatar" style="background:${escapeHtml((r.type === 'dm' ? r.avatarColor : null) || '#3b82c4')}">${r.type === 'room' ? '&#128101;' : escapeHtml(initials(r.name))}</div>`;
      return `
      <div class="list-item" data-href="${href}" data-id="${r.type}:${r.id}">
        <div style="position:relative">${avatar}${online ? '<span class="dot-online"></span>' : ''}</div>
        <div class="meta">
          <div class="top-row"><span class="name">${escapeHtml(r.name)}</span><span class="time">${r.lastAt ? timeAgo(new Date(r.lastAt).getTime()) : ''}</span></div>
          <div class="top-row"><span class="preview">${escapeHtml(r.preview || 'No messages yet')}</span>${r.unread ? `<span class="badge">${r.unread > 99 ? '99+' : r.unread}</span>` : ''}</div>
        </div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => { location.hash = el.dataset.href; }));
    highlightActive();
  }

  function highlightActive() {
    const listEl = document.getElementById('cl-list');
    if (!listEl) return;
    const h = location.hash;
    listEl.querySelectorAll('.list-item').forEach((el) => el.classList.toggle('active', el.dataset.href === h));
  }
}

function openNewChatModal() {
  const modal = openModal(`
    <h3>New chat</h3>
    <p class="muted small">Find someone by username, or start a group.</p>
    <label for="nc-username">Username</label>
    <input id="nc-username" placeholder="e.g. chanda_m">
    <div id="nc-result" style="margin-top:10px"></div>
    <div style="margin:18px 0;border-top:1px solid var(--border)"></div>
    <button class="btn btn-ghost btn-block" id="nc-newroom">Create a group</button>
    <button class="btn btn-ghost btn-block" style="margin-top:8px" id="nc-joincode">Join a group by invite code</button>
  `);
  const input = modal.querySelector('#nc-username');
  const result = modal.querySelector('#nc-result');
  input.addEventListener('input', debounce(async () => {
    const uname = input.value.trim().toLowerCase().replace(/^@/, '');
    if (!uname) { result.innerHTML = ''; return; }
    result.innerHTML = '<p class="muted small">Searching…</p>';
    try {
      const rows = await rpc('find_user_by_username', { p_username: uname });
      const person = rows && rows[0];
      if (!person) { result.innerHTML = '<p class="muted small">No one with that username.</p>'; return; }
      result.innerHTML = `
        <div class="list-item" style="border:1px solid var(--border);border-radius:12px">
          <div class="avatar" style="background:${escapeHtml(person.avatar_color || '#3b82c4')}">${person.avatar_path ? `<img class="avatar" src="${escapeHtml(avatarUrl(person.avatar_path))}">` : escapeHtml(initials(person.full_name))}</div>
          <div class="meta"><div class="name">${escapeHtml(person.full_name || person.username)}</div><div class="preview">@${escapeHtml(person.username)}</div></div>
        </div>
        <button class="btn btn-gold btn-block" style="margin-top:10px" id="nc-message">Message</button>`;
      result.querySelector('#nc-message').addEventListener('click', async () => {
        try {
          const cid = await rpc('ensure_conversation', { p_other: person.id });
          closeModal();
          location.hash = `#/chat/${encodeURIComponent(cid)}`;
        } catch (e) { toast(e.message || 'Could not start that chat.'); }
      });
    } catch (e) { result.innerHTML = `<p class="muted small">${escapeHtml(e.message || 'Search failed.')}</p>`; }
  }, 300));

  modal.querySelector('#nc-newroom').addEventListener('click', () => { closeModal(); openNewRoomModal(); });
  modal.querySelector('#nc-joincode').addEventListener('click', () => { closeModal(); openJoinCodeModal(); });
}

function openNewRoomModal() {
  const modal = openModal(`
    <h3>Create a group</h3>
    <label for="nr-name">Group name</label>
    <input id="nr-name" placeholder="e.g. Weekend Plans">
    <label for="nr-topic">Topic (optional)</label>
    <input id="nr-topic" placeholder="What's this group about?">
    <button class="btn btn-gold btn-block" style="margin-top:16px" id="nr-submit">Create</button>
    <div id="nr-msg" class="form-msg"></div>`);
  modal.querySelector('#nr-submit').addEventListener('click', async () => {
    const name = modal.querySelector('#nr-name').value.trim();
    const topic = modal.querySelector('#nr-topic').value.trim();
    const msg = modal.querySelector('#nr-msg');
    if (name.length < 2) { msg.className = 'form-msg err'; msg.textContent = 'Give the group a name.'; return; }
    try {
      const room = await createRoom({ name, topic }, state.user);
      closeModal();
      location.hash = `#/room/${room.id}`;
    } catch (e) { msg.className = 'form-msg err'; msg.textContent = e.message || 'Could not create the group.'; }
  });
}

function openJoinCodeModal() {
  const modal = openModal(`
    <h3>Join a group</h3>
    <p class="muted small">Paste the invite code someone shared with you.</p>
    <input id="jc-code" placeholder="Invite code">
    <button class="btn btn-gold btn-block" style="margin-top:16px" id="jc-submit">Join</button>
    <div id="jc-msg" class="form-msg"></div>`);
  modal.querySelector('#jc-submit').addEventListener('click', async () => {
    const code = modal.querySelector('#jc-code').value.trim();
    const msg = modal.querySelector('#jc-msg');
    try {
      const roomId = await joinRoom(code);
      closeModal();
      location.hash = `#/room/${roomId}`;
    } catch (e) { msg.className = 'form-msg err'; msg.textContent = e.message || 'That invite code did not work.'; }
  });
}
