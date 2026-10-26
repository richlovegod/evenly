// Balances: convert each expense into the group currency and add up who paid and who owes.
//
// A refund (kind 'refund', docs/SPEC.md section 2, Refunds) is money coming back: exactly a
// negative expense. It is stored like an expense, with positive amounts: its payers are who got the
// money back and its shares whose money it is. toBase gives it with every amount negated, so every
// sum below (nets, plans, spending) takes it off without a case of its own.

import { allocate, fairOrder, rankIndexes } from './alloc';
import { getCurrency } from './currencies';
import { pow10 } from './money';
import type { Portion } from './split';

/** The fields of an expense, payment or refund that balance math needs. */
export interface LedgerEntry {
  id: string;
  kind: 'expense' | 'payment' | 'refund';
  /** Minor units of `currency`, > 0. */
  amount: number;
  currency: string;
  /** 1 major unit of `currency` = fxRate major units of the group currency (1 when the same). */
  fxRate: number;
  /** Who paid, minor units of `currency`, sums to `amount`. For a payment: the sender. For a refund: who got the money back. */
  payers: Portion[];
  /** Who owes, minor units of `currency`, sums to `amount`. For a payment: the recipient. For a refund: whose money it is. */
  shares: Portion[];
  category?: string;
  date?: string;
  deletedAt?: string | null;
}

/** A stored kind as the balance math reads it: 'payment' and 'refund' as such, anything else an expense. */
export function ledgerKind(kind: string): LedgerEntry['kind'] {
  return kind === 'payment' || kind === 'refund' ? kind : 'expense';
}

/**
 * Convert minor units of `from` into minor units of `to` at `rate`
 * (1 major `from` = rate major `to`), rounding half away from zero.
 */
export function convertMinor(amount: number, from: string, rate: number, to: string): number {
  if (from === to) return amount;
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('convertMinor: bad rate');
  const df = getCurrency(from).decimals;
  const dt = getCurrency(to).decimals;
  const x = (Math.abs(amount) * rate * pow10(dt)) / pow10(df);
  const r = Math.round(Number(x.toPrecision(14)));
  // `r !== 0` keeps a negative amount that rounds to nothing from coming back as -0.
  return amount < 0 && r !== 0 ? -r : r;
}

export interface BasePortions {
  /** The expense total in group-currency minor units. */
  total: number;
  paid: Portion[];
  owed: Portion[];
}

/** -x, keeping 0 as 0 (never -0, which JSON and other languages would not tell from 0 anyway). */
function negate(x: number): number {
  return x === 0 ? 0 : -x;
}

/**
 * The expense expressed in the group currency. The converted total is split back over the
 * payers and the sharers in proportion to their original amounts, so paid and owed both sum
 * to exactly the converted total and every expense nets to zero across the group.
 * A refund comes out as the same entry as an expense would, with every amount negated (total,
 * paid and owed below zero): money coming back.
 */
export function toBase(e: LedgerEntry, base: string): BasePortions {
  const b = toBasePositive(e, base);
  if (e.kind !== 'refund') return b;
  return {
    total: negate(b.total),
    paid: b.paid.map(p => ({ memberId: p.memberId, amount: negate(p.amount) })),
    owed: b.owed.map(o => ({ memberId: o.memberId, amount: negate(o.amount) })),
  };
}

