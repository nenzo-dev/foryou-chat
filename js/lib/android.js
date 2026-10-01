// The ForYou Android app shows this same web app inside it and adds window.ForYouAndroid: phone
// notifications, a ringing screen for incoming calls, keeping the screen on during calls, and a private
// device code it uses to check for new messages while the app is closed (see android/ and
// supabase/migrations/08). Everywhere else these functions do nothing.
import { rpc } from './db.js';
import { CONFIG } from '../config.js';

const bridge = () => (typeof window !== 'undefined' && window.ForYouAndroid) || null;
export const inAndroidApp = () => !!bridge();

function call(name, ...args) {
  const b = bridge();
  if (!b || typeof b[name] !== 'function') return undefined;
  try { return b[name](...args); } catch (e) { console.error(e); return undefined; }
}

export function androidInfo() {
  try { return JSON.parse(call('info') || '{}'); } catch { return {}; }
}

// Once per sign-in on a phone: get a device code from the database and hand it to the app.
export async function registerAndroidDevice(user) {
  if (!bridge() || androidInfo().deviceUser === user.id) return;
  try {
    const token = await rpc('register_device', { p_platform: 'android' });
    if (token) call('registerDevice', JSON.stringify({ url: CONFIG.supabase.url, key: CONFIG.supabase.anonKey, token, user: user.id }));
  } catch (e) { console.error(e); }
}

// The app deletes its device code (and stops checking) when the person signs out.
export const androidSignedOut = () => call('signOut');

export const androidNotify = (title, body, tag, hash = '') => call('notify', String(title), String(body), String(tag), String(hash));
export const androidNotifications = () => androidInfo().notifications === true;
export const androidAskNotifications = () => call('requestNotifications');
export const androidIncomingCall = (roomKey, name) => call('incomingCall', JSON.stringify({ roomKey, name }));
export const androidEndIncomingCall = (roomKey) => call('endIncomingCall', String(roomKey || ''));
export const androidInCall = (on) => call('setInCall', !!on);
// App updates (android/.../Updater.java): what's available, start it, or look again now.
export const androidUpdate = () => androidInfo().update || null;
export const androidStartUpdate = () => call('startUpdate');
export const androidCheckUpdate = () => call('checkUpdate');
// 1.0.0 has no updater; the website offers it the new version to download instead.
export const androidCanSelfUpdate = () => { const b = bridge(); return !!b && typeof b.startUpdate === 'function'; };
// A call that reached the phone by push: { invite, action: 'accept' | 'show' }, or null.
export function androidTakePendingCall() {
  try { const raw = call('takePendingCall'); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
