// Email codes (services/emailCodes.ts and email.ts; POST /api/auth/email/* in routes/auth.ts and
// /api/me/email/* and /api/me/credentials in routes/me.ts; docs/SPEC.md section 3, Email codes):
// making and keeping a code, its expiry, a new code replacing the older one, 5 tries, the same
// work with or without a code, the limits and the whole app's daily cap, signing in versus making
// an account, name_required, adding and changing an account's email (email_taken,
// passwordCleared), the password route that no longer sets an email, test mode (never in
// production), the request Resend gets (a stubbed fetch), the daily cleanup and account deletion.
// Runs the real Worker against the real schema in SQLite (d1-sqlite.ts) with https://split.test
// as the app's origin. Addresses on .test domains never reach Resend (services/email.ts
// undeliverable), so the Resend tests use other domains; fetch is a stub in every test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, hashPassword } from '../../src/worker/auth';
import { sha256Hex } from '../../src/worker/http';
import worker from '../../src/worker/index';
import { cleanupStmts } from '../../src/worker/services/cron';
import {
  canEcho, canSend, codeMessage, EMAIL_APP_LINK, EMAIL_REPLY_TO, EMAIL_TIMEOUT_MS, EmailError, RESEND_URL, sendEmail, undeliverable,
} from '../../src/worker/services/email';
import {
  cleanCode, CODE_MAX_TRIES, CODE_TTL_SEC, codeEmail, codeHash, codeMatches, EMAIL_GLOBAL_PER_DAY, EMAIL_IP_PER_HOUR, EMAIL_PER_15M,
  EMAIL_PER_DAY, randomDigits, VERIFY_FAILS_PER_EMAIL, VERIFY_FAILS_PER_IP,
} from '../../src/worker/services/emailCodes';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';
/** An app build on another origin that calls with a Bearer token (allowed by CORS). */
const OLD_APP = 'https://old.test';
const SESSION = '__Host-evenly_session';
const MARKER = '__Host-evenly_user';
const FROM = '吉諾分帳所 <login@ginochang.com>';
const KEY = 're_test_key_0123456789';
/** The address most tests use: a .test domain, so it is never mailed. */
const E = 'gino@split.test';

let db: TestD1;
/** Vars on top of the defaults (test mode on, no Resend key) for the calls that follow. */
let vars: Record<string, string>;

interface Sent {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}
/** Every request the Worker sent out (only Resend's here). */
let sent: Sent[];
/** How the stubbed Resend answers. */
let resend: (s: Sent) => Response | Promise<Response>;

