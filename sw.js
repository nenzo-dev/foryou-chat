// Minimal service worker: mainly so the browser considers this site installable (a PWA needs one
// registered fetch handler to qualify), plus network-first caching of the app's own static files so it
// still opens (even if stale) on a flaky connection. Network-first, not cache-first, so a returning
// visitor is never permanently stuck on whatever was cached on their first visit -- bump CACHE's
// version string whenever the deployed files change meaningfully.
const CACHE = 'foryou-v1';
const CORE = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/config.js', 'manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache API/database calls -- only this app's own static files.
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(event.request))
  );
});
