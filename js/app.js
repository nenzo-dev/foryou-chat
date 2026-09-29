// Entry point: boots the session, builds the two-pane shell once signed in, and routes the right-hand
// pane by the URL hash. Everything else (chat list, threads, calls) lives in js/views/*.js.
import { hasSupabase, supabase, signOut, currentUser } from './lib/db.js';
import { startLive, stopLive, onLive } from './lib/live.js';
import { startSeen } from './lib/seen.js';
import { startRingListener, stopRingListener } from './lib/ring.js';
import { requestNotifyPermission, notify } from './lib/notify.js';
import { showPane } from './lib/ui.js';
import { ensureProfile } from './lib/profile.js';
import { state } from './state.js';
import { renderAuth } from './views/auth.js';
import { mountChatList } from './views/chats.js';
import { mountChat } from './views/chat.js';
import { mountRoom } from './views/room.js';
import { mountJoinRoom } from './views/joinroom.js';
import { mountSettings } from './views/settings.js';
import { mountInstall } from './views/install.js';
import { mountAdmin } from './views/admin.js';
import { renderSuspended } from './views/suspended.js';
import { handleRingEvent } from './views/callui.js';

const app = document.getElementById('app');
let disposeThread = null;
let stopSeen = null;
let offMsgNotify = null;
let offRoomMsgNotify = null;

// Captured as early as possible (module load, before any view exists) so the browser's own "Add to
// Home Screen" prompt is available no matter which page someone is on when they tap "Get the app".
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; });
export function canPromptInstall() { return !!deferredInstallPrompt; }
export async function promptInstall() {
  if (!deferredInstallPrompt) return 'unavailable';
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  return outcome;
}

async function boot() {
  if (!hasSupabase) {
    app.innerHTML = `<div class="auth-screen"><div class="auth-card center">
      <img src="icons/logo.webp" class="auth-logo" alt="">
      <h1 class="auth-title">ForYou</h1>
      <p class="auth-sub">This app is not connected to a database yet. Set js/config.js and reload.</p>
    </div></div>`;
    return;
  }
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') showAuth();
  });
  const user = await currentUser();
  if (!user) { showAuth(); return; }
  await enterApp(user);
}

function teardownSession() {
  stopLive();
  stopRingListener();
  if (stopSeen) { stopSeen(); stopSeen = null; }
  if (offMsgNotify) { offMsgNotify(); offMsgNotify = null; }
  if (offRoomMsgNotify) { offRoomMsgNotify(); offRoomMsgNotify = null; }
  if (disposeThread) { try { disposeThread(); } catch { /* ignore */ } disposeThread = null; }
}

function currentOpenThread() {
  const h = location.hash || '';
  let m;
  if ((m = h.match(/^#\/chat\/([^/]+)$/))) return { type: 'dm', id: decodeURIComponent(m[1]) };
  if ((m = h.match(/^#\/room\/([^/]+)$/))) return { type: 'room', id: decodeURIComponent(m[1]) };
  return null;
}

// A message notification only fires when you're not already looking straight at that conversation.
function wireMessageNotifications() {
  offMsgNotify = onLive('messages', (payload) => {
    const row = payload.new;
    if (!row || payload.eventType !== 'INSERT' || row.sender_id === state.user.id) return;
    const open = currentOpenThread();
    if (open && open.type === 'dm' && open.id === row.conversation_id && document.visibilityState === 'visible') return;
    notify('New message', row.body || 'Sent an attachment', 'foryou-dm-' + row.conversation_id);
  });
  offRoomMsgNotify = onLive('room_messages', (payload) => {
    const row = payload.new;
    if (!row || payload.eventType !== 'INSERT' || row.sender_id === state.user.id) return;
    const open = currentOpenThread();
    if (open && open.type === 'room' && open.id === row.room_id && document.visibilityState === 'visible') return;
    notify('New group message', row.body || 'Sent an attachment', 'foryou-room-' + row.room_id);
  });
}

function showAuth() {
  const wasSignedIn = !!state.user;
  state.user = null; state.profile = null;
  teardownSession();
  renderAuth(app, { onSignedIn: (user, profile) => enterApp(user, profile) });
  if (wasSignedIn) location.hash = '';
}

export async function refreshMyProfile() {
  if (!state.user) return;
  const { data } = await supabase.from('profiles').select('*').eq('id', state.user.id).single();
  if (data) state.profile = data;
}

async function enterApp(user, knownProfile) {
  state.user = user;
  // ensureProfile() is idempotent -- it returns the existing row when there is one, and only creates a
  // new one (from the name/username stashed at sign-up) the first time this account is ever seen here.
  const profile = knownProfile || (await ensureProfile(user)).profile;
  if (!profile) {
    await signOut();
    showAuth();
    return;
  }
  state.profile = profile;
  if (profile.suspended) { renderSuspended(app); return; }
  buildShell();
  startLive();
  wireMessageNotifications();
  stopSeen = startSeen();
  startRingListener(user.id, handleRingEvent);
  requestNotifyPermission().catch(() => {});
  route();
}

function buildShell() {
  app.innerHTML = `<div class="shell">
    <aside class="pane pane-list" id="pane-list"></aside>
    <main class="pane pane-thread" id="pane-thread"></main>
  </div>`;
  mountChatList(document.getElementById('pane-list'));
  showPane('list');
  emptyThread();
}

function threadEl() { return document.getElementById('pane-thread'); }

function emptyThread() {
  const el = threadEl();
  if (el) el.innerHTML = `<div class="empty-state"><img src="icons/logo.webp" alt=""><p>Pick a conversation, or start a new one.</p></div>`;
}

async function route() {
  if (!state.user) return;
  if (disposeThread) { try { disposeThread(); } catch { /* ignore */ } disposeThread = null; }
  const hash = location.hash || '#/';
  let m;
  if ((m = hash.match(/^#\/chat\/([^/]+)$/))) {
    showPane('thread');
    disposeThread = await mountChat(threadEl(), decodeURIComponent(m[1]));
  } else if ((m = hash.match(/^#\/room\/([^/]+)$/))) {
    showPane('thread');
    disposeThread = await mountRoom(threadEl(), decodeURIComponent(m[1]));
  } else if ((m = hash.match(/^#\/rooms\/join\/([^/]+)$/))) {
    showPane('thread');
    disposeThread = await mountJoinRoom(threadEl(), decodeURIComponent(m[1]));
  } else if (hash === '#/settings') {
    showPane('thread');
    disposeThread = await mountSettings(threadEl());
  } else if (hash === '#/install') {
    showPane('thread');
    disposeThread = await mountInstall(threadEl());
  } else if (hash === '#/admin') {
    showPane('thread');
    disposeThread = await mountAdmin(threadEl());
  } else {
    showPane('list');
    emptyThread();
  }
}

window.addEventListener('hashchange', route);
boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
