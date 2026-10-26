// 退款 (docs/SPEC.md section 2, Refunds) on the worker.fetch harness with the real schema
// (tests/worker/d1-sqlite.ts): a refund saved and read by a client that knows refunds (the
// X-Evenly-Features: refunds header), its link to the expense it refunds (refundOf), and what a
// client without the header gets (src/worker/compat.ts): the expense with the same effect, its own
// ETag, the feed and an entry's history with kind 'expense', and saves made in that view merged
// there and stored as the refund again, never losing it. Also: balances, the summary and spending,
// the activity rows, refunds never repeating, imports and the export.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayUTC } from '../../src/shared/dates';
import type { ActivityDTO, ExpenseDTO, GroupSnapshotDTO, MeDTO, UpsertExpenseReq } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';

let db: TestD1;
let env: Record<string, unknown>;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  data: T;
  etag: string | null;
}

/** `refunds`: send X-Evenly-Features: refunds, as the web app and the next iPhone app do. */
async function call<T = any>(user: string, method: string, path: string, body?: unknown, o: { refunds?: boolean; etag?: string } = {}): Promise<Res<T>> {
  const h: Record<string, string> = { 'cf-connecting-ip': '203.0.113.9', Authorization: 'Bearer ' + tokens[user] };
  if (o.refunds !== false) h['X-Evenly-Features'] = 'refunds';
  if (o.etag) h['If-None-Match'] = o.etag;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request(SITE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined, etag: res.headers.get('ETag') };
}
const old = { refunds: false };

async function addUser(id: string, name: string, email: string): Promise<void> {
  const now = new Date().toISOString();
  db.exec(
    'INSERT INTO users (id, name, email, locale, currency, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, name, email, 'zh-TW', 'JPY', '#2F6FB5', now, now,
  );
  tokens[id] = await createSession(db.d1, id, 'test');
}

let gid = '';
const mid: Record<string, string> = {};
const FOUR = () => ['gino', 'abbie', 'kevin', 'tiffany'].map(k => ({ memberId: mid[k] }));

function body(o: Partial<UpsertExpenseReq> = {}): UpsertExpenseReq {
  return {
    kind: 'expense',
    description: '民宿押金',
    category: 'travel.hotel',
    amount: 30000,
    currency: 'JPY',
    fxRate: 1,
    date: todayUTC(),
    payers: [{ memberId: mid.gino, amount: 30000 }],
    split: { method: 'equal', entries: FOUR() },
    ...o,
  };
}

/** The ¥30,000 deposit coming back to Gino, the four people's money equally, started from the deposit. */
const refund = (o: Partial<UpsertExpenseReq> = {}) => body({ kind: 'refund', description: '退款：民宿押金', refundOf: 'e-deposit-0001', ...o });

const put = (user: string, eid: string, b: unknown, o?: { refunds?: boolean }) => call<{ expense: ExpenseDTO; groupVersion: number }>(user, 'PUT', `/api/groups/${gid}/expenses/${eid}`, b, o);
const snap = (user: string, o?: { refunds?: boolean; etag?: string }) => call<GroupSnapshotDTO>(user, 'GET', `/api/groups/${gid}`, undefined, o);
const stored = (eid: string) =>
  db.rows<{ kind: string; payers: string; split: string; shares: string; refund_of: string | null; repeat: string; description: string; amount: number }>(
    'SELECT kind, payers, split, shares, refund_of, repeat, description, amount FROM expenses WHERE id = ?', eid,
  )[0];
const nets = async () => {
  const me = (await call<MeDTO>('gino', 'GET', '/api/me')).data;
  return me.groups.find(g => g.id === gid)!;
};

