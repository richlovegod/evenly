// The push sender (docs/PLAN-push-scan-cookies.md section 2.2). Activity rows that may notify
// people carry push_at (services/activity.ts pushAtFor). The minutely cron, and POST /api/push/run,
// send what is due:
// 1. Messages an earlier run could not fit (push_pending, step 7) go first, every person's newest
//    device before anyone's second: the whole budget when no group is due, else half of it (rounded
//    up) and then whatever room the groups leave. Kept messages that can no longer go (a day old, or
//    their device moved to another account or lost its session) are deleted before any is taken.
// 2. A group is due when its newest pending row is older than the hold (PUSH_HOLD_SECONDS, default
//    30, so bursts merge and undone entries drop out), or its oldest one has waited 4 minutes.
//    Groups nobody can hear (deleted, or no active member with a working device besides the one
//    account that wrote all their pending rows) are cleared first and never use a claim, and due
//    groups take turns by the account that wrote them, so one account's backlog of groups cannot
//    hold up everyone else's.
// 3. Its rows are claimed (UPDATE ... SET push_at = NULL ... RETURNING, so no row goes out twice)
//    in the same batch that reads the group, its members with their language and prefs, and their
//    devices.
// 4. The rows of one entry merge: a create that was deleted again sends nothing (an undo), a create
//    with edits sends one "added" with the last values, and rows without a create send nothing.
// 5. Who hears about it: active members whose account was linked when it happened, never anyone
//    who made the change. An expense reaches the members in its nets (payers and people with a
//    share), a payment its sender and recipient, a join everyone else, an add the added person, a
//    new group the others in it, an import everyone else, a friend invite accepted the link's
//    owner; then each person's prefs.
// 6. One notification per person per group per run (pushText.ts, in the person's language).
// 7. At most PUSH_MAX_PER_RUN messages per run (default 12). When a group does not fit in what is
//    left and push_pending was empty, what fits goes now (every person's newest device first), the
//    rest waits in push_pending for the next runs, and the run claims nothing more. While
//    push_pending still holds such a rest, a group that does not fit waits whole instead, and
//    smaller groups after it still go: its rows get their push_at back, and a group that more
//    devices can hear than a run sends is not even claimed. So push_pending holds what is left of
//    one group at most, a busy group's new rows merge while its rest goes out, and nothing is
//    dropped.
// 8. 404 or 410 deletes the subscription; other failures count, and 5 in a row delete it.
// Workers Free gives a cron run 10 ms of CPU, 50 subrequests and 50 D1 calls (a batch is one): a
// run makes one D1 call per group it claims plus at most three, each message costs one fetch and
// one ECDH, and the number of claims shrinks as the budget grows so both stay under 50. Rows and
// kept messages more than a day old are dropped instead of sent.

import type { Portion } from '../../shared/split';
import type { ActivityData, Locale, PushPrefsDTO } from '../../shared/types';
import { parseJSON } from '../db';
import type { Env } from '../env';
import { fromB64url } from '../http';
import { pushNotice, type PushItem, type PushPerson } from './pushText';
import { chunk, placeholders } from './summary';
import { loadVapid, sendPush, type PushMessage, type Vapid } from './webpush';

const HOLD_DEFAULT_S = 30;
const HOLD_MAX_S = 3600;
/** A busy group still hears something after this long. */
const CAP_MS = 4 * 60_000;
/** Older rows are dropped, not sent (also the push services' TTL). */
const STALE_MS = 86_400_000;
const BUDGET_DEFAULT = 12;
const BUDGET_MAX = 40;
/** Groups claimed per run at most (one D1 call each). */
const GROUPS_PER_RUN = 10;
/** Due groups a run looks at: more than it claims, since one too big to fit while kept messages
 *  are left is passed over without a claim. */
const CANDIDATES = 2 * GROUPS_PER_RUN;
/** Workers Free: 50 subrequests per invocation, every fetch and every D1 call (a batch is one). */
const SUBREQUESTS = 50;
/** Kept for the start batch, the call that keeps the rest of a group or finishes a run that started
 *  with kept messages left (never both), the delivery batch and POST /api/push/run's own sign-in
 *  (two), with one to spare. */
const SUBREQUESTS_KEPT = 6;
/** Failed pushes in a row before a subscription is deleted. */
export const FAILURES_MAX = 5;

const enc = new TextEncoder();
const dec = new TextDecoder();
const iso = (ms: number): string => new Date(ms).toISOString();

