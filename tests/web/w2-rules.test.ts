// Review fixes of 2026-11-07 (unit W2), the pure parts: which queued save a newer save of the same
// entry may replace (lib/outbox.ts replaceableSave), the base a save goes with after a save the
// server refused (afterRefusal, laterSave), the hold a refused new entry puts on its photos and
// comments (nextToSend holdsEntry), the words for a 409 conflict and for codes whose message is
// only English (lib/errors.ts), a broken % escape in the address (lib/router.ts parseHash), ids
// where crypto.randomUUID is missing (lib/ids.ts), and apiRaw reading an answer's body under its
// deadline (lib/api.ts).

import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpsertExpenseReq } from '../../src/shared/types';
import { newUuid } from '../../src/web/lib/ids';
import { afterRefusal, laterSave, nextToSend, replaceableSave, type OutboxItem } from '../../src/web/lib/outbox';
import { parseHash } from '../../src/web/lib/router';

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const FIELDS: Omit<UpsertExpenseReq, 'base' | 'baseVersion'> = {
  kind: 'expense', description: '燒肉晚餐', category: 'food.dining', amount: 100000, currency: 'TWD', fxRate: 1, date: '2026-11-01',
  payers: [{ memberId: 'm1', amount: 100000 }], split: { method: 'equal', entries: [{ memberId: 'm1' }, { memberId: 'm2' }] }, rateBase: 'TWD',
};

/** A new entry's save: neither base nor baseVersion. */
const create = (over: Partial<UpsertExpenseReq> = {}): UpsertExpenseReq => ({ ...FIELDS, ...over });
/** An edit as the editor sends it: the form's copy as `base`, its version. */
const edit = (over: Partial<UpsertExpenseReq> = {}, version = 3): UpsertExpenseReq => ({ ...FIELDS, ...over, base: { ...FIELDS }, baseVersion: version });
/** A save that writes the whole entry: the old body with its version and no base (the editor's 復原 sends this today). */
const undo = (): UpsertExpenseReq => ({ ...FIELDS, baseVersion: 4 });

let seq = 0;
function item(op: OutboxItem['op'], over: Partial<OutboxItem> = {}): OutboxItem {
  seq++;
  return {
    id: 'i' + String(seq).padStart(3, '0'), op, groupId: 'g1', expenseId: 'e1', createdAt: 1000 + seq, attempts: 0, nextTryAt: 0, error: null, lastError: null,
    ...over,
  };
}

describe('replaceableSave: what a newer save of the entry may replace', () => {
  it('an edit never replaces a queued edit or whole-entry save (the form showed it; it goes after it), only a queued new entry', () => {
    const queuedEdit = item('upsert', { body: edit({ amount: 200000 }) });
    expect(replaceableSave([queuedEdit], 'g1', 'e1', null, edit({ date: '2026-11-02' }))).toBeNull();
    const queuedUndo = item('upsert', { body: undo() });
    expect(replaceableSave([queuedUndo], 'g1', 'e1', null, edit())).toBeNull();
    const queuedNew = item('upsert', { body: create() });
    expect(replaceableSave([queuedNew], 'g1', 'e1', null, edit({ description: '燒肉', }, 1))).toBe(queuedNew);
  });

  it('a save that writes the whole entry (no base) replaces any, as does a call without the newer body (as before)', () => {
    const queuedEdit = item('upsert', { body: edit({ amount: 200000 }) });
    expect(replaceableSave([queuedEdit], 'g1', 'e1', null, undo())).toBe(queuedEdit);
    expect(replaceableSave([queuedEdit], 'g1', 'e1', null)).toBe(queuedEdit);
  });

  it('still never a failed save, the one this tab is sending, or one a later item of the entry follows', () => {
    const failed = item('upsert', { body: create(), error: { code: 'validation', message: 'x' } });
    expect(replaceableSave([failed], 'g1', 'e1', null, undo())).toBeNull();
    const sending = item('upsert', { body: create() });
    expect(replaceableSave([sending], 'g1', 'e1', sending.id, undo())).toBeNull();
    const save = item('upsert', { body: create() });
    const comment = item('comment', { body: { id: 'c1', body: 'hi' } });
    expect(replaceableSave([save, comment], 'g1', 'e1', null, undo())).toBeNull();
    // Another entry's items do not count.
    const other = item('comment', { expenseId: 'e2', body: { id: 'c2', body: 'hi' } });
    expect(replaceableSave([save, other], 'g1', 'e1', null, undo())).toBe(save);
  });
});

