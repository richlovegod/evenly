// The Worker's routes end to end against the real schema in SQLite (tests/worker/d1-sqlite.ts),
// with real sessions; only the exchange-rate provider is replaced. Covers saves that arrive late
// (a rate chosen against an older group currency, an edit made from an older copy of the entry),
// the shares of recurring copies, the nets in activity rows, and group versions after someone
// changes their payment details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ rates: {} as Record<string, number> }));

vi.mock('../../src/worker/services/fx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/worker/services/fx')>();
  return { ...actual, getUsdRates: vi.fn(async (_db: unknown, date: string) => ({ date, rates: { ...fx.rates }, source: 'test' })) };
});

import { entryNet, netBalances, type LedgerEntry } from '../../src/shared/balances';
import { addDays, todayUTC } from '../../src/shared/dates';
import { computeSharesFor, type Portion, type SplitInput } from '../../src/shared/split';
import type { ActivityDTO, ExpenseDTO, GroupSnapshotDTO, MeDTO } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { rateToBase } from '../../src/worker/services/fx';
import { TestD1 } from './d1-sqlite';

const START_RATES = { USD: 1, TWD: 32.3, JPY: 150.2, EUR: 0.92 };
const TODAY = todayUTC();

let db: TestD1;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  data: T;
  etag: string | null;
}

async function api<T = any>(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  const h: Record<string, string> = { ...headers };
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request('http://api.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'http://app.test/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined, etag: res.headers.get('ETag') };
}

async function addUser(id: string, name: string, email: string): Promise<void> {
  const now = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, email, '#2F6FB5', now, now);
  tokens[id] = await createSession(db.d1, id, 'test');
}

interface Group {
  gid: string;
  /** Member ids: A and B have accounts (uA, uB), C is a placeholder. */
  A: string;
  B: string;
  C: string;
}

async function newGroup(currency: string): Promise<Group> {
  const r = await api<GroupSnapshotDTO>('uA', 'POST', '/api/groups', {
    name: 'test-trip', type: 'trip', currency, members: [{ name: 'Bea', email: 'b@evenly.test' }, { name: 'Cy' }],
  });
  expect(r.status).toBe(200);
  const id = (name: string) => r.data.members.find(m => m.name === name)!.id;
  return { gid: r.data.group.id, A: id('Ann'), B: id('Bea'), C: id('Cy') };
}

type Body = Record<string, unknown>;

function expense(g: Group, over: Body = {}): Body {
  const amount = (over.amount as number | undefined) ?? 300;
  return {
    kind: 'expense', description: 'dinner', category: 'food.dining', amount, currency: 'TWD', fxRate: 1, date: TODAY,
    payers: [{ memberId: g.A, amount }], split: { method: 'equal', entries: [{ memberId: g.A }, { memberId: g.B }] },
    ...over,
  };
}

const put = (user: string, g: Group, eid: string, body: unknown) => api<{ expense: ExpenseDTO; groupVersion: number }>(user, 'PUT', `/api/groups/${g.gid}/expenses/${eid}`, body);
const snapshot = async (user: string, g: Group) => (await api<GroupSnapshotDTO>(user, 'GET', '/api/groups/' + g.gid)).data;
const stored = async (g: Group, eid: string) => (await snapshot('uA', g)).expenses.find(e => e.id === eid)!;
const history = async (g: Group, eid: string) => (await api<{ items: ActivityDTO[] }>('uA', 'GET', `/api/groups/${g.gid}/expenses/${eid}/history`)).data.items;

function ledger(e: ExpenseDTO): LedgerEntry {
  return { id: e.id, kind: e.kind, amount: e.amount, currency: e.currency, fxRate: e.fxRate, payers: e.payers, shares: e.shares };
}

const net = (e: LedgerEntry, base: string) => Object.fromEntries(entryNet(e, base));

