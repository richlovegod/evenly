// The outbox rules, without storage or network (the store does the I/O). Queued writes for one
// entry go out strictly in order; entries never wait for each other. A failed save, delete or
// restore of an entry is moot once a newer one of the same entry is queued or has gone through,
// and so is a change of one receipt photo once a newer change of the same photo is. An entry keeps
// up to three receipt photos (docs/SPEC.md section 8.4): each change of one is its own item (op
// 'photo', a photo to add or a version to drop), queued after the entry's save, so it goes up only
// once the entry exists. Items of op 'receipt' are what builds from before several photos queued
// (one photo per entry, replaced or removed); this build still sends them, never makes them.

import { photosOf, RECEIPT_PHOTOS_MAX } from '../../shared/receipts';
import type { ApiErrorCode, CommentDTO, ExpenseDTO, ExpenseKind, GroupSnapshotDTO, ReceiptDTO, UpsertExpenseReq } from '../../shared/types';

export type OutboxOp = 'upsert' | 'delete' | 'restore' | 'comment' | 'receipt' | 'photo';

/**
 * A legacy receipt photo change (op 'receipt', queued by builds from before several photos): a
 * photo to put on the entry in place of its first one (a JPEG data URL with its size in px), or
 * `remove` (the first one). A data URL rather than a Blob: the outbox falls back to localStorage
 * (JSON) where IndexedDB is missing.
 */
export type ReceiptChange = { image: string; width: number; height: number } | { remove: true };

/**
 * One receipt photo change (op 'photo'): a photo to add after the entry's others (its version is
 * the first 16 hex characters of the SHA-256 of the JPEG in `image`, lib/photo.ts photoVersion),
 * or the version of a photo to take off.
 */
export type PhotoChange = { add: { version: string; image: string; width: number; height: number } } | { drop: string };

export function isReceiptRemoval(b: unknown): b is { remove: true } {
  return !!b && typeof b === 'object' && (b as { remove?: unknown }).remove === true;
}

/** The photo a 'photo' item adds (null: it drops one, or it is not a photo change). */
export function photoAdd(b: unknown): { version: string; image: string; width: number; height: number } | null {
  if (!b || typeof b !== 'object') return null;
  const a = (b as { add?: unknown }).add;
  if (!a || typeof a !== 'object') return null;
  const p = a as Record<string, unknown>;
  return typeof p.version === 'string' && typeof p.image === 'string' && typeof p.width === 'number' && typeof p.height === 'number'
    ? (p as { version: string; image: string; width: number; height: number })
    : null;
}

/** The version a 'photo' item takes off (null: it adds one). */
export function photoDrop(b: unknown): string | null {
  if (!b || typeof b !== 'object') return null;
  const v = (b as { drop?: unknown }).drop;
  return typeof v === 'string' ? v : null;
}

/** The version a 'photo' item is about, added or taken off ('' for anything else). */
export function photoVersionOf(i: Pick<OutboxItem, 'op' | 'body'>): string {
  if (i.op !== 'photo') return '';
  return photoAdd(i.body)?.version ?? photoDrop(i.body) ?? '';
}

export interface OutboxError {
  code: string;
  message: string;
}

export interface OutboxItem {
  id: string;
  op: OutboxOp;
  groupId: string;
  expenseId: string;
  /** upsert: UpsertExpenseReq; comment: { id, body }; receipt: ReceiptChange; photo: PhotoChange */
  body?: UpsertExpenseReq | { id: string; body: string } | ReceiptChange | PhotoChange;
  createdAt: number;
  attempts: number;
  nextTryAt: number;
  /** Set when the server rejected it for good (shown as 同步失敗 with retry / discard). */
  error: OutboxError | null;
  /** The last failure worth retrying (no connection, 5xx, 429); the item keeps retrying by itself. */
  lastError?: (OutboxError & { at: number }) | null;
  /** The account that queued it, so it is only ever sent as that account. */
  userId?: string;
}

/**
 * An outbox record as stored (IndexedDB, or localStorage where it is missing). A 'photo' item keeps
 * its entry's id as `entryId` and has no `expenseId`: the isOutboxItem of builds from before
 * several photos needs `expenseId`, so those builds, still open in another tab or as a Home Screen
 * app, skip these records everywhere. They never send, fail, supersede or replace them, and never
 * count them as entry changes; their sendItem has no case for an op it does not know, and would
 * mark one sent and delete it. Every other op is stored as it is in memory.
 */
export type StoredOutboxItem = OutboxItem | (Omit<OutboxItem, 'expenseId'> & { entryId: string });