const ok200 = () => new Response(JSON.stringify({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  db = new TestD1();
  vars = {};
  sent = [];
  resend = ok200;
  vi.stubGlobal('fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    const s: Sent = { url: String(url), init, body: JSON.parse(String(init.body ?? '{}')) };
    sent.push(s);
    return resend(s);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function env() {
  return { DB: db.d1, ALLOWED_ORIGINS: OLD_APP, APP_URL: SITE + '/', ENVIRONMENT: 'test', EMAIL_DEV_ECHO: '1', EMAIL_FROM: FROM, ...vars };
}

interface Call {
  /** app: a page on this origin (the default); cross: an old build elsewhere; script: neither header. */
  from?: 'app' | 'cross' | 'script';
  cookie?: string;
  bearer?: string;
  body?: unknown;
  /** The client's address (cf-connecting-ip). */
  ip?: string;
  /** More request headers; they win over `from`'s. */
  headers?: Record<string, string>;
}

interface Res<T = any> {
  status: number;
  data: T;
  headers: Headers;
  setCookies: string[];
}

async function call<T = any>(method: string, path: string, o: Call = {}): Promise<Res<T>> {
  const h: Record<string, string> = { 'cf-connecting-ip': o.ip ?? '203.0.113.7' };
  const write = method !== 'GET' && method !== 'HEAD';
  const from = o.from ?? 'app';
  if (from === 'app') Object.assign(h, write ? { 'Sec-Fetch-Site': 'same-origin', Origin: SITE } : { 'Sec-Fetch-Site': 'same-origin' });
  if (from === 'cross') Object.assign(h, { 'Sec-Fetch-Site': 'cross-site', Origin: OLD_APP });
  if (o.cookie) h.Cookie = o.cookie;
  if (o.bearer) h.Authorization = 'Bearer ' + o.bearer;
  if (o.body !== undefined) h['Content-Type'] = 'application/json';
  Object.assign(h, o.headers);
  const req = new Request(SITE + path, { method, headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env() as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined, headers: res.headers, setCookies: res.headers.getSetCookie() };
}

const start = (email: string, o: Call & { locale?: string } = {}) =>
  call('POST', '/api/auth/email/start', { ...o, body: { email, ...(o.locale ? { locale: o.locale } : {}) } });
const verify = (email: string, code: string, extra: Record<string, unknown> = {}, o: Call = {}) =>
  call('POST', '/api/auth/email/verify', { ...o, body: { email, code, ...extra } });
const addStart = (token: string, email: string) => call('POST', '/api/me/email/start', { from: 'script', bearer: token, body: { email } });
const addVerify = (token: string, email: string, code: string) => call('POST', '/api/me/email/verify', { from: 'script', bearer: token, body: { email, code } });
const credentials = (token: string, body: Record<string, unknown>) => call('POST', '/api/me/credentials', { from: 'script', bearer: token, body });
const login = (email: string, password: string) => call('POST', '/api/auth/login', { from: 'script', body: { email, password } });

/** A code for `email` (test mode hands it back). */
async function codeFor(email: string, o: Call = {}): Promise<string> {
  const r = await start(email, o);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  expect(r.data.devCode).toMatch(/^[0-9]{6}$/);
  return r.data.devCode;
}

/** Six digits that are not `code`. */
const wrong = (code: string): string => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

interface CodeRowAll {
  id: string;
  email: string;
  purpose: string;
  user_id: string | null;
  code_hash: string;
  attempts: number;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

const codeRows = (email: string) => db.rows<CodeRowAll>('SELECT * FROM email_codes WHERE email = ? ORDER BY created_at, rowid', email);

/** A name-only account, made the way older clients and test scripts do (signup from a script: no cookies). */
async function signup(name: string, ip?: string): Promise<{ token: string; id: string }> {
  const r = await call('POST', '/api/auth/signup', { from: 'script', ip, body: { name } });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return { token: r.data.token, id: r.data.user.id };
}

/**
 * An account from before email codes, with an email nobody confirmed and a password (signup and
 * POST /me/credentials took both then; the App Review demo account is one). Written straight into
 * the table, as nothing makes one now; with a session for its Bearer token.
 */
async function legacyAccount(name: string, email: string, password: string): Promise<{ token: string; id: string }> {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  db.exec(
    'INSERT INTO users (id, name, email, pw_hash, color, activity_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, name, email, await hashPassword(password), '#2F6FB5', at, at, at,
  );
  return { token: await createSession(db.d1, id, 'test'), id };
}

const userRow = (id: string) => db.rows<{ email: string | null; pw_hash: string | null; email_verified_at: string | null; name: string; locale: string; currency: string }>('SELECT * FROM users WHERE id = ?', id)[0];

/** The Cookie header a browser signed in as `id` on this site sends. */
const jar = (token: string, id: string): string => `${SESSION}=${token}; ${MARKER}=${id}`;

function cookiesOf(r: Res): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of r.setCookies) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

// ---------- making a code ----------

describe('making a code', () => {
  it('draws six digits from crypto random, again when a draw would bias the result, leading zeros kept', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    spy.mockImplementationOnce(<T extends ArrayBufferView | null>(a: T): T => {
      (a as unknown as Uint32Array)[0] = 4_294_000_000; // the first value past the last whole 1,000,000s
      return a;
    });
    spy.mockImplementationOnce(<T extends ArrayBufferView | null>(a: T): T => {
      (a as unknown as Uint32Array)[0] = 4_293_999_999;
      return a;
    });
    expect(randomDigits()).toBe('999999');
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockImplementationOnce(<T extends ArrayBufferView | null>(a: T): T => {
      (a as unknown as Uint32Array)[0] = 1_000_042;
      return a;
    });
    expect(randomDigits()).toBe('000042');
    spy.mockRestore();
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = randomDigits();
      expect(c).toMatch(/^[0-9]{6}$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(1990);
  });

  it('keeps only a hash of id + ":" + code, for the address as typed in any case or width, valid 10 minutes', async () => {
    const before = Date.now();
    const r = await start('  Ｇino@Split.TEST ');
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, expiresInSec: CODE_TTL_SEC, devCode: expect.stringMatching(/^[0-9]{6}$/) });
    expect(CODE_TTL_SEC).toBe(600);
    const rows = codeRows(E);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ email: E, purpose: 'sign_in', user_id: null, attempts: 0, used_at: null });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.code_hash).toBe(await sha256Hex(row.id + ':' + r.data.devCode));
    expect(row.code_hash).toBe(await codeHash(row.id, r.data.devCode));
    // No column holds the code itself.
    expect(Object.values(row).some(v => typeof v === 'string' && v.includes(r.data.devCode) && v !== row.code_hash)).toBe(false);
    const made = Date.parse(row.created_at);
    expect(made).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(row.expires_at) - made).toBe(600_000);
  });

  it('normalizes addresses and typed codes, and refuses what is not one', async () => {
    expect(codeEmail('  ＧＩＮＯ＠Ｅｘａｍｐｌｅ．ＣＯＭ ')).toBe('gino@example.com');
    expect(codeEmail('Abbie.Lin+trip@Mail.co.jp')).toBe('abbie.lin+trip@mail.co.jp');
    for (const bad of ['', 'gino', 'gino@', '@x.com', 'gino@localhost', 'gi no@x.com', 'a@b@c.com', 'e'.repeat(109) + '@evenly.test', 42, null]) {
      expect(codeEmail(bad)).toBeNull();
    }
    expect(cleanCode('123456')).toBe('123456');
    expect(cleanCode('１２３ ４５６')).toBe('123456');
    expect(cleanCode(' 123-456 ')).toBe('123456');
    for (const bad of ['12345', '1234567', '12a456', '', 123456]) expect(cleanCode(bad)).toBeNull();
    const r = await start('not an address');
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('validation');
    expect(r.data.error.details).toEqual([{ path: ['email'], message: expect.any(String) }]);
  });

  it('answers the same whether or not an account has the address', async () => {
    await legacyAccount('Leo', 'leo@split.test', 'leo password 1');
    const strip = ({ devCode: _code, ...rest }: Record<string, unknown>) => rest;
    const known = await start('leo@split.test');
    const unknown = await start('nobody@split.test');
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(strip(known.data)).toEqual({ ok: true, expiresInSec: 600 });
    expect(strip(unknown.data)).toEqual(strip(known.data));
  });

  it('a page on another site cannot make the Worker mail anyone (403); the app, allowed origins and clients without Origin can', async () => {
    // A text/plain form post from anywhere needs no preflight: without the check it would send mail.
    const evil = await call('POST', '/api/auth/email/start', {
      from: 'script',
      headers: { Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' },
      body: { email: E },
    });
    expect(evil.status).toBe(403);
    expect(evil.data.error.code).toBe('forbidden');
    const sibling = await call('POST', '/api/auth/email/start', { from: 'script', headers: { Origin: 'https://award.split.test' }, body: { email: E } });
    expect(sibling.status).toBe(403);
    expect(codeRows(E)).toHaveLength(0);
    expect(db.rows('SELECT key FROM rate_limits')).toHaveLength(0);
    expect((await start(E)).status).toBe(200); // the app (same origin)
    expect((await start('a@split.test', { from: 'cross' })).status).toBe(200); // an allowed origin
    expect((await start('b@split.test', { from: 'script' })).status).toBe(200); // the iOS app, scripts
  });

  it('a new code for the same address and purpose replaces the older unused one', async () => {
    const first = await codeFor(E);
    const second = await codeFor(E);
    const rows = codeRows(E);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_hash).toBe(await codeHash(rows[0].id, second));
    if (first !== second) {
      const old = await verify(E, first, { name: 'Gino' });
      expect(old.status).toBe(400);
      expect(old.data.error.code).toBe('code_invalid');
    }
    expect((await verify(E, second, { name: 'Gino' })).status).toBe(200);
  });
});

// ---------- trying a code ----------

