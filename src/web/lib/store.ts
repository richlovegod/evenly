// App state and every server call. Pages read state with useStore()/useGroupView() and change
// things only through `actions`. Expense writes (save, delete, restore, comment) go through an
// outbox so they work offline. They are retried in order for each entry, and an entry that keeps
// failing never holds back another one.
//
// Every tab of the app shares the outbox: each item is its own IndexedDB record (outbox:<id>),
// each tab mirrors the records in memory and reads them again when another tab announces a
// change (BroadcastChannel, or a localStorage ping where that is missing), and one tab at a time
// sends (Web Locks). When the session ends on its own (a 401: signed out from another device, a
// password reset), unsynced items stay on the device, filed under the account (held:<userId>),
// and go out when the same person signs in again.

import { useMemo, useSyncExternalStore } from 'react';
import { computeSharesFor } from '../../shared/split';
import type {
  ActivityDTO, AddMemberReq, AdminUserRes, AdminUsersRes, AuthRes, BatchImportReq, ClaimInfoDTO, CommentDTO, CreateGroupReq, CredentialsReq,
  ExpenseDTO, FxRes, GroupSnapshotDTO, JoinInfoDTO, JoinReq, LinkCodeRes, LoginReq, MeDTO, MemberDTO, SessionDTO,
  SignupReq, UpdateGroupReq, UpdateMeReq, UpdateMemberReq, UpsertExpenseReq, UpsertExpenseRes, UserDTO,
} from '../../shared/types';
import {
  api, apiRaw, ApiError, browserOnline, getToken, setToken, setUnauthorizedHandler, storedToken, TOKEN_STORAGE_KEY,
  type ClientErrorCode,
} from './api';
import { passwordKey, passwordOk } from './crypto';
import { errorMessage } from './errors';
import { isStandalone } from './pwa';
import { idbBatch, idbClear, idbDel, idbEntries, idbGet, idbKeys, idbSet, idbTryEntries, type IdbOp } from './idb';
import { getLocale, setLocale, t } from './i18n';
import {
  entryKey, isOutboxItem, liveItems, mergeItems, nextToSend, outboxSignature, patchAfterSend, replaceableSave,
  replacesEntry, sameEntry, sortExpenses, sortOutbox, staleFailures, summarizeItem, supersededIds,
  type ChangeSummary, type OutboxError, type OutboxItem, type OutboxOp, type SentResult,
} from './outbox';
import { navigate } from './router';
import { showToast } from './toast';

export type { ChangeSummary, OutboxItem, OutboxOp } from './outbox';

// ---------- types ----------

export interface GroupEntry {
  snap: GroupSnapshotDTO | null;
  etag: string | null;
  loading: boolean;
  error: ApiError | null;
  fetchedAt: number;
}

export interface ActivityState {
  items: ActivityDTO[];
  next: string | null;
  loading: boolean;
  loaded: boolean;
  error: ApiError | null;
}

/** The session ended on its own while changes were still unsynced; they are kept on this device. */
export interface SignedOutNotice {
  /** What is kept, sent once the same account signs in again. */
  changes: ChangeSummary[];
  /** The account has a password (without one it signs in again only with a code from another device). */
  hasPassword: boolean;
}

export interface State {
  /** Cached data has been read from IndexedDB. */
  booted: boolean;
  token: string | null;
  me: MeDTO | null;
  meLoading: boolean;
  meError: ApiError | null;
  groups: Record<string, GroupEntry>;
  outbox: OutboxItem[];
  /** Last known connectivity. */
  online: boolean;
  syncing: boolean;
  activity: ActivityState;
  /** Set when a session ended with unsynced changes kept (App.tsx explains it once). */
  signedOut: SignedOutNotice | null;
}

const emptyActivity: ActivityState = { items: [], next: null, loading: false, loaded: false, error: null };

