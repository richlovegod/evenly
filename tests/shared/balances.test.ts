import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { convertMinor, entryNet, memberEffect, netBalances, spendTotals, toBase, type LedgerEntry } from '../../src/shared/balances';
import { getCurrency } from '../../src/shared/currencies';
import type { Portion } from '../../src/shared/split';

const MEMBERS = ['gino', 'abbie', 'chris', 'dana', 'eli'];
const CURRENCIES = ['TWD', 'USD', 'JPY', 'EUR', 'KRW', 'VND', 'HKD'];
const BASES = ['TWD', 'USD', 'JPY'];

const total = (ps: readonly { amount: number }[]) => ps.reduce((a, p) => a + p.amount, 0);
const sumValues = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

/** Split `amount` by integer weights (floors, remainder to the first); zero parts dropped. */
function portions(amount: number, ids: readonly string[], weights: readonly number[]): Portion[] {
  let w = weights.slice(0, ids.length);
  if (w.every(x => x === 0)) w = ids.map(() => 1);
  const W = w.reduce((a, b) => a + b, 0);
  const out = ids.map((memberId, i) => ({ memberId, amount: Math.floor((amount * w[i]) / W) }));
  out[0].amount += amount - total(out);
  return out.filter(p => p.amount > 0);
}

/** Deterministic Fisher-Yates shuffle. */
function shuffle<T>(list: readonly T[], seed: number): T[] {
  const out = [...list];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Exchange rates from 0.0001 to 10000 with six significant digits, like real quotes.
const rateArb = fc.double({ min: -4, max: 4, noNaN: true }).map(u => Number(Math.pow(10, u).toPrecision(6)));
const dateArb = fc.integer({ min: 0, max: 900 }).map(d => new Date(Date.UTC(2025, 0, 1 + d)).toISOString().slice(0, 10));
const deletedArb = fc.integer({ min: 0, max: 7 }).map(x => (x === 0 ? '2026-10-01T00:00:00.000Z' : null));

const expenseArb = (base: string) =>
  fc
    .record({
      currency: fc.oneof(fc.constant(base), fc.constantFrom(...CURRENCIES)),
      amount: fc.oneof(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 10_000_000 })),
      payers: fc.uniqueArray(fc.constantFrom(...MEMBERS), { minLength: 1, maxLength: 3 }),
      payerWeights: fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 3, maxLength: 3 }),
      sharers: fc.uniqueArray(fc.constantFrom(...MEMBERS), { minLength: 1, maxLength: 5 }),
      shareWeights: fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 5, maxLength: 5 }),
      rate: rateArb,
      deletedAt: deletedArb,
      category: fc.constantFrom('food.dining', 'travel.hotel', 'transport.taxi', undefined),
      date: dateArb,
    })
    .map(
      (x): Omit<LedgerEntry, 'id'> => ({
        kind: 'expense',
        amount: x.amount,
        currency: x.currency,
        fxRate: x.currency === base ? 1 : x.rate,
        payers: portions(x.amount, x.payers, x.payerWeights),
        shares: portions(x.amount, x.sharers, x.shareWeights),
        category: x.category,
        date: x.date,
        deletedAt: x.deletedAt,
      }),
    );

const paymentArb = (base: string) =>
  fc
    .record({
      pair: fc.uniqueArray(fc.constantFrom(...MEMBERS), { minLength: 2, maxLength: 2 }),
      amount: fc.integer({ min: 1, max: 1_000_000 }),
      currency: fc.oneof(fc.constant(base), fc.constant(base), fc.constantFrom(...CURRENCIES)),
      rate: rateArb,
      deletedAt: deletedArb,
      date: dateArb,
    })
    .map(
      (x): Omit<LedgerEntry, 'id'> => ({
        kind: 'payment',
        amount: x.amount,
        currency: x.currency,
        fxRate: x.currency === base ? 1 : x.rate,
        payers: [{ memberId: x.pair[0], amount: x.amount }],
        shares: [{ memberId: x.pair[1], amount: x.amount }],
        category: 'payment',
        date: x.date,
        deletedAt: x.deletedAt,
      }),
    );