beforeEach(async () => {
  db = new TestD1();
  env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test' };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await addUser('gino', 'Gino', 'gino@evenly.test');
  await addUser('abbie', 'Abbie', 'abbie@evenly.test');
  await addUser('kevin', 'Kevin', 'kevin@evenly.test');
  await addUser('tiffany', 'Tiffany', 'tiffany@evenly.test');
  const r = await call<GroupSnapshotDTO>('gino', 'POST', '/api/groups', {
    name: '北海道滑雪', type: 'trip', currency: 'JPY',
    members: [{ name: 'Abbie', email: 'abbie@evenly.test' }, { name: 'Kevin', email: 'kevin@evenly.test' }, { name: 'Tiffany', email: 'tiffany@evenly.test' }],
  });
  expect(r.status).toBe(200);
  gid = r.data.group.id;
  for (const m of r.data.members) mid[m.userId!] = m.id;
  // Gino paid the ¥30,000 deposit for the four of them.
  expect((await put('gino', 'e-deposit-0001', body())).status).toBe(200);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a refund, for a client that knows refunds', () => {
  it('is stored as a refund linked to its expense, and undoes the deposit in every balance', async () => {
    const before = await nets();
    expect(before.myNet).toBe(22500);
    const r = await put('gino', 'r-deposit-0001', refund());
    expect(r.status).toBe(200);
    expect(r.data.expense).toMatchObject({ kind: 'refund', refundOf: 'e-deposit-0001', amount: 30000, repeat: 'none' });
    expect(r.data.expense.payers).toEqual([{ memberId: mid.gino, amount: 30000 }]);
    expect(r.data.expense.shares.map(s => s.amount)).toEqual([7500, 7500, 7500, 7500]);
    const s = await snap('gino');
    expect(s.etag).toBe(`"${s.data.group.version}"`);
    expect(s.data.expenses.find(e => e.id === 'r-deposit-0001')).toMatchObject({ kind: 'refund', refundOf: 'e-deposit-0001' });
    const after = await nets();
    expect(after.myNet).toBe(0);
    expect(after.spent).toBe(0);
  });

  it('alone, the receiver owes each of the other three ¥7,500 (the contract example)', async () => {
    await put('gino', 'e-deposit-0001', body({ payers: [{ memberId: mid.abbie, amount: 30000 }] }));
    // Now Abbie paid the deposit: Gino owes her 7,500. Gino gets the ¥30,000 back.
    await put('gino', 'r-deposit-0001', refund());
    const g = await nets();
    // -7,500 for the deposit, -22,500 for the refund he holds.
    expect(g.myNet).toBe(-30000);
    const groupNet = (await call<MeDTO>('abbie', 'GET', '/api/me')).data.groups.find(x => x.id === gid)!;
    expect(groupNet.myNet).toBe(22500 + 7500);
    const only = await put('gino', 'e-deposit-0001', body({ kind: 'payment', description: '', payers: [{ memberId: mid.kevin, amount: 1 }], amount: 1, split: { method: 'exact', entries: [{ memberId: mid.tiffany, value: 1 }] } }));
    expect(only.status).toBe(200);
    // With the deposit out of the way (a tiny payment instead), the refund alone: -22,500 for Gino.
    expect((await nets()).myNet).toBe(-22500);
  });

  it('needs a description, never repeats, and keeps its category', async () => {
    const r = await put('gino', 'r-1-no-desc', refund({ description: '' }));
    expect(r.status).toBe(400);
    expect(r.data.error.details).toMatchObject({ code: 'description_required' });
    const rep = await put('gino', 'r-2-repeat', refund({ repeat: 'monthly' }));
    expect(rep.status).toBe(200);
    expect(rep.data.expense.repeat).toBe('none');
    expect(stored('r-2-repeat')).toMatchObject({ repeat: 'none', kind: 'refund' });
    expect(rep.data.expense.category).toBe('travel.hotel');
  });

  it('links only to an expense of the same group, and keeps the link when a save leaves it out', async () => {
    const pay = body({ kind: 'payment', description: '', payers: [{ memberId: mid.abbie, amount: 100 }], amount: 100, split: { method: 'exact', entries: [{ memberId: mid.gino, value: 100 }] } });
    await put('abbie', 'p-payment-01', pay);
    expect((await put('gino', 'r-a-000001', refund({ refundOf: 'p-payment-01' }))).data.expense.refundOf).toBeNull();
    expect((await put('gino', 'r-b-000001', refund({ refundOf: 'r-b-000001' }))).data.expense.refundOf).toBeNull();
    expect((await put('gino', 'r-c-000001', refund({ refundOf: 'no-such-entry' }))).data.expense.refundOf).toBeNull();
    expect((await put('gino', 'r-d-000001', refund({ refundOf: 'r-a-000001' }))).data.expense.refundOf).toBeNull();
    expect((await put('gino', 'r-e-000001', refund({ refundOf: 42 as never }))).status).toBe(200);
    // Another group's expense.
    const other = await call<GroupSnapshotDTO>('gino', 'POST', '/api/groups', { name: '別的', type: 'other', currency: 'JPY' });
    await call('gino', 'PUT', `/api/groups/${other.data.group.id}/expenses/e-other-0001`, { ...body(), payers: [{ memberId: other.data.me.memberId, amount: 30000 }], split: { method: 'equal', entries: [{ memberId: other.data.me.memberId }] } });
    expect((await put('gino', 'r-f-000001', refund({ refundOf: 'e-other-0001' }))).data.expense.refundOf).toBeNull();
    // An expense with a refundOf stores none.
    expect((await put('gino', 'e-g-000001', body({ refundOf: 'e-deposit-0001' }))).data.expense.refundOf).toBeNull();

    await put('gino', 'r-deposit-0001', refund());
    const { refundOf: _drop, ...noLink } = refund({ description: '退款：押金（一半）', amount: 15000, payers: [{ memberId: mid.gino, amount: 15000 }] });
    expect((await put('gino', 'r-deposit-0001', noLink)).data.expense.refundOf).toBe('e-deposit-0001');
    expect((await put('gino', 'r-deposit-0001', refund({ refundOf: null }))).data.expense.refundOf).toBeNull();
    // Made an expense, it loses the link.
    await put('gino', 'r-deposit-0001', refund());
    expect((await put('gino', 'r-deposit-0001', body({ description: '押金' }))).data.expense).toMatchObject({ kind: 'expense', refundOf: null });
  });

  it('works in another currency with the expense rate rules', async () => {
    const r = await put('gino', 'r-usd-00001', refund({ currency: 'USD', amount: 20000, fxRate: 150, rateBase: 'JPY', payers: [{ memberId: mid.abbie, amount: 20000 }] }));
    expect(r.status).toBe(200);
    expect(r.data.expense.fxRate).toBe(150);
    // US$200 at 150 = ¥30,000: Abbie holds it, each of the four had ¥7,500 of it.
    const abbie = (await call<MeDTO>('abbie', 'GET', '/api/me')).data.groups.find(x => x.id === gid)!;
    expect(abbie.myNet).toBe(-7500 - 22500);
    const missing = await put('gino', 'r-usd-00002', refund({ currency: 'USD', amount: 100, fxRate: null as never, payers: [{ memberId: mid.gino, amount: 100 }] }));
    expect(missing.status).toBe(400);
    expect(missing.data.error.details).toMatchObject({ code: 'invalid_fx_rate' });
  });

  it('activity rows keep kind refund with each person\'s effect', async () => {
    await put('gino', 'r-deposit-0001', refund());
    const feed = (await call<{ items: ActivityDTO[] }>('abbie', 'GET', '/api/activity')).data.items;
    const row = feed.find(a => a.expenseId === 'r-deposit-0001')!;
    expect(row.type).toBe('expense.create');
    expect(row.data.kind).toBe('refund');
    expect(row.data.nets).toEqual({ [mid.gino]: -22500, [mid.abbie]: 7500, [mid.kevin]: 7500, [mid.tiffany]: 7500 });
    const hist = (await call<{ items: ActivityDTO[] }>('gino', 'GET', `/api/groups/${gid}/expenses/r-deposit-0001/history`)).data.items;
    expect(hist.map(h => h.data.kind)).toEqual(['refund']);
  });
});

