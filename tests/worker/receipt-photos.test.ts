// Receipt photos kept with their expense (routes/receiptPhotos.ts, services/receiptPhotos.ts;
// docs/SPEC.md section 6, Receipt photos): uploading (the body checks, the size limit and the body
// gate, ?w= and ?h=, who may, a deleted entry, replacing), fetching (who may, the cache headers,
// 304 and a stale ?v=), removing, the per-account limit and the two whole-app caps, the group
// version, the `receipt` field in every answer that carries an expense and in the export, and the
// daily cleanup with its undo window. Runs the real Worker against the real schema in SQLite
// (d1-sqlite.ts) with an in-memory KV namespace, and https://split.test as the app's origin.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayUTC } from '../../src/shared/dates';
import type { ExpenseDTO, GroupSnapshotDTO, ReceiptDTO } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import { MAX_BODY_BYTES } from '../../src/worker/http';
import worker from '../../src/worker/index';
import {
  RECEIPT_KV_WRITES_PER_DAY, RECEIPT_MAX_SIDE, RECEIPT_PHOTO_MAX_BYTES, RECEIPT_PHOTO_PER_DAY, RECEIPT_STORE_MAX_BYTES,
} from '../../src/worker/routes/receiptPhotos';
import { runDaily } from '../../src/worker/services/cron';
import { cleanupReceiptPhotos, RECEIPT_CLEANUP_PER_RUN, receiptKey } from '../../src/worker/services/receiptPhotos';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';
/** A sibling site: same-site for SameSite=Lax, so the browser still sends the cookie from it. */
const SIBLING = 'https://award.split.test';
const DAY_MS = 86_400_000;

/** A real 4 x 4 JPEG and a real 2 x 2 PNG. */
const JPEG = Buffer.from(
  '/9j/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC8AGLE/9k=',
  'base64',
);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPQz9/6H4QZYAwATi4JSZ2rmMEAAAAASUVORK5CYII=', 'base64');

const versionOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
/** `n` bytes that start like a JPEG. */
function jpegOf(n: number, fill = 0): Uint8Array {
  const b = new Uint8Array(n).fill(fill);
  b.set([0xff, 0xd8, 0xff]);
  return b;
}

/** Workers KV as the routes use it: put, get as a stream or bytes, delete; deletes can be made to fail. */
class FakeKV {
  readonly map = new Map<string, Uint8Array>();
  puts = 0;
  deletes: string[] = [];
  failDeletes = false;
  failPuts: string | null = null;
  async put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<void> {
    if (this.failPuts) throw new Error(this.failPuts);
    this.puts++;
    const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.map.set(key, new Uint8Array(view));
  }
  async get(key: string, type?: string): Promise<unknown> {
    const v = this.map.get(key);
    if (!v) return null;
    if (type === 'stream') return new Response(v.slice()).body;
    return v.slice().buffer;
  }
  async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error('KV delete failed');
    this.deletes.push(key);
    this.map.delete(key);
  }
}

let db: TestD1;
let kv: FakeKV;
let vars: Record<string, string> = {};
const tokens: Record<string, string> = {};

interface Call {
  as?: string;
  /** Sign in with this Cookie header instead. */
  cookie?: string;
  /** Where a cookie request comes from: this app (default), or a sibling site. */
  from?: 'app' | 'sibling';
  /** The body as it is (bytes go raw), with this Content-Type. */
  body?: Uint8Array | string;
  type?: string;
  /** Send Content-Length (default: whatever the body is; false: a chunked body without it). */
  length?: boolean;
  headers?: Record<string, string>;
  json?: unknown;
}

interface Res<T = any> {
  status: number;
  data: T;
  bytes: Buffer;
  headers: Headers;
}

const env = () => ({ DB: db.d1, RECEIPTS: kv, ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test', ...vars });

async function call<T = any>(method: string, path: string, o: Call = {}): Promise<Res<T>> {
  const h: Record<string, string> = {};
  if (o.as) h.Authorization = 'Bearer ' + tokens[o.as];
  if (o.cookie) {
    h.Cookie = o.cookie;
    const write = method !== 'GET' && method !== 'HEAD';
    if (o.from === 'sibling') Object.assign(h, { 'Sec-Fetch-Site': 'same-site', Origin: SIBLING });
    else Object.assign(h, write ? { 'Sec-Fetch-Site': 'same-origin', Origin: SITE } : { 'Sec-Fetch-Site': 'same-origin' });
  }
  let body: BodyInit | undefined;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    h['Content-Type'] = 'application/json';
  } else if (o.body !== undefined) {
    const bytes = typeof o.body === 'string' ? new TextEncoder().encode(o.body) : o.body;
    if (o.type !== undefined) h['Content-Type'] = o.type;
    if (o.length !== false) h['Content-Length'] = String(bytes.length);
    // Without a length, a stream: what a chunked upload looks like to the Worker.
    body = o.length === false ? new Response(bytes).body! : bytes;
  }
  Object.assign(h, o.headers);
  const init: RequestInit & { duplex?: string } = { method, headers: h, body };
  if (body instanceof ReadableStream) init.duplex = 'half';
  const req = new Request(SITE + path, init);
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env() as never, ctx);
  const bytes = Buffer.from(await res.arrayBuffer());
  const isJson = (res.headers.get('Content-Type') || '').includes('json');
  return { status: res.status, data: isJson && bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined, bytes, headers: res.headers };
}

