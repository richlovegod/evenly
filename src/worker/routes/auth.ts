// /api/auth: signup, login, sign in or sign up with an email code, with Google or with Apple,
// logout, sessions, sign in another device, password reset, and moving a Bearer token into the
// session cookie. Sign-ins from the app on this origin also get the session in cookies (auth.ts
// startSession); every JSON answer still carries the token. The web app makes new accounts with an
// email code, Google or Apple only; signup with a name alone stays for older clients, the iOS app
// and test scripts. On the web, Google (services/google.ts) and Apple (services/apple.ts) are page
// loads, not JSON: the app on this origin opens /google/start or /apple/start, and the callback
// answers with the session cookies and a redirect into the app. The iPhone app signs in with Apple
// by JSON (POST /apple), and with Google through the same pages, which hand it a one-time code for
// POST /google/exchange. Linking either from 我的 runs through the same routes.

import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { colorFor } from '../../shared/colors';
import { isKnownCurrency } from '../../shared/currencies';
import type {
  AppleErrorCode, AuthRes, EmailVerifyRes, GoogleErrorCode, LinkCodeRes, Locale, ProviderSignInRes, ProvidersRes, SessionDTO,
  SignInArrival,
} from '../../shared/types';
import {
  bearerToken, clearSessionCookies, constantTimeEqual, cookieSessionId, DUMMY_PASSWORD_HASH, hashPassword, ipKey, limitFrom,
  liveCookieSession, rateLimit, requireUser, sameOrigin, sessionIsLive, setSessionCookies, startCookieSession, startSession,
  validPassword, verifyPassword,
} from '../auth';
import {
  getUser, getUserByAppleSub, getUserByEmail, getUserByGoogleSub, isOwnerEmail, isUniqueViolation, toUserDTO, type UserRow,
} from '../db';
import type { AppEnv, Ctx, Env } from '../env';
import {
  ApiError, appOrigin, clientIp, deviceLabel, fail, forbidden, json, newId, nowISO, randomCode, randomToken, readJson, sha256Hex,
} from '../http';
import {
  afterAnswer, APPLE_FLOW_COOKIE, APPLE_FLOW_TTL_SEC, APPLE_IP_PER_15M, appleApiError, appleAppId, appleAuthUrl, appleCallbackUrl, AppleError,
  appleName, appleReady, appleServicesId, appleWebAvailable, checkAppCredential, decodeAppleFlow, encodeAppleFlow, exchangeAppleCode,
  keepAppleGrant, nameFromAppleUser, revokeAppleGrants, settleGrant, settleRefusedGrant, verifyAppleToken, type AppleFlow, type AppleIdentity,
} from '../services/apple';
import { checkCode, codeEmail, codeInvalid, consumeCode, countStart, invalidEmail, mayAskForCode, sendCode } from '../services/emailCodes';
import {
  APP_CODE_TTL_SEC, authUrl, callbackUrl, decodeFlow, encodeFlow, exchangeCode, FLOW_COOKIE, FLOW_TTL_SEC, flowState, flowTarget,
  GOOGLE_IP_PER_15M, GOOGLE_START_PATH, googleAvailable, googleClientId, googleConfigured, GoogleError, googleName, grantsEmail, IOS_CALLBACK_PATH,
  pkceChallenge, RANDOM_RE, safeReturn, stateTarget, verifyIdToken, type FlowTarget, type GoogleFlow, type GoogleIdentity,
  type LinkTarget,
} from '../services/google';
import { createPendingLink, emailUnconfirmed } from '../services/links';

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

/**
 * A new account (signup, an email code for an address with no account, or a Google account or an
 * Apple ID that is linked to none and whose email has none). The language and home currency come
 * from the request, leniently: an unknown one gets the default for the language.
 */
function newUserRow(o: {
  name: string; email: string | null; pwHash: string | null; emailVerifiedAt: string | null; locale: unknown; currency: unknown;
  googleSub?: string; appleSub?: string;
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
    apple_sub: o.appleSub ?? null,
  };
}

/**
 * Store a row from newUserRow. A taken email, Google account or Apple ID is D1's UNIQUE error
 * (isUniqueViolation 'users.email', 'users.google_sub' or 'users.apple_sub').
 */
async function insertUser(db: D1Database, u: UserRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, name, email, pw_hash, locale, currency, color, pay_info, venmo, paypal, activity_seen_at, created_at, updated_at, email_verified_at, google_sub, apple_sub)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      u.id, u.name, u.email, u.pw_hash, u.locale, u.currency, u.color, u.activity_seen_at, u.created_at, u.updated_at, u.email_verified_at,
      u.google_sub, u.apple_sub,
    )
    .run();
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
 * counts as confirmed from now on; one set before email codes is taken over by claimByEmail: its
 * password goes and its sessions end, `notice: "claimed"`), or, with a name, a new account is made
 * with it (created: true). Without an account and without a name: 400 name_required, and the code
 * is not spent, so the app asks for a name and sends it again. Unlike signup, a live session cookie
 * is no reason to refuse: this is a sign-in, so a page on this origin gets the new session in its
 * cookies and the one it held before ends (startSession), as with login.
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
  let claimed = false;
  if (user) {
    const r = (await claimByEmail(c, user)) ?? codeInvalid();
    user = r.user;
    claimed = r.claimed;
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
      const r = (await claimByEmail(c, taken)) ?? codeInvalid();
      user = r.user;
      claimed = r.claimed;
    }
  }
  const token = await startSession(c, user.id, labelOf(c));
  const res: EmailVerifyRes = { ...authRes(env, user, token), created, ...(claimed ? { notice: 'claimed' as const } : {}) };
  return json(c, res);
});

// ---------- Sign in with Google and with Apple (services/google.ts and apple.ts; docs/SPEC.md section 3) ----------

