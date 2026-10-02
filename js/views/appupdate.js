// Updates for the Android app. The app finds a newer version itself (Updater.java, from 1.1.0); 1.0.0
// can't, so for it the newest version is read from app/android.json on this website. A pop-up says
// the version on the phone will no longer be supported. Update closes it straight away and starts the
// update, and the chat list shows how it's going instead of the "Update available" banner. After
// Update is pressed, neither the pop-up nor the banner comes back for that version for an hour, even
// if the app is closed and opened again, so there's time to finish installing it. Settings still has
// the Update button for anyone who wants to try again sooner.
import { inAndroidApp, androidInfo, androidStartUpdate, androidCheckUpdate, androidCanSelfUpdate } from '../lib/android.js';
import { openModal, closeModal, toast } from '../lib/ui.js';
import { escapeHtml } from '../lib/util.js';
import { ICON } from '../lib/icons.js';
import { isBusy } from './callui.js';

let progress = null;   // { stage, pct } while an update is under way
let shownFor = 0;      // the version the pop-up was shown for since the app opened ("Not now" lasts till then)
let fromSite = null;   // the newest version on the website, for 1.0.0
let watching = false;
let retry = 0;
let stall = 0;
let pressedHere = null; // { code, at } when Update was pressed, in case the phone won't keep it

const PRESSED_KEY = 'fy_update_pressed';
const QUIET_MS = 60 * 60 * 1000;

const changed = () => window.dispatchEvent(new Event('foryouapp'));
const plainVersion = (v) => String(v || '').replace(/-debug$/, '');

/** The newer version that's ready for this phone, or null (also null outside the Android app). */
export function availableUpdate() {
  if (!inAndroidApp()) return null;
  const info = androidInfo();
  if (info.update) return info.update;
  if (fromSite && Number(fromSite.versionCode) > Number(info.code || 0)) return fromSite;
  return null;
}

/** Was Update pressed for this version in the last hour? Then the pop-up and banner stay away. */
export function updatePressed(u) {
  if (!u) return false;
  let p = pressedHere;
  try { p = JSON.parse(localStorage.getItem(PRESSED_KEY) || 'null') || p; } catch { /* use pressedHere */ }
  return !!p && Number(p.code) === Number(u.versionCode) && Date.now() - Number(p.at) < QUIET_MS;
}

function setPressed(u) {
  pressedHere = u ? { code: Number(u.versionCode), at: Date.now() } : null;
  try {
    if (pressedHere) localStorage.setItem(PRESSED_KEY, JSON.stringify(pressedHere));
    else localStorage.removeItem(PRESSED_KEY);
  } catch { /* pressedHere still covers this visit */ }
}

/** How the update is going ({ stage, pct }), or null when none is under way. */
export const updateProgress = () => progress;

export function progressText(p) {
  return {
    downloading: `Downloading the update… ${p.pct}%`,
    checking: 'Checking the download…',
    installing: 'Installing the update…',
    confirm: 'Tap Update on the screen that opened to finish',
  }[p.stage] || 'Starting the update…';
}

/** Update pressed (pop-up, banner, Settings or Get the app). */
export function startAppUpdate() {
  closeUpdatePopup();
  const u = availableUpdate();
  if (!u) return;
  setPressed(u);
  if (androidCanSelfUpdate()) {
    onUpdateProgress('starting', 0);
    androidStartUpdate();
  } else {
    // 1.0.0 can't install updates itself: the phone's browser downloads the new version instead.
    location.href = '/app/foryou.apk';
    toast('Downloading the new version. When it finishes, open it to install the update.', 7000);
    changed();
  }
}

/** "Check for updates" in Settings. The answer arrives as a 'foryouapp' event. */
export function checkForAppUpdate() {
  if (androidCanSelfUpdate()) androidCheckUpdate();
  else loadFromSite();
}

/** The app reports each step of an update (window.__foryouUpdate, see js/app.js). */
export function onUpdateProgress(stage, pct = 0) {
  clearTimeout(stall);
  if (['error', 'idle', 'none'].includes(stage)) {
    progress = null;
    if (stage === 'error') {
      setPressed(null); // the banner comes back so they can try again
      toast("Sorry, the update didn't download. Check your connection and try again.");
    }
  } else {
    progress = { stage, pct };
    // If nothing more is heard (for example "Allow from this source" was left off), show Update again.
    if (stage !== 'confirm') stall = setTimeout(() => { progress = null; setPressed(null); changed(); }, 90_000);
  }
  changed();
}

/** Once signed in: show the pop-up whenever a newer version is ready. */
export function watchAppUpdate() {
  if (!inAndroidApp() || watching) return;
  watching = true;
  window.addEventListener('foryouapp', maybeShowPopup);
  if (!androidCanSelfUpdate()) loadFromSite();
  maybeShowPopup();
}

async function loadFromSite() {
  try {
    const res = await fetch(`/app/android.json?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) fromSite = await res.json();
  } catch { /* offline: next time */ }
  changed();
}

function maybeShowPopup() {
  const u = availableUpdate();
  if (!u || progress || updatePressed(u) || shownFor === Number(u.versionCode)) return;
  // Never on top of another pop-up or a call: try again a little later.
  if (document.querySelector('#modal-root .modal') || isBusy()) {
    clearTimeout(retry);
    retry = setTimeout(maybeShowPopup, 10_000);
    return;
  }
  shownFor = Number(u.versionCode);
  const mine = plainVersion(androidInfo().version);
  const modal = openModal(`
    <div class="update-pop">
      <span class="up-ic">${ICON.download}</span>
      <h3>Update ForYou</h3>
      <p>ForYou ${escapeHtml(u.versionName)} is ready. ${mine ? `Version ${escapeHtml(mine)}` : 'The version'} on this phone will no longer be supported, so please update to keep using ForYou.</p>
      <button class="btn btn-gold btn-block" id="up-go" type="button">${ICON.download} Update now</button>
      <button class="btn btn-plain btn-block" id="up-later" type="button">Not now</button>
    </div>`, { className: 'modal-update' });
  modal.querySelector('#up-go').addEventListener('click', startAppUpdate);
  modal.querySelector('#up-later').addEventListener('click', closeModal);
}

function closeUpdatePopup() {
  if (document.querySelector('#modal-root .modal-update')) closeModal();
}
