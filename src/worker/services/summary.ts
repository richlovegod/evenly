// Group summaries: the numbers dashboards need (net per member, settle-up plan, totals), computed
// with shared/summary.ts and cached in groups.summary, tagged with the group version they were
// computed for. Also the pure dashboard math that GET /api/me builds from those summaries.

import { ledgerKind, toBase, type LedgerEntry } from '../../shared/balances';
import type { Transfer } from '../../shared/settle';
import type { Portion } from '../../shared/split';
import { computeGroupSummary, SUMMARY_VERSION, type GroupSummary } from '../../shared/summary';
import type { FriendDTO, GroupListItemDTO, GroupType, MeDTO } from '../../shared/types';
import { parseJSON, type GroupRow } from '../db';

/** D1 allows 100 bound parameters per statement; IN lists stay at or below this many ids. */
export const MAX_IN = 90;

/** At most this many recomputed summaries are written back per call (bounds D1 queries per request). */
const MAX_WRITES_PER_CALL = 25;

export function chunk<T>(list: readonly T[], size = MAX_IN): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** "?, ?, ?" for an IN list. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

// ---------- computing and storing ----------

interface LedgerRow {
  id: string;
  group_id: string;
  kind: string;
  amount: number;
  currency: string;
  fx_rate: number;
  payers: string;
  shares: string;
  category: string;
  date: string;
  deleted_at: string | null;
}

function toLedger(r: LedgerRow): LedgerEntry {
  return {
    id: r.id,
    kind: ledgerKind(r.kind),
    amount: r.amount,
    currency: r.currency,
    fxRate: r.fx_rate,
    payers: parseJSON<Portion[]>(r.payers, []),
    shares: parseJSON<Portion[]>(r.shares, []),
    category: r.category,
    date: r.date,
    deletedAt: r.deleted_at,
  };
}

function portionsAddUp(list: unknown, total: number): boolean {
  if (!Array.isArray(list) || list.length === 0) return false;
  let sum = 0;
  for (const p of list as Portion[]) {
    if (!p || typeof p.memberId !== 'string' || !Number.isSafeInteger(p.amount)) return false;
    sum += p.amount;
  }
  return sum === total;
}

/**
 * Entries the balance math can use: payers and shares that add up to the amount and a usable
 * exchange rate. The Worker validates every write, so this only drops corrupt rows (and logs
 * them) instead of letting one bad row break a whole group's balances.
 */
export function usableEntries(entries: readonly LedgerEntry[], base: string, groupId = ''): LedgerEntry[] {
  return entries.filter(e => {
    let ok = Number.isSafeInteger(e.amount) && e.amount > 0 && portionsAddUp(e.payers, e.amount) && portionsAddUp(e.shares, e.amount);
    if (ok) {
      try {
        toBase(e, base);
      } catch {
        ok = false;
      }
    }
    if (!ok) console.error(`summary: skipping entry ${e.id} in group ${groupId}: amounts or rate are not consistent`);
    return ok;
  });
}

export function summaryFor(group: GroupRow, memberOrder: readonly string[], entries: readonly LedgerEntry[]): GroupSummary {
  return computeGroupSummary({
    currency: group.currency,
    simplify: !!group.simplify,
    memberOrder,
    entries: usableEntries(entries, group.currency, group.id),
    forVersion: group.version,
  });
}

/** The stored summary when it is current for this group row (math version, group version, currency), else null. */
export function storedSummary(group: Pick<GroupRow, 'summary' | 'version' | 'currency'>): GroupSummary | null {
  const s = parseJSON<GroupSummary | null>(group.summary, null);
  if (!s || typeof s !== 'object') return null;
  if (s.v !== SUMMARY_VERSION || s.forVersion !== group.version || s.currency !== group.currency) return null;
  if (!s.net || typeof s.net !== 'object' || !Array.isArray(s.transfers)) return null;
  return s;
}

function emptySummary(group: GroupRow): GroupSummary {
  return summaryFor(group, [], []);
}

/**
 * Read the group rows, members and live entries of these groups in one D1 batch per 90 ids (one
 * transaction, so the data matches the version it is tagged with) and compute their summaries.
 * Soft-deleted groups are included.
 */
