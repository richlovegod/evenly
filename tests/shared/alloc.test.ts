import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allocate, allocateEqual, allocateExact } from '../../src/shared/alloc';

// Exact reference numbers with BigInt: for integer weights, part i must be
// floor(total * w_i / W) or one more, and only parts with a non-zero remainder may get the extra.
function exactParts(total: number, weights: readonly number[]) {
  const T = BigInt(total);
  const W = weights.reduce((a, w) => a + BigInt(w), 0n);
  return weights.map(w => ({ floor: (T * BigInt(w)) / W, rem: (T * BigInt(w)) % W }));
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

const intWeights = (max = 1000, maxLength = 12) =>
  fc.array(fc.integer({ min: 0, max }), { minLength: 1, maxLength }).filter(w => w.some(x => x > 0));

const anyTotal = fc.oneof(
  fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 }),
  fc.integer({ min: -100, max: 100 }),
  fc.constantFrom(Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 1, -1, 0),
);

const priorityArb = fc.array(fc.integer({ min: -2, max: 14 }), { maxLength: 8 });

describe('allocate: examples', () => {
  it('splits 100 three ways, the leftover going to the lowest index or to priority', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(100, [1, 1, 1], [2])).toEqual([33, 33, 34]);
    expect(allocate(101, [1, 1, 1], [2, 1])).toEqual([33, 34, 34]);
    expect(allocate(101, [1, 1, 1], [2])).toEqual([34, 33, 34]);
  });

  it('follows the largest remainders before priority', () => {
    // 1000 * [1, 2, 3] / 6 = 166.67, 333.33, 500: the one leftover unit goes to index 0.
    expect(allocate(1000, [1, 2, 3])).toEqual([167, 333, 500]);
    // Priority does not override a larger remainder.
    expect(allocate(1000, [1, 2, 3], [1])).toEqual([167, 333, 500]);
  });

  it('accepts fractional weights (shares 1.5, percentages)', () => {
    expect(allocate(100, [1.5, 1, 0.5])).toEqual([50, 33, 17]);
    expect(allocate(10000, [33.33, 33.33, 33.34])).toEqual([3333, 3333, 3334]);
    expect(allocate(1000, [12.5, 87.5])).toEqual([125, 875]);
  });

  it('gives zero-weight entries nothing, even when they are listed first in priority', () => {
    expect(allocate(10, [0, 1, 0, 1])).toEqual([0, 5, 0, 5]);
    expect(allocate(5, [0, 1, 1], [0])).toEqual([0, 3, 2]);
  });

  it('returns zeros for a zero total and an empty list for no weights', () => {
    expect(allocate(0, [1, 2, 3])).toEqual([0, 0, 0]);
    expect(allocate(0, [])).toEqual([]);
  });

  it('allocates a negative total as the negation of the positive one, without -0', () => {
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    const parts = allocate(-1, [1, 1, 1]);
    expect(parts).toEqual([-1, 0, 0]);
    for (const p of parts) expect(Object.is(p, -0)).toBe(false);
  });

  it('stays exact at the largest amounts', () => {
    expect(allocate(1_000_000_000_000, [1, 1, 1])).toEqual([333_333_333_334, 333_333_333_333, 333_333_333_333]);
    const big = allocate(Number.MAX_SAFE_INTEGER, [1, 2, 4]);
    expect(sum(big)).toBe(Number.MAX_SAFE_INTEGER);
    // 2^53 - 1 = 9007199254740991; / 7 = 1286742750677284.43 exactly.
    expect(big).toEqual([1286742750677284, 2573485501354569, 5146971002709138]);
  });

  it('treats weights below the 1e-6 resolution as zero', () => {
    expect(allocate(100, [1e-7, 1])).toEqual([0, 100]);
    expect(() => allocate(100, [1e-7])).toThrow(/sum to zero/);
  });

  it('throws on bad input', () => {
    expect(() => allocate(1.5, [1])).toThrow(/safe integer/);
    expect(() => allocate(Number.NaN, [1])).toThrow(/safe integer/);
    expect(() => allocate(Number.POSITIVE_INFINITY, [1])).toThrow(/safe integer/);
    expect(() => allocate(2 ** 53, [1])).toThrow(/safe integer/);
    expect(() => allocate(10, [])).toThrow(/no weights/);
    expect(() => allocate(10, [1, -1])).toThrow(/finite and >= 0/);
    expect(() => allocate(10, [1, Number.NaN])).toThrow(/finite and >= 0/);
    expect(() => allocate(10, [1, Number.POSITIVE_INFINITY])).toThrow(/finite and >= 0/);
    expect(() => allocate(-10, [1, -1])).toThrow(/finite and >= 0/);
    expect(() => allocate(10, [0, 0])).toThrow(/sum to zero/);
    expect(() => allocate(0, [], [])).not.toThrow();
  });

  it('allocateEqual is allocate with equal weights', () => {
    expect(allocateEqual(10, 3)).toEqual([4, 3, 3]);
    expect(allocateEqual(10, 3, [2])).toEqual([3, 3, 4]);
    expect(allocateEqual(0, 0)).toEqual([]);
  });
});

