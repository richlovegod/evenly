// A code to sign in another device dies with the sessions (review B1-01): ending a session of the
// account (POST /api/auth/logout, DELETE /api/auth/sessions/:id from 我的, a reset link) cancels the
// account's open code, and POST /api/auth/link-code makes none for a session that ended after
// requireUser saw it. Otherwise a stolen session that keeps a fresh code waiting could sign straight
// back in each time it is signed out. Runs the real Worker against the real schema in SQLite
// (tests/worker/d1-sqlite.ts), as a script would call it (Bearer, no browser headers).

import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../src/worker/auth';
import { sha256Hex } from '../../src/worker/http';
import worker from '../../src/worker/index';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';

let db: TestD1;
/** Runs once, right before the next batch: a session that ends between requireUser and the write. */
let beforeBatch: (() => void) | null;

/** The test database as the Worker's DB, with the beforeBatch hook. */
function d1(): D1Database {
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (stmts: Parameters<TestD1['batch']>[0]) => {
      const hook = beforeBatch;
      beforeBatch = null;
      hook?.();
      return db.batch(stmts);
    },
  } as unknown as D1Database;
}

interface Res<T = any> {
  status: number;
  data: T;
}

async function call<T = any>(method: string, path: string, o: { bearer?: string; body?: unknown } = {}): Promise<Res<T>> {
  const h: Record<string, string> = { 'cf-connecting-ip': '203.0.113.7' };
  if (o.bearer) h.Authorization = 'Bearer ' + o.bearer;
  if (o.body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request(SITE + path, { method, headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const env = { DB: d1(), ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

/** A code to sign in another device, asked for with `token`'s session. */
async function codeFrom(token: string): Promise<string> {
  const r = await call('POST', '/api/auth/link-code', { bearer: token, body: {} });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data.code;
}

const link = (code: string) => call('POST', '/api/auth/link', { body: { code } });
const me = (token: string) => call('GET', '/api/me', { bearer: token });
const openCodes = () => db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM login_codes WHERE kind = 'device' AND used_at IS NULL")[0].n;

/** Gino's phone, and a session someone took from him (a copied cookie or token). */
let phone: string;
let stolen: string;

beforeEach(async () => {
  db = new TestD1();
  beforeBatch = null;
  const at = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'gino', 'Gino', 'gino@split.test', '#2F6FB5', at, at);
  phone = await createSession(db.d1, 'gino', 'iPhone');
  stolen = await createSession(db.d1, 'gino', 'Windows Chrome');
});

describe('a code to sign in another device and the sessions (review B1-01)', () => {
  it('a code from a live session signs a new device in, once', async () => {
    const code = await codeFrom(phone);
    const r = await link(code);
    expect(r.status).toBe(200);
    expect(r.data.user.id).toBe('gino');
    expect((await me(r.data.token)).status).toBe(200);
    expect((await link(code)).data.error.code).toBe('code_invalid');
  });

  it('signing that device out from 我的 cancels the code it asked for', async () => {
    const code = await codeFrom(stolen);
    const out = await call('DELETE', '/api/auth/sessions/' + (await sha256Hex(stolen)), { bearer: phone });
    expect(out.status).toBe(200);
    expect((await me(stolen)).status).toBe(401);
    const r = await link(code);
    expect([r.status, r.data.error.code]).toEqual([400, 'code_invalid']);
    expect(openCodes()).toBe(0);
  });

  it('logging out cancels it', async () => {
    const code = await codeFrom(stolen);
    expect((await call('POST', '/api/auth/logout', { bearer: stolen, body: {} })).status).toBe(200);
    expect((await link(code)).data.error.code).toBe('code_invalid');
    expect((await me(phone)).status).toBe(200);
  });

  it('a reset link signs every session out, with the code', async () => {
    const code = await codeFrom(stolen);
    // A reset link as the admin page makes it (routes/admin.ts).
    const token = 'reset-token-0123456789abcdef';
    db.exec(
      "INSERT INTO login_codes (id, user_id, kind, expires_at, used_at, created_at) VALUES (?, 'gino', 'reset', ?, NULL, ?)",
      await sha256Hex(token), new Date(Date.now() + 30 * 60_000).toISOString(), new Date().toISOString(),
    );
    const reset = await call('POST', '/api/auth/reset', { body: { token, password: 'a new password 1' } });
    expect(reset.status).toBe(200);
    expect((await me(stolen)).status).toBe(401);
    expect((await link(code)).data.error.code).toBe('code_invalid');
    expect((await me(reset.data.token)).status).toBe(200);
  });

  it('a session asked for a code as it was signed out: no code is made, and the answer is 401', async () => {
    // The owner signs the device out between requireUser and the write (no cancel runs after it).
    const sid = await sha256Hex(stolen);
    beforeBatch = () => db.exec('DELETE FROM sessions WHERE id = ?', sid);
    const r = await call('POST', '/api/auth/link-code', { bearer: stolen, body: {} });
    expect([r.status, r.data.error.code]).toEqual([401, 'unauthorized']);
    expect(openCodes()).toBe(0);
  });

  it('signing out a session that is not there is 404 and leaves the code alone', async () => {
    const code = await codeFrom(phone);
    const r = await call('DELETE', '/api/auth/sessions/' + 'f'.repeat(64), { bearer: phone });
    expect(r.status).toBe(404);
    expect((await link(code)).status).toBe(200);
  });

  it('the account has one open code, and ending any of its sessions cancels it: the table does not say which session asked', async () => {
    const code = await codeFrom(phone);
    expect((await call('POST', '/api/auth/logout', { bearer: stolen, body: {} })).status).toBe(200);
    expect((await link(code)).data.error.code).toBe('code_invalid');
    // A new code from the phone works again.
    expect((await link(await codeFrom(phone))).status).toBe(200);
  });
});
