// Get the app: a QR code that starts the install the instant it's scanned on a phone that isn't
// already running this page, an in-page install button for browsers that support it (mostly Android),
// and a plain "open in your browser" fallback (notably iPhone, which has no install prompt API --
// Safari's own Share > Add to Home Screen is what installs it there).
import { CONFIG } from '../config.js';
import { canPromptInstall, promptInstall } from '../app.js';
import { toast } from '../lib/ui.js';
import { ICON } from '../lib/icons.js';

export async function mountInstall(root) {
  const url = CONFIG.siteUrl || location.href.split('#')[0];
  root.innerHTML = `
    <div class="thread-head">
      <button class="back-btn" id="in-back" aria-label="Back">${ICON.back}</button>
      <div class="info"><div class="name">Get the app</div></div>
    </div>
    <div class="settings-body">
      <p class="muted small">Scan this with another phone's camera to start installing ForYou straight away. On this device, use the button below.</p>
      <div class="qr-box" style="margin-top:14px">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(url)}" alt="QR code to install ForYou">
        <div>
          <button class="btn btn-gold" id="in-install">Install on this device</button>
          <p class="muted small" style="margin-top:10px">iPhone: open this page in Safari, tap Share, then "Add to Home Screen".</p>
        </div>
      </div>
      <div class="settings-section" style="margin-top:20px">
        <h4>Or use it in a browser</h4>
        <p class="muted small">No install needed — <a href="${url}" target="_blank" rel="noopener">${url}</a> works the same way, right in the browser, on any device.</p>
      </div>
    </div>`;

  root.querySelector('#in-back').onclick = () => { location.hash = '#/'; };
  root.querySelector('#in-install').addEventListener('click', async () => {
    if (!canPromptInstall()) { toast("Your browser doesn't offer an install button here — use Share/menu > Add to Home Screen instead."); return; }
    const outcome = await promptInstall();
    if (outcome === 'accepted') toast('Installing ForYou…');
  });

  return () => {};
}
