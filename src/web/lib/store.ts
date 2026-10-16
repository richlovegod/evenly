// App state and every server call. Pages read state with useStore()/useGroupView() and change
// things only through `actions`. Expense writes (save, delete, restore, comment) go through an
// outbox so they work offline and are retried in order.

import { useMemo, useSyncExternalStore } from 'react';
import { computeSharesFor } from '../../shared/split';
import type {
  ActivityDTO, AddMemberReq, AuthRes, BatchImportReq, ClaimInfoDTO, CommentDTO, CreateGroupReq, CredentialsReq,
  ExpenseDTO, FxRes, GroupSnapshotDTO, JoinInfoDTO, JoinReq, LinkCodeRes, LoginReq, MeDTO, MemberDTO, SessionDTO,
  SignupReq, UpdateGroupReq, UpdateMeReq, UpdateMemberReq, UpsertExpenseReq, UserDTO,
} from '../../shared/types';
import { api, apiRaw, ApiError, browserOnline, getToken, setToken, setUnauthorizedHandler } from './api';
import { passwordKey, passwordOk } from './crypto';
import { isStandalone } from './pwa';
import { idbClear, idbDel, idbGet, idbKeys, idbSet } from './idb';
import { getLocale, setLocale, t } from './i18n';
import { navigate } from './router';
import { showToast } from './toast';

// ---------- types ----------

export type OutboxOp = 'upsert' | 'delete' | 'restore' | 'comment';

export interface OutboxItem {
  id: string;
  op: OutboxOp;
  groupId: string;
  expenseId: string;
  /** upsert: UpsertExpenseReq; comment: { id, body } */
  body?: UpsertExpenseReq | { id: string; body: string };
  createdAt: number;
  attempts: number;
  nextTryAt: number;
  /** Set when the server rejected it for good (shown as 同步失敗 with retry / discard). */
  error: { code: string; message: string } | null;
}

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

let saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function persist(key: string, value: unknown, delay = 250): void {
  const prev = saveTimers.get(key);
  if (prev) clearTimeout(prev);
  saveTimers.set(key, setTimeout(() => {
    saveTimers.delete(key);
    void idbSet(key, value);
  }, delay));
}

function persistOutbox() {
  persist('outbox', state.outbox, 0);
}

