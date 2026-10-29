// The push sender (docs/PLAN-push-scan-cookies.md section 2.2). Activity rows that may notify
// people carry push_at (services/activity.ts pushAtFor). The minutely cron, and POST /api/push/run,
// send what is due to two kinds of device: browsers (Web Push, webpush.ts: push_subscriptions) and
// iPhones with the app (APNs, apns.ts: apns_devices). Every step treats both alike (one budget,
// one claim, the same words, prefs and device order); only the send at the end differs:
// 1. Messages an earlier run could not fit (push_pending, and apns_pending for iPhones, step 7) go
//    first, every person's newest device before anyone's second: the whole budget when no group is
//    due, else half of it (rounded up) and then whatever room the groups leave. Kept messages that
//    can no longer go (a day old, or their device moved to another account or lost its session) are
//    deleted before any is taken.
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
// 7. At most PUSH_MAX_PER_RUN messages per run (default 12), browsers and iPhones together. When a
//    group does not fit in what is left and nothing was kept, what fits goes now (every person's
//    newest device first), the rest waits in push_pending and apns_pending for the next runs, and
//    the run claims nothing more. While such a rest is still kept, a group that does not fit waits
//    whole instead, and smaller groups after it still go: its rows get their push_at back, and a
//    group that more devices can hear than a run sends is not even claimed. So the two tables hold
//    what is left of one group at most, a busy group's new rows merge while its rest goes out, and
//    nothing is dropped.
// 8. Web Push: 404 or 410 deletes the subscription. APNs: 410, BadDeviceToken or
//    DeviceTokenNotForTopic deletes the iPhone. Other failures count, and 5 in a row delete the
//    device; an APNs answer that refuses this server's own request (403, its provider token)
//    counts on no device.
// Workers Free gives a cron run 10 ms of CPU, 50 subrequests and 50 D1 calls (a batch is one): a
// run makes one D1 call per group it claims plus at most three, each message costs one fetch (and
// a Web Push one an ECDH), and the number of claims shrinks as the budget grows so both stay under
// 50. Rows and kept messages more than a day old are dropped instead of sent.

import type { Portion } from '../../shared/split';
import type { ActivityData, Locale, PushPrefsDTO } from '../../shared/types';
import { parseJSON } from '../db';
import type { Env } from '../env';
import { fromB64url } from '../http';
import { apnsBody, apnsMessageFor, apnsOutcome, forgetApnsJwt, loadApns, sendApns, type Apns, type ApnsAnswer, type ApnsMessage, type ApnsOutcome } from './apns';
import { pushNotice, type PushItem, type PushNotice, type PushPerson } from './pushText';
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
  /** Messages the push services (and APNs) accepted. */
  sent: number;
  /** Devices deleted because the push service said they are gone (Web Push 404 or 410; APNs 410, BadDeviceToken, DeviceTokenNotForTopic). */
  removed: number;
  /** Messages that failed otherwise (counted on the device, 5 in a row delete it; an APNs refusal of the server's own request counts on none). */
  failed: number;
}

/** What can send: Web Push (null without usable VAPID keys) and APNs (null without its key). */
export interface Senders {
  vapid: Vapid | null;
  apns: Apns | null;
}

export async function loadSenders(env: Env): Promise<Senders> {
  const [vapid, apns] = await Promise.all([loadVapid(env), loadApns(env)]);
  return { vapid, apns };
}

/** The two kinds of device: a browser's Web Push subscription, an iPhone's APNs token. */
export type Channel = 'web' | 'apns';

/** The channel has its key: its devices can get messages. */
export const canSend = (s: Senders, ch: Channel): boolean => (ch === 'apns' ? !!s.apns : !!s.vapid);

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

