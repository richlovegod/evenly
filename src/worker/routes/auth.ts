// /api/auth: signup, login, sign in or sign up with an email code or with Google, logout,
// sessions, sign in another device, password reset, and moving a Bearer token into the session
// cookie. Sign-ins from the app on this origin also get the session in cookies (auth.ts
// startSession); every JSON answer still carries the token. The web app makes new accounts with an
// email code or Google only; signup with a name alone stays for older clients, the iOS app and
// test scripts. Google (services/google.ts) is page loads, not JSON: the app on this origin opens
// /google/start, and the callback answers with the session cookies and a redirect into the app.

import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { colorFor } from '../../shared/colors';
import { isKnownCurrency } from '../../shared/currencies';
import type {
  AuthRes, EmailVerifyRes, GoogleArrival, GoogleErrorCode, LinkCodeRes, Locale, ProvidersRes, SessionDTO,
} from '../../shared/types';
import {
  bearerToken, clearSessionCookies, constantTimeEqual, cookieSessionId, DUMMY_PASSWORD_HASH, hashPassword, ipKey, limitFrom,
  liveCookieSession, rateLimit, requireUser, sameOrigin, setSessionCookies, startCookieSession, startSession, validPassword,
  verifyPassword,
} from '../auth';
import { getUser, getUserByEmail, getUserByGoogleSub, isOwnerEmail, toUserDTO, type UserRow } from '../db';
import type { AppEnv, Ctx, Env } from '../env';
import {
  ApiError, clientIp, deviceLabel, fail, forbidden, json, newId, nowISO, randomCode, randomToken, readJson, sha256Hex,
} from '../http';
import { checkCode, codeEmail, codeInvalid, consumeCode, countStart, invalidEmail, mayAskForCode, sendCode } from '../services/emailCodes';
import {
  authUrl, callbackUrl, decodeFlow, encodeFlow, exchangeCode, FLOW_COOKIE, FLOW_TTL_SEC, GOOGLE_IP_PER_15M, googleAvailable,
  googleClientId, GoogleError, googleName, safeReturn, verifyIdToken, type GoogleFlow, type GoogleIdentity,
} from '../services/google';

export const authRoutes = new Hono<AppEnv>();

const LINK_CODE_MINUTES = 10;
const LINK_CODE_RE = /^[2-9A-HJKMNP-Z]{8}$/; // the randomCode alphabet: no 0 O 1 I L

const signupSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(60, 'At most 60 characters'),
  // A name only: anything in these is refused (the route, `filled`). Older clients may still send
  // the keys empty or null, which is fine.
  email: z.unknown().optional(),
  password: z.unknown().optional(),
  // Lenient: an unexpected locale or currency falls back to the defaults instead of failing signup.
  locale: z.unknown().optional(),
  currency: z.unknown().optional(),
});

/** A signup body field that holds something: missing, null and blank text do not. */
function filled(v: unknown): boolean {
  return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
}

const loginSchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1000),
});

const linkSchema = z.object({ code: z.string().max(100) });

const resetSchema = z.object({
  token: z.string().trim().min(1).max(200),
  password: z.string().max(1000),
});

const emailStartSchema = z.object({
  email: z.string().max(320),
  // Lenient, as at signup: an unexpected locale gets the default language.
  locale: z.unknown().optional(),
});