let state: State = {
  booted: false,
  token: getToken(),
  me: null,
  meLoading: false,
  meError: null,
  groups: {},
  outbox: [],
  online: browserOnline(),
  syncing: false,
  activity: emptyActivity,
  signedOut: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState(): State {
  return state;
}

/** Subscribe to a slice of state. The selector must return existing objects or primitives. */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

// ---------- persistence ----------

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Write `key` a moment later with what `read()` returns then (undefined: nothing to write). */
function persistLater(key: string, read: () => unknown, delay = 250): void {
  const prev = saveTimers.get(key);
  if (prev) clearTimeout(prev);
  saveTimers.set(key, setTimeout(() => {
    saveTimers.delete(key);
    const value = read();
    if (value !== undefined) void idbSet(key, value);
  }, delay));
}

function persist(key: string, value: unknown, delay = 250): void {
  persistLater(key, () => value, delay);
}

/** Forget writes still waiting to happen (after a sign-out they must not land). */
function cancelPersist(): void {
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
}

function groupRecord(gid: string): { snap: GroupSnapshotDTO; etag: string | null } | undefined {
  const g = state.groups[gid];
  return g?.snap ? { snap: g.snap, etag: g.etag } : undefined;
}

function setGroup(gid: string, patch: Partial<GroupEntry>): void {
  set(s => {
    const prev = s.groups[gid] ?? { snap: null, etag: null, loading: false, error: null, fetchedAt: 0 };
    const next = { ...prev, ...patch };
    return { groups: { ...s.groups, [gid]: next } };
  });
  if (patch.snap !== undefined) {
    if (state.groups[gid]?.snap) persistLater('group:' + gid, () => groupRecord(gid));
    else void idbDel('group:' + gid);
  }
}

function dropGroup(gid: string): void {
  set(s => {
    const groups = { ...s.groups };
    delete groups[gid];
    return { groups };
  });
  void idbDel('group:' + gid);
}

/** Highest group version each group reached through this device's own writes (for loadGroup). */
const writeFloor = new Map<string, number>();

function noteWrite(gid: string, version: number | undefined): void {
  if (typeof version === 'number' && version > (writeFloor.get(gid) ?? 0)) writeFloor.set(gid, version);
}

// ---------- outbox storage ----------

const OUTBOX = 'outbox:';
/** Earlier builds kept the whole outbox in one record (moved to one record per item at boot). */
const LEGACY_OUTBOX = 'outbox';
const HELD = 'held:';
/** Held changes nobody came back for are dropped after this long. */
const HOLD_MS = 30 * 24 * 60 * 60 * 1000;

interface HeldRecord {
  userId: string | null;
  heldAt: number;
  items: OutboxItem[];
}

function isHeld(v: unknown): v is HeldRecord {
  return !!v && typeof v === 'object' && Array.isArray((v as HeldRecord).items) && typeof (v as HeldRecord).heldAt === 'number';
}

/** The account this tab is signed in as, once known (auth response, cached or fetched /api/me). */
let currentUserId: string | null = null;

/** Items this account may see here (items from before accounts were noted count as its own). */
function isMine(i: OutboxItem): boolean {
  return !i.userId || !currentUserId || i.userId === currentUserId;
}

/** Items that may go out with this tab's token: never another account's. */
function canSend(i: OutboxItem): boolean {
  return currentUserId ? !i.userId || i.userId === currentUserId : !i.userId;
}

/**
 * This tab's outbox writes that have not landed in IndexedDB (null: a delete): still on their
 * way, or failed. Reads apply them on top of storage, so a slow or failed write never makes an
 * item vanish from (or come back to) this tab.
 */
const unsaved = new Map<string, { item: OutboxItem | null }>();

function markUnsaved(id: string, item: OutboxItem | null): () => void {
  const m = { item };
  unsaved.set(id, m);
  return () => {
    if (unsaved.get(id) === m) unsaved.delete(id);
  };
}

/** Store outbox puts and deletes (plus any other steps) in one transaction, then tell the other tabs. */
async function writeOutbox(puts: readonly OutboxItem[], dels: readonly string[], extra: readonly IdbOp[] = [], notify = true): Promise<boolean> {
  if (!puts.length && !dels.length && !extra.length) return true;
  const landed = [...puts.map(i => markUnsaved(i.id, i)), ...dels.map(id => markUnsaved(id, null))];
  const ok = await idbBatch([
    ...extra,
    ...puts.map(i => ({ type: 'put' as const, key: OUTBOX + i.id, value: i })),
    ...dels.map(id => ({ type: 'del' as const, key: OUTBOX + id })),
  ]);
  // A write that did not land stays marked: this tab keeps showing (and sending) what it meant.
  if (ok) for (const f of landed) f();
  if (notify) announce({ type: 'outbox' });
  return ok;
}

/**
 * Change one item here and in storage. Storage applies `fn` to its own copy inside one
 * transaction, so a newer copy from another tab is not overwritten and an item another tab
 * removed stays removed.
 */
async function updateItem(id: string, fn: (i: OutboxItem) => OutboxItem): Promise<void> {
  const cur = state.outbox.find(o => o.id === id);
  const next = cur ? fn(cur) : null;
  if (next) set(s => ({ outbox: s.outbox.map(o => (o.id === id ? next : o)) }));
  const landed = next ? markUnsaved(id, next) : null;
  const ok = await idbBatch([{ type: 'update', key: OUTBOX + id, fn: v => (isOutboxItem(v) ? fn(v) : undefined) }]);
  if (ok) landed?.();
  announce({ type: 'outbox' });
}

/** Every outbox item in storage, with this tab's writes that have not landed applied, oldest first. */
async function readOutbox(): Promise<OutboxItem[]> {
  const rows = await idbTryEntries<OutboxItem>(OUTBOX);
  const byId = new Map<string, OutboxItem>();
  if (rows) {
    for (const [, v] of rows) if (isOutboxItem(v)) byId.set(v.id, v);
  } else {
    // Storage did not answer: go on with what this tab has.
    for (const i of state.outbox) byId.set(i.id, i);
  }
  for (const [id, m] of unsaved) {
    if (m.item) byId.set(id, m.item);
    else byId.delete(id);
  }
  return sortOutbox([...byId.values()]);
}

function setOutbox(items: OutboxItem[]): void {
  if (outboxSignature(items) === outboxSignature(state.outbox)) return;
  set({ outbox: items });
}

let readSeq = 0;

/** Bring this tab's outbox in line with storage (another tab may have changed it). Resolves this account's items. */
async function syncOutbox(): Promise<OutboxItem[]> {
  if (!state.token) return [];
  const seq = ++readSeq;
  const token = state.token;
  const all = await readOutbox();
  if (state.token !== token) return [];
  const foreign = currentUserId ? all.filter(i => !isMine(i)) : [];
  // Another account's items (queued in a tab that was still signed in as it): keep them for it.
  if (foreign.length) void holdItems(foreign, null);
  const mine = all.filter(isMine);
  if (seq === readSeq) setOutbox(mine);
  return mine;
}

/**
 * File items under their account (held:<userId>) and take them out of the outbox, in one
 * transaction (never in both places, never in neither). Resolves whether that landed.
 */
async function holdItems(items: readonly OutboxItem[], fallbackUser: string | null): Promise<boolean> {
  if (!items.length) return true;
  const byUser = new Map<string, OutboxItem[]>();
  for (const it of items) {
    const uid = it.userId ?? fallbackUser ?? '';
    const list = byUser.get(uid) ?? [];
    list.push({ ...it, userId: uid || undefined, attempts: 0, nextTryAt: 0 });
    byUser.set(uid, list);
  }
  const holds: IdbOp[] = [...byUser].map(([uid, list]) => ({
    type: 'update' as const,
    key: HELD + uid,
    fn: (prev: unknown): HeldRecord => ({
      userId: uid || null,
      heldAt: Date.now(),
      items: mergeItems(isHeld(prev) ? prev.items.filter(isOutboxItem) : [], list),
    }),
  }));
  return writeOutbox([], items.map(i => i.id), holds);
}

/** Put back what this device held for the account that just signed in, and send it. */
async function restoreHeld(userId: string): Promise<void> {
  const rec = await idbGet<HeldRecord>(HELD + userId);
  if (!isHeld(rec) || !state.token || currentUserId !== userId) return;
  const back = rec.items.filter(isOutboxItem).map(i => ({ ...i, userId, attempts: 0, nextTryAt: 0 }));
  const all = mergeItems(state.outbox, back);
  const moot = supersededIds(all);
  setOutbox(all.filter(i => !moot.has(i.id)));
  await writeOutbox(back.filter(i => !moot.has(i.id)), [...moot], [{ type: 'del', key: HELD + userId }]);
  if (state.signedOut) set({ signedOut: null });
  void flush();
}

/** Drop held changes older than HOLD_MS. */
async function expireHolds(): Promise<void> {
  const rows = await idbEntries<HeldRecord>(HELD);
  const now = Date.now();
  const old = rows.filter(([, v]) => !isHeld(v) || now - v.heldAt > HOLD_MS).map(([key]) => key);
  if (old.length) await idbBatch(old.map(key => ({ type: 'del' as const, key })));
}

// ---------- telling the other tabs ----------

type BusMessage =
  | { type: 'outbox' }
  | { type: 'sent'; groupId: string; op: OutboxOp; expenseId: string; result: SentResult | null };

const BUS_KEY = 'evenly.bus';
let channel: BroadcastChannel | null = null;

function announce(msg: BusMessage): void {
  try {
    if (channel) channel.postMessage(msg);
    else localStorage.setItem(BUS_KEY, JSON.stringify({ ...msg, nonce: Math.random() }));
  } catch {
    /* the other tabs catch up when they come to the front */
  }
}

function onBus(msg: BusMessage | null | undefined): void {
  if (!msg || !state.token) return;
  // Another tab sent something: show the server's copy first, then drop the item, so the entry
  // never drops out of view in between.
  if (msg.type === 'sent') applySent(msg.groupId, msg, msg.result);
  void syncOutbox();
}

/** Put a write's result into this tab's copy of the group. Returns the patched snapshot (null: unchanged). */
function applySent(gid: string, sent: { op: OutboxOp; groupId: string; expenseId: string }, result: SentResult | null): GroupSnapshotDTO | null {
  noteWrite(gid, result?.groupVersion);
  const entry = state.groups[gid];
  if (!entry?.snap) return null;
  const patched = patchAfterSend(entry.snap, sent, result);
  if (patched === entry.snap) return null;
  set(s => (s.groups[gid] ? { groups: { ...s.groups, [gid]: { ...s.groups[gid], snap: patched } } } : {}));
  return patched;
}

// ---------- start ----------

/** Load cached data and start syncing. Called once from main.tsx. */
export async function boot(): Promise<void> {
  setUnauthorizedHandler(() => void handleUnauthorized());
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel('evenly');
      channel.onmessage = e => onBus(e.data as BusMessage);
    } catch {
      channel = null;
    }
  }
  const [me, legacy, rows, keys] = await Promise.all([
    idbGet<MeDTO>('me'),
    idbGet<unknown>(LEGACY_OUTBOX),
    idbEntries<OutboxItem>(OUTBOX),
    idbKeys('group:'),
  ]);
  const groups: Record<string, GroupEntry> = {};
  await Promise.all(keys.map(async k => {
    const v = await idbGet<{ snap: GroupSnapshotDTO; etag: string | null }>(k);
    if (v?.snap) groups[k.slice(6)] = { snap: v.snap, etag: v.etag, loading: false, error: null, fetchedAt: 0 };
  }));
  const owner = me?.user.id ?? null;
  currentUserId = state.token ? owner : null;

  let items = rows.map(([, v]) => v).filter(isOutboxItem);
  if (Array.isArray(legacy)) {
    // One record per item from now on (earlier versions kept a single array).
    const have = new Set(items.map(i => i.id));
    const moved = legacy.filter(isOutboxItem).filter(i => !have.has(i.id)).map(i => ({ ...i, userId: i.userId ?? owner ?? undefined }));
    await idbBatch([...moved.map(i => ({ type: 'put' as const, key: OUTBOX + i.id, value: i })), { type: 'del', key: LEGACY_OUTBOX }]);
    items = items.concat(moved);
  }
  items = sortOutbox(items);
  // A failed change that a later one of the same entry replaced (earlier versions kept those).
  const moot = supersededIds(items);
  if (moot.size) {
    await idbBatch([...moot].map(id => ({ type: 'del' as const, key: OUTBOX + id })));
    items = items.filter(i => !moot.has(i.id));
  }
  if (!state.token && items.length) {
    // Signed out with items still here (a sign-out that was cut short): keep them for their account.
    await holdItems(items, owner);
    items = [];
  }
  const foreign = currentUserId ? items.filter(i => !isMine(i)) : [];
  if (foreign.length) {
    await holdItems(foreign, null);
    items = items.filter(isMine);
  }
  void expireHolds();
  set({ booted: true, me: state.token ? me ?? null : null, outbox: state.token ? items : [], groups: state.token ? groups : {} });

  window.addEventListener('online', () => {
    set({ online: true });
    void wakeWaiting().then(() => flush());
    void actions.loadMe();
  });
  window.addEventListener('offline', () => set({ online: false }));
  window.addEventListener('storage', e => {
    if (e.key === BUS_KEY) {
      if (e.newValue) {
        try {
          onBus(JSON.parse(e.newValue) as BusMessage);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    // Another tab signed in or out: start over with its session, so this tab never shows or
    // sends anything as the wrong account.
    if ((e.key === TOKEN_STORAGE_KEY || e.key === null) && storedToken() !== getToken()) location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.token) {
      void syncOutbox();
      void flush();
      void actions.loadMe();
    }
  });
  setInterval(() => {
    if (!state.token || document.visibilityState !== 'visible') return;
    if (state.outbox.some(i => !i.error)) void flush();
  }, 15000);
  setInterval(() => {
    if (state.token && document.visibilityState === 'visible') void actions.loadMe();
  }, 60000);

  await handleInstallCode();

  if (state.token) {
    void actions.loadMe();
    void flush();
  }
}

/**
 * The Home Screen app has its own storage, separate from Safari. Before adding it, the account
 * page puts a one-time sign-in code in the page URL (?install=CODE); the installed app opens
 * that URL, signs in with the code, and removes it from the address.
 */
async function handleInstallCode(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const code = params.get('install');
  if (!code || !isStandalone()) return;
  params.delete('install');
  const q = params.toString();
  history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash);
  if (state.token) return;
  try {
    await actions.linkLogin(code);
    showToast({ message: t('已登入。', 'Signed in.'), kind: 'success' });
  } catch {
    showToast({ message: t('登入碼已過期，請在 Safari 的「我的」頁面重新產生。', 'The sign-in code expired. Make a new one on the Account page in Safari.'), kind: 'error', duration: 8000 });
  }
}