/** A browser's subscription (push_subscriptions). */
export interface SubscriptionRow {
  /** The claim and the take say 'web'; a row read on its own may leave it out. */
  ch?: 'web';
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** An iPhone (apns_devices): `id` is its device token. */
export interface ApnsDeviceRow {
  ch: 'apns';
  id: string;
  user_id: string;
  environment: string;
  bundle_id: string;
}

/** A device that may get notifications. */
export type DeviceRow = SubscriptionRow | ApnsDeviceRow;

export const channelOf = (d: DeviceRow): Channel => (d.ch === 'apns' ? 'apns' : 'web');

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
  /** Devices of the active members, browsers and iPhones, each person's device in use first. */
  devices: DeviceRow[];
  entries: EntryRow[];
}

/** One message for one device, ready to send: `subId` is the subscription's id, or the iPhone's token. */
export type Delivery = { ch: 'web'; subId: string; message: PushMessage } | { ch: 'apns'; subId: string; message: ApnsMessage };

export type Outgoing = Delivery & {
  /** The account it was written for (a device that moved to another account by then gets nothing). */
  userId: string;
  /** 0 for a person's newest device, 1 for the next... */
  rank: number;
};

/** A message an earlier run kept for later, as a take returns it from push_pending or apns_pending. */
interface KeptRow {
  /** 0 push_pending (a browser), 1 apns_pending (an iPhone). */
  c: number;
  id: number;
  /** The subscription's id, or the iPhone's token. */
  sub_id: string;
  user_id: string;
  rank: number;
  /** The PushPayload JSON (encrypted when sent), or the APNs body (sent as it is). */
  payload: string;
  urgency: string;
  collapse_id: string | null;
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

/** A browser's message: `payload` is the PushPayload JSON, encrypted when it is sent. */
function webDelivery(s: SubscriptionRow, payload: Uint8Array, urgency: 'normal' | 'low'): Delivery | null {
  const message = pushMessageFor(s, payload, urgency);
  return message ? { ch: 'web', subId: s.id, message } : null;
}

/** An iPhone's message: `body` is the APNs JSON (apnsBody), sent as it is; `collapseId` web push's tag. */
function apnsDelivery(d: ApnsDeviceRow, body: string, urgency: 'normal' | 'low', collapseId: string | null): Delivery | null {
  const message = apnsMessageFor(d, body, urgency, collapseId);
  return message ? { ch: 'apns', subId: d.id, message } : null;
}

/** One device's message for a notification (POST /api/push/test), or null when its row cannot be used. */
export function deliveryFor(d: DeviceRow, notice: PushNotice): Delivery | null {
  return d.ch === 'apns'
    ? apnsDelivery(d, apnsBody(notice), notice.urgency, notice.payload.tag)
    : webDelivery(d, enc.encode(JSON.stringify(notice.payload)), notice.urgency);
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
 * notification, one message per device (a browser or an iPhone, the same words on both). Sorted by
 * device rank, so cutting the list keeps every person's newest device.
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
          nets, groupCurrency: str(d.groupCurrency) || str(d.currency), refund: d.kind === 'refund',
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
  const devices = new Map<string, DeviceRow[]>();
  for (const d of g.devices) {
    const same = devices.get(d.user_id);
    if (same) same.push(d);
    else devices.set(d.user_id, [d]);
  }

  const out: { o: Outgoing; order: number }[] = [];
  let order = 0;
  for (const [uid, items] of perUser) {
    const devs = devices.get(uid);
    const m = byUser.get(uid);
    if (!devs?.length || !m) continue;
    const locale: Locale = m.locale === 'en' ? 'en' : 'zh-TW';
    const notice = pushNotice(group, items, { memberId: m.id, locale });
    if (!notice) continue;
    // One payload per person and channel: every browser gets the same words, encrypted for it, and
    // every iPhone the same APNs body.
    const web = enc.encode(JSON.stringify(notice.payload));
    const apns = devs.some(d => d.ch === 'apns') ? apnsBody(notice) : '';
    let rank = 0;
    for (const d of devs) {
      const sent = d.ch === 'apns' ? apnsDelivery(d, apns, notice.urgency, notice.payload.tag) : webDelivery(d, web, notice.urgency);
      if (sent) out.push({ o: { ...sent, userId: uid, rank: rank++ }, order });
    }
    order++;
  }
  out.sort((a, b) => a.o.rank - b.o.rank || a.order - b.order);
  return out.map(x => x.o);
}

// ---------- D1 ----------

/** Groups with due rows (?1 the hold cutoff, ?2 the 4-minute cutoff), one row each. */
const DUE_FROM = `FROM activity WHERE push_at IS NOT NULL
  GROUP BY group_id HAVING MAX(push_at) <= ?1 OR MIN(push_at) <= ?2`;

/** Over a group's pending rows: the one account that wrote all of them, else NULL. */
const ONLY_ACTOR = 'CASE WHEN COUNT(DISTINCT user_id) = 1 AND COUNT(user_id) = COUNT(*) THEN MIN(user_id) END';

/** The tables of devices that get notifications: browsers, then iPhones (both have user_id and session_id). */
const DEVICE_TABLES = ['push_subscriptions', 'apns_devices'] as const;

/**
 * FROM and WHERE for the devices in `table` that can hear due group `d` (a row with group_id and
 * only_actor): those on a live session (the parameter `now`) of its active members with an
 * account, other than the one account that wrote every pending row of the group (nobody hears
 * about their own change).
 */
const devicesHearing = (table: (typeof DEVICE_TABLES)[number], d: string, now: string): string => `members m
  JOIN ${table} s ON s.user_id = m.user_id
  JOIN sessions se ON se.id = s.session_id AND se.expires_at > ${now}
  WHERE m.group_id = ${d}.group_id AND m.active = 1 AND m.user_id IS NOT NULL AND m.user_id IS NOT ${d}.only_actor`;

/**
 * Clears the due rows of groups nobody can hear (?3 now): deleted groups, and groups where no
 * active member with an account has a device (a browser or an iPhone) on a live session, other
 * than the one account that wrote every pending row of the group. Decided per group, not per row:
 * the rows of an entry merge, so someone else's delete of a new entry must stay with its create (an
 * undo sends nothing).
 */
const CLEAR_UNHEARD = `UPDATE activity SET push_at = NULL
  WHERE push_at IS NOT NULL AND push_at <= ?1 AND group_id IN (
    SELECT d.group_id FROM (SELECT group_id, ${ONLY_ACTOR} AS only_actor ${DUE_FROM}) d
    WHERE NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = d.group_id AND g.deleted_at IS NULL)
       OR (${DEVICE_TABLES.map(t => `NOT EXISTS (SELECT 1 FROM ${devicesHearing(t, 'd', '?3')})`).join(' AND ')}))`;

/**
 * The due groups to look at (at most ?3), taking turns by the account that wrote each group's oldest
 * pending row: everyone's longest waiting group first, then everyone's second... So an account
 * with a backlog of groups gets one claim per turn, like everyone else. Each comes with the number
 * of devices that can hear it (?4 now), browsers and iPhones, counted up to ?5: the most messages it
 * can make, so while kept messages are left a run passes over a group too big for any run without
 * touching its rows.
 */
const DUE_GROUPS = `WITH d AS (SELECT group_id, MIN(push_at) AS oldest, ${ONLY_ACTOR} AS only_actor ${DUE_FROM}),
  f AS (
    SELECT group_id, oldest, only_actor,
      (SELECT a.user_id FROM activity a WHERE a.group_id = d.group_id AND a.push_at = d.oldest ORDER BY a.rowid LIMIT 1) AS actor
    FROM d),
  t AS (
    SELECT group_id, oldest, only_actor, ROW_NUMBER() OVER (PARTITION BY actor ORDER BY oldest, group_id) AS turn FROM f
    ORDER BY turn, oldest, group_id LIMIT ?3)
  SELECT group_id, (SELECT COUNT(*) FROM (${DEVICE_TABLES.map(t => `SELECT 1 FROM ${devicesHearing(t, 't', '?4')}`).join(' UNION ALL ')} LIMIT ?5)) AS devices FROM t
  ORDER BY turn, oldest, group_id`;

/**
 * Kept messages that can no longer go, one statement per table: a day old (?1), or their device
 * moved to another account or has no live session (?2 now). Deleted before a run takes any, so
 * they never use its budget.
 */
const STALE_KEPT = [
  `DELETE FROM push_pending WHERE created_at < ?1 OR NOT EXISTS (
    SELECT 1 FROM push_subscriptions s JOIN sessions se ON se.id = s.session_id AND se.expires_at > ?2
    WHERE s.id = push_pending.sub_id AND s.user_id = push_pending.user_id)`,
  `DELETE FROM apns_pending WHERE created_at < ?1 OR NOT EXISTS (
    SELECT 1 FROM apns_devices a JOIN sessions se ON se.id = a.session_id AND se.expires_at > ?2
    WHERE a.token = apns_pending.token AND a.user_id = apns_pending.user_id)`,
];

/** Kept messages left in either table: a run that finds none may keep a rest of its own. */
const ANY_KEPT = 'SELECT EXISTS (SELECT 1 FROM push_pending) OR EXISTS (SELECT 1 FROM apns_pending) AS more';

/**
 * The ids, in table `c` (0 push_pending, 1 apns_pending), of the next `limit` kept messages over
 * both tables: every person's newest device first (rank), browsers before iPhones, then the oldest.
 */
const keptNext = (limit: string, c: 0 | 1): string => `SELECT id FROM (
    SELECT 0 AS c, id, rank FROM push_pending UNION ALL SELECT 1, id, rank FROM apns_pending
    ORDER BY rank, c, id LIMIT ${limit}) WHERE c = ${c}`;

/** Statements takeKept adds to a batch (takenFrom reads their results). */
const TAKE_STATEMENTS = 4;

/**
 * Statements for a batch that take the next kept messages out of both tables, at most `limit` (an
 * SQL expression over `params`): first their devices on live sessions, then the rows. Every
 * statement must see the same next `limit` rows, so the iPhones' rows are only marked at first
 * (taken = 1 leaves the order as it was), the browsers' rows are deleted, and then the marked ones;
 * the rows leave in the transaction that reads them, so two runs never send one twice.
 */
function takeKept(db: D1Database, limit: string, params: readonly unknown[], nowIso: string): D1PreparedStatement[] {
  const now = `?${params.length + 1}`;
  return [
    db
      .prepare(
        `SELECT 'web' AS ch, s.id, s.user_id, s.endpoint, s.p256dh, s.auth, NULL AS environment, NULL AS bundle_id FROM push_subscriptions s
           JOIN sessions se ON se.id = s.session_id AND se.expires_at > ${now}
           WHERE s.id IN (SELECT sub_id FROM push_pending WHERE id IN (${keptNext(limit, 0)}))
         UNION ALL
         SELECT 'apns', a.token, a.user_id, NULL, NULL, NULL, a.environment, a.bundle_id FROM apns_devices a
           JOIN sessions se ON se.id = a.session_id AND se.expires_at > ${now}
           WHERE a.token IN (SELECT token FROM apns_pending WHERE id IN (${keptNext(limit, 1)}))`,
      )
      .bind(...params, nowIso),
    db
      .prepare(`UPDATE apns_pending SET taken = 1 WHERE id IN (${keptNext(limit, 1)}) RETURNING 1 AS c, id, token AS sub_id, user_id, rank, payload, urgency, collapse_id, created_at`)
      .bind(...params),
    db
      .prepare(`DELETE FROM push_pending WHERE id IN (${keptNext(limit, 0)}) RETURNING 0 AS c, id, sub_id, user_id, rank, payload, urgency, NULL AS collapse_id, created_at`)
      .bind(...params),
    db.prepare('DELETE FROM apns_pending WHERE taken = 1'),
  ];
}

interface Taken {
  /** Messages earlier runs kept, ready to send (the rows are gone: this run owns them). */
  kept: Outgoing[];
  /** Kept messages deleted or taken but not sent: a day old, or their device moved or lost its session. */
  dropped: number;
}

/** The messages in the results of takeKept's statements (`res`, TAKE_STATEMENTS of them). */
function takenFrom(res: readonly (D1Result | undefined)[], nowMs: number, senders: Senders): Taken {
  const devices = new Map(rows<DeviceRow & { ch: Channel }>(res[0]).map(d => [d.ch + ' ' + d.id, d]));
  const staleBefore = iso(nowMs - STALE_MS);
  const taken = [...rows<KeptRow>(res[1]), ...rows<KeptRow>(res[2])].sort((a, b) => a.rank - b.rank || a.c - b.c || a.id - b.id);
  const kept: Outgoing[] = [];
  for (const k of taken) {
    const d = devices.get((k.c === 1 ? 'apns' : 'web') + ' ' + k.sub_id);
    // Gone stale since STALE_KEPT ran (a day old, a device that moved to another account, or one
    // whose session ended), a channel that cannot send now or, below, a row that cannot be used: dropped.
    if (k.created_at < staleBefore || !d || d.user_id !== k.user_id || !canSend(senders, channelOf(d))) continue;
    const urgency = k.urgency === 'low' ? 'low' : 'normal';
    const sent = d.ch === 'apns' ? apnsDelivery(d, k.payload, urgency, k.collapse_id) : webDelivery(d, enc.encode(k.payload), urgency);
    if (sent) kept.push({ ...sent, userId: d.user_id, rank: k.rank });
  }
  return { kept, dropped: taken.length - kept.length };
}

interface RunStart extends Taken {
  /** Nothing was kept after the take, so a group that does not fit may keep its rest. */
  drained: boolean;
  /** Due groups in turn order, with the most messages each can make (counted up to budget + 1). */
  due: { id: string; devices: number }[];
}

/**
 * The first D1 call of a run (one batch, one transaction): clear the groups nobody can hear,
 * delete the kept messages that can no longer go, take the next kept messages (the whole budget, or
 * half of it rounded up when a group is due, so the group can go in this run too), and read the due
 * groups.
 */
async function startRun(db: D1Database, budget: number, holdCutoff: string, capCutoff: string, nowMs: number, senders: Senders): Promise<RunStart> {
  const nowIso = iso(nowMs);
  const share = Math.ceil(budget / 2);
  const take = 1 + STALE_KEPT.length;
  const res = await db.batch([
    db.prepare(CLEAR_UNHEARD).bind(holdCutoff, capCutoff, nowIso),
    ...STALE_KEPT.map(sql => db.prepare(sql).bind(iso(nowMs - STALE_MS), nowIso)),
    ...takeKept(db, `CASE WHEN EXISTS (SELECT 1 ${DUE_FROM}) THEN ?3 ELSE ?4 END`, [holdCutoff, capCutoff, share, budget], nowIso),
    db.prepare(ANY_KEPT),
    db.prepare(DUE_GROUPS).bind(holdCutoff, capCutoff, CANDIDATES, nowIso, budget + 1),
  ]);
  const taken = takenFrom(res.slice(take, take + TAKE_STATEMENTS), nowMs, senders);
  let stale = 0;
  for (let i = 1; i < take; i++) stale += res[i]?.meta?.changes ?? 0;
  return {
    kept: taken.kept,
    dropped: stale + taken.dropped,
    drained: !Number(rows<{ more: number }>(res[take + TAKE_STATEMENTS])[0]?.more ?? 0),
    due: rows<{ group_id: string; devices: number }>(res[take + TAKE_STATEMENTS + 1]).map(x => ({ id: x.group_id, devices: Number(x.devices) })),
  };
}

/**
 * The last D1 call before the sends of a run that started with kept messages left (so it keeps no
 * rest of its own), one batch: the claimed groups that did not fit after all get their rows back
 * (push_at again, as written: it is always the row's created_at), and up to `more` kept messages
 * take the room the groups left.
 */
async function finishRun(db: D1Database, back: readonly string[], more: number, nowMs: number, senders: Senders): Promise<Taken> {
  const stmts: D1PreparedStatement[] = [];
  if (back.length) {
    stmts.push(db.prepare('UPDATE activity SET push_at = created_at WHERE push_at IS NULL AND id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(back)));
  }
  if (more > 0) stmts.push(...takeKept(db, '?1', [more], iso(nowMs)));
  if (!stmts.length) return { kept: [], dropped: 0 };
  const res = await db.batch(stmts);
  return more > 0 ? takenFrom(res.slice(res.length - TAKE_STATEMENTS), nowMs, senders) : { kept: [], dropped: 0 };
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
    // Each person's devices, browsers and iPhones together, the one in use first: its session's
    // last use (renewed hourly by the device's own requests), then its last accepted push. Every
    // device a run reaches gets the same last_ok_at, so that alone would leave the order to the ids.
    // (A compound SELECT orders by the first one's AS names.)
    db
      .prepare(
        `SELECT 'web' AS ch, s.id AS id, s.user_id AS user_id, s.endpoint, s.p256dh, s.auth, NULL AS environment, NULL AS bundle_id,
                se.last_used_at AS used, COALESCE(s.last_ok_at, s.created_at) AS ok, s.created_at AS made
           FROM push_subscriptions s JOIN sessions se ON se.id = s.session_id AND se.expires_at > ?2
           WHERE s.user_id IN (SELECT user_id FROM members WHERE group_id = ?1 AND active = 1 AND user_id IS NOT NULL)
         UNION ALL
         SELECT 'apns', a.token, a.user_id, NULL, NULL, NULL, a.environment, a.bundle_id,
                se.last_used_at, COALESCE(a.last_ok_at, a.created_at), a.created_at
           FROM apns_devices a JOIN sessions se ON se.id = a.session_id AND se.expires_at > ?2
           WHERE a.user_id IN (SELECT user_id FROM members WHERE group_id = ?1 AND active = 1 AND user_id IS NOT NULL)
         ORDER BY user_id, used DESC, ok DESC, made DESC, id`,
      )
      .bind(gid, nowIso),
  ]);
  return {
    entries: rows<EntryRow>(res[0]),
    rows: rows<ClaimedRow>(res[1]),
    group: rows<NonNullable<ClaimedGroup['group']>>(res[2])[0] ?? null,
    members: rows<PushMemberRow>(res[3]),
    devices: rows<DeviceRow>(res[4]),
  };
}

/**
 * Keep messages for the next runs, one statement per person and channel (push_pending for
 * browsers, apns_pending for iPhones): they share one payload. A device deleted or moved to another
 * account since the claim is left out.
 */
async function keepForLater(db: D1Database, list: readonly Outgoing[], nowIso: string): Promise<void> {
  const people = new Map<string, { first: Outgoing; devices: [string, number][] }>();
  for (const o of list) {
    const key = o.ch + ' ' + o.userId;
    const p = people.get(key);
    if (p) p.devices.push([o.subId, o.rank]);
    else people.set(key, { first: o, devices: [[o.subId, o.rank]] });
  }
  if (!people.size) return;
  await db.batch(
    [...people.values()].map(({ first: o, devices }) =>
      o.ch === 'apns'
        ? db
            .prepare(
              `INSERT INTO apns_pending (token, user_id, rank, payload, urgency, collapse_id, created_at)
               SELECT a.token, a.user_id, json_extract(j.value, '$[1]'), ?3, ?4, ?5, ?6
               FROM json_each(?1) j JOIN apns_devices a ON a.token = json_extract(j.value, '$[0]') AND a.user_id = ?2
               ORDER BY j.key`,
            )
            .bind(JSON.stringify(devices), o.userId, o.message.body, o.message.priority === 5 ? 'low' : 'normal', o.message.collapseId, nowIso)
        : db
            .prepare(
              `INSERT INTO push_pending (sub_id, user_id, rank, payload, urgency, created_at)
               SELECT s.id, s.user_id, json_extract(j.value, '$[1]'), ?3, ?4, ?5
               FROM json_each(?1) j JOIN push_subscriptions s ON s.id = json_extract(j.value, '$[0]') AND s.user_id = ?2
               ORDER BY j.key`,
            )
            .bind(JSON.stringify(devices), o.userId, dec.decode(o.message.payload), o.message.urgency, nowIso),
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
 * What a Web Push status means for the subscription (APNs answers: apnsOutcome): 2xx accepted, 404
 * or 410 gone, anything else (no answer included) a failure.
 */
function webOutcome(status: number): ApnsOutcome {
  if (status >= 200 && status < 300) return 'ok';
  return status === 404 || status === 410 ? 'gone' : 'failed';
}

/** Each device table and its key, for the answers of deliverPushes. */
const ANSWER_TABLES = { web: ['push_subscriptions', 'id'], apns: ['apns_devices', 'token'] } as const;

/**
 * Send the messages (all at once, each on its channel) and record each answer on its device, in
 * one batch: success sets last_ok_at, a device that is gone is deleted, any other failure counts
 * (deleted at 5 in a row), and an APNs refusal of the server's own request touches no row (it would
 * be the same for every iPhone; the log says what to check, once a run).
 */
export async function deliverPushes(
  db: D1Database,
  senders: Senders,
  list: readonly Delivery[],
  nowMs = Date.now(),
): Promise<Omit<PushRunResult, 'groups'>> {
  const refusals = new Set<string>();
  const outcomes = await Promise.all(
    list.map(async (o): Promise<ApnsOutcome> => {
      if (o.ch === 'apns') {
        if (!senders.apns) return 'refused';
        const a: ApnsAnswer = await sendApns(senders.apns, o.message, nowMs);
        const outcome = apnsOutcome(a);
        // The status and APNs's reason only: the token identifies the iPhone.
        if (outcome === 'failed') console.warn(`push: APNs (${o.message.environment}) answered ${a.status || 'nothing'}${a.reason ? ' ' + a.reason : ''}`);
        if (outcome === 'refused') {
          refusals.add(`${a.status} ${a.reason || 'without a reason'}`);
          // A provider token APNs refuses (expired, or not accepted) is signed again next time.
          if (a.status === 403) forgetApnsJwt();
        }
        return outcome;
      }
      if (!senders.vapid) return 'refused';
      const status = await sendPush(senders.vapid, o.message, nowMs);
      // The host only: the rest of an endpoint identifies the device.
      if (webOutcome(status) === 'failed') console.warn(`push: ${hostOf(o.message.endpoint)} answered ${status || 'nothing'}`);
      return webOutcome(status);
    }),
  );
  for (const r of refusals) console.error(`push: APNs refused the request (${r}): check APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC and the APNS_AUTH_KEY secret`);
  const ids = { web: { ok: new Set<string>(), gone: new Set<string>(), failed: new Set<string>() }, apns: { ok: new Set<string>(), gone: new Set<string>(), failed: new Set<string>() } };
  outcomes.forEach((outcome, i) => {
    if (outcome !== 'refused') ids[list[i].ch][outcome].add(list[i].subId);
  });
  const stmts: D1PreparedStatement[] = [];
  const each = (set: Set<string>, sql: (marks: string) => string, ...extra: unknown[]) => {
    for (const part of chunk([...set])) stmts.push(db.prepare(sql(placeholders(part.length))).bind(...extra, ...part));
  };
  for (const ch of ['web', 'apns'] as const) {
    const [table, key] = ANSWER_TABLES[ch];
    const { ok, gone, failed } = ids[ch];
    each(failed, m => `UPDATE ${table} SET failures = failures + 1 WHERE ${key} IN (${m})`);
    each(failed, m => `DELETE FROM ${table} WHERE failures >= ? AND ${key} IN (${m})`, FAILURES_MAX);
    each(ok, m => `UPDATE ${table} SET last_ok_at = ?, failures = 0 WHERE ${key} IN (${m})`, iso(nowMs));
    each(gone, m => `DELETE FROM ${table} WHERE ${key} IN (${m})`);
  }
  if (stmts.length) await db.batch(stmts);
  const count = (o: ApnsOutcome) => outcomes.filter(x => x === o).length;
  return { sent: count('ok'), removed: count('gone'), failed: count('failed') + count('refused') };
}

// ---------- the run ----------

/** Send every due notification (steps 1 to 8 above). Never throws: it runs inside ctx.waitUntil. */
export async function runPushSender(env: Env, now: Date = new Date()): Promise<PushRunResult> {
  const out: PushRunResult = { groups: 0, sent: 0, removed: 0, failed: 0 };
  try {
    const db = env.DB;
    const nowMs = now.getTime();
    const senders = await loadSenders(env);
    if (!senders.vapid && !senders.apns) {
      // Push is not set up (or its keys are broken): nothing can go out. Keep a day of rows for
      // when it is fixed, so the pending list cannot grow without end. Kept messages wait too, and
      // are dropped when they come up a day old. (With one channel set up, the other's devices are
      // left out of every message instead.)
      const stale = iso(nowMs - STALE_MS);
      await db.batch([
        db.prepare('UPDATE activity SET push_at = NULL WHERE push_at IS NOT NULL AND push_at < ?').bind(stale),
        // The privacy page promises a kept notification waits at most a day.
        db.prepare('DELETE FROM push_pending WHERE created_at < ?').bind(stale),
        db.prepare('DELETE FROM apns_pending WHERE created_at < ?').bind(stale),
      ]);
      return out;
    }
    const budget = budgetOf(env.PUSH_MAX_PER_RUN);
    // Each claim is a D1 call and each message a fetch: together they stay under 50.
    let claimsLeft = Math.min(GROUPS_PER_RUN, SUBREQUESTS - SUBREQUESTS_KEPT - budget);
    const holdCutoff = iso(nowMs - holdSeconds(env.PUSH_HOLD_SECONDS) * 1000);
    const start = await startRun(db, budget, holdCutoff, iso(nowMs - CAP_MS), nowMs, senders);
    const queue: Outgoing[] = start.kept;
    const later: Outgoing[] = [];
    /** Activity ids of claimed groups that did not fit after all, to get their push_at back. */
    const back: string[] = [];
    let waiting = 0;
    let dropped = start.dropped;
    for (const due of start.due) {
      if (queue.length >= budget || claimsLeft <= 0) break;
      const room = budget - queue.length;
      // While the rest of a group is kept, a second rest could keep it growing: a group that does
      // not fit waits whole (its rows merge with what comes next) for a run with room for it or one
      // that starts with nothing kept, and smaller groups still go. One that more devices can hear
      // than a run sends is not even claimed, so a big busy group costs nothing.
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
        // A channel that cannot send (its key is not set up) has no devices.
        messages = groupMessages({ ...claimed, devices: claimed.devices.filter(d => canSend(senders, channelOf(d))) }, nowMs);
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
        // Nothing was kept: the rest waits for the next runs.
        later.push(...messages.slice(room));
        break;
      }
    }
    if (!start.drained && (back.length || queue.length < budget)) {
      // Rows given back, and the room the groups left for more kept messages, in one call (this run
      // keeps no rest, so it is the call that would have kept one).
      try {
        const more = await finishRun(db, back, budget - queue.length, nowMs, senders);
        queue.push(...more.kept);
        dropped += more.dropped;
      } catch (err) {
        console.error(`push: could not finish the run (${waiting} groups waiting, ${back.length} rows to give back)`, err);
      }
    }
    if (!queue.length && !out.groups && !dropped && !waiting) return out;
    // Kept before sending: a run that stops while it sends still leaves them for the next one.
    if (later.length) await keepForLater(db, later, iso(nowMs)).catch(err => console.error(`push: could not keep ${later.length} messages for later`, err));
    if (queue.length) Object.assign(out, await deliverPushes(db, senders, queue, nowMs));
    console.log(
      `push: ${out.groups} groups, ${out.sent} sent, ${out.removed} removed, ${out.failed} failed, ${later.length} kept for later, ${dropped} kept ones dropped, ${waiting} groups waiting`,
    );
  } catch (err) {
    console.error('push sender failed', err);
  }
  return out;
}
