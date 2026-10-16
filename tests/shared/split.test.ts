import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  checkPayers,
  computeShares,
  equalSplit,
  itemsTotal,
  splitParticipants,
  SPLIT_METHODS,
  type Portion,
  type SplitInput,
  type SplitItem,
  type SplitResult,
} from '../../src/shared/split';
import { MAX_AMOUNT } from '../../src/shared/money';

const MEMBERS = ['gino', 'abbie', 'chris', 'dana', 'eli', 'fay', 'gus', 'hana'];

function sharesOf(r: SplitResult): Portion[] {
  if (!r.ok) throw new Error('expected ok, got ' + JSON.stringify(r));
  return r.shares;
}

function byId(ps: readonly Portion[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of ps) out[p.memberId] = p.amount;
  return out;
}

const sumOf = (ps: readonly { amount: number }[]) => ps.reduce((a, p) => a + p.amount, 0);

/** Payers first (in priority order, if they take part), then everyone else in entry order. */
function ranking(participants: readonly string[], priority: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of priority) if (participants.includes(p) && !out.includes(p)) out.push(p);
  for (const m of participants) if (!out.includes(m)) out.push(m);
  return out;
}

/** The invariants of every successful split. */
function expectValid(r: SplitResult, total: number, participants: readonly string[]): Portion[] {
  const s = sharesOf(r);
  expect(sumOf(s)).toBe(total);
  let last = -1;
  for (const p of s) {
    expect(Number.isSafeInteger(p.amount)).toBe(true);
    // Members with 0 are left out, and no share is ever negative.
    expect(p.amount).toBeGreaterThan(0);
    const idx = participants.indexOf(p.memberId);
    // Each member appears once, in participant order.
    expect(idx).toBeGreaterThan(last);
    last = idx;
  }
  return s;
}

/** Non-negative integers that add up to `total` (zeros included). */
const partitionOf = (total: number, n: number) =>
  fc
    .array(fc.oneof(fc.integer({ min: 0, max: total }), fc.constantFrom(0, total)), { minLength: n - 1, maxLength: n - 1 })
    .map(cuts => {
      const c = [0, ...[...cuts].sort((a, b) => a - b), total];
      return c.slice(1).map((x, i) => x - c[i]);
    });

const totalArb = fc.oneof(
  fc.integer({ min: 1, max: 1000 }),
  fc.integer({ min: 1, max: 1_000_000_000 }),
  fc.constantFrom(1, 2, 99, 100, 101, MAX_AMOUNT),
);
const participantsArb = fc.shuffledSubarray(MEMBERS, { minLength: 1 });
const priorityArb = fc.shuffledSubarray([...MEMBERS, 'not-in-split'], { maxLength: 3 });

const entries = (ids: readonly string[], values?: readonly (number | undefined)[]) =>
  ids.map((memberId, i) => (values && values[i] !== undefined ? { memberId, value: values[i] } : { memberId }));

