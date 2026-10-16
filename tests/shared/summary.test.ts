import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeGroupSummary, SUMMARY_VERSION } from '../../src/shared/summary';
import { entryNet, netBalances, spendTotals, type LedgerEntry } from '../../src/shared/balances';
import { settlementPlan, type Transfer } from '../../src/shared/settle';
import type { Portion } from '../../src/shared/split';

const MEMBERS = ['gino', 'abbie', 'chris', 'dana', 'eli'];
const CURRENCIES = ['TWD', 'USD', 'JPY', 'KRW', 'EUR'];
const BASES = ['TWD', 'USD', 'JPY'];

const sumValues = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

function flows(transfers: readonly Transfer[]): Record<string, number> {
  const f: Record<string, number> = {};
  for (const t of transfers) {
    f[t.to] = (f[t.to] ?? 0) + t.amount;
    f[t.from] = (f[t.from] ?? 0) - t.amount;
  }
  return f;
}

function portions(amount: number, ids: readonly string[], weights: readonly number[]): Portion[] {
  let w = weights.slice(0, ids.length);
  if (w.every(x => x === 0)) w = ids.map(() => 1);
  const W = w.reduce((a, b) => a + b, 0);
  const out = ids.map((memberId, i) => ({ memberId, amount: Math.floor((amount * w[i]) / W) }));
  out[0].amount += amount - out.reduce((a, p) => a + p.amount, 0);
  return out.filter(p => p.amount > 0);
}

const rateArb = fc.double({ min: -3, max: 3, noNaN: true }).map(u => Number(Math.pow(10, u).toPrecision(6)));
const dateArb = fc.integer({ min: 0, max: 700 }).map(d => new Date(Date.UTC(2025, 5, 1 + d)).toISOString().slice(0, 10));

const entryArb = (base: string) =>
  fc
    .record({
      kind: fc.constantFrom<'expense' | 'payment'>('expense', 'expense', 'expense', 'payment'),
      currency: fc.oneof(fc.constant(base), fc.constantFrom(...CURRENCIES)),
      amount: fc.oneof(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 5_000_000 })),
      payers: fc.uniqueArray(fc.constantFrom(...MEMBERS), { minLength: 1, maxLength: 3 }),
      payerWeights: fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 3, maxLength: 3 }),
      sharers: fc.uniqueArray(fc.constantFrom(...MEMBERS), { minLength: 1, maxLength: 5 }),
      shareWeights: fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 5, maxLength: 5 }),
      pair: fc.uniqueArray(fc.constantFrom(...MEMBERS), { minLength: 2, maxLength: 2 }),
      rate: rateArb,
      deleted: fc.integer({ min: 0, max: 5 }).map(x => x === 0),
      category: fc.constantFrom('food.dining', 'travel.hotel', 'general', undefined),
      date: fc.option(dateArb, { nil: undefined, freq: 10 }),
    })
    .map(
      (x): Omit<LedgerEntry, 'id'> => ({
        kind: x.kind,
        amount: x.amount,
        currency: x.currency,
        fxRate: x.currency === base ? 1 : x.rate,
        payers: x.kind === 'payment' ? [{ memberId: x.pair[0], amount: x.amount }] : portions(x.amount, x.payers, x.payerWeights),
        shares: x.kind === 'payment' ? [{ memberId: x.pair[1], amount: x.amount }] : portions(x.amount, x.sharers, x.shareWeights),
        category: x.kind === 'payment' ? 'payment' : x.category,
        date: x.date,
        deletedAt: x.deleted ? '2026-10-01T00:00:00.000Z' : null,
      }),
    );

const groupArb = fc.constantFrom(...BASES).chain(currency =>
  fc.record({
    currency: fc.constant(currency),
    simplify: fc.boolean(),
    memberOrder: fc.shuffledSubarray(MEMBERS, { minLength: MEMBERS.length }),
    entries: fc.array(entryArb(currency), { maxLength: 30 }).map(list => list.map((e, i): LedgerEntry => ({ id: 'e' + i, ...e }))),
    forVersion: fc.integer({ min: 0, max: 1_000_000 }),
  }),
);