/** An item as it is stored (see StoredOutboxItem). */
export function toStored(i: OutboxItem): StoredOutboxItem {
  if (i.op !== 'photo') return i;
  const { expenseId, ...rest } = i;
  return { ...rest, entryId: expenseId };
}

/** A stored record as this build keeps it in memory (anything that is not a 'photo' record comes back as it is). */
export function fromStored(v: StoredOutboxItem): OutboxItem {
  const r = v as Partial<OutboxItem> & { entryId?: unknown };
  if (r.op !== 'photo' || typeof r.entryId !== 'string' || typeof r.expenseId === 'string') return v as OutboxItem;
  const { entryId, ...rest } = r as Omit<OutboxItem, 'expenseId'> & { entryId: string };
  return { ...rest, expenseId: entryId };
}

/** What the server answered for a write that went through (null: nothing to apply). */
export interface SentResult {
  expense?: ExpenseDTO;
  comment?: CommentDTO;
  /** A receipt photo change: the first photo now on the entry (null: none). */
  receipt?: ReceiptDTO | null;
  /** A receipt photo change: every photo now on the entry, first to last (servers from before several photos leave it out). */
  receipts?: ReceiptDTO[];
  groupVersion?: number;
}

/** A record in either shape: this build's in memory, or a stored one (a 'photo' record has `entryId` instead). */
export function isOutboxItem(v: unknown): v is StoredOutboxItem {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<OutboxItem> & { entryId?: unknown };
  const entry = typeof o.expenseId === 'string' || (o.op === 'photo' && typeof o.entryId === 'string');
  return typeof o.id === 'string' && typeof o.op === 'string' && typeof o.groupId === 'string' && entry && typeof o.createdAt === 'number';
}

/** Oldest first; items made in the same millisecond keep a stable order. */
export function sortOutbox(items: readonly OutboxItem[]): OutboxItem[] {
  return [...items].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function entryKey(i: { groupId: string; expenseId: string }): string {
  return i.groupId + '/' + i.expenseId;
}

export function sameEntry(a: { groupId: string; expenseId: string }, b: { groupId: string; expenseId: string }): boolean {
  return a.groupId === b.groupId && a.expenseId === b.expenseId;
}

/** Save, delete and restore each set the whole state of an entry; a comment or a receipt photo only adds to it. */
export function replacesEntry(op: OutboxOp): boolean {
  return op !== 'comment' && op !== 'receipt' && op !== 'photo';
}

/** Changes that move no balance (a comment, a receipt photo): the group's pending count skips them. */
export function movesBalances(op: OutboxOp): boolean {
  return op !== 'comment' && op !== 'receipt' && op !== 'photo';
}

/**
 * What an item sets in full, so a later item of the same entry with the same part makes a failed
 * one moot: 'entry' for save, delete and restore, 'photo:<version>' for a change of one receipt
 * photo (so a failed upload of one photo is never hidden by a change to another), 'receipt' for a
 * legacy photo change, null for a comment (each one adds).
 */
export function partOf(i: Pick<OutboxItem, 'op' | 'body'>): string | null {
  switch (i.op) {
    case 'comment': return null;
    case 'receipt': return 'receipt';
    case 'photo': return 'photo:' + photoVersionOf(i);
    default: return 'entry';
  }
}

/** Failed items that a later item of the same entry and part makes moot (partOf). */
export function supersededIds(items: readonly OutboxItem[]): Set<string> {
  const sorted = sortOutbox(items);
  const last = new Map<string, number>();
  sorted.forEach((it, i) => {
    const part = partOf(it);
    if (part) last.set(entryKey(it) + '#' + part, i);
  });
  const out = new Set<string>();
  sorted.forEach((it, i) => {
    const part = partOf(it);
    if (it.error && part && (last.get(entryKey(it) + '#' + part) ?? -1) > i) out.add(it.id);
  });
  return out;
}

/** The items that still mean something, oldest first. */
export function liveItems(items: readonly OutboxItem[]): OutboxItem[] {
  const moot = supersededIds(items);
  return sortOutbox(items).filter(i => !moot.has(i.id));
}

/**
 * The next item to send: the oldest one whose entry is not held back. An entry is held back by
 * an earlier item of its own that waits for a retry (`nextTryAt`) or that the current pass
 * gave up on (`blocked`). Failed items wait for 重試 / 放棄 and hold nothing back.
 */
export function nextToSend(
  items: readonly OutboxItem[],
  opts: { now: number; blocked?: ReadonlySet<string>; canSend?: (i: OutboxItem) => boolean },
): OutboxItem | null {
  const held = new Set(opts.blocked ?? []);
  for (const it of liveItems(items)) {
    if (opts.canSend && !opts.canSend(it)) continue;
    if (it.error) continue;
    const k = entryKey(it);
    if (held.has(k)) continue;
    if (it.nextTryAt > opts.now) {
      held.add(k);
      continue;
    }
    return it;
  }
  return null;
}

/**
 * Coalescing: the queued save that a newer save of the same entry can replace. Only the entry's
 * last item qualifies (a later comment, delete or restore must still follow the save it
 * follows), and only while it is not being sent from this tab and has not failed.
 */
export function replaceableSave(items: readonly OutboxItem[], groupId: string, expenseId: string, inFlight: string | null): OutboxItem | null {
  const sorted = sortOutbox(items);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const it = sorted[i];
    if (it.groupId !== groupId || it.expenseId !== expenseId) continue;
    if (it.op !== 'upsert' || it.error || it.id === inFlight) return null;
    return it;
  }
  return null;
}

