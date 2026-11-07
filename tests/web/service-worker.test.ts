// public/sw.js run as the browser loads it, with fake caches, fetch and push manager: what the
// install fetches and keeps, what the asset handler stores, and that pushsubscriptionchange sends
// nothing to the API (review findings on the assets fallback, the install's cookies and push).
// Also how long a page load of the app waits for the network before the cached shell opens, and
// the Google Fonts stylesheet and Latin font files kept for offline use (review of 2026-11-07).

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import SOURCE from '../../public/sw.js?raw';

const ORIGIN = 'https://split.test';
const JS = ORIGIN + '/assets/index-NEW.js';
const CSS = ORIGIN + '/assets/index-NEW.css';

const SHELL_HTML = [
  '<!doctype html><html><head>',
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">',
  '<script type="module" crossorigin src="/assets/index-NEW.js"></script>',
  '<link rel="stylesheet" crossorigin href="/assets/index-NEW.css">',
  '</head><body><div id="root"></div></body></html>',
].join('\n');

interface Answer {
  status?: number;
  type: string;
  body: string;
}
/** The site by path, and other origins (Google Fonts) by full URL; anything else gets the Worker's JSON 404. */
type Site = Record<string, Answer>;

const SITE: Site = {
  '/': { type: 'text/html; charset=utf-8', body: SHELL_HTML },
  '/assets/index-NEW.js': { type: 'text/javascript', body: 'export {};' },
  '/assets/index-NEW.css': { type: 'text/css', body: 'body { margin: 0 }' },
  '/manifest.webmanifest': { type: 'application/manifest+json', body: '{}' },
  '/icons/icon.svg': { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
};

/** What the old not_found_handling = "single-page-application" sent for a file it did not have. */
const HTML_INSTEAD: Answer = { type: 'text/html; charset=utf-8', body: SHELL_HTML };

function answer(site: Site, url: string): Response {
  const u = new URL(url);
  const a = site[u.origin === ORIGIN ? u.pathname : u.href];
  if (!a) return new Response('{"error":{"code":"not_found","message":"Not found"}}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  return new Response(a.body, { status: a.status ?? 200, headers: { 'Content-Type': a.type } });
}

const urlOf = (req: RequestInfo | URL): string => (typeof req === 'string' ? new URL(req, ORIGIN).href : req instanceof URL ? req.href : req.url);

interface Stored {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
}

/** The parts of Cache that sw.js uses, keyed by URL (sw.js matches with ignoreVary). */
class FakeCache {
  readonly entries = new Map<string, Stored>();
  constructor(private readonly load: (url: string) => Promise<Response>) {}

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const e = this.entries.get(urlOf(req));
    return e ? new Response(e.body.slice(0), { status: e.status, headers: e.headers }) : undefined;
  }

  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    this.entries.set(urlOf(req), { status: res.status, headers: [...res.headers], body: await res.arrayBuffer() });
  }

  /** As in browsers: an answer that is not ok rejects them all, any other answer is kept. */
  async addAll(reqs: (RequestInfo | URL)[]): Promise<void> {
    const got = await Promise.all(reqs.map(async r => ({ r, res: await this.load(urlOf(r)) })));
    if (got.some(g => !g.res.ok)) throw new TypeError('addAll: a request failed');
    for (const g of got) await this.put(g.r, g.res);
  }

  add(req: RequestInfo | URL): Promise<void> {
    return this.addAll([req]);
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map(u => new Request(u));
  }

  async delete(req: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(urlOf(req));
  }
}

class FakeCaches {
  readonly byName = new Map<string, FakeCache>();
  constructor(private readonly load: (url: string) => Promise<Response>) {}

  async open(name: string): Promise<FakeCache> {
    let c = this.byName.get(name);
    if (!c) this.byName.set(name, (c = new FakeCache(this.load)));
    return c;
  }

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    for (const c of this.byName.values()) {
      const hit = await c.match(req);
      if (hit) return hit;
    }
    return undefined;
  }

  async keys(): Promise<string[]> {
    return [...this.byName.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.byName.delete(name);
  }

  /** Every URL kept in any cache. */
  stored(): string[] {
    return [...this.byName.values()].flatMap(c => [...c.entries.keys()]);
  }
}

type Listener = (event: any) => void;

interface Worker {
  on: Record<string, Listener>;
  caches: FakeCaches;
  /** Every fetch() the worker made, in order. */
  fetches: { url: string; init: RequestInit | undefined }[];
  subscribe: Mock;
}

