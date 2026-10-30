// A group: the top bar, the cover band and its status card (GroupHeader), the 費用 / 結算 / 統計 /
// 設定 tabs and the open tab. Numbers are computed here from the merged view, so entries saved
// offline count at once.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Spinner';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { movesBalances } from '../../lib/outbox';
import { navigate } from '../../lib/router';
import { Tabs } from '../../components/Tabs';
import { actions, useGroupView, useStore } from '../../lib/store';
import { BalancesTab, type PlanState } from './BalancesTab';
import { cx } from './cx';
import { ExpensesTab } from './ExpensesTab';
import { GroupHeader, GroupHeaderSkeleton } from './GroupHeader';
import { defaultHub, loadHubChoice, saveHubChoice, settlePlan, summarize, type HubChoice, type PlanMode } from './groupMath';
import { groupPath } from './links';
import { SettingsTab } from './SettingsTab';
import { StatsTab } from './StatsTab';
import { useGroupSync } from './useGroupSync';
import s from './GroupPage.module.css';

export type GroupTab = 'expenses' | 'balances' | 'stats' | 'settings';

export function GroupPage({ gid, tab }: { gid: string; tab: GroupTab }) {
  const { t } = useT();
  const view = useGroupView(gid);
  const online = useStore(st => st.online);
  const [compact, setCompact] = useState(false);
  // The top bar's height when it sticks on its own: month headers stop under it.
  const [bandStick, setBandStick] = useState(0);
  useGroupSync(gid);

  const snap = view.snap;
  const summary = useMemo(() => (snap ? summarize(snap) : null), [snap]);

  // 集中還給… is remembered per group on this device; the other two modes are the group's setting.
  const [choice, setChoice] = useState<HubChoice>(() => loadHubChoice(gid));
  useEffect(() => setChoice(loadHubChoice(gid)), [gid]);

  const mode: PlanMode = choice.on ? 'hub' : snap?.group.simplify === false ? 'pairwise' : 'simplified';
  const hub = useMemo(() => {
    if (mode !== 'hub' || !snap || !summary) return null;
    const ok = choice.hub && snap.members.some(m => m.id === choice.hub && m.active);
    return ok ? choice.hub : defaultHub(snap, summary);
  }, [mode, snap, summary, choice.hub]);
  const plan = useMemo(() => (snap && summary ? settlePlan(snap, summary, mode, hub) : []), [snap, summary, mode, hub]);

  const planState: PlanState = {
    mode,
    hub,
    plan,
    setHubMode: on => {
      const next = { on, hub: on ? hub ?? choice.hub : choice.hub ?? hub };
      setChoice(next);
      saveHubChoice(gid, next);
    },
    setHub: id => {
      const next = { on: true, hub: id };
      setChoice(next);
      saveHubChoice(gid, next);
    },
  };

  // Waiting changes that move balances: a comment or a receipt photo moves none.
  const pendingIds = Object.keys(view.pending).filter(id => movesBalances(view.pending[id].op));
  const pendingCount = pendingIds.length;
  const pendingPayments = snap ? pendingIds.filter(id => snap.expenses.find(e => e.id === id)?.kind === 'payment').length : 0;

  if (!snap || !summary) {
    const back = '/groups';
    if (view.error?.code === 'not_found') {
      return (
        <div className={s.page}>
          <PageHeader back={back} title={t('找不到群組', 'Group not found')} />
          <div className={s.state}>
            <EmptyState
              icon="groups"
              title={t('找不到這個群組', 'We cannot find this group')}
              body={t('它可能已被刪除，或你已經不在這個群組裡。', 'It may have been deleted, or you are no longer in it.')}
              action={
                <Button variant="primary" onClick={() => navigate('/groups', { replace: true })}>
                  {t('回到群組', 'Back to groups')}
                </Button>
              }
            />
          </div>
        </div>
      );
    }
    if (view.error && !view.loading) {
      return (
        <div className={s.page}>
          <PageHeader back={back} title={t('群組', 'Group')} />
          <div className={s.state}>
            <EmptyState
              icon={view.error.code === 'offline' ? 'offline' : 'warning'}
              title={t('現在無法載入這個群組', 'This group cannot load right now')}
              body={errorMessage(view.error)}
              action={
                <Button variant="secondary" icon="sync" onClick={() => void actions.loadGroup(gid, { force: true })}>
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
        <GroupHeaderSkeleton back={back} />
        <div className={s.loadingRows}>
          {[0, 1, 2, 3].map(i => (
            <div key={i} className={s.loadingRow}>
              <Skeleton height={40} width={40} radius={20} />
              <span className={s.loadingText}>
                <Skeleton height={16} width="60%" />
                <Skeleton height={12} width="40%" />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Links (Tabs replaces the history entry on a tap, so Back leaves the group, not the tab).
  const tabs: { key: GroupTab; label: string; href: string }[] = [
    { key: 'expenses', label: t('費用', 'Expenses'), href: groupPath(gid) },
    { key: 'balances', label: t('結算', 'Balances'), href: groupPath(gid, 'balances') },
    { key: 'stats', label: t('統計', 'Stats'), href: groupPath(gid, 'stats') },
    { key: 'settings', label: t('設定', 'Settings'), href: groupPath(gid, 'settings') },
  ];

  return (
    <div
      className={cx(s.page, compact && s.compact)}
      style={bandStick > 0 ? ({ '--band-stick': bandStick + 'px' } as CSSProperties) : undefined}
    >
      <GroupHeader
        gid={gid}
        snap={snap}
        summary={summary}
        plan={plan}
        pendingCount={pendingCount}
        pendingPayments={pendingPayments}
        online={online}
        onCompact={setCompact}
        onBandStick={setBandStick}
      />

      <Tabs tabs={tabs} active={tab} label={t('群組內容', 'Group sections')} data-testid="group-tab" className={s.tabs} />

      <div className={s.body}>
        {tab === 'expenses' ? <ExpensesTab gid={gid} view={view} /> : null}
        {tab === 'balances' ? <BalancesTab gid={gid} view={view} summary={summary} planState={planState} /> : null}
        {tab === 'stats' ? <StatsTab gid={gid} view={view} /> : null}
        {tab === 'settings' ? <SettingsTab gid={gid} view={view} /> : null}
      </div>
    </div>
  );
}
