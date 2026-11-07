// The web store's outbox against the real Worker (review of 2026-11-07, unit W2). One tab of the
// real store runs in a fake browser (bearer mode, no IndexedDB, so idb.ts keeps its records in
// localStorage), and its fetch goes into the real Worker over the real schema (tests/worker/
// d1-sqlite.ts), with switches for no connection, an answer lost after the Worker wrote the
// change, and an answer whose body breaks. Edits are built as ExpenseEditorPage.save builds them:
// `base` is the copy the form opened, which the outbox view (applyOutbox) already shows.
//
// Covered: two saves of one entry queued offline both land (a newer edit no longer replaces a
// queued one, outbox.ts replaceableSave); a first save that landed with its answer lost, followed
// by a re-edit, a revert or 復原 (as the editor sends it, with a base, and as an older build
// queued it), ends as typed; an offline new entry and an edit still make one PUT; a save made from
// a form that showed a refused save meets the same clash instead of settling it without a word
// (afterRefusal, from drain and from enqueue); the retry of a save that landed with its answer lost
// is answered as done by its opId, after someone else changed the same part (review W2-correct-01)
// and after a change that does not clash, which it keeps (a new entry changed, an amount set back;
// G9-contract-01), while one that never reached the Worker still meets the clash; a new entry the
// server refuses holds its photo and comment back, and 放棄 takes them with it and forgets the
// deleted group; a save whose answer's body breaks after the Worker wrote it is retried, not
// failed. Also two store actions on the same harness: group settings answering out of order
// (B6a-12) and importExpenses' reasons and reload (B6b-04, B6b-02).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseDTO, GroupSnapshotDTO, UpsertExpenseReq } from '../../src/shared/types';
import { bodyOfExpense, undoOfEdit } from '../../src/web/features/expenses/editorLogic';

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
  /** 復原 after an edit as an older version of the app queued it: the entry as it was before (bodyOfExpense, no base). Today's has a base (undoEdit). */
  const undo = (before: ExpenseDTO) => store.actions.saveExpense(gid, EID, bodyOfExpense(before));
  /**
   * 復原 as the editor sends it today (ExpenseEditorPage.save, editorLogic.undoOfEdit): the copy the
   * newest queued save was merged against (`before`), merged against what that save sent.
   */
  const undoEdit = (before: ExpenseDTO) => {
    const sent = store.getState().outbox.at(-1)!.body as UpsertExpenseReq;
    store.actions.saveExpense(gid, EID, undoOfEdit(sent, before, 'TWD'));
  };
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
  const server = async (id = EID): Promise<ExpenseDTO> => (await direct<GroupSnapshotDTO>('A', 'GET', '/api/groups/' + gid)).data.expenses.find(e => e.id === id)!;
  /** Bea, online on her phone, edits the entry from the server's copy. */
  const beaEdits = async (change: Record<string, unknown>, id = EID) => {
    const cur = await server(id);
    const { baseVersion: _v, base: _b, ...was } = bodyOfExpense(cur);
    return direct('B', 'PUT', `/api/groups/${gid}/expenses/${id}`, { ...was, ...change, base: was, baseVersion: cur.version, rateBase: 'TWD' });
  };
  /** Who wrote each line of the entry's history, oldest first. */
  const historyBy = async (id = EID): Promise<(string | null)[]> =>
    (await direct<{ items: { userId: string | null }[] }>('A', 'GET', `/api/groups/${gid}/expenses/${id}/history`)).data.items.map(i => i.userId);
  const amount = (n: number) => ({ amount: n, payers: [{ memberId: A, amount: n }] });
  return { store, st, view, gid, A, B, net, saves, sent, direct, opened, saveFrom, undo, undoEdit, goOffline, goOnline, server, beaEdits, historyBy, amount };
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

  it('the first save landed with its answer lost, then 復原 as the editor sends it: it queues behind the save, and the entry is as before (review W2-correct-05)', async () => {
    const w = await world();
    const before = w.opened();
    w.net.loseNextSaveAnswer = true;
    w.saveFrom(before, w.amount(2000));
    await settle(300);
    w.undoEdit(before);
    await settle();
    // A 復原 with a base goes after its edit (outbox.ts replaceableSave), it does not replace it.
    expect(w.st().outbox.map(i => i.op)).toEqual(['upsert', 'upsert']);
    await w.goOnline();
    expect(w.saves.every(s => s.status === 200)).toBe(true);
    expect((await w.server()).amount).toBe(1000);
    expect(w.st().outbox).toEqual([]);
  });

  it('an offline edit, then 復原 as the editor sends it: two PUTs, and the entry is as before', async () => {
    const w = await world();
    const before = w.opened();
    w.goOffline();
    w.saveFrom(before, w.amount(2000));
    await settle();
    w.undoEdit(before);
    await settle();
    await w.goOnline();
    expect(w.saves.map(s => s.status)).toEqual([200, 200]);
    expect((await w.server()).amount).toBe(1000);
    expect(w.st().outbox).toEqual([]);
  });

  it('the first save landed with its answer lost, then 復原 as an older version of the app queued it (no base): the entry is as before', async () => {
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

describe('a save that landed with its answer lost, then someone else changed the same part (review W2-correct-01)', () => {
  it('the retry is answered as done (its opId), and the next edit, queued behind it, lands too', async () => {
    const w = await world();
    w.net.loseNextSaveAnswer = true;
    w.saveFrom(w.opened(), w.amount(2000));
    await settle(300);
    expect((await w.server()).amount).toBe(2000);
    // Bea saw NT$2,000 and sets NT$1,500 on her phone.
    expect((await w.beaEdits(w.amount(1500))).status).toBe(200);
    // Ann, still waiting for the retry, fixes only the date (the form shows NT$2,000).
    expect(w.opened().amount).toBe(2000);
    w.saveFrom(w.opened(), { date: '2026-11-02' });
    await settle();
    await w.goOnline();
    expect(w.saves.map(s => s.status)).toEqual([200, 200, 200]);
    expect(w.saves.every(s => typeof s.body.opId === 'string')).toBe(true);
    expect(w.saves[1].body.opId).toBe(w.saves[0].body.opId);
    expect(await w.server()).toMatchObject({ amount: 1500, date: '2026-11-02' });
    expect(w.st().outbox).toEqual([]);
  });

  it('the same when the date edit comes after the retry: it goes from the stored NT$1,500', async () => {
    const w = await world();
    w.net.loseNextSaveAnswer = true;
    w.saveFrom(w.opened(), w.amount(2000));
    await settle(300);
    expect((await w.beaEdits(w.amount(1500))).status).toBe(200);
    await w.goOnline();
    expect(w.view().pending[EID]).toBeUndefined();
    w.saveFrom(w.opened(), { date: '2026-11-02' });
    await settle(300);
    await w.store.flush();
    await settle(300);
    expect(w.saves.map(s => s.status)).toEqual([200, 200, 200]);
    expect(await w.server()).toMatchObject({ amount: 1500, date: '2026-11-02' });
    expect(w.st().outbox).toEqual([]);
  });

  it('a save whose first try never reached the server still meets the clash, and so does the edit behind it: shown, never dropped', async () => {
    const w = await world();
    // A stalled connect or a reset while the browser says it is online: nothing reached the Worker.
    w.net.offline = true;
    w.saveFrom(w.opened(), w.amount(2000));
    await settle(300);
    expect(w.st().outbox[0]?.lastError?.code).toBe('offline');
    expect((await w.beaEdits(w.amount(1500))).status).toBe(200);
    w.saveFrom(w.opened(), { date: '2026-11-02' });
    await settle();
    await w.goOnline();
    expect(w.saves.map(s => s.status)).toEqual([409, 409]);
    expect(await w.server()).toMatchObject({ amount: 1500, date: '2026-11-01' });
    expect(w.view().pending[EID]).toMatchObject({ state: 'failed', error: { code: 'conflict' } });
  });
});

describe('a save that landed with its answer lost, then someone else changed it with no clash (review G9-contract-01)', () => {
  it("a new entry whose answer was lost, then Bea's NT$1,500: the retry keeps it", async () => {
    const w = await world();
    const NEW = '0b9e0b9e-0000-4000-8000-0000000000ee';
    const body = { ...bodyOfExpense(w.opened()), description: '拉麵' };
    delete body.baseVersion;
    w.net.loseNextSaveAnswer = true;
    w.store.actions.saveExpense(w.gid, NEW, body);
    await settle(300);
    expect((await w.server(NEW)).amount).toBe(1000);
    expect(w.st().outbox[0]?.lastError?.code).toBe('offline');
    // Bea sees 拉麵 and sets NT$1,500 on her phone.
    expect((await w.beaEdits(w.amount(1500), NEW)).status).toBe(200);
    await w.goOnline();
    expect(w.saves.map(s => s.status)).toEqual([200, 200]);
    expect(w.saves[1].body.opId).toBe(w.saves[0].body.opId);
    expect(await w.server(NEW)).toMatchObject({ amount: 1500, description: '拉麵' });
    // No line says Ann changed it back.
    expect(await w.historyBy(NEW)).toEqual(['uA', 'uB']);
    expect(w.st().outbox).toEqual([]);
  });

  it('an edit whose answer was lost, then Bea sets NT$1,000 back: the retry keeps it', async () => {
    const w = await world();
    w.net.loseNextSaveAnswer = true;
    w.saveFrom(w.opened(), w.amount(2000));
    await settle(300);
    expect((await w.server()).amount).toBe(2000);
    // Bea saw NT$2,000 and puts NT$1,000 back: the amount Ann's form opened with.
    expect((await w.beaEdits(w.amount(1000))).status).toBe(200);
    await w.goOnline();
    expect(w.saves.map(s => s.status)).toEqual([200, 200]);
    expect(await w.server()).toMatchObject({ amount: 1000 });
    expect(await w.historyBy()).toEqual(['uA', 'uA', 'uB']);
    expect(w.st().outbox).toEqual([]);
  });
});

describe('store actions for the group settings and the import (review B6a-12, B6b-04, B6b-02)', () => {
  it('two settings saved at once that answer out of order: the older answer, coming last, does not roll the view back', async () => {
    const w = await world();
    const inner = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>(r => (release = r));
    let first = true;
    vi.stubGlobal('fetch', (async (url: string, init: RequestInit = {}) => {
      // The Worker writes the rename at once; its answer comes late.
      const res = await inner(url, init);
      if (init.method === 'PATCH' && first) {
        first = false;
        await held;
      }
      return res;
    }) as typeof fetch);
    const rename = w.store.actions.updateGroup(w.gid, { name: 'trip 2026' });
    await settle();
    const color = await w.store.actions.updateGroup(w.gid, { color: '#C2410C' });
    release();
    const renamed = await rename;
    expect(renamed.group.version).toBeLessThan(color.group.version);
    const shown = w.st().groups[w.gid]!.snap!.group;
    expect(shown).toMatchObject({ name: 'trip 2026', color: '#C2410C', version: color.group.version });
  });

  it('importExpenses: the reasons by place in the list, and the group loaded only when asked', async () => {
    const w = await world();
    const entry = (id: string) => ({
      id, kind: 'expense' as const, description: 'x', category: 'general', amount: 100, currency: 'TWD', fxRate: 1, date: '2026-11-01',
      payers: [{ memberId: w.A, amount: 100 }], split: { method: 'equal' as const, entries: [{ memberId: w.A }] },
    });
    // 201 entries go in two requests of 200 and 1; the last one has an id the Worker refuses.
    const list = [...Array.from({ length: 200 }, (_, i) => entry(`imp-${String(i).padStart(4, '0')}`)), entry('bad')];
    const before = w.sent.length;
    const r = await w.store.actions.importExpenses(w.gid, list, { reload: false });
    expect(r.imported).toBe(200);
    expect(r.skipped).toEqual([{ index: 200, code: 'invalid_id', field: 'id' }]);
    const calls = w.sent.slice(before);
    expect(calls.filter(s => s.startsWith('POST ') && s.endsWith('/import'))).toHaveLength(2);
    expect(calls.filter(s => s === `GET /api/groups/${w.gid}`)).toEqual([]);
    // Sent again with the reload (the default): entries the group has are exists, and the group loads once.
    const again = await w.store.actions.importExpenses(w.gid, list.slice(0, 1));
    expect(again).toEqual({ imported: 0, skipped: [{ index: 0, code: 'exists', field: 'id' }] });
    await settle();
    expect(w.sent.filter(s => s === `GET /api/groups/${w.gid}`).length).toBeGreaterThan(0);
  });
});

describe('a new entry the group has no room for (review W7-contract-05)', () => {
  it('同步失敗 says which limit, from the details kept with the failed item (never the whole details)', async () => {
    const w = await world();
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (async (url: string, init: RequestInit = {}) => {
      if (init.method === 'PUT' && /\/expenses\/[^/]+$/.test(new URL(url).pathname)) {
        const body = { error: { code: 'limit_reached', message: 'A group can hold up to 5000 entries', details: { limit: 'entries', max: 5000, extra: { big: 'x' } } } };
        return new Response(JSON.stringify(body), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      return inner(url, init);
    }) as typeof fetch);
    const NEW = '0b9e0b9e-0000-4000-8000-0000000000dd';
    const body = { ...bodyOfExpense(w.opened()), description: '拉麵' };
    delete body.baseVersion;
    w.store.actions.saveExpense(w.gid, NEW, body);
    await settle(300);
    await w.store.flush();
    await settle(300);
    expect(w.st().outbox[0]?.error).toEqual({ code: 'limit_reached', message: 'A group can hold up to 5000 entries', details: { limit: 'entries', max: 5000 } });
    expect(w.view().pending[NEW]).toMatchObject({ state: 'failed', error: { code: 'limit_reached', message: 'A group can hold at most 5,000 entries.' } });
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