/**
 * Load sw.js against `site`, as a browser does: the file as it ships, with these globals. `net`
 * may answer a fetch the worker makes differently (a stalled or failed connection, an error page).
 */
function boot(site: Site, net?: (url: string) => Promise<Response> | null): Worker {
  const on: Record<string, Listener> = {};
  const fetches: Worker['fetches'] = [];
  const load = async (url: string) => answer(site, url);
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    fetches.push({ url: urlOf(input), init });
    return net?.(urlOf(input)) ?? load(urlOf(input));
  };
  const caches = new FakeCaches(load);
  const subscribe = vi.fn(async () => ({ toJSON: () => ({ endpoint: 'https://push.test/new', keys: {} }) }));
  const self = {
    registration: { scope: ORIGIN + '/', pushManager: { subscribe }, showNotification: async () => undefined },
    location: new URL(ORIGIN + '/sw.js'),
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => null },
    skipWaiting: () => undefined,
    addEventListener: (type: string, fn: Listener) => {
      on[type] = fn;
    },
  };
  // Response, Request, Headers and URL are Node's, as the browser's would be.
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, fakeFetch);
  return { on, caches, fetches, subscribe };
}

/** An ExtendableEvent with `fields`; done() settles everything passed to waitUntil. */
function extendable<T extends object>(fields: T) {
  const waits: Promise<unknown>[] = [];
  const event = { ...fields, waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  return { event, done: () => Promise.all(waits) };
}

async function install(sw: Worker): Promise<void> {
  const e = extendable({});
  sw.on.install(e.event);
  await e.done();
}

/** A page's GET of `url`: what the worker answers, once the work it started is done. */
async function get(sw: Worker, url: string): Promise<Response> {
  let answered: Promise<Response> | undefined;
  const e = extendable({ request: new Request(url), respondWith: (p: Promise<Response>) => void (answered = p) });
  sw.on.fetch(e.event);
  if (!answered) throw new Error('the worker did not answer ' + url);
  const res = await answered;
  await e.done();
  return res;
}

describe('install', () => {
  it('fetches the shell without cookies, then every asset afresh, and keeps them', async () => {
    const sw = boot(SITE);
    await install(sw);
    // credentials: 'omit', so an answer to this fetch never sets the session cookies.
    expect(sw.fetches[0]).toEqual({ url: ORIGIN + '/', init: { cache: 'no-cache', credentials: 'omit' } });
    const assets = sw.fetches.filter(f => f.url.startsWith(ORIGIN + '/assets/'));
    expect(assets.map(f => f.url).sort()).toEqual([CSS, JS]);
    for (const f of assets) expect(f.init?.cache, f.url).toBe('no-cache');
    expect(sw.caches.stored()).toEqual(expect.arrayContaining([ORIGIN + '/', JS, CSS, ORIGIN + '/manifest.webmanifest']));
  });

  it('fails, keeping nothing, when an asset is answered with an HTML page', async () => {
    const sw = boot({ ...SITE, '/assets/index-NEW.js': HTML_INSTEAD });
    await expect(install(sw)).rejects.toThrow(/asset 200 \/assets\/index-NEW\.js/);
    expect(sw.caches.stored()).toEqual([]);
  });

  it('fails, keeping nothing, when an asset is missing', async () => {
    const site = Object.fromEntries(Object.entries(SITE).filter(([path]) => path !== '/assets/index-NEW.css'));
    const sw = boot(site);
    await expect(install(sw)).rejects.toThrow();
    expect(sw.caches.stored()).toEqual([]);
  });
});

describe('a built asset that is not in the cache yet', () => {
  it('is fetched and kept when the server sends the file', async () => {
    const sw = boot(SITE);
    const res = await get(sw, JS);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('export {};');
    expect(sw.caches.stored()).toEqual([JS]);
  });

  it('is passed on but never kept when the server answers with an HTML page or an error', async () => {
    const sw = boot({ ...SITE, '/assets/index-NEW.js': HTML_INSTEAD });
    const res = await get(sw, JS);
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
    const missing = await get(sw, ORIGIN + '/assets/index-GONE.css');
    expect(missing.status).toBe(404);
    expect(sw.caches.stored()).toEqual([]);
  });
});

describe('pushsubscriptionchange', () => {
  const key = new Uint8Array([4, 1, 2, 3]).buffer;

  it('subscribes again with the old key, and tells the API nothing', async () => {
    // The cookie may belong to another account by now; the page's start sync links the new
    // subscription for the account that turned notifications on.
    const sw = boot(SITE);
    const e = extendable({ oldSubscription: { options: { applicationServerKey: key } }, newSubscription: null });
    sw.on.pushsubscriptionchange(e.event);
    await e.done();
    expect(sw.subscribe).toHaveBeenCalledTimes(1);
    expect(sw.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: key });
    expect(sw.fetches).toEqual([]);
  });

  it('sends a subscription the browser renewed by itself nowhere either, and needs no key then', async () => {
    const sw = boot(SITE);
    const renewed = extendable({ oldSubscription: null, newSubscription: { toJSON: () => ({ endpoint: 'https://push.test/renewed', keys: {} }) } });
    sw.on.pushsubscriptionchange(renewed.event);
    const unknown = extendable({ oldSubscription: null, newSubscription: null });
    sw.on.pushsubscriptionchange(unknown.event);
    await Promise.all([renewed.done(), unknown.done()]);
    expect(sw.subscribe).not.toHaveBeenCalled();
    expect(sw.fetches).toEqual([]);
  });
});

