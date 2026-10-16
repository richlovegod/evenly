// Activity rows: what changed in a group, who did it, and (for expenses and payments) what it
// meant for each member's balance in the group currency at the time.

import { entryNet, type LedgerEntry } from '../../shared/balances';
import type { Portion } from '../../shared/split';
import { GROUP_TYPES, type ActivityData, type ActivityDTO, type ActivityType, type ExpenseKind, type GroupType } from '../../shared/types';
import { parseJSON, type ActivityRow } from '../db';
import { newId } from '../http';

/** Actor name for changes nobody made by hand (recurring copies) or whose author is unknown. */
export const SYSTEM_ACTOR_NAME = '系統';

export interface ActivityInput {
  groupId: string;
  /** Actor account, null for the system. */
  userId: string | null;
  /** Actor member in this group, null for the system. */
  memberId: string | null;
  type: ActivityType;
  expenseId?: string | null;
  data: ActivityData;
  now: string;
}

const INSERT_COLUMNS = 'INSERT INTO activity (id, group_id, user_id, member_id, type, expense_id, data, created_at)';

function activityValues(a: ActivityInput): unknown[] {
  return [newId(), a.groupId, a.userId, a.memberId, a.type, a.expenseId ?? null, JSON.stringify(a.data ?? {}), a.now];
}

/** INSERT statement for one activity row (use inside db.batch with the change it describes). */
export function activityStmt(db: D1Database, a: ActivityInput): D1PreparedStatement {
  return db.prepare(`${INSERT_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(...activityValues(a));
}

/**
 * Like activityStmt, but the row is only written when `condition` (an SQL expression, usually
 * EXISTS (...)) is true when the statement runs. Lets a batch log a change only if an earlier
 * conditional UPDATE in the same batch really happened.
 */
export function activityStmtWhere(db: D1Database, a: ActivityInput, condition: string, params: readonly unknown[]): D1PreparedStatement {
  return db
    .prepare(`${INSERT_COLUMNS} SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${condition}`)
    .bind(...activityValues(a), ...params);
}

/** The fields of an expense or payment that its activity row describes. */
export interface ActivityEntry {
  kind: string;
  description: string;
  amount: number;
  currency: string;
  fxRate: number;
  payers: readonly Portion[];
  shares: readonly Portion[];
}

/**
 * Activity data for an expense or payment: description, amount and currency as entered, plus each
 * involved member's effect in the group currency (positive = gets money back, 0 = involved but even).
 */
export function entryActivityData(e: ActivityEntry, groupCurrency: string): ActivityData {
  const kind: ExpenseKind = e.kind === 'payment' ? 'payment' : 'expense';
  const nets: Record<string, number> = {};
  try {
    const ledger: LedgerEntry = {
      id: '',
      kind,
      amount: e.amount,
      currency: e.currency,
      fxRate: e.fxRate,
      payers: e.payers.map(p => ({ memberId: p.memberId, amount: p.amount })),
      shares: e.shares.map(s => ({ memberId: s.memberId, amount: s.amount })),
    };
    for (const [memberId, v] of entryNet(ledger, groupCurrency)) nets[memberId] = v;
  } catch (err) {
    // Activity is informational: a bad rate must never block the write it describes.
    console.error('entryActivityData: could not compute nets', err);
  }
  return { kind, description: e.description, amount: e.amount, currency: e.currency, nets, groupCurrency };
}

/** An activity row joined with its group and the actor's display name (see activitySelect). */
export type ActivityJoinedRow = ActivityRow & {
  group_name: string;
  group_emoji: string;
  group_type: string;
  actor_name: string | null;
};

export function toActivityDTO(row: ActivityJoinedRow): ActivityDTO {
  const raw = parseJSON<unknown>(row.data, {});
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ActivityData) : {};
  const groupType = (GROUP_TYPES as readonly string[]).includes(row.group_type) ? (row.group_type as GroupType) : 'other';
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name ?? '',
    groupEmoji: row.group_emoji ?? '',
    groupType,
    userId: row.user_id,
    memberId: row.member_id,
    actorName: row.actor_name || SYSTEM_ACTOR_NAME,
    type: row.type as ActivityType,
    expenseId: row.expense_id,
    data,
    createdAt: row.created_at,
  };
}

/**
 * SELECT returning ActivityJoinedRow columns: `a` = activity, `g` = its group. The actor's name is
 * their member name in that group (by member_id, else by user_id), else their account name; null
 * (shown as 系統) for the system. Append conditions with `where` and ORDER BY / LIMIT with `tail`.
 */
export function activitySelect(where: string, tail = ''): string {
  return `SELECT a.id, a.group_id, a.user_id, a.member_id, a.type, a.expense_id, a.data, a.created_at,
            g.name AS group_name, g.emoji AS group_emoji, g.type AS group_type,
            COALESCE(am.name, um.name, u.name) AS actor_name
     FROM activity a
     JOIN groups g ON g.id = a.group_id
     LEFT JOIN members am ON am.id = a.member_id
     LEFT JOIN members um ON a.member_id IS NULL AND a.user_id IS NOT NULL AND um.group_id = a.group_id AND um.user_id = a.user_id
     LEFT JOIN users u ON u.id = a.user_id
     WHERE ${where}
     ${tail}`;
}
