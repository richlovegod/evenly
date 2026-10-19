// /api groups, members, invite links, claim links and friends (SPEC sections 4 and 6).

import { Hono } from 'hono';
import { z } from 'zod';
import { convertMinor } from '../../shared/balances';
import { colorFor, nextColor } from '../../shared/colors';
import { todayUTC } from '../../shared/dates';
import { MAX_AMOUNT } from '../../shared/money';
import type { ActivityData, ClaimInfoDTO, GroupType, JoinInfoDTO, MemberDTO, MemberRole } from '../../shared/types';
import { optionalUser, rateLimit, requireUser } from '../auth';
import {
  bumpVersionStmt, getGroupRow, getMembers, getUser, getUserByEmail, loadSnapshot, requireMember, toMemberDTO, versionFromBatch,
  type GroupRow, type MemberRow, type MemberWithUserRow, type UserRow,
} from '../db';
import type { AppEnv, AuthUser, Env } from '../env';
import { ApiError, fail, forbidden, json, newId, notFound, nowISO, randomInviteCode, randomToken, readJson, sha256Hex } from '../http';
import { activityStmt, activityStmtWhere } from '../services/activity';
import { getUsdRates, rateToBase } from '../services/fx';
import { materializeDue } from '../services/recurring';
import { chunk, ensureSummary, placeholders, refreshSummary } from '../services/summary';

export const groupRoutes = new Hono<AppEnv>();

// ---------- limits and formats ----------

export const MAX_ACTIVE_MEMBERS = 50;
export const MAX_GROUPS_PER_USER = 200;
/** Accounts one person may link by email in a day (each gets a push notification, see limitLinks). */
export const MAX_LINKS_PER_DAY = 30;
/** A 1:1 friend ledger (type 'pair') holds two people. */
const PAIR_MEMBERS = 2;
const CLAIM_TTL_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 86_400_000;

const CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const INVITE_RE = /^[A-Za-z0-9]{6,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

const name60 = z.string().trim().min(1, 'Enter a name').max(60, 'At most 60 characters');
const groupName = z.string().trim().min(1, 'Enter a group name').max(80, 'At most 80 characters');
const emoji = z.string().trim().refine(s => [...s].length <= 16, 'At most 16 characters');
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use #RRGGBB');
const currency = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code');
const optEmail = z.union([z.string().max(320), z.null()]).optional();

const CreateGroupSchema = z.object({
  id: z.unknown().optional(),
  name: groupName,
  // Pair groups (1:1 friend ledgers) are made only by POST /friends.
  type: z.enum(['trip', 'home', 'couple', 'other']),
  currency,
  emoji: emoji.optional(),
  color: hexColor.optional(),
  simplify: z.boolean().optional(),
  members: z.array(z.object({ name: name60, email: optEmail })).max(200).optional(),
});

const UpdateGroupSchema = z.object({
  name: groupName.optional(),
  type: z.enum(['trip', 'home', 'couple', 'other', 'pair']).optional(),
  emoji: emoji.optional(),
  color: hexColor.optional(),
  simplify: z.boolean().optional(),
  notes: z.string().trim().max(2000, 'At most 2000 characters').optional(),
  currency: currency.optional(),
});

const AddMemberSchema = z.object({ name: name60, email: optEmail });

const UpdateMemberSchema = z.object({
  name: name60.optional(),
  color: hexColor.optional(),
  role: z.enum(['admin', 'member']).optional(),
});

const JoinSchema = z.object({
  memberId: z.string().max(100).optional(),
  name: z.string().trim().max(60, 'At most 60 characters').optional(),
});

const FriendSchema = z.object({ name: name60, email: optEmail });

/**
 * One line of a 'group.update' activity. A currency change also keeps the rate it re-based the
 * entries with (when it had to convert any), so a save made against the old currency that arrives
 * later can be converted the same way (routes/expenses.ts, groupBaseBody).
 */
type Change = { field: string; from: string; to: string; rate?: number };

// ---------- helpers ----------

function normEmail(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  return s && s.length <= 120 && EMAIL_RE.test(s) ? s : null;
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

const roleOf = (m: { role: string }): MemberRole => (m.role === 'admin' ? 'admin' : 'member');

/** An admin who can act: active and linked to an account. */
const isLinkedAdmin = (m: MemberRow): boolean => !!m.active && !!m.user_id && m.role === 'admin';

const maxSort = (members: readonly MemberRow[]): number => members.reduce((a, m) => Math.max(a, m.sort), -1);

/** The account's own color when no other active member uses it, else the next free color. */
function pickColor(used: readonly string[], preferred: string | null | undefined, seed: string): string {
  const taken = used.map(c => c.toUpperCase());
  if (preferred && /^#[0-9A-Fa-f]{6}$/.test(preferred) && !taken.includes(preferred.toUpperCase())) return preferred;
  return nextColor(used, seed);
}

/** Cut a value for display in activity ("before" and "after" of long notes). */
function clip(s: string, max = 120): string {
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max).join('') + '…' : s;
}

function appLink(env: Env, hashPath: string): string {
  const base = env.APP_URL || '';
  return (base.endsWith('/') ? base : base + '/') + '#' + hashPath;
}

/** If-None-Match names this ETag (also weakly, or with *). Also used by routes/avatars.ts. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some(p => {
    const t = p.trim();
    return t === '*' || t === etag || t === 'W/' + etag;
  });
}

interface NewMember {
  id: string;
  groupId: string;
  userId: string | null;
  name: string;
  color: string;
  role: MemberRole;
  sort: number;
  now: string;
}

function insertMemberStmt(db: D1Database, m: NewMember): D1PreparedStatement {
  return db
    .prepare('INSERT INTO members (id, group_id, user_id, name, color, role, active, sort, created_at, claimed_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
    .bind(m.id, m.groupId, m.userId, m.name, m.color, m.role, m.sort, m.now, m.userId ? m.now : null);
}

/** The DTO of a member we just wrote, without reading it back. */
function newMemberDTO(m: NewMember, account: UserRow | null): MemberDTO {
  return toMemberDTO({
    id: m.id, group_id: m.groupId, user_id: m.userId, name: m.name, color: m.color, role: m.role, active: 1, sort: m.sort,
    created_at: m.now, claimed_at: m.userId ? m.now : null,
    u_pay_info: account?.pay_info ?? null, u_venmo: account?.venmo ?? null, u_paypal: account?.paypal ?? null,
    u_avatar: account?.avatar ?? null,
  });
}

function insertGroupStmt(
  db: D1Database,
  g: { id: string; name: string; type: GroupType; currency: string; emoji: string; color: string; simplify: boolean; createdBy: string; now: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO groups (id, name, type, currency, emoji, color, simplify, notes, invite_code, created_by, created_at, updated_at, deleted_at, version, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, NULL, 1, NULL)`,
    )
    .bind(g.id, g.name, g.type, g.currency, g.emoji, g.color, g.simplify ? 1 : 0, randomInviteCode(), g.createdBy, g.now, g.now);
}

/** Active memberships in live groups, per user. */
async function groupCounts(db: D1Database, userIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const part of chunk([...new Set(userIds)])) {
    const r = await db
      .prepare(
        `SELECT m.user_id AS uid, COUNT(*) AS n FROM members m JOIN groups g ON g.id = m.group_id
         WHERE m.user_id IN (${placeholders(part.length)}) AND m.active = 1 AND g.deleted_at IS NULL GROUP BY m.user_id`,
      )
      .bind(...part)
      .all<{ uid: string; n: number }>();
    for (const x of r.results ?? []) out.set(x.uid, x.n);
  }
  return out;
}

/** 409 limit_reached when one of these people is already in MAX_GROUPS_PER_USER groups. */
async function assertGroupRoom(db: D1Database, people: readonly { id: string; label: string }[]): Promise<void> {
  if (!people.length) return;
  const counts = await groupCounts(db, people.map(p => p.id));
  for (const p of people) {
    if ((counts.get(p.id) ?? 0) >= MAX_GROUPS_PER_USER) {
      fail(409, 'limit_reached', `${p.label} can be in at most ${MAX_GROUPS_PER_USER} groups`);
    }
  }
}

/**
 * Count `n` accounts linked by email (a new group, an added member, a 1:1 ledger) toward the
 * person's daily limit, and refuse with 429 rate_limited past it. Each linked account gets a push
 * notification with words the person chose (the group name), and linking needs only the email,
 * so this keeps anyone from filling a stranger's lock screen. rateLimit (auth.ts) in steps of `n`:
 * the same rate_limits rows and fixed window, so refused attempts count too.
 */
async function limitLinks(db: D1Database, userId: string, n: number): Promise<void> {
  if (n <= 0) return;
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, ?4, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ?3 THEN ?4 ELSE rate_limits.count + ?4 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
       RETURNING count, reset_at`,
    )
    .bind('link-account:' + userId, now + DAY_MS, now, n)
    .first<{ count: number; reset_at: number }>();
  if (row && row.count > MAX_LINKS_PER_DAY) {
    const retryAfter = Math.max(1, Math.ceil((row.reset_at - now) / 1000));
    fail(429, 'rate_limited', `You can add at most ${MAX_LINKS_PER_DAY} people by email a day`, { retryAfter, scope: 'links' });
  }
}

/** 409 limit_reached when the group has no room for one more active member. */
function assertMemberRoom(group: GroupRow, activeCount: number): void {
  if (group.type === 'pair' && activeCount >= PAIR_MEMBERS) {
    fail(409, 'limit_reached', 'A 1:1 friend ledger has two people. Create a group to add more people.');
  }
  if (activeCount >= MAX_ACTIVE_MEMBERS) fail(409, 'limit_reached', `A group can have at most ${MAX_ACTIVE_MEMBERS} members`);
}

async function groupByInvite(db: D1Database, code: string): Promise<GroupRow | null> {
  if (!INVITE_RE.test(code)) return null;
  return db.prepare('SELECT * FROM groups WHERE invite_code = ? AND deleted_at IS NULL').bind(code).first<GroupRow>();
}

/** Batch statements: one member change + its activity + the version bump (index 2). */
async function memberChange(
  db: D1Database,
  change: D1PreparedStatement,
  activity: D1PreparedStatement,
  gid: string,
  now: string,
): Promise<number> {
  const res = await db.batch([change, activity, bumpVersionStmt(db, gid, now)]);
  await refreshSummary(db, gid);
  return versionFromBatch(res, 2);
}

// ---------- claim (shared by invite links and claim links) ----------

interface ClaimArgs {
  groupId: string;
  memberId: string;
  memberName: string;
  userId: string;
  now: string;
  /** Make the claimer an admin (the group has no active admin with an account). */
  makeAdmin: boolean;
  /** Claim link to mark used in the same transaction. */
  tokenId?: string;
}

/**
 * Link an active placeholder to an account in one transaction. Returns the new group version, or
 * null when the member was no longer an active placeholder (then nothing changed).
 */
async function claimMember(db: D1Database, a: ClaimArgs): Promise<number | null> {
  // True only after this request's UPDATE linked the member (claimed_at is this request's time).
  const claimed = 'EXISTS (SELECT 1 FROM members WHERE id = ? AND user_id = ? AND claimed_at = ?)';
  const claimedParams = [a.memberId, a.userId, a.now];
  const stmts: D1PreparedStatement[] = [
    // A member row of mine that left this group earlier lets go of my account, so I can take this one.
    db
      .prepare(
        `UPDATE members SET user_id = NULL, claimed_at = NULL
         WHERE group_id = ? AND user_id = ? AND active = 0
           AND EXISTS (SELECT 1 FROM members WHERE id = ? AND group_id = ? AND user_id IS NULL AND active = 1)`,
      )
      .bind(a.groupId, a.userId, a.memberId, a.groupId),
    db
      .prepare(
        `UPDATE members SET user_id = ?, claimed_at = ?${a.makeAdmin ? ", role = 'admin'" : ''}
         WHERE id = ? AND group_id = ? AND user_id IS NULL AND active = 1`,
      )
      .bind(a.userId, a.now, a.memberId, a.groupId),
  ];
  if (a.tokenId) {
    stmts.push(
      db.prepare(`UPDATE claim_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND ${claimed}`).bind(a.now, a.tokenId, ...claimedParams),
    );
  }
  stmts.push(
    activityStmtWhere(
      db,
      { groupId: a.groupId, userId: a.userId, memberId: a.memberId, type: 'member.claim', data: { memberId: a.memberId, memberName: a.memberName }, now: a.now },
      claimed,
      claimedParams,
    ),
  );
  stmts.push(
    db.prepare(`UPDATE groups SET version = version + 1, updated_at = ? WHERE id = ? AND ${claimed} RETURNING version`).bind(a.now, a.groupId, ...claimedParams),
  );
  const res = await db.batch(stmts);
  if (!((res[1]?.meta?.changes ?? 0) > 0)) return null;
  return versionFromBatch(res, res.length - 1);
}

async function hasLinkedAdmin(db: D1Database, gid: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM members WHERE group_id = ? AND active = 1 AND user_id IS NOT NULL AND role = 'admin'")
    .bind(gid)
    .first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

interface ClaimTokenRow {
  token_id: string;
  member_id: string;
  group_id: string;
  expires_at: string;
  used_at: string | null;
  m_name: string;
  m_color: string;
  m_user_id: string | null;
  m_active: number;
  g_name: string;
  g_emoji: string;
  g_color: string;
  g_deleted_at: string | null;
}

/** The claim link's row when it can still be used (unused, not expired, member still an active placeholder). */
async function usableClaim(db: D1Database, token: string): Promise<ClaimTokenRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const row = await db
    .prepare(
      `SELECT ct.id AS token_id, ct.member_id, ct.group_id, ct.expires_at, ct.used_at,
              m.name AS m_name, m.color AS m_color, m.user_id AS m_user_id, m.active AS m_active,
              g.name AS g_name, g.emoji AS g_emoji, g.color AS g_color, g.deleted_at AS g_deleted_at
       FROM claim_tokens ct
       JOIN members m ON m.id = ct.member_id AND m.group_id = ct.group_id
       JOIN groups g ON g.id = ct.group_id
       WHERE ct.id = ?`,
    )
    .bind(await sha256Hex(token))
    .first<ClaimTokenRow>();
  if (!row || row.used_at || !(row.expires_at > nowISO()) || row.m_user_id || !row.m_active || row.g_deleted_at) return null;
  return row;
}

// ---------- groups ----------

groupRoutes.post('/groups', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const body = await readJson(c, CreateGroupSchema);
  const user = (await getUser(db, au.id)) ?? fail(401, 'unauthorized', 'Sign in first');

  // The client may send its own id so a retried create is not doubled.
  let gid = typeof body.id === 'string' && CLIENT_ID_RE.test(body.id) ? body.id : newId();
  const existing = await db
    .prepare(
      `SELECT g.id, g.deleted_at, m.id AS m_id FROM groups g
       LEFT JOIN members m ON m.group_id = g.id AND m.user_id = ? AND m.active = 1
       WHERE g.id = ?`,
    )
    .bind(user.id, gid)
    .first<{ id: string; deleted_at: string | null; m_id: string | null }>();
  if (existing) {
    if (!existing.deleted_at && existing.m_id) {
      const { group, member } = await requireMember(db, gid, user.id);
      return json(c, await loadSnapshot(db, group, member));
    }
    gid = newId();
  }

  const asked = body.members ?? [];
  const emails = [...new Set(asked.map(m => normEmail(m.email)).filter((e): e is string => !!e))];
  const accounts = new Map<string, UserRow>();
  for (const part of chunk(emails)) {
    const r = await db.prepare(`SELECT * FROM users WHERE email IN (${placeholders(part.length)})`).bind(...part).all<UserRow>();
    for (const u of r.results ?? []) if (u.email) accounts.set(u.email, u);
  }

  const now = nowISO();
  const myMemberId = newId();
  const used: string[] = [user.color];
  const linked = new Set<string>([user.id]);
  const others: { id: string; label: string }[] = [];
  const memberStmts: D1PreparedStatement[] = [
    insertMemberStmt(db, { id: myMemberId, groupId: gid, userId: user.id, name: user.name, color: user.color, role: 'admin', sort: 0, now }),
  ];
  for (const m of asked) {
    const email = normEmail(m.email);
    const account = email ? accounts.get(email) ?? null : null;
    // My own email, or the same account twice: nobody new to add.
    if (account && linked.has(account.id)) continue;
    const id = newId();
    const color = pickColor(used, account?.color, id);
    used.push(color);
    memberStmts.push(insertMemberStmt(db, { id, groupId: gid, userId: account?.id ?? null, name: m.name, color, role: 'member', sort: memberStmts.length, now }));
    if (account) {
      linked.add(account.id);
      others.push({ id: account.id, label: m.name });
    }
  }
  if (memberStmts.length > MAX_ACTIVE_MEMBERS) fail(409, 'limit_reached', `A group can have at most ${MAX_ACTIVE_MEMBERS} members`);
  await assertGroupRoom(db, [{ id: user.id, label: 'You' }, ...others]);
  await limitLinks(db, user.id, others.length);

  await db.batch([
    insertGroupStmt(db, {
      id: gid, name: body.name, type: body.type, currency: body.currency, emoji: body.emoji ?? '', color: body.color ?? colorFor(gid),
      simplify: body.simplify !== false, createdBy: user.id, now,
    }),
    ...memberStmts,
    activityStmt(db, { groupId: gid, userId: user.id, memberId: myMemberId, type: 'group.create', data: { groupName: body.name }, now }),
  ]);
  await refreshSummary(db, gid);
  const { group, member } = await requireMember(db, gid, user.id);
  return json(c, await loadSnapshot(db, group, member));
});

groupRoutes.get('/groups/:gid', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const gid = c.req.param('gid');
  const { group, member } = await requireMember(db, gid, au.id);
  let current = group;
  try {
    await materializeDue(db, { groupId: gid, today: todayUTC() });
    // Re-read even when nothing was created: moving a repeat flag also bumps the version.
    current = (await getGroupRow(db, gid)) ?? notFound('Group not found');
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw err;
    // Recurring copies can wait for the next read or the daily cron; the group itself must load.
    console.error('materializeDue failed for group', gid, err);
  }
  const etag = `"${current.version}"`;
  c.header('ETag', etag);
  if (etagMatches(c.req.header('If-None-Match'), etag)) {
    c.header('Cache-Control', 'no-store');
    return c.body(null, 304);
  }
  return json(c, await loadSnapshot(db, current, member));
});

