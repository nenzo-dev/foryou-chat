// Everything a message thread does that is the same for a DM and a group: loading history a page at a
// time, live updates (new, edited and deleted messages, reactions), the message menu (reply, copy, edit,
// delete) and keeping the view scrolled to the newest message. chat.js and room.js supply the header,
// who's who, and how a message is sent.
import { supabase, rpc } from './db.js';
import { onLive } from './live.js';
import { renderThread, hydrateThread, attachSwipeReply, attachMessageMenu, openMessageMenu, closeMessageMenu, jumpToMessage } from './msgui.js';
import { createComposer } from './composer.js';
import { toast, friendlyError, choose } from './ui.js';
import { ICON } from './icons.js';

const PAGE = 120;

const KINDS = {
  dm: {
    table: 'messages', key: 'conversation_id', reactions: 'message_reactions',
    react: 'toggle_message_reaction', edit: 'edit_message', del: 'delete_message',
    markRead: (id) => rpc('mark_conversation_read', { p_conversation: id }),
  },
  room: {
    table: 'room_messages', key: 'room_id', reactions: 'room_message_reactions',
    react: 'toggle_room_message_reaction', edit: 'edit_room_message', del: 'delete_room_message',
    markRead: (id) => rpc('mark_room_read', { p_room: id }),
  },
};

