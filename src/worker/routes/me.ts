// /api/me (dashboard, profile, sign-in details and the email confirmed with a code, account
// deletion, export) and /api/activity. The profile photo has its own module (routes/avatars.ts).

import { Hono } from 'hono';
import { z } from 'zod';
import type { AddEmailVerifyRes, GroupSnapshotDTO, GroupType, MeDTO } from '../../shared/types';
import { clearSessionCookies, cookieSessionId, hashPassword, rateLimit, requireUser, validPassword, verifyPassword } from '../auth';
import {
  getUser, getUserByEmail, isOwnerEmail, RECEIPT_COLUMNS, toExpenseDTO, toGroupDTO, toMemberDTO, toUserDTO,
  type ExpenseRow, type GroupRow, type MemberWithUserRow, type ReceiptColumns, type UserRow,
} from '../db';
import { activityView, knowsRefunds } from '../compat';
import type { AppEnv } from '../env';
import { fail, json, nowISO, readJson } from '../http';
import { activitySelect, activityStmt, toActivityDTO, type ActivityJoinedRow } from '../services/activity';
import { checkCode, codeEmail, codeInvalid, consumeCode, countStart, invalidEmail, sendCode } from '../services/emailCodes';
import {
  buildDashboard, ensureSummaries, touchGroupsStmts, touchUserGroupsStmt, type DashGroup, type DashMember, type DashPerson,
} from '../services/summary';
import { avatarDataUrl } from './avatars';

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

const AddEmailStartSchema = z.object({ email: z.string().max(320) });
const AddEmailVerifySchema = z.object({ email: z.string().max(320), code: z.string().max(40) });

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

async function currentUser(db: D1Database, id: string): Promise<UserRow> {
  return (await getUser(db, id)) ?? fail(401, 'unauthorized', 'Sign in first');
}

// ---------- dashboard ----------

