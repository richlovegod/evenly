// Cookie sessions across tabs (src/web/lib/store.ts and api.ts): what a tab does after another tab
// signed the browser in to another account, or the cookies went away, when the reload it asks for
// does not happen (a desktop browser's "Reload site?" prompt over a half-typed expense, answered
// Cancel), and what 登出 does in such a tab; also that a tab matching the browser, a sign-in made
// in the tab and bearer mode behave as before. One tab of the real store runs here. The browser
// around it is a set of fakes on globalThis (cookies, storage, the localStorage bus between tabs,
// location.reload), the Worker is a fake fetch, and IndexedDB is missing, so idb.ts keeps its
// records in localStorage (evenly.kv.<key>), where the tests read them. The last part is about
// cookies a sibling *.ginochang.com site can plant that read like the marker: they must not make
// the tab delete or file away anything another account left here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthRes, MeDTO, UserDTO } from '../../src/shared/types';

type StoreModule = typeof import('../../src/web/lib/store');
type ApiModule = typeof import('../../src/web/lib/api');

const ORIGIN = 'https://split.test';
const TOKENS: Record<string, string> = {
  U1: 'tokU1' + 'a'.repeat(38),
  V1: 'tokV1' + 'b'.repeat(38),
  W1: 'tokW1' + 'c'.repeat(38),
};

class MemoryStorage {
  readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
}

type Listener = (e: unknown) => void;

/** One browser: its cookies, storage and the Worker's sessions. */
interface Browser {
  ls: MemoryStorage;
  ss: MemoryStorage;
  /** The account the readable marker cookie names (null: none). */
  marker: string | null;
  /**
   * Pairs document.cookie lists before the marker: cookies a sibling site set for the whole
   * domain. The Worker never takes them for its own (Hono reads names exactly).
   */
  planted: string[];
  /** The token in the HttpOnly session cookie (null: none). */
  cookie: string | null;
  /** No connection: every request fails before it reaches the Worker. */
  offline: boolean;
  /** Live sessions on the Worker: token to account. */
  sessions: Map<string, string>;
  reloads: number;
  sent: Sent[];
  /** Answers one request differently (undefined: the usual answer). */
  override: ((s: Sent) => Response | undefined) | null;
  win: Map<string, Listener[]>;
  doc: Map<string, Listener[]>;
  location: { origin: string; href: string; pathname: string; search: string; hash: string; reload: () => void };
}

function userOf(id: string): UserDTO {
  return {
    id,
    name: id,
    email: null,
    hasPassword: false,
    locale: 'en',
    currency: 'USD',
    color: '#000000',
    payInfo: '',
    venmo: '',
    paypal: '',
    isAdmin: false,
  } as UserDTO;
}

function meOf(id: string): MeDTO {
  return { user: userOf(id), groups: [], friends: [], totals: [], unread: 0, serverTime: new Date().toISOString() };
}

/** An outbox item as the store keeps it (waiting for a later try, so a matching tab does not send it here). */
function item(id: string, userId: string) {
  return {
    id,
    op: 'comment',
    groupId: 'g1',
    expenseId: 'e-' + id,
    body: { id: 'c-' + id, body: 'hi' },
    createdAt: Date.now(),
    attempts: 1,
    nextTryAt: Date.now() + 3_600_000,
    error: null,
    lastError: null,
    userId,
  };
}