/** Tell the sign-in gate (App.tsx) not to remember the current page as a return target. */
function markSignedOut(): void {
  try {
    sessionStorage.setItem('evenly.signedOut', '1');
    sessionStorage.removeItem('evenly.returnTo');
  } catch {
    /* ignore */
  }
}

function weak(): never {
  throw new ApiError(400, 'weak_password', 'weak password');
}

/** The server no longer accepts this device's session (signed out elsewhere, password reset, expired). */
async function handleUnauthorized(): Promise<void> {
  if (!state.token) return;
  const hasPassword = !!state.me?.user.hasPassword;
  const kept = await clearSession({ hold: true });
  // Go first: a dialog belongs to the page it opens on (Dialog.tsx cancels it when the page changes).
  navigate('/welcome', { replace: true });
  if (kept.length) set({ signedOut: { changes: kept, hasPassword } });
  else showToast({ message: t('登入已失效，請重新登入。', 'You were signed out. Please sign in again.'), kind: 'error' });
}

/**
 * End the session on this device. With `hold`, unsynced changes stay, filed under their account,
 * and come back when it signs in again; they are returned, described for people. Without it
 * (signing out on purpose, deleting the account) this account's changes go with everything else.
 */
async function clearSession(opts: { hold?: boolean } = {}): Promise<ChangeSummary[]> {
  const userId = currentUserId;
  const memory = state.outbox;
  const groups = state.groups;
  setToken(null);
  currentUserId = null;
  set({ token: null, me: null, meLoading: false, meError: null, groups: {}, outbox: [], activity: emptyActivity });
  cancelPersist();
  writeFloor.clear();
  let kept: OutboxItem[] = [];
  let heldOk = true;
  if (opts.hold) {
    kept = mergeItems(await readOutbox(), memory);
    heldOk = await holdItems(kept, userId);
  }
  unsaved.clear();
  // If filing them away failed, the outbox records stay too (the next start files them).
  await idbClear(key =>
    key.startsWith(HELD) ? !!opts.hold || !userId || key !== HELD + userId : !heldOk && key.startsWith(OUTBOX),
  );
  announce({ type: 'outbox' });
  return kept
    .filter(i => !userId || !i.userId || i.userId === userId)
    .map(i => summarizeItem(i, groups[i.groupId]?.snap?.expenses.find(e => e.id === i.expenseId)));
}

