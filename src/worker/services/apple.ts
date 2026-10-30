// Sign in with Apple (docs/SPEC.md section 3, Apple), for the iPhone app and the web. The iPhone
// app gets an identity token and an authorization code from AuthenticationServices and sends them
// (POST /api/auth/apple, routes/auth.ts). The web runs OAuth 2.0 against appleid.apple.com from the
// Worker alone, as for Google, so no Apple script ever loads on our pages: GET /api/auth/apple/start
// keeps a state and a nonce in a 10-minute cookie and sends the browser to Apple, and Apple posts the
// answer back to /api/auth/apple/callback. Either way this module checks the identity token (RS256
// against Apple's published keys, kept in memory; the issuer, the audience, the expiry and the
// nonce), exchanges the code at Apple's token endpoint with a client secret it signs (an ES256 JWT
// with the Sign in with Apple key, signed as services/apns.ts signs its provider token), and
// revokes the grant when the account is deleted. The refresh token from the exchange is kept only
// for that (apple_grants). Nothing here logs a code, a token, a key or an address: only what failed,
// by name, and the status and error name Apple answered.

import type { ApiErrorCode, AppleErrorCode, Locale } from '../../shared/types';
import { getUserByAppleSub } from '../db';
import type { Ctx, Env } from '../env';
import { b64url, fail, fromB64url, nowISO, onAppSite, sha256Hex } from '../http';
import { es256Jwt, pkcs8FromPem } from './apns';
import { codeEmail } from './emailCodes';
import { cookieJson, fitName, RANDOM_RE, safeReturn } from './google';

// ---------- Apple's endpoints (tests send them elsewhere) ----------

export interface AppleEndpoints {
  authorize: string;
  token: string;
  revoke: string;
  keys: string;
}

export const APPLE_ENDPOINTS: Readonly<AppleEndpoints> = {
  authorize: 'https://appleid.apple.com/auth/authorize',
  token: 'https://appleid.apple.com/auth/token',
  revoke: 'https://appleid.apple.com/auth/revoke',
  keys: 'https://appleid.apple.com/auth/keys',
};

let endpoints: AppleEndpoints = { ...APPLE_ENDPOINTS };

/** Tests: send this module's requests to stand-ins, or (no argument) to Apple again. Forgets the kept keys. */
export function setAppleEndpoints(e: Partial<AppleEndpoints> = {}): void {
  endpoints = { ...APPLE_ENDPOINTS, ...e };
  keySet = null;
}

/** The identity token's `iss`, and the client secret's `aud`. */
export const APPLE_ISSUER = 'https://appleid.apple.com';
/** The web asks for the name and the email, so Apple wants response_mode=form_post. */
export const APPLE_SCOPE = 'name email';
/** Where Apple posts the web's answer, on the site's own origin (a return URL of the Services ID). */
export const APPLE_CALLBACK_PATH = '/api/auth/apple/callback';
/** Each request to Apple gives up after this long. */
export const APPLE_TIMEOUT_MS = 10_000;
/** How long a started web sign-in may take (the flow cookie's Max-Age). */
export const APPLE_FLOW_TTL_SEC = 600;
/** The web's flow cookie, without the __Host- prefix (hono/cookie adds it with prefix: 'host'). */
export const APPLE_FLOW_COOKIE = 'evenly_apple';
/** Default of APPLE_IP_PER_15M: the iPhone app's sign-ins, and the web's starts and callbacks, per IP in 15 minutes. */
export const APPLE_IP_PER_15M = 20;
/** The client secret's life. Apple takes up to six months; this one is signed for each request. */
export const CLIENT_SECRET_TTL_SEC = 300;
/** Hide My Email: the addresses Apple forwards to the person's own. */
export const RELAY_DOMAIN = 'privaterelay.appleid.com';
/** Seconds the identity token's exp and iat may be off from our clock. */
const CLOCK_SKEW_SEC = 60;
/** Apple's keys answer Cache-Control: no-store: kept a day here, and fetched again sooner for a key id the set lacks. */
const KEY_TTL_MS = 86_400_000;
/** An unknown key id fetches the keys again at most once a minute, so made-up ids cannot make every request fetch. */
const REFETCH_GAP_MS = 60_000;
/** Apple's key ids and team ids: 10 characters, A to Z and 0 to 9. */
const APPLE_ID_RE = /^[A-Z0-9]{10}$/;