/** A cached group snapshot as fetched by `userId` (its "me" member is that account's). */
function groupRecord(gid: string, userId: string) {
  return {
    snap: {
      group: { id: gid, name: 'Trip', currency: 'USD', version: 1 },
      members: [{ id: 'm-' + userId, userId }],
      expenses: [],
      me: { memberId: 'm-' + userId, role: 'admin' },
      inviteCode: 'X',
    },
    etag: '"1"',
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const unauthorized = () => json(401, { error: { code: 'unauthorized', message: 'Sign in first' } });

/** The Worker, as far as these flows need it (src/worker/auth.ts resolveUser, routes/auth.ts). */
function answer(b: Browser, s: Sent): Response {
  const special = b.override?.(s);
  if (special) return special;
  if (s.method === 'POST' && s.path === '/api/auth/link') {
    // startSession: a new session in the cookies; the one the browser held before is deleted.
    if (b.cookie) b.sessions.delete(b.cookie);
    b.sessions.set(TOKENS.W1, 'W1');
    b.cookie = TOKENS.W1;
    b.marker = 'W1';
    const res: AuthRes = { token: TOKENS.W1, user: userOf('W1') };
    return json(200, res);
  }
  const auth = s.headers['Authorization'];
  let user: string | null = null;
  const viaCookie = auth === undefined;
  if (!viaCookie) {
    user = b.sessions.get(auth.replace(/^Bearer /, '')) ?? null;
  } else if (b.cookie) {
    user = b.sessions.get(b.cookie) ?? null;
    if (!user) {
      // A cookie for a session that ended: both cookies go.
      b.cookie = null;
      b.marker = null;
    }
    const expected = s.headers['X-Evenly-User'];
    if (user && expected !== undefined && expected !== user) {
      return json(401, { error: { code: 'session_changed', message: 'This browser is signed in to another account now' } });
    }
  }
  if (!user) return unauthorized();
  if (s.method === 'GET' && s.path === '/api/me') return json(200, meOf(user));
  if (s.method === 'POST' && s.path === '/api/auth/cookie') {
    // The Bearer session goes into both cookies, no new session.
    if (viaCookie) return json(400, { error: { code: 'bad_request', message: 'Bearer only' } });
    b.cookie = auth.replace(/^Bearer /, '');
    b.marker = user;
    return json(200, { user: userOf(user) });
  }
  if (s.method === 'POST' && s.path === '/api/auth/logout') {
    if (viaCookie) {
      b.sessions.delete(b.cookie!);
      b.cookie = null;
      b.marker = null;
    } else {
      b.sessions.delete(auth.replace(/^Bearer /, ''));
    }
    return json(200, { ok: true });
  }
  return json(200, {});
}

function newBrowser(signedIn: string | null): Browser {
  const b: Browser = {
    ls: new MemoryStorage(),
    ss: new MemoryStorage(),
    marker: signedIn,
    planted: [],
    cookie: signedIn ? TOKENS[signedIn] : null,
    offline: false,
    sessions: new Map(signedIn ? [[TOKENS[signedIn], signedIn]] : []),
    reloads: 0,
    sent: [],
    override: null,
    win: new Map(),
    doc: new Map(),
    location: {
      origin: ORIGIN,
      href: ORIGIN + '/#/',
      pathname: '/',
      search: '',
      hash: '#/',
      reload: () => {
        b.reloads++;
      },
    },
  };
  // The app's API is this origin: cookie mode.
  b.ls.setItem('evenly.api', 'same-origin');
  return b;
}

const on = (bag: Map<string, Listener[]>) => (type: string, fn: Listener) => {
  bag.set(type, [...(bag.get(type) ?? []), fn]);
};

function install(b: Browser): void {
  vi.stubGlobal('localStorage', b.ls);
  vi.stubGlobal('sessionStorage', b.ss);
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('location', b.location);
  vi.stubGlobal('history', {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => {
      const u = new URL(url, ORIGIN);
      b.location.hash = u.hash;
      b.location.search = u.search;
    },
    back: () => undefined,
  });
  vi.stubGlobal('window', {
    addEventListener: on(b.win),
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('document', {
    get cookie() {
      return [...b.planted, ...(b.marker ? ['__Host-evenly_user=' + b.marker] : [])].join('; ');
    },
    visibilityState: 'visible',
    addEventListener: on(b.doc),
    removeEventListener: () => undefined,
    documentElement: {},
  });
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'test', language: 'en-US', languages: ['en-US'], platform: 'test', maxTouchPoints: 0 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (b.offline) throw new TypeError('Failed to fetch');
    const s: Sent = { method: init.method ?? 'GET', path: new URL(url, ORIGIN).pathname, headers: { ...(init.headers as Record<string, string>) } };
    b.sent.push(s);
    return answer(b, s);
  });
}

/** Let promise chains and fetch bodies finish (setImmediate is not faked here). */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>(r => setImmediate(r));
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/** A tab of the app on this browser, started like main.tsx does. */
async function open(b: Browser): Promise<{ store: StoreModule; api: ApiModule }> {
  install(b);
  vi.resetModules();
  const api = await import('../../src/web/lib/api');
  const store = await import('../../src/web/lib/store');
  await store.boot();
  await settle();
  // Writes the start made (the cached `me`) land before the test goes on.
  await tick(300);
  expect(api.authMode()).toBe('cookie');
  return { store, api };
}

/** Another tab says something on the bus (BroadcastChannel is missing, so a localStorage ping). */
async function bus(b: Browser, msg: { type: string }): Promise<void> {
  for (const fn of b.win.get('storage') ?? []) fn({ key: 'evenly.bus', newValue: JSON.stringify({ ...msg, nonce: Math.random() }) });
  await settle();
}

/** The tab comes to the front. */
async function show(b: Browser): Promise<void> {
  for (const fn of b.doc.get('visibilitychange') ?? []) fn({});
  await settle();
}

/** The person signs in as `user` in another tab: new cookies, that tab's token copy and cache, then its message. */
async function otherTabSignsIn(b: Browser, user: string): Promise<void> {
  if (b.cookie) b.sessions.delete(b.cookie);
  b.sessions.set(TOKENS[user], user);
  b.cookie = TOKENS[user];
  b.marker = user;
  b.ls.setItem('evenly.token', TOKENS[user]);
  b.ls.setItem('evenly.tokenUser', user);
  b.ls.setItem('evenly.kv.me', JSON.stringify(meOf(user)));
  await bus(b, { type: 'session' });
}

function record(b: Browser, key: string): unknown {
  const v = b.ls.getItem('evenly.kv.' + key);
  return v === null ? undefined : JSON.parse(v);
}

function heldIds(b: Browser, user: string): string[] {
  const rec = record(b, 'held:' + user) as { items: { id: string }[] } | undefined;
  return rec ? rec.items.map(i => i.id) : [];
}

function putItem(b: Browser, it: ReturnType<typeof item>): void {
  b.ls.setItem('evenly.kv.outbox:' + it.id, JSON.stringify(it));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a tab whose reload was cancelled', () => {
  it('asks to reload again on the next message, visit or request, not only once', async () => {
    const b = newBrowser('U1');
    const { store } = await open(b);
    await otherTabSignsIn(b, 'V1');
    expect(b.reloads).toBe(1);

    // The page is still there (the person chose to stay). Right away, nothing asks twice.
    await show(b);
    await bus(b, { type: 'session' });
    expect(b.reloads).toBe(1);

    await tick(3100);
    await show(b);
    expect(b.reloads).toBe(2);
    await tick(3100);
    await bus(b, { type: 'session' });
    expect(b.reloads).toBe(3);
    await tick(3100);
    const before = b.sent.length;
    await store.actions.loadMe();
    expect(b.reloads).toBe(4);
    // Nothing went out as the old account, and the tab was not signed out.
    expect(b.sent.length).toBe(before);
    expect(store.getState().token).toMatch(/^cookie:U1:/);
    // The loop guard counts this page once: asking again after a cancel is not a reload loop.
    expect(JSON.parse(b.ss.getItem('evenly.sessionReloads') ?? '{}').n).toBe(1);
  });

  it('coming to the front does not sync or load as the old account while it waits', async () => {
    const b = newBrowser('U1');
    const { store } = await open(b);
    await otherTabSignsIn(b, 'V1');
    await show(b);
    expect(store.getState().meError).toBeNull();
  });

  it("leaves the new account's queued changes in the outbox", async () => {
    const b = newBrowser('U1');
    const { store } = await open(b);
    await otherTabSignsIn(b, 'V1');
    // V1's tab queues a change and tells the tabs.
    putItem(b, item('v1a', 'V1'));
    await bus(b, { type: 'outbox' });
    expect(record(b, 'outbox:v1a')).toBeDefined();
    expect(record(b, 'held:V1')).toBeUndefined();
    expect(store.getState().outbox.map(i => i.id)).toEqual([]);
  });

  it('a tab that matches the browser still files another account\'s change under that account', async () => {
    const b = newBrowser('U1');
    const { store } = await open(b);
    putItem(b, item('x1a', 'X1'));
    await bus(b, { type: 'outbox' });
    expect(record(b, 'outbox:x1a')).toBeUndefined();
    expect(heldIds(b, 'X1')).toEqual(['x1a']);
    expect(store.getState().outbox).toEqual([]);
  });

  it('a fourth reload within a minute signs the tab out, and only its own things go', async () => {
    const b = newBrowser('U1');
    // Three reloads of this tab in the last minute (sessionStorage outlives a reload).
    b.ss.setItem('evenly.sessionReloads', JSON.stringify({ n: 3, since: Date.now() }));
    putItem(b, item('u1a', 'U1'));
    b.ls.setItem('evenly.kv.group:g1', JSON.stringify(groupRecord('g1', 'U1')));
    const { store } = await open(b);
    expect(store.getState().outbox.map(i => i.id)).toEqual(['u1a']);
    putItem(b, item('v1a', 'V1'));
    b.ls.setItem('evenly.kv.group:g2', JSON.stringify(groupRecord('g2', 'V1')));
    await otherTabSignsIn(b, 'V1');

    expect(b.reloads).toBe(0);
    expect(store.getState().token).toBeNull();
    // This tab's change is kept for its account; the signed-in account's things stay as they are.
    expect(heldIds(b, 'U1')).toEqual(['u1a']);
    expect(record(b, 'outbox:u1a')).toBeUndefined();
    expect(record(b, 'outbox:v1a')).toBeDefined();
    expect(record(b, 'held:V1')).toBeUndefined();
    expect(b.ls.getItem('evenly.token')).toBe(TOKENS.V1);
    expect(b.ls.getItem('evenly.tokenUser')).toBe('V1');
    expect((record(b, 'me') as MeDTO | undefined)?.user.id).toBe('V1');
    expect(record(b, 'group:g2')).toBeDefined();
    expect(store.getState().signedOut?.changes.length).toBe(1);
  });
});

describe('登出 (cookie mode)', () => {
  it('in a tab another tab switched to another account: refuses with session_changed, sends nothing, clears nothing', async () => {
    const b = newBrowser('U1');
    const { store } = await open(b);
    await otherTabSignsIn(b, 'V1');
    putItem(b, item('v1b', 'V1'));
    const before = b.sent.length;

    await expect(store.actions.logout()).rejects.toMatchObject({ status: 401, code: 'session_changed' });
    expect(b.sent.length).toBe(before);
    expect(b.ls.getItem('evenly.token')).toBe(TOKENS.V1);
    expect(b.ls.getItem('evenly.tokenUser')).toBe('V1');
    expect(record(b, 'outbox:v1b')).toBeDefined();
    expect((record(b, 'me') as MeDTO | undefined)?.user.id).toBe('V1');
    expect(b.ss.getItem('evenly.signedOut')).toBeNull();
    expect(store.getState().token).toMatch(/^cookie:U1:/);
    // The browser is still V1's.
    expect(b.marker).toBe('V1');
    expect(b.sessions.get(TOKENS.V1)).toBe('V1');
  });

  it('after the cookies went away: reloads to start on the token copy instead of throwing the copy away', async () => {
    const b = newBrowser('U1');
    b.ls.setItem('evenly.token', TOKENS.U1);
    b.ls.setItem('evenly.tokenUser', 'U1');
    putItem(b, item('u1e', 'U1'));
    const { store } = await open(b);
    // Both cookies expired in the browser; the session itself is alive.
    b.cookie = null;
    b.marker = null;
    const before = b.sent.length;

    await expect(store.actions.logout()).rejects.toMatchObject({ code: 'session_changed' });
    expect(b.sent.length).toBe(before);
    expect(b.reloads).toBe(1);
    expect(b.ls.getItem('evenly.token')).toBe(TOKENS.U1);
    expect(b.ls.getItem('evenly.tokenUser')).toBe('U1');
    expect(record(b, 'outbox:u1e')).toBeDefined();
    expect(b.sessions.get(TOKENS.U1)).toBe('U1');
  });

  it('answered 401 session_changed by the Worker: reloads and clears nothing', async () => {
    const b = newBrowser('U1');
    b.ls.setItem('evenly.token', TOKENS.U1);
    b.ls.setItem('evenly.tokenUser', 'U1');
    const { store } = await open(b);
    b.override = s =>
      s.path === '/api/auth/logout' ? json(401, { error: { code: 'session_changed', message: 'This browser is signed in to another account now' } }) : undefined;

    await expect(store.actions.logout()).rejects.toMatchObject({ code: 'session_changed' });
    expect(b.reloads).toBe(1);
    expect(b.ls.getItem('evenly.token')).toBe(TOKENS.U1);
    expect(store.getState().token).toMatch(/^cookie:U1:/);
  });

  it('answered 401 otherwise: it had ended already, so this device is signed out', async () => {
    const b = newBrowser('U1');
    b.ls.setItem('evenly.token', TOKENS.U1);
    b.ls.setItem('evenly.tokenUser', 'U1');
    putItem(b, item('u1c', 'U1'));
    const { store } = await open(b);
    // Signed out from another device meanwhile.
    b.sessions.delete(TOKENS.U1);
    putItem(b, item('x1c', 'X1'));

    await store.actions.logout();
    expect(b.sent.filter(s => s.path === '/api/auth/logout').length).toBe(1);
    expect(store.getState().token).toBeNull();
    expect(b.ls.getItem('evenly.token')).toBeNull();
    expect(b.ls.getItem('evenly.tokenUser')).toBeNull();
    expect(record(b, 'outbox:u1c')).toBeUndefined();
    // Another account's change is not this account's to drop: it stays for that account.
    expect(record(b, 'outbox:x1c')).toBeDefined();
    expect(b.location.hash).toBe('#/welcome');
    expect(b.reloads).toBe(0);
  });

  it('goes through to the Worker when the tab matches the browser', async () => {
    const b = newBrowser('U1');
    b.ls.setItem('evenly.token', TOKENS.U1);
    b.ls.setItem('evenly.tokenUser', 'U1');
    const { store } = await open(b);

    await store.actions.logout();
    const sent = b.sent.filter(s => s.path === '/api/auth/logout');
    expect(sent.length).toBe(1);
    expect(sent[0].headers['X-Evenly-User']).toBe('U1');
    expect(b.sessions.size).toBe(0);
    expect(b.marker).toBeNull();
    expect(store.getState().token).toBeNull();
    expect(b.ls.getItem('evenly.token')).toBeNull();
    expect(record(b, 'me')).toBeUndefined();
  });
});

describe('bearer mode (the API on another origin)', () => {
  it('pays no attention to a marker cookie: another account\'s change is filed as before', async () => {
    const b = newBrowser(null);
    b.ls.setItem('evenly.api', 'https://api.test');
    b.ls.setItem('evenly.token', TOKENS.U1);
    b.sessions.set(TOKENS.U1, 'U1');
    // A marker this origin happens to carry (cookies are not how this mode signs in).
    b.marker = 'V1';
    install(b);
    vi.resetModules();
    const api = await import('../../src/web/lib/api');
    const store = await import('../../src/web/lib/store');
    await store.boot();
    await settle();
    expect(api.authMode()).toBe('bearer');
    expect(store.getState().me?.user.id).toBe('U1');

    putItem(b, item('x1b', 'X1'));
    await bus(b, { type: 'outbox' });
    expect(heldIds(b, 'X1')).toEqual(['x1b']);
    await bus(b, { type: 'session' });
    await show(b);
    expect(b.reloads).toBe(0);
  });
});

describe('signing in to another account from this tab', () => {
  it('still replaces everything of the account before (held changes aside)', async () => {
    const b = newBrowser('U1');
    b.ls.setItem('evenly.token', TOKENS.U1);
    b.ls.setItem('evenly.tokenUser', 'U1');
    putItem(b, item('u1d', 'U1'));
    b.ls.setItem('evenly.kv.group:g1', JSON.stringify(groupRecord('g1', 'U1')));
    const { store } = await open(b);

    await store.actions.linkLogin('ABCD-EFGH');
    await tick(300);
    expect(store.getState().token).toMatch(/^cookie:W1:/);
    expect(heldIds(b, 'U1')).toEqual(['u1d']);
    expect(record(b, 'outbox:u1d')).toBeUndefined();
    expect(record(b, 'group:g1')).toBeUndefined();
    expect((record(b, 'me') as MeDTO | undefined)?.user.id).toBe('W1');
    expect(b.ls.getItem('evenly.token')).toBe(TOKENS.W1);
    expect(b.ls.getItem('evenly.tokenUser')).toBe('W1');
    expect(b.reloads).toBe(0);
  });
});

/** V1 was signed in on this device and its cookies lapsed: its token copy, cached data and a queued change are here. */
function leftByV1(b: Browser): void {
  b.sessions.set(TOKENS.V1, 'V1');
  b.ls.setItem('evenly.token', TOKENS.V1);
  b.ls.setItem('evenly.tokenUser', 'V1');
  b.ls.setItem('evenly.kv.me', JSON.stringify(meOf('V1')));
  b.ls.setItem('evenly.kv.group:g2', JSON.stringify(groupRecord('g2', 'V1')));
  putItem(b, item('v1a', 'V1'));
}

describe('a cookie a sibling *.ginochang.com site planted', () => {
  it('is the marker only when its name is exactly __Host-evenly_user, and two such pairs are no marker', async () => {
    const b = newBrowser(null);
    const { api } = await open(b);
    const read = (...pairs: string[]) => {
      b.planted = pairs;
      return api.markerUser();
    };
    expect(read('__Host-evenly_user=U1')).toBe('U1');
    expect(read('a=1', '__Host-evenly_user=U1', 'b=2')).toBe('U1');
    // Spaces and tabs around a name or value are not part of it (browsers and Hono agree).
    expect(read('\t__Host-evenly_user =U1 ')).toBe('U1');
    // A Unicode space is: such a cookie is no __Host- cookie, so any sibling can set it.
    for (const space of ['\u00A0', '\uFEFF', '\u3000', '\u2000', '\u2028']) {
      expect(read(space + '__Host-evenly_user=X1')).toBeNull();
      expect(read('__Host-evenly_user' + space + '=X1')).toBeNull();
      expect(read('__Host-evenly_user=' + space + 'X1')).toBeNull();
    }
    expect(read('__host-evenly_user=X1')).toBeNull();
    // A real __Host- cookie is the only one of its name on this host: a second pair was planted.
    expect(read('__Host-evenly_user=X1', '__Host-evenly_user=U1')).toBeNull();
    expect(read('__Host-evenly_user=U1', '__Host-evenly_user=U1')).toBeNull();
  });

  it('with a Unicode space before its name is ignored: the app starts on the token copy and keeps everything', async () => {
    const b = newBrowser(null);
    leftByV1(b);
    b.planted = ['\u00A0__Host-evenly_user=X1'];
    const { store } = await open(b);

    expect(b.sent.some(s => s.headers['X-Evenly-User'] === 'X1')).toBe(false);
    expect(store.getState().me?.user.id).toBe('V1');
    expect(Object.keys(store.getState().groups)).toEqual(['g2']);
    expect(store.getState().outbox.map(i => i.id)).toEqual(['v1a']);
    // The copy went back into the cookies and stays as the copy.
    expect(b.marker).toBe('V1');
    expect(store.getState().token).toMatch(/^cookie:V1:/);
    expect(b.ls.getItem('evenly.token')).toBe(TOKENS.V1);
    expect(b.ls.getItem('evenly.tokenUser')).toBe('V1');
    expect(record(b, 'group:g2')).toBeDefined();
    expect(record(b, 'outbox:v1a')).toBeDefined();
    expect(record(b, 'held:V1')).toBeUndefined();
  });

  it('that reads exactly like the marker (a nameless cookie, kept by WebKit) gets nothing of another account deleted or filed away', async () => {
    const b = newBrowser(null);
    leftByV1(b);
    b.planted = ['__Host-evenly_user=X1'];
    const { store } = await open(b);

    // The tab started as X1, and the first answer (401: no session cookie came) signed it out.
    expect(b.sent.some(s => s.path === '/api/me' && s.headers['X-Evenly-User'] === 'X1')).toBe(true);
    expect(store.getState().token).toBeNull();
    expect(b.ls.getItem('evenly.token')).toBe(TOKENS.V1);
    expect(b.ls.getItem('evenly.tokenUser')).toBe('V1');
    expect((record(b, 'me') as MeDTO | undefined)?.user.id).toBe('V1');
    expect(record(b, 'group:g2')).toBeDefined();
    expect(record(b, 'outbox:v1a')).toBeDefined();
    expect(record(b, 'held:V1')).toBeUndefined();
    expect(record(b, 'held:X1')).toBeUndefined();
    expect(b.sessions.get(TOKENS.V1)).toBe('V1');

    // Once that cookie is gone (it expires when the sibling chose), the next start is V1's again.
    b.planted = [];
    b.win.clear();
    b.doc.clear();
    const again = await open(b);
    expect(again.store.getState().me?.user.id).toBe('V1');
    expect(Object.keys(again.store.getState().groups)).toEqual(['g2']);
    expect(again.store.getState().outbox.map(i => i.id)).toEqual(['v1a']);
  });

  it('with the real marker, what another account left only waits for GET /api/me to name this one, then goes as before', async () => {
    const b = newBrowser('U1');
    leftByV1(b);
    b.sessions.set(TOKENS.U1, 'U1');
    b.ls.setItem('evenly.kv.group:g1', JSON.stringify(groupRecord('g1', 'U1')));
    putItem(b, item('u1a', 'U1'));
    b.offline = true;
    const { store } = await open(b);

    // Offline: signed in as U1 from the marker; V1's things are out of view, and all still there.
    expect(store.getState().token).toMatch(/^cookie:U1:/);
    expect(store.getState().me).toBeNull();
    expect(Object.keys(store.getState().groups)).toEqual(['g1']);
    expect(store.getState().outbox.map(i => i.id)).toEqual(['u1a']);
    expect(b.ls.getItem('evenly.token')).toBe(TOKENS.V1);
    expect(b.ls.getItem('evenly.tokenUser')).toBe('V1');
    expect((record(b, 'me') as MeDTO | undefined)?.user.id).toBe('V1');
    expect(record(b, 'group:g2')).toBeDefined();
    expect(record(b, 'outbox:v1a')).toBeDefined();
    expect(record(b, 'held:V1')).toBeUndefined();

    // Online: GET /api/me with the cookie says U1. V1's copy and cached data go, its change is filed under it.
    b.offline = false;
    for (const fn of b.win.get('online') ?? []) fn({});
    await tick(300);
    expect(store.getState().me?.user.id).toBe('U1');
    expect(b.ls.getItem('evenly.token')).toBeNull();
    expect(b.ls.getItem('evenly.tokenUser')).toBeNull();
    expect((record(b, 'me') as MeDTO | undefined)?.user.id).toBe('U1');
    expect(record(b, 'group:g1')).toBeDefined();
    expect(record(b, 'group:g2')).toBeUndefined();
    expect(heldIds(b, 'V1')).toEqual(['v1a']);
    expect(record(b, 'outbox:v1a')).toBeUndefined();
    expect(record(b, 'outbox:u1a')).toBeDefined();
    expect(store.getState().outbox.map(i => i.id)).toEqual(['u1a']);
  });

  it("signed out by a 401 before any answer named the account: its own things go as after any 401, another account's stay", async () => {
    const b = newBrowser('U1');
    // U1's session ended elsewhere while the app was closed; its cookies are still in the browser.
    b.sessions.delete(TOKENS.U1);
    b.ls.setItem('evenly.token', TOKENS.U1);
    b.ls.setItem('evenly.tokenUser', 'U1');
    b.ls.setItem('evenly.kv.me', JSON.stringify(meOf('U1')));
    b.ls.setItem('evenly.kv.group:g1', JSON.stringify(groupRecord('g1', 'U1')));
    b.ls.setItem('evenly.kv.group:g2', JSON.stringify(groupRecord('g2', 'V1')));
    putItem(b, item('u1a', 'U1'));
    putItem(b, item('v1a', 'V1'));
    const { store } = await open(b);

    expect(store.getState().token).toBeNull();
    expect(store.getState().signedOut?.changes.length).toBe(1);
    expect(heldIds(b, 'U1')).toEqual(['u1a']);
    expect(record(b, 'outbox:u1a')).toBeUndefined();
    expect(b.ls.getItem('evenly.token')).toBeNull();
    expect(b.ls.getItem('evenly.tokenUser')).toBeNull();
    expect(record(b, 'me')).toBeUndefined();
    expect(record(b, 'group:g1')).toBeUndefined();
    // V1's change and cached group stay where they were, for V1's next start or sign-in.
    expect(record(b, 'outbox:v1a')).toBeDefined();
    expect(record(b, 'held:V1')).toBeUndefined();
    expect(record(b, 'group:g2')).toBeDefined();
  });
});