beforeEach(async () => {
  fx.rates = { ...START_RATES };
  db = new TestD1();
  await addUser('uA', 'Ann', 'a@evenly.test');
  await addUser('uB', 'Bea', 'b@evenly.test');
});

// ---------- rates chosen against an older group currency ----------

describe('a save whose rate was chosen against an older group currency', () => {
  it('is converted like the stored entries were, also when it was queued without rateBase (fxRate 1)', async () => {
    const g = await newGroup('TWD');
    expect((await put('uA', g, 'ctrl-0001', expense(g))).status).toBe(200);
    expect((await api('uB', 'PATCH', '/api/groups/' + g.gid, { currency: 'USD' })).status).toBe(200);
    const k = rateToBase(START_RATES, 'TWD', 'USD');
    expect((await stored(g, 'ctrl-0001')).fxRate).toBe(k);

    // What an outbox holds for NT$300 saved offline while the group was still TWD.
    const late = await put('uA', g, 'late-0001', expense(g, { description: 'queued before the switch' }));
    expect(late.status).toBe(200);
    expect(late.data.expense).toMatchObject({ currency: 'TWD', amount: 300, fxRate: k });
    // The same body from an app that says which group currency it meant.
    const said = await put('uA', g, 'late-0002', expense(g, { rateBase: 'TWD' }));
    expect(said.data.expense.fxRate).toBe(k);

    // A paid NT$300 three times, half for B: about US$4.64 each, not US$150.
    const me = (await api<MeDTO>('uA', 'GET', '/api/me')).data;
    const myNet = me.groups.find(x => x.id === g.gid)!.myNet;
    expect(myNet).toBe(netBalances((await snapshot('uA', g)).expenses.map(ledger), 'USD')[g.A]);
    expect(myNet).toBeGreaterThan(1380);
    expect(myNet).toBeLessThan(1410);
  });

  it('logs the rate a currency change used, and only when it converted something', async () => {
    const g = await newGroup('TWD');
    await api('uA', 'PATCH', '/api/groups/' + g.gid, { currency: 'JPY' }); // nothing to convert yet
    await put('uA', g, 'ctrl-0001', expense(g, { currency: 'JPY', amount: 1000 }));
    await api('uA', 'PATCH', '/api/groups/' + g.gid, { currency: 'USD' });
    const changes = db
      .rows<{ data: string }>(`SELECT data FROM activity WHERE group_id = ? AND type = 'group.update' ORDER BY created_at, rowid`, g.gid)
      .map(r => JSON.parse(r.data).changes);
    expect(changes).toEqual([
      [{ field: 'currency', from: 'TWD', to: 'JPY' }],
      [{ field: 'currency', from: 'JPY', to: 'USD', rate: rateToBase(START_RATES, 'JPY', 'USD') }],
    ]);
  });

  it('goes through every change since, with the rates those changes used, not today\'s', async () => {
    const g = await newGroup('TWD');
    await put('uA', g, 'ctrl-twd1', expense(g));
    await put('uA', g, 'ctrl-eur1', expense(g, { currency: 'EUR', amount: 1000, fxRate: 35.1 }));
    await api('uA', 'PATCH', '/api/groups/' + g.gid, { currency: 'USD' });
    fx.rates = { ...START_RATES, TWD: 31, JPY: 140 };
    await api('uA', 'PATCH', '/api/groups/' + g.gid, { currency: 'JPY' });
    fx.rates = { ...START_RATES, TWD: 30, JPY: 160 }; // today's rates moved again

    const twd = await put('uA', g, 'late-twd1', expense(g, { rateBase: 'TWD' }));
    expect(twd.data.expense.fxRate).toBe((await stored(g, 'ctrl-twd1')).fxRate);
    const eur = await put('uA', g, 'late-eur1', expense(g, { currency: 'EUR', amount: 1000, fxRate: 35.1, rateBase: 'TWD' }));
    expect(eur.data.expense.fxRate).toBe((await stored(g, 'ctrl-eur1')).fxRate);
    // In the group currency now: always 1.
    const jpy = await put('uA', g, 'late-jpy1', expense(g, { currency: 'JPY', amount: 5000, fxRate: 0.2, rateBase: 'TWD' }));
    expect(jpy.data.expense.fxRate).toBe(1);
    // Rates against the current group currency are kept as typed.
    const now = await put('uA', g, 'late-eur2', expense(g, { currency: 'EUR', amount: 1000, fxRate: 171.5, rateBase: 'JPY' }));
    expect(now.data.expense.fxRate).toBe(171.5);
  });

  it('uses today\'s rate for a currency the history does not show, and keeps a typed 1 for a currency the group never had', async () => {
    const g = await newGroup('USD');
    const said = await put('uA', g, 'eur-said1', expense(g, { currency: 'EUR', amount: 1000, fxRate: 1, rateBase: 'EUR' }));
    expect(said.data.expense.fxRate).toBe(rateToBase(START_RATES, 'EUR', 'USD'));
    const typed = await put('uA', g, 'eur-typed', expense(g, { currency: 'EUR', amount: 1000, fxRate: 1 }));
    expect(typed.data.expense.fxRate).toBe(1);
    const none = await put('uA', g, 'xaf-said1', expense(g, { currency: 'XAF', amount: 1000, fxRate: 1, rateBase: 'XAF' }));
    expect(none.status).toBe(400);
    expect(none.data.error.details).toMatchObject({ code: 'invalid_fx_rate', field: 'fxRate' });
  });

  it('is converted in an import too', async () => {
    const g = await newGroup('TWD');
    await put('uA', g, 'ctrl-0001', expense(g));
    await api('uA', 'PATCH', '/api/groups/' + g.gid, { currency: 'USD' });
    const r = await api('uA', 'POST', `/api/groups/${g.gid}/import`, {
      expenses: [
        { id: 'imp-00001', ...expense(g, { rateBase: 'TWD' }) },
        { id: 'imp-00002', ...expense(g, { currency: 'XAF', fxRate: 2, rateBase: 'XAF' }) },
      ],
    });
    expect(r.data).toMatchObject({ imported: 1, skipped: [{ index: 1, code: 'invalid_fx_rate', field: 'fxRate' }] });
    expect((await stored(g, 'imp-00001')).fxRate).toBe((await stored(g, 'ctrl-0001')).fxRate);
  });
});

