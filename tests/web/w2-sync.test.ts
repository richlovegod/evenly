// The web store's outbox against the real Worker (review of 2026-11-07, unit W2). One tab of the
// real store runs in a fake browser (bearer mode, no IndexedDB, so idb.ts keeps its records in
// localStorage), and its fetch goes into the real Worker over the real schema (tests/worker/
// d1-sqlite.ts), with switches for no connection, an answer lost after the Worker wrote the
// change, and an answer whose body breaks. Edits are built as ExpenseEditorPage.save builds them:
// `base` is the copy the form opened, which the outbox view (applyOutbox) already shows.
//
// Covered: two saves of one entry queued offline both land (a newer edit no longer replaces a
// queued one, outbox.ts replaceableSave); a first save that landed with its answer lost, followed
// by a re-edit, a revert or 復原, ends as typed; an offline new entry and an edit still make one
// PUT; a save made from a form that showed a refused save meets the same clash instead of
// settling it without a word (afterRefusal, from drain and from enqueue); a new entry the server
// refuses holds its photo and comment back, and 放棄 takes them with it and forgets the deleted
// group; a save whose answer's body breaks after the Worker wrote it is retried, not failed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseDTO, GroupSnapshotDTO, UpsertExpenseReq } from '../../src/shared/types';
import { bodyOfExpense } from '../../src/web/features/expenses/editorLogic';

type StoreModule = typeof import('../../src/web/lib/store');

// Loaded by path at run time, so the web typecheck does not pull in the Worker sources.
const WORKER = '../../src/worker/index';
const WORKER_AUTH = '../../src/worker/auth';
const TEST_D1 = '../worker/d1-sqlite';

interface WorkerModule {
  default: { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> };
}
interface AuthModule {
  createSession: (db: unknown, userId: string, label: string) => Promise<string>;
}
interface D1Module {
  TestD1: new () => { d1: unknown; exec: (sql: string, ...params: (string | number | null)[]) => void };
}

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

async function settle(n = 120): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>(r => setImmediate(r));
}

const EID = '0b9e0b9e-0000-4000-8000-0000000000aa';

interface Res<T = unknown> {
  status: number;
  data: T;
}

