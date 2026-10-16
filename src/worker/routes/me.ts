// /api/me (dashboard, profile, sign-in details, account deletion, export) and /api/activity.

import { Hono } from 'hono';
import { z } from 'zod';
import type { GroupSnapshotDTO, GroupType, MeDTO } from '../../shared/types';
import { hashPassword, rateLimit, requireUser, validPassword, verifyPassword } from '../auth';
import {
  getUser, getUserByEmail, isOwnerEmail, toExpenseDTO, toGroupDTO, toMemberDTO, toUserDTO,
  type ExpenseRow, type GroupRow, type MemberWithUserRow, type UserRow,
} from '../db';
import type { AppEnv } from '../env';
import { fail, json, nowISO, readJson } from '../http';
import { activitySelect, activityStmt, toActivityDTO, type ActivityJoinedRow } from '../services/activity';
import {
  buildDashboard, ensureSummaries, touchGroupsStmts, touchUserGroupsStmt, type DashGroup, type DashMember, type DashPerson,
} from '../services/summary';

export const meRoutes = new Hono<AppEnv>();

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const HANDLE_RE = /^[A-Za-z0-9_.-]{0,50}$/;
const BEFORE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Groups I am an active member of (deleted groups excluded). Binds one parameter: my user id. */
const MY_GROUPS = `SELECT mg.group_id FROM members mg JOIN groups gg ON gg.id = mg.group_id
                   WHERE mg.user_id = ? AND mg.active = 1 AND gg.deleted_at IS NULL`;

const nullToEmpty = (v: unknown) => (v === null ? '' : v);

/** Account columns that every group snapshot shows on my members (db.ts toMemberDTO). */
const PAY_COLUMNS = ['pay_info', 'venmo', 'paypal'] as const;

/** A Venmo or PayPal.me username; pasted links and a leading "@" are reduced to the name. */
function handle(linkPrefix: RegExp) {
  return z.preprocess(
    nullToEmpty,
    z
      .string()
      .trim()
      .transform(s => s.replace(linkPrefix, '').replace(/[/?#].*$/, '').replace(/^@+/, ''))
      .pipe(z.string().regex(HANDLE_RE, 'Use at most 50 letters, digits, _ . or -')),
  );
}

const UpdateMeSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(60, 'At most 60 characters').optional(),
  locale: z.enum(['zh-TW', 'en']).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code').optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use #RRGGBB').optional(),
  payInfo: z.preprocess(nullToEmpty, z.string().trim().max(300, 'At most 300 characters')).optional(),
  venmo: handle(/^(https?:\/\/)?(www\.|account\.)?venmo\.com\/(u\/)?/i).optional(),
  paypal: handle(/^(https?:\/\/)?(www\.)?paypal\.me\//i).optional(),
});

const CredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().max(320),
  password: z.string().max(1000),
  currentPassword: z.union([z.string().max(1000), z.null()]).optional(),
});

const DeleteMeSchema = z.object({ password: z.union([z.string().max(1000), z.null()]).optional() });

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

async function currentUser(db: D1Database, id: string): Promise<UserRow> {
  return (await getUser(db, id)) ?? fail(401, 'unauthorized', 'Sign in first');
}

// ---------- dashboard ----------

type MyGroupRow = GroupRow & { my_member_id: string };

interface DashMemberRow extends MemberWithUserRow {
  u_name: string | null;
  u_color: string | null;
}

