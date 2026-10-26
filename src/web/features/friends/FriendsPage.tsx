// 朋友: everyone I share a group with, with what we owe each other per currency (people with
// something to settle first), 邀請朋友 (my friend invite link, features/invite) and 新增朋友. A
// refresh that keeps failing while online is said under the band, with the time of the numbers and
// 再試一次.

import { useEffect, useMemo } from 'react';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { IconButton } from '../../components/IconButton';
import { PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { Skeleton } from '../../components/Spinner';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, useStore } from '../../lib/store';
import { dashboardView } from '../home/dashboard';
import { useCatchUpGroups, useMeFreshness } from '../home/freshness';
import { StaleLine } from '../home/StaleNote';
import { FriendRow } from './FriendRow';
import s from './FriendsPage.module.css';

export function FriendsPage() {
  const { t } = useT();
  const me = useStore(st => st.me);
  const meLoading = useStore(st => st.meLoading);
  const meError = useStore(st => st.meError);
  const outbox = useStore(st => st.outbox);
  const cache = useStore(st => st.groups);
  const fresh = useMeFreshness();

  useEffect(() => {
    void actions.loadMe();
  }, []);
  useCatchUpGroups();

  const dash = useMemo(() => (me ? dashboardView(me, outbox, cache) : null), [me, outbox, cache]);
  const groupsById = useMemo(() => new Map((dash?.groups ?? []).map(g => [g.id, g])), [dash]);
  const open = (dash?.friends ?? []).filter(f => f.balances.length > 0);
  const settled = (dash?.friends ?? []).filter(f => f.balances.length === 0);

  const header = (
    <PageHeader
      large
      title={t('朋友', 'Friends')}
      actions={
        <>
          <IconButton icon="share" label={t('邀請朋友', 'Invite friends')} href="/invite-friends" data-testid="friends-invite" />
          <IconButton icon="userPlus" label={t('新增朋友', 'Add a friend')} href="/add-friend" data-testid="friends-add" />
        </>
      }
    />
  );

  if (!dash) {
    return (
      <div className={s.page}>
        {header}
        {meError && !meLoading ? (
          <div className={s.state}>
            <EmptyState
              icon={meError.code === 'offline' ? 'offline' : 'warning'}
              title={t('現在無法載入', 'Cannot load right now')}
              body={errorMessage(meError)}
              action={
                <Button variant="secondary" icon="sync" onClick={() => void actions.loadMe()}>
                  {t('再試一次', 'Try again')}
                </Button>
              }
            />
          </div>
        ) : (
          <div className={s.skel} aria-busy="true">
            {[0, 1, 2].map(i => (
              <div key={i} className={s.skelRow}>
                <Skeleton height={40} width={40} radius={20} />
                <span className={s.skelText}>
                  <Skeleton height={16} width="50%" />
                  <Skeleton height={12} width="30%" />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (!dash.friends.length) {
    return (
      <div className={s.page}>
        {header}
        <div className={s.state}>
          <EmptyState
            icon="friends"
            title={t('還沒有朋友', 'No friends yet')}
            body={t('傳邀請連結給朋友，或用名字新增，就能直接跟他記帳。', 'Send friends your invite link, or add one by name, to track costs with just the two of you.')}
            action={
              <>
                <Button variant="primary" icon="share" href="/invite-friends" data-testid="friends-empty-invite">
                  {t('邀請朋友', 'Invite friends')}
                </Button>
                <Button variant="secondary" icon="userPlus" href="/add-friend">
                  {t('新增朋友', 'Add a friend')}
                </Button>
              </>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      {header}
      {fresh.stale ? <StaleLine at={fresh.at} onRetry={() => void actions.loadMe()} /> : null}
      {open.length ? (
        <Section className={s.first} title={t('還沒結清', 'To settle')}>
          <ul className={s.list}>
            {open.map(f => (
              <li key={f.key}>
                <FriendRow friend={f} groups={groupsById} testId="friend-row" />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {settled.length ? (
        <Section className={open.length ? undefined : s.first} title={t('已結清', 'Settled up')}>
          <ul className={s.list}>
            {settled.map(f => (
              <li key={f.key}>
                <FriendRow friend={f} groups={groupsById} testId="friend-row" />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <div className={s.actions}>
        <Button variant="secondary" icon="share" href="/invite-friends" data-testid="friends-list-invite">
          {t('邀請朋友', 'Invite friends')}
        </Button>
        <Button variant="secondary" icon="userPlus" href="/add-friend">
          {t('新增朋友', 'Add a friend')}
        </Button>
      </div>
    </div>
  );
}