async function world() {
  const worker = ((await import(/* @vite-ignore */ WORKER)) as WorkerModule).default;
  const { createSession } = (await import(/* @vite-ignore */ WORKER_AUTH)) as AuthModule;
  const { TestD1 } = (await import(/* @vite-ignore */ TEST_D1)) as D1Module;
  const db = new TestD1();
  const now = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'uA', 'Ann', 'a@evenly.test', '#2F6FB5', now, now);
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'uB', 'Bea', 'b@evenly.test', '#2F6FB5', now, now);
  const tokens = { A: await createSession(db.d1, 'uA', 'test'), B: await createSession(db.d1, 'uB', 'test') };
  const env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'http://app.test/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
  /** A request straight to the Worker, as Ann or Bea on another device. */
  const direct = async <T = unknown>(as: 'A' | 'B', method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const headers: Record<string, string> = { Authorization: 'Bearer ' + tokens[as] };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await worker.fetch(new Request('http://api.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
  };

  const made = await direct<GroupSnapshotDTO>('A', 'POST', '/api/groups', { name: 'trip', type: 'trip', currency: 'TWD', members: [{ name: 'Bea', email: 'b@evenly.test' }] });
  expect(made.status).toBe(200);
  const gid = made.data.group.id;
  const A = made.data.members.find(m => m.name === 'Ann')!.id;
  const B = made.data.members.find(m => m.name === 'Bea')!.id;
  const v1 = {
    kind: 'expense', description: '燒肉晚餐', category: 'food.dining', amount: 1000, currency: 'TWD', fxRate: 1, date: '2026-11-01',
    payers: [{ memberId: A, amount: 1000 }], split: { method: 'equal', entries: [{ memberId: A }, { memberId: B }] },
  };
  expect((await direct('A', 'PUT', `/api/groups/${gid}/expenses/${EID}`, v1)).status).toBe(200);

  // ---- the browser ----
  const net = { offline: false, loseNextSaveAnswer: false, breakNextSaveBody: false };
  /** Saves (PUT .../expenses/<id>) as they reached the Worker, and what it answered. */
  const saves: { status: number; body: UpsertExpenseReq }[] = [];
  /** Every request that reached the Worker, as "METHOD path". */
  const sent: string[] = [];
  const win = new Map<string, ((e: unknown) => void)[]>();
  const ls = new MemoryStorage();
  ls.setItem('evenly.api', 'https://api.test');
  ls.setItem('evenly.token', tokens.A);
  ls.setItem('evenly.locale', 'en');
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('location', { origin: 'https://split.test', href: 'https://split.test/#/', pathname: '/', search: '', hash: '#/', reload: () => undefined });
  vi.stubGlobal('history', { state: null, replaceState: () => undefined, back: () => undefined });
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (e: unknown) => void) => win.set(type, [...(win.get(type) ?? []), fn]),
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false }),
    dispatchEvent: () => true,
  });
  vi.stubGlobal('document', { cookie: '', visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined, documentElement: {} });
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'test', language: 'en-US', languages: ['en-US'], platform: 'test', maxTouchPoints: 0 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (net.offline) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const method = init.method ?? 'GET';
    sent.push(method + ' ' + u.pathname);
    const req = new Request('http://api.test' + u.pathname + u.search, { method, headers: init.headers as Record<string, string>, body: init.body as BodyInit | undefined });
    const res = await worker.fetch(req, env, ctx);
    const save = method === 'PUT' && /\/expenses\/[^/]+$/.test(u.pathname);
    if (save) saves.push({ status: res.status, body: JSON.parse(String(init.body)) as UpsertExpenseReq });
    if (save && net.loseNextSaveAnswer) {
      // The Worker wrote it; the answer never reaches the phone (a dropped connection, the timeout).
      net.loseNextSaveAnswer = false;
      throw new TypeError('Failed to fetch');
    }
    if (save && net.breakNextSaveBody) {
      // The headers came, then the connection broke while the body was on its way.
      net.breakNextSaveBody = false;
      return new Response(new ReadableStream({ start: c => c.error(new TypeError('Load failed')) }), { status: res.status, headers: res.headers });
    }
    return res;
  });

  vi.resetModules();
  const store: StoreModule = await import('../../src/web/lib/store');
  await store.boot();
  await settle();
  await store.actions.loadGroup(gid, { force: true });
  await settle();
  expect(store.getState().me?.user.id).toBe('uA');

  const st = () => store.getState();
  const view = () => store.applyOutbox(st().groups[gid]?.snap ?? null, st().outbox, 'uA');
  /** The entry as the editor opens it: the outbox view. */
  const opened = (): ExpenseDTO => view().snap!.expenses.find(e => e.id === EID)!;
  /** ExpenseEditorPage.save: the form's body, its copy as `base`, and that copy's version. */
  const saveFrom = (from: ExpenseDTO, change: Partial<UpsertExpenseReq>) => {
    const { baseVersion: _v, base: _b, ...was } = bodyOfExpense(from);
    store.actions.saveExpense(gid, EID, { ...was, ...change, baseVersion: from.version, base: was });
  };
  /** 復原 after an edit as an older version of the app queued it: the entry as it was before (bodyOfExpense, no base). Today's has a base (editorLogic.undoOfEdit, tests/worker/w1-edit-merge.test.ts). */
  const undo = (before: ExpenseDTO) => store.actions.saveExpense(gid, EID, bodyOfExpense(before));
  const goOffline = () => {
    net.offline = true;
    (navigator as { onLine: boolean }).onLine = false;
  };
  const goOnline = async () => {
    net.offline = false;
    (navigator as { onLine: boolean }).onLine = true;
    for (const fn of win.get('online') ?? []) fn({});
    await settle(300);
    await store.flush();
    await settle(300);
  };
  const server = async (): Promise<ExpenseDTO> => (await direct<GroupSnapshotDTO>('A', 'GET', '/api/groups/' + gid)).data.expenses.find(e => e.id === EID)!;
  /** Bea, online on her phone, edits the entry from the server's copy. */
  const beaEdits = async (change: Record<string, unknown>) => {
    const cur = await server();
    const { baseVersion: _v, base: _b, ...was } = bodyOfExpense(cur);
    return direct('B', 'PUT', `/api/groups/${gid}/expenses/${EID}`, { ...was, ...change, base: was, baseVersion: cur.version, rateBase: 'TWD' });
  };
  const amount = (n: number) => ({ amount: n, payers: [{ memberId: A, amount: n }] });
  return { store, st, view, gid, A, B, net, saves, sent, direct, opened, saveFrom, undo, goOffline, goOnline, server, beaEdits, amount };
}

