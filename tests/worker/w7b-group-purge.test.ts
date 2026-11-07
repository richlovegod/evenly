// The owner's erase of a deleted group, POST /api/admin/groups/:gid/purge (review B4a-01). The
// privacy page offers it to a deleted group's admins on request, and the schema's cascade alone
// would leave the group's activity rows (they have no foreign key) and strand its receipt photos in
// KV (only their rows find them). Only the owner, only a deleted group; the photos first (KV, then
// the rows, a page a call); then, in one batch, the group row with its cascade and the activity
// rows. Runs the real Worker against the real schema in SQLite (d1-sqlite.ts, foreign keys on as D1
// has them) with an in-memory KV namespace, as a script calls it (Bearer).

import { beforeEach, describe, expect, it } from 'vitest';
import { todayUTC } from '../../src/shared/dates';
import type { GroupSnapshotDTO } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { PURGE_PHOTOS_PER_CALL } from '../../src/worker/routes/admin';
import { receiptKey } from '../../src/worker/services/receiptPhotos';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';
const OWNER = 'gino@split.test';
const TODAY = todayUTC();

/** Workers KV as the routes use it; deletes of some keys can be made to fail. */
class FakeKV {
  readonly map = new Map<string, Uint8Array>();
  failKeys = new Set<string>();
  async get(key: string): Promise<ArrayBuffer | null> {
    const v = this.map.get(key);
    return v ? v.slice().buffer : null;
  }
  async put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<void> {
    const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.map.set(key, new Uint8Array(view));
  }
  async delete(key: string): Promise<void> {
    if (this.failKeys.has(key)) throw new Error('KV delete failed');
    this.map.delete(key);
  }
}

let db: TestD1;
let kv: FakeKV | undefined;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  data: T;
}

