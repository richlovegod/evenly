// Sign in with Google (docs/SPEC.md section 3, Google): OAuth 2.0's authorization code flow with
// PKCE, run by the Worker alone, so no Google script ever loads on our pages. GET
// /api/auth/google/start (routes/auth.ts) keeps a state, a nonce and a PKCE verifier in a
// 10-minute HttpOnly cookie and sends the browser to Google; Google sends it back to
// /api/auth/google/callback with a code, which this module exchanges, with the client secret and
// the verifier, for an id_token, and checks: RS256 against Google's published keys (kept in
// memory as long as Google's Cache-Control says), the issuer, the audience (our client id), the
// expiry, the nonce and a verified email. The same flow serves the iPhone app (its start names
// `client=ios` and the challenge of a verifier only the app holds, and the callback hands the app a
// one-time code instead of cookies) and linking from 我的 (the account and the session that started
// it are kept on the server, in sign_in_flows, never in the cookie). Nothing here logs the code, a
// token or an address: only what failed, by name, and the status Google answered.

import type { GoogleErrorCode, Locale } from '../../shared/types';
import type { Ctx, Env } from '../env';
import { b64url, fromB64url, onAppSite } from '../http';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** Both forms Google writes in `iss`. */
export const GOOGLE_ISSUERS: readonly string[] = ['accounts.google.com', 'https://accounts.google.com'];
/** The name, the email and the account id: nothing else (no contacts, no Drive). */
export const GOOGLE_SCOPE = 'openid email profile';
/** Where Google sends people back, on the site's own origin (registered in the Google Cloud console). */
export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';
/** Each request to Google gives up after this long. */
export const GOOGLE_TIMEOUT_MS = 10_000;
/** How long a started sign-in may take (the flow cookie's Max-Age). */
export const FLOW_TTL_SEC = 600;
/** The flow cookie, without the __Host- prefix (hono/cookie adds it with prefix: 'host'). */
export const FLOW_COOKIE = 'evenly_google';
/** Default of GOOGLE_IP_PER_15M: starts, and callbacks, per IP in 15 minutes. */
export const GOOGLE_IP_PER_15M = 20;
/** The start the web's button and the iPhone app open (GET /api/auth/providers?client=ios gives it in full). */
export const GOOGLE_START_PATH = '/api/auth/google/start';
/**
 * Where the iPhone app's flows end, on the start's own origin (APP_URL's): an https address of an
 * associated domain (GET /.well-known/apple-app-site-association names the app), which iOS hands
 * only to the app's own ASWebAuthenticationSession (Callback.https). A plain browser that ends
 * there gets a page saying to go back to the app (index.ts).
 */
export const IOS_CALLBACK_PATH = '/app/auth/google';
/** The iPhone app's one-time codes and link tickets work this long (google_app_codes). */
export const APP_CODE_TTL_SEC = 300;
/** wrangler.toml's placeholder until the Google Cloud console has made the client. */
const PLACEHOLDER = 'SET_ME';
/** Seconds the id_token's exp and iat may be off from our clock. */
const CLOCK_SKEW_SEC = 60;
/** Google's keys are kept at most a day, whatever Cache-Control says. */
const MAX_KEY_AGE_SEC = 86_400;

/** A sign-in that cannot go on: `code` is what 登入 shows, `detail` what the log says (never a value). */
export class GoogleError extends Error {
  constructor(
    public code: GoogleErrorCode,
    public detail: string,
  ) {
    super(detail);
  }
}

// ---------- configuration ----------

/** The OAuth client id, or null while it is missing or still wrangler.toml's "SET_ME". */
export function googleClientId(env: Env): string | null {
  const id = env.GOOGLE_CLIENT_ID?.trim();
  return id && id !== PLACEHOLDER ? id : null;
}

/** Both halves of the client are set. */
export function googleConfigured(env: Env): boolean {
  return !!googleClientId(env) && !!env.GOOGLE_CLIENT_SECRET?.trim();
}

/**
 * The app on this request's site may offer Google: it is set up, and the request came to APP_URL's
 * origin, the one whose callback is registered at Google (production also answers on workers.dev,
 * where Google would refuse the redirect). Local wrangler dev on 127.0.0.1 or localhost counts too.
 */
export function googleAvailable(c: Ctx): boolean {
  return googleConfigured(c.env) && onAppSite(c);
}