meRoutes.get('/me', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const [uRes, gRes, mRes, nRes] = await db.batch([
    db.prepare('SELECT * FROM users WHERE id = ?').bind(au.id),
    db
      .prepare(
        `SELECT g.*, m.id AS my_member_id FROM groups g JOIN members m ON m.group_id = g.id
         WHERE m.user_id = ? AND m.active = 1 AND g.deleted_at IS NULL`,
      )
      .bind(au.id),
    db
      .prepare(
        `SELECT m.*, u.name AS u_name, u.color AS u_color, u.pay_info AS u_pay_info, u.venmo AS u_venmo, u.paypal AS u_paypal
         FROM members m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.group_id IN (${MY_GROUPS})
         ORDER BY m.group_id, m.sort, m.created_at, m.id`,
      )
      .bind(au.id),
    // Unread: activity in my groups since I last opened the feed (or since I signed up), not by me.
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM activity a
           WHERE a.group_id IN (${MY_GROUPS})
             AND a.created_at > (SELECT COALESCE(activity_seen_at, created_at) FROM users WHERE id = ?)
             AND (a.user_id IS NULL OR a.user_id <> ?)
           LIMIT 1000
         )`,
      )
      .bind(au.id, au.id, au.id),
  ]);
  const user = (uRes.results?.[0] as UserRow | undefined) ?? fail(401, 'unauthorized', 'Sign in first');
  const rows = (gRes.results ?? []) as MyGroupRow[];
  const summaries = await ensureSummaries(db, rows);

  const members = new Map<string, DashMember[]>();
  const people: Record<string, DashPerson> = {};
  for (const m of (mRes.results ?? []) as DashMemberRow[]) {
    const dm: DashMember = { id: m.id, userId: m.user_id, name: m.name, color: m.color, active: !!m.active };
    const list = members.get(m.group_id);
    if (list) list.push(dm);
    else members.set(m.group_id, [dm]);
    if (m.user_id && m.u_name !== null && !people[m.user_id]) {
      people[m.user_id] = { name: m.u_name, color: m.u_color || m.color, payInfo: m.u_pay_info ?? '', venmo: m.u_venmo ?? '', paypal: m.u_paypal ?? '' };
    }
  }

  const groups: DashGroup[] = [];
  for (const g of rows) {
    const summary = summaries.get(g.id);
    if (!summary) continue;
    groups.push({
      group: {
        id: g.id, name: g.name, type: g.type as GroupType, currency: g.currency, emoji: g.emoji, color: g.color,
        version: g.version, updatedAt: g.updated_at,
      },
      myMemberId: g.my_member_id,
      summary,
      members: members.get(g.id) ?? [],
    });
  }
  const dash = buildDashboard({ userId: user.id, homeCurrency: user.currency, groups, people });
  const unread = (nRes.results?.[0] as { n: number } | undefined)?.n ?? 0;
  const me: MeDTO = {
    user: toUserDTO(user, isOwnerEmail(c.env, user.email)),
    groups: dash.groups,
    friends: dash.friends,
    totals: dash.totals,
    unread,
    serverTime: nowISO(),
  };
  return json(c, me);
});

// ---------- profile and sign-in ----------

meRoutes.patch('/me', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const body = await readJson(c, UpdateMeSchema);
  const user = await currentUser(db, au.id);

  const next: UserRow = { ...user };
  const cols: [string, string][] = [];
  const set = (column: 'name' | 'locale' | 'currency' | 'color' | 'pay_info' | 'venmo' | 'paypal', value: string | undefined) => {
    if (value === undefined || value === user[column]) return;
    cols.push([column, value]);
    next[column] = value;
  };
  set('name', body.name);
  set('locale', body.locale);
  set('currency', body.currency);
  set('color', body.color);
  set('pay_info', body.payInfo);
  set('venmo', body.venmo);
  set('paypal', body.paypal);

  if (cols.length) {
    next.updated_at = nowISO();
    const stmts: D1PreparedStatement[] = [
      db
        .prepare(`UPDATE users SET ${cols.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .bind(...cols.map(([, v]) => v), next.updated_at, au.id),
    ];
    const renamed = next.name !== user.name;
    if (renamed) {
      // Members still named after the old account name follow the new one; names changed in a group stay.
      stmts.push(db.prepare('UPDATE members SET name = ? WHERE user_id = ? AND name = ?').bind(next.name, au.id, user.name));
    }
    // Group snapshots carry member names and this account's payment details (db.ts toMemberDTO),
    // and devices keep a cached snapshot until the group version moves (the ETag): bump every
    // group I have a member row in, in the same batch, so no device caches the new version with
    // the old details (and the settle-up page never links to a Venmo account I replaced).
    if (renamed || PAY_COLUMNS.some(k => next[k] !== user[k])) stmts.push(touchUserGroupsStmt(db, au.id));
    await db.batch(stmts);
  }
  return json(c, { user: toUserDTO(next, isOwnerEmail(c.env, next.email)) });
});

