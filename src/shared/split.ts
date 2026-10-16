// How an expense is divided among members. The client computes shares for live preview;
// the Worker recomputes them from the same input with this same code and never trusts
// shares sent by a client.

import { allocate, allocateExact, fairOrder } from './alloc';
import { MAX_AMOUNT } from './money';

export type SplitMethod = 'equal' | 'exact' | 'percent' | 'shares' | 'adjust' | 'items';

export const SPLIT_METHODS: readonly SplitMethod[] = ['equal', 'exact', 'percent', 'shares', 'adjust', 'items'];

/**
 * One participant and the number they typed:
 * equal: ignored; exact: minor units; percent: 0 to 100; shares: >= 0 (1.5 allowed);
 * adjust: minor units added to (or, if negative, taken from) an equal share of the rest.
 */
export interface SplitEntry {
  memberId: string;
  value?: number;
}

/** A line on a receipt, split equally among the members who had it. */
export interface SplitItem {
  id: string;
  name: string;
  /** Minor units. */
  amount: number;
  memberIds: string[];
}

export interface SplitInput {
  method: SplitMethod;
  /** Participants in display order. For 'items' the participants come from the items. */
  entries: SplitEntry[];
  /** Only for method 'items'. The expense total minus the item sum (tax, tip, service charge,
   *  or a discount when negative) is spread in proportion to each person's item subtotal. */
  items?: SplitItem[];
}

/** An amount owed or paid by one member, in minor units of the expense currency. */
export interface Portion {
  memberId: string;
  amount: number;
}

export type SplitErrorCode =
  | 'invalid_total'
  | 'no_participants'
  | 'duplicate_member'
  | 'invalid_value'
  | 'exact_mismatch'
  | 'percent_mismatch'
  | 'zero_weights'
  | 'negative_share'
  | 'no_items'
  | 'item_no_members'
  | 'items_exceed_total';

export type SplitResult =
  | { ok: true; shares: Portion[] }
  /** diff: for exact_mismatch the minor units still unassigned (negative = over-assigned);
   *  for percent_mismatch the percentage points still unassigned. */
  | { ok: false; code: SplitErrorCode; diff?: number };

const PERCENT_EPSILON = 0.001;

function fail(code: SplitErrorCode, diff?: number): SplitResult {
  return diff === undefined ? { ok: false, code } : { ok: false, code, diff };
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function priorityIndexes(ids: readonly string[], priority: readonly string[]): number[] {
  const out: number[] = [];
  for (const p of priority) {
    const i = ids.indexOf(p);
    if (i >= 0 && !out.includes(i)) out.push(i);
  }
  return out;
}

/**
 * allocate() where the members ranked first (`prio`, then entry order) absorb the rounding,
 * that is, end up with the larger part, whatever the sign of `amount`. allocate() gives the
 * extra unit of a negative amount (the more negative part) to the indexes it ranks first, so a
 * negative amount (adjustments that add up to more than the total) uses the reversed ranking.
 */
function allocateAbsorbed(amount: number, weights: readonly number[], prio: readonly number[]): number[] {
  if (amount >= 0) return allocate(amount, weights, prio);
  const order = [...prio];
  for (let i = 0; i < weights.length; i++) if (!order.includes(i)) order.push(i);
  return allocate(amount, weights, order.reverse());
}

function toPortions(ids: readonly string[], amounts: readonly number[]): Portion[] {
  const out: Portion[] = [];
  for (let i = 0; i < ids.length; i++) if (amounts[i] !== 0) out.push({ memberId: ids[i], amount: amounts[i] });
  return out;
}

/**
 * Compute each member's share of `total` (minor units, > 0).
 * `priority` lists member ids that absorb rounding leftovers first (pass the payers), so with
 * NT$100 split three ways and Gino paying, Gino's share is NT$34 and the others owe NT$33.
 * This holds for every method, including adjustments above the total and item discounts.
 * Members whose share is 0 are left out of the result.
 */
export function computeShares(total: number, split: SplitInput, priority: readonly string[] = []): SplitResult {
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_AMOUNT) return fail('invalid_total');

  if (split.method === 'items') return computeItems(total, split.items ?? [], priority);

  const entries = split.entries ?? [];
  if (entries.length === 0) return fail('no_participants');
  const ids = entries.map(e => e.memberId);
  if (new Set(ids).size !== ids.length) return fail('duplicate_member');
  const prio = priorityIndexes(ids, priority);

  switch (split.method) {
    case 'equal':
      return { ok: true, shares: toPortions(ids, allocate(total, ids.map(() => 1), prio)) };

    case 'shares': {
      const w = entries.map(e => e.value);
      if (!w.every(x => isFiniteNumber(x) && x >= 0 && x <= 1_000_000)) return fail('invalid_value');
      if ((w as number[]).every(x => Math.round(x * 1_000_000) === 0)) return fail('zero_weights');
      return { ok: true, shares: toPortions(ids, allocate(total, w as number[], prio)) };
    }

    case 'percent': {
      const w = entries.map(e => e.value);
      if (!w.every(x => isFiniteNumber(x) && x >= 0 && x <= 100)) return fail('invalid_value');
      const sum = (w as number[]).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) > PERCENT_EPSILON) return fail('percent_mismatch', Math.round((100 - sum) * 1000) / 1000);
      return { ok: true, shares: toPortions(ids, allocate(total, w as number[], prio)) };
    }

    case 'exact': {
      const v = entries.map(e => e.value);
      if (!v.every(x => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= MAX_AMOUNT)) return fail('invalid_value');
      const sum = (v as number[]).reduce((a, b) => a + b, 0);
      if (sum !== total) return fail('exact_mismatch', total - sum);
      return { ok: true, shares: toPortions(ids, v as number[]) };
    }

    case 'adjust': {
      const adj = entries.map(e => (e.value === undefined ? 0 : e.value));
      if (!adj.every(x => Number.isSafeInteger(x) && Math.abs(x) <= MAX_AMOUNT)) return fail('invalid_value');
      const rest = total - adj.reduce((a, b) => a + b, 0);
      const equal = allocateAbsorbed(rest, ids.map(() => 1), prio);
      const shares = equal.map((x, i) => x + adj[i]);
      if (shares.some(x => x < 0)) return fail('negative_share');
      return { ok: true, shares: toPortions(ids, shares) };
    }

    default:
      return fail('invalid_value');
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Each person's item subtotal is the exact sum of amount / (people on the item) over their
 * items; the total (item sum plus tax and tip, or minus a discount) is split in proportion to
 * those subtotals with ONE rounding. Rounding every item separately would hand the same
 * person the leftover unit on every line (12 dishes of NT$85 for three: 348 / 336 / 336
 * instead of 340 each). Scaling by the least common multiple of the member counts keeps the
 * subtotals exact integers.
 */