/**
 * What the sign-in pages may offer here; public, and the same for everyone on a site. The iPhone
 * app asks with ?client=ios: its Google flow runs on APP_URL's origin whatever site it asked
 * (googleStartUrl), and its Apple sign-in needs only the key and the app's own client id. Google
 * is offered to the app only together with Apple (App Review 4.8).
 */
authRoutes.get('/providers', async c => {
  const env = c.env;
  if (c.req.query('client') === 'ios') {
    const origin = appOrigin(env);
    const apple = await appleReady(env, appleAppId(env));
    const google = apple && googleConfigured(env) && !!origin;
    const res: ProvidersRes = { google, apple, googleStartUrl: google ? origin + GOOGLE_START_PATH : null };
    return json(c, res);
  }
  const res: ProvidersRes = { google: googleAvailable(c), apple: await appleWebAvailable(c) };
  return json(c, res);
});

/**
 * The start came from a page of this app: Sec-Fetch-Site same-origin when the browser sends it;
 * without it (Safari before 16.4), a Referer on this origin (the app's Referrer-Policy keeps it for
 * same-origin links). A link on another site, or the address typed in, is not one: a page elsewhere
 * could otherwise send its visitors through Google or Apple and back into an account here.
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

/**
 * The JSON sign-in routes only the iPhone app calls (POST /apple, POST /google/exchange) refuse a
 * browser request from another site before anything is counted (Sec-Fetch-Site cross-site or
 * same-site, or an Origin that is neither this site nor ALLOWED_ORIGINS, as mayAskForCode): a page
 * elsewhere could otherwise post there unseen and spend a network's limit. The app sends neither.
 */
function refuseOtherSites(c: Ctx): void {
  const site = c.req.header('Sec-Fetch-Site');
  if (site === 'cross-site' || site === 'same-site' || !mayAskForCode(c)) forbidden('Sign in from the app');
}

/**
 * The request came from a page (Sec-Fetch-Site cross-site or same-site): an image, a link or
 * window.open on some site. The iPhone app's ASWebAuthenticationSession opens its start itself,
 * which a browser marks none (or sends no Fetch Metadata at all): never this.
 */
function pageRequest(c: Ctx): string | null {
  const site = c.req.header('Sec-Fetch-Site');
  return site === 'cross-site' || site === 'same-site' ? site : null;
}

const utf8 = new TextEncoder();

/** The iPhone app's way back for a flow on this origin (services/google.ts IOS_CALLBACK_PATH). */
function iosCallback(c: Ctx): string {
  return new URL(c.req.url).origin + IOS_CALLBACK_PATH;
}

/**
 * Where a Google or Apple page load that failed sends the browser: 登入 with the code
 * (`?google_error=` or `?apple_error=`, which 登入 says in words), 我的 for a link (`?google_link=`,
 * `?apple_link=`), or the iPhone app's way back (`/app/auth/google?error=`).
 */
function flowFailure(c: Ctx, provider: 'google' | 'apple', target: FlowTarget, code: string, status: 302 | 303): Response {
  if (target === 'ios') return c.redirect(`${iosCallback(c)}?error=${code}`, status);
  if (target === 'link') return c.redirect(`/?${provider}_link=${code}#/account`, status);
  return c.redirect(`/?${provider}_error=${code}#/login`, status);
}

/** Both Google routes are page loads: every failure goes where `where` says (flowFailure), filled in once the route knows. */
async function googlePage(c: Ctx, route: 'start' | 'callback', where: { target: FlowTarget }, run: () => Promise<Response>): Promise<Response> {
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
    return flowFailure(c, 'google', where.target, code, 302);
  }
}

/** A new account's home currency from a start's or a request's `currency` (a known ISO 4217 code), else null (the language's). */
function askedCurrency(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return isKnownCurrency(v) ? v : null;
}

/**
 * The first sign-in that proves an account's email while it is still unconfirmed (an email code,
 * Google or Apple; docs/SPEC.md section 3, An unconfirmed email): in one batch the email counts as
 * confirmed, the password goes, every Apple ID or Google account linked before goes (Apple's
 * grants with it, revoked after the answer), and every session of the account ends (and with them
 * its push subscriptions and iPhone devices) along with its codes to sign in another device and
 * its pending links, since whoever typed that address in before email codes never proved it was
 * theirs and could have set any of those up. With `link`, the same batch links the Google account
 * or Apple ID. An email confirmed already changes nothing but the link. `claimed`: this sign-in
 * confirmed it and took something away (the password, a link, or a session), so the client says
 * so once (`notice: "claimed"`). null when the account changed in between (another email, or a
 * link of that kind): the caller looks again.
 */
