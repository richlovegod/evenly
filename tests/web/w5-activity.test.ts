// 動態 (src/web/features/activity/ActivityPage.tsx): when a visit marks the feed seen, and how a
// 1:1 ledger's rows say whose ledger it is.
// - askStep / settleStep: only this visit's load of the newest items, once it has answered without
//   an error, marks the new rows (未讀) and tells the server they were seen. A load that fails
//   (offline, a 5xx) leaves the badge for the next visit; 再試一次 that works marks them then; a
//   load already running when the page opens (StrictMode's second mount, a 載入更多 left over from
//   the last visit) is waited for.
// - ledgerFriend / feedGroupLabel: 「和 Abbie 的兩人帳本」 / "Ledger with Abbie", with the friend's
//   face, instead of 兩人帳本 and my own initial for every ledger alike.

import { afterEach, describe, expect, it, vi } from 'vitest';

// ActivityPage.tsx reaches lib/store.ts and lib/api.ts, which read location and storage when they load.
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

import type { GroupListItemDTO } from '../../src/shared/types';
import { askStep, feedGroupLabel, ledgerFriend, settleStep, type VisitLoad } from '../../src/web/features/activity/ActivityPage';
import { t, setLocale } from '../../src/web/lib/i18n';

afterEach(() => setLocale('zh-TW'));

/** Runs a visit: the page's steps against a sequence of activity states, counting loads and marks. */
function visit(loadingAtStart: boolean) {
  let want: VisitLoad = 'idle';
  let loads = 0;
  let marks = 0;
  const ask = (loading: boolean) => {
    const s = askStep(want, loading);
    want = s.want;
    if (s.load) loads++;
  };
  const settle = (a: { loading: boolean; error: unknown }) => {
    const s = settleStep(want, a);
    want = s.want;
    if (s.act === 'ask') ask(a.loading);
    if (s.act === 'mark') marks++;
  };
  ask(loadingAtStart);
  return { settle, ask, get loads() { return loads; }, get marks() { return marks; }, get want() { return want; } };
}

const failure = { code: 'server_error' };

describe('askStep and settleStep: marking 動態 seen', () => {
  it('marks it seen once the load answers', () => {
    const v = visit(false);
    expect(v.loads).toBe(1);
    v.settle({ loading: true, error: null });
    expect(v.marks).toBe(0);
    v.settle({ loading: false, error: null });
    expect(v.marks).toBe(1);
  });

  it('does not mark it seen when the load fails, and does once 再試一次 works', () => {
    const v = visit(false);
    v.settle({ loading: false, error: failure });
    expect(v.marks).toBe(0);
    // 再試一次
    v.ask(false);
    expect(v.loads).toBe(2);
    v.settle({ loading: true, error: failure });
    expect(v.marks).toBe(0);
    v.settle({ loading: false, error: null });
    expect(v.marks).toBe(1);
  });

  it('waits for a load already running, then asks for the newest items itself', () => {
    const v = visit(true); // a 載入更多 from the last visit is still going
    expect(v.loads).toBe(0);
    expect(v.want).toBe('wait');
    v.settle({ loading: false, error: null }); // it ended: now ask
    expect(v.loads).toBe(1);
    expect(v.marks).toBe(0);
    v.settle({ loading: false, error: null });
    expect(v.marks).toBe(1);
  });

  it('keeps its own load when StrictMode mounts the page a second time', () => {
    const v = visit(false);
    v.ask(true); // the second mount finds the first one's load running
    expect(v.want).toBe('asked');
    expect(v.loads).toBe(1);
    v.settle({ loading: false, error: null });
    expect(v.marks).toBe(1);
  });

  it('marks nothing for a later 載入更多', () => {
    const v = visit(false);
    v.settle({ loading: false, error: null });
    v.settle({ loading: true, error: null });
    v.settle({ loading: false, error: null });
    expect(v.marks).toBe(1);
    expect(settleStep('idle', { loading: false, error: null })).toEqual({ want: 'idle', act: 'none' });
  });
});

function ledger(id: string, members: GroupListItemDTO['members'], o: Partial<GroupListItemDTO> = {}): GroupListItemDTO {
  return {
    id, name: 'Gino & Abbie', type: 'pair', currency: 'TWD', emoji: '', color: '#2F6FB5', version: 1, updatedAt: '2026-11-01T00:00:00.000Z',
    myMemberId: 'm-gino', myNet: 0, myTransfers: [], spent: 0, count: 0, lastDate: null, archived: false, members, ...o,
  };
}

const gino = { id: 'm-gino', name: 'Gino', color: '#2F6FB5', userId: 'u-gino', active: true, avatar: null };
const abbie = { id: 'm-abbie', name: 'Abbie', color: '#C2410C', userId: 'u-abbie', active: true, avatar: 'v2' };

describe('ledgerFriend', () => {
  it('finds the other person of a 1:1 ledger', () => {
    expect(ledgerFriend({ groups: [ledger('p1', [gino, abbie])] }, 'p1')).toEqual(abbie);
  });

  it('still names a friend who has left the ledger, preferring one who is still in it', () => {
    const gone = { ...abbie, active: false };
    expect(ledgerFriend({ groups: [ledger('p1', [gino, gone])] }, 'p1')).toEqual(gone);
    const now = { ...abbie, id: 'm-abbie2', name: 'Abbie Chen' };
    expect(ledgerFriend({ groups: [ledger('p1', [gino, gone, now])] }, 'p1')).toEqual(now);
  });

  it('is null for a group that is not a ledger, or one the dashboard does not list', () => {
    expect(ledgerFriend({ groups: [ledger('g1', [gino, abbie], { type: 'trip' })] }, 'g1')).toBeNull();
    expect(ledgerFriend({ groups: [] }, 'p1')).toBeNull();
    expect(ledgerFriend(null, 'p1')).toBeNull();
  });
});

describe('feedGroupLabel', () => {
  it('names whose ledger it is, spaced as Chinese text needs', () => {
    setLocale('zh-TW');
    expect(feedGroupLabel({ groupType: 'pair', groupName: 'Gino & Abbie' }, { name: 'Abbie' }, t)).toBe('和 Abbie 的兩人帳本');
    expect(feedGroupLabel({ groupType: 'pair', groupName: 'Gino & 佳穎' }, { name: '佳穎' }, t)).toBe('和佳穎的兩人帳本');
    setLocale('en');
    expect(feedGroupLabel({ groupType: 'pair', groupName: 'Gino & Abbie' }, { name: 'Abbie' }, t)).toBe('Ledger with Abbie');
  });

  it('says 兩人帳本 when the friend is not known here, and a group its own name', () => {
    setLocale('zh-TW');
    expect(feedGroupLabel({ groupType: 'pair', groupName: 'Gino & Abbie' }, null, t)).toBe('兩人帳本');
    expect(feedGroupLabel({ groupType: 'trip', groupName: '北海道' }, null, t)).toBe('北海道');
    setLocale('en');
    expect(feedGroupLabel({ groupType: 'pair', groupName: 'Gino & Abbie' }, null, t)).toBe('Friend ledger');
  });
});
