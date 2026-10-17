// Passwords, sessions (Bearer header or cookie), the auth middleware and rate limits.

import type { MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { isOwnerEmail } from './db';
import type { AppEnv, AuthUser, Ctx } from './env';
import { b64url, fail, forbidden, fromB64url, randomToken, sha256Hex } from './http';

// ---------- passwords ----------

/**
 * Iterations for new hashes. The web app never sends the typed password: it sends a key it
 * derived in the browser with PBKDF2-SHA256 at 210,000 iterations, salted by the email
 * (src/web/lib/crypto.ts). The server adds a light PBKDF2 on top (about 2 ms of CPU), which
 * keeps sign-ins inside the Workers Free plan's 10 ms CPU limit.
 */
export const PBKDF2_ITERATIONS = 4_000;
/** The most PBKDF2 iterations Cloudflare Workers allows; stored hashes above it are refused. */
export const PBKDF2_MAX_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCHEME = 'pbkdf2-sha256';

/**
 * A well-formed hash of no real password. Login verifies against it when the email is unknown,
 * so "no such account" takes as long as "wrong password".
 */
export const DUMMY_PASSWORD_HASH = 'pbkdf2-sha256$4000$OtD2EIBSm4b_7O27BkiWmg$A2s92hpOTrs-pJf1i8MPMROH0fu9mlp8MCfXMuRaKy4';

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, bytes: number): Promise<Uint8Array> {
  // NFC so the same password typed on different keyboards (composed or decomposed accents) matches.
  const material = new TextEncoder().encode(password.normalize('NFC'));
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, bytes * 8);
  return new Uint8Array(bits);
}

/** Compare two byte strings in time that depends only on their length. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Hash a password (or the browser-derived key) as 'pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>'. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(pw, salt, PBKDF2_ITERATIONS, KEY_BYTES);
  return `${SCHEME}$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

/**
 * Check a password against a stored hash. Malformed hashes return false (never throw). The
 * iteration count comes from the stored value, so older or lighter hashes keep working.
 */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (typeof pw !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== SCHEME || !/^[1-9][0-9]{0,6}$/.test(parts[1])) return false;
  const iterations = Number(parts[1]);
  if (iterations > PBKDF2_MAX_ITERATIONS) return false; // Workers refuse to run more
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2]) || !/^[A-Za-z0-9_-]+$/.test(parts[3])) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromB64url(parts[2]);
    expected = fromB64url(parts[3]);
  } catch {
    return false;
  }
  if (!salt.length || expected.length < 16 || expected.length > 64) return false;
  const actual = await pbkdf2(pw, salt, iterations, expected.length);
  return constantTimeEqual(actual, expected);
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Sign-in email trimmed and lowercased, or null when it does not look valid or is over 120 characters. */
export function normalizeEmail(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  return s.length <= 120 && EMAIL_RE.test(s) ? s : null;
}

/** Password rule: 8 to 200 characters, not only spaces. */
export function validPassword(pw: string): boolean {
  if (typeof pw !== 'string') return false;
  const n = Array.from(pw).length;
  return n >= 8 && n <= 200 && pw.trim().length > 0;
}

// ---------- sessions ----------

export const SESSION_DAYS = 365;
const DAY_MS = 86_400_000;
/** last_used_at (and the sliding expiry) is written at most this often per session. */
const TOUCH_EVERY_MS = 3_600_000;

const iso = (ms: number): string => new Date(ms).toISOString();

/** Create a session and return its bearer token. Only SHA-256(token) is stored. */
export async function createSession(db: D1Database, userId: string, label: string): Promise<string> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = Date.now();
  await db
    .prepare('INSERT INTO sessions (id, user_id, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userId, (label || '').slice(0, 60), iso(now), iso(now), iso(now + SESSION_DAYS * DAY_MS))
    .run();
  return token;
}

interface SessionUserRow {
  session_id: string;
  last_used_at: string;
  expires_at: string;
  user_id: string;
  name: string;
  email: string | null;
}

const BEARER_RE = /^Bearer\s+([A-Za-z0-9_-]{20,200})\s*$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

// ---------- session cookies ----------
// The app on the Worker's own origin keeps its session in cookies the Worker sets and clears
// (never page script), so Safari's 7-day limit on script-written storage does not apply:
//   __Host-evenly_session  the same token createSession returns; HttpOnly
//   __Host-evenly_user     the account id, readable by the page so it knows who is signed in at
//                          start, with no request and offline
// The __Host- prefix forces Secure, Path=/ and no Domain, so sibling *.ginochang.com sites cannot
// plant or overwrite them. SameSite=Lax still sends them from those siblings, hence sameOrigin().

/** Cookie names without the __Host- prefix (hono/cookie adds it with prefix: 'host'). */
export const SESSION_COOKIE = 'evenly_session';
export const USER_COOKIE = 'evenly_user';
/** The browser keeps both as long as the session row lives (re-sent when the expiry slides). */
const COOKIE_MAX_AGE = SESSION_DAYS * 86_400;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The request comes from a page on this origin: Sec-Fetch-Site says same-origin when the browser
 * sends it; otherwise the Origin header must be this origin. Neither header: not same-origin.
 */
