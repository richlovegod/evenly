// The app shell (src/web/components/AppShell.tsx): which tab a page marks, and where the 記一筆 key
// goes outside a group.
// - tabFor: #/g/* marks 群組, except a 1:1 ledger's pages, which mark 朋友, where ledgers live
//   (docs/SPEC.md section 4) and where their back button goes; #/f/* marks 朋友.
// - lastGroup: the last-used group (evenly.lastGroup, written by the editor) only while it is still
//   mine and not archived; an archived one is off the 新增費用 pickers (SPEC 8.3), so the key opens
//   the chooser instead of booking into a group I put away.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// AppShell.tsx reaches lib/store.ts and lib/api.ts, which read location and storage when they load;
// lastGroup reads localStorage.
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

import type { GroupListItemDTO, MeDTO } from '../../src/shared/types';
import { lastGroup, tabFor } from '../../src/web/components/AppShell';
import { parseHash } from '../../src/web/lib/router';

function group(id: string, o: Partial<GroupListItemDTO> = {}): GroupListItemDTO {
  return {
    id, name: id, type: 'trip', currency: 'JPY', emoji: '', color: '#2F6FB5', version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z', myMemberId: 'm-' + id, myNet: 0, myTransfers: [], spent: 0, count: 0,
    lastDate: null, members: [], archived: false, ...o,
  };
}

function me(groups: GroupListItemDTO[]): MeDTO {
  return { user: { id: 'u-gino' } as MeDTO['user'], groups, friends: [], totals: [], unread: 0, serverTime: '2026-11-07T00:00:00.000Z' };
}

describe('tabFor', () => {
  it('marks 朋友 on every page of a 1:1 ledger', () => {
    for (const path of ['#/g/p1', '#/g/p1/balances', '#/g/p1/settings', '#/g/p1/e/e1', '#/g/p1/settle']) {
      expect(tabFor(parseHash(path), 'pair')).toBe('friends');
    }
  });

  it('marks 群組 on a group, also while its type is not known yet', () => {
    expect(tabFor(parseHash('#/g/g1'), 'trip')).toBe('groups');
    expect(tabFor(parseHash('#/g/g1/stats'), 'home')).toBe('groups');
    expect(tabFor(parseHash('#/g/g1'), null)).toBe('groups');
  });

  it('keeps the other sections as they were', () => {
    expect(tabFor(parseHash('#/'), null)).toBe('home');
    expect(tabFor(parseHash('#/f/u%3Aabbie'), null)).toBe('friends');
    expect(tabFor(parseHash('#/groups'), null)).toBe('groups');
    expect(tabFor(parseHash('#/activity'), null)).toBe('activity');
    expect(tabFor(parseHash('#/account'), null)).toBe('account');
    expect(tabFor(parseHash('#/join/abc'), null)).toBeNull();
  });
});

describe('lastGroup', () => {
  beforeEach(() => localStorage.removeItem('evenly.lastGroup'));

  it('opens the last-used group while it is mine and not archived', () => {
    localStorage.setItem('evenly.lastGroup', 'hokkaido');
    expect(lastGroup(me([group('hokkaido')]))).toBe('hokkaido');
  });

  it('falls back to the chooser once I archived that group', () => {
    localStorage.setItem('evenly.lastGroup', 'hokkaido');
    expect(lastGroup(me([group('hokkaido', { archived: true })]))).toBeNull();
  });

  it('falls back when the group is gone or nothing is remembered', () => {
    localStorage.setItem('evenly.lastGroup', 'gone');
    expect(lastGroup(me([group('hokkaido')]))).toBeNull();
    expect(lastGroup(null)).toBeNull();
    localStorage.removeItem('evenly.lastGroup');
    expect(lastGroup(me([group('hokkaido')]))).toBeNull();
  });
});
