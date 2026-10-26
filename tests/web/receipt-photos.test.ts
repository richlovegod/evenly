// Receipt photos on the device (docs/SPEC.md section 8.7): the image prep in lib/photo.ts (the
// size it is drawn at, the encodings tried until one fits 600,000 bytes, data URL helpers), the
// outbox rules for a photo change (lib/outbox.ts: what makes an earlier one moot, coalescing, the
// wait after a refusal, the cached snapshot after it went up), and the real store sending one: a
// photo attached to a new entry offline waits in the outbox and goes up after the entry's save once
// the connection is back, as the raw image; a day's limit waits for its retryAfter, a full store
// fails for good. The browser around the store is a set of fakes (bearer mode, no IndexedDB, so
// idb.ts keeps its records in localStorage); the Worker is a fake fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseDTO, GroupSnapshotDTO, MeDTO, ReceiptDTO, UpsertExpenseReq } from '../../src/shared/types';
import {
  partOf, patchAfterSend, replaceableReceipts, retryDelay, staleFailures, supersededIds, type OutboxItem,
} from '../../src/web/lib/outbox';
import { dataUrlBytes, dataUrlToBytes, encodeWithin, fitSize, RECEIPT_PHOTO } from '../../src/web/lib/photo';

// ---------- image prep ----------

/** A JPEG data URL holding `n` bytes (base64 of zeros after a JPEG start). */
function jpegUrl(n: number): string {
  const b = Buffer.alloc(n);
  b.set([0xff, 0xd8, 0xff].slice(0, n));
  return 'data:image/jpeg;base64,' + b.toString('base64');
}

