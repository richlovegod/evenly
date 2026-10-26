// Gino's Split Lab (code name Evenly): Cloudflare Worker entry. Hono router for /api, D1 database,
// the daily cron and the minutely push sender. Everything else is the built web app, served by
// Workers Static Assets (wrangler.toml [assets]); only page loads of the app itself ("/") come
// through here, to renew the session cookies on the page's own response, friend invite links
// (/i/<code>: the app's page with the invite's preview tags), and paths with no file
// (not_found_handling "none"), which get a 404 or, for a page load, the app.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { ApiErrorBody, ApiErrorCode } from '../shared/types';
import { renewPageCookies } from './auth';
import type { AppEnv, Ctx, Env } from './env';
import { ApiError, fail, json, MAX_BODY_BYTES } from './http';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { AVATAR_MAX_BODY, AVATAR_PATH, avatarRoutes } from './routes/avatars';
import { expenseRoutes } from './routes/expenses';
import { fxRoutes } from './routes/fx';
import { groupRoutes } from './routes/groups';
import { INVITE_AVATAR_PATH, invitePageHtml, inviteRoutes } from './routes/invites';
import { meRoutes } from './routes/me';
import { pushRoutes } from './routes/push';
import { RECEIPT_PHOTO_MAX_BYTES, RECEIPT_PHOTO_PATH, receiptPhotoRoutes } from './routes/receiptPhotos';
import { RECEIPT_MAX_BYTES, receiptRoutes } from './routes/receipts';
import { runDaily } from './services/cron';
import { runPushSender } from './services/push';

const app = new Hono<AppEnv>();

// ---------- CORS (SPEC section 6) ----------
// For app builds on other origins (GitHub Pages builds still open on phones, vite dev, tests),
// which call with a Bearer token. The app on this Worker's own origin needs none of it. Never
// Access-Control-Allow-Credentials: no other origin may read answers made with the session cookie.

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
// X-Evenly-Features: what the client understands (compat.ts), sent by the web app on every call.
const ALLOW_HEADERS = 'Authorization, Content-Type, If-None-Match, X-Evenly-User, X-Evenly-Features';

function allowedOrigin(env: Env, origin: string | undefined): string | null {
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return list.includes(origin) || list.includes('*') ? origin : null;
}

/** Add `Origin` to the Vary header once. */
function varyOrigin(c: Ctx): void {
  const vary = c.res.headers.get('Vary');
  if (!vary) c.header('Vary', 'Origin');
  else if (!/(^|,)\s*origin\s*(,|$)/i.test(vary)) c.header('Vary', vary + ', Origin');
}

app.use('/api/*', async (c, next) => {
  const origin = allowedOrigin(c.env, c.req.header('Origin'));
  if (c.req.method === 'OPTIONS') {
    const headers = new Headers({ Vary: 'Origin' });
    if (origin) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', ALLOW_METHODS);
      headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
      headers.set('Access-Control-Max-Age', '86400');
    }
    return new Response(null, { status: 204, headers });
  }
  await next();
  // After the handler (and the error handler), so every response gets these, 304s included.
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Expose-Headers', 'ETag');
  }
  // Vary: * keeps every cache out of API answers, including the evenly-v3 service worker still
  // installed on phones: it stores every same-origin GET, but Cache.put throws on Vary: *.
  // GET /api/fx is public and differs only by the CORS origin. A profile photo or a receipt photo
  // is private, and its ?v= address never changes its bytes: Vary: * would stop the browser keeping
  // it for a year (no shared cache stores a private answer, and the evenly-v3 worker keeps only ok
  // answers by URL). The same goes for the inviter's photo on a friend invite's page.
  const read = c.req.method === 'GET' || c.req.method === 'HEAD';
  const photo = AVATAR_PATH.test(c.req.path) || RECEIPT_PHOTO_PATH.test(c.req.path) || INVITE_AVATAR_PATH.test(c.req.path);
  if (read && (c.req.path === '/api/fx' || photo)) varyOrigin(c);
  else c.header('Vary', '*');
  // API answers carry user data unless a route says otherwise (GET /api/fx is public).
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});

// Reject big bodies before any route reads them (readJson checks again for chunked bodies). The
// receipt scan route takes up to RECEIPT_MAX_BYTES, the profile photo route up to AVATAR_MAX_BODY
// (150,000 bytes as base64, routes/avatars.ts) and a receipt photo up to RECEIPT_PHOTO_MAX_BYTES
// (raw bytes, routes/receiptPhotos.ts); each checks the body itself.
app.use('/api/*', async (c, next) => {
  const len = Number(c.req.header('Content-Length') || '0');
  const path = c.req.path;
  const limit = path === '/api/receipts/scan'
    ? RECEIPT_MAX_BYTES
    : path === '/api/me/avatar'
      ? AVATAR_MAX_BODY
      : RECEIPT_PHOTO_PATH.test(path)
        ? RECEIPT_PHOTO_MAX_BYTES
        : MAX_BODY_BYTES;
  if (len > limit) fail(413, 'payload_too_large', 'Request body is too large');
  await next();
});

// ---------- errors ----------

function errorBody(code: ApiErrorCode, message: string, details?: unknown): ApiErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

const HTTP_CODES: Record<number, ApiErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  429: 'rate_limited',
};

