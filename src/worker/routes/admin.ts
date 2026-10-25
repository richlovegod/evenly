// /api/admin: owner tools (emails in the OWNER_EMAILS secret). Everyone else gets 404.
// The user list and the detail of one account never return password hashes, session ids or
// tokens: only whether a password exists, and session labels and times.

import { Hono } from 'hono';
import { z } from 'zod';
import {
  GROUP_TYPES,
  type AdminSessionDTO, type AdminStatsDTO, type AdminUserGroupDTO, type AdminUserRes, type AdminUserRow, type AdminUsersRes,
  type GroupType,
} from '../../shared/types';
import { requireUser } from '../auth';
import { getUserByEmail, isOwnerEmail } from '../db';
import type { AppEnv } from '../env';
import { fail, json, nowISO, randomToken, readJson, sha256Hex } from '../http';
import { activitySelect, toActivityDTO, type ActivityJoinedRow } from '../services/activity';

export const adminRoutes = new Hono<AppEnv>();

const RESET_MINUTES = 30;
const DAY_MS = 86_400_000;

export const USERS_PAGE_DEFAULT = 50;
export const USERS_PAGE_MAX = 100;
const OFFSET_MAX = 1_000_000;
const QUERY_MAX = 100;
/** Device labels per account in the list. */
export const DEVICES_MAX = 5;
const DETAIL_ACTIVITY = 20;
const DETAIL_SESSIONS = 50;
const DETAIL_GROUPS = 200;

adminRoutes.use('*', requireUser);
adminRoutes.use('*', async (c, next) => {
  if (!c.get('user').isOwner) fail(404, 'not_found', 'Not found');
  await next();
});

// ---------- helpers (exported for tests) ----------

/** limit 1 to 100 (default 50) and offset 0 or more (default 0); anything that is not a number takes the default. */
export function parsePaging(limitRaw: string | undefined, offsetRaw: string | undefined): { limit: number; offset: number } {
  const l = Number.parseInt(limitRaw ?? '', 10);
  const o = Number.parseInt(offsetRaw ?? '', 10);
  return {
    limit: Number.isFinite(l) ? Math.min(USERS_PAGE_MAX, Math.max(1, l)) : USERS_PAGE_DEFAULT,
    offset: Number.isFinite(o) ? Math.min(OFFSET_MAX, Math.max(0, o)) : 0,
  };
}

/** The search text: trimmed, runs of spaces made one, at most 100 characters. */
export function cleanQuery(raw: string | undefined): string {
  return Array.from((raw ?? '').trim().replace(/\s+/g, ' ')).slice(0, QUERY_MAX).join('');
}

/** A LIKE pattern that finds `q` anywhere, with % _ and \ taken literally (use it with ESCAPE '\'). */
export function likePattern(q: string): string {
  return '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
}

/**
 * The WHERE clause (users aliased u) for a search: q anywhere in the name or the email. SQLite's
 * LIKE ignores case for A to Z; emails are stored in lowercase.
 */
export function userFilter(q: string): { where: string; params: string[] } {
  if (!q) return { where: '1 = 1', params: [] };
  const p = likePattern(q);
  return { where: "(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')", params: [p, p] };
}

/** A users row with the counts the list shows (see usersSql). */
export interface AdminUserSqlRow {
  id: string;
  name: string;
  email: string | null;
  has_pw: number;
  /** users.email_verified_at IS NOT NULL (the email was confirmed with a code). */
  email_ok: number;
  locale: string;
  currency: string;
  color: string;
  created_at: string;
  pay_info: string;
  venmo: string;
  paypal: string;
  last_active: string | null;
  live_sessions: number | null;
  group_count: number | null;
  entry_count: number | null;
  last_entry: string | null;
}

const count = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export function toAdminUserRow(r: AdminUserSqlRow, devices: readonly string[], isOwner: boolean): AdminUserRow {
  return {
    id: r.id,
    name: r.name,
    email: r.email ?? null,
    emailVerified: !!r.email && !!r.email_ok,
    hasPassword: !!r.has_pw,
    locale: r.locale === 'en' ? 'en' : 'zh-TW',
    currency: r.currency,
    color: r.color,
    createdAt: r.created_at,
    lastActiveAt: r.last_active ?? null,
    sessions: count(r.live_sessions),
    devices: devices.slice(0, DEVICES_MAX),
    groups: count(r.group_count),
    entries: count(r.entry_count),
    lastEntryAt: r.last_entry ?? null,
    isOwner,
  };
}

