// 封存群組 in the app (docs/SPEC.md section 4, Archive): which list each group goes in on 群組 and
// 總覽 (features/groups/groupLists.ts). An archived group goes under 已封存 only, whatever its
// balance; 1:1 ledgers stay under 朋友. The Worker's side is tests/worker/archive.test.ts.

import { describe, expect, it } from 'vitest';
import type { GroupListItemDTO } from '../../src/shared/types';
import { groupLists, homeGroups, isRecent } from '../../src/web/features/groups/groupLists';

const NOW = Date.parse('2026-10-25T12:00:00Z');

function group(id: string, o: Partial<GroupListItemDTO> = {}): GroupListItemDTO {
  return {
    id, name: id, type: 'trip', currency: 'JPY', emoji: '', color: '#2F6FB5', version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z', myMemberId: 'm-' + id, myNet: 0, myTransfers: [], spent: 0, count: 0,
    lastDate: null, members: [], archived: false, ...o,
  };
}

describe('groupLists', () => {
  const owing = group('owing', { myNet: -3000 });
  const recent = group('recent', { updatedAt: '2026-10-20T00:00:00.000Z' });
  const quiet = group('quiet');
  const archivedOwing = group('archived-owing', { myNet: -22500, archived: true });
  const archivedQuiet = group('archived-quiet', { archived: true });
  const pair = group('pair', { type: 'pair', myNet: 500 });
  const pairArchived = group('pair-archived', { type: 'pair', archived: true });

  it('puts an archived group under 已封存 only, also when it still has a balance', () => {
    const l = groupLists([recent, archivedOwing, owing, quiet, archivedQuiet, pair, pairArchived], NOW);
    expect(l.open.map(g => g.id)).toEqual(['owing', 'recent']);
    expect(l.settled.map(g => g.id)).toEqual(['quiet']);
    expect(l.archived.map(g => g.id)).toEqual(['archived-owing', 'archived-quiet']);
  });

  it('leaves 1:1 ledgers out of every list (they are under 朋友)', () => {
    const l = groupLists([pair, pairArchived], NOW);
    expect(l.open).toEqual([]);
    expect(l.settled).toEqual([]);
    expect(l.archived).toEqual([]);
  });

  it('treats a missing flag (an older server) as not archived', () => {
    const old = { ...group('old', { myNet: 100 }) } as Partial<GroupListItemDTO>;
    delete old.archived;
    expect(groupLists([old as GroupListItemDTO], NOW).open.map(g => g.id)).toEqual(['old']);
  });

  it('isRecent counts a change or an entry date in the last 30 days', () => {
    expect(isRecent(recent, NOW)).toBe(true);
    expect(isRecent(quiet, NOW)).toBe(false);
    expect(isRecent(group('dated', { lastDate: '2026-10-01' }), NOW)).toBe(true);
  });
});

describe('homeGroups', () => {
  it('shows the groups that are not archived, something to settle first', () => {
    const list = [group('a'), group('b', { myNet: 10 }), group('c', { archived: true, myNet: -5 }), group('p', { type: 'pair', myNet: 1 })];
    expect(homeGroups(list).map(g => g.id)).toEqual(['b', 'a']);
  });
});