/** The callback on this request's origin: the redirect_uri of both the start and the code exchange. */
export function callbackUrl(c: Ctx): string {
  return new URL(c.req.url).origin + GOOGLE_CALLBACK_PATH;
}

// ---------- the page to come back to ----------

/** A hash route of the app ("/join/abc", "/g/x/settle?from=a"): path and query characters only. */
const RETURN_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;
/** Pages that make no sense once signed in (App.tsx GUEST_ONLY): Home instead. */
const GUEST_ONLY = /^\/(?:welcome|login)(?:[/?]|$)/;

/**
 * Where the app opens after the sign-in: a hash route of this app, at most 300 characters, else
 * "/" (Home). Never a URL of its own: the callback puts it after "/#", on this origin.
 */
export function safeReturn(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  if (raw.length > 300 || !RETURN_RE.test(raw) || raw.startsWith('//') || GUEST_ONLY.test(raw)) return '/';
  return raw;
}

// ---------- the flow cookie ----------

/** An account and the session it was signed in with: who a link from 我的 is for (sign_in_flows). */
export interface LinkTarget {
  userId: string;
  /** sessions.id (SHA-256 of the token): the link goes through only while this session lives. */
  sessionId: string;
}

/** What a started sign-in keeps in its cookie until Google sends the browser back. */
export interface GoogleFlow {
  /** Sent to Google and back (with flowState's mark): the callback's `state` must be this one. */
  state: string;
  /** Google puts it in the id_token: proves the token was made for this sign-in. */
  nonce: string;
  /** PKCE: Google got only its SHA-256 (code_challenge), the code exchange sends it. */
  verifier: string;
  /** safeReturn's path. */
  returnTo: string;
  /** For a new account (the start's ?locale=, else Accept-Language). */
  locale: Locale;
  /** 'ios': the iPhone app's (the answer goes to IOS_CALLBACK_PATH, never into cookies). */
  client: 'web' | 'ios';
  /**
   * Never sent to Google: what the flow's binding on the server is found by (sign_in_flows, by its
   * SHA-256), so a leaked consent URL, which carries the state and the nonce, names no binding.
   * Null in a cookie from before it (such a flow has no binding).
   */
  secret: string | null;
  /** For a new account (the start's ?currency=, else the language's). */
  currency: string | null;
  /** The iPhone app's sign-in: base64url SHA-256 of the verifier the app keeps, for the exchange. */
  challenge: string | null;
  /**
   * A link from 我的 (the web's ?link=1, or the iPhone app's ticket). Which account and session it
   * is for is kept on the server (sign_in_flows, by the secret's hash): anyone can write their own
   * browser's cookie, so the cookie only says that it is a link.
   */
  link: boolean;
}

/** randomToken(32): 43 base64url characters (also a valid PKCE verifier, 43 to 128 of them). */
export const RANDOM_RE = /^[A-Za-z0-9_-]{43}$/;
const utf8 = new TextEncoder();

export function encodeFlow(f: GoogleFlow): string {
  const o: Record<string, unknown> = { s: f.state, n: f.nonce, v: f.verifier, r: f.returnTo, l: f.locale };
  if (f.client === 'ios') o.c = 'ios';
  if (f.challenge) o.ch = f.challenge;
  if (f.secret) o.x = f.secret;
  if (f.currency) o.cu = f.currency;
  if (f.link) o.k = 1;
  return b64url(utf8.encode(JSON.stringify(o)));
}

