// The web store at start and when a session ends (review of 2026-11-07, unit W2): the Home Screen
// app's one-time ?install= code is tried until it has signed in or the server said it no longer
// works, and never again after that (the icon keeps opening the URL with the code); the signed-out
// notice says how the account gets back in (an email, a linked Apple ID or Google account, or only
// a code from another device); and saving works where crypto.randomUUID is missing (Safari 15.0
// to 15.3). One tab of the real store in a fake browser (bearer mode, no IndexedDB, so idb.ts keeps
// its records in localStorage); the Worker is a fake fetch, and toasts are recorded.

import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthRes, MeDTO, UpsertExpenseReq, UserDTO } from '../../src/shared/types';

type StoreModule = typeof import('../../src/web/lib/store');

const ORIGIN = 'https://split.test';
const API = 'https://api.test';
const TOKEN = 'tok' + 'a'.repeat(40);
const CODE = 'ABCD2345';

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

function userOf(over: Partial<UserDTO> = {}): UserDTO {
  return {
    id: 'u-gino', name: 'Gino', email: null, emailVerified: false, hasPassword: false, googleLinked: false, appleLinked: false, locale: 'en', currency: 'TWD', color: '#000000',
    payInfo: '', venmo: '', paypal: '', isAdmin: false, createdAt: '2026-10-25T00:00:00.000Z', avatar: null, ...over,
  };
}

const meOf = (user: UserDTO): MeDTO => ({ user, groups: [], friends: [], totals: [], unread: 0, serverTime: new Date().toISOString() });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** One device: its storage, its address and what the fake Worker does. */
interface Device {
  ls: MemoryStorage;
  location: { origin: string; href: string; pathname: string; search: string; hash: string; reload: () => void };
  standalone: boolean;
  offline: boolean;
  /** How POST /api/auth/link answers. */
  link: 'ok' | 'spent' | 'limited';
  /** The account GET /api/me describes (null: the session is over, 401). */
  account: UserDTO | null;
  sent: string[];
  toasts: { message: string; kind?: string }[];
}

function newDevice(over: Partial<Device> = {}): Device {
  const ls = new MemoryStorage();
  ls.setItem('evenly.api', API);
  ls.setItem('evenly.locale', 'en');
  return {
    ls,
    location: { origin: ORIGIN, href: ORIGIN + '/', pathname: '/', search: '', hash: '#/', reload: () => undefined },
    standalone: false,
    offline: false,
    link: 'ok',
    account: userOf(),
    sent: [],
    toasts: [],
    ...over,
  };
}

function answer(d: Device, method: string, path: string): Response {
  if (method === 'POST' && path === '/api/auth/link') {
    if (d.link === 'spent') return json(400, { error: { code: 'code_invalid', message: 'This code is wrong or has expired' } });
    if (d.link === 'limited') return json(429, { error: { code: 'rate_limited', message: 'Too many attempts', details: { retryAfter: 900 } } });
    d.account = userOf();
    const res: AuthRes = { token: TOKEN, user: d.account };
    return json(200, res);
  }
  if (method === 'GET' && path === '/api/me') {
    return d.account ? json(200, meOf(d.account)) : json(401, { error: { code: 'unauthorized', message: 'Sign in first' } });
  }
  if (method === 'POST' && path === '/api/auth/logout') return json(200, { ok: true });
  return json(404, { error: { code: 'not_found', message: 'Not found' } });
}

function install(d: Device): void {
  const location = d.location;
  vi.stubGlobal('localStorage', d.ls);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => {
      const u = new URL(url, ORIGIN);
      location.search = u.search;
      location.hash = u.hash;
    },
    back: () => undefined,
  });
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: (q: string) => ({ matches: d.standalone && q === '(display-mode: standalone)' }),
    dispatchEvent: () => true,
  });
  vi.stubGlobal('document', { cookie: '', visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined, documentElement: {} });
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'test', language: 'en-US', languages: ['en-US'], platform: 'test', maxTouchPoints: 0 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (d.offline) throw new TypeError('Failed to fetch');
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname;
    d.sent.push(method + ' ' + path);
    return answer(d, method, path);
  });
  vi.doMock('../../src/web/lib/toast', () => ({
    showToast: (t: { message: string; kind?: string }) => d.toasts.push({ message: t.message, kind: t.kind }),
    dismissToast: () => undefined,
    useToasts: () => [],
  }));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await new Promise<void>(r => setImmediate(r));
}

/** A cold start of the app on this device. */
async function start(d: Device): Promise<StoreModule> {
  install(d);
  vi.resetModules();
  const store = await import('../../src/web/lib/store');
  await store.boot();
  await settle();
  return store;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.doUnmock('../../src/web/lib/toast');
  vi.unstubAllGlobals();
});

const links = (d: Device) => d.sent.filter(s => s === 'POST /api/auth/link').length;

