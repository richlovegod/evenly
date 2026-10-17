// Web Push in the app (src/web/lib/push.ts and src/web/lib/pwa.ts): decoding the server's key,
// the state the 通知 cards show, the worker version ping and its timeout, the notification-tap
// message, and the order of calls when notifications are turned on (permission first, inside the
// tap), turned off (also while the start sync is on its way), synced at start, and dropped when
// the account leaves the device. The browser is a set of fakes on globalThis; the API module is
// mocked, so nothing here needs a network or a DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { api: vi.fn(), FakeApiError };
});

vi.mock('../../src/web/lib/api', () => ({ api: h.api, ApiError: h.FakeApiError }));

type PushModule = typeof import('../../src/web/lib/push');
type PwaModule = typeof import('../../src/web/lib/pwa');

/** The signed-in account in these tests, and its session key (main.tsx passes both to setPushSession). */
const ACCOUNT = 'acct-gino';
const SESSION = 'cookie:acct-gino:1';
/** Someone else who signs in on the same device. */
const OTHER = 'acct-abbie';

/**
 * Fresh copies of both modules, so the key cache and the in-flight sync never leak between tests.
 * Signed in as ACCOUNT, unless `signedIn` is false (a start with nobody known yet).
 */
async function load(signedIn = true): Promise<{ push: PushModule; pwa: PwaModule }> {
  vi.resetModules();
  const push = await import('../../src/web/lib/push');
  if (signedIn) push.setPushSession(SESSION, ACCOUNT);
  return { push, pwa: await import('../../src/web/lib/pwa') };
}

// The VAPID public keys in wrangler.toml (production, then staging).
const PROD_KEY = 'BBQud4_qE1XmHw0mM4JoX3MnGtlAESxSVQh_wOFK1vPoTzSAxwKVh4U5fCVN6oHOChRNSkAbWU3280hbdhcKNBQ';
const STAGING_KEY = 'BOz_wPKbLjJoUqyHOOd_hIzlSrEEsqM7LLI4HgiOjW_yHg9kxiB4aHKPDQi6VJGbnc6nsETv29CqOkVYSyYBsJQ';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const IPHONE_LINE = IPHONE_SAFARI + ' Line/15.2.0';
const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

describe('serverKeyBytes', () => {
  it.each([PROD_KEY, STAGING_KEY])('decodes %s to the 65-byte P-256 point the browser takes', async key => {
    const { push } = await load();
    const bytes = push.serverKeyBytes(key);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
    expect(Array.from(bytes)).toEqual(Array.from(Buffer.from(key, 'base64url')));
  });

  it('accepts padding and surrounding space', async () => {
    const { push } = await load();
    expect(Array.from(push.serverKeyBytes(' ' + PROD_KEY + '=\n'))).toEqual(Array.from(push.serverKeyBytes(PROD_KEY)));
  });

  it('refuses what cannot be a key', async () => {
    const { push } = await load();
    // Standard base64, a 32-byte value, a point that is not uncompressed, empty.
    expect(() => push.serverKeyBytes(PROD_KEY.replace(/_/g, '/'))).toThrow();
    expect(() => push.serverKeyBytes(Buffer.alloc(32, 7).toString('base64url'))).toThrow();
    expect(() => push.serverKeyBytes(Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 1)]).toString('base64url'))).toThrow();
    expect(() => push.serverKeyBytes('')).toThrow();
  });
});

describe('decidePushState', () => {
  const base = { iosBrowser: false, supported: true, workerReady: true, permission: 'default' as NotificationPermission, subscribed: false };

  it.each([
    [{ iosBrowser: true, supported: false }, 'needs-install'],
    // iPhone Safari outside the Home Screen app: install first, whatever else is true.
    [{ iosBrowser: true, supported: true, permission: 'granted', subscribed: true }, 'needs-install'],
    [{ supported: false }, 'unsupported'],
    [{ supported: false, permission: 'denied' }, 'unsupported'],
    [{ workerReady: false }, 'waiting-worker'],
    [{ workerReady: false, permission: 'denied' }, 'waiting-worker'],
    [{ permission: 'denied' }, 'denied'],
    [{ permission: 'denied', subscribed: true }, 'denied'],
    [{ permission: 'default' }, 'off'],
    [{ permission: 'default', subscribed: true }, 'off'],
    // Allowed, but turned off on this device (or the browser lost the subscription).
    [{ permission: 'granted' }, 'off'],
    [{ permission: 'granted', subscribed: true }, 'on'],
  ] as const)('%j -> %s', async (facts, want) => {
    const { push } = await load();
    expect(push.decidePushState({ ...base, ...facts })).toBe(want);
  });
});

