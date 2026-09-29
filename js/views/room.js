// A group chat: history, sending text/photos/files/voice notes, swipe-to-reply, tap-to-react, members
// with an invite QR/link, and a group video call banner when people are already on one.
import { supabase, rpc, avatarUrl, attachmentUrl } from '../lib/db.js';
import { onLive } from '../lib/live.js';
import { escapeHtml, initials, fmtTime, uid } from '../lib/util.js';
import { isEmojiOnly, EMOJI_GROUPS, recentEmoji, pushRecent } from '../lib/emoji.js';
import { VoiceRecorder, MIN_VOICE_SECONDS, extensionFor } from '../lib/voice.js';
import { explainMediaError } from '../lib/rtc.js';
import { renderReplyQuote, renderReactionChips, attachSwipeReply, attachReactionPicker, jumpToMessage } from '../lib/msgui.js';
import { roomPeople, sendRoomMessage, inviteLink, resetInvite, leaveRoom, removeMember, deleteRoom, roomCalls, ROOM_FOLDER } from '../lib/rooms.js';
import { startGroupCall } from './callui.js';
import { toast, openModal, closeModal, friendlyError } from '../lib/ui.js';
import { ICON } from '../lib/icons.js';
import { state } from '../state.js';

export async function mountRoom(root, roomId) {
  root.innerHTML = `<div class="empty-state"><p class="muted">Loading…</p></div>`;
  const { data: room, error } = await supabase.from('rooms').select('*').eq('id', roomId).single();
  if (error || !room) {
    root.innerHTML = `<div class="empty-state"><p>That group could not be opened.</p></div>`;
    return () => {};
  }

  root.innerHTML = `
    <div class="thread-head">
      <button class="back-btn" id="rm-back">${ICON.back}</button>
      <div class="avatar sm" style="background:#3b82c4" id="rm-avatar">${ICON.people}</div>
      <div class="info" id="rm-info">
        <div class="name">${escapeHtml(room.name)}</div>
        <div class="status" id="rm-status">&nbsp;</div>
      </div>
      <button class="btn-icon" id="rm-call" title="Group video call">${ICON.video}</button>
    </div>
    <div id="rm-call-banner"></div>
    <div class="messages" id="rm-messages"></div>
    <div id="rm-reply-preview" class="reply-preview">
      <div class="rp-body"><span class="rp-name" id="rm-rp-name"></span><span class="rp-text" id="rm-rp-text"></span></div>
      <button class="rp-close" id="rm-rp-close" aria-label="Cancel reply">&times;</button>
    </div>
    <div id="rm-record" class="record-indicator hidden"></div>
    <div id="rm-emoji" class="emoji-panel hidden"></div>
    <div class="composer">
      <button class="btn-icon" id="rm-emoji-btn" aria-label="Emoji">${ICON.emoji}</button>
      <input type="file" id="rm-file" class="hidden" accept="image/*,application/pdf,.doc,.docx">
      <button class="btn-icon" id="rm-attach" aria-label="Attach">${ICON.attach}</button>
      <div class="composer-input-wrap">
        <textarea id="rm-input" rows="1" placeholder="Message"></textarea>
        <button class="ai-compose-btn" id="rm-ai" title="Shorten with AI" aria-label="Shorten with AI">${ICON.sparkle}</button>
      </div>
      <button class="btn-icon" id="rm-mic" aria-label="Voice message">${ICON.mic}</button>
      <button class="btn-icon send-btn" id="rm-send" aria-label="Send">${ICON.send}</button>
    </div>`;

  root.querySelector('#rm-back').onclick = () => { location.hash = '#/'; };
  root.querySelector('#rm-call').onclick = () => startGroupCall(room);
  root.querySelector('#rm-info').onclick = () => openRoomInfo();

  const msgsEl = root.querySelector('#rm-messages');
  let messages = [];
  let reactions = {};
  let replyingTo = null;
  const { data: history } = await supabase.from('room_messages').select('*').eq('room_id', roomId).order('created_at', { ascending: true });
  messages = history || [];
  const people = await roomPeople(roomId).catch(() => []);
  const byId = Object.fromEntries((people || []).map((p) => [p.user_id, p]));
  await loadReactions();
  paintMessages();
  scrollDown();
  rpc('mark_room_read', { p_room: roomId }).catch(() => {});

  const offLive = onLive('room_messages', (payload) => {
    const row = payload.new;
    if (!row || row.room_id !== roomId) return;
    if (payload.eventType === 'INSERT') {
      messages.push(row);
      paintMessages();
      scrollDown();
      if (row.sender_id !== state.user.id) rpc('mark_room_read', { p_room: roomId }).catch(() => {});
    }
  });
  const offReactions = onLive('room_message_reactions', (payload) => {
    const row = payload.new || payload.old;
    if (!row || !messages.some((m) => m.id === row.message_id)) return;
    loadReactions().then(paintMessages);
  });

  let callBeat = setInterval(paintCallBanner, 15000);
  paintCallBanner();

  wireComposer();

  return () => { offLive(); offReactions(); clearInterval(callBeat); };

  async function loadReactions() {
    if (!messages.length) { reactions = {}; return; }
    const { data } = await supabase.from('room_message_reactions').select('message_id, user_id, emoji').in('message_id', messages.map((m) => m.id));
    reactions = {};
    for (const r of data || []) (reactions[r.message_id] ||= []).push(r);
  }

  async function paintCallBanner() {
    const banner = root.querySelector('#rm-call-banner');
    if (!banner) return;
    try {
      const counts = await roomCalls();
      const n = counts[roomId] || 0;
      banner.innerHTML = n
        ? `<div class="install-banner" style="cursor:pointer" id="rm-join-call"><span class="file-ic" style="color:var(--gold)">${ICON.video}</span><div class="txt">${n} ${n === 1 ? 'person is' : 'people are'} on a call now</div><button class="btn btn-gold btn-sm">Join</button></div>`
        : '';
      const j = banner.querySelector('#rm-join-call');
      if (j) j.addEventListener('click', () => startGroupCall(room));
    } catch { /* try again next tick */ }
  }

  function paintMessages() {
    let lastDay = '';
    let html = '';
    for (const m of messages) {
      const day = new Date(m.created_at).toDateString();
      if (day !== lastDay) { html += `<div class="day-sep"><span>${escapeHtml(dayLabel(m.created_at))}</span></div>`; lastDay = day; }
      html += renderMessage(m);
    }
    msgsEl.innerHTML = html || `<div class="empty-state"><p>No messages yet — say hello 👋</p></div>`;
    msgsEl.querySelectorAll('[data-attach-path]').forEach(resolveAttachment);
    msgsEl.querySelectorAll('.voice-msg').forEach(wireVoicePlayback);
    msgsEl.querySelectorAll('.msg-row').forEach(wireRow);
  }

  function renderMessage(m) {
    const mine = m.sender_id === state.user.id;
    const sender = byId[m.sender_id];
    const emojiOnly = !m.attachment && isEmojiOnly(m.body);
    const original = m.reply_to_id ? messages.find((x) => x.id === m.reply_to_id) : null;
    const quote = m.reply_to_id ? renderReplyQuote(original, original ? nameFor(original.sender_id) : 'Original message') : '';
    let body = quote;
    if (!mine) body += `<span style="display:block;font-size:12px;font-weight:700;color:var(--gold);margin-bottom:2px">${escapeHtml((sender && sender.full_name) || 'Someone')}</span>`;
    if (m.attachment) body += renderAttachment(m.attachment, m.id);
    if (m.body) body += emojiOnly ? escapeHtml(m.body) : escapeHtml(m.body).replace(/\n/g, '<br>');
    return `<div class="msg-row ${mine ? 'out' : 'in'} ${emojiOnly ? 'msg-emoji-only' : ''}" data-msg-id="${escapeHtml(m.id)}">
      <div class="bubble-wrap">
        <span class="swipe-reply-icon">&#8617;</span>
        <div class="bubble">${body}<span class="meta">${fmtTime(new Date(m.created_at).getTime(), Intl.DateTimeFormat().resolvedOptions().timeZone)}</span></div>
        ${renderReactionChips(reactions[m.id], state.user.id)}
      </div>
    </div>`;
  }

  function nameFor(userId) {
    if (userId === state.user.id) return 'You';
    const p = byId[userId];
    return (p && p.full_name) || 'Someone';
  }

  function wireRow(rowEl) {
    const id = rowEl.dataset.msgId;
    const m = messages.find((x) => x.id === id);
    if (!m) return;
    attachSwipeReply(rowEl, () => startReply(m));
    attachReactionPicker(rowEl, (emoji) => {
      rpc('toggle_room_message_reaction', { p_message: id, p_emoji: emoji }).catch((e) => toast(friendlyError(e)));
    });
    const quote = rowEl.querySelector('[data-reply-jump]');
    if (quote) quote.addEventListener('click', () => jumpToMessage(msgsEl, quote.dataset.replyJump));
    rowEl.querySelectorAll('.reaction-chip').forEach((chip) => chip.addEventListener('click', () => {
      rpc('toggle_room_message_reaction', { p_message: id, p_emoji: chip.dataset.emoji }).catch((e) => toast(friendlyError(e)));
    }));
  }

  function startReply(m) {
    replyingTo = m;
    root.querySelector('#rm-rp-name').textContent = nameFor(m.sender_id);
    root.querySelector('#rm-rp-text').textContent = m.body || (m.attachment ? (m.attachment.type && m.attachment.type.startsWith('audio/') ? 'Voice message' : 'Attachment') : '');
    root.querySelector('#rm-reply-preview').classList.add('show');
    root.querySelector('#rm-input').focus();
  }

  function cancelReply() {
    replyingTo = null;
    root.querySelector('#rm-reply-preview').classList.remove('show');
  }

  function resolveAttachment(el) {
    attachmentUrl(el.dataset.attachPath).then((url) => {
      if (el.tagName === 'IMG') el.src = url; else el.dataset.url = url;
    }).catch(() => {});
  }

  function wireVoicePlayback(el) {
    if (el.dataset.wired) return;
    el.dataset.wired = '1';
    const btn = el.querySelector('.vplay');
    let audio = null;
    btn.addEventListener('click', () => {
      if (!audio) {
        const src = el.querySelector('[data-attach-path]');
        const url = src && src.dataset.url;
        if (!url) { toast('Still loading that voice note…'); return; }
        audio = new Audio(url);
        audio.addEventListener('ended', () => { btn.innerHTML = ICON.play; });
      }
      if (audio.paused) { audio.play(); btn.innerHTML = ICON.pause; } else { audio.pause(); btn.innerHTML = ICON.play; }
    });
  }

  function scrollDown() { requestAnimationFrame(() => { msgsEl.scrollTop = msgsEl.scrollHeight; }); }

  function wireComposer() {
    const input = root.querySelector('#rm-input');
    const send = root.querySelector('#rm-send');
    const emojiBtn = root.querySelector('#rm-emoji-btn');
    const emojiPanel = root.querySelector('#rm-emoji');
    const attachBtn = root.querySelector('#rm-attach');
    const fileInput = root.querySelector('#rm-file');
    const micBtn = root.querySelector('#rm-mic');
    const recordBar = root.querySelector('#rm-record');
    const aiBtn = root.querySelector('#rm-ai');
    const folder = ROOM_FOLDER(roomId);

    root.querySelector('#rm-rp-close').addEventListener('click', cancelReply);

    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    send.addEventListener('click', doSend);

    aiBtn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) { toast('Type something first.'); return; }
      aiBtn.disabled = true;
      try {
        const { data, error: fnErr } = await supabase.functions.invoke('ai-compose', { body: { text } });
        if (fnErr) throw new Error(fnErr.message || 'Could not reach the AI.');
        if (data && data.error) { toast(data.error); return; }
        if (data && data.text) { input.value = data.text; input.dispatchEvent(new Event('input')); }
      } catch (e) { toast(friendlyError(e)); }
      finally { aiBtn.disabled = false; }
    });

    emojiBtn.addEventListener('click', () => {
      if (emojiPanel.classList.contains('hidden')) { paintEmoji(); emojiPanel.classList.remove('hidden'); } else emojiPanel.classList.add('hidden');
    });
    function paintEmoji() {
      const recent = recentEmoji();
      const groups = recent.length ? [{ id: 'recent', label: 'Recent', list: recent }, ...EMOJI_GROUPS] : EMOJI_GROUPS;
      emojiPanel.innerHTML = groups.map((g) => `<div class="grp-label">${escapeHtml(g.label)}</div><div class="emoji-grid">${g.list.map((e) => `<button type="button">${e}</button>`).join('')}</div>`).join('');
      emojiPanel.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { input.value += b.textContent; input.focus(); pushRecent(b.textContent); }));
    }

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      await sendFile(file);
    });

    let recorder = null;
    let recTimer = null;
    micBtn.addEventListener('click', async () => {
      if (recorder) { await finishRecording(); return; }
      try { recorder = new VoiceRecorder(); await recorder.start(); }
      catch (e) { toast(explainMediaError(e)); recorder = null; return; }
      micBtn.innerHTML = ICON.stop;
      recordBar.classList.remove('hidden');
      const paint = () => { recordBar.innerHTML = `<span class="rec-dot"></span> Recording… ${recorder.seconds().toFixed(0)}s <button class="btn btn-ghost btn-sm" id="rm-rec-cancel" style="margin-left:auto">Cancel</button>`; recordBar.querySelector('#rm-rec-cancel').onclick = cancelRecording; };
      paint();
      recTimer = setInterval(paint, 500);
    });

    function cancelRecording() {
      if (recorder) recorder.cancel();
      recorder = null;
      clearInterval(recTimer);
      recordBar.classList.add('hidden');
      micBtn.innerHTML = ICON.mic;
    }

    async function finishRecording() {
      clearInterval(recTimer);
      recordBar.classList.add('hidden');
      micBtn.innerHTML = ICON.mic;
      const r = recorder; recorder = null;
      let result;
      try { result = await r.stop(); } catch { return; }
      if (result.duration < MIN_VOICE_SECONDS) { toast('Too short — hold to record a voice message.'); return; }
      const path = `${folder}/${uid()}.${extensionFor(result.mime)}`;
      try {
        const { error: upErr } = await supabase.storage.from('attachments').upload(path, result.blob, { contentType: result.mime });
        if (upErr) throw new Error(upErr.message);
        await sendRoomMessage({ room, body: '', attachment: { type: result.mime, path, name: 'Voice message', duration: result.duration, peaks: result.peaks }, replyTo: replyingTo ? replyingTo.id : null });
        cancelReply();
      } catch (e) { toast(friendlyError(e)); }
    }

    async function doSend() {
      const text = input.value.trim();
      if (!text) return;
      input.value = ''; input.style.height = 'auto';
      emojiPanel.classList.add('hidden');
      const replyId = replyingTo ? replyingTo.id : null;
      cancelReply();
      try { await sendRoomMessage({ room, body: text, replyTo: replyId }); }
      catch (e) { toast(friendlyError(e)); }
    }

    async function sendFile(file) {
      if (file.size > 15 * 1024 * 1024) { toast('That file is larger than 15 MB.'); return; }
      const path = `${folder}/${uid()}-${file.name}`;
      try {
        const { error: upErr } = await supabase.storage.from('attachments').upload(path, file, { contentType: file.type || 'application/octet-stream' });
        if (upErr) throw new Error(upErr.message);
        await sendRoomMessage({ room, body: '', attachment: { type: file.type || 'application/octet-stream', path, name: file.name, size: file.size }, replyTo: replyingTo ? replyingTo.id : null });
        cancelReply();
      } catch (e) { toast(friendlyError(e)); }
    }
  }

  async function openRoomInfo() {
    const isOwner = room.owner_id === state.user.id;
    const link = inviteLink(room.invite_code);
    const modal = openModal(`
      <h3 style="margin-bottom:2px">${escapeHtml(room.name)}</h3>
      <p class="muted small">${escapeHtml(room.topic || 'No topic set')}</p>
      <div class="qr-box" style="margin:16px 0">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=6&data=${encodeURIComponent(link)}" alt="Invite QR code">
        <button class="btn btn-ghost btn-sm" id="ri-copy">Copy invite link</button>
        ${isOwner ? '<button class="btn btn-ghost btn-sm" id="ri-reset">Generate new invite code</button>' : ''}
      </div>
      <h4 style="margin:16px 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase">Members (${(people || []).length})</h4>
      <div id="ri-members"></div>
      <div style="margin-top:18px;display:flex;gap:8px">
        ${isOwner ? '<button class="btn btn-danger btn-block" id="ri-delete">Delete group</button>' : '<button class="btn btn-danger btn-block" id="ri-leave">Leave group</button>'}
      </div>`);
    modal.querySelector('#ri-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(link); toast('Invite link copied.'); } catch { toast(link); } });
    const resetBtn = modal.querySelector('#ri-reset');
    if (resetBtn) resetBtn.addEventListener('click', async () => {
      try { room.invite_code = await resetInvite(roomId); toast('New invite code generated.'); closeModal(); openRoomInfo(); } catch (e) { toast(friendlyError(e)); }
    });
    const membersEl = modal.querySelector('#ri-members');
    membersEl.innerHTML = (people || []).map((p) => `
      <div class="member-row">
        <div class="avatar sm" style="background:${escapeHtml(p.avatar_color || '#3b82c4')}">${p.avatar_path ? `<img class="avatar sm" src="${escapeHtml(avatarUrl(p.avatar_path))}">` : escapeHtml(initials(p.full_name))}</div>
        <div class="meta"><div class="name">${escapeHtml(p.full_name)}${p.is_owner ? ' &#9733;' : ''}</div><div class="status">${p.last_seen ? (statusFrom(p.last_seen)) : ''}</div></div>
        ${isOwner && !p.is_owner ? `<button class="btn btn-ghost btn-sm" data-remove="${escapeHtml(p.user_id)}">Remove</button>` : ''}
      </div>`).join('');
    membersEl.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      try { await removeMember(roomId, b.dataset.remove); toast('Removed from the group.'); closeModal(); openRoomInfo(); } catch (e) { toast(friendlyError(e)); }
    }));
    const leaveBtn = modal.querySelector('#ri-leave');
    if (leaveBtn) leaveBtn.addEventListener('click', async () => {
      try { await leaveRoom(roomId); closeModal(); location.hash = '#/'; } catch (e) { toast(friendlyError(e)); }
    });
    const deleteBtn = modal.querySelector('#ri-delete');
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this group for everyone? This cannot be undone.')) return;
      try { await deleteRoom(roomId); closeModal(); location.hash = '#/'; } catch (e) { toast(friendlyError(e)); }
    });
  }
}