describe('fitSize', () => {
  it('brings the longest side down to the limit, keeping the shape, and never makes a photo larger', () => {
    expect(fitSize(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitSize(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitSize(1000, 600, 1600)).toEqual({ width: 1000, height: 600 });
    expect(fitSize(1600, 1600, 1600)).toEqual({ width: 1600, height: 1600 });
    // A long thin receipt keeps at least 1 px on its short side.
    expect(fitSize(20000, 3, 1600)).toEqual({ width: 1600, height: 1 });
  });

  it('the receipt photo is 1600 px at JPEG 0.7, under the Worker\'s 600,000 bytes', () => {
    expect(RECEIPT_PHOTO).toEqual({ maxSide: 1600, quality: 0.7, maxBytes: 600_000 });
  });
});

describe('data URLs', () => {
  it('dataUrlBytes counts the bytes from the base64 length, padding included', () => {
    for (const n of [1, 2, 3, 4, 599_999, 600_000]) expect(dataUrlBytes(jpegUrl(n))).toBe(n);
    expect(dataUrlBytes('not a data url')).toBe(0);
    expect(dataUrlBytes('data:image/jpeg,raw')).toBe(0);
  });

  it('dataUrlToBytes gives the type and the bytes, or null', () => {
    const r = dataUrlToBytes(jpegUrl(10))!;
    expect(r.mime).toBe('image/jpeg');
    expect([...r.bytes.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0]);
    expect(r.bytes.length).toBe(10);
    expect(dataUrlToBytes('data:image/jpeg;base64,!!!')).toBeNull();
    expect(dataUrlToBytes('https://example.test/x.jpg')).toBeNull();
  });
});

describe('encodeWithin', () => {
  it('takes the first encoding that fits: 0.7 at full size when it does', async () => {
    const calls: [number, number, number][] = [];
    const r = await encodeWithin({ width: 1200, height: 1600 }, async (w, h, q) => {
      calls.push([w, h, q]);
      return jpegUrl(300_000);
    });
    expect(calls).toEqual([[1200, 1600, 0.7]]);
    expect(r).toMatchObject({ width: 1200, height: 1600, bytes: 300_000 });
  });

  it('tries 0.55 and 0.4, then 3/4 and 1/2 of the size, until one fits', async () => {
    const calls: [number, number, number][] = [];
    const r = await encodeWithin({ width: 1600, height: 1200 }, async (w, h, q) => {
      calls.push([w, h, q]);
      // Only the half-size photo at 0.55 fits.
      return jpegUrl(w === 800 && q <= 0.55 ? 500_000 : 700_000);
    });
    expect(calls).toEqual([
      [1600, 1200, 0.7], [1600, 1200, 0.55], [1600, 1200, 0.4],
      [1200, 900, 0.7], [1200, 900, 0.55], [1200, 900, 0.4],
      [800, 600, 0.7], [800, 600, 0.55],
    ]);
    expect(r).toMatchObject({ width: 800, height: 600, bytes: 500_000 });
  });

  it('is null when nothing fits, or when the browser gives no JPEG', async () => {
    expect(await encodeWithin({ width: 100, height: 100 }, async () => jpegUrl(700_000))).toBeNull();
    expect(await encodeWithin({ width: 100, height: 100 }, async () => '')).toBeNull();
    expect(await encodeWithin({ width: 100, height: 100 }, async () => 'data:image/png;base64,AAAA')).toBeNull();
  });
});

// ---------- outbox rules ----------

function item(id: string, op: OutboxItem['op'], at: number, o: Partial<OutboxItem> = {}): OutboxItem {
  return { id, op, groupId: 'g1', expenseId: 'e1', createdAt: at, attempts: 0, nextTryAt: 0, error: null, ...o };
}
const failed = { code: 'server_error', message: 'x' };

describe('the outbox and photo changes', () => {
  it('a photo change is its own part of the entry: a later save does not make a failed one moot, a later photo change does', () => {
    expect([partOf('upsert'), partOf('delete'), partOf('restore'), partOf('receipt'), partOf('comment')]).toEqual(['entry', 'entry', 'entry', 'receipt', null]);
    const items = [
      item('r1', 'receipt', 1, { error: failed }),
      item('u1', 'upsert', 2, { error: failed }),
      item('u2', 'upsert', 3),
    ];
    expect([...supersededIds(items)]).toEqual(['u1']);
    expect([...supersededIds([...items, item('r2', 'receipt', 4)])].sort()).toEqual(['r1', 'u1']);
    // A photo change that went through makes earlier failed photo changes of the entry stale, not failed saves.
    expect(staleFailures([...items, item('r2', 'receipt', 4)], item('r2', 'receipt', 4))).toEqual(['r1']);
  });

  it('a new photo change replaces the entry\'s queued ones, except the one being sent', () => {
    const items = [item('r1', 'receipt', 1), item('u1', 'upsert', 2), item('r2', 'receipt', 3, { error: failed }), item('x', 'receipt', 4, { expenseId: 'e2' })];
    expect(replaceableReceipts(items, 'g1', 'e1', null)).toEqual(['r1', 'r2']);
    expect(replaceableReceipts(items, 'g1', 'e1', 'r1')).toEqual(['r2']);
  });

  it('waits for the server\'s retryAfter when it is later than the backoff, and a full store fails for good', () => {
    expect(retryDelay({ code: 'offline', retryable: true }, 2000)).toBe(2000);
    expect(retryDelay({ code: 'receipts_quota', retryable: true, details: { retryAfter: 3600 } }, 2000)).toBe(3_600_000);
    expect(retryDelay({ code: 'rate_limited', retryable: true, details: { retryAfter: 1 } }, 4000)).toBe(4000);
    expect(retryDelay({ code: 'receipts_full', retryable: true }, 2000)).toBeNull();
    expect(retryDelay({ code: 'payload_too_large', retryable: false }, 2000)).toBeNull();
  });

  it('after it went up, the cached snapshot shows the photo (or none), unless it was fetched after', () => {
    const receipt: ReceiptDTO = { version: 'abcd', mime: 'image/jpeg', width: 3, height: 4, bytes: 9 };
    const snap = { group: { id: 'g1', version: 5 }, expenses: [{ id: 'e1', receipt: null }], members: [], me: { memberId: 'm', role: 'admin' }, inviteCode: '' } as unknown as GroupSnapshotDTO;
    const sent = { op: 'receipt' as const, groupId: 'g1', expenseId: 'e1' };
    expect(patchAfterSend(snap, sent, { receipt, groupVersion: 6 }).expenses[0].receipt).toEqual(receipt);
    expect(patchAfterSend(snap, sent, { receipt, groupVersion: 5 })).toBe(snap);
    const withPhoto = { ...snap, expenses: [{ ...snap.expenses[0], receipt }] } as GroupSnapshotDTO;
    expect(patchAfterSend(withPhoto, sent, { receipt: null, groupVersion: 6 }).expenses[0].receipt).toBeNull();
  });
});

// ---------- the store sending a photo ----------

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

interface Sent {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

const API = 'https://api.test';
const TOKEN = 'tok' + 'a'.repeat(40);
const ME = 'U1';
const MEMBER = 'm-U1';

function meOf(): MeDTO {
  return {
    user: { id: ME, name: 'Gino', email: null, emailVerified: false, hasPassword: false, googleLinked: false, locale: 'en', currency: 'JPY', color: '#000000', payInfo: '', venmo: '', paypal: '', isAdmin: false, createdAt: '', avatar: null },
    groups: [], friends: [], totals: [], unread: 0, serverTime: new Date().toISOString(),
  };
}

function snapOf(version: number, expenses: ExpenseDTO[] = []): GroupSnapshotDTO {
  return {
    group: { id: 'g1', name: 'Trip', type: 'trip', currency: 'JPY', emoji: '', color: '#000000', simplify: true, notes: '', createdBy: ME, createdAt: '', updatedAt: '', version },
    members: [{ id: MEMBER, groupId: 'g1', userId: ME, name: 'Gino', color: '#000000', role: 'admin', active: true, sort: 0, createdAt: '', claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null }],
    expenses,
    me: { memberId: MEMBER, role: 'admin' },
    inviteCode: 'X',
  };
}

const BODY: UpsertExpenseReq = {
  kind: 'expense', description: 'Dinner', category: 'food.dining', amount: 1200, currency: 'JPY', fxRate: 1, date: '2026-10-25',
  payers: [{ memberId: MEMBER, amount: 1200 }], split: { method: 'equal', entries: [{ memberId: MEMBER }] },
};

function expenseOf(eid: string, receipt: ReceiptDTO | null = null): ExpenseDTO {
  return {
    ...BODY, id: eid, groupId: 'g1', notes: '', shares: [{ memberId: MEMBER, amount: 1200 }], repeat: 'none', repeatSeries: null, repeatStart: null,
    createdBy: ME, createdAt: '2026-10-25T00:00:00Z', updatedBy: ME, updatedAt: '2026-10-25T00:00:00Z', deletedAt: null, deletedBy: null, version: 1, commentCount: 0, receipt,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Browser {
  ls: MemoryStorage;
  offline: boolean;
  sent: Sent[];
  version: number;
  /** The photo the fake Worker holds for e1. */
  receipt: ReceiptDTO | null;
  /** Answers a receipt upload differently (undefined: stored). */
  receiptAnswer: (() => Response | undefined) | null;
  win: Map<string, ((e: unknown) => void)[]>;
}

function newBrowser(): Browser {
  const ls = new MemoryStorage();
  ls.setItem('evenly.api', API);
  ls.setItem('evenly.token', TOKEN);
  ls.setItem('evenly.kv.me', JSON.stringify(meOf()));
  ls.setItem('evenly.kv.group:g1', JSON.stringify({ snap: snapOf(1), etag: '"1"' }));
  return { ls, offline: false, sent: [], version: 1, receipt: null, receiptAnswer: null, win: new Map() };
}

function answer(b: Browser, s: Sent): Response {
  const p = s.url.pathname;
  if (s.method === 'GET' && p === '/api/me') return json(200, meOf());
  if (s.method === 'GET' && p === '/api/groups/g1') return json(200, snapOf(b.version, [expenseOf('e1', b.receipt)]));
  if (s.method === 'PUT' && p === '/api/groups/g1/expenses/e1') {
    b.version++;
    return json(200, { expense: expenseOf('e1', b.receipt), groupVersion: b.version });
  }
  if (s.method === 'PUT' && p === '/api/groups/g1/expenses/e1/receipt') {
    const special = b.receiptAnswer?.();
    if (special) return special;
    const bytes = s.body as Uint8Array;
    b.receipt = { version: 'v' + bytes.length, mime: s.headers['Content-Type'], width: Number(s.url.searchParams.get('w')), height: Number(s.url.searchParams.get('h')), bytes: bytes.length };
    b.version++;
    return json(200, { receipt: b.receipt, groupVersion: b.version });
  }
  if (s.method === 'DELETE' && p === '/api/groups/g1/expenses/e1/receipt') {
    b.receipt = null;
    b.version++;
    return json(200, { groupVersion: b.version });
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
  vi.stubGlobal('history', { state: null, replaceState: () => undefined, back: () => undefined });
  vi.stubGlobal('window', { addEventListener: on, removeEventListener: () => undefined, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('document', { cookie: '', visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined, documentElement: {} });
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'test', language: 'en-US', languages: ['en-US'], platform: 'test', maxTouchPoints: 0 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (b.offline) throw new TypeError('Failed to fetch');
    const s: Sent = { method: init.method ?? 'GET', url: new URL(url), headers: { ...(init.headers as Record<string, string>) }, body: init.body };
    b.sent.push(s);
    return answer(b, s);
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>(r => setImmediate(r));
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

async function open(b: Browser): Promise<StoreModule> {
  install(b);
  vi.resetModules();
  const store = await import('../../src/web/lib/store');
  await store.boot();
  await settle();
  await tick(300);
  return store;
}

/** The outbox records as stored (idb.ts in localStorage), oldest first. */
function stored(b: Browser): OutboxItem[] {
  return [...b.ls.map.entries()]
    .filter(([k]) => k.startsWith('evenly.kv.outbox:'))
    .map(([, v]) => JSON.parse(v) as OutboxItem)
    .sort((x, y) => x.createdAt - y.createdAt);
}

const writes = (b: Browser) => b.sent.filter(s => s.method !== 'GET').map(s => `${s.method} ${s.url.pathname}`);
const photo = (n: number, width = 1200, height = 1600) => ({ image: jpegUrl(n), width, height, bytes: n });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the store sends a receipt photo through the outbox', () => {
  it('offline, a new entry and its photo wait in the outbox, in that order; back online the save goes first, then the raw image', async () => {
    const b = newBrowser();
    const store = await open(b);
    expect(store.getState().token).toBe(TOKEN);
    b.offline = true;
    store.actions.saveExpense('g1', 'e1', BODY);
    store.actions.attachReceipt('g1', 'e1', photo(5000));
    await settle();
    await tick(300);
    expect(writes(b)).toEqual([]);
    expect(stored(b).map(i => i.op)).toEqual(['upsert', 'receipt']);
    // The view shows the photo from the outbox meanwhile, and the entry as waiting.
    const view = store.applyOutbox(store.getState().groups.g1.snap, store.getState().outbox, ME);
    expect(view.pendingReceipts.e1).toMatchObject({ photo: { width: 1200, height: 1600 }, failed: false });
    expect(view.pending.e1.state).toBe('pending');

    b.offline = false;
    for (const fn of b.win.get('online') ?? []) fn({});
    await settle();
    await tick(500);
    expect(writes(b)).toEqual(['PUT /api/groups/g1/expenses/e1', 'PUT /api/groups/g1/expenses/e1/receipt']);
    const up = b.sent.find(s => s.url.pathname.endsWith('/receipt'))!;
    expect(up.headers['Content-Type']).toBe('image/jpeg');
    expect(up.url.searchParams.get('w')).toBe('1200');
    expect(up.url.searchParams.get('h')).toBe('1600');
    // The image itself, not JSON and not base64.
    expect(up.body).toBeInstanceOf(Uint8Array);
    expect((up.body as Uint8Array).length).toBe(5000);
    expect([...(up.body as Uint8Array).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(stored(b)).toEqual([]);
    expect(store.getState().groups.g1.snap!.expenses.find(e => e.id === 'e1')!.receipt).toMatchObject({ bytes: 5000, width: 1200 });
  });

  it('a newer photo replaces one not sent yet, so only the last goes up; a removal goes as DELETE', async () => {
    const b = newBrowser();
    const store = await open(b);
    b.offline = true;
    store.actions.saveExpense('g1', 'e1', BODY);
    store.actions.attachReceipt('g1', 'e1', photo(100));
    store.actions.attachReceipt('g1', 'e1', photo(200));
    await settle();
    await tick(300);
    expect(stored(b).map(i => i.op)).toEqual(['upsert', 'receipt']);
    b.offline = false;
    for (const fn of b.win.get('online') ?? []) fn({});
    await settle();
    await tick(500);
    const ups = b.sent.filter(s => s.url.pathname.endsWith('/receipt'));
    expect(ups.map(s => (s.body as Uint8Array).length)).toEqual([200]);

    store.actions.removeReceipt('g1', 'e1');
    await settle();
    await tick(500);
    expect(writes(b).slice(-1)).toEqual(['DELETE /api/groups/g1/expenses/e1/receipt']);
    expect(b.receipt).toBeNull();
    expect(stored(b)).toEqual([]);
  });

  it('the day\'s uploads used up (503 receipts_quota): it keeps waiting until the retryAfter, never failed', async () => {
    const b = newBrowser();
    const store = await open(b);
    b.receiptAnswer = () => json(503, { error: { code: 'receipts_quota', message: 'used up', details: { retryAfter: 7200 } } });
    store.actions.saveExpense('g1', 'e1', BODY);
    store.actions.attachReceipt('g1', 'e1', photo(300));
    await settle();
    await tick(500);
    const [left] = stored(b);
    expect(left.op).toBe('receipt');
    expect(left.error).toBeNull();
    expect(left.lastError?.code).toBe('receipts_quota');
    expect(left.nextTryAt - Date.now()).toBeGreaterThan(7_100_000);
    const view = store.applyOutbox(store.getState().groups.g1.snap, store.getState().outbox, ME);
    expect(view.pendingReceipts.e1).toMatchObject({ failed: false, code: 'receipts_quota' });
    // The 15 s retry loop leaves it alone; after the wait it goes.
    b.receiptAnswer = null;
    await tick(60_000);
    expect(b.sent.filter(s => s.url.pathname.endsWith('/receipt'))).toHaveLength(1);
    await tick(7_200_000);
    expect(stored(b)).toEqual([]);
    expect(b.receipt).toMatchObject({ bytes: 300 });
  });

  it('a full store (503 receipts_full) fails for good, with 重試 / 放棄 on the entry', async () => {
    const b = newBrowser();
    const store = await open(b);
    b.receiptAnswer = () => json(503, { error: { code: 'receipts_full', message: 'full' } });
    store.actions.saveExpense('g1', 'e1', BODY);
    store.actions.attachReceipt('g1', 'e1', photo(300));
    await settle();
    await tick(500);
    const [left] = stored(b);
    expect(left.error?.code).toBe('receipts_full');
    const view = store.applyOutbox(store.getState().groups.g1.snap, store.getState().outbox, ME);
    expect(view.pending.e1).toMatchObject({ state: 'failed', op: 'receipt' });
    expect(view.pendingReceipts.e1).toMatchObject({ failed: true, code: 'receipts_full' });
    store.actions.discard(left.id);
    await settle();
    expect(stored(b)).toEqual([]);
  });
});