describe('small helpers', () => {
  it('sameKey compares the bytes a subscription was made with, and trusts an unknown one', async () => {
    const { push } = await load();
    const key = push.serverKeyBytes(PROD_KEY);
    expect(push.sameKey(key.slice().buffer, key)).toBe(true);
    expect(push.sameKey(push.serverKeyBytes(STAGING_KEY).buffer, key)).toBe(false);
    expect(push.sameKey(new Uint8Array(12).buffer, key)).toBe(false);
    expect(push.sameKey(null, key)).toBe(true);
    expect(push.sameKey(undefined, key)).toBe(true);
  });

  it('subscriptionBody keeps what the browser wrote and adds the time zone', async () => {
    const { push } = await load();
    const json = { endpoint: 'https://web.push.apple.com/abc', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } };
    expect(push.subscriptionBody(json, 'Asia/Taipei')).toEqual({ ...json, tz: 'Asia/Taipei' });
    expect(push.subscriptionBody(json, null)).toEqual(json);
  });

  it('deviceTimeZone answers an IANA name', async () => {
    const { push } = await load();
    expect(push.deviceTimeZone()).toMatch(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/);
  });

  it('openPath only accepts app paths from an open message', async () => {
    const { pwa } = await load();
    expect(pwa.openPath({ type: 'open', path: '/g/abc/e/def' })).toBe('/g/abc/e/def');
    expect(pwa.openPath({ type: 'open', path: '/' })).toBe('/');
    expect(pwa.openPath({ type: 'open', path: '//evil.example/x' })).toBeNull();
    expect(pwa.openPath({ type: 'open', path: 'https://evil.example/' })).toBeNull();
    expect(pwa.openPath({ type: 'open' })).toBeNull();
    expect(pwa.openPath({ type: 'version', path: '/g/abc' })).toBeNull();
    expect(pwa.openPath('skipWaiting')).toBeNull();
    expect(pwa.openPath(null)).toBeNull();
  });

  it('readVersion reads the worker answer', async () => {
    const { pwa } = await load();
    expect(pwa.readVersion({ type: 'version', version: 'evenly-v4', push: true })).toEqual({ version: 'evenly-v4', push: true });
    expect(pwa.readVersion({ type: 'version', version: 'evenly-v5' })).toEqual({ version: 'evenly-v5', push: false });
    expect(pwa.readVersion({ type: 'version' })).toBeNull();
    expect(pwa.readVersion('evenly-v4')).toBeNull();
  });
});

// ---------- a fake browser ----------

interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null; userVisibleOnly: boolean };
  toJSON: () => PushSubscriptionJSON;
  unsubscribe: ReturnType<typeof vi.fn>;
}

interface Browser {
  ua?: string;
  standalone?: boolean;
  /** window.PushManager and friends exist. */
  push?: boolean;
  permission?: NotificationPermission;
  /** What the permission prompt answers. */
  answer?: NotificationPermission;
  /** The worker in control: answers the ping with push: true ('v4'), ignores it ('v3'), or none. */
  worker?: 'v4' | 'v3' | 'none';
  /** A subscription the browser already holds, made with this key. */
  subscribedWith?: string | null;
  /** localStorage['evenly.push.wanted']. */
  wanted?: boolean;
}

/** A key's bytes in an ArrayBuffer of their own (a small Buffer's .buffer is Node's shared pool). */
function keyBuffer(key: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(key, 'base64url')).buffer;
}

function fakeSub(key: ArrayBuffer | null, log: string[], gone: (sub: FakeSub) => void): FakeSub {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/' + Math.random().toString(36).slice(2);
  const sub: FakeSub = {
    endpoint,
    options: { applicationServerKey: key, userVisibleOnly: true },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'BPub', auth: 'secret' } }),
    unsubscribe: vi.fn(async () => {
      log.push('unsubscribe');
      gone(sub);
      return true;
    }),
  };
  return sub;
}

