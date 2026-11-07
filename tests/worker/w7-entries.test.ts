// Review-1106 unit W7, entry routes on the worker.fetch harness with the real schema
// (tests/worker/d1-sqlite.ts); only the exchange-rate provider is replaced. Deleting the newest
// copy of a repeating entry with ?keep=series hands the repeat on (B2-05); clients cannot create
// ids of a recurring copy's shape (B2-07); deleted entries count toward a cap of their own (B2-08);
// a save, an import, a currency change or a recurring copy that races a currency change never
// stores a rate meant for the old currency (B2-06).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ rates: {} as Record<string, number> }));

vi.mock('../../src/worker/services/fx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/worker/services/fx')>();
  return { ...actual, getUsdRates: vi.fn(async (_db: unknown, date: string) => ({ date, rates: { ...fx.rates }, source: 'test' })) };
});

import { addDays, todayUTC } from '../../src/shared/dates';
import type { ExpenseDTO, GroupSnapshotDTO } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import { uuidFrom } from '../../src/worker/http';
import worker from '../../src/worker/index';
import { MAX_ENTRY_ROWS, MAX_LIVE_ENTRIES } from '../../src/worker/routes/expenses';
import { rateToBase } from '../../src/worker/services/fx';
import { isCopyId } from '../../src/worker/services/recurring';
import { importId } from '../../src/web/features/groups/splitwiseImport';
import { TestD1, type TestStmt } from './d1-sqlite';

const START_RATES = { USD: 1, TWD: 32.3, JPY: 150.2, EUR: 0.92 };

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

interface Group {
  gid: string;
  A: string;
  B: string;
}

async function newGroup(currency: string): Promise<Group> {
  const r = await api<GroupSnapshotDTO>('uA', 'POST', '/api/groups', { name: 'test-home', type: 'home', currency, members: [{ name: 'Bea', email: 'b@evenly.test' }] });
  expect(r.status).toBe(200);
  const id = (name: string) => r.data.members.find(m => m.name === name)!.id;
  return { gid: r.data.group.id, A: id('Ann'), B: id('Bea') };
}

type Body = Record<string, unknown>;

function expense(g: Group, over: Body = {}): Body {
  const amount = (over.amount as number | undefined) ?? 300;
  return {
    kind: 'expense', description: 'rent', category: 'general', amount, currency: 'TWD', fxRate: 1, date: todayUTC(),
    payers: [{ memberId: g.A, amount }], split: { method: 'equal', entries: [{ memberId: g.A }, { memberId: g.B }] },
    ...over,
  };
}

/** PUT an entry: `data` is UpsertExpenseRes, or `{ error }` when refused. */
const put = (user: string, g: Group, eid: string, body: unknown) =>
  api<{ expense: ExpenseDTO; groupVersion: number; error?: any }>(user, 'PUT', `/api/groups/${g.gid}/expenses/${eid}`, body);
const snapshot = async (g: Group) => (await api<GroupSnapshotDTO>('uA', 'GET', '/api/groups/' + g.gid)).data;

interface Row {
  id: string;
  date: string;
  repeat: string;
  deleted_at: string | null;
  fx_rate: number;
  currency: string;
}
const rowsOf = (g: Group) => db.rows<Row>('SELECT id, date, repeat, deleted_at, fx_rate, currency FROM expenses WHERE group_id = ? ORDER BY date, id', g.gid);
const rowOf = (id: string) => db.rows<Row>('SELECT id, date, repeat, deleted_at, fx_rate, currency FROM expenses WHERE id = ?', id)[0];

/** Run `before` once, right before the first batch that `match` picks (another request "landing first"). */
function beforeBatch(match: (stmts: readonly TestStmt[]) => boolean, before: () => Promise<void>): void {
  const real = db.batch.bind(db);
  let fired = false;
  (db as unknown as { batch: (s: readonly TestStmt[]) => ReturnType<TestD1['batch']> }).batch = async stmts => {
    if (!fired && match(stmts)) {
      fired = true;
      await before();
    }
    return real(stmts);
  };
}

const writesEntry = (eid: string) => (stmts: readonly TestStmt[]) => stmts.some(s => s.sql.startsWith('INSERT INTO expenses') && s.params[0] === eid);

