// Phone/computer notifications for a new message or an incoming call while ForYou isn't in front.
// Inside the Android app they go through the app (Android WebViews have no Notification API);
// everywhere else through the browser's own Notification API. Every function is safe to call when
// notifications aren't supported or allowed: it just does nothing. Adapted from AlPhi Cuts' notify.js.
import { inAndroidApp, androidNotify, androidNotifications, androidAskNotifications } from './android.js';

export function notifySupported() {
  return inAndroidApp() || typeof Notification !== 'undefined';
}

export function notifyPermission() {
  if (inAndroidApp()) return androidNotifications() ? 'granted' : 'default';
  return typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
}

export async function requestNotifyPermission() {
  if (inAndroidApp()) { androidAskNotifications(); return notifyPermission(); }
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

// hash: where tapping the notification should take you, e.g. "#/chat/<id>".
export function notify(title, body, tag = 'foryou-message', hash = '') {
  if (inAndroidApp()) { androidNotify(title, body, tag, hash); return; }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: 'icons/icon-192.png', tag });
    n.onclick = () => { window.focus(); if (hash) location.hash = hash; n.close(); };
  } catch { /* some browsers throw if the page isn't in a state that allows this; nothing to do */ }
}
