// Which list each group goes in on 群組 and 總覽, from GET /api/me. Pure (no React, no storage), so
// tests/web/archive.test.ts runs it in Node.

import type { GroupListItemDTO } from '../../../shared/types';

const RECENT_DAYS = 30;

/** Something happened in the group in the last 30 days (a change, or an entry dated then). */
export function isRecent(g: GroupListItemDTO, now = Date.now()): boolean {
  const cut = now - RECENT_DAYS * 86400000;
  if (Date.parse(g.updatedAt) > cut) return true;
  if (g.lastDate && Date.parse(g.lastDate + 'T00:00:00Z') > cut) return true;
  return false;
}

export interface GroupLists {
  /** Something to settle or recent: settling first, then the most recently changed (the server's order). */
  open: GroupListItemDTO[];
  /** Settled and quiet, under 已結清的群組. */
  settled: GroupListItemDTO[];
  /** Archived by me, under 已封存 (whatever their balance), in the server's order. */
  archived: GroupListItemDTO[];
}

/**
 * The 群組 page's lists (docs/SPEC.md section 4, Archive). 1:1 ledgers are left out: they live
 * under 朋友. A group I archived goes under 已封存 only, also when I still owe or am owed there.
 */
export function groupLists(groups: readonly GroupListItemDTO[], now = Date.now()): GroupLists {
  const all = groups.filter(g => g.type !== 'pair');
  const shown = all.filter(g => !g.archived);
  const lively = shown.filter(g => g.myNet !== 0 || isRecent(g, now));
  const quiet = shown.filter(g => g.myNet === 0 && !isRecent(g, now));
  const ranked = lively.map((g, i) => ({ g, i })).sort((a, b) => (a.g.myNet !== 0 ? 0 : 1) - (b.g.myNet !== 0 ? 0 : 1) || a.i - b.i);
  return { open: ranked.map(x => x.g), settled: quiet, archived: all.filter(g => g.archived) };
}

/** 總覽's 群組 section: groups that are not archived, something to settle first, then the server's order. */
export function homeGroups(groups: readonly GroupListItemDTO[]): GroupListItemDTO[] {
  return groups
    .filter(g => g.type !== 'pair' && !g.archived)
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (a.g.myNet !== 0 ? 0 : 1) - (b.g.myNet !== 0 ? 0 : 1) || a.i - b.i)
    .map(x => x.g);
}