export interface PushRunResult {
  /** Groups whose pending rows this run handled. */
  groups: number;
  /** Messages the push services accepted. */
  sent: number;
  /** Subscriptions deleted because the push service said they are gone (404 or 410). */
  removed: number;
  /** Messages that failed otherwise (counted on the subscription; 5 in a row delete it). */
  failed: number;
}

/** PUSH_HOLD_SECONDS: 0 (staging) up to an hour; empty or not a number means 30. */
export function holdSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return HOLD_DEFAULT_S;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(HOLD_MAX_S, Math.floor(n)) : HOLD_DEFAULT_S;
}

/** PUSH_MAX_PER_RUN: 1 to 40; empty or not a number means 12. */
export function budgetOf(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return BUDGET_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(BUDGET_MAX, Math.floor(n)) : BUDGET_DEFAULT;
}

/** users.notify_prefs: anything but an explicit false is on. */
export function parsePrefs(raw: string | null | undefined): PushPrefsDTO {
  const v = parseJSON<unknown>(raw, null);
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return { expenses: o.expenses !== false, payments: o.payments !== false, joins: o.joins !== false };
}

// ---------- rows ----------

/** An activity row as the claim returns it; `seq` (the rowid) orders rows written in the same millisecond. */
export interface ClaimedRow {
  seq: number;
  id: string;
  group_id: string;
  user_id: string | null;
  member_id: string | null;
  type: string;
  expense_id: string | null;
  data: string;
  created_at: string;
}

