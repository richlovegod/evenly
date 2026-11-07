// 總覽's footnote about unsynced changes (src/web/features/home/dashboard.ts dashboardView and
// pendingNotes): changes the server refused for good (同步失敗) are kept apart from the ones still
// waiting. They stay in the numbers, as the group page shows them until 重試 or 放棄, but are
// never called 等待同步; and with changes both counted and not counted yet, the note says both,
// so the totals never look complete while some are missing.

import { afterEach, describe, expect, it, vi } from 'vitest';

// dashboard.ts reaches lib/store.ts and lib/api.ts, which read location and storage when they load.
vi.hoisted(() => {
  const map = new Map<string, string>([['evenly.api', 'same-origin']]);
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage ??= storage;
  g.sessionStorage ??= storage;
  g.location ??= { origin: 'https://split.test', href: 'https://split.test/', pathname: '/', search: '', hash: '' };
});

import type { GroupListItemDTO, GroupSnapshotDTO, MeDTO, MemberDTO, UpsertExpenseReq } from '../../src/shared/types';
import { dashboardView, pendingNotes } from '../../src/web/features/home/dashboard';
import { setLocale } from '../../src/web/lib/i18n';
import type { GroupEntry, OutboxItem } from '../../src/web/lib/store';

const ME = 'u-gino';

function member(gid: string, id: string, name: string, sort: number, userId: string | null): MemberDTO {
  return {
    id, groupId: gid, userId, name, color: '#2F6FB5', role: 'member', active: true, sort, createdAt: '2026-10-01T00:00:00.000Z',
    claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null,
  };
}

/** A two-person group (Gino and Abbie) in TWD, as GET /api/me lists it and as a snapshot. */
function twoPeople(gid: string): { item: GroupListItemDTO; snap: GroupSnapshotDTO } {
  const members = [member(gid, gid + '-gino', 'Gino', 0, ME), member(gid, gid + '-abbie', 'Abbie', 1, null)];
  const item: GroupListItemDTO = {
    id: gid, name: gid, type: 'home', currency: 'TWD', emoji: '', color: '#2F6FB5', version: 3, updatedAt: '2026-11-01T00:00:00.000Z',
    myMemberId: gid + '-gino', myNet: 0, myTransfers: [], spent: 0, count: 0, lastDate: null, archived: false,
    members: members.map(m => ({ id: m.id, name: m.name, color: m.color, userId: m.userId, active: true, avatar: null })),
  };
  const snap: GroupSnapshotDTO = {
    group: {
      id: gid, name: gid, type: 'home', currency: 'TWD', emoji: '', color: '#2F6FB5', simplify: true, notes: '', createdBy: ME,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', version: 3, defaultSplit: null,
    },
    members,
    expenses: [],
    me: { memberId: gid + '-gino', role: 'admin' },
    inviteCode: 'x'.repeat(16),
  };
  return { item, snap };
}

/** Gino paid `amount` (minor units), split equally with Abbie. */
function save(gid: string, eid: string, amount: number, o: Partial<OutboxItem> = {}): OutboxItem {
  const body: UpsertExpenseReq = {
    kind: 'expense', description: '晚餐', category: 'food.dining', amount, currency: 'TWD', fxRate: 1, date: '2026-11-05', notes: '',
    payers: [{ memberId: gid + '-gino', amount }],
    split: { method: 'equal', entries: [{ memberId: gid + '-gino' }, { memberId: gid + '-abbie' }] },
  };
  return { id: 'o-' + eid + '-' + (o.createdAt ?? 1), op: 'upsert', groupId: gid, expenseId: eid, body, createdAt: 1, attempts: 0, nextTryAt: 0, error: null, userId: ME, ...o };
}

const refused = { code: 'limit_reached', message: 'limit' } as unknown as NonNullable<OutboxItem['error']>;

function setup() {
  const home = twoPeople('home'); // cached on this device
  const trip = twoPeople('trip'); // never opened here
  const me: MeDTO = {
    user: {
      id: ME, name: 'Gino', email: null, emailVerified: false, hasPassword: false, googleLinked: false, appleLinked: false, locale: 'zh-TW',
      currency: 'TWD', color: '#2F6FB5', payInfo: '', venmo: '', paypal: '', isAdmin: false, createdAt: '2026-10-01T00:00:00.000Z', avatar: null,
    } as MeDTO['user'],
    groups: [home.item, trip.item],
    friends: [],
    totals: [],
    unread: 0,
    serverTime: '2026-11-07T00:00:00.000Z',
  };
  const cache: Record<string, GroupEntry> = { home: { snap: home.snap, etag: '"3"', loading: false, error: null, fetchedAt: 0 } };
  return { me, cache };
}

