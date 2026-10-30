// App state and every server call. Pages read state with useStore()/useGroupView() and change
// things only through `actions`. Expense writes (save, delete, restore, comment) go through an
// outbox so they work offline. They are retried in order for each entry, and an entry that keeps
// failing never holds back another one.
//
// The receipt photos kept with an entry (up to three) go through the outbox too: one item per
// photo change (op 'photo', a photo to add as a data URL, or a version to drop), queued right
// after the entry's save, so they go up once the entry exists, offline or not. They are stored
// with `entryId` instead of `expenseId` (outbox.ts toStored), so builds from before several photos,
// open in another tab, skip them. Items of op 'receipt' that such a build queued are still sent,
// to the legacy routes, with their legacy meaning.
//
// Every tab of the app shares the outbox: each item is its own IndexedDB record (outbox:<id>),
// each tab mirrors the records in memory and reads them again when another tab announces a
// change (BroadcastChannel, or a localStorage ping where that is missing), and one tab at a time
// sends (Web Locks). When the session ends on its own (a 401: signed out from another device, a
// password reset), unsynced items stay on the device, filed under the account (held:<userId>),
// and go out when the same person signs in again.
//
// Signing in (api.ts): where the app and the API share an origin (cookie mode), the session is an
// HttpOnly cookie the Worker sets, and its readable marker says at start, with no request and
// offline, which account it is. State.token is then an opaque key for this tab's session
// (cookie:<userId>:<n>), so every "signed in?" check and every "is this answer still for the
// session that asked?" check means what it always did. A token an older build left in
// localStorage is moved into the cookie when online; tabs follow each other's sign-ins through
// a {type: 'session'} message and when they come to the front. A cookie another *.ginochang.com
// site planted can read like the marker, so until GET /api/me names the account (markerOnly),
// what another account left here (cached data, queued changes, a token copy) is only kept out of
// view, never deleted or filed away.

import { useMemo, useSyncExternalStore } from 'react';
import { computeSharesFor } from '../../shared/split';
import type {
  ActivityDTO, AddEmailStartReq, AddEmailVerifyReq, AddEmailVerifyRes, AddMemberReq, AdminUserRes, AdminUsersRes, ArchiveReq, ArchiveRes, AuthRes, AvatarReq, AvatarRes,
  BatchImportReq, ClaimInfoDTO, CommentDTO, CreateGroupReq, CredentialsReq, DefaultSplitInput, EmailStartReq, EmailStartRes, EmailVerifyReq, EmailVerifyRes,
  ExpenseDTO, FxRes, GroupSnapshotDTO, InviteAcceptRes, InviteInfoDTO, JoinInfoDTO, JoinReq, LinkCodeRes, Locale, LoginReq, MeDTO, MemberDTO,
  MyInviteDTO, PendingLinkDTO, ProviderLinkRes, ReceiptDeleteRes, ReceiptPhotosRes, ReceiptRes, SessionDTO, UpdateGroupReq, UpdateMeReq,
  UpdateMemberReq, UpsertExpenseReq, UpsertExpenseRes, UserDTO,
} from '../../shared/types';
import { photosOf } from '../../shared/receipts';
import {
  api, apiRaw, ApiError, authMode, browserOnline, fallBackToBearer, getCookieUser, getToken, keepTokenCopy, markerUser, setCookieUser,
  setSessionChangedHandler, setToken, setUnauthorizedHandler, storedToken, TOKEN_STORAGE_KEY, tokenCopyUser, type ClientErrorCode,
} from './api';
import { passwordKey, passwordOk } from './crypto';
import { errorMessage } from './errors';
import { isStandalone } from './pwa';
import { idbBatch, idbClear, idbDel, idbEntries, idbGet, idbKeys, idbSet, idbTryEntries, type IdbOp } from './idb';
import { getLocale, setLocale, t } from './i18n';
import {
  entryKey, fromStored, isOutboxItem, isReceiptRemoval, liveItems, mergeItems, nextToSend, outboxSignature, patchAfterSend, photoAdd,
  photoChangePlan, photoDrop, replaceableReceipts, replaceableSave, replacesEntry, retryDelay, sameEntry, sortExpenses, sortOutbox,
  staleFailures, summarizeItem, supersededIds, toStored, type ChangeSummary, type OutboxError, type OutboxItem, type OutboxOp,
  type PendingPhotos, type PendingReceipt, type PhotoChange, type ReceiptChange, type SentResult, type StoredOutboxItem,
} from './outbox';
import { dataUrlToBytes, photoVersion } from './photo';
import { navigate } from './router';
import { showToast } from './toast';

export type { ChangeSummary, OutboxItem, OutboxOp, PendingPhotoAdd, PendingPhotos, PendingReceipt, VisiblePhoto } from './outbox';
export { photosPastMax, visiblePhotos } from './outbox';

/** A receipt photo to add to an entry: the JPEG to keep (lib/photo.ts receiptPhoto) and its version (photoVersion). */
export interface PhotoUpload {
  version: string;
  image: string;
  width: number;
  height: number;
}

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
  /** The account has an email, so a code sent to it signs in again (without one, only a code from another device does). */
  hasEmail: boolean;
}

export interface State {
  /** Cached data has been read from IndexedDB. */
  booted: boolean;
  /**
   * This tab's session, null when signed out. Bearer mode: the token. Cookie mode: an opaque
   * key, cookie:<userId>:<n> (or, until it is moved into the cookie, a token an older build saved).
   */
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

let sessionSeq = 0;

/** State.token for a cookie session: opaque, new for each sign-in in this tab. */
function cookieKey(userId: string): string {
  return `cookie:${userId}:${++sessionSeq}`;
}

let state: State = {
  booted: false,
  // Cookie mode with the marker: signed in as that account, also offline (api.ts read it at load).
  token: getCookieUser() ? cookieKey(getCookieUser()!) : getToken(),
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
  /** As stored (outbox.ts toStored): read them through fromStored. */
  items: StoredOutboxItem[];
}

function isHeld(v: unknown): v is HeldRecord {
  return !!v && typeof v === 'object' && Array.isArray((v as HeldRecord).items) && typeof (v as HeldRecord).heldAt === 'number';
}

/** The account this tab is signed in as, once known (auth response, cached or fetched /api/me). */
let currentUserId: string | null = null;

/**
 * Cookie mode: currentUserId came from the marker cookie at start, and no server answer has named
 * the account since (loadMe, a sign-in, a cookie check). The marker alone may be a cookie another
 * site planted (api.ts markerUser), so until then nothing of another account is deleted or filed
 * away (settleMarkerStart does that), and a sign-out touches only what is recorded for this one.
 */
let markerOnly = false;

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
    ...puts.map(i => ({ type: 'put' as const, key: OUTBOX + i.id, value: toStored(i) })),
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
  const ok = await idbBatch([{ type: 'update', key: OUTBOX + id, fn: v => (isOutboxItem(v) ? toStored(fn(fromStored(v))) : undefined) }]);
  if (ok) landed?.();
  announce({ type: 'outbox' });
}