groupRoutes.patch('/groups/:gid', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const gid = c.req.param('gid');
  const { group, member } = await requireMember(db, gid, au.id);
  const body = await readJson(c, UpdateGroupSchema);

  const changes: Change[] = [];
  const sets: string[] = [];
  const vals: unknown[] = [];
  const change = (column: string, value: unknown, field: string, from: string, to: string) => {
    sets.push(`${column} = ?`);
    vals.push(value);
    changes.push({ field, from, to });
  };

  if (body.name !== undefined && body.name !== group.name) change('name', body.name, 'name', group.name, body.name);
  if (body.type !== undefined && body.type !== group.type) {
    if (body.type === 'pair') fail(400, 'bad_request', 'A 1:1 friend ledger can only be made from Friends');
    change('type', body.type, 'type', group.type, body.type);
  }
  if (body.emoji !== undefined && body.emoji !== group.emoji) change('emoji', body.emoji, 'emoji', group.emoji, body.emoji);
  if (body.color !== undefined && body.color.toUpperCase() !== (group.color || '').toUpperCase()) change('color', body.color, 'color', group.color, body.color);
  if (body.simplify !== undefined && body.simplify !== !!group.simplify) {
    change('simplify', body.simplify ? 1 : 0, 'simplify', String(!!group.simplify), String(body.simplify));
  }
  if (body.notes !== undefined && body.notes !== group.notes) change('notes', body.notes, 'notes', clip(group.notes), clip(body.notes));

  const stmts: D1PreparedStatement[] = [];
  if (body.currency !== undefined && body.currency !== group.currency) {
    const rebase = await rebaseStmt(db, gid, group.currency, body.currency);
    stmts.push(rebase.stmt);
    change('currency', body.currency, 'currency', group.currency, body.currency);
    if (rebase.rate !== null) changes[changes.length - 1].rate = rebase.rate;
  }
  if (!changes.length) return json(c, await loadSnapshot(db, group, member));

  const now = nowISO();
  stmts.push(db.prepare(`UPDATE groups SET ${sets.join(', ')}, version = version + 1, updated_at = ? WHERE id = ? RETURNING version`).bind(...vals, now, gid));
  stmts.push(
    activityStmt(db, { groupId: gid, userId: au.id, memberId: member.id, type: 'group.update', data: { groupName: body.name ?? group.name, changes }, now }),
  );
  await db.batch(stmts);
  await refreshSummary(db, gid);
  const fresh = (await getGroupRow(db, gid)) ?? notFound('Group not found');
  return json(c, await loadSnapshot(db, fresh, member));
});