async function claimByEmail(
  c: Ctx,
  owner: UserRow,
  link?: { column: 'google_sub' | 'apple_sub'; sub: string },
): Promise<{ user: UserRow; claimed: boolean } | null> {
  const db = c.env.DB;
  // The account as the update below finds it, with its email still unconfirmed (?1 its id, ?2 the
  // email). The batch is one transaction, so the statements before the update see what it sees.
  const found = `u.id = ?1 AND u.email = ?2 AND u.email_verified_at IS NULL${link ? ` AND u.${link.column} IS NULL` : ''}`;
  const unconfirmed = `EXISTS (SELECT 1 FROM users u WHERE ${found})`;
  // The links made before the email was proved: every one but the one this sign-in makes. (An
  // UPDATE's CASE reads the row as it was, so email_verified_at there is still the old one.)
  const others = (['google_sub', 'apple_sub'] as const).filter(col => col !== link?.column);
  const clear = others.map(col => `, ${col} = CASE WHEN email_verified_at IS NULL THEN NULL ELSE ${col} END`).join('');
  const update = link
    ? db
      .prepare(
        `UPDATE users SET ${link.column} = ?4${clear}, pw_hash = CASE WHEN email_verified_at IS NULL THEN NULL ELSE pw_hash END,
           email_verified_at = COALESCE(email_verified_at, ?3)
         WHERE id = ?1 AND email = ?2 AND ${link.column} IS NULL RETURNING *`,
      )
      .bind(owner.id, owner.email, nowISO(), link.sub)
    : db
      .prepare(
        `UPDATE users SET pw_hash = CASE WHEN email_verified_at IS NULL THEN NULL ELSE pw_hash END${clear},
           email_verified_at = COALESCE(email_verified_at, ?3)
         WHERE id = ?1 AND email = ?2 RETURNING *`,
      )
      .bind(owner.id, owner.email, nowISO());
  const hadLink = others.map(col => `u.${col} IS NOT NULL`).join(' OR ');
  const stmts: D1PreparedStatement[] = [
    db.prepare(`SELECT u.pw_hash IS NOT NULL AS had_password, (${hadLink}) AS had_link FROM users u WHERE ${found}`).bind(owner.id, owner.email),
    db.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND ${unconfirmed}`).bind(owner.id, owner.email),
    db.prepare(`DELETE FROM login_codes WHERE user_id = ?1 AND ${unconfirmed}`).bind(owner.id, owner.email),
    db.prepare(`DELETE FROM pending_links WHERE user_id = ?1 AND ${unconfirmed} RETURNING provider, sub, client_id, refresh_token`).bind(owner.id, owner.email),
  ];
  // Apple's grants go with an Apple ID cleared here (an Apple sign-in links the account's first).
  const grantsAt = others.includes('apple_sub')
    ? stmts.push(db.prepare(`DELETE FROM apple_grants WHERE user_id = ?1 AND ${unconfirmed} RETURNING client_id, refresh_token`).bind(owner.id, owner.email)) - 1
    : -1;
  stmts.push(update);
  const done = await db.batch(stmts);
  const user = (done[done.length - 1].results?.[0] as UserRow | undefined) ?? null;
  if (!user) return null;
  const took = done[0].results?.[0] as { had_password: number; had_link: number } | undefined;
  const grants = (grantsAt >= 0 ? done[grantsAt].results ?? [] : []) as { client_id: string; refresh_token: string }[];
  const pending = (done[3].results ?? []) as { provider: string; sub: string; client_id: string | null; refresh_token: string | null }[];
  const settle = pending.filter(p => p.provider === 'apple' && p.client_id && p.refresh_token);
  if (grants.length || settle.length) {
    await afterAnswer(
      c,
      Promise.all([
        revokeAppleGrants(c.env, grants),
        ...settle.map(p => settleGrant(c.env, { sub: p.sub, clientId: p.client_id!, refreshToken: p.refresh_token! })),
      ]),
    );
  }
  const removed = !!took && (Number(took.had_password) === 1 || Number(took.had_link) === 1 || (done[1].meta?.changes ?? 0) > 0);
  return { user, claimed: removed };
}

/**
 * The email a Google identity may find or make an account by: GoogleError `unverified` when Google
 * has verified none, `failed` for one no account can have (codeEmail).
 */
function accountEmail(who: GoogleIdentity): string {
  if (!who.email) throw new GoogleError('unverified', 'no verified email');
  const email = codeEmail(who.email);
  if (!email) throw new GoogleError('failed', 'the email is not one an account can have');
  return email;
}

/**
 * The account a verified Google identity signs in to: the one linked to its `sub`, whatever its
 * email, or none (`back`); else, by an email Google verified that an account can have
 * (accountEmail, asked only from here on), the one that has it, confirmed or not (Google has
 * verified the address, as a code would), which gets the link by claimByEmail (`linked`); else a
 * new one with Google's name, the email confirmed, the start's language and currency (the
 * language's when none, as at signup). An account with this email that is linked to another Google
 * account is refused (linked_other): its owner signs in with an email code instead. Another
 * request that linked or took the same thing a moment ago only means looking again.
 */
async function googleAccount(
  c: Ctx,
  who: GoogleIdentity,
  o: { locale: Locale; currency: string | null },
): Promise<{ user: UserRow; arrival: SignInArrival; claimed: boolean }> {
  const db = c.env.DB;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const linked = await getUserByGoogleSub(db, who.sub);
    if (linked) return { user: linked, arrival: 'back', claimed: false };
    const email = accountEmail(who);
    const owner = await getUserByEmail(db, email);
    try {
      if (owner) {
        // Linked to this Google account a moment ago (two sign-ins at once): that is `back`.
        if (owner.google_sub === who.sub) return { user: owner, arrival: 'back', claimed: false };
        if (owner.google_sub) throw new GoogleError('linked_other', 'the email is linked to another Google account');
        const r = await claimByEmail(c, owner, { column: 'google_sub', sub: who.sub });
        if (r) return { user: r.user, arrival: 'linked', claimed: r.claimed };
      } else {
        const fresh = newUserRow({
          name: googleName({ ...who, email }), email, pwHash: null, emailVerifiedAt: nowISO(), locale: o.locale, currency: o.currency, googleSub: who.sub,
        });
        await insertUser(db, fresh);
        return { user: fresh, arrival: 'new', claimed: false };
      }
    } catch (err) {
      if (!isUniqueViolation(err, 'users.google_sub') && !isUniqueViolation(err, 'users.email')) throw err;
    }
  }
  throw new GoogleError('server', 'the account kept changing');
}

/**
 * The account a verified Apple identity signs in to, by googleAccount's rules: the one linked to
 * its `sub` (`back`); else, with an email, the one that has it, confirmed or not (Apple has
 * verified it), which gets the link by claimByEmail (`linked`), or is refused when it has another
 * Apple ID (`linked_other`); else a new account (`new`) with the email, a relay address included,
 * confirmed, named by appleName (the client's name from Apple; never a relay address's letters),
 * in the client's language and currency. No email and no linked account: `no_email`.
 */
async function appleAccount(
  c: Ctx,
  who: AppleIdentity,
  o: { locale: Locale; name: string | null; currency: string | null },
): Promise<{ user: UserRow; arrival: SignInArrival; claimed: boolean }> {
  const db = c.env.DB;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const linked = await getUserByAppleSub(db, who.sub);
    if (linked) return { user: linked, arrival: 'back', claimed: false };
    if (!who.email) throw new AppleError('no_email', 'no usable email in the identity token');
    const owner = await getUserByEmail(db, who.email);
    try {
      if (owner) {
        if (owner.apple_sub === who.sub) return { user: owner, arrival: 'back', claimed: false };
        if (owner.apple_sub) throw new AppleError('linked_other', 'the email is linked to another Apple ID');
        const r = await claimByEmail(c, owner, { column: 'apple_sub', sub: who.sub });
        if (r) return { user: r.user, arrival: 'linked', claimed: r.claimed };
      } else {
        const name = appleName({ name: o.name, email: who.email, relay: who.relay, locale: o.locale });
        const fresh = newUserRow({ name, email: who.email, pwHash: null, emailVerifiedAt: nowISO(), locale: o.locale, currency: o.currency, appleSub: who.sub });
        await insertUser(db, fresh);
        return { user: fresh, arrival: 'new', claimed: false };
      }
    } catch (err) {
      if (!isUniqueViolation(err, 'users.apple_sub') && !isUniqueViolation(err, 'users.email')) throw err;
    }
  }
  throw new AppleError('server', 'the account kept changing');
}

/** A session token as the app sends it, in X-Evenly-Session (or, from builds before it, Authorization: Bearer). */
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

function appSessionToken(c: Ctx): string | null {
  const x = c.req.header('X-Evenly-Session')?.trim();
  if (x && SESSION_TOKEN_RE.test(x)) return x;
  return bearerToken(c);
}

/**
 * Spend a ticket of POST /api/me/google/ticket, opened by the app that asked for it: the request
 * carries that session (`X-Evenly-Session`, ASWebAuthenticationSession's additionalHeaderFields;
 * `Authorization: Bearer` works too), so a ticket URL that reached anyone else is no use to them.
 * The account and session it is for, else GoogleError `start` (the ticket is then left as it was).
 */
async function spendLinkTicket(c: Ctx, ticket: string): Promise<LinkTarget> {
  const db = c.env.DB;
  if (!RANDOM_RE.test(ticket)) throw new GoogleError('start', 'the ticket is not one');
  const token = appSessionToken(c);
  if (!token) throw new GoogleError('start', 'the ticket came without the session that asked for it');
  const now = nowISO();
  const row = await db
    .prepare(
      `UPDATE google_app_codes SET used_at = ? WHERE id = ? AND kind = 'link' AND session_id = ? AND used_at IS NULL AND expires_at > ?
       RETURNING user_id, session_id`,
    )
    .bind(now, await sha256Hex(ticket), await sha256Hex(token), now)
    .first<{ user_id: string; session_id: string }>();
  if (!row) throw new GoogleError('start', 'the ticket is unknown, used, expired or another session\'s');
  if (!(await sessionIsLive(db, row.session_id, row.user_id))) throw new GoogleError('start', 'the session that asked for the ticket has ended');
  return { userId: row.user_id, sessionId: row.session_id };
}

/** What a started flow is bound to, kept on the server (sign_in_flows), never in its cookie. */
interface FlowBinding {
  /** 'link': a link from 我的 for this account while this session lives; 'replace': a web Apple sign-in replacing this session. */
  kind: 'link' | 'replace';
  userId: string;
  sessionId: string;
}

/**
 * Keep a flow's binding, for as long as its cookie lives, by the SHA-256 of the cookie's secret,
 * which Apple and Google never see, with the SHA-256 of its state to compare when it comes back.
 */
async function bindFlow(db: D1Database, flow: { state: string; secret: string | null }, b: FlowBinding, ttlSec: number): Promise<void> {
  if (!flow.secret) throw new Error('a flow to bind needs its secret');
  const now = Date.now();
  await db
    .prepare('INSERT INTO sign_in_flows (id, kind, user_id, session_id, state_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(
      await sha256Hex(flow.secret), b.kind, b.userId, b.sessionId, await sha256Hex(flow.state),
      new Date(now + ttlSec * 1000).toISOString(), new Date(now).toISOString(),
    )
    .run();
}

/**
 * Take a flow's binding (once), found by its cookie's secret and its state together; null when it
 * has none, its cookie has no secret, or it expired. A state alone (a leaked URL) finds nothing and
 * leaves the binding where it is.
 */
async function takeFlowBinding(db: D1Database, flow: { state: string; secret: string | null }): Promise<FlowBinding | null> {
  if (!flow.secret) return null;
  const row = await db
    .prepare('DELETE FROM sign_in_flows WHERE id = ? AND state_hash = ? RETURNING kind, user_id, session_id, expires_at')
    .bind(await sha256Hex(flow.secret), await sha256Hex(flow.state))
    .first<{ kind: string; user_id: string; session_id: string; expires_at: string }>();
  if (!row || row.expires_at <= nowISO()) return null;
  return { kind: row.kind === 'link' ? 'link' : 'replace', userId: row.user_id, sessionId: row.session_id };
}

/** What the iPhone app's Google sign-in code carries until the exchange: the verified identity and the start's choices. */
interface AppIdentity extends GoogleIdentity {
  locale: Locale;
  currency: string | null;
}

/**
 * The one-time code that hands an iPhone app's Google sign-in to the app. It carries the verified
 * identity, not an account: POST /google/exchange finds or makes the account after the verifier
 * check, so a code nobody exchanges changes nothing.
 */
async function issueSignInCode(db: D1Database, o: { challenge: string; identity: AppIdentity }): Promise<string> {
  const code = randomToken(32);
  const now = Date.now();
  await db
    .prepare('INSERT INTO google_sign_in_codes (id, challenge, identity, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(code), o.challenge, JSON.stringify(o.identity), new Date(now + APP_CODE_TTL_SEC * 1000).toISOString(), new Date(now).toISOString())
    .run();
  return code;
}

/**
 * GET /api/auth/google/start?return=<hash route>&locale=<zh-TW|en>&currency=: from the app on this
 * site only (startedHere), at most GOOGLE_IP_PER_15M an IP in 15 minutes. Keeps the flow (state,
 * nonce, PKCE verifier, a secret Google never sees, the page to come back to, the language and the
 * currency) in __Host-evenly_google, HttpOnly, SameSite=Lax (the callback is a page load from
 * Google, which Lax lets through), 10 minutes, and sends the browser to Google's consent page. A
 * new start replaces an older flow in this browser. With `link=1`: a link from 我的 for the account
 * this browser's cookie is signed in to (the account and its session are bound to the flow on the
 * server, sign_in_flows). The iPhone app's, `client=ios`: with the `challenge` of a verifier the
 * app keeps (a sign-in), or with a `ticket` of POST /api/me/google/ticket and that session as
 * X-Evenly-Session (a link, spent here). No startedHere there, since only the app that holds the
 * verifier, or the session, can use the answer; it counts under its own key, so pages elsewhere
 * that start it cannot spend the web's starts, and its failures go to the app's way back.
 */
authRoutes.get('/google/start', c => {
  const where: { target: FlowTarget } = { target: c.req.query('client') === 'ios' ? 'ios' : c.req.query('link') === '1' ? 'link' : 'web' };
  return googlePage(c, 'start', where, async () => {
    const env = c.env;
    const db = env.DB;
    if (!googleAvailable(c)) throw new GoogleError('unavailable', 'not set up on this site');
    if (where.target !== 'ios' && !startedHere(c)) throw new GoogleError('start', 'not started from the app on this site');
    // Before it counts or sets a cookie: a page elsewhere that loads or opens the iPhone start can
    // neither spend the network's starts nor replace a web sign-in's flow cookie in this browser.
    const page = where.target === 'ios' ? pageRequest(c) : null;
    if (page) throw new GoogleError('start', `an iPhone start from a page (Sec-Fetch-Site ${page})`);
    const key = where.target === 'ios' ? 'google-ios-start:ip:' : 'google-start:ip:';
    await rateLimit(db, key + ipKey(clientIp(c)), limitFrom(env.GOOGLE_IP_PER_15M, GOOGLE_IP_PER_15M), 900);
    let challenge: string | null = null;
    let link: LinkTarget | null = null;
    if (where.target === 'ios') {
      const ticket = c.req.query('ticket');
      if (ticket !== undefined) {
        link = await spendLinkTicket(c, ticket);
      } else {
        challenge = c.req.query('challenge') ?? '';
        if (!RANDOM_RE.test(challenge)) throw new GoogleError('start', 'no challenge');
      }
    } else if (where.target === 'link') {
      const live = await liveCookieSession(c);
      if (!live) throw new GoogleError('start', 'a link needs a signed-in session');
      link = { userId: live.userId, sessionId: await sha256Hex(live.token) };
    }
    if (link && (await emailUnconfirmed(db, link.userId))) throw new GoogleError('email_unconfirmed', 'a link to an account whose email is not confirmed');
    const flow: GoogleFlow = {
      state: randomToken(32),
      nonce: randomToken(32),
      verifier: randomToken(32),
      secret: randomToken(32),
      returnTo: safeReturn(c.req.query('return')),
      locale: pickLocale(c.req.query('locale') || c.req.header('Accept-Language')),
      currency: askedCurrency(c.req.query('currency')),
      client: where.target === 'ios' ? 'ios' : 'web',
      challenge,
      link: !!link,
    };
    if (link) await bindFlow(db, flow, { kind: 'link', ...link }, FLOW_TTL_SEC);
    setCookie(c, FLOW_COOKIE, encodeFlow(flow), { prefix: 'host', httpOnly: true, sameSite: 'Lax', maxAge: FLOW_TTL_SEC });
    return c.redirect(await authUrl({ clientId: googleClientId(env)!, redirectUri: callbackUrl(c), flow }), 302);
  });
});

/**
 * GET /api/auth/google/callback?code&state (or ?error, when the person said no): Google sending the
 * browser back. Nothing is counted or cleared until the state is this browser's flow's: a page
 * elsewhere that loads this address cannot end a sign-in in progress or spend the limit. Then the
 * flow cookie goes (one use), its binding is taken (by the cookie's secret and the state), and
 * after the code exchange and the id_token's checks (services/google.ts verifyIdToken), by the
 * flow:
 * - a link (我的, or the iPhone app's ticket): only while the session that started it lives (checked
 *   before Google is asked), the Google account waits as a pending link for the client's
 *   confirmation (services/links.ts), and the browser goes to 我的 with `?link_pending=<id>`, or
 *   the app to `/app/auth/google?pending=<id>`;
 * - the iPhone app's sign-in: a one-time code for the app with the verified identity (no account
 *   is found or made before the exchange), `/app/auth/google?code=`, with no cookie;
 * - the web's: the account (googleAccount, which may take over an unconfirmed email:
 *   `&notice=claimed`) and a session in both cookies, replacing the browser's session as any
 *   sign-in does (startCookieSession: the flow cookie, which only a start from this app can set,
 *   stands in for the same-origin check this cross-site page load cannot pass), then the app at the
 *   page it started from, `/?google=<new|back|linked>#<path>`.
 * Any failure goes where flowFailure says. At most GOOGLE_IP_PER_15M an IP in 15 minutes.
 */
authRoutes.get('/google/callback', c => {
  const where: { target: FlowTarget } = { target: stateTarget(c.req.query('state')) };
  return googlePage(c, 'callback', where, async () => {
    const env = c.env;
    const db = env.DB;
    const flow = decodeFlow(getCookie(c, FLOW_COOKIE, 'host'));
    if (flow) where.target = flowTarget(flow);
    // The address holds the code until the next page: keep it out of any Referer.
    c.header('Referrer-Policy', 'no-referrer');
    const clientId = googleClientId(env);
    if (!googleAvailable(c) || !clientId) throw new GoogleError('unavailable', 'not set up on this site');
    const state = c.req.query('state') ?? '';
    const ours = !!flow && constantTimeEqual(utf8.encode(state), utf8.encode(flowState(flow)));
    if (ours) {
      deleteCookie(c, FLOW_COOKIE, { prefix: 'host', httpOnly: true, sameSite: 'Lax' });
      await rateLimit(db, 'google-callback:ip:' + ipKey(clientIp(c)), limitFrom(env.GOOGLE_IP_PER_15M, GOOGLE_IP_PER_15M), 900);
    }
    const said = c.req.query('error');
    if (said) {
      const name = /^[a-z_]{1,40}$/.test(said) ? said : 'other';
      throw new GoogleError(said === 'access_denied' ? 'denied' : 'failed', `Google answered ${name}`);
    }
    if (!flow) throw new GoogleError('state', 'no flow cookie');
    if (!ours) throw new GoogleError('state', 'state mismatch');
    // A link's account and session come from the server, never from the cookie.
    const bound = await takeFlowBinding(db, flow);
    const link = bound?.kind === 'link' ? bound : null;
    if (flow.link !== !!link) throw new GoogleError('state', flow.link ? 'the link is not bound on the server' : 'a bound flow its cookie does not call a link');
    if (link && !(await sessionIsLive(db, link.sessionId, link.userId))) throw new GoogleError('state', 'the session that started the link has ended');
    const code = c.req.query('code') ?? '';
    if (!code || code.length > 2000) throw new GoogleError('failed', 'no code');
    const { idToken, scope } = await exchangeCode(env, { code, redirectUri: callbackUrl(c), verifier: flow.verifier });
    const who = await verifyIdToken(idToken, { clientId, nonce: flow.nonce });
    if (link) {
      // The question before 連結 names the Google account by the email Google verified: an answer
      // granted without the email scope (an edited consent URL), or with no verified email, names
      // none, and is refused.
      if (!grantsEmail(scope) || !who.email) throw new GoogleError('unverified', 'a link needs the email Google verified');
      const id = await createPendingLink(db, {
        userId: link.userId, sessionId: link.sessionId,
        link: { provider: 'google', sub: who.sub, email: codeEmail(who.email) ?? who.email, clientId: null, refreshToken: null },
      });
      return flow.client === 'ios' ? c.redirect(`${iosCallback(c)}?pending=${id}`, 302) : c.redirect(`/?link_pending=${id}#/account`, 302);
    }
    if (flow.client === 'ios') {
      // Only a sign-in that can end in an account is handed over: a linked Google account, or an email one can have.
      if (!(await getUserByGoogleSub(db, who.sub))) accountEmail(who);
      const handoff = await issueSignInCode(db, { challenge: flow.challenge!, identity: { ...who, locale: flow.locale, currency: flow.currency } });
      return c.redirect(`${iosCallback(c)}?code=${handoff}`, 302);
    }
    const { user, arrival, claimed } = await googleAccount(c, who, { locale: flow.locale, currency: flow.currency });
    await startCookieSession(c, user.id, labelOf(c));
    return c.redirect(`/?google=${arrival}${claimed ? '&notice=claimed' : ''}#${flow.returnTo}`, 302);
  });
});

const exchangeSchema = z.object({ code: z.string().max(200), verifier: z.string().max(200) });
/** RFC 7636's code_verifier: 43 to 128 unreserved characters. */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** The identity a sign-in code carries, or null for a row this code did not write. */
function appIdentity(raw: string): AppIdentity | null {
  try {
    const o = JSON.parse(raw) as Partial<AppIdentity> | null;
    if (!o || typeof o.sub !== 'string' || !o.sub || typeof o.email !== 'string') return null;
    return {
      sub: o.sub, email: o.email, givenName: typeof o.givenName === 'string' ? o.givenName : '', name: typeof o.name === 'string' ? o.name : '',
      locale: o.locale === 'en' ? 'en' : 'zh-TW', currency: askedCurrency(o.currency),
    };
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/google/exchange {code, verifier}: the iPhone app's end of its Google sign-in. The
 * code the callback handed it (5 minutes, one use: this request spends it, right or wrong) and the
 * verifier whose challenge the start kept; only then is the account found or made (googleAccount,
 * with the start's language and currency), and a Bearer session made as for the app's other
 * sign-ins, with how it came about (`arrival`, and `notice: "claimed"` when it took an unconfirmed
 * email over). 401 code_invalid (no 401 signs the app out here: it sends no token), 409
 * linked_other. A browser request from another site is 403 before it counts; at most
 * GOOGLE_IP_PER_15M an IP in 15 minutes.
 */
authRoutes.post('/google/exchange', async c => {
  const env = c.env;
  const db = env.DB;
  refuseOtherSites(c);
  await rateLimit(db, 'google-exchange:ip:' + ipKey(clientIp(c)), limitFrom(env.GOOGLE_IP_PER_15M, GOOGLE_IP_PER_15M), 900);
  const body = await readJson(c, exchangeSchema);
  const wrong = (): never => fail(401, 'code_invalid', 'This code is wrong or has expired');
  const now = nowISO();
  const hit = await db
    .prepare('UPDATE google_sign_in_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? RETURNING challenge, identity')
    .bind(now, await sha256Hex(body.code), now)
    .first<{ challenge: string; identity: string }>();
  if (!hit) wrong();
  if (!VERIFIER_RE.test(body.verifier) || !constantTimeEqual(utf8.encode(await pkceChallenge(body.verifier)), utf8.encode(hit!.challenge))) wrong();
  const identity = appIdentity(hit!.identity) ?? wrong();
  let account: { user: UserRow; arrival: SignInArrival; claimed: boolean };
  try {
    account = await googleAccount(c, identity, { locale: identity.locale, currency: identity.currency });
  } catch (err) {
    if (!(err instanceof GoogleError)) throw err;
    console.warn(`google exchange: ${err.detail}`);
    if (err.code === 'linked_other') fail(409, 'linked_other', 'The account with this email is linked to another Google account');
    wrong();
  }
  const token = await startSession(c, account!.user.id, labelOf(c));
  const res: ProviderSignInRes = { ...authRes(env, account!.user, token), arrival: account!.arrival, ...(account!.claimed ? { notice: 'claimed' as const } : {}) };
  return json(c, res);
});

/** The iPhone app's Apple credential (POST /api/auth/apple; POST /api/me/apple without name, locale and currency). */
export const appleCredentialSchema = z.object({
  identityToken: z.string().min(1).max(10_000),
  authorizationCode: z.string().min(1).max(2_000),
  nonce: z.string().regex(/^[\x20-\x7E]{16,256}$/, 'Send the raw nonce: 16 to 256 printable ASCII characters'),
});

const appleSignInSchema = appleCredentialSchema.extend({
  // Lenient, as at signup: a name of any length is cut to 60 characters (appleName), and an unknown currency falls back.
  name: z.union([z.string().max(1000), z.null()]).optional(),
  locale: z.unknown().optional(),
  currency: z.unknown().optional(),
});

/**
 * POST /api/auth/apple {identityToken, authorizationCode, nonce, name?, locale, currency?}: the
 * iPhone app's Sign in with Apple. The credential is checked (services/apple.ts checkAppCredential:
 * the token for the app's bundle id with the SHA-256 hex of the raw nonce, and the code exchanged,
 * which a sign-in needs), the account found or made (appleAccount), the refresh token kept to
 * revoke it some day, and a session made as for the app's other sign-ins. AuthRes plus `arrival`
 * (and `notice: "claimed"`). 401 apple_invalid, 409 linked_other and no_email, 503
 * apple_unavailable (appleApiError); a browser request from another site is 403 before it counts;
 * at most APPLE_IP_PER_15M an IP in 15 minutes.
 */
authRoutes.post('/apple', async c => {
  const env = c.env;
  const db = env.DB;
  refuseOtherSites(c);
  await rateLimit(db, 'apple:ip:' + ipKey(clientIp(c)), limitFrom(env.APPLE_IP_PER_15M, APPLE_IP_PER_15M), 900);
  const body = await readJson(c, appleSignInSchema);
  try {
    const { who, grant, clientId } = await checkAppCredential(c, body);
    try {
      const { user, arrival, claimed } = await appleAccount(c, who, { locale: pickLocale(body.locale), name: body.name ?? null, currency: askedCurrency(body.currency) });
      await keepAppleGrant(db, user.id, clientId, grant.refreshToken);
      const token = await startSession(c, user.id, labelOf(c));
      const res: ProviderSignInRes = { ...authRes(env, user, token), arrival, ...(claimed ? { notice: 'claimed' as const } : {}) };
      return json(c, res);
    } catch (err) {
      await settleRefusedGrant(c, grant, clientId);
      throw err;
    }
  } catch (err) {
    return appleApiError(err, 'sign-in', 401);
  }
});

/** The web's Apple routes are page loads too: failures go to 登入, or to 我的 for a link (flowFailure). */
async function applePage(c: Ctx, route: 'start' | 'callback', where: { target: FlowTarget }, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    let code: AppleErrorCode = 'server';
    // Names only: never the code, a token or an address.
    if (err instanceof AppleError) {
      code = err.code;
      console.warn(`apple ${route}: ${err.detail}`);
    } else if (err instanceof ApiError && err.status === 429) {
      code = 'rate_limited';
    } else {
      console.error(`apple ${route}: ${err instanceof Error ? err.name : 'error'}`);
    }
    // After Apple's POST, 303 makes the next page a GET.
    return flowFailure(c, 'apple', where.target, code, route === 'callback' ? 303 : 302);
  }
}

/**
 * GET /api/auth/apple/start?return=<hash route>&locale=<zh-TW|en>&currency= (and `link=1` from
 * 我的): the web's Sign in with Apple, from the app on this site only (startedHere), at most
 * APPLE_IP_PER_15M an IP in 15 minutes. Keeps the flow (state, nonce, a secret Apple never sees,
 * the page to come back to, the language and the currency) in __Host-evenly_apple, HttpOnly, 10
 * minutes, SameSite=None: Apple comes back with a cross-site POST, which a Lax cookie would not
 * ride. The session this browser's cookie holds is bound to the flow on the server (sign_in_flows,
 * by the secret): for a link, the account to link to while it lives; else the session the sign-in
 * replaces. Then Apple's consent page for the Services ID, asking for the name and the email
 * (response_mode form_post).
 */
authRoutes.get('/apple/start', c => {
  const where: { target: FlowTarget } = { target: c.req.query('link') === '1' ? 'link' : 'web' };
  return applePage(c, 'start', where, async () => {
    const env = c.env;
    const clientId = appleServicesId(env);
    if (!clientId || !(await appleWebAvailable(c))) throw new AppleError('unavailable', 'not set up on this site');
    if (!startedHere(c)) throw new AppleError('start', 'not started from the app on this site');
    await rateLimit(env.DB, 'apple-start:ip:' + ipKey(clientIp(c)), limitFrom(env.APPLE_IP_PER_15M, APPLE_IP_PER_15M), 900);
    const live = await liveCookieSession(c);
    if (where.target === 'link' && !live) throw new AppleError('start', 'a link needs a signed-in session');
    if (where.target === 'link' && (await emailUnconfirmed(env.DB, live!.userId))) throw new AppleError('email_unconfirmed', 'a link to an account whose email is not confirmed');
    const flow: AppleFlow = {
      state: randomToken(32),
      secret: randomToken(32),
      nonce: randomToken(32),
      returnTo: safeReturn(c.req.query('return')),
      locale: pickLocale(c.req.query('locale') || c.req.header('Accept-Language')),
      currency: askedCurrency(c.req.query('currency')),
      link: where.target === 'link',
    };
    if (live) {
      const kind = flow.link ? 'link' : 'replace';
      await bindFlow(env.DB, flow, { kind, userId: live.userId, sessionId: await sha256Hex(live.token) }, APPLE_FLOW_TTL_SEC);
    }
    setCookie(c, APPLE_FLOW_COOKIE, encodeAppleFlow(flow), { prefix: 'host', httpOnly: true, sameSite: 'None', maxAge: APPLE_FLOW_TTL_SEC });
    return c.redirect(appleAuthUrl({ clientId, redirectUri: appleCallbackUrl(c), state: flowState(flow), nonce: flow.nonce }), 302);
  });
});

/** Apple's form post (application/x-www-form-urlencoded); anything else reads as an empty form. */
async function readForm(c: Ctx): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(c.req.header('Content-Type') || '')) return new URLSearchParams();
  const text = await c.req.text();
  return text.length <= 64_000 ? new URLSearchParams(text) : new URLSearchParams();
}

/**
 * POST /api/auth/apple/callback, Apple's form post: `code`, `id_token`, `state` and, on the first
 * authorization only, `user` (JSON with the name), or `error` (user_cancelled_authorize when the
 * person said no). A cross-site POST from appleid.apple.com, so no same-origin check applies (no
 * route here makes one): the flow cookie, which only a start from this app can set, its state and
 * its secret are the check. Nothing is counted or cleared until the state is this browser's flow's
 * (this SameSite=None cookie rides any site's form post, which must not end a sign-in in progress
 * or spend the limit). Then the flow's binding (by the cookie's secret and the state), the identity
 * token (for the Services ID, with the flow's nonce), the code exchange (required), and by the
 * flow: a link (only while the session that started it lives, checked before Apple is asked) waits
 * as a pending link (with its grant) for the client's confirmation, `/?link_pending=<id>#/account`;
 * or the account (appleAccount, the
 * name from `user` for a new one; `&notice=claimed` when it took an unconfirmed email over) and a
 * session in both cookies, the session the start saw deleted, then the app at
 * `/?apple=<new|back|linked>#<path>`, the refresh token kept to revoke it some day. A refusal after
 * the exchange settles the grant (settleRefusedGrant). Failures: flowFailure. 303 throughout, so
 * the next page is a GET. At most APPLE_IP_PER_15M an IP in 15 minutes.
 */
authRoutes.post('/apple/callback', c => {
  const where: { target: FlowTarget } = { target: 'web' };
  return applePage(c, 'callback', where, async () => {
    const env = c.env;
    const db = env.DB;
    const flow = decodeAppleFlow(getCookie(c, APPLE_FLOW_COOKIE, 'host'));
    c.header('Referrer-Policy', 'no-referrer');
    const form = await readForm(c);
    const state = form.get('state') ?? '';
    // A web flow only: a state marked for the iPhone app's Google flow means nothing here.
    where.target = flow ? flowTarget(flow) : stateTarget(state) === 'link' ? 'link' : 'web';
    const clientId = appleServicesId(env);
    if (!clientId || !(await appleWebAvailable(c))) throw new AppleError('unavailable', 'not set up on this site');
    const ours = !!flow && constantTimeEqual(utf8.encode(state), utf8.encode(flowState(flow)));
    if (ours) {
      deleteCookie(c, APPLE_FLOW_COOKIE, { prefix: 'host', httpOnly: true, sameSite: 'None' });
      await rateLimit(db, 'apple-callback:ip:' + ipKey(clientIp(c)), limitFrom(env.APPLE_IP_PER_15M, APPLE_IP_PER_15M), 900);
    }
    const said = form.get('error');
    if (said) {
      const name = /^[a-z_]{1,40}$/.test(said) ? said : 'other';
      throw new AppleError(said === 'user_cancelled_authorize' ? 'denied' : 'failed', `Apple answered ${name}`);
    }
    if (!flow) throw new AppleError('state', 'no flow cookie');
    if (!ours) throw new AppleError('state', 'state mismatch');
    // A link's account and session, and the session a sign-in replaces, come from the server.
    const bound = await takeFlowBinding(db, flow);
    const link = bound?.kind === 'link' ? bound : null;
    if (flow.link !== !!link) throw new AppleError('state', flow.link ? 'the link is not bound on the server' : 'a bound flow its cookie does not call a link');
    if (link && !(await sessionIsLive(db, link.sessionId, link.userId))) throw new AppleError('state', 'the session that started the link has ended');
    const code = form.get('code') ?? '';
    const idToken = form.get('id_token') ?? '';
    if (!code || code.length > 2000 || !idToken || idToken.length > 10_000) throw new AppleError('failed', 'no code or id_token');
    const who = await verifyAppleToken(idToken, { clientId, nonce: flow.nonce });
    const grant = await exchangeAppleCode(env, { clientId, code, redirectUri: appleCallbackUrl(c) });
    try {
      if (grant.sub !== who.sub) throw new AppleError('failed', 'the exchanged id_token names another Apple ID');
      if (link) {
        const id = await createPendingLink(db, {
          userId: link.userId, sessionId: link.sessionId,
          link: { provider: 'apple', sub: who.sub, email: who.email, clientId, refreshToken: grant.refreshToken },
        });
        return c.redirect(`/?link_pending=${id}#/account`, 303);
      }
      const { user, arrival, claimed } = await appleAccount(c, who, {
        locale: flow.locale, name: nameFromAppleUser(form.get('user')) || null, currency: flow.currency,
      });
      await keepAppleGrant(db, user.id, clientId, grant.refreshToken);
      await startCookieSession(c, user.id, labelOf(c), bound?.kind === 'replace' ? bound.sessionId : null);
      return c.redirect(`/?apple=${arrival}${claimed ? '&notice=claimed' : ''}#${flow.returnTo}`, 303);
    } catch (err) {
      await settleRefusedGrant(c, grant, clientId);
      throw err;
    }
  });
});

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
