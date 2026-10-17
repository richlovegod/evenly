// Pure helpers of the expense routes (validation, change lists, import planning), the recurring
// planner, and materializeDue / runDaily against a fake D1. Modules owned by other parts of the
// Worker (auth, activity, summary, fx) are mocked so these tests only exercise W3 code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/worker/auth', () => ({
  requireUser: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../src/worker/services/summary', () => ({
  refreshSummary: vi.fn(async () => null),
}));
vi.mock('../../src/worker/services/activity', () => ({
  activityStmt: vi.fn((db: { prepare(sql: string): { bind(...v: unknown[]): unknown } }, a: unknown) =>
    db.prepare('INSERT INTO activity').bind(a),
  ),
  activitySelect: vi.fn((where: string, tail = '') => `SELECT * FROM activity a WHERE ${where} ${tail}`),
  entryActivityData: vi.fn((e: { description: string; amount: number; currency: string }) => ({
    description: e.description,
    amount: e.amount,
    currency: e.currency,
  })),
  toActivityDTO: vi.fn((r: unknown) => r),
}));
vi.mock('../../src/worker/services/fx', () => ({
  getUsdRates: vi.fn(async (_db: unknown, date: string) => ({ date, rates: { USD: 1, TWD: 32.3 }, source: 'test' })),
}));

import { addDays } from '../../src/shared/dates';
import { MAX_AMOUNT } from '../../src/shared/money';
import { computeSharesFor, type SplitInput } from '../../src/shared/split';
import {
  changedParts,
  expenseChanges,
  keepStoredShares,
  legacyConflict,
  mergeEdit,
  normalizeUpsert,
  parseCurrencyHistory,
  planImport,
  rateBaseClaim,
  rebasedRate,
  repeatFields,
  rowFields,
  snippet,
  splitKey,
  switchesSince,
  type CurrencySwitch,
  type EntryFields,
  type NormalizeResult,
  type NormalizedEntry,
  type UpsertError,
} from '../../src/worker/routes/expenses';
import type { ExpenseRow } from '../../src/worker/db';
import { uuidFrom } from '../../src/worker/http';
import { entryActivityData } from '../../src/worker/services/activity';
import { cleanupStmts, runDaily } from '../../src/worker/services/cron';
import { getUsdRates } from '../../src/worker/services/fx';
import { copyShares, dueDates, materializeDue, planSeries, type ExistingOccurrence } from '../../src/worker/services/recurring';
import { refreshSummary } from '../../src/worker/services/summary';
import type { Env } from '../../src/worker/env';

const TODAY = '2026-10-16';
const MEMBERS = ['m-gino', 'm-abbie', 'm-kevin', 'm-left'];

type Body = Record<string, unknown>;

function expenseBody(over: Body = {}): Body {
  return {
    kind: 'expense',
    description: '燒肉晚餐',
    category: 'food.dining',
    amount: 1000,
    currency: 'TWD',
    fxRate: 1,
    date: '2026-10-15',
    payers: [{ memberId: 'm-abbie', amount: 1000 }],
    split: { method: 'equal', entries: [{ memberId: 'm-gino' }, { memberId: 'm-abbie' }, { memberId: 'm-kevin' }] },
    ...over,
  };
}

function paymentBody(over: Body = {}): Body {
  return {
    kind: 'payment',
    description: '',
    category: 'payment',
    amount: 3150,
    currency: 'TWD',
    fxRate: 1,
    date: '2026-10-15',
    payers: [{ memberId: 'm-kevin', amount: 3150 }],
    split: { method: 'exact', entries: [{ memberId: 'm-gino', value: 3150 }] },
    ...over,
  };
}

const norm = (body: unknown, groupCurrency = 'TWD') => normalizeUpsert(body, groupCurrency, MEMBERS, TODAY);

function ok(r: NormalizeResult): NormalizedEntry {
  if (!r.ok) throw new Error('expected ok, got ' + JSON.stringify(r.error));
  return r.entry;
}

function err(r: NormalizeResult): UpsertError {
  if (r.ok) throw new Error('expected an error, got ' + JSON.stringify(r.entry));
  return r.error;
}

// ---------- normalizeUpsert ----------

describe('normalizeUpsert: shares and stored shape', () => {
  it('computes shares on the server with the payer absorbing rounding', () => {
    const e = ok(norm(expenseBody()));
    expect(e.shares).toEqual([
      { memberId: 'm-gino', amount: 333 },
      { memberId: 'm-abbie', amount: 334 },
      { memberId: 'm-kevin', amount: 333 },
    ]);
  });

  it('returns exactly the stored fields, ignoring client shares and unknown keys', () => {
    const e = ok(norm(expenseBody({ shares: [{ memberId: 'm-gino', amount: 1000 }], baseVersion: 7, id: 'x', createdBy: 'evil' })));
    expect(e).toEqual({
      kind: 'expense',
      description: '燒肉晚餐',
      category: 'food.dining',
      amount: 1000,
      currency: 'TWD',
      fxRate: 1,
      date: '2026-10-15',
      notes: '',
      payers: [{ memberId: 'm-abbie', amount: 1000 }],
      split: { method: 'equal', entries: [{ memberId: 'm-gino' }, { memberId: 'm-abbie' }, { memberId: 'm-kevin' }] },
      shares: [
        { memberId: 'm-gino', amount: 333 },
        { memberId: 'm-abbie', amount: 334 },
        { memberId: 'm-kevin', amount: 333 },
      ],
      repeat: 'none',
    });
  });

  it('drops values from an equal split but keeps them for other methods', () => {
    const eq = ok(norm(expenseBody({ split: { method: 'equal', entries: [{ memberId: 'm-gino', value: 5 }, { memberId: 'm-abbie', value: null }] } })));
    expect(eq.split).toEqual({ method: 'equal', entries: [{ memberId: 'm-gino' }, { memberId: 'm-abbie' }] });
    const sh = ok(norm(expenseBody({ split: { method: 'shares', entries: [{ memberId: 'm-gino', value: 1 }, { memberId: 'm-abbie', value: 1.5 }], items: [] } })));
    expect(sh.split).toEqual({ method: 'shares', entries: [{ memberId: 'm-gino', value: 1 }, { memberId: 'm-abbie', value: 1.5 }] });
    expect(sh.shares).toEqual([
      { memberId: 'm-gino', amount: 400 },
      { memberId: 'm-abbie', amount: 600 },
    ]);
  });

  it('splits items with the service charge spread by subtotal', () => {
    const e = ok(
      norm(
        expenseBody({
          amount: 11000,
          payers: [{ memberId: 'm-kevin', amount: 11000 }],
          split: {
            method: 'items',
            entries: [],
            items: [
              { id: 'i1', name: ' 生啤 ', amount: 4000, memberIds: ['m-gino', 'm-kevin'] },
              { id: null, name: null, amount: 6000, memberIds: ['m-gino', 'm-kevin', 'm-abbie'] },
            ],
          },
        }),
      ),
    );
    const by = Object.fromEntries(e.shares.map(s => [s.memberId, s.amount]));
    expect(by['m-abbie']).toBe(2200);
    expect(by['m-gino'] + by['m-kevin'] + by['m-abbie']).toBe(11000);
    expect(e.split.items).toEqual([
      { id: 'i1', name: '生啤', amount: 4000, memberIds: ['m-gino', 'm-kevin'] },
      { id: 'item-2', name: '', amount: 6000, memberIds: ['m-gino', 'm-kevin', 'm-abbie'] },
    ]);
  });

  it('accepts null for optional fields', () => {
    const e = ok(norm(expenseBody({ notes: null, repeat: null, fxRate: null })));
    expect(e.notes).toBe('');
    expect(e.repeat).toBe('none');
    expect(e.fxRate).toBe(1);
    const p = ok(norm(paymentBody({ description: null })));
    expect(p.description).toBe('');
  });

  it('keeps a repeat setting and trims notes', () => {
    const e = ok(norm(expenseBody({ repeat: 'monthly', notes: '  住宿押金  ' })));
    expect(e.repeat).toBe('monthly');
    expect(e.notes).toBe('住宿押金');
  });
});