/**
 * The statement that re-bases every entry (deleted ones too) when the group currency changes:
 * new fxRate = old fxRate x (value of 1 old base in the new base); entries already in the new
 * base get exactly 1, entries in the old base get the rate itself. 503 fx_unavailable without rates.
 * `rate` is that value of 1 old base, or null when no entry needed converting (it was not fetched).
 * Keep the CASE below in step with rebasedRate() in routes/expenses.ts, which converts saves made
 * against the old currency that arrive after the change.
 */
async function rebaseStmt(
  db: D1Database,
  gid: string,
  oldBase: string,
  newBase: string,
): Promise<{ stmt: D1PreparedStatement; rate: number | null }> {
  const need = await db
    .prepare('SELECT COUNT(*) AS n FROM expenses WHERE group_id = ? AND currency <> ?')
    .bind(gid, newBase)
    .first<{ n: number }>();
  let k = 1;
  const converts = (need?.n ?? 0) > 0;
  if (converts) {
    let rate: number | null = null;
    try {
      const fx = await getUsdRates(db, todayUTC());
      rate = rateToBase(fx.rates, oldBase, newBase);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      console.error('rebase: exchange rates failed', err);
      fail(503, 'fx_unavailable', 'Exchange rates are not available right now');
    }
    if (rate === null || !Number.isFinite(rate) || rate <= 0) {
      fail(503, 'fx_unavailable', `No exchange rate from ${oldBase} to ${newBase}`);
    }
    k = rate;
    // Refuse a change that would push a converted total past MAX_AMOUNT (it would break every
    // later summary of the group).
    const rowsR = await db
      .prepare('SELECT amount, currency, fx_rate FROM expenses WHERE group_id = ? AND currency <> ?')
      .bind(gid, newBase)
      .all<{ amount: number; currency: string; fx_rate: number }>();
    for (const r of rowsR.results ?? []) {
      const nr = r.currency === oldBase ? k : r.fx_rate * k;
      if (!(nr > 0) || convertMinor(r.amount, r.currency, nr, newBase) > MAX_AMOUNT) {
        fail(400, 'validation', 'Some amounts would be too large in the new currency', { code: 'amount_too_large' });
      }
    }
  }
  // 10 significant digits, like rateToBase, so no float noise ends up in the stored rates.
  const stmt = db
    .prepare(
      `UPDATE expenses SET fx_rate = CASE
         WHEN currency = ? THEN 1
         WHEN currency = ? THEN ?
         ELSE CAST(printf('%.10g', fx_rate * ?) AS REAL) END
       WHERE group_id = ?`,
    )
    .bind(newBase, oldBase, k, k, gid);
  return { stmt, rate: converts ? k : null };
}

