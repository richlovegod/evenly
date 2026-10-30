// Receipt photos kept with their expense, up to three (routes/receiptPhotos.ts,
// services/receiptPhotos.ts, migration 0016; docs/SPEC.md section 6, Receipt photos): the
// migration and code from before it on the new schema; adding (PUT .../receipts/:version: the
// version, the body checks, the size limit and the body gate, ?w= and ?h=, who may, a deleted
// entry, the order, the third photo's limit, the per-account limit shared with the legacy route and
// the two whole-app caps) and removing (DELETE .../receipts/:version); the races between them; the
// legacy PUT and DELETE .../receipt with their new meanings on an entry with three photos; fetching
// any photo by ?v= (who may, the cache headers, 304 and a version the entry does not have); the
// group version, `receipt` and `receipts` in every answer that carries an expense and in the
// export; what a rollback leaves; and the daily cleanup with its undo window, per expense. Runs the
// real Worker against the real schema in SQLite (d1-sqlite.ts) with an in-memory KV namespace, and
// https://split.test as the app's origin.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayUTC } from '../../src/shared/dates';
import { RECEIPT_PHOTOS_MAX } from '../../src/shared/receipts';
import type { ExpenseDTO, GroupSnapshotDTO, MeDTO, ReceiptDTO, ReceiptPhotosRes } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import { receiptsOf } from '../../src/worker/db';
import { MAX_BODY_BYTES } from '../../src/worker/http';
import worker from '../../src/worker/index';
import {
  RECEIPT_EXTRAS_MAX_BYTES, RECEIPT_KV_WRITES_PER_DAY, RECEIPT_LEGACY_DELETE_WINDOW_S, RECEIPT_MAX_SIDE, RECEIPT_PHOTO_MAX_BYTES, RECEIPT_PHOTO_PER_DAY,
  RECEIPT_STORE_MAX_BYTES,
} from '../../src/worker/routes/receiptPhotos';
import { runDaily } from '../../src/worker/services/cron';
import { cleanupReceiptPhotos, RECEIPT_CLEANUP_EXPENSES_PER_RUN, receiptKey } from '../../src/worker/services/receiptPhotos';
import { migrationFiles, TestD1, TestStmt } from './d1-sqlite';

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

/**
 * Workers KV as the routes use it: put, get as a stream or bytes, delete; deletes can be made to
 * fail (all, or some keys). `onPut` runs once, right after the next put is stored, so a test can
 * send another request between a route's KV put and its batch.
 */
