// public/sw.js run as the browser loads it, with fake caches, fetch and push manager: what the
// install fetches and keeps, what the asset handler stores, and that pushsubscriptionchange sends
// nothing to the API (review findings on the assets fallback, the install's cookies and push).

import { describe, expect, it, vi, type Mock } from 'vitest';
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
/** The site by path; any other path gets the Worker's JSON 404. */
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
  const a = site[new URL(url).pathname];
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

/** Load sw.js against `site`, as a browser does: the file as it ships, with these globals. */
function boot(site: Site): Worker {
  const on: Record<string, Listener> = {};
  const fetches: Worker['fetches'] = [];
  const load = async (url: string) => answer(site, url);
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    fetches.push({ url: urlOf(input), init });
    return load(urlOf(input));
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