function install(b: Browser = {}) {
  const log: string[] = [];
  const store = new Map<string, string>();
  if (b.wanted) store.set('evenly.push.wanted', ACCOUNT);
  const state = {
    permission: b.permission ?? 'default',
    sub: null as FakeSub | null,
  };
  const gone = (sub: FakeSub) => {
    if (state.sub === sub) state.sub = null;
  };
  if (b.subscribedWith !== undefined) {
    state.sub = fakeSub(b.subscribedWith === null ? null : keyBuffer(b.subscribedWith), log, gone);
  }
  const Notification = {
    get permission() {
      return state.permission;
    },
    requestPermission: vi.fn(() => {
      log.push('permission');
      state.permission = b.answer ?? 'granted';
      return Promise.resolve(state.permission);
    }),
  };
  const pushManager = {
    getSubscription: vi.fn(async () => state.sub),
    subscribe: vi.fn(async (opts: PushSubscriptionOptionsInit) => {
      log.push('subscribe');
      const key = opts.applicationServerKey as Uint8Array;
      state.sub = fakeSub(key.slice().buffer, log, gone);
      return state.sub;
    }),
  };
  const reg = { active: {}, waiting: null, pushManager };
  const worker = b.worker ?? 'v4';
  const controller =
    worker === 'none'
      ? null
      : {
          postMessage: (msg: unknown, ports: MessagePort[]) => {
            if (worker === 'v4' && (msg as { type?: string }).type === 'version') {
              ports[0].postMessage({ type: 'version', version: 'evenly-v4', push: true });
            }
          },
        };
  const supported = b.push ?? true;
  const win: Record<string, unknown> = {
    matchMedia: () => ({ matches: !!b.standalone }),
    // router.ts listens for hashchange when it is imported.
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  if (supported) Object.assign(win, { PushManager: class {}, Notification });
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', {
    userAgent: b.ua ?? DESKTOP_CHROME,
    platform: (b.ua ?? DESKTOP_CHROME).includes('iPhone') ? 'iPhone' : 'Win32',
    maxTouchPoints: (b.ua ?? DESKTOP_CHROME).includes('iPhone') ? 5 : 0,
    standalone: b.standalone,
    serviceWorker: { controller, getRegistration: vi.fn(async () => reg) },
  });
  if (supported) {
    vi.stubGlobal('Notification', Notification);
    vi.stubGlobal('ServiceWorkerRegistration', class { showNotification() {} });
  }
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return { log, state, store, Notification, pushManager };
}

/** GET /api/push/status in these tests: the production key. */
const STATUS = { publicKey: PROD_KEY, prefs: { expenses: true, payments: true, joins: true }, devices: 1 };

/** The API: status with the production key, subscription saves answering 2 devices. */
function serve(log: string[], overrides: Partial<Record<string, (body: unknown) => unknown>> = {}) {
  h.api.mockImplementation(async (method: string, path: string, body?: unknown) => {
    const route = method + ' ' + path;
    log.push(route);
    const fn = overrides[route];
    if (fn) return fn(body);
    if (route === 'GET /api/push/status') return STATUS;
    if (route === 'PUT /api/push/subscription') return { ok: true, devices: 2 };
    if (route === 'DELETE /api/push/subscription') return { ok: true };
    throw new Error('unexpected ' + route);
  });
}

function callsTo(route: string): unknown[] {
  return h.api.mock.calls.filter(c => c[0] + ' ' + c[1] === route).map(c => c[2]);
}

/** An answer the test holds back, and gives when it is ready. */
function held<T = void>(): { promise: Promise<T>; give: (value: T) => void } {
  let give!: (value: T) => void;
  const promise = new Promise<T>(resolve => {
    give = resolve;
  });
  return { promise, give };
}

/** Let the queued promise chains (the fakes resolve at once) run to the end. */
const settle = () => new Promise(r => setTimeout(r, 20));