describe('normalizeUpsert: description and category', () => {
  it('trims the description and requires one for expenses', () => {
    expect(ok(norm(expenseBody({ description: '  晚餐  ' }))).description).toBe('晚餐');
    expect(err(norm(expenseBody({ description: '   ' })))).toMatchObject({ code: 'description_required', field: 'description' });
    expect(err(norm(expenseBody({ description: undefined })))).toMatchObject({ code: 'description_required' });
  });

  it('allows up to 120 characters', () => {
    expect(ok(norm(expenseBody({ description: 'x'.repeat(120) }))).description).toHaveLength(120);
    expect(err(norm(expenseBody({ description: 'x'.repeat(121) })))).toMatchObject({ code: 'invalid_field', field: 'description' });
  });

  it('keeps known category keys and turns everything else into general', () => {
    expect(ok(norm(expenseBody({ category: 'transport.taxi' }))).category).toBe('transport.taxi');
    expect(ok(norm(expenseBody({ category: ' travel.hotel ' }))).category).toBe('travel.hotel');
    for (const category of ['nope', '', 42, null, undefined, { a: 1 }, 'payment']) {
      expect(ok(norm(expenseBody({ category }))).category).toBe('general');
    }
  });

  it('forces the payment category and allows an empty description on payments', () => {
    const p = ok(norm(paymentBody({ category: 'food.dining', description: '   ' })));
    expect(p.category).toBe('payment');
    expect(p.description).toBe('');
    expect(ok(norm(paymentBody({ description: 'LINE Pay' }))).description).toBe('LINE Pay');
  });
});

describe('normalizeUpsert: currency and exchange rate', () => {
  it('forces fxRate to exactly 1 in the group currency, whatever was sent', () => {
    for (const fxRate of [2, 0, -1, undefined, null, 1e12]) {
      expect(ok(norm(expenseBody({ fxRate }))).fxRate).toBe(1);
    }
  });

  it('keeps a valid rate for another currency', () => {
    const e = ok(norm(expenseBody({ currency: 'JPY', fxRate: 0.2105 })));
    expect(e.currency).toBe('JPY');
    expect(e.fxRate).toBe(0.2105);
    expect(ok(norm(expenseBody({ currency: 'VND', fxRate: 999_999_999 }))).fxRate).toBe(999_999_999);
  });

  it('rejects a missing, zero, negative or huge rate for another currency', () => {
    for (const fxRate of [undefined, null, 0, -0.5, 1e9, 5e9]) {
      expect(err(norm(expenseBody({ currency: 'USD', fxRate })))).toMatchObject({ code: 'invalid_fx_rate', field: 'fxRate' });
    }
  });

  it('rejects non-finite rates and malformed currency codes in the schema', () => {
    expect(err(norm(expenseBody({ currency: 'USD', fxRate: Infinity })))).toMatchObject({ code: 'invalid_field', field: 'fxRate' });
    expect(err(norm(expenseBody({ currency: 'USD', fxRate: Number.NaN })))).toMatchObject({ code: 'invalid_field', field: 'fxRate' });
    for (const currency of ['usd', 'US', 'USDT', '', 1]) {
      expect(err(norm(expenseBody({ currency })))).toMatchObject({ code: 'invalid_field', field: 'currency' });
    }
  });

  it('never stores a rate meant for another group currency (rateBase must be converted first)', () => {
    expect(err(norm(expenseBody({ currency: 'JPY', fxRate: 0.2105, rateBase: 'USD' })))).toMatchObject({ code: 'invalid_fx_rate', field: 'rateBase' });
    expect(err(norm(expenseBody({ currency: 'JPY', fxRate: 0.2105, baseCurrency: 'USD' })))).toMatchObject({ code: 'invalid_fx_rate', field: 'rateBase' });
    expect(ok(norm(expenseBody({ currency: 'JPY', fxRate: 0.2105, rateBase: 'TWD' }))).fxRate).toBe(0.2105);
    // In the group currency the rate is 1 whatever it was chosen against.
    expect(ok(norm(expenseBody({ rateBase: 'USD', fxRate: 0.031 }))).fxRate).toBe(1);
    expect(err(norm(expenseBody({ rateBase: 'twd' })))).toMatchObject({ code: 'invalid_field', field: 'rateBase' });
  });
});

// ---------- rates chosen against an older group currency ----------

describe('rateBaseClaim', () => {
  it('a body in the group currency, or one that names the group currency, is current', () => {
    expect(rateBaseClaim(expenseBody(), 'TWD')).toEqual({ kind: 'current' });
    expect(rateBaseClaim(expenseBody({ rateBase: 'JPY' }), 'TWD')).toEqual({ kind: 'current' });
    expect(rateBaseClaim(expenseBody({ currency: 'JPY', fxRate: 0.2, rateBase: 'TWD' }), 'TWD')).toEqual({ kind: 'current' });
    expect(rateBaseClaim(expenseBody({ currency: 'JPY', fxRate: 0.2 }), 'TWD')).toEqual({ kind: 'current' });
  });

  it('a rateBase (or baseCurrency) other than the group currency is stale', () => {
    expect(rateBaseClaim(expenseBody({ currency: 'JPY', fxRate: 0.2, rateBase: 'TWD' }), 'USD')).toEqual({ kind: 'stale', base: 'TWD' });
    expect(rateBaseClaim(expenseBody({ rateBase: 'TWD' }), 'USD')).toEqual({ kind: 'stale', base: 'TWD' });
    expect(rateBaseClaim(expenseBody({ baseCurrency: 'TWD' }), 'USD')).toEqual({ kind: 'stale', base: 'TWD' });
    // A named base wins over the fxRate-1 guess, also when it is the current one.
    expect(rateBaseClaim(expenseBody({ rateBase: 'USD' }), 'USD')).toEqual({ kind: 'current' });
  });

  it('without rateBase, a rate of exactly 1 for another currency may be from before a currency change', () => {
    expect(rateBaseClaim(expenseBody(), 'USD')).toEqual({ kind: 'legacy', currency: 'TWD' });
    expect(rateBaseClaim(expenseBody({ rateBase: null }), 'USD')).toEqual({ kind: 'legacy', currency: 'TWD' });
    expect(rateBaseClaim(expenseBody({ fxRate: 0.031 }), 'USD')).toEqual({ kind: 'current' });
  });

  it('leaves malformed bodies to normalizeUpsert', () => {
    for (const raw of [null, 42, 'x', [], {}, { currency: 'usd', fxRate: 1 }, { currency: 'TWD', rateBase: 'us' }]) {
      expect(rateBaseClaim(raw, 'USD').kind === 'stale').toBe(false);
    }
  });
});

describe('parseCurrencyHistory', () => {
  it('reads the currency changes of group.update activity, with their rate when one was logged', () => {
    const datas = [
      JSON.stringify({ groupName: 'Japan', changes: [{ field: 'name', from: 'a', to: 'b' }, { field: 'currency', from: 'TWD', to: 'USD', rate: 0.031 }] }),
      JSON.stringify({ changes: [{ field: 'currency', from: 'USD', to: 'JPY' }] }),
      JSON.stringify({ changes: [{ field: 'currency', from: 'JPY', to: 'EUR', rate: 0 }] }),
      JSON.stringify({ changes: [{ field: 'currency', from: 'eur', to: 'EUR' }, { field: 'currency', from: 'EUR', to: 'EUR' }, null, 5] }),
      'not json',
      JSON.stringify({ changes: 'nope' }),
      JSON.stringify([1]),
    ];
    expect(parseCurrencyHistory(datas)).toEqual([
      { from: 'TWD', to: 'USD', rate: 0.031 },
      { from: 'USD', to: 'JPY' },
      { from: 'JPY', to: 'EUR' },
    ]);
  });
});

describe('switchesSince', () => {
  const h: CurrencySwitch[] = [
    { from: 'TWD', to: 'USD', rate: 0.031 },
    { from: 'USD', to: 'TWD', rate: 32 },
    { from: 'TWD', to: 'JPY', rate: 4.7 },
    { from: 'JPY', to: 'USD', rate: 0.0067 },
  ];

  it('starts at the last time the group left the base and keeps every later change', () => {
    expect(switchesSince(h, 'TWD', 'USD')).toEqual(h.slice(2));
    expect(switchesSince(h, 'JPY', 'USD')).toEqual(h.slice(3));
  });

  it('is null when the history shows no path to the current currency', () => {
    expect(switchesSince(h, 'EUR', 'USD')).toBeNull();
    expect(switchesSince(h, 'TWD', 'JPY')).toBeNull();
    expect(switchesSince([{ from: 'TWD', to: 'USD' }, { from: 'EUR', to: 'JPY' }], 'TWD', 'JPY')).toBeNull();
    expect(switchesSince([], 'TWD', 'USD')).toBeNull();
  });
});