// ---------- recurring copies ----------

describe('recurring copies', () => {
  const split3 = (g: Group): SplitInput => ({ method: 'equal', entries: [{ memberId: g.A }, { memberId: g.B }, { memberId: g.C }] });

  it('get shares and activity nets for their own id, and a later description-only save moves nothing', async () => {
    const g = await newGroup('TWD');
    const head = expense(g, { amount: 100, payers: [{ memberId: g.B, amount: 100 }], split: split3(g), repeat: 'weekly', date: addDays(TODAY, -15) });
    expect((await put('uA', g, 'head-0001', head)).status).toBe(200);
    const copies = (await snapshot('uA', g)).expenses.filter(e => e.id !== 'head-0001' && !e.deletedAt);
    expect(copies).toHaveLength(2);
    for (const c of copies) {
      const want = computeSharesFor(c.id, 100, c.split);
      if (!want.ok) throw new Error('fixture');
      expect(c.shares).toEqual(want.shares);
      const [row] = db.rows<{ data: string }>(`SELECT data FROM activity WHERE type = 'recurring.create' AND expense_id = ?`, c.id);
      expect(JSON.parse(row.data).nets).toEqual(net(ledger(c), 'TWD'));
    }

    const c = copies[0];
    const r = await put('uA', g, c.id, { ...c, description: 'weekly cleaning (fixed typo)', baseVersion: c.version });
    expect(r.status).toBe(200);
    expect(r.data.expense.shares).toEqual(c.shares);
    expect((await history(g, c.id)).at(-1)!.data.changes).toEqual([{ field: 'description', from: 'dinner', to: 'weekly cleaning (fixed typo)' }]);
  });

  it('an older copy stored with its head\'s shares keeps them when saved again (and Undo restores it exactly)', async () => {
    const g = await newGroup('TWD');
    const split = split3(g);
    const headShares = computeSharesFor('head-0001', 100, split);
    if (!headShares.ok) throw new Error('fixture');
    // A copy made before copies got their own shares: an id whose own rounding differs.
    let id = '';
    for (let i = 0; !id; i++) {
      const s = computeSharesFor(`oldcopy-${i}`, 100, split);
      if (s.ok && JSON.stringify(s.shares) !== JSON.stringify(headShares.shares)) id = `oldcopy-${i}`;
    }
    const now = new Date().toISOString();
    db.exec(
      `INSERT INTO expenses (id, group_id, kind, description, category, amount, currency, fx_rate, date, notes, payers, split, shares,
         repeat, repeat_series, repeat_start, created_by, created_at, updated_by, updated_at, version)
       VALUES (?, ?, 'expense', 'cleaning', 'general', 100, 'TWD', 1, ?, '', ?, ?, ?, 'none', 'head-0001', ?, 'uA', ?, 'uA', ?, 1)`,
      id, g.gid, addDays(TODAY, -7), JSON.stringify([{ memberId: g.B, amount: 100 }]), JSON.stringify(split), JSON.stringify(headShares.shares),
      addDays(TODAY, -14), now, now,
    );
    const before = await stored(g, id);
    const edited = await put('uA', g, id, { ...before, description: 'cleaning (typo fixed)' });
    expect(edited.data.expense.shares).toEqual(headShares.shares);
    expect((await history(g, id)).at(-1)!.data.changes!.map(c => c.field)).toEqual(['description']);
    const undo = await put('uA', g, id, { ...before });
    expect(undo.data.expense).toMatchObject({ description: 'cleaning', shares: headShares.shares });
    // A different split still recomputes.
    const two = await put('uA', g, id, { ...before, split: { method: 'equal', entries: [{ memberId: g.A }, { memberId: g.B }] } });
    expect(two.data.expense.shares).toEqual([{ memberId: g.A, amount: 50 }, { memberId: g.B, amount: 50 }]);
  });
});