type MyGroupRow = GroupRow & { my_member_id: string; my_archived_at: string | null };

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
        `SELECT g.*, m.id AS my_member_id, m.archived_at AS my_archived_at FROM groups g JOIN members m ON m.group_id = g.id
         WHERE m.user_id = ? AND m.active = 1 AND g.deleted_at IS NULL`,
      )
      .bind(au.id),
    db
      .prepare(
        `SELECT m.*, u.name AS u_name, u.color AS u_color, u.pay_info AS u_pay_info, u.venmo AS u_venmo, u.paypal AS u_paypal,
                u.avatar AS u_avatar
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
    const dm: DashMember = { id: m.id, userId: m.user_id, name: m.name, color: m.color, active: !!m.active, avatar: m.u_avatar ?? null };
    const list = members.get(m.group_id);
    if (list) list.push(dm);
    else members.set(m.group_id, [dm]);
    if (m.user_id && m.u_name !== null && !people[m.user_id]) {
      people[m.user_id] = {
        name: m.u_name, color: m.u_color || m.color, payInfo: m.u_pay_info ?? '', venmo: m.u_venmo ?? '', paypal: m.u_paypal ?? '',
        avatar: m.u_avatar ?? null,
      };
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
      archived: !!g.my_archived_at,
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

/**
 * Set or change the password. The email in the body must be the account's own (the browser salts
 * the password key with it), since an email is set or changed only with a code sent to it (POST
 * /me/email below), and that email must be confirmed, unless the account had a password already:
 * accounts from before email codes (the App Review demo account among them) keep changing theirs
 * here with the current password, as they always did. Anything else is 400 email_unconfirmed.
 */
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
  if (body.email !== user.email || (!user.email_verified_at && !user.pw_hash)) {
    fail(400, 'email_unconfirmed', 'Confirm this email with a code first (POST /api/me/email/start)');
  }
  if (user.pw_hash) {
    // 400, not 401: a 401 would sign this device out.
    const ok = !!body.currentPassword && (await verifyPassword(body.currentPassword, user.pw_hash));
    if (!ok) fail(400, 'invalid_credentials', 'The current password is not correct');
  }
  const pwHash = await hashPassword(body.password);
  const now = nowISO();
  await db.prepare('UPDATE users SET pw_hash = ?, updated_at = ? WHERE id = ?').bind(pwHash, now, au.id).run();
  const next: UserRow = { ...user, pw_hash: pwHash, updated_at: now };
  return json(c, { user: toUserDTO(next, isOwnerEmail(c.env, next.email)) });
});

// ---------- the sign-in email, confirmed with a code (services/emailCodes.ts) ----------

/**
 * A code to the address this account wants as its sign-in email, from the same limits as the
 * public start (per address and per IP). An address another account has is 409 email_taken at
 * once: this account could never get it.
 */
meRoutes.post('/me/email/start', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const body = await readJson(c, AddEmailStartSchema);
  const email = codeEmail(body.email) ?? invalidEmail();
  await countStart(c, email);
  const user = await currentUser(db, au.id);
  const owner = await getUserByEmail(db, email);
  if (owner && owner.id !== user.id) fail(409, 'email_taken', 'That email already has an account');
  return json(c, await sendCode(c, { email, purpose: 'add_email', userId: user.id, locale: user.locale === 'en' ? 'en' : 'zh-TW' }));
});

/**
 * The code from that email: it becomes the account's confirmed sign-in email. A password the
 * account had was derived in the browser with the old email as its salt (lib/crypto.ts), so under
 * the new one it could never match again: it is removed, and the answer says so (passwordCleared).
 * Confirming the email the account already has keeps the password. No group is touched, unlike a
 * new name or payment details on PATCH /me: no snapshot, dashboard, invite or push shows anyone's
 * email (only GET /api/me and the owner's page show it, read fresh).
 */
meRoutes.post('/me/email/verify', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const body = await readJson(c, AddEmailVerifySchema);
  const email = codeEmail(body.email) ?? invalidEmail();
  const code = await checkCode(c, { email, purpose: 'add_email', userId: au.id, code: body.code });
  const user = await currentUser(db, au.id);
  const owner = await getUserByEmail(db, email);
  if (owner && owner.id !== user.id) fail(409, 'email_taken', 'That email already has an account');
  if (!(await consumeCode(db, code.id))) codeInvalid();
  const passwordCleared = !!user.pw_hash && user.email !== email;
  const now = nowISO();
  try {
    await db
      .prepare('UPDATE users SET email = ?, email_verified_at = ?, pw_hash = CASE WHEN ? THEN NULL ELSE pw_hash END, updated_at = ? WHERE id = ?')
      .bind(email, now, passwordCleared ? 1 : 0, now, au.id)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) fail(409, 'email_taken', 'That email already has an account');
    throw err;
  }
  const next: UserRow = { ...user, email, email_verified_at: now, pw_hash: passwordCleared ? null : user.pw_hash, updated_at: now };
  const res: AddEmailVerifyRes = { user: toUserDTO(next, isOwnerEmail(c.env, next.email)), passwordCleared };
  return json(c, res);
});

/**
 * Delete my account. In every group where I am the only active admin with an account, the earliest
 * other active member with an account becomes admin first. My members stay as placeholders, so
 * groups keep their history. My profile photo and the codes I asked for to add an email go with
 * the account (sign-in codes belong to an address, not an account: the daily cleanup takes them).
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
  // The cascade from users does this too; said here like the rows above.
  stmts.push(db.prepare('DELETE FROM email_codes WHERE user_id = ?').bind(au.id));
  stmts.push(db.prepare('DELETE FROM avatars WHERE user_id = ?').bind(au.id));
  stmts.push(db.prepare('DELETE FROM users WHERE id = ?').bind(au.id));
  await db.batch(stmts);
  // Every session of the account is gone, so is the one this request's cookie holds. (Another
  // session of the account in the cookie of a Bearer caller is cleared on its next request.)
  if ((await cookieSessionId(c)) === au.sessionId) clearSessionCookies(c);
  return json(c, { ok: true });
});

/**
 * Everything I can see: my account with my profile photo (`user.avatarImage`, a data URL or null)
 * and a full snapshot of every group I am in, in one batch. Receipt photos come as their metadata
 * (ExpenseDTO.receipt), never their bytes: an export of a busy trip would otherwise be megabytes,
 * and each photo stays at its own address for anyone in the group. Refunds come as refunds for
 * every client (compat.ts has no view here): the export is a file to keep, and the apps from before
 * refunds read it as plain JSON.
 */
meRoutes.get('/me/export', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const [uRes, gRes, mRes, eRes, cRes, aRes] = await db.batch([
    db.prepare('SELECT * FROM users WHERE id = ?').bind(au.id),
    db
      .prepare(
        `SELECT g.*, m.id AS my_member_id, m.role AS my_role, m.archived_at AS my_archived_at FROM groups g JOIN members m ON m.group_id = g.id
         WHERE m.user_id = ? AND m.active = 1 AND g.deleted_at IS NULL ORDER BY g.updated_at DESC`,
      )
      .bind(au.id),
    db
      .prepare(
        `SELECT m.*, u.pay_info AS u_pay_info, u.venmo AS u_venmo, u.paypal AS u_paypal, u.avatar AS u_avatar
         FROM members m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.group_id IN (${MY_GROUPS}) ORDER BY m.sort, m.created_at`,
      )
      .bind(au.id),
    // The receipt photos' metadata only (ExpenseDTO.receipt): the bytes stay in KV, at their address.
    db
      .prepare(
        `SELECT e.*, ${RECEIPT_COLUMNS} FROM expenses e LEFT JOIN receipts r ON r.expense_id = e.id
         WHERE e.group_id IN (${MY_GROUPS}) ORDER BY e.date DESC, e.created_at DESC`,
      )
      .bind(au.id),
    db
      .prepare(`SELECT expense_id, COUNT(*) AS n FROM comments WHERE group_id IN (${MY_GROUPS}) AND deleted_at IS NULL GROUP BY expense_id`)
      .bind(au.id),
    db.prepare('SELECT mime, data FROM avatars WHERE user_id = ?').bind(au.id),
  ]);
  const user = (uRes.results?.[0] as UserRow | undefined) ?? fail(401, 'unauthorized', 'Sign in first');
  const photo = aRes.results?.[0] as { mime: string; data: unknown } | undefined;
  const members = new Map<string, MemberWithUserRow[]>();
  for (const m of (mRes.results ?? []) as MemberWithUserRow[]) {
    const list = members.get(m.group_id);
    if (list) list.push(m);
    else members.set(m.group_id, [m]);
  }
  const expenses = new Map<string, (ExpenseRow & ReceiptColumns)[]>();
  for (const e of (eRes.results ?? []) as (ExpenseRow & ReceiptColumns)[]) {
    const list = expenses.get(e.group_id);
    if (list) list.push(e);
    else expenses.set(e.group_id, [e]);
  }
  const counts: Record<string, number> = {};
  for (const x of (cRes.results ?? []) as { expense_id: string; n: number }[]) counts[x.expense_id] = x.n;

  // Each group also says whether I archived it (my own flag; not part of GroupSnapshotDTO elsewhere).
  const groups: (GroupSnapshotDTO & { archived: boolean })[] = (
    (gRes.results ?? []) as (GroupRow & { my_member_id: string; my_role: string; my_archived_at: string | null })[]
  ).map(g => ({
    group: toGroupDTO(g),
    members: (members.get(g.id) ?? []).map(toMemberDTO),
    expenses: (expenses.get(g.id) ?? []).map(r => toExpenseDTO(r, counts[r.id] ?? 0)),
    me: { memberId: g.my_member_id, role: g.my_role === 'admin' ? 'admin' : 'member' },
    inviteCode: g.invite_code,
    archived: !!g.my_archived_at,
  }));
  const avatarImage = photo ? avatarDataUrl(photo.mime, photo.data) : null;
  return json(c, { user: { ...toUserDTO(user, isOwnerEmail(c.env, user.email)), avatarImage }, groups, exportedAt: nowISO() });
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
  const refunds = knowsRefunds(c);
  return json(c, { items: rows.map(r => activityView(toActivityDTO(r), refunds)), next });
});

meRoutes.post('/activity/seen', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  await db.prepare('UPDATE users SET activity_seen_at = ? WHERE id = ?').bind(nowISO(), au.id).run();
  return json(c, { ok: true });
});