/*
  host        element that receives the messages list and the composer
  kind        'dm' | 'room'
  id          conversation id or room id
  folder      storage folder for uploads
  me          signed-in person's id
  nameFor     (userId) => name
  avatarFor   (userId) => avatar html (groups)
  isOwner     true if this person owns the group (can remove anyone's message)
  send        async ({ body, attachment, replyTo }) => the inserted row
*/
export async function mountThread(host, { kind, id, folder, me, nameFor, avatarFor, isOwner = false, send }) {
  const K = KINDS[kind];
  host.innerHTML = `
    <div class="thread-body">
      <div class="messages" role="log" aria-live="polite"></div>
      <button class="jump-new hidden" type="button" aria-label="Go to newest message"><span class="jn-count"></span>${ICON.back}</button>
    </div>
    <div class="thread-composer"></div>`;
  const listEl = host.querySelector('.messages');
  const jumpEl = host.querySelector('.jump-new');

  let messages = [], reactions = {}, hidden = new Set(), hasMore = false, unseen = 0, destroyed = false;
  const fresh = new Set();

  const composer = createComposer(host.querySelector('.thread-composer'), {
    folder, me, nameFor,
    send: async (args) => { const row = await send(args); if (row && row.id) addRow(row, true); },
    edit: async (m, body) => { const row = await rpc(K.edit, { p_message: m.id, p_body: body }); if (row && row.id) upsert(row); },
  });

  listEl.innerHTML = '<div class="thread-loading"><span></span><span></span><span></span></div>';
  await Promise.all([loadPage(), loadHidden()]);
  await loadReactions();
  if (destroyed) return { destroy() {} };
  paint();
  scrollToEnd(false);
  // Web fonts arriving a moment later change line heights; stay pinned to the newest message.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!destroyed && nearBottom(160)) scrollToEnd(false); });
  K.markRead(id).catch(() => {});

  const offRows = onLive(K.table, (payload) => {
    const row = payload.new;
    if (!row || row[K.key] !== id) return;
    if (payload.eventType === 'INSERT') addRow(row, row.sender_id === me);
    else if (payload.eventType === 'UPDATE') upsert(row);
  });
  const offReactions = onLive(K.reactions, (payload) => {
    const row = payload.new && payload.new.message_id ? payload.new : payload.old;
    if (!row || !messages.some((m) => m.id === row.message_id)) return;
    loadReactions().then(paint);
  });
  listEl.addEventListener('scroll', onScroll, { passive: true });
  jumpEl.addEventListener('click', () => scrollToEnd(true));

  return {
    composer,
    repaint: paint,
    destroy() {
      destroyed = true;
      offRows(); offReactions(); composer.destroy(); closeMessageMenu();
    },
  };

  async function loadPage(before) {
    let q = supabase.from(K.table).select('*').eq(K.key, id).order('created_at', { ascending: false }).limit(PAGE);
    if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    if (error) { console.error(error); return; }
    const rows = (data || []).reverse();
    hasMore = rows.length === PAGE;
    messages = before ? [...rows, ...messages] : rows;
  }

  async function loadHidden() {
    const { data } = await supabase.from('hidden_messages').select('message_id').limit(5000);
    hidden = new Set((data || []).map((r) => r.message_id));
  }

  async function loadReactions() {
    const ids = messages.map((m) => m.id);
    const next = {};
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await supabase.from(K.reactions).select('message_id, user_id, emoji').in('message_id', ids.slice(i, i + 100));
      for (const r of data || []) (next[r.message_id] ||= []).push(r);
    }
    reactions = next;
  }

  function paint() {
    if (destroyed) return;
    const html = renderThread(messages, { me, reactions, hidden, fresh, nameFor, avatarFor, group: kind === 'room', ticks: kind === 'dm' });
    const earlier = hasMore ? `<div class="load-earlier"><button type="button" class="btn btn-plain btn-sm">${ICON.chevronUp} Show earlier messages</button></div>` : '';
    listEl.innerHTML = earlier + (html || `<div class="thread-empty"><div class="te-art">${ICON.heart}</div><p>No messages yet</p><span>Say hello. It's a good way to start.</span></div>`);
    hydrateThread(listEl);
    listEl.querySelectorAll('.msg-row').forEach(wireRow);
    const more = listEl.querySelector('.load-earlier button');
    if (more) more.addEventListener('click', loadEarlier);
  }

  async function loadEarlier(e) {
    e.currentTarget.disabled = true;
    const oldest = messages[0];
    const prevHeight = listEl.scrollHeight;
    await loadPage(oldest && oldest.created_at);
    await loadReactions();
    paint();
    listEl.scrollTop += listEl.scrollHeight - prevHeight;
  }

  function wireRow(rowEl) {
    const m = messages.find((x) => x.id === rowEl.dataset.msgId);
    if (!m) return;
    if (!m.deleted_at) attachSwipeReply(rowEl, () => composer.replyTo(m));
    attachMessageMenu(rowEl, () => openMenu(rowEl, m));
    const quote = rowEl.querySelector('[data-reply-jump]');
    if (quote) quote.addEventListener('click', (e) => { e.stopPropagation(); jumpToMessage(listEl, quote.dataset.replyJump); });
    rowEl.querySelectorAll('.reaction-chip').forEach((chip) => chip.addEventListener('click', (e) => { e.stopPropagation(); react(m.id, chip.dataset.emoji); }));
  }

  function openMenu(rowEl, m) {
    const mine = m.sender_id === me;
    if (m.deleted_at) {
      openMessageMenu(rowEl, { actions: [{ id: 'hide', label: 'Remove from my view', icon: ICON.trash }], onAction: () => hide(m) });
      return;
    }
    const isVoice = ((m.attachment && m.attachment.type) || '').startsWith('audio/');
    const actions = [{ id: 'reply', label: 'Reply', icon: ICON.reply }];
    if (m.body) actions.push({ id: 'copy', label: 'Copy text', icon: ICON.copy });
    if (mine && !isVoice) actions.push({ id: 'edit', label: m.body ? 'Edit' : 'Add a caption', icon: ICON.edit });
    actions.push({ id: 'delete', label: 'Delete', icon: ICON.trash, danger: true });
    openMessageMenu(rowEl, {
      actions,
      onReact: (emoji) => react(m.id, emoji),
      onAction: (a) => {
        if (a === 'reply') composer.replyTo(m);
        else if (a === 'copy') copy(m.body);
        else if (a === 'edit') composer.startEdit(m);
        else if (a === 'delete') remove(m);
      },
    });
  }

  function react(messageId, emoji) {
    rpc(K.react, { p_message: messageId, p_emoji: emoji }).catch((e) => toast(friendlyError(e)));
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { toast("Your browser didn't allow copying."); }
  }

  async function remove(m) {
    const mine = m.sender_id === me;
    const forAll = mine || (kind === 'room' && isOwner);
    const choice = await choose({
      title: 'Delete this message?',
      text: forAll
        ? (mine ? 'Delete it for everyone in the chat, or just remove it from your own view.' : "You own this group, so you can remove it for everyone.")
        : 'This removes it from your view. Others in the chat will still see it.',
      actions: forAll
        ? [{ id: 'all', label: 'Delete for everyone', danger: true }, { id: 'me', label: 'Delete for me' }]
        : [{ id: 'me', label: 'Delete for me', danger: true }],
    });
    if (choice === 'all') {
      try {
        const path = await rpc(K.del, { p_message: m.id });
        if (path && mine) supabase.storage.from('attachments').remove([path]).catch(() => {});
        if (composer.editingId === m.id) composer.cancel();
        upsert({ ...m, body: '', attachment: null, edited_at: null, deleted_at: new Date().toISOString() });
      } catch (e) { toast(friendlyError(e)); }
    } else if (choice === 'me') {
      hide(m);
    }
  }

  async function hide(m) {
    try {
      await rpc('hide_message', { p_message: m.id });
      hidden.add(m.id);
      if (composer.editingId === m.id) composer.cancel();
      paint();
    } catch (e) { toast(friendlyError(e)); }
  }

  function addRow(row, stick) {
    if (messages.some((m) => m.id === row.id)) { upsert(row); return; }
    const wasNear = nearBottom();
    messages.push(row);
    if (messages.length > 1 && messages[messages.length - 2].created_at > row.created_at) {
      messages.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    }
    fresh.add(row.id);
    setTimeout(() => fresh.delete(row.id), 700);
    paint();
    if (stick || wasNear) scrollToEnd(true);
    else { unseen++; showJump(); }
    if (row.sender_id !== me) K.markRead(id).catch(() => {});
  }

  function upsert(row) {
    const i = messages.findIndex((m) => m.id === row.id);
    if (i < 0) return;
    messages[i] = { ...messages[i], ...row };
    paint();
  }

  function nearBottom(px = 120) { return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < px; }

  function scrollToEnd(smooth) {
    requestAnimationFrame(() => {
      listEl.scrollTo({ top: listEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      unseen = 0; showJump();
    });
  }

  function onScroll() {
    closeMessageMenu();
    if (nearBottom()) unseen = 0;
    showJump();
  }

  function showJump() {
    const away = !nearBottom();
    jumpEl.classList.toggle('hidden', !away);
    const c = jumpEl.querySelector('.jn-count');
    c.textContent = unseen ? String(unseen > 99 ? '99+' : unseen) : '';
    c.classList.toggle('hidden', !unseen);
  }
}