beforeEach(() => {
  // The store's 15 s and 60 s timers stay still: each test drives the sends itself.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('two saves of one synced entry before the first one went out', () => {
  it('offline, edits of different parts both go, in order, and both are stored (Bea\'s notes meanwhile too)', async () => {
    const w = await world();
    w.goOffline();
    w.saveFrom(w.opened(), w.amount(2000));
    await settle();
    // The form opens again on the merged view, which shows NT$2,000; only the date changes now.
    expect(w.opened().amount).toBe(2000);
    w.saveFrom(w.opened(), { date: '2026-11-02' });
    await settle();
    expect(w.st().outbox.map(i => i.op)).toEqual(['upsert', 'upsert']);
    expect((await w.beaEdits({ notes: 'Bea was here' })).status).toBe(200);
    await w.goOnline();
    expect(await w.server()).toMatchObject({ amount: 2000, date: '2026-11-02', notes: 'Bea was here' });
    expect(w.saves.map(s => s.status)).toEqual([200, 200]);
    expect(w.st().outbox).toEqual([]);
  });

  it.each([
    ['the same part again', (w: Awaited<ReturnType<typeof world>>) => w.saveFrom(w.opened(), w.amount(2500)), { amount: 2500 }],
    ['the amount put back, and the date moved', (w: Awaited<ReturnType<typeof world>>) => w.saveFrom(w.opened(), { ...w.amount(1000), date: '2026-11-02' }), { amount: 1000, date: '2026-11-02' }],
  ])('the first save landed with its answer lost, then a new edit (%s): it ends as typed, with no 409', async (_name, second, want) => {
    const w = await world();
    w.net.loseNextSaveAnswer = true;
    w.saveFrom(w.opened(), w.amount(2000));
    await settle(300);
    expect((await w.server()).amount).toBe(2000);
    expect(w.st().outbox[0]?.lastError?.code).toBe('offline');
    second(w);
    await settle();
    await w.goOnline();
    expect(await w.server()).toMatchObject(want);
    expect(w.saves.every(s => s.status === 200)).toBe(true);
    expect(w.st().outbox).toEqual([]);
  });

  it('the first save landed with its answer lost, then 復原: the entry is as before', async () => {
    const w = await world();
    const before = w.opened();
    w.net.loseNextSaveAnswer = true;
    w.saveFrom(before, w.amount(2000));
    await settle(300);
    w.undo(before);
    await settle();
    await w.goOnline();
    expect((await w.server()).amount).toBe(1000);
    expect(w.st().outbox).toEqual([]);
  });

  it('an offline new entry followed by an edit of it still makes one PUT', async () => {
    const w = await world();
    const NEW = '0b9e0b9e-0000-4000-8000-0000000000bb';
    w.goOffline();
    const body = { ...bodyOfExpense(w.opened()), description: '拉麵' };
    delete body.baseVersion;
    w.store.actions.saveExpense(w.gid, NEW, body);
    await settle();
    const shown = w.view().snap!.expenses.find(e => e.id === NEW)!;
    const { baseVersion: _v, base: _b, ...was } = bodyOfExpense(shown);
    w.store.actions.saveExpense(w.gid, NEW, { ...was, description: '豚骨拉麵', baseVersion: shown.version, base: was });
    await settle();
    expect(w.st().outbox).toHaveLength(1);
    await w.goOnline();
    const puts = w.sent.filter(s => s === `PUT /api/groups/${w.gid}/expenses/${NEW}`);
    expect(puts).toHaveLength(1);
    const snap = (await w.direct<GroupSnapshotDTO>('A', 'GET', '/api/groups/' + w.gid)).data;
    expect(snap.expenses.find(e => e.id === NEW)?.description).toBe('豚骨拉麵');
  });
});