app.onError((err, c) => {
  if (err instanceof ApiError) {
    if (err.status >= 500) console.error(`${c.req.method} ${c.req.path}: ${err.code}: ${err.message}`);
    // 429 rate_limited, and 503 email_quota and receipts_quota (the day's code emails or photo
    // uploads are used up).
    if (err.status === 429 || err.status === 503) {
      const retry = (err.details as { retryAfter?: unknown } | undefined)?.retryAfter;
      if (typeof retry === 'number') c.header('Retry-After', String(retry));
    }
    return json(c, errorBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof ZodError) {
    return json(c, errorBody('validation', 'Some fields are not valid', err.issues), 400);
  }
  if (err instanceof HTTPException && err.status < 500) {
    return json(c, errorBody(HTTP_CODES[err.status] ?? 'bad_request', err.message || 'Request failed'), err.status);
  }
  console.error(`${c.req.method} ${c.req.path}: unhandled error`, err);
  return json(c, errorBody('server_error', 'Something went wrong on our side. Try again in a moment.'), 500);
});

/**
 * A top-level page load: the browser opening the page in a tab (Sec-Fetch-Mode navigate,
 * Sec-Fetch-Dest document), or a client that sends no Fetch Metadata (Safari before 16.4, curl).
 * A fetch of the page (the service worker's install, a script) is not one, and neither is a frame:
 * WebKit caps a cookie that such an answer sets to 7 days when the connection went to another of
 * the site's addresses, and the capped copy would replace the year-long one (auth.ts).
 */
function isTopLevelLoad(c: Ctx): boolean {
  const mode = c.req.header('Sec-Fetch-Mode');
  if (mode === undefined) return true;
  const dest = c.req.header('Sec-Fetch-Dest');
  return mode === 'navigate' && (dest === undefined || dest === 'document');
}

/** A browser opening a URL as a page (navigate, or an Accept that asks for HTML). */
function opensPage(c: Ctx): boolean {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return false;
  return c.req.header('Sec-Fetch-Mode') === 'navigate' || /\btext\/html\b/i.test(c.req.header('Accept') || '');
}

// A path with no route and no file (wrangler.toml not_found_handling "none"). A page load outside
// /api goes to the app at "/" with its query (the browser keeps the #route), so an old or mistyped
// link still opens the app. Everything else, a missing /assets/ file included, is a JSON 404 that
// no cache keeps (json() says no-store): never index.html, which a cache would keep as that file.
// "/" itself only gets here without an ASSETS binding, so it never points at itself.
app.notFound(c => {
  const path = c.req.path;
  const api = path === '/api' || path.startsWith('/api/');
  if (!api && path !== '/' && path !== '/index.html' && opensPage(c)) {
    c.header('Cache-Control', 'no-store');
    return c.redirect('/' + new URL(c.req.url).search, 302);
  }
  return json(c, errorBody('not_found', 'Not found'), 404);
});

// ---------- routes ----------
// Public and self-contained modules are mounted first. Hono runs every matching handler in the
// order it was added, so a module mounted at /api that uses `use('*', requireUser)` must not
// come before routes that work without signing in.

app.get('/api/health', c => json(c, { ok: true, env: c.env.ENVIRONMENT }));

/**
 * A page load of the app: the built index.html, with the session cookies renewed for a year on
 * this top-level response (auth.ts renewPageCookies). A fetch of the page (the service worker's
 * install) gets the same page without them (isTopLevelLoad). private: a response that sets cookies
 * is never kept by a shared cache. If the renewal fails, the page still loads. `rewrite` (a friend
 * invite's page) gets index.html's text and returns the page to send; HEAD skips it.
 */
async function appPage(c: Ctx, rewrite?: (html: string) => Promise<string>): Promise<Response> {
  if (!c.env.ASSETS) return c.notFound();
  // The session cookies are Secure (__Host-), so the app only works over https: send plain-http
  // page loads there (local wrangler dev on 127.0.0.1 or localhost excepted).
  const url = new URL(c.req.url);
  if (url.protocol === 'http:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    url.protocol = 'https:';
    return c.redirect(url.toString(), 301);
  }
  if (isTopLevelLoad(c)) {
    try {
      await renewPageCookies(c);
    } catch (err) {
      console.error('page load: cookie renewal failed', err);
    }
  }
  let res: Response;
  if (rewrite) {
    // index.html itself, asked for plainly: this answer is another page, which none of the
    // request's conditional headers (its ETag of index.html) can stand for.
    const built = await c.env.ASSETS.fetch(new Request(new URL('/', url).toString()));
    if (built.ok) {
      const body = c.req.method === 'HEAD' ? null : await rewrite(await built.text());
      res = new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    } else {
      res = built;
    }
  } else {
    res = await c.env.ASSETS.fetch(c.req.raw);
  }
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-cache');
  // public/_headers covers files the assets serve directly; this answer comes from the Worker.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  for (const cookie of c.res.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Page loads of the app (wrangler.toml run_worker_first: "/" and "/index.html").
app.on(['GET', 'HEAD'], ['/', '/index.html'], c => appPage(c));

// A friend invite link (wrangler.toml run_worker_first: "/i/*"; routes/invites.ts): the app's
// page with the invite's preview tags, for LINE, Messenger and the like. In a browser, index.html's
// first script moves the address to /#/i/<code>, where the app starts.
app.on(['GET', 'HEAD'], ['/i/:code', '/i/:code/'], c => appPage(c, html => invitePageHtml(c, html, c.req.param('code'))));

app.route('/api/auth', authRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api', fxRoutes);
app.route('/api', groupRoutes);
app.route('/api', inviteRoutes);
app.route('/api', meRoutes);
app.route('/api', expenseRoutes);
app.route('/api', pushRoutes);
app.route('/api', receiptRoutes);
app.route('/api', avatarRoutes);
app.route('/api', receiptPhotoRoutes);

export default {
  fetch: app.fetch,
  scheduled: (controller, env, ctx) => {
    // '* * * * *' sends due push notifications; '0 9 * * *' is the daily job (wrangler.toml).
    if (controller.cron === '* * * * *') ctx.waitUntil(runPushSender(env));
    else ctx.waitUntil(runDaily(env));
  },
} satisfies ExportedHandler<Env>;