beforeEach(() => {
  h.api.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('swVersion', () => {
  it('answers null when no worker controls the page', async () => {
    install({ worker: 'none' });
    const { pwa } = await load();
    expect(await pwa.swVersion(50)).toBeNull();
  });

  it('reads the answer of evenly-v4 over a MessageChannel', async () => {
    install({ worker: 'v4' });
    const { pwa } = await load();
    expect(await pwa.swVersion(1000)).toEqual({ version: 'evenly-v4', push: true });
  });

  it('gives up after the timeout when the worker ignores the question (evenly-v3)', async () => {
    install({ worker: 'v3' });
    const { pwa } = await load();
    const started = Date.now();
    expect(await pwa.swVersion(60)).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('answers null when posting to the worker fails', async () => {
    install();
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { controller: { postMessage: () => { throw new Error('gone'); } } } });
    const { pwa } = await load();
    expect(await pwa.swVersion(1000)).toBeNull();
  });
});

describe('pushState', () => {
  it('iPhone Safari outside the Home Screen app needs the install first', async () => {
    install({ ua: IPHONE_SAFARI, standalone: false, push: false });
    const { push } = await load();
    expect(await push.pushState()).toBe('needs-install');
  });

  it('an in-app browser on iPhone is unsupported (no install steps there)', async () => {
    install({ ua: IPHONE_LINE, push: false });
    const { push } = await load();
    expect(await push.pushState()).toBe('unsupported');
  });

  it('the Home Screen app before iOS 16.4 has no Push API', async () => {
    install({ ua: IPHONE_SAFARI, standalone: true, push: false });
    const { push } = await load();
    expect(await push.pushState()).toBe('unsupported');
  });

  it('the Home Screen app with a worker that shows notifications is off until turned on', async () => {
    install({ ua: IPHONE_SAFARI, standalone: true });
    const { push } = await load();
    expect(await push.pushState()).toBe('off');
  });

  it('waits for the new worker while evenly-v3 is in control', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    install({ worker: 'v3', permission: 'granted', subscribedWith: PROD_KEY });
    const { push } = await load();
    const p = push.pushState();
    await vi.advanceTimersByTimeAsync(2500);
    expect(await p).toBe('waiting-worker');
  });

  it('is on with permission and a subscription, denied when blocked', async () => {
    install({ permission: 'granted', subscribedWith: PROD_KEY , wanted: true });
    expect(await (await load()).push.pushState()).toBe('on');
    vi.unstubAllGlobals();
    install({ permission: 'denied' });
    expect(await (await load()).push.pushState()).toBe('denied');
  });

  it('a browser that refuses service worker calls is unsupported', async () => {
    install({ worker: 'v4' });
    const container = navigator.serviceWorker;
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: { controller: container.controller, getRegistration: () => Promise.reject(new Error('SecurityError')) },
    });
    const { push } = await load();
    expect(await push.pushState()).toBe('unsupported');
  });
});