groupRoutes.delete('/groups/:gid', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const gid = c.req.param('gid');
  const { group, member } = await requireMember(db, gid, au.id);
  if (roleOf(member) !== 'admin') forbidden('Only admins can delete the group');
  const now = nowISO();
  await db.batch([
    db.prepare('UPDATE groups SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL').bind(now, now, gid),
    activityStmt(db, { groupId: gid, userId: au.id, memberId: member.id, type: 'group.delete', data: { groupName: group.name }, now }),
  ]);
  return json(c, { ok: true });
});

// ---------- members ----------

groupRoutes.post('/groups/:gid/members', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const gid = c.req.param('gid');
  const { group, member: me } = await requireMember(db, gid, au.id);
  const body = await readJson(c, AddMemberSchema);
  const members = await getMembers(db, gid);
  const active = members.filter(m => m.active);
  const email = normEmail(body.email);
  const account = email ? await getUserByEmail(db, email) : null;
  const now = nowISO();

  if (account) {
    if (account.id === au.id) fail(409, 'already_member', 'You are already in this group');
    const row = members.find(m => m.user_id === account.id);
    if (row?.active) fail(409, 'already_member', `${row.name} is already in this group`);
    assertMemberRoom(group, active.length);
    await assertGroupRoom(db, [{ id: account.id, label: body.name }]);
    await limitLinks(db, au.id, 1);
    if (row) {
      // Someone who left or was removed comes back with their old member (and history).
      const version = await memberChange(
        db,
        db.prepare('UPDATE members SET active = 1 WHERE id = ?').bind(row.id),
        activityStmt(db, { groupId: gid, userId: au.id, memberId: me.id, type: 'member.add', data: { memberId: row.id, memberName: row.name }, now }),
        gid,
        now,
      );
      return json(c, { member: toMemberDTO({ ...row, active: 1 }), groupVersion: version });
    }
  } else {
    assertMemberRoom(group, active.length);
  }

  const id = newId();
  const nm: NewMember = {
    id,
    groupId: gid,
    userId: account?.id ?? null,
    name: body.name,
    color: pickColor(active.map(m => m.color), account?.color, id),
    role: group.type === 'pair' ? 'admin' : 'member',
    sort: maxSort(members) + 1,
    now,
  };
  let version: number;
  try {
    version = await memberChange(
      db,
      insertMemberStmt(db, nm),
      activityStmt(db, { groupId: gid, userId: au.id, memberId: me.id, type: 'member.add', data: { memberId: id, memberName: nm.name }, now }),
      gid,
      now,
    );
  } catch (err) {
    if (isUniqueViolation(err)) fail(409, 'already_member', `${body.name} is already in this group`);
    throw err;
  }
  return json(c, { member: newMemberDTO(nm, account), groupVersion: version });
});

