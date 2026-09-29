// A one-to-one conversation: history, sending text/photos/files/voice notes, emoji, swipe-to-reply,
// tap-to-react, read receipts, and starting a video call. If the other person has "Reply for me" on and
// this message reaches them while they're away, their reply appears here tagged "Auto-reply"
// (message.sent_by_ai) -- see supabase/functions/ai-reply.
import { supabase, rpc, avatarUrl, attachmentUrl } from '../lib/db.js';
import { onLive } from '../lib/live.js';
import { fetchSeen, statusOf } from '../lib/seen.js';
import { escapeHtml, initials, fmtTime, uid } from '../lib/util.js';
import { isEmojiOnly, EMOJI_GROUPS, recentEmoji, pushRecent } from '../lib/emoji.js';
import { VoiceRecorder, MIN_VOICE_SECONDS, extensionFor } from '../lib/voice.js';
import { renderTicks, renderReplyQuote, renderReactionChips, attachSwipeReply, attachReactionPicker, jumpToMessage } from '../lib/msgui.js';
import { startDirectCall } from './callui.js';
import { toast, openModal } from '../lib/ui.js';
import { ICON } from '../lib/icons.js';
import { state } from '../state.js';

export async function mountChat(root, conversationId) {
  const [aId, bId] = conversationId.split('__');
  const otherId = aId === state.user.id ? bId : aId;
  if (!otherId || (aId !== state.user.id && bId !== state.user.id)) {
    root.innerHTML = `<div class="empty-state"><p>That conversation could not be opened.</p></div>`;
    return () => {};
  }

  root.innerHTML = `<div class="empty-state"><p class="muted">Loading…</p></div>`;
  const { data: peer, error } = await supabase.from('profiles').select('*').eq('id', otherId).single();
  if (error || !peer) {
    root.innerHTML = `<div class="empty-state"><p>That person could not be found.</p></div>`;
    return () => {};
  }

  root.innerHTML = `
    <div class="thread-head">
      <button class="back-btn" id="ch-back">${ICON.back}</button>
      <div class="avatar sm" id="ch-avatar"></div>
      <div class="info" id="ch-info">
        <div class="name">${escapeHtml(peer.full_name || peer.username)}</div>
        <div class="status" id="ch-status">&nbsp;</div>
      </div>
      <button class="btn-icon" id="ch-call" title="Video call">${ICON.video}</button>
    </div>
    <div class="messages" id="ch-messages"></div>
    <div id="ch-reply-preview" class="reply-preview">
      <div class="rp-body"><span class="rp-name" id="ch-rp-name"></span><span class="rp-text" id="ch-rp-text"></span></div>
      <button class="rp-close" id="ch-rp-close" aria-label="Cancel reply">&times;</button>
    </div>
    <div id="ch-record" class="record-indicator hidden"></div>
    <div id="ch-emoji" class="emoji-panel hidden"></div>
    <div class="composer">
      <button class="btn-icon" id="ch-emoji-btn" aria-label="Emoji">${ICON.emoji}</button>
      <input type="file" id="ch-file" class="hidden" accept="image/*,application/pdf,.doc,.docx">
      <button class="btn-icon" id="ch-attach" aria-label="Attach">${ICON.attach}</button>
      <div class="composer-input-wrap">
        <textarea id="ch-input" rows="1" placeholder="Message"></textarea>
        <button class="ai-compose-btn" id="ch-ai" title="Shorten with AI" aria-label="Shorten with AI">${ICON.sparkle}</button>
      </div>
      <button class="btn-icon" id="ch-mic" aria-label="Voice message">${ICON.mic}</button>
      <button class="btn-icon send-btn" id="ch-send" aria-label="Send">${ICON.send}</button>
    </div>`;

  paintAvatar(root.querySelector('#ch-avatar'), peer);
  root.querySelector('#ch-back').onclick = () => { location.hash = '#/'; };
  root.querySelector('#ch-call').onclick = () => startDirectCall(peer);
  root.querySelector('#ch-info').onclick = () => showContactInfo(peer);

  let statusStop = tickStatus();

  const msgsEl = root.querySelector('#ch-messages');
  let messages = [];
  let reactions = {}; // message id -> [{user_id, emoji}]
  let replyingTo = null;

  const { data: history } = await supabase.from('messages').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: true });
  messages = history || [];
  await loadReactions();
  paintMessages();
  scrollDown();
  rpc('mark_conversation_read', { p_conversation: conversationId }).catch(() => {});

  const offLive = onLive('messages', (payload) => {
    const row = payload.new;
    if (!row || row.conversation_id !== conversationId) return;
    if (payload.eventType === 'INSERT') {
      messages.push(row);
      paintMessages();
      scrollDown();
      if (row.sender_id !== state.user.id) rpc('mark_conversation_read', { p_conversation: conversationId }).catch(() => {});
    } else if (payload.eventType === 'UPDATE') {
      const i = messages.findIndex((m) => m.id === row.id);
      if (i >= 0) { messages[i] = row; paintMessages(); }
    }
  });
  const offReactions = onLive('message_reactions', (payload) => {
    const row = payload.new || payload.old;
    if (!row || !messages.some((m) => m.id === row.message_id)) return;
    loadReactions().then(paintMessages);
  });

  wireComposer();

  return () => { offLive(); offReactions(); if (statusStop) clearInterval(statusStop); };

  async function loadReactions() {
    if (!messages.length) { reactions = {}; return; }
    const { data } = await supabase.from('message_reactions').select('message_id, user_id, emoji').in('message_id', messages.map((m) => m.id));
    reactions = {};
    for (const r of data || []) (reactions[r.message_id] ||= []).push(r);
  }

  function tickStatus() {
    const set = async () => {
      try {
        const rows = await fetchSeen();
        const info = rows[otherId];
        const st = root.querySelector('#ch-status');
        if (st) st.textContent = info ? statusOf(info.lastSeen).text : '';
      } catch { /* keep the last known status */ }
    };
    set();
    return setInterval(set, 20000);
  }

  function paintMessages() {
    let lastDay = '';
    let html = '';
    for (const m of messages) {
      const day = new Date(m.created_at).toDateString();
      if (day !== lastDay) { html += `<div class="day-sep"><span>${escapeHtml(dayLabel(m.created_at))}</span></div>`; lastDay = day; }
      html += renderMessage(m);
    }
    msgsEl.innerHTML = html || `<div class="empty-state"><p>Say hello 👋</p></div>`;
    msgsEl.querySelectorAll('[data-attach-path]').forEach(resolveAttachment);
    msgsEl.querySelectorAll('.voice-msg').forEach(wireVoicePlayback);
    msgsEl.querySelectorAll('.msg-row').forEach(wireRow);
  }

  function renderMessage(m) {
    const mine = m.sender_id === state.user.id;
    const emojiOnly = !m.attachment && isEmojiOnly(m.body);
    const badge = m.sent_by_ai ? '<span class="ai-badge">Auto-reply</span>' : '';
    const original = m.reply_to_id ? messages.find((x) => x.id === m.reply_to_id) : null;
    const quote = m.reply_to_id ? renderReplyQuote(original, original ? (original.sender_id === state.user.id ? 'You' : (peer.full_name || 'Them')) : 'Original message') : '';
    let body = quote;
    if (m.attachment) body += renderAttachment(m.attachment, m.id);
    if (m.body) body += emojiOnly ? escapeHtml(m.body) : escapeHtml(m.body).replace(/\n/g, '<br>');
    return `<div class="msg-row ${mine ? 'out' : 'in'} ${emojiOnly ? 'msg-emoji-only' : ''}" data-msg-id="${escapeHtml(m.id)}">
      <div class="bubble-wrap">
        <span class="swipe-reply-icon">&#8617;</span>
        <div class="bubble">${badge}${body}<span class="meta">${fmtTime(new Date(m.created_at).getTime(), Intl.DateTimeFormat().resolvedOptions().timeZone)}${renderTicks(m, mine)}</span></div>
        ${renderReactionChips(reactions[m.id], state.user.id)}
      </div>
    </div>`;
  }

  function wireRow(rowEl) {
    const id = rowEl.dataset.msgId;
    const m = messages.find((x) => x.id === id);
    if (!m) return;
    attachSwipeReply(rowEl, () => startReply(m));
    attachReactionPicker(rowEl, (emoji) => {
      rpc('toggle_message_reaction', { p_message: id, p_emoji: emoji }).catch((e) => toast(e.message || 'Could not react.'));
    });
    const quote = rowEl.querySelector('[data-reply-jump]');
    if (quote) quote.addEventListener('click', () => jumpToMessage(msgsEl, quote.dataset.replyJump));
    rowEl.querySelectorAll('.reaction-chip').forEach((chip) => chip.addEventListener('click', () => {
      rpc('toggle_message_reaction', { p_message: id, p_emoji: chip.dataset.emoji }).catch((e) => toast(e.message || 'Could not react.'));
    }));
  }

  function startReply(m) {
    replyingTo = m;
    const nameEl = root.querySelector('#ch-rp-name');
    const textEl = root.querySelector('#ch-rp-text');
    const mine = m.sender_id === state.user.id;
    nameEl.textContent = mine ? 'You' : (peer.full_name || 'Them');
    textEl.textContent = m.body || (m.attachment ? (m.attachment.type && m.attachment.type.startsWith('audio/') ? 'Voice message' : 'Attachment') : '');
    root.querySelector('#ch-reply-preview').classList.add('show');
    root.querySelector('#ch-input').focus();
  }

  function cancelReply() {
    replyingTo = null;
    root.querySelector('#ch-reply-preview').classList.remove('show');
  }

  function resolveAttachment(el) {
    const path = el.dataset.attachPath;
    attachmentUrl(path).then((url) => {
      if (el.tagName === 'IMG') el.src = url;
      else el.dataset.url = url;
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
    const input = root.querySelector('#ch-input');
    const send = root.querySelector('#ch-send');
    const emojiBtn = root.querySelector('#ch-emoji-btn');
    const emojiPanel = root.querySelector('#ch-emoji');
    const attachBtn = root.querySelector('#ch-attach');
    const fileInput = root.querySelector('#ch-file');
    const micBtn = root.querySelector('#ch-mic');
    const recordBar = root.querySelector('#ch-record');
    const aiBtn = root.querySelector('#ch-ai');

    root.querySelector('#ch-rp-close').addEventListener('click', cancelReply);

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
      } catch (e) { toast(e.message || 'Could not shorten that message.'); }
      finally { aiBtn.disabled = false; }
    });

    emojiBtn.addEventListener('click', () => {
      if (emojiPanel.classList.contains('hidden')) { paintEmoji(); emojiPanel.classList.remove('hidden'); } else emojiPanel.classList.add('hidden');
    });
    function paintEmoji() {
      const recent = recentEmoji();
      const groups = recent.length ? [{ id: 'recent', label: 'Recent', list: recent }, ...EMOJI_GROUPS] : EMOJI_GROUPS;
      emojiPanel.innerHTML = groups.map((g) => `<div class="grp-label">${escapeHtml(g.label)}</div><div class="emoji-grid">${g.list.map((e) => `<button type="button">${e}</button>`).join('')}</div>`).join('');
      emojiPanel.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        input.value += b.textContent; input.focus(); pushRecent(b.textContent);
      }));
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
      try {
        recorder = new VoiceRecorder();
        await recorder.start();
      } catch (e) { toast(e.message || 'Could not start recording.'); recorder = null; return; }
      micBtn.innerHTML = ICON.stop;
      recordBar.classList.remove('hidden');
      const paint = () => { recordBar.innerHTML = `<span class="rec-dot"></span> Recording… ${recorder.seconds().toFixed(0)}s <button class="btn btn-ghost btn-sm" id="ch-rec-cancel" style="margin-left:auto">Cancel</button>`; recordBar.querySelector('#ch-rec-cancel').onclick = cancelRecording; };
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
      const path = `${conversationId}/${uid()}.${extensionFor(result.mime)}`;
      try {
        const { error: upErr } = await supabase.storage.from('attachments').upload(path, result.blob, { contentType: result.mime });
        if (upErr) throw new Error(upErr.message);
        await rpc('send_message', { p_conversation: conversationId, p_body: '', p_attachment: { type: result.mime, path, name: 'Voice message', duration: result.duration, peaks: result.peaks }, p_reply_to: replyingTo ? replyingTo.id : null });
        cancelReply();
      } catch (e) { toast(e.message || 'Could not send the voice message.'); }
    }

    async function doSend() {
      const text = input.value.trim();
      if (!text) return;
      input.value = ''; input.style.height = 'auto';
      emojiPanel.classList.add('hidden');
      const replyId = replyingTo ? replyingTo.id : null;
      cancelReply();
      try { await rpc('send_message', { p_conversation: conversationId, p_body: text, p_reply_to: replyId }); }
      catch (e) { toast(e.message || 'Could not send that message.'); }
    }

    async function sendFile(file) {
      if (file.size > 15 * 1024 * 1024) { toast('That file is larger than 15 MB.'); return; }
      const path = `${conversationId}/${uid()}-${file.name}`;
      try {
        const { error: upErr } = await supabase.storage.from('attachments').upload(path, file, { contentType: file.type || 'application/octet-stream' });
        if (upErr) throw new Error(upErr.message);
        await rpc('send_message', { p_conversation: conversationId, p_body: '', p_attachment: { type: file.type || 'application/octet-stream', path, name: file.name, size: file.size }, p_reply_to: replyingTo ? replyingTo.id : null });
        cancelReply();
      } catch (e) { toast(e.message || 'Could not send that file.'); }
    }
  }
}

function paintAvatar(el, person) {
  if (person.avatar_path) el.innerHTML = `<img src="${escapeHtml(avatarUrl(person.avatar_path))}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
  else { el.style.background = person.avatar_color || '#3b82c4'; el.textContent = initials(person.full_name || person.username || '?'); }
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

function showContactInfo(peer) {
  const modal = openModal(`
    <div class="center">
      <div class="avatar lg" style="margin:0 auto 12px" id="ci-avatar"></div>
      <h3 style="margin-bottom:2px">${escapeHtml(peer.full_name || peer.username)}</h3>
      <p class="muted small">@${escapeHtml(peer.username || '')}</p>
      ${peer.bio ? `<p style="margin-top:14px">${escapeHtml(peer.bio)}</p>` : '<p class="muted" style="margin-top:14px">No bio yet.</p>'}
    </div>`);
  paintAvatar(modal.querySelector('#ci-avatar'), peer);
}