describe('enablePush', () => {
  it('asks for permission inside the tap, before any await, then subscribes and saves', async () => {
    const b = install({ permission: 'default', answer: 'granted' });
    serve(b.log);
    const { push } = await load();
    await push.loadPushStatus(); // before the tap: the key is kept
    b.log.length = 0;

    const pending = push.enablePush();
    // Still inside the tap: the prompt was requested synchronously, nothing else yet.
    expect(b.log).toEqual(['permission']);
    expect(await pending).toEqual({ state: 'on', devices: 2 });
    expect(b.log).toEqual(['permission', 'subscribe', 'PUT /api/push/subscription']);

    const opts = b.pushManager.subscribe.mock.calls[0][0];
    expect(opts.userVisibleOnly).toBe(true);
    expect(Array.from(opts.applicationServerKey as Uint8Array)).toEqual(Array.from(Buffer.from(PROD_KEY, 'base64url')));
    const body = callsTo('PUT /api/push/subscription')[0] as Record<string, unknown>;
    expect(body).toMatchObject({ endpoint: b.state.sub!.endpoint, expirationTime: null, keys: { p256dh: 'BPub', auth: 'secret' } });
    expect(typeof body.tz).toBe('string');
    expect(b.store.get('evenly.push.wanted')).toBe(ACCOUNT);
  });

  it('still asks first when the key was not fetched before the tap, and fetches it after', async () => {
    const b = install({ permission: 'default' });
    serve(b.log);
    const { push } = await load();
    const pending = push.enablePush();
    expect(b.log).toEqual(['permission']);
    expect((await pending).state).toBe('on');
    expect(b.log).toEqual(['permission', 'GET /api/push/status', 'subscribe', 'PUT /api/push/subscription']);
  });

  it('a blocked or dismissed prompt subscribes nothing, but the tap is remembered', async () => {
    const denied = install({ answer: 'denied' });
    serve(denied.log);
    let m = await load();
    expect(await m.push.enablePush()).toEqual({ state: 'denied' });
    expect(denied.pushManager.subscribe).not.toHaveBeenCalled();
    expect(callsTo('PUT /api/push/subscription')).toHaveLength(0);
    expect(denied.store.get('evenly.push.wanted')).toBe(ACCOUNT);

    vi.unstubAllGlobals();
    const dismissed = install({ answer: 'default' });
    serve(dismissed.log);
    m = await load();
    expect(await m.push.enablePush()).toEqual({ state: 'off' });
    expect(dismissed.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('when saving fails, the new subscription is dropped again and the error comes back', async () => {
    const b = install({ permission: 'granted' });
    let down = true;
    serve(b.log, {
      'PUT /api/push/subscription': () => {
        if (down) throw new h.FakeApiError(503, 'server_error', 'down');
        return { ok: true, devices: 1 };
      },
    });
    const { push } = await load();
    await push.loadPushStatus();
    await expect(push.enablePush()).rejects.toMatchObject({ status: 503 });
    expect(b.log.slice(-2)).toEqual(['PUT /api/push/subscription', 'unsubscribe']);
    expect(b.state.sub).toBeNull();
    // The wish stays: the next start finishes the job without another tap.
    down = false;
    b.log.length = 0;
    await push.syncPush();
    expect(b.log).toEqual(['subscribe', 'PUT /api/push/subscription']);
  });

  it('replaces a subscription made with another server key', async () => {
    const b = install({ permission: 'granted', subscribedWith: STAGING_KEY });
    serve(b.log);
    const { push } = await load();
    await push.loadPushStatus();
    b.log.length = 0;
    expect((await push.enablePush()).state).toBe('on');
    expect(b.log).toEqual(['permission', 'unsubscribe', 'DELETE /api/push/subscription', 'subscribe', 'PUT /api/push/subscription']);
  });
});

describe('disablePush', () => {
  it('unsubscribes, then tells the server, and remembers the choice', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    serve(b.log);
    const { push } = await load();
    const endpoint = b.state.sub!.endpoint;
    await push.disablePush();
    expect(b.log).toEqual(['unsubscribe', 'DELETE /api/push/subscription']);
    expect(callsTo('DELETE /api/push/subscription')).toEqual([{ endpoint }]);
    expect(b.store.has('evenly.push.wanted')).toBe(false);
  });

  it('ignores a 404 (the server had already dropped it) and a failed DELETE', async () => {
    for (const status of [404, 0]) {
      vi.unstubAllGlobals();
      const b = install({ permission: 'granted', subscribedWith: PROD_KEY });
      serve(b.log, {
        'DELETE /api/push/subscription': () => {
          throw new h.FakeApiError(status, status ? 'not_found' : 'offline', 'x');
        },
      });
      const { push } = await load();
      await expect(push.disablePush()).resolves.toBeUndefined();
      expect(b.log[0]).toBe('unsubscribe');
    }
  });
});

describe('syncPush', () => {
  it('does not link a subscription that another account turned on here (it signed out, someone else signed in)', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY });
    b.store.set('evenly.push.wanted', 'acct-someone-else');
    serve(b.log);
    const { push } = await load();
    await push.syncPush();
    expect(b.log).toEqual([]);
    expect(await push.pushState()).toBe('off');
    expect(b.store.get('evenly.push.wanted')).toBe('acct-someone-else');
  });

  it('turning notifications on takes over that subscription for this account', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY });
    b.store.set('evenly.push.wanted', 'acct-someone-else');
    serve(b.log);
    const { push } = await load();
    await push.loadPushStatus();
    b.log.length = 0;
    const r = await push.enablePush();
    expect(r.state).toBe('on');
    expect(b.log).toEqual(['permission', 'PUT /api/push/subscription']);
    expect(b.store.get('evenly.push.wanted')).toBe(ACCOUNT);
  });

  it('links an existing subscription to this session again', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY , wanted: true });
    serve(b.log);
    const { push } = await load();
    await push.syncPush();
    expect(b.log).toEqual(['GET /api/push/status', 'PUT /api/push/subscription']);
    expect(b.Notification.requestPermission).not.toHaveBeenCalled();
    expect(b.store.get('evenly.push.wanted')).toBe(ACCOUNT);
  });

  it('subscribes again quietly when the browser lost it while notifications were wanted here', async () => {
    const b = install({ permission: 'granted', wanted: true });
    serve(b.log);
    const { push } = await load();
    await push.syncPush();
    expect(b.log).toEqual(['GET /api/push/status', 'subscribe', 'PUT /api/push/subscription']);
    expect(b.Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('never turns notifications back on after they were turned off on this device', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    serve(b.log);
    const { push } = await load();
    await push.disablePush();
    b.log.length = 0;
    await push.syncPush();
    expect(b.log).toEqual([]);
  });

  it('does nothing without permission, and asks for none', async () => {
    const b = install({ permission: 'default', wanted: true });
    serve(b.log);
    const { push } = await load();
    await push.syncPush();
    expect(b.log).toEqual([]);
    expect(b.Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('drops the subscription when notifications were blocked since, keeping the wish', async () => {
    const b = install({ permission: 'denied', subscribedWith: PROD_KEY, wanted: true });
    serve(b.log);
    const { push } = await load();
    await push.syncPush();
    expect(b.log).toEqual(['unsubscribe', 'DELETE /api/push/subscription']);
    expect(b.store.get('evenly.push.wanted')).toBe(ACCOUNT);
  });

  it('replaces a subscription made with an older server key', async () => {
    const b = install({ permission: 'granted', subscribedWith: STAGING_KEY , wanted: true });
    serve(b.log);
    const { push } = await load();
    await push.syncPush();
    expect(b.log).toEqual(['GET /api/push/status', 'unsubscribe', 'DELETE /api/push/subscription', 'subscribe', 'PUT /api/push/subscription']);
  });

  it('still links the subscription when the status cannot be read', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY , wanted: true });
    serve(b.log, {
      'GET /api/push/status': () => {
        throw new h.FakeApiError(500, 'server_error', 'x');
      },
    });
    const { push } = await load();
    await push.syncPush();
    expect(b.log).toEqual(['GET /api/push/status', 'PUT /api/push/subscription']);
  });

  it('does not subscribe while a worker without push handlers is in control', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const b = install({ permission: 'granted', wanted: true, worker: 'v3' });
    serve(b.log);
    const { push } = await load();
    const p = push.syncPush();
    await vi.advanceTimersByTimeAsync(2500);
    await p;
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
    expect(callsTo('PUT /api/push/subscription')).toHaveLength(0);
  });

  it('runs once when started twice (StrictMode effects), and never throws', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY , wanted: true });
    serve(b.log, {
      'PUT /api/push/subscription': () => {
        throw new h.FakeApiError(0, 'offline', 'x');
      },
    });
    const { push } = await load();
    await Promise.all([push.syncPush(), push.syncPush()]);
    expect(callsTo('PUT /api/push/subscription')).toHaveLength(1);
  });

  it('saves once, in the newest run, when the account loads again while a sync waits', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    const status = held<unknown>();
    serve(b.log, { 'GET /api/push/status': () => status.promise });
    const { push } = await load();
    const runs = [push.syncPush()];
    await settle();
    // Each time `me` comes back, main.tsx starts a sync again.
    for (let i = 0; i < 2; i++) {
      push.setPushSession(SESSION, null);
      push.setPushSession(SESSION, ACCOUNT);
      runs.push(push.syncPush());
    }
    status.give(STATUS);
    await Promise.all(runs);
    expect(b.log).toEqual(['GET /api/push/status', 'PUT /api/push/subscription']);
  });

  it('skips iPhone Safari outside the Home Screen app', async () => {
    const b = install({ ua: IPHONE_SAFARI, push: false });
    serve(b.log);
    const { push } = await load();
    await push.syncPush();
    expect(b.log).toEqual([]);
  });
});