describe('rebasedRate', () => {
  const none = () => null;

  it('repeats the re-base of routes/groups.ts for each change', () => {
    const steps: CurrencySwitch[] = [{ from: 'TWD', to: 'USD', rate: 0.03095975232 }];
    expect(rebasedRate('TWD', 1, steps, none)).toBe(0.03095975232); // the old group currency: the rate itself
    expect(rebasedRate('USD', 32.3, steps, none)).toBe(1); // the new one: 1
    expect(rebasedRate('JPY', 0.2040268032, steps, none)).toBe(Number((0.2040268032 * 0.03095975232).toPrecision(10)));
    const two: CurrencySwitch[] = [...steps, { from: 'USD', to: 'JPY', rate: 140 }];
    expect(rebasedRate('TWD', 1, two, none)).toBe(Number((0.03095975232 * 140).toPrecision(10)));
    expect(rebasedRate('JPY', 0.2, two, none)).toBe(1);
  });

  it('asks rateOf for a change that logged no rate, and gives null without one', () => {
    const rateOf = vi.fn((from: string, to: string) => (from === 'TWD' && to === 'USD' ? 0.031 : null));
    expect(rebasedRate('TWD', 1, [{ from: 'TWD', to: 'USD' }], rateOf)).toBe(0.031);
    expect(rateOf).toHaveBeenCalledWith('TWD', 'USD');
    expect(rebasedRate('TWD', 1, [{ from: 'TWD', to: 'EUR' }], rateOf)).toBeNull();
    expect(rebasedRate('TWD', 1, [{ from: 'TWD', to: 'EUR', rate: Number.NaN }], none)).toBeNull();
    // No rate is needed for a change into the entry's own currency.
    expect(rebasedRate('EUR', 1.1, [{ from: 'TWD', to: 'EUR' }], none)).toBe(1);
  });
});

describe('normalizeUpsert: dates', () => {
  it('needs a real calendar date', () => {
    for (const date of ['2026-02-30', '2026/10/15', '2026-13-01', '15-10-2026', '', '2026-10-15T00:00:00Z']) {
      expect(err(norm(expenseBody({ date }))).code).toMatch(/invalid_date|invalid_field/);
    }
    expect(err(norm(expenseBody({ date: '2026-02-30' })))).toMatchObject({ code: 'invalid_date', field: 'date' });
  });

  it('runs from 2000-01-01 to today + 366 days', () => {
    expect(ok(norm(expenseBody({ date: '2000-01-01' }))).date).toBe('2000-01-01');
    expect(err(norm(expenseBody({ date: '1999-12-31' })))).toMatchObject({ code: 'date_out_of_range' });
    expect(addDays(TODAY, 366)).toBe('2027-10-17');
    expect(ok(norm(expenseBody({ date: '2027-10-17' }))).date).toBe('2027-10-17');
    expect(err(norm(expenseBody({ date: '2027-10-18' })))).toMatchObject({ code: 'date_out_of_range' });
  });
});

describe('normalizeUpsert: members', () => {
  it('accepts any member of the group, also one who left', () => {
    const e = ok(norm(expenseBody({ payers: [{ memberId: 'm-left', amount: 1000 }] })));
    expect(e.payers).toEqual([{ memberId: 'm-left', amount: 1000 }]);
  });

  it('rejects ids that are not members, in payers, entries or items', () => {
    expect(err(norm(expenseBody({ payers: [{ memberId: 'm-stranger', amount: 1000 }] })))).toMatchObject({
      code: 'unknown_member',
      field: 'payers',
      memberId: 'm-stranger',
    });
    expect(err(norm(expenseBody({ split: { method: 'equal', entries: [{ memberId: 'm-gino' }, { memberId: 'm-x' }] } })))).toMatchObject({
      code: 'unknown_member',
      field: 'split',
      memberId: 'm-x',
    });
    const items = { method: 'items', entries: [], items: [{ id: 'i', name: 'x', amount: 1000, memberIds: ['m-gino', 'm-y'] }] };
    expect(err(norm(expenseBody({ split: items })))).toMatchObject({ code: 'unknown_member', memberId: 'm-y' });
    // The entries of an items split are checked too.
    const items2 = { method: 'items', entries: [{ memberId: 'm-z' }], items: [{ id: 'i', name: 'x', amount: 1000, memberIds: ['m-gino'] }] };
    expect(err(norm(expenseBody({ split: items2 })))).toMatchObject({ code: 'unknown_member', memberId: 'm-z' });
  });

  it('takes the member list as any iterable', () => {
    expect(normalizeUpsert(expenseBody(), 'TWD', new Set(MEMBERS), TODAY).ok).toBe(true);
    expect(normalizeUpsert(expenseBody(), 'TWD', new Map(MEMBERS.map(m => [m, 1])).keys(), TODAY).ok).toBe(true);
  });
});

describe('normalizeUpsert: payments', () => {
  it('stores a payment as one sender and one recipient with an exact split', () => {
    const p = ok(norm(paymentBody({ split: { method: 'exact', entries: [{ memberId: 'm-gino', value: 3150 }], items: [{ id: 'i', name: 'x', amount: 1, memberIds: ['m-gino'] }] } })));
    expect(p.split).toEqual({ method: 'exact', entries: [{ memberId: 'm-gino', value: 3150 }] });
    expect(p.payers).toEqual([{ memberId: 'm-kevin', amount: 3150 }]);
    expect(p.shares).toEqual([{ memberId: 'm-gino', amount: 3150 }]);
  });

  it('needs exactly one sender', () => {
    const two = [{ memberId: 'm-kevin', amount: 3000 }, { memberId: 'm-abbie', amount: 150 }];
    expect(err(norm(paymentBody({ payers: two })))).toMatchObject({ code: 'payment_payer', field: 'payers' });
    expect(err(norm(paymentBody({ payers: [] })))).toMatchObject({ code: 'payment_payer' });
  });

  it('needs an exact split to exactly one other person', () => {
    expect(err(norm(paymentBody({ split: { method: 'equal', entries: [{ memberId: 'm-gino' }] } })))).toMatchObject({ code: 'payment_split' });
    const twoTo = { method: 'exact', entries: [{ memberId: 'm-gino', value: 3000 }, { memberId: 'm-abbie', value: 150 }] };
    expect(err(norm(paymentBody({ split: twoTo })))).toMatchObject({ code: 'payment_split' });
    expect(err(norm(paymentBody({ split: { method: 'exact', entries: [{ memberId: 'm-kevin', value: 3150 }] } })))).toMatchObject({
      code: 'payment_self',
    });
  });

  it('needs the recipient amount and the sent amount to match the total', () => {
    expect(err(norm(paymentBody({ split: { method: 'exact', entries: [{ memberId: 'm-gino', value: 3000 }] } })))).toMatchObject({
      code: 'exact_mismatch',
      field: 'split',
      diff: 150,
    });
    expect(err(norm(paymentBody({ split: { method: 'exact', entries: [{ memberId: 'm-gino' }] } })))).toMatchObject({ code: 'invalid_value' });
    expect(err(norm(paymentBody({ payers: [{ memberId: 'm-kevin', amount: 3000 }] })))).toMatchObject({
      code: 'payers_mismatch',
      field: 'payers',
      diff: 150,
    });
  });
});

