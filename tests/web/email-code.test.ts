// Email codes in the app (src/web/features/auth/emailCode.ts and the store's emailStart,
// emailVerify, addEmailStart and addEmailVerify): cleaning a typed address and a typed or pasted
// code, when 重新寄送 works, what each answer that went wrong says in both languages, and what
// the store sends and keeps when a code signs in, makes an account or confirms an email. The
// browser is a set of fakes on globalThis in Bearer mode (the API on another origin, as under vite
// preview), the Worker is a fake fetch, and IndexedDB is missing, so idb.ts keeps its records in
// localStorage (evenly.kv.<key>).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeDTO, UserDTO } from '../../src/shared/types';

type StoreModule = typeof import('../../src/web/lib/store');
type CodeModule = typeof import('../../src/web/features/auth/emailCode');
type I18nModule = typeof import('../../src/web/lib/i18n');
type ApiModule = typeof import('../../src/web/lib/api');

const ORIGIN = 'https://split.test';
const API = 'https://api.split.test';
const TOKEN = 'tok' + 'e'.repeat(40);

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
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

function userOf(over: Partial<UserDTO> = {}): UserDTO {
  return {
    id: 'u-gino', name: 'Gino', email: null, emailVerified: false, hasPassword: false, googleLinked: false, appleLinked: false, locale: 'en', currency: 'USD', color: '#000000',
    payInfo: '', venmo: '', paypal: '', isAdmin: false, createdAt: '2026-10-25T00:00:00.000Z', avatar: null, ...over,
  };
}

const meOf = (user: UserDTO): MeDTO => ({ user, groups: [], friends: [], totals: [], unread: 0, serverTime: new Date().toISOString() });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let ls: MemoryStorage;
let sent: Sent[];
/** How the fake Worker answers; the default answers GET /api/me for the signed-in account. */
let answer: (s: Sent) => Response;
/** The account GET /api/me describes. */
let account: UserDTO;

function install(): void {
  ls = new MemoryStorage();
  ls.setItem('evenly.api', API);
  ls.setItem('evenly.locale', 'en');
  const location = { origin: ORIGIN, href: ORIGIN + '/#/welcome', pathname: '/', search: '', hash: '#/welcome', reload: () => undefined };
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => {
      const u = new URL(url, ORIGIN);
      location.hash = u.hash;
      location.search = u.search;
    },
    back: () => undefined,
  });
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('document', { cookie: '', visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined, documentElement: {} });
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'test', language: 'en-US', languages: ['en-US'], platform: 'test', maxTouchPoints: 0 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const s: Sent = {
      method: init.method ?? 'GET',
      url,
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    sent.push(s);
    return answer(s);
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>(r => setImmediate(r));
}

async function load(): Promise<{ store: StoreModule; code: CodeModule; i18n: I18nModule; api: ApiModule }> {
  install();
  vi.resetModules();
  const api = await import('../../src/web/lib/api');
  const i18n = await import('../../src/web/lib/i18n');
  const store = await import('../../src/web/lib/store');
  const code = await import('../../src/web/features/auth/emailCode');
  return { store, code, i18n, api };
}