describe('the Home Screen app\'s ?install= code', () => {
  it('a spent code says so once; later starts (signed out) leave it alone', async () => {
    const d = newDevice({ standalone: true, link: 'spent', account: null });
    d.location.search = '?install=' + CODE;
    await start(d);
    expect(links(d)).toBe(1);
    expect(d.toasts).toEqual([{ message: 'The sign-in code expired. Make a new one on the Account page in Safari.', kind: 'error' }]);
    expect(d.location.search).toBe('');
    // The icon opens the URL it was added from again, code and all.
    for (let i = 0; i < 3; i++) {
      d.location.search = '?install=' + CODE;
      d.toasts.length = 0;
      await start(d);
      expect(d.toasts).toEqual([]);
    }
    expect(links(d)).toBe(1);
  });

  it('a try with no connection, or refused for now, says why and keeps the code for the next start, which signs in', async () => {
    const d = newDevice({ standalone: true, account: null, offline: true });
    d.location.search = '?install=' + CODE;
    await start(d);
    expect(d.toasts).toEqual([{ message: 'No connection. Try again when you are online.', kind: 'error' }]);

    d.offline = false;
    d.link = 'limited';
    d.location.search = '?install=' + CODE;
    d.toasts.length = 0;
    await start(d);
    expect(d.toasts).toEqual([{ message: 'Too many attempts. Wait a few minutes and try again.', kind: 'error' }]);

    d.link = 'ok';
    d.location.search = '?install=' + CODE;
    d.toasts.length = 0;
    const store = await start(d);
    expect(store.getState().token).toBe(TOKEN);
    expect(d.toasts).toEqual([{ message: 'Signed in.', kind: 'success' }]);
    expect(links(d)).toBe(2);

    // Signed out on purpose later: the used code is not tried again.
    await store.actions.logout();
    d.account = null;
    d.location.search = '?install=' + CODE;
    d.toasts.length = 0;
    await start(d);
    expect(links(d)).toBe(2);
    expect(d.toasts).toEqual([]);
  });

  it('a code the app opens with while signed in is remembered too', async () => {
    const d = newDevice({ standalone: true });
    d.ls.setItem('evenly.token', TOKEN);
    d.location.search = '?install=' + CODE;
    await start(d);
    expect(links(d)).toBe(0);
    expect(d.ls.getItem('evenly.installTried')).toBe(CODE);
  });
});

/** An outbox record as the store keeps it, waiting for a later try (so the start does not send it). */
function queuedComment(userId: string) {
  return {
    id: 'c-item-1', op: 'comment', groupId: 'g1', expenseId: 'e1', body: { id: 'c-1', body: '收據在這' },
    createdAt: Date.now(), attempts: 1, nextTryAt: Date.now() + 3_600_000, error: null, lastError: null, userId,
  };
}

describe('the signed-out notice', () => {
  it.each([
    ['an Apple ID and no email', { appleLinked: true }, { hasEmail: false, apple: true, google: false }],
    ['a Google account and no email', { googleLinked: true }, { hasEmail: false, apple: false, google: true }],
    ['an email', { email: 'gino@evenly.test', emailVerified: true }, { hasEmail: true, apple: false, google: false }],
    ['nothing but this device', {}, { hasEmail: false, apple: false, google: false }],
  ])('for an account with %s says how it gets back in', async (_name, over, ways) => {
    const user = userOf(over);
    const d = newDevice({ account: null });
    d.ls.setItem('evenly.token', TOKEN);
    d.ls.setItem('evenly.kv.me', JSON.stringify(meOf(user)));
    d.ls.setItem('evenly.kv.outbox:c-item-1', JSON.stringify(queuedComment(user.id)));
    const store = await start(d);
    expect(store.getState().token).toBeNull();
    expect(store.getState().signedOut).toEqual({ changes: [expect.objectContaining({ op: 'comment' })], ...ways });
  });
});

describe('ids where crypto.randomUUID is missing (Safari 15.0 to 15.3)', () => {
  it('saving and commenting still queue, with UUIDs made from getRandomValues', async () => {
    vi.stubGlobal('crypto', { subtle: webcrypto.subtle, getRandomValues: <T extends ArrayBufferView>(a: T) => webcrypto.getRandomValues(a as unknown as Uint8Array) as unknown as T });
    const d = newDevice();
    d.ls.setItem('evenly.token', TOKEN);
    const store = await start(d);
    d.offline = true;
    const body: UpsertExpenseReq = {
      kind: 'expense', description: '晚餐', category: 'food.dining', amount: 1200, currency: 'TWD', fxRate: 1, date: '2026-11-01',
      payers: [{ memberId: 'm1', amount: 1200 }], split: { method: 'equal', entries: [{ memberId: 'm1' }] },
    };
    store.actions.saveExpense('g1', 'e-new-0001', body);
    store.actions.addComment('g1', 'e-new-0001', '好吃');
    await settle();
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const items = store.getState().outbox;
    expect(items.map(i => i.op)).toEqual(['upsert', 'comment']);
    for (const i of items) expect(i.id).toMatch(UUID);
    expect((items[1].body as { id: string }).id).toMatch(UUID);
  });
});
