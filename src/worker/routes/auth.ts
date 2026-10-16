// /api/auth: signup, login, logout, sessions, sign in another device, password reset.

import { Hono } from 'hono';
import { z } from 'zod';
import { colorFor } from '../../shared/colors';
import { isKnownCurrency } from '../../shared/currencies';
import type { AuthRes, LinkCodeRes, Locale, SessionDTO } from '../../shared/types';
import {
  createSession, DUMMY_PASSWORD_HASH, hashPassword, ipKey, limitFrom, normalizeEmail, rateLimit, requireUser, validPassword,
  verifyPassword,
} from '../auth';
import { getUser, getUserByEmail, isOwnerEmail, toUserDTO, type UserRow } from '../db';
import type { AppEnv, Ctx, Env } from '../env';
import { clientIp, deviceLabel, fail, json, newId, nowISO, randomCode, readJson, sha256Hex } from '../http';

export const authRoutes = new Hono<AppEnv>();

const LINK_CODE_MINUTES = 10;
const LINK_CODE_RE = /^[2-9A-HJKMNP-Z]{8}$/; // the randomCode alphabet: no 0 O 1 I L

/** Optional email field: missing, null or blank all mean "no email"; otherwise it must be valid. */
const optionalEmail = z
  .union([z.string().max(320), z.null()])
  .optional()
  .transform(v => (v ?? '').trim().toLowerCase())
  .refine(v => v === '' || normalizeEmail(v) !== null, { message: 'Enter a valid email address (at most 120 characters)' });

const signupSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(60, 'At most 60 characters'),
  email: optionalEmail,
  password: z.union([z.string().max(1000), z.null()]).optional(),
  // Lenient: an unexpected locale or currency falls back to the defaults instead of failing signup.
  locale: z.unknown().optional(),
  currency: z.unknown().optional(),
});

const loginSchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1000),
});

const linkSchema = z.object({ code: z.string().max(100) });

const resetSchema = z.object({
  token: z.string().trim().min(1).max(200),
  password: z.string().max(1000),
});

function pickLocale(raw: unknown): Locale {
  if (typeof raw !== 'string' || !raw.trim()) return 'zh-TW';
  return raw.trim().toLowerCase().startsWith('zh') ? 'zh-TW' : 'en';
}

function authRes(env: Env, user: UserRow, token: string): AuthRes {
  return { token, user: toUserDTO(user, isOwnerEmail(env, user.email)) };
}

/** D1 reports e.g. "UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT". */
function isUniqueViolation(err: unknown, column: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('UNIQUE constraint failed') && msg.includes(column);
}

const labelOf = (c: Ctx): string => deviceLabel(c.req.header('User-Agent'));

/** Codes are shown as XXXX-XXXX and may be typed in lowercase, full width or with spaces. */
function normalizeCode(raw: string): string {
  return raw.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------- signup and login ----------

authRoutes.post('/signup', async c => {
  const env = c.env;
  const db = env.DB;
  await rateLimit(db, 'signup:ip:' + ipKey(clientIp(c)), limitFrom(env.SIGNUP_PER_HOUR, 10), 3600);
  const body = await readJson(c, signupSchema);

  const email = body.email || null;
  let pwHash: string | null = null;
  if (email) {
    const pw = body.password ?? '';
    if (!pw) fail(400, 'password_required', 'A password is required when you add an email');
    if (!validPassword(pw)) fail(400, 'weak_password', 'Use a password of at least 8 characters');
    if (await getUserByEmail(db, email)) fail(409, 'email_taken', 'This email already belongs to an account');
    pwHash = await hashPassword(pw);
  }

  const locale = pickLocale(body.locale);
  const reqCurrency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
  const currency = isKnownCurrency(reqCurrency) ? reqCurrency : locale === 'zh-TW' ? 'TWD' : 'USD';
  const id = newId();
  const now = nowISO();
  const user: UserRow = {
    id,
    name: body.name,
    email,
    pw_hash: pwHash,
    locale,
    currency,
    color: colorFor(id),
    pay_info: '',
    venmo: '',
    paypal: '',
    // Nothing that happened before the account existed counts as unread.
    activity_seen_at: now,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        `INSERT INTO users (id, name, email, pw_hash, locale, currency, color, pay_info, venmo, paypal, activity_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?)`,
      )
      .bind(user.id, user.name, user.email, user.pw_hash, user.locale, user.currency, user.color, now, now, now)
      .run();
  } catch (err) {
    if (email && isUniqueViolation(err, 'users.email')) fail(409, 'email_taken', 'This email already belongs to an account');
    throw err;
  }
  const token = await createSession(db, id, labelOf(c));
  return json(c, authRes(env, user, token));
});

