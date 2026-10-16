// The top of a group (DESIGN.md 8.1, 8.4): the printer band (back, ticket, name, currency, people,
// members, add) and the slip it prints: where I stand, who I settle with (each line is one tap to
// 結清), who is settled with me, and ※ notes about unsynced entries. Scrolled past the slip, a
// compact band and a one-line strip stay at the top (reference/group-scrolled.png).

import { useEffect, useRef, useState } from 'react';
import type { Transfer } from '../../../shared/settle';
import type { GroupSummary } from '../../../shared/summary';
import type { GroupSnapshotDTO } from '../../../shared/types';
import { Avatar, AvatarStack } from '../../components/Avatar';
import { GroupAvatar } from '../../components/GroupAvatar';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { Money, MoneyStatus } from '../../components/Money';
import { PageHeader, PageHeaderCode } from '../../components/PageHeader';
import { orderedMembers, zhJoin } from '../../lib/describe';
import { useT } from '../../lib/i18n';
import { back, navigate } from '../../lib/router';
import { cx } from './cx';
import { groupPath, linkTo, settlePath } from './links';
import { Dash, Foot, Lead, Leader, Slip, Stamp, usePrintFeed } from './Slip';
import { count } from './plural';
import { syncText, useLastSyncAt } from './sync';
import s from './GroupHeader.module.css';

const MAX_LINES = 3;
/** Compact band (48) plus the strip (39) plus a little: where sticky month headers stop. */
export const COMPACT_TOP = 96;

