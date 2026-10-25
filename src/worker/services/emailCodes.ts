// Email codes (docs/SPEC.md section 3, Email codes): a 6-digit code mailed to an address proves
// the address is the person's. Shared by POST /api/auth/email/* (sign in to the account that has
// the email, or create one) and POST /api/me/email/* (add or change the signed-in account's
// email). A code works for 10 minutes and 5 tries, once; a new code for the same address and
// purpose replaces the older unused ones. The table keeps only SHA-256(id + ':' + code).
// Limits, in rate_limits, keyed by IP or by a SHA-256 prefix of the address (never the address):
// asking for codes, per IP an hour (EMAIL_IP_PER_HOUR) and per address (3 in 15 minutes, 10 a
// day), and the whole app's sends a UTC day (EMAIL_GLOBAL_PER_DAY, under Resend's 100), which is
// 503 email_quota; wrong tries per address and per IP, which also cap how many guesses a code
// can get on top of its own 5.

import { todayUTC } from '../../shared/dates';
import type { EmailStartRes, Locale } from '../../shared/types';
import { checkLimit, constantTimeEqual, countFailure, ipKey, limitFrom, normalizeEmail, rateLimit } from '../auth';
import type { Ctx } from '../env';
import { ApiError, clientIp, fail, newId, nowISO, sha256Hex } from '../http';
import { canEcho, canSend, codeMessage, EmailError, sendEmail, undeliverable } from './email';
import { secondsToNextUtcDay } from './receipt';

export type CodePurpose = 'sign_in' | 'add_email';

/** How long a code works. */
export const CODE_TTL_SEC = 600;
/** Tries per code, right or wrong; the code is dead after them. */
export const CODE_MAX_TRIES = 5;
/** Codes asked for one address: in 15 minutes, and in a day (both start routes count). */
export const EMAIL_PER_15M = 3;
export const EMAIL_PER_DAY = 10;
/** Defaults of EMAIL_IP_PER_HOUR and EMAIL_GLOBAL_PER_DAY. */
export const EMAIL_IP_PER_HOUR = 10;
export const EMAIL_GLOBAL_PER_DAY = 90;
/** Wrong tries in 15 minutes, per address and per IP (login's limits, for the same reasons). */
export const VERIFY_FAILS_PER_EMAIL = 10;
export const VERIFY_FAILS_PER_IP = 30;

const CODE_RE = /^[0-9]{6}$/;
const CODE_INVALID = 'This code is wrong or has expired';

/**
 * An address as codes and accounts keep it: NFKC (full-width letters and ＠, typed with a Chinese
 * keyboard, become plain ones), then the sign-in email's rule (auth.ts normalizeEmail: trimmed,
 * lowercase, the email pattern, at most 120 characters). null when it is not one.
 */
export function codeEmail(raw: unknown): string | null {
  return typeof raw === 'string' ? normalizeEmail(raw.normalize('NFKC')) : null;
}

/** 400 validation about `email` (the body's only address). */
export function invalidEmail(): never {
  fail(400, 'validation', 'Enter a valid email address', [{ path: ['email'], message: 'Enter a valid email address (at most 120 characters)' }]);
}

/** A typed code: full-width digits, spaces and a hyphen are fine ("１２３ ４５６", "123-456"). */
export function cleanCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFKC').replace(/[\s-]/g, '');
  return CODE_RE.test(s) ? s : null;
}

/** 2^32 rounded down to a whole number of 1,000,000s: a draw at or above it is drawn again. */
const DRAW_LIMIT = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;

/** Six digits from crypto random, every value equally likely (no modulo bias), leading zeros kept. */
export function randomDigits(): string {
  const a = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(a);
    if (a[0] < DRAW_LIMIT) return String(a[0] % 1_000_000).padStart(6, '0');
  }
}

/** What the table keeps for a code: SHA-256 hex of the row id, ':' and the code. */
export function codeHash(id: string, code: string): Promise<string> {
  return sha256Hex(id + ':' + code);
}