describe('normalizeUpsert: split and payer errors carry code and diff', () => {
  const split = (method: string, entries: unknown[], extra: Body = {}) => expenseBody({ split: { method, entries, ...extra } });

  it('exact and percent mismatches report what is left', () => {
    expect(err(norm(split('exact', [{ memberId: 'm-gino', value: 600 }, { memberId: 'm-abbie', value: 300 }])))).toMatchObject({
      code: 'exact_mismatch',
      field: 'split',
      diff: 100,
    });
    expect(err(norm(split('exact', [{ memberId: 'm-gino', value: 600 }, { memberId: 'm-abbie', value: 500 }])))).toMatchObject({
      code: 'exact_mismatch',
      diff: -100,
    });
    expect(err(norm(split('percent', [{ memberId: 'm-gino', value: 60 }, { memberId: 'm-abbie', value: 30 }])))).toMatchObject({
      code: 'percent_mismatch',
      diff: 10,
    });
  });

  it('reports the other split problems by code', () => {
    expect(err(norm(split('equal', [])))).toMatchObject({ code: 'no_participants' });
    expect(err(norm(split('equal', [{ memberId: 'm-gino' }, { memberId: 'm-gino' }])))).toMatchObject({ code: 'duplicate_member', field: 'split' });
    expect(err(norm(split('shares', [{ memberId: 'm-gino', value: 0 }, { memberId: 'm-abbie', value: 0 }])))).toMatchObject({ code: 'zero_weights' });
    expect(err(norm(split('exact', [{ memberId: 'm-gino', value: 999.5 }, { memberId: 'm-abbie', value: 0.5 }])))).toMatchObject({ code: 'invalid_value' });
    expect(err(norm(split('adjust', [{ memberId: 'm-gino', value: -1200 }, { memberId: 'm-abbie', value: 0 }])))).toMatchObject({ code: 'negative_share' });
    expect(err(norm(split('items', [], { items: [] })))).toMatchObject({ code: 'no_items' });
    expect(err(norm(split('items', [], { items: [{ id: 'i', name: 'a', amount: 500, memberIds: [] }] })))).toMatchObject({ code: 'item_no_members' });
    expect(err(norm(split('everyone', [{ memberId: 'm-gino' }])))).toMatchObject({ code: 'invalid_field', field: 'split.method' });
  });

  it('reports payer problems by code', () => {
    expect(err(norm(expenseBody({ payers: [] })))).toMatchObject({ code: 'no_payers', field: 'payers' });
    const dup = [{ memberId: 'm-abbie', amount: 500 }, { memberId: 'm-abbie', amount: 500 }];
    expect(err(norm(expenseBody({ payers: dup })))).toMatchObject({ code: 'duplicate_member', field: 'payers' });
    const zero = [{ memberId: 'm-abbie', amount: 1000 }, { memberId: 'm-gino', amount: 0 }];
    expect(err(norm(expenseBody({ payers: zero })))).toMatchObject({ code: 'invalid_value', field: 'payers' });
    const short = [{ memberId: 'm-abbie', amount: 600 }, { memberId: 'm-gino', amount: 300 }];
    expect(err(norm(expenseBody({ payers: short })))).toMatchObject({ code: 'payers_mismatch', diff: 100 });
  });
});

describe('normalizeUpsert: schema limits (SPEC section 6)', () => {
  it('reports the first bad field with the zod issues', () => {
    const e = err(norm(expenseBody({ amount: -5 })));
    expect(e).toMatchObject({ code: 'invalid_field', field: 'amount' });
    expect(Array.isArray(e.issues) && e.issues.length > 0).toBe(true);
  });

  it('needs the amount to be a whole number of minor units from 1 to MAX_AMOUNT', () => {
    for (const amount of [0, -1, 1.5, MAX_AMOUNT + 1, '1000', null]) {
      expect(err(norm(expenseBody({ amount })))).toMatchObject({ code: 'invalid_field', field: 'amount' });
    }
    const max = ok(norm(expenseBody({ amount: MAX_AMOUNT, payers: [{ memberId: 'm-abbie', amount: MAX_AMOUNT }] })));
    expect(max.amount).toBe(MAX_AMOUNT);
  });

  it('needs safe integers for payer amounts and finite split values', () => {
    expect(err(norm(expenseBody({ payers: [{ memberId: 'm-abbie', amount: 1e300 }] })))).toMatchObject({ field: 'payers.0.amount' });
    expect(err(norm(expenseBody({ payers: [{ memberId: 'm-abbie', amount: 999.9 }] })))).toMatchObject({ field: 'payers.0.amount' });
    const inf = { method: 'shares', entries: [{ memberId: 'm-gino', value: Infinity }] };
    expect(err(norm(expenseBody({ split: inf })))).toMatchObject({ field: 'split.entries.0.value' });
  });

  it('limits notes, list sizes and item names', () => {
    expect(ok(norm(expenseBody({ notes: 'n'.repeat(2000) }))).notes).toHaveLength(2000);
    expect(err(norm(expenseBody({ notes: 'n'.repeat(2001) })))).toMatchObject({ field: 'notes' });
    const many = Array.from({ length: 51 }, (_, i) => ({ memberId: 'm-' + i }));
    expect(err(norm(expenseBody({ split: { method: 'equal', entries: many } })))).toMatchObject({ field: 'split.entries' });
    const payers = Array.from({ length: 51 }, (_, i) => ({ memberId: 'p-' + i, amount: 1 }));
    expect(err(norm(expenseBody({ payers })))).toMatchObject({ field: 'payers' });
    const longName = { method: 'items', entries: [], items: [{ id: 'i', name: 'x'.repeat(61), amount: 1000, memberIds: ['m-gino'] }] };
    expect(err(norm(expenseBody({ split: longName })))).toMatchObject({ field: 'split.items.0.name' });
    const okName = { method: 'items', entries: [], items: [{ id: 'i', name: 'x'.repeat(60), amount: 1000, memberIds: ['m-gino'] }] };
    expect(norm(expenseBody({ split: okName })).ok).toBe(true);
  });

  it('rejects unknown kinds and repeats, and bodies that are not objects', () => {
    expect(err(norm(expenseBody({ kind: 'refund' })))).toMatchObject({ field: 'kind' });
    expect(err(norm(expenseBody({ repeat: 'daily' })))).toMatchObject({ field: 'repeat' });
    for (const body of [null, [], 'expense', 42, undefined]) {
      const e = err(norm(body));
      expect(e.code).toBe('invalid_field');
      expect(e.field).toBeUndefined();
    }
  });
});

// ---------- repeatFields ----------

describe('repeatFields', () => {
  const row = (over: Partial<ExpenseRow>) => ({ repeat: 'none', repeat_series: null, repeat_start: null, date: '2026-10-01', ...over });

  it('starts a series at the entry for a new repeating entry', () => {
    expect(repeatFields(null, 'e1', { repeat: 'weekly', date: '2026-10-01' })).toEqual({ series: 'e1', start: '2026-10-01' });
    expect(repeatFields(null, 'e1', { repeat: 'none', date: '2026-10-01' })).toEqual({ series: null, start: null });
  });

  it('keeps series and start while the repeat and the date stay the same', () => {
    const head = row({ repeat: 'monthly', repeat_series: 's1', repeat_start: '2026-01-31', date: '2026-09-30' });
    expect(repeatFields(head, 'c9', { repeat: 'monthly', date: '2026-09-30' })).toEqual({ series: 's1', start: '2026-01-31' });
  });

  it('restarts the schedule at the entry date when the repeat or the date changes', () => {
    const head = row({ repeat: 'monthly', repeat_series: 's1', repeat_start: '2026-01-31', date: '2026-09-30' });
    expect(repeatFields(head, 'c9', { repeat: 'weekly', date: '2026-09-30' })).toEqual({ series: 's1', start: '2026-09-30' });
    expect(repeatFields(head, 'c9', { repeat: 'monthly', date: '2026-09-29' })).toEqual({ series: 's1', start: '2026-09-29' });
  });

  it('keeps the series of a copy when repeat is turned on or off', () => {
    const copy = row({ repeat: 'none', repeat_series: 's1', repeat_start: '2026-01-31', date: '2026-03-31' });
    expect(repeatFields(copy, 'c3', { repeat: 'monthly', date: '2026-03-31' })).toEqual({ series: 's1', start: '2026-03-31' });
    const head = row({ repeat: 'weekly', repeat_series: 's1', repeat_start: '2026-01-01', date: '2026-03-26' });
    expect(repeatFields(head, 'c3', { repeat: 'none', date: '2026-03-26' })).toEqual({ series: 's1', start: '2026-01-01' });
  });

  it('uses the entry id when an old repeating row has no series yet', () => {
    expect(repeatFields(row({ repeat: 'weekly', date: '2026-10-01' }), 'e7', { repeat: 'weekly', date: '2026-10-01' })).toEqual({
      series: 'e7',
      start: '2026-10-01',
    });
  });
});

// ---------- expenseChanges ----------

function expenseRow(over: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: 'e1',
    group_id: 'g1',
    kind: 'expense',
    description: '燒肉晚餐',
    category: 'food.dining',
    amount: 12600,
    currency: 'JPY',
    fx_rate: 1,
    date: '2026-10-15',
    notes: '',
    payers: JSON.stringify([{ memberId: 'm-gino', amount: 12600 }]),
    split: JSON.stringify({ method: 'equal', entries: [{ memberId: 'm-gino' }, { memberId: 'm-abbie' }] }),
    shares: JSON.stringify([
      { memberId: 'm-gino', amount: 6300 },
      { memberId: 'm-abbie', amount: 6300 },
    ]),
    repeat: 'none',
    repeat_series: null,
    repeat_start: null,
    created_by: 'u1',
    created_at: '2026-10-15T10:00:00.000Z',
    updated_by: 'u1',
    updated_at: '2026-10-15T10:00:00.000Z',
    deleted_at: null,
    deleted_by: null,
    version: 1,
    ...over,
  };
}