describe('a save made from a form that showed a save the server refused', () => {
  it('queued behind it: it meets the same clash (409) instead of settling it without a word', async () => {
    const w = await world();
    w.goOffline();
    w.saveFrom(w.opened(), w.amount(2000));
    await settle();
    w.saveFrom(w.opened(), { date: '2026-11-02' });
    await settle();
    // Bea changes the amount meanwhile: Ann's first edit clashes with hers.
    expect((await w.beaEdits(w.amount(1500))).status).toBe(200);
    await w.goOnline();
    expect(w.saves.map(s => s.status)).toEqual([409, 409]);
    expect(await w.server()).toMatchObject({ amount: 1500, date: '2026-11-01' });
    const pending = w.view().pending[EID];
    expect(pending).toMatchObject({ state: 'failed', error: { code: 'conflict', message: 'Someone else changed this after you opened it. Discard this change, then open it again to edit it.' } });
  });

  it('made after it failed: the same clash again, and nothing is written', async () => {
    const w = await world();
    w.goOffline();
    w.saveFrom(w.opened(), w.amount(2000));
    await settle();
    expect((await w.beaEdits(w.amount(1500))).status).toBe(200);
    await w.goOnline();
    expect(w.view().pending[EID]?.state).toBe('failed');
    // The form opens on the failed save (NT$2,000) and changes only the description.
    expect(w.opened().amount).toBe(2000);
    w.saveFrom(w.opened(), { description: '燒肉' });
    await settle(300);
    await w.store.flush();
    await settle(300);
    expect(w.saves.map(s => s.status)).toEqual([409, 409]);
    expect(await w.server()).toMatchObject({ amount: 1500, description: '燒肉晚餐' });
    expect(w.view().pending[EID]?.state).toBe('failed');
  });

  it('when nothing clashes, the parts of the refused save that the form still showed are written too', async () => {
    const w = await world();
    w.goOffline();
    w.saveFrom(w.opened(), w.amount(2000));
    await settle();
    w.saveFrom(w.opened(), { date: '2026-11-02' });
    await settle();
    // Bea renames the entry meanwhile: a part neither of Ann's edits touches.
    expect((await w.beaEdits({ description: '燒肉晚餐（Bea）' })).status).toBe(200);
    // The first edit is refused for good (a 400, so it never landed); the second goes on.
    vi.stubGlobal('fetch', refuseFirstSave(globalThis.fetch));
    await w.goOnline();
    expect(await w.server()).toMatchObject({ amount: 2000, date: '2026-11-02', description: '燒肉晚餐（Bea）' });
    // The edit that landed carried the refused one's parts, so that failure is moot and goes.
    expect(w.st().outbox).toEqual([]);
  });
});

/** A fetch that answers the first save with a 400 (refused for good, never written), then passes everything on. */
function refuseFirstSave(inner: typeof fetch): typeof fetch {
  let refused = false;
  return (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (!refused && init.method === 'PUT' && /\/expenses\/[^/]+$/.test(u.pathname)) {
      refused = true;
      return new Response(JSON.stringify({ error: { code: 'validation', message: 'Some fields are not valid' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return inner(url, init);
  }) as typeof fetch;
}

describe('a new entry the server refuses for good', () => {
  it('holds back its photo and comment; 放棄 takes them with it, and the deleted group is forgotten', async () => {
    const w = await world();
    const NEW = '0b9e0b9e-0000-4000-8000-0000000000cc';
    w.goOffline();
    const body = { ...bodyOfExpense(w.opened()), description: '晚餐' };
    delete body.baseVersion;
    w.store.actions.saveExpense(w.gid, NEW, body);
    w.store.actions.addReceiptPhoto(w.gid, NEW, { version: 'abcdef0123456789', image: 'data:image/jpeg;base64,/9j/', width: 4, height: 4 });
    w.store.actions.addComment(w.gid, NEW, '收據在這');
    await settle();
    // The admin deletes the group meanwhile, on another device.
    expect((await w.direct('A', 'DELETE', '/api/groups/' + w.gid)).status).toBe(200);
    await w.goOnline();
    expect(w.sent.filter(s => s.includes('/receipts/') || s.endsWith('/comments'))).toEqual([]);
    const items = w.st().outbox;
    expect(items.map(i => [i.op, i.error?.code ?? null])).toEqual([['upsert', 'not_found'], ['photo', null], ['comment', null]]);
    w.store.actions.discard(items[0].id);
    expect(w.st().outbox).toEqual([]);
    expect(w.st().groups[w.gid]?.snap ?? null).toBeNull();
  });
});

describe('a save whose answer\'s body breaks after the Worker wrote it', () => {
  it('waits and goes again (no connection), and the retry writes nothing more: no 同步失敗', async () => {
    const w = await world();
    w.net.breakNextSaveBody = true;
    w.saveFrom(w.opened(), w.amount(2000));
    await settle(300);
    expect(w.st().outbox[0]).toMatchObject({ error: null, lastError: { code: 'offline' } });
    await w.goOnline();
    expect(w.saves.map(s => s.status)).toEqual([200, 200]);
    expect((await w.server()).amount).toBe(2000);
    expect(w.st().outbox).toEqual([]);
  });
});
