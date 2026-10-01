// Get the app. Android: download and install the ForYou app (app/foryou.apk, published by
// .github/workflows/android.yml with app/android.json describing it). iPhone: add ForYou to the Home
// Screen from Safari. Computers: the browser's own install button, or a QR code to open it on a phone.
// Inside the Android app this page shows the installed version and offers updates.
import { CONFIG } from '../config.js';
import { canPromptInstall, promptInstall } from '../app.js';
import { inAndroidApp, androidInfo, androidStartUpdate } from '../lib/android.js';
import { toast } from '../lib/ui.js';
import { escapeHtml, formatBytes } from '../lib/util.js';
import { ICON } from '../lib/icons.js';

async function latestAndroid() {
  try {
    const res = await fetch(new URL('app/android.json', CONFIG.siteUrl), { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.versionName ? j : null;
  } catch { return null; }
}

export async function mountInstall(root) {
  const site = CONFIG.siteUrl;
  const apk = new URL('app/foryou.apk', site).href;
  const ua = navigator.userAgent;
  const iphone = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /android/i.test(ua);
  const inApp = inAndroidApp();

  const androidCard = `
    <section class="get-card" id="get-android">
      <div class="get-head"><span class="get-ic android">${ICON.download}</span><div><b>Android</b><span id="ga-version">Checking the latest version…</span></div></div>
      ${inApp ? '<p class="muted small" id="ga-installed"></p>' : `
      <ol class="get-steps">
        <li>Tap <b>Download for Android</b>.</li>
        <li>Open the downloaded file. If Android asks, allow installs from your browser, then tap <b>Install</b>.</li>
        <li>Open ForYou and sign in. Allow notifications, the camera and the microphone when asked.</li>
      </ol>`}
      <a class="btn btn-gold btn-block hidden" id="ga-download" href="${apk}" download>${ICON.download} Download for Android</a>
      <p class="muted small get-note">Only install ForYou from this website.</p>
    </section>`;
  const iphoneCard = `
    <section class="get-card" id="get-iphone">
      <div class="get-head"><span class="get-ic">${ICON.share}</span><div><b>iPhone and iPad</b><span>Add ForYou to your Home Screen</span></div></div>
      <ol class="get-steps">
        <li>Open <b>${escapeHtml(site.replace(/^https:\/\//, '').replace(/\/$/, ''))}</b> in <b>Safari</b>.</li>
        <li>Tap the <b>Share</b> button at the bottom of the screen.</li>
        <li>Scroll down, tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        <li>Open ForYou from your Home Screen and allow notifications when asked.</li>
      </ol>
      <p class="muted small get-note">Notifications on iPhone need iOS 16.4 or later and only work once ForYou is on your Home Screen.</p>
    </section>`;
  const computerCard = `
    <section class="get-card" id="get-computer">
      <div class="get-head"><span class="get-ic">${ICON.link}</span><div><b>On a computer, or another phone</b><span>Scan to open ForYou on your phone</span></div></div>
      <div class="qr-box">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(site + '#/install')}" alt="QR code that opens ForYou">
        <button class="btn btn-ghost btn-sm" id="in-install">Install on this computer</button>
      </div>
    </section>`;

  const cards = iphone ? [iphoneCard, androidCard, computerCard] : android || inApp ? [androidCard, iphoneCard, computerCard] : [computerCard, androidCard, iphoneCard];
  root.innerHTML = `
    <div class="thread-head">
      <button class="back-btn" id="in-back" aria-label="Back">${ICON.back}</button>
      <div class="info"><span class="name">Get the app</span><span class="status">Android, iPhone and computer</span></div>
    </div>
    <div class="settings-body get-body">${cards.join('')}</div>`;

  root.querySelector('#in-back').onclick = () => { location.hash = '#/'; };
  root.querySelector('#in-install').addEventListener('click', async () => {
    if (!canPromptInstall()) { toast('Your browser has no install button here. Use its menu and choose "Install" or "Add to Home Screen".'); return; }
    const outcome = await promptInstall();
    if (outcome === 'accepted') toast('Installing ForYou…');
  });

  const latest = await latestAndroid();
  const versionEl = root.querySelector('#ga-version');
  const download = root.querySelector('#ga-download');
  if (!versionEl) return () => {};
  if (!latest) {
    versionEl.textContent = 'The Android app will be available here soon.';
  } else {
    versionEl.textContent = `Version ${latest.versionName} · ${formatBytes(latest.size)}`;
    if (inApp) {
      const mine = androidInfo();
      const newer = Number(latest.versionCode) > Number(mine.code || 0);
      root.querySelector('#ga-installed').textContent = newer
        ? `You have version ${mine.version || 'unknown'}. A newer version is ready.`
        : `You have the latest version (${mine.version || latest.versionName}).`;
      if (newer) {
        download.classList.remove('hidden');
        download.textContent = 'Update';
        download.addEventListener('click', (e) => { e.preventDefault(); androidStartUpdate(); });
      }
    } else {
      download.classList.remove('hidden');
    }
  }
  return () => {};
}
