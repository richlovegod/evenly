// Integer allocation: split an integer total into integer parts in proportion to weights.

const SCALE = 1_000_000;

/**
 * Largest-remainder allocation. Returns integer parts, one per weight, that always sum to
 * exactly `total`. Each part is floor(total * w / W) or that plus one; the leftover units go
 * to the largest fractional remainders. Ties go to indexes listed earlier in `priority`
 * (for example the payer, who then absorbs the rounding), then to the lowest index.
 * Weights may be fractional (shares 1.5, percent 33.33); they are scaled to integers and
 * the division is done with BigInt, so the result is exact and deterministic.
 * A negative total is allocated as -(allocation of |total|). Zero-weight entries get 0.
 */
export function allocate(total: number, weights: readonly number[], priority: readonly number[] = []): number[] {
  if (!Number.isSafeInteger(total)) throw new Error('allocate: total must be a safe integer');
  const n = weights.length;
  if (n === 0) {
    if (total !== 0) throw new Error('allocate: no weights for a non-zero total');
    return [];
  }
  if (total === 0) return weights.map(() => 0);

  const w: bigint[] = weights.map(x => {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) throw new Error('allocate: weights must be finite and >= 0');
    return BigInt(Math.round(x * SCALE));
  });
  return allocateExact(total, w, priority);
}

/**
 * allocate() for weights that are already exact integers, for example fractions scaled to a
 * common denominator (BigInt, so they can be as large as needed). Same rules as allocate():
 * the parts sum to `total`, each is floor or floor + 1 of its exact share, ties go to
 * `priority` then the lowest index, and a negative total is the negation of the positive one.
 */
export function allocateExact(total: number, weights: readonly bigint[], priority: readonly number[] = []): number[] {
  if (!Number.isSafeInteger(total)) throw new Error('allocate: total must be a safe integer');
  const n = weights.length;
  if (n === 0) {
    if (total !== 0) throw new Error('allocate: no weights for a non-zero total');
    return [];
  }
  if (total === 0) return weights.map(() => 0);
  if (total < 0) return allocateExact(-total, weights, priority).map(x => (x === 0 ? 0 : -x));

  let W = 0n;
  for (const x of weights) {
    if (typeof x !== 'bigint' || x < 0n) throw new Error('allocate: weights must be finite and >= 0');
    W += x;
  }
  if (W === 0n) throw new Error('allocate: weights sum to zero');

  const T = BigInt(total);
  const base: bigint[] = new Array(n);
  const rem: bigint[] = new Array(n);
  let sum = 0n;
  for (let i = 0; i < n; i++) {
    const p = T * weights[i];
    base[i] = p / W;
    rem[i] = p % W;
    sum += base[i];
  }
  let left = Number(T - sum);
  if (left > 0) {
    const rank = new Map<number, number>();
    priority.forEach((idx, k) => { if (!rank.has(idx)) rank.set(idx, k); });
    const order = Array.from({ length: n }, (_, i) => i).filter(i => rem[i] > 0n);
    order.sort((a, b) => {
      if (rem[a] !== rem[b]) return rem[b] > rem[a] ? 1 : -1;
      const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a - b;
    });
    for (let k = 0; k < order.length && left > 0; k++, left--) base[order[k]] += 1n;
  }
  return base.map(x => Number(x));
}

/** Allocate `total` equally among `n` people (with optional tie priority). */
export function allocateEqual(total: number, n: number, priority: readonly number[] = []): number[] {
  return allocate(total, new Array(n).fill(1), priority);
}

/** FNV-1a 32-bit hash. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A fair, stable order for rounding ties inside one expense: ids sorted by a hash of
 * (seed, id), where the seed is the expense id. Re-saving an expense never moves a unit,
 * and across many expenses the leftovers land on different people instead of always on the
 * payer (Splitwise dropped "the payer absorbs it" as unfair to people who pay often).
 */
export function fairOrder(seed: string, ids: readonly string[]): string[] {
  const uniq = [...new Set(ids)];
  const h = new Map(uniq.map(id => [id, fnv1a(seed + ':' + id)]));
  return uniq.sort((a, b) => (h.get(a)! - h.get(b)!) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Indexes of `ids` in the order given by `order` (ids missing from `order` are skipped). */
export function rankIndexes(ids: readonly string[], order: readonly string[]): number[] {
  const out: number[] = [];
  for (const m of order) {
    const i = ids.indexOf(m);
    if (i >= 0 && !out.includes(i)) out.push(i);
  }
  return out;
}
