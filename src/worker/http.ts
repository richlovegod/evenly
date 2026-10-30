// HTTP helpers shared by every route module.

import type { ZodType, ZodTypeDef } from 'zod';
import type { ApiErrorCode } from '../shared/types';
import type { Ctx } from './env';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Throw an API error; the global handler turns it into `{error: {code, message, details}}`. */
export function fail(status: number, code: ApiErrorCode, message: string, details?: unknown): never {
  throw new ApiError(status, code, message, details);
}

export const notFound = (what = 'Not found'): never => fail(404, 'not_found', what);
export const forbidden = (why = 'Not allowed'): never => fail(403, 'forbidden', why);

export const MAX_BODY_BYTES = 256 * 1024;

/** Read and validate a JSON body. Empty body is treated as {}. */
export async function readJson<T>(c: Ctx, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const len = Number(c.req.header('content-length') || '0');
  if (len > MAX_BODY_BYTES) fail(413, 'payload_too_large', 'Request body is too large');
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) fail(413, 'payload_too_large', 'Request body is too large');
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      fail(400, 'bad_request', 'Body is not valid JSON');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) fail(400, 'validation', 'Some fields are not valid', parsed.error.issues);
  return parsed.data;
}

/** JSON response that is never cached by browsers or proxies. */
export function json(c: Ctx, data: unknown, status = 200): Response {
  c.header('Cache-Control', 'no-store');
  return c.json(data as object, status as 200);
}

export const nowISO = (): string => new Date().toISOString();

export const newId = (): string => crypto.randomUUID();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Random URL-safe token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0 O 1 I L

/** Random code from an alphabet without look-alike characters (for codes people type). */
export function randomCode(length: number): string {
  const a = new Uint8Array(length);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

/** Random invite code: 16 characters from [A-Za-z0-9] (about 95 bits). */
export function randomInviteCode(): string {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += ALPHA[b % ALPHA.length];
  return s;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** UUID-formatted id derived from a string (stable): used for recurring copies. */
export async function uuidFrom(s: string): Promise<string> {
  const h = await sha256Hex(s);
  const v = '8' + h.slice(17, 20); // RFC 4122 variant bits
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}-${h.slice(20, 32)}`;
}

/** APP_URL's origin (https://split.ginochang.com in production), or null when APP_URL is not a URL. */
export function appOrigin(env: { APP_URL: string }): string | null {
  try {
    return new URL(env.APP_URL).origin;
  } catch {
    return null;
  }
}

/**
 * The request came to APP_URL's origin, the one whose callbacks are registered at Google and Apple
 * (production also answers on workers.dev, where they would refuse the redirect). Local wrangler
 * dev on 127.0.0.1 or localhost counts too.
 */
export function onAppSite(c: Ctx): boolean {
  const here = new URL(c.req.url);
  if (here.hostname === '127.0.0.1' || here.hostname === 'localhost') return true;
  return appOrigin(c.env) === here.origin;
}

export function clientIp(c: Ctx): string {
  return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}

/** A short label for a session from the User-Agent ("iPhone Safari", "Windows Chrome"). */
export function deviceLabel(ua: string | undefined): string {
  if (!ua) return '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Line\//.test(ua) ? 'LINE' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, br].filter(Boolean).join(' ');
}