authRoutes.post('/login', async c => {
  const env = c.env;
  const db = env.DB;
  const body = await readJson(c, loginSchema);
  const email = body.email.toLowerCase();
  await rateLimit(db, 'login:ip:' + ipKey(clientIp(c)), limitFrom(env.LOGIN_IP_PER_15M, 30), 900);
  // Hashed so the table never holds addresses of people who have no account.
  await rateLimit(db, 'login:email:' + (await sha256Hex(email)).slice(0, 32), limitFrom(env.LOGIN_EMAIL_PER_15M, 10), 900);

  const user = await getUserByEmail(db, email);
  // Always run one PBKDF2, so the response time does not tell whether the email has an account.
  const ok = await verifyPassword(body.password, user?.pw_hash || DUMMY_PASSWORD_HASH);
  if (!user || !user.pw_hash || !ok) fail(401, 'invalid_credentials', 'Wrong email or password');
  const token = await createSession(db, user.id, labelOf(c));
  return json(c, authRes(env, user, token));
});

// ---------- this account's sessions ----------

authRoutes.post('/logout', requireUser, async c => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(c.get('user').sessionId).run();
  return json(c, { ok: true });
});

authRoutes.get('/sessions', requireUser, async c => {
  const me = c.get('user');
  const now = nowISO();
  const r = await c.env.DB
    .prepare(
      `SELECT id, label, created_at, last_used_at FROM sessions
       WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC LIMIT 200`,
    )
    .bind(me.id, now)
    .all<{ id: string; label: string; created_at: string; last_used_at: string }>();
  const sessions: SessionDTO[] = (r.results ?? []).map(s => ({
    id: s.id,
    label: s.label,
    createdAt: s.created_at,
    // The stored value is refreshed hourly; the session making this request is in use right now.
    lastUsedAt: s.id === me.sessionId ? now : s.last_used_at,
    current: s.id === me.sessionId,
  }));
  sessions.sort((a, b) => Number(b.current) - Number(a.current));
  return json(c, { sessions });
});

authRoutes.delete('/sessions/:id', requireUser, async c => {
  const me = c.get('user');
  const r = await c.env.DB
    .prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), me.id)
    .run();
  if (!r.meta.changes) fail(404, 'not_found', 'Session not found');
  return json(c, { ok: true });
});

// ---------- sign in another device ----------

authRoutes.post('/link-code', requireUser, async c => {
  const me = c.get('user');
  const db = c.env.DB;
  const now = Date.now();
  const expiresAt = new Date(now + LINK_CODE_MINUTES * 60_000).toISOString();
  for (let attempt = 1; ; attempt++) {
    const code = randomCode(8);
    const id = await sha256Hex(code);
    try {
      // One live code per account: a new code replaces any unused older one.
      await db.batch([
        db.prepare("DELETE FROM login_codes WHERE user_id = ? AND kind = 'device' AND used_at IS NULL").bind(me.id),
        db
          .prepare("INSERT INTO login_codes (id, user_id, kind, expires_at, used_at, created_at) VALUES (?, ?, 'device', ?, NULL, ?)")
          .bind(id, me.id, expiresAt, new Date(now).toISOString()),
      ]);
      const res: LinkCodeRes = { code, expiresAt };
      return json(c, res);
    } catch (err) {
      if (attempt < 3 && isUniqueViolation(err, 'login_codes.id')) continue; // same code as a recent one: draw again
      throw err;
    }
  }
});