beforeEach(() => {
  sent = [];
  account = userOf();
  answer = s => (s.method === 'GET' && s.url === API + '/api/me' ? json(200, meOf(account)) : json(404, { error: { code: 'not_found', message: 'Not found' } }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- the helpers ----------

describe('cleaning what is typed', () => {
  it('an address: NFKC, trimmed, lowercase, the Worker\'s rule', async () => {
    const { code } = await load();
    expect(code.cleanEmail('  ＧＩＮＯ＠Ｅｘａｍｐｌｅ．ｃｏｍ ')).toBe('gino@example.com');
    expect(code.cleanEmail('Abbie@Mail.CO.JP')).toBe('abbie@mail.co.jp');
    expect(code.emailOk('gino@example.com')).toBe(true);
    for (const bad of ['', 'gino', 'gino@', '@x.com', 'gino@localhost', 'gi no@x.com', 'e'.repeat(109) + '@evenly.test']) expect(code.emailOk(bad)).toBe(false);
  });

  it('a code: its digits only (full width too), at most 6, so a pasted line or "123 456" works', async () => {
    const { code } = await load();
    expect(code.cleanCode('123456')).toBe('123456');
    expect(code.cleanCode('１２３ ４５６')).toBe('123456');
    expect(code.cleanCode('123-456')).toBe('123456');
    expect(code.cleanCode('Code: 042 917')).toBe('042917');
    expect(code.cleanCode('1234567')).toBe('123456');
    expect(code.cleanCode('abc')).toBe('');
    expect(code.codeComplete('042917')).toBe(true);
    expect(code.codeComplete('04291')).toBe(false);
    expect(code.codeComplete('04291a')).toBe(false);
  });

  it('重新寄送 works a minute after a code went out', async () => {
    const { code } = await load();
    expect(code.RESEND_AFTER_MS).toBe(60_000);
    expect(code.resendAt(1_000_000)).toBe(1_060_000);
  });
});

describe('what an answer that went wrong says', () => {
  const err = async (api: ApiModule, status: number, codeName: string, details?: unknown) => new api.ApiError(status, codeName as never, 'x', details);

  it('in English', async () => {
    const { code, api } = await load();
    expect(code.codeErrorText(await err(api, 400, 'code_invalid'), 'verify')).toBe('That code is wrong or has expired. Type it again, or send a new one.');
    expect(code.codeErrorText(await err(api, 429, 'rate_limited', { retryAfter: 600 }), 'send')).toBe('Too many codes for now. Try again in 10 minutes.');
    expect(code.codeErrorText(await err(api, 429, 'rate_limited', { retryAfter: 30 }), 'verify')).toBe('Too many wrong tries. Try again in 1 minute.');
    expect(code.codeErrorText(await err(api, 429, 'rate_limited', { retryAfter: 80_000 }), 'send')).toBe('Too many codes for now. Try again in 23 hours.');
    expect(code.codeErrorText(await err(api, 429, 'rate_limited'), 'send')).toBe('Too many codes for now. Try again in a while.');
    expect(code.codeErrorText(await err(api, 503, 'email_quota', { retryAfter: 3600 }), 'send')).toBe("Today's sign-in emails are used up. Try again tomorrow, or use a code from another device.");
    expect(code.codeErrorText(await err(api, 503, 'email_unavailable'), 'send')).toContain("can't send the email right now");
    expect(code.codeErrorText(await err(api, 409, 'email_taken'), 'send')).toBe('Another account already uses this email.');
    expect(code.codeErrorText(await err(api, 400, 'name_required'), 'verify')).toBe('Enter your name.');
    expect(code.codeErrorText(await err(api, 400, 'validation'), 'send')).toBe('Enter a valid email address.');
    expect(code.codeErrorText(await err(api, 0, 'offline'), 'send')).toBe('No connection. Try again when you are online.');
  });

  it('in Chinese', async () => {
    const { code, api, i18n } = await load();
    i18n.setLocale('zh-TW');
    expect(code.codeErrorText(await err(api, 400, 'code_invalid'), 'verify')).toBe('驗證碼不對或已經過期，請再輸入一次，或重新寄送。');
    expect(code.codeErrorText(await err(api, 503, 'email_quota'), 'send')).toBe('今天的驗證信已經寄完了，請明天再試，或用其他裝置的登入碼。');
    expect(code.codeErrorText(await err(api, 429, 'rate_limited', { retryAfter: 900 }), 'send')).toBe('驗證信寄太多次了，請 15 分鐘後再試。');
    expect(code.codeErrorText(await err(api, 429, 'rate_limited', { retryAfter: 7200 }), 'verify')).toBe('輸入錯太多次了，請 2 小時後再試。');
    expect(code.codeErrorText(await err(api, 409, 'email_taken'), 'send')).toBe('這個 Email 已經有別的帳號在用了。');
    expect(code.codeErrorText(await err(api, 400, 'name_required'), 'verify')).toBe('請輸入你的名字。');
  });
});

// ---------- the store ----------

describe('signing in with a code (store)', () => {
  it('emailStart asks for a code anonymously, in the app\'s language', async () => {
    const { store } = await load();
    answer = () => json(200, { ok: true, expiresInSec: 600, devCode: '123456' });
    const r = await store.actions.emailStart('gino@example.com');
    expect(r).toEqual({ ok: true, expiresInSec: 600, devCode: '123456' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'POST', url: API + '/api/auth/email/start', body: { email: 'gino@example.com', locale: 'en' } });
    expect(sent[0].headers.Authorization).toBeUndefined();
  });

  it('emailVerify signs in with the token it gets (Bearer mode) and says whether the account is new', async () => {
    const { store } = await load();
    account = userOf({ email: 'gino@example.com', emailVerified: true });
    const base = answer;
    answer = s => (s.url === API + '/api/auth/email/verify' ? json(200, { token: TOKEN, user: account, created: true }) : base(s));
    const r = await store.actions.emailVerify({ email: 'gino@example.com', code: '123456', name: 'Gino' });
    await settle();
    expect(r.created).toBe(true);
    expect(r.user.emailVerified).toBe(true);
    const verify = sent.find(s => s.url.endsWith('/api/auth/email/verify'))!;
    expect(verify.body).toEqual({ locale: 'en', email: 'gino@example.com', code: '123456', name: 'Gino' });
    expect(verify.headers.Authorization).toBeUndefined();
    expect(store.getState().token).toBe(TOKEN);
    expect(ls.getItem('evenly.token')).toBe(TOKEN);
    // The dashboard is fetched for the new session.
    const me = sent.find(s => s.method === 'GET' && s.url === API + '/api/me');
    expect(me?.headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(store.getState().me?.user.id).toBe('u-gino');
  });

  it('a name_required answer leaves the device signed out, for the page to ask for a name', async () => {
    const { store, api } = await load();
    answer = () => json(400, { error: { code: 'name_required', message: 'No account uses this email yet' } });
    const e = await store.actions.emailVerify({ email: 'new@example.com', code: '123456' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(api.ApiError);
    expect((e as InstanceType<ApiModule['ApiError']>).code).toBe('name_required');
    expect(store.getState().token).toBeNull();
    expect(ls.getItem('evenly.token')).toBeNull();
  });
});

describe('adding or changing the email (store)', () => {
  /** Signed in with a token, the dashboard loaded. */
  async function signedIn() {
    const mods = await load();
    ls.setItem('evenly.token', TOKEN);
    vi.resetModules();
    const store = await import('../../src/web/lib/store');
    await store.actions.loadMe();
    return { ...mods, store };
  }

  it('addEmailStart and addEmailVerify go as this account, and the answer replaces the account on the device', async () => {
    const { store } = await signedIn();
    expect(store.getState().me?.user.emailVerified).toBe(false);
    const confirmed = userOf({ email: 'gino@example.com', emailVerified: true });
    const base = answer;
    answer = s => {
      if (s.url === API + '/api/me/email/start') return json(200, { ok: true, expiresInSec: 600 });
      if (s.url === API + '/api/me/email/verify') return json(200, { user: confirmed, passwordCleared: false });
      return base(s);
    };
    await store.actions.addEmailStart('gino@example.com');
    const r = await store.actions.addEmailVerify('gino@example.com', '654321');
    await settle();
    expect(r).toEqual({ user: confirmed, passwordCleared: false });
    const start = sent.find(s => s.url.endsWith('/api/me/email/start'))!;
    const verify = sent.find(s => s.url.endsWith('/api/me/email/verify'))!;
    expect(start.body).toEqual({ email: 'gino@example.com' });
    expect(verify.body).toEqual({ email: 'gino@example.com', code: '654321' });
    for (const s of [start, verify]) expect(s.headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(store.getState().me?.user).toMatchObject({ email: 'gino@example.com', emailVerified: true });
    // The store writes its copy a moment later (persist waits 250 ms for more changes).
    await new Promise(r => setTimeout(r, 300));
    await settle();
    const kept = JSON.parse(ls.getItem('evenly.kv.me') ?? 'null') as MeDTO | null;
    expect(kept?.user.emailVerified).toBe(true);
  });

  it('setCredentials sends the account\'s own email with the key salted by it', async () => {
    const { store } = await signedIn();
    const confirmed = userOf({ email: 'gino@example.com', emailVerified: true });
    const base = answer;
    answer = s => (s.url === API + '/api/me/credentials' ? json(200, { user: { ...confirmed, hasPassword: true } }) : base(s));
    await store.actions.setCredentials({ email: 'gino@example.com', password: 'gino password 1' });
    const c = sent.find(s => s.url.endsWith('/api/me/credentials'))!;
    expect(c.body?.email).toBe('gino@example.com');
    expect(String(c.body?.password)).toMatch(/^k1\./);
    expect(c.body?.password).not.toBe('gino password 1');
  });
});