describe('a client that does not know refunds (compat.ts)', () => {
  beforeEach(async () => {
    await put('gino', 'r-deposit-0001', refund());
  });

  it('sees the refund as the expense the four paid for Gino, with the same balances', async () => {
    const s = await snap('kevin', old);
    const e = s.data.expenses.find(x => x.id === 'r-deposit-0001')!;
    expect(e.kind).toBe('expense');
    expect(e.payers).toEqual(FOUR().map(m => ({ memberId: m.memberId, amount: 7500 })));
    expect(e.split).toEqual({ method: 'exact', entries: [{ memberId: mid.gino, value: 30000 }] });
    expect(e.shares).toEqual([{ memberId: mid.gino, amount: 30000 }]);
    expect(e.description).toBe('退款：民宿押金');
    // The deposit itself is untouched.
    expect(s.data.expenses.find(x => x.id === 'e-deposit-0001')!.kind).toBe('expense');
    // GET /api/me is the same for both (no kinds in it).
    const a = (await call<MeDTO>('kevin', 'GET', '/api/me')).data;
    const b = (await call<MeDTO>('kevin', 'GET', '/api/me', undefined, old)).data;
    expect(b.groups).toEqual(a.groups);
    expect(b.totals).toEqual(a.totals);
  });

  it('gets its own ETag, so neither view is kept for the other on a 304', async () => {
    const legacy = await snap('kevin', old);
    const v = legacy.data.group.version;
    expect(legacy.etag).toBe(`"${v}-legacy"`);
    expect((await snap('kevin', { ...old, etag: `"${v}-legacy"` })).status).toBe(304);
    expect((await snap('kevin', { ...old, etag: `"${v}"` })).status).toBe(200);
    expect((await snap('kevin', { etag: `"${v}-legacy"` })).status).toBe(200);
    expect((await snap('kevin', { etag: `"${v}"` })).status).toBe(304);
  });

  it('reads the feed and the history with kind expense', async () => {
    await put('gino', 'r-deposit-0001', body({ description: '押金' }));
    const feed = (await call<{ items: ActivityDTO[] }>('abbie', 'GET', '/api/activity', undefined, old)).data.items.filter(a => a.expenseId === 'r-deposit-0001');
    expect(feed.map(a => a.data.kind)).toEqual(['expense', 'expense']);
    // The change of kind refund -> expense reads expense -> expense: it is left out.
    expect(feed[0].data.changes?.some(c => c.field === 'kind')).toBe(false);
    const capable = (await call<{ items: ActivityDTO[] }>('abbie', 'GET', '/api/activity')).data.items.filter(a => a.expenseId === 'r-deposit-0001');
    expect(capable[0].data.changes?.find(c => c.field === 'kind')).toEqual({ field: 'kind', from: 'refund', to: 'expense' });
    const hist = (await call<{ items: ActivityDTO[] }>('gino', 'GET', `/api/groups/${gid}/expenses/r-deposit-0001/history`, undefined, old)).data.items;
    expect(hist.map(h => h.data.kind)).toEqual(['expense', 'expense']);
  });

  it('an edit made in that view (with base) changes only what it changed, and the refund stays a refund', async () => {
    const seen = (await snap('kevin', old)).data.expenses.find(x => x.id === 'r-deposit-0001')!;
    const baseBody = {
      kind: seen.kind, description: seen.description, category: seen.category, amount: seen.amount, currency: seen.currency, fxRate: seen.fxRate,
      date: seen.date, notes: seen.notes, payers: seen.payers, split: seen.split, repeat: seen.repeat,
    };
    const r = await put('kevin', 'r-deposit-0001', { ...baseBody, description: '退款：民宿押金（全額）', base: baseBody, baseVersion: seen.version }, old);
    expect(r.status).toBe(200);
    // The answer is in the view the client knows.
    expect(r.data.expense.kind).toBe('expense');
    expect(r.data.expense.description).toBe('退款：民宿押金（全額）');
    const row = stored('r-deposit-0001');
    expect(row.kind).toBe('refund');
    expect(JSON.parse(row.split)).toEqual({ method: 'equal', entries: FOUR() });
    expect(JSON.parse(row.payers)).toEqual([{ memberId: mid.gino, amount: 30000 }]);
    expect(row.refund_of).toBe('e-deposit-0001');
    expect((await nets()).myNet).toBe(0);
  });

  it('an edit of the money in that view is read back the other way round', async () => {
    const seen = (await snap('kevin', old)).data.expenses.find(x => x.id === 'r-deposit-0001')!;
    const baseBody = {
      kind: seen.kind, description: seen.description, category: seen.category, amount: seen.amount, currency: seen.currency, fxRate: seen.fxRate,
      date: seen.date, notes: seen.notes, payers: seen.payers, split: seen.split, repeat: seen.repeat,
    };
    // Only ¥20,000 came back: in the old view, each of the four "paid" 5,000 and it is all Gino's.
    const mine = {
      ...baseBody, amount: 20000,
      payers: FOUR().map(m => ({ memberId: m.memberId, amount: 5000 })),
      split: { method: 'exact', entries: [{ memberId: mid.gino, value: 20000 }] },
    };
    const r = await put('kevin', 'r-deposit-0001', { ...mine, base: baseBody, baseVersion: seen.version }, old);
    expect(r.status).toBe(200);
    expect(r.data.expense).toMatchObject({ kind: 'expense', amount: 20000 });
    const row = stored('r-deposit-0001');
    expect(row.kind).toBe('refund');
    expect(row.amount).toBe(20000);
    expect(JSON.parse(row.payers)).toEqual([{ memberId: mid.gino, amount: 20000 }]);
    expect(JSON.parse(row.split)).toEqual({ method: 'exact', entries: FOUR().map(m => ({ memberId: m.memberId, value: 5000 })) });
    // Deposit +22,500, refund -15,000.
    expect((await nets()).myNet).toBe(7500);
    // For a client that knows refunds it is the refund it was.
    const now = (await snap('gino')).data.expenses.find(x => x.id === 'r-deposit-0001')!;
    expect(now).toMatchObject({ kind: 'refund', refundOf: 'e-deposit-0001' });
  });

  it('a save without base (an older outbox) goes through the same way', async () => {
    const seen = (await snap('kevin', old)).data.expenses.find(x => x.id === 'r-deposit-0001')!;
    const r = await put('kevin', 'r-deposit-0001', {
      kind: seen.kind, description: '押金退回', category: seen.category, amount: seen.amount, currency: seen.currency, fxRate: seen.fxRate,
      date: seen.date, notes: '', payers: seen.payers, split: seen.split, baseVersion: seen.version,
    }, old);
    expect(r.status).toBe(200);
    expect(stored('r-deposit-0001')).toMatchObject({ kind: 'refund', description: '押金退回' });
    expect(JSON.parse(stored('r-deposit-0001').split).method).toBe('equal');
  });

  it('an edit queued in that view and sent after the app learned refunds is still read in it', async () => {
    const seen = (await snap('kevin', old)).data.expenses.find(x => x.id === 'r-deposit-0001')!;
    const baseBody = {
      kind: seen.kind, description: seen.description, category: seen.category, amount: seen.amount, currency: seen.currency, fxRate: seen.fxRate,
      date: seen.date, notes: seen.notes, payers: seen.payers, split: seen.split, repeat: seen.repeat,
    };
    const r = await put('kevin', 'r-deposit-0001', { ...baseBody, notes: '退到 Gino 的卡', base: baseBody, baseVersion: seen.version });
    expect(r.status).toBe(200);
    expect(r.data.expense).toMatchObject({ kind: 'refund', notes: '退到 Gino 的卡', refundOf: 'e-deposit-0001' });
    expect(JSON.parse(stored('r-deposit-0001').split).method).toBe('equal');
  });

  it('a client that knows refunds can still make one an expense', async () => {
    const seen = (await snap('gino')).data.expenses.find(x => x.id === 'r-deposit-0001')!;
    const baseBody = {
      kind: seen.kind, description: seen.description, category: seen.category, amount: seen.amount, currency: seen.currency, fxRate: seen.fxRate,
      date: seen.date, notes: seen.notes, payers: seen.payers, split: seen.split, repeat: seen.repeat,
    };
    const r = await put('gino', 'r-deposit-0001', { ...baseBody, kind: 'expense', base: baseBody, baseVersion: seen.version });
    expect(r.status).toBe(200);
    expect(stored('r-deposit-0001')).toMatchObject({ kind: 'expense', refund_of: null });
    // Two deposits now: Gino is owed 45,000.
    expect((await nets()).myNet).toBe(45000);
  });

  it('a conflict answers with the entry in the client\'s view', async () => {
    const seen = (await snap('kevin', old)).data.expenses.find(x => x.id === 'r-deposit-0001')!;
    const baseBody = {
      kind: seen.kind, description: seen.description, category: seen.category, amount: seen.amount, currency: seen.currency, fxRate: seen.fxRate,
      date: seen.date, notes: seen.notes, payers: seen.payers, split: seen.split, repeat: seen.repeat,
    };
    // Gino changes the description meanwhile.
    await put('gino', 'r-deposit-0001', refund({ description: '退款：押金' }));
    const r = await put('kevin', 'r-deposit-0001', { ...baseBody, description: '押金回來了', base: baseBody, baseVersion: seen.version }, old);
    expect(r.status).toBe(409);
    expect(r.data.error.details.fields).toEqual(['description']);
    expect(r.data.error.details.expense).toMatchObject({ kind: 'expense', description: '退款：押金' });
    expect(r.data.error.details.expense.split.method).toBe('exact');
  });

  it('delete and restore answer in its view, and the refund comes back as a refund', async () => {
    const del = await call<{ expense: ExpenseDTO }>('kevin', 'DELETE', `/api/groups/${gid}/expenses/r-deposit-0001`, undefined, old);
    expect(del.status).toBe(200);
    expect(del.data.expense.kind).toBe('expense');
    expect((await nets()).myNet).toBe(22500);
    const back = await call<{ expense: ExpenseDTO }>('kevin', 'POST', `/api/groups/${gid}/expenses/r-deposit-0001/restore`, undefined, old);
    expect(back.data.expense.kind).toBe('expense');
    expect(stored('r-deposit-0001').kind).toBe('refund');
    expect((await nets()).myNet).toBe(0);
  });

  it('the export keeps refunds as refunds for every client', async () => {
    const x = await call<{ groups: GroupSnapshotDTO[] }>('kevin', 'GET', '/api/me/export', undefined, old);
    const e = x.data.groups.find(g => g.group.id === gid)!.expenses.find(y => y.id === 'r-deposit-0001')!;
    expect(e).toMatchObject({ kind: 'refund', refundOf: 'e-deposit-0001' });
  });
});

describe('import', () => {
  it('takes refunds (without a link) like expenses', async () => {
    const r = await call<{ imported: number; skipped: unknown[] }>('gino', 'POST', `/api/groups/${gid}/import`, {
      expenses: [{ id: 'imp-refund-0001', ...refund({ refundOf: 'e-deposit-0001' }) }],
    });
    expect(r.data).toMatchObject({ imported: 1, skipped: [] });
    expect(stored('imp-refund-0001')).toMatchObject({ kind: 'refund', refund_of: null });
    expect((await nets()).myNet).toBe(0);
  });
});