/**
 * Coalescing legacy photos: the queued 'receipt' items of an entry that a newer one replaces (the
 * newest says what the first photo should be), except the one this tab is sending.
 */
export function replaceableReceipts(items: readonly OutboxItem[], groupId: string, expenseId: string, inFlight: string | null): string[] {
  return items.filter(it => it.op === 'receipt' && it.groupId === groupId && it.expenseId === expenseId && it.id !== inFlight).map(it => it.id);
}

/**
 * What queueing one photo change of an entry does to the outbox (op 'photo'). `stored`: the
 * versions the entry has on the server as this device last saw them.
 * - A drop of a version whose add is still queued (not in flight) or failed takes that add out,
 *   and queues nothing: the photo never goes up.
 * - An add of a version whose drop is still queued (not in flight) or failed takes that drop out,
 *   and queues nothing: the photo stays.
 * - An add of a version already queued or already stored queues nothing.
 * Anything else is queued (a drop after an add in flight goes out after it).
 */
export function photoChangePlan(
  items: readonly OutboxItem[],
  groupId: string,
  expenseId: string,
  change: PhotoChange,
  inFlight: string | null,
  stored: readonly string[],
): { cancel: string[]; queue: boolean } {
  const mine = items.filter(it => it.op === 'photo' && it.groupId === groupId && it.expenseId === expenseId);
  const drop = photoDrop(change);
  if (drop !== null) {
    const adds = mine.filter(it => photoAdd(it.body)?.version === drop && it.id !== inFlight);
    return adds.length ? { cancel: adds.map(it => it.id), queue: false } : { cancel: [], queue: true };
  }
  const add = photoAdd(change);
  if (!add) return { cancel: [], queue: false };
  const drops = mine.filter(it => photoDrop(it.body) === add.version && it.id !== inFlight);
  if (drops.length) return { cancel: drops.map(it => it.id), queue: false };
  const queued = mine.some(it => photoAdd(it.body)?.version === add.version);
  // A drop in flight: the photo is going, so this add puts it back after it.
  const going = mine.some(it => photoDrop(it.body) === add.version);
  if (queued || (stored.includes(add.version) && !going)) return { cancel: [], queue: false };
  return { cancel: [], queue: true };
}

/** Failed items of the same entry and part (partOf), queued before one that just went through. */
export function staleFailures(items: readonly OutboxItem[], sent: OutboxItem): string[] {
  const part = partOf(sent);
  if (!part) return [];
  const sorted = sortOutbox(items);
  const at = sorted.findIndex(i => i.id === sent.id);
  const before = at >= 0 ? sorted.slice(0, at) : sorted.filter(i => i.createdAt <= sent.createdAt && i.id !== sent.id);
  return before.filter(i => i.error && partOf(i) === part && sameEntry(i, sent)).map(i => i.id);
}

/**
 * How long a write that failed with `err` waits before its next try (null: it failed for good and
 * waits for a retry or a discard by hand). The backoff, or the server's retryAfter when that is
 * later (a daily limit says 00:00 UTC; trying every minute until then would only count more
 * attempts). A full photo store does not clear by waiting: it fails for good.
 */
export function retryDelay(err: { code: ApiErrorCode | string; retryable: boolean; details?: unknown }, backoffMs: number): number | null {
  if (!err.retryable || err.code === 'receipts_full') return null;
  const after = (err.details as { retryAfter?: unknown } | undefined)?.retryAfter;
  const ms = typeof after === 'number' && Number.isFinite(after) && after > 0 ? Math.min(after, 86_400) * 1000 : 0;
  return Math.max(backoffMs, ms);
}