describe('expenseChanges', () => {
  const names = new Map([
    ['m-gino', 'Gino'],
    ['m-abbie', 'Abbie'],
    ['m-kevin', 'Kevin'],
  ]);
  const jpyBody = (over: Body = {}) =>
    expenseBody({
      amount: 12600,
      currency: 'JPY',
      fxRate: 0.2105,
      payers: [{ memberId: 'm-gino', amount: 12600 }],
      split: { method: 'equal', entries: [{ memberId: 'm-gino' }, { memberId: 'm-abbie' }] },
      ...over,
    });
  const jpy = (over: Body = {}) => ok(normalizeUpsert(jpyBody(over), 'JPY', MEMBERS, TODAY));

  it('is empty when nothing changed', () => {
    expect(expenseChanges(rowFields(expenseRow()), jpy(), names)).toEqual([]);
  });

  it('lists description and amount with formatted money, not the rescaled payer or split', () => {
    const after = jpy({ description: '燒肉晚餐（含飲料）', amount: 14000, payers: [{ memberId: 'm-gino', amount: 14000 }] });
    expect(expenseChanges(rowFields(expenseRow()), after, names)).toEqual([
      { field: 'description', from: '燒肉晚餐', to: '燒肉晚餐（含飲料）' },
      { field: 'amount', from: '¥12,600', to: '¥14,000' },
    ]);
  });

  it('lists payers with amounts when several paid, and the split as resulting shares', () => {
    const after = jpy({
      payers: [{ memberId: 'm-gino', amount: 10000 }, { memberId: 'm-abbie', amount: 2600 }],
      split: { method: 'exact', entries: [{ memberId: 'm-gino', value: 4200 }, { memberId: 'm-abbie', value: 4200 }, { memberId: 'm-kevin', value: 4200 }] },
    });
    expect(expenseChanges(rowFields(expenseRow()), after, names)).toEqual([
      { field: 'payers', from: 'Gino', to: 'Gino ¥10,000, Abbie ¥2,600' },
      { field: 'split', from: 'Gino ¥6,300, Abbie ¥6,300', to: 'Gino ¥4,200, Abbie ¥4,200, Kevin ¥4,200' },
    ]);
  });

  it('lists a currency switch as amount, currency and rate', () => {
    const after = ok(
      normalizeUpsert(
        jpyBody({ currency: 'TWD', amount: 2400, fxRate: 4.75, payers: [{ memberId: 'm-gino', amount: 2400 }] }),
        'JPY',
        MEMBERS,
        TODAY,
      ),
    );
    expect(expenseChanges(rowFields(expenseRow()), after, names)).toEqual([
      { field: 'amount', from: '¥12,600', to: 'NT$2,400' },
      { field: 'currency', from: 'JPY', to: 'TWD' },
      { field: 'fxRate', from: '1', to: '4.75' },
    ]);
  });

  it('uses keys for category and repeat, cuts long notes, and lists the date', () => {
    const after = jpy({ category: 'travel.ski', repeat: 'monthly', notes: '雪'.repeat(250), date: '2026-10-14' });
    const changes = expenseChanges(rowFields(expenseRow()), after, names);
    expect(changes.map(c => c.field)).toEqual(['date', 'category', 'notes', 'repeat']);
    expect(changes[1]).toEqual({ field: 'category', from: 'food.dining', to: 'travel.ski' });
    expect(changes[3]).toEqual({ field: 'repeat', from: 'none', to: 'monthly' });
    expect(Array.from(changes[2].to)).toHaveLength(201);
    expect(changes[2].to.endsWith('…')).toBe(true);
  });

  it('does not list the split when only the key order of the stored JSON differs', () => {
    const reordered = expenseRow({ split: '{"entries":[{"memberId":"m-gino"},{"memberId":"m-abbie"}],"method":"equal"}' });
    expect(expenseChanges(rowFields(reordered), jpy(), names)).toEqual([]);
  });

  it('shows ? for a member it cannot name, and lists a kind change', () => {
    const before = rowFields(expenseRow({ payers: JSON.stringify([{ memberId: 'm-gone', amount: 12600 }]) }));
    const after = ok(normalizeUpsert(paymentBody({ amount: 12600, currency: 'JPY', payers: [{ memberId: 'm-gino', amount: 12600 }], split: { method: 'exact', entries: [{ memberId: 'm-abbie', value: 12600 }] } }), 'JPY', MEMBERS, TODAY));
    const changes = expenseChanges(before, after, names);
    expect(changes[0]).toEqual({ field: 'kind', from: 'expense', to: 'payment' });
    expect(changes.find(c => c.field === 'payers')).toEqual({ field: 'payers', from: '?', to: 'Gino' });
  });

  it('does not list a split or payers that only changed order (the editor lists "me" first)', () => {
    const before = rowFields(expenseRow({ payers: JSON.stringify([{ memberId: 'm-gino', amount: 10000 }, { memberId: 'm-abbie', amount: 2600 }]) }));
    const after = jpy({
      payers: [{ memberId: 'm-abbie', amount: 2600 }, { memberId: 'm-gino', amount: 10000 }],
      split: { method: 'equal', entries: [{ memberId: 'm-abbie' }, { memberId: 'm-gino' }] },
    });
    expect(expenseChanges(before, after, names)).toEqual([]);
  });

  it('lists the split when the shares moved while the amount stayed, so no balance change goes unlisted', () => {
    const before = rowFields(expenseRow({ shares: JSON.stringify([{ memberId: 'm-gino', amount: 6301 }, { memberId: 'm-abbie', amount: 6299 }]) }));
    expect(expenseChanges(before, jpy(), names)).toEqual([
      { field: 'split', from: 'Gino ¥6,301, Abbie ¥6,299', to: 'Gino ¥6,300, Abbie ¥6,300' },
    ]);
  });
});

// ---------- edits made from an older copy ----------

describe('splitKey', () => {
  it('ignores entry order, item ids and the values of an equal split', () => {
    const a: SplitInput = { method: 'equal', entries: [{ memberId: 'x' }, { memberId: 'y', value: 3 }] };
    const b: SplitInput = { method: 'equal', entries: [{ memberId: 'y' }, { memberId: 'x' }] };
    expect(splitKey(a)).toBe(splitKey(b));
    const items = (id: string, members: string[]): SplitInput => ({ method: 'items', entries: [], items: [{ id, name: '啤酒', amount: 400, memberIds: members }] });
    expect(splitKey(items('i1', ['x', 'y']))).toBe(splitKey(items('i9', ['y', 'x'])));
  });

  it('tells apart methods, values, people and item amounts', () => {
    const base: SplitInput = { method: 'shares', entries: [{ memberId: 'x', value: 1 }, { memberId: 'y', value: 2 }] };
    expect(splitKey(base)).not.toBe(splitKey({ ...base, method: 'percent' }));
    expect(splitKey(base)).not.toBe(splitKey({ method: 'shares', entries: [{ memberId: 'x', value: 2 }, { memberId: 'y', value: 1 }] }));
    expect(splitKey(base)).not.toBe(splitKey({ method: 'shares', entries: [{ memberId: 'x', value: 1 }] }));
    const items = (amount: number): SplitInput => ({ method: 'items', entries: [], items: [{ id: 'i', name: 'a', amount, memberIds: ['x'] }] });
    expect(splitKey(items(400))).not.toBe(splitKey(items(401)));
  });
});

describe('mergeEdit', () => {
  const base = ok(norm(expenseBody()));
  const theirs = ok(norm(expenseBody({ amount: 1600, payers: [{ memberId: 'm-abbie', amount: 1600 }] })));

  it('writes the parts I changed and keeps what someone else changed in the others', () => {
    const mine = ok(norm(expenseBody({ description: '燒肉晚餐（B）', split: { method: 'equal', entries: [{ memberId: 'm-kevin' }, { memberId: 'm-gino' }, { memberId: 'm-abbie' }] } })));
    const m = mergeEdit(theirs, base, mine);
    expect(m.conflicts).toEqual([]);
    expect(m.merged).toMatchObject({ amount: 1600, description: '燒肉晚餐（B）', payers: theirs.payers, split: theirs.split });
  });

  it('is a conflict only when both changed a part to different values', () => {
    const mine = ok(norm(expenseBody({ amount: 1200, payers: [{ memberId: 'm-abbie', amount: 1200 }], notes: 'B' })));
    expect(mergeEdit(theirs, base, mine).conflicts).toEqual(['money']);
    expect(mergeEdit(theirs, base, theirs)).toEqual({ merged: theirs, conflicts: [] });
    // Nothing changed by me: what is stored stays.
    expect(mergeEdit(theirs, base, base)).toEqual({ merged: theirs, conflicts: [] });
  });

  it('changedParts lists the parts that differ', () => {
    const other = ok(norm(expenseBody({ date: '2026-10-14', notes: 'x', category: 'transport.taxi', repeat: 'monthly' })));
    expect(changedParts(base, other)).toEqual(['category', 'date', 'notes', 'repeat']);
    expect(changedParts(base, theirs)).toEqual(['money']);
    expect(changedParts(base, base)).toEqual([]);
  });
});

