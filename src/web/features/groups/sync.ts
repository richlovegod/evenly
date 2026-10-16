// "上次同步 12/20 16:12": one last-sync time for every screen (DESIGN.md 8.4), the newest of the
// dashboard fetch and any group fetch, so 總覽 and a group never disagree.

import { formatDate, formatTime, getLocale, t } from '../../lib/i18n';
import { useStore, type State } from '../../lib/store';

export function lastSyncAt(s: State): number {
  let at = s.me ? Date.parse(s.me.serverTime) || 0 : 0;
  for (const g of Object.values(s.groups)) if (g.fetchedAt > at) at = g.fetchedAt;
  return at;
}

export function useLastSyncAt(): number {
  return useStore(lastSyncAt);
}

/** 「上次同步 12/20 16:12」 / "Last synced Dec 20, 4:12 PM"; under a minute 「剛剛同步」. */
export function syncText(ms: number, now = Date.now()): string {
  if (!ms) return '';
  if (now - ms < 60000) return t('剛剛同步', 'Synced just now');
  const d = new Date(ms);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (getLocale() === 'zh-TW') {
    return '上次同步 ' + formatDate(iso, 'md') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  return 'Last synced ' + formatDate(iso, 'md') + ', ' + formatTime(d.toISOString());
}