/** A flow cookie's object (base64url JSON), or null. */
export function cookieJson(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || raw.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const o = JSON.parse(new TextDecoder().decode(fromB64url(raw)));
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The cookie's flow, or null when it is missing or not one encodeFlow made. */
export function decodeFlow(raw: string | undefined): GoogleFlow | null {
  const o = cookieJson(raw);
  if (!o) return null;
  const { s, n, v, r, l, c, ch, x, cu } = o;
  if (typeof s !== 'string' || typeof n !== 'string' || typeof v !== 'string') return null;
  if (!RANDOM_RE.test(s) || !RANDOM_RE.test(n) || !RANDOM_RE.test(v)) return null;
  const client = c === 'ios' ? 'ios' : 'web';
  const challenge = typeof ch === 'string' && RANDOM_RE.test(ch) ? ch : null;
  const link = o.k === 1;
  // The iPhone app's sign-in is no use without its challenge.
  if (client === 'ios' && !challenge && !link) return null;
  return {
    state: s, nonce: n, verifier: v, returnTo: safeReturn(r), locale: l === 'en' ? 'en' : 'zh-TW', client, challenge, link,
    secret: typeof x === 'string' && RANDOM_RE.test(x) ? x : null,
    currency: typeof cu === 'string' && /^[A-Z]{3}$/.test(cu) ? cu : null,
  };
}

/** Where a flow's answer goes: 'ios' to the iPhone app (IOS_CALLBACK_PATH), 'link' to 我的, 'web' into the app (errors to 登入). */
export type FlowTarget = 'web' | 'link' | 'ios';

export function flowTarget(f: { client?: 'web' | 'ios'; link: boolean }): FlowTarget {
  return f.client === 'ios' ? 'ios' : f.link ? 'link' : 'web';
}

/**
 * The state as sent out: the flow's random state, marked "i." for the iPhone app and "l." for a
 * link from 我的 ("." is not base64url), so a callback whose cookie is gone still sends its error
 * to the right place (stateTarget). The mark is part of what the callback compares.
 */
export function flowState(f: { state: string; client?: 'web' | 'ios'; link: boolean }): string {
  const t = flowTarget(f);
  return (t === 'ios' ? 'i.' : t === 'link' ? 'l.' : '') + f.state;
}

/** The target a callback's `state` names by its mark (for an error when no flow cookie came back). */
export function stateTarget(state: string | null | undefined): FlowTarget {
  return state?.startsWith('i.') ? 'ios' : state?.startsWith('l.') ? 'link' : 'web';
}

// ---------- to Google and back ----------

/** PKCE S256: base64url of SHA-256 of the verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(verifier))));
}

/** Google's consent page for this flow. prompt=select_account: people with several Google accounts pick one. */
export async function authUrl(o: { clientId: string; redirectUri: string; flow: GoogleFlow }): Promise<string> {
  const u = new URL(GOOGLE_AUTH_URL);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: GOOGLE_SCOPE,
    state: flowState(o.flow),
    nonce: o.flow.nonce,
    code_challenge: await pkceChallenge(o.flow.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return u.toString();
}

/** A request to Google within GOOGLE_TIMEOUT_MS, never following a redirect; GoogleError `failed` without an answer. */
async function askGoogle(url: string, init: RequestInit, what: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GOOGLE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'manual' });
  } catch (err) {
    const why = ctrl.signal.aborted ? 'timeout' : err instanceof Error ? err.name : 'error';
    throw new GoogleError('failed', `no answer from Google's ${what} (${why})`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The code exchange: the code, the PKCE verifier and the client secret for the id_token. Google's
 * refusal (an `invalid_grant` for a code used twice or too old) is GoogleError `failed`; the log
 * gets the status and Google's error name, never the body.
 */
export async function exchangeCode(env: Env, o: { code: string; redirectUri: string; verifier: string }): Promise<string> {
  const clientId = googleClientId(env);
  const secret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !secret) throw new GoogleError('unavailable', 'not configured');
  const res = await askGoogle(
    GOOGLE_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: o.code,
        client_id: clientId,
        client_secret: secret,
        redirect_uri: o.redirectUri,
        code_verifier: o.verifier,
      }).toString(),
    },
    'token endpoint',
  );
  let body: { id_token?: unknown; error?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!res.ok || typeof body.id_token !== 'string') {
    const name = typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? body.error : 'unknown';
    throw new GoogleError('failed', `token endpoint answered ${res.status} ${name}`);
  }
  return body.id_token;
}

// ---------- Google's signing keys ----------

interface KeySet {
  keys: Map<string, CryptoKey>;
  /** ms: kept until then (Cache-Control max-age, less Age). */
  until: number;
}

/** In this Worker instance's memory; every instance fetches its own copy. */
let keySet: KeySet | null = null;

/** Seconds Cache-Control allows keeping an answer (0 for no-store, no-cache or none given), at most a day. */
export function keepFor(cacheControl: string | null, age: string | null): number {
  const cc = (cacheControl || '').toLowerCase();
  if (/\b(?:no-store|no-cache)\b/.test(cc)) return 0;
  const m = /\bmax-age=(\d+)/.exec(cc);
  if (!m) return 0;
  const left = Number(m[1]) - (Number(age) > 0 ? Number(age) : 0);
  return Math.max(0, Math.min(MAX_KEY_AGE_SEC, left));
}

