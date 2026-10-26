// The per-group numbers the dashboard needs, computed by the Worker after every change
// (and by the web app from the full group data, with the same code).

import { netBalances, spendTotals, type LedgerEntry } from './balances';
import { settlementPlan, type Transfer } from './settle';

/**
 * Bump when the math changes; stored summaries with another value are recomputed on read.
 * 2: refunds (kind 'refund') count as negative expenses (2026-10-26). A summary that version 1
 * code stored for a group with refunds (a rollback, then a roll forward) counted them as expenses.
 */
export const SUMMARY_VERSION = 2;

export interface GroupSummary {
  v: number;
  /** The group version this summary was computed for. */
  forVersion: number;
  currency: string;
  /** Net per member, group-currency minor units (positive = is owed). */
  net: Record<string, number>;
  /** Expenses less refunds (payments excluded). */
  paid: Record<string, number>;
  share: Record<string, number>;
  /** Expenses less refunds (payments are not spending). */
  spent: number;
  /** Settle-up plan following the group's simplify setting. */
  transfers: Transfer[];
  /** Number of live (not deleted) entries, payments included. */
  count: number;
  /** Latest entry date (YYYY-MM-DD) or null. */
  lastDate: string | null;
}

export function computeGroupSummary(args: {
  currency: string;
  simplify: boolean;
  memberOrder: readonly string[];
  entries: readonly LedgerEntry[];
  forVersion: number;
}): GroupSummary {
  const { currency, simplify, memberOrder, entries, forVersion } = args;
  const live = entries.filter(e => !e.deletedAt);
  const net = netBalances(live, currency, memberOrder);
  const totals = spendTotals(live, currency);
  let lastDate: string | null = null;
  for (const e of live) if (e.date && (!lastDate || e.date > lastDate)) lastDate = e.date;
  return {
    v: SUMMARY_VERSION,
    forVersion,
    currency,
    net,
    paid: totals.paid,
    share: totals.share,
    spent: totals.spent,
    transfers: settlementPlan(live, currency, net, simplify, memberOrder),
    count: live.length,
    lastDate,
  };
}