const groupArb = fc.constantFrom(...BASES).chain(base =>
  fc
    .array(fc.oneof({ weight: 3, arbitrary: expenseArb(base) }, { weight: 1, arbitrary: paymentArb(base) }), { maxLength: 25 })
    .map(list => ({ base, entries: list.map((e, i): LedgerEntry => ({ id: 'e' + i, ...e })) })),
);

const entryArb = fc.constantFrom(...BASES).chain(base =>
  fc.oneof(expenseArb(base), paymentArb(base)).map(e => ({ base, entry: { id: 'x', ...e } as LedgerEntry })),
);

/** Exact conversion with half-away-from-zero rounding for a rate of k / 10^4. */
function exactConvert(amount: number, from: string, k: number, to: string): number {
  const df = getCurrency(from).decimals;
  const dt = getCurrency(to).decimals;
  const num = BigInt(Math.abs(amount)) * BigInt(k) * 10n ** BigInt(dt);
  const den = 10n ** 4n * 10n ** BigInt(df);
  const q = Number((2n * num + den) / (2n * den));
  return amount < 0 && q !== 0 ? -q : q;
}

describe('convertMinor', () => {
  it('converts between currencies with different decimals (JPY 0, TWD 0, USD 2)', () => {
    expect(convertMinor(1_000_000, 'JPY', 0.2105, 'TWD')).toBe(210_500);
    expect(convertMinor(3000, 'JPY', 0.2105, 'TWD')).toBe(632); // 631.5 rounds up
    expect(convertMinor(1000, 'JPY', 0.0067, 'USD')).toBe(670); // US$6.70
    expect(convertMinor(1234, 'USD', 149.5, 'JPY')).toBe(1845); // 1844.83
    expect(convertMinor(1250, 'USD', 31.5, 'TWD')).toBe(394); // 393.75
    expect(convertMinor(100_000, 'TWD', 0.031, 'USD')).toBe(310_000); // US$3,100.00
    expect(convertMinor(1, 'USD', 0.5, 'TWD')).toBe(0); // NT$0.005
    expect(convertMinor(12_345, 'EUR', 1.0843, 'USD')).toBe(13_386); // 133.856835 -> 133.86
  });

  it('rounds half away from zero, also where floating point lands just below .5', () => {
    // 1 * 0.285 * 100 is 28.499999999999996 in floating point; the exact value is 28.5.
    expect(convertMinor(1, 'JPY', 0.285, 'USD')).toBe(29);
    expect(convertMinor(-1, 'JPY', 0.285, 'USD')).toBe(-29);
    expect(convertMinor(115, 'TWD', 0.1, 'JPY')).toBe(12);
    expect(convertMinor(-3000, 'JPY', 0.2105, 'TWD')).toBe(-632);
  });

  it('returns 0, never -0, when a negative amount rounds to nothing', () => {
    const r = convertMinor(-1, 'JPY', 0.001, 'TWD');
    expect(r).toBe(0);
    expect(Object.is(r, -0)).toBe(false);
  });

  it('returns the amount unchanged for the same currency, whatever the rate', () => {
    expect(convertMinor(12345, 'TWD', 1, 'TWD')).toBe(12345);
    expect(convertMinor(-12345, 'USD', 0, 'USD')).toBe(-12345);
    expect(convertMinor(7, 'JPY', Number.NaN, 'JPY')).toBe(7);
  });

  it('throws on a zero, negative or non-finite rate', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => convertMinor(100, 'USD', bad, 'TWD')).toThrow(/bad rate/);
    }
  });

  it('property: equals the exact decimal result rounded half away from zero', () => {
    const pairArb = fc.uniqueArray(fc.constantFrom(...CURRENCIES), { minLength: 2, maxLength: 2 });
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.integer({ min: 1, max: 10_000_000 }), pairArb, (amount, k, [from, to]) => {
        const got = convertMinor(amount, from, k / 10_000, to);
        expect(got).toBe(exactConvert(amount, from, k, to));
        expect(Object.is(got, -0)).toBe(false);
      }),
      { numRuns: 3000 },
    );
  });

  it('property: symmetric for negatives and monotonic in the amount', () => {
    const pairArb = fc.uniqueArray(fc.constantFrom(...CURRENCIES), { minLength: 2, maxLength: 2 });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: 0, max: 1000 }), rateArb, pairArb, (a, d, rate, [from, to]) => {
        const x = convertMinor(a, from, rate, to);
        const neg = convertMinor(-a, from, rate, to);
        expect(neg).toBe(x === 0 ? 0 : -x);
        expect(Object.is(neg, -0)).toBe(false);
        expect(convertMinor(a + d, from, rate, to)).toBeGreaterThanOrEqual(x);
        expect(Number.isSafeInteger(x)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('toBase', () => {
  const jpyDinner: LedgerEntry = {
    id: '1',
    kind: 'expense',
    amount: 3000,
    currency: 'JPY',
    fxRate: 0.2105,
    payers: [{ memberId: 'gino', amount: 3000 }],
    shares: [{ memberId: 'gino', amount: 1000 }, { memberId: 'abbie', amount: 1000 }, { memberId: 'chris', amount: 1000 }],
  };

  it('converts the total once and allocates it back over payers and sharers', () => {
    expect(toBase(jpyDinner, 'TWD')).toEqual({
      total: 632,
      paid: [{ memberId: 'gino', amount: 632 }],
      owed: [{ memberId: 'gino', amount: 211 }, { memberId: 'abbie', amount: 211 }, { memberId: 'chris', amount: 210 }],
    });
    expect(Object.fromEntries(entryNet(jpyDinner, 'TWD'))).toEqual({ gino: 421, abbie: -211, chris: -210 });
  });

  it('handles several payers in a converted entry', () => {
    const e: LedgerEntry = {
      id: '2',
      kind: 'expense',
      amount: 10000,
      currency: 'USD',
      fxRate: 31.55,
      payers: [{ memberId: 'a', amount: 6000 }, { memberId: 'b', amount: 4000 }],
      shares: [{ memberId: 'a', amount: 5000 }, { memberId: 'b', amount: 5000 }],
    };
    const b = toBase(e, 'TWD');
    expect(b.total).toBe(3155);
    expect(b.paid).toEqual([{ memberId: 'a', amount: 1893 }, { memberId: 'b', amount: 1262 }]);
    expect(b.owed).toEqual([{ memberId: 'a', amount: 1578 }, { memberId: 'b', amount: 1577 }]);
  });

  it('keeps the original amounts when the entry is in the group currency (fxRate ignored)', () => {
    const e: LedgerEntry = { ...jpyDinner, currency: 'TWD', fxRate: 99 };
    expect(toBase(e, 'TWD')).toEqual({ total: 3000, paid: e.payers, owed: e.shares });
  });

  it('gives everyone 0 when the converted total rounds to 0', () => {
    const e: LedgerEntry = { ...jpyDinner, amount: 1, payers: [{ memberId: 'gino', amount: 1 }], shares: [{ memberId: 'abbie', amount: 1 }], fxRate: 0.001 };
    expect(toBase(e, 'TWD')).toEqual({ total: 0, paid: [{ memberId: 'gino', amount: 0 }], owed: [{ memberId: 'abbie', amount: 0 }] });
  });

  it('property: paid and owed both sum to the converted total, each part within floor/ceil of its exact share', () => {
    fc.assert(
      fc.property(entryArb, ({ base, entry }) => {
        const b = toBase(entry, base);
        expect(b.total).toBe(convertMinor(entry.amount, entry.currency, entry.currency === base ? 1 : entry.fxRate, base));
        expect(total(b.paid)).toBe(b.total);
        expect(total(b.owed)).toBe(b.total);
        expect(b.paid.map(p => p.memberId)).toEqual(entry.payers.map(p => p.memberId));
        expect(b.owed.map(p => p.memberId)).toEqual(entry.shares.map(p => p.memberId));
        const check = (parts: Portion[], orig: Portion[]) =>
          parts.forEach((p, i) => {
            const lo = Number((BigInt(b.total) * BigInt(orig[i].amount)) / BigInt(entry.amount));
            expect(p.amount === lo || p.amount === lo + 1).toBe(true);
          });
        check(b.paid, entry.payers);
        check(b.owed, entry.shares);
      }),
      { numRuns: 2000 },
    );
  });

  it('property: every entry nets to exactly 0, and each member is within 2 units of the exact converted net', () => {
    fc.assert(
      fc.property(entryArb, ({ base, entry }) => {
        const net = entryNet(entry, base);
        expect([...net.values()].reduce((a, b) => a + b, 0)).toBe(0);
        const b = toBase(entry, base);
        for (const [m, v] of net) {
          const orig = total(entry.payers.filter(p => p.memberId === m)) - total(entry.shares.filter(s => s.memberId === m));
          const exact = (orig * b.total) / entry.amount;
          expect(Math.abs(v - exact)).toBeLessThan(2);
          if (entry.currency === base) expect(v).toBe(orig);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe('netBalances', () => {
  it('adds up who paid and who owes, ignores deleted entries and lists idle members with 0', () => {
    const entries: LedgerEntry[] = [
      { id: '1', kind: 'expense', amount: 900, currency: 'TWD', fxRate: 1, payers: [{ memberId: 'a', amount: 900 }], shares: [{ memberId: 'a', amount: 300 }, { memberId: 'b', amount: 300 }, { memberId: 'c', amount: 300 }] },
      { id: '2', kind: 'payment', amount: 300, currency: 'TWD', fxRate: 1, payers: [{ memberId: 'b', amount: 300 }], shares: [{ memberId: 'a', amount: 300 }] },
      { id: '3', kind: 'expense', amount: 5000, currency: 'TWD', fxRate: 1, payers: [{ memberId: 'c', amount: 5000 }], shares: [{ memberId: 'a', amount: 5000 }], deletedAt: '2026-10-01T00:00:00Z' },
    ];
    expect(netBalances(entries, 'TWD', ['a', 'b', 'c', 'd'])).toEqual({ a: 300, b: 0, c: -300, d: 0 });
    expect(netBalances([], 'TWD')).toEqual({});
  });

  it('property: always sums to exactly 0 for random multi-currency ledgers', () => {
    fc.assert(
      fc.property(groupArb, ({ base, entries }) => {
        const net = netBalances(entries, base, MEMBERS);
        expect(sumValues(net)).toBe(0);
        for (const m of MEMBERS) expect(Number.isSafeInteger(net[m])).toBe(true);
        expect(Object.keys(net).sort()).toEqual([...MEMBERS].sort());
      }),
      { numRuns: 1000 },
    );
  });

  it('property: equals the sum of entryNet over live entries, in any order, and is additive', () => {
    fc.assert(
      fc.property(groupArb, groupArb, fc.integer({ min: 0, max: 1000 }), ({ base, entries }, other, seed) => {
        const net = netBalances(entries, base);
        const manual: Record<string, number> = {};
        for (const e of entries) if (!e.deletedAt) for (const [m, v] of entryNet(e, base)) manual[m] = (manual[m] ?? 0) + v;
        expect(net).toEqual(manual);
        // Deleted entries change nothing.
        expect(netBalances(entries.filter(e => !e.deletedAt), base)).toEqual(net);
        // Order does not matter.
        const shuffled = netBalances(shuffle(entries, seed), base);
        expect(Object.keys(shuffled).sort()).toEqual(Object.keys(net).sort());
        for (const m of Object.keys(net)) expect(shuffled[m]).toBe(net[m]);
        // Additive over two ledgers in the same group currency.
        const more = other.entries.map(e => ({ ...e, id: 'o' + e.id, fxRate: e.currency === base ? 1 : e.fxRate }));
        const both = netBalances([...entries, ...more], base, MEMBERS);
        const a = netBalances(entries, base, MEMBERS);
        const b = netBalances(more, base, MEMBERS);
        for (const m of MEMBERS) expect(both[m]).toBe(a[m] + b[m]);
      }),
      { numRuns: 500 },
    );
  });
});

describe('spendTotals', () => {
  it('counts expenses only, by payer, sharer and category', () => {
    const entries: LedgerEntry[] = [
      { id: '1', kind: 'expense', amount: 1200, currency: 'TWD', fxRate: 1, category: 'food.dining', payers: [{ memberId: 'a', amount: 1200 }], shares: [{ memberId: 'a', amount: 600 }, { memberId: 'b', amount: 600 }] },
      { id: '2', kind: 'expense', amount: 3000, currency: 'JPY', fxRate: 0.2105, payers: [{ memberId: 'b', amount: 3000 }], shares: [{ memberId: 'a', amount: 1500 }, { memberId: 'b', amount: 1500 }] },
      { id: '3', kind: 'payment', amount: 500, currency: 'TWD', fxRate: 1, category: 'payment', payers: [{ memberId: 'b', amount: 500 }], shares: [{ memberId: 'a', amount: 500 }] },
      { id: '4', kind: 'expense', amount: 999, currency: 'TWD', fxRate: 1, category: 'food.dining', payers: [{ memberId: 'a', amount: 999 }], shares: [{ memberId: 'b', amount: 999 }], deletedAt: '2026-10-02T00:00:00Z' },
    ];
    expect(spendTotals(entries, 'TWD')).toEqual({
      spent: 1832,
      paid: { a: 1200, b: 632 },
      share: { a: 916, b: 916 },
      byCategory: { 'food.dining': 1200, general: 632 },
    });
  });

  it('property: spent = sum of paid = sum of shares = sum by category; payments and deleted entries excluded', () => {
    fc.assert(
      fc.property(groupArb, ({ base, entries }) => {
        const t = spendTotals(entries, base);
        expect(sumValues(t.paid)).toBe(t.spent);
        expect(sumValues(t.share)).toBe(t.spent);
        expect(sumValues(t.byCategory)).toBe(t.spent);
        const expensesOnly = entries.filter(e => e.kind === 'expense' && !e.deletedAt);
        expect(spendTotals(expensesOnly, base)).toEqual(t);
        expect(t.spent).toBe(expensesOnly.reduce((a, e) => a + toBase(e, base).total, 0));
      }),
      { numRuns: 500 },
    );
  });
});

describe('memberEffect', () => {
  const e: LedgerEntry = {
    id: '1',
    kind: 'expense',
    amount: 31500,
    currency: 'JPY',
    fxRate: 0.21,
    payers: [{ memberId: 'gino', amount: 31500 }],
    shares: [{ memberId: 'gino', amount: 10500 }, { memberId: 'abbie', amount: 10500 }, { memberId: 'chris', amount: 10500 }],
  };

  it('reports lent, borrowed, not involved and even, in the entry currency', () => {
    expect(memberEffect(e, 'gino')).toEqual({ involved: true, paid: 31500, owed: 10500, net: 21000 });
    expect(memberEffect(e, 'abbie')).toEqual({ involved: true, paid: 0, owed: 10500, net: -10500 });
    expect(memberEffect(e, 'dana')).toEqual({ involved: false, paid: 0, owed: 0, net: 0 });
    const self: LedgerEntry = { ...e, shares: [{ memberId: 'gino', amount: 31500 }] };
    expect(memberEffect(self, 'gino')).toEqual({ involved: true, paid: 31500, owed: 31500, net: 0 });
  });

  it('property: nets add up to 0 across members and involved means listed', () => {
    fc.assert(
      fc.property(entryArb, ({ entry }) => {
        let s = 0;
        for (const m of [...MEMBERS, 'stranger']) {
          const fx = memberEffect(entry, m);
          s += fx.net;
          const listed = entry.payers.some(p => p.memberId === m) || entry.shares.some(p => p.memberId === m);
          expect(fx.involved).toBe(listed);
          expect(fx.net).toBe(fx.paid - fx.owed);
        }
        expect(s).toBe(0);
      }),
      { numRuns: 500 },
    );
  });
});
