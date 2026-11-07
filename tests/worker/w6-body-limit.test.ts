// The body gate (src/worker/index.ts, review B1-03 and B3-02): a body without a Content-Length
// (chunked, or HTTP/2 without the header) is counted as it arrives and refused with 413 as soon as
// it passes the route's limit, before any route reads it, with or without a sign-in; a Content-Length
// over the limit is refused before a byte is read; bodies within the limit, chunked or not, reach the
// routes as before. Runs the real Worker against the real schema in SQLite (tests/worker/d1-sqlite.ts).

import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../src/worker/auth';
import { MAX_BODY_BYTES } from '../../src/worker/http';
import worker from '../../src/worker/index';
import { AVATAR_MAX_BODY } from '../../src/worker/routes/avatars';
import { RECEIPT_MAX_BYTES } from '../../src/worker/routes/receipts';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';
const CHUNK = 64 * 1024;

let db: TestD1;
let token: string;

beforeEach(async () => {
  db = new TestD1();
  const at = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'gino', 'Gino', 'gino@split.test', '#2F6FB5', at, at);
  token = await createSession(db.d1, 'gino', 'test');
});

/** `total` bytes of `fill`, made only as the reader pulls them; `pulled` says how many were. */
function stream(total: number, fill = 0x61): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (pulled >= total) {
        ctrl.close();
        return;
      }
      const n = Math.min(CHUNK, total - pulled);
      pulled += n;
      ctrl.enqueue(new Uint8Array(n).fill(fill));
    },
  });
  return { body, pulled: () => pulled };
}

/** `text` as a body without a Content-Length, in chunks. */
function chunked(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (at >= bytes.length) {
        ctrl.close();
        return;
      }
      ctrl.enqueue(bytes.slice(at, at + 1000));
      at += 1000;
    },
  });
}

async function send(method: string, path: string, body: ReadableStream<Uint8Array> | string, o: { type?: string; bearer?: boolean; length?: number } = {}) {
  const h: Record<string, string> = { 'Content-Type': o.type ?? 'application/json', 'cf-connecting-ip': '203.0.113.7' };
  if (o.bearer) h.Authorization = 'Bearer ' + token;
  if (o.length !== undefined) h['Content-Length'] = String(o.length);
  const init: RequestInit & { duplex?: string } = { method, headers: h, body };
  if (body instanceof ReadableStream) init.duplex = 'half';
  const req = new Request(SITE + path, init);
  expect(typeof body === 'string' || o.length !== undefined || req.headers.get('content-length') === null).toBe(true);
  const env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text && (res.headers.get('Content-Type') || '').includes('json') ? JSON.parse(text) : undefined, headers: res.headers };
}

const MB = 1024 * 1024;

describe('the body gate (review B1-03, B3-02)', () => {
  it('a 20 MB body without a Content-Length is refused once it passes 256 KB, without a sign-in: login and Apple\'s callback', async () => {
    for (const [path, type] of [['/api/auth/login', 'application/json'], ['/api/auth/apple/callback', 'application/x-www-form-urlencoded']] as const) {
      const s = stream(20 * MB);
      const r = await send('POST', path, s.body, { type });
      expect([path, r.status, r.data?.error?.code]).toEqual([path, 413, 'payload_too_large']);
      expect(r.headers.get('Cache-Control')).toBe('no-store');
      // Only a little past the limit was ever pulled, never the 20 MB.
      expect(s.pulled()).toBeGreaterThan(MAX_BODY_BYTES);
      expect(s.pulled()).toBeLessThan(MAX_BODY_BYTES + 4 * CHUNK);
    }
  });

  it('the receipt scan and the profile photo stop at their own limits too', async () => {
    for (const [method, path, limit] of [['POST', '/api/receipts/scan', RECEIPT_MAX_BYTES], ['PUT', '/api/me/avatar', AVATAR_MAX_BODY]] as const) {
      const s = stream(20 * MB);
      const r = await send(method, path, s.body, { bearer: true });
      expect([path, r.status, r.data?.error?.code]).toEqual([path, 413, 'payload_too_large']);
      expect(s.pulled()).toBeLessThan(limit + 4 * CHUNK);
      // One byte over is refused, the limit itself is not (the route then reads it: not JSON here).
      expect((await send(method, path, stream(limit + 1).body, { bearer: true })).status).toBe(413);
      const at = await send(method, path, stream(limit).body, { bearer: true });
      expect([path, at.status, at.data?.error?.code]).toEqual([path, 400, 'bad_request']);
    }
  });

  it('exactly 256 KB without a Content-Length goes through; one byte more does not', async () => {
    const json = (size: number) => {
      const head = '{"email":"gino@split.test","password":"not the password","pad":"';
      return head + 'a'.repeat(size - head.length - 2) + '"}';
    };
    expect(json(MAX_BODY_BYTES)).toHaveLength(MAX_BODY_BYTES);
    const at = await send('POST', '/api/auth/login', chunked(json(MAX_BODY_BYTES)));
    expect([at.status, at.data.error.code]).toEqual([401, 'invalid_credentials']);
    const over = await send('POST', '/api/auth/login', chunked(json(MAX_BODY_BYTES + 1)));
    expect([over.status, over.data.error.code]).toEqual([413, 'payload_too_large']);
  });

  it('a small body without a Content-Length reaches the route whole, as one with it does', async () => {
    const body = JSON.stringify({ name: 'Gino Chang' });
    const r = await send('PATCH', '/api/me', chunked(body), { bearer: true });
    expect(r.status).toBe(200);
    expect(db.rows<{ name: string }>('SELECT name FROM users WHERE id = ?', 'gino')[0].name).toBe('Gino Chang');
    const plain = await send('PATCH', '/api/me', JSON.stringify({ name: 'Gino' }), { bearer: true });
    expect(plain.status).toBe(200);
    expect(db.rows<{ name: string }>('SELECT name FROM users WHERE id = ?', 'gino')[0].name).toBe('Gino');
  });

  it('a Content-Length over the limit is refused before the body is read', async () => {
    const s = stream(20 * MB);
    const r = await send('POST', '/api/auth/login', s.body, { length: 20 * MB });
    expect([r.status, r.data.error.code]).toEqual([413, 'payload_too_large']);
    // A stream fills its first chunk on its own; nothing past it was asked for.
    expect(s.pulled()).toBeLessThanOrEqual(CHUNK);
  });
});