const LATIN_START = /^[A-Za-z0-9(]/;

export function GroupHeader({
  gid,
  snap,
  summary,
  plan,
  pendingCount,
  pendingPayments,
  online,
  onCompact,
}: {
  gid: string;
  snap: GroupSnapshotDTO;
  summary: GroupSummary;
  plan: readonly Transfer[];
  /** Unsynced changes that affect balances (they are counted in the numbers). */
  pendingCount: number;
  /** How many of those are payments (for 「含 1 筆等待同步的付款」). */
  pendingPayments: number;
  online: boolean;
  /** Told when the slip scrolls out (true) and back (false). */
  onCompact?: (compact: boolean) => void;
}) {
  const { t, date } = useT();
  const lastSync = useLastSyncAt();
  const g = snap.group;
  const meId = snap.me.memberId;
  const cur = g.currency;
  const byId = new Map(snap.members.map(m => [m.id, m]));
  const active = orderedMembers(snap.members, meId);
  const net = summary.net[meId] ?? 0;
  const backTo = g.type === 'pair' ? '/friends' : '/groups';

  // Dates the entries span, for trips: 「12/16～12/20」 / "Dec 16 to 20".
  const live = snap.expenses.filter(e => !e.deletedAt);
  let range = '';
  if (live.length && g.type === 'trip') {
    let lo = live[0].date;
    let hi = live[0].date;
    for (const e of live) {
      if (e.date < lo) lo = e.date;
      if (e.date > hi) hi = e.date;
    }
    const a = date(lo, 'md');
    const b = date(hi, 'md');
    const sameMonth = lo.slice(0, 7) === hi.slice(0, 7);
    range = lo === hi ? a : t(a + '～' + b, a + ' to ' + (sameMonth ? String(Number(hi.slice(8, 10))) : b));
  }
  const people = t('{n} 人', count(active.length, 'person', 'people'), { n: active.length });
  const meta = range ? t(people + '，' + range, people + ', ' + range) : people;

  // Who I settle with under the plan, largest first.
  const mine = plan.filter(tr => tr.from === meId || tr.to === meId).sort((a, b) => b.amount - a.amount);
  const withMe = new Set(mine.map(tr => (tr.from === meId ? tr.to : tr.from)));
  const settledWithMe = active.filter(m => m.id !== meId && !withMe.has(m.id));
  const nameOf = (id: string) => byId.get(id)?.name ?? t('（已移除）', '(removed)');
  const settledNames = (() => {
    const names = settledWithMe.map(m => m.name);
    if (names.length <= 3) return names.join(t('、', ', '));
    return t(names.slice(0, 2).join('、') + ' 等 {n} 人', names[0] + ', ' + names[1] + ' and {k} more', { n: names.length, k: names.length - 2 });
  })();

  const printKey = net + '|' + mine.map(tr => tr.from + '>' + tr.to + ':' + tr.amount).join(',');
  const printing = usePrintFeed('g.' + gid, printKey);
  const addPath = '/g/' + encodeURIComponent(gid) + '/add';

  // ----- compact band: when the slip has scrolled under the top of the screen -----
  const sentinel = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => {
        const out = !entry.isIntersecting && entry.boundingClientRect.top < COMPACT_TOP;
        setCompact(out);
      },
      { rootMargin: `-${COMPACT_TOP}px 0px 0px 0px`, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    onCompact?.(compact);
  }, [compact, onCompact]);

  const stack = (
    <a
      className={s.stack}
      {...linkTo(groupPath(gid, 'settings'))}
      aria-label={t('成員 {n} 人：{names}', count(active.length, 'member', 'members') + ': {names}', {
        n: active.length,
        names: active.map(m => (m.id === meId ? t('你', 'you') : m.name)).join(t('、', ', ')),
      })}
    >
      <AvatarStack people={active.map(m => ({ name: m.name, color: m.color, ring: m.id === meId }))} max={3} size={26} aria-hidden="true" />
    </a>
  );

  const many = (n: number, one: string, more: string) => n + ' ' + (n === 1 ? one : more);
  const pendingNote =
    pendingCount > 0
      ? pendingPayments === pendingCount
        ? t('※ 含 {n} 筆等待同步的付款', 'Note: includes ' + many(pendingCount, 'payment', 'payments') + ' waiting to sync.', { n: pendingCount })
        : pendingPayments === 0
          ? t('※ 含 {n} 筆等待同步的費用', 'Note: includes ' + many(pendingCount, 'expense', 'expenses') + ' waiting to sync.', { n: pendingCount })
          : t('※ 含 {n} 筆等待同步的變更', 'Note: includes ' + many(pendingCount, 'change', 'changes') + ' waiting to sync.', { n: pendingCount })
      : !online
        ? t('※ 離線中，顯示的是上次同步的資料', 'Note: offline, showing the last synced data.')
        : null;

  return (
    <>
      <PageHeader
        back={backTo}
        leading={<GroupAvatar emoji={g.emoji} color={g.color} name={g.name} size={28} settled={net === 0} className={s.bandTicket} />}
        title={
          <span className={s.title} data-testid="group-title">
            {g.name}
          </span>
        }
        subtitle={
          <>
            <PageHeaderCode>{cur}</PageHeaderCode>
            <span>{meta}</span>
          </>
        }
        actions={
          <span className={s.actions}>
            {stack}
            <IconButton icon="plus" label={t('新增費用', 'Add expense')} onClick={() => navigate(addPath)} data-testid="group-add-expense" />
          </span>
        }
      />

      <Slip printing={printing} testId="group-status" label={t('你在這個群組的結餘', 'Your balance in this group')}>
        {net !== 0 ? (
          <MoneyStatus amount={net} currency={cur} kind="groupMine" size="lg" className={s.status} />
        ) : (
          <div className={s.settledStatus}>
            <span className={s.statusK}>{t('你在這個群組', 'You in this group')}</span>
            <Stamp label={t('已結清', 'Settled up')} land={printing} />
          </div>
        )}

        {active.length <= 1 ? (
          <>
            <Dash className={s.dash} />
            <p className={s.lone}>
              {t('群組裡只有你，', 'Only you so far. ')}
              <a className={s.inlineLink} {...linkTo(groupPath(gid, 'settings'))}>
                {t('邀請朋友加入', 'Invite people')}
              </a>
            </p>
          </>
        ) : mine.length || settledWithMe.length ? (
          <>
            <Dash className={s.dash} />
            {mine.slice(0, MAX_LINES).map(tr => {
              const otherId = tr.from === meId ? tr.to : tr.from;
              const other = byId.get(otherId);
              const owesMe = tr.to === meId;
              const who = nameOf(otherId);
              const words = owesMe ? t(zhJoin(who, '欠你'), who + ' owes you') : t('你欠' + (LATIN_START.test(who) ? ' ' : '') + who, 'You owe ' + who);
              return (
                <a key={tr.from + '>' + tr.to} className={s.settleLine} {...linkTo(settlePath(gid, tr.from, tr.to, tr.amount))}>
                  <Avatar name={other?.name ?? '?'} color={other?.color ?? ''} size={26} className={s.lineAv} />
                  <span className={s.lineK}>{words}</span>
                  <Leader />
                  <Money amount={tr.amount} currency={cur} tone={owesMe ? 'positive' : 'negative'} sign="never" className={s.lineAmt} />
                  <span className={s.go}>
                    {t('結清', 'Settle')}
                    <Icon name="chevronRight" size={16} strokeWidth={2.2} />
                  </span>
                </a>
              );
            })}
            {mine.length > MAX_LINES ? (
              <a className={s.moreLine} {...linkTo(groupPath(gid, 'balances'))}>
                {t('另外 {n} 人', count(mine.length - MAX_LINES, 'more person', 'more people'), { n: mine.length - MAX_LINES })}
                <Icon name="chevronRight" size={16} />
              </a>
            ) : null}
            {settledWithMe.length ? (
              <Lead className={s.settledLead} label={settledNames} value={<span className={s.mute}>{t('跟你已結清', 'Settled up with you')}</span>} />
            ) : null}
          </>
        ) : null}

        {pendingNote ? <Foot right={pendingCount > 0 || !online ? syncText(lastSync) : undefined}>{pendingNote}</Foot> : null}
      </Slip>
      <div ref={sentinel} className={s.sentinel} aria-hidden="true" />

      {compact ? (
        <div className={s.compact}>
          <div className={s.compactBand}>
            <IconButton icon="back" label={t('返回', 'Back')} onClick={() => back(backTo)} className={s.compactBack} />
            <span className={s.compactTitle}>{g.name}</span>
            {stack}
          </div>
          <a className={s.stripWrap} {...linkTo(groupPath(gid, 'balances'))}>
            <span className={s.strip}>
              {net !== 0 ? (
                <>
                  {/* the same words as MoneyStatus 'groupMine' */}
                  <span className={s.stripK}>{net > 0 ? t('你可以拿回', 'You get back') : t('你欠', 'You owe')}</span>
                  <Leader />
                  <Money amount={Math.abs(net)} currency={cur} tone={net > 0 ? 'positive' : 'negative'} sign="never" className={s.stripAmt} />
                </>
              ) : (
                <>
                  <span className={cx(s.stripK, s.mute)}>{t('已結清', 'Settled up')}</span>
                  <Leader />
                </>
              )}
              <Icon name="chevronRight" size={18} className={s.stripChev} />
            </span>
          </a>
        </div>
      ) : null}
    </>
  );
}

/** The band and an empty slip while the group loads. */
export function GroupHeaderSkeleton({ back: backTo }: { back: string }) {
  const { t } = useT();
  return (
    <>
      <PageHeader back={backTo} title={<span className={cx(s.title, s.ghost)}>{t('載入中', 'Loading')}</span>} />
      <Slip label={t('載入中', 'Loading')}>
        <div className={s.ghostStatus}>
          <span className={cx(s.ghostBar, s.ghostLabel)} />
          <span className={cx(s.ghostBar, s.ghostAmt)} />
        </div>
      </Slip>
    </>
  );
}