describe('trying a code', () => {
  it('works once, within 10 minutes, typed in full width or with a space', async () => {
    const code = await codeFor(E);
    const typed = code.slice(0, 3) + ' ' + code.slice(3).replace(/[0-9]/g, d => String.fromCharCode(0xff10 + Number(d)));
    const r = await verify('GINO@split.test', typed, { name: 'Gino' });
    expect(r.status).toBe(200);
    const again = await verify(E, code, { name: 'Gino' });
    expect(again.status).toBe(400);
    expect(again.data.error.code).toBe('code_invalid');
    expect(codeRows(E)[0].used_at).not.toBeNull();
  });

  it('an expired code fails', async () => {
    const code = await codeFor(E);
    db.exec('UPDATE email_codes SET expires_at = ?', new Date(Date.now() - 1000).toISOString());
    const r = await verify(E, code, { name: 'Gino' });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('code_invalid');
  });

  it(`takes ${CODE_MAX_TRIES} tries, right or wrong; after 5 wrong ones even the right code fails`, async () => {
    const code = await codeFor(E);
    for (let i = 0; i < CODE_MAX_TRIES - 1; i++) expect((await verify(E, wrong(code), { name: 'Gino' })).data.error.code).toBe('code_invalid');
    // The fifth try still counts.
    expect((await verify(E, code, { name: 'Gino' })).status).toBe(200);

    const other = 'abbie@split.test';
    const c2 = await codeFor(other);
    for (let i = 0; i < CODE_MAX_TRIES; i++) expect((await verify(other, wrong(c2), { name: 'Abbie' })).status).toBe(400);
    expect(codeRows(other)[0].attempts).toBe(CODE_MAX_TRIES);
    const late = await verify(other, c2, { name: 'Abbie' });
    expect(late.status).toBe(400);
    expect(late.data.error.code).toBe('code_invalid');
    expect(codeRows(other)[0].attempts).toBe(CODE_MAX_TRIES);
  });

  it('does the same work whether or not a code waits: one hash and a constant-time comparison', async () => {
    const id = crypto.randomUUID();
    const row = { id, code_hash: await codeHash(id, '424242') };
    const digest = vi.spyOn(crypto.subtle, 'digest');
    for (const [r, code, expected] of [[null, '424242', false], [row, '424243', false], [row, '424242', true]] as const) {
      digest.mockClear();
      expect(await codeMatches(r, code)).toBe(expected);
      expect(digest).toHaveBeenCalledTimes(1);
    }
    // A hash that differs only in its last character is still refused (the whole value is compared).
    expect(await codeMatches({ id, code_hash: row.code_hash.slice(0, 63) + (row.code_hash.endsWith('0') ? '1' : '0') }, '424242')).toBe(false);
    digest.mockRestore();
    // On the route, an address with no code waiting fails like a wrong code, and counts the same.
    const none = await verify('nobody@split.test', '123456', { name: 'X' });
    const code = await codeFor(E);
    const bad = await verify(E, wrong(code), { name: 'X' });
    expect(none.status).toBe(400);
    expect(none.data).toEqual(bad.data);
    const counts = db.rows<{ key: string; count: number }>("SELECT key, count FROM rate_limits WHERE key LIKE 'email-verify:%' AND key NOT LIKE 'email-verify:ip:%'");
    expect(counts.map(x => x.count)).toEqual([1, 1]);
  });

  it('a malformed code is refused at once and costs no try', async () => {
    const code = await codeFor(E);
    for (const bad of ['12345', '1234567', 'abcdef']) {
      const r = await verify(E, bad, { name: 'Gino' });
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe('code_invalid');
    }
    expect(codeRows(E)[0].attempts).toBe(0);
    expect((await verify(E, code, { name: 'Gino' })).status).toBe(200);
  });
});

// ---------- limits ----------

