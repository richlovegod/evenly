// D1 row types, row -> DTO mappers and the queries most routes need.

import { ledgerKind, type LedgerEntry } from '../shared/balances';
import type { Repeat } from '../shared/dates';
import { parseDefaultSplit } from '../shared/defaultSplit';
import { RECEIPT_PHOTOS_MAX } from '../shared/receipts';
import type { Portion, SplitInput } from '../shared/split';
import type {
  ExpenseDTO, ExpenseKind, GroupDTO, GroupSnapshotDTO, GroupType, Locale, MemberDTO, MemberRole, ReceiptDTO, UserDTO,
} from '../shared/types';
import { snapshotView } from './compat';
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
  /** When `email` was confirmed with a code, null until then (migration 0005). */
  email_verified_at: string | null;
  /** The linked Google account's id (the id_token's `sub`), null until a Google sign-in links one
   *  (migration 0007). Never sent to a client: the DTO says only `googleLinked`. */
  google_sub: string | null;
  /** The personal friend invite code, null until GET /api/me/invite makes one (migration 0008).
   *  Only its owner gets it back (routes/invites.ts); no DTO carries it. */
  invite_code: string | null;
  /** The linked Apple ID (the identity token's `sub`), null until a Sign in with Apple links one
   *  (migration 0013). Never sent to a client: the DTO says only `appleLinked`. */
  apple_sub: string | null;
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
  /** The default split as JSON (shared/defaultSplit.ts DefaultSplit), null for none (migration 0010). */
  default_split?: string | null;
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
  /** When this member's person archived the group, null while it is on their lists (migration 0009). */
  archived_at?: string | null;
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
  /** A refund started from an expense: that expense's id, else null (migration 0011). */
  refund_of?: string | null;
}

/**
 * A row of `receipts` (migration 0006): an expense's first photo; its bytes are in KV. The second
 * and third photos are rows of `receipt_extras` (migration 0016) with the same columns.
 */
export interface ReceiptRow {
  expense_id: string;
  group_id: string;
  kv_key: string;
  version: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  uploaded_by: string | null;
  created_at: string;
}

/**
 * The receipt columns an expense query adds with `LEFT JOIN receipts r ON r.expense_id = e.id`
 * (RECEIPT_COLUMNS): the first photo's, all null without one, and `r_extras`, the expense's
 * receipt_extras rows as a JSON array. toExpenseDTO reads them; a row without them (an
 * UPDATE ... RETURNING *, the recurring copies) has no photos.
 */
export interface ReceiptColumns {
  r_version?: string | null;
  r_mime?: string | null;
  r_width?: number | null;
  r_height?: number | null;
  r_bytes?: number | null;
  /** [{version, mime, width, height, bytes, at}] of receipt_extras, in no set order ('[]' for none). */
  r_extras?: string | null;
}

/**
 * Select list for ReceiptColumns, from a `receipts r` joined to the expense `e`: the first photo's
 * columns and one correlated subquery for the others (one probe of receipt_extras' primary key per
 * expense). Every query of the form `SELECT e.*, ${RECEIPT_COLUMNS} FROM expenses e LEFT JOIN
 * receipts r ON r.expense_id = e.id` carries every photo with it.
 */
export const RECEIPT_COLUMNS =
  'r.version AS r_version, r.mime AS r_mime, r.width AS r_width, r.height AS r_height, r.bytes AS r_bytes, ' +
  "(SELECT json_group_array(json_object('version', x.version, 'mime', x.mime, 'width', x.width, 'height', x.height, 'bytes', x.bytes, 'at', x.created_at)) " +
  'FROM receipt_extras x WHERE x.expense_id = e.id) AS r_extras';

export function toReceiptDTO(r: ReceiptColumns): ReceiptDTO | null {
  if (!r.r_version) return null;
  return { version: r.r_version, mime: r.r_mime ?? 'image/jpeg', width: r.r_width ?? 0, height: r.r_height ?? 0, bytes: r.r_bytes ?? 0 };
}

/** One stored photo with what orders it: when it was added (I1). */
export interface PhotoInOrder extends ReceiptDTO {
  at: string;
}

/**
 * Photos of receipt_extras in their order (I1): by when they were added, then by version. The
 * aggregate and UNION ALL leave the order to SQLite, so it is always settled here.
 */