// ---------- page loads and Google Fonts (review of 2026-11-07) ----------

/** A request the worker gets, answered without waiting for the work it starts (done() settles that). */
function request(sw: Worker, req: { url: string; method: string; mode: string } | Request): { answered: Promise<Response>; done: () => Promise<unknown> } {
  let answered: Promise<Response> | undefined;
  const e = extendable({ request: req, respondWith: (p: Promise<Response>) => void (answered = p) });
  sw.on.fetch(e.event);
  if (!answered) throw new Error('the worker did not answer ' + req.url);
  return { answered, done: e.done };
}

/** A page load (Node's Request cannot have mode 'navigate', so a plain object stands in). */
const navigation = (sw: Worker, url: string) => request(sw, { url, method: 'GET', mode: 'navigate' });

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Whether `p` has settled after the timers moved on. */
async function settledAfter(p: Promise<unknown>, ms: number): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  await vi.advanceTimersByTimeAsync(ms);
  return done;
}

const html = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('a page load of the app', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the network\'s answer when it comes in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The site serves a newer build's page by now.
    const fresh = SHELL_HTML.replace('<div id="root">', '<div id="root" data-build="next">');
    let next = false;
    const sw = boot(SITE, url => (next && new URL(url).pathname === '/' ? Promise.resolve(html(fresh)) : null));
    await install(sw);
    next = true;
    const res = await navigation(sw, ORIGIN + '/').answered;
    expect(await res.text()).toBe(fresh);
  });

  it('opens the cached shell when the network has not answered in 3 s; the late answer still comes through', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const late = deferred<Response>();
    let stall = false;
    const sw = boot(SITE, url => (stall && new URL(url).pathname === '/' ? late.promise : null));
    await install(sw);
    stall = true;
    const nav = navigation(sw, ORIGIN + '/?install=ABCD2345');
    expect(await settledAfter(nav.answered, 2_900)).toBe(false);
    expect(await settledAfter(nav.answered, 200)).toBe(true);
    expect(await (await nav.answered).text()).toBe(SHELL_HTML);
    late.resolve(html(SHELL_HTML));
    await nav.done();
  });

  it('opens the cached shell at once without a connection, and in place of an error page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let mode: 'up' | 'offline' | 'error' = 'up';
    const sw = boot(SITE, url => {
      if (new URL(url).pathname !== '/' || mode === 'up') return null;
      return mode === 'offline' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response('<h1>502 Bad gateway</h1>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    });
    await install(sw);
    mode = 'offline';
    const offline = navigation(sw, ORIGIN + '/');
    expect(await settledAfter(offline.answered, 0)).toBe(true);
    expect(await (await offline.answered).text()).toBe(SHELL_HTML);
    mode = 'error';
    const error = navigation(sw, ORIGIN + '/');
    const res = await error.answered;
    expect([res.status, await res.text()]).toEqual([200, SHELL_HTML]);
    // A friend invite page is the app's page too.
    const invite = await navigation(sw, ORIGIN + '/i/AbC123').answered;
    expect(invite.status).toBe(200);
  });

  it('after the 3 s fallback, the late answer of a newer build still becomes the shell: the worker fetches its files (review W2-correct-03)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const NEXT_HTML = SHELL_HTML.replace(/index-NEW/g, 'index-NEXT');
    const site: Site = {
      ...SITE,
      '/assets/index-NEXT.js': { type: 'text/javascript', body: 'export const next = 1;' },
      '/assets/index-NEXT.css': { type: 'text/css', body: 'body { margin: 1px }' },
    };
    const late = deferred<Response>();
    let mode: 'install' | 'slow' | 'offline' = 'install';
    const sw = boot(site, url => {
      if (new URL(url).pathname !== '/' || mode === 'install') return null;
      return mode === 'slow' ? late.promise : Promise.reject(new TypeError('Failed to fetch'));
    });
    await install(sw);
    // A start on roaming data: the page opens the cached build after 3 s, then the new page arrives.
    mode = 'slow';
    const nav = navigation(sw, ORIGIN + '/');
    expect(await settledAfter(nav.answered, 3_100)).toBe(true);
    expect(await (await nav.answered).text()).toBe(SHELL_HTML);
    late.resolve(html(NEXT_HTML));
    await nav.done();
    const kept = sw.caches.byName.get('evenly-v7')!;
    expect([...kept.entries.keys()].sort()).toEqual(
      [ORIGIN + '/', ORIGIN + '/assets/index-NEXT.css', ORIGIN + '/assets/index-NEXT.js', ORIGIN + '/icons/icon.svg', ORIGIN + '/manifest.webmanifest'].sort(),
    );
    // The next start, with no connection at all, opens the new build.
    mode = 'offline';
    expect(await (await navigation(sw, ORIGIN + '/').answered).text()).toBe(NEXT_HTML);
  });

  it('a late answer of the same build changes nothing, and a newer one whose files cannot be fetched leaves the cached build', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const NEXT_HTML = SHELL_HTML.replace(/index-NEW/g, 'index-GONE');
    let late = deferred<Response>();
    let slow = false;
    const sw = boot(SITE, url => (slow && new URL(url).pathname === '/' ? late.promise : null));
    await install(sw);
    slow = true;
    const same = navigation(sw, ORIGIN + '/');
    await settledAfter(same.answered, 3_100);
    late.resolve(html(SHELL_HTML));
    await same.done();
    late = deferred<Response>();
    const nav = navigation(sw, ORIGIN + '/');
    await settledAfter(nav.answered, 3_100);
    late.resolve(html(NEXT_HTML));
    await nav.done();
    // index-GONE.* are 404s: the cached build stays the shell, with its files.
    const shell = await sw.caches.byName.get('evenly-v7')!.match(ORIGIN + '/');
    expect(await shell!.text()).toBe(SHELL_HTML);
    expect(sw.caches.stored()).toEqual(expect.arrayContaining([JS, CSS]));
  });

  it('passes an error page on when there is no cached shell yet', async () => {
    const sw = boot(SITE, url => (new URL(url).pathname === '/' ? Promise.resolve(new Response('down', { status: 503, headers: { 'Content-Type': 'text/html' } })) : null));
    const res = await navigation(sw, ORIGIN + '/').answered;
    expect(res.status).toBe(503);
  });

  it('a page of its own (/privacy/, /support/) waits for the network as long as it takes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const late = deferred<Response>();
    const sw = boot(SITE, url => (new URL(url).pathname === '/privacy/' ? late.promise : null));
    await install(sw);
    const nav = navigation(sw, ORIGIN + '/privacy/');
    expect(await settledAfter(nav.answered, 10_000)).toBe(false);
    late.resolve(html('<h1>隱私權政策</h1>'));
    expect(await (await nav.answered).text()).toBe('<h1>隱私權政策</h1>');
  });
});

