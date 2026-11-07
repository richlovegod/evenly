// The iPhone app's 復原 of an edit (review I1-correct-07): EditorForm.save (記一筆) and
// SettleForm.commit (記錄還款) build it from the copy the form opened with, its `rateBase` the group
// currency that copy's rate is for (openedBase), merged against what the save sent. It used to be
// built from the phone's live copy of the group at the save, which already held the edit when a
// first try of the save had landed with its answer lost (the page's poll brought it in), so 復原
// changed nothing while it said 已復原. On the real PUT route and schema (tests/worker/d1-sqlite.ts),
// with the bodies shaped as the iPhone sends them. The web editor's 復原 is in w1-edit-merge.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ rates: {} as Record<string, number> }));

vi.mock('../../src/worker/services/fx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/worker/services/fx')>();
  return { ...actual, getUsdRates: vi.fn(async (_db: unknown, date: string) => ({ date, rates: { ...fx.rates }, source: 'test' })) };
});

import { todayUTC } from '../../src/shared/dates';
import type { ExpenseDTO, GroupSnapshotDTO, UpsertExpenseReq, UpsertExpenseRes } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { TestD1 } from './d1-sqlite';

const TODAY = todayUTC();

let db: TestD1;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  data: T;
}

async function api<T = any>(user: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const h: Record<string, string> = { Authorization: 'Bearer ' + tokens[user] };
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

/** A trip of Ann (uA, member A) and Bea (uB, member B). */
interface G {
  gid: string;
  A: string;
  B: string;
}

async function newGroup(currency: string): Promise<G> {
  const r = await api<GroupSnapshotDTO>('uA', 'POST', '/api/groups', { name: 'tokyo', type: 'trip', currency, members: [{ name: 'Bea', email: 'b@evenly.test' }] });
  expect(r.status).toBe(200);
  const id = (name: string) => r.data.members.find(m => m.name === name)!.id;
  return { gid: r.data.group.id, A: id('Ann'), B: id('Bea') };
}

type Body = Omit<UpsertExpenseReq, 'base' | 'baseVersion'>;

const put = (user: string, g: G, eid: string, body: UpsertExpenseReq) => api<UpsertExpenseRes>(user, 'PUT', `/api/groups/${g.gid}/expenses/${eid}`, body);
const stored = async (g: G, eid: string): Promise<ExpenseDTO> =>
  (await api<GroupSnapshotDTO>('uA', 'GET', '/api/groups/' + g.gid)).data.expenses.find(e => e.id === eid)!;

/** The iPhone's ExpenseBody(e): the stored fields, rateBase left out (the form sets it). */
function bodyOf(e: ExpenseDTO): Body {
  return {
    kind: e.kind, description: e.description, category: e.category, amount: e.amount, currency: e.currency, fxRate: e.fxRate,
    date: e.date, notes: e.notes, payers: e.payers, split: e.split, repeat: e.repeat,
  };
}

beforeEach(async () => {
  fx.rates = { USD: 1, TWD: 32.3, JPY: 150.2 };
  db = new TestD1();
  await addUser('uA', 'Ann', 'a@evenly.test');
  await addUser('uB', 'Bea', 'b@evenly.test');
});

describe('a retried save whose first try landed, then 復原', () => {
  /** Ann's form opens on NT$3,000 and she saves NT$3,600 twice: the first try lands, its answer is lost. */
  async function landedTwice() {
    const g = await newGroup('TWD');
    const eid = 'dinner-00000001';
    const split: UpsertExpenseReq['split'] = { method: 'equal', entries: [{ memberId: g.A }, { memberId: g.B }] };
    const first: UpsertExpenseReq = {
      kind: 'expense', description: 'dinner', category: 'food.dining', amount: 3000, currency: 'TWD', fxRate: 1, date: TODAY,
      notes: '', payers: [{ memberId: g.A, amount: 3000 }], split, repeat: 'none', rateBase: 'TWD',
    };
    expect((await put('uA', g, eid, first)).status).toBe(200);
    const opened = await stored(g, eid);
    const payload: Body = { ...bodyOf(opened), amount: 3600, payers: [{ memberId: g.A, amount: 3600 }], rateBase: 'TWD' };
    const req: UpsertExpenseReq = { ...payload, baseVersion: opened.version, base: { ...bodyOf(opened), rateBase: 'TWD' } };
    // The first try lands, its answer is lost; the page's poll brings the saved copy.
    expect((await put('uA', g, eid, req)).status).toBe(200);
    const live = await stored(g, eid);
    expect(live.amount).toBe(3600);
    // 儲存 again: the same request, which changes nothing.
    const saved = await put('uA', g, eid, req);
    expect(saved.status).toBe(200);
    return { g, eid, opened, live, payload, saved };
  }

  it('from the opened copy (now): the amount goes back', async () => {
    const { g, eid, opened, payload, saved } = await landedTwice();
    const undo = await put('uA', g, eid, { ...bodyOf(opened), rateBase: 'TWD', baseVersion: saved.data.expense.version, base: payload });
    expect(undo.status).toBe(200);
    expect((await stored(g, eid)).amount).toBe(3000);
  });

  it('(as it was) from the live copy: nothing changes', async () => {
    const { g, eid, live, payload, saved } = await landedTwice();
    const undo = await put('uA', g, eid, { ...bodyOf(live), rateBase: 'TWD', baseVersion: saved.data.expense.version, base: payload });
    expect(undo.status).toBe(200);
    expect((await stored(g, eid)).amount).toBe(3600);
  });
});

describe('the group currency changed while the form was open, then 復原 from the opened copy', () => {
  it('an expense: amount and the re-based rate come back', async () => {
    const g = await newGroup('TWD');
    const eid = 'dinner-00000002';
    const split: UpsertExpenseReq['split'] = { method: 'equal', entries: [{ memberId: g.A }, { memberId: g.B }] };
    const first: UpsertExpenseReq = {
      kind: 'expense', description: 'dinner', category: 'food.dining', amount: 3000, currency: 'TWD', fxRate: 1, date: TODAY,
      notes: 'note', payers: [{ memberId: g.A, amount: 3000 }], split, repeat: 'none', rateBase: 'TWD',
    };
    expect((await put('uA', g, eid, first)).status).toBe(200);
    const opened = await stored(g, eid);
    expect((await api('uB', 'PATCH', '/api/groups/' + g.gid, { currency: 'JPY' })).status).toBe(200);
    const live = await stored(g, eid);
    const k = live.fxRate;
    const payload: Body = { ...bodyOf(opened), amount: 3600, payers: [{ memberId: g.A, amount: 3600 }], fxRate: k, rateBase: 'JPY' };
    const saved = await put('uA', g, eid, { ...payload, baseVersion: opened.version, base: { ...bodyOf(opened), rateBase: 'TWD' } });
    expect(saved.status).toBe(200);
    // Bea adds a note meanwhile: it stays.
    const withNote = await stored(g, eid);
    const noted = await put('uB', g, eid, {
      ...bodyOf(withNote), notes: 'note, Bea', rateBase: 'JPY', baseVersion: withNote.version, base: { ...bodyOf(withNote), rateBase: 'JPY' },
    });
    expect(noted.status).toBe(200);
    const undo = await put('uA', g, eid, { ...bodyOf(opened), rateBase: 'TWD', baseVersion: noted.data.expense.version, base: payload });
    expect(undo.status).toBe(200);
    expect(await stored(g, eid)).toMatchObject({ amount: 3000, currency: 'TWD', fxRate: k, notes: 'note, Bea' });
  });

  it('a USD expense in the TWD group: its rate is moved onto JPY as the stored one was', async () => {
    const g = await newGroup('TWD');
    const eid = 'dinner-00000003';
    const split: UpsertExpenseReq['split'] = { method: 'equal', entries: [{ memberId: g.A }, { memberId: g.B }] };
    const first: UpsertExpenseReq = {
      kind: 'expense', description: 'dinner', category: 'food.dining', amount: 10000, currency: 'USD', fxRate: 31.4, date: TODAY,
      notes: '', payers: [{ memberId: g.A, amount: 10000 }], split, repeat: 'none', rateBase: 'TWD',
    };
    expect((await put('uA', g, eid, first)).status).toBe(200);
    const opened = await stored(g, eid);
    expect((await api('uB', 'PATCH', '/api/groups/' + g.gid, { currency: 'JPY' })).status).toBe(200);
    const live = await stored(g, eid);
    const payload: Body = { ...bodyOf(opened), amount: 12000, payers: [{ memberId: g.A, amount: 12000 }], fxRate: live.fxRate, rateBase: 'JPY' };
    const saved = await put('uA', g, eid, { ...payload, baseVersion: opened.version, base: { ...bodyOf(opened), rateBase: 'TWD' } });
    expect(saved.status).toBe(200);
    const undo = await put('uA', g, eid, { ...bodyOf(opened), rateBase: 'TWD', baseVersion: saved.data.expense.version, base: payload });
    expect(undo.status).toBe(200);
    expect(await stored(g, eid)).toMatchObject({ amount: 10000, currency: 'USD', fxRate: live.fxRate });
  });

  it('a payment (記錄還款): amount and the re-based rate come back', async () => {
    const g = await newGroup('TWD');
    const eid = 'pay-00000001';
    /** As SettleForm.commit builds it: Bea paid Ann `amount`, at `rate`. */
    const pay = (amount: number, rate: number): Body => ({
      kind: 'payment', description: '', category: 'payment', amount, currency: 'TWD', fxRate: rate, date: TODAY, notes: '',
      payers: [{ memberId: g.B, amount }], split: { method: 'exact', entries: [{ memberId: g.A, value: amount }] },
    });
    expect((await put('uA', g, eid, { ...pay(1000, 1), rateBase: 'TWD' })).status).toBe(200);
    const opened = await stored(g, eid);
    expect((await api('uB', 'PATCH', '/api/groups/' + g.gid, { currency: 'JPY' })).status).toBe(200);
    const live = await stored(g, eid);
    const entry: Body = { ...pay(1200, live.fxRate), repeat: opened.repeat, rateBase: 'JPY' };
    const saved = await put('uA', g, eid, { ...entry, baseVersion: opened.version, base: { ...bodyOf(opened), rateBase: 'TWD' } });
    expect(saved.status).toBe(200);
    const undo = await put('uA', g, eid, { ...bodyOf(opened), rateBase: 'TWD', baseVersion: saved.data.expense.version, base: entry });
    expect(undo.status).toBe(200);
    expect(await stored(g, eid)).toMatchObject({ amount: 1000, currency: 'TWD', fxRate: live.fxRate });
  });
});