groupRoutes.patch('/groups/:gid/members/:mid', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const gid = c.req.param('gid');
  const mid = c.req.param('mid');
  const { group, member: me } = await requireMember(db, gid, au.id);
  const body = await readJson(c, UpdateMemberSchema);
  const members = await getMembers(db, gid);
  const target = members.find(m => m.id === mid) ?? notFound('Member not found');

  const changes: Change[] = [];
  const sets: string[] = [];
  const vals: unknown[] = [];
  const next: MemberWithUserRow = { ...target };
  if (body.name !== undefined && body.name !== target.name) {
    sets.push('name = ?');
    vals.push(body.name);
    changes.push({ field: 'name', from: target.name, to: body.name });
    next.name = body.name;
  }
  if (body.color !== undefined && body.color.toUpperCase() !== target.color.toUpperCase()) {
    sets.push('color = ?');
    vals.push(body.color);
    changes.push({ field: 'color', from: target.color, to: body.color });
    next.color = body.color;
  }
  if (body.role !== undefined && body.role !== roleOf(target)) {
    if (roleOf(me) !== 'admin') forbidden('Only admins can change roles');
    if (body.role === 'member' && isLinkedAdmin(target) && !members.some(m => m.id !== target.id && isLinkedAdmin(m))) {
      fail(409, 'last_admin', 'Make someone else an admin first');
    }
    sets.push('role = ?');
    vals.push(body.role);
    changes.push({ field: 'role', from: roleOf(target), to: body.role });
    next.role = body.role;
  }
  if (!changes.length) return json(c, { member: toMemberDTO(target), groupVersion: group.version });

  const now = nowISO();
  const version = await memberChange(
    db,
    db.prepare(`UPDATE members SET ${sets.join(', ')} WHERE id = ? AND group_id = ?`).bind(...vals, mid, gid),
    activityStmt(db, { groupId: gid, userId: au.id, memberId: me.id, type: 'member.update', data: { memberId: mid, memberName: next.name, changes }, now }),
    gid,
    now,
  );
  return json(c, { member: toMemberDTO(next), groupVersion: version });
});

/** Leave (your own member) or remove (admins). The member's net must be 0; the row stays with active = 0. */
groupRoutes.delete('/groups/:gid/members/:mid', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const gid = c.req.param('gid');
  const mid = c.req.param('mid');
  const { group, member: me } = await requireMember(db, gid, au.id);
  const members = await getMembers(db, gid);
  const target = members.find(m => m.id === mid) ?? notFound('Member not found');
  const leaving = target.id === me.id;
  if (!leaving && roleOf(me) !== 'admin') forbidden('Only admins can remove members');
  if (!target.active) return json(c, { ok: true, groupVersion: group.version });

  const summary = await ensureSummary(db, group);
  const net = summary.net[target.id] ?? 0;
  if (net !== 0) fail(409, 'balance_not_zero', 'Settle up first: this member still has a balance', { net, currency: summary.currency });
  if (leaving && isLinkedAdmin(target)) {
    const otherAdmin = members.some(m => m.id !== target.id && isLinkedAdmin(m));
    const otherLinked = members.some(m => m.id !== target.id && m.active && m.user_id);
    if (!otherAdmin && otherLinked) fail(409, 'last_admin', 'Make someone else an admin before you leave');
  }

  const now = nowISO();
  const version = await memberChange(
    db,
    db.prepare('UPDATE members SET active = 0 WHERE id = ? AND group_id = ?').bind(mid, gid),
    activityStmt(db, {
      groupId: gid, userId: au.id, memberId: me.id, type: leaving ? 'member.leave' : 'member.remove',
      data: { memberId: mid, memberName: target.name }, now,
    }),
    gid,
    now,
  );
  return json(c, { ok: true, groupVersion: version });
});

/** Admins turn a member back into a placeholder (to recover someone who lost their device). */
groupRoutes.post('/groups/:gid/members/:mid/unlink', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const gid = c.req.param('gid');
  const mid = c.req.param('mid');
  const { group, member: me } = await requireMember(db, gid, au.id);
  if (roleOf(me) !== 'admin') forbidden('Only admins can unlink accounts');
  const members = await getMembers(db, gid);
  const target = members.find(m => m.id === mid) ?? notFound('Member not found');
  if (target.id === me.id) fail(400, 'bad_request', 'You cannot unlink your own account');
  const placeholder: MemberWithUserRow = { ...target, user_id: null, claimed_at: null, u_pay_info: null, u_venmo: null, u_paypal: null, u_avatar: null };
  if (!target.user_id) return json(c, { member: toMemberDTO(placeholder), groupVersion: group.version });

  const now = nowISO();
  const version = await memberChange(
    db,
    db.prepare('UPDATE members SET user_id = NULL, claimed_at = NULL WHERE id = ? AND group_id = ?').bind(mid, gid),
    activityStmt(db, { groupId: gid, userId: au.id, memberId: me.id, type: 'member.unlink', data: { memberId: mid, memberName: target.name }, now }),
    gid,
    now,
  );
  return json(c, { member: toMemberDTO(placeholder), groupVersion: version });
});

