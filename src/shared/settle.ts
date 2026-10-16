// Who should pay whom. Two views, chosen per group:
//  - simplified: from each member's net balance, the fewest practical transfers
//    (everyone ends at zero; you may end up paying someone you never shared a bill with);
//  - pairwise: the debts between each pair of members from the expenses they actually
//    shared, netted pair by pair.

import { allocate } from './alloc';
import { toBase, type LedgerEntry } from './balances';

export interface Transfer {
  from: string;
  to: string;
  /** Group-currency minor units, > 0. */
  amount: number;
}

function ranker(order: readonly string[]) {
  const rank = new Map<string, number>();
  order.forEach((m, i) => { if (!rank.has(m)) rank.set(m, i); });
  return (m: string) => rank.get(m) ?? Number.MAX_SAFE_INTEGER;
}

function byMember(order: readonly string[]) {
  const r = ranker(order);
  return (a: string, b: string) => r(a) - r(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function sortTransfers(list: Transfer[], order: readonly string[]): Transfer[] {
  const cmp = byMember(order);
  return list.sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to));
}

/**
 * Settle net balances (positive = is owed) with at most (debtors + creditors - 1) transfers.
 * First pairs a debtor and a creditor whose amounts match exactly, then repeatedly matches
 * the largest debtor with the largest creditor. Deterministic for a given member order.
 */
export function simplifyDebts(net: Readonly<Record<string, number>>, order: readonly string[] = []): Transfer[] {
  const cmp = byMember(order.length ? order : Object.keys(net));
  const debtors = Object.entries(net).filter(([, v]) => v < 0).map(([m, v]) => ({ m, a: -v })).sort((x, y) => cmp(x.m, y.m));
  const creditors = Object.entries(net).filter(([, v]) => v > 0).map(([m, v]) => ({ m, a: v })).sort((x, y) => cmp(x.m, y.m));
  const out: Transfer[] = [];

  for (const d of debtors) {
    const c = creditors.find(c => c.a > 0 && c.a === d.a);
    if (c && d.a > 0) {
      out.push({ from: d.m, to: c.m, amount: d.a });
      c.a = 0;
      d.a = 0;
    }
  }

  const pick = (list: { m: string; a: number }[]) => {
    let best: { m: string; a: number } | null = null;
    for (const x of list) if (x.a > 0 && (!best || x.a > best.a)) best = x;
    return best;
  };
  for (;;) {
    const d = pick(debtors);
    const c = pick(creditors);
    if (!d || !c) break;
    const x = Math.min(d.a, c.a);
    out.push({ from: d.m, to: c.m, amount: x });
    d.a -= x;
    c.a -= x;
  }
  return sortTransfers(out, order.length ? order : Object.keys(net));
}

/**
 * Debts between pairs of members, built expense by expense. Inside one expense every member
 * who owes (owed more than paid) owes the members who are owed (paid more than owed), in
 * proportion to what each of those is still owed in that expense, so the amounts add up
 * exactly. Debts are then netted per pair across all entries (payments included).
 */
export function pairwiseDebts(entries: readonly LedgerEntry[], base: string, order: readonly string[] = []): Transfer[] {
  const cmp = byMember(order);
  const debt = new Map<string, Map<string, number>>();
  const add = (from: string, to: string, x: number) => {
    let row = debt.get(from);
    if (!row) { row = new Map(); debt.set(from, row); }
    row.set(to, (row.get(to) ?? 0) + x);
  };

  for (const e of entries) {
    if (e.deletedAt) continue;
    const b = toBase(e, base);
    const net = new Map<string, number>();
    for (const p of b.paid) net.set(p.memberId, (net.get(p.memberId) ?? 0) + p.amount);
    for (const o of b.owed) net.set(o.memberId, (net.get(o.memberId) ?? 0) - o.amount);
    const creditors = [...net].filter(([, v]) => v > 0).sort((x, y) => cmp(x[0], y[0]));
    const debtors = [...net].filter(([, v]) => v < 0).sort((x, y) => cmp(x[0], y[0]));
    if (!creditors.length || !debtors.length) continue;
    const remaining = creditors.map(([, v]) => v);
    for (const [dm, dv] of debtors) {
      const owe = -dv;
      const parts = allocate(owe, remaining);
      parts.forEach((x, i) => {
        if (x > 0) {
          add(dm, creditors[i][0], x);
          remaining[i] -= x;
        }
      });
    }
  }

  const out: Transfer[] = [];
  const seen = new Set<string>();
  for (const [a, row] of debt) {
    for (const [b] of row) {
      const key = cmp(a, b) <= 0 ? a + '\u0000' + b : b + '\u0000' + a;
      if (seen.has(key)) continue;
      seen.add(key);
      const ab = debt.get(a)?.get(b) ?? 0;
      const ba = debt.get(b)?.get(a) ?? 0;
      if (ab > ba) out.push({ from: a, to: b, amount: ab - ba });
      else if (ba > ab) out.push({ from: b, to: a, amount: ba - ab });
    }
  }
  return sortTransfers(out, order);
}

/**
 * "Everyone settles with one person": every other member who owes pays `hub`, and `hub` pays
 * every member who is owed. Handy when one person fronted the lodging and the lift tickets.
 */
export function hubPlan(net: Readonly<Record<string, number>>, hub: string, order: readonly string[] = []): Transfer[] {
  const out: Transfer[] = [];
  for (const [m, v] of Object.entries(net)) {
    if (m === hub || v === 0) continue;
    if (v < 0) out.push({ from: m, to: hub, amount: -v });
    else out.push({ from: hub, to: m, amount: v });
  }
  return sortTransfers(out, order.length ? order : Object.keys(net));
}

/** The settle-up plan a group shows, following its "simplify debts" setting. */
export function settlementPlan(
  entries: readonly LedgerEntry[],
  base: string,
  net: Readonly<Record<string, number>>,
  simplify: boolean,
  order: readonly string[] = [],
): Transfer[] {
  return simplify ? simplifyDebts(net, order) : pairwiseDebts(entries, base, order);
}

/** Transfers that involve one member, split into what they owe and what they are owed. */
export function transfersFor(memberId: string, plan: readonly Transfer[]): { owes: Transfer[]; owed: Transfer[] } {
  return {
    owes: plan.filter(t => t.from === memberId),
    owed: plan.filter(t => t.to === memberId),
  };
}