async function api<T = any>(user: string | null, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const h: Record<string, string> = { 'cf-connecting-ip': '203.0.113.9' };
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request(SITE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const env = { DB: db.d1, RECEIPTS: kv, ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test', OWNER_EMAILS: OWNER };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

const purge = (gid: string, as = 'gino') => api(as, 'POST', `/api/admin/groups/${gid}/purge`);

async function addUser(id: string, name: string, email: string): Promise<void> {
  const at = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, email, '#2F6FB5', at, at);
  tokens[id] = await createSession(db.d1, id, 'test');
}

function expenseBody(payer: string, amount = 1200): unknown {
  return {
    kind: 'expense', description: 'Dinner', category: 'food.dining', amount, currency: 'TWD', fxRate: 1, date: TODAY,
    payers: [{ memberId: payer, amount }], split: { method: 'equal', entries: [{ memberId: payer }] },
  };
}

async function addExpense(as: string, gid: string, eid: string, payer: string): Promise<void> {
  const r = await api(as, 'PUT', `/api/groups/${gid}/expenses/${eid}`, expenseBody(payer));
  expect(r.status, JSON.stringify(r.data)).toBe(200);
}

/** A photo row as the routes write it (`first`: receipts; else receipt_extras), and its object in KV. */
function seedPhoto(table: 'receipts' | 'receipt_extras', gid: string, eid: string, n: number): string {
  const version = n.toString(16).padStart(16, '0');
  const key = receiptKey(eid, version);
  db.exec(
    `INSERT INTO ${table} (expense_id, group_id, kv_key, version, mime, bytes, width, height, uploaded_by, created_at) VALUES (?, ?, ?, ?, 'image/jpeg', 3, 10, 20, 'abbie', ?)`,
    eid, gid, key, version, new Date(Date.now() + n).toISOString(),
  );
  kv?.map.set(key, new Uint8Array([0xff, 0xd8, 0xff]));
  return key;
}

/** An expense row put straight into the table (many of them, faster than the route). */
function seedExpense(gid: string, eid: string): void {
  const at = new Date().toISOString();
  db.exec(
    `INSERT INTO expenses (id, group_id, kind, description, category, amount, currency, date, payers, split, shares, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, 'expense', 'Seeded', 'food.dining', 100, 'TWD', ?, '[]', '{"method":"equal","entries":[]}', '[]', 'abbie', ?, 'abbie', ?)`,
    eid, gid, TODAY, at, at,
  );
}

/** Rows of `table` that belong to group `gid` (by group_id). */
const countIn = (table: string, gid: string): number => db.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?`, gid)[0].n;

interface World {
  trip: GroupSnapshotDTO;
  home: GroupSnapshotDTO;
  tripKeys: string[];
  homeKey: string;
}

/**
 * Abbie's trip (with Leo, who joined by the invite link, and Kai, a name with a claim link): three
 * entries, one deleted, a comment, four photos (one entry with three, the deleted one with one),
 * then deleted by Abbie. Her home group stays live, with an entry and its photo. Gino is the owner.
 */
async function world(): Promise<World> {
  await addUser('gino', 'Gino', OWNER);
  await addUser('abbie', 'Abbie', 'abbie@split.test');
  await addUser('leo', 'Leo', 'leo@split.test');
  const trip = (await api<GroupSnapshotDTO>('abbie', 'POST', '/api/groups', { name: 'Niseko', type: 'trip', currency: 'TWD', members: [{ name: 'Kai' }] })).data;
  const gid = trip.group.id;
  expect((await api('leo', 'POST', '/api/join/' + trip.inviteCode, { name: 'Leo' })).status).toBe(200);
  const me = trip.me.memberId;
  for (const eid of ['dinner-0001', 'taxi-000001', 'oops-000001']) await addExpense('abbie', gid, eid, me);
  expect((await api('abbie', 'DELETE', `/api/groups/${gid}/expenses/oops-000001`)).status).toBe(200);
  expect((await api('leo', 'POST', `/api/groups/${gid}/expenses/dinner-0001/comments`, { body: 'Thanks for dinner!' })).status).toBe(200);
  const kai = trip.members.find(m => m.name === 'Kai')!.id;
  expect((await api('abbie', 'POST', `/api/groups/${gid}/members/${kai}/claim-link`, {})).status).toBe(200);
  const tripKeys = [
    seedPhoto('receipts', gid, 'dinner-0001', 1),
    seedPhoto('receipt_extras', gid, 'dinner-0001', 2),
    seedPhoto('receipt_extras', gid, 'dinner-0001', 3),
    seedPhoto('receipts', gid, 'oops-000001', 4),
  ];
  const home = (await api<GroupSnapshotDTO>('abbie', 'POST', '/api/groups', { name: 'Home', type: 'home', currency: 'TWD' })).data;
  await addExpense('abbie', home.group.id, 'rent-000001', home.me.memberId);
  const homeKey = seedPhoto('receipts', home.group.id, 'rent-000001', 5);
  expect((await api('abbie', 'DELETE', '/api/groups/' + gid)).status).toBe(200);
  return { trip, home, tripKeys, homeKey };
}

beforeEach(() => {
  db = new TestD1();
  kv = new FakeKV();
  for (const k of Object.keys(tokens)) delete tokens[k];
});

describe('POST /api/admin/groups/:gid/purge (review B4a-01)', () => {
  it('erases a deleted group for good: its members, claim links, entries, comments, photos (KV and rows) and activity, and nothing of any other group', async () => {
    const w = await world();
    const gid = w.trip.group.id;
    const hid = w.home.group.id;
    // What the cascade alone would leave behind: activity rows (no foreign key) and photo objects.
    expect(countIn('activity', gid)).toBeGreaterThan(0);
    expect(db.rows("SELECT 1 FROM activity WHERE group_id = ? AND type = 'group.delete'", gid)).toHaveLength(1);
    expect([countIn('members', gid), countIn('claim_tokens', gid), countIn('expenses', gid), countIn('comments', gid)]).toEqual([3, 1, 3, 1]);
    expect(countIn('receipts', gid) + countIn('receipt_extras', gid)).toBe(4);
    const homeBefore = ['members', 'expenses', 'activity', 'receipts'].map(t => countIn(t, hid));

    const r = await purge(gid);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toEqual({ done: true, photosDeleted: 4, photosFailed: 0, photosLeft: 0 });
    expect(db.rows('SELECT 1 FROM groups WHERE id = ?', gid)).toEqual([]);
    for (const table of ['members', 'claim_tokens', 'expenses', 'comments', 'receipts', 'receipt_extras', 'activity']) {
      expect(countIn(table, gid), table).toBe(0);
    }
    for (const key of w.tripKeys) expect(kv!.map.has(key), key).toBe(false);
    // Abbie's live group and every account are untouched.
    expect(['members', 'expenses', 'activity', 'receipts'].map(t => countIn(t, hid))).toEqual(homeBefore);
    expect(kv!.map.has(w.homeKey)).toBe(true);
    expect(db.rows<{ id: string }>('SELECT id FROM users ORDER BY id').map(u => u.id)).toEqual(['abbie', 'gino', 'leo']);
    expect((await api('abbie', 'GET', '/api/groups/' + hid)).status).toBe(200);
    // Erased already: there is no such group.
    expect((await purge(gid)).data.error.code).toBe('not_found');
  });

  it('is the owner\'s only, and only for a deleted group: 404 for anyone else, 409 while the group is live, 404 for an unknown one; nothing changes', async () => {
    const w = await world();
    const gid = w.trip.group.id;
    expect((await api(null, 'POST', `/api/admin/groups/${gid}/purge`)).status).toBe(401);
    for (const who of ['abbie', 'leo']) {
      const r = await purge(gid, who);
      expect([r.status, r.data.error.code]).toEqual([404, 'not_found']);
    }
    const live = await purge(w.home.group.id);
    expect([live.status, live.data.error.code]).toEqual([409, 'conflict']);
    expect((await purge('no-such-group')).status).toBe(404);
    expect((await purge('x'.repeat(101))).status).toBe(404);
    expect(db.rows('SELECT 1 FROM groups')).toHaveLength(2);
    expect(countIn('receipts', gid) + countIn('receipt_extras', gid)).toBe(4);
    expect(kv!.map.size).toBe(5);
  });

  it(`deletes at most ${PURGE_PHOTOS_PER_CALL} photos a call and erases nothing else until none is left`, async () => {
    await addUser('gino', 'Gino', OWNER);
    await addUser('abbie', 'Abbie', 'abbie@split.test');
    const trip = (await api<GroupSnapshotDTO>('abbie', 'POST', '/api/groups', { name: 'Year at home', type: 'home', currency: 'TWD' })).data;
    const gid = trip.group.id;
    // Three photos an entry, three more photos than one call takes.
    const entries = PURGE_PHOTOS_PER_CALL / 3 + 1;
    for (let i = 0; i < entries; i++) {
      const eid = `seeded-${String(i).padStart(4, '0')}`;
      seedExpense(gid, eid);
      seedPhoto('receipts', gid, eid, i * 10 + 1);
      seedPhoto('receipt_extras', gid, eid, i * 10 + 2);
      seedPhoto('receipt_extras', gid, eid, i * 10 + 3);
    }
    expect((await api('abbie', 'DELETE', '/api/groups/' + gid)).status).toBe(200);
    const first = await purge(gid);
    expect(first.data).toEqual({ done: false, photosDeleted: PURGE_PHOTOS_PER_CALL, photosFailed: 0, photosLeft: 3 });
    expect(kv!.map.size).toBe(3);
    // The group, its entries and its activity wait for the photos.
    expect(db.rows('SELECT 1 FROM groups WHERE id = ?', gid)).toHaveLength(1);
    expect(countIn('expenses', gid)).toBe(entries);
    expect(countIn('activity', gid)).toBeGreaterThan(0);
    expect((await purge(gid)).data).toEqual({ done: true, photosDeleted: 3, photosFailed: 0, photosLeft: 0 });
    expect(kv!.map.size).toBe(0);
    expect([countIn('expenses', gid), countIn('activity', gid), countIn('members', gid)]).toEqual([0, 0, 0]);
  });

  it('a KV delete that fails keeps its row and the whole group for the next call, so no object loses the row that finds it', async () => {
    const w = await world();
    const gid = w.trip.group.id;
    kv!.failKeys.add(w.tripKeys[1]);
    const r = await purge(gid);
    expect(r.data).toEqual({ done: false, photosDeleted: 3, photosFailed: 1, photosLeft: 1 });
    expect(kv!.map.has(w.tripKeys[1])).toBe(true);
    expect(db.rows<{ kv_key: string }>('SELECT kv_key FROM receipt_extras WHERE group_id = ?', gid).map(x => x.kv_key)).toEqual([w.tripKeys[1]]);
    expect([countIn('members', gid), countIn('expenses', gid), countIn('comments', gid)]).toEqual([3, 3, 1]);
    kv!.failKeys.clear();
    expect((await purge(gid)).data).toEqual({ done: true, photosDeleted: 1, photosFailed: 0, photosLeft: 0 });
    expect(kv!.map.has(w.tripKeys[1])).toBe(false);
    expect(countIn('activity', gid)).toBe(0);
  });

  it('without the KV binding: 503 and nothing changes while the group has photos; a group without photos is erased', async () => {
    const w = await world();
    const gid = w.trip.group.id;
    kv = undefined;
    const r = await purge(gid);
    expect([r.status, r.data.error.code]).toEqual([503, 'server_error']);
    expect(countIn('receipts', gid) + countIn('receipt_extras', gid)).toBe(4);
    expect(db.rows('SELECT 1 FROM groups WHERE id = ?', gid)).toHaveLength(1);
    // A deleted group that never had a photo needs no KV.
    const plain = (await api<GroupSnapshotDTO>('abbie', 'POST', '/api/groups', { name: 'Plain', type: 'other', currency: 'TWD' })).data;
    await addExpense('abbie', plain.group.id, 'plain-00001', plain.me.memberId);
    expect((await api('abbie', 'DELETE', '/api/groups/' + plain.group.id)).status).toBe(200);
    expect((await purge(plain.group.id)).data).toEqual({ done: true, photosDeleted: 0, photosFailed: 0, photosLeft: 0 });
    expect([countIn('expenses', plain.group.id), countIn('activity', plain.group.id)]).toEqual([0, 0]);
  });
});