afterEach(() => setLocale('zh-TW'));

describe('dashboardView: unsynced changes', () => {
  it('counts a change the server refused apart from the waiting ones, and keeps it in the numbers', () => {
    const { me, cache } = setup();
    const outbox = [save('home', 'e1', 1000), save('home', 'e2', 600, { error: refused })];
    const v = dashboardView(me, outbox, cache);
    expect(v.pendingCounted).toBe(1);
    expect(v.pendingFailed).toBe(1);
    expect(v.pendingUncounted).toBe(0);
    // Both saves are in Gino's net: half of 1,000 plus half of 600.
    expect(v.groups.find(g => g.id === 'home')?.myNet).toBe(800);
  });

  it('counts the waiting changes of a group not cached here as not counted yet, and a refused one there not at all', () => {
    const { me, cache } = setup();
    const outbox = [save('home', 'e1', 1000), save('trip', 'e3', 400), save('trip', 'e4', 200, { error: refused })];
    const v = dashboardView(me, outbox, cache);
    expect(v).toMatchObject({ pendingCounted: 1, pendingUncounted: 1, pendingFailed: 0 });
  });

  it('leaves out a refused save that a later save of the same entry replaced', () => {
    const { me, cache } = setup();
    const outbox = [save('home', 'e1', 1000, { error: refused, createdAt: 1 }), save('home', 'e1', 1200, { createdAt: 2 })];
    const v = dashboardView(me, outbox, cache);
    expect(v).toMatchObject({ pendingCounted: 1, pendingUncounted: 0, pendingFailed: 0 });
    expect(v.groups.find(g => g.id === 'home')?.myNet).toBe(600);
  });

  it('has nothing to say with an empty outbox', () => {
    const { me, cache } = setup();
    expect(dashboardView(me, [], cache)).toMatchObject({ pendingCounted: 0, pendingUncounted: 0, pendingFailed: 0 });
  });
});

describe('pendingNotes', () => {
  it('says which waiting changes are counted when there are both kinds', () => {
    setLocale('zh-TW');
    expect(pendingNotes({ pendingCounted: 1, pendingUncounted: 2, pendingFailed: 0 })).toEqual(['※ 3 筆等待同步，1 筆已計入，2 筆還沒算進來']);
    setLocale('en');
    expect(pendingNotes({ pendingCounted: 1, pendingUncounted: 2, pendingFailed: 0 })).toEqual(['Note: 3 items waiting to sync: 1 counted, 2 not counted yet.']);
  });

  it('keeps the one-kind notes as they were', () => {
    setLocale('zh-TW');
    expect(pendingNotes({ pendingCounted: 2, pendingUncounted: 0, pendingFailed: 0 })).toEqual(['※ 2 筆等待同步，已計入']);
    expect(pendingNotes({ pendingCounted: 0, pendingUncounted: 1, pendingFailed: 0 })).toEqual(['※ 1 筆等待同步，還沒算進來']);
    setLocale('en');
    expect(pendingNotes({ pendingCounted: 1, pendingUncounted: 0, pendingFailed: 0 })).toEqual(['Note: includes 1 item waiting to sync.']);
    expect(pendingNotes({ pendingCounted: 0, pendingUncounted: 2, pendingFailed: 0 })).toEqual(['Note: 2 items waiting to sync, not counted yet.']);
  });

  it('never calls a refused change waiting', () => {
    setLocale('zh-TW');
    expect(pendingNotes({ pendingCounted: 0, pendingUncounted: 0, pendingFailed: 1 })).toEqual(['※ 含 1 筆同步失敗的變更']);
    expect(pendingNotes({ pendingCounted: 1, pendingUncounted: 0, pendingFailed: 2 })).toEqual(['※ 1 筆等待同步，已計入', '※ 含 2 筆同步失敗的變更']);
    setLocale('en');
    expect(pendingNotes({ pendingCounted: 0, pendingUncounted: 0, pendingFailed: 1 })).toEqual(['Note: includes 1 change that failed to sync.']);
    expect(pendingNotes({ pendingCounted: 0, pendingUncounted: 0, pendingFailed: 3 })).toEqual(['Note: includes 3 changes that failed to sync.']);
  });

  it('is empty with nothing unsynced', () => {
    expect(pendingNotes({ pendingCounted: 0, pendingUncounted: 0, pendingFailed: 0 })).toEqual([]);
  });
});