// The start sync waits on the network (the key, the PUT) while 我的 already shows 已開啟 and its
// 關閉這台裝置的通知 button, for example after a tap on the test notification opened the app there.
describe('a tap on 關閉這台裝置的通知 while the start sync is on its way', () => {
  it('while it waits for the key: nothing is saved, and the next start leaves it off', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    const status = held<unknown>();
    serve(b.log, { 'GET /api/push/status': () => status.promise });
    const { push } = await load();
    const sync = push.syncPush();
    await settle();
    await push.disablePush();
    status.give(STATUS);
    await sync;
    expect(b.log).toEqual(['GET /api/push/status', 'unsubscribe', 'DELETE /api/push/subscription']);
    expect(b.store.has('evenly.push.wanted')).toBe(false);

    b.log.length = 0;
    const next = await load();
    await next.push.syncPush();
    expect(b.log).toEqual([]);
    expect(await next.push.pushState()).toBe('off');
  });

  it('while the PUT is on its way: the wish stays cleared, and the DELETE goes again after the PUT', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    const saved = held<unknown>();
    serve(b.log, { 'PUT /api/push/subscription': () => saved.promise });
    const { push } = await load();
    await push.loadPushStatus();
    const endpoint = b.state.sub!.endpoint;
    b.log.length = 0;
    const sync = push.syncPush();
    await settle();
    await push.disablePush();
    saved.give({ ok: true, devices: 2 });
    await sync;
    // The tap's DELETE may reach the server before the PUT does, so it goes again once the PUT is done.
    expect(b.log).toEqual(['PUT /api/push/subscription', 'unsubscribe', 'DELETE /api/push/subscription', 'DELETE /api/push/subscription']);
    expect(callsTo('DELETE /api/push/subscription')).toEqual([{ endpoint }, { endpoint }]);
    expect(b.store.has('evenly.push.wanted')).toBe(false);

    b.log.length = 0;
    const next = await load();
    await next.push.syncPush();
    expect(b.log).toEqual([]);
  });

  it('while it subscribes again: the new subscription is dropped, and nothing is saved', async () => {
    const b = install({ permission: 'granted', wanted: true }); // the browser lost its subscription
    serve(b.log);
    const answer = held();
    const subscribe = b.pushManager.subscribe.getMockImplementation()!;
    b.pushManager.subscribe.mockImplementationOnce(async opts => {
      await answer.promise;
      return subscribe(opts);
    });
    const { push } = await load();
    await push.loadPushStatus();
    b.log.length = 0;
    const sync = push.syncPush();
    await settle();
    expect(b.pushManager.subscribe).toHaveBeenCalledTimes(1);
    await push.disablePush(); // nothing to drop yet: subscribe() has not answered
    answer.give();
    await sync;
    expect(b.log).toEqual(['subscribe', 'unsubscribe']);
    expect(b.state.sub).toBeNull();
    expect(callsTo('PUT /api/push/subscription')).toHaveLength(0);
  });
});