describe('afterRefusal: a save made from a form that showed a refused save', () => {
  it('goes with the refused save\'s base and baseVersion, and keeps its own parts', () => {
    const refused = edit({ amount: 200000 }, 2);
    const next: UpsertExpenseReq = { ...edit({ amount: 200000, date: '2026-11-02' }, 3), base: { ...FIELDS, amount: 200000 } };
    const out = afterRefusal(next, refused);
    expect(out.base).toEqual(refused.base);
    expect(out.baseVersion).toBe(2);
    expect(out).toMatchObject({ amount: 200000, date: '2026-11-02', rateBase: 'TWD' });
  });

  it('marks the base with the group currency its rate was chosen against when the base itself does not say', () => {
    const { rateBase: _r, ...bare } = FIELDS;
    const refused: UpsertExpenseReq = { ...bare, amount: 300, currency: 'JPY', fxRate: 0.21, rateBase: 'TWD', base: { ...bare }, baseVersion: 5 };
    const next: UpsertExpenseReq = { ...bare, rateBase: 'USD', base: { ...bare }, baseVersion: 6 };
    expect(afterRefusal(next, refused).base).toEqual({ ...bare, rateBase: 'TWD' });
    // A base that says its own currency keeps it (a chain across a currency change).
    const said: UpsertExpenseReq = { ...refused, base: { ...bare, rateBase: 'JPY' } };
    expect(afterRefusal(next, said).base).toEqual({ ...bare, rateBase: 'JPY' });
  });

  it('leaves a whole-entry save, a new entry, and a save after a refused one without a base as they are', () => {
    const refused = edit({ amount: 200000 }, 2);
    const u = undo();
    expect(afterRefusal(u, refused)).toBe(u);
    const c = create();
    expect(afterRefusal(c, refused)).toBe(c);
    const e = edit();
    expect(afterRefusal(e, create())).toBe(e);
    expect(afterRefusal(e, undefined)).toBe(e);
    // A refused save with a base and no baseVersion: the new save keeps no version either.
    const { baseVersion: _v, ...noVersion } = refused;
    expect('baseVersion' in afterRefusal(e, noVersion)).toBe(false);
  });

  it('laterSave finds the entry\'s first save after the refused one, skipping other items and entries', () => {
    const refused = item('upsert', { body: edit() });
    const photo = item('photo', { body: { drop: 'abcdabcdabcdabcd' } });
    const otherEntry = item('upsert', { expenseId: 'e2', body: edit() });
    const next = item('upsert', { body: edit() });
    const after = item('upsert', { body: edit() });
    expect(laterSave([after, next, otherEntry, photo, refused], refused)).toBe(next);
    expect(laterSave([refused, photo], refused)).toBeNull();
  });
});

describe('nextToSend: a refused new entry holds back its photos and comments', () => {
  const failedNew = () => item('upsert', { body: create(), error: { code: 'not_found', message: 'Group not found' } });

  it('its later items wait with it, also in the pass that failed it (canSend skips handled items); other entries go on', () => {
    const save = failedNew();
    const photo = item('photo', { body: { add: { version: 'abcdabcdabcdabcd', image: 'data:image/jpeg;base64,AAAA', width: 1, height: 1 } } });
    const other = item('comment', { expenseId: 'e2', body: { id: 'c2', body: 'hi' } });
    const handled = new Set([save.id]);
    const next = nextToSend([save, photo, other], { now: 5000, canSend: i => !handled.has(i.id), holdsEntry: () => true });
    expect(next).toBe(other);
    expect(nextToSend([save, photo], { now: 5000, holdsEntry: () => true })).toBeNull();
  });

  it('a failed edit of an entry the server has holds nothing back (as documented), nor does any failure without holdsEntry', () => {
    const save = item('upsert', { body: edit(), error: { code: 'conflict', message: 'x' } });
    const comment = item('comment', { body: { id: 'c1', body: 'hi' } });
    expect(nextToSend([save, comment], { now: 5000, holdsEntry: () => false })).toBe(comment);
    const created = failedNew();
    const comment2 = item('comment', { body: { id: 'c3', body: 'hi' } });
    expect(nextToSend([created, comment2], { now: 5000 })).toBe(comment2);
  });

  it('a failed comment or photo never holds its entry', () => {
    const comment = item('comment', { body: { id: 'c1', body: 'hi' }, error: { code: 'not_found', message: 'x' } });
    const save = item('upsert', { body: edit() });
    expect(nextToSend([comment, save], { now: 5000, holdsEntry: () => true })).toBe(save);
  });
});

describe('parseHash: a broken % escape', () => {
  it('stays as typed (the page then says it cannot find it) instead of throwing', () => {
    expect(parseHash('#/join/abc%')).toMatchObject({ name: 'join', params: { code: 'abc%' } });
    expect(parseHash('#/f/u%3')).toMatchObject({ name: 'friend', params: { key: 'u%3' } });
    expect(parseHash('#/g/%E4%B8')).toMatchObject({ name: 'group', params: { gid: '%E4%B8' } });
    expect(parseHash('#/g/g1/e/%zz')).toMatchObject({ name: 'expense', params: { gid: 'g1', eid: '%zz' } });
    // A good escape still reads.
    expect(parseHash('#/g/%E4%B8%AD')).toMatchObject({ name: 'group', params: { gid: '中' } });
  });
});