/**
 * Device labels per account: distinct, empty ones left out, most recently used first, at most
 * DEVICES_MAX. Rows are sessions (or per-label groups of them) with when each was last used.
 */
export function devicesByUser(rows: readonly { user_id: string; label: string | null; last_used: string | null }[]): Map<string, string[]> {
  const sorted = [...rows].sort((a, b) => {
    const at = a.last_used ?? '';
    const bt = b.last_used ?? '';
    return at === bt ? 0 : at < bt ? 1 : -1;
  });
  const out = new Map<string, string[]>();
  for (const r of sorted) {
    const label = (r.label ?? '').trim();
    if (!label) continue;
    const list = out.get(r.user_id) ?? [];
    if (list.length < DEVICES_MAX && !list.includes(label)) list.push(label);
    out.set(r.user_id, list);
  }
  return out;
}

export interface AdminStatsSqlRow {
  users: number;
  new_last7: number;
  active_last7: number;
  with_email: number;
  with_password: number;
  groups: number;
  entries: number;
}

/** Device-only now means no email: an email signs in anywhere with a code, a password or not. */
export function toAdminStats(r: Partial<AdminStatsSqlRow> | null | undefined): AdminStatsDTO {
  const users = count(r?.users);
  const withEmail = Math.min(users, count(r?.with_email));
  return {
    users,
    newLast7: count(r?.new_last7),
    activeLast7: count(r?.active_last7),
    withEmail,
    withPassword: Math.min(withEmail, count(r?.with_password)),
    deviceOnly: users - withEmail,
    groups: count(r?.groups),
    entries: count(r?.entries),
  };
}

export interface AdminGroupSqlRow {
  id: string;
  name: string;
  type: string;
  currency: string;
  emoji: string;
  color: string;
  deleted_at: string | null;
  role: string;
  active: number;
  member_count: number | null;
  entry_count: number | null;
  last_date: string | null;
}

export function toAdminUserGroup(r: AdminGroupSqlRow): AdminUserGroupDTO {
  return {
    id: r.id,
    name: r.name,
    type: (GROUP_TYPES as readonly string[]).includes(r.type) ? (r.type as GroupType) : 'other',
    currency: r.currency,
    emoji: r.emoji ?? '',
    color: r.color ?? '',
    memberCount: count(r.member_count),
    role: r.role === 'admin' ? 'admin' : 'member',
    active: !!r.active,
    entries: count(r.entry_count),
    lastDate: r.last_date ?? null,
    deleted: !!r.deleted_at,
  };
}

// ---------- SQL ----------

/**
 * One page of the users matching `where` (users aliased u), newest first, with: the latest
 * session use and the number of live sessions, active memberships in groups that are not
 * deleted, and live entries the account created (with the newest one's time). Binds the filter
 * parameters, then limit, offset, and now (ISO).
 */
function usersSql(where: string): string {
  return `WITH page AS (
      SELECT u.id, u.name, u.email, u.pw_hash IS NOT NULL AS has_pw, u.email_verified_at IS NOT NULL AS email_ok, u.locale, u.currency, u.color, u.created_at,
             u.pay_info, u.venmo, u.paypal
      FROM users u
      WHERE ${where}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ? OFFSET ?
    )
    SELECT p.*, s.last_active, s.live AS live_sessions, gm.n AS group_count, ex.n AS entry_count, ex.last_entry
    FROM page p
    LEFT JOIN (
      SELECT user_id, MAX(last_used_at) AS last_active, SUM(expires_at > ?) AS live
      FROM sessions WHERE user_id IN (SELECT id FROM page) GROUP BY user_id
    ) s ON s.user_id = p.id
    LEFT JOIN (
      SELECT m.user_id, COUNT(*) AS n
      FROM members m JOIN groups g ON g.id = m.group_id
      WHERE m.active = 1 AND g.deleted_at IS NULL AND m.user_id IN (SELECT id FROM page)
      GROUP BY m.user_id
    ) gm ON gm.user_id = p.id
    LEFT JOIN (
      SELECT e.created_by, COUNT(*) AS n, MAX(e.created_at) AS last_entry
      FROM expenses e JOIN groups g ON g.id = e.group_id
      WHERE e.deleted_at IS NULL AND g.deleted_at IS NULL AND e.created_by IN (SELECT id FROM page)
      GROUP BY e.created_by
    ) ex ON ex.created_by = p.id
    ORDER BY p.created_at DESC, p.id DESC`;
}

