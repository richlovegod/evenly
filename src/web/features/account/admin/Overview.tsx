// 概況: the site-wide counts as tiles (使用者, 本週新增, 本週活躍, 有 Email / 只在裝置上, 群組, 費用).
// They come with every page of the user list; while that list cannot load (a Worker without
// /api/admin/users), the three counts of /api/admin/stats show instead.

import type { AdminStatsDTO } from '../../../../shared/types';
import { Button } from '../../../components/Button';
import { Skeleton } from '../../../components/Spinner';
import { useT } from '../../../lib/i18n';
import { Card, cx, ErrorLine, Note } from '../../auth/Receipt';
import s from './Admin.module.css';

type TileTint = 'water' | 'yellow';

export interface BasicCounts {
  users: number;
  groups: number;
  expenses: number;
}

export function Overview({ stats, basic, error, onRetry }: { stats: AdminStatsDTO | null; basic?: BasicCounts | null; error: string | null; onRetry: () => void }) {
  const { t, num } = useT();
  const n = (v: number) => num(v, 0);
  const tiles: { key: string; label: string; value: string; tint: TileTint }[] | null = stats
    ? [
        { key: 'users', label: t('使用者', 'People'), value: n(stats.users), tint: 'water' },
        { key: 'new', label: t('本週新增', 'New this week'), value: n(stats.newLast7), tint: 'yellow' },
        { key: 'active', label: t('本週活躍', 'Active this week'), value: n(stats.activeLast7), tint: 'yellow' },
        // A Worker from before email codes sends no withEmail; then an email and a password was the only way in elsewhere.
        { key: 'email', label: t('有 Email / 只在裝置上', 'Email / device only'), value: `${n(stats.withEmail ?? stats.withPassword)} / ${n(stats.deviceOnly)}`, tint: 'water' },
        { key: 'groups', label: t('群組', 'Groups'), value: n(stats.groups), tint: 'water' },
        { key: 'entries', label: t('費用', 'Expenses'), value: n(stats.entries), tint: 'yellow' },
      ]
    : basic
      ? [
          { key: 'users', label: t('使用者', 'People'), value: n(basic.users), tint: 'water' },
          { key: 'groups', label: t('群組', 'Groups'), value: n(basic.groups), tint: 'yellow' },
          { key: 'entries', label: t('費用', 'Expenses'), value: n(basic.expenses), tint: 'yellow' },
        ]
      : null;

  return (
    <Card title={t('概況', 'Overview')} aria-busy={!tiles && !error ? true : undefined} data-testid="admin-stats">
      {tiles ? (
        <>
          <dl className={s.tiles}>
            {tiles.map(x => (
              <div key={x.key} className={cx(s.tile, s[x.tint])} data-testid={'admin-stat-' + x.key}>
                <dt>{x.label}</dt>
                <dd>{x.value}</dd>
              </div>
            ))}
          </dl>
          <Note>
            {stats
              ? t('本週＝最近 7 天。不含已刪除的群組和費用。', 'This week means the last 7 days. Deleted groups and expenses are not counted.')
              : t('不含已刪除的群組和費用', 'Deleted groups and expenses are not counted.')}
          </Note>
        </>
      ) : error ? (
        <>
          <ErrorLine>{error}</ErrorLine>
          <Button variant="secondary" size="sm" icon="sync" className={s.more} onClick={onRetry}>
            {t('再試一次', 'Try again')}
          </Button>
        </>
      ) : (
        <div className={s.tiles}>
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} className={cx(s.tile, s.tileSkel)}>
              <Skeleton height={12} width="60%" />
              <div className={s.skelGap} />
              <Skeleton height={20} width="40%" />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