meRoutes.post('/me/credentials', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const body = await readJson(c, CredentialsSchema);
  if (body.email.length > 120 || !EMAIL_RE.test(body.email)) {
    fail(400, 'validation', 'Enter a valid email address', [{ path: ['email'], message: 'Enter a valid email address (at most 120 characters)' }]);
  }
  if (!validPassword(body.password)) fail(400, 'weak_password', 'Use at least 8 characters for the password');
  await rateLimit(db, 'credentials:' + au.id, 10, 15 * 60);
  const user = await currentUser(db, au.id);
  if (user.pw_hash) {
    // 400, not 401: a 401 would sign this device out.
    const ok = !!body.currentPassword && (await verifyPassword(body.currentPassword, user.pw_hash));
    if (!ok) fail(400, 'invalid_credentials', 'The current password is not correct');
  }
  if (body.email !== user.email) {
    const taken = await getUserByEmail(db, body.email);
    if (taken && taken.id !== user.id) fail(409, 'email_taken', 'That email already has an account');
  }
  const pwHash = await hashPassword(body.password);
  const now = nowISO();
  try {
    await db.prepare('UPDATE users SET email = ?, pw_hash = ?, updated_at = ? WHERE id = ?').bind(body.email, pwHash, now, au.id).run();
  } catch (err) {
    if (isUniqueViolation(err)) fail(409, 'email_taken', 'That email already has an account');
    throw err;
  }
  const next: UserRow = { ...user, email: body.email, pw_hash: pwHash, updated_at: now };
  return json(c, { user: toUserDTO(next, isOwnerEmail(c.env, next.email)) });
});

/**
 * Delete my account. In every group where I am the only active admin with an account, the earliest
 * other active member with an account becomes admin first. My members stay as placeholders, so
 * groups keep their history.
 */
meRoutes.delete('/me', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const body = await readJson(c, DeleteMeSchema);
  const user = await currentUser(db, au.id);
  if (user.pw_hash) {
    await rateLimit(db, 'delete-account:' + au.id, 10, 15 * 60);
    const ok = !!body.password && (await verifyPassword(body.password, user.pw_hash));
    if (!ok) fail(400, 'invalid_credentials', 'The password is not correct');
  }

  const [mineRes, othersRes] = await db.batch([
    db.prepare('SELECT id, group_id, role, active FROM members WHERE user_id = ?').bind(au.id),
    db
      .prepare(
        `SELECT m.id, m.group_id, m.name, m.role FROM members m JOIN groups g ON g.id = m.group_id
         WHERE g.deleted_at IS NULL AND m.active = 1 AND m.user_id IS NOT NULL AND m.user_id <> ?
           AND m.group_id IN (SELECT group_id FROM members WHERE user_id = ? AND active = 1 AND role = 'admin')
         ORDER BY m.group_id, m.created_at, m.sort, m.id`,
      )
      .bind(au.id, au.id),
  ]);
  const mine = (mineRes.results ?? []) as { id: string; group_id: string; role: string; active: number }[];
  const others = new Map<string, { id: string; name: string; role: string }[]>();
  for (const o of (othersRes.results ?? []) as { id: string; group_id: string; name: string; role: string }[]) {
    const list = others.get(o.group_id);
    if (list) list.push(o);
    else others.set(o.group_id, [o]);
  }

  const now = nowISO();
  const stmts: D1PreparedStatement[] = [];
  for (const m of mine) {
    if (!m.active || m.role !== 'admin') continue;
    const candidates = others.get(m.group_id) ?? [];
    if (!candidates.length || candidates.some(o => o.role === 'admin')) continue;
    const heir = candidates[0];
    stmts.push(db.prepare("UPDATE members SET role = 'admin' WHERE id = ?").bind(heir.id));
    stmts.push(
      activityStmt(db, {
        groupId: m.group_id, userId: null, memberId: null, type: 'member.update',
        data: { memberId: heir.id, memberName: heir.name, changes: [{ field: 'role', from: 'member', to: 'admin' }] },
        now,
      }),
    );
  }
  stmts.push(db.prepare('UPDATE members SET user_id = NULL, claimed_at = NULL WHERE user_id = ?').bind(au.id));
  stmts.push(...touchGroupsStmts(db, mine.map(m => m.group_id)));
  stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(au.id));
  stmts.push(db.prepare('DELETE FROM login_codes WHERE user_id = ?').bind(au.id));
  stmts.push(db.prepare('DELETE FROM users WHERE id = ?').bind(au.id));
  await db.batch(stmts);
  return json(c, { ok: true });
});