describe('allocate: properties', () => {
  it('always sums to the total (positive, negative and zero; integer and fractional weights)', () => {
    const weights = fc.oneof(
      intWeights(),
      fc.array(fc.integer({ min: 0, max: 100000 }).map(k => k / 100), { minLength: 1, maxLength: 12 }).filter(w => w.some(x => x > 0)),
      fc.array(fc.double({ min: 0, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 12 }).filter(w => w.some(x => Math.round(x * 1e6) > 0)),
    );
    fc.assert(
      fc.property(anyTotal, weights, priorityArb, (total, w, prio) => {
        const parts = allocate(total, w, prio);
        expect(parts).toHaveLength(w.length);
        expect(sum(parts)).toBe(total);
        for (const p of parts) {
          expect(Number.isSafeInteger(p)).toBe(true);
          expect(Object.is(p, -0)).toBe(false);
          if (total >= 0) expect(p).toBeGreaterThanOrEqual(0);
          else expect(p).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('keeps each part within floor/ceil of its exact share; extras go to the largest remainders, ties by priority then index', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000_000 }), intWeights(), priorityArb, (total, w, prio) => {
        const parts = allocate(total, w, prio);
        const ex = exactParts(total, w);
        const rank = (i: number) => {
          const k = prio.indexOf(i);
          return k < 0 ? Number.POSITIVE_INFINITY : k;
        };
        const extra = parts.map((p, i) => BigInt(p) - ex[i].floor);
        extra.forEach((e, i) => {
          expect(e === 0n || e === 1n).toBe(true);
          if (ex[i].rem === 0n) expect(e).toBe(0n);
        });
        for (let i = 0; i < w.length; i++) {
          for (let j = 0; j < w.length; j++) {
            if (extra[i] !== 1n || extra[j] !== 0n || ex[j].rem === 0n) continue;
            // i won an extra unit that j could also have taken.
            expect(ex[i].rem >= ex[j].rem).toBe(true);
            if (ex[i].rem === ex[j].rem) {
              expect(rank(i) < rank(j) || (rank(i) === rank(j) && i < j)).toBe(true);
            }
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('gives zero weights exactly 0 for any total', () => {
    fc.assert(
      fc.property(anyTotal, intWeights(5, 10), priorityArb, (total, w, prio) => {
        const parts = allocate(total, w, prio);
        w.forEach((x, i) => {
          if (x === 0) expect(parts[i]).toBe(0);
        });
      }),
      { numRuns: 500 },
    );
  });

  it('allocates a negative total as the exact negation of the positive one', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000_000 }), intWeights(), priorityArb, (total, w, prio) => {
        const pos = allocate(total, w, prio);
        const neg = allocate(-total, w, prio);
        expect(neg).toEqual(pos.map(x => (x === 0 ? 0 : -x)));
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic and ignores duplicate or out-of-range priority indexes', () => {
    fc.assert(
      fc.property(anyTotal, intWeights(), priorityArb, (total, w, prio) => {
        const a = allocate(total, w, prio);
        expect(allocate(total, w, prio)).toEqual(a);
        const deduped = prio.filter((x, k) => prio.indexOf(x) === k);
        expect(allocate(total, w, deduped)).toEqual(a);
        expect(allocate(total, w, [...prio, ...prio, -1, 99])).toEqual(a);
        const inRange = deduped.filter(x => x >= 0 && x < w.length);
        expect(allocate(total, w, inRange)).toEqual(a);
      }),
      { numRuns: 500 },
    );
  });

  it('does not depend on the scale of the weights', () => {
    fc.assert(
      fc.property(anyTotal, intWeights(100000), priorityArb, fc.constantFrom(2, 3, 7, 1000), (total, w, prio, k) => {
        const a = allocate(total, w, prio);
        expect(allocate(total, w.map(x => x * k), prio)).toEqual(a);
        // Weights given as percentages or decimals (x / 100) mean the same proportions.
        expect(allocate(total, w.map(x => x / 100), prio)).toEqual(a);
      }),
      { numRuns: 500 },
    );
  });

  it('gives a larger weight at least as much as a smaller one', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000_000 }), intWeights(50), priorityArb, (total, w, prio) => {
        const parts = allocate(total, w, prio);
        for (let i = 0; i < w.length; i++) {
          for (let j = 0; j < w.length; j++) {
            if (w[i] > w[j]) expect(parts[i]).toBeGreaterThanOrEqual(parts[j]);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it('with equal weights, parts differ by at most 1 and the larger ones go to priority, then the lowest indexes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 20 }),
        priorityArb,
        (total, n, prio) => {
          const parts = allocate(total, new Array(n).fill(1), prio);
          const q = Math.floor(total / n);
          const r = total % n;
          const order: number[] = [];
          for (const i of prio) if (i >= 0 && i < n && !order.includes(i)) order.push(i);
          for (let i = 0; i < n; i++) if (!order.includes(i)) order.push(i);
          const expected = new Array(n).fill(q);
          for (let k = 0; k < r; k++) expected[order[k]] = q + 1;
          expect(parts).toEqual(expected);
          expect(allocateEqual(total, n, prio)).toEqual(expected);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('with a full priority order the result does not depend on the index order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        intWeights(20, 8).chain(w =>
          fc.tuple(fc.constant(w), fc.shuffledSubarray(w.map((_, i) => i), { minLength: w.length }), fc.shuffledSubarray(w.map((_, i) => i), { minLength: w.length })),
        ),
        (total, [w, prio, perm]) => {
          // perm[k] = old index placed at new position k.
          const parts = allocate(total, w, prio);
          const newIndexOf = new Map(perm.map((old, k) => [old, k]));
          const permuted = allocate(
            total,
            perm.map(old => w[old]),
            prio.map(old => newIndexOf.get(old)!),
          );
          expect(permuted).toEqual(perm.map(old => parts[old]));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('throws for any non-safe-integer total and for invalid weights', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.double({ noInteger: true, noNaN: true }), fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -(2 ** 53))),
        intWeights(),
        (total, w) => {
          expect(() => allocate(total, w)).toThrow();
        },
      ),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }).chain(t => fc.constantFrom(t, -t)),
        intWeights(),
        fc.oneof(fc.double({ max: -1e-9, noNaN: true }), fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)),
        fc.nat(),
        (total, w, bad, at) => {
          const ws = [...w];
          ws.splice(at % (ws.length + 1), 0, bad);
          expect(() => allocate(total, ws)).toThrow(/finite and >= 0/);
        },
      ),
    );
  });
});

describe('allocateExact (BigInt weights)', () => {
  it('gives the same parts as allocate for the same integer weights', () => {
    fc.assert(
      fc.property(anyTotal, intWeights(), priorityArb, (total, w, prio) => {
        expect(allocateExact(total, w.map(x => BigInt(x)), prio)).toEqual(allocate(total, w, prio));
      }),
      { numRuns: 1000 },
    );
  });

  it('stays exact with weights far beyond 2^53', () => {
    const big = fc.array(fc.bigInt({ min: 0n, max: 2n ** 120n }), { minLength: 1, maxLength: 10 }).filter(w => w.some(x => x > 0n));
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000_000 }), big, priorityArb, (total, w, prio) => {
        const parts = allocateExact(total, w, prio);
        expect(sum(parts)).toBe(total);
        const W = w.reduce((a, b) => a + b, 0n);
        parts.forEach((p, i) => {
          const lo = (BigInt(total) * w[i]) / W;
          const exact = (BigInt(total) * w[i]) % W === 0n;
          expect(BigInt(p) === lo || (!exact && BigInt(p) === lo + 1n)).toBe(true);
        });
        expect(allocateExact(-total, w, prio)).toEqual(parts.map(x => (x === 0 ? 0 : -x)));
      }),
      { numRuns: 500 },
    );
    // 1/3 : 1/3 : 1/3 written over a huge common denominator.
    const third = 10n ** 30n;
    expect(allocateExact(100, [third, third, third], [2])).toEqual([33, 33, 34]);
  });

  it('throws on bad input', () => {
    expect(() => allocateExact(1.5, [1n])).toThrow(/safe integer/);
    expect(() => allocateExact(10, [])).toThrow(/no weights/);
    expect(() => allocateExact(10, [1n, -1n])).toThrow(/finite and >= 0/);
    expect(() => allocateExact(10, [0n, 0n])).toThrow(/sum to zero/);
    expect(allocateExact(0, [1n, 2n])).toEqual([0, 0]);
    expect(allocateExact(0, [])).toEqual([]);
  });
});
