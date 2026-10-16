// Thin fetch wrapper for the Worker API.

import type { ApiErrorBody } from '../../shared/types';
import { API_BASE } from '../config';

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

let token: string | null = (() => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();

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

export function setToken(t: string | null): void {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode): keep it in memory */
  }
}

/** Called when the server says the token is no longer valid. Set by the store. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export interface ApiOptions {
  /** Send If-None-Match; a 304 resolves to `undefined`. */
  etag?: string;
  signal?: AbortSignal;
  /** Do not attach the bearer token. */
  anonymous?: boolean;
  timeoutMs?: number;
}

export interface ApiResult<T> {
  data: T | undefined;
  etag: string | null;
  status: number;
}

/** Full-detail request (status, ETag). Most callers want `api()` below. */
export async function apiRaw<T>(method: string, path: string, body?: unknown, opts: ApiOptions = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token && !opts.anonymous) headers['Authorization'] = 'Bearer ' + token;
  if (opts.etag) headers['If-None-Match'] = opts.etag;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });

  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
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
    if (res.status === 401 && token && !opts.anonymous) onUnauthorized?.();
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