export function inPhotoOrder<T extends { version: string; at: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

/** The receipt_extras photos in r_extras (null, '' or anything malformed: none; a malformed element is skipped). */
export function extrasOf(raw: string | null | undefined): PhotoInOrder[] {
  const list = parseJSON<unknown>(raw, []);
  if (!Array.isArray(list)) return [];
  const out: PhotoInOrder[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const p = x as Record<string, unknown>;
    const ok = typeof p.version === 'string' && p.version !== '' && typeof p.mime === 'string' && typeof p.at === 'string' &&
      typeof p.width === 'number' && typeof p.height === 'number' && typeof p.bytes === 'number';
    if (ok) out.push({ version: p.version as string, mime: p.mime as string, width: p.width as number, height: p.height as number, bytes: p.bytes as number, at: p.at as string });
  }
  return inPhotoOrder(out);
}

/**
 * An expense's photos, first to last (I1, I3, I5): the first photo, then the others in order
 * without the first one's version, at most RECEIPT_PHOTOS_MAX; with no first photo (a rollback's
 * old DELETE), the earliest other one is first. Five ReceiptDTO fields each.
 */
export function photoList(first: ReceiptDTO | null, extras: readonly ReceiptDTO[]): ReceiptDTO[] {
  const dto = (p: ReceiptDTO): ReceiptDTO => ({ version: p.version, mime: p.mime, width: p.width, height: p.height, bytes: p.bytes });
  const seen = new Set<string>();
  const out: ReceiptDTO[] = [];
  for (const p of first ? [first, ...extras] : extras) {
    if (seen.has(p.version)) continue;
    seen.add(p.version);
    out.push(dto(p));
  }
  return out.slice(0, RECEIPT_PHOTOS_MAX);
}

/** The photos of a row read with RECEIPT_COLUMNS (none for a row without them). */
export function receiptsOf(r: ReceiptColumns): ReceiptDTO[] {
  return photoList(toReceiptDTO(r), extrasOf(r.r_extras));
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
    // An email set before email codes (signup and POST /me/credentials took one without a code) is
    // not confirmed until a code for it is.
    emailVerified: !!r.email && !!r.email_verified_at,
    hasPassword: !!r.pw_hash,
    googleLinked: !!r.google_sub,
    appleLinked: !!r.apple_sub,
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
    defaultSplit: parseDefaultSplit(r.default_split),
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

export function toExpenseDTO(r: ExpenseRow & ReceiptColumns, commentCount = 0): ExpenseDTO {
  const receipts = receiptsOf(r);
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
    refundOf: r.refund_of ?? null,
    receipt: receipts[0] ?? null,
    receipts,
  };
}

export function toLedgerEntry(r: ExpenseRow): LedgerEntry {
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

// ---------- queries ----------

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email.trim().toLowerCase()).first<UserRow>();
}

/** The account a Google account is linked to (users.google_sub, unique). */
export async function getUserByGoogleSub(db: D1Database, sub: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(sub).first<UserRow>();
}

/** The account an Apple ID is linked to (users.apple_sub, unique). */
export async function getUserByAppleSub(db: D1Database, sub: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE apple_sub = ?').bind(sub).first<UserRow>();
}

/** D1 reports e.g. "UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT". */
export function isUniqueViolation(err: unknown, column: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('UNIQUE constraint failed') && msg.includes(column);
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
    default_split: r.default_split ?? null,
  };
  return { group, member };
}

/** A group's entries with their receipt photos' metadata (ReceiptColumns), newest date first. */
export async function getExpenseRows(db: D1Database, gid: string): Promise<(ExpenseRow & ReceiptColumns)[]> {
  const r = await db
    .prepare(
      `SELECT e.*, ${RECEIPT_COLUMNS} FROM expenses e LEFT JOIN receipts r ON r.expense_id = e.id
       WHERE e.group_id = ? ORDER BY e.date DESC, e.created_at DESC`,
    )
    .bind(gid)
    .all<ExpenseRow & ReceiptColumns>();
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

/**
 * Everything the group page needs, for a caller who is a member. `refunds`: the caller's client
 * knows refunds (compat.ts knowsRefunds); without it each refund comes as its expense.
 */
export async function loadSnapshot(db: D1Database, group: GroupRow, me: MemberRow, refunds: boolean): Promise<GroupSnapshotDTO> {
  const [members, rows, counts] = await Promise.all([
    getMembers(db, group.id),
    getExpenseRows(db, group.id),
    getCommentCounts(db, group.id),
  ]);
  return snapshotView(
    {
      group: toGroupDTO(group),
      members: members.map(toMemberDTO),
      expenses: rows.map(r => toExpenseDTO(r, counts[r.id] ?? 0)),
      me: { memberId: me.id, role: (me.role === 'admin' ? 'admin' : 'member') as MemberRole },
      inviteCode: group.invite_code,
    },
    refunds,
  );
}

/** Statement that bumps a group's version and returns the new value (use inside db.batch). */
export function bumpVersionStmt(db: D1Database, gid: string, now: string): D1PreparedStatement {
  return db.prepare('UPDATE groups SET version = version + 1, updated_at = ? WHERE id = ? RETURNING version').bind(now, gid);
}

/**
 * Statement that puts the group back on the lists of every member who archived it, except
 * `authorMemberId` (the person who wrote the entry; null for the system): a new entry by someone
 * else can be a new debt, which must never be hidden (docs/SPEC.md section 4, Archive).
 */
export function unarchiveStmt(db: D1Database, gid: string, authorMemberId: string | null): D1PreparedStatement {
  return db
    .prepare('UPDATE members SET archived_at = NULL WHERE group_id = ? AND archived_at IS NOT NULL AND id <> ?')
    .bind(gid, authorMemberId ?? '');
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
