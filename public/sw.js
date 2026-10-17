// Gino's Split Lab service worker: the app opens offline after one online visit, and push
// notifications show while the app is closed.
// - Install: cache the app shell (index.html) together with every built file it references
//   (assets/*.js and *.css). If the shell or one of its assets cannot be fetched, the install
//   fails and the browser tries again on the next visit, so a worker never goes live with a shell
//   whose JS or CSS is missing (a blank page offline). An HTML page in place of an asset counts as
//   missing. The shell is fetched without cookies: it does not depend on the sign-in. The icons,
//   the manifest and the web fonts the stylesheet declares are cached too, but a failure there
//   does not fail the install.
// - Page loads (navigations): network first, fall back to the cached shell. The shell of a newer
//   build replaces the cached one only after the page has loaded all of its assets into the cache,
//   and then the previous build's assets are deleted. A connection that drops halfway through a
//   load keeps the previous, complete version for offline use.
// - Built assets (assets/*, hashed names): cache first. Only the file itself is stored, never an
//   error or an HTML page answered in its place (it would stay under that name for good).
// - Icons, manifest: stale while revalidate. Any other file on this origin is not touched.
// - Web fonts (fonts.gstatic.com): cache first.
// - API calls (/api/ on this origin, and any other origin) are never touched: they carry one
//   person's data and must never be answered from a cache.
// - Push: every push shows a notification (iOS requires one per push); a tap opens the app at the
//   page the push is about. A {type: 'version'} message is answered with this worker's version,
//   so the page only offers notifications once a worker with these handlers is in control.

const VERSION = 'evenly-v5'; // bump when the rules here change; activate deletes older caches
const FONT_CACHE = 'evenly-fonts-v2';
const SCOPE = self.registration ? new URL(self.registration.scope).pathname : '/';
const SHELL = SCOPE; // index.html served at the scope root
const ASSETS = SCOPE + 'assets/';
const API = SCOPE + 'api/';
const APP_NAME = '吉諾分帳所';
// Entries are keyed by URL alone. Nothing the server lists in Vary (Origin, Accept-Encoding)
// changes these files, so a page request matches an entry the install stored, whatever its headers.
const MATCH = { ignoreVary: true };

const isAsset = href => new URL(href).pathname.startsWith(ASSETS);
/** A built file as the server sent it: not an error, and not an HTML page standing in for a missing one. */
const isAssetFile = res => res.ok && !/text\/html/i.test(res.headers.get('Content-Type') || '');
/** Small files kept fresh in the background: the Home Screen icons and the manifest. */
const isStatic = path => path.startsWith(SCOPE + 'icons/') || path === SCOPE + 'manifest.webmanifest';

/** Same-origin URLs inside the scope that the shell's src and href attributes point to. */
function shellRefs(html) {
  const base = new URL(SHELL, self.location.href);
  const refs = new Set();
  for (const m of html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    let u;
    try {
      u = new URL(m[1], base);
    } catch (e) {
      continue;
    }
    u.hash = '';
    if (u.origin === self.location.origin && u.pathname.startsWith(SCOPE) && !u.pathname.startsWith(API)) refs.add(u.href);
  }
  return [...refs];
}

/** A page load cannot be answered with a redirected response, so keep a plain copy instead. */
function storable(res, html) {
  return res.redirected ? new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : res;
}

/** The web fonts that the cached stylesheets declare. The first visit loaded them before this worker existed. */
async function precacheFonts(cache, assets) {
  const urls = new Set();
  for (const href of assets.filter(h => new URL(h).pathname.endsWith('.css'))) {
    const css = await (await cache.match(href, MATCH)).text();
    for (const m of css.matchAll(/url\(\s*["']?(https:\/\/fonts\.gstatic\.com\/[^"')\s]+)/g)) urls.add(m[1]);
  }
  const fonts = await caches.open(FONT_CACHE);
  await Promise.all([...urls].map(async u => {
    if (await fonts.match(u)) return;
    const res = await fetch(u);
    if (res.ok) await fonts.put(u, res);
  }).map(p => p.catch(() => undefined)));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Without cookies: an answer to this fetch must not set the session cookies (the Worker renews
    // them only on page loads, src/worker/index.ts).
    const res = await fetch(SHELL, { cache: 'no-cache', credentials: 'omit' });
    if (!res.ok) throw new Error('Split Lab: app shell ' + res.status);
    const html = await res.clone().text();
    const refs = shellRefs(html);
    const assets = refs.filter(isAsset);
    const cache = await caches.open(VERSION);
    // Every asset must arrive as the file itself, or the install fails (all or nothing, like
    // cache.addAll). no-cache revalidates the HTTP cache's copy, so one stored wrongly is replaced.
    const files = await Promise.all(assets.map(async href => {
      const file = await fetch(href, { cache: 'no-cache' });
      if (!isAssetFile(file)) throw new Error('Split Lab: asset ' + file.status + ' ' + new URL(href).pathname);
      return [href, file];
    }));
    await Promise.all(files.map(([href, file]) => cache.put(href, file)));
    await cache.put(SHELL, storable(res, html));
    // Nice to have offline, but not worth failing the install over.
    await Promise.all([
      ...refs.filter(href => !isAsset(href)).map(href => cache.add(href)),
      precacheFonts(cache, assets),
    ].map(p => p.catch(() => undefined)));
  })());
});

self.addEventListener('activate', event => {
  // Deleting evenly-v3 also drops any API answer that version stored before this one took over.
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
    return;
  }
  if (event.data && event.data.type === 'version') {
    const reply = { type: 'version', version: VERSION, push: true };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
  }
});