authRoutes.post('/link', async c => {
  const env = c.env;
  const db = env.DB;
  await rateLimit(db, 'link:ip:' + ipKey(clientIp(c)), limitFrom(env.LINK_PER_15M, 10), 900);
  const body = await readJson(c, linkSchema);
  const code = normalizeCode(body.code);
  if (!LINK_CODE_RE.test(code)) fail(400, 'code_invalid', 'This code is wrong or has expired');
  const now = nowISO();
  const hit = await db
    .prepare(
      `UPDATE login_codes SET used_at = ?
       WHERE id = ? AND kind = 'device' AND used_at IS NULL AND expires_at > ?
       RETURNING user_id`,
    )
    .bind(now, await sha256Hex(code), now)
    .all<{ user_id: string }>();
  const userId = hit.results?.[0]?.user_id;
  if (!userId) fail(400, 'code_invalid', 'This code is wrong or has expired');
  const user = await getUser(db, userId);
  if (!user) fail(400, 'code_invalid', 'This code is wrong or has expired');
  const token = await createSession(db, user.id, labelOf(c));
  return json(c, authRes(env, user, token));
});

// ---------- password reset (link made by the owner on the admin page) ----------

// The reset page needs the account's email: the browser salts the password key with it.
authRoutes.get('/reset/:token', async c => {
  const env = c.env;
  const db = env.DB;
  await rateLimit(db, 'reset:ip:' + ipKey(clientIp(c)), limitFrom(env.LINK_PER_15M, 10), 900);
  const row = await db
    .prepare(
      `SELECT u.email AS email, l.expires_at AS expires_at FROM login_codes l JOIN users u ON u.id = l.user_id
       WHERE l.id = ? AND l.kind = 'reset' AND l.used_at IS NULL AND l.expires_at > ?`,
    )
    .bind(await sha256Hex(c.req.param('token')), nowISO())
    .first<{ email: string | null; expires_at: string }>();
  if (!row || !row.email) fail(400, 'code_invalid', 'This reset link is invalid or has expired');
  return json(c, { email: row!.email, expiresAt: row!.expires_at });
});

authRoutes.post('/reset', async c => {
  const env = c.env;
  const db = env.DB;
  await rateLimit(db, 'reset:ip:' + ipKey(clientIp(c)), limitFrom(env.LINK_PER_15M, 10), 900);
  const body = await readJson(c, resetSchema);
  // Check the password first so a weak one does not use up the link.
  if (!validPassword(body.password)) fail(400, 'weak_password', 'Use a password of at least 8 characters');
  const now = nowISO();
  const hit = await db
    .prepare(
      `UPDATE login_codes SET used_at = ?
       WHERE id = ? AND kind = 'reset' AND used_at IS NULL AND expires_at > ?
       RETURNING user_id`,
    )
    .bind(now, await sha256Hex(body.token), now)
    .all<{ user_id: string }>();
  const userId = hit.results?.[0]?.user_id;
  if (!userId) fail(400, 'code_invalid', 'This reset link is invalid or has expired');
  const pwHash = await hashPassword(body.password);
  await db.batch([
    db.prepare('UPDATE users SET pw_hash = ?, updated_at = ? WHERE id = ?').bind(pwHash, now, userId),
    // Every existing session is signed out; the caller gets a fresh one below.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare("UPDATE login_codes SET used_at = ? WHERE user_id = ? AND kind = 'reset' AND used_at IS NULL").bind(now, userId),
  ]);
  const user = await getUser(db, userId);
  if (!user) fail(400, 'code_invalid', 'This reset link is invalid or has expired');
  const token = await createSession(db, user.id, labelOf(c));
  return json(c, authRes(env, user, token));
});
