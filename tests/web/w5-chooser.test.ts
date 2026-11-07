// 新增費用's chooser (src/web/components/AddExpenseChooser.tsx chooserLists): what it offers when
// the add key cannot tell where a new expense goes. Only friends with a 1:1 ledger are listed, as
// the iPhone's PickGroupView does: by name alone POST /api/friends makes a placeholder ledger, so
// a friend who has an account but no ledger with me is never offered (picking them used to put
// the expense where they never see it). Archived groups stay off the list, and with nothing left
// to pick because every group is archived, the chooser says so instead of 還沒有群組.

import { describe, expect, it, vi } from 'vitest';

// The chooser's module reaches lib/store.ts and lib/api.ts, which read location and storage when
// they load.
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

import type { FriendDTO, GroupListItemDTO } from '../../src/shared/types';
import { chooserLists } from '../../src/web/components/AddExpenseChooser';

function group(id: string, o: Partial<GroupListItemDTO> = {}): GroupListItemDTO {
  return {
    id, name: id, type: 'trip', currency: 'TWD', emoji: '', color: '#2F6FB5', version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z', myMemberId: 'm-' + id, myNet: 0, myTransfers: [], spent: 0, count: 0,
    lastDate: null, members: [], archived: false, ...o,
  };
}

function friend(key: string, o: Partial<FriendDTO> = {}): FriendDTO {
  return {
    key, userId: key.startsWith('u:') ? key.slice(2) : null, name: key, color: '#2F6FB5', balances: [], groups: [],
    pairGroupId: null, payInfo: '', venmo: '', paypal: '', avatar: null, ...o,
  };
}

describe('chooserLists', () => {
  it('leaves out a friend with an account but no 1:1 ledger', () => {
    const abbie = friend('u:abbie'); // shares 北海道 with me, no ledger
    const l = chooserLists([group('hokkaido')], [abbie]);
    expect(l.friends).toEqual([]);
    expect(l.groups.map(g => g.id)).toEqual(['hokkaido']);
  });

  it('keeps friends with a ledger, accounts and placeholders alike, in the dashboard order', () => {
    const leo = friend('m:leo', { pairGroupId: 'p-leo' });
    const abbie = friend('u:abbie', { pairGroupId: 'p-abbie' });
    const kevin = friend('u:kevin');
    const l = chooserLists([group('p-leo', { type: 'pair' }), group('p-abbie', { type: 'pair' })], [leo, kevin, abbie]);
    expect(l.friends.map(f => f.key)).toEqual(['m:leo', 'u:abbie']);
    expect(l.friends.map(f => f.pairGroupId)).toEqual(['p-leo', 'p-abbie']);
    // 1:1 ledgers are listed under the friends, never as groups.
    expect(l.groups).toEqual([]);
  });

  it('lists the groups that are not archived, the most recently changed first', () => {
    const old = group('old', { updatedAt: '2026-03-01T00:00:00.000Z' });
    const recent = group('recent', { updatedAt: '2026-10-20T00:00:00.000Z' });
    const archived = group('archived', { updatedAt: '2026-11-01T00:00:00.000Z', archived: true });
    const input = [old, archived, recent];
    const l = chooserLists(input, []);
    expect(l.groups.map(g => g.id)).toEqual(['recent', 'old']);
    expect(l.allArchived).toBe(false);
    // The dashboard's own list is left as it was.
    expect(input.map(g => g.id)).toEqual(['old', 'archived', 'recent']);
  });

  it('says every group is archived only when nothing else is left to pick', () => {
    const archived = group('archived', { archived: true });
    expect(chooserLists([archived], []).allArchived).toBe(true);
    // A friend's ledger is still something to pick.
    expect(chooserLists([archived, group('p', { type: 'pair' })], [friend('u:abbie', { pairGroupId: 'p' })]).allArchived).toBe(false);
    // A friend without a ledger is not.
    expect(chooserLists([archived], [friend('u:abbie')]).allArchived).toBe(true);
    // An archived 1:1 ledger (the server allows it, the app offers no 封存) is not a group of mine here.
    expect(chooserLists([group('p', { type: 'pair', archived: true })], []).allArchived).toBe(false);
  });

  it('is empty, and not all archived, before there is anything at all', () => {
    expect(chooserLists(undefined, undefined)).toEqual({ groups: [], friends: [], allArchived: false });
    expect(chooserLists([], [])).toEqual({ groups: [], friends: [], allArchived: false });
  });
});