describe('limits', () => {
  it(`asking for codes: ${EMAIL_PER_15M} per address in 15 minutes`, async () => {
    for (let i = 0; i < EMAIL_PER_15M; i++) expect((await start(E)).status).toBe(200);
    const r = await start(E);
    expect(r.status).toBe(429);
    expect(r.data.error.code).toBe('rate_limited');
    expect(r.data.error.details.retryAfter).toBeGreaterThan(800);
    expect(r.headers.get('Retry-After')).toBe(String(r.data.error.details.retryAfter));
    // Another address is its own pool; the account route shares the address's pool.
    expect((await start('abbie@split.test')).status).toBe(200);
    const u = await signup('Kai');
    const shared = await addStart(u.token, E);
    expect(shared.status).toBe(429);
  });

  it(`asking for codes: ${EMAIL_PER_DAY} per address a day`, async () => {
    vars = { EMAIL_IP_PER_HOUR: '1000' };
    for (let i = 0; i < EMAIL_PER_DAY; i++) {
      // A new 15-minute window every third code.
      if (i > 0 && i % EMAIL_PER_15M === 0) db.exec("UPDATE rate_limits SET reset_at = 0 WHERE key LIKE 'email-code:15m:%'");
      expect((await start(E)).status, 'code ' + (i + 1)).toBe(200);
    }
    db.exec("UPDATE rate_limits SET reset_at = 0 WHERE key LIKE 'email-code:15m:%'");
    const r = await start(E);
    expect(r.status).toBe(429);
    expect(r.data.error.details.retryAfter).toBeGreaterThan(80_000);
  });

  it(`asking for codes: ${EMAIL_IP_PER_HOUR} per IP an hour by default, EMAIL_IP_PER_HOUR overrides`, async () => {
    for (let i = 0; i < EMAIL_IP_PER_HOUR; i++) expect((await start(`p${i}@split.test`)).status).toBe(200);
    expect((await start('one-more@split.test')).status).toBe(429);
    expect((await start('one-more@split.test', { ip: '198.51.100.20' })).status).toBe(200);
    vars = { EMAIL_IP_PER_HOUR: '2' };
    expect((await start('q1@split.test', { ip: '198.51.100.21' })).status).toBe(200);
    expect((await start('q2@split.test', { ip: '198.51.100.21' })).status).toBe(200);
    expect((await start('q3@split.test', { ip: '198.51.100.21' })).status).toBe(429);
  });

  it(`wrong tries: ${VERIFY_FAILS_PER_EMAIL} per address in 15 minutes, then even a right code waits`, async () => {
    let code = await codeFor(E);
    for (let i = 0; i < VERIFY_FAILS_PER_EMAIL; i++) {
      if (i === CODE_MAX_TRIES) code = await codeFor(E); // the first code is dead after its 5 tries
      expect((await verify(E, wrong(code), { name: 'Gino' })).status).toBe(400);
    }
    const fresh = await codeFor(E);
    const r = await verify(E, fresh, { name: 'Gino' });
    expect(r.status).toBe(429);
    expect(r.data.error.code).toBe('rate_limited');
    // The refused try did not touch the code.
    expect(codeRows(E).find(x => x.used_at === null)?.attempts).toBe(0);
    db.exec("UPDATE rate_limits SET reset_at = 0 WHERE key LIKE 'email-verify:%'");
    expect((await verify(E, fresh, { name: 'Gino' })).status).toBe(200);
  });

  it(`wrong tries: ${VERIFY_FAILS_PER_IP} per IP in 15 minutes, across addresses`, async () => {
    const ip = '198.51.100.9';
    for (let i = 0; i < VERIFY_FAILS_PER_IP; i++) expect((await verify(`n${i}@split.test`, '123456', { name: 'X' }, { ip })).status).toBe(400);
    const code = await codeFor(E, { ip });
    expect((await verify(E, code, { name: 'Gino' }, { ip })).status).toBe(429);
    expect((await verify(E, code, { name: 'Gino' }, { ip: '198.51.100.10' })).status).toBe(200);
  });

  it('keys every limit by IP or a SHA-256 prefix of the address, never the address', async () => {
    const code = await codeFor('Gino.Chang@split.test');
    await verify('gino.chang@split.test', wrong(code), { name: 'G' });
    const keys = db.rows<{ key: string }>('SELECT key FROM rate_limits').map(r => r.key);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const k of keys) {
      expect(k).not.toContain('@');
      expect(k.toLowerCase()).not.toContain('gino');
    }
    const h = (await sha256Hex('gino.chang@split.test')).slice(0, 32);
    expect(keys).toEqual(expect.arrayContaining(['email-code:15m:' + h, 'email-code:day:' + h, 'email-verify:' + h]));
  });

  it(`the whole app sends at most EMAIL_GLOBAL_PER_DAY a UTC day (default ${EMAIL_GLOBAL_PER_DAY}), then 503 email_quota`, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vars = { RESEND_API_KEY: KEY, EMAIL_DEV_ECHO: '0', EMAIL_GLOBAL_PER_DAY: '2' };
    expect((await start('ann@mail.example.org.tw')).status).toBe(200);
    expect((await start('ben@gmail.com', { ip: '198.51.100.30' })).status).toBe(200);
    expect(sent).toHaveLength(2);
    const r = await start('cai@gmail.com', { ip: '198.51.100.31' });
    expect(r.status).toBe(503);
    expect(r.data.error.code).toBe('email_quota');
    const retry = r.data.error.details.retryAfter;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(86_400);
    expect(r.headers.get('Retry-After')).toBe(String(retry));
    expect(sent).toHaveLength(2);
    expect(codeRows('cai@gmail.com')).toHaveLength(0);
    // The day is the key, as Resend's quota resets at 00:00 UTC.
    const day = new Date().toISOString().slice(0, 10);
    expect(db.rows<{ count: number }>('SELECT count FROM rate_limits WHERE key = ?', 'email-send:' + day)[0].count).toBe(3);
    // Codes that are never mailed (test domains) do not use it up.
    expect((await start('dee@evenly.test', { ip: '198.51.100.32' })).status).toBe(200);
  });
});

// ---------- signing in or making an account ----------