/** A sign-in that cannot go on: `code` is what 登入 or the app shows, `detail` what the log says (never a value). */
export class AppleError extends Error {
  constructor(
    public code: AppleErrorCode,
    public detail: string,
  ) {
    super(detail);
  }
}

// ---------- configuration ----------

/** The Sign in with Apple key, imported: what the client secret is signed with. */
export interface AppleSigning {
  keyId: string;
  teamId: string;
  key: CryptoKey;
}

let signingMemo: { source: string; signing: Promise<AppleSigning | null> } | null = null;

/**
 * The key from the env, imported once per isolate. Null when Sign in with Apple is not set up: the
 * key's id, the team or the secret is missing, an id is not one of Apple's, or the secret is not a
 * P-256 private key in PEM.
 */
export function appleSigning(env: Pick<Env, 'APPLE_SIGNIN_KEY_ID' | 'APPLE_TEAM_ID' | 'APPLE_SIGNIN_KEY'>): Promise<AppleSigning | null> {
  const keyId = (env.APPLE_SIGNIN_KEY_ID ?? '').trim();
  const teamId = (env.APPLE_TEAM_ID ?? '').trim();
  const pem = env.APPLE_SIGNIN_KEY ?? '';
  if (!keyId || !teamId || !pem.trim()) return Promise.resolve(null);
  const source = [keyId, teamId, pem].join('\n');
  if (signingMemo?.source !== source) signingMemo = { source, signing: importSigning(keyId, teamId, pem) };
  return signingMemo.signing;
}

/** Logs a fixed message only: an error from atob or importKey could quote the secret. */
function unusable(why: string): null {
  console.error('apple: the Sign in with Apple key is not usable: ' + why);
  return null;
}

async function importSigning(keyId: string, teamId: string, pem: string): Promise<AppleSigning | null> {
  if (!APPLE_ID_RE.test(keyId)) return unusable('APPLE_SIGNIN_KEY_ID is not an Apple key id');
  if (!APPLE_ID_RE.test(teamId)) return unusable('APPLE_TEAM_ID is not an Apple team id');
  const der = pkcs8FromPem(pem);
  if (!der) return unusable('APPLE_SIGNIN_KEY is not a PEM private key');
  try {
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { keyId, teamId, key };
  } catch {
    return unusable('APPLE_SIGNIN_KEY is not a P-256 private key');
  }
}

/** The iPhone app's client_id (its bundle id, the primary App ID), or null. */
export function appleAppId(env: Pick<Env, 'APPLE_APP_ID'>): string | null {
  return env.APPLE_APP_ID?.trim() || null;
}

/** The web's client_id (the Services ID), or null. */
export function appleServicesId(env: Pick<Env, 'APPLE_SERVICES_ID'>): string | null {
  return env.APPLE_SERVICES_ID?.trim() || null;
}

/** Sign in with Apple can work for `clientId`: it is set and the key is usable. */
export async function appleReady(env: Env, clientId: string | null): Promise<boolean> {
  return !!clientId && !!(await appleSigning(env));
}

/** The web on this request's site may offer Apple: set up, and on APP_URL's origin (the return URLs Apple has). */
export async function appleWebAvailable(c: Ctx): Promise<boolean> {
  return onAppSite(c) && appleReady(c.env, appleServicesId(c.env));
}

/** The web's callback on this request's origin: the redirect_uri of both the start and the code exchange. */
export function appleCallbackUrl(c: Ctx): string {
  return new URL(c.req.url).origin + APPLE_CALLBACK_PATH;
}

// ---------- the client secret ----------

/**
 * The client secret for `clientId`: an ES256 JWT with the key's id in its header, `iss` the team,
 * `sub` the client, `aud` Apple, and five minutes to live.
 */
