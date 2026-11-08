// 只刪除這一筆 (review B2-05, Gino's call of 2026-11-07): deleting the newest copy of a repeating entry
// asks whether its series goes on. Covered: when the page asks (editorLogic.offersKeepSeries) and the
// line under its question (editorText.keepSeriesHint); the outbox keeps the choice with the delete
// (outbox.ts DeleteChoice, keepsSeries), so the first try, a retry and a reload all send
// DELETE ?keep=series, while 刪除並停止重複 and a delete an older build queued stay a plain DELETE; an
// answer with seriesKept false is said once, with 復原, and not at all once that 復原 is queued. The
// store runs in a fake browser (bearer mode, no IndexedDB, so idb.ts keeps its records in
// localStorage), first against a fake fetch, then against the real Worker over the real schema
// (tests/worker/d1-sqlite.ts): the series goes on from the copy before it, and 復原 brings the head
// back as the one entry of the series that repeats, once the store has read the group again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// editorText.ts reaches lib/api.ts, which reads location and storage when it loads.
vi.hoisted(() => {
  const store = () => {
    const map = new Map<string, string>([['evenly.api', 'same-origin']]);
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    };
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage ??= store();
  g.sessionStorage ??= store();
  g.location ??= { origin: 'https://split.test', href: 'https://split.test/', pathname: '/', search: '', hash: '' };
});

/** The toasts the store showed (lib/toast, replaced so the tests can read them). */
const toasts = vi.hoisted(() => ({ shown: [] as { message: string; action?: { label: string; run: () => void } }[] }));
vi.mock('../../src/web/lib/toast', () => ({
  showToast: (x: { message: string; action?: { label: string; run: () => void } }) => {
    toasts.shown.push(x);
    return toasts.shown.length;
  },
  dismissToast: () => undefined,
  useToasts: () => [],
}));

import { addDays, todayUTC } from '../../src/shared/dates';
import type { ExpenseDTO, GroupSnapshotDTO, MeDTO } from '../../src/shared/types';
import { offersKeepSeries } from '../../src/web/features/expenses/editorLogic';
import { keepSeriesHint } from '../../src/web/features/expenses/editorText';
import { getLocale, setLocale } from '../../src/web/lib/i18n';
import { keepsSeries } from '../../src/web/lib/outbox';

const STOPPED = 'Deleted. No earlier entry could take over, so the repeat stopped too.';
const ME = 'U1';
const MEMBER = 'm-U1';

/** An entry of a monthly rent series in g1 (rent-0001 is its first entry, so its id is the series id). */
function entry(id: string, date: string, over: Partial<ExpenseDTO> = {}): ExpenseDTO {
  return {
    id, groupId: 'g1', kind: 'expense', description: 'Rent', category: 'general', amount: 30000, currency: 'JPY', fxRate: 1, date, notes: '',
    payers: [{ memberId: MEMBER, amount: 30000 }], split: { method: 'equal', entries: [{ memberId: MEMBER }] }, shares: [{ memberId: MEMBER, amount: 30000 }],
    repeat: 'none', repeatSeries: 'rent-0001', repeatStart: '2026-09-07',
    createdBy: ME, createdAt: date + 'T00:00:00.000Z', updatedBy: ME, updatedAt: date + 'T00:00:00.000Z', deletedAt: null, deletedBy: null,
    version: 1, commentCount: 0, refundOf: null, receipt: null, receipts: [], ...over,
  };
}

/** The series: its first entry (September) and the copies of October and November; November's is the head. */
const series = (): ExpenseDTO[] => [
  entry('c-nov', '2026-11-07', { repeat: 'monthly' }),
  entry('c-oct', '2026-10-07'),
  entry('rent-0001', '2026-09-07'),
];

