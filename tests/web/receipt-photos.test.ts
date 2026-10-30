// Receipt photos on the device, up to three per expense (docs/SPEC.md sections 8.4 and 8.7): the
// image prep in lib/photo.ts (the size it is drawn at, the encodings tried until one fits 600,000
// bytes, data URL helpers, the version), the outbox rules for photo changes (lib/outbox.ts: the
// 'photo' op stored so that builds from before several photos skip it, its part per version, what
// cancels what, the cached snapshot after it went up, the photos an entry shows), photosOf, and the
// real store sending them: photos of a new entry wait in the outbox and go up after the entry's
// save, in order, as raw images to PUT .../receipts/<version>; a removal goes as DELETE; refusals
// fail for good or wait; a 401 files them under the account and a sign-in brings them back; and the
// legacy 'receipt' items an older build queued still go to the legacy routes. The browser around
// the store is a set of fakes (bearer mode, no IndexedDB, so idb.ts keeps its records in
// localStorage); the Worker is a fake fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { photosOf, RECEIPT_PHOTOS_MAX } from '../../src/shared/receipts';
import type { ExpenseDTO, GroupSnapshotDTO, MeDTO, ReceiptDTO, UpsertExpenseReq } from '../../src/shared/types';
import {
  fromStored, isOutboxItem, legacyPhotos, movesBalances, partOf, patchAfterSend, photoChangePlan, replaceableReceipts, retryDelay, staleFailures,
  summarizeItem, supersededIds, toStored, visiblePhotos, withReceipts, type OutboxItem, type PendingPhotos,
} from '../../src/web/lib/outbox';
import { dataUrlBytes, dataUrlToBytes, encodeWithin, fitSize, photoVersion, RECEIPT_PHOTO } from '../../src/web/lib/photo';

/** The 4 x 4 JPEG and 2 x 2 PNG of tests/worker/receipt-photos.test.ts (the shared test vectors). */
const JPEG_B64 =
  '/9j/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC8AGLE/9k=';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPQz9/6H4QZYAwATi4JSZ2rmMEAAAAASUVORK5CYII=';

// ---------- image prep ----------

