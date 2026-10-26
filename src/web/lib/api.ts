// Thin fetch wrapper for the Worker API, and how requests are signed in (config.ts AUTH_MODE):
// - cookie (the app and the API share an origin): the Worker keeps the session in an HttpOnly
//   cookie and sets a readable marker cookie naming the account (__Host-evenly_user). Requests
//   say which account this tab expects (X-Evenly-User), so a tab that another tab signed into a
//   different account gets 401 `session_changed` and reloads instead of acting as the wrong person.
//   A token is sent as Bearer only while it is not yet backed by a cookie: one an older build left
//   in localStorage (until it is moved into the cookie), or a new sign-in's until the cookie is
//   confirmed. A device whose browser keeps no cookies falls back to bearer for good.
// - bearer (the API is on another origin: vite dev, tests): the token in localStorage['evenly.token'].

import type { ApiErrorBody } from '../../shared/types';
import { API_BASE, AUTH_MODE } from '../config';

/** Server codes, plus the client's own: offline (no answer), unsynced (changes still queued here), unknown. */
export type ClientErrorCode = ApiErrorBody['error']['code'] | 'offline' | 'unsynced' | 'unknown';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ClientErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  /** True for problems worth retrying later (no connection, server trouble, rate limit). */
  get retryable(): boolean {
    return this.code === 'offline' || this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

const TOKEN_KEY = 'evenly.token';
/** Cookie mode: the account the token copy in TOKEN_KEY belongs to (see keepTokenCopy). */
const TOKEN_USER_KEY = 'evenly.tokenUser';
/** localStorage: 'bearer' once this browser turned out to keep no cookies for the site. */
const AUTH_KEY = 'evenly.auth';
const MARKER_COOKIE = '__Host-evenly_user';

function readStored(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** A cookie's name or value without the spaces and tabs around it (only those, as browsers and Hono trim). */
function trimCookiePart(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

/**
 * The account the browser's session cookie belongs to (the readable marker cookie), or null.
 * The name must be exactly __Host-evenly_user. String.prototype.trim() would also strip Unicode
 * spaces (U+00A0, U+3000, U+FEFF), and a cookie named with one of those in front is no __Host-
 * cookie: any *.ginochang.com site can set it for the whole domain. A real __Host- cookie is the
 * only one of its name on this host, so two pairs with that name mean one was planted (WebKit
 * keeps a nameless cookie whose value starts with "__Host-evenly_user=", which reads the same):
 * then there is no marker. Such a cookie can still be the only pair, so the store deletes or
 * files away nothing because of the marker until a server answer names the account.
 */
export function markerUser(): string | null {
  let all = '';
  try {
    all = typeof document === 'undefined' ? '' : document.cookie;
  } catch {
    return null;
  }
  let raw: string | null = null;
  for (const part of all.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || trimCookiePart(part.slice(0, eq)) !== MARKER_COOKIE) continue;
    if (raw !== null) return null;
    raw = trimCookiePart(part.slice(eq + 1));
  }
  if (raw === null) return null;
  let v: string;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null;
}

let mode: 'cookie' | 'bearer' = (() => {
  if (AUTH_MODE !== 'cookie') return 'bearer';
  try {
    return localStorage.getItem(AUTH_KEY) === 'bearer' ? 'bearer' : 'cookie';
  } catch {
    return 'cookie';
  }
})();

/** cookie or bearer for this tab right now (cookie falls back to bearer where cookies are blocked). */
export function authMode(): 'cookie' | 'bearer' {
  return mode;
}

/** This browser keeps no cookies for the site: sign in with the token from now on, also on later starts. */
export function fallBackToBearer(): void {
  mode = 'bearer';
  cookieUser = null;
  epoch++;
  try {
    localStorage.setItem(AUTH_KEY, 'bearer');
  } catch {
    /* this tab still uses bearer */
  }
}

// A token copy saved for another account than the marker's (two accounts on one device) would sign
// in the wrong person if the cookie lapsed, but the marker alone does not drop it: the store does
// once GET /api/me with the cookie names the account (store.ts settleMarkerStart).
const markerAtStart = mode === 'cookie' ? markerUser() : null;

/**
 * The Bearer token this tab sends. Bearer mode: the saved token, as always. Cookie mode: none
 * when the marker says the browser is signed in (a token left in storage then is ignored), else
 * the saved one an older build left, until it is moved into the cookie.
 */
let token: string | null = markerAtStart ? null : readStored();
/** Cookie mode: the account this tab is signed in as through the cookie (sent as X-Evenly-User). */
let cookieUser: string | null = markerAtStart;
/** Bumped whenever the credential changes, so a 401 for a request sent before does not end the new session. */
let epoch = 0;

export function getToken(): string | null {
  return token;
}

/** The token as saved for every tab right now (another tab may have signed in or out since this one loaded). */
export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return token;
  }
}

/** The localStorage key of the token (a `storage` event on it means another tab changed the sign-in). */
export const TOKEN_STORAGE_KEY = TOKEN_KEY;

/**
 * Sign requests with `t` as a Bearer token. `save` (the default) also writes it to localStorage
 * for the other tabs and the next start, or removes it there when `t` is null.
 */