function statusFrom(iso) {
  const age = Date.now() - Date.parse(iso);
  return age < 90000 ? 'Online' : '';
}

function dayLabel(iso) {
  const d = new Date(iso), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (sameDay) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function renderAttachment(att, msgId) {
  if (!att || !att.path) return '';
  if (att.type && att.type.startsWith('image/')) {
    return `<img class="msg-img" data-attach-path="${escapeHtml(att.path)}" alt="${escapeHtml(att.name || 'photo')}" onclick="this.src && window.open(this.src,'_blank')">`;
  }
  if (att.type && att.type.startsWith('audio/')) {
    const peaks = Array.isArray(att.peaks) ? att.peaks : [];
    const bars = (peaks.length ? peaks : Array(28).fill(0.3)).map((v) => `<i style="height:${Math.round(v * 24) + 4}px"></i>`).join('');
    return `<div class="voice-msg" id="voice-${escapeHtml(msgId)}">
      <button class="vplay" type="button">${ICON.play}</button>
      <div class="vbars">${bars}</div>
      <span class="vtime">${att.duration ? Math.round(att.duration) + 's' : ''}</span>
      <span data-attach-path="${escapeHtml(att.path)}" style="display:none"></span>
    </div>`;
  }
  return `<a class="msg-file" data-attach-path="${escapeHtml(att.path)}" href="#" onclick="event.preventDefault(); if(this.dataset.url) window.open(this.dataset.url,'_blank')">
    <span class="file-ic">${ICON.file}</span> <span>${escapeHtml(att.name || 'File')}${att.size ? ` (${(att.size / 1024).toFixed(0)} KB)` : ''}</span>
  </a>`;
}
