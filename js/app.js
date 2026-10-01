// Entry point: boots the session, builds the two-pane shell once signed in, and routes the right-hand
// pane by the URL hash. Everything else (chat list, threads, calls) lives in js/views/*.js.
import { hasSupabase, supabase, signOut, currentUser } from './lib/db.js';
import { startLive, stopLive, onLive } from './lib/live.js';
import { startSeen } from './lib/seen.js';
import { startRingListener, stopRingListener } from './lib/ring.js';
import { requestNotifyPermission, notifyPermission, notifySupported, notify } from './lib/notify.js';
import { toast, showPane, openModal, closeModal } from './lib/ui.js';
import { registerAndroidDevice, androidSignedOut } from './lib/android.js';
import { LEGAL_UPDATED } from './lib/legal.js';
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
import { mountDates } from './views/dates.js';
import { mountDate } from './views/date.js';
import { renderSuspended } from './views/suspended.js';
import { mountLegal, openLegalSheet } from './views/legal.js';
import { handleRingEvent, checkAndroidPendingCall } from './views/callui.js';

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
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') { showAuth(); return; }
    // Signing in to another account in a second tab of the same browser replaces the session here too.
    // Carrying on as the old account would send messages as the new one (and show your own messages on
    // the wrong side), so start again as whoever is signed in now.
    const id = session && session.user && session.user.id;
    if (id && state.user && id !== state.user.id) location.reload();
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

// Names for notifications, looked up once each.
const names = new Map();
async function lookup(table, id, column) {
  const k = table + ':' + id;
  if (!names.has(k)) {
    names.set(k, supabase.from(table).select(column).eq('id', id).single()
      .then(({ data }) => (data && data[column]) || '').catch(() => ''));
  }
  return names.get(k);
}

const previewOf = (row) => {
  const t = (row.attachment && row.attachment.type) || '';
  const text = row.body || (t.startsWith('audio/') ? 'Voice message' : t.startsWith('image/') ? 'Photo' : 'Sent a file');
  return (row.sent_by_ai ? 'AI auto-reply: ' : '') + text;
};

// A new message tells you about itself unless you're already looking straight at that conversation:
// a small banner while ForYou is on screen, a phone/computer notification when it isn't.
function wireMessageNotifications() {
  const announce = (title, body, tag, hash) => {
    if (document.visibilityState === 'visible') toast(`${title}: ${body}`, 3200);
    else notify(title, body, tag, hash);
  };
  offMsgNotify = onLive('messages', async (payload) => {
    const row = payload.new;
    if (!row || payload.eventType !== 'INSERT' || row.sender_id === state.user.id) return;
    const open = currentOpenThread();
    if (open && open.type === 'dm' && open.id === row.conversation_id && document.visibilityState === 'visible') return;
    const name = (await lookup('profiles', row.sender_id, 'full_name')) || 'New message';
    announce(name, previewOf(row), 'foryou-dm-' + row.conversation_id, '#/chat/' + encodeURIComponent(row.conversation_id));
  });
  offRoomMsgNotify = onLive('room_messages', async (payload) => {
    const row = payload.new;
    if (!row || payload.eventType !== 'INSERT' || row.sender_id === state.user.id) return;
    const open = currentOpenThread();
    if (open && open.type === 'room' && open.id === row.room_id && document.visibilityState === 'visible') return;
    const [room, who] = await Promise.all([lookup('rooms', row.room_id, 'name'), lookup('profiles', row.sender_id, 'full_name')]);
    announce(room || 'New group message', `${who ? who.split(' ')[0] + ': ' : ''}${previewOf(row)}`, 'foryou-room-' + row.room_id, '#/room/' + row.room_id);
  });
}

function showAuth() {
  const wasSignedIn = !!state.user;
  state.user = null; state.profile = null;
  teardownSession();
  if (wasSignedIn) androidSignedOut();
  renderAuth(app, { onSignedIn: (user, profile) => enterApp(user, profile) });
  const legal = (location.hash || '').match(/^#\/legal\/(terms|privacy|disclaimer)$/);
  if (legal) openLegalSheet(legal[1]);
  else if (wasSignedIn) location.hash = '';
}

// Accounts made before the terms existed are asked once to read and agree to them.
function askToAcceptTerms() {
  const prefs = (state.profile && state.profile.prefs) || {};
  if (prefs.terms_accepted) return;
  const modal = openModal(`
    <div class="terms-prompt">
      <h3>Terms, privacy and AI</h3>
      <p class="muted small">ForYou now has Terms of use, a Privacy policy and a Disclaimer. They cover how your messages are handled, AI replies and Blind Dates. Please read them, then tap "I agree" to carry on.</p>
      <div class="terms-links">
        <a href="#" data-legal="terms">Terms of use</a><a href="#" data-legal="privacy">Privacy policy</a><a href="#" data-legal="disclaimer">Disclaimer</a>
      </div>
      <button class="btn btn-gold btn-block" id="tp-agree">I agree</button>
    </div>`);
  modal.querySelectorAll('[data-legal]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openLegalSheet(a.dataset.legal); }));
  modal.querySelector('#tp-agree').addEventListener('click', async () => {
    const next = { ...prefs, terms_accepted: LEGAL_UPDATED };
    const { error } = await supabase.from('profiles').update({ prefs: next }).eq('id', state.user.id);
    if (!error) state.profile.prefs = next;
    closeModal();
  });
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
  nudgeNotifications();
  registerAndroidDevice(user);
  route();
  askToAcceptTerms();
  checkAndroidPendingCall();
}

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

async function nudgeNotifications() {
  if (!notifySupported()) return;
  if (notifyPermission() !== 'default') return; // already granted, or already denied -- nothing useful to say
  if (isIOS() && !isStandalone()) {
    // iOS Safari refuses notification permission entirely for a page that isn't installed to the Home
    // Screen yet -- asking now would just fail silently, so point them at the real fix instead.
    toast('On iPhone, install ForYou to your Home Screen first (Settings → Get the app) to enable notifications.', 5000);
    return;
  }
  const result = await requestNotifyPermission().catch(() => 'denied');
  if (result !== 'granted') toast('You can turn on notifications any time in Settings.', 4000);
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
  if (el) el.innerHTML = `<div class="empty-state welcome"><img src="icons/logo.webp" alt=""><h2>Welcome to ForYou</h2><p>Pick a conversation on the left, or start a new one.</p></div>`;
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
  } else if (hash === '#/dates') {
    showPane('thread');
    disposeThread = await mountDates(threadEl());
  } else if ((m = hash.match(/^#\/date\/([0-9a-f-]{36})$/))) {
    showPane('thread');
    disposeThread = await mountDate(threadEl(), m[1]);
  } else if ((m = hash.match(/^#\/legal\/(terms|privacy|disclaimer)$/))) {
    showPane('thread');
    disposeThread = await mountLegal(threadEl(), m[1]);
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
