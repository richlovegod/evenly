// 動態: what changed across my groups, newest first. Each item says who did what, in which group,
// and what it meant for me (你借出 ¥10,500); new items since my last visit are marked. Opening the
// page marks everything seen; more items load as the list scrolls.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { GroupAvatar } from '../../components/GroupAvatar';
import { MoneyStatus } from '../../components/Money';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton, Spinner } from '../../components/Spinner';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, getState, useStore } from '../../lib/store';
import { cx } from '../groups/cx';
import { linkTo } from '../groups/links';
import { activityContext, describeActivity, type ActivityEffect } from './activityText';
import s from './ActivityPage.module.css';

/**
 * Items the server counted as unread: the newest `count` items not made by me (the unread count
 * leaves out my own changes).
 */
export function unreadIds(items: readonly ActivityDTO[], count: number, meUserId: string): Set<string> {
  const out = new Set<string>();
  let left = count;
  for (const a of items) {
    if (left <= 0) break;
    if (a.userId && a.userId === meUserId) continue;
    out.add(a.id);
    left--;
  }
  return out;
}

function Effect({ effect }: { effect: ActivityEffect }) {
  const status =
    effect.kind === 'payment' ? (
      <MoneyStatus
        amount={effect.involved ? (effect.sent ? effect.amount : -effect.amount) : 0}
        currency={effect.currency}
        kind="rowEffect"
        payment
        involved={effect.involved}
        size={effect.involved ? 'md' : 'sm'}
      />
    ) : (
      <MoneyStatus amount={effect.amount} currency={effect.currency} kind="rowEffect" involved={effect.involved} size={effect.involved && effect.amount !== 0 ? 'md' : 'sm'} />
    );
  return <span className={cx(s.effect, effect.void && s.void)}>{status}</span>;
}

export function ActivityPage() {
  const { t, relative } = useT();
  const me = useStore(st => st.me);
  const activity = useStore(st => st.activity);
  const online = useStore(st => st.online);
  // The unread count from before this visit marks it seen.
  const [unread, setUnread] = useState(() => getState().me?.unread ?? 0);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void actions.loadActivity().then(() => {
      if (!alive) return;
      const n = getState().me?.unread ?? 0;
      setUnread(u => Math.max(u, n));
      void actions.markActivitySeen();
    });
    return () => {
      alive = false;
    };
  }, []);

  // Load the next page when the end of the list comes into view.
  const canMore = !!activity.next && !activity.loading && !activity.error;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void actions.loadActivity(true);
      },
      { rootMargin: '0px 0px 320px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canMore, activity.items.length]);

  const ctx = useMemo(() => (me ? activityContext(me) : null), [me]);
  const groupColors = useMemo(() => new Map((me?.groups ?? []).map(g => [g.id, g.color])), [me]);
  const fresh = useMemo(() => unreadIds(activity.items, unread, me?.user.id ?? ''), [activity.items, unread, me]);

  const header = <PageHeader large title={t('動態', 'Activity')} />;

  if (!activity.loaded && !activity.items.length) {
    if (activity.error && !activity.loading) {
      return (
        <div className={s.page}>
          {header}
          <div className={s.state}>
            <EmptyState
              icon={activity.error.code === 'offline' ? 'offline' : 'warning'}
              title={t('現在無法載入動態', 'Activity cannot load right now')}
              body={errorMessage(activity.error)}
              action={
                <Button variant="secondary" icon="sync" onClick={() => void actions.loadActivity()}>
                  {t('再試一次', 'Try again')}
                </Button>
              }
            />
          </div>
        </div>
      );
    }
    return (
      <div className={s.page} aria-busy="true">
        {header}
        <div className={s.skel}>
          {[0, 1, 2, 3].map(i => (
            <div key={i} className={s.skelRow}>
              <Skeleton height={40} width={38} />
              <span className={s.skelText}>
                <Skeleton height={16} width="75%" />
                <Skeleton height={12} width="40%" />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!activity.items.length) {
    return (
      <div className={s.page}>
        {header}
        <div className={s.state}>
          <EmptyState icon="activity" title={t('還沒有動態', 'No activity yet')} body={t('有人新增或修改費用時，會出現在這裡。', 'When someone adds or changes an expense, it shows up here.')} />
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      {header}
      <ul className={s.list} aria-label={t('動態', 'Activity')}>
        {activity.items.map(a => {
          const v = ctx ? describeActivity(a, ctx) : null;
          if (!v) return null;
          const isNew = fresh.has(a.id);
          const body = (
            <>
              <span className={s.lead} aria-hidden="true">
                <GroupAvatar emoji={a.groupEmoji} color={groupColors.get(a.groupId) ?? ''} name={a.groupName || '?'} size={38} />
              </span>
              <span className={s.main}>
                <span className={s.text}>
                  {isNew ? <span className={s.dot} aria-hidden="true" /> : null}
                  {isNew ? <span className="sr-only">{t('未讀：', 'New: ')}</span> : null}
                  {v.text}
                </span>
                {v.detail ? <span className={s.detail}>{v.detail}</span> : null}
                <span className={s.meta}>
                  <span className={s.group}>{a.groupType === 'pair' ? t('兩人帳本', 'Friend ledger') : a.groupName}</span>
                  <span className={s.time}>{relative(a.createdAt)}</span>
                </span>
              </span>
              {v.effect ? <Effect effect={v.effect} /> : null}
            </>
          );
          return (
            <li key={a.id} className={s.item}>
              {v.path ? (
                <a className={cx(s.row, isNew && s.new)} {...linkTo(v.path)} data-testid="activity-item" data-id={a.id} data-unread={isNew || undefined}>
                  {body}
                </a>
              ) : (
                <div className={cx(s.row, isNew && s.new)} data-testid="activity-item" data-id={a.id} data-unread={isNew || undefined}>
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div ref={sentinel} className={s.end}>
        {activity.loading ? (
          <Spinner size={22} label={t('載入更多', 'Loading more')} />
        ) : activity.next ? (
          <Button variant="ghost" onClick={() => void actions.loadActivity(true)} disabled={!online} data-testid="activity-more">
            {t('載入更多', 'Load more')}
          </Button>
        ) : (
          <span>{t('更早的動態都在這裡了', 'You have reached the beginning')}</span>
        )}
        {activity.error && activity.items.length ? <span className={s.err}>{errorMessage(activity.error)}</span> : null}
      </div>
    </div>
  );
}