describe('when 刪除 asks 只刪除這一筆 (offersKeepSeries)', () => {
  it('the newest copy of a repeating entry, with an earlier entry of its series still there', () => {
    const list = series();
    expect(offersKeepSeries(list[0], list)).toBe(true);
    // The first entry alone is earlier: it can take the repeat over too.
    const firstLeft = list.map(e => (e.id === 'c-oct' ? { ...e, deletedAt: '2026-11-07T01:00:00.000Z' } : e));
    expect(offersKeepSeries(firstLeft[0], firstLeft)).toBe(true);
    // Weekly, every 2 weeks and yearly ask the same.
    for (const repeat of ['weekly', 'biweekly', 'yearly'] as const) {
      const other = list.map(e => (e.id === 'c-nov' ? { ...e, repeat } : e));
      expect(offersKeepSeries(other[0], other)).toBe(true);
    }
  });

  it('not for an older copy, an entry that does not repeat, or one already deleted: they keep the single confirmation', () => {
    const list = series();
    expect(offersKeepSeries(list[1], list)).toBe(false);
    expect(offersKeepSeries(list[2], list)).toBe(false);
    const once = entry('once-0001', '2026-11-07', { repeatSeries: null, repeatStart: null });
    expect(offersKeepSeries(once, [once, ...list])).toBe(false);
    const gone = { ...list[0], deletedAt: '2026-11-07T01:00:00.000Z' };
    expect(offersKeepSeries(gone, [gone, list[1], list[2]])).toBe(false);
  });

  it('not when nothing could take the repeat over: the series\' first entry while it is the newest, every earlier one deleted, no series', () => {
    // A new monthly entry: it is the series' first entry and its head.
    const fresh = entry('rent-0001', '2026-11-07', { repeat: 'monthly', repeatStart: '2026-11-07' });
    expect(offersKeepSeries(fresh, [fresh])).toBe(false);
    // Even with an entry of its series dated earlier (its id is the series id, not a copy's).
    expect(offersKeepSeries(fresh, [fresh, entry('c-old', '2026-10-01')])).toBe(false);
    const list = series().map(e => (e.id === 'c-nov' ? e : { ...e, deletedAt: '2026-11-07T01:00:00.000Z' }));
    expect(offersKeepSeries(list[0], list)).toBe(false);
    const legacy = { ...series()[0], repeatSeries: null };
    expect(offersKeepSeries(legacy, [legacy, ...series().slice(1)])).toBe(false);
  });

  it('an entry of another series, or of its own dated the same day, does not count; nor does a repeat this build does not know', () => {
    const head = series()[0];
    expect(offersKeepSeries(head, [head, entry('x-oct', '2026-10-07', { repeatSeries: 'gym-0001' })])).toBe(false);
    expect(offersKeepSeries(head, [head, entry('c-same', '2026-11-07')])).toBe(false);
    const odd = { ...head, repeat: 'daily' as never };
    expect(offersKeepSeries(odd, [odd, ...series().slice(1)])).toBe(false);
  });

  it('keepSeriesHint: how often it comes, in both languages, as the iPhone app says it', () => {
    const was = getLocale();
    try {
      setLocale('zh-TW');
      expect(keepSeriesHint('monthly')).toBe('這筆會每月自動新增。只刪除這一筆的話，之後還會照樣新增。');
      expect(keepSeriesHint('weekly')).toBe('這筆會每週自動新增。只刪除這一筆的話，之後還會照樣新增。');
      expect(keepSeriesHint('biweekly')).toBe('這筆會每兩週自動新增。只刪除這一筆的話，之後還會照樣新增。');
      expect(keepSeriesHint('yearly')).toBe('這筆會每年自動新增。只刪除這一筆的話，之後還會照樣新增。');
      setLocale('en');
      expect(keepSeriesHint('monthly')).toBe('This one is added again every month. If you delete only this one, the next ones are still added.');
      expect(keepSeriesHint('weekly')).toBe('This one is added again every week. If you delete only this one, the next ones are still added.');
      expect(keepSeriesHint('biweekly')).toBe('This one is added again every 2 weeks. If you delete only this one, the next ones are still added.');
      expect(keepSeriesHint('yearly')).toBe('This one is added again every year. If you delete only this one, the next ones are still added.');
      expect(keepSeriesHint('none')).toBe('');
    } finally {
      setLocale(was);
    }
  });

  it('keepsSeries: only a delete whose body is { keep: "series" }', () => {
    expect(keepsSeries({ op: 'delete', body: { keep: 'series' } })).toBe(true);
    // 刪除並停止重複, any other entry's delete, and every delete an older build queued: no body.
    expect(keepsSeries({ op: 'delete' })).toBe(false);
    expect(keepsSeries({ op: 'delete', body: { keep: 'all' } as never })).toBe(false);
    expect(keepsSeries({ op: 'restore', body: { keep: 'series' } as never })).toBe(false);
  });
});