describe('computeGroupSummary', () => {
  // A Japan trip in a TWD group: a hotel in TWD, ramen in JPY, a payment, and a deleted taxi.
  const trip: LedgerEntry[] = [
    { id: 'hotel', kind: 'expense', amount: 9000, currency: 'TWD', fxRate: 1, category: 'travel.hotel', date: '2026-10-01',
      payers: [{ memberId: 'gino', amount: 9000 }], shares: [{ memberId: 'gino', amount: 3000 }, { memberId: 'abbie', amount: 3000 }, { memberId: 'chris', amount: 3000 }] },
    { id: 'ramen', kind: 'expense', amount: 3000, currency: 'JPY', fxRate: 0.2105, category: 'food.dining', date: '2026-10-02',
      payers: [{ memberId: 'abbie', amount: 3000 }], shares: [{ memberId: 'gino', amount: 1000 }, { memberId: 'abbie', amount: 1000 }, { memberId: 'chris', amount: 1000 }] },
    { id: 'pay', kind: 'payment', amount: 1000, currency: 'TWD', fxRate: 1, category: 'payment', date: '2026-10-03',
      payers: [{ memberId: 'chris', amount: 1000 }], shares: [{ memberId: 'gino', amount: 1000 }] },
    { id: 'taxi', kind: 'expense', amount: 500, currency: 'TWD', fxRate: 1, category: 'transport.taxi', date: '2026-10-04', deletedAt: '2026-10-05T00:00:00Z',
      payers: [{ memberId: 'chris', amount: 500 }], shares: [{ memberId: 'gino', amount: 250 }, { memberId: 'chris', amount: 250 }] },
  ];
  const memberOrder = ['gino', 'abbie', 'chris', 'dana'];

  it('summarizes a trip with simplified debts', () => {
    expect(computeGroupSummary({ currency: 'TWD', simplify: true, memberOrder, entries: trip, forVersion: 7 })).toEqual({
      v: SUMMARY_VERSION,
      forVersion: 7,
      currency: 'TWD',
      net: { gino: 4789, abbie: -2579, chris: -2210, dana: 0 },
      paid: { gino: 9000, abbie: 632 },
      share: { gino: 3211, abbie: 3211, chris: 3210 },
      spent: 9632,
      transfers: [{ from: 'abbie', to: 'gino', amount: 2579 }, { from: 'chris', to: 'gino', amount: 2210 }],
      count: 3,
      lastDate: '2026-10-03',
    });
  });

  it('summarizes the same trip pairwise when simplify is off', () => {
    const s = computeGroupSummary({ currency: 'TWD', simplify: false, memberOrder, entries: trip, forVersion: 7 });
    expect(s.transfers).toEqual([
      { from: 'abbie', to: 'gino', amount: 2789 },
      { from: 'chris', to: 'gino', amount: 2000 },
      { from: 'chris', to: 'abbie', amount: 210 },
    ]);
    expect(s.net).toEqual({ gino: 4789, abbie: -2579, chris: -2210, dana: 0 });
  });

  it('handles an empty group', () => {
    expect(computeGroupSummary({ currency: 'USD', simplify: true, memberOrder: ['a', 'b'], entries: [], forVersion: 0 })).toEqual({
      v: SUMMARY_VERSION,
      forVersion: 0,
      currency: 'USD',
      net: { a: 0, b: 0 },
      paid: {},
      share: {},
      spent: 0,
      transfers: [],
      count: 0,
      lastDate: null,
    });
  });

  it('property: random ledgers give consistent nets, totals, plan, count and last date', () => {
    fc.assert(
      fc.property(groupArb, g => {
        const s = computeGroupSummary(g);
        const live = g.entries.filter(e => !e.deletedAt);
        expect(s.v).toBe(SUMMARY_VERSION);
        expect(s.forVersion).toBe(g.forVersion);
        expect(s.currency).toBe(g.currency);

        // Nets: every member listed, adding up to exactly 0, as netBalances computes them.
        expect(s.net).toEqual(netBalances(live, g.currency, g.memberOrder));
        expect(sumValues(s.net)).toBe(0);
        for (const m of g.memberOrder) expect(Number.isSafeInteger(s.net[m])).toBe(true);

        // Spending: expenses only.
        const t = spendTotals(live, g.currency);
        expect(s.spent).toBe(t.spent);
        expect(s.paid).toEqual(t.paid);
        expect(s.share).toEqual(t.share);
        expect(sumValues(s.paid)).toBe(s.spent);
        expect(sumValues(s.share)).toBe(s.spent);

        // Each member's net = paid - share for expenses + what payments did for them.
        const viaPayments: Record<string, number> = {};
        for (const e of live) if (e.kind === 'payment') for (const [m, v] of entryNet(e, g.currency)) viaPayments[m] = (viaPayments[m] ?? 0) + v;
        for (const m of g.memberOrder) expect(s.net[m]).toBe((s.paid[m] ?? 0) - (s.share[m] ?? 0) + (viaPayments[m] ?? 0));

        // The plan follows the simplify setting and settles everyone exactly.
        expect(s.transfers).toEqual(settlementPlan(live, g.currency, s.net, g.simplify, g.memberOrder));
        const f = flows(s.transfers);
        for (const m of g.memberOrder) expect(f[m] ?? 0).toBe(s.net[m]);

        expect(s.count).toBe(live.length);
        const dates = live.map(e => e.date).filter((d): d is string => !!d).sort();
        expect(s.lastDate).toBe(dates.length ? dates[dates.length - 1] : null);
      }),
      { numRuns: 500 },
    );
  });

  it('property: deleted entries change nothing, and the summary survives a JSON round trip', () => {
    fc.assert(
      fc.property(groupArb, g => {
        const s = computeGroupSummary(g);
        expect(computeGroupSummary({ ...g, entries: g.entries.filter(e => !e.deletedAt) })).toEqual(s);
        // The Worker stores the summary as JSON in groups.summary.
        expect(JSON.parse(JSON.stringify(s))).toEqual(s);
        for (const v of Object.values(s.net)) expect(Object.is(v, -0)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
