// 群組: every group I am in (1:1 friend ledgers live under 朋友). Groups with something to settle
// or recent activity first; settled, quiet ones fold away under 已結清的群組, and the ones I
// archived under 已封存 at the very bottom, each with 取消封存 (docs/SPEC.md section 4, Archive).
// A refresh that keeps failing while online is said under the band, with the time of the numbers
// and 再試一次.

import { useEffect, useMemo, useState } from 'react';
import type { GroupListItemDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { promptDialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { Skeleton } from '../../components/Spinner';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { dashboardView } from '../home/dashboard';
import { useCatchUpGroups, useMeFreshness } from '../home/freshness';
import { StaleLine } from '../home/StaleNote';
import { pastedInvitePath } from '../invite/inviteFlow';
import { groupLists } from './groupLists';
import { GroupRow } from './GroupRow';
import s from './GroupsPage.module.css';

export function GroupsPage() {
  const { t } = useT();
  const me = useStore(st => st.me);
  const meLoading = useStore(st => st.meLoading);
  const meError = useStore(st => st.meError);
  const outbox = useStore(st => st.outbox);
  const cache = useStore(st => st.groups);
  const online = useStore(st => st.online);
  const [showSettled, setShowSettled] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [unarchiving, setUnarchiving] = useState<string | null>(null);
  const fresh = useMeFreshness();

  useEffect(() => {
    void actions.loadMe();
  }, []);
  useCatchUpGroups();

  const dash = useMemo(() => (me ? dashboardView(me, outbox, cache) : null), [me, outbox, cache]);

  const { open, settled, archived } = useMemo(() => groupLists(dash?.groups ?? []), [dash]);

  const unarchive = async (g: GroupListItemDTO) => {
    setUnarchiving(g.id);
    try {
      await actions.setArchived(g.id, false);
      showToast({ message: t('已取消封存「{name}」', 'Unarchived "{name}"', { name: g.name }), kind: 'success' });
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
    } finally {
      setUnarchiving(null);
    }
  };

  const join = async () => {
    const text = await promptDialog({
      title: t('用邀請連結加入群組', 'Join a group with an invite link'),
      message: t('貼上朋友傳給你的邀請連結或代碼。', 'Paste the invite link or code a friend sent you.'),
      label: t('邀請連結或代碼', 'Invite link or code'),
      placeholder: 'https://…/#/join/…',
      confirmLabel: t('前往', 'Open'),
    });
    if (text === null) return;
    const to = pastedInvitePath(text);
    if (!to) {
      showToast({ message: t('這看起來不是邀請連結，請再確認一次。', 'That does not look like an invite link. Check it and try again.'), kind: 'error' });
      return;
    }
    navigate(to);
  };

  const header = (
    <PageHeader
      large
      title={t('群組', 'Groups')}
      actions={
        <>
          <IconButton icon="link" label={t('用邀請連結加入', 'Join with an invite link')} onClick={() => void join()} data-testid="groups-join" />
          <IconButton icon="plus" label={t('建立群組', 'New group')} href="/new-group" data-testid="groups-new-group" />
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
                <Skeleton height={48} width={48} radius={14} />
                <span className={s.skelText}>
                  <Skeleton height={16} width="55%" />
                  <Skeleton height={12} width="35%" />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (!open.length && !settled.length && !archived.length) {
    return (
      <div className={s.page}>
        {header}
        <div className={s.state}>
          <EmptyState
            icon="groups"
            title={t('還沒有群組', 'No groups yet')}
            body={t('建立一個群組，邀朋友一起記帳。', 'Create a group and invite friends to track costs together.')}
            action={
              <>
                <Button variant="primary" icon="plus" href="/new-group">
                  {t('建立群組', 'Create a group')}
                </Button>
                <Button variant="ghost" icon="link" onClick={() => void join()}>
                  {t('用邀請連結加入', 'Join with an invite link')}
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
        <Section className={s.first}>
          <ul className={s.list}>
            {open.map(g => (
              <li key={g.id}>
                <GroupRow group={g} testId="group-row" />
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        <p className={s.note}>
          {settled.length || !archived.length
            ? t('目前沒有要結清的群組', 'Nothing to settle right now')
            : t('你的群組都封存了，在最下面的「已封存」裡', 'All your groups are archived: see Archived at the bottom')}
        </p>
      )}

      {settled.length ? (
        <Section className={s.settledSec}>
          <button
            type="button"
            className={s.fold}
            aria-expanded={showSettled}
            onClick={() => setShowSettled(v => !v)}
            data-testid="groups-show-settled"
          >
            <span>{t('已結清的群組（{n}）', 'Settled groups ({n})', { n: settled.length })}</span>
            <Icon name={showSettled ? 'chevronUp' : 'chevronDown'} size={18} />
          </button>
          {showSettled ? (
            <ul className={s.list}>
              {settled.map(g => (
                <li key={g.id}>
                  <GroupRow group={g} testId="group-row" />
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {archived.length ? (
        // My archived groups, whatever their balance: their money still counts on 總覽 and 朋友.
        <Section className={s.settledSec}>
          <button
            type="button"
            className={s.fold}
            aria-expanded={showArchived}
            onClick={() => setShowArchived(v => !v)}
            data-testid="groups-show-archived"
          >
            <span className={s.foldLabel}>
              <Icon name="archive" size={18} />
              {t('已封存（{n}）', 'Archived ({n})', { n: archived.length })}
            </span>
            <Icon name={showArchived ? 'chevronUp' : 'chevronDown'} size={18} />
          </button>
          {showArchived ? (
            <>
              <p className={s.archivedNote}>
                {t('只有你看不到這些群組，金額照樣算在總覽裡；別人新增費用時，群組會自己回來。', 'Only you have these out of sight. Their balances still count on Home, and a group comes back when someone else adds an entry.')}
              </p>
              <ul className={s.list}>
                {archived.map(g => (
                  <li key={g.id} className={s.archivedItem}>
                    <GroupRow group={g} testId="group-row-archived" />
                    <div className={s.unarchiveBar}>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="restore"
                        onClick={() => void unarchive(g)}
                        loading={unarchiving === g.id}
                        disabled={!online}
                        aria-label={t('取消封存「{name}」', 'Unarchive "{name}"', { name: g.name })}
                        data-testid="group-unarchive"
                        data-id={g.id}
                      >
                        {t('取消封存', 'Unarchive')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {!online ? <p className={s.archivedNote}>{t('離線中，取消封存需要網路', 'You are offline. Unarchiving needs a connection')}</p> : null}
            </>
          ) : null}
        </Section>
      ) : null}

      <div className={s.actions}>
        <Button variant="secondary" icon="plus" href="/new-group" data-testid="groups-create">
          {t('建立群組', 'Create a group')}
        </Button>
      </div>
    </div>
  );
}