/** Every outbox item in storage, with this tab's writes that have not landed applied, oldest first. */
async function readOutbox(): Promise<OutboxItem[]> {
  const rows = await idbTryEntries<unknown>(OUTBOX);
  const byId = new Map<string, OutboxItem>();
  if (rows) {
    for (const [, v] of rows) if (isOutboxItem(v)) byId.set(v.id, fromStored(v));
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
  hashLegacyPhotos(items);
  if (outboxSignature(items) === outboxSignature(state.outbox)) return;
  set({ outbox: items });
}

/**
 * The version each legacy queued photo (op 'receipt' with an image, from a build before several
 * photos) has on the server once its PUT lands: the SHA-256 of its bytes, as the Worker versions
 * it. Worked out as the item is read from storage, so a removal of that photo can queue the drop of
 * it at once, in order with the rest of a save (removeReceiptPhoto). Kept for the session: the
 * editor may still show the photo after its item went through. '' while it is being worked out.
 */
const legacyVersions = new Map<string, string>();

function hashLegacyPhotos(items: readonly OutboxItem[]): void {
  for (const it of items) {
    if (it.op !== 'receipt' || legacyVersions.has(it.id)) continue;
    const b = it.body as ReceiptChange | undefined;
    if (!b || !('image' in b) || typeof b.image !== 'string') continue;
    legacyVersions.set(it.id, '');
    void photoVersion(b.image).then(
      v => (v ? legacyVersions.set(it.id, v) : legacyVersions.delete(it.id)),
      () => legacyVersions.delete(it.id),
    );
  }
}

let readSeq = 0;

/** Bring this tab's outbox in line with storage (another tab may have changed it). Resolves this account's items. */
async function syncOutbox(): Promise<OutboxItem[]> {
  if (!state.token) return [];
  const seq = ++readSeq;
  const token = state.token;
  const all = await readOutbox();
  if (state.token !== token) return [];
  // Another account's items (queued in a tab that was still signed in as it): keep them for it.
  // Not from a tab the browser's sign-in has moved away from: they may be the live changes of the
  // account signed in now, so this tab only stops showing them (it reloads into that account).
  // Nor on the marker alone (markerOnly): they wait, out of view, until loadMe names this account.
  const foreign = currentUserId && !markerOnly && !sessionMoved() ? all.filter(i => !isMine(i)) : [];
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
      items: mergeItems(isHeld(prev) ? prev.items.filter(isOutboxItem).map(fromStored) : [], list).map(toStored),
    }),
  }));
  return writeOutbox([], items.map(i => i.id), holds);
}