/** Merge two lists of items by id (the second list wins), oldest first. */
export function mergeItems(a: readonly OutboxItem[], b: readonly OutboxItem[]): OutboxItem[] {
  const byId = new Map<string, OutboxItem>();
  for (const i of a) byId.set(i.id, i);
  for (const i of b) byId.set(i.id, i);
  return sortOutbox([...byId.values()]);
}

/** A cheap fingerprint of what the UI shows about a list of items (ids, retries, failures). */
export function outboxSignature(items: readonly OutboxItem[]): string {
  return items
    .map(i => [i.id, i.attempts, i.nextTryAt, i.error ? i.error.code : '', i.lastError ? i.lastError.at : ''].join(':'))
    .join('|');
}

// ---------- applying what the server answered ----------

/** Newest date first, then newest created first (the order GroupSnapshotDTO.expenses uses). */
export function sortExpenses(list: ExpenseDTO[]): ExpenseDTO[] {
  return list.sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) : a.date < b.date ? 1 : -1));
}

/** The snapshot with the server's copy of one entry in it (an older copy never replaces a newer one). */
export function withServerExpense(snap: GroupSnapshotDTO, e: ExpenseDTO): GroupSnapshotDTO {
  if (e.groupId && e.groupId !== snap.group.id) return snap;
  const at = snap.expenses.findIndex(x => x.id === e.id);
  if (at >= 0 && snap.expenses[at].version > e.version) return snap;
  const expenses = snap.expenses.slice();
  if (at >= 0) expenses[at] = e;
  else expenses.push(e);
  return { ...snap, expenses: sortExpenses(expenses) };
}

/** The snapshot counting one more comment on an entry, unless it was fetched after the comment landed. */
export function withCommentAdded(snap: GroupSnapshotDTO, expenseId: string, groupVersion: number | undefined): GroupSnapshotDTO {
  if (groupVersion !== undefined && snap.group.version >= groupVersion) return snap;
  const at = snap.expenses.findIndex(x => x.id === expenseId);
  if (at < 0) return snap;
  const expenses = snap.expenses.slice();
  expenses[at] = { ...expenses[at], commentCount: expenses[at].commentCount + 1 };
  return { ...snap, expenses };
}

/**
 * The snapshot with an entry's receipt photos as the server now has them (`receipt` is the first),
 * unless it was fetched after that change.
 */
export function withReceipts(snap: GroupSnapshotDTO, expenseId: string, receipts: readonly ReceiptDTO[], groupVersion: number | undefined): GroupSnapshotDTO {
  if (groupVersion !== undefined && snap.group.version >= groupVersion) return snap;
  const at = snap.expenses.findIndex(x => x.id === expenseId);
  if (at < 0) return snap;
  const expenses = snap.expenses.slice();
  expenses[at] = { ...expenses[at], receipt: receipts[0] ?? null, receipts: [...receipts] };
  return { ...snap, expenses };
}

/**
 * An entry's photos after a legacy photo change whose answer named only the first photo (an old
 * tab's `sent` message, or a server from before several photos): `receipt` replaced the first one
 * (a photo 2 or 3 with its version moves up), or null took it off.
 */
export function legacyPhotos(e: Pick<ExpenseDTO, 'receipt' | 'receipts'>, receipt: ReceiptDTO | null): ReceiptDTO[] {
  const list = photosOf(e);
  return receipt ? [receipt, ...list.slice(1).filter(p => p.version !== receipt.version)] : list.slice(1);
}

/**
 * The cached snapshot after a queued write went through, so the change does not drop out of
 * view between leaving the outbox and the next successful fetch. Returns `snap` itself when
 * there is nothing to change. The group version and ETag stay as they were, so the next poll
 * still fetches the whole group (other people's changes included).
 */
export function patchAfterSend(snap: GroupSnapshotDTO, sent: Pick<OutboxItem, 'op' | 'groupId' | 'expenseId'>, result: SentResult | null): GroupSnapshotDTO {
  if (!result || sent.groupId !== snap.group.id) return snap;
  if (result.expense) return withServerExpense(snap, result.expense);
  if (sent.op === 'comment' && result.comment) return withCommentAdded(snap, sent.expenseId, result.groupVersion);
  if ((sent.op === 'photo' || sent.op === 'receipt') && Array.isArray(result.receipts)) {
    return withReceipts(snap, sent.expenseId, result.receipts, result.groupVersion);
  }
  if (sent.op === 'receipt' && result.receipt !== undefined) {
    const e = snap.expenses.find(x => x.id === sent.expenseId);
    if (!e) return snap;
    return withReceipts(snap, sent.expenseId, legacyPhotos(e, result.receipt), result.groupVersion);
  }
  return snap;
}

// ---------- what the group page shows of queued photo changes ----------