const emailVerifySchema = z.object({
  email: z.string().max(320),
  code: z.string().max(40),
  // The new account's name, by signup's rule; blank or missing means none was sent.
  name: z.union([z.string().trim().max(60, 'At most 60 characters'), z.null()]).optional(),
  locale: z.unknown().optional(),
  currency: z.unknown().optional(),
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

/**
 * A new account (signup, an email code for an address with no account, or a Google account that
 * is linked to none and whose email has none). The language and home currency come from the
 * request, leniently: an unknown one gets the default for the language.
 */
function newUserRow(o: {
  name: string; email: string | null; pwHash: string | null; emailVerifiedAt: string | null; locale: unknown; currency: unknown;
  googleSub?: string;
}): UserRow {
  const locale = pickLocale(o.locale);
  const reqCurrency = typeof o.currency === 'string' ? o.currency.trim().toUpperCase() : '';
  const currency = isKnownCurrency(reqCurrency) ? reqCurrency : locale === 'zh-TW' ? 'TWD' : 'USD';
  const id = newId();
  const now = nowISO();
  return {
    id,
    name: o.name,
    email: o.email,
    pw_hash: o.pwHash,
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
    avatar: null,
    email_verified_at: o.emailVerifiedAt,
    google_sub: o.googleSub ?? null,
    invite_code: null,
  };
}

/**
 * Store a row from newUserRow. A taken email or Google account is D1's UNIQUE error
 * (isUniqueViolation 'users.email' or 'users.google_sub').
 */
async function insertUser(db: D1Database, u: UserRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, name, email, pw_hash, locale, currency, color, pay_info, venmo, paypal, activity_seen_at, created_at, updated_at, email_verified_at, google_sub)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?, ?, ?)`,
    )
    .bind(u.id, u.name, u.email, u.pw_hash, u.locale, u.currency, u.color, u.activity_seen_at, u.created_at, u.updated_at, u.email_verified_at, u.google_sub)
    .run();
}

/** An account whose email a code just proved: confirmed from now on (one set before email codes, too). */
async function confirmEmail(db: D1Database, user: UserRow): Promise<UserRow> {
  if (user.email_verified_at) return user;
  const at = nowISO();
  await db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL').bind(at, user.id).run();
  return { ...user, email_verified_at: at };
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
  // This browser is signed in already (its cookie outlived the page's own storage, or another
  // tab signed in): the app carries on as that account instead of making a second one over it,
  // since a name-only account that loses its session can never be signed in again.
  const live = await liveCookieSession(c);
  if (live) {
    if (sameOrigin(c)) setSessionCookies(c, live.token, live.userId); // the marker may be what went missing
    fail(409, 'already_signed_in', 'This browser is already signed in', { userId: live.userId });
  }
  await rateLimit(db, 'signup:ip:' + ipKey(clientIp(c)), limitFrom(env.SIGNUP_PER_HOUR, 10), 3600);
  const body = await readJson(c, signupSchema);
  // A name only. An email here would be one nobody confirmed: someone could make an account with
  // another person's address and a password of their own, and that person's first code sign-in
  // would land in it while its maker still had the password. An email comes with a code
  // (POST /email/start), and a password after it (POST /api/me/credentials).
  if (filled(body.email) || filled(body.password)) {
    fail(400, 'email_requires_code', 'Add an email with a code: POST /api/auth/email/start');
  }

  const user = newUserRow({ name: body.name, email: null, pwHash: null, emailVerifiedAt: null, locale: body.locale, currency: body.currency });
  await insertUser(db, user);
  const token = await startSession(c, user.id, labelOf(c));
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
  const token = await startSession(c, user.id, labelOf(c));
  return json(c, authRes(env, user, token));
});

// ---------- email codes (services/emailCodes.ts) ----------

/**
 * A 6-digit code to the address (POST /verify spends it). The answer is the same whether or not
 * an account has the address, so it tells nobody who uses the service. Pages on other sites get
 * 403 (mayAskForCode); signed-in callers of /me/email/start are covered by requireUser instead.
 */
authRoutes.post('/email/start', async c => {
  if (!mayAskForCode(c)) forbidden('Ask for a code in the app');
  const body = await readJson(c, emailStartSchema);
  const email = codeEmail(body.email) ?? invalidEmail();
  await countStart(c, email);
  return json(c, await sendCode(c, { email, purpose: 'sign_in', userId: null, locale: pickLocale(body.locale) }));
});

/**
 * The code proves the address is the person's: the account that has it signs in (and the email
 * counts as confirmed from now on, also one set before email codes), or, with a name, a new
 * account is made with it (created: true). Without an account and without a name: 400 name_required, and the
 * code is not spent, so the app asks for a name and sends it again. Unlike signup, a live session
 * cookie is no reason to refuse: this is a sign-in, so a page on this origin gets the new session
 * in its cookies and the one it held before ends (startSession), as with login.
 */
authRoutes.post('/email/verify', async c => {
  const env = c.env;
  const db = env.DB;
  const body = await readJson(c, emailVerifySchema);
  const email = codeEmail(body.email) ?? invalidEmail();
  const code = await checkCode(c, { email, purpose: 'sign_in', userId: null, code: body.code });
  const name = body.name ?? '';
  let user = await getUserByEmail(db, email);
  if (!user && !name) fail(400, 'name_required', 'No account uses this email yet: send a name to create one');
  if (!(await consumeCode(db, code.id))) codeInvalid();
  let created = false;
  if (user) {
    user = await confirmEmail(db, user);
  } else {
    const fresh = newUserRow({ name, email, pwHash: null, emailVerifiedAt: nowISO(), locale: body.locale, currency: body.currency });
    try {
      await insertUser(db, fresh);
      user = fresh;
      created = true;
    } catch (err) {
      // An account got this address a moment ago (a signup with it, or a code that added it to an
      // account): the code proved the address is the person's, so that account signs in.
      if (!isUniqueViolation(err, 'users.email')) throw err;
      const taken = (await getUserByEmail(db, email)) ?? codeInvalid();
      user = await confirmEmail(db, taken);
    }
  }
  const token = await startSession(c, user.id, labelOf(c));
  const res: EmailVerifyRes = { ...authRes(env, user, token), created };
  return json(c, res);
});

// ---------- Sign in with Google (services/google.ts; docs/SPEC.md section 3, Google) ----------

/** What the sign-in pages may offer here; public, and the same for everyone on a site. */
authRoutes.get('/providers', c => {
  const res: ProvidersRes = { google: googleAvailable(c) };
  return json(c, res);
});

/**
 * The start came from a page of this app: Sec-Fetch-Site same-origin when the browser sends it;
 * without it (Safari before 16.4), a Referer on this origin (the app's Referrer-Policy keeps it for
 * same-origin links). A link on another site, or the address typed in, is not one: a page elsewhere
 * could otherwise send its visitors through Google and back into an account here.
 */
function startedHere(c: Ctx): boolean {
  const site = c.req.header('Sec-Fetch-Site');
  if (site) return site === 'same-origin';
  const ref = c.req.header('Referer');
  if (!ref) return false;
  try {
    return new URL(ref).origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}

const utf8 = new TextEncoder();

/** Both Google routes are page loads: every failure goes to 登入 with its code, which says it in words. */
async function googlePage(c: Ctx, route: 'start' | 'callback', run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    let code: GoogleErrorCode = 'server';
    // Names only: never the code, a token or an address.
    if (err instanceof GoogleError) {
      code = err.code;
      console.warn(`google ${route}: ${err.detail}`);
    } else if (err instanceof ApiError && err.status === 429) {
      code = 'rate_limited';
    } else {
      console.error(`google ${route}: ${err instanceof Error ? err.name : 'error'}`);
    }
    return c.redirect('/?google_error=' + code + '#/login', 302);
  }
}

/**
 * Link a Google account to the account that has its email (one Google has verified, so the email
 * counts as confirmed from now on, as after a code). null when that account changed in between (it
 * got another email, or a Google account): the caller looks again.
 */
async function linkGoogle(db: D1Database, user: UserRow, sub: string): Promise<UserRow | null> {
  return db
    .prepare(
      `UPDATE users SET google_sub = ?1, email_verified_at = COALESCE(email_verified_at, ?2)
       WHERE id = ?3 AND email = ?4 AND google_sub IS NULL RETURNING *`,
    )
    .bind(sub, nowISO(), user.id, user.email)
    .first<UserRow>();
}

/**
 * The account a verified Google identity signs in to: the one linked to its `sub`; else the one
 * that has its email, confirmed or not (Google has verified the address, as a code would), which
 * gets linked; else a new one with Google's name, the email confirmed and the start's language
 * (the currency follows it, as at signup). An account with this email that is linked to another
 * Google account is refused (linked_other): its owner signs in with an email code instead. Another
 * request that linked or took the same thing a moment ago only means looking again.
 */
async function googleAccount(db: D1Database, who: GoogleIdentity, locale: Locale): Promise<{ user: UserRow; arrival: GoogleArrival }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const linked = await getUserByGoogleSub(db, who.sub);
    if (linked) return { user: linked, arrival: 'back' };
    const owner = await getUserByEmail(db, who.email);
    try {
      if (owner) {
        if (owner.google_sub) throw new GoogleError('linked_other', 'the email is linked to another Google account');
        const user = await linkGoogle(db, owner, who.sub);
        if (user) return { user, arrival: 'linked' };
      } else {
        const fresh = newUserRow({
          name: googleName(who), email: who.email, pwHash: null, emailVerifiedAt: nowISO(), locale, currency: null, googleSub: who.sub,
        });
        await insertUser(db, fresh);
        return { user: fresh, arrival: 'new' };
      }
    } catch (err) {
      if (!isUniqueViolation(err, 'users.google_sub') && !isUniqueViolation(err, 'users.email')) throw err;
    }
  }
  throw new GoogleError('server', 'the account kept changing');
}

/**
 * GET /api/auth/google/start?return=<hash route>&locale=<zh-TW|en>: from the app on this site
 * only (startedHere), at most GOOGLE_IP_PER_15M an IP in 15 minutes. Keeps the flow (state, nonce,
 * PKCE verifier, the page to come back to, the language) in __Host-evenly_google, HttpOnly,
 * SameSite=Lax (the callback is a page load from Google, which Lax lets through), 10 minutes, and
 * sends the browser to Google's consent page. A new start replaces an older flow in this browser.
 */
authRoutes.get('/google/start', c =>
  googlePage(c, 'start', async () => {
    const env = c.env;
    if (!googleAvailable(c)) throw new GoogleError('unavailable', 'not set up on this site');
    if (!startedHere(c)) throw new GoogleError('start', 'not started from the app on this site');
    await rateLimit(env.DB, 'google-start:ip:' + ipKey(clientIp(c)), limitFrom(env.GOOGLE_IP_PER_15M, GOOGLE_IP_PER_15M), 900);
    const flow: GoogleFlow = {
      state: randomToken(32),
      nonce: randomToken(32),
      verifier: randomToken(32),
      returnTo: safeReturn(c.req.query('return')),
      locale: pickLocale(c.req.query('locale') || c.req.header('Accept-Language')),
    };
    setCookie(c, FLOW_COOKIE, encodeFlow(flow), { prefix: 'host', httpOnly: true, sameSite: 'Lax', maxAge: FLOW_TTL_SEC });
    return c.redirect(await authUrl({ clientId: googleClientId(env)!, redirectUri: callbackUrl(c), flow }), 302);
  }),
);

/**
 * GET /api/auth/google/callback?code&state (or ?error, when the person said no): Google sending the
 * browser back. The flow cookie goes with this answer whatever happens (one use). The state must be
 * the cookie's; then the code exchange, the id_token's checks (services/google.ts verifyIdToken),
 * the account (googleAccount), and a session in both cookies, replacing the browser's session as
 * any sign-in does (startCookieSession: the flow cookie, which only a start from this app can set,
 * stands in for the same-origin check this cross-site page load cannot pass). Then the app at the
 * page it started from, `/?google=<new|back|linked>#<path>`; any failure is 登入 with
 * `?google_error=<code>`. At most GOOGLE_IP_PER_15M an IP in 15 minutes.
 */
authRoutes.get('/google/callback', c =>
  googlePage(c, 'callback', async () => {
    const env = c.env;
    const db = env.DB;
    const flow = decodeFlow(getCookie(c, FLOW_COOKIE, 'host'));
    deleteCookie(c, FLOW_COOKIE, { prefix: 'host', httpOnly: true, sameSite: 'Lax' });
    // The address holds the code until the next page: keep it out of any Referer.
    c.header('Referrer-Policy', 'no-referrer');
    const clientId = googleClientId(env);
    if (!googleAvailable(c) || !clientId) throw new GoogleError('unavailable', 'not set up on this site');
    await rateLimit(db, 'google-callback:ip:' + ipKey(clientIp(c)), limitFrom(env.GOOGLE_IP_PER_15M, GOOGLE_IP_PER_15M), 900);
    const said = c.req.query('error');
    if (said) {
      const name = /^[a-z_]{1,40}$/.test(said) ? said : 'other';
      throw new GoogleError(said === 'access_denied' ? 'denied' : 'failed', `Google answered ${name}`);
    }
    const state = c.req.query('state') ?? '';
    if (!flow) throw new GoogleError('state', 'no flow cookie');
    if (!constantTimeEqual(utf8.encode(state), utf8.encode(flow.state))) throw new GoogleError('state', 'state mismatch');
    const code = c.req.query('code') ?? '';
    if (!code || code.length > 2000) throw new GoogleError('failed', 'no code');
    const redirectUri = callbackUrl(c);
    const idToken = await exchangeCode(env, { code, redirectUri, verifier: flow.verifier });
    const who = await verifyIdToken(idToken, { clientId, nonce: flow.nonce });
    const email = codeEmail(who.email);
    if (!email) throw new GoogleError('failed', 'the email is not one an account can have');
    const { user, arrival } = await googleAccount(db, { ...who, email }, flow.locale);
    await startCookieSession(c, user.id, labelOf(c));
    return c.redirect(`/?google=${arrival}#${flow.returnTo}`, 302);
  }),
);

// ---------- this account's sessions ----------

/** Expire the cookies when the session just ended is the one they hold (not some other session a Bearer caller ended). */
async function clearIfCookieSession(c: Ctx, sessionId: string): Promise<void> {
  if ((await cookieSessionId(c)) === sessionId) clearSessionCookies(c);
}

authRoutes.post('/logout', requireUser, async c => {
  const sid = c.get('user').sessionId;
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  await clearIfCookieSession(c, sid);
  return json(c, { ok: true });
});

/**
 * Put the Bearer session of this request into the cookies, without a new session row (so tabs
 * that race to do it get the same cookie). The app moves the token an older build left in
 * localStorage this way, then checks that the browser kept the cookie before forgetting it.
 */
authRoutes.post('/cookie', requireUser, async c => {
  const me = c.get('user');
  const token = bearerToken(c);
  if (me.via !== 'bearer' || !token) fail(400, 'bad_request', 'Send the session as a Bearer token');
  if (!sameOrigin(c)) forbidden('Only the app on this site can keep its sign-in in a cookie');
  const user = (await getUser(c.env.DB, me.id)) ?? fail(401, 'unauthorized', 'Sign in first');
  setSessionCookies(c, token, me.id);
  return json(c, { user: toUserDTO(user, me.isOwner) });
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
  const id = c.req.param('id');
  const r = await c.env.DB
    .prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?')
    .bind(id, me.id)
    .run();
  if (!r.meta.changes) fail(404, 'not_found', 'Session not found');
  await clearIfCookieSession(c, id);
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
  const token = await startSession(c, user.id, labelOf(c));
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
  const token = await startSession(c, user.id, labelOf(c));
  return json(c, authRes(env, user, token));
});