describe('legacyConflict', () => {
  const stored = { version: 3, updated_by: 'u-abbie' };
  it('is true only for an older baseVersion when someone else made the last change', () => {
    expect(legacyConflict(stored, 2, 'u-gino')).toBe(true);
    expect(legacyConflict(stored, 3, 'u-gino')).toBe(false);
    expect(legacyConflict(stored, 4, 'u-gino')).toBe(false); // counts unsynced local edits
    expect(legacyConflict(stored, 2, 'u-abbie')).toBe(false); // my own last change (undo, quick second save)
    for (const v of [undefined, null, '2', 1.5, Number.NaN]) expect(legacyConflict(stored, v, 'u-gino')).toBe(false);
  });
});

describe('keepStoredShares', () => {
  const split3: SplitInput = { method: 'equal', entries: [{ memberId: 'm-gino' }, { memberId: 'm-abbie' }, { memberId: 'm-kevin' }] };
  const next = ok(normalizeUpsert(expenseBody({ amount: 100, payers: [{ memberId: 'm-abbie', amount: 100 }], split: split3 }), 'TWD', MEMBERS, TODAY, 'copy-0001'));
  const fields = (over: Partial<EntryFields> = {}): EntryFields => ({ ...next, ...over });
  // Another way to round NT$100 three ways (computed now: Gino gets the leftover unit).
  const variant = [
    { memberId: 'm-gino', amount: 33 },
    { memberId: 'm-abbie', amount: 33 },
    { memberId: 'm-kevin', amount: 34 },
  ];

  it('keeps stored shares for the same kind, amount, currency and split (in any order)', () => {
    expect(next.shares).not.toEqual(variant);
    expect(keepStoredShares(fields({ shares: variant }), next)).toEqual(variant);
    const reordered = { method: 'equal' as const, entries: [...split3.entries].reverse() };
    expect(keepStoredShares(fields({ shares: variant, split: reordered }), next)).toEqual(variant);
  });

  it('recomputes when the amount, currency, kind or split changed, or for exact splits', () => {
    expect(keepStoredShares(fields({ shares: variant, amount: 101 }), next)).toBe(next.shares);
    expect(keepStoredShares(fields({ shares: variant, currency: 'JPY' }), next)).toBe(next.shares);
    expect(keepStoredShares(fields({ shares: variant, kind: 'payment' }), next)).toBe(next.shares);
    expect(keepStoredShares(fields({ shares: variant, split: { method: 'equal', entries: split3.entries.slice(0, 2) } }), next)).toBe(next.shares);
    const exact = ok(normalizeUpsert(expenseBody({ amount: 100, payers: [{ memberId: 'm-abbie', amount: 100 }], split: { method: 'exact', entries: [{ memberId: 'm-gino', value: 50 }, { memberId: 'm-abbie', value: 50 }] } }), 'TWD', MEMBERS, TODAY, 'x-0000001'));
    expect(keepStoredShares({ ...exact, shares: [{ memberId: 'm-gino', amount: 51 }, { memberId: 'm-abbie', amount: 49 }] }, exact)).toBe(exact.shares);
  });

  it('recomputes stored shares that are not a valid rounding of the split', () => {
    const bad = [
      [{ memberId: 'm-gino', amount: 35 }, { memberId: 'm-abbie', amount: 32 }, { memberId: 'm-kevin', amount: 33 }], // two units off
      [{ memberId: 'm-gino', amount: 34 }, { memberId: 'm-abbie', amount: 33 }, { memberId: 'm-kevin', amount: 34 }], // wrong total
      [{ memberId: 'm-gino', amount: 34 }, { memberId: 'm-abbie', amount: 33 }, { memberId: 'm-left', amount: 33 }], // not in the split
      [{ memberId: 'm-gino', amount: 34 }, { memberId: 'm-gino', amount: 33 }, { memberId: 'm-kevin', amount: 33 }], // twice
      [{ memberId: 'm-gino', amount: 50 }, { memberId: 'm-abbie', amount: 50 }], // someone left out
    ];
    for (const shares of bad) expect(keepStoredShares(fields({ shares }), next)).toBe(next.shares);
  });
});

// ---------- snippet ----------

describe('snippet', () => {
  it('keeps short text and cuts long text by code points', () => {
    expect(snippet('我晚點轉給你 🙏')).toBe('我晚點轉給你 🙏');
    const s = snippet('🙏'.repeat(250));
    expect(Array.from(s)).toHaveLength(201);
    expect(s.startsWith('🙏'.repeat(200))).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(snippet('x'.repeat(200))).toBe('x'.repeat(200));
  });
});

// ---------- planImport ----------

describe('planImport', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('validates each entry like a save and reports what it skipped', () => {
    const list = [
      { id: id(1), ...expenseBody() },
      { id: 'bad id!', ...expenseBody() },
      { id: id(2), ...paymentBody() },
      { id: id(2), ...expenseBody() },
      { id: id(3), ...expenseBody({ amount: -5 }) },
      { id: id(4), ...expenseBody({ payers: [{ memberId: 'm-ghost', amount: 1000 }] }) },
      7,
      { ...expenseBody() },
    ];
    const plan = planImport(list, 'TWD', MEMBERS, TODAY, 100);
    expect(plan.accepted.map(a => [a.index, a.id])).toEqual([
      [0, id(1)],
      [2, id(2)],
    ]);
    expect(plan.accepted[1].entry.kind).toBe('payment');
    expect(plan.skipped).toEqual([
      { index: 1, code: 'invalid_id', field: 'id' },
      { index: 3, code: 'duplicate_id', field: 'id' },
      { index: 4, code: 'invalid_field', field: 'amount' },
      { index: 5, code: 'unknown_member', field: 'payers' },
      { index: 6, code: 'invalid_id', field: 'id' },
      { index: 7, code: 'invalid_id', field: 'id' },
    ]);
  });

  it('a duplicate id only counts once the first one was valid', () => {
    const plan = planImport([{ id: id(9), ...expenseBody({ amount: 0 }) }, { id: id(9), ...expenseBody() }], 'TWD', MEMBERS, TODAY, 10);
    expect(plan.accepted.map(a => a.index)).toEqual([1]);
  });

  it('stops at the room left in the group', () => {
    const list = [1, 2, 3, 4].map(n => ({ id: id(n), ...expenseBody() }));
    const plan = planImport(list, 'TWD', MEMBERS, TODAY, 2);
    expect(plan.accepted.map(a => a.index)).toEqual([0, 1]);
    expect(plan.skipped).toEqual([
      { index: 2, code: 'limit_reached' },
      { index: 3, code: 'limit_reached' },
    ]);
    expect(planImport(list, 'TWD', MEMBERS, TODAY, 0).accepted).toEqual([]);
  });
});

// ---------- recurring: dueDates and planSeries ----------

describe('dueDates', () => {
  it('lists every occurrence after the head date up to today', () => {
    expect(dueDates({ date: addDays(TODAY, -15), repeat: 'weekly', repeat_start: addDays(TODAY, -15) }, TODAY)).toEqual([
      addDays(TODAY, -8),
      addDays(TODAY, -1),
    ]);
    expect(dueDates({ date: TODAY, repeat: 'weekly', repeat_start: TODAY }, TODAY)).toEqual([]);
    expect(dueDates({ date: addDays(TODAY, -14), repeat: 'weekly', repeat_start: null }, TODAY)).toEqual([addDays(TODAY, -7), TODAY]);
    expect(dueDates({ date: '2026-09-18', repeat: 'biweekly', repeat_start: '2026-09-18' }, TODAY)).toEqual(['2026-10-02', '2026-10-16']);
  });

  it('keeps the anchor day of the series start for monthly and yearly', () => {
    expect(dueDates({ date: '2026-02-28', repeat: 'monthly', repeat_start: '2026-01-31' }, '2026-04-30')).toEqual(['2026-03-31', '2026-04-30']);
    expect(dueDates({ date: '2024-02-29', repeat: 'yearly', repeat_start: '2024-02-29' }, TODAY)).toEqual(['2025-02-28', '2026-02-28']);
  });

  it('stops at the cap', () => {
    const head = { date: addDays(TODAY, -7 * 70), repeat: 'weekly', repeat_start: null };
    const all = dueDates(head, TODAY);
    expect(all).toHaveLength(60);
    expect(all[0]).toBe(addDays(TODAY, -7 * 69));
    expect(dueDates(head, TODAY, 5)).toHaveLength(5);
    expect(dueDates(head, TODAY, 1000)).toHaveLength(70);
  });

  it('returns nothing for entries that do not repeat or have bad dates', () => {
    expect(dueDates({ date: '2026-01-01', repeat: 'none', repeat_start: null }, TODAY)).toEqual([]);
    expect(dueDates({ date: '2026-01-01', repeat: 'daily', repeat_start: null }, TODAY)).toEqual([]);
    expect(dueDates({ date: 'soon', repeat: 'weekly', repeat_start: null }, TODAY)).toEqual([]);
    expect(dueDates({ date: '2026-10-01', repeat: 'weekly', repeat_start: null }, 'today')).toEqual([]);
    expect(dueDates({ date: '2026-10-01', repeat: 'weekly', repeat_start: 'garbage' }, TODAY)).toEqual(['2026-10-08', '2026-10-15']);
  });
});