const jar = (id: string): string => `__Host-evenly_session=${tokens[id]}; __Host-evenly_user=${id}`;

function addUser(id: string, name: string): void {
  const at = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, `${id}@split.test`, '#2F6FB5', at, at);
}

interface World {
  gid: string;
  gino: string;
  abbie: string;
  /** Gino's dinner in the trip. */
  eid: string;
}

const TODAY = todayUTC();

function expenseBody(payer: string, amount = 1200): unknown {
  return {
    kind: 'expense', description: 'Dinner', category: 'food.dining', amount, currency: 'JPY', fxRate: 1, date: TODAY,
    payers: [{ memberId: payer, amount }], split: { method: 'equal', entries: [{ memberId: payer }] },
  };
}

async function addExpense(as: string, gid: string, eid: string, payer: string): Promise<ExpenseDTO> {
  const r = await call<{ expense: ExpenseDTO }>('PUT', `/api/groups/${gid}/expenses/${eid}`, { as, json: expenseBody(payer) });
  expect(r.status).toBe(200);
  return r.data.expense;
}

/** Gino's trip with Abbie (joined by the invite link) and a dinner. Leo shares no group with them. */
async function world(): Promise<World> {
  for (const [id, name] of [['gino', 'Gino'], ['abbie', 'Abbie'], ['leo', 'Leo']]) {
    addUser(id, name);
    tokens[id] = await createSession(db.d1, id, 'test');
  }
  const trip = (await call<GroupSnapshotDTO>('POST', '/api/groups', { as: 'gino', json: { name: 'Niseko', type: 'trip', currency: 'JPY' } })).data;
  const join = await call('POST', '/api/join/' + trip.inviteCode, { as: 'abbie', json: { name: 'Abbie' } });
  expect(join.status).toBe(200);
  const eid = 'dinner-0001';
  await addExpense('gino', trip.group.id, eid, trip.me.memberId);
  return { gid: trip.group.id, gino: trip.me.memberId, abbie: join.data.memberId, eid };
}

const path = (w: { gid: string }, eid: string) => `/api/groups/${w.gid}/expenses/${eid}/receipt`;
const upload = (as: string, w: World, bytes: Uint8Array = JPEG, o: Partial<Call> & { w?: string | number; h?: string | number; eid?: string } = {}) =>
  call<{ receipt: ReceiptDTO; groupVersion: number }>('PUT', `${path(w, o.eid ?? w.eid)}?w=${o.w ?? 1200}&h=${o.h ?? 1600}`, { as, body: bytes, type: 'image/jpeg', ...o });
const photo = (as: string, w: World, v?: string, headers?: Record<string, string>, eid?: string) =>
  call('GET', path(w, eid ?? w.eid) + (v === undefined ? '' : '?v=' + encodeURIComponent(v)), { as, headers });
const groupVersion = (gid: string): number => db.rows<{ version: number }>('SELECT version FROM groups WHERE id = ?', gid)[0].version;
const rowsOf = (eid: string) => db.rows<{ kv_key: string; version: string; mime: string; bytes: number; width: number; height: number; uploaded_by: string; group_id: string }>('SELECT * FROM receipts WHERE expense_id = ?', eid);
const snapOf = async (as: string, gid: string) => (await call<GroupSnapshotDTO>('GET', '/api/groups/' + gid, { as })).data;
const NOT_FOUND = { error: { code: 'not_found', message: 'Not found' } };

