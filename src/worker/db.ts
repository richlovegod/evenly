// D1 row types, row -> DTO mappers and the queries most routes need.

import type { LedgerEntry } from '../shared/balances';
import type { Repeat } from '../shared/dates';
import type { Portion, SplitInput } from '../shared/split';
import type {
  ExpenseDTO, ExpenseKind, GroupDTO, GroupSnapshotDTO, GroupType, Locale, MemberDTO, MemberRole, UserDTO,
} from '../shared/types';
import { notFound } from './http';

export interface UserRow {
  id: string;
  name: string;
  email: string | null;
  pw_hash: string | null;
  locale: string;
  currency: string;
  color: string;
  pay_info: string;
  venmo: string;
  paypal: string;
  activity_seen_at: string | null;
  created_at: string;
  updated_at: string;
  /** The profile photo's version (avatars.version), null without one (migration 0004). */
  avatar: string | null;
}

export interface GroupRow {
  id: string;
  name: string;
  type: string;
  currency: string;
  emoji: string;
  color: string;
  simplify: number;
  notes: string;
  invite_code: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  summary: string | null;
}

export interface MemberRow {
  id: string;
  group_id: string;
  user_id: string | null;
  name: string;
  color: string;
  role: string;
  active: number;
  sort: number;
  created_at: string;
  claimed_at: string | null;
}

/** Member joined with the linked user's payment details and photo version (LEFT JOIN users). */
export interface MemberWithUserRow extends MemberRow {
  u_pay_info: string | null;
  u_venmo: string | null;
  u_paypal: string | null;
  u_avatar: string | null;
}

export interface ExpenseRow {
  id: string;
  group_id: string;
  kind: string;
  description: string;
  category: string;
  amount: number;
  currency: string;
  fx_rate: number;
  date: string;
  notes: string;
  payers: string;
  split: string;
  shares: string;
  repeat: string;
  repeat_series: string | null;
  repeat_start: string | null;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  version: number;
}

export interface CommentRow {
  id: string;
  group_id: string;
  expense_id: string;
  user_id: string;
  member_id: string | null;
  body: string;
  created_at: string;
  deleted_at: string | null;
}

export interface ActivityRow {
  id: string;
  group_id: string;
  user_id: string | null;
  member_id: string | null;
  type: string;
  expense_id: string | null;
  data: string;
  created_at: string;
}

export function parseJSON<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function toUserDTO(r: UserRow, isAdmin: boolean): UserDTO {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    hasPassword: !!r.pw_hash,
    locale: (r.locale === 'en' ? 'en' : 'zh-TW') as Locale,
    currency: r.currency,
    color: r.color,
    payInfo: r.pay_info,
    venmo: r.venmo,
    paypal: r.paypal,
    isAdmin,
    createdAt: r.created_at,
    avatar: r.avatar ?? null,
  };
}