describe('Google Fonts', () => {
  const SHEET = 'https://fonts.googleapis.com/css2?family=Huninn&family=M+PLUS+Rounded+1c:wght@700;800&display=swap';
  const LATIN = 'https://fonts.gstatic.com/s/huninn/v1/latin.woff2';
  const LATIN_800 = 'https://fonts.gstatic.com/s/mplusrounded1c/v1/latin-800.woff2';
  const CJK = 'https://fonts.gstatic.com/s/huninn/v1/cjk-118.woff2';
  const CSS_TEXT = [
    '/* [118] */',
    `@font-face { font-family: 'Huninn'; font-style: normal; font-weight: 400; src: url(${CJK}) format('woff2'); unicode-range: U+4e00-4e3f; }`,
    '/* latin */',
    `@font-face { font-family: 'Huninn'; font-style: normal; font-weight: 400; src: url(${LATIN}) format('woff2'); unicode-range: U+0000-00FF; }`,
    '/* latin */',
    `@font-face { font-family: 'M PLUS Rounded 1c'; font-style: normal; font-weight: 800; src: url(${LATIN_800}) format('woff2'); unicode-range: U+0000-00FF; }`,
  ].join('\n');
  // The shell links to the stylesheet as index.html does (preconnect first).
  const FONT_SHELL = SHELL_HTML.replace(
    '<link rel="manifest"',
    `<link rel="preconnect" href="https://fonts.googleapis.com" />\n<link href="${SHEET}" rel="stylesheet" />\n<link rel="manifest"`,
  );
  const FONT_SITE: Site = {
    ...SITE,
    '/': { type: 'text/html; charset=utf-8', body: FONT_SHELL },
    [SHEET]: { type: 'text/css; charset=utf-8', body: CSS_TEXT },
    [LATIN]: { type: 'font/woff2', body: 'latin' },
    [LATIN_800]: { type: 'font/woff2', body: 'latin-800' },
    [CJK]: { type: 'font/woff2', body: 'cjk' },
  };
  const fontCache = (sw: Worker) => [...(sw.caches.byName.get('evenly-fonts-v2')?.entries.keys() ?? [])].sort();

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the install keeps the stylesheet the shell links to (fetched with CORS) and its Latin font files, not the CJK subsets', async () => {
    const sw = boot(FONT_SITE);
    await install(sw);
    expect(fontCache(sw)).toEqual([LATIN, SHEET, LATIN_800].sort());
    expect(sw.fetches.find(f => f.url === SHEET)?.init).toBeUndefined();
  });

  it('an install where Google cannot be reached still goes live, without fonts', async () => {
    const sw = boot(FONT_SITE, url => (new URL(url).origin === ORIGIN ? null : Promise.reject(new TypeError('Failed to fetch'))));
    await install(sw);
    expect(sw.caches.stored()).toEqual(expect.arrayContaining([ORIGIN + '/', JS, CSS]));
    expect(fontCache(sw)).toEqual([]);
  });

  it('an install where Google never answers goes live after 10 s, without fonts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sw = boot(FONT_SITE, url => (new URL(url).origin === ORIGIN ? null : new Promise<Response>(() => undefined)));
    const installing = install(sw);
    expect(await settledAfter(installing, 9_000)).toBe(false);
    expect(await settledAfter(installing, 1_500)).toBe(true);
    await installing;
    expect(sw.caches.stored()).toEqual(expect.arrayContaining([ORIGIN + '/', JS, CSS]));
  });

  it('the stylesheet comes from the cache at once while the network stalls, and a fresh copy is kept for next time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const late = deferred<Response>();
    let stall = false;
    const sw = boot(FONT_SITE, url => (stall && url === SHEET ? late.promise : null));
    await install(sw);
    stall = true;
    const got = request(sw, new Request(SHEET));
    expect(await settledAfter(got.answered, 0)).toBe(true);
    expect(await (await got.answered).text()).toBe(CSS_TEXT);
    late.resolve(new Response('/* newer */', { status: 200, headers: { 'Content-Type': 'text/css' } }));
    await got.done();
    const again = await request(sw, new Request(SHEET)).answered;
    expect(await again.text()).toBe('/* newer */');
  });

  it('without a copy, a stylesheet that cannot be kept (storage full) is still passed on (review W2-sw-04)', async () => {
    const sw = boot(FONT_SITE);
    const fonts = await sw.caches.open('evenly-fonts-v2');
    fonts.put = async () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    const got = request(sw, new Request(SHEET));
    const res = await got.answered;
    expect([res.status, await res.text()]).toEqual([200, CSS_TEXT]);
    await got.done();
  });

  it('without a copy, the network\'s answer is passed on and kept, so it applies offline later', async () => {
    let offline = false;
    const sw = boot(FONT_SITE, () => (offline ? Promise.reject(new TypeError('Failed to fetch')) : null));
    const first = request(sw, new Request(SHEET));
    expect(await (await first.answered).text()).toBe(CSS_TEXT);
    await first.done();
    offline = true;
    const later = await request(sw, new Request(SHEET)).answered;
    expect(await later.text()).toBe(CSS_TEXT);
  });
});