beforeEach(async () => {
  fx.rates = { ...START_RATES };
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

// ---------- B2-05 ----------

describe('deleting the newest copy of a repeating entry (B2-05)', () => {
  /** A weekly entry 15 days old: copies 8 days and 1 day ago, the last one the head. */
  async function weekly() {
    const g = await newGroup('TWD');
    expect((await put('uA', g, 'head-0001', expense(g, { repeat: 'weekly', date: addDays(todayUTC(), -15) }))).status).toBe(200);
    await snapshot(g);
    const c1 = await uuidFrom(`head-0001:${addDays(todayUTC(), -8)}`);
    const c2 = await uuidFrom(`head-0001:${addDays(todayUTC(), -1)}`);
    expect(rowsOf(g).map(r => [r.id, r.repeat])).toEqual([['head-0001', 'none'], [c1, 'none'], [c2, 'weekly']]);
    return { g, c1, c2 };
  }
  /** Seven days on: the next weekly date is due. */
  const aWeekLater = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 7 * 86_400_000));
  };

  it('?keep=series hands the repeat to the copy before it, so the series goes on without the deleted date', async () => {
    const { g, c1, c2 } = await weekly();
    const r = await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/${c2}?keep=series`);
    expect(r.status).toBe(200);
    expect(rowOf(c2)).toMatchObject({ repeat: 'weekly' });
    expect(rowOf(c2).deleted_at).not.toBeNull();
    expect(rowOf(c1).repeat).toBe('weekly');

    const before = todayUTC();
    aWeekLater();
    await snapshot(g);
    const c3 = await uuidFrom(`head-0001:${addDays(before, 6)}`);
    const live = rowsOf(g).filter(x => !x.deleted_at);
    expect(live.map(x => [x.id, x.repeat])).toEqual([['head-0001', 'none'], [c1, 'none'], [c3, 'weekly']]);
    // The deleted date was not made again.
    expect(rowsOf(g).filter(x => x.date === addDays(before, -1))).toHaveLength(1);
  });

  it('without it the series stops, as before (復原 brings it back)', async () => {
    const { g, c1, c2 } = await weekly();
    expect((await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/${c2}`)).status).toBe(200);
    expect(rowOf(c1).repeat).toBe('none');
    aWeekLater();
    await snapshot(g);
    expect(rowsOf(g).filter(x => !x.deleted_at)).toHaveLength(2);
  });

  it('復原 after ?keep=series: the restored head keeps the series and the older copy gives the repeat back', async () => {
    const { g, c1, c2 } = await weekly();
    expect((await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/${c2}?keep=series`)).status).toBe(200);
    expect((await api('uA', 'POST', `/api/groups/${g.gid}/expenses/${c2}/restore`)).status).toBe(200);
    await snapshot(g);
    expect(rowOf(c1).repeat).toBe('none');
    expect(rowOf(c2)).toMatchObject({ repeat: 'weekly', deleted_at: null });
    expect(rowsOf(g)).toHaveLength(3);
  });

  it('hands nothing on for a head whose date was moved (its schedule restarted there)', async () => {
    const { g, c1, c2 } = await weekly();
    const moved = await put('uA', g, c2, { ...expense(g), repeat: 'weekly', date: addDays(todayUTC(), -2) });
    expect(moved.status).toBe(200);
    const r = await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/${c2}?keep=series`);
    expect(r.status).toBe(200);
    expect(rowOf(c1).repeat).toBe('none');
    // The answer says the repeat stopped (review W7-correct-01).
    expect(r.data.seriesKept).toBe(false);
  });

  it('seriesKept says whether the series goes on: true after a hand-over, also on a retry; left out without ?keep=series (review W7-correct-01)', async () => {
    const { g, c2 } = await weekly();
    const r = await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/${c2}?keep=series`);
    expect(r.data).toMatchObject({ seriesKept: true, expense: { id: c2 } });
    // An outbox retry after a lost answer finds the entry deleted already, and gets the same word.
    const again = await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/${c2}?keep=series`);
    expect([again.status, again.data.seriesKept]).toEqual([200, true]);
    // A plain delete of a head ends the series by design, and says nothing about it.
    expect((await put('uA', g, 'plain-0001', expense(g, { repeat: 'monthly' }))).status).toBe(200);
    const p = await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/plain-0001`);
    expect(p.status).toBe(200);
    expect('seriesKept' in p.data).toBe(false);
  });

  it('?keep=series on the series\' first entry while it is still the newest: nothing can take the repeat over, and seriesKept is false', async () => {
    const g = await newGroup('TWD');
    expect((await put('uA', g, 'rent-0001', expense(g, { repeat: 'monthly', date: todayUTC() }))).status).toBe(200);
    const r = await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/rent-0001?keep=series`);
    expect(r.status).toBe(200);
    expect(r.data.seriesKept).toBe(false);
    // A non-repeating entry says nothing about a series.
    expect((await put('uA', g, 'once-0001', expense(g))).status).toBe(200);
    const once = await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/once-0001?keep=series`);
    expect('seriesKept' in once.data).toBe(false);
  });

  it('the first entry dated earlier, then its copy deleted with ?keep=series: its first date is not made a second time (review W7-contract-01)', async () => {
    const g = await newGroup('TWD');
    const start = addDays(todayUTC(), -8);
    expect((await put('uA', g, 'head-0002', expense(g, { repeat: 'weekly', date: start }))).status).toBe(200);
    await snapshot(g);
    const c1 = await uuidFrom(`head-0002:${addDays(start, 7)}`);
    expect(rowOf(c1).repeat).toBe('weekly');
    // Someone corrects the first entry's date one day earlier (it no longer repeats; its schedule start stays).
    expect((await put('uA', g, 'head-0002', expense(g, { date: addDays(start, -1) }))).status).toBe(200);
    const r = await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/${c1}?keep=series`);
    expect(r.data.seriesKept).toBe(true);
    expect(rowOf('head-0002').repeat).toBe('weekly');
    await snapshot(g);
    // Nothing on the first entry's old date, nothing doubled.
    expect(rowsOf(g).filter(x => x.date === start)).toEqual([]);
    expect(rowsOf(g).filter(x => !x.deleted_at).map(x => x.id)).toEqual(['head-0002']);
    // A week on, the next date comes as usual.
    const before = todayUTC();
    aWeekLater();
    await snapshot(g);
    const next = await uuidFrom(`head-0002:${addDays(start, 14)}`);
    expect(addDays(start, 14)).toBe(addDays(before, 6));
    expect(rowsOf(g).filter(x => !x.deleted_at).map(x => [x.id, x.repeat])).toEqual([['head-0002', 'none'], [next, 'weekly']]);
  });

  it('a copy moved before the series start that takes the repeat over never brings the start date back (review W7-contract-01)', async () => {
    const { g, c1, c2 } = await weekly();
    const start = addDays(todayUTC(), -15);
    // The first copy is corrected to a day before the first entry.
    expect((await put('uA', g, c1, expense(g, { date: addDays(start, -1) }))).status).toBe(200);
    expect((await api('uA', 'DELETE', `/api/groups/${g.gid}/expenses/${c2}?keep=series`)).data.seriesKept).toBe(true);
    // The first entry takes the repeat; the next read hands it to the moved copy (its date is due).
    await snapshot(g);
    expect(rowOf(c1).repeat).toBe('weekly');
    await snapshot(g);
    // Only the first entry is on the start date, after both reads.
    expect(rowsOf(g).filter(x => x.date === start).map(x => x.id)).toEqual(['head-0001']);
    expect(rowsOf(g).filter(x => !x.deleted_at)).toHaveLength(2);
    const before = todayUTC();
    aWeekLater();
    await snapshot(g);
    const next = await uuidFrom(`head-0001:${addDays(before, 6)}`);
    expect(rowsOf(g).filter(x => !x.deleted_at).map(x => [x.id, x.repeat]).sort()).toEqual([['head-0001', 'none'], [c1, 'none'], [next, 'weekly']].sort());
  });
});