/** A JPEG data URL holding `n` bytes (base64 of `fill` after a JPEG start). */
function jpegUrl(n: number, fill = 0): string {
  const b = Buffer.alloc(n, fill);
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

  it('photoVersion is the Worker\'s version: the first 16 hex characters of the SHA-256 of the bytes', async () => {
    expect(Buffer.from(JPEG_B64, 'base64').length).toBe(269);
    expect(await photoVersion('data:image/jpeg;base64,' + JPEG_B64)).toBe('938a494efb687c77');
    expect(await photoVersion('data:image/png;base64,' + PNG_B64)).toBe('6acadc78bbbfc36f');
    expect(await photoVersion('data:image/jpeg;base64,')).toBe('');
    expect(await photoVersion('nothing')).toBe('');
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
const add = (id: string, version: string, at: number, o: Partial<OutboxItem> = {}) =>
  item(id, 'photo', at, { body: { add: { version, image: jpegUrl(10), width: 3, height: 4 } }, ...o });
const drop = (id: string, version: string, at: number, o: Partial<OutboxItem> = {}) => item(id, 'photo', at, { body: { drop: version }, ...o });
const failed = { code: 'server_error', message: 'x' };

/** isOutboxItem as builds from before several photos have it (src/web/lib/outbox.ts at 6164f11). */
function oldIsOutboxItem(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<OutboxItem>;
  return typeof o.id === 'string' && typeof o.op === 'string' && typeof o.groupId === 'string' && typeof o.expenseId === 'string' && typeof o.createdAt === 'number';
}

const r = (version: string, width = 3, height = 4): ReceiptDTO => ({ version, mime: 'image/jpeg', width, height, bytes: 9 });

describe('the outbox and photo changes', () => {
  it('a photo change is stored with entryId and no expenseId, so builds from before several photos skip it; this build reads both shapes', () => {
    const p = add('p1', 'aaaa', 1, { userId: 'U1' });
    const stored = toStored(p) as unknown as Record<string, unknown>;
    expect(stored.entryId).toBe('e1');
    expect('expenseId' in stored).toBe(false);
    expect(oldIsOutboxItem(stored)).toBe(false);
    expect(isOutboxItem(stored)).toBe(true);
    expect(fromStored(stored as never)).toEqual(p);
    // Every other op is stored as it is: old builds go on reading it.
    for (const op of ['upsert', 'delete', 'restore', 'comment', 'receipt'] as const) {
      const it = item('x', op, 2);
      expect(toStored(it)).toBe(it);
      expect(oldIsOutboxItem(toStored(it))).toBe(true);
      expect(fromStored(toStored(it))).toBe(it);
    }
    // In memory a photo item has expenseId like any other.
    expect(isOutboxItem(p)).toBe(true);
    expect(isOutboxItem({ ...stored, entryId: 5 })).toBe(false);
    expect(isOutboxItem({ ...stored, op: 'upsert' })).toBe(false);
  });

  it('partOf works per photo version, so a failed upload of one photo is never hidden by a change to another', () => {
    expect([partOf(item('u', 'upsert', 1)), partOf(item('d', 'delete', 1)), partOf(item('r', 'restore', 1)), partOf(item('c', 'comment', 1))]).toEqual(['entry', 'entry', 'entry', null]);
    expect(partOf(item('l', 'receipt', 1, { body: { remove: true } }))).toBe('receipt');
    expect([partOf(add('a', 'v1', 1)), partOf(drop('b', 'v1', 1)), partOf(add('c', 'v2', 1))]).toEqual(['photo:v1', 'photo:v1', 'photo:v2']);
    const items = [add('p1', 'v1', 1, { error: failed }), add('p2', 'v2', 2)];
    expect([...supersededIds(items)]).toEqual([]);
    expect(staleFailures(items, items[1])).toEqual([]);
    // A later change of the same photo makes the failed one moot.
    const later = [...items, drop('p3', 'v1', 3)];
    expect([...supersededIds(later)]).toEqual(['p1']);
    expect(staleFailures(later, later[2])).toEqual(['p1']);
  });

  it('legacy photo changes keep their rules: their own part, and a newer one replaces those not sent yet', () => {
    const items = [
      item('r1', 'receipt', 1, { error: failed, body: { remove: true } }),
      item('u1', 'upsert', 2, { error: failed }),
      item('u2', 'upsert', 3),
    ];
    expect([...supersededIds(items)]).toEqual(['u1']);
    const more = [...items, item('r2', 'receipt', 4, { body: { remove: true } })];
    expect([...supersededIds(more)].sort()).toEqual(['r1', 'u1']);
    expect(staleFailures(more, more[3])).toEqual(['r1']);
    const queued = [item('r1', 'receipt', 1), item('u1', 'upsert', 2), item('r2', 'receipt', 3, { error: failed }), item('x', 'receipt', 4, { expenseId: 'e2' }), add('p1', 'v1', 5)];
    expect(replaceableReceipts(queued, 'g1', 'e1', null)).toEqual(['r1', 'r2']);
    expect(replaceableReceipts(queued, 'g1', 'e1', 'r1')).toEqual(['r2']);
  });

  it('a drop cancels a queued or failed add, an add cancels a queued drop, and an add of a photo queued or stored queues nothing', () => {
    const plan = (items: OutboxItem[], change: Parameters<typeof photoChangePlan>[3], inFlight: string | null = null, stored: string[] = []) =>
      photoChangePlan(items, 'g1', 'e1', change, inFlight, stored);
    // A drop of a photo still queued, or failed: its add goes, and nothing is queued.
    expect(plan([add('p1', 'v1', 1)], { drop: 'v1' })).toEqual({ cancel: ['p1'], queue: false });
    expect(plan([add('p1', 'v1', 1, { error: failed })], { drop: 'v1' })).toEqual({ cancel: ['p1'], queue: false });
    // Its add in flight: the drop goes out after it.
    expect(plan([add('p1', 'v1', 1)], { drop: 'v1' }, 'p1')).toEqual({ cancel: [], queue: true });
    // A stored photo: the drop is queued.
    expect(plan([], { drop: 'v1' }, null, ['v1'])).toEqual({ cancel: [], queue: true });
    // An add of a photo whose drop is queued: the drop goes, and the photo stays.
    const photo = { add: { version: 'v1', image: jpegUrl(10), width: 3, height: 4 } };
    expect(plan([drop('d1', 'v1', 1)], photo, null, ['v1'])).toEqual({ cancel: ['d1'], queue: false });
    // Its drop in flight: the photo is going, so the add puts it back after it.
    expect(plan([drop('d1', 'v1', 1)], photo, 'd1', ['v1'])).toEqual({ cancel: [], queue: true });
    // Already queued, or stored: nothing.
    expect(plan([add('p1', 'v1', 1)], photo)).toEqual({ cancel: [], queue: false });
    expect(plan([], photo, null, ['v1'])).toEqual({ cancel: [], queue: false });
    // Another entry's items count for nothing here.
    expect(plan([add('p1', 'v1', 1, { expenseId: 'e2' })], photo)).toEqual({ cancel: [], queue: true });
    expect(plan([], { add: { version: 'v2', image: jpegUrl(10), width: 3, height: 4 } }, null, ['v1'])).toEqual({ cancel: [], queue: true });
  });

  it('waits for the server\'s retryAfter when it is later than the backoff, and a full store fails for good', () => {
    expect(retryDelay({ code: 'offline', retryable: true }, 2000)).toBe(2000);
    expect(retryDelay({ code: 'receipts_quota', retryable: true, details: { retryAfter: 3600 } }, 2000)).toBe(3_600_000);
    expect(retryDelay({ code: 'rate_limited', retryable: true, details: { retryAfter: 1 } }, 4000)).toBe(4000);
    expect(retryDelay({ code: 'receipts_full', retryable: true }, 2000)).toBeNull();
    expect(retryDelay({ code: 'payload_too_large', retryable: false }, 2000)).toBeNull();
  });

  it('a comment or a photo change moves no balance (the group page does not count them as waiting)', () => {
    expect((['upsert', 'delete', 'restore', 'comment', 'receipt', 'photo'] as const).map(movesBalances)).toEqual([true, true, true, false, false, false]);
  });

  it('describes a photo change for the signed-out note: taking one off, or adding one', () => {
    expect(summarizeItem(drop('d', 'v1', 1)).removesReceipt).toBe(true);
    expect(summarizeItem(add('a', 'v1', 1)).removesReceipt).toBe(false);
    expect(summarizeItem(item('l', 'receipt', 1, { body: { remove: true } })).removesReceipt).toBe(true);
  });
});

// ---------- the cached snapshot after a change went up ----------

function snapWith(version: number, e: Partial<ExpenseDTO>): GroupSnapshotDTO {
  return { group: { id: 'g1', version }, expenses: [{ id: 'e1', receipt: null, ...e }], members: [], me: { memberId: 'm', role: 'admin' }, inviteCode: '' } as unknown as GroupSnapshotDTO;
}

describe('withReceipts and the legacy answer rule', () => {
  it('a photo change, or a legacy one whose answer lists the photos, sets receipts and receipt = receipts[0], unless the snapshot is newer', () => {
    const snap = snapWith(5, { receipt: r('a'), receipts: [r('a')] });
    for (const op of ['photo', 'receipt'] as const) {
      const sent = { op, groupId: 'g1', expenseId: 'e1' };
      const now = patchAfterSend(snap, sent, { receipt: r('a'), receipts: [r('a'), r('b')], groupVersion: 6 }).expenses[0];
      expect([now.receipt, now.receipts]).toEqual([r('a'), [r('a'), r('b')]]);
      const none = patchAfterSend(snap, sent, { receipt: null, receipts: [], groupVersion: 6 }).expenses[0];
      expect([none.receipt, none.receipts]).toEqual([null, []]);
      expect(patchAfterSend(snap, sent, { receipt: null, receipts: [], groupVersion: 5 })).toBe(snap);
    }
    expect(withReceipts(snap, 'nobody', [r('z')], 9)).toBe(snap);
    // A drop the server answered 404 (done): nothing to apply.
    expect(patchAfterSend(snap, { op: 'photo', groupId: 'g1', expenseId: 'e1' }, null)).toBe(snap);
  });

  it('a legacy answer without receipts (an old tab\'s sent message) means what the legacy routes mean now', () => {
    const snap = snapWith(5, { receipt: r('a'), receipts: [r('a'), r('b'), r('c')] });
    const sent = { op: 'receipt' as const, groupId: 'g1', expenseId: 'e1' };
    // A new first photo replaces the first one; photos 2 and 3 stay.
    expect(patchAfterSend(snap, sent, { receipt: r('n'), groupVersion: 6 }).expenses[0].receipts).toEqual([r('n'), r('b'), r('c')]);
    // Bytes that were photo 2: it moves up, and the old first goes.
    expect(patchAfterSend(snap, sent, { receipt: r('b'), groupVersion: 6 }).expenses[0].receipts).toEqual([r('b'), r('c')]);
    // A removal takes the first one off; the next one is first.
    const removed = patchAfterSend(snap, sent, { receipt: null, groupVersion: 6 }).expenses[0];
    expect([removed.receipt, removed.receipts]).toEqual([r('b'), [r('b'), r('c')]]);
    expect(legacyPhotos({ receipt: null }, r('x'))).toEqual([r('x')]);
  });
});

describe('photosOf', () => {
  it('reads receipts when they are there, and receipt alone for a server or a copy from before several photos', () => {
    expect(photosOf({ receipt: null })).toEqual([]);
    expect(photosOf({ receipt: r('a') })).toEqual([r('a')]);
    expect(photosOf({ receipt: r('a'), receipts: [r('a'), r('b')] })).toEqual([r('a'), r('b')]);
    expect(photosOf({ receipt: null, receipts: [] })).toEqual([]);
    // Not an array: the first photo alone. An element that is not a ReceiptDTO: dropped.
    expect(photosOf({ receipt: r('a'), receipts: 'x' as never })).toEqual([r('a')]);
    expect(photosOf({ receipt: r('a'), receipts: [r('a'), { version: 'b' }, null, r('c')] as never })).toEqual([r('a'), r('c')]);
    // At most three.
    expect(photosOf({ receipt: r('a'), receipts: [r('a'), r('b'), r('c'), r('d')] })).toHaveLength(RECEIPT_PHOTOS_MAX);
  });

  it('a copy an old tab patched (receipt no longer receipts[0]) gets the legacy meaning, both ways', () => {
    // An old tab's PUT: its new first photo, then photos 2 and 3 (without its version).
    expect(photosOf({ receipt: r('n'), receipts: [r('a'), r('b'), r('c')] })).toEqual([r('n'), r('b'), r('c')]);
    expect(photosOf({ receipt: r('c'), receipts: [r('a'), r('b'), r('c')] })).toEqual([r('c'), r('b')]);
    // An old tab's DELETE: the first one is gone.
    expect(photosOf({ receipt: null, receipts: [r('a'), r('b'), r('c')] })).toEqual([r('b'), r('c')]);
  });
});

describe('visiblePhotos', () => {
  const e = { receipt: r('a'), receipts: [r('a'), r('b')] };
  const pending = (o: Partial<PendingPhotos>): PendingPhotos => ({ adds: [], drops: [], ...o });
  const queued = (version: string, state: 'sending' | 'waiting' | 'failed' = 'sending') => ({ itemId: 'i-' + version, version, image: jpegUrl(10), width: 3, height: 4, state, code: state === 'failed' ? 'limit_reached' : null });

  it('the stored photos, then the queued adds in order; a queued drop hides its photo at once; at most three', () => {
    expect(visiblePhotos(e).map(p => [p.version, !!p.stored, !!p.queued])).toEqual([['a', true, false], ['b', true, false]]);
    const v = visiblePhotos(e, pending({ drops: ['a'], adds: [queued('c'), queued('d', 'failed')] }));
    expect(v.map(p => p.version)).toEqual(['b', 'c', 'd']);
    expect(v[1].queued).toMatchObject({ itemId: 'i-c', state: 'sending' });
    expect(v[2].queued).toMatchObject({ state: 'failed', code: 'limit_reached' });
    expect(visiblePhotos(e, pending({ adds: [queued('c'), queued('d')] })).map(p => p.version)).toEqual(['a', 'b', 'c']);
    // An add of a version already there shows once.
    expect(visiblePhotos(e, pending({ adds: [queued('b')] })).map(p => p.version)).toEqual(['a', 'b']);
  });

  it('a leftover legacy item replaces or takes off the first photo, as the legacy routes do', () => {
    const replace = visiblePhotos(e, undefined, { itemId: 'L1', photo: { image: jpegUrl(10), width: 5, height: 6 }, failed: false, code: 'offline' });
    expect(replace.map(p => p.version)).toEqual(['legacy:L1', 'b']);
    expect(replace[0].queued).toMatchObject({ itemId: 'L1', legacy: true, state: 'waiting' });
    expect(visiblePhotos(e, undefined, { itemId: 'L2', photo: null, failed: false, code: null }).map(p => p.version)).toEqual(['b']);
    expect(visiblePhotos({ receipt: null }, pending({ adds: [queued('c')] }), { itemId: 'L3', photo: null, failed: false, code: null }).map(p => p.version)).toEqual(['c']);
  });
});

// ---------- the store sending photo changes ----------

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
const PHOTOS_PATH = /^\/api\/groups\/g1\/expenses\/e1\/receipts\/([0-9a-f]{16})$/;

function meOf(): MeDTO {
  return {
    user: { id: ME, name: 'Gino', email: null, emailVerified: false, hasPassword: false, googleLinked: false, appleLinked: false, locale: 'en', currency: 'JPY', color: '#000000', payInfo: '', venmo: '', paypal: '', isAdmin: false, createdAt: '', avatar: null },
    groups: [], friends: [], totals: [], unread: 0, serverTime: new Date().toISOString(),
  };
}

function snapOf(version: number, expenses: ExpenseDTO[] = []): GroupSnapshotDTO {
  return {
    group: { id: 'g1', name: 'Trip', type: 'trip', currency: 'JPY', emoji: '', color: '#000000', simplify: true, notes: '', createdBy: ME, createdAt: '', updatedAt: '', version, defaultSplit: null },
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

/** e1 with these photos (a fixture with only `receipt` still compiles: `receipts` is optional). */
function expenseOf(eid: string, photos: ReceiptDTO[] = []): ExpenseDTO {
  return {
    ...BODY, id: eid, groupId: 'g1', notes: '', shares: [{ memberId: MEMBER, amount: 1200 }], repeat: 'none', repeatSeries: null, repeatStart: null,
    createdBy: ME, createdAt: '2026-10-25T00:00:00Z', updatedBy: ME, updatedAt: '2026-10-25T00:00:00Z', deletedAt: null, deletedBy: null, version: 1, commentCount: 0, refundOf: null,
    receipt: photos[0] ?? null, receipts: photos,
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
  /** The photos the fake Worker holds for e1, first to last. */
  photos: ReceiptDTO[];
  /** Answers a photo request differently (undefined: as the Worker does). */
  photoAnswer: ((s: Sent) => Response | undefined) | null;
  /** Answers any request differently first. */
  override: ((s: Sent) => Response | undefined) | null;
  win: Map<string, ((e: unknown) => void)[]>;
}

function newBrowser(photos: ReceiptDTO[] = []): Browser {
  const ls = new MemoryStorage();
  ls.setItem('evenly.api', API);
  ls.setItem('evenly.token', TOKEN);
  ls.setItem('evenly.kv.me', JSON.stringify(meOf()));
  ls.setItem('evenly.kv.group:g1', JSON.stringify({ snap: snapOf(1, photos.length ? [expenseOf('e1', photos)] : []), etag: '"1"' }));
  return { ls, offline: false, sent: [], version: 1, photos: [...photos], photoAnswer: null, override: null, win: new Map() };
}

/** The Worker's photo routes, as far as these tests need them (routes/receiptPhotos.ts). */
function answer(b: Browser, s: Sent): Response {
  const special = b.override?.(s);
  if (special) return special;
  const p = s.url.pathname;
  const list = () => ({ receipt: b.photos[0] ?? null, receipts: [...b.photos], groupVersion: b.version });
  if (s.method === 'POST' && p === '/api/auth/link') return json(200, { token: TOKEN, user: meOf().user });
  if (s.method === 'GET' && p === '/api/me') return json(200, meOf());
  if (s.method === 'GET' && p === '/api/groups/g1') return json(200, snapOf(b.version, [expenseOf('e1', b.photos)]));
  if (s.method === 'PUT' && p === '/api/groups/g1/expenses/e1') {
    b.version++;
    return json(200, { expense: expenseOf('e1', b.photos), groupVersion: b.version });
  }
  const m = PHOTOS_PATH.exec(p);
  if (m && (s.method === 'PUT' || s.method === 'DELETE')) {
    const special2 = b.photoAnswer?.(s);
    if (special2) return special2;
    const v = m[1];
    if (s.method === 'PUT' && !b.photos.some(x => x.version === v)) {
      if (b.photos.length >= 3) {
        return json(409, { error: { code: 'limit_reached', message: 'An expense keeps up to 3 receipt photos', details: { limit: 'receipt_photos', max: 3, receipts: b.photos } } });
      }
      const bytes = s.body as Uint8Array;
      b.photos.push({ version: v, mime: s.headers['Content-Type'], width: Number(s.url.searchParams.get('w')), height: Number(s.url.searchParams.get('h')), bytes: bytes.length });
      b.version++;
    } else if (s.method === 'DELETE' && b.photos.some(x => x.version === v)) {
      b.photos = b.photos.filter(x => x.version !== v);
      b.version++;
    }
    return json(200, list());
  }
  // The legacy routes now: PUT makes these bytes the first photo, DELETE takes the first one off.
  if (s.method === 'PUT' && p === '/api/groups/g1/expenses/e1/receipt') {
    const bytes = s.body as Uint8Array;
    const first: ReceiptDTO = { version: 'legacy' + String(bytes.length).padStart(10, '0'), mime: s.headers['Content-Type'], width: Number(s.url.searchParams.get('w')), height: Number(s.url.searchParams.get('h')), bytes: bytes.length };
    b.photos = [first, ...b.photos.slice(1).filter(x => x.version !== first.version)];
    b.version++;
    return json(200, { receipt: first, groupVersion: b.version, receipts: [...b.photos] });
  }
  if (s.method === 'DELETE' && p === '/api/groups/g1/expenses/e1/receipt') {
    if (b.photos.length) {
      b.photos = b.photos.slice(1);
      b.version++;
    }
    return json(200, { groupVersion: b.version, receipt: b.photos[0] ?? null, receipts: [...b.photos] });
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

const writes = (b: Browser) => b.sent.filter(s => s.method !== 'GET').map(s => `${s.method} ${s.url.pathname}`);

/** A photo the editor would add: a JPEG of `n` bytes with its real version. */
async function photo(n: number, fill = 1, width = 1200, height = 1600): Promise<{ version: string; image: string; width: number; height: number }> {
  const image = jpegUrl(n, fill);
  return { version: await photoVersion(image), image, width, height };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the store sends receipt photo changes through the outbox', () => {
  it('offline, a new entry and its three photos wait in order (photos stored with entryId); back online the save goes first, then each raw image to PUT .../receipts/<version>', async () => {
    const b = newBrowser();
    const store = await open(b);
    expect(store.getState().token).toBe(TOKEN);
    const ps = [await photo(500, 1), await photo(600, 2, 900, 1600), await photo(700, 3)];
    b.offline = true;
    store.actions.saveExpense('g1', 'e1', BODY);
    for (const p of ps) store.actions.addReceiptPhoto('g1', 'e1', p);
    await settle();
    await tick(300);
    expect(writes(b)).toEqual([]);
    const recs = stored(b);
    expect(recs.map(i => i.op)).toEqual(['upsert', 'photo', 'photo', 'photo']);
    expect(recs[0].expenseId).toBe('e1');
    for (const rec of recs.slice(1)) {
      expect([rec.entryId, 'expenseId' in rec, oldIsOutboxItem(rec)]).toEqual(['e1', false, false]);
    }
    // The view shows them from the outbox meanwhile, and the entry as waiting.
    const view = store.applyOutbox(store.getState().groups.g1.snap, store.getState().outbox, ME);
    expect(view.pendingPhotos.e1.adds.map(a => [a.version, a.state])).toEqual(ps.map(p => [p.version, 'sending']));
    expect(view.pending.e1.state).toBe('pending');

    await online(b);
    expect(writes(b)).toEqual(['PUT /api/groups/g1/expenses/e1', ...ps.map(p => `PUT /api/groups/g1/expenses/e1/receipts/${p.version}`)]);
    const ups = b.sent.filter(s => PHOTOS_PATH.test(s.url.pathname));
    expect(ups.map(s => [s.headers['Content-Type'], s.url.searchParams.get('w'), s.url.searchParams.get('h'), (s.body as Uint8Array).length])).toEqual([
      ['image/jpeg', '1200', '1600', 500], ['image/jpeg', '900', '1600', 600], ['image/jpeg', '1200', '1600', 700],
    ]);
    // The image itself, not JSON and not base64.
    expect(ups[0].body).toBeInstanceOf(Uint8Array);
    expect([...(ups[0].body as Uint8Array).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(stored(b)).toEqual([]);
    const e = store.getState().groups.g1.snap!.expenses.find(x => x.id === 'e1')!;
    expect(e.receipts!.map(x => x.version)).toEqual(ps.map(p => p.version));
    expect(e.receipt?.version).toBe(ps[0].version);
  });

  it('the same photo twice is queued once, a removal of one still queued takes it out instead, and an add of one whose removal is queued keeps it', async () => {
    const kept = await photo(400, 9);
    const b = newBrowser([{ version: kept.version, mime: 'image/jpeg', width: 1200, height: 1600, bytes: 400 }]);
    const store = await open(b);
    const p = await photo(500, 4);
    b.offline = true;
    store.actions.saveExpense('g1', 'e1', BODY);
    store.actions.addReceiptPhoto('g1', 'e1', p);
    store.actions.addReceiptPhoto('g1', 'e1', p);
    await settle();
    expect(stored(b).map(i => i.op)).toEqual(['upsert', 'photo']);
    store.actions.removeReceiptPhoto('g1', 'e1', p.version);
    await settle();
    expect(stored(b).map(i => i.op)).toEqual(['upsert']);
    // The stored photo: a removal is queued, an add of it then takes the removal out, and a
    // second add of it queues nothing (it is stored).
    store.actions.removeReceiptPhoto('g1', 'e1', kept.version);
    await settle();
    expect(stored(b).map(i => i.body)).toEqual([expect.anything(), { drop: kept.version }]);
    expect(store.applyOutbox(store.getState().groups.g1.snap, store.getState().outbox, ME).pendingPhotos.e1.drops).toEqual([kept.version]);
    store.actions.addReceiptPhoto('g1', 'e1', kept);
    store.actions.addReceiptPhoto('g1', 'e1', kept);
    await settle();
    expect(stored(b).map(i => i.op)).toEqual(['upsert']);
    await online(b);
    expect(writes(b)).toEqual(['PUT /api/groups/g1/expenses/e1']);
    expect(b.photos.map(x => x.version)).toEqual([kept.version]);
  });

  it('a removal goes as DELETE .../receipts/<version> and the snapshot follows the answer; a 404 on a removal counts as done', async () => {
    const [p1, p2] = [await photo(300, 5), await photo(310, 6)];
    const b = newBrowser([p1, p2].map(p => ({ version: p.version, mime: 'image/jpeg', width: 1200, height: 1600, bytes: 300 })));
    const store = await open(b);
    store.actions.removeReceiptPhoto('g1', 'e1', p1.version);
    await settle();
    await tick(500);
    expect(writes(b)).toEqual([`DELETE /api/groups/g1/expenses/e1/receipts/${p1.version}`]);
    expect(stored(b)).toEqual([]);
    const e = store.getState().groups.g1.snap!.expenses.find(x => x.id === 'e1')!;
    expect([e.receipt?.version, e.receipts!.map(x => x.version)]).toEqual([p2.version, [p2.version]]);
    b.photoAnswer = s => (s.method === 'DELETE' ? json(404, { error: { code: 'not_found', message: 'Not found' } }) : undefined);
    store.actions.removeReceiptPhoto('g1', 'e1', p2.version);
    await settle();
    await tick(500);
    expect(writes(b).slice(-1)).toEqual([`DELETE /api/groups/g1/expenses/e1/receipts/${p2.version}`]);
    expect(stored(b)).toEqual([]);
  });

  it('an add the server refuses for good (409 limit_reached, 404) fails with 重試 / 放棄 for that photo; a later photo still goes up, and the failure stays', async () => {
    const b = newBrowser();
    const store = await open(b);
    const [p1, p2] = [await photo(300, 7), await photo(320, 8)];
    b.photoAnswer = s => (s.url.pathname.endsWith(p1.version) ? json(409, { error: { code: 'limit_reached', message: 'An expense keeps up to 3 receipt photos', details: { limit: 'receipt_photos', max: 3, receipts: [] } } }) : undefined);
    store.actions.saveExpense('g1', 'e1', BODY);
    store.actions.addReceiptPhoto('g1', 'e1', p1);
    store.actions.addReceiptPhoto('g1', 'e1', p2);
    await settle();
    await tick(500);
    const left = stored(b);
    expect(left.map(i => [i.entryId, (i.error as { code: string } | null)?.code])).toEqual([['e1', 'limit_reached']]);
    let view = store.applyOutbox(store.getState().groups.g1.snap, store.getState().outbox, ME);
    expect(view.pending.e1).toMatchObject({ state: 'failed', op: 'photo' });
    expect(view.pendingPhotos.e1.adds).toEqual([expect.objectContaining({ version: p1.version, state: 'failed', code: 'limit_reached' })]);
    expect(b.photos.map(x => x.version)).toEqual([p2.version]);
    // 404 on an add (the entry is gone) fails for good too.
    b.photoAnswer = () => json(404, { error: { code: 'not_found', message: 'Not found' } });
    store.actions.retry(left[0].id as string);
    await settle();
    await tick(500);
    view = store.applyOutbox(store.getState().groups.g1.snap, store.getState().outbox, ME);
    expect(view.pendingPhotos.e1.adds[0]).toMatchObject({ state: 'failed', code: 'not_found' });
    store.actions.discard(left[0].id as string);
    await settle();
    expect(stored(b)).toEqual([]);
  });

  it('the day\'s uploads used up (503 receipts_quota) waits for its retryAfter, kept in the stored shape; a full store (503 receipts_full) fails for good', async () => {
    const b = newBrowser();
    const store = await open(b);
    const p = await photo(300, 3);
    b.photoAnswer = () => json(503, { error: { code: 'receipts_quota', message: 'used up', details: { retryAfter: 7200 } } });
    store.actions.saveExpense('g1', 'e1', BODY);
    store.actions.addReceiptPhoto('g1', 'e1', p);
    await settle();
    await tick(500);
    const [left] = stored(b);
    // updateItem keeps the record in the stored shape.
    expect([left.op, left.entryId, 'expenseId' in left, left.error]).toEqual(['photo', 'e1', false, null]);
    expect((left.lastError as { code: string }).code).toBe('receipts_quota');
    expect((left.nextTryAt as number) - Date.now()).toBeGreaterThan(7_100_000);
    const view = store.applyOutbox(store.getState().groups.g1.snap, store.getState().outbox, ME);
    expect(view.pendingPhotos.e1.adds[0]).toMatchObject({ state: 'waiting', code: 'receipts_quota' });
    // The 15 s retry loop leaves it alone; after the wait it goes.
    b.photoAnswer = null;
    await tick(60_000);
    expect(b.sent.filter(s => PHOTOS_PATH.test(s.url.pathname))).toHaveLength(1);
    await tick(7_200_000);
    expect(stored(b)).toEqual([]);
    expect(b.photos).toHaveLength(1);

    const q = await photo(330, 2);
    b.photoAnswer = () => json(503, { error: { code: 'receipts_full', message: 'full' } });
    store.actions.addReceiptPhoto('g1', 'e1', q);
    await settle();
    await tick(500);
    expect((stored(b)[0].error as { code: string }).code).toBe('receipts_full');
  });

  it('a 401 files the photo changes under the account in their stored shape; signing in again puts them back and sends them', async () => {
    const b = newBrowser();
    const store = await open(b);
    const p = await photo(300, 11);
    b.offline = true;
    store.actions.saveExpense('g1', 'e1', BODY);
    store.actions.addReceiptPhoto('g1', 'e1', p);
    await settle();
    b.override = s => (s.url.pathname === '/api/auth/link' ? undefined : json(401, { error: { code: 'unauthorized', message: 'Sign in first' } }));
    await online(b);
    expect(store.getState().token).toBeNull();
    expect(stored(b)).toEqual([]);
    const held = JSON.parse(b.ls.getItem('evenly.kv.held:' + ME)!) as { items: Record<string, unknown>[] };
    expect(held.items.map(i => [i.op, i.expenseId ?? null, i.entryId ?? null])).toEqual([['upsert', 'e1', null], ['photo', null, 'e1']]);

    b.override = null;
    b.sent.length = 0;
    await store.actions.linkLogin('ABCD-EFGH');
    await settle();
    await tick(500);
    expect(b.ls.getItem('evenly.kv.held:' + ME)).toBeNull();
    expect(writes(b)).toEqual(['POST /api/auth/link', 'PUT /api/groups/g1/expenses/e1', `PUT /api/groups/g1/expenses/e1/receipts/${p.version}`]);
    expect(stored(b)).toEqual([]);
  });

  it('a photo record at boot is read in either shape, and legacy items an older build queued still go to the legacy routes with their meaning', async () => {
    const [a1, a2] = [await photo(300, 1), await photo(310, 2)];
    const b = newBrowser([a1, a2].map(p => ({ version: p.version, mime: 'image/jpeg', width: 1200, height: 1600, bytes: 300 })));
    const at = Date.now();
    // An old build's 'receipt' item (with expenseId), then this build's 'photo' record (entryId).
    b.ls.setItem('evenly.kv.outbox:L1', JSON.stringify({ id: 'L1', op: 'receipt', groupId: 'g1', expenseId: 'e1', body: { image: jpegUrl(222, 3), width: 10, height: 20 }, createdAt: at, attempts: 0, nextTryAt: 0, error: null, userId: ME }));
    const q = await photo(333, 4);
    b.ls.setItem('evenly.kv.outbox:P1', JSON.stringify(toStored({ id: 'P1', op: 'photo', groupId: 'g1', expenseId: 'e1', body: { add: q }, createdAt: at + 1, attempts: 0, nextTryAt: 0, error: null, userId: ME })));
    const store = await open(b);
    await tick(500);
    expect(writes(b)).toEqual(['PUT /api/groups/g1/expenses/e1/receipt', `PUT /api/groups/g1/expenses/e1/receipts/${q.version}`]);
    const legacy = b.sent.find(s => s.url.pathname.endsWith('/receipt'))!;
    expect([legacy.headers['Content-Type'], legacy.url.searchParams.get('w'), (legacy.body as Uint8Array).length]).toEqual(['image/jpeg', '10', 222]);
    // The legacy PUT replaced the first photo; photo 2 stayed; the new one went after them.
    const e = store.getState().groups.g1.snap!.expenses.find(x => x.id === 'e1')!;
    expect(e.receipts!.map(x => x.version)).toEqual([b.photos[0].version, a2.version, q.version]);
    expect(e.receipt).toEqual(e.receipts![0]);
    // A legacy removal takes the first photo off.
    b.ls.setItem('evenly.kv.outbox:L2', JSON.stringify({ id: 'L2', op: 'receipt', groupId: 'g1', expenseId: 'e1', body: { remove: true }, createdAt: Date.now(), attempts: 0, nextTryAt: 0, error: null, userId: ME }));
    for (const fn of b.win.get('storage') ?? []) fn({ key: 'evenly.bus', newValue: JSON.stringify({ type: 'outbox', nonce: 1 }) });
    await settle();
    // The tab reads it from storage now and sends it with the next round (every 15 s while pending).
    await tick(16_000);
    expect(writes(b).slice(-1)).toEqual(['DELETE /api/groups/g1/expenses/e1/receipt']);
    expect(store.getState().groups.g1.snap!.expenses.find(x => x.id === 'e1')!.receipts!.map(x => x.version)).toEqual([a2.version, q.version]);
  });

  it('a queued save keeps the entry\'s receipts in the view (localExpense)', async () => {
    const b = newBrowser();
    const store = await open(b);
    const photos = [r('1111111111111111'), r('2222222222222222')];
    const snap = snapOf(3, [expenseOf('e1', photos)]);
    const upsert: OutboxItem = { id: 'u1', op: 'upsert', groupId: 'g1', expenseId: 'e1', body: { ...BODY, description: 'Dinner 2' }, createdAt: 1, attempts: 0, nextTryAt: 0, error: null };
    const v = store.applyOutbox(snap, [upsert], ME);
    const e = v.snap!.expenses.find(x => x.id === 'e1')!;
    expect([e.description, e.receipt, e.receipts]).toEqual(['Dinner 2', photos[0], photos]);
  });
});