async function computeMany(db: D1Database, ids: readonly string[]): Promise<Map<string, { group: GroupRow; summary: GroupSummary }>> {
  const out = new Map<string, { group: GroupRow; summary: GroupSummary }>();
  for (const part of chunk([...new Set(ids)])) {
    const ph = placeholders(part.length);
    const [gRes, mRes, eRes] = await db.batch([
      db.prepare(`SELECT * FROM groups WHERE id IN (${ph})`).bind(...part),
      db.prepare(`SELECT id, group_id FROM members WHERE group_id IN (${ph}) ORDER BY sort, created_at, id`).bind(...part),
      db
        .prepare(
          `SELECT id, group_id, kind, amount, currency, fx_rate, payers, shares, category, date, deleted_at
           FROM expenses WHERE group_id IN (${ph}) AND deleted_at IS NULL`,
        )
        .bind(...part),
    ]);
    const order = new Map<string, string[]>();
    for (const m of (mRes.results ?? []) as { id: string; group_id: string }[]) {
      const list = order.get(m.group_id);
      if (list) list.push(m.id);
      else order.set(m.group_id, [m.id]);
    }
    const entries = new Map<string, LedgerEntry[]>();
    for (const r of (eRes.results ?? []) as LedgerRow[]) {
      const list = entries.get(r.group_id);
      if (list) list.push(toLedger(r));
      else entries.set(r.group_id, [toLedger(r)]);
    }
    for (const g of (gRes.results ?? []) as GroupRow[]) {
      out.set(g.id, { group: g, summary: summaryFor(g, order.get(g.id) ?? [], entries.get(g.id) ?? []) });
    }
  }
  return out;
}

function storeStmt(db: D1Database, group: GroupRow, s: GroupSummary): D1PreparedStatement {
  // Guarded by the version it was computed for: a write that raced ahead makes this a no-op.
  return db.prepare('UPDATE groups SET summary = ? WHERE id = ? AND version = ?').bind(JSON.stringify(s), group.id, group.version);
}

/**
 * Recompute and store a group's summary (call after every change, once the version was bumped).
 * Returns null when the group does not exist or is deleted, or when the refresh failed: the write
 * it follows already succeeded, and a stale summary is recomputed on the next read.
 */
export async function refreshSummary(db: D1Database, groupId: string): Promise<GroupSummary | null> {
  try {
    const hit = (await computeMany(db, [groupId])).get(groupId);
    if (!hit || hit.group.deleted_at) return null;
    await storeStmt(db, hit.group, hit.summary).run();
    return hit.summary;
  } catch (err) {
    console.error('refreshSummary failed for group', groupId, err);
    return null;
  }
}

/** Current summaries for many groups: stored ones when current, the rest recomputed in bulk and written back. */
export async function ensureSummaries(db: D1Database, groups: readonly GroupRow[]): Promise<Map<string, GroupSummary>> {
  const out = new Map<string, GroupSummary>();
  const stale: GroupRow[] = [];
  for (const g of groups) {
    const s = storedSummary(g);
    if (s) out.set(g.id, s);
    else stale.push(g);
  }
  if (!stale.length) return out;
  const fresh = await computeMany(db, stale.map(g => g.id));
  const writes: D1PreparedStatement[] = [];
  for (const g of stale) {
    const hit = fresh.get(g.id);
    out.set(g.id, hit ? hit.summary : emptySummary(g));
    if (hit && !hit.group.deleted_at && writes.length < MAX_WRITES_PER_CALL) writes.push(storeStmt(db, hit.group, hit.summary));
  }
  if (writes.length) {
    try {
      await db.batch(writes);
    } catch (err) {
      console.error('ensureSummaries: could not store summaries', err);
    }
  }
  return out;
}

/** The group's current summary: the stored one if it matches the group's version, else recomputed and stored. */
export async function ensureSummary(db: D1Database, group: GroupRow): Promise<GroupSummary> {
  return (await ensureSummaries(db, [group])).get(group.id) ?? emptySummary(group);
}

