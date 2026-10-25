// The session cookie on the app's own origin (docs/PLAN-push-scan-cookies.md section 1): which
// requests get the cookies, which may use them, how they are cleared and kept fresh, and that
// Bearer callers (old app builds, scripts, tests) see no change. Runs the real Worker against the
// real schema in SQLite (tests/worker/d1-sqlite.ts) with https://split.test as the app's origin.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/worker/services/fx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/worker/services/fx')>();
  return { ...actual, getUsdRates: vi.fn(async (_db: unknown, date: string) => ({ date, rates: { USD: 1, TWD: 32.3, JPY: 150.2 }, source: 'test' })) };
});

import { createSession, SESSION_DAYS } from '../../src/worker/auth';
import { sha256Hex } from '../../src/worker/http';
import worker from '../../src/worker/index';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';
/** A sibling site: same-site for SameSite=Lax, so the browser still sends the cookie from it. */
const SIBLING = 'https://award.split.test';
/** An app build on another origin that calls with a Bearer token (allowed by CORS). */
const OLD_APP = 'https://old.test';

const SESSION = '__Host-evenly_session';
const MARKER = '__Host-evenly_user';
const YEAR_S = SESSION_DAYS * 86_400;

let db: TestD1;

type From = 'app' | 'app-origin-only' | 'sibling' | 'cross' | 'script';

interface Call {
  from?: From;
  cookie?: string;
  bearer?: string;
  /** X-Evenly-User: the account the page expects. */
  user?: string;
  body?: unknown;
  /** More request headers (Fetch Metadata of a page load, Accept); they win over `from`'s. */
  headers?: Record<string, string>;
}

interface Res<T = any> {
  status: number;
  data: T;
  headers: Headers;
  /** Set-Cookie lines, in order. */
  setCookies: string[];
}

/** What a browser adds: Sec-Fetch-Site always, Origin on writes (and on cross-origin requests). */
function sourceHeaders(from: From, method: string): Record<string, string> {
  const write = method !== 'GET' && method !== 'HEAD';
  switch (from) {
    case 'app': return write ? { 'Sec-Fetch-Site': 'same-origin', Origin: SITE } : { 'Sec-Fetch-Site': 'same-origin' };
    // Safari before 16.4 sends no Sec-Fetch-Site; a write still carries Origin.
    case 'app-origin-only': return write ? { Origin: SITE } : {};
    case 'sibling': return { 'Sec-Fetch-Site': 'same-site', Origin: SIBLING };
    case 'cross': return { 'Sec-Fetch-Site': 'cross-site', Origin: OLD_APP };
    case 'script': return {};
  }
}

async function call<T = any>(method: string, path: string, o: Call = {}): Promise<Res<T>> {
  const h: Record<string, string> = { ...sourceHeaders(o.from ?? 'app', method), ...o.headers };
  if (o.cookie) h.Cookie = o.cookie;
  if (o.bearer) h.Authorization = 'Bearer ' + o.bearer;
  if (o.user) h['X-Evenly-User'] = o.user;
  if (o.body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request(SITE + path, { method, headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  // Test mode (EMAIL_DEV_ECHO): an email code comes back in the start answer.
  const env = { DB: db.d1, ALLOWED_ORIGINS: OLD_APP, APP_URL: SITE + '/', ENVIRONMENT: 'test', EMAIL_DEV_ECHO: '1', ASSETS: assets };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env, ctx);
  const text = await res.text();
  const isJson = (res.headers.get('Content-Type') || '').includes('json');
  return { status: res.status, data: text ? (isJson ? JSON.parse(text) : text) : undefined, headers: res.headers, setCookies: res.headers.getSetCookie() };
}

/** The built app as Workers Static Assets serves it (index.html for a page load). */
const assets = {
  fetch: async (req: Request) =>
    new Response(req.method === 'HEAD' ? null : '<!doctype html><div id="root"></div>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: '"build-1"' },
    }),
};

interface SetCookie {
  name: string;
  value: string;
  /** Attributes, lowercased ("httponly", "max-age=31536000"). */
  attrs: string[];
}

function parseSetCookie(line: string): SetCookie {
  const [pair, ...attrs] = line.split(';').map(s => s.trim());
  const eq = pair.indexOf('=');
  return { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)), attrs: attrs.map(a => a.toLowerCase()) };
}

function cookiesOf(r: Res): Record<string, SetCookie> {
  const out: Record<string, SetCookie> = {};
  for (const line of r.setCookies) {
    const c = parseSetCookie(line);
    out[c.name] = c;
  }
  return out;
}

