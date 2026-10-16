// Evenly service worker: the app works offline after the first visit.
// - Page loads (navigations): network first, fall back to the cached app shell.
// - Built assets (/assets/*, hashed names): cache first.
// - Icons, manifest: stale while revalidate.
// - API calls (other origins) are never touched.

const VERSION = 'evenly-v1';
const SCOPE = self.registration ? new URL(self.registration.scope).pathname : '/';
const SHELL = SCOPE; // index.html served at the scope root

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION).then(cache => cache.addAll([SHELL, SCOPE + 'manifest.webmanifest']).catch(() => undefined)),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

const FONT_CACHE = 'evenly-fonts-v1';

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Web fonts (Chivo Mono, Hanken Grotesk) from Google Fonts: cache first, so numbers keep their
  // typeface offline. Font files never change at a given URL.
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(cache => cache.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }).catch(() => new Response('', { status: 504, statusText: 'Offline' })))),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put(SHELL, copy));
          }
          return res;
        })
        .catch(() => caches.match(SHELL).then(r => r || caches.match(req)).then(r => r || new Response('Offline', { status: 503 }))),
    );
    return;
  }

  if (url.pathname.startsWith(SCOPE + 'assets/')) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      })),
    );
    return;
  }

  if (url.pathname.startsWith(SCOPE)) {
    event.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put(req, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      }),
    );
  }
});