/** SET clause of a version bump that keeps a current stored summary current (balances unchanged). */
const TOUCH_SET = `version = version + 1,
           summary = CASE
             WHEN summary IS NOT NULL AND json_valid(summary) AND json_extract(summary, '$.forVersion') = version
             THEN json_set(summary, '$.forVersion', version + 1)
             ELSE summary END`;

/**
 * Statements that bump these groups' versions (so cached snapshots refresh) for changes that do not
 * touch balances, such as names or account links. A stored summary that was current stays current.
 */
export function touchGroupsStmts(db: D1Database, groupIds: readonly string[]): D1PreparedStatement[] {
  return chunk([...new Set(groupIds)]).map(part =>
    db.prepare(`UPDATE groups SET ${TOUCH_SET} WHERE id IN (${placeholders(part.length)})`).bind(...part),
  );
}

/**
 * touchGroupsStmts for every live group in which this account has a member row, active or not
 * (getMembers lists members who left too, with the account's payment details). One statement,
 * so it can share a batch with the change that makes it necessary.
 */
export function touchUserGroupsStmt(db: D1Database, userId: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE groups SET ${TOUCH_SET} WHERE deleted_at IS NULL AND id IN (SELECT group_id FROM members WHERE user_id = ?)`)
    .bind(userId);
}

// ---------- dashboard (pure) ----------

export interface DashMember {
  id: string;
  userId: string | null;
  name: string;
  color: string;
  active: boolean;
  /** The linked account's photo version, null for a placeholder (missing counts as null). */
  avatar?: string | null;
}

/** Account details of a linked member, for the Friends list and settling up. */
export interface DashPerson {
  name: string;
  color: string;
  payInfo: string;
  venmo: string;
  paypal: string;
  /** The account's photo version (missing counts as null). */
  avatar?: string | null;
}

export interface DashGroup {
  group: { id: string; name: string; type: GroupType; currency: string; emoji: string; color: string; version: number; updatedAt: string };
  myMemberId: string;
  summary: GroupSummary;
  /** Every member of the group (active or not) in display order. */
  members: readonly DashMember[];
  /** I archived the group (members.archived_at): off my lists, its money still counts. */
  archived?: boolean;
}

export interface Dashboard {
  groups: GroupListItemDTO[];
  friends: FriendDTO[];
  totals: MeDTO['totals'];
}

interface FriendAcc {
  dto: FriendDTO;
  sums: Map<string, number>;
  pairUpdatedAt: string;
  lastUpdated: string;
}

/** What each other member owes me (positive) or I owe them (negative) in one group's settle-up plan. */
export function balancesWithMe(myMemberId: string, transfers: readonly Transfer[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of transfers) {
    if (t.from === t.to) continue;
    if (t.to === myMemberId) out.set(t.from, (out.get(t.from) ?? 0) + t.amount);
    else if (t.from === myMemberId) out.set(t.to, (out.get(t.to) ?? 0) - t.amount);
  }
  return out;
}

function byHomeThenCode(home: string | undefined) {
  return (a: { currency: string }, b: { currency: string }) => {
    if (home && a.currency !== b.currency) {
      if (a.currency === home) return -1;
      if (b.currency === home) return 1;
    }
    return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;
  };
}

/**
 * GET /api/me without the I/O: one list item per group (newest change first), friends aggregated
 * per person from each group's settle-up plan, and my totals per currency.
 *  - A friend's amount in a group is the sum of the plan's transfers between them and me
 *    (positive = they owe me), so per group the friends add up to my net there.
 *  - People with an account are one friend across groups ('u:<userId>'); placeholders are one
 *    friend per group ('m:<memberId>'). Everyone I share a group with is listed, also at zero;
 *    members who left are listed only while a transfer still involves them.
 *  - balances keep only non-zero currencies; groups lists every shared group, also at zero.
 *  - totals: per currency, owed = sum of my positive nets, owe = sum of my negative nets (as positive numbers).
 *  - An archived group is in all of these like any other (its money is never hidden); only its
 *    list item says `archived`.
 */
export function buildDashboard(args: {
  userId: string;
  homeCurrency?: string;
  groups: readonly DashGroup[];
  people: Readonly<Record<string, DashPerson>>;
}): Dashboard {
  const { userId, homeCurrency, people } = args;
  const sorted = [...args.groups].sort((a, b) =>
    a.group.updatedAt < b.group.updatedAt ? 1 : a.group.updatedAt > b.group.updatedAt ? -1 : a.group.id < b.group.id ? -1 : 1,
  );

  const items: GroupListItemDTO[] = [];
  const totals = new Map<string, { owed: number; owe: number }>();
  const friends = new Map<string, FriendAcc>();

  for (const g of sorted) {
    const me = g.myMemberId;
    const s = g.summary;
    const cur = g.group.currency;
    const myNet = s.net[me] ?? 0;
    const myTransfers = s.transfers.filter(t => t.from === me || t.to === me);
    items.push({
      id: g.group.id,
      name: g.group.name,
      type: g.group.type,
      currency: cur,
      emoji: g.group.emoji,
      color: g.group.color,
      version: g.group.version,
      updatedAt: g.group.updatedAt,
      myMemberId: me,
      myNet,
      myTransfers,
      spent: s.spent,
      count: s.count,
      lastDate: s.lastDate,
      members: g.members.map(m => ({ id: m.id, name: m.name, color: m.color, userId: m.userId, active: m.active, avatar: m.userId ? m.avatar ?? null : null })),
      archived: !!g.archived,
    });
    if (myNet !== 0) {
      const t = totals.get(cur) ?? { owed: 0, owe: 0 };
      if (myNet > 0) t.owed += myNet;
      else t.owe -= myNet;
      totals.set(cur, t);
    }

    const withMe = balancesWithMe(me, myTransfers);
    const activeCount = g.members.filter(m => m.active).length;
    const isPair = g.group.type === 'pair' && activeCount <= 2;
    for (const m of g.members) {
      if (m.id === me || (m.userId !== null && m.userId === userId)) continue;
      const amount = withMe.get(m.id) ?? 0;
      if (!m.active && amount === 0) continue;
      const key = m.userId ? 'u:' + m.userId : 'm:' + m.id;
      let f = friends.get(key);
      if (!f) {
        const p = m.userId ? people[m.userId] : undefined;
        f = {
          dto: {
            key,
            userId: m.userId,
            name: p?.name || m.name,
            color: p?.color || m.color,
            balances: [],
            groups: [],
            pairGroupId: null,
            payInfo: p?.payInfo ?? '',
            venmo: p?.venmo ?? '',
            paypal: p?.paypal ?? '',
            avatar: p?.avatar ?? null,
          },
          sums: new Map(),
          pairUpdatedAt: '',
          lastUpdated: '',
        };
        friends.set(key, f);
      }
      f.dto.groups.push({ groupId: g.group.id, memberId: m.id, currency: cur, amount });
      f.sums.set(cur, (f.sums.get(cur) ?? 0) + amount);
      if (isPair && m.active && (!f.dto.pairGroupId || g.group.updatedAt > f.pairUpdatedAt)) {
        f.dto.pairGroupId = g.group.id;
        f.pairUpdatedAt = g.group.updatedAt;
      }
      if (g.group.updatedAt > f.lastUpdated) f.lastUpdated = g.group.updatedAt;
    }
  }

  const order = byHomeThenCode(homeCurrency);
  const accs = [...friends.values()];
  for (const f of accs) {
    f.dto.balances = [...f.sums]
      .filter(([, amount]) => amount !== 0)
      .map(([currency, amount]) => ({ currency, amount }))
      .sort(order);
  }
  accs.sort((a, b) => {
    const za = a.dto.balances.length === 0 ? 1 : 0;
    const zb = b.dto.balances.length === 0 ? 1 : 0;
    if (za !== zb) return za - zb;
    if (a.lastUpdated !== b.lastUpdated) return a.lastUpdated < b.lastUpdated ? 1 : -1;
    return a.dto.name.localeCompare(b.dto.name) || (a.dto.key < b.dto.key ? -1 : 1);
  });

  return {
    groups: items,
    friends: accs.map(f => f.dto),
    totals: [...totals].map(([currency, t]) => ({ currency, owed: t.owed, owe: t.owe })).sort(order),
  };
}