/** A one-time link (7 days) that lets one specific person take over one placeholder. */
groupRoutes.post('/groups/:gid/members/:mid/claim-link', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const gid = c.req.param('gid');
  const mid = c.req.param('mid');
  await requireMember(db, gid, au.id);
  const target = (await db.prepare('SELECT * FROM members WHERE id = ? AND group_id = ?').bind(mid, gid).first<MemberRow>()) ?? notFound('Member not found');
  if (target.user_id) fail(409, 'member_claimed', `${target.name} already has an account in this group`);
  if (!target.active) fail(400, 'bad_request', 'This member is no longer in the group');
  await rateLimit(db, 'claim-link:' + au.id, 60, 3600);
  const token = randomToken(32);
  const now = nowISO();
  const expiresAt = new Date(Date.parse(now) + CLAIM_TTL_MS).toISOString();
  await db
    .prepare('INSERT INTO claim_tokens (id, member_id, group_id, created_by, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .bind(await sha256Hex(token), mid, gid, au.id, expiresAt, now)
    .run();
  return json(c, { token, url: appLink(c.env, '/claim/' + token), expiresAt });
});

groupRoutes.post('/groups/:gid/invite/reset', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const gid = c.req.param('gid');
  const { member } = await requireMember(db, gid, au.id);
  if (roleOf(member) !== 'admin') forbidden('Only admins can reset the invite link');
  let inviteCode = randomInviteCode();
  try {
    await db.prepare('UPDATE groups SET invite_code = ?, version = version + 1 WHERE id = ?').bind(inviteCode, gid).run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    inviteCode = randomInviteCode();
    await db.prepare('UPDATE groups SET invite_code = ?, version = version + 1 WHERE id = ?').bind(inviteCode, gid).run();
  }
  await refreshSummary(db, gid);
  return json(c, { inviteCode });
});

// ---------- invite links ----------

groupRoutes.get('/join/:code', optionalUser, async c => {
  const db = c.env.DB;
  const group = (await groupByInvite(db, c.req.param('code'))) ?? notFound('Invite link not found');
  const members = (await getMembers(db, group.id)).filter(m => m.active);
  const user = c.get('user') as AuthUser | undefined;
  const mine = user ? members.find(m => m.user_id === user.id) : undefined;
  const info: JoinInfoDTO = {
    group: {
      id: group.id, name: group.name, emoji: group.emoji, color: group.color, currency: group.currency,
      type: group.type as GroupType, memberCount: members.length,
    },
    members: members.map(m => ({ id: m.id, name: m.name, color: m.color, claimed: !!m.user_id, active: true })),
    myMemberId: mine?.id ?? null,
  };
  return json(c, info);
});

groupRoutes.post('/join/:code', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const group = (await groupByInvite(db, c.req.param('code'))) ?? notFound('Invite link not found');
  const body = await readJson(c, JoinSchema);
  const gid = group.id;
  const members = await getMembers(db, gid);
  const mine = members.find(m => m.user_id === au.id);
  if (mine?.active) return json(c, { groupId: gid, memberId: mine.id });

  const active = members.filter(m => m.active);
  // A group whose admins all left or lost their accounts gets one back from the next person who joins.
  const makeAdmin = !active.some(isLinkedAdmin);
  const now = nowISO();
  await assertGroupRoom(db, [{ id: au.id, label: 'You' }]);

  if (mine) {
    // Back after leaving or being removed: the old member (with its history) is active again.
    assertMemberRoom(group, active.length);
    await memberChange(
      db,
      db.prepare(`UPDATE members SET active = 1${makeAdmin ? ", role = 'admin'" : ''} WHERE id = ?`).bind(mine.id),
      activityStmt(db, { groupId: gid, userId: au.id, memberId: mine.id, type: 'member.join', data: { memberId: mine.id, memberName: mine.name }, now }),
      gid,
      now,
    );
    return json(c, { groupId: gid, memberId: mine.id });
  }

  if (body.memberId) {
    const target = active.find(m => m.id === body.memberId) ?? notFound('Member not found');
    if (target.user_id) fail(409, 'member_claimed', `${target.name} is already linked to an account`);
    let version: number | null;
    try {
      version = await claimMember(db, { groupId: gid, memberId: target.id, memberName: target.name, userId: au.id, now, makeAdmin });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      version = null;
    }
    if (version === null) {
      // A second tap may have joined already.
      const again = (await getMembers(db, gid)).find(m => m.user_id === au.id && m.active);
      if (again) return json(c, { groupId: gid, memberId: again.id });
      fail(409, 'member_claimed', `${target.name} is already linked to an account`);
    }
    await refreshSummary(db, gid);
    return json(c, { groupId: gid, memberId: target.id });
  }

  const name = (body.name ?? '').trim();
  if (!name) fail(400, 'validation', 'Pick your name from the list or type a new one', [{ path: ['name'], message: 'Enter a name' }]);
  assertMemberRoom(group, active.length);
  const user = await getUser(db, au.id);
  const id = newId();
  const nm: NewMember = {
    id,
    groupId: gid,
    userId: au.id,
    name,
    color: pickColor(active.map(m => m.color), user?.color, id),
    role: makeAdmin || group.type === 'pair' ? 'admin' : 'member',
    sort: maxSort(members) + 1,
    now,
  };
  try {
    await memberChange(
      db,
      insertMemberStmt(db, nm),
      activityStmt(db, { groupId: gid, userId: au.id, memberId: id, type: 'member.join', data: { memberId: id, memberName: name }, now }),
      gid,
      now,
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const again = (await getMembers(db, gid)).find(m => m.user_id === au.id && m.active);
    if (again) return json(c, { groupId: gid, memberId: again.id });
    throw err;
  }
  return json(c, { groupId: gid, memberId: id });
});