export function sameOrigin(c: Ctx): boolean {
  const site = c.req.header('Sec-Fetch-Site');
  if (site) return site === 'same-origin';
  const origin = c.req.header('Origin');
  return !!origin && origin === new URL(c.req.url).origin;
}

/** Put a session in both cookies (on the response being built). */
export function setSessionCookies(c: Ctx, token: string, userId: string): void {
  setCookie(c, SESSION_COOKIE, token, { prefix: 'host', httpOnly: true, sameSite: 'Lax', maxAge: COOKIE_MAX_AGE });
  setCookie(c, USER_COOKIE, userId, { prefix: 'host', sameSite: 'Lax', maxAge: COOKIE_MAX_AGE });
}

/** Expire both cookies. */
export function clearSessionCookies(c: Ctx): void {
  deleteCookie(c, SESSION_COOKIE, { prefix: 'host', httpOnly: true, sameSite: 'Lax' });
  deleteCookie(c, USER_COOKIE, { prefix: 'host', sameSite: 'Lax' });
}

/** The session token in the request's cookie, when it is well formed. */
function cookieToken(c: Ctx): string | null {
  const v = getCookie(c, SESSION_COOKIE, 'host');
  return v && TOKEN_RE.test(v) ? v : null;
}

/** The id (SHA-256) of the session the request's cookie names, live or not; null without one. */
export async function cookieSessionId(c: Ctx): Promise<string | null> {
  const token = cookieToken(c);
  return token ? sha256Hex(token) : null;
}

/** The token sent in `Authorization: Bearer`, when well formed. */
export function bearerToken(c: Ctx): string | null {
  return BEARER_RE.exec(c.req.header('Authorization') || '')?.[1] ?? null;
}

/** Run work after the response when the runtime allows it (Workers), else wait for it. */
async function runSoon(c: Ctx, work: Promise<unknown>): Promise<void> {
  const guarded = work.then(
    () => undefined,
    err => console.error('session touch failed', err),
  );
  let ctx: { waitUntil(p: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = null; // no ExecutionContext (unit tests)
  }
  if (ctx) ctx.waitUntil(guarded);
  else await guarded;
}

/** The live session (not expired, its account still there) a token belongs to. */
async function findSession(db: D1Database, sid: string): Promise<SessionUserRow | null> {
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.last_used_at, s.expires_at, u.id AS user_id, u.name, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .bind(sid)
    .first<SessionUserRow>();
  return row && Date.parse(row.expires_at) > Date.now() ? row : null;
}

/** The signed-in user for a token, sliding its expiry (and, for the cookie, the cookies' too). */
async function sessionUser(c: Ctx, token: string, via: AuthUser['via']): Promise<AuthUser | null> {
  const sid = await sha256Hex(token);
  const row = await findSession(c.env.DB, sid);
  if (!row) return null;
  await touchSession(c, sid, row);
  // A marker that does not name this session's account (cleared or edited by hand) is put right,
  // so the page boots as the account the cookie really holds. The year-long expiry itself is
  // renewed on page loads (renewPageCookies), not on API answers: WebKit caps a cookie that a
  // fetch answer sets to 7 days when that connection went to another of the site's addresses
  // (its third-party IP defense), and the capped copy would replace the longer one.
  if (via === 'cookie' && getCookie(c, USER_COOKIE, 'host') !== row.user_id) setSessionCookies(c, token, row.user_id);
  return sessionAuthUser(c, row, sid, via);
}

/**
 * Sliding expiry: a session lasts 365 days after its last use, so a device-only account that is
 * used now and then never gets locked out. Written at most once an hour.
 */
async function touchSession(c: Ctx, sid: string, row: SessionUserRow): Promise<void> {
  const now = Date.now();
  if (now - Date.parse(row.last_used_at) < TOUCH_EVERY_MS) return;
  await runSoon(
    c,
    c.env.DB.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?')
      .bind(iso(now), iso(now + SESSION_DAYS * DAY_MS), sid)
      .run(),
  );
}

/**
 * A page load of the app ("/", index.ts): both cookies again with a fresh year, on the page's own
 * response. WebKit does not apply its third-party IP cap to cookies a top-level page load sets,
 * so this is where the expiry is renewed (see sessionUser). The session row slides too. A cookie
 * for a session that has ended, or a malformed one, is cleared. Errors are left to the caller.
 */
export async function renewPageCookies(c: Ctx): Promise<void> {
  const raw = getCookie(c, SESSION_COOKIE, 'host');
  if (raw === undefined) {
    if (getCookie(c, USER_COOKIE, 'host') !== undefined) clearSessionCookies(c);
    return;
  }
  if (!TOKEN_RE.test(raw)) {
    clearSessionCookies(c);
    return;
  }
  const sid = await sha256Hex(raw);
  const row = await findSession(c.env.DB, sid);
  if (!row) {
    clearSessionCookies(c);
    return;
  }
  await touchSession(c, sid, row);
  setSessionCookies(c, raw, row.user_id);
}

function sessionAuthUser(c: Ctx, row: SessionUserRow, sid: string, via: AuthUser['via']): AuthUser {
  return {
    id: row.user_id,
    name: row.name,
    email: row.email,
    isOwner: isOwnerEmail(c.env, row.email),
    sessionId: sid,
    via,
  };
}

/**
 * The signed-in user for this request, or null. An Authorization header wins and is the only
 * thing read when present (old app builds, scripts and tests behave exactly as before); without
 * one, the session cookie. Cookie requests that change something must come from this origin
 * (403 `forbidden`, never 401: a 401 signs the app out), and when the page says which account it
 * expects (X-Evenly-User), another account in the cookie is 401 `session_changed` (another tab
 * switched accounts; the page reloads, nothing is cleared).
 */
async function resolveUser(c: Ctx): Promise<AuthUser | null> {
  const header = c.req.header('Authorization');
  if (header !== undefined) {
    const m = BEARER_RE.exec(header);
    return m ? sessionUser(c, m[1], 'bearer') : null;
  }
  const raw = getCookie(c, SESSION_COOKIE, 'host');
  if (raw === undefined) {
    // A marker without its session cookie (cleared by hand): drop it too, so the page stops
    // starting up signed in.
    if (getCookie(c, USER_COOKIE, 'host') !== undefined) clearSessionCookies(c);
    return null;
  }
  if (!TOKEN_RE.test(raw)) {
    clearSessionCookies(c);
    return null;
  }
  // SameSite=Lax still sends the cookie from sibling sites (award.ginochang.com), and readJson
  // takes a text/plain form body, so only this origin's pages may write with it.
  if (!SAFE_METHODS.has(c.req.method) && !sameOrigin(c)) forbidden('Use the app on this site to make changes');
  const user = await sessionUser(c, raw, 'cookie');
  if (!user) {
    // Signed out elsewhere, revoked, reset or expired: the cookies go too.
    clearSessionCookies(c);
    return null;
  }
  const expected = c.req.header('X-Evenly-User');
  if (expected !== undefined && expected !== user.id) {
    fail(401, 'session_changed', 'This browser is signed in to another account now');
  }
  return user;
}

/** Middleware: 401 `unauthorized` unless a valid Bearer token or session cookie was sent. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await resolveUser(c);
  if (!user) fail(401, 'unauthorized', 'Sign in first');
  c.set('user', user);
  await next();
};

/**
 * Middleware: sets `user` when a valid token or cookie was sent. A missing or dead session is
 * not an error; the cookie checks (403 `forbidden`, 401 `session_changed`) still apply.
 */
export const optionalUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await resolveUser(c);
  if (user) c.set('user', user);
  await next();
};