// ---------- push ----------

function readPush(event) {
  try {
    const data = event.data ? event.data.json() : null;
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}

/** The app URL for a hash route: '/g/abc' -> https://split.ginochang.com/#/g/abc */
function appUrl(path) {
  const p = typeof path === 'string' && path.startsWith('/') ? path : '/';
  return new URL(SCOPE + '#' + p, self.location.origin).href;
}

self.addEventListener('push', event => {
  const data = readPush(event);
  const title = typeof data.title === 'string' && data.title ? data.title : APP_NAME;
  const path = typeof data.path === 'string' ? data.path : '/';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: SCOPE + 'icons/icon-192.png',
    data: { path, url: appUrl(path) },
    timestamp: Date.now(),
  };
  if (typeof data.tag === 'string' && data.tag) {
    options.tag = data.tag;
    options.renotify = true;
  }
  // Always show one: Safari stops delivering to a worker that receives pushes and shows nothing.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const path = typeof data.path === 'string' ? data.path : '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(c => new URL(c.url).origin === self.location.origin);
    if (open) {
      // The page moves itself (src/web/lib/pwa.ts), so it keeps its state instead of reloading.
      open.postMessage({ type: 'open', path });
      if ('focus' in open) await open.focus();
      return;
    }
    await self.clients.openWindow(appUrl(path));
  })());
});

// The push service dropped or replaced this browser's subscription (rare: Firefox says which one;
// Safari does not fire this). Subscribe again with the same key when the browser has no new one,
// but tell the API nothing: this worker cannot know which account turned notifications on here
// (the page keeps that in localStorage), and the session cookie may be someone else's by now. The
// page's start sync (src/web/lib/push.ts) links the subscription for the account that wanted it,
// the next time the app opens.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    if (event.newSubscription) return;
    const old = event.oldSubscription;
    const key = old && old.options ? old.options.applicationServerKey : null;
    if (key) await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  })().catch(() => undefined));
});

// ---------- fetch ----------

// The shell of a newer build, waiting until the page has loaded its assets into the cache.
let candidate = null;

/** Called with the HTML of each page load that came from the network. */
async function offerShell(res) {
  const html = await res.clone().text();
  const cache = await caches.open(VERSION);
  const current = await cache.match(SHELL, MATCH);
  if (current && (await current.text()) === html) return; // same build, already the offline shell
  candidate = { res: storable(res, html), assets: shellRefs(html).filter(isAsset) };
  await commitShell();
}

/** Once every asset of the candidate is cached, make it the offline shell and drop older assets. */
async function commitShell() {
  const next = candidate;
  if (!next) return;
  const cache = await caches.open(VERSION);
  for (const href of next.assets) {
    if (!(await cache.match(href, MATCH))) return; // still loading, or failed: keep the current shell
  }
  if (candidate !== next) return; // a later page load replaced it meanwhile
  candidate = null;
  await cache.put(SHELL, next.res);
  const keep = new Set(next.assets);
  for (const key of await cache.keys()) {
    if (isAsset(key.url) && !keep.has(key.url)) await cache.delete(key);
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The Google Fonts stylesheet (Huninn, M PLUS Rounded 1c): network first, the cached copy
  // offline, so the fonts still apply without a connection.
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(cache => fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cache.match(req).then(hit => hit || new Response('', { status: 504, statusText: 'Offline' })))),
    );
    return;
  }

  // Font files from Google Fonts: cache first, so text and numbers keep their typeface offline.
  // Font files never change at a given URL.
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
  // The API on this origin: straight to the network, never cached.
  if (url.pathname.startsWith(API)) return;

  if (req.mode === 'navigate') {
    // Only the app page itself (any query or hash) is a shell, not an icon or a 404 opened in a tab.
    const isShell = url.pathname === SHELL || url.pathname === SCOPE + 'index.html';
    const net = fetch(req).then(res => ({
      res,
      copy: isShell && res.ok && /text\/html/i.test(res.headers.get('Content-Type') || '') ? res.clone() : null,
    }));
    event.respondWith(net.then(
      n => n.res,
      () => caches.open(VERSION).then(c => c.match(SHELL, MATCH)).then(r => r || new Response('Offline', { status: 503 })),
    ));
    event.waitUntil(net.then(n => n.copy && offerShell(n.copy)).catch(() => undefined));
    return;
  }

  if (url.pathname.startsWith(ASSETS)) {
    const got = caches.match(req, MATCH).then(hit => hit ? { res: hit } : fetch(req).then(res => ({ res, copy: isAssetFile(res) ? res.clone() : null })));
    event.respondWith(got.then(g => g.res));
    // Storing an asset may complete a newer shell's set, which can then become the offline shell.
    event.waitUntil(got.then(g => g.copy && caches.open(VERSION).then(c => c.put(req.url, g.copy)).then(commitShell)).catch(() => undefined));
    return;
  }

  if (isStatic(url.pathname)) {
    event.respondWith(
      caches.match(req, MATCH).then(hit => {
        const net = fetch(req).then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put(req.url, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      }),
    );
  }
});