function computeItems(total: number, items: readonly SplitItem[], priority: readonly string[]): SplitResult {
  if (items.length === 0) return fail('no_items');
  const ids: string[] = [];
  let itemsSum = 0;
  let lcm = 1n;
  for (const it of items) {
    if (!Number.isSafeInteger(it.amount) || it.amount < 0 || it.amount > MAX_AMOUNT) return fail('invalid_value');
    const mids = it.memberIds ?? [];
    if (mids.length === 0) return fail('item_no_members');
    if (new Set(mids).size !== mids.length) return fail('duplicate_member');
    for (const m of mids) if (!ids.includes(m)) ids.push(m);
    const n = BigInt(mids.length);
    lcm = (lcm / gcd(lcm, n)) * n;
    itemsSum += it.amount;
  }
  if (itemsSum <= 0) return fail('no_items');
  const extra = total - itemsSum;
  if (extra < 0 && -extra > itemsSum) return fail('items_exceed_total');
  const weight = new Map<string, bigint>(ids.map(m => [m, 0n]));
  for (const it of items) {
    const per = BigInt(it.amount) * (lcm / BigInt(it.memberIds.length));
    for (const m of it.memberIds) weight.set(m, (weight.get(m) ?? 0n) + per);
  }
  const shares = allocateExact(total, ids.map(m => weight.get(m) ?? 0n), priorityIndexes(ids, priority));
  return { ok: true, shares: toPortions(ids, shares) };
}

/** Sum of the item amounts of an 'items' split (minor units). */
export function itemsTotal(items: readonly SplitItem[] | undefined): number {
  let s = 0;
  for (const it of items ?? []) s += it.amount;
  return s;
}

/** Participants of a split input, in order (for 'items': first appearance across items). */
export function splitParticipants(split: SplitInput): string[] {
  if (split.method !== 'items') return split.entries.map(e => e.memberId);
  const out: string[] = [];
  for (const it of split.items ?? []) for (const m of it.memberIds) if (!out.includes(m)) out.push(m);
  return out;
}

export type PayersErrorCode = 'no_payers' | 'duplicate_member' | 'invalid_value' | 'payers_mismatch';

/** Payers must be distinct members with positive amounts that add up to the total. */
export function checkPayers(total: number, payers: readonly Portion[]): { ok: true } | { ok: false; code: PayersErrorCode; diff?: number } {
  if (payers.length === 0) return { ok: false, code: 'no_payers' };
  const ids = payers.map(p => p.memberId);
  if (new Set(ids).size !== ids.length) return { ok: false, code: 'duplicate_member' };
  if (!payers.every(p => Number.isSafeInteger(p.amount) && p.amount > 0 && p.amount <= MAX_AMOUNT)) return { ok: false, code: 'invalid_value' };
  const sum = payers.reduce((a, p) => a + p.amount, 0);
  if (sum !== total) return { ok: false, code: 'payers_mismatch', diff: total - sum };
  return { ok: true };
}

/**
 * The shares the app actually stores: computeShares with a fair, stable tie-break order
 * derived from the expense id (see alloc.fairOrder). Web and Worker both call this, so the
 * preview always matches what the server saves.
 */
export function computeSharesFor(expenseId: string, total: number, split: SplitInput): SplitResult {
  return computeShares(total, split, fairOrder(expenseId, splitParticipants(split)));
}

/** Convenience builder: an equal split among these members. */
export function equalSplit(memberIds: readonly string[]): SplitInput {
  return { method: 'equal', entries: memberIds.map(memberId => ({ memberId })) };
}
