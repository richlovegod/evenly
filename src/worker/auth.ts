// Passwords, sessions, the auth middleware and rate limits.

import type { MiddlewareHandler } from 'hono';
import { isOwnerEmail } from './db';
import type { AppEnv, AuthUser, Ctx } from './env';
import { b64url, fail, fromB64url, randomToken, sha256Hex } from './http';

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

/** The signed-in user for this request, or null when no valid token was sent. */
async function resolveUser(c: Ctx): Promise<AuthUser | null> {
  const m = BEARER_RE.exec(c.req.header('Authorization') || '');
  if (!m) return null;
  const sid = await sha256Hex(m[1]);
  const db = c.env.DB;
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.last_used_at, s.expires_at, u.id AS user_id, u.name, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .bind(sid)
    .first<SessionUserRow>();
  if (!row) return null;
  const now = Date.now();
  if (!(Date.parse(row.expires_at) > now)) return null;
  const last = Date.parse(row.last_used_at);
  if (!(now - last < TOUCH_EVERY_MS)) {
    // Sliding expiry: a session lasts 365 days after its last use, so a device-only account that
    // is used now and then never gets locked out.
    await runSoon(
      c,
      db
        .prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?')
        .bind(iso(now), iso(now + SESSION_DAYS * DAY_MS), sid)
        .run(),
    );
  }
  return {
    id: row.user_id,
    name: row.name,
    email: row.email,
    isOwner: isOwnerEmail(c.env, row.email),
    sessionId: sid,
  };
}

/** Middleware: 401 `unauthorized` unless a valid `Authorization: Bearer` token was sent. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await resolveUser(c);
  if (!user) fail(401, 'unauthorized', 'Sign in first');
  c.set('user', user);
  await next();
};

/** Middleware: sets `user` when a valid token was sent; never fails. */
export const optionalUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await resolveUser(c);
  if (user) c.set('user', user);
  await next();
};

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