/**
 * The live session the request's cookie holds (whatever the method or origin), for signup's
 * check that this browser is not signed in already.
 */
export async function liveCookieSession(c: Ctx): Promise<{ token: string; userId: string } | null> {
  const token = cookieToken(c);
  if (!token) return null;
  const row = await findSession(c.env.DB, await sha256Hex(token));
  return row ? { token, userId: row.user_id } : null;
}

/**
 * Create a session for a sign-in (signup, login, link, reset). A page on this origin also gets
 * it in the cookies, and the session its browser held before is deleted (the device is switching
 * accounts or signing in again; another site cannot sign a browser out this way, since only a
 * same-origin request replaces the cookie). Every caller gets the token in the answer: old app
 * builds and scripts use it as Bearer, and the app keeps it if this browser blocks cookies.
 */
export async function startSession(c: Ctx, userId: string, label: string): Promise<string> {
  const db = c.env.DB;
  const token = await createSession(db, userId, label);
  if (sameOrigin(c)) {
    const prev = cookieToken(c);
    setSessionCookies(c, token, userId);
    if (prev && prev !== token) await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(prev)).run();
  }
  return token;
}

// ---------- rate limits ----------

/**
 * Count one attempt for `key` in a fixed window of `windowSec` seconds; throws 429 `rate_limited`
 * (details.retryAfter in seconds) once the count goes over `limit`.
 */
export async function rateLimit(db: D1Database, key: string, limit: number, windowSec: number): Promise<void> {
  const now = Date.now();
  const resetAt = now + windowSec * 1000;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
       RETURNING count, reset_at`,
    )
    .bind(key.slice(0, 200), resetAt, now)
    .first<{ count: number; reset_at: number }>();
  if (row && row.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((row.reset_at - now) / 1000));
    fail(429, 'rate_limited', 'Too many attempts, try again later', { retryAfter });
  }
}

/** A limit from an optional env override (a positive number, usually as a string), else the default. */
export function limitFrom(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/**
 * The rate-limit identity of a client address: IPv4 as is, IPv6 by its /64 prefix (one phone or
 * one home network usually owns a whole /64).
 */
export function ipKey(ip: string): string {
  const s = (ip || 'unknown').trim().toLowerCase();
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1); // IPv4-mapped (::ffff:1.2.3.4)
  const halves = s.split('::');
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? Math.max(0, 8 - head.length - tail.length) : 0;
  const groups = [...head, ...Array.from({ length: fill }, () => '0'), ...tail];
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