function noteOnline(ok: boolean) {
  if (state.online !== ok) set({ online: ok });
}

/** Run an API call that needs a connection, keeping `online` up to date. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    noteOnline(true);
    return r;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'offline') noteOnline(false);
    else noteOnline(true);
    throw e;
  }
}

// ---------- outbox ----------

/** The item this tab is sending right now. */
let inFlight: string | null = null;
let lastCreatedAt = 0;

function backoff(attempts: number): number {
  return Math.min(60000, 2000 * Math.pow(2, Math.max(0, attempts - 1)));
}

function newOpId(): string {
  return crypto.randomUUID();
}

/** Strictly increasing, and after every queued item (the order per entry relies on it). */
function nextCreatedAt(): number {
  let at = Math.max(Date.now(), lastCreatedAt + 1);
  for (const o of state.outbox) if (o.createdAt >= at) at = o.createdAt + 1;
  lastCreatedAt = at;
  return at;
}

function enqueue(item: Pick<OutboxItem, 'op' | 'groupId' | 'expenseId' | 'body'>): void {
  if (!state.token) return;
  const current = state.outbox;
  const drop = new Set<string>();
  if (replacesEntry(item.op)) {
    // A failed save, delete or restore of this entry is moot now: the new one says what it should be.
    for (const o of current) if (o.error && replacesEntry(o.op) && sameEntry(o, item)) drop.add(o.id);
    // Coalesce: a newer save replaces the entry's queued save that has not gone out yet. It is
    // replaced by a new item rather than edited, so a tab sending the old one meanwhile only
    // sends it before the new one, never instead of it.
    if (item.op === 'upsert') {
      const prev = replaceableSave(current.filter(o => !drop.has(o.id)), item.groupId, item.expenseId, inFlight);
      if (prev) drop.add(prev.id);
    }
  }
  const full: OutboxItem = {
    ...item,
    id: newOpId(),
    createdAt: nextCreatedAt(),
    attempts: 0,
    nextTryAt: 0,
    error: null,
    lastError: null,
    ...(currentUserId ? { userId: currentUserId } : {}),
  };
  set({ outbox: sortOutbox([...current.filter(o => !drop.has(o.id)), full]) });
  void writeOutbox([full], [...drop]);
  void flush();
}

async function sendItem(item: OutboxItem): Promise<SentResult | null> {
  const g = encodeURIComponent(item.groupId);
  const e = encodeURIComponent(item.expenseId);
  switch (item.op) {
    case 'upsert':
      return (await api<UpsertExpenseRes>('PUT', `/api/groups/${g}/expenses/${e}`, item.body)) ?? null;
    case 'delete':
      try {
        return (await api<{ expense: ExpenseDTO; groupVersion: number }>('DELETE', `/api/groups/${g}/expenses/${e}`)) ?? null;
      } catch (err) {
        // Deleting something the server never saw is fine.
        if (err instanceof ApiError && err.code === 'not_found') return null;
        throw err;
      }
    case 'restore':
      return (await api<{ expense: ExpenseDTO; groupVersion: number }>('POST', `/api/groups/${g}/expenses/${e}/restore`)) ?? null;
    case 'comment':
      return (await api<{ comment: CommentDTO; groupVersion: number }>('POST', `/api/groups/${g}/expenses/${e}/comments`, item.body)) ?? null;
  }
}

/**
 * A write went through: in one step, put the server's copy into the cached group and take the
 * item (and failed items of the same entry it makes moot) out of the outbox. Both land in
 * IndexedDB in one transaction too, so the entry is never in neither place, not even after the
 * app is closed right then.
 */
async function commitSent(item: OutboxItem, result: SentResult | null): Promise<void> {
  const gid = item.groupId;
  noteWrite(gid, result?.groupVersion);
  const drop = new Set([item.id, ...staleFailures(state.outbox, item)]);
  const entry = state.groups[gid];
  const patched = entry?.snap ? patchAfterSend(entry.snap, item, result) : null;
  const changed = !!entry && !!patched && patched !== entry.snap;
  set(s => {
    const out: Partial<State> = { outbox: s.outbox.filter(o => !drop.has(o.id)) };
    if (changed && patched && s.groups[gid]) out.groups = { ...s.groups, [gid]: { ...s.groups[gid], snap: patched } };
    return out;
  });
  const extra: IdbOp[] = changed && entry ? [{ type: 'put', key: 'group:' + gid, value: { snap: patched, etag: entry.etag } }] : [];
  await writeOutbox([], [...drop], extra, false);
  announce({ type: 'sent', groupId: gid, op: item.op, expenseId: item.expenseId, result });
}

let flushRun: Promise<void> | null = null;
let flushAgain = false;
let soonTimer: ReturnType<typeof setTimeout> | null = null;

/** Another tab is sending: look again in a moment (it also sends this tab's items, if it gets to them). */
function flushSoon(ms = 3000): void {
  if (soonTimer) return;
  soonTimer = setTimeout(() => {
    soonTimer = null;
    if (state.token && state.outbox.some(i => !i.error)) void flush();
  }, ms);
}

/** One tab at a time sends. Resolves whether `fn` ran here. */
async function withSendLock(fn: () => Promise<void>): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== 'function') {
    await fn();
    return true;
  }
  let ran = false;
  try {
    await locks.request('evenly-outbox', { ifAvailable: true }, async lock => {
      if (!lock) return;
      ran = true;
      await fn();
    });
  } catch {
    if (!ran) {
      ran = true;
      await fn();
    }
  }
  return ran;
}

/** Send queued writes. Safe to call any time; resolves when this round is done. */
export function flush(): Promise<void> {
  if (!state.token) return Promise.resolve();
  if (flushRun) {
    flushAgain = true;
    return flushRun;
  }
  const round = { done: null as Promise<void> | null };
  round.done = (async () => {
    // Yield first, so flushRun is set before anything below can ask for another round.
    await Promise.resolve();
    try {
      do {
        flushAgain = false;
        const ran = await withSendLock(drain);
        if (!ran) {
          flushSoon();
          break;
        }
      } while (flushAgain && state.token);
    } finally {
      if (flushRun === round.done) flushRun = null;
    }
  })();
  flushRun = round.done;
  return round.done;
}

/** Back online: items that only waited for a connection go now instead of after their backoff. */
async function wakeWaiting(): Promise<void> {
  const now = Date.now();
  const waiting = state.outbox.filter(o => !o.error && o.nextTryAt > now && o.lastError?.code === 'offline');
  await Promise.all(waiting.map(o => updateItem(o.id, x => (x.lastError?.code === 'offline' ? { ...x, nextTryAt: 0 } : x))));
}