export function appleClientSecret(s: AppleSigning, clientId: string, nowMs = Date.now()): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  return es256Jwt(s.key, { kid: s.keyId }, { iss: s.teamId, iat, exp: iat + CLIENT_SECRET_TTL_SEC, aud: APPLE_ISSUER, sub: clientId });
}

// ---------- to Apple and back ----------

/** A request to Apple within APPLE_TIMEOUT_MS, never following a redirect; AppleError `unavailable` without an answer. */
async function askApple(url: string, init: RequestInit, what: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), APPLE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'manual' });
  } catch (err) {
    const why = ctrl.signal.aborted ? 'timeout' : err instanceof Error ? err.name : 'error';
    throw new AppleError('unavailable', `no answer from Apple's ${what} (${why})`);
  } finally {
    clearTimeout(timer);
  }
}

/** Apple's error name from an answer's JSON (`invalid_grant`, `invalid_client`), letters and _ only, else 'unknown'. */
async function errorName(res: Response): Promise<string> {
  try {
    const e = ((await res.json()) as { error?: unknown } | null)?.error;
    return typeof e === 'string' && /^[a-z_]{1,40}$/.test(e) ? e : 'unknown';
  } catch {
    return 'unknown';
  }
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };

/** The web's consent page for a started flow (spaces as %20, as Apple's documentation writes them). */
export function appleAuthUrl(o: { clientId: string; redirectUri: string; state: string; nonce: string }): string {
  const q: [string, string][] = [
    ['client_id', o.clientId],
    ['redirect_uri', o.redirectUri],
    ['response_type', 'code id_token'],
    ['response_mode', 'form_post'],
    ['scope', APPLE_SCOPE],
    ['state', o.state],
    ['nonce', o.nonce],
  ];
  return endpoints.authorize + '?' + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** What the code exchange gives: the refresh token to keep (only to revoke it), and whom its id_token names. */
export interface AppleGrant {
  refreshToken: string;
  sub: string;
}

/**
 * The code exchange, which a sign-in needs: the authorization code and the client secret for a
 * refresh token and an id_token (redirect_uri for the web's code only). The id_token comes straight
 * from Apple over TLS for our own request, so only its `sub` is read, for the caller to compare.
 * Any refusal or a missing answer is AppleError `unavailable`; the log gets the status and Apple's
 * error name, never the body.
 */
export async function exchangeAppleCode(env: Env, o: { clientId: string; code: string; redirectUri?: string }): Promise<AppleGrant> {
  const signing = await appleSigning(env);
  if (!signing) throw new AppleError('unavailable', 'not configured');
  const params: Record<string, string> = {
    client_id: o.clientId,
    client_secret: await appleClientSecret(signing, o.clientId),
    code: o.code,
    grant_type: 'authorization_code',
  };
  if (o.redirectUri) params.redirect_uri = o.redirectUri;
  const res = await askApple(endpoints.token, { method: 'POST', headers: FORM, body: new URLSearchParams(params).toString() }, 'token endpoint');
  if (!res.ok) throw new AppleError('unavailable', `token endpoint answered ${res.status} ${await errorName(res)}`);
  let body: { refresh_token?: unknown; id_token?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = {};
  }
  const sub = typeof body.id_token === 'string' ? jwtPart(body.id_token, 1)?.sub : undefined;
  if (typeof body.refresh_token !== 'string' || !body.refresh_token || typeof sub !== 'string') {
    throw new AppleError('unavailable', 'token endpoint answered without a refresh token or an id_token');
  }
  return { refreshToken: body.refresh_token, sub };
}

/**
 * Revoke a grant (the refresh token the exchange gave `clientId`), which ends this app's
 * authorization for the Apple ID: Apple's own list of apps using Sign in with Apple drops it, and
 * the next sign-in is a first one again. AppleError `unavailable` when Apple refuses or does not answer.
 */
export async function revokeAppleToken(env: Env, o: { clientId: string; refreshToken: string }): Promise<void> {
  const signing = await appleSigning(env);
  if (!signing) throw new AppleError('unavailable', 'not configured');
  const body = new URLSearchParams({
    client_id: o.clientId,
    client_secret: await appleClientSecret(signing, o.clientId),
    token: o.refreshToken,
    token_type_hint: 'refresh_token',
  }).toString();
  const res = await askApple(endpoints.revoke, { method: 'POST', headers: FORM, body }, 'revoke endpoint');
  if (!res.ok) throw new AppleError('unavailable', `revoke endpoint answered ${res.status} ${await errorName(res)}`);
  await res.body?.cancel().catch(() => undefined);
}

/**
 * Whether Apple takes this server's client secret for `clientId`, without anyone signing in: a
 * made-up code, exchanged. Apple checks the client first, so `invalid_grant` means the key, its id,
 * the team and the client id all fit and only the code was refused; `invalid_client` means the
 * client secret was. For the owner's check once the key is loaded (POST /api/admin/apple-check).
 */
export async function checkAppleClient(env: Env, clientId: string, redirectUri?: string): Promise<{ clientId: string; status: number; error: string }> {
  const signing = await appleSigning(env);
  if (!signing) return { clientId, status: 0, error: 'not_configured' };
  const params: Record<string, string> = {
    client_id: clientId,
    client_secret: await appleClientSecret(signing, clientId),
    code: 'evenly-check-not-a-code',
    grant_type: 'authorization_code',
  };
  if (redirectUri) params.redirect_uri = redirectUri;
  try {
    const res = await askApple(endpoints.token, { method: 'POST', headers: FORM, body: new URLSearchParams(params).toString() }, 'token endpoint');
    return { clientId, status: res.status, error: res.ok ? '' : await errorName(res) };
  } catch {
    return { clientId, status: 0, error: 'no_answer' };
  }
}

// ---------- Apple's signing keys ----------

interface KeySet {
  keys: Map<string, CryptoKey>;
  /** ms: when they were fetched. */
  at: number;
}

/** In this Worker instance's memory; every instance fetches its own copy. */
let keySet: KeySet | null = null;

async function fetchKeys(now: number): Promise<KeySet> {
  const res = await askApple(endpoints.keys, { headers: { Accept: 'application/json' } }, 'keys');
  if (!res.ok) throw new AppleError('unavailable', `keys answered ${res.status}`);
  let body: { keys?: unknown };
  try {
    body = (await res.json()) as { keys?: unknown };
  } catch {
    throw new AppleError('unavailable', 'keys are not JSON');
  }
  const keys = new Map<string, CryptoKey>();
  for (const k of Array.isArray(body.keys) ? body.keys : []) {
    const j = k as { kty?: unknown; kid?: unknown; n?: unknown; e?: unknown; alg?: unknown; use?: unknown };
    if (j.kty !== 'RSA' || typeof j.kid !== 'string' || typeof j.n !== 'string' || typeof j.e !== 'string') continue;
    if ((j.alg !== undefined && j.alg !== 'RS256') || (j.use !== undefined && j.use !== 'sig')) continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: j.n, e: j.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      keys.set(j.kid, key);
    } catch {
      // A key WebCrypto cannot read: tokens signed with it fail as unknown keys.
    }
  }
  return { keys, at: now };
}