/** A photo waiting in the outbox to be added to an entry. */
export interface PendingPhotoAdd {
  itemId: string;
  version: string;
  image: string;
  width: number;
  height: number;
  /** sending: queued, it goes out next; waiting: it failed for now and waits for its next try
   *  (offline, the day's uploads used up); failed: it failed for good (重試 / 放棄). */
  state: 'sending' | 'waiting' | 'failed';
  /** Its failure, or the last trouble while it waits, as an error code. */
  code: string | null;
}

/** An entry's queued photo changes, in the order they will land. */
export interface PendingPhotos {
  adds: PendingPhotoAdd[];
  /** Versions queued to be taken off: hidden at once. */
  drops: string[];
}

/** A legacy photo change still waiting (op 'receipt', from a build before several photos). */
export interface PendingReceipt {
  itemId: string;
  /** The photo that replaces the first one (shown from its data URL meanwhile), or null: a removal of the first one. */
  photo: { image: string; width: number; height: number } | null;
  /** It failed for good (重試 / 放棄 on the entry). */
  failed: boolean;
  /** Its failure, or the last trouble while it keeps retrying (offline, the day's uploads used up), as an error code. */
  code: string | null;
}

/** One photo as the entry's page and the editor show it: stored on the server, or still in the outbox. */
export interface VisiblePhoto {
  /** Its version; a legacy queued photo, whose version is not known yet, gets 'legacy:<itemId>'. */
  version: string;
  width: number;
  height: number;
  /** On the server: load it from its versioned address. */
  stored: ReceiptDTO | null;
  /** In the outbox: its data URL, and how its upload is going. */
  queued: { itemId: string; image: string; state: PendingPhotoAdd['state']; code: string | null; legacy?: boolean } | null;
}

/**
 * An entry's photos as they will be once the outbox is sent: the stored ones (photosOf), with a
 * legacy item applied to the first one, without the queued drops (a drop hides its photo at once),
 * then the queued adds in the order they go up. At most three.
 */
export function visiblePhotos(e: Pick<ExpenseDTO, 'receipt' | 'receipts'>, pending?: PendingPhotos, legacy?: PendingReceipt): VisiblePhoto[] {
  let list: VisiblePhoto[] = photosOf(e).map(p => ({ version: p.version, width: p.width, height: p.height, stored: p, queued: null }));
  if (legacy) {
    const rest = list.slice(1);
    list = legacy.photo
      ? [
          {
            version: 'legacy:' + legacy.itemId,
            width: legacy.photo.width,
            height: legacy.photo.height,
            stored: null,
            queued: { itemId: legacy.itemId, image: legacy.photo.image, state: legacy.failed ? 'failed' : legacy.code ? 'waiting' : 'sending', code: legacy.code, legacy: true },
          },
          ...rest,
        ]
      : rest;
  }
  if (pending) {
    const drops = new Set(pending.drops);
    list = list.filter(p => !drops.has(p.version));
    const have = new Set(list.map(p => p.version));
    for (const a of pending.adds) {
      if (have.has(a.version)) continue;
      have.add(a.version);
      list.push({ version: a.version, width: a.width, height: a.height, stored: null, queued: { itemId: a.itemId, image: a.image, state: a.state, code: a.code } });
    }
  }
  return list.slice(0, RECEIPT_PHOTOS_MAX);
}

// ---------- describing items to people ----------

/** One unsynced change, for a message that lists what would otherwise be lost. */
export interface ChangeSummary {
  op: OutboxOp;
  kind: ExpenseKind | null;
  /** The entry's description ('' for payments and when unknown). */
  description: string;
  amount: number | null;
  currency: string | null;
  /** Comments: the text. */
  comment?: string;
  /** Receipt photo changes: true when it takes a photo off. */
  removesReceipt?: boolean;
}

export function summarizeItem(item: OutboxItem, known?: ExpenseDTO): ChangeSummary {
  if (item.op === 'upsert' && item.body && 'amount' in item.body) {
    const b = item.body;
    return { op: 'upsert', kind: b.kind, description: b.description, amount: b.amount, currency: b.currency };
  }
  const base: ChangeSummary = {
    op: item.op,
    kind: known?.kind ?? null,
    description: known?.description ?? '',
    amount: known?.amount ?? null,
    currency: known?.currency ?? null,
  };
  if (item.op === 'comment' && item.body && 'body' in item.body && typeof item.body.body === 'string') base.comment = item.body.body;
  if (item.op === 'receipt') base.removesReceipt = isReceiptRemoval(item.body);
  if (item.op === 'photo') base.removesReceipt = photoDrop(item.body) !== null;
  return base;
}