async function drain(): Promise<void> {
  const touched = new Set<string>();
  /** Entries this round gave up on (a server error): their later items wait, other entries go on. */
  const blocked = new Set<string>();
  /** Items this round already handled (each goes out at most once per round). */
  const handled = new Set<string>();
  let noAnswer = 0;
  set({ syncing: true });
  try {
    for (;;) {
      if (!state.token) break;
      // Read storage again every time: another tab may have added, replaced or sent items.
      const items = await syncOutbox();
      const item = nextToSend(items, { now: Date.now(), blocked, canSend: i => canSend(i) && !handled.has(i.id) });
      if (!item) break;
      handled.add(item.id);
      inFlight = item.id;
      let result: SentResult | null = null;
      let failure: ApiError | null = null;
      try {
        result = await sendItem(item);
      } catch (e) {
        failure = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      } finally {
        inFlight = null;
      }
      if (!failure) {
        noAnswer = 0;
        noteOnline(true);
        touched.add(item.groupId);
        await commitSent(item, result);
        continue;
      }
      const err = failure;
      // The session ended: handleUnauthorized keeps the items for when this account signs in again.
      if (err.status === 401) break;
      if (err.retryable) {
        const at = Date.now();
        const lastError = { code: err.code, message: err.message, at };
        await updateItem(item.id, o => ({ ...o, attempts: o.attempts + 1, nextTryAt: at + backoff(o.attempts + 1), lastError }));
        if (err.code === 'offline') {
          noteOnline(false);
          // No answer at all usually means no connection, so stop. A server error page the
          // browser cannot read looks the same, so one other entry gets a try first.
          if (!browserOnline() || ++noAnswer >= 2) break;
        } else {
          noteOnline(true);
        }
        blocked.add(entryKey(item));
        continue;
      }
      noteOnline(true);
      touched.add(item.groupId);
      const error: OutboxError = { code: err.code, message: err.message };
      await updateItem(item.id, o => ({ ...o, error }));
      showToast({ message: t('有一筆變更無法同步，請到群組裡查看。', 'One change could not be synced. Open the group to review it.'), kind: 'error' });
    }
  } finally {
    set({ syncing: false });
  }
  if (touched.size) {
    await Promise.all([...touched].map(gid => actions.loadGroup(gid, { force: true }).catch(() => undefined)));
    void actions.loadMe();
  }
}

// ---------- optimistic view ----------

export interface PendingInfo {
  state: 'pending' | 'failed';
  /** The item 重試 / 放棄 act on: the failed one, or the entry's next item to go out. */
  itemId: string;
  /** The entry's main change (a save, delete or restore before a comment). */
  op: OutboxOp;
  /** Why it failed, in the current language. */
  error: { code: string; message: string } | null;
  /** Tries so far. */
  attempts: number;
  /** A pending item's last failure (no connection, server trouble); it keeps retrying by itself. */
  lastError: { code: string; message: string; at: number } | null;
}

export interface GroupView {
  snap: GroupSnapshotDTO | null;
  /** Expense ids with unsynced changes. */
  pending: Record<string, PendingInfo>;
  /** Comments waiting to be sent, per expense. */
  pendingComments: Record<string, { id: string; body: string; createdAt: number }[]>;
  loading: boolean;
  error: ApiError | null;
}

function localExpense(gid: string, eid: string, body: UpsertExpenseReq, existing: ExpenseDTO | undefined, userId: string): ExpenseDTO {
  const now = new Date().toISOString();
  const r = computeSharesFor(eid, body.amount, body.split);
  const repeat = body.repeat ?? 'none';
  return {
    id: eid,
    groupId: gid,
    kind: body.kind,
    description: body.description,
    category: body.category,
    amount: body.amount,
    currency: body.currency,
    fxRate: body.fxRate,
    date: body.date,
    notes: body.notes ?? '',
    payers: body.payers,
    split: body.split,
    shares: r.ok ? r.shares : existing?.shares ?? [],
    repeat,
    repeatSeries: existing?.repeatSeries ?? (repeat !== 'none' ? eid : null),
    repeatStart: existing?.repeatStart ?? (repeat !== 'none' ? body.date : null),
    createdBy: existing?.createdBy ?? userId,
    createdAt: existing?.createdAt ?? now,
    updatedBy: userId,
    updatedAt: now,
    deletedAt: existing?.deletedAt ?? null,
    deletedBy: existing?.deletedBy ?? null,
    version: (existing?.version ?? 0) + 1,
    commentCount: existing?.commentCount ?? 0,
  };
}

function shownError(e: OutboxError): OutboxError {
  return { code: e.code, message: errorMessage(new ApiError(0, e.code as ClientErrorCode, e.message)) };
}

/** One entry's sync state from its live items (oldest first): a failure shows first, so 重試 / 放棄 stay in reach. */
function pendingInfo(list: readonly OutboxItem[]): PendingInfo {
  const failed = list.find(i => i.error);
  if (failed && failed.error) {
    return { state: 'failed', itemId: failed.id, op: failed.op, error: shownError(failed.error), attempts: failed.attempts, lastError: failed.lastError ?? null };
  }
  const head = list[0];
  const main = [...list].reverse().find(i => replacesEntry(i.op)) ?? list[list.length - 1];
  return { state: 'pending', itemId: head.id, op: main.op, error: null, attempts: head.attempts, lastError: head.lastError ?? null };
}

export function applyOutbox(snap: GroupSnapshotDTO | null, items: readonly OutboxItem[], userId: string): Omit<GroupView, 'loading' | 'error'> {
  const pending: Record<string, PendingInfo> = {};
  const pendingComments: GroupView['pendingComments'] = {};
  if (!snap) return { snap, pending, pendingComments };
  const gid = snap.group.id;
  // A failed change that a later one of the same entry replaced shows nothing (the later one wins).
  const mine = liveItems(items.filter(i => i.groupId === gid));
  if (!mine.length) return { snap, pending, pendingComments };
  const expenses = [...snap.expenses];
  const index = new Map(expenses.map((e, i) => [e.id, i]));
  const byEntry = new Map<string, OutboxItem[]>();
  for (const it of mine) {
    const at = index.get(it.expenseId);
    const existing = at !== undefined ? expenses[at] : undefined;
    if (it.op === 'upsert' && it.body) {
      const e = localExpense(gid, it.expenseId, it.body as UpsertExpenseReq, existing, userId);
      if (at !== undefined) expenses[at] = e;
      else { index.set(e.id, expenses.length); expenses.push(e); }
    } else if (it.op === 'delete' && existing && at !== undefined) {
      expenses[at] = { ...existing, deletedAt: new Date(it.createdAt).toISOString(), deletedBy: userId };
    } else if (it.op === 'restore' && existing && at !== undefined) {
      expenses[at] = { ...existing, deletedAt: null, deletedBy: null };
    } else if (it.op === 'comment' && it.body) {
      const b = it.body as { id: string; body: string };
      (pendingComments[it.expenseId] ??= []).push({ id: b.id, body: b.body, createdAt: it.createdAt });
      if (existing && at !== undefined) expenses[at] = { ...existing, commentCount: existing.commentCount + 1 };
    }
    const list = byEntry.get(it.expenseId);
    if (list) list.push(it);
    else byEntry.set(it.expenseId, [it]);
  }
  for (const [eid, list] of byEntry) pending[eid] = pendingInfo(list);
  return { snap: { ...snap, expenses: sortExpenses(expenses) }, pending, pendingComments };
}