// ---------- claim links ----------

groupRoutes.get('/claim/:token', async c => {
  const row = (await usableClaim(c.env.DB, c.req.param('token'))) ?? fail(400, 'code_invalid', 'This link is not valid anymore');
  const info: ClaimInfoDTO = {
    group: { id: row.group_id, name: row.g_name, emoji: row.g_emoji, color: row.g_color },
    member: { id: row.member_id, name: row.m_name, color: row.m_color },
    expiresAt: row.expires_at,
  };
  return json(c, info);
});

groupRoutes.post('/claim/:token', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const row = (await usableClaim(db, c.req.param('token'))) ?? fail(400, 'code_invalid', 'This link is not valid anymore');
  const mine = await db.prepare('SELECT * FROM members WHERE group_id = ? AND user_id = ?').bind(row.group_id, au.id).first<MemberRow>();
  if (mine?.active) fail(409, 'already_member', 'You are already in this group', { groupId: row.group_id, memberId: mine.id });
  await assertGroupRoom(db, [{ id: au.id, label: 'You' }]);
  const makeAdmin = !(await hasLinkedAdmin(db, row.group_id));
  let version: number | null;
  try {
    version = await claimMember(db, {
      groupId: row.group_id, memberId: row.member_id, memberName: row.m_name, userId: au.id, now: nowISO(), makeAdmin, tokenId: row.token_id,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    version = null;
  }
  if (version === null) fail(409, 'member_claimed', `${row.m_name} is already linked to an account`);
  await refreshSummary(db, row.group_id);
  return json(c, { groupId: row.group_id, memberId: row.member_id });
});

// ---------- friends ----------

/** The 1:1 ledger with a person: reuse the pair group we are both active in, else create one. */
groupRoutes.post('/friends', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const body = await readJson(c, FriendSchema);
  const user = (await getUser(db, au.id)) ?? fail(401, 'unauthorized', 'Sign in first');
  const email = normEmail(body.email);
  const other = email ? await getUserByEmail(db, email) : null;
  if (other && other.id === user.id) fail(400, 'bad_request', 'That is your own email');

  const existing = other
    ? await db
        .prepare(
          `SELECT g.id FROM groups g
           JOIN members a ON a.group_id = g.id AND a.user_id = ? AND a.active = 1
           JOIN members b ON b.group_id = g.id AND b.user_id = ? AND b.active = 1
           WHERE g.type = 'pair' AND g.deleted_at IS NULL
           ORDER BY g.updated_at DESC LIMIT 1`,
        )
        .bind(user.id, other.id)
        .first<{ id: string }>()
    : await db
        .prepare(
          `SELECT g.id FROM groups g
           JOIN members a ON a.group_id = g.id AND a.user_id = ? AND a.active = 1
           JOIN members b ON b.group_id = g.id AND b.user_id IS NULL AND b.active = 1 AND lower(trim(b.name)) = lower(?)
           WHERE g.type = 'pair' AND g.deleted_at IS NULL
           ORDER BY g.updated_at DESC LIMIT 1`,
        )
        .bind(user.id, body.name)
        .first<{ id: string }>();
  if (existing) return json(c, { groupId: existing.id });

  await assertGroupRoom(db, other ? [{ id: user.id, label: 'You' }, { id: other.id, label: body.name }] : [{ id: user.id, label: 'You' }]);
  if (other) await limitLinks(db, user.id, 1);
  const gid = newId();
  const now = nowISO();
  const myMemberId = newId();
  const theirId = newId();
  const name = [...`${user.name} & ${body.name}`].slice(0, 80).join('').trim();
  const data: ActivityData = { groupName: name };
  await db.batch([
    insertGroupStmt(db, { id: gid, name, type: 'pair', currency: user.currency, emoji: '', color: colorFor(gid), simplify: true, createdBy: user.id, now }),
    insertMemberStmt(db, { id: myMemberId, groupId: gid, userId: user.id, name: user.name, color: user.color, role: 'admin', sort: 0, now }),
    // Both people of a 1:1 ledger are admins: either may rename or delete it.
    insertMemberStmt(db, { id: theirId, groupId: gid, userId: other?.id ?? null, name: body.name, color: pickColor([user.color], other?.color, theirId), role: 'admin', sort: 1, now }),
    activityStmt(db, { groupId: gid, userId: user.id, memberId: myMemberId, type: 'group.create', data, now }),
  ]);
  await refreshSummary(db, gid);
  return json(c, { groupId: gid });
});
