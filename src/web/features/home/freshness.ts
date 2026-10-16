// How fresh the numbers on a screen are, for the ※ notes that say so (DESIGN.md 8.4); the rules
// are in freshnessRules.ts. While the dashboard knows a newer version of a group cached on this
// device, that group is fetched in the background, so the phone holds current snapshots before
// the signal drops.

import { useEffect } from 'react';
import { actions, getState, useStore } from '../../lib/store';
import { groupFreshness, meFreshness, type GroupFreshness, type MeFreshness } from './freshnessRules';

export { groupFreshness, meFreshness, meSyncAt, refreshFailed, type GroupFreshness, type MeFreshness } from './freshnessRules';

export function useMeFreshness(): MeFreshness {
  const me = useStore(st => st.me);
  const err = useStore(st => st.meError);
  return meFreshness(me, err);
}

export function useGroupFreshness(gid: string): GroupFreshness {
  const entry = useStore(st => st.groups[gid]);
  const me = useStore(st => st.me);
  return groupFreshness(gid, entry, me);
}

// ---------- catching up cached groups ----------

let catching = false;
/** `gid@version` pairs already fetched once, so a fetch that fails or lags is not repeated in a loop. */
const tried = new Set<string>();

/** Fetch, one at a time, every group cached here whose dashboard version is newer than its snapshot. */
export async function catchUpGroups(): Promise<void> {
  if (catching) return;
  catching = true;
  try {
    for (;;) {
      const st = getState();
      if (!st.token || !st.me || !st.online) break;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') break;
      const next = st.me.groups.find(g => {
        const e = st.groups[g.id];
        return !!e?.snap && !e.loading && e.snap.group.version < g.version && !tried.has(g.id + '@' + g.version);
      });
      if (!next) break;
      const key = next.id + '@' + next.version;
      tried.add(key);
      await actions.loadGroup(next.id);
      // The connection dropped on the way: try this one again on the next dashboard refresh.
      if (getState().groups[next.id]?.error?.code === 'offline') {
        tried.delete(key);
        break;
      }
    }
  } finally {
    catching = false;
  }
}

/** On every dashboard refresh, bring cached group snapshots up to date in the background. */
export function useCatchUpGroups(): void {
  const stamp = useStore(st => (st.me ? st.me.serverTime : ''));
  useEffect(() => {
    if (stamp) void catchUpGroups();
  }, [stamp]);
}