describe('leaving the device', () => {
  it('signing out drops the subscription here at once, with no request, and keeps the wish', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    serve(b.log);
    const { push } = await load();
    push.setPushSession(null, null);
    await settle();
    expect(b.log).toEqual(['unsubscribe']);
    expect(h.api).not.toHaveBeenCalled();
    expect(b.state.sub).toBeNull();
    expect(b.store.get('evenly.push.wanted')).toBe(ACCOUNT);
  });

  it.each([
    ['at once', [['cookie:acct-abbie:2', OTHER]]],
    ['its token first, its account a moment later (Bearer)', [['token-abbie', null], ['token-abbie', OTHER]]],
    ['after a sign-out', [[null, null], ['token-abbie', null], ['token-abbie', OTHER]]],
  ] as const)('another account signing in (%s) drops the subscription, and gets none', async (_, steps) => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    serve(b.log);
    const { push } = await load();
    for (const [key, user] of steps) push.setPushSession(key, user);
    await push.syncPush();
    expect(b.log).toEqual(['unsubscribe']);
    expect(h.api).not.toHaveBeenCalled();
    expect(await push.pushState()).toBe('off');
    expect(b.store.get('evenly.push.wanted')).toBe(ACCOUNT);
  });

  it('the account loading again, or its session key changing, is not leaving', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    serve(b.log);
    const { push } = await load();
    // me loads again (after a Bearer sign-in, at start); a token an older build saved moves into the cookie.
    push.setPushSession(SESSION, null);
    push.setPushSession(SESSION, ACCOUNT);
    push.setPushSession('cookie:acct-gino:2', ACCOUNT);
    push.setPushSession('cookie:acct-gino:2', null);
    push.setPushSession('cookie:acct-gino:2', ACCOUNT);
    await settle();
    expect(b.log).toEqual([]);
    expect(await push.pushState()).toBe('on');
  });

  it('a start, or a sign-in where nobody was signed in, drops nothing', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    serve(b.log);
    let m = await load(false);
    m.push.setPushSession(SESSION, null); // the session is known at once, the account a moment later
    m.push.setPushSession(SESSION, ACCOUNT);
    await settle();
    m = await load(false);
    m.push.setPushSession('token-abbie', OTHER);
    await settle();
    expect(b.log).toEqual([]);
    expect(b.state.sub).not.toBeNull();
  });

  it('the same account signing in again gets a new subscription quietly', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    serve(b.log);
    const { push } = await load();
    await push.loadPushStatus();
    const before = b.state.sub!.endpoint;
    b.log.length = 0;
    push.setPushSession(null, null);
    push.setPushSession('cookie:acct-gino:2', null);
    push.setPushSession('cookie:acct-gino:2', ACCOUNT);
    await push.syncPush();
    expect(b.log).toEqual(['unsubscribe', 'subscribe', 'PUT /api/push/subscription']);
    expect(b.state.sub!.endpoint).not.toBe(before);
    expect(b.store.get('evenly.push.wanted')).toBe(ACCOUNT);
  });

  it('a sync on its way for the account that left saves nothing under the next one', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    const status = held<unknown>();
    serve(b.log, { 'GET /api/push/status': () => status.promise });
    const { push } = await load();
    const sync = push.syncPush();
    await settle();
    push.setPushSession('cookie:acct-abbie:2', OTHER);
    status.give(STATUS);
    await sync;
    expect(b.log).toEqual(['GET /api/push/status', 'unsubscribe']);
    expect(callsTo('PUT /api/push/subscription')).toHaveLength(0);
    expect(b.store.get('evenly.push.wanted')).toBe(ACCOUNT);
  });

  it('signing out and in again while a sync waits still links the new session', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    const status = held<unknown>();
    serve(b.log, { 'GET /api/push/status': () => status.promise });
    const { push } = await load();
    const first = push.syncPush();
    await settle();
    push.setPushSession(null, null);
    push.setPushSession('cookie:acct-gino:2', ACCOUNT);
    const second = push.syncPush();
    status.give(STATUS);
    await Promise.all([first, second]);
    expect(b.log).toEqual(['GET /api/push/status', 'unsubscribe', 'subscribe', 'PUT /api/push/subscription']);
    expect(b.store.get('evenly.push.wanted')).toBe(ACCOUNT);
  });

  it('signs out all the same where the browser refuses service worker calls', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    serve(b.log);
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { controller: null, getRegistration: () => Promise.reject(new Error('SecurityError')) } });
    const { push } = await load();
    expect(() => push.setPushSession(null, null)).not.toThrow();
    await settle();
    expect(b.log).toEqual([]);
  });
});