function setGroup(gid: string, patch: Partial<GroupEntry>): void {
  set(s => {
    const prev = s.groups[gid] ?? { snap: null, etag: null, loading: false, error: null, fetchedAt: 0 };
    const next = { ...prev, ...patch };
    return { groups: { ...s.groups, [gid]: next } };
  });
  const g = state.groups[gid];
  if (patch.snap !== undefined) {
    if (g?.snap) persist('group:' + gid, { snap: g.snap, etag: g.etag });
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

/** Load cached data and start syncing. Called once from main.tsx. */
export async function boot(): Promise<void> {
  setUnauthorizedHandler(() => void handleUnauthorized());
  const [me, outbox, keys] = await Promise.all([
    idbGet<MeDTO>('me'),
    idbGet<OutboxItem[]>('outbox'),
    idbKeys('group:'),
  ]);
  const groups: Record<string, GroupEntry> = {};
  await Promise.all(keys.map(async k => {
    const v = await idbGet<{ snap: GroupSnapshotDTO; etag: string | null }>(k);
    if (v?.snap) groups[k.slice(6)] = { snap: v.snap, etag: v.etag, loading: false, error: null, fetchedAt: 0 };
  }));
  set({ booted: true, me: state.token ? me ?? null : null, outbox: state.token ? outbox ?? [] : [], groups: state.token ? groups : {} });

  window.addEventListener('online', () => { set({ online: true }); void flush(); void actions.loadMe(); });
  window.addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.token) {
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

async function handleUnauthorized(): Promise<void> {
  if (!state.token) return;
  await clearSession();
  showToast({ message: t('登入已失效，請重新登入。', 'You were signed out. Please sign in again.'), kind: 'error' });
  navigate('/welcome', { replace: true });
}

async function clearSession(): Promise<void> {
  setToken(null);
  set({ token: null, me: null, groups: {}, outbox: [], activity: emptyActivity, meError: null });
  await idbClear();
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

let flushing = false;
let inFlight: string | null = null;

function backoff(attempts: number): number {
  return Math.min(60000, 2000 * Math.pow(2, Math.max(0, attempts - 1)));
}

function newOpId(): string {
  return crypto.randomUUID();
}

function enqueue(item: Omit<OutboxItem, 'id' | 'createdAt' | 'attempts' | 'nextTryAt' | 'error'>): void {
  let outbox = state.outbox;
  // Coalesce: a newer save of the same expense replaces a queued (not yet sent) save.
  if (item.op === 'upsert') {
    const idx = outbox.findIndex(o => o.op === 'upsert' && o.expenseId === item.expenseId && o.groupId === item.groupId && o.id !== inFlight && !o.error);
    const last = outbox.length - 1;
    if (idx >= 0 && idx === last) {
      outbox = outbox.map((o, i) => (i === idx ? { ...o, body: item.body, attempts: 0, nextTryAt: 0 } : o));
      set({ outbox });
      persistOutbox();
      void flush();
      return;
    }
  }
  const full: OutboxItem = { ...item, id: newOpId(), createdAt: Date.now(), attempts: 0, nextTryAt: 0, error: null };
  set({ outbox: [...outbox, full] });
  persistOutbox();
  void flush();
}

async function sendItem(item: OutboxItem): Promise<void> {
  const g = encodeURIComponent(item.groupId);
  const e = encodeURIComponent(item.expenseId);
  switch (item.op) {
    case 'upsert':
      await api('PUT', `/api/groups/${g}/expenses/${e}`, item.body);
      return;
    case 'delete':
      try {
        await api('DELETE', `/api/groups/${g}/expenses/${e}`);
      } catch (err) {
        // Deleting something the server never saw is fine.
        if (!(err instanceof ApiError && err.code === 'not_found')) throw err;
      }
      return;
    case 'restore':
      await api('POST', `/api/groups/${g}/expenses/${e}/restore`);
      return;
    case 'comment':
      await api('POST', `/api/groups/${g}/expenses/${e}/comments`, item.body);
      return;
  }
}

/** Send queued writes in order. Safe to call any time. */
export async function flush(): Promise<void> {
  if (flushing || !state.token) return;
  flushing = true;
  const touched = new Set<string>();
  set({ syncing: true });
  try {
    for (;;) {
      const item = state.outbox.find(i => !i.error);
      if (!item) break;
      if (item.nextTryAt > Date.now()) break;
      inFlight = item.id;
      try {
        await sendItem(item);
        noteOnline(true);
        touched.add(item.groupId);
        set(s => ({ outbox: s.outbox.filter(o => o.id !== item.id) }));
        persistOutbox();
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
        if (err.status === 401) break;
        if (err.retryable) {
          noteOnline(err.code !== 'offline');
          set(s => ({ outbox: s.outbox.map(o => (o.id === item.id ? { ...o, attempts: o.attempts + 1, nextTryAt: Date.now() + backoff(o.attempts + 1) } : o)) }));
          persistOutbox();
          break;
        }
        noteOnline(true);
        touched.add(item.groupId);
        set(s => ({ outbox: s.outbox.map(o => (o.id === item.id ? { ...o, error: { code: err.code, message: err.message } } : o)) }));
        persistOutbox();
        showToast({ message: t('有一筆變更無法同步，請到群組裡查看。', 'One change could not be synced. Open the group to review it.'), kind: 'error' });
      } finally {
        inFlight = null;
      }
    }
  } finally {
    flushing = false;
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
  itemId: string;
  op: OutboxOp;
  error: { code: string; message: string } | null;
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

function sortExpenses(list: ExpenseDTO[]): ExpenseDTO[] {
  return list.sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) : a.date < b.date ? 1 : -1));
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

export function applyOutbox(snap: GroupSnapshotDTO | null, items: readonly OutboxItem[], userId: string): Omit<GroupView, 'loading' | 'error'> {
  const pending: Record<string, PendingInfo> = {};
  const pendingComments: GroupView['pendingComments'] = {};
  if (!snap) return { snap, pending, pendingComments };
  const gid = snap.group.id;
  const mine = items.filter(i => i.groupId === gid);
  if (!mine.length) return { snap, pending, pendingComments };
  const expenses = [...snap.expenses];
  const index = new Map(expenses.map((e, i) => [e.id, i]));
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
    pending[it.expenseId] = { state: it.error ? 'failed' : 'pending', itemId: it.id, op: it.op, error: it.error };
  }
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

// ---------- fx cache ----------

const fxMem = new Map<string, FxRes>();

// ---------- actions ----------

function afterAuth(res: AuthRes): void {
  setToken(res.token);
  if (res.user.locale && res.user.locale !== getLocale()) setLocale(res.user.locale);
  set({ token: res.token, me: state.me && state.me.user.id === res.user.id ? { ...state.me, user: res.user } : null });
  void actions.loadMe();
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
    await clearSession();
    afterAuth(res);
    return res.user;
  },
  async linkLogin(code: string): Promise<UserDTO> {
    const res = await call(() => api<AuthRes>('POST', '/api/auth/link', { code: code.replace(/[\s-]/g, '').toUpperCase() }, { anonymous: true }));
    await clearSession();
    afterAuth(res);
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
    await clearSession();
    afterAuth(res);
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

  // ----- me -----
  async loadMe(): Promise<MeDTO | null> {
    if (!state.token) return null;
    set({ meLoading: true });
    try {
      const me = await call(() => api<MeDTO>('GET', '/api/me'));
      set({ me, meLoading: false, meError: null });
      persist('me', me);
      return me;
    } catch (e) {
      set({ meLoading: false, meError: e instanceof ApiError ? e : null });
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
      setGroup(gid, { snap: r.data ?? null, etag: r.etag, loading: false, error: null, fetchedAt: Date.now() });
      return r.data ?? null;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      if (err.code === 'not_found') {
        dropGroup(gid);
        setGroup(gid, { loading: false, error: err });
      } else {
        setGroup(gid, { loading: false, error: err });
      }
      return state.groups[gid]?.snap ?? null;
    }
  },
  async createGroup(req: CreateGroupReq): Promise<string> {
    const snap = await call(() => api<GroupSnapshotDTO>('POST', '/api/groups', req));
    setGroup(snap.group.id, { snap, etag: `"${snap.group.version}"`, loading: false, error: null, fetchedAt: Date.now() });
    void actions.loadMe();
    return snap.group.id;
  },
  async updateGroup(gid: string, req: UpdateGroupReq): Promise<GroupSnapshotDTO> {
    const snap = await call(() => api<GroupSnapshotDTO>('PATCH', '/api/groups/' + encodeURIComponent(gid), req));
    setGroup(gid, { snap, etag: `"${snap.group.version}"`, error: null, fetchedAt: Date.now() });
    void actions.loadMe();
    return snap;
  },
  async deleteGroup(gid: string): Promise<void> {
    await call(() => api('DELETE', '/api/groups/' + encodeURIComponent(gid)));
    dropGroup(gid);
    set(s => ({ outbox: s.outbox.filter(o => o.groupId !== gid) }));
    persistOutbox();
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
    enqueue({ op: 'upsert', groupId: gid, expenseId: eid, body });
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
  /** Retry an outbox item that failed for good. */
  retry(itemId: string): void {
    set(s => ({ outbox: s.outbox.map(o => (o.id === itemId ? { ...o, error: null, attempts: 0, nextTryAt: 0 } : o)) }));
    persistOutbox();
    void flush();
  },
  /** Throw away an unsynced change. */
  discard(itemId: string): void {
    set(s => ({ outbox: s.outbox.filter(o => o.id !== itemId) }));
    persistOutbox();
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
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
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
};

export type Actions = typeof actions;