const cleared = (c: SetCookie | undefined): boolean => !!c && c.value === '' && c.attrs.includes('max-age=0');

/** Both cookies expired by this response. */
function clearsBoth(r: Res): boolean {
  const c = cookiesOf(r);
  return cleared(c[SESSION]) && cleared(c[MARKER]);
}

/** The Cookie header a browser would send for these values. */
const jar = (token: string, userId?: string): string => `${SESSION}=${token}` + (userId ? `; ${MARKER}=${userId}` : '');

async function sessionCount(userId?: string): Promise<number> {
  const rows = userId ? db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', userId) : db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM sessions');
  return rows[0].n;
}

async function sessionExists(token: string): Promise<boolean> {
  return db.rows('SELECT 1 FROM sessions WHERE id = ?', await sha256Hex(token)).length === 1;
}

/**
 * An account with an email and a password, made from a script (no cookies) the only way there is
 * now: an email code (test mode hands it back), then the password. Its Bearer token and id.
 */
async function passwordAccount(name: string, email: string, password: string): Promise<{ token: string; userId: string }> {
  const start = await call('POST', '/api/auth/email/start', { from: 'script', body: { email } });
  const made = await call('POST', '/api/auth/email/verify', { from: 'script', body: { email, code: start.data.devCode, name } });
  expect(made.status).toBe(200);
  const set = await call('POST', '/api/me/credentials', { from: 'script', bearer: made.data.token, body: { email, password } });
  expect(set.status).toBe(200);
  return { token: made.data.token, userId: made.data.user.id };
}

/** A device-only account made by the app on this origin: its token and the cookie it got. */
async function appSignup(name: string): Promise<{ token: string; userId: string; cookie: string }> {
  const r = await call('POST', '/api/auth/signup', { body: { name } });
  expect(r.status).toBe(200);
  return { token: r.data.token, userId: r.data.user.id, cookie: jar(r.data.token, r.data.user.id) };
}

beforeEach(() => {
  db = new TestD1();
});

// ---------- getting the cookies ----------