// ---------- the store against a fake Worker ----------

class MemoryStorage {
  readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

type StoreModule = typeof import('../../src/web/lib/store');

const API = 'https://api.test';
const TOKEN = 'tok' + 'a'.repeat(40);

function meOf(): MeDTO {
  return {
    user: { id: ME, name: 'Gino', email: null, emailVerified: false, hasPassword: false, googleLinked: false, appleLinked: false, locale: 'en', currency: 'JPY', color: '#000000', payInfo: '', venmo: '', paypal: '', isAdmin: false, createdAt: '', avatar: null },
    groups: [], friends: [], totals: [], unread: 0, serverTime: new Date().toISOString(),
  };
}

function snapOf(version: number, expenses: ExpenseDTO[]): GroupSnapshotDTO {
  return {
    group: { id: 'g1', name: 'Home', type: 'home', currency: 'JPY', emoji: '', color: '#000000', simplify: true, notes: '', createdBy: ME, createdAt: '', updatedAt: '', version, defaultSplit: null },
    members: [{ id: MEMBER, groupId: 'g1', userId: ME, name: 'Gino', color: '#000000', role: 'admin', active: true, sort: 0, createdAt: '', claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null }],
    expenses,
    me: { memberId: MEMBER, role: 'admin' },
    inviteCode: 'X',
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Browser {
  ls: MemoryStorage;
  offline: boolean;
  /** Every request, as "METHOD path?query". */
  sent: string[];
  version: number;
  expenses: ExpenseDTO[];
  /** What a DELETE ?keep=series of a repeating entry answers as seriesKept. */
  seriesKept: boolean;
  /** Answers a request differently first (undefined: as below); may throw, as a lost answer does. */
  override: ((method: string, url: URL) => Response | undefined) | null;
  win: Map<string, ((e: unknown) => void)[]>;
}

function newBrowser(): Browser {
  const ls = new MemoryStorage();
  ls.setItem('evenly.api', API);
  ls.setItem('evenly.token', TOKEN);
  ls.setItem('evenly.locale', 'en');
  ls.setItem('evenly.kv.me', JSON.stringify(meOf()));
  ls.setItem('evenly.kv.group:g1', JSON.stringify({ snap: snapOf(1, series()), etag: '"1"' }));
  return { ls, offline: false, sent: [], version: 1, expenses: series(), seriesKept: true, override: null, win: new Map() };
}

/** The entry routes, as far as these tests need them (routes/expenses.ts setDeleted). */
function answer(b: Browser, method: string, url: URL): Response {
  const special = b.override?.(method, url);
  if (special) return special;
  const p = url.pathname;
  if (method === 'GET' && p === '/api/me') return json(200, meOf());
  if (method === 'GET' && p === '/api/groups/g1') return json(200, snapOf(b.version, b.expenses));
  const m = /^\/api\/groups\/g1\/expenses\/([^/]+)(\/restore)?$/.exec(p);
  const at = m ? b.expenses.findIndex(e => e.id === m[1]) : -1;
  if (m && at >= 0 && ((method === 'DELETE' && !m[2]) || (method === 'POST' && m[2]))) {
    const was = b.expenses[at];
    const deleting = method === 'DELETE';
    b.version++;
    b.expenses[at] = { ...was, deletedAt: deleting ? new Date().toISOString() : null, deletedBy: deleting ? ME : null, version: was.version + 1 };
    const kept = deleting && url.search === '?keep=series' && was.repeat !== 'none' ? { seriesKept: b.seriesKept } : {};
    return json(200, { expense: b.expenses[at], groupVersion: b.version, ...kept });
  }
  return json(404, { error: { code: 'not_found', message: 'Not found' } });
}

function install(b: Browser): void {
  const on = (type: string, fn: (e: unknown) => void) => b.win.set(type, [...(b.win.get(type) ?? []), fn]);
  vi.stubGlobal('localStorage', b.ls);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('location', { origin: 'https://split.test', href: 'https://split.test/#/', pathname: '/', search: '', hash: '#/', reload: () => undefined });
  vi.stubGlobal('history', { state: null, replaceState: () => undefined, pushState: () => undefined, back: () => undefined });
  vi.stubGlobal('window', { addEventListener: on, removeEventListener: () => undefined, matchMedia: () => ({ matches: false }), dispatchEvent: () => true });
  vi.stubGlobal('document', { cookie: '', visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined, documentElement: {} });
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'test', language: 'en-US', languages: ['en-US'], platform: 'test', maxTouchPoints: 0 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (b.offline) throw new TypeError('Failed to fetch');
    const method = init.method ?? 'GET';
    const u = new URL(url);
    b.sent.push(method + ' ' + u.pathname + u.search);
    return answer(b, method, u);
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>(r => setImmediate(r));
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/** The app opened in this browser. */
async function open(b: Browser): Promise<StoreModule> {
  install(b);
  vi.resetModules();
  const store = await import('../../src/web/lib/store');
  await store.boot();
  await settle();
  await tick(300);
  return store;
}

/** The app closed and opened again: the old page's timers and listeners are gone with it. */
async function reload(b: Browser): Promise<StoreModule> {
  vi.clearAllTimers();
  b.win.clear();
  return open(b);
}

async function online(b: Browser): Promise<void> {
  b.offline = false;
  for (const fn of b.win.get('online') ?? []) fn({});
  await settle();
  await tick(500);
}

/** The outbox records as stored (idb.ts in localStorage), oldest first. */
function stored(b: Browser): Record<string, unknown>[] {
  return [...b.ls.map.entries()]
    .filter(([k]) => k.startsWith('evenly.kv.outbox:'))
    .map(([, v]) => JSON.parse(v) as Record<string, unknown>)
    .sort((x, y) => (x.createdAt as number) - (y.createdAt as number));
}

const writes = (b: Browser) => b.sent.filter(s => !s.startsWith('GET '));
const stoppedNotes = () => toasts.shown.filter(x => x.message === STOPPED);

describe('the store sends 只刪除這一筆 through the outbox', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    toasts.shown.length = 0;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('只刪除這一筆 goes as DELETE ?keep=series; 刪除並停止重複 and any other delete as a plain DELETE', async () => {
    const b = newBrowser();
    const store = await open(b);
    store.actions.deleteExpense('g1', 'c-nov', { keepSeries: true });
    await settle();
    await tick(500);
    store.actions.deleteExpense('g1', 'c-oct');
    store.actions.deleteExpense('g1', 'rent-0001', { keepSeries: false });
    await settle();
    await tick(500);
    expect(writes(b)).toEqual(['DELETE /api/groups/g1/expenses/c-nov?keep=series', 'DELETE /api/groups/g1/expenses/c-oct', 'DELETE /api/groups/g1/expenses/rent-0001']);
    expect(stored(b)).toEqual([]);
    expect(store.getState().groups.g1.snap!.expenses.every(e => !!e.deletedAt)).toBe(true);
    // The series went on (seriesKept true): nothing more to say.
    expect(stoppedNotes()).toEqual([]);
  });

  it('queued offline, the choice is stored with the item and still goes after a reload; a retry after a server error sends it again', async () => {
    const b = newBrowser();
    let store = await open(b);
    b.offline = true;
    store.actions.deleteExpense('g1', 'c-nov', { keepSeries: true });
    await settle();
    await tick(300);
    const [rec] = stored(b);
    expect([rec.op, rec.expenseId, rec.body]).toEqual(['delete', 'c-nov', { keep: 'series' }]);
    // The page shows it deleted meanwhile.
    expect(store.applyOutbox(store.getState().groups.g1.snap, store.getState().outbox, ME).snap!.expenses.find(e => e.id === 'c-nov')!.deletedAt).not.toBeNull();

    // The app is closed and opened again, still offline; the server is in trouble when it comes back.
    store = await reload(b);
    expect(store.getState().outbox.map(i => [i.op, i.body])).toEqual([['delete', { keep: 'series' }]]);
    let failures = 1;
    b.override = method => (method === 'DELETE' && failures-- > 0 ? json(503, { error: { code: 'unavailable', message: 'Try again later' } }) : undefined);
    await online(b);
    expect(writes(b)).toEqual(['DELETE /api/groups/g1/expenses/c-nov?keep=series']);
    expect(stored(b)[0]?.lastError).toMatchObject({ code: 'unavailable' });
    await tick(16_000);
    expect(writes(b)).toEqual(['DELETE /api/groups/g1/expenses/c-nov?keep=series', 'DELETE /api/groups/g1/expenses/c-nov?keep=series']);
    expect(stored(b)).toEqual([]);
  });

  it('a delete an older build queued (no body) still goes, as a plain DELETE', async () => {
    const b = newBrowser();
    b.ls.setItem('evenly.kv.outbox:OLD1', JSON.stringify({ id: 'OLD1', op: 'delete', groupId: 'g1', expenseId: 'c-nov', createdAt: Date.now(), attempts: 0, nextTryAt: 0, error: null, userId: ME }));
    await open(b);
    await tick(500);
    expect(writes(b)).toEqual(['DELETE /api/groups/g1/expenses/c-nov']);
    expect(stored(b)).toEqual([]);
    expect(stoppedNotes()).toEqual([]);
  });

  it('seriesKept false: said once, with 復原, also when the first answer was lost; 復原 restores the entry', async () => {
    const b = newBrowser();
    b.seriesKept = false;
    const store = await open(b);
    // The first try reaches the Worker, and its answer never comes back.
    let lose = true;
    b.override = method => {
      if (method !== 'DELETE' || !lose) return undefined;
      lose = false;
      answer({ ...b, override: null }, 'DELETE', new URL(API + '/api/groups/g1/expenses/c-nov?keep=series'));
      throw new TypeError('Failed to fetch');
    };
    store.actions.deleteExpense('g1', 'c-nov', { keepSeries: true });
    await settle();
    await tick(500);
    expect(stoppedNotes()).toEqual([]);
    await tick(16_000);
    expect(writes(b)).toEqual(['DELETE /api/groups/g1/expenses/c-nov?keep=series', 'DELETE /api/groups/g1/expenses/c-nov?keep=series']);
    const notes = stoppedNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].action?.label).toBe('Undo');
    await tick(16_000);
    expect(stoppedNotes()).toHaveLength(1);
    notes[0].action!.run();
    await settle();
    await tick(500);
    expect(writes(b).slice(-1)).toEqual(['POST /api/groups/g1/expenses/c-nov/restore']);
    expect(store.getState().groups.g1.snap!.expenses.find(e => e.id === 'c-nov')).toMatchObject({ deletedAt: null, repeat: 'monthly' });
  });

  it('seriesKept false while the entry\'s 復原 is queued already: nothing is said, and the restore follows', async () => {
    const b = newBrowser();
    b.seriesKept = false;
    const store = await open(b);
    b.offline = true;
    store.actions.deleteExpense('g1', 'c-nov', { keepSeries: true });
    // 復原 in the page's toast, before anything went out.
    store.actions.restoreExpense('g1', 'c-nov');
    await settle();
    await online(b);
    expect(writes(b)).toEqual(['DELETE /api/groups/g1/expenses/c-nov?keep=series', 'POST /api/groups/g1/expenses/c-nov/restore']);
    expect(stoppedNotes()).toEqual([]);
  });

  it('a plain delete of a repeating entry says nothing more, whatever the Worker answers', async () => {
    const b = newBrowser();
    b.seriesKept = false;
    const store = await open(b);
    store.actions.deleteExpense('g1', 'c-nov');
    await settle();
    await tick(500);
    expect(writes(b)).toEqual(['DELETE /api/groups/g1/expenses/c-nov']);
    expect(stoppedNotes()).toEqual([]);
  });
});

// ---------- the store against the real Worker ----------

// Loaded by path at run time, so the web typecheck does not pull in the Worker sources.
const WORKER = '../../src/worker/index';
const WORKER_AUTH = '../../src/worker/auth';
const WORKER_HTTP = '../../src/worker/http';
const TEST_D1 = '../worker/d1-sqlite';

interface WorkerModule {
  default: { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> };
}
interface AuthModule {
  createSession: (db: unknown, userId: string, label: string) => Promise<string>;
}
interface HttpModule {
  uuidFrom: (s: string) => Promise<string>;
}
interface D1Module {
  TestD1: new () => {
    d1: unknown;
    exec: (sql: string, ...params: (string | number | null)[]) => void;
    rows: <T>(sql: string, ...params: (string | number | null)[]) => T[];
  };
}

async function settleReal(n = 300): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>(r => setImmediate(r));
}