/** The group as the user should see it: server data plus unsynced local changes. */
export function useGroupView(gid: string | undefined): GroupView {
  const entry = useStore(s => (gid ? s.groups[gid] : undefined));
  const outbox = useStore(s => s.outbox);
  const userId = useStore(s => s.me?.user.id ?? '');
  return useMemo(() => {
    const merged = applyOutbox(entry?.snap ?? null, outbox, userId);
    return { ...merged, loading: entry?.loading ?? false, error: entry?.error ?? null };
  }, [entry, outbox, userId]);
}

/** Members of a group by id (from the merged view). */
export function membersById(snap: GroupSnapshotDTO | null): Record<string, MemberDTO> {
  const out: Record<string, MemberDTO> = {};
  for (const m of snap?.members ?? []) out[m.id] = m;
  return out;
}

/** After the last change waiting for a group that is gone (removed, deleted) is dealt with, forget the group. */
function forgetIfGone(gid: string): void {
  const g = state.groups[gid];
  if (!g || g.error?.code !== 'not_found' || !g.snap || state.outbox.some(o => o.groupId === gid)) return;
  const err = g.error;
  dropGroup(gid);
  setGroup(gid, { loading: false, error: err });
}

// ---------- fx cache ----------

const fxMem = new Map<string, FxRes>();

// ---------- actions ----------

function afterAuth(res: AuthRes): void {
  setToken(res.token);
  currentUserId = res.user.id;
  if (res.user.locale && res.user.locale !== getLocale()) setLocale(res.user.locale);
  set({ token: res.token, me: state.me && state.me.user.id === res.user.id ? { ...state.me, user: res.user } : null });
  void actions.loadMe();
}

/** A sign-in that replaces this device's session (password, code, reset link): changes this device held for that account come back. */
async function switchSession(res: AuthRes): Promise<void> {
  await clearSession({ hold: true });
  afterAuth(res);
  await restoreHeld(res.user.id);
}

/** The group's currency as this device last saw it (cached group, else the dashboard list). */
function groupCurrencyOf(gid: string): string | undefined {
  return state.groups[gid]?.snap?.group.currency ?? state.me?.groups.find(g => g.id === gid)?.currency;
}

