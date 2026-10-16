import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { pairwiseDebts, settlementPlan, simplifyDebts, transfersFor, type Transfer } from '../../src/shared/settle';
import { netBalances, type LedgerEntry } from '../../src/shared/balances';
import type { Portion } from '../../src/shared/split';

const MEMBERS = ['gino', 'abbie', 'chris', 'dana', 'eli', 'fay'];
const CURRENCIES = ['TWD', 'USD', 'JPY', 'EUR', 'KRW'];
const BASES = ['TWD', 'USD', 'JPY'];

/** incoming minus outgoing per member: what the plan pays each member (negative = they pay). */
function flows(transfers: readonly Transfer[]): Record<string, number> {
  const f: Record<string, number> = {};
  for (const t of transfers) {
    f[t.to] = (f[t.to] ?? 0) + t.amount;
    f[t.from] = (f[t.from] ?? 0) - t.amount;
  }
  return f;
}

function expectSettles(net: Readonly<Record<string, number>>, transfers: readonly Transfer[]) {
  const f = flows(transfers);
  for (const m of new Set([...Object.keys(net), ...Object.keys(f)])) expect(f[m] ?? 0).toBe(net[m] ?? 0);
}

function expectWellFormed(transfers: readonly Transfer[]) {
  const pairs = new Set<string>();
  for (const t of transfers) {
    expect(t.from).not.toBe(t.to);
    expect(Number.isSafeInteger(t.amount)).toBe(true);
    expect(t.amount).toBeGreaterThan(0);
    const key = [t.from, t.to].sort().join('|');
    // At most one transfer per pair of members, in one direction.
    expect(pairs.has(key)).toBe(false);
    pairs.add(key);
  }
}

function expectSorted(transfers: readonly Transfer[], order: readonly string[]) {
  const rank = (m: string) => {
    const i = order.indexOf(m);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const cmp = (a: string, b: string) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  for (let i = 1; i < transfers.length; i++) {
    const p = transfers[i - 1], q = transfers[i];
    expect(cmp(p.from, q.from) < 0 || (cmp(p.from, q.from) === 0 && cmp(p.to, q.to) < 0)).toBe(true);
  }
}

// Nets that add up to 0, with repeated round numbers so exact debtor/creditor matches happen.
const netArb = fc
  .array(fc.oneof(fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.constantFrom(0, 100, -100, 250, -250, 1, -1)), { minLength: 1, maxLength: 10 })
  .map(vals => {
    const ids = vals.map((_, i) => 'm' + i);
    const net: Record<string, number> = {};
    let s = 0;
    for (let i = 0; i < vals.length - 1; i++) {
      net[ids[i]] = vals[i];
      s += vals[i];
    }
    net[ids[vals.length - 1]] = s === 0 ? 0 : -s;
    return { net, ids };
  });

/** Split `amount` by integer weights (floors, remainder to the first); zero parts dropped. */
function portions(amount: number, ids: readonly string[], weights: readonly number[]): Portion[] {
  let w = weights.slice(0, ids.length);
  if (w.every(x => x === 0)) w = ids.map(() => 1);
  const W = w.reduce((a, b) => a + b, 0);
  const out = ids.map((memberId, i) => ({ memberId, amount: Math.floor((amount * w[i]) / W) }));
  out[0].amount += amount - out.reduce((a, p) => a + p.amount, 0);
  return out.filter(p => p.amount > 0);
}

const rateArb = fc.double({ min: -3, max: 3, noNaN: true }).map(u => Number(Math.pow(10, u).toPrecision(6)));
const deletedArb = fc.integer({ min: 0, max: 7 }).map(x => (x === 0 ? '2026-10-01T00:00:00.000Z' : null));

const entryArb = (base: string) =>
  fc.oneof(
    {
      weight: 3,
      arbitrary: fc
        .record({
          currency: fc.oneof(fc.constant(base), fc.constantFrom(...CURRENCIES)),
          amount: fc.oneof(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 5_000_000 })),
          payers: fc.uniqueArray(fc.constantFrom(...MEMBERS), { minLength: 1, maxLength: 3 }),
          payerWeights: fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 3, maxLength: 3 }),
          sharers: fc.uniqueArray(fc.constantFrom(...MEMBERS), { minLength: 1, maxLength: 6 }),
          shareWeights: fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 6, maxLength: 6 }),
          rate: rateArb,
          deletedAt: deletedArb,
        })
        .map(
          (x): Omit<LedgerEntry, 'id'> => ({
            kind: 'expense',
            amount: x.amount,
            currency: x.currency,
            fxRate: x.currency === base ? 1 : x.rate,
            payers: portions(x.amount, x.payers, x.payerWeights),
            shares: portions(x.amount, x.sharers, x.shareWeights),
            deletedAt: x.deletedAt,
          }),
        ),
    },
    {
      weight: 1,
      arbitrary: fc
        .record({
          pair: fc.uniqueArray(fc.constantFrom(...MEMBERS), { minLength: 2, maxLength: 2 }),
          amount: fc.integer({ min: 1, max: 1_000_000 }),
          currency: fc.oneof(fc.constant(base), fc.constantFrom(...CURRENCIES)),
          rate: rateArb,
          deletedAt: deletedArb,
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
            deletedAt: x.deletedAt,
          }),
        ),
    },
  );