/** A member of the group with the account's language and prefs (LEFT JOIN users). */
export interface PushMemberRow {
  id: string;
  user_id: string | null;
  name: string;
  active: number;
  /** When the account was linked to this member (created with it, joined, or claimed it). */
  claimed_at: string | null;
  locale: string | null;
  notify_prefs: string | null;
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Who paid and who received, for payments whose nets do not say it. */
interface EntryRow {
  id: string;
  payers: string;
  shares: string;
}

export interface ClaimedGroup {
  /** null when the group was deleted (its rows are dropped). */
  group: { id: string; name: string; emoji: string; type: string } | null;
  rows: ClaimedRow[];
  members: PushMemberRow[];
  /** Devices of the active members, each person's most recently working one first. */
  subscriptions: SubscriptionRow[];
  entries: EntryRow[];
}

/** One message for one device, ready to send. */
export interface Outgoing {
  subId: string;
  /** The account it was written for (a device that moved to another account by then gets nothing). */
  userId: string;
  /** 0 for a person's newest device, 1 for the next... */
  rank: number;
  message: PushMessage;
}

/** A message an earlier run kept for later, as the start of a run takes it out of push_pending. */
interface KeptRow {
  id: number;
  sub_id: string;
  user_id: string;
  rank: number;
  payload: string;
  urgency: string;
  created_at: string;
}

const ENTRY_TYPES = new Set(['expense.create', 'expense.update', 'expense.delete', 'expense.restore']);

function rows<T>(r: D1Result | undefined): T[] {
  return (r?.results ?? []) as T[];
}

function dataOf(raw: string): ActivityData {
  const v = parseJSON<unknown>(raw, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as ActivityData) : {};
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function numbers(nets: ActivityData['nets']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(nets && typeof nets === 'object' ? nets : {})) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

const byTime = (a: { at: string; seq: number }, b: { at: string; seq: number }): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq;

/** A subscription as a message to send, or null when its stored keys cannot be read. */
export function pushMessageFor(s: SubscriptionRow, payload: Uint8Array, urgency: 'normal' | 'low'): PushMessage | null {
  try {
    const p256dh = fromB64url(s.p256dh);
    const auth = fromB64url(s.auth);
    if (p256dh.length !== 65 || auth.length !== 16) return null;
    return { endpoint: s.endpoint, keys: { p256dh, auth }, payload, urgency };
  } catch {
    return null;
  }
}

// ---------- what to send (pure) ----------

type Pref = keyof PushPrefsDTO;

interface Pending {
  item: PushItem;
  at: string;
  seq: number;
  pref: Pref;
  /** User ids that hear about it. */
  to: string[];
}

/**
 * The messages for one claimed group: who hears about what, merged per person into one
 * notification, one message per device. Sorted by device rank, so cutting the list keeps every
 * person's newest device.
 */
export function groupMessages(g: ClaimedGroup, nowMs: number): Outgoing[] {
  const group = g.group;
  if (!group || !g.rows.length) return [];
  const staleBefore = iso(nowMs - STALE_MS);
  const list = g.rows.filter(r => r.created_at >= staleBefore).map(r => ({ ...r, at: r.created_at })).sort(byTime);

  const byId = new Map(g.members.map(m => [m.id, m]));
  const byUser = new Map<string, PushMemberRow>();
  for (const m of g.members) if (m.active && m.user_id) byUser.set(m.user_id, m);
  const entries = new Map(g.entries.map(e => [e.id, e]));

  const person = (memberId: string): PushPerson => ({ id: memberId, name: byId.get(memberId)?.name ?? '' });
  /** The actor as the feed names them: their member in this group, else their account's member here. */
  const actorOf = (r: ClaimedRow): PushPerson => {
    const m = (r.member_id ? byId.get(r.member_id) : undefined) ?? (r.user_id ? g.members.find(x => x.user_id === r.user_id) : undefined);
    return { id: r.member_id ?? m?.id ?? null, name: m?.name ?? '' };
  };
  /**
   * User ids of these members that can hear about something that happened at `at`: active, with
   * an account that was already linked then (someone who joined a minute later was not "added"
   * when the group was made), and none of the actors.
   */
  const hearing = (memberIds: Iterable<string>, actors: readonly (string | null)[], at: string): string[] => {
    const out = new Set<string>();
    for (const id of memberIds) {
      const m = byId.get(id);
      if (m && m.active && m.user_id && (!m.claimed_at || m.claimed_at <= at) && !actors.includes(m.user_id)) out.add(m.user_id);
    }
    return [...out];
  };
  const everyoneBut = (actors: readonly (string | null)[], at: string): string[] => hearing([...byUser.values()].map(m => m.id), actors, at);

  const pending: Pending[] = [];
  const perEntry = new Map<string, typeof list>();
  const joined = new Set<string>();
  const added = new Set<string>();
  const imports = new Map<string, Extract<PushItem, { kind: 'import' }>>();
  for (const r of list) {
    const d = dataOf(r.data);
    if (ENTRY_TYPES.has(r.type)) {
      if (!r.expense_id) continue;
      const same = perEntry.get(r.expense_id);
      if (same) same.push(r);
      else perEntry.set(r.expense_id, [r]);
      continue;
    }
    switch (r.type) {
      case 'member.join':
      case 'member.claim': {
        const mid = d.memberId ?? r.member_id ?? r.id;
        if (joined.has(mid)) break;
        joined.add(mid);
        pending.push({ item: { kind: 'join', name: str(d.memberName) || actorOf(r).name }, at: r.at, seq: r.seq, pref: 'joins', to: everyoneBut([r.user_id], r.at) });
        break;
      }
      case 'member.add': {
        // Only the added person hears it, and only when the member is linked to an account.
        if (!d.memberId || added.has(d.memberId)) break;
        added.add(d.memberId);
        pending.push({ item: { kind: 'add', actor: actorOf(r) }, at: r.at, seq: r.seq, pref: 'joins', to: hearing([d.memberId], [r.user_id], r.at) });
        break;
      }
      case 'friend.join':
        // Someone accepted a friend invite link: the link's owner (data.memberId) hears it.
        if (!d.memberId) break;
        pending.push({ item: { kind: 'invite', actor: actorOf(r) }, at: r.at, seq: r.seq, pref: 'joins', to: hearing([d.memberId], [r.user_id], r.at) });
        break;
      case 'group.create':
        pending.push({ item: { kind: 'create', actor: actorOf(r) }, at: r.at, seq: r.seq, pref: 'joins', to: everyoneBut([r.user_id], r.at) });
        break;
      case 'group.update': {
        // A Splitwise import arrives as one row per request (200 entries each): one summary per importer.
        const c = d.changes?.[0];
        const n = Number(c?.to);
        if (c?.field !== 'import' || !Number.isFinite(n) || n <= 0) break;
        const prev = imports.get(r.user_id ?? '');
        if (prev) {
          prev.count += n;
          break;
        }
        const item: Extract<PushItem, { kind: 'import' }> = { kind: 'import', actor: actorOf(r), count: n };
        imports.set(r.user_id ?? '', item);
        pending.push({ item, at: r.at, seq: r.seq, pref: 'expenses', to: everyoneBut([r.user_id], r.at) });
        break;
      }
    }
  }

  for (const [eid, rowsOfEntry] of perEntry) {
    const start = rowsOfEntry.findIndex(r => r.type === 'expense.create');
    if (start < 0) continue; // edits, deletes and restores of older entries stay in the feed only
    const create = rowsOfEntry[start];
    let alive = true;
    let last = create;
    for (const r of rowsOfEntry.slice(start + 1)) {
      if (r.type === 'expense.delete') alive = false;
      else if (r.type === 'expense.restore') {
        alive = true;
        last = r;
      } else if (r.type === 'expense.update') last = r;
    }
    if (!alive) continue; // added and deleted again: an undo
    const d = dataOf(last.data);
    // Everyone who touched the entry already knows about it.
    const actors = rowsOfEntry.map(r => r.user_id);
    const when = { at: create.at, seq: create.seq };
    if (d.kind === 'payment') {
      const nets = Object.entries(numbers(d.nets));
      let payer = nets.find(([, v]) => v > 0)?.[0];
      let payee = nets.find(([, v]) => v < 0)?.[0];
      const stored = entries.get(eid);
      if ((!payer || !payee) && stored) {
        // The converted amount rounded to 0 (both nets 0): the entry itself says who paid whom.
        payer = parseJSON<Portion[]>(stored.payers, [])[0]?.memberId;
        payee = parseJSON<Portion[]>(stored.shares, [])[0]?.memberId;
      }
      if (!payer || !payee) continue;
      pending.push({
        item: {
          kind: 'payment', actor: actorOf(create), expenseId: eid, from: person(payer), to: person(payee), amount: num(d.amount),
          currency: str(d.currency) || str(d.groupCurrency),
        },
        ...when,
        pref: 'payments',
        to: hearing([payer, payee], actors, when.at),
      });
    } else {
      const nets = numbers(d.nets);
      let involved = Object.keys(nets);
      const stored = entries.get(eid);
      if (!involved.length && stored) {
        // No nets (a rate that could not convert): the payers and the people with a share.
        involved = [...parseJSON<Portion[]>(stored.payers, []), ...parseJSON<Portion[]>(stored.shares, [])].map(p => p.memberId);
      }
      pending.push({
        item: {
          kind: 'expense', actor: actorOf(create), expenseId: eid, description: str(d.description), amount: num(d.amount), currency: str(d.currency),
          nets, groupCurrency: str(d.groupCurrency) || str(d.currency),
        },
        ...when,
        pref: 'expenses',
        to: hearing(involved, actors, when.at),
      });
    }
  }
  pending.sort(byTime);

  // One notification per person: their items in the order they happened, filtered by their prefs.
  const perUser = new Map<string, PushItem[]>();
  const prefs = new Map<string, PushPrefsDTO>();
  for (const p of pending) {
    for (const uid of p.to) {
      const m = byUser.get(uid);
      if (!m) continue;
      let pr = prefs.get(uid);
      if (!pr) prefs.set(uid, (pr = parsePrefs(m.notify_prefs)));
      if (!pr[p.pref]) continue;
      const items = perUser.get(uid);
      if (items) items.push(p.item);
      else perUser.set(uid, [p.item]);
    }
  }
  const devices = new Map<string, SubscriptionRow[]>();
  for (const s of g.subscriptions) {
    const same = devices.get(s.user_id);
    if (same) same.push(s);
    else devices.set(s.user_id, [s]);
  }

  const out: (Outgoing & { order: number })[] = [];
  let order = 0;
  for (const [uid, items] of perUser) {
    const subs = devices.get(uid);
    const m = byUser.get(uid);
    if (!subs?.length || !m) continue;
    const locale: Locale = m.locale === 'en' ? 'en' : 'zh-TW';
    const notice = pushNotice(group, items, { memberId: m.id, locale });
    if (!notice) continue;
    const payload = enc.encode(JSON.stringify(notice.payload));
    let rank = 0;
    for (const s of subs) {
      const message = pushMessageFor(s, payload, notice.urgency);
      if (message) out.push({ subId: s.id, userId: uid, rank: rank++, order, message });
    }
    order++;
  }
  out.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return out.map(({ subId, userId, rank, message }) => ({ subId, userId, rank, message }));
}

// ---------- D1 ----------

/** Groups with due rows (?1 the hold cutoff, ?2 the 4-minute cutoff), one row each. */
const DUE_FROM = `FROM activity WHERE push_at IS NOT NULL
  GROUP BY group_id HAVING MAX(push_at) <= ?1 OR MIN(push_at) <= ?2`;

/** Over a group's pending rows: the one account that wrote all of them, else NULL. */
const ONLY_ACTOR = 'CASE WHEN COUNT(DISTINCT user_id) = 1 AND COUNT(user_id) = COUNT(*) THEN MIN(user_id) END';

/**
 * FROM and WHERE for the devices that can hear due group `d` (a row with group_id and only_actor):
 * those on a live session (the parameter `now`) of its active members with an account, other than
 * the one account that wrote every pending row of the group (nobody hears about their own change).
 */
const devicesHearing = (d: string, now: string): string => `members m
  JOIN push_subscriptions s ON s.user_id = m.user_id
  JOIN sessions se ON se.id = s.session_id AND se.expires_at > ${now}
  WHERE m.group_id = ${d}.group_id AND m.active = 1 AND m.user_id IS NOT NULL AND m.user_id IS NOT ${d}.only_actor`;

/**
 * Clears the due rows of groups nobody can hear (?3 now): deleted groups, and groups where no
 * active member with an account has a device on a live session, other than the one account that
 * wrote every pending row of the group. Decided per group, not per row: the rows of an entry merge,
 * so someone else's delete of a new entry must stay with its create (an undo sends nothing).
 */
const CLEAR_UNHEARD = `UPDATE activity SET push_at = NULL
  WHERE push_at IS NOT NULL AND push_at <= ?1 AND group_id IN (
    SELECT d.group_id FROM (SELECT group_id, ${ONLY_ACTOR} AS only_actor ${DUE_FROM}) d
    WHERE NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = d.group_id AND g.deleted_at IS NULL)
       OR NOT EXISTS (SELECT 1 FROM ${devicesHearing('d', '?3')}))`;

/**
 * The due groups to look at (at most ?3), taking turns by the account that wrote each group's oldest
 * pending row: everyone's longest waiting group first, then everyone's second... So an account
 * with a backlog of groups gets one claim per turn, like everyone else. Each comes with the number
 * of devices that can hear it (?4 now), counted up to ?5: the most messages it can make, so while
 * kept messages are left a run passes over a group too big for any run without touching its rows.
 */
const DUE_GROUPS = `WITH d AS (SELECT group_id, MIN(push_at) AS oldest, ${ONLY_ACTOR} AS only_actor ${DUE_FROM}),
  f AS (
    SELECT group_id, oldest, only_actor,
      (SELECT a.user_id FROM activity a WHERE a.group_id = d.group_id AND a.push_at = d.oldest ORDER BY a.rowid LIMIT 1) AS actor
    FROM d),
  t AS (
    SELECT group_id, oldest, only_actor, ROW_NUMBER() OVER (PARTITION BY actor ORDER BY oldest, group_id) AS turn FROM f
    ORDER BY turn, oldest, group_id LIMIT ?3)
  SELECT group_id, (SELECT COUNT(*) FROM (SELECT 1 FROM ${devicesHearing('t', '?4')} LIMIT ?5)) AS devices FROM t
  ORDER BY turn, oldest, group_id`;

/**
 * Kept messages that can no longer go: a day old (?1), or their device moved to another account
 * or has no live session (?2 now). Deleted before a run takes any, so they never use its budget.
 */
const STALE_KEPT = `DELETE FROM push_pending WHERE created_at < ?1 OR NOT EXISTS (
  SELECT 1 FROM push_subscriptions s JOIN sessions se ON se.id = s.session_id AND se.expires_at > ?2
  WHERE s.id = push_pending.sub_id AND s.user_id = push_pending.user_id)`;

/**
 * Two statements for a batch that take the next kept messages out of push_pending, at most `limit`
 * (an SQL expression over `params`), every person's newest device first, then the oldest: their
 * devices on live sessions, read before the DELETE ... RETURNING takes the rows (so two runs never
 * send one twice).
 */
function takeKept(db: D1Database, limit: string, params: readonly unknown[], nowIso: string): D1PreparedStatement[] {
  const next = `FROM push_pending ORDER BY rank, id LIMIT ${limit}`;
  return [
    db
      .prepare(
        `SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
         JOIN sessions se ON se.id = s.session_id AND se.expires_at > ?${params.length + 1}
         WHERE s.id IN (SELECT sub_id ${next})`,
      )
      .bind(...params, nowIso),
    db.prepare(`DELETE FROM push_pending WHERE id IN (SELECT id ${next}) RETURNING id, sub_id, user_id, rank, payload, urgency, created_at`).bind(...params),
  ];
}

interface Taken {
  /** Messages earlier runs kept, ready to send (the rows are gone: this run owns them). */
  kept: Outgoing[];
  /** Kept messages deleted or taken but not sent: a day old, or their device moved or lost its session. */
  dropped: number;
}

/** The messages in the two results of takeKept. */
function takenFrom(devicesRes: D1Result | undefined, takenRes: D1Result | undefined, nowMs: number): Taken {
  const devices = new Map(rows<SubscriptionRow>(devicesRes).map(s => [s.id, s]));
  const staleBefore = iso(nowMs - STALE_MS);
  const taken = rows<KeptRow>(takenRes).sort((a, b) => a.rank - b.rank || a.id - b.id);
  const kept: Outgoing[] = [];
  for (const k of taken) {
    const s = devices.get(k.sub_id);
    // Gone stale since STALE_KEPT ran (a day old, a device that moved to another account, or one
    // whose session ended) or, below, keys that cannot be read: dropped.
    if (k.created_at < staleBefore || !s || s.user_id !== k.user_id) continue;
    const message = pushMessageFor(s, enc.encode(k.payload), k.urgency === 'low' ? 'low' : 'normal');
    if (message) kept.push({ subId: s.id, userId: s.user_id, rank: k.rank, message });
  }
  return { kept, dropped: taken.length - kept.length };
}

interface RunStart extends Taken {
  /** push_pending was empty after the take, so a group that does not fit may keep its rest there. */
  drained: boolean;
  /** Due groups in turn order, with the most messages each can make (counted up to budget + 1). */
  due: { id: string; devices: number }[];
}

/**
 * The first D1 call of a run (one batch, one transaction): clear the groups nobody can hear,
 * delete the kept messages that can no longer go, take the next kept messages out of push_pending
 * (the whole budget, or half of it rounded up when a group is due, so the group can go in this run
 * too), and read the due groups.
 */
async function startRun(db: D1Database, budget: number, holdCutoff: string, capCutoff: string, nowMs: number): Promise<RunStart> {
  const nowIso = iso(nowMs);
  const share = Math.ceil(budget / 2);
  const res = await db.batch([
    db.prepare(CLEAR_UNHEARD).bind(holdCutoff, capCutoff, nowIso),
    db.prepare(STALE_KEPT).bind(iso(nowMs - STALE_MS), nowIso),
    ...takeKept(db, `CASE WHEN EXISTS (SELECT 1 ${DUE_FROM}) THEN ?3 ELSE ?4 END`, [holdCutoff, capCutoff, share, budget], nowIso),
    db.prepare('SELECT EXISTS (SELECT 1 FROM push_pending) AS more'),
    db.prepare(DUE_GROUPS).bind(holdCutoff, capCutoff, CANDIDATES, nowIso, budget + 1),
  ]);
  const taken = takenFrom(res[2], res[3], nowMs);
  return {
    kept: taken.kept,
    dropped: (res[1]?.meta?.changes ?? 0) + taken.dropped,
    drained: !Number(rows<{ more: number }>(res[4])[0]?.more ?? 0),
    due: rows<{ group_id: string; devices: number }>(res[5]).map(x => ({ id: x.group_id, devices: Number(x.devices) })),
  };
}

/**
 * The last D1 call before the sends of a run that started with kept messages left (so it keeps no
 * rest of its own), one batch: the claimed groups that did not fit after all get their rows back
 * (push_at again, as written: it is always the row's created_at), and up to `more` kept messages
 * take the room the groups left.
 */
async function finishRun(db: D1Database, back: readonly string[], more: number, nowMs: number): Promise<Taken> {
  const stmts: D1PreparedStatement[] = [];
  if (back.length) {
    stmts.push(db.prepare('UPDATE activity SET push_at = created_at WHERE push_at IS NULL AND id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(back)));
  }
  if (more > 0) stmts.push(...takeKept(db, '?1', [more], iso(nowMs)));
  if (!stmts.length) return { kept: [], dropped: 0 };
  const res = await db.batch(stmts);
  return more > 0 ? takenFrom(res[res.length - 2], res[res.length - 1], nowMs) : { kept: [], dropped: 0 };
}

/** Claim a group's due rows and read what the messages need, in one batch (one transaction). */
export async function claimGroup(db: D1Database, gid: string, holdCutoff: string, nowIso: string): Promise<ClaimedGroup> {
  const due = 'group_id = ?1 AND push_at IS NOT NULL AND push_at <= ?2';
  const res = await db.batch([
    // Before the claim, while the rows still carry push_at. It starts from the pending rows (the
    // partial index) and looks each entry up by its key: the group's own index would walk every
    // entry it has, since D1 keeps no table statistics.
    db
      .prepare(
        `SELECT DISTINCT e.id, e.payers, e.shares FROM activity a JOIN expenses e ON e.id = a.expense_id
         WHERE a.group_id = ?1 AND a.push_at IS NOT NULL AND a.push_at <= ?2 AND a.type = 'expense.create' AND e.group_id = ?1`,
      )
      .bind(gid, holdCutoff),
    db
      .prepare(`UPDATE activity SET push_at = NULL WHERE ${due} RETURNING rowid AS seq, id, group_id, user_id, member_id, type, expense_id, data, created_at`)
      .bind(gid, holdCutoff),
    db.prepare('SELECT id, name, emoji, type FROM groups WHERE id = ? AND deleted_at IS NULL').bind(gid),
    db
      .prepare(
        `SELECT m.id, m.user_id, m.name, m.active, m.claimed_at, u.locale, u.notify_prefs
         FROM members m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.group_id = ? ORDER BY m.sort, m.created_at`,
      )
      .bind(gid),
    // Each person's devices, the one in use first: its session's last use (renewed hourly by the
    // device's own requests), then its last accepted push. Every device a run reaches gets the same
    // last_ok_at, so that alone would leave the order to the endpoint hash.
    db
      .prepare(
        `SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
         JOIN sessions se ON se.id = s.session_id AND se.expires_at > ?2
         WHERE s.user_id IN (SELECT user_id FROM members WHERE group_id = ?1 AND active = 1 AND user_id IS NOT NULL)
         ORDER BY s.user_id, se.last_used_at DESC, COALESCE(s.last_ok_at, s.created_at) DESC, s.created_at DESC, s.id`,
      )
      .bind(gid, nowIso),
  ]);
  return {
    entries: rows<EntryRow>(res[0]),
    rows: rows<ClaimedRow>(res[1]),
    group: rows<NonNullable<ClaimedGroup['group']>>(res[2])[0] ?? null,
    members: rows<PushMemberRow>(res[3]),
    subscriptions: rows<SubscriptionRow>(res[4]),
  };
}

/**
 * Keep messages for the next runs (push_pending), one statement per person: they share one
 * payload. A device deleted or moved to another account since the claim is left out.
 */
async function keepForLater(db: D1Database, list: readonly Outgoing[], nowIso: string): Promise<void> {
  const people = new Map<string, { payload: Uint8Array; urgency: string; devices: [string, number][] }>();
  for (const o of list) {
    const p = people.get(o.userId);
    if (p) p.devices.push([o.subId, o.rank]);
    else people.set(o.userId, { payload: o.message.payload, urgency: o.message.urgency, devices: [[o.subId, o.rank]] });
  }
  if (!people.size) return;
  await db.batch(
    [...people].map(([uid, p]) =>
      db
        .prepare(
          `INSERT INTO push_pending (sub_id, user_id, rank, payload, urgency, created_at)
           SELECT s.id, s.user_id, json_extract(j.value, '$[1]'), ?3, ?4, ?5
           FROM json_each(?1) j JOIN push_subscriptions s ON s.id = json_extract(j.value, '$[0]') AND s.user_id = ?2
           ORDER BY j.key`,
        )
        .bind(JSON.stringify(p.devices), uid, dec.decode(p.payload), p.urgency, nowIso),
    ),
  );
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return '?';
  }
}

/**
 * Send the messages (all at once) and record each answer on its subscription, in one batch:
 * success sets last_ok_at, 404 or 410 deletes it, anything else counts a failure (deleted at 5).
 */
export async function deliverPushes(
  db: D1Database,
  vapid: Vapid,
  list: readonly { subId: string; message: PushMessage }[],
  nowMs = Date.now(),
): Promise<Omit<PushRunResult, 'groups'>> {
  const statuses = await Promise.all(list.map(o => sendPush(vapid, o.message, nowMs)));
  const ok = new Set<string>();
  const gone = new Set<string>();
  const bad = new Set<string>();
  statuses.forEach((status, i) => {
    const id = list[i].subId;
    if (status >= 200 && status < 300) ok.add(id);
    else if (status === 404 || status === 410) gone.add(id);
    else {
      bad.add(id);
      // The host only: the rest of an endpoint identifies the device.
      console.warn(`push: ${hostOf(list[i].message.endpoint)} answered ${status || 'nothing'}`);
    }
  });
  const stmts: D1PreparedStatement[] = [];
  const each = (ids: Set<string>, sql: (marks: string) => string, ...extra: unknown[]) => {
    for (const part of chunk([...ids])) stmts.push(db.prepare(sql(placeholders(part.length))).bind(...extra, ...part));
  };
  each(bad, m => `UPDATE push_subscriptions SET failures = failures + 1 WHERE id IN (${m})`);
  each(bad, m => `DELETE FROM push_subscriptions WHERE failures >= ? AND id IN (${m})`, FAILURES_MAX);
  each(ok, m => `UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id IN (${m})`, iso(nowMs));
  each(gone, m => `DELETE FROM push_subscriptions WHERE id IN (${m})`);
  if (stmts.length) await db.batch(stmts);
  let sent = 0;
  let removed = 0;
  let failed = 0;
  for (const s of statuses) {
    if (s >= 200 && s < 300) sent++;
    else if (s === 404 || s === 410) removed++;
    else failed++;
  }
  return { sent, removed, failed };
}

// ---------- the run ----------

/** Send every due notification (steps 1 to 8 above). Never throws: it runs inside ctx.waitUntil. */
export async function runPushSender(env: Env, now: Date = new Date()): Promise<PushRunResult> {
  const out: PushRunResult = { groups: 0, sent: 0, removed: 0, failed: 0 };
  try {
    const db = env.DB;
    const nowMs = now.getTime();
    const vapid = await loadVapid(env);
    if (!vapid) {
      // Push is not set up (or its keys are broken): nothing can go out. Keep a day of rows for
      // when it is fixed, so the pending list cannot grow without end. Kept messages wait too, and
      // are dropped when they come up a day old.
      const stale = iso(nowMs - STALE_MS);
      await db.batch([
        db.prepare('UPDATE activity SET push_at = NULL WHERE push_at IS NOT NULL AND push_at < ?').bind(stale),
        // The privacy page promises a kept notification waits at most a day.
        db.prepare('DELETE FROM push_pending WHERE created_at < ?').bind(stale),
      ]);
      return out;
    }
    const budget = budgetOf(env.PUSH_MAX_PER_RUN);
    // Each claim is a D1 call and each message a fetch: together they stay under 50.
    let claimsLeft = Math.min(GROUPS_PER_RUN, SUBREQUESTS - SUBREQUESTS_KEPT - budget);
    const holdCutoff = iso(nowMs - holdSeconds(env.PUSH_HOLD_SECONDS) * 1000);
    const start = await startRun(db, budget, holdCutoff, iso(nowMs - CAP_MS), nowMs);
    const queue: Outgoing[] = start.kept;
    const later: Outgoing[] = [];
    /** Activity ids of claimed groups that did not fit after all, to get their push_at back. */
    const back: string[] = [];
    let waiting = 0;
    let dropped = start.dropped;
    for (const due of start.due) {
      if (queue.length >= budget || claimsLeft <= 0) break;
      const room = budget - queue.length;
      // While push_pending holds the rest of a group, a second rest could keep it growing: a group
      // that does not fit waits whole (its rows merge with what comes next) for a run with room for
      // it or one that starts with push_pending empty, and smaller groups still go. One that more
      // devices can hear than a run sends is not even claimed, so a big busy group costs nothing.
      if (!start.drained && due.devices > budget) {
        waiting++;
        continue;
      }
      let claimed: ClaimedGroup;
      claimsLeft--;
      try {
        claimed = await claimGroup(db, due.id, holdCutoff, iso(nowMs));
      } catch (err) {
        // Still send what the earlier claims took (their rows no longer carry push_at).
        console.error('push: claim failed', err);
        break;
      }
      if (!claimed.rows.length) continue; // another run took them
      let messages: Outgoing[];
      try {
        messages = groupMessages(claimed, nowMs);
      } catch (err) {
        // Its rows are dropped: giving them back would fail the same way every minute.
        console.error('push: could not build the messages of a group', err);
        continue;
      }
      if (!start.drained && messages.length > room) {
        // Its rows get push_at back, and it waits as above.
        back.push(...claimed.rows.map(r => r.id));
        waiting++;
        continue;
      }
      out.groups++;
      queue.push(...messages.slice(0, room));
      if (messages.length > room) {
        // push_pending was empty: the rest waits there for the next runs.
        later.push(...messages.slice(room));
        break;
      }
    }
    if (!start.drained && (back.length || queue.length < budget)) {
      // Rows given back, and the room the groups left for more kept messages, in one call (this run
      // keeps no rest, so it is the call that would have kept one).
      try {
        const more = await finishRun(db, back, budget - queue.length, nowMs);
        queue.push(...more.kept);
        dropped += more.dropped;
      } catch (err) {
        console.error(`push: could not finish the run (${waiting} groups waiting, ${back.length} rows to give back)`, err);
      }
    }
    if (!queue.length && !out.groups && !dropped && !waiting) return out;
    // Kept before sending: a run that stops while it sends still leaves them for the next one.
    if (later.length) await keepForLater(db, later, iso(nowMs)).catch(err => console.error(`push: could not keep ${later.length} messages for later`, err));
    if (queue.length) Object.assign(out, await deliverPushes(db, vapid, queue, nowMs));
    console.log(
      `push: ${out.groups} groups, ${out.sent} sent, ${out.removed} removed, ${out.failed} failed, ${later.length} kept for later, ${dropped} kept ones dropped, ${waiting} groups waiting`,
    );
  } catch (err) {
    console.error('push sender failed', err);
  }
  return out;
}