/** Everything I can see: my account and a full snapshot of every group I am in (4 queries in one batch). */
meRoutes.get('/me/export', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const [uRes, gRes, mRes, eRes, cRes] = await db.batch([
    db.prepare('SELECT * FROM users WHERE id = ?').bind(au.id),
    db
      .prepare(
        `SELECT g.*, m.id AS my_member_id, m.role AS my_role FROM groups g JOIN members m ON m.group_id = g.id
         WHERE m.user_id = ? AND m.active = 1 AND g.deleted_at IS NULL ORDER BY g.updated_at DESC`,
      )
      .bind(au.id),
    db
      .prepare(
        `SELECT m.*, u.pay_info AS u_pay_info, u.venmo AS u_venmo, u.paypal AS u_paypal
         FROM members m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.group_id IN (${MY_GROUPS}) ORDER BY m.sort, m.created_at`,
      )
      .bind(au.id),
    db.prepare(`SELECT * FROM expenses WHERE group_id IN (${MY_GROUPS}) ORDER BY date DESC, created_at DESC`).bind(au.id),
    db
      .prepare(`SELECT expense_id, COUNT(*) AS n FROM comments WHERE group_id IN (${MY_GROUPS}) AND deleted_at IS NULL GROUP BY expense_id`)
      .bind(au.id),
  ]);
  const user = (uRes.results?.[0] as UserRow | undefined) ?? fail(401, 'unauthorized', 'Sign in first');
  const members = new Map<string, MemberWithUserRow[]>();
  for (const m of (mRes.results ?? []) as MemberWithUserRow[]) {
    const list = members.get(m.group_id);
    if (list) list.push(m);
    else members.set(m.group_id, [m]);
  }
  const expenses = new Map<string, ExpenseRow[]>();
  for (const e of (eRes.results ?? []) as ExpenseRow[]) {
    const list = expenses.get(e.group_id);
    if (list) list.push(e);
    else expenses.set(e.group_id, [e]);
  }
  const counts: Record<string, number> = {};
  for (const x of (cRes.results ?? []) as { expense_id: string; n: number }[]) counts[x.expense_id] = x.n;

  const groups: GroupSnapshotDTO[] = ((gRes.results ?? []) as (GroupRow & { my_member_id: string; my_role: string })[]).map(g => ({
    group: toGroupDTO(g),
    members: (members.get(g.id) ?? []).map(toMemberDTO),
    expenses: (expenses.get(g.id) ?? []).map(r => toExpenseDTO(r, counts[r.id] ?? 0)),
    me: { memberId: g.my_member_id, role: g.my_role === 'admin' ? 'admin' : 'member' },
    inviteCode: g.invite_code,
  }));
  return json(c, { user: toUserDTO(user, isOwnerEmail(c.env, user.email)), groups, exportedAt: nowISO() });
});

// ---------- activity ----------

/**
 * Newest first across my groups. `next` is the created_at of the last item; pass it back as
 * `before`. A page never splits items that share a timestamp (it grows to include all of them),
 * so `created_at < before` never skips anything.
 */
meRoutes.get('/activity', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const rawLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 30;
  const before = (c.req.query('before') ?? '').trim();
  if (before && !BEFORE_RE.test(before)) {
    fail(400, 'validation', 'before must be an ISO timestamp', [{ path: ['before'], message: 'Use the `next` value of the previous page' }]);
  }

  const mine = `a.group_id IN (${MY_GROUPS}) AND g.deleted_at IS NULL`;
  const page = await db
    .prepare(activitySelect(before ? `${mine} AND a.created_at < ?` : mine, 'ORDER BY a.created_at DESC, a.id DESC LIMIT ?'))
    .bind(...(before ? [au.id, before] : [au.id]), limit + 1)
    .all<ActivityJoinedRow>();
  let rows = page.results ?? [];
  let next: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1].created_at;
    const spills = rows[limit].created_at === last;
    rows = rows.slice(0, limit);
    if (spills) {
      const same = await db
        .prepare(activitySelect(`${mine} AND a.created_at = ?`, 'ORDER BY a.id DESC'))
        .bind(au.id, last)
        .all<ActivityJoinedRow>();
      rows = rows.filter(r => r.created_at !== last).concat(same.results ?? []);
    }
    next = last;
  }
  return json(c, { items: rows.map(toActivityDTO), next });
});

meRoutes.post('/activity/seen', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  await db.prepare('UPDATE users SET activity_seen_at = ? WHERE id = ?').bind(nowISO(), au.id).run();
  return json(c, { ok: true });
});