export const actions = {
  // ----- auth -----
  /** Create an account. With email + password, the password is turned into a key on the device first. */
  async signup(req: SignupReq): Promise<UserDTO> {
    const body: SignupReq = { locale: getLocale(), ...req };
    if (req.email && req.password !== undefined) {
      if (!passwordOk(req.password)) weak();
      body.password = await passwordKey(req.email, req.password);
    }
    const res = await call(() => api<AuthRes>('POST', '/api/auth/signup', body, { anonymous: true }));
    afterAuth(res);
    return res.user;
  },
  async login(req: LoginReq): Promise<UserDTO> {
    const key = await passwordKey(req.email, req.password);
    const res = await call(() => api<AuthRes>('POST', '/api/auth/login', { email: req.email, password: key }, { anonymous: true }));
    await switchSession(res);
    return res.user;
  },
  async linkLogin(code: string): Promise<UserDTO> {
    const res = await call(() => api<AuthRes>('POST', '/api/auth/link', { code: code.replace(/[\s-]/g, '').toUpperCase() }, { anonymous: true }));
    await switchSession(res);
    return res.user;
  },
  /** Who a reset link belongs to (the email is needed to derive the password key). */
  async resetInfo(token: string): Promise<{ email: string; expiresAt: string }> {
    return call(() => api<{ email: string; expiresAt: string }>('GET', '/api/auth/reset/' + encodeURIComponent(token), undefined, { anonymous: true }));
  },
  async resetPassword(token: string, password: string): Promise<UserDTO> {
    if (!passwordOk(password)) weak();
    const info = await actions.resetInfo(token);
    const key = await passwordKey(info.email, password);
    const res = await call(() => api<AuthRes>('POST', '/api/auth/reset', { token, password: key }, { anonymous: true }));
    await switchSession(res);
    return res.user;
  },
  async logout(): Promise<void> {
    try {
      await api('POST', '/api/auth/logout', {});
    } catch {
      /* signing out locally is what matters */
    }
    markSignedOut();
    await clearSession();
    navigate('/welcome', { replace: true });
  },
  /** The signed-out explanation (App.tsx) was shown. */
  dismissSignedOutNotice(): void {
    if (state.signedOut) set({ signedOut: null });
  },

  // ----- me -----
  async loadMe(): Promise<MeDTO | null> {
    if (!state.token) return null;
    const token = state.token;
    set({ meLoading: true });
    try {
      const me = await call(() => api<MeDTO>('GET', '/api/me'));
      // Signed out or into another account meanwhile: this answer belongs to the old session.
      if (state.token !== token) return state.me;
      const newUser = currentUserId !== me.user.id;
      currentUserId = me.user.id;
      set({ me, meLoading: false, meError: null });
      persist('me', me);
      if (newUser) void syncOutbox().then(() => flush());
      return me;
    } catch (e) {
      if (state.token === token) set({ meLoading: false, meError: e instanceof ApiError ? e : null });
      return state.me;
    }
  },
  async updateMe(req: UpdateMeReq): Promise<UserDTO> {
    if (req.locale) setLocale(req.locale);
    const res = await call(() => api<{ user: UserDTO }>('PATCH', '/api/me', req));
    if (state.me) {
      const me = { ...state.me, user: res.user };
      set({ me });
      persist('me', me);
    }
    void actions.loadMe();
    return res.user;
  },
  /** Add or change the sign-in email and password (keys are derived on the device). */
  async setCredentials(req: CredentialsReq): Promise<UserDTO> {
    if (!passwordOk(req.password)) weak();
    const oldEmail = state.me?.user.email ?? req.email;
    const body: CredentialsReq = { email: req.email, password: await passwordKey(req.email, req.password) };
    if (req.currentPassword) body.currentPassword = await passwordKey(oldEmail, req.currentPassword);
    const res = await call(() => api<{ user: UserDTO }>('POST', '/api/me/credentials', body));
    if (state.me) {
      const me = { ...state.me, user: res.user };
      set({ me });
      persist('me', me);
    }
    return res.user;
  },
  async deleteAccount(password?: string): Promise<void> {
    const email = state.me?.user.email;
    const key = password && email ? await passwordKey(email, password) : undefined;
    await call(() => api('DELETE', '/api/me', { password: key }));
    markSignedOut();
    await clearSession();
    navigate('/welcome', { replace: true });
  },
  /**
   * For "Add to Home Screen" on iPhone: put a one-time sign-in code in this page's URL, so the
   * installed app (which does not share Safari's storage) opens already signed in.
   * Valid 10 minutes.
   */
  async prepareInstall(): Promise<LinkCodeRes> {
    const r = await actions.createLinkCode();
    const url = new URL(location.href);
    url.searchParams.set('install', r.code);
    history.replaceState(history.state, '', url.toString());
    return r;
  },
  async exportData(): Promise<unknown> {
    return call(() => api('GET', '/api/me/export'));
  },
  async listSessions(): Promise<SessionDTO[]> {
    const r = await call(() => api<{ sessions: SessionDTO[] }>('GET', '/api/auth/sessions'));
    return r.sessions;
  },
  async revokeSession(id: string): Promise<void> {
    await call(() => api('DELETE', '/api/auth/sessions/' + encodeURIComponent(id)));
  },
  async createLinkCode(): Promise<LinkCodeRes> {
    return call(() => api<LinkCodeRes>('POST', '/api/auth/link-code', {}));
  },

  // ----- groups -----
  async loadGroup(gid: string, opts: { force?: boolean } = {}): Promise<GroupSnapshotDTO | null> {
    const entry = state.groups[gid];
    if (entry?.loading && !opts.force) return entry.snap;
    setGroup(gid, { loading: true });
    try {
      const r = await call(() => apiRaw<GroupSnapshotDTO>('GET', '/api/groups/' + encodeURIComponent(gid), undefined, { etag: entry?.etag && entry.snap ? entry.etag : undefined }));
      if (r.status === 304) {
        setGroup(gid, { loading: false, error: null, fetchedAt: Date.now() });
        return state.groups[gid]?.snap ?? null;
      }
      const snap = r.data ?? null;
      if (snap && snap.group.version < (writeFloor.get(gid) ?? 0)) {
        // Older than a change this device already saw land (a slow answer to an earlier
        // request): keep what is shown; the next fetch gets the group in full.
        setGroup(gid, { loading: false });
        return state.groups[gid]?.snap ?? null;
      }
      setGroup(gid, { snap, etag: r.etag, loading: false, error: null, fetchedAt: Date.now() });
      return snap;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      if (err.code === 'not_found') {
        if (state.groups[gid]?.snap && state.outbox.some(o => o.groupId === gid)) {
          // Removed from the group, or it was deleted, while changes for it still wait here: keep
          // the last copy so they stay in view with 重試 / 放棄 (discarding the last one forgets it).
          setGroup(gid, { loading: false, error: err });
        } else {
          dropGroup(gid);
          setGroup(gid, { loading: false, error: err });
        }
      } else {
        setGroup(gid, { loading: false, error: err });
      }
      return state.groups[gid]?.snap ?? null;
    }
  },
  async createGroup(req: CreateGroupReq): Promise<string> {
    const snap = await call(() => api<GroupSnapshotDTO>('POST', '/api/groups', req));
    noteWrite(snap.group.id, snap.group.version);
    setGroup(snap.group.id, { snap, etag: `"${snap.group.version}"`, loading: false, error: null, fetchedAt: Date.now() });
    void actions.loadMe();
    return snap.group.id;
  },
  async updateGroup(gid: string, req: UpdateGroupReq): Promise<GroupSnapshotDTO> {
    const snap = await call(() => api<GroupSnapshotDTO>('PATCH', '/api/groups/' + encodeURIComponent(gid), req));
    noteWrite(gid, snap.group.version);
    setGroup(gid, { snap, etag: `"${snap.group.version}"`, error: null, fetchedAt: Date.now() });
    void actions.loadMe();
    return snap;
  },
  async deleteGroup(gid: string): Promise<void> {
    await call(() => api('DELETE', '/api/groups/' + encodeURIComponent(gid)));
    dropGroup(gid);
    const ids = mergeItems(await readOutbox(), state.outbox).filter(o => o.groupId === gid).map(o => o.id);
    set(s => ({ outbox: s.outbox.filter(o => o.groupId !== gid) }));
    if (ids.length) void writeOutbox([], ids);
    void actions.loadMe();
  },
  async addMember(gid: string, req: AddMemberReq): Promise<MemberDTO> {
    const r = await call(() => api<{ member: MemberDTO }>('POST', `/api/groups/${encodeURIComponent(gid)}/members`, req));
    await actions.loadGroup(gid, { force: true });
    void actions.loadMe();
    return r.member;
  },
  async updateMember(gid: string, mid: string, req: UpdateMemberReq): Promise<MemberDTO> {
    const r = await call(() => api<{ member: MemberDTO }>('PATCH', `/api/groups/${encodeURIComponent(gid)}/members/${encodeURIComponent(mid)}`, req));
    await actions.loadGroup(gid, { force: true });
    return r.member;
  },
  /** Remove a member (admin) or leave the group (your own member id). */
  async removeMember(gid: string, mid: string): Promise<void> {
    const leaving = state.groups[gid]?.snap?.me.memberId === mid;
    if (leaving) {
      // After leaving, changes still queued for the group could never be sent, retried or seen.
      await flush();
      const left = (await syncOutbox()).filter(o => o.groupId === gid).length;
      if (left) {
        throw new ApiError(
          0,
          'unsynced',
          t('這個群組還有 {n} 筆變更沒同步。請等同步完成，或放棄這些變更，再離開群組。', 'This group has {n} unsynced changes. Wait until they sync, or discard them, and then leave.', { n: left }),
        );
      }
    }
    await call(() => api('DELETE', `/api/groups/${encodeURIComponent(gid)}/members/${encodeURIComponent(mid)}`));
    if (leaving) dropGroup(gid);
    else await actions.loadGroup(gid, { force: true });
    void actions.loadMe();
  },
  async unlinkMember(gid: string, mid: string): Promise<void> {
    await call(() => api('POST', `/api/groups/${encodeURIComponent(gid)}/members/${encodeURIComponent(mid)}/unlink`, {}));
    await actions.loadGroup(gid, { force: true });
  },
  async claimLink(gid: string, mid: string): Promise<{ token: string; url: string; expiresAt: string }> {
    return call(() => api('POST', `/api/groups/${encodeURIComponent(gid)}/members/${encodeURIComponent(mid)}/claim-link`, {}));
  },
  async resetInvite(gid: string): Promise<string> {
    const r = await call(() => api<{ inviteCode: string }>('POST', `/api/groups/${encodeURIComponent(gid)}/invite/reset`, {}));
    await actions.loadGroup(gid, { force: true });
    return r.inviteCode;
  },
  async joinInfo(code: string): Promise<JoinInfoDTO> {
    return call(() => api<JoinInfoDTO>('GET', '/api/join/' + encodeURIComponent(code)));
  },
  async join(code: string, req: JoinReq): Promise<{ groupId: string; memberId: string }> {
    const r = await call(() => api<{ groupId: string; memberId: string }>('POST', '/api/join/' + encodeURIComponent(code), req));
    await actions.loadGroup(r.groupId, { force: true });
    void actions.loadMe();
    return r;
  },
  async claimInfo(token: string): Promise<ClaimInfoDTO> {
    return call(() => api<ClaimInfoDTO>('GET', '/api/claim/' + encodeURIComponent(token), undefined, { anonymous: true }));
  },
  async claim(token: string): Promise<{ groupId: string; memberId: string }> {
    const r = await call(() => api<{ groupId: string; memberId: string }>('POST', '/api/claim/' + encodeURIComponent(token), {}));
    await actions.loadGroup(r.groupId, { force: true });
    void actions.loadMe();
    return r;
  },
  async addFriend(req: { name: string; email?: string }): Promise<string> {
    const r = await call(() => api<{ groupId: string }>('POST', '/api/friends', req));
    await actions.loadGroup(r.groupId, { force: true });
    void actions.loadMe();
    return r.groupId;
  },

  // ----- expenses (offline-capable) -----
  /** Create or update an expense or payment. Returns at once; syncing happens in the background. */
  saveExpense(gid: string, eid: string, body: UpsertExpenseReq): void {
    // Record which group currency the rate was chosen against, so a currency change made by
    // someone else before this save syncs is converted instead of booked at the wrong rate.
    const rateBase = body.rateBase ?? groupCurrencyOf(gid);
    enqueue({ op: 'upsert', groupId: gid, expenseId: eid, body: rateBase ? { ...body, rateBase } : body });
  },
  deleteExpense(gid: string, eid: string): void {
    enqueue({ op: 'delete', groupId: gid, expenseId: eid });
  },
  restoreExpense(gid: string, eid: string): void {
    enqueue({ op: 'restore', groupId: gid, expenseId: eid });
  },
  addComment(gid: string, eid: string, body: string): void {
    enqueue({ op: 'comment', groupId: gid, expenseId: eid, body: { id: crypto.randomUUID(), body } });
  },
  /** Send an outbox item again now: one that failed for good, or one waiting for its next try. */
  retry(itemId: string): void {
    void updateItem(itemId, o => ({ ...o, error: null, attempts: 0, nextTryAt: 0 }));
    void flush();
  },
  /** Throw away an unsynced change. */
  discard(itemId: string): void {
    const it = state.outbox.find(o => o.id === itemId);
    set(s => ({ outbox: s.outbox.filter(o => o.id !== itemId) }));
    void writeOutbox([], [itemId]);
    if (it) forgetIfGone(it.groupId);
  },
  async deleteComment(gid: string, cid: string): Promise<void> {
    await call(() => api('DELETE', `/api/groups/${encodeURIComponent(gid)}/comments/${encodeURIComponent(cid)}`));
    void actions.loadGroup(gid, { force: true });
  },
  async loadComments(gid: string, eid: string): Promise<CommentDTO[]> {
    const r = await call(() => api<{ comments: CommentDTO[] }>('GET', `/api/groups/${encodeURIComponent(gid)}/expenses/${encodeURIComponent(eid)}/comments`));
    return r.comments;
  },
  async loadHistory(gid: string, eid: string): Promise<ActivityDTO[]> {
    const r = await call(() => api<{ items: ActivityDTO[] }>('GET', `/api/groups/${encodeURIComponent(gid)}/expenses/${encodeURIComponent(eid)}/history`));
    return r.items;
  },
  async importExpenses(gid: string, list: BatchImportReq['expenses'], onProgress?: (done: number) => void): Promise<number> {
    let done = 0;
    const base = groupCurrencyOf(gid);
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200).map(e => (base && !e.rateBase ? { ...e, rateBase: base } : e));
      const r = await call(() => api<{ imported: number }>('POST', `/api/groups/${encodeURIComponent(gid)}/import`, { expenses: chunk }));
      done += r.imported;
      onProgress?.(done);
    }
    await actions.loadGroup(gid, { force: true });
    void actions.loadMe();
    return done;
  },

  // ----- activity -----
  async loadActivity(more = false): Promise<void> {
    const cur = state.activity;
    if (cur.loading) return;
    if (more && !cur.next) return;
    set({ activity: { ...cur, loading: true } });
    try {
      const q = more && cur.next ? '?before=' + encodeURIComponent(cur.next) : '';
      const r = await call(() => api<{ items: ActivityDTO[]; next: string | null }>('GET', '/api/activity' + q));
      const items = more ? [...cur.items, ...r.items] : r.items;
      set({ activity: { items, next: r.next, loading: false, loaded: true, error: null } });
    } catch (e) {
      set({ activity: { ...state.activity, loading: false, error: e instanceof ApiError ? e : null } });
    }
  },
  async markActivitySeen(): Promise<void> {
    try {
      await api('POST', '/api/activity/seen', {});
      if (state.me) set({ me: { ...state.me, unread: 0 } });
    } catch {
      /* not important */
    }
  },

  // ----- exchange rates -----
  /** Rates into `base` for a date: rates[C] = value of 1 C in base. Falls back to cached data offline. */
  async getFx(base: string, date: string): Promise<(FxRes & { stale?: boolean }) | null> {
    const key = `fx:${base}:${date}`;
    const mem = fxMem.get(key);
    if (mem) return mem;
    try {
      const r = await call(() => api<FxRes>('GET', `/api/fx?base=${encodeURIComponent(base)}&date=${encodeURIComponent(date)}`, undefined, { anonymous: true, timeoutMs: 8000 }));
      fxMem.set(key, r);
      void idbSet(key, r);
      void idbSet(`fx:${base}:latest`, r);
      return r;
    } catch {
      const cached = (await idbGet<FxRes>(key)) ?? (await idbGet<FxRes>(`fx:${base}:latest`));
      return cached ? { ...cached, stale: true } : null;
    }
  },

  // ----- admin -----
  async adminResetLink(email: string): Promise<{ url: string; expiresAt: string }> {
    return call(() => api('POST', '/api/admin/reset-link', { email }));
  },
  async adminStats(): Promise<{ users: number; groups: number; expenses: number }> {
    return call(() => api('GET', '/api/admin/stats'));
  },
  /** Who signed up, newest first, with the site-wide counts. `q` matches part of a name or email. */
  async adminUsers(opts: { q?: string; limit?: number; offset?: number } = {}): Promise<AdminUsersRes> {
    const p = new URLSearchParams();
    if (opts.q) p.set('q', opts.q);
    if (opts.limit !== undefined) p.set('limit', String(opts.limit));
    if (opts.offset) p.set('offset', String(opts.offset));
    const qs = p.toString();
    return call(() => api<AdminUsersRes>('GET', '/api/admin/users' + (qs ? '?' + qs : '')));
  },
  /** One account in full: profile, payment details, groups, devices and recent activity. */
  async adminUser(id: string): Promise<AdminUserRes> {
    return call(() => api<AdminUserRes>('GET', '/api/admin/users/' + encodeURIComponent(id)));
  },
};

export type Actions = typeof actions;
