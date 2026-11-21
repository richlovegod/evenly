// 復原 of the newest copy of a repeating entry deleted with 只刪除這一筆 (DELETE ?keep=series, review
// B2-05; Gino's call of 2026-11-21): after any restore its series has at most one live entry that
// repeats, and no occurrence is made twice, whatever was edited in between (services/recurring.ts
// restoreRepeat). The entry that took the repeat over gives it back when it is still exactly as the
// hand-over left it; when it or the series changed since, the change wins and the restored entry
// comes back without its repeat. On the worker.fetch harness with the real schema
// (tests/worker/d1-sqlite.ts), the clock faked so each step has its own time (one test keeps it
// still, to check the order of steps in the same millisecond). Requests carry no X-Evenly-Features,
// as the iPhone 1.1 build sends them; one restore is also checked with the web's header.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/worker/services/fx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/worker/services/fx')>();
  return { ...actual, getUsdRates: vi.fn(async (_db: unknown, date: string) => ({ date, rates: { USD: 1, TWD: 32.3 }, source: 'test' })) };
});

import type { DeleteExpenseRes, GroupSnapshotDTO } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import { uuidFrom } from '../../src/worker/http';
import worker from '../../src/worker/index';
import type { ExpenseRow } from '../../src/worker/db';
import { restoreRepeat, seriesAtRestore, type SeriesAtRestore } from '../../src/worker/services/recurring';
import { TestD1, type TestStmt } from './d1-sqlite';

let db: TestD1;
const tokens: Record<string, string> = {};
/** How far the clock moves before each request (0: every step in the same millisecond). */
let step = 1000;

interface Res<T = any> {
  status: number;
  data: T;
}

