// The persistent left-hand pane: search bar, the combined list of DMs and rooms (sorted like WhatsApp,
// most recent activity first), and the "new chat" / "new room" / "join by code" flows.
import { supabase, rpc, avatarUrl } from '../lib/db.js';
import { onLive } from '../lib/live.js';
import { watchSeen, statusOf } from '../lib/seen.js';
import { createRoom, joinRoom } from '../lib/rooms.js';
import { dateLobby } from '../lib/dates.js';
import { inAndroidApp } from '../lib/android.js';
import { availableUpdate, updatePressed, updateProgress, progressText, startAppUpdate } from './appupdate.js';
import { initials, timeAgo, escapeHtml, debounce, cssColor } from '../lib/util.js';
import { openModal, closeModal, toast, friendlyError } from '../lib/ui.js';
import { ICON } from '../lib/icons.js';
import { state } from '../state.js';

let seenMap = {};
let stopWatchingSeen = null;
let rows = [];
let followUps = new Set(); // DMs where AI answered for you and you haven't written since
let toldAboutFollowUps = false;

export function mountChatList(root) {
  root.innerHTML = `
    <div class="topbar">
      <div class="brand"><img src="icons/logo.webp" alt=""> ForYou</div>
      <div class="spacer"></div>
      <button class="head-btn" id="cl-install" title="Get the app" aria-label="Get the app">${ICON.download}</button>
      <button class="me-btn" id="cl-settings" title="Settings" aria-label="Settings"></button>
    </div>
    <div class="searchbar"><input id="cl-search" type="search" placeholder="Search chats"></div>
    <div class="list" id="cl-list">
      <div id="cl-update"></div>
      <button class="bd-banner" id="cl-dates" type="button">
        <span class="bd-banner-art">${ICON.blindfold}</span>
        <span class="bd-banner-txt"><b>Campus Blind Dates</b><span id="cl-dates-sub">Talk first, see later</span></span>
        <span class="bd-banner-go">${ICON.back}</span>
      </button>
      <div id="cl-rows"><div class="thread-loading"><span></span><span></span><span></span></div></div>
    </div>
    <button class="fab" id="cl-new" aria-label="New chat">${ICON.plus}</button>`;

  paintMyAvatar();
  root.querySelector('#cl-settings').addEventListener('click', () => { location.hash = '#/settings'; });
  root.querySelector('#cl-install').addEventListener('click', () => { location.hash = '#/install'; });
  root.querySelector('#cl-new').addEventListener('click', openNewChatModal);
  root.querySelector('#cl-dates').addEventListener('click', () => { location.hash = '#/dates'; });
  root.querySelector('#cl-search').addEventListener('input', debounce((e) => renderList(e.target.value), 120));

  const refresh = debounce(() => load(), 200);
  const offs = ['messages', 'conversations', 'room_messages', 'rooms', 'room_members'].map((t) => onLive(t, refresh));
  stopWatchingSeen = watchSeen((m) => { seenMap = m; renderList(root.querySelector('#cl-search')?.value || ''); }, 20000);
  window.addEventListener('hashchange', highlightActive);

  load();
  countDates();
  paintUpdate();
  window.addEventListener('foryouapp', paintUpdate);
  const datesTimer = setInterval(countDates, 30000);

  return () => {
    clearInterval(datesTimer);
    window.removeEventListener('foryouapp', paintUpdate);
    offs.forEach((off) => off());
    if (stopWatchingSeen) stopWatchingSeen();
    window.removeEventListener('hashchange', highlightActive);
  };

  // A newer version of the Android app (views/appupdate.js). Once Update is pressed, the banner gives
  // way to a line that shows how the update is going, and doesn't come back for an hour.
  function paintUpdate() {
    const box = root.querySelector('#cl-update');
    if (!box || !inAndroidApp()) return;
    const ready = availableUpdate();
    const u = updatePressed(ready) ? null : ready;
    const p = updateProgress();
    const key = p ? `p:${p.stage}:${p.pct}` : u ? `u:${u.versionCode}` : '';
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    if (p) {
      box.innerHTML = `<div class="update-progress"><span class="up-spin"></span><span>${escapeHtml(progressText(p))}</span></div>`;
    } else if (u) {
      box.innerHTML = `<div class="update-banner">
        <span class="ub-ic">${ICON.download}</span>
        <span class="ub-txt"><b>Update available</b><span>ForYou ${escapeHtml(u.versionName)} is ready. This version will no longer be supported.</span></span>
        <button class="btn btn-gold btn-sm" id="cl-update-go" type="button">Update</button>
      </div>`;
      box.querySelector('#cl-update-go').addEventListener('click', startAppUpdate);
    } else {
      box.innerHTML = '';
    }
  }

  async function countDates() {
    try {
      const open = (await dateLobby()).filter((r) => !r.revealed).length;
      const sub = root.querySelector('#cl-dates-sub');
      if (sub) sub.textContent = open ? `${open} room${open === 1 ? '' : 's'} open now` : 'Talk first, see later';
      root.querySelector('#cl-dates').classList.toggle('live', open > 0);
    } catch { /* the banner keeps its tagline */ }
  }

  function paintMyAvatar() {
    const btn = root.querySelector('#cl-settings');
    const p = state.profile;
    if (p && p.avatar_path) btn.innerHTML = `<img src="${escapeHtml(avatarUrl(p.avatar_path))}" alt="">`;
    else { btn.style.background = (p && p.avatar_color) || 'var(--gold)'; btn.textContent = initials((p && p.full_name) || '?'); }
  }

  async function load() {
    try {
      const [convs, myRooms] = await Promise.all([rpc('my_conversations'), rpc('my_rooms'), loadFollowUps()]);
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
      root.querySelector('#cl-rows').innerHTML = `<p class="muted center" style="padding:20px">${escapeHtml(friendlyError(e))}</p>`;
    }
  }

  async function loadFollowUps() {
    const { data } = await supabase.from('messages').select('conversation_id, sent_by_ai, deleted_at')
      .eq('sender_id', state.user.id).order('created_at', { ascending: false }).limit(300);
    const seen = new Set(), next = new Set();
    for (const r of data || []) {
      if (r.deleted_at || seen.has(r.conversation_id)) continue;
      seen.add(r.conversation_id);
      if (r.sent_by_ai) next.add(r.conversation_id);
    }
    followUps = next;
    if (next.size && !toldAboutFollowUps) {
      toldAboutFollowUps = true;
      toast(`While you were away, AI replied for you in ${next.size === 1 ? 'a chat' : `${next.size} chats`}. Follow up when you can.`, 5000);
    }
  }

  function renderList(filter) {
    const listEl = root.querySelector('#cl-rows');
    if (!listEl) return;
    const q = String(filter || '').trim().toLowerCase();
    const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
    if (!shown.length) {
      listEl.innerHTML = `<div class="list-empty"><p>${q ? 'No chats match your search.' : 'No chats yet. Tap + to start one.'}</p></div>`;
      return;
    }
    listEl.innerHTML = shown.map((r) => {
      const href = r.type === 'dm' ? `#/chat/${encodeURIComponent(r.id)}` : `#/room/${r.id}`;
      const online = r.type === 'dm' && seenMap[r.otherId] && statusOf(seenMap[r.otherId].lastSeen).online;
      const avatar = r.avatarPath
        ? `<img class="avatar" src="${escapeHtml(avatarUrl(r.avatarPath))}" alt="">`
        : r.type === 'room'
          ? `<div class="avatar group-avatar">${ICON.people}</div>`
          : `<div class="avatar" style="background:${cssColor(r.avatarColor, '#3b82c4')}">${escapeHtml(initials(r.name))}</div>`;
      const muted = !r.preview || r.preview === 'Message deleted';
      return `
      <div class="list-item${r.unread ? ' unread' : ''}" data-href="${href}" data-id="${r.type}:${r.id}">
        <div class="li-avatar">${avatar}${online ? '<span class="dot-online"></span>' : ''}</div>
        <div class="meta">
          <div class="top-row"><span class="name">${escapeHtml(r.name)}</span>${r.type === 'dm' && followUps.has(r.id) ? '<span class="pill-followup">Follow up</span>' : ''}<span class="time">${r.lastAt ? timeAgo(new Date(r.lastAt).getTime()) : ''}</span></div>
          <div class="top-row"><span class="preview${muted ? ' faint' : ''}">${escapeHtml(r.preview || 'No messages yet')}</span>${r.unread ? `<span class="badge">${r.unread > 99 ? '99+' : r.unread}</span>` : ''}</div>
        </div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => { location.hash = el.dataset.href; }));
    highlightActive();
  }

  function highlightActive() {
    const listEl = document.getElementById('cl-rows');
    if (!listEl) return;
    const h = location.hash;
    listEl.querySelectorAll('.list-item').forEach((el) => el.classList.toggle('active', el.dataset.href === h));
  }
}

async function openNewChatModal() {
  const modal = openModal(`
    <h3>New chat</h3>
    <p class="muted small">Everyone on ForYou. Tap someone to start chatting.</p>
    <input id="nc-search" type="search" placeholder="Search by name or username">
    <div id="nc-result" style="margin-top:10px;max-height:320px;overflow-y:auto"></div>
    <div style="margin:18px 0;border-top:1px solid var(--border)"></div>
    <button class="btn btn-ghost btn-block" id="nc-newroom">Create a group</button>
    <button class="btn btn-ghost btn-block" style="margin-top:8px" id="nc-joincode">Join a group by invite code</button>
  `);
  const input = modal.querySelector('#nc-search');
  const result = modal.querySelector('#nc-result');
  let everyone = [];

  result.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const { data, error } = await supabase.from('profiles')
      .select('id, full_name, username, avatar_path, avatar_color')
      .neq('id', state.user.id).order('full_name').limit(300);
    if (error) throw new Error(error.message);
    everyone = data || [];
    paint(everyone);
  } catch (e) { result.innerHTML = `<p class="muted small">${escapeHtml(friendlyError(e))}</p>`; }

  input.addEventListener('input', debounce(() => {
    const q = input.value.trim().toLowerCase().replace(/^@/, '');
    if (!q) { paint(everyone); return; }
    paint(everyone.filter((p) => (p.full_name || '').toLowerCase().includes(q) || (p.username || '').toLowerCase().includes(q)));
  }, 150));

  function paint(list) {
    if (!list.length) { result.innerHTML = '<p class="muted small">No one found.</p>'; return; }
    result.innerHTML = list.map((p) => `
      <div class="list-item" data-person="${escapeHtml(p.id)}" style="border-radius:12px">
        <div class="avatar" style="background:${escapeHtml(p.avatar_color || '#3b82c4')}">${p.avatar_path ? `<img class="avatar" src="${escapeHtml(avatarUrl(p.avatar_path))}">` : escapeHtml(initials(p.full_name))}</div>
        <div class="meta"><div class="name">${escapeHtml(p.full_name || p.username || 'Someone')}</div><div class="preview">${p.username ? '@' + escapeHtml(p.username) : ''}</div></div>
      </div>`).join('');
    result.querySelectorAll('[data-person]').forEach((row) => row.addEventListener('click', async () => {
      try {
        const cid = await rpc('ensure_conversation', { p_other: row.dataset.person });
        closeModal();
        location.hash = `#/chat/${encodeURIComponent(cid)}`;
      } catch (e) { toast(friendlyError(e)); }
    }));
  }

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
    } catch (e) { msg.className = 'form-msg err'; msg.textContent = friendlyError(e); }
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
    } catch (e) { msg.className = 'form-msg err'; msg.textContent = friendlyError(e); }
  });
}
