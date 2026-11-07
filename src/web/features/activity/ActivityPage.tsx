// 動態: what changed across my groups, newest first. Each item says who did what, in which group
// (a 1:1 ledger by the friend's name and face: 和 Abbie 的兩人帳本), and what it meant for me
// (你借出 ¥10,500; a deleted entry: 不再計入); new items since my last visit are marked. More items
// load as the list scrolls.
// The newest items load on every visit (the last visit's stay in memory and show meanwhile). Only
// once that load has answered are the new ones marked (未讀) and everything marked seen on the
// server: until then the rows on screen are the old ones, and a load that fails (offline, a 5xx)
// leaves the badge and the markers for the next visit.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ActivityDTO, GroupListItemDTO, MeDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { GroupAvatar } from '../../components/GroupAvatar';
import { MoneyStatus } from '../../components/Money';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton, Spinner } from '../../components/Spinner';
import { zhJoin, zhThen } from '../../lib/describe';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, getState, useStore } from '../../lib/store';
import { cx } from '../groups/cx';
import { linkTo } from '../groups/links';
import { useCatchUpGroups } from '../home/freshness';
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

/**
 * This visit's load of the newest items, as the page tracks it: 'asked' until it answers; 'wait'
 * while another load still runs (loadActivity then returns at once), to ask once that one ends.
 */
export type VisitLoad = 'idle' | 'wait' | 'asked';

/**
 * Asking (on arrival, and from 再試一次). A load already running is either the page's own (StrictMode
 * mounts twice, and the second finds the first one's load, still 'asked') or another one (a 載入更多
 * left over from the last visit): wait for it, then ask.
 */
export function askStep(want: VisitLoad, loading: boolean): { want: VisitLoad; load: boolean } {
  if (loading) return { want: want === 'asked' ? 'asked' : 'wait', load: false };
  return { want: 'asked', load: true };
}

/**
 * The activity state changed. Once no load runs: ask if the page was waiting, else this visit's
 * load has answered, and only a load that succeeded marks the new items and tells the server they
 * were seen. A failed one (offline, a 5xx) leaves the badge and the markers for the next visit.
 */
export function settleStep(want: VisitLoad, a: { loading: boolean; error: unknown }): { want: VisitLoad; act: 'none' | 'ask' | 'mark' } {
  if (want === 'idle' || a.loading) return { want, act: 'none' };
  if (want === 'wait') return { want, act: 'ask' };
  return { want: 'idle', act: a.error ? 'none' : 'mark' };
}

export type ListedMember = GroupListItemDTO['members'][number];

/**
 * The friend a 1:1 ledger is with, as GET /api/me lists the ledger (one who has left still names
 * it). Null for any other group, or a ledger the dashboard no longer lists.
 */
export function ledgerFriend(me: Pick<MeDTO, 'groups'> | null, groupId: string): ListedMember | null {
  const g = me?.groups.find(x => x.id === groupId);
  if (!g || g.type !== 'pair') return null;
  return g.members.find(m => m.id !== g.myMemberId && m.active) ?? g.members.find(m => m.id !== g.myMemberId) ?? null;
}

/**
 * Where an item happened, under its sentence: the group's name, or for a 1:1 ledger whose ledger
 * it is (「和 Abbie 的兩人帳本」 / "Ledger with Abbie"; all my own rows would otherwise read 兩人帳本
 * alike), 兩人帳本 when the friend is not known here.
 */
export function feedGroupLabel(a: Pick<ActivityDTO, 'groupType' | 'groupName'>, friend: Pick<ListedMember, 'name'> | null, t: (zh: string, en: string) => string): string {
  if (a.groupType !== 'pair') return a.groupName;
  if (!friend) return t('兩人帳本', 'Friend ledger');
  return t(zhJoin(zhThen('和', friend.name), '的兩人帳本'), 'Ledger with ' + friend.name);
}

function Effect({ effect }: { effect: ActivityEffect }) {
  const { t } = useT();
  // A deleted entry no longer counts toward anyone's balance: say that, instead of an amount that
  // still reads 你借出 ¥6,300 (people not involved keep 你沒參與).
  if (effect.void && effect.involved) {
    return (
      <span className={cx(s.effect, s.void)} data-testid="activity-void">
        {t('不再計入', 'No longer counts')}
      </span>
    );
  }
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
      <MoneyStatus
        amount={effect.amount}
        currency={effect.currency}
        kind="rowEffect"
        refund={effect.kind === 'refund'}
        involved={effect.involved}
        size={effect.involved && effect.amount !== 0 ? 'md' : 'sm'}
      />
    );
  return <span className={s.effect}>{status}</span>;
}

export function ActivityPage() {
  const { t, relative } = useT();
  const me = useStore(st => st.me);
  const activity = useStore(st => st.activity);
  const online = useStore(st => st.online);
  // The unread count from before this visit marks it seen.
  const [unread, setUnread] = useState(() => getState().me?.unread ?? 0);
  // This visit's load of the newest items has answered without an error: the rows are current,
  // so the unread ones can be marked.
  const [shownNow, setShownNow] = useState(false);
  const want = useRef<VisitLoad>('idle');
  const sentinel = useRef<HTMLDivElement>(null);

  // On arrival and from 再試一次 (askStep).
  const refresh = useCallback(() => {
    const step = askStep(want.current, getState().activity.loading);
    want.current = step.want;
    if (step.load) void actions.loadActivity();
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  // When that load answers (settleStep; the store is read, as it can be ahead of this render):
  // mark what is new and tell the server it was seen, or nothing after a failure. Before paint, so
  // the markers come with the rows.
  useLayoutEffect(() => {
    const step = settleStep(want.current, getState().activity);
    want.current = step.want;
    if (step.act === 'ask') {
      refresh();
    } else if (step.act === 'mark') {
      setUnread(u => Math.max(u, getState().me?.unread ?? 0));
      setShownNow(true);
      void actions.markActivitySeen();
    }
  }, [activity, refresh]);
  // The dashboard refreshes here too; keep cached groups current behind it.
  useCatchUpGroups();

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
  // Until this visit's load answers, the rows are the last visit's: the count is about newer items.
  const fresh = useMemo(() => (shownNow ? unreadIds(activity.items, unread, me?.user.id ?? '') : new Set<string>()), [shownNow, activity.items, unread, me]);

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
                <Button variant="secondary" icon="sync" onClick={refresh}>
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
              <Skeleton height={38} width={38} radius={12} />
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
          // A 1:1 ledger has no cover of its own (its tile would print my own initial): the friend's face.
          const friend = a.groupType === 'pair' ? ledgerFriend(me, a.groupId) : null;
          const body = (
            <>
              <span className={s.lead} aria-hidden="true">
                {friend ? (
                  <Avatar name={friend.name} color={friend.color} userId={friend.userId} avatar={friend.avatar} size={38} />
                ) : (
                  <GroupAvatar emoji={a.groupEmoji} color={groupColors.get(a.groupId) ?? ''} name={a.groupName || '?'} size={38} />
                )}
              </span>
              <span className={s.main}>
                <span className={s.text}>
                  {isNew ? <span className={s.dot} aria-hidden="true" /> : null}
                  {isNew ? <span className="sr-only">{t('未讀：', 'New: ')}</span> : null}
                  {v.text}
                </span>
                {v.detail ? <span className={s.detail}>{v.detail}</span> : null}
                <span className={s.meta}>
                  <span className={s.group}>{feedGroupLabel(a, friend, t)}</span>
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