async function api<T = any>(user: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  vi.setSystemTime(Date.now() + step);
  const h: Record<string, string> = { Authorization: 'Bearer ' + tokens[user], ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request('http://api.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'http://app.test/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

async function addUser(id: string, name: string, email: string): Promise<void> {
  const now = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, email, '#2F6FB5', now, now);
  tokens[id] = await createSession(db.d1, id, 'test');
}

interface Group {
  gid: string;
  A: string;
  B: string;
}

async function newGroup(): Promise<Group> {
  const r = await api<GroupSnapshotDTO>('uA', 'POST', '/api/groups', { name: 'test-home', type: 'home', currency: 'TWD', members: [{ name: 'Bea', email: 'b@evenly.test' }] });
  expect(r.status).toBe(200);
  const id = (name: string) => r.data.members.find(m => m.name === name)!.id;
  return { gid: r.data.group.id, A: id('Ann'), B: id('Bea') };
}

function rent(g: Group, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'expense', description: 'rent', category: 'general', amount: 300, currency: 'TWD', fxRate: 1, date: '2026-09-05', repeat: 'monthly',
    payers: [{ memberId: g.A, amount: 300 }], split: { method: 'equal', entries: [{ memberId: g.A }, { memberId: g.B }] }, ...over,
  };
}

const put = (g: Group, eid: string, body: unknown) => api('uA', 'PUT', `/api/groups/${g.gid}/expenses/${eid}`, body);
const del = (g: Group, eid: string, keep = false) => api<DeleteExpenseRes>('uA', 'DELETE', `/api/groups/${g.gid}/expenses/${eid}${keep ? '?keep=series' : ''}`);
const restore = (g: Group, eid: string, headers: Record<string, string> = {}) =>
  api<DeleteExpenseRes>('uA', 'POST', `/api/groups/${g.gid}/expenses/${eid}/restore`, undefined, headers);
/** A read of the group: the recurring pass runs first (routes/groups.ts). */
const read = async (g: Group) => (await api<GroupSnapshotDTO>('uA', 'GET', '/api/groups/' + g.gid)).data;

interface Row {
  id: string;
  date: string;
  repeat: string;
  repeat_start: string | null;
  deleted_at: string | null;
}
const rowsOf = (g: Group) => db.rows<Row>('SELECT id, date, repeat, repeat_start, deleted_at FROM expenses WHERE group_id = ? ORDER BY date, id', g.gid);
/** The live entries that repeat, as [date, repeat, schedule start]: at most one per series. */
const heads = (g: Group) => rowsOf(g).filter(r => !r.deleted_at && r.repeat !== 'none').map(r => [r.date, r.repeat, r.repeat_start]);
/** Every row's date, deleted ones too: an occurrence made twice shows twice. */
const dates = (g: Group) => rowsOf(g).map(r => r.date);
const liveDates = (g: Group) => rowsOf(g).filter(r => !r.deleted_at).map(r => r.date);
/** Moves the clock to a day (09:00 UTC), as if that much time went by. */
const on = (day: string) => vi.setSystemTime(new Date(day + 'T09:00:00.000Z'));

/**
 * A monthly rent from 2026-09-05, read on 2026-11-21: the first entry, the copies of October and
 * November, November's the head. Then November is deleted with 只刪除這一筆: October takes over.
 */
async function rentSeries(handOver = true) {
  const g = await newGroup();
  expect((await put(g, 'rent-0001', rent(g))).status).toBe(200);
  await read(g);
  const oct = await uuidFrom('rent-0001:2026-10-05');
  const nov = await uuidFrom('rent-0001:2026-11-05');
  expect(rowsOf(g).map(r => [r.id, r.date, r.repeat])).toEqual([['rent-0001', '2026-09-05', 'none'], [oct, '2026-10-05', 'none'], [nov, '2026-11-05', 'monthly']]);
  if (handOver) {
    const r = await del(g, nov, true);
    expect([r.status, r.data.seriesKept]).toEqual([200, true]);
    expect(heads(g)).toEqual([['2026-10-05', 'monthly', '2026-09-05']]);
  }
  return { g, oct, nov };
}

/** Run `before` once, right before the first batch that `match` picks (another request landing first). */
function beforeBatch(match: (stmts: readonly TestStmt[]) => boolean, before: () => void): void {
  const real = db.batch.bind(db);
  let fired = false;
  (db as unknown as { batch: (s: readonly TestStmt[]) => ReturnType<TestD1['batch']> }).batch = async stmts => {
    if (!fired && match(stmts)) {
      fired = true;
      before();
    }
    return real(stmts);
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  on('2026-11-21');
  step = 1000;
  db = new TestD1();
  await addUser('uA', 'Ann', 'a@evenly.test');
  await addUser('uB', 'Bea', 'b@evenly.test');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('復原 after 只刪除這一筆: the entry that took over is still as the hand-over left it (an exact undo)', () => {
  it('the restored head takes the repeat back in the restore itself, before any read; the series goes on from it', async () => {
    const { g, oct, nov } = await rentSeries();
    const r = await restore(g, nov);
    expect(r.status).toBe(200);
    expect(r.data.expense).toMatchObject({ id: nov, repeat: 'monthly', deletedAt: null });
    expect(heads(g)).toEqual([['2026-11-05', 'monthly', '2026-09-05']]);
    expect(rowsOf(g).find(x => x.id === oct)!.repeat).toBe('none');
    // What both apps show after the read they make right after the restore.
    const snap = await read(g);
    expect(snap.expenses.filter(e => !e.deletedAt && e.repeat !== 'none').map(e => e.id)).toEqual([nov]);
    expect(dates(g)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
    on('2026-12-06');
    await read(g);
    expect(heads(g)).toEqual([['2026-12-05', 'monthly', '2026-09-05']]);
    expect(dates(g)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05', '2026-12-05']);
  });

  it('every step in the same millisecond: the copies made before the delete do not count as made since', async () => {
    step = 0;
    const { g, nov } = await rentSeries();
    expect((await restore(g, nov)).data.expense.repeat).toBe('monthly');
    expect(heads(g)).toEqual([['2026-11-05', 'monthly', '2026-09-05']]);
  });

  it('a restore much later, before the next date: still an exact undo', async () => {
    const { g, nov } = await rentSeries();
    on('2026-12-03');
    expect((await restore(g, nov)).data.expense.repeat).toBe('monthly');
    expect(heads(g)).toEqual([['2026-11-05', 'monthly', '2026-09-05']]);
    on('2026-12-06');
    await read(g);
    expect(heads(g)).toEqual([['2026-12-05', 'monthly', '2026-09-05']]);
    expect(dates(g)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05', '2026-12-05']);
  });

  it('the entry that took over deleted with 只刪除這一筆 too: the first entry holds the repeat as a hand-over leaves it, and gives it back', async () => {
    const { g, oct, nov } = await rentSeries();
    expect((await del(g, oct, true)).data.seriesKept).toBe(true);
    expect(heads(g)).toEqual([['2026-09-05', 'monthly', '2026-09-05']]);
    expect((await restore(g, nov)).data.expense.repeat).toBe('monthly');
    expect(heads(g)).toEqual([['2026-11-05', 'monthly', '2026-09-05']]);
    // October stays deleted, and its date is not made again.
    on('2026-12-06');
    await read(g);
    expect(liveDates(g)).toEqual(['2026-09-05', '2026-11-05', '2026-12-05']);
    expect(dates(g)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05', '2026-12-05']);
    // October restored later from its own page: it still carries the repeat it had when deleted, and
    // comes back without it, since the series goes on from December.
    expect((await restore(g, oct)).data.expense.repeat).toBe('none');
    expect(heads(g)).toEqual([['2026-12-05', 'monthly', '2026-09-05']]);
  });

  it('the restore answer is the same for the web (X-Evenly-Features: refunds) as for the iPhone 1.1 build (no header)', async () => {
    const { g, nov } = await rentSeries();
    const r = await restore(g, nov, { 'X-Evenly-Features': 'refunds' });
    expect(r.data.expense).toMatchObject({ id: nov, repeat: 'monthly', deletedAt: null });
    expect(heads(g)).toEqual([['2026-11-05', 'monthly', '2026-09-05']]);
  });
});

describe('復原 after 只刪除這一筆 when something changed since: the change wins', () => {
  it('the entry that took over moved from the 5th to the 7th: the restored head comes back without its repeat, and only the 7th runs', async () => {
    const { g, oct, nov } = await rentSeries();
    expect((await put(g, oct, rent(g, { date: '2026-10-07' }))).status).toBe(200);
    expect(heads(g)).toEqual([['2026-10-07', 'monthly', '2026-10-07']]);
    const r = await restore(g, nov);
    expect(r.data.expense).toMatchObject({ id: nov, repeat: 'none', deletedAt: null });
    expect(heads(g)).toEqual([['2026-10-07', 'monthly', '2026-10-07']]);
    await read(g);
    expect(heads(g)).toEqual([['2026-11-07', 'monthly', '2026-10-07']]);
    on('2026-12-08');
    await read(g);
    // Never a copy on the 5th again: one schedule.
    expect(dates(g)).toEqual(['2026-09-05', '2026-10-07', '2026-11-05', '2026-11-07', '2026-12-07']);
    expect(heads(g)).toEqual([['2026-12-07', 'monthly', '2026-10-07']]);
  });

  it('the same with a read in between (the 7th made its November copy first): nothing new for the restored date', async () => {
    const { g, oct, nov } = await rentSeries();
    expect((await put(g, oct, rent(g, { date: '2026-10-07' }))).status).toBe(200);
    await read(g);
    expect(heads(g)).toEqual([['2026-11-07', 'monthly', '2026-10-07']]);
    expect((await restore(g, nov)).data.expense.repeat).toBe('none');
    expect(heads(g)).toEqual([['2026-11-07', 'monthly', '2026-10-07']]);
    on('2026-12-08');
    await read(g);
    expect(dates(g)).toEqual(['2026-09-05', '2026-10-07', '2026-11-05', '2026-11-07', '2026-12-07']);
  });

  it('the entry that took over set to every week: only the weekly schedule runs', async () => {
    const { g, oct, nov } = await rentSeries();
    expect((await put(g, oct, rent(g, { date: '2026-10-05', repeat: 'weekly' }))).status).toBe(200);
    expect((await restore(g, nov)).data.expense.repeat).toBe('none');
    expect(heads(g)).toEqual([['2026-10-05', 'weekly', '2026-10-05']]);
    on('2026-12-06');
    await read(g);
    expect(heads(g)).toEqual([['2026-11-30', 'weekly', '2026-10-05']]);
    // Weekly from October 5th, and November 5th (the restored entry) once; no monthly December 5th.
    expect(dates(g)).toEqual([
      '2026-09-05', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-05', '2026-11-09', '2026-11-16',
      '2026-11-23', '2026-11-30',
    ]);
  });

  it('the entry that took over set to 不重複 (the series stopped): the restore does not start it again', async () => {
    const { g, oct, nov } = await rentSeries();
    expect((await put(g, oct, rent(g, { date: '2026-10-05', repeat: 'none' }))).status).toBe(200);
    expect(heads(g)).toEqual([]);
    expect((await restore(g, nov)).data.expense.repeat).toBe('none');
    expect(heads(g)).toEqual([]);
    on('2026-12-06');
    await read(g);
    expect(dates(g)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
  });

  it('the entry that took over deleted with 刪除並停止重複: the series stays stopped', async () => {
    const { g, oct, nov } = await rentSeries();
    expect((await del(g, oct)).status).toBe(200);
    expect(heads(g)).toEqual([]);
    expect((await restore(g, nov)).data.expense.repeat).toBe('none');
    expect(heads(g)).toEqual([]);
    on('2026-12-06');
    await read(g);
    expect(liveDates(g)).toEqual(['2026-09-05', '2026-11-05']);
    expect(dates(g)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
  });

  it('a restore much later, after the series made its December copy: that copy keeps the repeat, November comes back as a plain copy', async () => {
    const { g, nov } = await rentSeries();
    on('2026-12-06');
    await read(g);
    expect(heads(g)).toEqual([['2026-12-05', 'monthly', '2026-09-05']]);
    on('2026-12-10');
    const r = await restore(g, nov);
    expect(r.data.expense).toMatchObject({ repeat: 'none', deletedAt: null });
    expect(heads(g)).toEqual([['2026-12-05', 'monthly', '2026-09-05']]);
    on('2027-01-06');
    await read(g);
    expect(dates(g)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05', '2026-12-05', '2027-01-05']);
    expect(heads(g)).toEqual([['2027-01-05', 'monthly', '2026-09-05']]);
  });

  it('a restore much later, after the series made its December copy and someone stopped it there: nothing is made again', async () => {
    const { g, nov } = await rentSeries();
    on('2026-12-06');
    await read(g);
    const dec = await uuidFrom('rent-0001:2026-12-05');
    expect((await del(g, dec)).status).toBe(200);
    on('2027-01-10');
    expect((await restore(g, nov)).data.expense.repeat).toBe('none');
    expect(heads(g)).toEqual([]);
    await read(g);
    expect(dates(g)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05', '2026-12-05']);
    expect(liveDates(g)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
  });

  it('a change that lands between the restore\'s reads and its write: the restored head still never repeats beside it', async () => {
    const { g, oct, nov } = await rentSeries();
    // Someone moves October to the 7th right then (straight in, as another request's commit would be).
    beforeBatch(
      stmts => stmts.some(s => s.sql.includes('deleted_at = NULL') && s.params[0] === nov),
      () => db.exec("UPDATE expenses SET date = '2026-10-07', repeat_start = '2026-10-07' WHERE id = ?", oct),
    );
    expect((await restore(g, nov)).data.expense.repeat).toBe('none');
    expect(heads(g)).toEqual([['2026-10-07', 'monthly', '2026-10-07']]);
  });
});

describe('復原 after 刪除並停止重複 (no hand-over)', () => {
  it('nothing changed since: the series goes on from it, and a restore much later catches up, as before', async () => {
    const { g, nov } = await rentSeries(false);
    expect((await del(g, nov)).status).toBe(200);
    expect(heads(g)).toEqual([]);
    on('2027-01-10');
    expect((await restore(g, nov)).data.expense.repeat).toBe('monthly');
    expect(heads(g)).toEqual([['2026-11-05', 'monthly', '2026-09-05']]);
    await read(g);
    expect(dates(g)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05', '2026-12-05', '2027-01-05']);
    expect(heads(g)).toEqual([['2027-01-05', 'monthly', '2026-09-05']]);
  });

  it('someone turned the repeat on for October since: October\'s repeat wins, November comes back without its own', async () => {
    const { g, oct, nov } = await rentSeries(false);
    expect((await del(g, nov)).status).toBe(200);
    expect((await put(g, oct, rent(g, { date: '2026-10-05', repeat: 'monthly' }))).status).toBe(200);
    expect((await restore(g, nov)).data.expense.repeat).toBe('none');
    expect(heads(g)).toEqual([['2026-10-05', 'monthly', '2026-10-05']]);
  });
});

describe('seriesAtRestore: what the series did after the head was deleted', () => {
  const at = (id: string) => db.rows<ExpenseRow>('SELECT * FROM expenses WHERE id = ?', id)[0];

  it('nothing yet; then a copy made (moved); then that copy deleted while it repeats (stopped)', async () => {
    const { g, oct, nov } = await rentSeries();
    expect(await seriesAtRestore(db.d1, at(nov))).toEqual({
      repeating: [{ id: oct, date: '2026-10-05', repeat: 'monthly', repeat_start: '2026-09-05' }], before: oct, moved: false, stopped: false,
    });
    on('2026-12-06');
    await read(g);
    const dec = await uuidFrom('rent-0001:2026-12-05');
    expect(await seriesAtRestore(db.d1, at(nov))).toEqual({
      repeating: [{ id: dec, date: '2026-12-05', repeat: 'monthly', repeat_start: '2026-09-05' }], before: oct, moved: true, stopped: false,
    });
    expect((await del(g, dec)).status).toBe(200);
    expect(await seriesAtRestore(db.d1, at(nov))).toMatchObject({ repeating: [], before: oct, moved: true, stopped: true });
  });

  it('a repeat turned off, or a date moved, of the entry that took over; another series in the group counts for nothing', async () => {
    const { g, oct, nov } = await rentSeries();
    expect((await put(g, 'gym-0001', rent(g, { description: 'gym', date: '2026-11-01' }))).status).toBe(200);
    expect((await put(g, 'gym-0001', rent(g, { description: 'gym', date: '2026-11-01', repeat: 'none' }))).status).toBe(200);
    expect(await seriesAtRestore(db.d1, at(nov))).toMatchObject({ moved: false, stopped: false });
    expect((await put(g, oct, rent(g, { date: '2026-10-07' }))).status).toBe(200);
    expect(await seriesAtRestore(db.d1, at(nov))).toMatchObject({ repeating: [{ id: oct, repeat_start: '2026-10-07' }], moved: false, stopped: false });
    expect((await put(g, oct, rent(g, { date: '2026-10-07', repeat: 'none' }))).status).toBe(200);
    expect(await seriesAtRestore(db.d1, at(nov))).toMatchObject({ repeating: [], moved: false, stopped: true });
  });
});

describe('restoreRepeat (pure)', () => {
  const head = { date: '2026-11-05', repeat: 'monthly', repeat_start: '2026-09-05' };
  const taker = { id: 'oct', date: '2026-10-05', repeat: 'monthly', repeat_start: '2026-09-05' };
  const s = (over: Partial<SeriesAtRestore> = {}): SeriesAtRestore => ({ repeating: [taker], before: 'oct', moved: false, stopped: false, ...over });

  it('takes the repeat back only from the hand-over\'s entry, as a hand-over leaves it, with no copy made since', () => {
    expect(restoreRepeat(head, s())).toEqual({ kind: 'takeBack', from: 'oct' });
    // A deleted entry that repeated (the one before it took over again with 只刪除這一筆) does not stop it.
    expect(restoreRepeat(head, s({ stopped: true }))).toEqual({ kind: 'takeBack', from: 'oct' });
    expect(restoreRepeat(head, s({ moved: true }))).toEqual({ kind: 'drop' });
    expect(restoreRepeat(head, s({ repeating: [{ ...taker, date: '2026-10-07', repeat_start: '2026-10-07' }] }))).toEqual({ kind: 'drop' });
    expect(restoreRepeat(head, s({ repeating: [{ ...taker, repeat: 'weekly' }] }))).toEqual({ kind: 'drop' });
    expect(restoreRepeat(head, s({ before: 'sep' }))).toEqual({ kind: 'drop' });
    expect(restoreRepeat(head, s({ repeating: [taker, { ...taker, id: 'gym' }] }))).toEqual({ kind: 'drop' });
  });

  it('keeps its repeat when nothing else repeats and nothing changed since; else drops it', () => {
    expect(restoreRepeat(head, s({ repeating: [] }))).toEqual({ kind: 'keep' });
    expect(restoreRepeat(head, s({ repeating: [], before: null }))).toEqual({ kind: 'keep' });
    expect(restoreRepeat(head, s({ repeating: [], stopped: true }))).toEqual({ kind: 'drop' });
    expect(restoreRepeat(head, s({ repeating: [], moved: true }))).toEqual({ kind: 'drop' });
  });

  it('an entry that does not repeat comes back as it is; a schedule without a start begins at the date', () => {
    expect(restoreRepeat({ ...head, repeat: 'none' }, s())).toEqual({ kind: 'keep' });
    const legacy = { ...head, repeat_start: null, date: '2026-09-05' };
    expect(restoreRepeat(legacy, s({ repeating: [{ ...taker, date: '2026-08-05' }] }))).toEqual({ kind: 'takeBack', from: 'oct' });
  });
});
