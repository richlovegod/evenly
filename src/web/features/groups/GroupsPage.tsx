// 群組: every group I am in (1:1 friend ledgers live under 朋友). Groups with something to settle
// or recent activity first; settled, quiet ones fold away under 已結清的群組. A refresh that keeps
// failing while online is said under the band, with the time of the numbers and 再試一次.

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
import { GroupRow } from './GroupRow';
import s from './GroupsPage.module.css';

const RECENT_DAYS = 30;

/** Something happened in the group in the last 30 days (a change, or an entry dated then). */
export function isRecent(g: GroupListItemDTO, now = Date.now()): boolean {
  const cut = now - RECENT_DAYS * 86400000;
  if (Date.parse(g.updatedAt) > cut) return true;
  if (g.lastDate && Date.parse(g.lastDate + 'T00:00:00Z') > cut) return true;
  return false;
}

/** An invite code from what someone pasted: a whole link (…#/join/CODE) or just the code. */
export function inviteCodeFrom(text: string): string | null {
  const v = text.trim();
  const m = /join\/([A-Za-z0-9_-]{6,64})/.exec(v);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{6,64}$/.test(v) ? v : null;
}

export function GroupsPage() {
  const { t } = useT();
  const me = useStore(st => st.me);
  const meLoading = useStore(st => st.meLoading);
  const meError = useStore(st => st.meError);
  const outbox = useStore(st => st.outbox);
  const cache = useStore(st => st.groups);
  const [showSettled, setShowSettled] = useState(false);
  const fresh = useMeFreshness();

  useEffect(() => {
    void actions.loadMe();
  }, []);
  useCatchUpGroups();

  const dash = useMemo(() => (me ? dashboardView(me, outbox, cache) : null), [me, outbox, cache]);

  const { open, settled } = useMemo(() => {
    const all = (dash?.groups ?? []).filter(g => g.type !== 'pair');
    const now = Date.now();
    const lively = all.filter(g => g.myNet !== 0 || isRecent(g, now));
    const quiet = all.filter(g => g.myNet === 0 && !isRecent(g, now));
    // Something to settle first, then the most recently changed (the server's order).
    const ranked = lively.map((g, i) => ({ g, i })).sort((a, b) => (a.g.myNet !== 0 ? 0 : 1) - (b.g.myNet !== 0 ? 0 : 1) || a.i - b.i);
    return { open: ranked.map(x => x.g), settled: quiet };
  }, [dash]);

  const join = async () => {
    const text = await promptDialog({
      title: t('用邀請連結加入群組', 'Join a group with an invite link'),
      message: t('貼上朋友傳給你的邀請連結或代碼。', 'Paste the invite link or code a friend sent you.'),
      label: t('邀請連結或代碼', 'Invite link or code'),
      placeholder: 'https://…/#/join/…',
      confirmLabel: t('前往', 'Open'),
    });
    if (text === null) return;
    const code = inviteCodeFrom(text);
    if (!code) {
      showToast({ message: t('這看起來不是邀請連結，請再確認一次。', 'That does not look like an invite link. Check it and try again.'), kind: 'error' });
      return;
    }
    navigate('/join/' + encodeURIComponent(code));
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

  if (!open.length && !settled.length) {
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
        <p className={s.note}>{t('目前沒有要結清的群組', 'Nothing to settle right now')}</p>
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

      <div className={s.actions}>
        <Button variant="secondary" icon="plus" href="/new-group" data-testid="groups-create">
          {t('建立群組', 'Create a group')}
        </Button>
      </div>
    </div>
  );
}