/**
 * The key a token names: from memory for a day, else fetched again; also fetched again for a key
 * id the kept set lacks (Apple rotates its keys), unless the set is under a minute old.
 */
async function keyFor(kid: string, now: number): Promise<CryptoKey | null> {
  const fresh = keySet && now - keySet.at < KEY_TTL_MS && now >= keySet.at ? keySet : null;
  const held = fresh?.keys.get(kid);
  if (held) return held;
  if (fresh && now - fresh.at < REFETCH_GAP_MS) return null;
  keySet = await fetchKeys(now);
  return keySet.keys.get(kid) ?? null;
}

/** Forget the kept keys (tests). */
export function forgetAppleKeys(): void {
  keySet = null;
}

// ---------- the identity token ----------

/** Who Apple says signed in. */
export interface AppleIdentity {
  /** Apple's user id for our team: stable, the same in the app and on the web; the only thing an account is linked by. */
  sub: string;
  /** The email Apple verified, as codeEmail keeps it (a relay address included); null without one. */
  email: string | null;
  /** The email is a Hide My Email address (is_private_email, or the relay domain). */
  relay: boolean;
}

/** Part `i` of a JWT as an object, or null. */
function jwtPart(token: string, i: number): Record<string, unknown> | null {
  const p = token.split('.')[i];
  if (typeof p !== 'string' || !/^[A-Za-z0-9_-]*$/.test(p)) return null;
  try {
    const o = JSON.parse(new TextDecoder().decode(fromB64url(p)));
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Apple writes email_verified and is_private_email as a boolean or as the string "true" or "false". */
function flag(v: unknown): boolean {
  return v === true || v === 'true';
}

const utf8 = new TextEncoder();

/**
 * Check an identity token and say who it names. In order: the shape, RS256 with a key Apple
 * publishes, `iss` Apple, `aud` the client (the app's bundle id, or the web's Services ID), `exp`
 * (and an `iat` not from the future), `nonce` (the iPhone app's: the SHA-256 hex of its raw nonce;
 * the web's: the flow's own), and `sub`. Every failure is AppleError `failed`, except Apple's keys
 * not answering (`unavailable`). An email Apple has not verified (Sign in with Apple at Work &
 * School) counts as none.
 */
export async function verifyAppleToken(token: string, o: { clientId: string; nonce: string; now?: number }): Promise<AppleIdentity> {
  const now = o.now ?? Date.now();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]*$/.test(p))) throw new AppleError('failed', 'identity token is not a JWT');
  const header = jwtPart(token, 0);
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AppleError('failed', 'identity token header');
  const key = await keyFor(header.kid, now);
  if (!key) throw new AppleError('failed', 'identity token key unknown');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), utf8.encode(parts[0] + '.' + parts[1]));
  } catch {
    ok = false;
  }
  if (!ok) throw new AppleError('failed', 'identity token signature');
  const claims = jwtPart(token, 1);
  if (!claims) throw new AppleError('failed', 'identity token claims');
  if (claims.iss !== APPLE_ISSUER) throw new AppleError('failed', 'identity token iss');
  const aud = claims.aud;
  if (aud !== o.clientId && !(Array.isArray(aud) && aud.length === 1 && aud[0] === o.clientId)) throw new AppleError('failed', 'identity token aud');
  const sec = now / 1000;
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SEC <= sec) throw new AppleError('failed', 'identity token expired');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SEC > sec) throw new AppleError('failed', 'identity token iat');
  if (typeof claims.nonce !== 'string' || claims.nonce !== o.nonce) throw new AppleError('failed', 'identity token nonce');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new AppleError('failed', 'identity token sub');
  const email = typeof claims.email === 'string' && flag(claims.email_verified) ? codeEmail(claims.email) : null;
  return { sub: claims.sub, email, relay: flag(claims.is_private_email) || !!email?.endsWith('@' + RELAY_DOMAIN) };
}