// ---------- activity nets ----------

describe('activity nets', () => {
  it('are the entry\'s own effect: the rounding of a converted amount follows the entry id', async () => {
    const g = await newGroup('TWD');
    const split = { method: 'equal', entries: [{ memberId: g.A }, { memberId: g.B }, { memberId: g.C }] } as SplitInput;
    const body = expense(g, { currency: 'JPY', amount: 1200, fxRate: 0.2040268032, payers: [{ memberId: g.C, amount: 1200 }], split });
    // An id whose rounding ties break differently from an empty id (what activity used to use).
    let eid = '';
    for (let i = 0; !eid; i++) {
      const id = `nets-${String(i).padStart(4, '0')}`;
      const shares = computeSharesFor(id, 1200, split);
      if (!shares.ok) continue;
      const e: LedgerEntry = { id, kind: 'expense', amount: 1200, currency: 'JPY', fxRate: 0.2040268032, payers: [{ memberId: g.C, amount: 1200 }], shares: shares.shares };
      if (JSON.stringify(net(e, 'TWD')) !== JSON.stringify(net({ ...e, id: '' }, 'TWD'))) eid = id;
    }
    const r = await put('uA', g, eid, body);
    const want = net(ledger(r.data.expense), 'TWD');
    const nets = (type: string) => JSON.parse(db.rows<{ data: string }>(`SELECT data FROM activity WHERE type = ? AND expense_id = ?`, type, eid)[0].data).nets;
    expect(nets('expense.create')).toEqual(want);
    await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/${eid}`);
    expect(nets('expense.delete')).toEqual(want);
  });
});

// ---------- payment details ----------

describe('payment details in cached group snapshots', () => {
  it('a new Venmo or bank detail moves the group version, so a device with the old ETag gets it', async () => {
    const g = await newGroup('TWD');
    await api('uB', 'PATCH', '/api/me', { venmo: 'test-old', payInfo: '舊帳號 012-345' });
    const first = await api<GroupSnapshotDTO>('uA', 'GET', '/api/groups/' + g.gid);
    expect(first.data.members.find(m => m.id === g.B)).toMatchObject({ venmo: 'test-old', payInfo: '舊帳號 012-345' });

    await api('uB', 'PATCH', '/api/me', { venmo: 'test-new', payInfo: '新帳號 999-888' });
    const again = await api<GroupSnapshotDTO>('uA', 'GET', '/api/groups/' + g.gid, undefined, { 'If-None-Match': first.etag! });
    expect(again.status).toBe(200);
    expect(again.data.members.find(m => m.id === g.B)).toMatchObject({ venmo: 'test-new', payInfo: '新帳號 999-888' });

    // Details added by someone who had none, and a PayPal change, too.
    await api('uB', 'PATCH', '/api/me', { paypal: 'bea' });
    expect((await api('uA', 'GET', '/api/groups/' + g.gid, undefined, { 'If-None-Match': again.etag! })).status).toBe(200);
  });

  it('other profile changes leave the version alone, and a current stored summary stays current', async () => {
    const g = await newGroup('TWD');
    await put('uA', g, 'ctrl-0001', expense(g));
    await api('uA', 'GET', '/api/me'); // stores a current summary
    const first = await api('uA', 'GET', '/api/groups/' + g.gid);
    await api('uB', 'PATCH', '/api/me', { locale: 'en', currency: 'USD', color: '#C2410C' });
    expect((await api('uA', 'GET', '/api/groups/' + g.gid, undefined, { 'If-None-Match': first.etag! })).status).toBe(304);
    await api('uB', 'PATCH', '/api/me', { venmo: 'bea-v' });
    const [row] = db.rows<{ version: number; summary: string }>('SELECT version, summary FROM groups WHERE id = ?', g.gid);
    expect(JSON.parse(row.summary).forVersion).toBe(row.version);
  });

  it('a new account name renames the members still named after it and moves their group versions', async () => {
    const g = await newGroup('TWD');
    const first = await api('uA', 'GET', '/api/groups/' + g.gid);
    await api('uB', 'PATCH', '/api/me', { name: 'Bea Chen' });
    const again = await api<GroupSnapshotDTO>('uA', 'GET', '/api/groups/' + g.gid, undefined, { 'If-None-Match': first.etag! });
    expect(again.status).toBe(200);
    expect(again.data.members.find(m => m.id === g.B)!.name).toBe('Bea Chen');
  });
});

// ---------- edits made from an older copy of the entry ----------

describe('a save made from an older copy of the entry', () => {
  /** X: NT$1,000 paid by A, split between A, B and C; then A changed the amount to NT$1,600. */
  async function setup() {
    const g = await newGroup('TWD');
    const split = { method: 'equal', entries: [{ memberId: g.A }, { memberId: g.B }, { memberId: g.C }] };
    const v1 = expense(g, { amount: 1000, payers: [{ memberId: g.A, amount: 1000 }], split });
    await put('uA', g, 'entry-x01', v1);
    const v2 = { ...v1, amount: 1600, payers: [{ memberId: g.A, amount: 1600 }] };
    expect((await put('uA', g, 'entry-x01', { ...v2, baseVersion: 1 })).status).toBe(200);
    return { g, v1, v2 };
  }

  it('without base: refused when someone else changed the entry since, and it would change it', async () => {
    const { g, v1 } = await setup();
    const r = await put('uB', g, 'entry-x01', { ...v1, description: 'dinner, B', baseVersion: 1 });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('conflict');
    expect(r.data.error.details).toMatchObject({ code: 'edited_elsewhere', fields: ['money', 'description'], expense: { amount: 1600, version: 2 } });
    expect((await stored(g, 'entry-x01')).amount).toBe(1600);
  });

  it('without base: my own undo, an identical save and a baseVersion ahead of the server go through', async () => {
    const { g, v1, v2 } = await setup();
    expect((await put('uB', g, 'entry-x01', { ...v2, baseVersion: 1 })).status).toBe(200); // same as stored
    expect((await put('uB', g, 'entry-x01', { ...v2, notes: 'B', baseVersion: 9 })).status).toBe(200); // local edits counted
    const undo = await put('uB', g, 'entry-x01', { ...v2, baseVersion: 3 }); // B undoes B's own note
    expect(undo.status).toBe(200);
    expect((await put('uA', g, 'entry-x01', { ...v1, baseVersion: 1 })).status).toBe(409); // B wrote last: A's old copy is refused
    expect((await put('uB', g, 'entry-x01', { ...v1 })).status).toBe(200); // no baseVersion at all: last write wins
  });

  it('with base: only the parts I changed are written, also when my editor lists the split in another order', async () => {
    const { g, v1 } = await setup();
    const split = { method: 'equal', entries: [{ memberId: g.B }, { memberId: g.A }, { memberId: g.C }] };
    const mine = { ...v1, split, description: 'dinner, B', base: v1, baseVersion: 1 };
    const r = await put('uB', g, 'entry-x01', mine);
    expect(r.status).toBe(200);
    expect(r.data.expense).toMatchObject({ amount: 1600, description: 'dinner, B' });
    expect((await history(g, 'entry-x01')).at(-1)!.data.changes).toEqual([{ field: 'description', from: 'dinner', to: 'dinner, B' }]);
    // The same save again (a retry after a lost answer) changes nothing and logs nothing.
    const count = (await history(g, 'entry-x01')).length;
    expect((await put('uB', g, 'entry-x01', mine)).data.expense).toMatchObject({ amount: 1600, description: 'dinner, B' });
    expect(await history(g, 'entry-x01')).toHaveLength(count);
  });

  it('with base: a part that someone else changed too is a conflict', async () => {
    const { g, v1 } = await setup();
    const r = await put('uB', g, 'entry-x01', { ...v1, amount: 1200, payers: [{ memberId: g.A, amount: 1200 }], base: v1 });
    expect(r.status).toBe(409);
    expect(r.data.error.details).toMatchObject({ code: 'edited_elsewhere', fields: ['money'], expense: { amount: 1600 } });
    // Both changed it to the same value: nothing to decide.
    expect((await put('uB', g, 'entry-x01', { ...v1, amount: 1600, payers: [{ memberId: g.A, amount: 1600 }], base: v1 })).status).toBe(200);
  });

  it('with base: rates for an older group currency are converted before the parts are compared', async () => {
    const { g, v1 } = await setup();
    await api('uA', 'PATCH', '/api/groups/' + g.gid, { currency: 'USD' });
    const before = await stored(g, 'entry-x01');
    const r = await put('uB', g, 'entry-x01', { ...v1, description: 'dinner, B', rateBase: 'TWD', base: v1 });
    expect(r.status).toBe(200);
    expect(r.data.expense).toMatchObject({ amount: 1600, fxRate: before.fxRate, description: 'dinner, B' });
  });

  it('with a base that cannot be read: falls back to the baseVersion check', async () => {
    const { g, v1 } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await put('uB', g, 'entry-x01', { ...v1, description: 'dinner, B', base: { kind: 'nope' }, baseVersion: 1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(r.status).toBe(409);
  });
});

// Shares are integers in the entry currency: a tiny sanity check of the fixtures above.
it('fixtures: equal shares of NT$100 among three add up', () => {
  const r = computeSharesFor('x-0000001', 100, { method: 'equal', entries: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }] });
  expect(r.ok && (r.shares as Portion[]).reduce((s, p) => s + p.amount, 0)).toBe(100);
});