// ---------- B2-07 ----------

describe('ids of a recurring copy\'s shape (B2-07)', () => {
  it('isCopyId: every server copy id, no client id', async () => {
    expect(isCopyId(await uuidFrom('series-1:2026-12-01'))).toBe(true);
    for (let i = 0; i < 50; i++) expect(isCopyId(crypto.randomUUID())).toBe(false);
    expect(isCopyId(crypto.randomUUID().toUpperCase())).toBe(false);
    const row = { rawDate: '2026-09-05', description: 'Dinner', category: 'Dining out', costText: '30.00', currency: 'USD', netTexts: ['15.00', '-15.00'] };
    expect(isCopyId(importId('g1', row as never, 0))).toBe(false);
    expect(isCopyId('dinner-0001')).toBe(false);
  });

  it('a new entry may not take one (it could stop another group\'s series), an existing copy is edited as usual', async () => {
    const g = await newGroup('TWD');
    const squat = await uuidFrom('someone-elses-series:2026-12-01');
    const r = await put('uB', g, squat, expense(g));
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('bad_request');
    expect(rowOf(squat)).toBeUndefined();

    expect((await put('uA', g, 'head-0002', expense(g, { repeat: 'weekly', date: addDays(todayUTC(), -8) }))).status).toBe(200);
    await snapshot(g);
    const copy = await uuidFrom(`head-0002:${addDays(todayUTC(), -1)}`);
    expect(rowOf(copy)).toBeDefined();
    const edit = await put('uA', g, copy, { ...expense(g), description: 'rent (fixed)', date: addDays(todayUTC(), -1), repeat: 'weekly' });
    expect(edit.status).toBe(200);
    expect(edit.data.expense.description).toBe('rent (fixed)');
  });

  it('an import skips one as invalid_id', async () => {
    const g = await newGroup('TWD');
    const squat = await uuidFrom('someone-elses-series:2027-01-01');
    const r = await api('uA', 'POST', `/api/groups/${g.gid}/import`, { expenses: [{ ...expense(g), id: squat }, { ...expense(g), id: 'import-0001' }] });
    expect(r.status).toBe(200);
    expect(r.data.imported).toBe(1);
    expect(r.data.skipped).toEqual([{ index: 0, code: 'invalid_id', field: 'id' }]);
  });
});