/** A weekly series 15 days old in a TWD group (copies 8 days and 1 day ago, the newer one the head), and the store signed in as Ann. */
async function realWorld() {
  const worker = ((await import(/* @vite-ignore */ WORKER)) as WorkerModule).default;
  const { createSession } = (await import(/* @vite-ignore */ WORKER_AUTH)) as AuthModule;
  const { uuidFrom } = (await import(/* @vite-ignore */ WORKER_HTTP)) as HttpModule;
  const { TestD1 } = (await import(/* @vite-ignore */ TEST_D1)) as D1Module;
  const db = new TestD1();
  const now = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'uA', 'Ann', 'a@evenly.test', '#2F6FB5', now, now);
  const token = await createSession(db.d1, 'uA', 'test');
  const env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'http://app.test/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
  const direct = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const headers: Record<string, string> = { Authorization: 'Bearer ' + token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await worker.fetch(new Request('http://api.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
  };
  const made = await direct<GroupSnapshotDTO>('POST', '/api/groups', { name: 'home', type: 'home', currency: 'TWD', members: [{ name: 'Bea' }] });
  expect(made.status).toBe(200);
  const gid = made.data.group.id;
  const A = made.data.members.find(m => m.name === 'Ann')!.id;
  const B = made.data.members.find(m => m.name === 'Bea')!.id;
  const body = (over: Record<string, unknown>) => ({
    kind: 'expense', description: 'rent', category: 'general', amount: 300, currency: 'TWD', fxRate: 1, date: todayUTC(),
    payers: [{ memberId: A, amount: 300 }], split: { method: 'equal', entries: [{ memberId: A }, { memberId: B }] }, ...over,
  });
  expect((await direct('PUT', `/api/groups/${gid}/expenses/head-0001`, body({ repeat: 'weekly', date: addDays(todayUTC(), -15) }))).status).toBe(200);
  await direct('GET', '/api/groups/' + gid);
  const c1 = await uuidFrom(`head-0001:${addDays(todayUTC(), -8)}`);
  const c2 = await uuidFrom(`head-0001:${addDays(todayUTC(), -1)}`);
  const repeats = () =>
    db.rows<{ id: string; repeat: string; deleted_at: string | null }>('SELECT id, repeat, deleted_at FROM expenses WHERE group_id = ? ORDER BY date, id', gid);
  expect(repeats().map(r => [r.id, r.repeat])).toEqual([['head-0001', 'none'], [c1, 'none'], [c2, 'weekly']]);

  // ---- the browser ----
  const sent: string[] = [];
  const ls = new MemoryStorage();
  ls.setItem('evenly.api', API);
  ls.setItem('evenly.token', token);
  ls.setItem('evenly.locale', 'en');
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('location', { origin: 'https://split.test', href: 'https://split.test/#/', pathname: '/', search: '', hash: '#/', reload: () => undefined });
  vi.stubGlobal('history', { state: null, replaceState: () => undefined, back: () => undefined });
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia: () => ({ matches: false }), dispatchEvent: () => true });
  vi.stubGlobal('document', { cookie: '', visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined, documentElement: {} });
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'test', language: 'en-US', languages: ['en-US'], platform: 'test', maxTouchPoints: 0 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    sent.push(method + ' ' + u.pathname + u.search);
    return worker.fetch(new Request('http://api.test' + u.pathname + u.search, { method, headers: init.headers as Record<string, string>, body: init.body as BodyInit | undefined }), env, ctx);
  });
  vi.resetModules();
  const store: StoreModule = await import('../../src/web/lib/store');
  await store.boot();
  await settleReal();
  await store.actions.loadGroup(gid, { force: true });
  await settleReal();
  expect(store.getState().me?.user.id).toBe('uA');
  /** The entries of the series as the store shows them. */
  const shown = (id: string) => store.applyOutbox(store.getState().groups[gid]?.snap ?? null, store.getState().outbox, 'uA').snap!.expenses.find(e => e.id === id)!;
  return { store, gid, c1, c2, sent, direct, body, repeats, shown };
}