function toBasePositive(e: LedgerEntry, base: string): BasePortions {
  const total = convertMinor(e.amount, e.currency, e.currency === base ? 1 : e.fxRate, base);
  if (total === 0) {
    return {
      total: 0,
      paid: e.payers.map(p => ({ memberId: p.memberId, amount: 0 })),
      owed: e.shares.map(s => ({ memberId: s.memberId, amount: 0 })),
    };
  }
  // One fair order for both sides, so a member who pays and owes the same amount nets to zero.
  const payerIds = e.payers.map(p => p.memberId);
  const shareIds = e.shares.map(s => s.memberId);
  const order = e.currency === base ? [] : fairOrder(e.id, [...payerIds, ...shareIds]);
  const paidParts = e.currency === base ? e.payers.map(p => p.amount) : allocate(total, e.payers.map(p => p.amount), rankIndexes(payerIds, order));
  const owedParts = e.currency === base ? e.shares.map(s => s.amount) : allocate(total, e.shares.map(s => s.amount), rankIndexes(shareIds, order));
  return {
    total,
    paid: e.payers.map((p, i) => ({ memberId: p.memberId, amount: paidParts[i] })),
    owed: e.shares.map((s, i) => ({ memberId: s.memberId, amount: owedParts[i] })),
  };
}

/** Per-member effect of one entry in group currency: paid minus owed (positive = gets money back). */
export function entryNet(e: LedgerEntry, base: string): Map<string, number> {
  const b = toBase(e, base);
  const net = new Map<string, number>();
  for (const p of b.paid) net.set(p.memberId, (net.get(p.memberId) ?? 0) + p.amount);
  for (const o of b.owed) net.set(o.memberId, (net.get(o.memberId) ?? 0) - o.amount);
  return net;
}

function live(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries.filter(e => !e.deletedAt);
}

/**
 * Net balance per member in group-currency minor units: positive = the group owes them,
 * negative = they owe the group. Always sums to exactly 0. Deleted entries are ignored.
 * Members in `memberIds` with no activity appear with 0.
 */
export function netBalances(entries: readonly LedgerEntry[], base: string, memberIds: readonly string[] = []): Record<string, number> {
  const net: Record<string, number> = {};
  for (const m of memberIds) net[m] = 0;
  for (const e of live(entries)) {
    for (const [m, v] of entryNet(e, base)) net[m] = (net[m] ?? 0) + v;
  }
  return net;
}

export interface SpendTotals {
  /** Sum of expense totals less refunds (payments excluded), group-currency minor units. */
  spent: number;
  /** What each member paid for expenses, less the refunds they got back (payments excluded). */
  paid: Record<string, number>;
  /** Each member's share of expenses, less their share of refunds (payments excluded). */
  share: Record<string, number>;
  /** Spending by category key (a refund takes its amount off its own category). */
  byCategory: Record<string, number>;
}

/** Spending: expenses add, refunds subtract (toBase gives them negated), payments are not spending. */
export function spendTotals(entries: readonly LedgerEntry[], base: string): SpendTotals {
  const out: SpendTotals = { spent: 0, paid: {}, share: {}, byCategory: {} };
  for (const e of live(entries)) {
    if (e.kind === 'payment') continue;
    const b = toBase(e, base);
    out.spent += b.total;
    const cat = e.category || 'general';
    out.byCategory[cat] = (out.byCategory[cat] ?? 0) + b.total;
    for (const p of b.paid) out.paid[p.memberId] = (out.paid[p.memberId] ?? 0) + p.amount;
    for (const o of b.owed) out.share[o.memberId] = (out.share[o.memberId] ?? 0) + o.amount;
  }
  return out;
}

/**
 * How one entry affects one member, in the entry's own currency (for list rows like
 * "you lent ¥10,500" / "you borrowed ¥2,100"): paid minus owed. 0 with involved=false
 * means the member had no part in it. A refund counts negatively, like toBase: what the member
 * got back is a negative `paid`, their share of it a negative `owed`.
 */
export function memberEffect(e: LedgerEntry, memberId: string): { involved: boolean; paid: number; owed: number; net: number } {
  let paid = 0;
  let owed = 0;
  let involved = false;
  for (const p of e.payers) if (p.memberId === memberId) { paid += p.amount; involved = true; }
  for (const s of e.shares) if (s.memberId === memberId) { owed += s.amount; involved = true; }
  if (e.kind === 'refund') {
    paid = negate(paid);
    owed = negate(owed);
  }
  return { involved, paid, owed, net: paid - owed };
}