/** A document whose visibility the test flips (i18n sets documentElement.lang when imported). */
function fakeDocument() {
  const handlers = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    documentElement: {} as Record<string, string>,
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'visibilitychange') handlers.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type === 'visibilitychange') handlers.delete(fn);
    },
  };
  vi.stubGlobal('document', doc);
  return {
    handlers,
    set(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      for (const fn of [...handlers]) fn();
    },
  };
}

describe('startPushSync', () => {
  it('after a blocked prompt, allowing notifications in Settings turns them on when the app is back', async () => {
    const b = install({ standalone: true, ua: IPHONE_SAFARI, answer: 'denied' });
    const page = fakeDocument();
    serve(b.log);
    const { push } = await load();
    expect((await push.enablePush()).state).toBe('denied');
    const stop = push.startPushSync();
    await settle();
    b.log.length = 0;

    page.set('hidden');
    b.state.permission = 'granted'; // Settings > Notifications > 吉諾分帳所 > Allow Notifications
    page.set('visible');
    await settle();
    expect(b.log).toEqual(['GET /api/push/status', 'subscribe', 'PUT /api/push/subscription']);
    stop();
    expect(page.handlers.size).toBe(0);
  });

  it('coming back with the same permission sends nothing more', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY , wanted: true });
    const page = fakeDocument();
    serve(b.log);
    const { push } = await load();
    const stop = push.startPushSync();
    await settle();
    expect(b.log).toEqual(['GET /api/push/status', 'PUT /api/push/subscription']);
    b.log.length = 0;
    page.set('hidden');
    page.set('visible');
    await settle();
    expect(b.log).toEqual([]);
    stop();
  });

  it('blocked while the app was away: this device stops getting them', async () => {
    const b = install({ permission: 'granted', subscribedWith: PROD_KEY, wanted: true });
    const page = fakeDocument();
    serve(b.log);
    const { push } = await load();
    const stop = push.startPushSync();
    await settle();
    b.log.length = 0;
    page.set('hidden');
    b.state.permission = 'denied';
    page.set('visible');
    await settle();
    expect(b.log).toEqual(['unsubscribe', 'DELETE /api/push/subscription']);
    stop();
  });
});

describe('updateApp', () => {
  function container(reg: Record<string, unknown> | undefined, controller: unknown = {}) {
    vi.stubGlobal('navigator', { userAgent: DESKTOP_CHROME, serviceWorker: { controller, getRegistration: async () => reg } });
  }

  it('hands over to a waiting worker', async () => {
    const waiting = { postMessage: vi.fn() };
    container({ waiting, active: {}, installing: null, update: vi.fn() });
    const { pwa } = await load();
    expect(await pwa.updateApp()).toBe('reloading');
    expect(waiting.postMessage).toHaveBeenCalledWith('skipWaiting');
  });

  it('reloads a page that no worker controls', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload, hash: '' });
    container({ waiting: null, active: {}, installing: null, update: vi.fn() }, null);
    const { pwa } = await load();
    expect(await pwa.updateApp()).toBe('reloading');
    expect(reload).toHaveBeenCalled();
  });

  it('says when a newer version is downloading, and when there is none', async () => {
    const reg: Record<string, unknown> = { waiting: null, active: {}, installing: null };
    reg.update = vi.fn(async () => {
      reg.installing = {};
    });
    container(reg);
    expect(await (await load()).pwa.updateApp()).toBe('downloading');

    container({ waiting: null, active: {}, installing: null, update: vi.fn(async () => undefined) });
    expect(await (await load()).pwa.updateApp()).toBe('none');

    container(undefined);
    expect(await (await load()).pwa.updateApp()).toBe('none');
  });
});