class FakeKV {
  readonly map = new Map<string, Uint8Array>();
  puts = 0;
  deletes: string[] = [];
  failDeletes = false;
  failDeleteKeys = new Set<string>();
  failPuts: string | null = null;
  onPut: ((key: string) => Promise<void>) | null = null;
  async put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<void> {
    if (this.failPuts) throw new Error(this.failPuts);
    this.puts++;
    const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.map.set(key, new Uint8Array(view));
    const hook = this.onPut;
    this.onPut = null;
    if (hook) await hook(key);
  }
  async get(key: string, type?: string): Promise<unknown> {
    const v = this.map.get(key);
    if (!v) return null;
    if (type === 'stream') return new Response(v.slice()).body;
    return v.slice().buffer;
  }
  async delete(key: string): Promise<void> {
    if (this.failDeletes || this.failDeleteKeys.has(key)) throw new Error('KV delete failed');
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
  call<{ receipt: ReceiptDTO; groupVersion: number; receipts: ReceiptDTO[] }>('PUT', `${path(w, o.eid ?? w.eid)}?w=${o.w ?? 1200}&h=${o.h ?? 1600}`, { as, body: bytes, type: 'image/jpeg', ...o });
const photo = (as: string, w: World, v?: string, headers?: Record<string, string>, eid?: string) =>
  call('GET', path(w, eid ?? w.eid) + (v === undefined ? '' : '?v=' + encodeURIComponent(v)), { as, headers });
const groupVersion = (gid: string): number => db.rows<{ version: number }>('SELECT version FROM groups WHERE id = ?', gid)[0].version;
const rowsOf = (eid: string) => db.rows<{ kv_key: string; version: string; mime: string; bytes: number; width: number; height: number; uploaded_by: string; group_id: string }>('SELECT * FROM receipts WHERE expense_id = ?', eid);
const extrasOf = (eid: string) => db.rows<{ kv_key: string; version: string; mime: string; bytes: number; width: number; height: number; uploaded_by: string; group_id: string; created_at: string }>('SELECT * FROM receipt_extras WHERE expense_id = ? ORDER BY created_at, version', eid);
const snapOf = async (as: string, gid: string) => (await call<GroupSnapshotDTO>('GET', '/api/groups/' + gid, { as })).data;
const NOT_FOUND = { error: { code: 'not_found', message: 'Not found' } };

/** PUT .../receipts/:version (the version from the bytes unless `version` says otherwise). */
const add = (as: string, w: World, bytes: Uint8Array = JPEG, o: Partial<Call> & { w?: string | number; h?: string | number; eid?: string; version?: string } = {}) =>
  call<ReceiptPhotosRes>('PUT', `/api/groups/${w.gid}/expenses/${o.eid ?? w.eid}/receipts/${o.version ?? versionOf(bytes)}?w=${o.w ?? 1200}&h=${o.h ?? 1600}`, {
    as, body: bytes, type: 'image/jpeg', ...o,
  });
/** DELETE .../receipts/:version. */
const drop = (as: string, w: World, version: string, eid?: string) => call<ReceiptPhotosRes>('DELETE', `/api/groups/${w.gid}/expenses/${eid ?? w.eid}/receipts/${version}`, { as });
/** Three different photos, each a JPEG of its own bytes. */
const P1 = jpegOf(300, 1);
const P2 = jpegOf(310, 2);
const P3 = jpegOf(320, 3);
const P4 = jpegOf(330, 4);
const [V1, V2, V3, V4] = [P1, P2, P3, P4].map(versionOf);
/** The entry with three photos, added in order with the new route. */
async function threePhotos(w: World, eid = w.eid): Promise<ReceiptPhotosRes> {
  let last: ReceiptPhotosRes | null = null;
  for (const [i, p] of [P1, P2, P3].entries()) {
    const r = await add('gino', w, p, { eid, w: 1000 + i, h: 1500 + i });
    expect(r.status).toBe(200);
    last = r.data;
  }
  return last!;
}
const versions = (list: readonly ReceiptDTO[] | undefined) => (list ?? []).map(p => p.version);
const entryIn = (snap: GroupSnapshotDTO, eid: string) => snap.expenses.find(e => e.id === eid)!;
/** A photo row written straight into one table (the state an older Worker or a rollback leaves). */
function seedPhoto(table: 'receipts' | 'receipt_extras', w: World, eid: string, bytes: Uint8Array, createdAt: string): string {
  const v = versionOf(bytes);
  db.exec(
    `INSERT INTO ${table} (expense_id, group_id, kv_key, version, mime, bytes, width, height, uploaded_by, created_at) VALUES (?, ?, ?, ?, 'image/jpeg', ?, 10, 20, 'gino', ?)`,
    eid, w.gid, receiptKey(eid, v), v, bytes.length, createdAt,
  );
  kv.map.set(receiptKey(eid, v), new Uint8Array(bytes));
  return v;
}

beforeEach(() => {
  db = new TestD1();
  kv = new FakeKV();
  vars = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Spies on TestStmt.prototype and on the database outlive a test otherwise.
  vi.restoreAllMocks();
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
    const receipt = { version: v, mime: 'image/jpeg', width: 1200, height: 1600, bytes: JPEG.length };
    expect(r.data).toEqual({ receipt, groupVersion: before + 1, receipts: [receipt] });
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

  it('refuses a photo that would take the stored total past 800,000,000 bytes: 503 receipts_full', async () => {
    const w = await world();
    expect(RECEIPT_STORE_MAX_BYTES).toBe(800_000_000);
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

  it('wrangler.toml keeps both environments inside the KV that Workers Paid includes for the whole account', () => {
    const toml: Record<string, Record<string, string>> = { vars: {}, 'env.staging.vars': {} };
    let table = '';
    for (const raw of readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      const header = /^\[{1,2}([^\]]+)\]{1,2}$/.exec(line);
      if (header) table = header[1].trim();
      const m = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
      if (m && toml[table]) toml[table][m[1]] = m[2];
    }
    // A table without the var gets the code's default.
    const bytes = (t: string) => Number(toml[t].RECEIPT_STORE_MAX_BYTES ?? RECEIPT_STORE_MAX_BYTES);
    const writes = (t: string) => Number(toml[t].RECEIPT_KV_WRITES_PER_DAY ?? RECEIPT_KV_WRITES_PER_DAY);
    expect([bytes('vars'), bytes('env.staging.vars')]).toEqual([800_000_000, 30_000_000]);
    expect([writes('vars'), writes('env.staging.vars')]).toEqual([500, 60]);
    // 1 GB stored: at least 150 MB left for the other Workers' namespaces and objects whose delete failed.
    expect(bytes('vars') + bytes('env.staging.vars')).toBeLessThanOrEqual(1_000_000_000 - 150_000_000);
    // 1,000,000 writes a month: a 31-day month at both caps is under 2% of it.
    expect((writes('vars') + writes('env.staging.vars')) * 31).toBeLessThan(20_000);
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
    // iPhone 1.0 reads it as {groupVersion}; receipt and receipts are new.
    expect(r.data).toEqual({ groupVersion: up.data.groupVersion + 1, receipt: null, receipts: [] });
    expect(rowsOf(w.eid)).toEqual([]);
    expect(kv.map.size).toBe(0);
    expect((await photo('gino', w, v)).status).toBe(404);
    expect((await snapOf('gino', w.gid)).expenses.find(e => e.id === w.eid)!.receipt).toBeNull();
    const again = await call('DELETE', path(w, w.eid), { as: 'gino' });
    expect(again.data).toEqual({ groupVersion: up.data.groupVersion + 1, receipt: null, receipts: [] });
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

  it('a KV delete that fails keeps its row for the next run; at most RECEIPT_CLEANUP_EXPENSES_PER_RUN expenses a run', async () => {
    const w = await world();
    const n = RECEIPT_CLEANUP_EXPENSES_PER_RUN + 3;
    for (let i = 0; i < n; i++) {
      const eid = `bulk-${String(i).padStart(4, '0')}`;
      await addExpense('gino', w.gid, eid, w.gino);
      expect((await upload('gino', w, jpegOf(100, i), { eid })).status).toBe(200);
    }
    expect((await call('DELETE', '/api/groups/' + w.gid, { as: 'gino' })).status).toBe(200);
    kv.failDeletes = true;
    expect(await cleanupReceiptPhotos(env() as never, new Date())).toEqual({ deleted: 0, failed: RECEIPT_CLEANUP_EXPENSES_PER_RUN });
    expect(db.rows('SELECT expense_id FROM receipts')).toHaveLength(n);
    kv.failDeletes = false;
    expect(await cleanupReceiptPhotos(env() as never, new Date())).toEqual({ deleted: RECEIPT_CLEANUP_EXPENSES_PER_RUN, failed: 0 });
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

// ======================================================================================
// Up to three photos (migration 0016)
// ======================================================================================

/**
 * Code from before migration 0016 (6164f11), as it still runs between `migrations apply` and
 * `wrangler deploy`, and after a rollback: its upsert of the one photo, its snapshot query, its
 * DELETE and the cleanup's DUE_SQL.
 */
const OLD = {
  upsert: `INSERT INTO receipts (expense_id, group_id, kv_key, version, mime, bytes, width, height, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(expense_id) DO UPDATE SET kv_key = excluded.kv_key, version = excluded.version, mime = excluded.mime,
             bytes = excluded.bytes, width = excluded.width, height = excluded.height, uploaded_by = excluded.uploaded_by,
             created_at = excluded.created_at`,
  snapshot: `SELECT e.*, r.version AS r_version, r.mime AS r_mime, r.width AS r_width, r.height AS r_height, r.bytes AS r_bytes FROM expenses e LEFT JOIN receipts r ON r.expense_id = e.id
       WHERE e.group_id = ? ORDER BY e.date DESC, e.created_at DESC`,
  del: 'DELETE FROM receipts WHERE expense_id = ? AND kv_key = ?',
  due: `SELECT r.expense_id, r.kv_key FROM receipts r
  JOIN expenses e ON e.id = r.expense_id
  JOIN groups g ON g.id = r.group_id
  WHERE g.deleted_at IS NOT NULL OR (e.deleted_at IS NOT NULL AND e.deleted_at < ?1)
  ORDER BY COALESCE(g.deleted_at, e.deleted_at)
  LIMIT ?2`,
};

describe('migration 0016 and the code from before it', () => {
  it('applies after 0015, additive: receipt_extras with its columns, its primary key and the group index; rows already there are untouched', () => {
    const files = migrationFiles();
    expect(files.slice(-2)).toEqual(['0015_sign_in_review.sql', '0016_receipt_extras.sql']);
    // The schema up to 0015 with a photo in it, then 0016.
    const s = new DatabaseSync(':memory:');
    s.exec('PRAGMA foreign_keys = ON');
    for (const f of files.slice(0, -1)) s.exec(readFileSync(new URL('../../migrations/' + f, import.meta.url), 'utf8'));
    const at = new Date().toISOString();
    s.prepare("INSERT INTO users (id, name, color, created_at, updated_at) VALUES ('u', 'U', '#000', ?, ?)").run(at, at);
    s.prepare("INSERT INTO groups (id, name, type, currency, invite_code, created_by, created_at, updated_at) VALUES ('g', 'G', 'trip', 'JPY', 'code', 'u', ?, ?)").run(at, at);
    s.prepare(
      `INSERT INTO expenses (id, group_id, kind, description, category, amount, currency, fx_rate, date, notes, payers, split, shares, repeat, created_by, created_at, updated_by, updated_at, version)
       VALUES ('e', 'g', 'expense', 'x', 'general', 1, 'JPY', 1, '2026-10-30', '', '[]', '{}', '[]', 'none', 'u', ?, 'u', ?, 1)`,
    ).run(at, at);
    s.prepare("INSERT INTO receipts (expense_id, group_id, kv_key, version, mime, bytes, width, height, uploaded_by, created_at) VALUES ('e', 'g', 'receipt:e:v', 'v', 'image/jpeg', 9, 1, 2, 'u', ?)").run(at);
    const before = s.prepare('SELECT * FROM receipts').all();
    s.exec(readFileSync(new URL('../../migrations/0016_receipt_extras.sql', import.meta.url), 'utf8'));
    expect(s.prepare('SELECT * FROM receipts').all()).toEqual(before);
    const cols = s.prepare('PRAGMA table_info(receipt_extras)').all() as { name: string; notnull: number; pk: number }[];
    expect(cols.map(c => c.name)).toEqual(['expense_id', 'version', 'group_id', 'kv_key', 'mime', 'bytes', 'width', 'height', 'uploaded_by', 'created_at']);
    expect(cols.filter(c => c.pk).map(c => c.name)).toEqual(['expense_id', 'version']);
    expect(cols.filter(c => !c.notnull).map(c => c.name)).toEqual(['uploaded_by']);
    const idx = s.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'receipt_extras' AND sql IS NOT NULL").all() as { name: string; sql: string }[];
    expect(idx.map(i => i.name)).toEqual(['idx_receipt_extras_group']);
    // receipts and every other table keep their columns.
    expect((s.prepare('PRAGMA table_info(receipts)').all() as { name: string }[]).map(c => c.name)).toEqual(['expense_id', 'group_id', 'kv_key', 'version', 'mime', 'bytes', 'width', 'height', 'uploaded_by', 'created_at']);
    // Deleting the expense for good takes its extras with it (no orphans).
    s.prepare("INSERT INTO receipt_extras (expense_id, version, group_id, kv_key, mime, bytes, width, height, uploaded_by, created_at) VALUES ('e', 'w', 'g', 'receipt:e:w', 'image/jpeg', 9, 1, 2, 'u', ?)").run(at);
    s.prepare("DELETE FROM expenses WHERE id = 'e'").run();
    expect(s.prepare('SELECT * FROM receipt_extras').all()).toEqual([]);
  });

  it('the old upsert on an entry with three photos replaces its first and leaves the other two alone; the old snapshot query lists it once', async () => {
    const w = await world();
    await threePhotos(w);
    const at = new Date().toISOString();
    db.exec(OLD.upsert, w.eid, w.gid, receiptKey(w.eid, V4), V4, 'image/jpeg', P4.length, 1, 1, 'abbie', at);
    expect(rowsOf(w.eid).map(r => r.version)).toEqual([V4]);
    expect(extrasOf(w.eid).map(r => r.version)).toEqual([V2, V3]);
    const old = db.rows<{ id: string; r_version: string }>(OLD.snapshot, w.gid).filter(r => r.id === w.eid);
    expect(old).toEqual([expect.objectContaining({ id: w.eid, r_version: V4 })]);
    // The new code reads it as the old code wrote it: the new first photo, then the other two.
    expect(versions(entryIn(await snapOf('gino', w.gid), w.eid).receipts)).toEqual([V4, V2, V3]);
  });

  it('the old DELETE and the old cleanup query touch only receipts', async () => {
    const w = await world();
    await threePhotos(w);
    db.exec(OLD.del, w.eid, receiptKey(w.eid, V1));
    expect(rowsOf(w.eid)).toEqual([]);
    expect(extrasOf(w.eid).map(r => r.version)).toEqual([V2, V3]);
    expect((await call('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'gino' })).status).toBe(200);
    const due = db.rows<{ expense_id: string; kv_key: string }>(OLD.due, new Date(Date.now() + 2 * DAY_MS).toISOString(), 25);
    // Only rows of receipts: the extras stay (not shown, not purged by old code).
    expect(due).toEqual([]);
  });
});

describe('PUT /api/groups/:gid/expenses/:eid/receipts/:version', () => {
  it('the first photo goes to receipts, the second and third to receipt_extras in order, each answer the whole list', async () => {
    const w = await world();
    const before = groupVersion(w.gid);
    const activity = db.rows('SELECT id FROM activity').length;
    const one = await add('abbie', w, P1, { w: 1200, h: 1600 });
    expect(one.status).toBe(200);
    const p1 = { version: V1, mime: 'image/jpeg', width: 1200, height: 1600, bytes: P1.length };
    expect(one.data).toEqual({ receipt: p1, receipts: [p1], groupVersion: before + 1 });
    expect(one.headers.get('Vary')).toBe('*');
    expect(one.headers.get('Cache-Control')).toBe('no-store');
    expect(rowsOf(w.eid)).toEqual([expect.objectContaining({ version: V1, kv_key: receiptKey(w.eid, V1), uploaded_by: 'abbie', group_id: w.gid })]);
    const two = await add('gino', w, P2, { w: 800, h: 600 });
    const p2 = { version: V2, mime: 'image/jpeg', width: 800, height: 600, bytes: P2.length };
    expect(two.data).toEqual({ receipt: p1, receipts: [p1, p2], groupVersion: before + 2 });
    const three = await add('gino', w, P3, { type: 'image/jpeg' });
    expect(versions(three.data.receipts)).toEqual([V1, V2, V3]);
    expect(three.data.receipt).toEqual(p1);
    expect(extrasOf(w.eid)).toEqual([
      expect.objectContaining({ version: V2, kv_key: receiptKey(w.eid, V2), width: 800, height: 600, uploaded_by: 'gino', group_id: w.gid }),
      expect.objectContaining({ version: V3, kv_key: receiptKey(w.eid, V3) }),
    ]);
    expect([...kv.map.keys()].sort()).toEqual([V1, V2, V3].map(v => receiptKey(w.eid, v)).sort());
    expect(Buffer.from(kv.map.get(receiptKey(w.eid, V2))!).equals(Buffer.from(P2))).toBe(true);
    // No activity row and no push; the entry's own version stays.
    expect(db.rows('SELECT id FROM activity')).toHaveLength(activity);
    expect(db.rows<{ version: number }>('SELECT version FROM expenses WHERE id = ?', w.eid)[0].version).toBe(1);
    // A PNG is taken too.
    const w2 = { ...w, eid: 'png-entry-01' };
    await addExpense('gino', w.gid, w2.eid, w.gino);
    const png = await add('gino', w2, PNG, { type: 'image/png', w: 2, h: 2 });
    expect(png.data.receipt).toEqual({ version: '6acadc78bbbfc36f', mime: 'image/png', width: 2, height: 2, bytes: PNG.length });
  });

  it('a new photo goes last, also when it is added in the same millisecond as the one before (no position is stored)', async () => {
    const w = await world();
    // Three photos whose versions sort the other way round from the order they are added in.
    const pool = Array.from({ length: 40 }, (_, i) => jpegOf(200 + i, 11));
    const byVersion = [...pool].sort((a, b) => (versionOf(a) < versionOf(b) ? 1 : -1));
    const [a, b, c] = [byVersion[0], byVersion[1], byVersion[2]];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T10:00:00.000Z'));
    try {
      for (const p of [a, b, c]) expect((await add('gino', w, p)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    expect(versions(entryIn(await snapOf('gino', w.gid), w.eid).receipts)).toEqual([a, b, c].map(versionOf));
    expect(extrasOf(w.eid).map(x => x.created_at)).toEqual(['2026-10-30T10:00:00.000Z', '2026-10-30T10:00:00.001Z']);
  });

  it('the version is the first 16 hex characters of the SHA-256 of the bytes: the contract\'s test vectors', async () => {
    expect(versionOf(JPEG)).toBe('938a494efb687c77');
    expect(JPEG.length).toBe(269);
    expect(JPEG.toString('base64').startsWith('/9j/2wBDAAUDBAQEAwUE')).toBe(true);
    expect(versionOf(PNG)).toBe('6acadc78bbbfc36f');
    expect(PNG.length).toBe(95);
    const w = await world();
    expect((await add('gino', w, JPEG, { version: '938a494efb687c77' })).status).toBe(200);
  });

  it('the same bytes again, in any place: 200 with the list, and no KV put, no count and no version bump', async () => {
    const w = await world();
    await threePhotos(w);
    const puts = kv.puts;
    const version = groupVersion(w.gid);
    const count = db.rows<{ count: number }>("SELECT count FROM rate_limits WHERE key LIKE 'receipt-photo:user:gino:%'")[0].count;
    for (const p of [P1, P2, P3]) {
      const r = await add('gino', w, p);
      expect(r.status).toBe(200);
      expect(versions(r.data.receipts)).toEqual([V1, V2, V3]);
      expect(r.data.groupVersion).toBe(version);
    }
    expect(kv.puts).toBe(puts);
    expect(groupVersion(w.gid)).toBe(version);
    expect(db.rows<{ count: number }>("SELECT count FROM rate_limits WHERE key LIKE 'receipt-photo:user:gino:%'")[0].count).toBe(count);
  });

  it('a fourth photo: 409 limit_reached with {limit, max, receipts}, and nothing written or counted', async () => {
    const w = await world();
    await threePhotos(w);
    const puts = kv.puts;
    const version = groupVersion(w.gid);
    const count = db.rows<{ count: number }>("SELECT count FROM rate_limits WHERE key LIKE 'receipt-photo:user:gino:%'")[0].count;
    const r = await add('gino', w, P4);
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('limit_reached');
    expect(r.data.error.message).toBe('An expense keeps up to 3 receipt photos');
    expect(r.data.error.details).toEqual({ limit: 'receipt_photos', max: 3, receipts: entryIn(await snapOf('gino', w.gid), w.eid).receipts });
    expect(versions(r.data.error.details.receipts)).toEqual([V1, V2, V3]);
    expect([kv.puts, groupVersion(w.gid)]).toEqual([puts, version]);
    expect(db.rows<{ count: number }>("SELECT count FROM rate_limits WHERE key LIKE 'receipt-photo:user:gino:%'")[0].count).toBe(count);
    expect(kv.map.has(receiptKey(w.eid, V4))).toBe(false);
  });

  it('a version that is not 16 lowercase hex characters, or not the SHA-256 of the bytes: 400 bad_request with fields [version]', async () => {
    const w = await world();
    for (const version of ['938A494EFB687C77', '938a494efb687c7', '938a494efb687c77a', 'zzzzzzzzzzzzzzzz', '938a494efb687c7g']) {
      const r = await add('gino', w, JPEG, { version });
      expect([version, r.status, r.data.error.code, r.data.error.details]).toEqual([version, 400, 'bad_request', { fields: ['version'] }]);
    }
    const wrong = await add('gino', w, JPEG, { version: V2 });
    expect([wrong.status, wrong.data.error.details, wrong.data.error.message]).toEqual([400, { fields: ['version'] }, 'The version is not the SHA-256 of the photo']);
    // The form is checked first, before the sides.
    expect((await add('gino', w, JPEG, { version: 'nope', w: 0 })).data.error.details).toEqual({ fields: ['version'] });
    expect(kv.puts).toBe(0);
    expect(db.rows("SELECT key FROM rate_limits WHERE key LIKE 'receipt-photo:%'")).toEqual([]);
  });

  it('w and h, the Content-Type and the bytes are checked as on the legacy route', async () => {
    const w = await world();
    for (const [name, wv, hv] of [['w', '', 10], ['w', 0, 10], ['w', RECEIPT_MAX_SIDE + 1, 10], ['w', '1.5', 10], ['h', 10, 'x'], ['h', 10, 99999]] as const) {
      const r = await add('gino', w, JPEG, { w: wv, h: hv });
      expect([name, r.status, r.data.error.details]).toEqual([name, 400, { fields: [name] }]);
    }
    const cases: [string, Partial<Call>][] = [
      ['PNG bytes called a JPEG', { body: PNG, type: 'image/jpeg', version: versionOf(PNG) }],
      ['JPEG bytes called a PNG', { type: 'image/png' }],
      ['a GIF', { type: 'image/gif' }],
      ['no Content-Type', { type: undefined }],
      ['an empty body', { body: new Uint8Array(0), version: versionOf(new Uint8Array(0)) }],
    ];
    for (const [what, o] of cases) {
      const r = await add('gino', w, JPEG, o as never);
      expect([what, r.status, r.data?.error?.code, r.data?.error?.details]).toEqual([what, 400, 'bad_request', { fields: ['body'] }]);
    }
    expect(kv.puts).toBe(0);
  });

  it('takes 600,000 bytes past the 256 KB gate and refuses 600,001 with 413, with or without a Content-Length', async () => {
    const w = await world();
    const most = jpegOf(RECEIPT_PHOTO_MAX_BYTES, 9);
    expect(most.length).toBeGreaterThan(MAX_BODY_BYTES);
    const ok = await add('gino', w, most);
    expect(ok.status).toBe(200);
    expect(ok.data.receipt!.bytes).toBe(RECEIPT_PHOTO_MAX_BYTES);
    const over = jpegOf(RECEIPT_PHOTO_MAX_BYTES + 1, 9);
    for (const length of [true, false]) {
      const r = await add('gino', w, over, { length });
      expect([length, r.status, r.data.error.code]).toEqual([length, 413, 'payload_too_large']);
    }
    // A chunked body under the limit goes through.
    expect((await add('gino', w, P2, { length: false })).status).toBe(200);
    expect(kv.puts).toBe(2);
  });

  it('a deleted entry: 404 and nothing stored; a stranger, someone who left and a deleted group: 404', async () => {
    const w = await world();
    await add('gino', w, P1);
    expect((await call('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'gino' })).status).toBe(200);
    const puts = kv.puts;
    expect((await add('gino', w, P2)).status).toBe(404);
    expect(kv.puts).toBe(puts);
    expect(extrasOf(w.eid)).toEqual([]);
    expect((await call('POST', `/api/groups/${w.gid}/expenses/${w.eid}/restore`, { as: 'gino' })).status).toBe(200);
    expect((await add('leo', w, P2)).status).toBe(404);
    expect((await add('gino', w, P2, { eid: 'nothing-here' })).status).toBe(404);
    expect((await call('DELETE', `/api/groups/${w.gid}/members/${w.abbie}`, { as: 'abbie' })).status).toBe(200);
    expect((await add('abbie', w, P2)).status).toBe(404);
    expect((await call('DELETE', '/api/groups/' + w.gid, { as: 'gino' })).status).toBe(200);
    expect((await add('gino', w, P2)).status).toBe(404);
    expect(kv.puts).toBe(puts);
    expect((await call('PUT', `/api/groups/${w.gid}/expenses/${w.eid}/receipts/${V2}?w=1&h=1`, { body: P2, type: 'image/jpeg' })).status).toBe(401);
  });

  it('the 40 uploads a day count new and legacy uploads together', async () => {
    const w = await world();
    db.exec('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)', `receipt-photo:user:gino:${TODAY}`, RECEIPT_PHOTO_PER_DAY - 2, Date.now() + DAY_MS);
    expect((await upload('gino', w, P1)).status).toBe(200);
    expect((await add('gino', w, P2)).status).toBe(200);
    const r = await add('gino', w, P3);
    expect([r.status, r.data.error.code, r.data.error.details.scope]).toEqual([429, 'rate_limited', 'user']);
    expect(Number(r.headers.get('Retry-After'))).toBe(r.data.error.details.retryAfter);
    expect((await upload('gino', w, P4)).status).toBe(429);
    expect((await add('abbie', w, P3)).status).toBe(200);
  });

  it('receipts_full counts the bytes of both tables; receipts_quota after the app\'s KV writes; a failed KV put stores nothing', async () => {
    const w = await world();
    await addExpense('gino', w.gid, 'big-one-0001', w.gino);
    seedPhoto('receipts', w, 'big-one-0001', jpegOf(10, 7), new Date().toISOString());
    db.exec(
      `INSERT INTO receipt_extras (expense_id, version, group_id, kv_key, mime, bytes, width, height, uploaded_by, created_at) VALUES ('big-one-0001', 'x', ?, 'receipt:big-one-0001:x', 'image/jpeg', ?, 1, 1, 'gino', ?)`,
      w.gid, RECEIPT_STORE_MAX_BYTES - 10 - P1.length, new Date().toISOString(),
    );
    expect((await add('gino', w, P1)).status).toBe(200);
    const full = await add('gino', w, P2);
    expect([full.status, full.data.error.code]).toEqual([503, 'receipts_full']);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(false);
    db.exec("DELETE FROM receipt_extras WHERE version = 'x'");

    db.exec('INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)', `receipt-photo:kv:${TODAY}`, RECEIPT_KV_WRITES_PER_DAY, Date.now() + DAY_MS);
    const quota = await add('gino', w, P2);
    expect([quota.status, quota.data.error.code]).toEqual([503, 'receipts_quota']);
    expect(Number(quota.headers.get('Retry-After'))).toBe(quota.data.error.details.retryAfter);
    db.exec('DELETE FROM rate_limits WHERE key = ?', `receipt-photo:kv:${TODAY}`);

    kv.failPuts = 'KV PUT failed: 429 Too Many Requests';
    expect((await add('gino', w, P2)).data.error.code).toBe('receipts_quota');
    kv.failPuts = 'network connection lost';
    expect((await add('gino', w, P2)).data.error.code).toBe('server_error');
    kv.failPuts = null;
    expect(extrasOf(w.eid)).toEqual([]);
    expect(versions(entryIn(await snapOf('gino', w.gid), w.eid).receipts)).toEqual([V1]);
  });

  it('without the RECEIPTS binding: 503', async () => {
    const w = await world();
    (kv as unknown) = undefined;
    expect((await add('gino', w)).status).toBe(503);
    expect((await drop('gino', w, V1)).status).toBe(503);
  });
});

describe('races between photo writes', () => {
  it('two adds for the last place: one 200 and one 409, and the loser\'s object is deleted', async () => {
    const w = await world();
    await add('gino', w, P1);
    await add('gino', w, P2);
    let other: Res<ReceiptPhotosRes> | null = null;
    kv.onPut = async () => {
      other = await add('abbie', w, P4);
    };
    const r = await add('gino', w, P3);
    expect(other!.status).toBe(200);
    expect([r.status, r.data.error.code]).toEqual([409, 'limit_reached']);
    expect(versions(r.data.error.details.receipts)).toEqual([V1, V2, V4]);
    expect(kv.map.has(receiptKey(w.eid, V3))).toBe(false);
    expect(kv.map.has(receiptKey(w.eid, V4))).toBe(true);
    expect(extrasOf(w.eid).map(x => x.version)).toEqual([V2, V4]);
  });

  it('two identical adds: one row and one object, both 200', async () => {
    const w = await world();
    await add('gino', w, P1);
    let other: Res<ReceiptPhotosRes> | null = null;
    kv.onPut = async () => {
      other = await add('abbie', w, P2);
    };
    const r = await add('gino', w, P2);
    expect([r.status, other!.status]).toEqual([200, 200]);
    expect(versions(r.data.receipts)).toEqual([V1, V2]);
    expect(extrasOf(w.eid).map(x => x.version)).toEqual([V2]);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(true);
  });

  it('an add while the entry is being deleted: 404, and no object is left', async () => {
    const w = await world();
    await add('gino', w, P1);
    kv.onPut = async () => {
      expect((await call('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'abbie' })).status).toBe(200);
    };
    const r = await add('gino', w, P2);
    expect(r.status).toBe(404);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(false);
    expect(extrasOf(w.eid)).toEqual([]);
    // The photo it had stays for 復原.
    expect(kv.map.has(receiptKey(w.eid, V1))).toBe(true);
  });

  it('the first photo while the entry has none: two adds at once give one first photo and one second', async () => {
    const w = await world();
    let other: Res<ReceiptPhotosRes> | null = null;
    kv.onPut = async () => {
      other = await add('abbie', w, P2);
    };
    const r = await add('gino', w, P1);
    expect([r.status, other!.status]).toEqual([200, 200]);
    expect(versions(r.data.receipts)).toEqual([V2, V1]);
    expect(rowsOf(w.eid).map(x => x.version)).toEqual([V2]);
    expect(extrasOf(w.eid).map(x => x.version)).toEqual([V1]);
  });

  it('two legacy PUTs at once: no object is left without a row', async () => {
    const w = await world();
    await threePhotos(w);
    kv.onPut = async () => {
      expect((await upload('abbie', w, jpegOf(400, 8))).status).toBe(200);
    };
    const r = await upload('gino', w, jpegOf(410, 9));
    expect(r.status).toBe(200);
    const named = [...rowsOf(w.eid), ...extrasOf(w.eid)].map(x => x.kv_key).sort();
    expect([...kv.map.keys()].sort()).toEqual(named);
    expect(versions(r.data.receipts)).toEqual([versionOf(jpegOf(410, 9)), V2, V3]);
  });

  it('a batch that fails during an identical add at the same time does not delete the object the other row names', async () => {
    const w = await world();
    await add('gino', w, P1);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The next write batch (more statements than the two reads of entryFor) fails.
    const real = db.batch.bind(db);
    let failNext = false;
    vi.spyOn(db, 'batch').mockImplementation(async stmts => {
      if (failNext && stmts.length > 2) {
        failNext = false;
        throw new Error('D1_ERROR: network connection lost');
      }
      return real(stmts);
    });
    kv.onPut = async () => {
      expect((await add('abbie', w, P2)).status).toBe(200);
      failNext = true;
    };
    const r = await add('gino', w, P2);
    expect([r.status, r.data.error.code]).toEqual([503, 'server_error']);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(true);
    expect(extrasOf(w.eid).map(x => x.version)).toEqual([V2]);
    // Alone, a failed batch takes its new object out again.
    failNext = true;
    expect((await add('gino', w, P3)).status).toBe(503);
    expect(kv.map.has(receiptKey(w.eid, V3))).toBe(false);
    expect(versions(entryIn(await snapOf('gino', w.gid), w.eid).receipts)).toEqual([V1, V2]);
  });
});

describe('DELETE /api/groups/:gid/expenses/:eid/receipts/:version', () => {
  it('takes the photo off now (KV, then the row), and the others keep their order', async () => {
    const w = await world();
    const three = await threePhotos(w);
    const r = await drop('abbie', w, V2);
    expect(r.status).toBe(200);
    expect(versions(r.data.receipts)).toEqual([V1, V3]);
    expect(r.data.receipt).toEqual(three.receipts[0]);
    expect(r.data.groupVersion).toBe(three.groupVersion + 1);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(false);
    expect(kv.deletes).toEqual([receiptKey(w.eid, V2)]);
    expect(versions(entryIn(await snapOf('gino', w.gid), w.eid).receipts)).toEqual([V1, V3]);
    expect((await photo('gino', w, V2)).status).toBe(404);
  });

  it('removing the first promotes the earliest other photo, and receipt is receipts[0]', async () => {
    const w = await world();
    await threePhotos(w);
    const r = await drop('gino', w, V1);
    expect(versions(r.data.receipts)).toEqual([V2, V3]);
    expect(r.data.receipt).toEqual(r.data.receipts[0]);
    expect(rowsOf(w.eid).map(x => x.version)).toEqual([V2]);
    expect(extrasOf(w.eid).map(x => x.version)).toEqual([V3]);
    // Its object stays: the first photo uses it now.
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(true);
    const last = await drop('gino', w, V3);
    expect(versions(last.data.receipts)).toEqual([V2]);
    const none = await drop('gino', w, V2);
    expect(none.data).toEqual({ receipt: null, receipts: [], groupVersion: groupVersion(w.gid) });
    expect(kv.map.size).toBe(0);
  });

  it('a version the entry does not have: 200 with the list, nothing changes', async () => {
    const w = await world();
    const three = await threePhotos(w);
    const r = await drop('gino', w, V4);
    expect(r.status).toBe(200);
    expect(r.data).toEqual(three);
    expect(kv.deletes).toEqual([]);
    expect((await drop('gino', w, 'NOT-A-VERSION')).data.error.details).toEqual({ fields: ['version'] });
  });

  it('a KV delete that fails: 503, and the rows are unchanged', async () => {
    const w = await world();
    await threePhotos(w);
    kv.failDeletes = true;
    const r = await drop('gino', w, V2);
    expect([r.status, r.data.error.code]).toEqual([503, 'server_error']);
    expect(extrasOf(w.eid).map(x => x.version)).toEqual([V2, V3]);
  });

  it('works on a deleted entry (its page shows its photos until the purge); a stranger gets 404', async () => {
    const w = await world();
    await threePhotos(w);
    expect((await call('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'gino' })).status).toBe(200);
    expect((await drop('leo', w, V3)).status).toBe(404);
    const r = await drop('abbie', w, V3);
    expect(versions(r.data.receipts)).toEqual([V1, V2]);
  });
});

describe('the legacy routes on an entry with three photos', () => {
  it('PUT .../receipt replaces only the first photo: its object goes, photos 2 and 3 stay in order, never 409', async () => {
    const w = await world();
    const three = await threePhotos(w);
    const r = await upload('abbie', w, P4, { w: 640, h: 480 });
    expect(r.status).toBe(200);
    const p4 = { version: V4, mime: 'image/jpeg', width: 640, height: 480, bytes: P4.length };
    expect(r.data).toEqual({ receipt: p4, groupVersion: three.groupVersion + 1, receipts: [p4, three.receipts[1], three.receipts[2]] });
    // Exactly the five fields iPhone 1.0 decodes.
    expect(Object.keys(r.data.receipt).sort()).toEqual(['bytes', 'height', 'mime', 'version', 'width']);
    expect(kv.map.has(receiptKey(w.eid, V1))).toBe(false);
    expect(kv.map.has(receiptKey(w.eid, V4))).toBe(true);
    expect(rowsOf(w.eid).map(x => x.version)).toEqual([V4]);
    expect(extrasOf(w.eid).map(x => x.version)).toEqual([V2, V3]);
  });

  it('PUT with photo 2\'s bytes moves it up with no KV put and takes the old first off', async () => {
    const w = await world();
    await threePhotos(w);
    const puts = kv.puts;
    const kvDay = () => db.rows<{ count: number }>('SELECT count FROM rate_limits WHERE key = ?', `receipt-photo:kv:${TODAY}`)[0].count;
    const writes = kvDay();
    const r = await upload('gino', w, P2);
    expect(r.status).toBe(200);
    expect(versions(r.data.receipts)).toEqual([V2, V3]);
    expect(r.data.receipt).toEqual(r.data.receipts[0]);
    expect([kv.puts, kvDay()]).toEqual([puts, writes]);
    expect(kv.map.has(receiptKey(w.eid, V1))).toBe(false);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(true);
    expect(rowsOf(w.eid).map(x => x.version)).toEqual([V2]);
    expect(extrasOf(w.eid).map(x => x.version)).toEqual([V3]);
  });

  it('PUT with the first photo\'s bytes writes nothing (the upload is still counted, as before)', async () => {
    const w = await world();
    const three = await threePhotos(w);
    const count = () => db.rows<{ count: number }>('SELECT count FROM rate_limits WHERE key = ?', `receipt-photo:user:gino:${TODAY}`)[0].count;
    const before = count();
    const r = await upload('gino', w, P1);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ receipt: three.receipts[0], groupVersion: three.groupVersion, receipts: three.receipts });
    expect(count()).toBe(before + 1);
    expect(groupVersion(w.gid)).toBe(three.groupVersion);
  });

  it('DELETE .../receipt removes only the first photo; the next becomes first, and the answer says so', async () => {
    const w = await world();
    const three = await threePhotos(w);
    const r = await call('DELETE', path(w, w.eid), { as: 'abbie' });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ groupVersion: three.groupVersion + 1, receipt: three.receipts[1], receipts: [three.receipts[1], three.receipts[2]] });
    expect(kv.map.has(receiptKey(w.eid, V1))).toBe(false);
    expect(rowsOf(w.eid).map(x => x.version)).toEqual([V2]);
    expect(versions(entryIn(await snapOf('gino', w.gid), w.eid).receipts)).toEqual([V2, V3]);
  });
});

describe('GET .../receipt?v= with three photos', () => {
  it('each version answers its own bytes with the year-long headers, and 304 before a KV read; without v, the first photo', async () => {
    const w = await world();
    await threePhotos(w);
    for (const [v, bytes] of [[V1, P1], [V2, P2], [V3, P3]] as const) {
      const r = await photo('abbie', w, v);
      expect([v, r.status]).toEqual([v, 200]);
      expect(Buffer.from(r.bytes).equals(Buffer.from(bytes))).toBe(true);
      expect(r.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
      expect(r.headers.get('ETag')).toBe(`"${v}"`);
      expect(r.headers.get('Vary')).toBe('Origin');
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(r.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    }
    const reads = vi.spyOn(kv, 'get');
    for (const v of [V1, V2, V3]) expect((await photo('abbie', w, v, { 'If-None-Match': `"${v}"` })).status).toBe(304);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    const first = await photo('abbie', w);
    expect([first.status, first.headers.get('ETag'), first.headers.get('Cache-Control')]).toEqual([200, `"${V1}"`, 'private, no-cache']);
    expect(Buffer.from(first.bytes).equals(Buffer.from(P1))).toBe(true);
  });

  it('another entry\'s version, or a removed one: 404', async () => {
    const w = await world();
    await threePhotos(w);
    await addExpense('gino', w.gid, 'lunch-00001', w.gino);
    await add('gino', w, P4, { eid: 'lunch-00001' });
    expect(await photo('gino', w, V4)).toMatchObject({ status: 404, data: NOT_FOUND });
    expect((await photo('gino', w, V2, undefined, 'lunch-00001')).status).toBe(404);
    await drop('gino', w, V3);
    expect(await photo('gino', w, V3)).toMatchObject({ status: 404, data: NOT_FOUND });
    expect((await photo('leo', w, V2)).status).toBe(404);
  });
});

describe('receipt and receipts in every answer with an expense', () => {
  it('snapshot, save, delete, restore, the 409 conflict\'s copy and the export carry receipts in order, receipt = receipts[0] ?? null', async () => {
    const w = await world();
    const three = await threePhotos(w);
    const list = three.receipts;
    const snap = entryIn(await snapOf('abbie', w.gid), w.eid);
    expect([snap.receipt, snap.receipts]).toEqual([list[0], list]);
    const save = await call<{ expense: ExpenseDTO }>('PUT', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'gino', json: { ...(expenseBody(w.gino, 1500) as object), baseVersion: 1 } });
    expect([save.data.expense.receipt, save.data.expense.receipts]).toEqual([list[0], list]);
    // Abbie saves from the copy before Gino's change: 409, with the entry as stored, photos and all.
    const conflict = await call('PUT', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'abbie', json: { ...(expenseBody(w.gino, 1800) as object), baseVersion: 1 } });
    expect(conflict.status).toBe(409);
    expect([conflict.data.error.details.expense.receipt, conflict.data.error.details.expense.receipts]).toEqual([list[0], list]);
    const del = await call<{ expense: ExpenseDTO }>('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'gino' });
    expect(del.data.expense.receipts).toEqual(list);
    const back = await call<{ expense: ExpenseDTO }>('POST', `/api/groups/${w.gid}/expenses/${w.eid}/restore`, { as: 'gino' });
    expect([back.data.expense.receipt, back.data.expense.receipts]).toEqual([list[0], list]);
    const fresh = await call<{ expense: ExpenseDTO }>('PUT', `/api/groups/${w.gid}/expenses/new-entry-01`, { as: 'gino', json: expenseBody(w.gino) });
    expect([fresh.data.expense.receipt, fresh.data.expense.receipts]).toEqual([null, []]);

    const ex = await call('GET', '/api/me/export', { as: 'abbie' });
    const entries = (ex.data.groups as GroupSnapshotDTO[]).find(g => g.group.id === w.gid)!.expenses;
    expect(entries.filter(e => e.id === w.eid)).toHaveLength(1);
    expect([entryIn({ expenses: entries } as GroupSnapshotDTO, w.eid).receipt, entryIn({ expenses: entries } as GroupSnapshotDTO, w.eid).receipts]).toEqual([list[0], list]);
    expect(entryIn({ expenses: entries } as GroupSnapshotDTO, 'new-entry-01').receipts).toEqual([]);
    // Metadata only.
    expect(ex.bytes.includes(Buffer.from(P2).subarray(0, 64))).toBe(false);
  });

  it('an entry with three photos is in the snapshot once, the balances do not move, the ETag does, and the summary is carried along', async () => {
    const w = await world();
    const me = async () => (await call<MeDTO>('GET', '/api/me', { as: 'abbie' })).data.groups.find(g => g.id === w.gid)!;
    const before = await me();
    const etag = (await call('GET', '/api/groups/' + w.gid, { as: 'abbie' })).headers.get('ETag')!;
    const activity = db.rows('SELECT id FROM activity').length;
    await threePhotos(w);
    const snap = await call<GroupSnapshotDTO>('GET', '/api/groups/' + w.gid, { as: 'abbie', headers: { 'If-None-Match': etag } });
    expect(snap.status).toBe(200);
    expect(snap.headers.get('ETag')).not.toBe(etag);
    expect(snap.data.expenses.filter(e => e.id === w.eid)).toHaveLength(1);
    expect(snap.data.expenses).toHaveLength(1);
    const after = await me();
    expect([after.myNet, after.spent, after.count]).toEqual([before.myNet, before.spent, before.count]);
    expect(db.rows('SELECT id FROM activity')).toHaveLength(activity);
    const g = db.rows<{ version: number; summary: string }>('SELECT version, summary FROM groups WHERE id = ?', w.gid)[0];
    expect(JSON.parse(g.summary).forVersion).toBe(g.version);
  });
});

describe('what a rollback leaves', () => {
  it('extras without a receipts row are listed in order with the earliest first, and the next write promotes it', async () => {
    const w = await world();
    const t = (s: number) => new Date(Date.UTC(2026, 9, 30, 9, 0, s)).toISOString();
    seedPhoto('receipt_extras', w, w.eid, P3, t(3));
    seedPhoto('receipt_extras', w, w.eid, P2, t(2));
    const e = entryIn(await snapOf('gino', w.gid), w.eid);
    expect(versions(e.receipts)).toEqual([V2, V3]);
    expect(e.receipt?.version).toBe(V2);
    // What clients load without v is that photo too.
    expect((await photo('gino', w)).headers.get('ETag')).toBe(`"${V2}"`);
    const r = await add('gino', w, P1);
    expect(versions(r.data.receipts)).toEqual([V2, V3, V1]);
    expect(rowsOf(w.eid).map(x => x.version)).toEqual([V2]);
    expect(extrasOf(w.eid).map(x => x.version)).toEqual([V3, V1]);
  });

  it('a version in both tables is listed once, and the next write takes the extra row off without deleting its object', async () => {
    const w = await world();
    const t = new Date().toISOString();
    seedPhoto('receipts', w, w.eid, P1, t);
    seedPhoto('receipt_extras', w, w.eid, P1, t);
    seedPhoto('receipt_extras', w, w.eid, P2, new Date(Date.now() + 1000).toISOString());
    expect(versions(entryIn(await snapOf('gino', w.gid), w.eid).receipts)).toEqual([V1, V2]);
    const r = await add('gino', w, P3);
    expect(versions(r.data.receipts)).toEqual([V1, V2, V3]);
    expect(extrasOf(w.eid).map(x => x.version)).toEqual([V2, V3]);
    expect(kv.map.has(receiptKey(w.eid, V1))).toBe(true);
    expect(kv.deletes).toEqual([]);
  });

  it('readers never show more than three, and a fourth place is never given', async () => {
    const w = await world();
    await threePhotos(w);
    // A fourth row a hand-made write could leave: still three in every answer.
    seedPhoto('receipt_extras', w, w.eid, P4, new Date(Date.now() + 60_000).toISOString());
    expect(versions(entryIn(await snapOf('gino', w.gid), w.eid).receipts)).toEqual([V1, V2, V3]);
    expect((await add('gino', w, jpegOf(500, 5))).status).toBe(409);
  });

  it('toExpenseDTO reads r_extras leniently: null or \'\' is none, a malformed element is skipped, the order is settled by at and version', () => {
    const row = { r_version: V1, r_mime: 'image/jpeg', r_width: 1, r_height: 2, r_bytes: 3 };
    const x = (version: string, at: string) => ({ version, mime: 'image/jpeg', width: 4, height: 5, bytes: 6, at });
    expect(receiptsOf({ ...row, r_extras: null }).map(p => p.version)).toEqual([V1]);
    expect(receiptsOf({ ...row, r_extras: '' }).map(p => p.version)).toEqual([V1]);
    expect(receiptsOf({ ...row, r_extras: 'not json' }).map(p => p.version)).toEqual([V1]);
    const extras = JSON.stringify([x(V3, '2026-10-30T10:00:01Z'), { version: 7 }, null, 'x', x('b', '2026-10-30T10:00:00Z'), x('a', '2026-10-30T10:00:00Z'), x(V1, '2026-10-30T09:00:00Z')]);
    const list = receiptsOf({ ...row, r_extras: extras });
    expect(list.map(p => p.version)).toEqual([V1, 'a', 'b']);
    expect(Object.keys(list[1]).sort()).toEqual(['bytes', 'height', 'mime', 'version', 'width']);
    // No first photo: the earliest other one is first.
    expect(receiptsOf({ r_extras: extras }).map(p => p.version)).toEqual([V1, 'a', 'b']);
    expect(receiptsOf({}).map(p => p.version)).toEqual([]);
  });
});

describe('the daily cleanup, per expense', () => {
  it('a deleted entry\'s three photos go together after 24 h, and not before; a restore within the day brings all three back', async () => {
    const w = await world();
    await threePhotos(w);
    await addExpense('gino', w.gid, 'lunch-00001', w.gino);
    await add('gino', w, P4, { eid: 'lunch-00001' });
    await add('gino', w, P1, { eid: 'lunch-00001' });
    expect((await call('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'gino' })).status).toBe(200);
    expect((await call('DELETE', `/api/groups/${w.gid}/expenses/lunch-00001`, { as: 'gino' })).status).toBe(200);
    expect(await cleanupReceiptPhotos(env() as never, new Date(Date.now() + 3600_000))).toEqual({ deleted: 0, failed: 0 });
    const back = await call<{ expense: ExpenseDTO }>('POST', `/api/groups/${w.gid}/expenses/lunch-00001/restore`, { as: 'gino' });
    expect(versions(back.data.expense.receipts)).toEqual([V4, V1]);
    expect(await cleanupReceiptPhotos(env() as never, new Date(Date.now() + DAY_MS + 60_000))).toEqual({ deleted: 3, failed: 0 });
    expect([...rowsOf(w.eid), ...extrasOf(w.eid)]).toEqual([]);
    expect([V1, V2, V3].some(v => kv.map.has(receiptKey(w.eid, v)))).toBe(false);
    expect(versions(entryIn(await snapOf('gino', w.gid), 'lunch-00001').receipts)).toEqual([V4, V1]);
  });

  it('a deleted group\'s photos go at the next run', async () => {
    const w = await world();
    await threePhotos(w);
    expect((await call('DELETE', '/api/groups/' + w.gid, { as: 'gino' })).status).toBe(200);
    expect(await cleanupReceiptPhotos(env() as never, new Date())).toEqual({ deleted: 3, failed: 0 });
    expect(kv.map.size).toBe(0);
    expect(db.rows('SELECT expense_id FROM receipt_extras')).toEqual([]);
  });

  it('at most 25 expenses a run with all their photos, oldest deletion first, never part of one except after a failed delete, which keeps its row', async () => {
    const w = await world();
    const eids: string[] = [];
    const t = Date.now();
    for (let i = 0; i < RECEIPT_CLEANUP_EXPENSES_PER_RUN + 2; i++) {
      const eid = `many-${String(i).padStart(4, '0')}`;
      eids.push(eid);
      await addExpense('gino', w.gid, eid, w.gino);
      seedPhoto('receipts', w, eid, jpegOf(50, i), new Date(t).toISOString());
      seedPhoto('receipt_extras', w, eid, jpegOf(51, i), new Date(t + 1).toISOString());
      seedPhoto('receipt_extras', w, eid, jpegOf(52, i), new Date(t + 2).toISOString());
      // Deleted two days ago, a second apart: the order the cleanup takes them in.
      db.exec('UPDATE expenses SET deleted_at = ?, deleted_by = ? WHERE id = ?', new Date(t - 2 * DAY_MS + i * 1000).toISOString(), 'gino', eid);
    }
    const failing = receiptKey(eids[0], versionOf(jpegOf(51, 0)));
    kv.failDeleteKeys.add(failing);
    expect(await cleanupReceiptPhotos(env() as never, new Date())).toEqual({ deleted: 3 * RECEIPT_CLEANUP_EXPENSES_PER_RUN - 1, failed: 1 });
    const left = (eid: string) => db.rows('SELECT version FROM receipts WHERE expense_id = ? UNION ALL SELECT version FROM receipt_extras WHERE expense_id = ?', eid, eid).length;
    expect(eids.map(left)).toEqual([1, ...Array(RECEIPT_CLEANUP_EXPENSES_PER_RUN - 1).fill(0), 3, 3]);
    expect(kv.map.has(failing)).toBe(true);
    kv.failDeleteKeys.clear();
    expect(await cleanupReceiptPhotos(env() as never, new Date())).toEqual({ deleted: 7, failed: 0 });
    expect(kv.map.size).toBe(0);
  });
});

describe('the pins', () => {
  it('three photos at most, 25 expenses a cleanup run, and every cap in wrangler.toml as it was (8,000 + 500 + 1,500 = 10,000 neurons)', () => {
    expect(RECEIPT_PHOTOS_MAX).toBe(3);
    expect(RECEIPT_CLEANUP_EXPENSES_PER_RUN).toBe(25);
    const vars: Record<string, Record<string, string>> = { vars: {}, 'env.staging.vars': {} };
    let table = '';
    for (const raw of readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      const header = /^\[{1,2}([^\]]+)\]{1,2}$/.exec(line);
      if (header) table = header[1].trim();
      const m = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
      if (m && vars[table]) vars[table][m[1]] = m[2];
    }
    const pick = (t: string, ...names: string[]) => names.map(n => vars[t][n] ?? null);
    const names = ['RECEIPT_NEURONS_PER_DAY', 'RECEIPT_STORE_MAX_BYTES', 'RECEIPT_KV_WRITES_PER_DAY', 'RECEIPT_GLOBAL_PER_DAY', 'RECEIPT_PER_DAY', 'RECEIPT_JOINT'];
    expect(pick('vars', ...names)).toEqual(['8000', null, '500', null, null, null]);
    expect(pick('env.staging.vars', ...names)).toEqual(['500', '30000000', '60', '40', null, null]);
    expect(8000 + 500 + 1500).toBe(10_000);
    expect([RECEIPT_STORE_MAX_BYTES, RECEIPT_KV_WRITES_PER_DAY, RECEIPT_PHOTO_PER_DAY, RECEIPT_PHOTO_MAX_BYTES]).toEqual([800_000_000, 900, 40, 600_000]);
    expect([RECEIPT_EXTRAS_MAX_BYTES, RECEIPT_LEGACY_DELETE_WINDOW_S]).toEqual([150_000_000, 86_400]);
    // 800 MB of first photos (all a rollback's code counts) plus the extras stay inside the account's 1 GB.
    expect(RECEIPT_STORE_MAX_BYTES + RECEIPT_EXTRAS_MAX_BYTES).toBeLessThanOrEqual(1_000_000_000 - 30_000_000);
  });
});

// ---------- the review's fixes (2026-10-30) ----------

/** The photos read again after a batch (PHOTOS_SQL through .all()) fail `n` times. */
function failPhotoReads(n: number): void {
  const real = TestStmt.prototype.all;
  let left = n;
  vi.spyOn(TestStmt.prototype, 'all').mockImplementation(async function (this: TestStmt) {
    if (left > 0 && this.sql.includes('AS extra FROM receipt_extras')) {
      left--;
      throw new Error('D1_ERROR: Network connection lost');
    }
    return real.call(this);
  });
}

/** The next write batch (more statements than entryFor's two reads) is applied, then answered with an error. */
function applyThenThrowNextBatch(): void {
  const real = db.batch.bind(db);
  let armed = true;
  vi.spyOn(db, 'batch').mockImplementation(async stmts => {
    if (armed && stmts.length > 2) {
      armed = false;
      await real(stmts);
      throw new Error('D1_ERROR: Network connection lost');
    }
    return real(stmts);
  });
}

describe('a legacy DELETE retried after a lost answer (review C1)', () => {
  const legacyDelete = (as: string, w: World) => call<{ groupVersion: number; receipt: ReceiptDTO | null; receipts: ReceiptDTO[] }>('DELETE', path(w, w.eid), { as });
  const windowRow = (uid: string, eid: string, v: string) =>
    db.rows<{ reset_at: number }>('SELECT reset_at FROM rate_limits WHERE key = ?', `receipt-legacy-del:${uid}:${eid}:${v}`)[0] ?? null;

  it('a retry hours after the lost answer (a Home Screen app suspended mid-request, a phone offline) still writes nothing (fix check of C1)', async () => {
    const w = await world();
    await threePhotos(w);
    const first = await legacyDelete('gino', w);
    // Five hours on: the row is still there (a day), so the retry is not a second removal.
    db.exec('UPDATE rate_limits SET reset_at = reset_at - ? WHERE key = ?', 5 * 3600_000, `receipt-legacy-del:gino:${w.eid}:${V2}`);
    const late = await legacyDelete('gino', w);
    expect([late.status, versions(late.data.receipts)]).toEqual([200, [V2, V3]]);
    expect(late.data).toEqual(first.data);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(true);
  });

  it('the same account removes one photo, not the next, within a day; another account still removes the next', async () => {
    const w = await world();
    await threePhotos(w);
    const first = await legacyDelete('gino', w);
    expect(versions(first.data.receipts)).toEqual([V2, V3]);
    const left = windowRow('gino', w.eid, V2)!;
    expect(left.reset_at - Date.now()).toBeGreaterThan((RECEIPT_LEGACY_DELETE_WINDOW_S - 60) * 1000);
    expect(left.reset_at - Date.now()).toBeLessThanOrEqual(RECEIPT_LEGACY_DELETE_WINDOW_S * 1000);
    // The retry: the same answer, nothing written.
    const deletes = kv.deletes.length;
    const again = await legacyDelete('gino', w);
    expect([again.status, again.data]).toEqual([200, first.data]);
    expect(kv.deletes).toHaveLength(deletes);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(true);
    expect(versions(entryIn(await snapOf('gino', w.gid), w.eid).receipts)).toEqual([V2, V3]);
    // Someone else's removal is not a retry of Gino's.
    expect(versions((await legacyDelete('abbie', w)).data.receipts)).toEqual([V3]);
  });

  it('once the window passes, or when the first photo changed since, the account removes the photo first now', async () => {
    const w = await world();
    await threePhotos(w);
    await legacyDelete('gino', w);
    db.exec('UPDATE rate_limits SET reset_at = ? WHERE key = ?', Date.now() - 1, `receipt-legacy-del:gino:${w.eid}:${V2}`);
    expect(versions((await legacyDelete('gino', w)).data.receipts)).toEqual([V3]);
    // A new first photo (the old app's 換一張) is not what the last DELETE left first.
    expect((await upload('gino', w, P4)).data.receipt.version).toBe(V4);
    expect(versions((await legacyDelete('gino', w)).data.receipts)).toEqual([]);
    // With no photo left there is nothing to remember, and a DELETE changes nothing.
    expect((await legacyDelete('gino', w)).data).toMatchObject({ receipt: null, receipts: [] });
  });

  it('the new route is not held back by it: a removal by version is never a retry of another', async () => {
    const w = await world();
    await threePhotos(w);
    await legacyDelete('gino', w);
    expect(versions((await drop('gino', w, V2)).data.receipts)).toEqual([V3]);
  });
});

describe('a batch whose outcome is not known (review C2 and I1)', () => {
  it('the new PUT: applied, answered with an error, and the photos unreadable: the object stays, and the retry finds the photo whole', async () => {
    const w = await world();
    await add('gino', w, P1);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    applyThenThrowNextBatch();
    failPhotoReads(2);
    const r = await add('gino', w, P2);
    expect([r.status, r.data.error.code]).toEqual([503, 'server_error']);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(true);
    expect(extrasOf(w.eid).map(x => x.version)).toEqual([V2]);
    vi.restoreAllMocks();
    const retry = await add('gino', w, P2);
    expect(versions(retry.data.receipts)).toEqual([V1, V2]);
    const img = await photo('abbie', w, V2);
    expect(img.status).toBe(200);
    expect(Buffer.from(img.bytes).equals(Buffer.from(P2))).toBe(true);
  });

  it('the new PUT: a batch that failed for real takes its object out once the photos show no row names it, even after one failed read', async () => {
    const w = await world();
    await add('gino', w, P1);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = db.batch.bind(db);
    let armed = true;
    vi.spyOn(db, 'batch').mockImplementation(async stmts => {
      if (armed && stmts.length > 2) {
        armed = false;
        throw new Error('D1_ERROR: Network connection lost');
      }
      return real(stmts);
    });
    failPhotoReads(1);
    expect((await add('gino', w, P2)).status).toBe(503);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(false);
  });

  it('the legacy PUT: applied, answered with an error, unreadable: both objects stay; readable: the replaced one goes', async () => {
    const w = await world();
    await threePhotos(w);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    applyThenThrowNextBatch();
    failPhotoReads(2);
    expect((await upload('gino', w, P4)).status).toBe(503);
    expect([kv.map.has(receiptKey(w.eid, V1)), kv.map.has(receiptKey(w.eid, V4))]).toEqual([true, true]);
    expect(rowsOf(w.eid).map(x => x.version)).toEqual([V4]);
    vi.restoreAllMocks();
    // Readable this time: the uploaded photo is first now, so the one it replaced goes.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p5 = jpegOf(340, 5);
    applyThenThrowNextBatch();
    expect((await upload('gino', w, p5)).status).toBe(503);
    expect(rowsOf(w.eid).map(x => x.version)).toEqual([versionOf(p5)]);
    expect(kv.map.has(receiptKey(w.eid, V4))).toBe(false);
    expect(kv.map.has(receiptKey(w.eid, versionOf(p5)))).toBe(true);
    // Photo 2's bytes moving up, applied but answered with an error: the old first goes as well.
    applyThenThrowNextBatch();
    expect((await upload('gino', w, P2)).status).toBe(503);
    expect(rowsOf(w.eid).map(x => x.version)).toEqual([V2]);
    expect(kv.map.has(receiptKey(w.eid, versionOf(p5)))).toBe(false);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(true);
  });

  it('a photo another request names again between a batch and its KV delete keeps its object (I1)', async () => {
    const w = await world();
    await add('gino', w, P1);
    await add('gino', w, P2);
    // While the legacy PUT that replaces P1 reads the photos before deleting P1's object, Abbie adds P1's bytes again.
    const real = TestStmt.prototype.all;
    let once = true;
    vi.spyOn(TestStmt.prototype, 'all').mockImplementation(async function (this: TestStmt) {
      if (once && this.sql.includes('AS extra FROM receipt_extras')) {
        once = false;
        expect((await add('abbie', w, P1)).status).toBe(200);
      }
      return real.call(this);
    });
    const r = await upload('gino', w, P4);
    expect(r.status).toBe(200);
    expect(versions(entryIn(await snapOf('gino', w.gid), w.eid).receipts)).toEqual([V4, V2, V1]);
    expect(kv.map.has(receiptKey(w.eid, V1))).toBe(true);
  });
});

describe('the 404 of the receipts/:version routes (review C3)', () => {
  const GONE = { error: { code: 'not_found', message: 'Not found', details: { entry: 'gone' } } };

  it('says {entry: "gone"} for every refusal; the legacy routes, GET and a path no route serves keep the plain 404', async () => {
    const w = await world();
    await add('gino', w, P1);
    const refusals: [string, Res][] = [
      ['a stranger adds', await add('leo', w, P2)],
      ['a stranger removes', await drop('leo', w, V1)],
      ['no such entry', await drop('gino', w, V1, 'nothing-here')],
      ['not an entry id', await add('gino', w, P2, { eid: 'a' })],
    ];
    expect((await call('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}`, { as: 'gino' })).status).toBe(200);
    refusals.push(['a deleted entry takes no photo', await add('gino', w, P2)]);
    for (const [what, r] of refusals) expect([what, r.status, r.data]).toEqual([what, 404, GONE]);
    // A removal from a deleted entry still works, as before.
    expect((await drop('gino', w, V1)).status).toBe(200);
    // What a server from before several photos answers for these paths: no details.
    expect((await call('DELETE', `/api/groups/${w.gid}/expenses/${w.eid}/receipts`, { as: 'gino' })).data).toEqual(NOT_FOUND);
    expect((await upload('leo', w)).data).toEqual(NOT_FOUND);
    expect((await call('DELETE', path(w, w.eid), { as: 'leo' })).data).toEqual(NOT_FOUND);
    expect((await photo('leo', w, V1)).data).toEqual(NOT_FOUND);
  });
});

describe('the second and third photos have room of their own (review C10)', () => {
  it('a photo that would become an extra is refused once receipt_extras would pass 150,000,000 bytes; a first photo is not', async () => {
    const w = await world();
    await addExpense('gino', w.gid, 'big-one-0001', w.gino);
    seedPhoto('receipts', w, 'big-one-0001', jpegOf(10, 7), new Date().toISOString());
    db.exec(
      `INSERT INTO receipt_extras (expense_id, version, group_id, kv_key, mime, bytes, width, height, uploaded_by, created_at) VALUES ('big-one-0001', 'x', ?, 'receipt:big-one-0001:x', 'image/jpeg', ?, 1, 1, 'gino', ?)`,
      w.gid, RECEIPT_EXTRAS_MAX_BYTES - P2.length + 1, new Date().toISOString(),
    );
    // The first photo goes to receipts: only the whole store counts.
    expect((await add('gino', w, P1)).status).toBe(200);
    const full = await add('gino', w, P2);
    expect([full.status, full.data.error.code]).toEqual([503, 'receipts_full']);
    expect(kv.map.has(receiptKey(w.eid, V2))).toBe(false);
    // The legacy PUT makes a first photo: allowed.
    expect((await upload('gino', w, P3)).status).toBe(200);
    db.exec("UPDATE receipt_extras SET bytes = bytes - 1 WHERE version = 'x'");
    expect((await add('gino', w, P2)).status).toBe(200);
  });
});