describe('planSeries', () => {
  const head = { id: 'h', repeat: 'weekly' as const };
  const due = [
    { date: '2026-10-01', id: 'c1' },
    { date: '2026-10-08', id: 'c2' },
    { date: '2026-10-15', id: 'c3' },
  ];
  const ex = (o: Record<string, Partial<ExistingOccurrence>>) =>
    new Map(Object.entries(o).map(([k, v]) => [k, { group_id: 'g', deleted_at: null, repeat: 'none', ...v }]));
  const none = new Set<string>();

  it('creates every copy and moves the repeat to the newest', () => {
    expect(planSeries(head, due, new Map(), none, 'g')).toEqual({
      copies: [
        { id: 'c1', date: '2026-10-01', repeat: 'none' },
        { id: 'c2', date: '2026-10-08', repeat: 'none' },
        { id: 'c3', date: '2026-10-15', repeat: 'weekly' },
      ],
      flagTo: null,
      clearHead: true,
    });
  });

  it('never recreates an occurrence that exists, also a deleted one', () => {
    const plan = planSeries(head, due, ex({ c1: {}, c3: { deleted_at: '2026-10-15T00:00:00Z' } }), none, 'g');
    expect(plan).toEqual({ copies: [{ id: 'c2', date: '2026-10-08', repeat: 'weekly' }], flagTo: null, clearHead: true });
  });

  it('hands the repeat to an existing live copy when it is the newest occurrence', () => {
    expect(planSeries(head, due, ex({ c3: {} }), none, 'g')).toEqual({
      copies: [
        { id: 'c1', date: '2026-10-01', repeat: 'none' },
        { id: 'c2', date: '2026-10-08', repeat: 'none' },
      ],
      flagTo: 'c3',
      clearHead: true,
    });
    expect(planSeries(head, due, ex({ c1: {}, c2: {}, c3: {} }), none, 'g')).toEqual({ copies: [], flagTo: 'c3', clearHead: true });
  });

  it('does nothing when every due occurrence is deleted or belongs elsewhere', () => {
    const gone = ex({ c1: { deleted_at: 'x' }, c2: { group_id: 'other' }, c3: { deleted_at: 'x' } });
    expect(planSeries(head, due, gone, none, 'g')).toEqual({ copies: [], flagTo: null, clearHead: false });
  });

  it('merges into a head that is already ahead with the same repeat', () => {
    expect(planSeries(head, due, ex({ c2: { repeat: 'weekly' } }), none, 'g')).toEqual({ copies: [], flagTo: null, clearHead: true });
  });

  it('steps over a head with another repeat', () => {
    expect(planSeries(head, due, ex({ c3: { repeat: 'monthly' } }), none, 'g')).toEqual({
      copies: [
        { id: 'c1', date: '2026-10-01', repeat: 'none' },
        { id: 'c2', date: '2026-10-08', repeat: 'weekly' },
      ],
      flagTo: null,
      clearHead: true,
    });
  });

  it('skips its own id (a moved head) and ids another head plans in the same run', () => {
    const moved = planSeries({ id: 'c3', repeat: 'weekly' }, due, new Map(), new Set(['c1']), 'g');
    expect(moved).toEqual({ copies: [{ id: 'c2', date: '2026-10-08', repeat: 'weekly' }], flagTo: null, clearHead: true });
    expect(planSeries(head, [], new Map(), none, 'g')).toEqual({ copies: [], flagTo: null, clearHead: false });
  });
});

// ---------- materializeDue and runDaily against a fake D1 ----------

interface Call {
  sql: string;
  params: unknown[];
}

class FakeStmt {
  constructor(
    readonly db: FakeDb,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]): FakeStmt {
    return new FakeStmt(this.db, this.sql, params);
  }
  all() {
    return this.db.exec(this);
  }
  run() {
    return this.db.exec(this);
  }
  async first() {
    return (await this.db.exec(this)).results[0] ?? null;
  }
}

class FakeDb {
  calls: Call[] = [];
  batches: Call[][] = [];
  constructor(
    readonly answer: (sql: string, params: unknown[]) => unknown[] = () => [],
    readonly onBatch: (stmts: FakeStmt[]) => void = () => {},
  ) {}
  prepare(sql: string): FakeStmt {
    return new FakeStmt(this, sql);
  }
  async exec(s: FakeStmt) {
    this.calls.push({ sql: s.sql, params: s.params });
    return { results: this.answer(s.sql, s.params), success: true, meta: { changes: 1 } };
  }
  async batch(stmts: FakeStmt[]) {
    this.batches.push(stmts.map(s => ({ sql: s.sql, params: s.params })));
    this.onBatch(stmts);
    const out = [];
    for (const s of stmts) out.push(await this.exec(s));
    return out;
  }
  get d1(): D1Database {
    return this as unknown as D1Database;
  }
}

function headRow(over: Partial<ExpenseRow> & { g_currency?: string } = {}) {
  return { ...expenseRow({ id: 'h1', currency: 'TWD', repeat: 'weekly', repeat_series: 'h1', date: addDays(TODAY, -15), repeat_start: addDays(TODAY, -15) }), g_currency: 'TWD', ...over };
}

const isHeads = (sql: string) => sql.startsWith('SELECT e.*');
const isLookup = (sql: string) => sql.startsWith('SELECT id, group_id, deleted_at, repeat FROM expenses WHERE id IN');