describe('POST /api/auth/email/verify', () => {
  it('signs in the account that has the address, which counts as confirmed from then on; one set before email codes is taken over (notice "claimed")', async () => {
    const leo = await legacyAccount('Leo', 'leo@split.test', 'leo password 1');
    expect(userRow(leo.id).email_verified_at).toBeNull();
    const device = await call('POST', '/api/auth/link-code', { from: 'script', bearer: leo.token, body: {} });
    expect(device.status).toBe(200);
    const code = await codeFor('leo@split.test');
    const r = await verify('Leo@Split.test', code);
    expect(r.status).toBe(200);
    expect(r.data.created).toBe(false);
    expect(r.data.notice).toBe('claimed');
    expect(r.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.data.user).toMatchObject({ id: leo.id, name: 'Leo', email: 'leo@split.test', emailVerified: true, hasPassword: false });
    expect(userRow(leo.id).email_verified_at).not.toBeNull();
    // Whoever typed the address in before email codes never proved it was theirs: in the same batch
    // the password went, and every session but this sign-in's ended, with its code for another device.
    expect(userRow(leo.id).pw_hash).toBeNull();
    expect((await login('leo@split.test', 'leo password 1')).status).toBe(401);
    expect((await call('GET', '/api/me', { from: 'script', bearer: leo.token })).status).toBe(401);
    expect(db.rows('SELECT 1 FROM login_codes')).toEqual([]);
    expect(db.rows<{ id: string }>('SELECT id FROM sessions')).toEqual([{ id: await sha256Hex(r.data.token) }]);
    // From then on a code takes nothing (no notice), and the name sent with one for an existing account changes nothing.
    const again = await verify('leo@split.test', await codeFor('leo@split.test'), { name: 'Somebody else' });
    expect(again.data.user.name).toBe('Leo');
    expect(again.data.notice).toBeUndefined();
    const me = await call('GET', '/api/me', { from: 'script', bearer: r.data.token });
    expect(me.data.user.emailVerified).toBe(true);
  });

  it('an unconfirmed email with nothing to take (no password, no session) is confirmed without the notice', async () => {
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    db.exec('INSERT INTO users (id, name, email, color, activity_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, 'Kai', 'kai@split.test', '#2F6FB5', at, at, at);
    const r = await verify('kai@split.test', await codeFor('kai@split.test'));
    expect(r.status).toBe(200);
    expect(r.data.user).toMatchObject({ id, emailVerified: true });
    expect(r.data.notice).toBeUndefined();
  });

  it('makes an account with a name: the address confirmed, no password, language and currency as at signup', async () => {
    const code = await codeFor(E);
    const r = await verify(E, code, { name: '  Gino  ', locale: 'en', currency: 'jpy' });
    expect(r.status).toBe(200);
    expect(r.data.created).toBe(true);
    expect(r.data.user).toMatchObject({ name: 'Gino', email: E, emailVerified: true, hasPassword: false, locale: 'en', currency: 'JPY' });
    const row = userRow(r.data.user.id);
    expect(row.email_verified_at).not.toBeNull();
    expect(row.pw_hash).toBeNull();
    const zh = await verify('kai@split.test', await codeFor('kai@split.test'), { name: 'Kai', locale: 'zh-TW', currency: 'XXX' });
    expect(zh.data.user).toMatchObject({ locale: 'zh-TW', currency: 'TWD' });
    const en = await verify('ann@split.test', await codeFor('ann@split.test'), { name: 'Ann', locale: 'fr' });
    expect(en.data.user).toMatchObject({ locale: 'en', currency: 'USD' });
  });

  it('without an account and without a name: 400 name_required, and the same code still works with one', async () => {
    const code = await codeFor(E);
    for (const extra of [{}, { name: '' }, { name: '   ' }, { name: null }]) {
      const r = await verify(E, code, extra);
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe('name_required');
    }
    expect(codeRows(E)[0].used_at).toBeNull();
    const made = await verify(E, code, { name: 'Gino' });
    expect(made.status).toBe(200);
    expect(made.data.created).toBe(true);
  });

  it('takes a name by signup\'s rule (at most 60 characters) before it looks at the code', async () => {
    const code = await codeFor(E);
    const long = await verify(E, code, { name: 'x'.repeat(61) });
    expect(long.status).toBe(400);
    expect(long.data.error.code).toBe('validation');
    expect(codeRows(E)[0].attempts).toBe(0);
    expect((await verify(E, code, { name: 'x'.repeat(60) })).data.user.name).toBe('x'.repeat(60));
  });

  it('from the app on this origin: both cookies, and the session the browser held before ends (no 409, unlike signup)', async () => {
    const dev = await call('POST', '/api/auth/signup', { body: { name: 'Kevin' } });
    expect(dev.status).toBe(200);
    const devToken: string = dev.data.token;
    const code = await codeFor(E);
    const r = await verify(E, code, { name: 'Gino' }, { cookie: jar(devToken, dev.data.user.id) });
    expect(r.status).toBe(200);
    const c = cookiesOf(r);
    expect(c[SESSION]).toBe(r.data.token);
    expect(c[MARKER]).toBe(r.data.user.id);
    expect(db.rows('SELECT 1 FROM sessions WHERE id = ?', await sha256Hex(devToken))).toHaveLength(0);
    expect(db.rows('SELECT 1 FROM sessions WHERE id = ?', await sha256Hex(r.data.token))).toHaveLength(1);
  });

  it('from another origin (an old build): the token, no cookies, and the browser\'s session stays', async () => {
    const dev = await call('POST', '/api/auth/signup', { body: { name: 'Kevin' } });
    const code = await codeFor(E, { from: 'cross' });
    const r = await verify(E, code, { name: 'Gino' }, { from: 'cross', cookie: jar(dev.data.token, dev.data.user.id) });
    expect(r.status).toBe(200);
    expect(r.setCookies).toEqual([]);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(OLD_APP);
    expect(db.rows('SELECT 1 FROM sessions WHERE id = ?', await sha256Hex(dev.data.token))).toHaveLength(1);
  });

  it('a sign-in code cannot add an email to an account, and an add-email code cannot sign in', async () => {
    const u = await signup('Kai');
    const signIn = await codeFor(E);
    const add = await addVerify(u.token, E, signIn);
    expect(add.status).toBe(400);
    expect(add.data.error.code).toBe('code_invalid');
    const other = 'abbie@split.test';
    const addCode = (await addStart(u.token, other)).data.devCode;
    const wrongWay = await verify(other, addCode, { name: 'Abbie' });
    expect(wrongWay.status).toBe(400);
    expect(wrongWay.data.error.code).toBe('code_invalid');
  });
});

// ---------- adding or changing the account's email ----------

describe('POST /api/me/email/start and /verify', () => {
  it('needs a session', async () => {
    const r = await call('POST', '/api/me/email/start', { from: 'script', body: { email: E } });
    expect(r.status).toBe(401);
    const v = await call('POST', '/api/me/email/verify', { from: 'script', body: { email: E, code: '123456' } });
    expect(v.status).toBe(401);
  });

  it('puts a confirmed email on a device-only account', async () => {
    const u = await signup('Kai');
    const s = await addStart(u.token, '  Kai@Split.test');
    expect(s.status).toBe(200);
    expect(s.data).toEqual({ ok: true, expiresInSec: 600, devCode: expect.stringMatching(/^[0-9]{6}$/) });
    const row = codeRows('kai@split.test')[0];
    expect(row).toMatchObject({ purpose: 'add_email', user_id: u.id });
    const v = await addVerify(u.token, 'kai@split.test', s.data.devCode);
    expect(v.status).toBe(200);
    expect(v.data).toEqual({ user: expect.objectContaining({ id: u.id, email: 'kai@split.test', emailVerified: true, hasPassword: false }), passwordCleared: false });
    expect(userRow(u.id)).toMatchObject({ email: 'kai@split.test', pw_hash: null });
    // Now the address signs in to this account.
    const back = await verify('kai@split.test', await codeFor('kai@split.test'));
    expect(back.data).toMatchObject({ created: false, user: { id: u.id } });
  });

  it('409 email_taken when another account has the address, at start and at verify', async () => {
    await legacyAccount('Leo', 'leo@split.test', 'leo password 1');
    const u = await signup('Kai');
    const r = await addStart(u.token, 'LEO@split.test');
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('email_taken');
    expect(codeRows('leo@split.test')).toHaveLength(0);
    // Taken while the code was on its way: Ann signs up with a code of her own (a sign-in code,
    // so it does not replace Kai's add-email code).
    const code = (await addStart(u.token, 'ann@split.test')).data.devCode;
    expect((await verify('ann@split.test', await codeFor('ann@split.test'), { name: 'Ann' })).data.created).toBe(true);
    const late = await addVerify(u.token, 'ann@split.test', code);
    expect(late.status).toBe(409);
    expect(late.data.error.code).toBe('email_taken');
    expect(userRow(u.id).email).toBeNull();
  });

  it("a code made for one account does not work for another", async () => {
    const a = await signup('Abbie');
    const b = await signup('Ben');
    const code = (await addStart(a.token, E)).data.devCode;
    const stolen = await addVerify(b.token, E, code);
    expect(stolen.status).toBe(400);
    expect(stolen.data.error.code).toBe('code_invalid');
    expect(userRow(b.id).email).toBeNull();
    expect((await addVerify(a.token, E, code)).status).toBe(200);
  });

  it('a new email removes the password, whose key was salted with the old one (passwordCleared)', async () => {
    const leo = await legacyAccount('Leo', 'leo@split.test', 'leo password 1');
    const code = (await addStart(leo.token, 'leo.new@split.test')).data.devCode;
    const r = await addVerify(leo.token, 'leo.new@split.test', code);
    expect(r.status).toBe(200);
    expect(r.data.passwordCleared).toBe(true);
    expect(r.data.user).toMatchObject({ email: 'leo.new@split.test', emailVerified: true, hasPassword: false });
    expect(userRow(leo.id).pw_hash).toBeNull();
    expect((await login('leo.new@split.test', 'leo password 1')).status).toBe(401);
    expect((await login('leo@split.test', 'leo password 1')).status).toBe(401);
    // The session that changed it keeps working.
    expect((await call('GET', '/api/me', { from: 'script', bearer: leo.token })).status).toBe(200);
  });

  it('confirming the email the account already has keeps its password', async () => {
    const leo = await legacyAccount('Leo', 'leo@split.test', 'leo password 1');
    const code = (await addStart(leo.token, 'leo@split.test')).data.devCode;
    const r = await addVerify(leo.token, 'leo@split.test', code);
    expect(r.status).toBe(200);
    expect(r.data.passwordCleared).toBe(false);
    expect(r.data.user).toMatchObject({ email: 'leo@split.test', emailVerified: true, hasPassword: true });
    expect((await login('leo@split.test', 'leo password 1')).status).toBe(200);
  });

  it('touches no group: no group shows anyone\'s email', async () => {
    const u = await signup('Kai');
    const g = await call('POST', '/api/groups', { from: 'script', bearer: u.token, body: { name: 'Niseko', type: 'trip', currency: 'JPY' } });
    expect(g.status).toBe(200);
    const version = () => db.rows<{ version: number }>('SELECT version FROM groups WHERE id = ?', g.data.group.id)[0].version;
    const before = version();
    const code = (await addStart(u.token, E)).data.devCode;
    expect((await addVerify(u.token, E, code)).status).toBe(200);
    expect(version()).toBe(before);
    const snap = await call('GET', '/api/groups/' + g.data.group.id, { from: 'script', bearer: u.token });
    expect(JSON.stringify(snap.data)).not.toContain(E);
  });
});

// ---------- signup ----------

describe('POST /api/auth/signup takes a name only', () => {
  it('an email or a password in the body is 400 email_requires_code, and nothing is made', async () => {
    for (const extra of [
      { email: 'leo@split.test', password: 'leo password 1' },
      { email: 'leo@split.test' },
      { email: ' Leo@Split.test ', password: null },
      { password: 'leo password 1' },
    ]) {
      const r = await call('POST', '/api/auth/signup', { from: 'script', body: { name: 'Leo', ...extra } });
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(r.data.error.code).toBe('email_requires_code');
      expect(r.data.error.message).toBe('Add an email with a code: POST /api/auth/email/start');
    }
    expect(db.rows('SELECT 1 FROM users')).toHaveLength(0);
    expect(db.rows('SELECT 1 FROM sessions')).toHaveLength(0);
    // The same answer for an address an account has: signup tells nobody who uses the service.
    await legacyAccount('Leo', 'leo@split.test', 'leo password 1');
    const taken = await call('POST', '/api/auth/signup', { from: 'script', body: { name: 'Leo 2', email: 'leo@split.test', password: 'x password 2' } });
    expect(taken.status).toBe(400);
    expect(taken.data.error.code).toBe('email_requires_code');
    expect(db.rows('SELECT 1 FROM users')).toHaveLength(1);
  });

  it('a name alone still makes a device-only account, also with the keys sent empty or null (older clients)', async () => {
    for (const extra of [{}, { email: null, password: null }, { email: '', password: '' }, { email: '   ' }]) {
      const r = await call('POST', '/api/auth/signup', { from: 'script', body: { name: 'Kai', locale: 'en', ...extra } });
      expect(r.status, JSON.stringify(extra)).toBe(200);
      expect(r.data.user).toMatchObject({ name: 'Kai', email: null, emailVerified: false, hasPassword: false, locale: 'en', currency: 'USD' });
      expect(r.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(db.rows('SELECT 1 FROM users WHERE email IS NULL AND pw_hash IS NULL')).toHaveLength(4);
  });
});

// ---------- the password route ----------

describe('POST /api/me/credentials no longer sets an email', () => {
  it('refuses to put an email on an account (400 email_unconfirmed), and writes nothing', async () => {
    const u = await signup('Kai');
    const r = await credentials(u.token, { email: 'kai@split.test', password: 'kai password 1' });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('email_unconfirmed');
    expect(userRow(u.id)).toMatchObject({ email: null, pw_hash: null });
  });

  it('a confirmed email can get a password, and change it with the current one; a new email still needs a code', async () => {
    const r = await verify(E, await codeFor(E), { name: 'Gino' });
    const token: string = r.data.token;
    const set = await credentials(token, { email: E, password: 'gino password 1' });
    expect(set.status).toBe(200);
    expect(set.data.user).toMatchObject({ email: E, emailVerified: true, hasPassword: true });
    expect((await login(E, 'gino password 1')).status).toBe(200);
    expect((await credentials(token, { email: E, password: 'gino password 2' })).data.error.code).toBe('invalid_credentials');
    expect((await credentials(token, { email: E, password: 'gino password 2', currentPassword: 'gino password 1' })).status).toBe(200);
    const moved = await credentials(token, { email: 'other@split.test', password: 'gino password 3', currentPassword: 'gino password 2' });
    expect(moved.status).toBe(400);
    expect(moved.data.error.code).toBe('email_unconfirmed');
    expect(userRow(r.data.user.id).email).toBe(E);
  });

  it('an account from before email codes with a password (the App Review demo account) still changes it', async () => {
    const demo = await legacyAccount('App Review', 'appreview@ginochang.com', 'review password 1');
    expect(userRow(demo.id).email_verified_at).toBeNull();
    const r = await credentials(demo.token, { email: 'appreview@ginochang.com', password: 'review password 2', currentPassword: 'review password 1' });
    expect(r.status).toBe(200);
    expect(r.data.user).toMatchObject({ email: 'appreview@ginochang.com', emailVerified: false, hasPassword: true });
    expect((await login('appreview@ginochang.com', 'review password 2')).status).toBe(200);
    const moved = await credentials(demo.token, { email: 'someone@ginochang.com', password: 'review password 3', currentPassword: 'review password 2' });
    expect(moved.data.error.code).toBe('email_unconfirmed');
  });
});

// ---------- test mode and Resend ----------

describe('test mode', () => {
  it('echoes only with EMAIL_DEV_ECHO "1" outside production, whatever the flag says there', () => {
    expect(canEcho({ EMAIL_DEV_ECHO: '1', ENVIRONMENT: 'staging' })).toBe(true);
    expect(canEcho({ EMAIL_DEV_ECHO: '1', ENVIRONMENT: 'test' })).toBe(true);
    expect(canEcho({ EMAIL_DEV_ECHO: '1', ENVIRONMENT: 'production' })).toBe(false);
    expect(canEcho({ EMAIL_DEV_ECHO: '1', ENVIRONMENT: ' Production ' })).toBe(false);
    expect(canEcho({ EMAIL_DEV_ECHO: '1', ENVIRONMENT: '' })).toBe(false);
    expect(canEcho({ EMAIL_DEV_ECHO: '1' } as never)).toBe(false);
    expect(canEcho({ EMAIL_DEV_ECHO: '0', ENVIRONMENT: 'staging' })).toBe(false);
    expect(canEcho({ ENVIRONMENT: 'staging' } as never)).toBe(false);
    expect(canSend({ RESEND_API_KEY: KEY, EMAIL_FROM: FROM })).toBe(true);
    expect(canSend({ RESEND_API_KEY: KEY })).toBe(false);
    expect(canSend({ EMAIL_FROM: FROM })).toBe(false);
  });

  it('production never answers with the code: without the key 503 email_unavailable, with it the code goes only by email', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vars = { ENVIRONMENT: 'production', EMAIL_DEV_ECHO: '1' };
    const r = await start(E);
    expect(r.status).toBe(503);
    expect(r.data.error.code).toBe('email_unavailable');
    expect(r.data.error.details).toBeUndefined();
    expect(codeRows(E)).toHaveLength(0);
    const u = await signup('Kai');
    expect((await addStart(u.token, 'kai@gmail.com')).data.error.code).toBe('email_unavailable');
    vars = { ENVIRONMENT: 'production', EMAIL_DEV_ECHO: '1', RESEND_API_KEY: KEY };
    const mailed = await start('gino@gmail.com');
    expect(mailed.status).toBe(200);
    expect(mailed.data).toEqual({ ok: true, expiresInSec: 600 });
    expect(sent).toHaveLength(1);
    const added = await addStart(u.token, 'kai@gmail.com');
    expect(added.data).toEqual({ ok: true, expiresInSec: 600 });
    expect(sent).toHaveLength(2);
  });

  it('staging without the key only echoes; with the key it mails as well', async () => {
    vars = { ENVIRONMENT: 'staging', EMAIL_DEV_ECHO: '1' };
    const echoed = await start('gino@gmail.com');
    expect(echoed.data.devCode).toMatch(/^[0-9]{6}$/);
    expect(sent).toHaveLength(0);
    vars = { ENVIRONMENT: 'staging', EMAIL_DEV_ECHO: '1', RESEND_API_KEY: KEY };
    const both = await start('abbie@gmail.com');
    expect(both.data.devCode).toMatch(/^[0-9]{6}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.subject).toBe('吉諾分帳所驗證碼：' + both.data.devCode);
  });
});

describe('mail through Resend (a stubbed fetch)', () => {
  beforeEach(() => {
    vars = { RESEND_API_KEY: KEY, EMAIL_DEV_ECHO: '0' };
  });

  /** The code a message carries, from its subject. */
  const codeOf = (s: Sent): string => /([0-9]{6})$/.exec(String(s.body.subject))![1];

  it('posts from, to, reply_to, the subject in the language asked for, text and html, and nothing else', async () => {
    const r = await start(' Abbie@Gmail.com', { locale: 'en' });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, expiresInSec: 600 });
    expect(sent).toHaveLength(1);
    const s = sent[0];
    expect(s.url).toBe(RESEND_URL);
    expect(RESEND_URL).toBe('https://api.resend.com/emails');
    expect(s.init.method).toBe('POST');
    const headers = new Headers(s.init.headers);
    expect(headers.get('Authorization')).toBe('Bearer ' + KEY);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(Object.keys(s.body).sort()).toEqual(['from', 'html', 'reply_to', 'subject', 'text', 'to']);
    expect(s.body).toMatchObject({ from: FROM, to: 'abbie@gmail.com', reply_to: EMAIL_REPLY_TO });
    expect(EMAIL_REPLY_TO).toBe('gino@ginochang.com');
    const code = codeOf(s);
    expect(s.body.subject).toBe("Gino's Split Lab code: " + code);
    const row = codeRows('abbie@gmail.com')[0];
    expect(row.code_hash).toBe(await codeHash(row.id, code));
    // zh-TW when the start says nothing.
    await start('kai@gmail.com');
    expect(sent[1].body.subject).toBe('吉諾分帳所驗證碼：' + codeOf(sent[1]));
    // The account's own language for an email it adds.
    const u = await signup('Leo');
    await call('PATCH', '/api/me', { from: 'script', bearer: u.token, body: { locale: 'en' } });
    await addStart(u.token, 'leo@gmail.com');
    expect(sent[2].body.subject).toBe("Gino's Split Lab code: " + codeOf(sent[2]));
  });

  it('the message: the code, valid 10 minutes, ignore it if it was not you, the picture-book colors, one link and no tracking', () => {
    for (const [locale, valid, notYou] of [
      ['zh-TW', '10 分鐘內有效', '不是你本人操作的話，忽略這封信就好'],
      ['en', 'valid for 10 minutes', 'If this was not you, ignore this email'],
    ] as const) {
      const m = codeMessage(locale, '012345');
      for (const part of [m.text, m.html]) {
        expect(part).toContain('012345');
        expect(part).toContain(valid);
        expect(part).toContain(notYou);
      }
      expect(m.text.match(/https?:\/\/[^\s]+/g)).toEqual([EMAIL_APP_LINK]);
      expect([...m.html.matchAll(/href="([^"]*)"/g)].map(x => x[1])).toEqual([EMAIL_APP_LINK]);
      expect(m.html.match(/https?:\/\//g)).toHaveLength(1);
      expect(EMAIL_APP_LINK).toBe('https://split.ginochang.com/');
      expect(m.html).not.toMatch(/<img|<link|<script|url\(|@import|background-image/i);
      expect(m.html).toContain('#FFFCF6');
      expect(m.html).toContain('#3E3A39');
      expect(m.html).toMatch(/font-size:3[0-9]px[^>]*>012345</);
    }
    expect(codeMessage('zh-TW', '012345').subject).toBe('吉諾分帳所驗證碼：012345');
    expect(codeMessage('en', '012345').subject).toBe("Gino's Split Lab code: 012345");
  });

  it('a message Resend refuses takes its code with it: 503 email_unavailable, or email_quota when its quota is used up', async () => {
    const errorOut = vi.spyOn(console, 'error').mockImplementation(() => {});
    const answers: [number, string, string][] = [
      [500, 'application_error', 'email_unavailable'],
      [401, 'validation_error', 'email_unavailable'],
      [403, 'validation_error', 'email_unavailable'],
      [429, 'rate_limit_exceeded', 'email_unavailable'],
      [429, 'daily_quota_exceeded', 'email_quota'],
      [429, 'monthly_quota_exceeded', 'email_quota'],
    ];
    let n = 0;
    for (const [status, name, code] of answers) {
      const email = `someone${n++}@gmail.com`;
      resend = () => new Response(JSON.stringify({ statusCode: status, name, message: `Nope for ${email}` }), { status });
      const r = await start(email, { ip: '198.51.100.' + n });
      expect(r.status, name).toBe(503);
      expect(r.data.error.code, name).toBe(code);
      expect(codeRows(email), name).toHaveLength(0);
    }
    resend = () => {
      throw new TypeError('fetch failed');
    };
    const offline = await start('offline@gmail.com', { ip: '198.51.100.99' });
    expect(offline.data.error.code).toBe('email_unavailable');
    expect(errorOut).toHaveBeenCalled();
  });

  it('logs neither the code, the key nor the address', async () => {
    const lines: string[] = [];
    const keep = (...args: unknown[]) => {
      lines.push(args.map(a => (a instanceof Error ? a.message + ' ' + a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    vi.spyOn(console, 'error').mockImplementation(keep);
    vi.spyOn(console, 'log').mockImplementation(keep);
    vi.spyOn(console, 'warn').mockImplementation(keep);
    let code = '';
    resend = s => {
      code = codeOf(s);
      return new Response(JSON.stringify({ name: 'validation_error', message: 'Invalid `to`: secret.person@gmail.com' }), { status: 422 });
    };
    const r = await start('Secret.Person@gmail.com');
    expect(r.status).toBe(503);
    resend = () => {
      throw new TypeError('fetch failed');
    };
    await start('secret.person2@gmail.com');
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    expect(all).not.toMatch(/secret\.person/i);
    expect(all).not.toContain(KEY);
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(all).not.toContain(code);
    expect(all).toContain('422 validation_error');
  });

  it(`gives up after ${EMAIL_TIMEOUT_MS / 1000} s without an answer`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resend = s =>
      new Promise((_resolve, reject) => {
        s.init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    const p = sendEmail({ ...env(), RESEND_API_KEY: KEY } as never, { to: 'a@gmail.com', subject: 's', text: 't', html: 'h' });
    const outcome = p.then(() => 'sent', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(EMAIL_TIMEOUT_MS - 1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(err).toBeInstanceOf(EmailError);
    expect((err as EmailError).reason).toBe('unavailable');
  });

  it('mails nothing to domains that never get mail (test addresses): the code is made all the same', async () => {
    for (const e of ['a@evenly.test', 'b@sub.example', 'c@example.com', 'd@mail.example.org', 'e@x.invalid', 'f@localhost.localhost']) {
      expect(undeliverable(e), e).toBe(true);
    }
    for (const e of ['a@gmail.com', 'b@ginochang.com', 'c@example.com.tw', 'd@testing.com']) expect(undeliverable(e), e).toBe(false);
    const r = await start('e2e-1@evenly.test');
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(codeRows('e2e-1@evenly.test')).toHaveLength(1);
  });

  it('without EMAIL_FROM nothing goes out (503 email_unavailable)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vars = { RESEND_API_KEY: KEY, EMAIL_DEV_ECHO: '0', EMAIL_FROM: '' };
    const r = await start('a@gmail.com');
    expect(r.status).toBe(503);
    expect(r.data.error.code).toBe('email_unavailable');
    expect(sent).toHaveLength(0);
  });
});

// ---------- cleanup and deletion ----------

describe('cleanup', () => {
  it('the daily job deletes email codes once they expire, used or not, and keeps live ones', async () => {
    await codeFor('old@split.test');
    const used = await codeFor('used@split.test');
    await verify('used@split.test', used, { name: 'U' });
    await codeFor('live@split.test');
    const past = new Date(Date.now() - 60_000).toISOString();
    db.exec("UPDATE email_codes SET expires_at = ? WHERE email IN ('old@split.test', 'used@split.test')", past);
    const res = await db.d1.batch(cleanupStmts(db.d1, new Date()) as never);
    expect((res as { meta: { changes: number } }[])[5].meta.changes).toBe(2);
    expect(codeRows('old@split.test')).toHaveLength(0);
    expect(codeRows('used@split.test')).toHaveLength(0);
    expect(codeRows('live@split.test')).toHaveLength(1);
  });

  it('deleting the account deletes the codes it asked for, also by the cascade; the export says nothing about codes', async () => {
    const u = await signup('Kai');
    expect((await addStart(u.token, E)).status).toBe(200);
    const signInCode = await codeFor('kai@split.test');
    const ex = await call('GET', '/api/me/export', { from: 'script', bearer: u.token });
    expect(ex.status).toBe(200);
    expect(JSON.stringify(ex.data)).not.toMatch(/code_hash|email_codes|devCode|"codes"/);
    expect(JSON.stringify(ex.data)).not.toContain(signInCode + '"');
    const del = await call('DELETE', '/api/me', { from: 'script', bearer: u.token, body: {} });
    expect(del.status).toBe(200);
    expect(db.rows("SELECT 1 FROM email_codes WHERE purpose = 'add_email'")).toHaveLength(0);
    // A sign-in code belongs to the address, not the account: the daily cleanup takes it.
    expect(codeRows('kai@split.test')).toHaveLength(1);

    const v = await signup('Vic');
    await addStart(v.token, 'vic@split.test');
    db.exec('DELETE FROM users WHERE id = ?', v.id);
    expect(codeRows('vic@split.test')).toHaveLength(0);
  });
});