async function fetchKeys(now: number): Promise<KeySet> {
  const res = await askGoogle(GOOGLE_JWKS_URL, { headers: { Accept: 'application/json' } }, 'keys');
  if (!res.ok) throw new GoogleError('failed', `keys answered ${res.status}`);
  let body: { keys?: unknown };
  try {
    body = (await res.json()) as { keys?: unknown };
  } catch {
    throw new GoogleError('failed', 'keys are not JSON');
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
  return { keys, until: now + keepFor(res.headers.get('Cache-Control'), res.headers.get('Age')) * 1000 };
}

/**
 * The key a token names: from memory while Google's Cache-Control allows, else fetched again,
 * also once for a key id the kept set does not have (Google rotates its keys).
 */
async function keyFor(kid: string, now: number): Promise<CryptoKey | null> {
  const held = keySet && keySet.until > now ? keySet.keys.get(kid) : undefined;
  if (held) return held;
  keySet = await fetchKeys(now);
  return keySet.keys.get(kid) ?? null;
}

/** Forget the kept keys (tests). */
export function forgetGoogleKeys(): void {
  keySet = null;
}

// ---------- the id_token ----------

/** Who Google says signed in. */
export interface GoogleIdentity {
  /** Google's account id: stable, never reused; the only thing an account is linked by. */
  sub: string;
  /**
   * The email Google has verified, or '' when it has not (or sent none): the account linked to
   * `sub` signs in either way, and only finding or making one by email needs it. As codeEmail
   * would keep it is the caller's job.
   */
  email: string;
  givenName: string;
  name: string;
}

function part(s: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(fromB64url(s)));
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Check an id_token from the code exchange and say who it names. In order: the shape, RS256 with
 * a key Google publishes, `iss`, `aud` (our client id; an array must hold it and `azp` must be
 * it), `exp` (and an `iat` not from the future), `nonce` and `sub`. Every failure is GoogleError
 * `failed`. An email Google has not verified comes back as '' (routes/auth.ts googleAccount says
 * `unverified` only where an account would be found or made by it).
 */
export async function verifyIdToken(token: string, o: { clientId: string; nonce: string; now?: number }): Promise<GoogleIdentity> {
  const now = o.now ?? Date.now();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]*$/.test(p))) throw new GoogleError('failed', 'id_token is not a JWT');
  const header = part(parts[0]);
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') throw new GoogleError('failed', 'id_token header');
  const key = await keyFor(header.kid, now);
  if (!key) throw new GoogleError('failed', 'id_token key unknown');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), utf8.encode(parts[0] + '.' + parts[1]));
  } catch {
    ok = false;
  }
  if (!ok) throw new GoogleError('failed', 'id_token signature');
  const claims = part(parts[1]);
  if (!claims) throw new GoogleError('failed', 'id_token claims');
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) throw new GoogleError('failed', 'id_token iss');
  const aud = claims.aud;
  const audOk = aud === o.clientId || (Array.isArray(aud) && aud.includes(o.clientId) && claims.azp === o.clientId);
  if (!audOk) throw new GoogleError('failed', 'id_token aud');
  const sec = now / 1000;
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SEC <= sec) throw new GoogleError('failed', 'id_token expired');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SEC > sec) throw new GoogleError('failed', 'id_token iat');
  if (typeof claims.nonce !== 'string' || claims.nonce !== o.nonce) throw new GoogleError('failed', 'id_token nonce');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new GoogleError('failed', 'id_token sub');
  // Google sends a boolean; very old tokens said "true".
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  return {
    sub: claims.sub,
    email: verified && typeof claims.email === 'string' ? claims.email : '',
    givenName: typeof claims.given_name === 'string' ? claims.given_name : '',
    name: typeof claims.name === 'string' ? claims.name : '',
  };
}

/** The most UTF-16 units a name may have (signup's zod rule: 1 to 60 after trimming). */
const NAME_MAX = 60;

/** `s` trimmed, cut to NAME_MAX UTF-16 units without splitting a character, trimmed again. */
export function fitName(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC').trim()) {
    if (out.length + ch.length > NAME_MAX) break;
    out += ch;
  }
  return out.trim();
}

/**
 * A new account's name from Google: the given name, else the full name, by signup's rule; with
 * neither, the email's part before the @ (the person renames it on 我的).
 */
export function googleName(id: Pick<GoogleIdentity, 'givenName' | 'name' | 'email'>): string {
  return fitName(id.givenName) || fitName(id.name) || fitName(id.email.split('@')[0]) || 'Google';
}