export function setToken(t: string | null, save = true): void {
  token = t;
  epoch++;
  if (!save) return;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_USER_KEY);
    }
  } catch {
    /* storage unavailable (private mode): keep it in memory */
  }
}

/**
 * Cookie mode: keep a copy of the session's token in localStorage (or drop it with null), without
 * signing requests with it. Requests use the cookie; the copy only matters if the cookie is gone
 * while localStorage is not, which is what a Home Screen app looks like when WebKit capped the
 * cookie (its third-party IP defense) and the app then sat unused for a week: the app then
 * starts on the token and puts it back into the cookie. Safari's 7-day cleanup of a site's
 * storage is the opposite case, where the cookie carries on.
 */
export function keepTokenCopy(t: string | null, userId: string | null): void {
  try {
    if (t && userId) {
      localStorage.setItem(TOKEN_KEY, t);
      localStorage.setItem(TOKEN_USER_KEY, userId);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_USER_KEY);
    }
  } catch {
    /* storage unavailable: the cookie alone carries the session */
  }
}

/** Cookie mode: the account the token copy in localStorage is recorded for (null: none, or not recorded). */
export function tokenCopyUser(): string | null {
  try {
    return localStorage.getItem(TOKEN_USER_KEY);
  } catch {
    return null;
  }
}

/** Cookie mode: the account this tab is signed in as through the session cookie (null: none). */
export function getCookieUser(): string | null {
  return cookieUser;
}

export function setCookieUser(userId: string | null): void {
  cookieUser = userId;
  epoch++;
}

/** Called when the server says the session is no longer valid. Set by the store. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** Called when the session cookie now belongs to another account than this tab's. Set by the store. */
let onSessionChanged: (() => void) | null = null;
export function setSessionChangedHandler(fn: () => void): void {
  onSessionChanged = fn;
}

export interface ApiOptions {
  /** Send If-None-Match; a 304 resolves to `undefined`. */
  etag?: string;
  signal?: AbortSignal;
  /**
   * Not on behalf of this tab's account: no Bearer token and no X-Evenly-User, and a 401 does not
   * sign the device out. (Same-origin calls still carry the browser's cookies.)
   */
  anonymous?: boolean;
  /**
   * A 401 is for the caller to handle; it does not sign the device out (logout). A 401
   * `session_changed` still reloads the tab: the cookie is another sign-in's now.
   */
  ignore401?: boolean;
  timeoutMs?: number;
  /**
   * Send `body` as it is (bytes or a Blob) with this Content-Type instead of as JSON: a receipt
   * photo goes up as the image itself, with no base64 for the Worker to decode.
   */
  contentType?: string;
}

export interface ApiResult<T> {
  data: T | undefined;
  etag: string | null;
  status: number;
}

/**
 * The newer parts of the API this app understands, sent on every request (X-Evenly-Features,
 * src/worker/compat.ts): with `refunds` the Worker sends refunds as such; a client without it sees
 * each refund as the expense with the same effect.
 */
export const CLIENT_FEATURES = 'refunds';

/** Full-detail request (status, ETag). Most callers want `api()` below. */
export async function apiRaw<T>(method: string, path: string, body?: unknown, opts: ApiOptions = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'X-Evenly-Features': CLIENT_FEATURES };
  if (body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/json';
  const sentAt = epoch;
  if (!opts.anonymous) {
    if (token) headers['Authorization'] = 'Bearer ' + token;
    else if (mode === 'cookie' && cookieUser) {
      // Another tab signed out or into another account: the cookie this request would carry is
      // no longer this tab's. Do not send it; the store reloads into the browser's sign-in.
      if (markerUser() !== cookieUser) {
        onSessionChanged?.();
        throw new ApiError(401, 'session_changed', 'Signed in to another account in another tab');
      }
      headers['X-Evenly-User'] = cookieUser;
    }
  }
  if (opts.etag) headers['If-None-Match'] = opts.etag;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });

  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : opts.contentType ? (body as BodyInit) : JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
      ...(mode === 'cookie' ? { credentials: 'same-origin' as const } : {}),
    });
  } catch (e) {
    throw new ApiError(0, 'offline', 'No connection');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) return { data: undefined, etag: opts.etag ?? null, status: 304 };

  let parsed: unknown = undefined;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (!res.ok) {
    const err = (parsed as ApiErrorBody | undefined)?.error;
    // Only about the session this request was sent with (not one signed in since).
    if (res.status === 401 && !opts.anonymous && sentAt === epoch) {
      if (err?.code === 'session_changed') onSessionChanged?.();
      else if (!opts.ignore401 && (token || cookieUser)) onUnauthorized?.();
    }
    throw new ApiError(res.status, err?.code ?? (res.status >= 500 ? 'server_error' : 'unknown'), err?.message ?? res.statusText, err?.details);
  }
  return { data: parsed as T, etag: res.headers.get('ETag'), status: res.status };
}

/** JSON request; throws ApiError on failure. */
export async function api<T>(method: string, path: string, body?: unknown, opts: ApiOptions = {}): Promise<T> {
  const r = await apiRaw<T>(method, path, body, opts);
  return r.data as T;
}

/** True when the browser reports a connection (navigator.onLine can be wrong, so failures still count). */
export function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}