describe('只刪除這一筆 from the store, against the real Worker', () => {
  beforeEach(() => {
    // The store's 15 s and 60 s timers stay still: each test drives the sends itself.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    toasts.shown.length = 0;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('the copy before it takes the repeat over; 復原 brings the head back as the one entry that repeats, also on the page', async () => {
    const w = await realWorld();
    w.store.actions.deleteExpense(w.gid, w.c2, { keepSeries: true });
    await settleReal();
    await w.store.flush();
    await settleReal();
    expect(w.sent).toContain(`DELETE /api/groups/${w.gid}/expenses/${w.c2}?keep=series`);
    expect(w.repeats().map(r => [r.id, r.repeat, !!r.deleted_at])).toEqual([['head-0001', 'none', false], [w.c1, 'weekly', false], [w.c2, 'weekly', true]]);
    // The store read the group again after the delete: the page shows the copy before it repeating.
    expect(w.shown(w.c1).repeat).toBe('weekly');
    expect(w.shown(w.c2).deletedAt).not.toBeNull();
    expect(stoppedNotes()).toEqual([]);

    w.store.actions.restoreExpense(w.gid, w.c2);
    await settleReal();
    await w.store.flush();
    await settleReal();
    // The read after the restore runs the recurring pass, which takes the repeat back from the
    // older copy (planSeries: the restored head is one of its due dates): one head, on the server
    // and on the page.
    expect(w.repeats().map(r => [r.id, r.repeat, !!r.deleted_at])).toEqual([['head-0001', 'none', false], [w.c1, 'none', false], [w.c2, 'weekly', false]]);
    expect([w.shown(w.c1).repeat, w.shown(w.c2).repeat, w.shown(w.c2).deletedAt]).toEqual(['none', 'weekly', null]);
  });

  it('the series\' first entry while it is the newest: the Worker answers seriesKept false, the store says so once, and its 復原 brings the repeat back', async () => {
    const w = await realWorld();
    expect((await w.direct('PUT', `/api/groups/${w.gid}/expenses/gym-0001`, w.body({ repeat: 'monthly' }))).status).toBe(200);
    await w.store.actions.loadGroup(w.gid, { force: true });
    await settleReal();
    // The page would not offer it here (offersKeepSeries); a view from before another device's change could.
    w.store.actions.deleteExpense(w.gid, 'gym-0001', { keepSeries: true });
    await settleReal();
    await w.store.flush();
    await settleReal();
    expect(w.sent).toContain(`DELETE /api/groups/${w.gid}/expenses/gym-0001?keep=series`);
    const notes = stoppedNotes();
    expect(notes).toHaveLength(1);
    notes[0].action!.run();
    await settleReal();
    await w.store.flush();
    await settleReal();
    expect(w.shown('gym-0001')).toMatchObject({ deletedAt: null, repeat: 'monthly' });
    expect(stoppedNotes()).toHaveLength(1);
  });
});