/** Compared against when no code is waiting, so that case costs the same as a wrong code. */
const DUMMY_ID = '00000000-0000-4000-8000-000000000000';
const DUMMY_HASH = '0'.repeat(64);
const utf8 = new TextEncoder();

/**
 * Whether `code` is the one `row` holds the hash of. With no row the same hash and comparison
 * run against a dummy, so the answer's timing does not tell whether a code waits for an address;
 * the comparison takes the same time wherever the hashes differ (constantTimeEqual).
 */
export async function codeMatches(row: { id: string; code_hash: string } | null, code: string): Promise<boolean> {
  const actual = await codeHash(row?.id ?? DUMMY_ID, code);
  const same = constantTimeEqual(utf8.encode(actual), utf8.encode(row?.code_hash ?? DUMMY_HASH));
  return row !== null && same;
}

/**
 * Whether this request may make the Worker mail someone: the app on this origin, the origins CORS
 * allows (vite dev, tests, old builds), or a client that sends no Origin (the iOS app, scripts).
 * A page on any other site could post here unseen (readJson takes a text/plain body, which needs
 * no preflight) and spend the day's emails, or fill an inbox, from its visitors' addresses.
 */
export function mayAskForCode(c: Ctx): boolean {
  const origin = c.req.header('Origin');
  if (origin === undefined) return true;
  if (origin === new URL(c.req.url).origin) return true;
  const allowed = (c.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return allowed.includes(origin) || allowed.includes('*');
}

/** The rate-limit name of an address: a SHA-256 prefix, as login does, so rate_limits never holds addresses. */
async function addressKey(email: string): Promise<string> {
  return (await sha256Hex(email)).slice(0, 32);
}

/** The limits on asking for a code, counted by both start routes (one pool per IP and per address). */
export async function countStart(c: Ctx, email: string): Promise<void> {
  const db = c.env.DB;
  await rateLimit(db, 'email-code:ip:' + ipKey(clientIp(c)), limitFrom(c.env.EMAIL_IP_PER_HOUR, EMAIL_IP_PER_HOUR), 3600);
  const key = await addressKey(email);
  await rateLimit(db, 'email-code:15m:' + key, EMAIL_PER_15M, 900);
  await rateLimit(db, 'email-code:day:' + key, EMAIL_PER_DAY, 86_400);
}

/**
 * One message counted against the whole app's sends today. The key names the UTC day, as Resend's
 * quota resets at 00:00 UTC; past EMAIL_GLOBAL_PER_DAY, 503 email_quota with the seconds until then.
 */
async function countSend(c: Ctx): Promise<void> {
  const now = Date.now();
  try {
    await rateLimit(c.env.DB, 'email-send:' + todayUTC(new Date(now)), limitFrom(c.env.EMAIL_GLOBAL_PER_DAY, EMAIL_GLOBAL_PER_DAY), 86_400);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 429) throw err;
    fail(503, 'email_quota', 'The sign-in emails for today are used up', { retryAfter: secondsToNextUtcDay(now) });
  }
}

export interface CodeTarget {
  email: string;
  purpose: CodePurpose;
  /** add_email: the account that wants the address; null for sign_in. */
  userId: string | null;
  /** The message's language. */
  locale: Locale;
}

/**
 * Make a code for `t` and mail it, replacing the older unused codes for the address and purpose.
 * The caller has counted countStart. Mailed only when Resend is set up and the address can get
 * mail (an address on a test domain gets a code that never goes out). Test mode answers with the
 * code as well; without Resend and outside test mode it is 503 email_unavailable, before anything
 * is written. A message Resend refuses takes its code with it: 503 email_unavailable, or
 * email_quota when Resend's own quota is used up.
 */
