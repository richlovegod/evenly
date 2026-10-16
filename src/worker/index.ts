// Evenly API: Cloudflare Worker entry (Hono router, D1 database, daily cron).

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { ApiErrorBody, ApiErrorCode } from '../shared/types';
import type { AppEnv, Ctx, Env } from './env';
import { ApiError, fail, json, MAX_BODY_BYTES } from './http';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { expenseRoutes } from './routes/expenses';
import { fxRoutes } from './routes/fx';
import { groupRoutes } from './routes/groups';
import { meRoutes } from './routes/me';
import { runDaily } from './services/cron';

const app = new Hono<AppEnv>();

// ---------- CORS (SPEC section 6) ----------

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Authorization, Content-Type, If-None-Match';

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
  varyOrigin(c);
  // API answers carry user data unless a route says otherwise (GET /api/fx is public).
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});

// Reject big bodies before any route reads them (readJson checks again for chunked bodies).
app.use('/api/*', async (c, next) => {
  const len = Number(c.req.header('Content-Length') || '0');
  if (len > MAX_BODY_BYTES) fail(413, 'payload_too_large', 'Request body is too large');
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
    if (err.status === 429) {
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

app.notFound(c => json(c, errorBody('not_found', 'Not found'), 404));

// ---------- routes ----------
// Public and self-contained modules are mounted first. Hono runs every matching handler in the
// order it was added, so a module mounted at /api that uses `use('*', requireUser)` must not
// come before routes that work without signing in.

app.get('/api/health', c => json(c, { ok: true, env: c.env.ENVIRONMENT }));

app.route('/api/auth', authRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api', fxRoutes);
app.route('/api', groupRoutes);
app.route('/api', meRoutes);
app.route('/api', expenseRoutes);

export default {
  fetch: app.fetch,
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(runDaily(env));
  },
} satisfies ExportedHandler<Env>;