// ---------- B2-08 ----------

describe('the caps on entries (B2-08, B2-10)', () => {
  /** `n` rows straight into the group, deleted or live. */
  function fill(g: Group, n: number, deleted: boolean) {
    const now = new Date().toISOString();
    db.exec(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
       INSERT INTO expenses (id, group_id, kind, description, category, amount, currency, fx_rate, date, notes, payers, split, shares,
         repeat, created_by, created_at, updated_by, updated_at, deleted_at, version)
       SELECT 'fill-' || i, ?, 'expense', 'x', 'general', 100, 'TWD', 1, ?, '', ?, ?, ?, 'none', 'uA', ?, 'uA', ?, ?, 1 FROM k`,
      n, g.gid, todayUTC(), JSON.stringify([{ memberId: g.A, amount: 100 }]), JSON.stringify({ method: 'equal', entries: [{ memberId: g.A }] }),
      JSON.stringify([{ memberId: g.A, amount: 100 }]), now, now, deleted ? now : null,
    );
  }

  it('deleted entries count toward MAX_ENTRY_ROWS: a new one is refused, an edit is not, an import skips', async () => {
    const g = await newGroup('TWD');
    expect((await put('uA', g, 'keep-0001', expense(g))).status).toBe(200);
    fill(g, MAX_ENTRY_ROWS - 1, true);
    const r = await put('uA', g, 'new-0001', expense(g));
    expect(r.status).toBe(409);
    expect(r.data.error).toMatchObject({ code: 'limit_reached', details: { limit: 'entry_rows', max: MAX_ENTRY_ROWS } });
    expect((await put('uA', g, 'keep-0001', expense(g, { description: 'still editable' }))).status).toBe(200);
    const imp = await api('uA', 'POST', `/api/groups/${g.gid}/import`, { expenses: [{ ...expense(g), id: 'import-0002' }] });
    expect(imp.data).toMatchObject({ imported: 0, skipped: [{ index: 0, code: 'limit_reached' }] });
  });

  it('live entries: MAX_LIVE_ENTRIES, now with details', async () => {
    const g = await newGroup('TWD');
    fill(g, MAX_LIVE_ENTRIES, false);
    const r = await put('uA', g, 'new-0002', expense(g));
    expect(r.status).toBe(409);
    expect(r.data.error.details).toEqual({ limit: 'entries', max: MAX_LIVE_ENTRIES });
  });
});

// ---------- B2-06 ----------

describe('a save that races a group currency change (B2-06)', () => {
  /** A TWD group with one TWD entry, so a switch converts (and logs its rate). */
  async function twdGroup() {
    const g = await newGroup('TWD');
    expect((await put('uA', g, 'ctrl-0001', expense(g))).status).toBe(200);
    return g;
  }
  const k = rateToBase(START_RATES, 'TWD', 'USD')!;

  it('a PUT read before the switch and written after it is read again against the new currency', async () => {
    const g = await twdGroup();
    beforeBatch(writesEntry('race-0001'), async () => {
      expect((await api('uB', 'PATCH', '/api/groups/' + g.gid, { currency: 'USD' })).status).toBe(200);
    });
    const r = await put('uA', g, 'race-0001', expense(g, { rateBase: 'TWD' }));
    expect(r.status).toBe(200);
    expect(r.data.expense).toMatchObject({ currency: 'TWD', amount: 300, fxRate: k });
    expect(rowOf('race-0001').fx_rate).toBe(k);
    expect(rowOf('ctrl-0001').fx_rate).toBe(k);
  });

  it('twice in a row: 409, and nothing is written', async () => {
    const g = await twdGroup();
    let n = 0;
    const real = db.batch.bind(db);
    (db as unknown as { batch: (s: readonly TestStmt[]) => ReturnType<TestD1['batch']> }).batch = async stmts => {
      if (writesEntry('race-0002')(stmts) && n < 2) {
        n++;
        // Straight in, as another request's commit would be.
        db.exec('UPDATE groups SET currency = ? WHERE id = ?', n === 1 ? 'USD' : 'EUR', g.gid);
      }
      return real(stmts);
    };
    const r = await put('uA', g, 'race-0002', expense(g));
    expect(r.status).toBe(409);
    expect(r.data.error).toMatchObject({ code: 'conflict', details: { code: 'currency_changed' } });
    expect(rowOf('race-0002')).toBeUndefined();
  });

  it('an import chunk that lands after the switch is planned again: rates converted, nothing doubled', async () => {
    const g = await twdGroup();
    const match = (stmts: readonly TestStmt[]) => stmts.some(s => s.sql.startsWith('INSERT OR IGNORE INTO expenses'));
    beforeBatch(match, async () => {
      expect((await api('uB', 'PATCH', '/api/groups/' + g.gid, { currency: 'USD' })).status).toBe(200);
    });
    const list = [{ ...expense(g), id: 'imp-0001' }, { ...expense(g), id: 'imp-0002', currency: 'USD', fxRate: null }];
    const r = await api('uA', 'POST', `/api/groups/${g.gid}/import`, { expenses: list });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ imported: 2, skipped: [] });
    expect(rowOf('imp-0001')).toMatchObject({ currency: 'TWD', fx_rate: k });
    expect(rowOf('imp-0002')).toMatchObject({ currency: 'USD', fx_rate: 1 });
  });

  it('two currency changes at once: the second is refused, not applied to rates already re-based', async () => {
    const g = await twdGroup();
    const patches = (stmts: readonly TestStmt[]) => stmts.some(s => s.sql.startsWith('UPDATE groups SET currency'));
    beforeBatch(patches, async () => {
      expect((await api('uB', 'PATCH', '/api/groups/' + g.gid, { currency: 'EUR' })).status).toBe(200);
    });
    const r = await api('uA', 'PATCH', '/api/groups/' + g.gid, { currency: 'USD' });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('conflict');
    expect(db.rows<{ currency: string }>('SELECT currency FROM groups WHERE id = ?', g.gid)[0].currency).toBe('EUR');
    expect(rowOf('ctrl-0001').fx_rate).toBe(rateToBase(START_RATES, 'TWD', 'EUR'));
  });

  it('a switch that found nothing to convert is refused when an entry in the old currency came in meanwhile', async () => {
    const g = await newGroup('TWD');
    const patches = (stmts: readonly TestStmt[]) => stmts.some(s => s.sql.startsWith('UPDATE groups SET currency'));
    beforeBatch(patches, async () => {
      expect((await put('uB', g, 'late-0001', expense(g))).status).toBe(200);
    });
    const r = await api('uA', 'PATCH', '/api/groups/' + g.gid, { currency: 'USD' });
    expect(r.status).toBe(409);
    expect(rowOf('late-0001').fx_rate).toBe(1);
    // Tried again, it converts the entry like any other.
    expect((await api('uA', 'PATCH', '/api/groups/' + g.gid, { currency: 'USD' })).status).toBe(200);
    expect(rowOf('late-0001').fx_rate).toBe(k);
  });

  it('recurring copies made after the switch take the re-based rate (the run in between writes nothing)', async () => {
    const g = await newGroup('TWD');
    expect((await put('uA', g, 'head-0003', expense(g, { repeat: 'weekly', date: addDays(todayUTC(), -8) }))).status).toBe(200);
    const copies = (stmts: readonly TestStmt[]) => stmts.some(s => s.sql.includes("'recurring.create'") || (s.sql.startsWith('INSERT INTO activity') && s.params.includes('recurring.create')));
    beforeBatch(copies, async () => {
      expect((await api('uB', 'PATCH', '/api/groups/' + g.gid, { currency: 'USD' })).status).toBe(200);
    });
    const first = await snapshot(g);
    expect(first.expenses.filter(e => e.id !== 'head-0003')).toHaveLength(0);
    const second = await snapshot(g);
    const copy = second.expenses.find(e => e.id !== 'head-0003')!;
    expect(copy).toMatchObject({ currency: 'TWD', fxRate: k });
  });
});