describe('newUuid', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const ID_RE = /^[A-Za-z0-9-]{8,64}$/; // routes/expenses.ts

  it('uses crypto.randomUUID where there is one', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-2222-4333-8444-555555555555', getRandomValues: () => { throw new Error('not used'); } });
    expect(newUuid()).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('makes a v4 UUID from getRandomValues where randomUUID is missing (Safari 15.0 to 15.3)', () => {
    vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView>(a: T) => webcrypto.getRandomValues(a as unknown as Uint8Array) as unknown as T });
    const a = newUuid();
    const b = newUuid();
    expect(a).toMatch(UUID);
    expect(a).toMatch(ID_RE);
    expect(b).not.toBe(a);
  });
});

/** Load errors.ts and api.ts the way the app does (config.ts reads location and localStorage). */
async function loadApi(locale: 'en' | 'zh-TW') {
  const ls = new MemoryStorage();
  ls.setItem('evenly.api', 'https://api.test');
  ls.setItem('evenly.locale', locale);
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('location', { origin: 'https://split.test', href: 'https://split.test/#/', pathname: '/', search: '', hash: '#/' });
  vi.resetModules();
  const api = await import('../../src/web/lib/api');
  const errors = await import('../../src/web/lib/errors');
  return { ...api, ...errors };
}

describe('errorMessage', () => {
  it('words a 409 conflict, in either language, instead of the Worker\'s English', async () => {
    const zh = await loadApi('zh-TW');
    const conflict = new zh.ApiError(409, 'conflict', 'Someone else changed this entry after you opened it. Discard this change, then edit the entry again.');
    expect(zh.errorMessage(conflict)).toBe('別人剛改過這筆，請先放棄這次的修改，再重新打開來改。');
    const en = await loadApi('en');
    expect(en.errorMessage(new en.ApiError(409, 'conflict', 'x'))).toBe('Someone else changed this after you opened it. Discard this change, then open it again to edit it.');
  });

  it('never shows the English of bad_request or unknown (a queued photo that cannot be read, TypeError: Load failed)', async () => {
    const zh = await loadApi('zh-TW');
    expect(zh.errorMessage(new zh.ApiError(400, 'bad_request', 'The queued photo cannot be read'))).toBe('發生錯誤，請稍後再試。');
    expect(zh.errorMessage(new zh.ApiError(0, 'unknown', 'TypeError: Load failed'))).toBe('發生錯誤，請稍後再試。');
    const en = await loadApi('en');
    expect(en.errorMessage(new en.ApiError(0, 'unknown', 'TypeError: Load failed'))).toBe('Something went wrong. Try again later.');
  });

  it('keeps the message of the client\'s own codes, which is in the current language already', async () => {
    const zh = await loadApi('zh-TW');
    expect(zh.errorMessage(new zh.ApiError(0, 'unsynced', '這個群組還有 2 筆變更沒同步。'))).toBe('這個群組還有 2 筆變更沒同步。');
  });
});

describe('apiRaw reads the answer under its deadline', () => {
  const JSON_HEADERS = { 'Content-Type': 'application/json' };

  it('an answer whose body breaks after the headers is no connection (retried later), not the browser\'s TypeError', async () => {
    const { api } = await loadApi('en');
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start: c => c.error(new TypeError('Load failed')) }), { status: 200, headers: JSON_HEADERS }));
    await expect(api('PUT', '/api/groups/g1/expenses/e1', { a: 1 })).rejects.toMatchObject({ status: 0, code: 'offline' });
  });

  it('a body that stops arriving ends at the deadline', async () => {
    const { api } = await loadApi('en');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit = {}) => {
      const body = new ReadableStream<Uint8Array>({
        start: c => {
          c.enqueue(new TextEncoder().encode('{"a":'));
          init.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200, headers: JSON_HEADERS });
    });
    const call = api('GET', '/api/me');
    const settled = call.then(() => 'ok', e => e);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('pending');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled).toMatchObject({ code: 'offline' });
  });

  it('a large answer that keeps arriving on a slow connection is read whole: each part starts the deadline again', async () => {
    const { api } = await loadApi('en');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const parts = ['{"items":[', '1,', '2,', '3', ']}'];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit = {}) => {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        start: c => {
          init.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
        },
        pull: c => new Promise<void>(resolve => {
          // 15 s between parts: 60 s in all, past one 20 s deadline but within it for each part.
          setTimeout(() => {
            if (i < parts.length) c.enqueue(new TextEncoder().encode(parts[i++]));
            else c.close();
            resolve();
          }, 15_000);
        }),
      });
      return new Response(body, { status: 200, headers: JSON_HEADERS });
    });
    const call = api<{ items: number[] }>('GET', '/api/groups/g1');
    const settled = call.then(v => v, e => e);
    await vi.advanceTimersByTimeAsync(15_000 * (parts.length + 1));
    expect(await settled).toEqual({ items: [1, 2, 3] });
  });
});
