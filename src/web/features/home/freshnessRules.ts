// How fresh the numbers on a screen are (pure rules; the hooks are in freshness.ts).
// 總覽, 群組 and 朋友 show the dashboard (GET /api/me), current as of me.serverTime. A group page
// shows its own snapshot, current as of its own last fetch, or as of a dashboard fetch that listed
// the same group version. A failed refresh (server trouble, not a missing connection, which the
// offline banner covers) is mentioned only once the data on screen has missed more than one
// regular refresh, so a single blip that the next poll clears prints nothing.

import type { MeDTO } from '../../../shared/types';
import type { ApiError } from '../../lib/api';
import type { GroupEntry } from '../../lib/store';

/** GET /api/me runs every 60 s on a visible screen: older than this after a failure, one was missed. */
export const ME_STALE_MS = 90_000;
/** An open group is fetched every 20 s (useGroupSync). */
export const GROUP_STALE_MS = 30_000;

/** The refresh failed for a reason other than having no connection (5xx, 429, a broken reply). */
export function refreshFailed(err: Pick<ApiError, 'code' | 'status'> | null | undefined): boolean {
  if (!err) return false;
  return err.code !== 'offline' && err.code !== 'not_found' && err.status !== 401 && err.status !== 403;
}

/** When the dashboard was fetched (0 when there is none). */
export function meSyncAt(me: Pick<MeDTO, 'serverTime'> | null | undefined): number {
  return me ? Date.parse(me.serverTime) || 0 : 0;
}

export interface MeFreshness {
  /** When the dashboard on screen was fetched. */
  at: number;
  /** The last refresh failed and the dashboard on screen missed more than one refresh. */
  stale: boolean;
}

export function meFreshness(me: Pick<MeDTO, 'serverTime'> | null, err: Pick<ApiError, 'code' | 'status'> | null, now = Date.now()): MeFreshness {
  const at = meSyncAt(me);
  return { at, stale: !!me && refreshFailed(err) && now - at > ME_STALE_MS };
}

export interface GroupFreshness {
  /** When this group's snapshot was last known to be current (0: not known on this device). */
  at: number;
  /** The dashboard lists a newer version of this group than the snapshot on screen. */
  behind: boolean;
  /** My balance in this group as the dashboard has it (null when the dashboard does not list it). */
  dashNet: number | null;
  /** The last fetch of this group failed (not for lack of a connection). */
  failed: boolean;
  /** It failed and the snapshot on screen missed more than one refresh. */
  stale: boolean;
}

type ListedGroup = Pick<MeDTO['groups'][number], 'id' | 'version' | 'myNet'>;

export function groupFreshness(
  gid: string,
  entry: Pick<GroupEntry, 'snap' | 'error' | 'fetchedAt'> | undefined,
  me: { serverTime: string; groups: readonly ListedGroup[] } | null,
  now = Date.now(),
): GroupFreshness {
  const snap = entry?.snap ?? null;
  const listed = me?.groups.find(g => g.id === gid);
  const version = snap?.group.version ?? 0;
  const behind = !!snap && !!listed && listed.version > version;
  // A dashboard fetch that listed this version (or an older one) saw this snapshot current.
  const vouched = snap && listed && listed.version <= version ? meSyncAt(me) : 0;
  const at = Math.max(entry?.fetchedAt ?? 0, vouched);
  const failed = refreshFailed(entry?.error);
  return { at, behind, dashNet: listed ? listed.myNet : null, failed, stale: failed && now - at > GROUP_STALE_MS };
}