/**
 * The iPhone app's credential, checked: the identity token for the app's bundle id with the SHA-256
 * (lowercase hex) of the raw nonce the app sent, then the authorization code exchanged, which a
 * sign-in needs, its id_token naming the same Apple ID. `unavailable` when Apple is not set up here.
 */
export async function checkAppCredential(
  c: Ctx,
  body: { identityToken: string; authorizationCode: string; nonce: string },
): Promise<{ who: AppleIdentity; grant: AppleGrant; clientId: string }> {
  const env = c.env;
  const clientId = appleAppId(env);
  if (!clientId || !(await appleSigning(env))) throw new AppleError('unavailable', 'not configured');
  const who = await verifyAppleToken(body.identityToken.trim(), { clientId, nonce: await sha256Hex(body.nonce) });
  const grant = await exchangeAppleCode(env, { clientId, code: body.authorizationCode.trim() });
  if (grant.sub !== who.sub) {
    await settleRefusedGrant(c, grant, clientId);
    throw new AppleError('failed', 'the exchanged id_token names another Apple ID');
  }
  return { who, grant, clientId };
}

/**
 * A sign-in or link refused after the code exchange (no_email, linked_other, apple_taken,
 * already_linked, a session that ended, a failed write): the grant Apple just made is kept for the
 * account that has that Apple ID, if one does (as its newest), else revoked, so no grant is left
 * that nothing could revoke later. After the answer where the runtime allows; a failure is logged
 * (the client and why, never the token) and changes nothing else.
 */