const groupArb = fc.constantFrom(...BASES).chain(base =>
  fc.record({
    base: fc.constant(base),
    entries: fc.array(entryArb(base), { maxLength: 30 }).map(list => list.map((e, i): LedgerEntry => ({ id: 'e' + i, ...e }))),
    order: fc.shuffledSubarray(MEMBERS, { minLength: MEMBERS.length }),
  }),
);

const tx = (from: string, to: string, amount: number): Transfer => ({ from, to, amount });
const ex = (id: string, payers: Portion[], shares: Portion[], extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id,
  kind: 'expense',
  amount: payers.reduce((a, p) => a + p.amount, 0),
  currency: 'TWD',
  fxRate: 1,
  payers,
  shares,
  ...extra,
});
const p = (memberId: string, amount: number): Portion => ({ memberId, amount });

describe('simplifyDebts', () => {
  it('settles the smoke-test nets', () => {
    expect(simplifyDebts({ a: 666, b: -33, c: -633 }, ['a', 'b', 'c'])).toEqual([tx('b', 'a', 33), tx('c', 'a', 633)]);
  });

  it('pairs exact matches first, saving transfers', () => {
    // Largest-first alone: a->c 40, b->d 30, a->e 10, b->e 10 (4 transfers).
    // Matching b with c first: b->c 40, a->d 30, a->e 20 (3 transfers).
    const net = { a: -50, b: -40, c: 40, d: 30, e: 20 };
    expect(simplifyDebts(net, ['a', 'b', 'c', 'd', 'e'])).toEqual([tx('a', 'd', 30), tx('a', 'e', 20), tx('b', 'c', 40)]);
  });

  it('returns nothing when everyone is settled', () => {
    expect(simplifyDebts({})).toEqual([]);
    expect(simplifyDebts({ a: 0, b: 0 }, ['a', 'b'])).toEqual([]);
  });

  it('one debtor pays every creditor', () => {
    expect(simplifyDebts({ a: -90, b: 30, c: 60 }, ['a', 'b', 'c'])).toEqual([tx('a', 'b', 30), tx('a', 'c', 60)]);
  });

  it('sorts by the given member order, else by the order of the net object', () => {
    expect(simplifyDebts({ a: 10, b: -10 }, ['b', 'a'])).toEqual([tx('b', 'a', 10)]);
    expect(simplifyDebts({ x: -5, y: -5, z: 10 })).toEqual([tx('x', 'z', 5), tx('y', 'z', 5)]);
    expect(simplifyDebts({ x: -5, y: -5, z: 10 }, ['z', 'y', 'x'])).toEqual([tx('y', 'z', 5), tx('x', 'z', 5)]);
  });

  it('property: settles every net exactly with at most (debtors + creditors - 1) well-formed transfers', () => {
    fc.assert(
      fc.property(netArb, fc.boolean(), ({ net, ids }, withOrder) => {
        const order = withOrder ? [...ids].reverse() : [];
        const plan = simplifyDebts(net, order);
        expectSettles(net, plan);
        expectWellFormed(plan);
        const debtors = ids.filter(m => net[m] < 0).length;
        const creditors = ids.filter(m => net[m] > 0).length;
        expect(plan.length).toBeLessThanOrEqual(Math.max(0, debtors + creditors - 1));
        for (const t of plan) {
          // Only debtors pay and only creditors receive, never more than they owe or are owed.
          expect(net[t.from]).toBeLessThan(0);
          expect(net[t.to]).toBeGreaterThan(0);
          expect(t.amount).toBeLessThanOrEqual(Math.min(-net[t.from], net[t.to]));
        }
        expectSorted(plan, order.length ? order : Object.keys(net));
      }),
      { numRuns: 2000 },
    );
  });

  it('property: deterministic, and a debtor with a unique exact match pays that creditor in one transfer', () => {
    fc.assert(
      fc.property(netArb, ({ net, ids }) => {
        const plan = simplifyDebts(net, ids);
        expect(simplifyDebts({ ...net }, [...ids])).toEqual(plan);
        for (const d of ids) {
          if (net[d] >= 0) continue;
          const sameCreditors = ids.filter(c => net[c] === -net[d]);
          const sameDebtors = ids.filter(x => net[x] === net[d]);
          if (sameCreditors.length !== 1 || sameDebtors.length !== 1) continue;
          const c = sameCreditors[0];
          expect(plan.filter(t => t.from === d || t.to === d || t.from === c || t.to === c)).toEqual([tx(d, c, -net[d])]);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('pairwiseDebts', () => {
  it('nets the debts of each pair across expenses', () => {
    const entries = [ex('1', [p('a', 100)], [p('b', 100)]), ex('2', [p('b', 60)], [p('a', 60)])];
    expect(pairwiseDebts(entries, 'TWD', ['a', 'b'])).toEqual([tx('b', 'a', 40)]);
  });

  it('a payment cancels the debt it pays', () => {
    const entries: LedgerEntry[] = [
      ex('1', [p('a', 100)], [p('b', 100)]),
      { id: '2', kind: 'payment', amount: 100, currency: 'TWD', fxRate: 1, payers: [p('b', 100)], shares: [p('a', 100)] },
    ];
    expect(pairwiseDebts(entries, 'TWD', ['a', 'b'])).toEqual([]);
  });

  it('splits a debtor across several payers in proportion to what each is owed', () => {
    // 300 paid by a 200 and b 100, shared by a, b, c: a is owed 100, b is even, c owes 100.
    expect(pairwiseDebts([ex('1', [p('a', 200), p('b', 100)], [p('a', 100), p('b', 100), p('c', 100)])], 'TWD', ['a', 'b', 'c'])).toEqual([tx('c', 'a', 100)]);
    // 900 paid by a 600 and b 300, shared by c alone: c owes a 600 and b 300.
    expect(pairwiseDebts([ex('1', [p('a', 600), p('b', 300)], [p('c', 900)])], 'TWD', ['a', 'b', 'c'])).toEqual([tx('c', 'a', 600), tx('c', 'b', 300)]);
  });

  it('never makes people who shared nothing pay each other (unlike simplify)', () => {
    // a paid for b, b paid for c: simplified, c pays a directly; pairwise keeps both debts.
    const entries = [ex('1', [p('a', 100)], [p('b', 100)]), ex('2', [p('b', 100)], [p('c', 100)])];
    const order = ['a', 'b', 'c'];
    expect(pairwiseDebts(entries, 'TWD', order)).toEqual([tx('b', 'a', 100), tx('c', 'b', 100)]);
    expect(simplifyDebts(netBalances(entries, 'TWD', order), order)).toEqual([tx('c', 'a', 100)]);
  });

  it('works in the group currency for converted entries and ignores deleted ones', () => {
    const entries = [
      ex('1', [p('a', 3000)], [p('a', 1000), p('b', 1000), p('c', 1000)], { currency: 'JPY', fxRate: 0.2105 }),
      ex('2', [p('b', 99999)], [p('a', 99999)], { deletedAt: '2026-10-01T00:00:00Z' }),
    ];
    // ¥3,000 at 0.2105 = NT$632; the one leftover unit follows the expense's fair order.
    const plan = pairwiseDebts(entries, 'TWD', ['a', 'b', 'c']);
    expect(plan.map(t => [t.from, t.to])).toEqual([['b', 'a'], ['c', 'a']]);
    for (const t of plan) expect([210, 211]).toContain(t.amount);
    // a keeps one third (210 or 211); the other two owe the rest of 632.
    const sum = plan.reduce((s, t) => s + t.amount, 0);
    expect([421, 422]).toContain(sum);
  });

  it('property: for every member, incoming minus outgoing equals their net exactly', () => {
    fc.assert(
      fc.property(groupArb, ({ base, entries, order }) => {
        const plan = pairwiseDebts(entries, base, order);
        expectSettles(netBalances(entries, base, MEMBERS), plan);
        expectWellFormed(plan);
        expectSorted(plan, order);
      }),
      { numRuns: 1000 },
    );
  });

  it('property: only members who shared a live entry owe each other; deleted entries are ignored; deterministic', () => {
    fc.assert(
      fc.property(groupArb, ({ base, entries, order }) => {
        const plan = pairwiseDebts(entries, base, order);
        const live = entries.filter(e => !e.deletedAt);
        for (const t of plan) {
          const shared = live.some(e => {
            const who = new Set([...e.payers, ...e.shares].map(x => x.memberId));
            return who.has(t.from) && who.has(t.to);
          });
          expect(shared).toBe(true);
        }
        expect(pairwiseDebts(live, base, order)).toEqual(plan);
        expect(pairwiseDebts(entries, base, order)).toEqual(plan);
      }),
      { numRuns: 500 },
    );
  });
});

describe('settlementPlan and transfersFor', () => {
  it('property: follows the simplify setting', () => {
    fc.assert(
      fc.property(groupArb, ({ base, entries, order }) => {
        const net = netBalances(entries, base, order);
        expect(settlementPlan(entries, base, net, true, order)).toEqual(simplifyDebts(net, order));
        expect(settlementPlan(entries, base, net, false, order)).toEqual(pairwiseDebts(entries, base, order));
        // Both plans settle the same nets.
        expectSettles(net, settlementPlan(entries, base, net, true, order));
        expectSettles(net, settlementPlan(entries, base, net, false, order));
      }),
      { numRuns: 300 },
    );
  });

  it('transfersFor splits what a member owes and is owed', () => {
    const plan = [tx('b', 'a', 10), tx('c', 'a', 20), tx('a', 'd', 5)];
    expect(transfersFor('a', plan)).toEqual({ owes: [tx('a', 'd', 5)], owed: [tx('b', 'a', 10), tx('c', 'a', 20)] });
    expect(transfersFor('z', plan)).toEqual({ owes: [], owed: [] });
  });
});