/** The labels of live sessions of the same page of users (same bindings as usersSql). */
function devicesSql(where: string): string {
  return `WITH page AS (
      SELECT u.id FROM users u WHERE ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?
    )
    SELECT user_id, label, MAX(last_used_at) AS last_used
    FROM sessions
    WHERE user_id IN (SELECT id FROM page) AND expires_at > ? AND label <> ''
    GROUP BY user_id, label`;
}

/** Site-wide counts. Binds one parameter: the start of the last 7 days (ISO). */
const STATS_SQL = `SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM users WHERE created_at >= ?1) AS new_last7,
    (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE last_used_at >= ?1) AS active_last7,
    (SELECT COUNT(*) FROM users WHERE email IS NOT NULL) AS with_email,
    (SELECT COUNT(*) FROM users WHERE email IS NOT NULL AND pw_hash IS NOT NULL) AS with_password,
    (SELECT COUNT(*) FROM groups WHERE deleted_at IS NULL) AS groups,
    (SELECT COUNT(*) FROM expenses e JOIN groups g ON g.id = e.group_id
      WHERE e.deleted_at IS NULL AND g.deleted_at IS NULL) AS entries`;

/** Every group the account has a member row in, with its size and entries. Binds the user id. */
const USER_GROUPS_SQL = `SELECT g.id, g.name, g.type, g.currency, g.emoji, g.color, g.deleted_at, m.role, m.active,
       mc.n AS member_count, ec.n AS entry_count, ec.last_date
    FROM members m
    JOIN groups g ON g.id = m.group_id
    LEFT JOIN (
      SELECT group_id, COUNT(*) AS n FROM members
      WHERE active = 1 AND group_id IN (SELECT group_id FROM members WHERE user_id = ?1)
      GROUP BY group_id
    ) mc ON mc.group_id = g.id
    LEFT JOIN (
      SELECT group_id, COUNT(*) AS n, MAX(date) AS last_date FROM expenses
      WHERE deleted_at IS NULL AND group_id IN (SELECT group_id FROM members WHERE user_id = ?1)
      GROUP BY group_id
    ) ec ON ec.group_id = g.id
    WHERE m.user_id = ?1
    ORDER BY g.deleted_at IS NOT NULL, m.active DESC, g.updated_at DESC, g.id
    LIMIT ${DETAIL_GROUPS}`;

// ---------- routes ----------

const resetLinkSchema = z.object({ email: z.string().trim().min(1).max(320) });