export async function settleRefusedGrant(c: Ctx, grant: AppleGrant, clientId: string): Promise<void> {
  await afterAnswer(c, settleGrant(c.env, { sub: grant.sub, clientId, refreshToken: grant.refreshToken }));
}

/**
 * A grant no account was given (a refused sign-in or link, a pending link dropped or expired):
 * kept for the account that has that Apple ID, if one does, else revoked. Never throws; a failure
 * is logged by the client and why, never the token.
 */
export async function settleGrant(env: Env, g: { sub: string; clientId: string; refreshToken: string }): Promise<void> {
  try {
    const holder = await getUserByAppleSub(env.DB, g.sub);
    if (holder) await keepAppleGrant(env.DB, holder.id, g.clientId, g.refreshToken);
    else await revokeAppleToken(env, { clientId: g.clientId, refreshToken: g.refreshToken });
  } catch (err) {
    console.error(`apple refused grant for ${g.clientId}: ${err instanceof AppleError ? err.detail : err instanceof Error ? err.name : 'error'}`);
  }
}

/** Run `work` after the answer where the runtime allows it (waitUntil), else wait for it (unit tests). */
export async function afterAnswer(c: Ctx, work: Promise<unknown>): Promise<void> {
  let ctx: { waitUntil(p: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = null; // no ExecutionContext (unit tests)
  }
  if (ctx) ctx.waitUntil(work);
  else await work;
}

/** How the JSON routes (the iPhone app's) answer each AppleError; `failed` is apple_invalid at the route's own status. */
const API_ERRORS: Partial<Record<AppleErrorCode, [number, ApiErrorCode, string]>> = {
  unavailable: [503, 'apple_unavailable', 'Sign in with Apple is not available right now'],
  no_email: [409, 'no_email', 'Apple gave no email for this Apple ID'],
  linked_other: [409, 'linked_other', 'The account with this email is linked to another Apple ID'],
  apple_taken: [409, 'apple_taken', 'This Apple ID is linked to another account'],
  already_linked: [409, 'already_linked', 'This account is linked to another Apple ID'],
  state: [401, 'unauthorized', 'Sign in first'],
};

/**
 * Throw an AppleError as the JSON routes answer it (logged by name, as the page routes do), and
 * anything else as it is. `invalidStatus`: 401 for a sign-in, 400 for a link from 我的, where a
 * 401 would sign the app out.
 */
export function appleApiError(err: unknown, route: string, invalidStatus: 400 | 401): never {
  if (!(err instanceof AppleError)) throw err;
  console.warn(`apple ${route}: ${err.detail}`);
  if (err.code === 'failed') fail(invalidStatus, 'apple_invalid', 'Apple could not confirm this sign-in');
  const answer = API_ERRORS[err.code];
  if (answer) fail(answer[0], answer[1], answer[2]);
  fail(500, 'server_error', 'Something went wrong on our side. Try again in a moment.');
}

// ---------- the new account's name ----------

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * A given and a family name as PersonNameComponentsFormatter writes them: family first with no
 * space in Chinese, Japanese and Korean script (張俊儒), else given first (Gino Chang).
 */
export function formatPersonName(given: string, family: string): string {
  const g = given.trim();
  const f = family.trim();
  if (!g || !f) return g || f;
  return CJK.test(g) || CJK.test(f) ? f + g : g + ' ' + f;
}

/**
 * The name in the web's form post `user` field (JSON, the first authorization only:
 * {"name": {"firstName", "lastName"}, "email"}), or '' when there is none or it is not that.
 */
export function nameFromAppleUser(raw: string | null | undefined): string {
  if (!raw || raw.length > 4000) return '';
  try {
    const name = (JSON.parse(raw) as { name?: { firstName?: unknown; lastName?: unknown } } | null)?.name;
    if (!name || typeof name !== 'object') return '';
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    return formatPersonName(s(name.firstName), s(name.lastName));
  } catch {
    return '';
  }
}

/**
 * A new account's name: the one the client passed from Apple (Apple gives it only once), by
 * signup's rule; else the part before the @ of a real address; else, for a relay address (whose
 * letters are no name), 「Apple 使用者」 / "Apple user" by the language. The person renames it on 我的.
 */
export function appleName(o: { name: string | null | undefined; email: string; relay: boolean; locale: Locale }): string {
  return fitName(o.name ?? '') || (o.relay ? '' : fitName(o.email.split('@')[0])) || (o.locale === 'en' ? 'Apple user' : 'Apple 使用者');
}

// ---------- the web's flow cookie ----------

/** What a started web sign-in keeps in its cookie until Apple posts the answer back. */
export interface AppleFlow {
  /** Sent to Apple and back (with flowState's mark for a link): the callback's `state` must be this one. */
  state: string;
  /**
   * Never sent to Apple: what the flow's binding on the server is found by (sign_in_flows, by its
   * SHA-256), so a leaked authorize URL, which carries the state and the nonce, names no binding.
   * Null in a cookie from before it (such a flow has no binding).
   */
  secret: string | null;
  /** For a new account (the start's ?currency=, else the language's). */
  currency: string | null;
  /** Apple puts it in the identity token as it is. */
  nonce: string;
  /** safeReturn's path. */
  returnTo: string;
  /** For a new account (the start's ?locale=, else Accept-Language). */
  locale: Locale;
  /**
   * A link from 我的. The account and session it is for, and for a sign-in the session it replaces
   * (Apple's cross-site POST carries no SameSite=Lax cookie), are kept on the server (sign_in_flows):
   * the cookie holds only random values and this flag.
   */
  link: boolean;
}

export function encodeAppleFlow(f: AppleFlow): string {
  const o: Record<string, unknown> = { s: f.state, n: f.nonce, r: f.returnTo, l: f.locale };
  if (f.secret) o.x = f.secret;
  if (f.currency) o.cu = f.currency;
  if (f.link) o.k = 1;
  return b64url(utf8.encode(JSON.stringify(o)));
}

/** The cookie's flow, or null when it is missing or not one encodeAppleFlow made. */
export function decodeAppleFlow(raw: string | undefined): AppleFlow | null {
  const o = cookieJson(raw);
  if (!o) return null;
  const { s, n, r, l, x, cu } = o;
  if (typeof s !== 'string' || typeof n !== 'string' || !RANDOM_RE.test(s) || !RANDOM_RE.test(n)) return null;
  return {
    state: s,
    secret: typeof x === 'string' && RANDOM_RE.test(x) ? x : null,
    nonce: n,
    returnTo: safeReturn(r),
    locale: l === 'en' ? 'en' : 'zh-TW',
    currency: typeof cu === 'string' && /^[A-Z]{3}$/.test(cu) ? cu : null,
    link: o.k === 1,
  };
}

// ---------- accounts ----------

/** Keep the refresh token of a sign-in or a link (one row per account and client, the newest). */
export async function keepAppleGrant(db: D1Database, userId: string, clientId: string, refreshToken: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO apple_grants (user_id, client_id, refresh_token, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, client_id) DO UPDATE SET refresh_token = excluded.refresh_token, created_at = excluded.created_at`,
    )
    .bind(userId, clientId, refreshToken, nowISO())
    .run();
}

/**
 * The grants an account's deletion took (DELETE ... RETURNING inside its batch, so a grant stored
 * a moment before is among them and one stored after cannot exist): each revoked with the client
 * it was issued to, all at once. A failure is logged (the client and why, never the token) and
 * nothing retries it. Returns how many Apple took.
 */
export async function revokeAppleGrants(env: Env, grants: { client_id: string; refresh_token: string }[]): Promise<number> {
  const done = await Promise.all(
    grants.map(g =>
      revokeAppleToken(env, { clientId: g.client_id, refreshToken: g.refresh_token }).then(
        () => true,
        err => {
          console.error(`apple revoke for ${g.client_id}: ${err instanceof AppleError ? err.detail : err instanceof Error ? err.name : 'error'}`);
          return false;
        },
      ),
    ),
  );
  return done.filter(Boolean).length;
}