/** Put back what this device held for the account that just signed in, and send it. */
async function restoreHeld(userId: string): Promise<void> {
  const rec = await idbGet<HeldRecord>(HELD + userId);
  if (!isHeld(rec) || !state.token || currentUserId !== userId) return;
  const back = rec.items.filter(isOutboxItem).map(fromStored).map(i => ({ ...i, userId, attempts: 0, nextTryAt: 0 }));
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
  | { type: 'sent'; groupId: string; op: OutboxOp; expenseId: string; result: SentResult | null }
  /** A tab signed in, out, or moved its token into the cookie (cookie mode: compare the marker). */
  | { type: 'session' };

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
  if (!msg) return;
  if (msg.type === 'session') {
    followSession();
    return;
  }
  if (!state.token) return;
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
  setSessionChangedHandler(reloadForSession);
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
    idbEntries<unknown>(OUTBOX),
    idbKeys('group:'),
  ]);
  const groups: Record<string, GroupEntry> = {};
  await Promise.all(keys.map(async k => {
    const v = await idbGet<{ snap: GroupSnapshotDTO; etag: string | null }>(k);
    if (v?.snap) groups[k.slice(6)] = { snap: v.snap, etag: v.etag, loading: false, error: null, fetchedAt: 0 };
  }));
  const owner = me?.user.id ?? null;
  // Cookie mode: the marker names the account, also offline and after Safari cleared the site's
  // storage (the cookies outlive it). Data cached for another account is not shown, and is
  // deleted only once GET /api/me names this account (settleMarkerStart).
  const cookieUid = getCookieUser();
  currentUserId = cookieUid ?? (state.token ? owner : null);
  markerOnly = !!cookieUid;
  let cachedMe = state.token ? me ?? null : null;
  if (cookieUid) {
    if (cachedMe && cachedMe.user.id !== cookieUid) cachedMe = null;
    for (const [gid, entry] of Object.entries(groups)) {
      if (snapUser(entry.snap) !== cookieUid) delete groups[gid];
    }
  }

  let items = rows.map(([, v]) => v).filter(isOutboxItem).map(fromStored);
  if (Array.isArray(legacy)) {
    // One record per item from now on (earlier versions kept a single array).
    const have = new Set(items.map(i => i.id));
    const moved = legacy.filter(isOutboxItem).map(fromStored).filter(i => !have.has(i.id)).map(i => ({ ...i, userId: i.userId ?? owner ?? undefined }));
    await idbBatch([...moved.map(i => ({ type: 'put' as const, key: OUTBOX + i.id, value: toStored(i) })), { type: 'del', key: LEGACY_OUTBOX }]);
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
  if (currentUserId) {
    // Another account's items are filed under it, except on the marker alone: then they only stay
    // out of view until loadMe names this account (syncOutbox files them then).
    const foreign = items.filter(i => !isMine(i));
    if (foreign.length && !markerOnly) await holdItems(foreign, null);
    items = items.filter(isMine);
  }
  void expireHolds();
  if (state.token) hashLegacyPhotos(items);
  set({ booted: true, me: cachedMe, outbox: state.token ? items : [], groups: state.token ? groups : {} });

  window.addEventListener('online', () => {
    set({ online: true });
    void wakeWaiting().then(() => flush());
    void actions.loadMe();
    void adoptLegacyToken();
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
    // sends anything as the wrong account. (On the session cookie, the marker says that instead:
    // followSession.)
    if ((e.key === TOKEN_STORAGE_KEY || e.key === null) && !getCookieUser() && !signInsRunning && storedToken() !== getToken()) {
      location.reload();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || followSession()) return;
    if (state.token) {
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
    void adoptLegacyToken();
  }
}

/** The account a cached group snapshot was fetched for (the account of its "me" member). */
function snapUser(snap: GroupSnapshotDTO | null): string | null {
  return snap?.members.find(m => m.id === snap.me.memberId)?.userId ?? null;
}

/** Keys of the cached `me` and group snapshots in storage that were fetched for another account than `userId`. */
async function othersCache(userId: string): Promise<string[]> {
  const [me, rows] = await Promise.all([idbGet<MeDTO>('me'), idbEntries<{ snap?: GroupSnapshotDTO | null }>('group:')]);
  const keys = rows.filter(([, v]) => snapUser(v?.snap ?? null) !== userId).map(([key]) => key);
  if (me && me.user?.id !== userId) keys.push('me');
  return keys;
}

/**
 * GET /api/me named the account this tab started as on the marker alone. While the browser is
 * still signed in as it, what start only kept out of view goes now: a token copy recorded for
 * another account (it would sign in the wrong person if the cookie lapsed), other accounts'
 * cached data, and their queued changes, which are filed under them (syncOutbox).
 */
async function settleMarkerStart(userId: string): Promise<void> {
  markerOnly = false;
  const key = state.token;
  if (getCookieUser() !== userId || markerUser() !== userId) return;
  const copyOwner = tokenCopyUser();
  if (copyOwner && copyOwner !== userId) keepTokenCopy(null, null);
  const stale = await othersCache(userId);
  if (state.token !== key || markerUser() !== userId) return;
  if (stale.length) await idbBatch(stale.map(k => ({ type: 'del' as const, key: k })));
  void syncOutbox();
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
  const hasEmail = !!state.me?.user.email;
  const kept = await clearSession({ hold: true });
  // Go first: a dialog belongs to the page it opens on (Dialog.tsx cancels it when the page changes).
  navigate('/welcome', { replace: true });
  if (kept.length) set({ signedOut: { changes: kept, hasEmail } });
  else showToast({ message: t('登入已失效，請重新登入。', 'You were signed out. Please sign in again.'), kind: 'error' });
}

/**
 * End the session on this device. With `hold`, unsynced changes stay, filed under their account,
 * and come back when it signs in again; they are returned, described for people. Without it
 * (signing out on purpose, deleting the account) this account's changes go with everything else.
 *
 * A tab the browser's sign-in has moved away from (sessionMoved) files or drops only its own
 * account's changes, and while another account is signed in, it also leaves that account's token
 * copy and cached data alone: they are that account's. `signIn`: a sign-in in this tab has just
 * replaced the browser's session (the Worker ended the one before), so the marker naming the new
 * account says nothing about this tab, and everything goes as before. A tab signed in on the
 * marker alone (markerOnly) touches only what is recorded for its account (changes queued as
 * it, a token copy saved for it, its cached data): the rest may be another account's only copy.
 */
async function clearSession(opts: { hold?: boolean; signIn?: boolean } = {}): Promise<ChangeSummary[]> {
  const userId = currentUserId;
  const unsure = markerOnly && !opts.signIn;
  markerOnly = false;
  const memory = state.outbox;
  const groups = state.groups;
  const moved = !opts.signIn && sessionMoved();
  const othersSignedIn = moved && !!markerUser();
  /** Only some of the queued changes are this account's to file away or drop. */
  const some = moved || unsure;
  const own = (i: OutboxItem) => (unsure ? !!userId && i.userId === userId : !userId || !i.userId || i.userId === userId);
  // The saved token goes, unless it is not this tab's (its Bearer token, or a copy recorded for
  // its account) while another account is signed in or this one was never confirmed.
  const t = getToken();
  const ownCopy = (!!t && storedToken() === t) || (!!userId && tokenCopyUser() === userId);
  setToken(null, ownCopy || (!othersSignedIn && !unsure));
  // A session cookie can only end at the Worker (logout, revoke, delete, or the 401 that found
  // it dead already cleared it); this tab just stops using it.
  setCookieUser(null);
  currentUserId = null;
  set({ token: null, me: null, meLoading: false, meError: null, groups: {}, outbox: [], activity: emptyActivity });
  cancelPersist();
  writeFloor.clear();
  let kept: OutboxItem[] = [];
  let heldOk = true;
  /** When only some are this account's: the outbox records that are its to drop. */
  let dropped = new Set<string>();
  if (opts.hold) {
    kept = mergeItems(await readOutbox(), memory);
    if (some) kept = kept.filter(own);
    heldOk = await holdItems(kept, userId);
  } else if (some) {
    dropped = new Set(mergeItems(await readOutbox(), memory).filter(own).map(i => OUTBOX + i.id));
  }
  // On the marker alone: the cached data of other accounts, which start kept out of view, stays.
  const others = unsure && userId ? new Set(await othersCache(userId)) : null;
  unsaved.clear();
  // If filing them away failed, the outbox records stay too (the next start files them).
  await idbClear(key => {
    if (key.startsWith(HELD)) return !!opts.hold || !userId || key !== HELD + userId;
    if (key.startsWith(OUTBOX)) return some ? !dropped.has(key) : !heldOk;
    return othersSignedIn || !!others?.has(key);
  });
  announce({ type: 'outbox' });
  announce({ type: 'session' });
  return kept.filter(own).map(i => summarizeItem(i, groups[i.groupId]?.snap?.expenses.find(e => e.id === i.expenseId)));
}

// ---------- the session cookie (cookie mode) ----------

/** Sign-ins running in this tab (cookie mode): until they finish, cookie changes are its own doing. */
let signInsRunning = 0;

async function duringSignIn<T>(fn: () => Promise<T>): Promise<T> {
  if (authMode() !== 'cookie') return fn();
  signInsRunning++;
  try {
    return await fn();
  } finally {
    signInsRunning--;
  }
}

const RELOADS_KEY = 'evenly.sessionReloads';
/** How long a reload this page asked for may take before the page asks again. */
const RELOAD_WAIT_MS = 3000;
/**
 * When this page last called location.reload() for the sign-in (0: never). The page can outlive
 * that call: the expense editor's "Reload site?" prompt over a half-typed entry, answered Cancel.
 * The next message, visit or request then asks again. A time, not a timer: background tabs run
 * timers late.
 */
let reloadAskedAt = 0;

/**
 * Start over as the browser's sign-in now (another tab signed in, out, or as someone else). A
 * count in sessionStorage stops a reload loop: a fourth reload within a minute signs this tab
 * out instead (unsynced changes are kept for their account, as after any 401). Each page counts
 * once, so asking again after a cancelled reload is not a loop.
 */
function reloadForSession(): void {
  if (signInsRunning) return;
  const now = Date.now();
  if (reloadAskedAt && now >= reloadAskedAt && now - reloadAskedAt < RELOAD_WAIT_MS) return;
  if (!reloadAskedAt) {
    let n = 0;
    let since = now;
    try {
      const r = JSON.parse(sessionStorage.getItem(RELOADS_KEY) || 'null') as { n?: unknown; since?: unknown } | null;
      if (r && typeof r.n === 'number' && typeof r.since === 'number' && now - r.since < 60_000) {
        n = r.n;
        since = r.since;
      }
      sessionStorage.setItem(RELOADS_KEY, JSON.stringify({ n: n + 1, since }));
    } catch {
      /* no sessionStorage: reload anyway */
    }
    if (n >= 3) {
      void handleUnauthorized();
      return;
    }
  }
  reloadAskedAt = now;
  location.reload();
  // A prompt holds the call until the person answers: wait from the answer.
  reloadAskedAt = Date.now();
}

/**
 * Cookie mode: the browser's sign-in (the marker cookie) is not this tab's any more: another tab
 * signed in, out, or as someone else, or the cookies went away. Such a tab reloads into the
 * browser's sign-in, and until it does, it must not file away or delete other accounts' changes:
 * they may be the live ones of the account signed in now.
 */
function sessionMoved(): boolean {
  if (authMode() !== 'cookie') return false;
  const marker = markerUser();
  const mine = getCookieUser();
  if (mine) return marker !== mine;
  // On a token: only another account's cookie counts.
  if (state.token) return !!marker && !!currentUserId && marker !== currentUserId;
  return !!marker; // signed out here, signed in in another tab
}

/**
 * Cookie mode: the marker cookie no longer matches this tab, so start over with the browser's
 * sign-in. Returns true when it moved (even while the reload asked for is on its way, or was
 * cancelled), so the caller does not go on as the old account.
 */
function followSession(): boolean {
  if (signInsRunning || !sessionMoved()) return false;
  reloadForSession();
  return true;
}

/**
 * This tab now uses the session cookie as `userId`: requests stop carrying the token, and
 * localStorage keeps `copy` (the same session's token; null drops any copy), see keepTokenCopy.
 */
function switchToCookie(userId: string, me: MeDTO, copy: string | null): void {
  setToken(null, false);
  keepTokenCopy(copy, copy ? userId : null);
  setCookieUser(userId);
  currentUserId = userId;
  markerOnly = false;
  const key = state.token && state.token.startsWith(`cookie:${userId}:`) ? state.token : cookieKey(userId);
  set({ token: key, me, meLoading: false, meError: null });
  persist('me', me);
}

type CookieCheck = { me: MeDTO } | 'none' | 'unknown';

/** GET /api/me with the cookie alone: its answer for `userId`, 'none' (no live cookie came), or 'unknown'. */
async function checkCookie(userId: string): Promise<CookieCheck> {
  try {
    const me = await call(() => api<MeDTO>('GET', '/api/me', undefined, { anonymous: true }));
    return me?.user?.id === userId ? { me } : 'unknown';
  } catch (e) {
    return e instanceof ApiError && e.status === 401 ? 'none' : 'unknown';
  }
}

type PutResult = { user: UserDTO } | 'refused' | 'dead' | 'unknown';

/** POST /api/auth/cookie: the Worker puts this tab's token into the cookies. */
async function putTokenInCookie(): Promise<PutResult> {
  try {
    const r = await call(() => api<{ user: UserDTO }>('POST', '/api/auth/cookie', {}));
    return r?.user?.id ? r : 'unknown';
  } catch (e) {
    if (!(e instanceof ApiError) || e.retryable) return 'unknown';
    // 401: the token was dead (handleUnauthorized signs this tab out). Anything else: the
    // Worker will not keep the session in a cookie for this page.
    return e.status === 401 ? 'dead' : 'refused';
  }
}

/**
 * After a sign-in in cookie mode: forget the token once a request with the cookie alone shows
 * the browser kept the cookie. Otherwise keep the token, saved, so the sign-in survives a reload,
 * and where the browser keeps no cookies at all, stay on the token on this device for good.
 */
async function settleSignIn(res: AuthRes): Promise<void> {
  const key = state.token;
  const uid = res.user.id;
  let check = await checkCookie(uid);
  let put: PutResult | null = null;
  if (check === 'none') {
    // No cookie came back. A reply to a request sent before this sign-in can clear the new one,
    // so ask once to set it again before deciding the browser keeps none.
    put = await putTokenInCookie();
    if (typeof put === 'object') check = await checkCookie(uid);
  }
  if (state.token !== key || getToken() !== res.token) return; // signed out or switched meanwhile
  if (typeof check === 'object') {
    switchToCookie(uid, check.me, res.token);
    return;
  }
  setToken(res.token);
  if (put === 'refused' || (typeof put === 'object' && check === 'none')) fallBackToBearer();
  void actions.loadMe();
}

let adopting = false;

/**
 * A token an older build saved in localStorage, and no session cookie yet: when online, move it
 * into the cookie (one tab at a time), check with a request that carries the cookie alone, then
 * forget the token. A 401 means the token was dead (handleUnauthorized signs out); a browser that
 * keeps no cookies stays on the token.
 */
async function adoptLegacyToken(): Promise<void> {
  if (adopting || authMode() !== 'cookie' || getCookieUser() || !getToken() || !state.token || !browserOnline()) return;
  adopting = true;
  try {
    await withSessionLock(async () => {
      const key = state.token;
      const t = getToken();
      // Another tab moved it (or signed in or out) meanwhile: the storage event reloads this one.
      if (!t || storedToken() !== t || getCookieUser()) return;
      const put = await putTokenInCookie();
      if (typeof put !== 'object') {
        if (put === 'refused') fallBackToBearer();
        return;
      }
      const check = await checkCookie(put.user.id);
      if (state.token !== key || getToken() !== t) return;
      if (check === 'none') {
        fallBackToBearer();
      } else if (typeof check === 'object') {
        switchToCookie(put.user.id, check.me, t);
        announce({ type: 'session' });
        void flush();
      }
    });
  } finally {
    adopting = false;
  }
}

/** One tab at a time moves a token into the cookie (Web Lock evenly-session). */
async function withSessionLock(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== 'function') return fn();
  let ran = false;
  try {
    await locks.request('evenly-session', async () => {
      ran = true;
      await fn();
    });
  } catch {
    if (!ran) await fn();
  }
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

/**
 * Entries whose sends wait in this tab for the version of a legacy photo being taken off
 * (removeReceiptPhoto), so the drop it queues keeps its place before what was queued after it.
 */
const versionHolds = new Set<string>();

/** Queue a write. `at`: a createdAt reserved earlier with nextCreatedAt (default: after every queued item). */
function enqueue(item: Pick<OutboxItem, 'op' | 'groupId' | 'expenseId' | 'body'>, at?: number): void {
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
  } else if (item.op === 'receipt') {
    // The newest photo change says what the photo should be: earlier ones of the entry that have
    // not gone out yet (or failed) go, so a replaced photo is never uploaded at all.
    for (const id of replaceableReceipts(current, item.groupId, item.expenseId, inFlight)) drop.add(id);
  } else if (item.op === 'photo') {
    // A drop of a photo still queued (or failed) takes its add out instead, and the other way
    // round; an add of a photo already queued or stored queues nothing (outbox.ts photoChangePlan).
    const shown = state.groups[item.groupId]?.snap?.expenses.find(e => e.id === item.expenseId);
    const stored = shown ? photosOf(shown).map(p => p.version) : [];
    const plan = photoChangePlan(current, item.groupId, item.expenseId, item.body as PhotoChange, inFlight, stored);
    for (const id of plan.cancel) drop.add(id);
    if (!plan.queue) {
      if (drop.size) {
        set({ outbox: current.filter(o => !drop.has(o.id)) });
        void writeOutbox([], [...drop]);
      }
      return;
    }
  }
  const full: OutboxItem = {
    ...item,
    id: newOpId(),
    createdAt: at ?? nextCreatedAt(),
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
    case 'receipt':
      return sendReceipt(item, `/api/groups/${g}/expenses/${e}/receipt`);
    case 'photo':
      return sendPhoto(item, `/api/groups/${g}/expenses/${e}/receipts/`);
  }
}

/** How long a photo upload may take: 400 KB on a slow phone connection is more than a JSON save. */
const RECEIPT_UPLOAD_TIMEOUT_MS = 60_000;

/** The photos in an answer that lists them (servers from before several photos send none). */
function listed(r: { receipts?: unknown } | null | undefined): { receipts?: ReceiptPhotosRes['receipts'] } {
  return r && Array.isArray(r.receipts) ? { receipts: r.receipts as ReceiptPhotosRes['receipts'] } : {};
}

/**
 * A legacy receipt photo change (op 'receipt', queued by a build from before several photos), to
 * the legacy routes with their meaning now: the image replaces the entry's first photo, a removal
 * takes the first one off. The image itself is the body (no base64 on the wire).
 */
async function sendReceipt(item: OutboxItem, path: string): Promise<SentResult | null> {
  const change = item.body as ReceiptChange | undefined;
  if (isReceiptRemoval(change)) {
    try {
      const r = await api<ReceiptDeleteRes>('DELETE', path);
      return { receipt: r?.receipt ?? null, ...listed(r), groupVersion: r?.groupVersion };
    } catch (err) {
      // The entry (or its group) is gone, and with it the photo.
      if (err instanceof ApiError && err.code === 'not_found') return null;
      throw err;
    }
  }
  const photo = change && 'image' in change ? dataUrlToBytes(change.image) : null;
  if (!photo || !change || !('image' in change)) throw new ApiError(400, 'bad_request', 'The queued photo cannot be read');
  const q = `?w=${encodeURIComponent(String(change.width))}&h=${encodeURIComponent(String(change.height))}`;
  const r = await api<ReceiptRes>('PUT', path + q, photo.bytes, { contentType: photo.mime, timeoutMs: RECEIPT_UPLOAD_TIMEOUT_MS });
  return r ? { receipt: r.receipt, ...listed(r), groupVersion: r.groupVersion } : null;
}

/**
 * One receipt photo change (op 'photo'): PUT .../receipts/<version>?w=&h= with the image itself as
 * the body, or DELETE .../receipts/<version>. A drop is done on a 404 that says the entry is gone
 * (`details.entry` 'gone': the entry, or its group, is gone and its photos with it). A bare 404 is
 * a server without these routes (a rollback, a deploy's first seconds), which took nothing off:
 * the drop fails for good with 重試 / 放棄. An add's 404 or 409 limit_reached fails for good.
 */
async function sendPhoto(item: OutboxItem, path: string): Promise<SentResult | null> {
  const drop = photoDrop(item.body);
  if (drop !== null) {
    try {
      const r = await api<ReceiptPhotosRes>('DELETE', path + encodeURIComponent(drop));
      return r ? { receipt: r.receipt ?? null, ...listed(r), groupVersion: r.groupVersion } : null;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_found' && (err.details as { entry?: unknown } | undefined)?.entry === 'gone') return null;
      throw err;
    }
  }
  const add = photoAdd(item.body);
  const photo = add ? dataUrlToBytes(add.image) : null;
  if (!add || !photo) throw new ApiError(400, 'bad_request', 'The queued photo cannot be read');
  const q = `?w=${encodeURIComponent(String(add.width))}&h=${encodeURIComponent(String(add.height))}`;
  const r = await api<ReceiptPhotosRes>('PUT', path + encodeURIComponent(add.version) + q, photo.bytes, { contentType: photo.mime, timeoutMs: RECEIPT_UPLOAD_TIMEOUT_MS });
  return r ? { receipt: r.receipt ?? null, ...listed(r), groupVersion: r.groupVersion } : null;
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
      const item = nextToSend(items, { now: Date.now(), blocked, canSend: i => canSend(i) && !handled.has(i.id) && !versionHolds.has(entryKey(i)) });
      if (!item) break;
      handled.add(item.id);
      // A legacy photo the person took off while it was going up (a reload cut that send): it is
      // not sent again. The drops queued after it take off whatever of it landed (removeReceiptPhoto).
      if (item.removed) {
        await writeOutbox([], [item.id]);
        set(s => ({ outbox: s.outbox.filter(o => o.id !== item.id) }));
        continue;
      }
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
      // Taken off while it was going up (removeReceiptPhoto): its send is over, so it goes, failed
      // or waiting, and never shows again; the drops after it settle whatever landed.
      if (state.outbox.find(o => o.id === item.id)?.removed) {
        await writeOutbox([], [item.id]);
        set(s => ({ outbox: s.outbox.filter(o => o.id !== item.id) }));
        touched.add(item.groupId);
        continue;
      }
      if (retryDelay(err, 0) !== null) {
        const at = Date.now();
        const lastError = { code: err.code, message: err.message, at };
        // The backoff, or until the server's retryAfter (a photo upload past the day's limit waits for 00:00 UTC).
        await updateItem(item.id, o => ({ ...o, attempts: o.attempts + 1, nextTryAt: at + (retryDelay(err, backoff(o.attempts + 1)) ?? 0), lastError }));
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
  /** Receipt photo changes waiting to be sent, per expense: photos to add, in order, and versions to drop. */
  pendingPhotos: Record<string, PendingPhotos>;
  /** A legacy photo change (op 'receipt', from a build before several photos) waiting, per expense (the newest one). */
  pendingReceipts: Record<string, PendingReceipt>;
  loading: boolean;
  error: ApiError | null;
}

function localExpense(gid: string, eid: string, body: UpsertExpenseReq, existing: ExpenseDTO | undefined, userId: string): ExpenseDTO {
  const now = new Date().toISOString();
  const r = computeSharesFor(eid, body.amount, body.split);
  // As the Worker stores it: a refund never repeats, and only a refund links to an expense
  // (left out of the save, the link stays; routes/expenses.ts refundOfFor).
  const refund = body.kind === 'refund';
  const repeat = refund ? 'none' : body.repeat ?? 'none';
  const refundOf = !refund ? null : body.refundOf !== undefined ? body.refundOf ?? null : existing?.refundOf ?? null;
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
    refundOf,
    // A save never changes the photos (each change of one is its own outbox item).
    receipt: existing?.receipt ?? null,
    receipts: existing?.receipts,
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
  const pendingPhotos: GroupView['pendingPhotos'] = {};
  const pendingReceipts: GroupView['pendingReceipts'] = {};
  if (!snap) return { snap, pending, pendingComments, pendingPhotos, pendingReceipts };
  const gid = snap.group.id;
  // A failed change that a later one of the same entry replaced shows nothing (the later one wins).
  const mine = liveItems(items.filter(i => i.groupId === gid));
  if (!mine.length) return { snap, pending, pendingComments, pendingPhotos, pendingReceipts };
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
    } else if (it.op === 'receipt' && it.body && !it.removed) {
      // A legacy change of the first photo: visiblePhotos shows it (a removal at once, a new photo
      // from its data URL until the server has it). One taken off while it was going up shows no more.
      const b = it.body as ReceiptChange;
      const removal = isReceiptRemoval(b);
      pendingReceipts[it.expenseId] = {
        itemId: it.id,
        photo: removal ? null : { image: b.image, width: b.width, height: b.height },
        failed: !!it.error,
        code: it.error?.code ?? it.lastError?.code ?? null,
      };
    } else if (it.op === 'photo' && it.body) {
      const p = (pendingPhotos[it.expenseId] ??= { adds: [], drops: [] });
      const add = photoAdd(it.body);
      const drop = photoDrop(it.body);
      const code = it.error?.code ?? it.lastError?.code ?? null;
      if (add) {
        p.adds.push({ itemId: it.id, version: add.version, image: add.image, width: add.width, height: add.height, state: it.error ? 'failed' : it.lastError ? 'waiting' : 'sending', code });
      } else if (drop !== null) {
        p.drops.push(drop);
      }
    }
    const list = byEntry.get(it.expenseId);
    if (list) list.push(it);
    else byEntry.set(it.expenseId, [it]);
  }
  for (const [eid, list] of byEntry) pending[eid] = pendingInfo(list);
  return { snap: { ...snap, expenses: sortExpenses(expenses) }, pending, pendingComments, pendingPhotos, pendingReceipts };
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

/** Signed in (an email code, a password, a code from another device, a reset link): this tab now acts as `res.user`. */
async function afterAuth(res: AuthRes): Promise<void> {
  currentUserId = res.user.id;
  markerOnly = false;
  if (res.user.locale && res.user.locale !== getLocale()) setLocale(res.user.locale);
  const me = state.me && state.me.user.id === res.user.id ? { ...state.me, user: res.user } : null;
  if (authMode() === 'cookie') {
    // The answer also put the session in this site's cookies. Until a request with the cookie
    // alone shows the browser kept it, the token (in memory only) signs this tab's requests.
    setCookieUser(null);
    setToken(res.token, false);
    set({ token: cookieKey(res.user.id), me });
    await settleSignIn(res);
  } else {
    setToken(res.token);
    set({ token: res.token, me });
    void actions.loadMe();
  }
  announce({ type: 'session' });
}

/** A sign-in that replaces this device's session (any sign-in): changes this device held for that account come back. */
async function switchSession(res: AuthRes): Promise<void> {
  await clearSession({ hold: true, signIn: true });
  await afterAuth(res);
  await restoreHeld(res.user.id);
}

/**
 * My profile photo changed (its version, or null): show it at once on my account, my members in the
 * dashboard and in every group kept here, then refresh the dashboard. Each group's next fetch brings
 * the server's copy anyway (the photo change bumped every group I have a member row in).
 */
function avatarChanged(version: string | null): void {
  const me = state.me;
  if (!me) return;
  const uid = me.user.id;
  const mine = <T extends { userId: string | null }>(m: T): T => (m.userId === uid ? { ...m, avatar: version } : m);
  const next: MeDTO = { ...me, user: { ...me.user, avatar: version }, groups: me.groups.map(g => ({ ...g, members: g.members.map(mine) })) };
  set({ me: next });
  persist('me', next);
  for (const [gid, entry] of Object.entries(state.groups)) {
    const snap = entry.snap;
    if (snap?.members.some(m => m.userId === uid)) setGroup(gid, { snap: { ...snap, members: snap.members.map(mine) } });
  }
  void actions.loadMe();
}

/** The group's currency as this device last saw it (cached group, else the dashboard list). */
function groupCurrencyOf(gid: string): string | undefined {
  return state.groups[gid]?.snap?.group.currency ?? state.me?.groups.find(g => g.id === gid)?.currency;
}

export const actions = {
  // ----- auth -----
  // New accounts come from an email code (emailVerify); the app no longer calls POST
  // /api/auth/signup, which stays for older clients, the iOS app and test scripts.
  /** Mail a 6-digit sign-in code to `email`. The answer is the same whether or not it has an account. */
  async emailStart(email: string): Promise<EmailStartRes> {
    const body: EmailStartReq = { email, locale: getLocale() };
    return call(() => api<EmailStartRes>('POST', '/api/auth/email/start', body, { anonymous: true }));
  },
  /**
   * Sign in with the emailed code: the account that has the email, or a new one named `name`
   * (without a name, 400 name_required). Like any sign-in it replaces this device's session, and
   * changes this device held for that account come back. `created` says which it was.
   */
  async emailVerify(req: EmailVerifyReq): Promise<EmailVerifyRes> {
    const body: EmailVerifyReq = { locale: getLocale(), ...req };
    return duringSignIn(async () => {
      const res = await call(() => api<EmailVerifyRes>('POST', '/api/auth/email/verify', body, { anonymous: true }));
      await switchSession(res);
      return res;
    });
  },
  async login(req: LoginReq): Promise<UserDTO> {
    const key = await passwordKey(req.email, req.password);
    return duringSignIn(async () => {
      const res = await call(() => api<AuthRes>('POST', '/api/auth/login', { email: req.email, password: key }, { anonymous: true }));
      await switchSession(res);
      return res.user;
    });
  },
  async linkLogin(code: string): Promise<UserDTO> {
    return duringSignIn(async () => {
      const res = await call(() => api<AuthRes>('POST', '/api/auth/link', { code: code.replace(/[\s-]/g, '').toUpperCase() }, { anonymous: true }));
      await switchSession(res);
      return res.user;
    });
  },
  /**
   * The page came back from 使用 Google 帳戶登入 or 使用 Apple 登入 (features/auth/SignInButtons.tsx):
   * the Worker put the session in this site's cookies on that page load, so this tab started on the
   * marker. Once
   * GET /api/me names the marker's account, do what the end of an in-app sign-in does: the
   * account's language, the changes this device held for it, and the other tabs told. null when
   * it did not load (offline, or the session had ended again).
   */
  async googleArrived(): Promise<MeDTO | null> {
    const me = await actions.loadMe();
    const uid = me?.user.id;
    if (!me || !uid || !state.token || getCookieUser() !== uid || currentUserId !== uid) return null;
    if (me.user.locale && me.user.locale !== getLocale()) setLocale(me.user.locale);
    announce({ type: 'session' });
    await restoreHeld(uid);
    return me;
  },
  /** Who a reset link belongs to (the email is needed to derive the password key). */
  async resetInfo(token: string): Promise<{ email: string; expiresAt: string }> {
    return call(() => api<{ email: string; expiresAt: string }>('GET', '/api/auth/reset/' + encodeURIComponent(token), undefined, { anonymous: true }));
  },
  async resetPassword(token: string, password: string): Promise<UserDTO> {
    if (!passwordOk(password)) weak();
    const info = await actions.resetInfo(token);
    const key = await passwordKey(info.email, password);
    return duringSignIn(async () => {
      const res = await call(() => api<AuthRes>('POST', '/api/auth/reset', { token, password: key }, { anonymous: true }));
      await switchSession(res);
      return res.user;
    });
  },
  /** Sign out. In cookie mode it needs a connection (throws offline, 5xx, 429 and the like). */
  async logout(): Promise<void> {
    if (authMode() === 'cookie') {
      // Only the Worker can end a session kept in an HttpOnly cookie: signed out here alone, the
      // device would be signed in again on its next start. A 401 from the Worker: it had ended
      // already. Not session_changed (this tab's own check, which sent nothing, or the Worker's):
      // the cookie is another sign-in's now, so nothing here is this tab's to clear, and the page
      // reloads into that sign-in.
      try {
        await call(() => api('POST', '/api/auth/logout', {}, { ignore401: true }));
        // The Worker ended the session of the account X-Evenly-User named: it is this tab's.
        markerOnly = false;
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401 || e.code === 'session_changed') throw e;
      }
    } else {
      try {
        await api('POST', '/api/auth/logout', {});
      } catch {
        /* signing out locally is what matters */
      }
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
      // The first answer naming the account this tab started as on the marker alone.
      if (markerOnly) void settleMarkerStart(me.user.id);
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
  /**
   * A link from 我的 that came back through Apple's or Google's pages, waiting for this session's
   * answer (features/auth/SignInButtons.tsx asks before it links). 404 not_found once it is gone.
   */
  async pendingLink(id: string): Promise<PendingLinkDTO> {
    return call(() => api<PendingLinkDTO>('GET', '/api/me/links/pending/' + encodeURIComponent(id)));
  },
  /** 連結: the account comes back with it linked (`movedFromEmpty` when an empty account gave it up). */
  async confirmPendingLink(id: string): Promise<ProviderLinkRes> {
    const token = state.token;
    const res = await call(() => api<ProviderLinkRes>('POST', '/api/me/links/pending/' + encodeURIComponent(id), {}));
    // Signed out or into another account meanwhile: this answer belongs to the old session.
    if (state.token === token && state.me) {
      const me = { ...state.me, user: res.user };
      set({ me });
      persist('me', me);
    }
    return res;
  },
  /** 取消: nothing is linked (the Worker revokes an Apple grant that no account keeps). */
  async dropPendingLink(id: string): Promise<void> {
    await call(() => api('DELETE', '/api/me/links/pending/' + encodeURIComponent(id), {}));
  },
  /** Mail a code to the address this account wants as its sign-in email (409 email_taken when another account has it). */
  async addEmailStart(email: string): Promise<EmailStartRes> {
    const body: AddEmailStartReq = { email };
    return call(() => api<EmailStartRes>('POST', '/api/me/email/start', body));
  },
  /**
   * The code from that email: the account's confirmed sign-in email is now `email`. A password
   * salted with the old email is gone then (passwordCleared); a new one can be set on 我的.
   */
  async addEmailVerify(email: string, code: string): Promise<AddEmailVerifyRes> {
    const token = state.token;
    const body: AddEmailVerifyReq = { email, code };
    const res = await call(() => api<AddEmailVerifyRes>('POST', '/api/me/email/verify', body));
    // Signed out or into another account meanwhile: this answer belongs to the old session.
    if (state.token === token && state.me) {
      const me = { ...state.me, user: res.user };
      set({ me });
      persist('me', me);
    }
    return res;
  },
  /**
   * Set or change the password (the key is derived on the device, salted with the account's
   * email). The server takes only the account's own email, confirmed (or one that had a password).
   */
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
  /** Put a new profile photo on the account: a JPEG data URL from avatarImage() (features/account/avatarPhoto.ts). */
  async setAvatar(image: string): Promise<string | null> {
    const token = state.token;
    const r = await call(() => api<AvatarRes>('PUT', '/api/me/avatar', { image } satisfies AvatarReq));
    // Signed out or into another account meanwhile: this answer belongs to the old session.
    if (state.token === token) avatarChanged(r.avatar);
    return r.avatar;
  },
  /** Take the profile photo off the account (everyone sees the initial again). */
  async removeAvatar(): Promise<void> {
    const token = state.token;
    await call(() => api<AvatarRes>('DELETE', '/api/me/avatar'));
    if (state.token === token) avatarChanged(null);
  },
  async deleteAccount(password?: string): Promise<void> {
    const email = state.me?.user.email;
    const key = password && email ? await passwordKey(email, password) : undefined;
    await call(() => api('DELETE', '/api/me', { password: key }));
    // The Worker deleted the account X-Evenly-User named (or the token's): it is this tab's.
    markerOnly = false;
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
  /**
   * Set the group's default split (null clears it; docs/SPEC.md section 4, Default split): one per
   * group, for everyone in it. Needs a connection, like the group's other settings.
   */
  async setDefaultSplit(gid: string, input: DefaultSplitInput | null): Promise<GroupSnapshotDTO> {
    return actions.updateGroup(gid, { defaultSplit: input });
  },
  /**
   * 封存群組 / 取消封存: the group leaves (or comes back to) my 總覽 and 群組 list, on every device
   * of mine; nobody else sees a change. Needs a connection, like the group's other settings.
   */
  async setArchived(gid: string, archived: boolean): Promise<void> {
    const token = state.token;
    const body: ArchiveReq = { archived };
    await call(() => api<ArchiveRes>('PUT', `/api/groups/${encodeURIComponent(gid)}/archive`, body));
    // Signed out or into another account meanwhile: this answer belongs to the old session.
    if (state.token === token && state.me) {
      const me = { ...state.me, groups: state.me.groups.map(g => (g.id === gid ? { ...g, archived } : g)) };
      set({ me });
      persist('me', me);
    }
    void actions.loadMe();
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

  // ----- friend invite links (docs/SPEC.md section 4) -----
  /** My invite link (made on the first ask), its QR code's text and the messages in `locale`. */
  async myInvite(locale: Locale): Promise<MyInviteDTO> {
    return call(() => api<MyInviteDTO>('GET', '/api/me/invite?locale=' + encodeURIComponent(locale)));
  },
  /** A new link in place of mine: the old one stops working at once. */
  async resetMyInvite(locale: Locale): Promise<MyInviteDTO> {
    return call(() => api<MyInviteDTO>('POST', '/api/me/invite/reset?locale=' + encodeURIComponent(locale), {}));
  },
  /** Who sent a link; signed in, also whether it is mine and our 1:1 ledger if we have one. */
  async inviteInfo(code: string): Promise<InviteInfoDTO> {
    return call(() => api<InviteInfoDTO>('GET', '/api/invite/' + encodeURIComponent(code)));
  },
  /** Accept a link: friends with its owner, in our 1:1 ledger (made now unless we have one). */
  async acceptInvite(code: string): Promise<InviteAcceptRes> {
    const r = await call(() => api<InviteAcceptRes>('POST', '/api/invite/' + encodeURIComponent(code), {}));
    await actions.loadGroup(r.groupId, { force: true });
    void actions.loadMe();
    return r;
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
  /**
   * Add this receipt photo to the entry, after the ones it has (lib/photo.ts receiptPhoto, with
   * its photoVersion). Call it after the entry's saveExpense: queued after the save, it goes up
   * once the entry exists, and like a save it waits here offline and is retried. A photo already
   * queued or stored is not queued again; one whose removal is still queued just stays.
   */
  addReceiptPhoto(gid: string, eid: string, photo: PhotoUpload): void {
    const body: PhotoChange = { add: { version: photo.version, image: photo.image, width: photo.width, height: photo.height } };
    enqueue({ op: 'photo', groupId: gid, expenseId: eid, body });
  },
  /**
   * Take one receipt photo off the entry (for everyone in the group), through the outbox; the later
   * ones move up. A photo still queued to go up is taken out of the outbox, and the removal is
   * queued as well unless the server refused that upload (outbox.ts photoChangePlan).
   *
   * A legacy queued photo ('legacy:<itemId>', visiblePhotos: shown in place of the entry's first
   * photo) leaves the entry as the page showed it without that photo. Its item is discarded, or,
   * when this tab is sending it, marked `removed` (hidden at once, and gone when the send ends,
   * however it ends). Drops are queued of its version (it may be going up from another tab, or
   * have gone already) and, while the item is still queued, of the first photo it was to replace.
   * A drop of a version the entry does not have changes nothing.
   */
  removeReceiptPhoto(gid: string, eid: string, version: string): void {
    if (version.startsWith('legacy:')) {
      const id = version.slice(7);
      const item = state.outbox.find(o => o.id === id && o.op === 'receipt');
      const shown = state.groups[gid]?.snap?.expenses.find(e => e.id === eid);
      const first = shown ? photosOf(shown)[0]?.version : undefined;
      const known = legacyVersions.get(id) || '';
      if (item && id !== inFlight) actions.discard(id);
      // Being sent from this tab right now: it is marked (and so stored), the page stops showing it
      // at once, and it goes as soon as its send ends, landed or not (drain). The drops below come
      // after it and take off whatever of it landed.
      if (item && id === inFlight) void updateItem(id, o => ({ ...o, removed: true }));
      const drop = (v: string, at?: number) => enqueue({ op: 'photo', groupId: gid, expenseId: eid, body: { drop: v } }, at);
      // The first photo it was to replace, only while it has not gone up: once it has, it replaced
      // that photo itself, and the first photo now may be one this editor never showed (the fix
      // check: someone removed it, or another client put a new one first meanwhile).
      if (item && first && first !== known) drop(first);
      if (known) {
        drop(known);
        return;
      }
      const b = item?.body as ReceiptChange | undefined;
      if (!b || !('image' in b)) return;
      // Not worked out yet (it is as the item is read): the drop keeps its place in the outbox now,
      // and this entry's sends wait in this tab until it is in, so a photo the same 儲存 adds still
      // goes after it.
      const at = nextCreatedAt();
      const key = entryKey({ groupId: gid, expenseId: eid });
      versionHolds.add(key);
      // A SHA-256 takes milliseconds; one that never answers must not hold the entry for good.
      const giveUp = setTimeout(() => {
        versionHolds.delete(key);
        void flush();
      }, 10_000);
      void photoVersion(b.image)
        .catch(() => '')
        .then(v => {
          clearTimeout(giveUp);
          versionHolds.delete(key);
          if (v && v !== first) drop(v, at);
          else void flush();
        });
      return;
    }
    enqueue({ op: 'photo', groupId: gid, expenseId: eid, body: { drop: version } });
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