describe('computeShares: equal', () => {
  it('NT$100 three ways with Gino paying: Gino 34, the others 33 (the documented example)', () => {
    const r = computeShares(100, equalSplit(['abbie', 'gino', 'chris']), ['gino']);
    expect(r).toEqual({ ok: true, shares: [{ memberId: 'abbie', amount: 33 }, { memberId: 'gino', amount: 34 }, { memberId: 'chris', amount: 33 }] });
  });

  it('ignores a payer who is not in the split and falls back to entry order', () => {
    expect(byId(sharesOf(computeShares(100, equalSplit(['abbie', 'chris', 'dana']), ['gino'])))).toEqual({ abbie: 34, chris: 33, dana: 33 });
  });

  it('omits members whose share rounds to 0', () => {
    expect(sharesOf(computeShares(2, equalSplit(['a', 'b', 'c']), ['c']))).toEqual([{ memberId: 'a', amount: 1 }, { memberId: 'c', amount: 1 }]);
  });

  it('ignores typed values', () => {
    expect(computeShares(90, { method: 'equal', entries: entries(['a', 'b'], [5, 7]) })).toEqual(computeShares(90, equalSplit(['a', 'b'])));
  });

  it('property: exact model of who absorbs the leftover units (payers first, then entry order)', () => {
    fc.assert(
      fc.property(totalArb, participantsArb, priorityArb, (total, ids, prio) => {
        const r = computeShares(total, equalSplit(ids), prio);
        const s = expectValid(r, total, ids);
        const n = ids.length;
        const q = Math.floor(total / n);
        const extra = total % n;
        const order = ranking(ids, prio);
        const want: Record<string, number> = {};
        order.forEach((m, k) => {
          const v = q + (k < extra ? 1 : 0);
          if (v) want[m] = v;
        });
        expect(byId(s)).toEqual(want);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('computeShares: shares', () => {
  it('splits by weight, 1.5 allowed', () => {
    expect(byId(sharesOf(computeShares(300, { method: 'shares', entries: entries(['a', 'b'], [1, 2]) })))).toEqual({ a: 100, b: 200 });
    expect(byId(sharesOf(computeShares(1000, { method: 'shares', entries: entries(['a', 'b', 'c'], [1.5, 1, 0]) })))).toEqual({ a: 600, b: 400 });
  });

  it('lets the payer absorb ties', () => {
    expect(byId(sharesOf(computeShares(101, { method: 'shares', entries: entries(['a', 'b'], [1, 1]) }, ['b'])))).toEqual({ a: 50, b: 51 });
  });

  it('rejects bad weights and all-zero weights', () => {
    expect(computeShares(100, { method: 'shares', entries: entries(['a', 'b'], [1, -1]) })).toEqual({ ok: false, code: 'invalid_value' });
    expect(computeShares(100, { method: 'shares', entries: entries(['a', 'b'], [1, Number.NaN]) })).toEqual({ ok: false, code: 'invalid_value' });
    expect(computeShares(100, { method: 'shares', entries: entries(['a', 'b'], [1, 1_000_001]) })).toEqual({ ok: false, code: 'invalid_value' });
    expect(computeShares(100, { method: 'shares', entries: entries(['a', 'b'], [1]) })).toEqual({ ok: false, code: 'invalid_value' });
    expect(computeShares(100, { method: 'shares', entries: entries(['a', 'b'], [0, 0]) })).toEqual({ ok: false, code: 'zero_weights' });
    expect(computeShares(100, { method: 'shares', entries: entries(['a', 'b'], [1e-7, 0]) })).toEqual({ ok: false, code: 'zero_weights' });
  });

  it('property: each share within floor/ceil of its exact share; equal weights favor payers', () => {
    fc.assert(
      fc.property(
        totalArb,
        participantsArb.chain(ids => fc.tuple(fc.constant(ids), fc.array(fc.integer({ min: 0, max: 20 }), { minLength: ids.length, maxLength: ids.length }))),
        priorityArb,
        (total, [ids, halves], prio) => {
          fc.pre(halves.some(h => h > 0));
          const r = computeShares(total, { method: 'shares', entries: entries(ids, halves.map(h => h / 2)) }, prio);
          const s = byId(expectValid(r, total, ids));
          const W = halves.reduce((a, b) => a + b, 0);
          ids.forEach((m, i) => {
            const got = s[m] ?? 0;
            const lo = Math.floor((total * halves[i]) / W);
            // total * halves[i] stays below 2^53 for total <= 1e12 and halves <= 20.
            expect(got === lo || got === lo + 1).toBe(true);
            if ((total * halves[i]) % W === 0) expect(got).toBe(lo);
            if (halves[i] === 0) expect(got).toBe(0);
          });
          const order = ranking(ids, prio);
          for (const x of ids) for (const y of ids) {
            const ix = ids.indexOf(x), iy = ids.indexOf(y);
            if (halves[ix] === halves[iy] && order.indexOf(x) < order.indexOf(y)) {
              const d = (s[x] ?? 0) - (s[y] ?? 0);
              expect(d === 0 || d === 1).toBe(true);
            }
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('computeShares: percent', () => {
  it('splits by percentage', () => {
    expect(byId(sharesOf(computeShares(10000, { method: 'percent', entries: entries(['a', 'b', 'c'], [50, 25, 25]) })))).toEqual({ a: 5000, b: 2500, c: 2500 });
    expect(byId(sharesOf(computeShares(1000, { method: 'percent', entries: entries(['a', 'b', 'c'], [33.33, 33.33, 33.34]) })))).toEqual({ a: 333, b: 333, c: 334 });
  });

  it('omits 0% members and accepts a sum within 0.001 of 100', () => {
    expect(sharesOf(computeShares(100, { method: 'percent', entries: entries(['a', 'b'], [100, 0]) }))).toEqual([{ memberId: 'a', amount: 100 }]);
    expect(computeShares(900, { method: 'percent', entries: entries(['a', 'b', 'c'], [33.3333, 33.3333, 33.3333]) }).ok).toBe(true);
  });

  it('reports the percentage points still unassigned', () => {
    expect(computeShares(100, { method: 'percent', entries: entries(['a', 'b'], [50, 49.99]) })).toEqual({ ok: false, code: 'percent_mismatch', diff: 0.01 });
    expect(computeShares(100, { method: 'percent', entries: entries(['a', 'b'], [60, 50]) })).toEqual({ ok: false, code: 'percent_mismatch', diff: -10 });
    expect(computeShares(100, { method: 'percent', entries: entries(['a', 'b'], [0, 0]) })).toEqual({ ok: false, code: 'percent_mismatch', diff: 100 });
    expect(computeShares(100, { method: 'percent', entries: entries(['a', 'b', 'c'], [33.33, 33.33, 33.33]) })).toEqual({ ok: false, code: 'percent_mismatch', diff: 0.01 });
  });

  it('rejects values outside 0 to 100', () => {
    for (const bad of [-1, 100.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(computeShares(100, { method: 'percent', entries: entries(['a', 'b'], [bad, 50]) })).toEqual({ ok: false, code: 'invalid_value' });
    }
    expect(computeShares(100, { method: 'percent', entries: entries(['a', 'b'], [100]) })).toEqual({ ok: false, code: 'invalid_value' });
  });

  it('property: with percentages that add to 100, each share is within floor/ceil of total * p / 100', () => {
    fc.assert(
      fc.property(
        totalArb,
        participantsArb.chain(ids => fc.tuple(fc.constant(ids), partitionOf(10000, ids.length))),
        priorityArb,
        (total, [ids, bp], prio) => {
          const r = computeShares(total, { method: 'percent', entries: entries(ids, bp.map(x => x / 100)) }, prio);
          const s = byId(expectValid(r, total, ids));
          ids.forEach((m, i) => {
            const got = s[m] ?? 0;
            const lo = Number((BigInt(total) * BigInt(bp[i])) / 10000n);
            expect(got === lo || got === lo + 1).toBe(true);
          });
          const order = ranking(ids, prio);
          for (const x of ids) for (const y of ids) {
            if (bp[ids.indexOf(x)] === bp[ids.indexOf(y)] && order.indexOf(x) < order.indexOf(y)) {
              const d = (s[x] ?? 0) - (s[y] ?? 0);
              expect(d === 0 || d === 1).toBe(true);
            }
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('property: percentages that do not add to 100 report the exact gap', () => {
    fc.assert(
      fc.property(
        participantsArb.chain(ids => fc.tuple(fc.constant(ids), fc.array(fc.integer({ min: 0, max: 10000 }), { minLength: ids.length, maxLength: ids.length }))),
        ([ids, bp]) => {
          const s = bp.reduce((a, b) => a + b, 0);
          fc.pre(s !== 10000);
          const r = computeShares(500, { method: 'percent', entries: entries(ids, bp.map(x => x / 100)) });
          if (r.ok) throw new Error('expected a mismatch');
          expect(r.code).toBe('percent_mismatch');
          expect(r.diff).toBeCloseTo((10000 - s) / 100, 6);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('computeShares: exact', () => {
  it('uses the typed amounts and omits zeros', () => {
    expect(sharesOf(computeShares(1000, { method: 'exact', entries: entries(['a', 'b', 'c'], [600, 400, 0]) }))).toEqual([
      { memberId: 'a', amount: 600 },
      { memberId: 'b', amount: 400 },
    ]);
  });

  it('reports what is still unassigned (negative = over-assigned)', () => {
    expect(computeShares(1000, { method: 'exact', entries: entries(['a', 'b'], [600, 300]) })).toEqual({ ok: false, code: 'exact_mismatch', diff: 100 });
    expect(computeShares(1000, { method: 'exact', entries: entries(['a', 'b'], [600, 500]) })).toEqual({ ok: false, code: 'exact_mismatch', diff: -100 });
    expect(computeShares(1000, { method: 'exact', entries: entries(['a', 'b'], [0, 0]) })).toEqual({ ok: false, code: 'exact_mismatch', diff: 1000 });
  });

  it('rejects non-integer, negative, missing or huge values', () => {
    for (const bad of [1.5, -1, Number.NaN, MAX_AMOUNT + 1]) {
      expect(computeShares(1000, { method: 'exact', entries: entries(['a', 'b'], [bad, 1000]) })).toEqual({ ok: false, code: 'invalid_value' });
    }
    expect(computeShares(1000, { method: 'exact', entries: entries(['a', 'b'], [1000]) })).toEqual({ ok: false, code: 'invalid_value' });
  });

  it('property: amounts that add up are returned as typed; others report total minus sum', () => {
    const caseArb = totalArb
      .filter(t => t <= 1_000_000_000)
      .chain(total => participantsArb.chain(ids => partitionOf(total, ids.length).map(values => ({ total, ids, values }))));
    fc.assert(
      fc.property(caseArb, fc.integer({ min: -1000, max: 1000 }), ({ total, ids, values }, delta) => {
        const good = computeShares(total, { method: 'exact', entries: entries(ids, values) });
        const s = expectValid(good, total, ids);
        expect(s).toEqual(ids.map((memberId, i) => ({ memberId, amount: values[i] })).filter(p => p.amount > 0));
        if (delta !== 0 && total + delta >= 1) {
          const bad = computeShares(total + delta, { method: 'exact', entries: entries(ids, values) });
          expect(bad).toEqual({ ok: false, code: 'exact_mismatch', diff: delta });
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('computeShares: adjust', () => {
  it('adds each adjustment on top of an equal split of the rest', () => {
    // 100 - 10 = 90 split three ways, then a gets +10.
    expect(byId(sharesOf(computeShares(100, { method: 'adjust', entries: entries(['a', 'b', 'c'], [10, 0, 0]) })))).toEqual({ a: 40, b: 30, c: 30 });
    // A negative adjustment: 110 split three ways (37, 37, 36), then a gets -10.
    expect(byId(sharesOf(computeShares(100, { method: 'adjust', entries: entries(['a', 'b', 'c'], [-10, 0, 0]) })))).toEqual({ a: 27, b: 37, c: 36 });
    // Missing values count as 0.
    expect(computeShares(100, { method: 'adjust', entries: entries(['a', 'b', 'c'], [10]) })).toEqual(
      computeShares(100, { method: 'adjust', entries: entries(['a', 'b', 'c'], [10, 0, 0]) }),
    );
  });

  it('lets the payer absorb the rounding when the adjustments leave a positive rest', () => {
    expect(byId(sharesOf(computeShares(101, { method: 'adjust', entries: entries(['a', 'b', 'c'], [1, 0, 0]) }, ['c'])))).toEqual({ a: 34, b: 33, c: 34 });
  });

  it('lets the payer absorb the rounding when the adjustments exceed the total (negative rest)', () => {
    // +34 each on NT$100 leaves a rest of -2, so two of the three shares drop by 1. The payer
    // absorbs the rounding exactly as in an equal split of NT$100: the payer keeps the larger share.
    const input: SplitInput = { method: 'adjust', entries: entries(['a', 'b', 'c'], [34, 34, 34]) };
    expect(computeShares(100, input, ['c'])).toEqual(computeShares(100, equalSplit(['a', 'b', 'c']), ['c']));
    expect(byId(sharesOf(computeShares(100, input, ['c'])))).toEqual({ a: 33, b: 33, c: 34 });
    expect(byId(sharesOf(computeShares(100, input, ['b'])))).toEqual({ a: 33, b: 34, c: 33 });
    // Without a payer the lowest index absorbs it, as in an equal split.
    expect(byId(sharesOf(computeShares(100, input)))).toEqual({ a: 34, b: 33, c: 33 });
  });

  it('rejects adjustments that make a share negative, and bad values', () => {
    expect(computeShares(30, { method: 'adjust', entries: entries(['a', 'b'], [-50, 0]) })).toEqual({ ok: false, code: 'negative_share' });
    expect(computeShares(100, { method: 'adjust', entries: entries(['a', 'b'], [200, 0]) })).toEqual({ ok: false, code: 'negative_share' });
    for (const bad of [1.5, Number.NaN, MAX_AMOUNT + 1, -(MAX_AMOUNT + 1)]) {
      expect(computeShares(100, { method: 'adjust', entries: entries(['a', 'b'], [bad, 0]) })).toEqual({ ok: false, code: 'invalid_value' });
    }
  });

  it('property: exact model, positive and negative adjustments, payers keep the larger part either way', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        participantsArb.chain(ids =>
          fc.tuple(
            fc.constant(ids),
            fc.array(fc.option(fc.oneof(fc.integer({ min: -200, max: 200 }), fc.integer({ min: -100_000, max: 100_000 })), { nil: undefined }), {
              minLength: ids.length,
              maxLength: ids.length,
            }),
          ),
        ),
        priorityArb,
        (total, [ids, adj], prio) => {
          const r = computeShares(total, { method: 'adjust', entries: entries(ids, adj) }, prio);
          const a = adj.map(x => x ?? 0);
          const n = ids.length;
          const rest = total - a.reduce((x, y) => x + y, 0);
          const q = Math.floor(rest / n);
          const extra = rest - q * n;
          const order = ranking(ids, prio);
          const want = ids.map((m, i) => a[i] + q + (order.indexOf(m) < extra ? 1 : 0));
          if (want.some(x => x < 0)) {
            expect(r).toEqual({ ok: false, code: 'negative_share' });
          } else {
            const s = expectValid(r, total, ids);
            expect(s).toEqual(ids.map((memberId, i) => ({ memberId, amount: want[i] })).filter(p => p.amount > 0));
          }
          // Whenever every exact share (adjustment + rest / n) is >= 0 the split must succeed.
          if (a.every(x => x + rest / n >= 0)) expect(r.ok).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('computeShares: items', () => {
  const item = (id: string, amount: number, memberIds: string[]): SplitItem => ({ id, name: 'item ' + id, amount, memberIds });

  it('splits each item among the people who had it, then spreads tax and tip by subtotal', () => {
    // a: 300, b: 200, shared: 100 -> subtotals a 350, b 250; 10% service (60) split 35 / 25.
    const items = [item('1', 300, ['a']), item('2', 200, ['b']), item('3', 100, ['a', 'b'])];
    expect(computeShares(660, { method: 'items', entries: [], items })).toEqual({
      ok: true,
      shares: [{ memberId: 'a', amount: 385 }, { memberId: 'b', amount: 275 }],
    });
  });

  it('spreads a discount (total below the item sum) the same way', () => {
    const items = [item('1', 300, ['a']), item('2', 200, ['b']), item('3', 100, ['a', 'b'])];
    expect(computeShares(540, { method: 'items', entries: [], items })).toEqual({
      ok: true,
      shares: [{ memberId: 'a', amount: 315 }, { memberId: 'b', amount: 225 }],
    });
  });

  it('participants come from the items in order of first appearance; entries are ignored', () => {
    const items = [item('1', 90, ['c', 'a']), item('2', 30, ['b', 'a'])];
    const r = computeShares(120, { method: 'items', entries: [{ memberId: 'zed' }], items });
    expect(sharesOf(r).map(p => p.memberId)).toEqual(['c', 'a', 'b']);
    expect(splitParticipants({ method: 'items', entries: [], items })).toEqual(['c', 'a', 'b']);
  });

  it('lets the payer absorb rounding on items and on a positive extra', () => {
    expect(computeShares(101, { method: 'items', entries: [], items: [item('1', 101, ['a', 'b'])] }, ['b'])).toEqual({
      ok: true,
      shares: [{ memberId: 'a', amount: 50 }, { memberId: 'b', amount: 51 }],
    });
    expect(byId(sharesOf(computeShares(101, { method: 'items', entries: [], items: [item('1', 100, ['a', 'b'])] }, ['b'])))).toEqual({ a: 50, b: 51 });
  });

  it('lets the payer absorb rounding on a discount too (same result as an equal split)', () => {
    // NT$100 of items for two, a NT$1 discount, b paid: NT$99 split two ways is 49 / 50 with
    // the payer taking the larger part, exactly like computeShares(99, equal, [b]).
    const r = computeShares(99, { method: 'items', entries: [], items: [item('1', 100, ['a', 'b'])] }, ['b']);
    expect(r).toEqual(computeShares(99, equalSplit(['a', 'b']), ['b']));
    expect(byId(sharesOf(r))).toEqual({ a: 49, b: 50 });
  });

  it('rounds once over the whole receipt, so people who had the same items pay the same', () => {
    const dishes = (n: number, amount: number, memberIds: string[]) => Array.from({ length: n }, (_, i) => item(String(i), amount, memberIds));
    // 12 dishes of NT$85 for three: rounding each dish separately would give 348 / 336 / 336.
    expect(sharesOf(computeShares(1020, { method: 'items', entries: [], items: dishes(12, 85, ['a', 'b', 'c']) }))).toEqual([
      { memberId: 'a', amount: 340 },
      { memberId: 'b', amount: 340 },
      { memberId: 'c', amount: 340 },
    ]);
    // 10 items of NT$5 for two: 25 each, not 30 / 20.
    expect(byId(sharesOf(computeShares(50, { method: 'items', entries: [], items: dishes(10, 5, ['a', 'b']) })))).toEqual({ a: 25, b: 25 });
    // NT$850 for three with c paying: c absorbs the single leftover unit, exactly like an equal split.
    const r = computeShares(850, { method: 'items', entries: [], items: dishes(10, 85, ['a', 'b', 'c']) }, ['c']);
    expect(byId(sharesOf(r))).toEqual({ a: 283, b: 283, c: 284 });
    expect(r).toEqual(computeShares(850, equalSplit(['a', 'b', 'c']), ['c']));
  });

  it('a receipt with a shared dish and a service charge: exact shares 289.01 / 156.89 / 110.10', () => {
    // a: 120 + 85 / 2 + 300 / 3 = 262.5; b: 142.5; c: 100 (item sum 505), then NT$556 in total.
    const items = [item('1', 120, ['a']), item('2', 85, ['a', 'b']), item('3', 300, ['a', 'b', 'c'])];
    expect(sharesOf(computeShares(556, { method: 'items', entries: [], items }))).toEqual([
      { memberId: 'a', amount: 289 },
      { memberId: 'b', amount: 157 },
      { memberId: 'c', amount: 110 },
    ]);
  });

  it('accepts free items (amount 0) and leaves out people who only had free items', () => {
    const items = [item('1', 0, ['c']), item('2', 100, ['a', 'b'])];
    expect(sharesOf(computeShares(100, { method: 'items', entries: [], items }))).toEqual([
      { memberId: 'a', amount: 50 },
      { memberId: 'b', amount: 50 },
    ]);
  });

  it('error codes: no_items, item_no_members, duplicate_member, invalid_value', () => {
    expect(computeShares(100, { method: 'items', entries: [] })).toEqual({ ok: false, code: 'no_items' });
    expect(computeShares(100, { method: 'items', entries: [], items: [] })).toEqual({ ok: false, code: 'no_items' });
    expect(computeShares(100, { method: 'items', entries: [], items: [item('1', 0, ['a'])] })).toEqual({ ok: false, code: 'no_items' });
    expect(computeShares(100, { method: 'items', entries: [], items: [item('1', 100, [])] })).toEqual({ ok: false, code: 'item_no_members' });
    expect(computeShares(100, { method: 'items', entries: [], items: [item('1', 100, ['a', 'a'])] })).toEqual({ ok: false, code: 'duplicate_member' });
    for (const bad of [-1, 1.5, Number.NaN, MAX_AMOUNT + 1]) {
      expect(computeShares(100, { method: 'items', entries: [], items: [item('1', bad, ['a'])] })).toEqual({ ok: false, code: 'invalid_value' });
    }
  });

  it('treats an item sum above the total as a discount (items_exceed_total is never returned)', () => {
    // The guard `extra < 0 && -extra > itemsSum` can only hold for a total < 0, which is rejected
    // earlier as invalid_total, so a total far below the item sum is still a valid split.
    const r = computeShares(1, { method: 'items', entries: [], items: [item('1', 1000, ['a', 'b'])] });
    expect(r.ok).toBe(true);
    expect(sumOf(sharesOf(r))).toBe(1);
  });

  // Random receipts: members, items with random subsets (in random order), tips and discounts.
  const receiptArb = fc
    .record({
      ids: fc.shuffledSubarray(MEMBERS.slice(0, 6), { minLength: 1 }),
      count: fc.integer({ min: 1, max: 8 }),
    })
    .chain(({ ids, count }) =>
      fc.record({
        ids: fc.constant(ids),
        items: fc.array(
          fc.record({
            amount: fc.oneof(fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 0, max: 30 })),
            memberIds: fc.shuffledSubarray(ids, { minLength: 1 }),
          }),
          { minLength: count, maxLength: count },
        ),
        extraFrac: fc.double({ min: -0.999, max: 1, noNaN: true }),
        prio: fc.shuffledSubarray(ids, { maxLength: Math.min(2, ids.length) }),
      }),
    )
    .map(({ ids, items, extraFrac, prio }) => {
      const list = items.map((it, i) => item(String(i), it.amount, it.memberIds));
      const sum = list.reduce((a, it) => a + it.amount, 0);
      const extra = Math.trunc(sum * extraFrac);
      return { ids, items: list, itemsSum: sum, total: sum + extra, prio };
    })
    .filter(x => x.itemsSum > 0 && x.total >= 1);

  it('property: sums to the total, no negatives, and each share is within floor/ceil of its exact share', () => {
    fc.assert(
      fc.property(receiptArb, ({ items, itemsSum, total, prio }) => {
        const r = computeShares(total, { method: 'items', entries: [], items }, prio);
        const participants = splitParticipants({ method: 'items', entries: [], items });
        const s = byId(expectValid(r, total, participants));
        // Exact share = total * sum(amount / people on the item) / item sum, over a common
        // denominator D (the product of the member counts).
        const D = items.reduce((d, it) => d * BigInt(it.memberIds.length), 1n);
        for (const m of participants) {
          let num = 0n;
          for (const it of items) if (it.memberIds.includes(m)) num += BigInt(it.amount) * (D / BigInt(it.memberIds.length));
          const den = BigInt(itemsSum) * D;
          const lo = (BigInt(total) * num) / den;
          const got = BigInt(s[m] ?? 0);
          expect(got === lo || got === lo + 1n).toBe(true);
          if ((BigInt(total) * num) % den === 0n) expect(got).toBe(lo);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('property: two people who had exactly the same items pay the same, the payer at most 1 more (tips and discounts)', () => {
    const twinsArb = fc
      .record({
        others: fc.shuffledSubarray(['c', 'd', 'e'], { maxLength: 3 }),
        items: fc.array(
          fc.record({
            amount: fc.oneof(fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 1, max: 9 })),
            withTwins: fc.boolean(),
            twinsFirst: fc.boolean(),
            pOrder: fc.boolean(),
            pick: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        extraFrac: fc.double({ min: -0.999, max: 0.5, noNaN: true }),
      })
      .map(({ others, items, extraFrac }) => {
        const list: SplitItem[] = items.map((it, i) => {
          const rest = others.filter((_, k) => it.pick[k]);
          const twins = it.pOrder ? ['p', 'q'] : ['q', 'p'];
          let memberIds = it.withTwins ? (it.twinsFirst ? [...twins, ...rest] : [...rest, ...twins]) : rest;
          if (memberIds.length === 0) memberIds = twins;
          return item(String(i), it.amount, memberIds);
        });
        const sum = list.reduce((a, it) => a + it.amount, 0);
        return { items: list, total: sum + Math.trunc(sum * extraFrac), sum };
      })
      .filter(x => x.sum > 0 && x.total >= 1);
    fc.assert(
      fc.property(twinsArb, ({ items, total }) => {
        const s = byId(sharesOf(computeShares(total, { method: 'items', entries: [], items }, ['p'])));
        const d = (s.p ?? 0) - (s.q ?? 0);
        expect(d === 0 || d === 1).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('computeShares: common errors', () => {
  it('invalid_total for zero, negative, fractional, non-finite or too large totals', () => {
    for (const t of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_AMOUNT + 1]) {
      for (const method of SPLIT_METHODS) {
        expect(computeShares(t, { method, entries: entries(['a'], [1]), items: [{ id: '1', name: 'x', amount: 1, memberIds: ['a'] }] })).toEqual({
          ok: false,
          code: 'invalid_total',
        });
      }
    }
  });

  it('no_participants and duplicate_member for every non-item method', () => {
    for (const method of SPLIT_METHODS.filter(m => m !== 'items')) {
      expect(computeShares(100, { method, entries: [] })).toEqual({ ok: false, code: 'no_participants' });
      expect(computeShares(100, { method, entries: entries(['a', 'b', 'a'], [50, 50, 0]) })).toEqual({ ok: false, code: 'duplicate_member' });
    }
  });

  it('invalid_value for an unknown method', () => {
    const r = computeShares(100, { method: 'bogus', entries: entries(['a']) } as unknown as SplitInput);
    expect(r).toEqual({ ok: false, code: 'invalid_value' });
  });

  it('is deterministic and never mutates its input', () => {
    fc.assert(
      fc.property(
        totalArb,
        fc.constantFrom(...SPLIT_METHODS),
        participantsArb.chain(ids => fc.tuple(fc.constant(ids), fc.array(fc.integer({ min: 0, max: 100 }), { minLength: ids.length, maxLength: ids.length }))),
        priorityArb,
        (total, method, [ids, values], prio) => {
          const split: SplitInput = {
            method,
            entries: entries(ids, values),
            items: [{ id: '1', name: 'x', amount: Math.max(1, Math.floor(total / 2)), memberIds: ids }],
          };
          const before = JSON.stringify(split);
          const a = computeShares(total, split, prio);
          expect(computeShares(total, split, prio)).toEqual(a);
          expect(JSON.stringify(split)).toBe(before);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('checkPayers', () => {
  it('accepts distinct positive payers that add up', () => {
    expect(checkPayers(1000, [{ memberId: 'a', amount: 1000 }])).toEqual({ ok: true });
    expect(checkPayers(1000, [{ memberId: 'a', amount: 600 }, { memberId: 'b', amount: 400 }])).toEqual({ ok: true });
  });

  it('rejects empty, duplicate, non-positive, fractional, huge and mismatched payers', () => {
    expect(checkPayers(1000, [])).toEqual({ ok: false, code: 'no_payers' });
    expect(checkPayers(1000, [{ memberId: 'a', amount: 500 }, { memberId: 'a', amount: 500 }])).toEqual({ ok: false, code: 'duplicate_member' });
    for (const bad of [0, -5, 1.5, Number.NaN, MAX_AMOUNT + 1]) {
      expect(checkPayers(1000, [{ memberId: 'a', amount: bad }, { memberId: 'b', amount: 1000 }])).toEqual({ ok: false, code: 'invalid_value' });
    }
    expect(checkPayers(1000, [{ memberId: 'a', amount: 600 }, { memberId: 'b', amount: 300 }])).toEqual({ ok: false, code: 'payers_mismatch', diff: 100 });
    expect(checkPayers(1000, [{ memberId: 'a', amount: 600 }, { memberId: 'b', amount: 500 }])).toEqual({ ok: false, code: 'payers_mismatch', diff: -100 });
  });

  it('property: ok exactly when the amounts add up to the total', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...MEMBERS), { minLength: 1, maxLength: 5 }).chain(ids =>
          fc.tuple(fc.constant(ids), fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: ids.length, maxLength: ids.length })),
        ),
        fc.integer({ min: -500, max: 500 }),
        ([ids, amounts], delta) => {
          const payers = ids.map((memberId, i) => ({ memberId, amount: amounts[i] }));
          const s = amounts.reduce((a, b) => a + b, 0);
          expect(checkPayers(s, payers)).toEqual({ ok: true });
          if (delta !== 0) expect(checkPayers(s + delta, payers)).toEqual({ ok: false, code: 'payers_mismatch', diff: delta });
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('helpers', () => {
  it('itemsTotal adds the item amounts', () => {
    expect(itemsTotal(undefined)).toBe(0);
    expect(itemsTotal([])).toBe(0);
    expect(itemsTotal([{ id: '1', name: 'a', amount: 120, memberIds: ['a'] }, { id: '2', name: 'b', amount: 80, memberIds: ['b'] }])).toBe(200);
  });

  it('splitParticipants and equalSplit', () => {
    expect(splitParticipants(equalSplit(['b', 'a']))).toEqual(['b', 'a']);
    expect(equalSplit(['a', 'b'])).toEqual({ method: 'equal', entries: [{ memberId: 'a' }, { memberId: 'b' }] });
    expect(SPLIT_METHODS).toEqual(['equal', 'exact', 'percent', 'shares', 'adjust', 'items']);
  });
});