export function toGroupDTO(r: GroupRow): GroupDTO {
  return {
    id: r.id,
    name: r.name,
    type: r.type as GroupType,
    currency: r.currency,
    emoji: r.emoji,
    color: r.color,
    simplify: !!r.simplify,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

export function toMemberDTO(r: MemberWithUserRow | MemberRow): MemberDTO {
  const u = r as MemberWithUserRow;
  return {
    id: r.id,
    groupId: r.group_id,
    userId: r.user_id,
    name: r.name,
    color: r.color,
    role: (r.role === 'admin' ? 'admin' : 'member') as MemberRole,
    active: !!r.active,
    sort: r.sort,
    createdAt: r.created_at,
    claimedAt: r.claimed_at,
    payInfo: u.u_pay_info ?? '',
    venmo: u.u_venmo ?? '',
    paypal: u.u_paypal ?? '',
    // A placeholder never has a photo.
    avatar: r.user_id ? u.u_avatar ?? null : null,
  };
}

export function toExpenseDTO(r: ExpenseRow, commentCount = 0): ExpenseDTO {
  return {
    id: r.id,
    groupId: r.group_id,
    kind: r.kind as ExpenseKind,
    description: r.description,
    category: r.category,
    amount: r.amount,
    currency: r.currency,
    fxRate: r.fx_rate,
    date: r.date,
    notes: r.notes,
    payers: parseJSON<Portion[]>(r.payers, []),
    split: parseJSON<SplitInput>(r.split, { method: 'equal', entries: [] }),
    shares: parseJSON<Portion[]>(r.shares, []),
    repeat: (r.repeat || 'none') as Repeat,
    repeatSeries: r.repeat_series,
    repeatStart: r.repeat_start,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    deletedBy: r.deleted_by,
    version: r.version,
    commentCount,
  };
}

export function toLedgerEntry(r: ExpenseRow): LedgerEntry {
  return {
    id: r.id,
    kind: r.kind as ExpenseKind,
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

// ---------- queries ----------

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email.trim().toLowerCase()).first<UserRow>();
}

/** A live (not deleted) group, or null. */
export async function getGroupRow(db: D1Database, gid: string): Promise<GroupRow | null> {
  return db.prepare('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL').bind(gid).first<GroupRow>();
}

export async function getMembers(db: D1Database, gid: string): Promise<MemberWithUserRow[]> {
  const r = await db
    .prepare(
      `SELECT m.*, u.pay_info AS u_pay_info, u.venmo AS u_venmo, u.paypal AS u_paypal, u.avatar AS u_avatar
       FROM members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ? ORDER BY m.sort, m.created_at`,
    )
    .bind(gid)
    .all<MemberWithUserRow>();
  return r.results ?? [];
}

/** The caller's active member row in a group, or null. */
export async function getMyMember(db: D1Database, gid: string, userId: string): Promise<MemberRow | null> {
  return db
    .prepare('SELECT * FROM members WHERE group_id = ? AND user_id = ? AND active = 1')
    .bind(gid, userId)
    .first<MemberRow>();
}

/** Group + the caller's member row; 404 when the group does not exist or the caller is not an active member. */
export async function requireMember(db: D1Database, gid: string, userId: string): Promise<{ group: GroupRow; member: MemberRow }> {
  const row = await db
    .prepare(
      `SELECT g.*, m.id AS m_id, m.role AS m_role, m.name AS m_name, m.color AS m_color, m.sort AS m_sort,
              m.created_at AS m_created_at, m.claimed_at AS m_claimed_at
       FROM groups g JOIN members m ON m.group_id = g.id
       WHERE g.id = ? AND g.deleted_at IS NULL AND m.user_id = ? AND m.active = 1`,
    )
    .bind(gid, userId)
    .first<GroupRow & { m_id: string; m_role: string; m_name: string; m_color: string; m_sort: number; m_created_at: string; m_claimed_at: string | null }>();
  if (!row) notFound('Group not found');
  const r = row!;
  const member: MemberRow = {
    id: r.m_id, group_id: r.id, user_id: userId, name: r.m_name, color: r.m_color, role: r.m_role,
    active: 1, sort: r.m_sort, created_at: r.m_created_at, claimed_at: r.m_claimed_at,
  };
  const group: GroupRow = {
    id: r.id, name: r.name, type: r.type, currency: r.currency, emoji: r.emoji, color: r.color, simplify: r.simplify,
    notes: r.notes, invite_code: r.invite_code, created_by: r.created_by, created_at: r.created_at,
    updated_at: r.updated_at, deleted_at: r.deleted_at, version: r.version, summary: r.summary,
  };
  return { group, member };
}

export async function getExpenseRows(db: D1Database, gid: string): Promise<ExpenseRow[]> {
  const r = await db
    .prepare('SELECT * FROM expenses WHERE group_id = ? ORDER BY date DESC, created_at DESC')
    .bind(gid)
    .all<ExpenseRow>();
  return r.results ?? [];
}

export async function getExpenseRow(db: D1Database, gid: string, eid: string): Promise<ExpenseRow | null> {
  return db.prepare('SELECT * FROM expenses WHERE id = ? AND group_id = ?').bind(eid, gid).first<ExpenseRow>();
}

export async function getCommentCounts(db: D1Database, gid: string): Promise<Record<string, number>> {
  const r = await db
    .prepare('SELECT expense_id, COUNT(*) AS n FROM comments WHERE group_id = ? AND deleted_at IS NULL GROUP BY expense_id')
    .bind(gid)
    .all<{ expense_id: string; n: number }>();
  const out: Record<string, number> = {};
  for (const x of r.results ?? []) out[x.expense_id] = x.n;
  return out;
}

/** Everything the group page needs, for a caller who is a member. */
export async function loadSnapshot(db: D1Database, group: GroupRow, me: MemberRow): Promise<GroupSnapshotDTO> {
  const [members, rows, counts] = await Promise.all([
    getMembers(db, group.id),
    getExpenseRows(db, group.id),
    getCommentCounts(db, group.id),
  ]);
  return {
    group: toGroupDTO(group),
    members: members.map(toMemberDTO),
    expenses: rows.map(r => toExpenseDTO(r, counts[r.id] ?? 0)),
    me: { memberId: me.id, role: (me.role === 'admin' ? 'admin' : 'member') as MemberRole },
    inviteCode: group.invite_code,
  };
}

/** Statement that bumps a group's version and returns the new value (use inside db.batch). */
export function bumpVersionStmt(db: D1Database, gid: string, now: string): D1PreparedStatement {
  return db.prepare('UPDATE groups SET version = version + 1, updated_at = ? WHERE id = ? RETURNING version').bind(now, gid);
}

/** Read the `version` column out of the batch result of bumpVersionStmt. */
export function versionFromBatch(results: D1Result[], index: number): number {
  const row = (results[index]?.results?.[0] ?? null) as { version?: number } | null;
  return row?.version ?? 0;
}

export function isOwnerEmail(env: { OWNER_EMAILS?: string }, email: string | null): boolean {
  if (!email) return false;
  const list = (env.OWNER_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}
