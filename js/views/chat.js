// A one-to-one conversation: the header (who, online status, video call) on top of the shared thread
// (js/lib/thread.js), which handles history, sending, replies, reactions, editing and deleting. If the
// other person has "Reply for me" on and this message reaches them while they're away, their reply
// appears here tagged "Auto-reply" (message.sent_by_ai) -- see supabase/functions/ai-reply.
import { supabase, rpc, avatarUrl } from '../lib/db.js';
import { fetchSeen, statusOf } from '../lib/seen.js';
import { escapeHtml, initials } from '../lib/util.js';
import { mountThread } from '../lib/thread.js';
import { startDirectCall } from './callui.js';
import { openModal, closeModal } from '../lib/ui.js';
import { ICON } from '../lib/icons.js';
import { state } from '../state.js';

export async function mountChat(root, conversationId) {
  const [aId, bId] = conversationId.split('__');
  const me = state.user.id;
  const otherId = aId === me ? bId : aId;
  if (!otherId || (aId !== me && bId !== me)) {
    root.innerHTML = `<div class="empty-state"><p>That conversation could not be opened.</p></div>`;
    return () => {};
  }

  root.innerHTML = `<div class="empty-state"><div class="thread-loading"><span></span><span></span><span></span></div></div>`;
  const { data: peer, error } = await supabase.from('profiles').select('*').eq('id', otherId).single();
  if (error || !peer) {
    root.innerHTML = `<div class="empty-state"><p>That person could not be found.</p></div>`;
    return () => {};
  }
  const peerName = peer.full_name || peer.username || 'Someone';

  root.innerHTML = `
    <div class="thread-head">
      <button class="back-btn" id="ch-back" aria-label="Back">${ICON.back}</button>
      <div class="head-avatar" id="ch-avatar-wrap"><div class="avatar sm" id="ch-avatar"></div><span class="presence-dot hidden" id="ch-dot"></span></div>
      <button class="info" id="ch-info" type="button">
        <span class="name">${escapeHtml(peerName)}</span>
        <span class="status" id="ch-status">&nbsp;</span>
      </button>
      <button class="head-btn" id="ch-call" title="Video call" aria-label="Video call">${ICON.video}</button>
    </div>
    <div class="thread-host" id="ch-thread"></div>`;

  paintAvatar(root.querySelector('#ch-avatar'), peer);
  root.querySelector('#ch-back').onclick = () => { location.hash = '#/'; };
  root.querySelector('#ch-call').onclick = () => startDirectCall(peer);
  root.querySelector('#ch-info').onclick = () => showContactInfo(peer);

  const statusTimer = tickStatus();

  const thread = await mountThread(root.querySelector('#ch-thread'), {
    kind: 'dm', id: conversationId, folder: conversationId, me,
    nameFor: (uid) => (uid === me ? 'You' : peerName),
    send: ({ body, attachment, replyTo }) => rpc('send_message', { p_conversation: conversationId, p_body: body, p_attachment: attachment || null, p_reply_to: replyTo || null }),
  });

  return () => { thread.destroy(); clearInterval(statusTimer); };

  function tickStatus() {
    const set = async () => {
      try {
        const rows = await fetchSeen();
        const info = rows[otherId];
        const st = root.querySelector('#ch-status');
        const dot = root.querySelector('#ch-dot');
        if (!st) return;
        const s = info ? statusOf(info.lastSeen) : null;
        st.textContent = info && info.inCall && s.online ? 'On a call' : (s ? s.text : '');
        st.classList.toggle('online', !!(s && s.online));
        if (dot) dot.classList.toggle('hidden', !(s && s.online));
      } catch { /* keep the last known status */ }
    };
    set();
    return setInterval(set, 20000);
  }
}

function paintAvatar(el, person) {
  if (person.avatar_path) el.innerHTML = `<img src="${escapeHtml(avatarUrl(person.avatar_path))}" alt="">`;
  else { el.style.background = person.avatar_color || '#3b82c4'; el.textContent = initials(person.full_name || person.username || '?'); }
}

function showContactInfo(peer) {
  const modal = openModal(`
    <div class="profile-card">
      <div class="avatar xl" id="ci-avatar"></div>
      <h3>${escapeHtml(peer.full_name || peer.username)}</h3>
      ${peer.username ? `<p class="muted small">@${escapeHtml(peer.username)}</p>` : ''}
      <p class="profile-bio ${peer.bio ? '' : 'muted'}">${peer.bio ? escapeHtml(peer.bio) : 'No bio yet.'}</p>
      <button class="btn btn-gold btn-block" id="ci-call">${ICON.video} Video call</button>
    </div>`);
  paintAvatar(modal.querySelector('#ci-avatar'), peer);
  modal.querySelector('#ci-call').addEventListener('click', () => { closeModal(); startDirectCall(peer); });
}