export async function sendCode(c: Ctx, t: CodeTarget): Promise<EmailStartRes> {
  const env = c.env;
  const db = env.DB;
  const echo = canEcho(env);
  if (!canSend(env) && !echo) fail(503, 'email_unavailable', 'Email is not set up here');
  const mail = canSend(env) && !undeliverable(t.email);
  if (mail) await countSend(c);
  const code = randomDigits();
  const id = newId();
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ? AND used_at IS NULL').bind(t.email, t.purpose),
    db
      .prepare(
        `INSERT INTO email_codes (id, email, purpose, user_id, code_hash, attempts, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?)`,
      )
      .bind(id, t.email, t.purpose, t.userId, await codeHash(id, code), new Date(now + CODE_TTL_SEC * 1000).toISOString(), new Date(now).toISOString()),
  ]);
  if (mail) {
    try {
      await sendEmail(env, { to: t.email, ...codeMessage(t.locale, code) });
    } catch (err) {
      // It never went out: nobody can know it, and a new start makes another.
      await db.prepare('DELETE FROM email_codes WHERE id = ?').bind(id).run().catch(() => undefined);
      if (err instanceof EmailError && err.reason === 'quota') {
        fail(503, 'email_quota', 'The sign-in emails for today are used up', { retryAfter: secondsToNextUtcDay() });
      }
      fail(503, 'email_unavailable', 'The email could not be sent. Try again in a moment.');
    }
  }
  const res: EmailStartRes = { ok: true, expiresInSec: CODE_TTL_SEC };
  if (echo) res.devCode = code;
  return res;
}

/** The live code a try was taken at (still unused: consumeCode spends it). */
export interface CodeRow {
  id: string;
  code_hash: string;
  user_id: string | null;
}

/**
 * One try at the live code for `t` (the newest one, unused, unexpired, with tries left, and for
 * add_email made for this account). The try is counted before the comparison, in the same
 * statement that finds the code, so parallel guesses never get past 5. A wrong, expired, used or
 * dead code is 400 code_invalid and one failure for the address and the IP; past their limits,
 * 429 before any code is looked at. A malformed code is code_invalid at once: it cannot be right.
 */
export async function checkCode(c: Ctx, t: { email: string; purpose: CodePurpose; userId: string | null; code: unknown }): Promise<CodeRow> {
  const db = c.env.DB;
  const code = cleanCode(t.code);
  if (!code) fail(400, 'code_invalid', CODE_INVALID);
  const byIp = 'email-verify:ip:' + ipKey(clientIp(c));
  const byAddress = 'email-verify:' + (await addressKey(t.email));
  await checkLimit(db, byIp, VERIFY_FAILS_PER_IP);
  await checkLimit(db, byAddress, VERIFY_FAILS_PER_EMAIL);
  const row = await db
    .prepare(
      `UPDATE email_codes SET attempts = attempts + 1
       WHERE id = (SELECT id FROM email_codes
                   WHERE email = ?1 AND purpose = ?2 AND user_id IS ?3 AND used_at IS NULL AND expires_at > ?4 AND attempts < ?5
                   ORDER BY created_at DESC LIMIT 1)
       RETURNING id, code_hash, user_id`,
    )
    .bind(t.email, t.purpose, t.userId, nowISO(), CODE_MAX_TRIES)
    .first<CodeRow>();
  if (!(await codeMatches(row ?? null, code))) {
    await countFailure(db, byIp, 900);
    await countFailure(db, byAddress, 900);
    fail(400, 'code_invalid', CODE_INVALID);
  }
  return row!;
}

/** Spend the code; false when another request spent it first (the same code sent twice at once). */
export async function consumeCode(db: D1Database, id: string): Promise<boolean> {
  const hit = await db.prepare('UPDATE email_codes SET used_at = ? WHERE id = ? AND used_at IS NULL RETURNING id').bind(nowISO(), id).first();
  return !!hit;
}

/** 400 code_invalid, the answer for every code that does not work. */
export function codeInvalid(): never {
  fail(400, 'code_invalid', CODE_INVALID);
}
