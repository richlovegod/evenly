// The dashboard as this device should show it: GET /api/me plus unsynced changes. For every group
// with queued writes whose snapshot is cached here (and is not older than the dashboard), the
// group's numbers are recomputed from the merged view with the same shared math the Worker uses;
// totals and friends follow from those numbers by the Worker's own rules (routes/me.ts).

import { convertMinor } from '../../../shared/balances';
import type { Transfer } from '../../../shared/settle';
import type { FriendDTO, FxRes, GroupListItemDTO, MeDTO } from '../../../shared/types';
import { applyOutbox, type GroupEntry, type OutboxItem } from '../../lib/store';
import { summarize } from '../groups/groupMath';

export interface DashboardView {
  groups: GroupListItemDTO[];
  friends: FriendDTO[];
  totals: MeDTO['totals'];
  /** Unsynced changes the numbers above include. */
  pendingCounted: number;
  /** Unsynced changes not included yet (their group is not cached on this device). */
  pendingUncounted: number;
}

/** Outbox operations that change balances (comments do not). */
const BALANCE_OPS: ReadonlySet<OutboxItem['op']> = new Set(['upsert', 'delete', 'restore']);

export function byHomeThenCode(home: string | undefined) {
  return (a: { currency: string }, b: { currency: string }): number => {
    if (home && a.currency !== b.currency) {
      if (a.currency === home) return -1;
      if (b.currency === home) return 1;
    }
    return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;
  };
}

/** Owed (positive) or owing (negative) per other member, from the plan transfers that involve me. */
function withMe(myMemberId: string, transfers: readonly Transfer[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const tr of transfers) {
    if (tr.from === tr.to) continue;
    if (tr.to === myMemberId) out.set(tr.from, (out.get(tr.from) ?? 0) + tr.amount);
    else if (tr.from === myMemberId) out.set(tr.to, (out.get(tr.to) ?? 0) - tr.amount);
  }
  return out;
}

/** Per currency: owed = sum of my positive nets, owe = sum of my negative nets (as positive numbers). */
export function totalsOf(groups: readonly GroupListItemDTO[], home: string): MeDTO['totals'] {
  const sums = new Map<string, { owed: number; owe: number }>();
  for (const g of groups) {
    if (g.myNet === 0) continue;
    const s = sums.get(g.currency) ?? { owed: 0, owe: 0 };
    if (g.myNet > 0) s.owed += g.myNet;
    else s.owe -= g.myNet;
    sums.set(g.currency, s);
  }
  return [...sums].map(([currency, s]) => ({ currency, owed: s.owed, owe: s.owe })).sort(byHomeThenCode(home));
}

export function dashboardView(me: MeDTO, outbox: readonly OutboxItem[], cache: Readonly<Record<string, GroupEntry>>): DashboardView {
  const queued = outbox.filter(o => BALANCE_OPS.has(o.op));
  if (!queued.length) return { groups: me.groups, friends: me.friends, totals: me.totals, pendingCounted: 0, pendingUncounted: 0 };

  const perGroup = new Map<string, number>();
  for (const o of queued) perGroup.set(o.groupId, (perGroup.get(o.groupId) ?? 0) + 1);

  let counted = 0;
  let uncounted = 0;
  const adjusted = new Map<string, GroupListItemDTO>();
  for (const [gid, n] of perGroup) {
    const g = me.groups.find(x => x.id === gid);
    const snap = cache[gid]?.snap;
    if (!g || !snap || snap.group.version < g.version) {
      uncounted += n;
      continue;
    }
    const merged = applyOutbox(snap, outbox, me.user.id).snap;
    if (!merged) {
      uncounted += n;
      continue;
    }
    const s = summarize(merged);
    const mine = g.myMemberId;
    adjusted.set(gid, {
      ...g,
      myNet: s.net[mine] ?? 0,
      myTransfers: s.transfers.filter(tr => tr.from === mine || tr.to === mine),
      spent: s.spent,
      count: s.count,
      lastDate: s.lastDate,
    });
    counted += n;
  }
  if (!adjusted.size) return { groups: me.groups, friends: me.friends, totals: me.totals, pendingCounted: 0, pendingUncounted: uncounted };

  const groups = me.groups.map(g => adjusted.get(g.id) ?? g);
  const order = byHomeThenCode(me.user.currency);
  const friends = me.friends.map(f => {
    if (!f.groups.some(x => adjusted.has(x.groupId))) return f;
    const fg = f.groups.map(x => {
      const g = adjusted.get(x.groupId);
      return g ? { ...x, amount: withMe(g.myMemberId, g.myTransfers).get(x.memberId) ?? 0 } : x;
    });
    const sums = new Map<string, number>();
    for (const x of fg) sums.set(x.currency, (sums.get(x.currency) ?? 0) + x.amount);
    const balances = [...sums].filter(([, a]) => a !== 0).map(([currency, amount]) => ({ currency, amount })).sort(order);
    return { ...f, groups: fg, balances };
  });
  // Same order as the server: people with something to settle first (stable otherwise).
  const ranked = friends.map((f, i) => ({ f, i })).sort((a, b) => (a.f.balances.length ? 0 : 1) - (b.f.balances.length ? 0 : 1) || a.i - b.i);

  return {
    groups,
    friends: ranked.map(x => x.f),
    totals: totalsOf(groups, me.user.currency),
    pendingCounted: counted,
    pendingUncounted: uncounted,
  };
}

export interface ApproxTotal {
  /** Home currency. */
  currency: string;
  owed: number;
  owe: number;
  /** owed minus owe. */
  net: number;
  /** The date of the rates used. */
  date: string;
  /** Rates came from this device's cache (no connection). */
  stale: boolean;
  /** Currencies without a rate (left out of the sum). */
  missing: string[];
}

/**
 * My totals converted into my home currency, for a rough overall picture. Null when there is
 * nothing to convert (only the home currency) or no rates at all.
 */
export function approximateTotal(totals: MeDTO['totals'], home: string, fx: (FxRes & { stale?: boolean }) | null): ApproxTotal | null {
  if (!totals.length || !totals.some(x => x.currency !== home) || !fx) return null;
  let owed = 0;
  let owe = 0;
  const missing: string[] = [];
  let used = 0;
  for (const x of totals) {
    const rate = x.currency === home ? 1 : fx.rates[x.currency];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      missing.push(x.currency);
      continue;
    }
    owed += convertMinor(x.owed, x.currency, rate, home);
    owe += convertMinor(x.owe, x.currency, rate, home);
    used++;
  }
  if (!used || (used === 1 && totals.length === 1 && totals[0].currency === home)) return null;
  return { currency: home, owed, owe, net: owed - owe, date: fx.date, stale: !!fx.stale, missing };
}