/** A one-time, 30-minute link that lets the person set a new password (no email is ever sent). */
adminRoutes.post('/reset-link', async c => {
  const db = c.env.DB;
  const { email } = await readJson(c, resetLinkSchema);
  const user = await getUserByEmail(db, email);
  if (!user) fail(404, 'not_found', 'No account uses this email');
  const token = randomToken(32);
  const now = nowISO();
  const expiresAt = new Date(Date.now() + RESET_MINUTES * 60_000).toISOString();
  await db.batch([
    // Only the newest link works.
    db.prepare("DELETE FROM login_codes WHERE user_id = ? AND kind = 'reset' AND used_at IS NULL").bind(user.id),
    db
      .prepare("INSERT INTO login_codes (id, user_id, kind, expires_at, used_at, created_at) VALUES (?, ?, 'reset', ?, NULL, ?)")
      .bind(await sha256Hex(token), user.id, expiresAt, now),
  ]);
  const appUrl = (c.env.APP_URL || '').replace(/\/*$/, '/');
  return json(c, { url: appUrl + '#/reset/' + token, expiresAt });
});

adminRoutes.get('/stats', async c => {
  const row = await c.env.DB
    .prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM groups WHERE deleted_at IS NULL) AS groups,
              (SELECT COUNT(*) FROM expenses WHERE deleted_at IS NULL) AS expenses`,
    )
    .first<{ users: number; groups: number; expenses: number }>();
  return json(c, { users: row?.users ?? 0, groups: row?.groups ?? 0, expenses: row?.expenses ?? 0 });
});

/** Who signed up: newest first, searchable by name or email, with the site-wide counts (one batch). */
adminRoutes.get('/users', async c => {
  const env = c.env;
  const db = env.DB;
  const q = cleanQuery(c.req.query('q'));
  const { limit, offset } = parsePaging(c.req.query('limit'), c.req.query('offset'));
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const since = new Date(nowMs - 7 * DAY_MS).toISOString();
  const f = userFilter(q);
  const [statsRes, totalRes, rowsRes, devicesRes] = await db.batch([
    db.prepare(STATS_SQL).bind(since),
    db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${f.where}`).bind(...f.params),
    db.prepare(usersSql(f.where)).bind(...f.params, limit, offset, now),
    db.prepare(devicesSql(f.where)).bind(...f.params, limit, offset, now),
  ]);
  const devices = devicesByUser((devicesRes.results ?? []) as { user_id: string; label: string; last_used: string }[]);
  const users = ((rowsRes.results ?? []) as AdminUserSqlRow[]).map(r => toAdminUserRow(r, devices.get(r.id) ?? [], isOwnerEmail(env, r.email)));
  const res: AdminUsersRes = {
    total: count((totalRes.results?.[0] as { n?: number } | undefined)?.n),
    users,
    stats: toAdminStats(statsRes.results?.[0] as Partial<AdminStatsSqlRow> | undefined),
  };
  return json(c, res);
});

/** One account: profile and payment details, its groups, live sessions and its latest activity (one batch). */
adminRoutes.get('/users/:id', async c => {
  const env = c.env;
  const db = env.DB;
  const id = c.req.param('id');
  if (!id || id.length > 100) fail(404, 'not_found', 'No such account');
  const now = nowISO();
  const [userRes, groupsRes, sessionsRes, activityRes] = await db.batch([
    db.prepare(usersSql('u.id = ?')).bind(id, 1, 0, now),
    db.prepare(USER_GROUPS_SQL).bind(id),
    db
      .prepare(
        `SELECT label, created_at, last_used_at, expires_at FROM sessions
         WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC, created_at DESC LIMIT ${DETAIL_SESSIONS}`,
      )
      .bind(id, now),
    db.prepare(activitySelect('a.user_id = ?', `ORDER BY a.created_at DESC, a.id DESC LIMIT ${DETAIL_ACTIVITY}`)).bind(id),
  ]);
  const row = userRes.results?.[0] as AdminUserSqlRow | undefined;
  if (!row) fail(404, 'not_found', 'No such account');
  const sessionRows = (sessionsRes.results ?? []) as { label: string; created_at: string; last_used_at: string; expires_at: string }[];
  const sessions: AdminSessionDTO[] = sessionRows.map(s => ({
    label: s.label ?? '',
    createdAt: s.created_at,
    lastUsedAt: s.last_used_at,
    expiresAt: s.expires_at,
  }));
  const devices = devicesByUser(sessionRows.map(s => ({ user_id: row.id, label: s.label, last_used: s.last_used_at }))).get(row.id) ?? [];
  const res: AdminUserRes = {
    user: {
      ...toAdminUserRow(row, devices, isOwnerEmail(env, row.email)),
      payInfo: row.pay_info ?? '',
      venmo: row.venmo ?? '',
      paypal: row.paypal ?? '',
    },
    groups: ((groupsRes.results ?? []) as AdminGroupSqlRow[]).map(toAdminUserGroup),
    sessions,
    activity: ((activityRes.results ?? []) as ActivityJoinedRow[]).map(toActivityDTO),
  };
  return json(c, res);
});