describe('materializeDue', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(refreshSummary).mockClear();
  });
  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
  });

  it('costs one query when nothing is due', async () => {
    const db = new FakeDb(sql => (isHeads(sql) ? [headRow({ date: TODAY, repeat_start: TODAY })] : []));
    expect(await materializeDue(db.d1, { groupId: 'g1', today: TODAY })).toBe(0);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].params).toEqual(['g1']);
    expect(db.batches).toHaveLength(0);
  });

  it('writes the copies, their activity, the repeat move and one version bump in one batch', async () => {
    const db = new FakeDb(sql => (isHeads(sql) ? [headRow()] : []));
    expect(await materializeDue(db.d1, { groupId: 'g1', today: TODAY })).toBe(2);
    const id1 = await uuidFrom(`h1:${addDays(TODAY, -8)}`);
    const id2 = await uuidFrom(`h1:${addDays(TODAY, -1)}`);
    const lookup = db.batches[0];
    expect(lookup).toHaveLength(1);
    expect(isLookup(lookup[0].sql)).toBe(true);
    expect(lookup[0].params).toEqual([id1, id2]);

    const write = db.batches[1];
    const kinds = write.map(c => c.sql.split(' ').slice(0, 3).join(' '));
    expect(kinds).toEqual([
      'INSERT INTO expenses',
      'INSERT INTO activity',
      'INSERT INTO expenses',
      'INSERT INTO activity',
      "UPDATE expenses SET",
      'UPDATE groups SET',
    ]);
    // Copies: id, group, date, repeat, series, start, created_by.
    expect(write[0].params[0]).toBe(id1);
    expect(write[0].params[1]).toBe('g1');
    expect(write[0].params[8]).toBe(addDays(TODAY, -8));
    expect(write[0].params.slice(13, 17)).toEqual(['none', 'h1', addDays(TODAY, -15), 'u1']);
    expect(write[2].params[0]).toBe(id2);
    expect(write[2].params[13]).toBe('weekly');
    // Plain INSERT (a concurrent run's batch then fails as a whole).
    expect(write[0].sql).not.toMatch(/OR IGNORE/);
    // Activity by the system for each copy.
    expect(write[1].params[0]).toMatchObject({ groupId: 'g1', userId: null, memberId: null, type: 'recurring.create', expenseId: id1 });
    // The old head gives up its repeat, guarded by the value read.
    expect(write[4].sql).toMatch(/SET repeat = 'none'/);
    expect(write[4].params).toEqual(['h1', 'weekly']);
    expect(write[5].params[1]).toBe('g1');
    expect(refreshSummary).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refreshSummary).mock.calls[0][1]).toBe('g1');
  });

  it('gives each copy the shares and activity of its own id, not the head\'s', async () => {
    const split: SplitInput = { method: 'equal', entries: [{ memberId: 'm-gino' }, { memberId: 'm-abbie' }, { memberId: 'm-kevin' }] };
    const headShares = computeSharesFor('h1', 100, split);
    if (!headShares.ok) throw new Error('fixture');
    const head = headRow({ amount: 100, payers: JSON.stringify([{ memberId: 'm-abbie', amount: 100 }]), split: JSON.stringify(split), shares: JSON.stringify(headShares.shares) });
    const db = new FakeDb(sql => (isHeads(sql) ? [head] : []));
    vi.mocked(entryActivityData).mockClear();
    expect(await materializeDue(db.d1, { groupId: 'g1', today: TODAY })).toBe(2);
    const inserts = db.batches[1].filter(c => c.sql.startsWith('INSERT INTO expenses'));
    const ids = inserts.map(c => c.params[0] as string);
    for (const ins of inserts) {
      const want = computeSharesFor(ins.params[0] as string, 100, split);
      expect(want.ok && JSON.parse(ins.params[12] as string)).toEqual(want.ok && want.shares);
    }
    const calls = vi.mocked(entryActivityData).mock.calls.map(c => c[0]);
    expect(calls.map(e => e.id)).toEqual(ids);
    expect(calls.map(e => e.shares)).toEqual(inserts.map(c => JSON.parse(c.params[12] as string)));
  });

  it('copyShares falls back to the head\'s shares when the split cannot be read', () => {
    const split: SplitInput = { method: 'equal', entries: [{ memberId: 'm-gino' }, { memberId: 'm-abbie' }, { memberId: 'm-kevin' }] };
    const shares = [{ memberId: 'm-gino', amount: 34 }, { memberId: 'm-abbie', amount: 33 }, { memberId: 'm-kevin', amount: 33 }];
    const head = { amount: 100, split: JSON.stringify(split), shares: JSON.stringify(shares) };
    const own = computeSharesFor('c-0000001', 100, split);
    expect(copyShares(head, 'c-0000001')).toEqual(own.ok ? own.shares : null);
    expect(copyShares({ ...head, split: 'not json' }, 'c-0000001')).toEqual(shares);
    expect(copyShares({ ...head, split: JSON.stringify({ method: 'equal', entries: [] }) }, 'c-0000001')).toEqual(shares);
  });

  it('moves the repeat onto an existing copy without inserting it again', async () => {
    const id2 = await uuidFrom(`h1:${addDays(TODAY, -1)}`);
    const db = new FakeDb((sql, params) => {
      if (isHeads(sql)) return [headRow()];
      if (isLookup(sql)) return params.includes(id2) ? [{ id: id2, group_id: 'g1', deleted_at: null, repeat: 'none' }] : [];
      return [];
    });
    expect(await materializeDue(db.d1, { today: TODAY })).toBe(1);
    const write = db.batches[1];
    expect(write.filter(c => c.sql.startsWith('INSERT INTO expenses'))).toHaveLength(1);
    const flag = write.find(c => c.sql.includes('repeat_series = ?2'));
    expect(flag?.params).toEqual(['weekly', 'h1', addDays(TODAY, -15), id2, 'g1']);
    expect(flag?.sql).toMatch(/repeat = 'none'/);
  });

  it('treats a duplicate id in the batch as another run having done the work', async () => {
    const db = new FakeDb(
      sql => (isHeads(sql) ? [headRow()] : []),
      stmts => {
        if (stmts.some(s => s.sql.startsWith('INSERT INTO expenses'))) {
          throw new Error('D1_ERROR: UNIQUE constraint failed: expenses.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)');
        }
      },
    );
    await expect(materializeDue(db.d1, { groupId: 'g1', today: TODAY })).resolves.toBe(0);
    expect(refreshSummary).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it('never throws: a failing group is logged and the others still run', async () => {
    const heads = [headRow({ group_id: 'bad' }), headRow({ id: 'h2', repeat_series: 'h2', group_id: 'good' })];
    const db = new FakeDb(
      sql => (isHeads(sql) ? heads : []),
      stmts => {
        if (stmts.some(s => s.sql.startsWith('INSERT INTO expenses') && s.params[1] === 'bad')) throw new Error('D1_ERROR: disk I/O error');
      },
    );
    await expect(materializeDue(db.d1, { today: TODAY })).resolves.toBe(2);
    expect(error).toHaveBeenCalledTimes(1);
    const broken = new FakeDb(() => {
      throw new Error('D1 is down');
    });
    await expect(materializeDue(broken.d1, { today: TODAY })).resolves.toBe(0);
  });

  it('caps the copies per group and per series in one run', async () => {
    const heads = [1, 2, 3].map(n =>
      headRow({ id: 'h' + n, repeat_series: 'h' + n, date: addDays(TODAY, -7 * 100), repeat_start: addDays(TODAY, -7 * 100) }),
    );
    const db = new FakeDb(sql => (isHeads(sql) ? heads : []));
    expect(await materializeDue(db.d1, { today: TODAY })).toBe(120);
    const inserts = db.batches.flat().filter(c => c.sql.startsWith('INSERT INTO expenses'));
    expect(inserts).toHaveLength(120);
    expect(new Set(inserts.map(c => c.params[0])).size).toBe(120);
  });

  it('ignores an invalid today without touching the database', async () => {
    const db = new FakeDb();
    expect(await materializeDue(db.d1, { today: '2026-13-01' })).toBe(0);
    expect(db.calls).toHaveLength(0);
  });
});

describe('runDaily', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getUsdRates).mockClear();
  });
  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
  });

  const env = (db: FakeDb) => ({ DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'https://example.test/', ENVIRONMENT: 'test' }) as Env;
  const NOW = new Date('2026-10-16T09:00:00.000Z');

  it('deletes expired rows with the right cutoffs', () => {
    const db = new FakeDb();
    const stmts = cleanupStmts(db.d1, NOW) as unknown as FakeStmt[];
    expect(stmts.map(s => [s.sql, s.params])).toEqual([
      ['DELETE FROM sessions WHERE expires_at < ?', ['2026-10-16T09:00:00.000Z']],
      ['DELETE FROM login_codes WHERE expires_at < ?', ['2026-10-16T09:00:00.000Z']],
      ['DELETE FROM claim_tokens WHERE expires_at < ?', ['2026-10-16T09:00:00.000Z']],
      ['DELETE FROM rate_limits WHERE reset_at < ?', [NOW.getTime() - 86_400_000]],
      ['DELETE FROM push_pending WHERE created_at < ?', ['2026-10-15T09:00:00.000Z']],
    ]);
  });

  it('runs cleanup, recurring copies and the rate warm-up for today', async () => {
    const db = new FakeDb(sql => (isHeads(sql) ? [headRow()] : []));
    await runDaily(env(db), NOW);
    expect(db.batches[0].map(c => c.sql.split(' ')[2])).toEqual(['sessions', 'login_codes', 'claim_tokens', 'rate_limits', 'push_pending']);
    expect(db.calls.some(c => isHeads(c.sql) && c.params.length === 0)).toBe(true);
    expect(getUsdRates).toHaveBeenCalledWith(db.d1, '2026-10-16');
    const lines = log.mock.calls.map(c => String(c[0]));
    expect(lines).toEqual([
      'cron cleanup: removed 1 sessions, 1 codes, 1 claim links, 1 rate limits, 1 kept pushes',
      'cron recurring: created 2 copies',
      'cron fx: rates for 2026-10-16 (test)',
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps going when a step fails and never throws', async () => {
    const db = new FakeDb(
      () => [],
      () => {
        throw new Error('D1 is down');
      },
    );
    vi.mocked(getUsdRates).mockRejectedValueOnce(new Error('fx_unavailable'));
    await expect(runDaily(env(db), NOW)).resolves.toBeUndefined();
    expect(error.mock.calls.map(c => String(c[0]))).toEqual(['cron cleanup failed', 'cron fx failed']);
    expect(log.mock.calls.map(c => String(c[0]))).toEqual(['cron recurring: created 0 copies']);
  });
});