describe('signing in sets the cookies only for the app on this origin', () => {
  it('a same-origin signup sets the HttpOnly session cookie and the readable marker, and still returns the token', async () => {
    const r = await call('POST', '/api/auth/signup', { body: { name: 'Gino' } });
    expect(r.status).toBe(200);
    const token: string = r.data.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const c = cookiesOf(r);
    expect(c[SESSION].value).toBe(token);
    expect(c[SESSION].attrs).toEqual(expect.arrayContaining([`max-age=${YEAR_S}`, 'path=/', 'httponly', 'secure', 'samesite=lax']));
    expect(c[SESSION].attrs.some(a => a.startsWith('domain'))).toBe(false);
    expect(c[MARKER].value).toBe(r.data.user.id);
    expect(c[MARKER].attrs).toEqual(expect.arrayContaining([`max-age=${YEAR_S}`, 'path=/', 'secure', 'samesite=lax']));
    expect(c[MARKER].attrs).not.toContain('httponly');
    expect(c[MARKER].attrs.some(a => a.startsWith('domain'))).toBe(false);
    // One session row, keyed by SHA-256 of the same token the cookie holds.
    expect(await sessionExists(token)).toBe(true);
    expect(await sessionCount()).toBe(1);
  });

  it('older Safari (Origin, no Sec-Fetch-Site) counts as same-origin', async () => {
    const r = await call('POST', '/api/auth/signup', { from: 'app-origin-only', body: { name: 'Gino' } });
    expect(r.status).toBe(200);
    expect(cookiesOf(r)[SESSION]?.value).toBe(r.data.token);
  });

  it('a cross-origin signup (an old app build) gets the token and no cookies', async () => {
    const r = await call('POST', '/api/auth/signup', { from: 'cross', body: { name: 'Abbie' } });
    expect(r.status).toBe(200);
    expect(r.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.setCookies).toEqual([]);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(OLD_APP);
    expect(r.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    // The token works as Bearer, as before.
    const me = await call('GET', '/api/me', { from: 'cross', bearer: r.data.token });
    expect(me.status).toBe(200);
    expect(me.data.user.name).toBe('Abbie');
  });

  it('a sibling site, a Sec-Fetch-Site: same-site page or a script without headers gets no cookies', async () => {
    for (const from of ['sibling', 'script'] as const) {
      const r = await call('POST', '/api/auth/signup', { from, body: { name: 'x-' + from } });
      expect(r.status, from).toBe(200);
      expect(r.setCookies, from).toEqual([]);
    }
  });

  it('login, link and reset set the cookies too and replace the session this browser held before', async () => {
    // An account with a password, made from a script (no cookies).
    const s = await passwordAccount('Leo', 'leo@split.test', 'leo password 1');
    const leo = s.userId;
    // This browser is signed in as a device-only account first.
    const dev = await appSignup('Kevin');

    const login = await call('POST', '/api/auth/login', { cookie: dev.cookie, body: { email: 'leo@split.test', password: 'leo password 1' } });
    expect(login.status).toBe(200);
    const lc = cookiesOf(login);
    expect(lc[SESSION].value).toBe(login.data.token);
    expect(lc[MARKER].value).toBe(leo);
    // The session the cookie held is gone; the account itself stays.
    expect(await sessionExists(dev.token)).toBe(false);
    expect(db.rows('SELECT 1 FROM users WHERE id = ?', dev.userId)).toHaveLength(1);

    // Link: a code from the Bearer session, spent by this browser.
    const code = await call('POST', '/api/auth/link-code', { from: 'script', bearer: s.token, body: {} });
    const link = await call('POST', '/api/auth/link', { cookie: jar(login.data.token, leo), body: { code: code.data.code } });
    expect(link.status).toBe(200);
    expect(cookiesOf(link)[SESSION].value).toBe(link.data.token);
    expect(await sessionExists(login.data.token)).toBe(false);

    // Reset (link made on the admin page): every session of the account goes, this browser gets a new one.
    const resetToken = 'reset-token-' + 'x'.repeat(30);
    db.exec(
      "INSERT INTO login_codes (id, user_id, kind, expires_at, used_at, created_at) VALUES (?, ?, 'reset', ?, NULL, ?)",
      await sha256Hex(resetToken), leo, new Date(Date.now() + 600_000).toISOString(), new Date().toISOString(),
    );
    const reset = await call('POST', '/api/auth/reset', { cookie: jar(link.data.token, leo), body: { token: resetToken, password: 'leo password 2' } });
    expect(reset.status).toBe(200);
    expect(cookiesOf(reset)[SESSION].value).toBe(reset.data.token);
    expect(await sessionCount(leo)).toBe(1);
    expect(await sessionExists(reset.data.token)).toBe(true);
  });

  it('a login from another site with the cookie neither replaces nor deletes this browser\'s session', async () => {
    await passwordAccount('Attacker', 'evil@split.test', 'evil password 1');
    const dev = await appSignup('Abbie');
    const r = await call('POST', '/api/auth/login', { from: 'sibling', cookie: dev.cookie, body: { email: 'evil@split.test', password: 'evil password 1' } });
    expect(r.status).toBe(200);
    expect(r.setCookies).toEqual([]);
    expect(await sessionExists(dev.token)).toBe(true);
  });
});

describe('signup over a live session cookie', () => {
  it('is 409 already_signed_in with the account id, creates nothing, and sends the cookies again', async () => {
    const dev = await appSignup('Gino');
    const users = db.rows('SELECT id FROM users').length;
    // Safari wiped the page's storage, the marker is lost too in this test: the session cookie alone.
    const r = await call('POST', '/api/auth/signup', { cookie: jar(dev.token), body: { name: 'Gino again' } });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('already_signed_in');
    expect(r.data.error.details).toEqual({ userId: dev.userId });
    expect(db.rows('SELECT id FROM users')).toHaveLength(users);
    const c = cookiesOf(r);
    expect(c[SESSION].value).toBe(dev.token);
    expect(c[MARKER].value).toBe(dev.userId);
  });

  it('a dead cookie does not block signup', async () => {
    const dev = await appSignup('Gino');
    db.exec('DELETE FROM sessions');
    const r = await call('POST', '/api/auth/signup', { cookie: dev.cookie, body: { name: 'New' } });
    expect(r.status).toBe(200);
    expect(cookiesOf(r)[SESSION].value).toBe(r.data.token);
  });
});

// ---------- using the cookie ----------

describe('requests with the cookie', () => {
  it('a cookie alone signs in a same-origin request, with or without the expected account', async () => {
    const dev = await appSignup('Gino');
    const plain = await call('GET', '/api/me', { cookie: dev.cookie });
    expect(plain.status).toBe(200);
    expect(plain.data.user.id).toBe(dev.userId);
    const expected = await call('GET', '/api/me', { cookie: dev.cookie, user: dev.userId });
    expect(expected.status).toBe(200);
    // A fresh session with a correct marker: nothing to send back.
    expect(expected.setCookies).toEqual([]);
    const write = await call('PATCH', '/api/me', { cookie: dev.cookie, user: dev.userId, body: { name: 'Gino C' } });
    expect(write.status).toBe(200);
    expect(write.data.user.name).toBe('Gino C');
  });

  it('a write with the cookie from another origin is 403 forbidden (never 401), and the cookies stay', async () => {
    const dev = await appSignup('Gino');
    for (const from of ['sibling', 'cross', 'script'] as const) {
      const r = await call('PATCH', '/api/me', { from, cookie: dev.cookie, body: { name: 'pwned' } });
      expect(r.status, from).toBe(403);
      expect(r.data.error.code, from).toBe('forbidden');
      expect(r.setCookies, from).toEqual([]);
    }
    // A write that names no origin at all (neither header) is refused too.
    const spoof = await call('POST', '/api/groups', {
      from: 'script',
      cookie: dev.cookie,
      body: { name: 'x', type: 'trip', currency: 'TWD' },
    });
    expect(spoof.status).toBe(403);
    const r = await call('DELETE', '/api/me', { from: 'sibling', cookie: dev.cookie, body: {} });
    expect(r.status).toBe(403);
    expect(db.rows('SELECT 1 FROM users WHERE id = ?', dev.userId)).toHaveLength(1);
    expect((await call('GET', '/api/me', { cookie: dev.cookie })).data.user.name).toBe('Gino');
  });

  it('a page claiming same-site in Sec-Fetch-Site is refused even when Origin is this origin', async () => {
    const dev = await appSignup('Gino');
    const req = new Request(SITE + '/api/me', {
      method: 'PATCH',
      headers: { 'Sec-Fetch-Site': 'same-site', Origin: SITE, Cookie: dev.cookie, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'pwned' }),
    });
    const env = { DB: db.d1, ALLOWED_ORIGINS: OLD_APP, APP_URL: SITE + '/', ENVIRONMENT: 'test' };
    const res = await worker.fetch(req, env, { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('reads with the cookie from a sibling site are answered (no CORS for it, so it cannot read them)', async () => {
    const dev = await appSignup('Gino');
    const r = await call('GET', '/api/me', { from: 'sibling', cookie: dev.cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(r.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('Bearer wins over a cookie, and a bad Bearer never falls back to the cookie', async () => {
    const a = await appSignup('Abbie');
    const b = await appSignup('Ben');
    const r = await call('GET', '/api/me', { bearer: a.token, cookie: b.cookie });
    expect(r.status).toBe(200);
    expect(r.data.user.id).toBe(a.userId);
    // X-Evenly-User is only checked against the cookie.
    const other = await call('GET', '/api/me', { bearer: a.token, cookie: b.cookie, user: b.userId });
    expect(other.status).toBe(200);
    expect(other.data.user.id).toBe(a.userId);
    const bad = await call('GET', '/api/me', { bearer: 'not-a-real-token-but-long-enough', cookie: b.cookie });
    expect(bad.status).toBe(401);
    expect(bad.data.error.code).toBe('unauthorized');
    expect(bad.setCookies).toEqual([]);
    // A Bearer write from another origin is fine: the header is never sent by itself.
    const write = await call('PATCH', '/api/me', { from: 'cross', bearer: a.token, cookie: b.cookie, body: { name: 'Abbie L' } });
    expect(write.status).toBe(200);
    expect(write.data.user.name).toBe('Abbie L');
  });

  it('a cookie of another account than X-Evenly-User says is 401 session_changed, and the cookies stay', async () => {
    const a = await appSignup('Abbie');
    const b = await appSignup('Ben');
    // Tab A still thinks it is Abbie; the browser's cookie is Ben's now.
    const r = await call('GET', '/api/me', { cookie: b.cookie, user: a.userId });
    expect(r.status).toBe(401);
    expect(r.data.error.code).toBe('session_changed');
    expect(r.setCookies).toEqual([]);
    const w = await call('POST', '/api/activity/seen', { cookie: b.cookie, user: a.userId, body: {} });
    expect(w.status).toBe(401);
    expect(w.data.error.code).toBe('session_changed');
    expect(await sessionExists(b.token)).toBe(true);
  });

  it('a wrong or missing marker is put right on the next cookie request', async () => {
    const a = await appSignup('Abbie');
    const r = await call('GET', '/api/me', { cookie: jar(a.token, 'someone-else') });
    expect(r.status).toBe(200);
    const c = cookiesOf(r);
    expect(c[MARKER].value).toBe(a.userId);
    expect(c[SESSION].value).toBe(a.token);
    const none = await call('GET', '/api/me', { cookie: jar(a.token) });
    expect(cookiesOf(none)[MARKER].value).toBe(a.userId);
  });
});

// ---------- ending it ----------

describe('clearing the cookies', () => {
  it('logout deletes the session and clears both cookies', async () => {
    const dev = await appSignup('Gino');
    const r = await call('POST', '/api/auth/logout', { cookie: dev.cookie, user: dev.userId, body: {} });
    expect(r.status).toBe(200);
    expect(clearsBoth(r)).toBe(true);
    expect(await sessionExists(dev.token)).toBe(false);
  });

  it('a Bearer logout clears the cookies only when they hold that same session', async () => {
    const a = await appSignup('Abbie');
    const other = await createSession(db.d1, a.userId, 'Old build');
    const r = await call('POST', '/api/auth/logout', { bearer: other, cookie: a.cookie, body: {} });
    expect(r.status).toBe(200);
    expect(r.setCookies).toEqual([]);
    const same = await call('POST', '/api/auth/logout', { bearer: a.token, cookie: a.cookie, body: {} });
    expect(clearsBoth(same)).toBe(true);
  });

  it('revoking the current session clears the cookies; revoking another device does not', async () => {
    const dev = await appSignup('Gino');
    const phone = await createSession(db.d1, dev.userId, 'iPhone Safari');
    const other = await call('DELETE', '/api/auth/sessions/' + (await sha256Hex(phone)), { cookie: dev.cookie, user: dev.userId });
    expect(other.status).toBe(200);
    expect(other.setCookies).toEqual([]);
    const mine = await call('DELETE', '/api/auth/sessions/' + (await sha256Hex(dev.token)), { cookie: dev.cookie, user: dev.userId });
    expect(mine.status).toBe(200);
    expect(clearsBoth(mine)).toBe(true);
  });

  it('DELETE /api/me clears both cookies', async () => {
    const dev = await appSignup('Gino');
    const r = await call('DELETE', '/api/me', { cookie: dev.cookie, user: dev.userId, body: {} });
    expect(r.status).toBe(200);
    expect(clearsBoth(r)).toBe(true);
    expect(db.rows('SELECT 1 FROM users WHERE id = ?', dev.userId)).toHaveLength(0);
  });

  it('a dead cookie (signed out elsewhere, expired, malformed, or a marker alone) is cleared and counts as signed out', async () => {
    const dev = await appSignup('Gino');
    // Revoked from another device.
    db.exec('DELETE FROM sessions WHERE id = ?', await sha256Hex(dev.token));
    const gone = await call('GET', '/api/me', { cookie: dev.cookie, user: dev.userId });
    expect(gone.status).toBe(401);
    expect(gone.data.error.code).toBe('unauthorized');
    expect(clearsBoth(gone)).toBe(true);

    const live = await appSignup('Abbie');
    db.exec('UPDATE sessions SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), await sha256Hex(live.token));
    const expired = await call('GET', '/api/me', { cookie: live.cookie });
    expect(expired.status).toBe(401);
    expect(clearsBoth(expired)).toBe(true);

    const junk = await call('GET', '/api/me', { cookie: `${SESSION}=short; ${MARKER}=${live.userId}` });
    expect(junk.status).toBe(401);
    expect(clearsBoth(junk)).toBe(true);

    const marker = await call('GET', '/api/me', { cookie: `${MARKER}=${live.userId}` });
    expect(marker.status).toBe(401);
    expect(clearsBoth(marker)).toBe(true);

    // A page that never had cookies gets no Set-Cookie at all.
    const bare = await call('GET', '/api/me');
    expect(bare.status).toBe(401);
    expect(bare.setCookies).toEqual([]);
  });

  it('a dead cookie on a route that works signed out (join info) is cleared too', async () => {
    const dev = await appSignup('Gino');
    db.exec('DELETE FROM sessions');
    const r = await call('GET', '/api/join/no-such-invite', { cookie: dev.cookie });
    expect(r.status).toBe(404);
    expect(clearsBoth(r)).toBe(true);
  });
});

// ---------- keeping it fresh ----------

describe('renewing the cookies', () => {
  it('an API answer slides the session row but does not send the cookies again', async () => {
    // WebKit caps a cookie that a fetch answer sets to 7 days when the connection went to another
    // of the site's addresses; such a copy would replace the year-long one. Page loads renew it.
    const dev = await appSignup('Gino');
    const sid = await sha256Hex(dev.token);
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    db.exec('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?', twoHoursAgo, soon, sid);
    const r = await call('GET', '/api/me', { cookie: dev.cookie, user: dev.userId });
    expect(r.status).toBe(200);
    expect(r.setCookies).toEqual([]);
    const row = db.rows<{ expires_at: string }>('SELECT expires_at FROM sessions WHERE id = ?', sid)[0];
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now() + (SESSION_DAYS - 1) * 86_400_000);
  });

  it('a page load of the app sends both cookies again with a full year, on a private page response', async () => {
    const dev = await appSignup('Gino');
    const sid = await sha256Hex(dev.token);
    db.exec('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?', new Date(Date.now() - 2 * 3_600_000).toISOString(), new Date(Date.now() + 86_400_000).toISOString(), sid);
    const r = await call('GET', '/?openExternalBrowser=1', { from: 'script', cookie: dev.cookie });
    expect(r.status).toBe(200);
    expect(r.data).toContain('id="root"');
    expect(r.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(r.headers.get('ETag')).toBe('"build-1"');
    const c = cookiesOf(r);
    expect(c[SESSION].value).toBe(dev.token);
    expect(c[SESSION].attrs).toContain(`max-age=${YEAR_S}`);
    expect(c[SESSION].attrs).toContain('httponly');
    expect(c[MARKER].value).toBe(dev.userId);
    expect(c[MARKER].attrs).toContain(`max-age=${YEAR_S}`);
    const row = db.rows<{ expires_at: string }>('SELECT expires_at FROM sessions WHERE id = ?', sid)[0];
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now() + (SESSION_DAYS - 1) * 86_400_000);
    // Every page load renews them, not only once an hour.
    const again = await call('GET', '/', { from: 'script', cookie: dev.cookie });
    expect(cookiesOf(again)[SESSION].value).toBe(dev.token);
  });

  it('a page load without cookies sets none; with a dead or malformed cookie it clears both', async () => {
    const none = await call('GET', '/', { from: 'script' });
    expect(none.status).toBe(200);
    expect(none.setCookies).toEqual([]);
    const dev = await appSignup('Abbie');
    db.exec('DELETE FROM sessions');
    const dead = await call('GET', '/', { from: 'script', cookie: dev.cookie });
    expect(dead.status).toBe(200);
    expect(clearsBoth(dead)).toBe(true);
    const bad = await call('GET', '/index.html', { from: 'script', cookie: `${SESSION}=not a token` });
    expect(bad.status).toBe(200);
    expect(clearsBoth(bad)).toBe(true);
  });

  it('a plain-http page load goes to https (the cookies are Secure), and https pages say HSTS', async () => {
    const env = { DB: db.d1, ALLOWED_ORIGINS: OLD_APP, APP_URL: SITE + '/', ENVIRONMENT: 'test', ASSETS: assets };
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request(SITE.replace('https:', 'http:') + '/?install=AB12CD34'), env, ctx);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(SITE + '/?install=AB12CD34');
    const page = await call('GET', '/', { from: 'script' });
    expect(page.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
  });

  it('a HEAD page load answers without a body and still renews the cookies', async () => {
    const dev = await appSignup('Kevin');
    const r = await call('HEAD', '/', { from: 'script', cookie: dev.cookie });
    expect(r.status).toBe(200);
    expect(r.data).toBeUndefined();
    expect(cookiesOf(r)[SESSION].value).toBe(dev.token);
  });

  it('only a tab\'s own page load renews them, not a fetch of "/" (the service worker\'s install) or a frame', async () => {
    // WebKit caps a cookie that a fetch answer or a frame sets to 7 days when the connection went
    // to another of the site's addresses, and that copy would replace the year-long one.
    const dev = await appSignup('Gino');
    const page = await call('GET', '/', { from: 'script', cookie: dev.cookie, headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
    expect(page.status).toBe(200);
    const c = cookiesOf(page);
    expect(c[SESSION].value).toBe(dev.token);
    expect(c[SESSION].attrs).toContain(`max-age=${YEAR_S}`);
    expect(c[MARKER].attrs).toContain(`max-age=${YEAR_S}`);
    const notPageLoads: Record<string, string>[] = [
      { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }, // fetch('/') from the service worker or a script
      { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'empty' },
      { 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' },
      { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' },
    ];
    for (const headers of notPageLoads) {
      const what = headers['Sec-Fetch-Mode'] + ' ' + headers['Sec-Fetch-Dest'];
      const r = await call('GET', '/', { cookie: dev.cookie, headers });
      expect(r.status, what).toBe(200);
      expect(r.data, what).toContain('id="root"');
      expect(r.headers.get('Cache-Control'), what).toBe('private, no-cache');
      expect(r.setCookies, what).toEqual([]);
    }
    // Not even a dead cookie is cleared there; the next page load or API answer does that.
    db.exec('DELETE FROM sessions');
    expect((await call('GET', '/', { cookie: dev.cookie, headers: notPageLoads[0] })).setCookies).toEqual([]);
  });

  it('never sends cookies to a Bearer caller', async () => {
    const r = await call('POST', '/api/auth/signup', { from: 'cross', body: { name: 'Old build' } });
    db.exec('UPDATE sessions SET last_used_at = ?', new Date(Date.now() - 2 * 3_600_000).toISOString());
    const me = await call('GET', '/api/me', { from: 'cross', bearer: r.data.token });
    expect(me.status).toBe(200);
    expect(me.setCookies).toEqual([]);
  });
});

// ---------- adopting a Bearer token ----------

describe('POST /api/auth/cookie', () => {
  it('puts the presented Bearer session into the cookies without a new session row', async () => {
    // A token an older build left in localStorage.
    const old = await call('POST', '/api/auth/signup', { from: 'cross', body: { name: 'Abbie' } });
    const before = await sessionCount();
    const r = await call('POST', '/api/auth/cookie', { bearer: old.data.token, body: {} });
    expect(r.status).toBe(200);
    expect(r.data.user.id).toBe(old.data.user.id);
    expect(r.data.user.name).toBe('Abbie');
    const c = cookiesOf(r);
    expect(c[SESSION].value).toBe(old.data.token);
    expect(c[SESSION].attrs).toContain('httponly');
    expect(c[MARKER].value).toBe(old.data.user.id);
    expect(await sessionCount()).toBe(before);
    // Two tabs racing: the same cookie again, still one row.
    const again = await call('POST', '/api/auth/cookie', { bearer: old.data.token, cookie: jar(old.data.token, old.data.user.id), body: {} });
    expect(again.status).toBe(200);
    expect(cookiesOf(again)[SESSION].value).toBe(old.data.token);
    expect(await sessionCount()).toBe(before);
    // The cookie alone now works.
    const me = await call('GET', '/api/me', { cookie: jar(old.data.token, old.data.user.id), user: old.data.user.id });
    expect(me.status).toBe(200);
  });

  it('needs a Bearer session from this origin', async () => {
    const dev = await appSignup('Gino');
    const cookieOnly = await call('POST', '/api/auth/cookie', { cookie: dev.cookie, body: {} });
    expect(cookieOnly.status).toBe(400);
    expect(cookieOnly.setCookies).toEqual([]);
    for (const from of ['cross', 'sibling', 'script'] as const) {
      const r = await call('POST', '/api/auth/cookie', { from, bearer: dev.token, body: {} });
      expect(r.status, from).toBe(403);
      expect(r.setCookies, from).toEqual([]);
    }
    const dead = await call('POST', '/api/auth/cookie', { bearer: 'x'.repeat(43), body: {} });
    expect(dead.status).toBe(401);
    expect(dead.setCookies).toEqual([]);
  });
});

// ---------- caching and CORS ----------

describe('response headers', () => {
  it('every API answer says Vary: *, except the public exchange rates', async () => {
    const dev = await appSignup('Gino');
    expect((await call('GET', '/api/me', { cookie: dev.cookie })).headers.get('Vary')).toBe('*');
    expect((await call('GET', '/api/me')).headers.get('Vary')).toBe('*');
    expect((await call('GET', '/api/health')).headers.get('Vary')).toBe('*');
    expect((await call('GET', '/api/nope')).headers.get('Vary')).toBe('*');
    expect((await call('PATCH', '/api/me', { cookie: dev.cookie, body: { name: 'G' } })).headers.get('Vary')).toBe('*');
    const fx = await call('GET', '/api/fx?base=TWD', { from: 'cross' });
    expect(fx.status).toBe(200);
    expect(fx.headers.get('Vary')).toBe('Origin');
    expect(fx.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('the CORS preflight allows X-Evenly-User and still no credentials', async () => {
    const req = new Request(SITE + '/api/me', {
      method: 'OPTIONS',
      headers: { Origin: OLD_APP, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    const env = { DB: db.d1, ALLOWED_ORIGINS: OLD_APP, APP_URL: SITE + '/', ENVIRONMENT: 'test' };
    const res = await worker.fetch(req, env, { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(OLD_APP);
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type, If-None-Match, X-Evenly-User');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});

// ---------- paths with no file ----------

describe('a path with no route and no file (not_found_handling "none")', () => {
  /** What a browser sends when it opens a URL in a tab: typed, a bookmark, a link from another app. */
  const NAVIGATE = {
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };

  it('a missing built file is a JSON 404 that no cache keeps, never the app page', async () => {
    // The new build's page asking a location that still runs the old one: index.html here would
    // be kept as that script for a year (the /assets/* rule in _headers) and by the service worker.
    const js = await call('GET', '/assets/index-MISSING1.js', { headers: { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'script', Accept: '*/*' } });
    expect(js.status).toBe(404);
    expect(js.headers.get('Content-Type')).toMatch(/^application\/json/);
    expect(js.headers.get('Cache-Control')).toBe('no-store');
    expect(js.data.error.code).toBe('not_found');
    const css = await call('GET', '/assets/index-MISSING2.css', { headers: { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'style', Accept: 'text/css,*/*;q=0.1' } });
    expect(css.status).toBe(404);
    expect(css.headers.get('Cache-Control')).toBe('no-store');
    // A client without Fetch Metadata (curl), and a form post: 404 too.
    expect((await call('GET', '/robots.txt', { from: 'script' })).status).toBe(404);
    expect((await call('POST', '/nope', { headers: NAVIGATE, body: {} })).status).toBe(404);
  });

  it('a page load goes to the app at "/" with its query, in a redirect no cache keeps', async () => {
    const r = await call('GET', '/join/AbC123?openExternalBrowser=1', { from: 'script', headers: NAVIGATE });
    expect(r.status).toBe(302);
    expect(r.headers.get('Location')).toBe('/?openExternalBrowser=1');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.setCookies).toEqual([]);
    // Safari before 16.4 sends no Sec-Fetch-Mode, but its Accept asks for HTML.
    const old = await call('GET', '/evenly/', { from: 'script', headers: { Accept: 'text/html,*/*;q=0.8' } });
    expect(old.status).toBe(302);
    expect(old.headers.get('Location')).toBe('/');
    const head = await call('HEAD', '/assets/index-OLD.js', { from: 'script', headers: NAVIGATE });
    expect(head.status).toBe(302);
    expect(head.headers.get('Location')).toBe('/');
  });

  it('the API stays JSON for a page load, and "/" never redirects to itself', async () => {
    const api = await call('GET', '/api/nope', { from: 'script', headers: NAVIGATE });
    expect(api.status).toBe(404);
    expect(api.headers.get('Content-Type')).toMatch(/^application\/json/);
    expect(api.headers.get('Vary')).toBe('*');
    // A Worker without the ASSETS binding: the app's own page is a 404, not a redirect loop.
    const env = { DB: db.d1, ALLOWED_ORIGINS: OLD_APP, APP_URL: SITE + '/', ENVIRONMENT: 'test' };
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    for (const path of ['/', '/index.html']) {
      const res = await worker.fetch(new Request(SITE + path, { headers: NAVIGATE }), env, ctx);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('Location'), path).toBeNull();
    }
  });
});

// ---------- the account still works end to end with the cookie ----------

describe('a cookie session in use', () => {
  it('creates a group, sees it, and lists this browser as the current device', async () => {
    const dev = await appSignup('Gino');
    const g = await call('POST', '/api/groups', { cookie: dev.cookie, user: dev.userId, body: { name: 'Niseko', type: 'trip', currency: 'JPY', members: [{ name: 'Abbie' }] } });
    expect(g.status).toBe(200);
    const snap = await call('GET', '/api/groups/' + g.data.group.id, { cookie: dev.cookie, user: dev.userId });
    expect(snap.status).toBe(200);
    expect(snap.data.group.name).toBe('Niseko');
    const s = await call('GET', '/api/auth/sessions', { cookie: dev.cookie, user: dev.userId });
    expect(s.data.sessions).toHaveLength(1);
    expect(s.data.sessions[0].current).toBe(true);
    expect(s.data.sessions[0].id).toBe(await sha256Hex(dev.token));
  });
});
