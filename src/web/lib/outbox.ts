// The outbox rules, without storage or network (the store does the I/O). Queued writes for one
// entry go out strictly in order; entries never wait for each other. A failed save, delete or
// restore of an entry is moot once a newer one of the same entry is queued or has gone through,
// and so is a receipt photo change once a newer one of the same entry is. A receipt photo of a new
// entry is queued right after its save, so it goes up only once the entry exists.

import type { ApiErrorCode, CommentDTO, ExpenseDTO, ExpenseKind, GroupSnapshotDTO, ReceiptDTO, UpsertExpenseReq } from '../../shared/types';

export type OutboxOp = 'upsert' | 'delete' | 'restore' | 'comment' | 'receipt';

/**
 * A receipt photo change: a photo to put on the entry (a JPEG data URL from lib/photo.ts
 * receiptPhoto, with its size in px), or `remove`. A data URL rather than a Blob: the outbox
 * falls back to localStorage (JSON) where IndexedDB is missing.
 */
export type ReceiptChange = { image: string; width: number; height: number } | { remove: true };

export function isReceiptRemoval(b: unknown): b is { remove: true } {
  return !!b && typeof b === 'object' && (b as { remove?: unknown }).remove === true;
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
  /** upsert: UpsertExpenseReq; comment: { id, body }; receipt: ReceiptChange */
  body?: UpsertExpenseReq | { id: string; body: string } | ReceiptChange;
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

/** What the server answered for a write that went through (null: nothing to apply). */
export interface SentResult {
  expense?: ExpenseDTO;
  comment?: CommentDTO;
  /** A receipt photo change: the photo now on the entry (null: removed). */
  receipt?: ReceiptDTO | null;
  groupVersion?: number;
}

export function isOutboxItem(v: unknown): v is OutboxItem {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<OutboxItem>;
  return typeof o.id === 'string' && typeof o.op === 'string' && typeof o.groupId === 'string' && typeof o.expenseId === 'string' && typeof o.createdAt === 'number';
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
  return op !== 'comment' && op !== 'receipt';
}

/**
 * What an item sets in full, so a later item of the same entry with the same part makes a failed
 * one moot: 'entry' for save, delete and restore, 'receipt' for a photo change, null for a comment
 * (each one adds).
 */
export function partOf(op: OutboxOp): 'entry' | 'receipt' | null {
  if (op === 'comment') return null;
  return op === 'receipt' ? 'receipt' : 'entry';
}

/** Failed items that a later item of the same entry and part makes moot (partOf). */
export function supersededIds(items: readonly OutboxItem[]): Set<string> {
  const sorted = sortOutbox(items);
  const last = new Map<string, number>();
  sorted.forEach((it, i) => {
    const part = partOf(it.op);
    if (part) last.set(entryKey(it) + '#' + part, i);
  });
  const out = new Set<string>();
  sorted.forEach((it, i) => {
    const part = partOf(it.op);
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
 * Coalescing photos: the queued receipt photo changes of an entry that a newer one replaces (the
 * newest says what the photo should be), except the one this tab is sending.
 */
export function replaceableReceipts(items: readonly OutboxItem[], groupId: string, expenseId: string, inFlight: string | null): string[] {
  return items.filter(it => it.op === 'receipt' && it.groupId === groupId && it.expenseId === expenseId && it.id !== inFlight).map(it => it.id);
}

/** Failed items of the same entry and part (partOf), queued before one that just went through. */
export function staleFailures(items: readonly OutboxItem[], sent: OutboxItem): string[] {
  const part = partOf(sent.op);
  if (!part) return [];
  const sorted = sortOutbox(items);
  const at = sorted.findIndex(i => i.id === sent.id);
  const before = at >= 0 ? sorted.slice(0, at) : sorted.filter(i => i.createdAt <= sent.createdAt && i.id !== sent.id);
  return before.filter(i => i.error && partOf(i.op) === part && sameEntry(i, sent)).map(i => i.id);
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

/** The snapshot with an entry's receipt photo as the server now has it, unless it was fetched after that change. */
export function withReceipt(snap: GroupSnapshotDTO, expenseId: string, receipt: ReceiptDTO | null, groupVersion: number | undefined): GroupSnapshotDTO {
  if (groupVersion !== undefined && snap.group.version >= groupVersion) return snap;
  const at = snap.expenses.findIndex(x => x.id === expenseId);
  if (at < 0) return snap;
  const expenses = snap.expenses.slice();
  expenses[at] = { ...expenses[at], receipt };
  return { ...snap, expenses };
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
  if (sent.op === 'receipt' && result.receipt !== undefined) return withReceipt(snap, sent.expenseId, result.receipt, result.groupVersion);
  return snap;
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
  /** Receipt photo changes: true when it takes the photo off. */
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
  return base;
}