beforeEach(() => {
  db = new TestD1();
  kv = new FakeKV();
  vars = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- uploading ----------

describe('PUT /api/groups/:gid/expenses/:eid/receipt', () => {
  it('stores the bytes in KV under receipt:<eid>:<version>, the row in D1, and answers the receipt and the new group version', async () => {
    const w = await world();
    const before = groupVersion(w.gid);
    const activity = db.rows('SELECT id FROM activity').length;
    const r = await upload('abbie', w, JPEG, { w: 1200, h: 1600 });
    expect(r.status).toBe(200);
    const v = versionOf(JPEG);
    expect(r.data).toEqual({ receipt: { version: v, mime: 'image/jpeg', width: 1200, height: 1600, bytes: JPEG.length }, groupVersion: before + 1 });
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.headers.get('Vary')).toBe('*');
    expect(Buffer.from(kv.map.get(receiptKey(w.eid, v))!).equals(JPEG)).toBe(true);
    expect(rowsOf(w.eid)).toEqual([expect.objectContaining({ kv_key: `receipt:${w.eid}:${v}`, version: v, mime: 'image/jpeg', bytes: JPEG.length, width: 1200, height: 1600, uploaded_by: 'abbie', group_id: w.gid })]);
    expect(groupVersion(w.gid)).toBe(before + 1);
    // No activity row, so no push.
    expect(db.rows('SELECT id FROM activity')).toHaveLength(activity);
  });

  it('takes a PNG, and a new photo replaces the old one: one row, the old object deleted after the new one is stored', async () => {
    const w = await world();
    const first = await upload('gino', w, JPEG);
    const second = await upload('gino', w, PNG, { type: 'image/png', w: 2, h: 2 });
    expect(second.status).toBe(200);
    expect(second.data.receipt).toEqual({ version: versionOf(PNG), mime: 'image/png', width: 2, height: 2, bytes: PNG.length });
    expect(second.data.groupVersion).toBe(first.data.groupVersion + 1);
    expect(rowsOf(w.eid)).toHaveLength(1);
    expect(rowsOf(w.eid)[0].mime).toBe('image/png');
    expect([...kv.map.keys()]).toEqual([receiptKey(w.eid, versionOf(PNG))]);
    expect(kv.deletes).toEqual([receiptKey(w.eid, versionOf(JPEG))]);
  });

  it('the same photo again writes nothing and answers the current version', async () => {
    const w = await world();
    const first = await upload('gino', w);
    const again = await upload('gino', w);
    expect(again.status).toBe(200);
    expect(again.data).toEqual(first.data);
    expect(kv.puts).toBe(1);
    expect(groupVersion(w.gid)).toBe(first.data.groupVersion);
  });

  it('refuses a body that is not a JPEG or PNG starting the way its Content-Type says: 400 bad_request, nothing stored or counted', async () => {
    const w = await world();
    const cases: [string, Partial<Call>][] = [
      ['PNG bytes called a JPEG', { body: PNG, type: 'image/jpeg' }],
      ['JPEG bytes called a PNG', { body: JPEG, type: 'image/png' }],
      ['a page called a JPEG', { body: '<svg onload="alert(1)"></svg>', type: 'image/jpeg' }],
      ['a GIF', { body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'), type: 'image/gif' }],
      ['a WebP', { body: Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), type: 'image/webp' }],
      ['JSON with a data URL', { body: JSON.stringify({ image: 'data:image/jpeg;base64,' + JPEG.toString('base64') }), type: 'application/json' }],
      ['no Content-Type', { body: JPEG, type: undefined }],
      ['an empty body', { body: new Uint8Array(0), type: 'image/jpeg' }],
      ['two bytes of a JPEG', { body: new Uint8Array([0xff, 0xd8]), type: 'image/jpeg' }],
    ];
    for (const [what, o] of cases) {
      const r = await upload('gino', w, JPEG, o);
      expect([what, r.status, r.data?.error?.code, r.data?.error?.details]).toEqual([what, 400, 'bad_request', { fields: ['body'] }]);
    }
    // The Content-Type may carry parameters, in any case.
    expect((await upload('gino', w, JPEG, { type: 'Image/JPEG; charset=binary' })).status).toBe(200);
    expect(kv.puts).toBe(1);
    expect(db.rows("SELECT count FROM rate_limits WHERE key LIKE 'receipt-photo:user:%'")).toEqual([{ count: 1 }]);
  });

  it('needs w and h as whole px from 1 to 4000', async () => {
    const w = await world();
    for (const [name, wv, hv] of [['w', '', 10], ['w', 0, 10], ['w', RECEIPT_MAX_SIDE + 1, 10], ['w', 'abc', 10], ['w', '1.5', 10], ['w', '-3', 10], ['w', '0012', 10], ['h', 10, ''], ['h', 10, 99999]] as const) {
      const r = await upload('gino', w, JPEG, { w: wv, h: hv });
      expect([name, wv, hv, r.status, r.data.error.details]).toEqual([name, wv, hv, 400, { fields: [name] }]);
    }
    const most = await upload('gino', w, JPEG, { w: RECEIPT_MAX_SIDE, h: 1 });
    expect(most.status).toBe(200);
    expect(most.data.receipt).toMatchObject({ width: RECEIPT_MAX_SIDE, height: 1 });
  });

  it('takes up to 600,000 bytes past the 256 KB gate, and refuses one more with 413, with or without a Content-Length', async () => {
    const w = await world();
    const most = jpegOf(RECEIPT_PHOTO_MAX_BYTES, 7);
    expect(most.length).toBeGreaterThan(MAX_BODY_BYTES);
    const ok = await upload('gino', w, most);
    expect(ok.status).toBe(200);
    expect(ok.data.receipt.bytes).toBe(RECEIPT_PHOTO_MAX_BYTES);
    expect(kv.map.get(receiptKey(w.eid, versionOf(most)))!.length).toBe(RECEIPT_PHOTO_MAX_BYTES);

    const over = jpegOf(RECEIPT_PHOTO_MAX_BYTES + 1);
    for (const length of [true, false]) {
      const r = await upload('gino', w, over, { length });
      expect([length, r.status, r.data.error.code]).toEqual([length, 413, 'payload_too_large']);
    }
    // A chunked body under the limit goes through too.
    const chunked = await upload('gino', w, PNG, { type: 'image/png', length: false });
    expect(chunked.status).toBe(200);
    expect(kv.puts).toBe(2);
    // The other routes keep the 256 KB gate.
    const other = await call('PATCH', '/api/me', { as: 'gino', body: JSON.stringify({ name: 'x', pad: 'A'.repeat(MAX_BODY_BYTES) }), type: 'application/json' });
    expect(other.status).toBe(413);
  });

  it('only an active member of the live group, for an entry of that group: 404 otherwise', async () => {
    const w = await world();
    const leos = (await call<GroupSnapshotDTO>('POST', '/api/groups', { as: 'leo', json: { name: 'Leo', type: 'other', currency: 'JPY' } })).data;
    await addExpense('leo', leos.group.id, 'leo-taxi-01', leos.me.memberId);
    const refusals: [string, Promise<Res>][] = [
      ['a stranger', upload('leo', w)],
      ['an entry of another group', upload('gino', { ...w, gid: leos.group.id })],
      ["someone else's entry under my group", upload('gino', w, JPEG, { eid: 'leo-taxi-01' })],
      ['no such entry', upload('gino', w, JPEG, { eid: 'nothing-here' })],
      ['not an entry id', upload('gino', w, JPEG, { eid: 'a' })],
    ];
    for (const [what, p] of refusals) {
      const r = await p;
      expect([what, r.status, r.data?.error?.code]).toEqual([what, 404, 'not_found']);
    }
    // Someone who left, and a deleted group.
    expect((await call('DELETE', `/api/groups/${w.gid}/members/${w.abbie}`, { as: 'abbie' })).status).toBe(200);
    expect((await upload('abbie', w)).status).toBe(404);
    expect((await call('DELETE', '/api/groups/' + w.gid, { as: 'gino' })).status).toBe(200);
    expect((await upload('gino', w)).status).toBe(404);
    expect(kv.puts).toBe(0);
    expect(db.rows('SELECT expense_id FROM receipts')).toEqual([]);
    expect((await call('PUT', `${path(w, w.eid)}?w=1&h=1`, { body: JPEG, type: 'image/jpeg' })).status).toBe(401);
  });

  it('a deleted entry takes no new photo (404) but keeps the one it has, and 復原 brings it back with it', async () => {
    const w = await world();
    const v = (await upload('gino', w)).data.receipt.version;
    const del = await call<{ expense: ExpenseDTO }>('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'gino' });
    expect(del.data.expense.receipt?.version).toBe(v);
    expect((await upload('gino', w, PNG, { type: 'image/png' })).status).toBe(404);
    // Still shown on the deleted entry (the snapshot shows deleted entries).
    expect((await photo('abbie', w, v)).status).toBe(200);
    const back = await call<{ expense: ExpenseDTO }>('POST', `/api/groups/${w.gid}/expenses/${w.eid}/restore`, { as: 'gino' });
    expect(back.data.expense.receipt).toMatchObject({ version: v });
    expect((await upload('gino', w, PNG, { type: 'image/png' })).status).toBe(200);
  });

  it('with the cookie, only this site may upload or remove (403 forbidden from another site), and an <img> loads it', async () => {
    const w = await world();
    const r = await call('PUT', `${path(w, w.eid)}?w=4&h=4`, { cookie: jar('gino'), from: 'sibling', body: JPEG, type: 'image/jpeg' });
    expect([r.status, r.data.error.code]).toEqual([403, 'forbidden']);
    const ok = await call('PUT', `${path(w, w.eid)}?w=4&h=4`, { cookie: jar('gino'), body: JPEG, type: 'image/jpeg' });
    expect(ok.status).toBe(200);
    expect((await call('DELETE', path(w, w.eid), { cookie: jar('gino'), from: 'sibling' })).status).toBe(403);
    const img = await call('GET', `${path(w, w.eid)}?v=${ok.data.receipt.version}`, { cookie: jar('abbie') });
    expect(img.status).toBe(200);
    expect(img.bytes.equals(JPEG)).toBe(true);
  });

  it('a failed KV put stores nothing and says why: receipts_quota when KV refuses for its daily limit, else server_error', async () => {
    const w = await world();
    kv.failPuts = 'KV PUT failed: 429 Too Many Requests';
    const quota = await upload('gino', w);
    expect([quota.status, quota.data.error.code]).toEqual([503, 'receipts_quota']);
    expect(Number(quota.headers.get('Retry-After'))).toBeGreaterThan(0);
    kv.failPuts = 'network connection lost';
    const other = await upload('gino', w);
    expect([other.status, other.data.error.code]).toEqual([503, 'server_error']);
    expect(rowsOf(w.eid)).toEqual([]);
  });

  it('without the RECEIPTS binding: 503 for writes, 404 for reads', async () => {
    const w = await world();
    (kv as unknown) = undefined;
    expect((await upload('gino', w)).status).toBe(503);
    expect((await photo('gino', w)).status).toBe(404);
    expect((await call('DELETE', path(w, w.eid), { as: 'gino' })).status).toBe(503);
  });
});

// ---------- the limits ----------

describe('limits', () => {
  const seed = (key: string, count: number) => db.exec('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)', key, count, Date.now() + DAY_MS);

  it('40 uploads per account a UTC day, then 429 rate_limited with retryAfter to 00:00 UTC; others have their own count', async () => {
    const w = await world();
    expect(RECEIPT_PHOTO_PER_DAY).toBe(40);
    seed(`receipt-photo:user:gino:${TODAY}`, RECEIPT_PHOTO_PER_DAY - 1);
    expect((await upload('gino', w)).status).toBe(200);
    const r = await upload('gino', w, PNG, { type: 'image/png' });
    expect([r.status, r.data.error.code, r.data.error.details.scope]).toEqual([429, 'rate_limited', 'user']);
    expect(r.data.error.details.retryAfter).toBeGreaterThan(0);
    expect(r.data.error.details.retryAfter).toBeLessThanOrEqual(86_400);
    expect(Number(r.headers.get('Retry-After'))).toBe(r.data.error.details.retryAfter);
    expect((await upload('abbie', w, PNG, { type: 'image/png' })).status).toBe(200);
  });

  it('900 KV writes a UTC day for the whole app, then 503 receipts_quota with retryAfter, and nothing is written', async () => {
    const w = await world();
    expect(RECEIPT_KV_WRITES_PER_DAY).toBe(900);
    seed(`receipt-photo:kv:${TODAY}`, RECEIPT_KV_WRITES_PER_DAY - 1);
    expect((await upload('gino', w)).status).toBe(200);
    const r = await upload('abbie', w, PNG, { type: 'image/png' });
    expect([r.status, r.data.error.code]).toEqual([503, 'receipts_quota']);
    expect(Number(r.headers.get('Retry-After'))).toBe(r.data.error.details.retryAfter);
    expect(kv.puts).toBe(1);
    expect(rowsOf(w.eid)[0].version).toBe(versionOf(JPEG));
    // RECEIPT_KV_WRITES_PER_DAY overrides it (staging keeps a small slice).
    vars = { RECEIPT_KV_WRITES_PER_DAY: '5000' };
    expect((await upload('abbie', w, PNG, { type: 'image/png' })).status).toBe(200);
  });

  it('refuses a photo that would take the stored total past 950,000,000 bytes: 503 receipts_full', async () => {
    const w = await world();
    expect(RECEIPT_STORE_MAX_BYTES).toBe(950_000_000);
    // Another entry's photo takes nearly all the room.
    await addExpense('gino', w.gid, 'big-one-0001', w.gino);
    db.exec(
      `INSERT INTO receipts (expense_id, group_id, kv_key, version, mime, bytes, width, height, uploaded_by, created_at) VALUES ('big-one-0001', ?, 'receipt:big-one-0001:x', 'x', 'image/jpeg', ?, 1, 1, 'gino', ?)`,
      w.gid, RECEIPT_STORE_MAX_BYTES - JPEG.length, new Date().toISOString(),
    );
    expect((await upload('gino', w)).status).toBe(200);
    const r = await upload('gino', w, PNG, { type: 'image/png' });
    expect([r.status, r.data.error.code]).toEqual([503, 'receipts_full']);
    expect(kv.puts).toBe(1);
    // Removing a photo makes room again.
    expect((await call('DELETE', path(w, w.eid), { as: 'gino' })).status).toBe(200);
    expect((await upload('gino', w, PNG, { type: 'image/png' })).status).toBe(200);
  });
});

// ---------- fetching ----------

describe('GET /api/groups/:gid/expenses/:eid/receipt', () => {
  it('gives every member the bytes with their type, kept a year at the ?v= address', async () => {
    const w = await world();
    const v = (await upload('gino', w)).data.receipt.version;
    for (const who of ['gino', 'abbie']) {
      const r = await photo(who, w, v);
      expect([who, r.status]).toEqual([who, 200]);
      expect(r.bytes.equals(JPEG)).toBe(true);
      expect(r.headers.get('Content-Type')).toBe('image/jpeg');
      expect(r.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
      expect(r.headers.get('ETag')).toBe(`"${v}"`);
      // Not Vary: *, which would keep the browser from storing it.
      expect(r.headers.get('Vary')).toBe('Origin');
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(r.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    }
    const png = (await upload('abbie', w, PNG, { type: 'image/png' })).data.receipt.version;
    const r = await photo('gino', w, png);
    expect(r.headers.get('Content-Type')).toBe('image/png');
    expect(r.bytes.equals(PNG)).toBe(true);
  });

  it('answers one 404 for no photo, a stranger, someone who left, a deleted group and an old v', async () => {
    const w = await world();
    const none = await photo('gino', w);
    const v1 = (await upload('gino', w)).data.receipt.version;
    const v2 = (await upload('gino', w, PNG, { type: 'image/png' })).data.receipt.version;
    const refusals: [string, Res][] = [
      ['no photo', none],
      ['a stranger', await photo('leo', w, v2)],
      ['a stranger without v', await photo('leo', w)],
      ['an old v', await photo('abbie', w, v1)],
      ['an empty v', await photo('abbie', w, '')],
      ['another entry', await photo('gino', w, v2, undefined, 'nothing-here')],
    ];
    expect((await call('DELETE', `/api/groups/${w.gid}/members/${w.abbie}`, { as: 'abbie' })).status).toBe(200);
    refusals.push(['someone who left', await photo('abbie', w, v2)]);
    for (const [what, r] of refusals) {
      expect([what, r.status, r.data]).toEqual([what, 404, NOT_FOUND]);
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
    expect((await photo('gino', w, v2)).status).toBe(200);
    expect((await call('DELETE', '/api/groups/' + w.gid, { as: 'gino' })).status).toBe(200);
    expect(await photo('gino', w, v2)).toMatchObject({ status: 404, data: NOT_FOUND });
  });

  it('without v it is the current photo, checked every time; If-None-Match gets a 304 without reading KV', async () => {
    const w = await world();
    const v = (await upload('gino', w)).data.receipt.version;
    const now = await photo('abbie', w);
    expect(now.status).toBe(200);
    expect(now.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(now.headers.get('ETag')).toBe(`"${v}"`);
    const reads = vi.spyOn(kv, 'get');
    const same = await photo('abbie', w, undefined, { 'If-None-Match': `"${v}"` });
    expect(same.status).toBe(304);
    expect(same.bytes.length).toBe(0);
    expect(same.headers.get('ETag')).toBe(`"${v}"`);
    expect(same.headers.get('Cache-Control')).toBe('private, no-cache');
    const pinned = await photo('abbie', w, v, { 'If-None-Match': `W/"${v}"` });
    expect(pinned.status).toBe(304);
    expect(pinned.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(reads).not.toHaveBeenCalled();
    expect((await photo('abbie', w, undefined, { 'If-None-Match': '"something-else"' })).status).toBe(200);
  });

  it('needs a session', async () => {
    const w = await world();
    const v = (await upload('gino', w)).data.receipt.version;
    const r = await call('GET', `${path(w, w.eid)}?v=${v}`);
    expect([r.status, r.data.error.code]).toEqual([401, 'unauthorized']);
  });
});

// ---------- removing ----------

describe('DELETE /api/groups/:gid/expenses/:eid/receipt', () => {
  it('removes the row and the KV object now, bumps the group version, and answers it; with no photo it changes nothing', async () => {
    const w = await world();
    const up = await upload('gino', w);
    const v = up.data.receipt.version;
    const r = await call<{ groupVersion: number }>('DELETE', path(w, w.eid), { as: 'abbie' });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ groupVersion: up.data.groupVersion + 1 });
    expect(rowsOf(w.eid)).toEqual([]);
    expect(kv.map.size).toBe(0);
    expect((await photo('gino', w, v)).status).toBe(404);
    expect((await snapOf('gino', w.gid)).expenses.find(e => e.id === w.eid)!.receipt).toBeNull();
    const again = await call('DELETE', path(w, w.eid), { as: 'gino' });
    expect(again.data).toEqual({ groupVersion: up.data.groupVersion + 1 });
    expect(groupVersion(w.gid)).toBe(up.data.groupVersion + 1);
  });

  it('a KV delete that fails keeps the row (503), so trying again still finds it', async () => {
    const w = await world();
    await upload('gino', w);
    kv.failDeletes = true;
    const r = await call('DELETE', path(w, w.eid), { as: 'gino' });
    expect([r.status, r.data.error.code]).toEqual([503, 'server_error']);
    expect(rowsOf(w.eid)).toHaveLength(1);
    kv.failDeletes = false;
    expect((await call('DELETE', path(w, w.eid), { as: 'gino' })).status).toBe(200);
    expect(rowsOf(w.eid)).toEqual([]);
  });

  it('only for an active member (404 for a stranger)', async () => {
    const w = await world();
    await upload('gino', w);
    expect((await call('DELETE', path(w, w.eid), { as: 'leo' })).status).toBe(404);
    expect(rowsOf(w.eid)).toHaveLength(1);
  });
});

// ---------- the group version and the DTOs ----------

describe('receipt in the expense DTOs and the export', () => {
  it('a change moves the ETag of the group, so cached snapshots pick up the photo, and keeps the summary current', async () => {
    const w = await world();
    const etag = (await call('GET', '/api/groups/' + w.gid, { as: 'abbie' })).headers.get('ETag')!;
    const v = (await upload('gino', w)).data.receipt.version;
    const r = await call<GroupSnapshotDTO>('GET', '/api/groups/' + w.gid, { as: 'abbie', headers: { 'If-None-Match': etag } });
    expect(r.status).toBe(200);
    expect(r.headers.get('ETag')).not.toBe(etag);
    expect(r.data.expenses.find(e => e.id === w.eid)!.receipt).toEqual({ version: v, mime: 'image/jpeg', width: 1200, height: 1600, bytes: JPEG.length });
    const g = db.rows<{ version: number; summary: string }>('SELECT version, summary FROM groups WHERE id = ?', w.gid)[0];
    expect(JSON.parse(g.summary).forVersion).toBe(g.version);
  });

  it('every answer with an expense carries receipt (null without a photo): snapshot, save, delete, restore, the export', async () => {
    const w = await world();
    expect((await snapOf('gino', w.gid)).expenses.every(e => e.receipt === null)).toBe(true);
    const up = (await upload('gino', w)).data.receipt;
    // An edit keeps the photo and says so.
    const edit = await call<{ expense: ExpenseDTO }>('PUT', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'abbie', json: { ...(expenseBody(w.gino, 1500) as object) } });
    expect(edit.status).toBe(200);
    expect(edit.data.expense.receipt).toEqual(up);
    const fresh = await call<{ expense: ExpenseDTO }>('PUT', `/api/groups/${w.gid}/expenses/new-entry-01`, { as: 'gino', json: expenseBody(w.gino) });
    expect(fresh.data.expense.receipt).toBeNull();
    expect((await call<{ expense: ExpenseDTO }>('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'gino' })).data.expense.receipt).toEqual(up);
    expect((await call<{ expense: ExpenseDTO }>('POST', `/api/groups/${w.gid}/expenses/${w.eid}/restore`, { as: 'gino' })).data.expense.receipt).toEqual(up);

    const ex = await call('GET', '/api/me/export', { as: 'abbie' });
    const entries = (ex.data.groups as GroupSnapshotDTO[]).find(g => g.group.id === w.gid)!.expenses;
    expect(entries.find(e => e.id === w.eid)!.receipt).toEqual(up);
    expect(entries.find(e => e.id === 'new-entry-01')!.receipt).toBeNull();
    // Metadata only: the export holds none of the photo's bytes.
    expect(ex.bytes.includes(JPEG.subarray(0, 64))).toBe(false);
    expect(ex.bytes.toString('utf8')).not.toContain(JPEG.toString('base64').slice(0, 40));
  });

  it('deleting an account keeps the photos it uploaded (group content, like its expenses)', async () => {
    const w = await world();
    const v = (await upload('abbie', w)).data.receipt.version;
    expect((await call('DELETE', '/api/me', { as: 'abbie', json: {} })).status).toBe(200);
    expect(rowsOf(w.eid)).toHaveLength(1);
    expect((await photo('gino', w, v)).status).toBe(200);
  });
});

// ---------- the daily cleanup ----------

describe('the daily cleanup of receipt photos', () => {
  it('deletes the photos of entries deleted more than a day ago (KV, then the row), and keeps those still in the undo window', async () => {
    const w = await world();
    await addExpense('gino', w.gid, 'lunch-00001', w.gino);
    await addExpense('gino', w.gid, 'taxi-000001', w.gino);
    const vDinner = (await upload('gino', w)).data.receipt.version;
    const vLunch = (await upload('gino', w, PNG, { type: 'image/png', eid: 'lunch-00001' })).data.receipt.version;
    await upload('gino', w, jpegOf(500), { eid: 'taxi-000001' });
    expect((await call('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'gino' })).status).toBe(200);
    expect((await call('DELETE', `/api/groups/${w.gid}/expenses/lunch-00001`, { as: 'gino' })).status).toBe(200);
    // Lunch was restored within the day: it keeps its photo.
    expect((await call('POST', `/api/groups/${w.gid}/expenses/lunch-00001/restore`, { as: 'gino' })).status).toBe(200);

    // An hour later nothing goes.
    expect(await cleanupReceiptPhotos(env() as never, new Date(Date.now() + 3600_000))).toEqual({ deleted: 0, failed: 0 });
    expect(rowsOf(w.eid)).toHaveLength(1);
    // A day and a minute later the deleted dinner's photo goes; lunch (restored) and the taxi stay.
    const later = new Date(Date.now() + DAY_MS + 60_000);
    expect(await cleanupReceiptPhotos(env() as never, later)).toEqual({ deleted: 1, failed: 0 });
    expect(rowsOf(w.eid)).toEqual([]);
    expect(kv.map.has(receiptKey(w.eid, vDinner))).toBe(false);
    expect(kv.map.has(receiptKey('lunch-00001', vLunch))).toBe(true);
    expect(rowsOf('taxi-000001')).toHaveLength(1);
    // Restoring it now brings the entry back without a photo.
    const back = await call<{ expense: ExpenseDTO }>('POST', `/api/groups/${w.gid}/expenses/${w.eid}/restore`, { as: 'gino' });
    expect(back.data.expense.receipt).toBeNull();
  });

  it('deletes the photos of a deleted group at the next run', async () => {
    const w = await world();
    await upload('gino', w);
    expect((await call('DELETE', '/api/groups/' + w.gid, { as: 'gino' })).status).toBe(200);
    expect(await cleanupReceiptPhotos(env() as never, new Date())).toEqual({ deleted: 1, failed: 0 });
    expect(kv.map.size).toBe(0);
    expect(db.rows('SELECT expense_id FROM receipts')).toEqual([]);
  });

  it('a KV delete that fails keeps its row for the next run; at most RECEIPT_CLEANUP_PER_RUN a run', async () => {
    const w = await world();
    const n = RECEIPT_CLEANUP_PER_RUN + 3;
    for (let i = 0; i < n; i++) {
      const eid = `bulk-${String(i).padStart(4, '0')}`;
      await addExpense('gino', w.gid, eid, w.gino);
      expect((await upload('gino', w, jpegOf(100, i), { eid })).status).toBe(200);
    }
    expect((await call('DELETE', '/api/groups/' + w.gid, { as: 'gino' })).status).toBe(200);
    kv.failDeletes = true;
    expect(await cleanupReceiptPhotos(env() as never, new Date())).toEqual({ deleted: 0, failed: RECEIPT_CLEANUP_PER_RUN });
    expect(db.rows('SELECT expense_id FROM receipts')).toHaveLength(n);
    kv.failDeletes = false;
    expect(await cleanupReceiptPhotos(env() as never, new Date())).toEqual({ deleted: RECEIPT_CLEANUP_PER_RUN, failed: 0 });
    expect(await cleanupReceiptPhotos(env() as never, new Date())).toEqual({ deleted: 3, failed: 0 });
    expect(kv.map.size).toBe(0);
  });

  it('runs as part of runDaily (the 0 9 * * * cron)', async () => {
    const w = await world();
    await upload('gino', w);
    expect((await call('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'gino' })).status).toBe(200);
    // The rates step fetches from the network: keep it offline here (its failure is logged and the run goes on).
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline in tests');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runDaily(env() as never, new Date(Date.now() + 2 * DAY_MS));
    expect(rowsOf(w.eid)).toEqual([]);
    expect(kv.map.size).toBe(0);
    expect(log.mock.calls.map(c => String(c[0]))).toContain('cron receipts: removed 1 receipt photos');
    log.mockRestore();
    err.mockRestore();
  });
});
