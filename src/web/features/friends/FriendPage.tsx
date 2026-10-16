// A friend (#/f/<key>): the slip with what we owe each other per currency and per group (each
// group line opens that group), 新增費用 and 結清 on our 1:1 ledger when there is one, their
// payment details, and the 1:1 ledger's entries (DESIGN.md 8.4 Friend slip).

import { useEffect, useMemo, type CSSProperties } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { GroupAvatar } from '../../components/GroupAvatar';
import { Icon } from '../../components/Icon';
import { Money, MoneyStatus } from '../../components/Money';
import { PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { Skeleton } from '../../components/Spinner';
import { zhJoin } from '../../lib/describe';
import { useT } from '../../lib/i18n';
import { copyText } from '../../lib/share';
import { actions, membersById, useGroupView, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { ExpenseRow, rowEffect, stubText, stubWidth } from '../groups/ExpenseRow';
import { payLines } from '../groups/groupMath';
import { groupPath, linkTo, settlePath } from '../groups/links';
import { Dash, Leader, Slip, Stamp, usePrintFeed } from '../groups/Slip';
import { useGroupSync } from '../groups/useGroupSync';
import { dashboardView } from '../home/dashboard';
import { groupLabel } from './FriendRow';
import s from './FriendPage.module.css';

const MAX_ROWS = 30;

export function FriendPage({ friendKey }: { friendKey: string }) {
  const { t, locale, money } = useT();
  const me = useStore(st => st.me);
  const outbox = useStore(st => st.outbox);
  const cache = useStore(st => st.groups);

  useEffect(() => {
    void actions.loadMe();
  }, []);

  const dash = useMemo(() => (me ? dashboardView(me, outbox, cache) : null), [me, outbox, cache]);
  const friend = dash?.friends.find(f => f.key === friendKey) ?? null;
  const pairId = friend?.pairGroupId ?? null;
  const pair = useGroupView(pairId ?? undefined);
  useGroupSync(pairId);

  const groupsById = useMemo(() => new Map((dash?.groups ?? []).map(g => [g.id, g])), [dash]);
  const printKey = friend ? friend.balances.map(b => b.currency + ':' + b.amount).join(',') : '';
  const printing = usePrintFeed('f.' + friendKey, printKey);

  const pairSnap = pair.snap;
  const pairMembers = useMemo(() => membersById(pairSnap), [pairSnap]);
  const rows = useMemo(() => (pairSnap ? pairSnap.expenses.filter(e => !e.deletedAt || pair.pending[e.id]?.state === 'failed').slice(0, MAX_ROWS) : []), [pairSnap, pair.pending]);
  const stubW = useMemo(
    () => (pairSnap ? stubWidth(rows.map(e => stubText(rowEffect(e, pairSnap.me.memberId, pairSnap.group.currency), money)), locale === 'en') : 112),
    [rows, pairSnap, money, locale],
  );

  if (!dash) {
    return (
      <div className={s.page} aria-busy="true">
        <PageHeader back="/friends" title={t('朋友', 'Friend')} />
        <Slip label={t('載入中', 'Loading')}>
          <div className={s.slipSkel}>
            <Skeleton height={18} width="45%" />
            <Skeleton height={34} width="70%" />
          </div>
        </Slip>
      </div>
    );
  }

  if (!friend) {
    return (
      <div className={s.page}>
        <PageHeader back="/friends" title={t('朋友', 'Friend')} />
        <div className={s.state}>
          <EmptyState
            icon="friends"
            title={t('找不到這位朋友', 'We cannot find this friend')}
            body={t('你們可能已經沒有共同的群組了。', 'You may no longer share a group.')}
            action={
              <Button variant="primary" href="/friends">
                {t('回到朋友', 'Back to friends')}
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const name = friend.name;
  const lines = payLines(friend);
  const pairLine = pairId ? friend.groups.find(x => x.groupId === pairId) : undefined;
  const myPairMember = pairId ? groupsById.get(pairId)?.myMemberId : undefined;
  const pairAmount = pairLine?.amount ?? 0;
  const settleHref =
    pairId && pairLine && myPairMember && pairAmount !== 0
      ? pairAmount > 0
        ? settlePath(pairId, pairLine.memberId, myPairMember, pairAmount)
        : settlePath(pairId, myPairMember, pairLine.memberId, -pairAmount)
      : pairId
        ? settlePath(pairId)
        : null;
  const shared = friend.groups.length;
  const subtitle = shared === 1 ? groupLabel(groupsById.get(friend.groups[0].groupId), t) : t('{n} 個共同群組', '{n} groups together', { n: shared });

  const copy = async (text: string) => {
    const ok = await copyText(text);
    showToast({ message: ok ? t('已複製', 'Copied') : t('無法複製', 'Could not copy'), kind: ok ? 'success' : 'error' });
  };

  return (
    <div className={s.page}>
      <PageHeader back="/friends" leading={<Avatar name={name} color={friend.color} size={30} />} title={name} subtitle={subtitle} />

      <Slip printing={printing} testId="friend-totals" label={t('你和{n}的結餘', 'You and {n}', { n: name })}>
        {friend.balances.length ? (
          friend.balances.map(b => (
            <MoneyStatus key={b.currency} amount={b.amount} currency={b.currency} kind="friend" name={name} size="md" layout="split" className={s.totalLine} />
          ))
        ) : (
          <div className={s.settledLine}>
            <span className={s.settledK}>{t(zhJoin(name, '跟你'), name + ' and you')}</span>
            <Stamp label={t('已結清', 'Settled up')} land={printing} />
          </div>
        )}
        {friend.groups.length ? <Dash className={s.dash} /> : null}
        {friend.groups.map(x => {
          const g = groupsById.get(x.groupId);
          return (
            <a key={x.groupId} className={s.groupLine} {...linkTo(groupPath(x.groupId))}>
              {g ? <GroupAvatar emoji={g.emoji} color={g.color} name={g.name} size={22} settled={x.amount === 0} /> : null}
              <span className={s.groupName}>{groupLabel(g, t)}</span>
              <Leader />
              {x.amount !== 0 ? (
                <Money amount={Math.abs(x.amount)} currency={x.currency} tone={x.amount > 0 ? 'positive' : 'negative'} sign="never" className={s.groupAmt} />
              ) : (
                <span className={s.mute}>{t('已結清', 'Settled up')}</span>
              )}
              <Icon name="chevronRight" size={16} className={s.chev} />
            </a>
          );
        })}
      </Slip>

      {pairId ? (
        <div className={s.actions}>
          <Button variant={pairAmount !== 0 ? 'secondary' : 'primary'} icon="plus" href={'/g/' + encodeURIComponent(pairId) + '/add'} data-testid="friend-add-expense">
            {t('新增費用', 'Add expense')}
          </Button>
          {pairAmount !== 0 && settleHref ? (
            <Button variant="primary" href={settleHref} data-testid="friend-settle">
              {t('結清', 'Settle up')}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className={s.note}>
          {t('你們沒有兩人帳本；在共同的群組裡記帳和結清。', 'You have no 1:1 ledger; add and settle expenses in a group you share.')}
        </p>
      )}

      {lines.length ? (
        <Section title={t('{n} 的收款方式', 'How to pay {n}', { n: name })}>
          {lines.map(l => (
            <p className={s.payLine} key={l.label}>
              <b className={s.payK}>{l.label}</b>
              <span className={l.mono ? s.payVMono : s.payV}>{l.value}</span>
              <Button variant="secondary" size="sm" icon="copy" onClick={() => void copy(l.copy)} aria-label={t('複製{k}', 'Copy {k}', { k: l.label })}>
                {t('複製', 'Copy')}
              </Button>
            </p>
          ))}
        </Section>
      ) : null}

      {pairId ? (
        <Section
          flush
          title={t('兩人帳本', 'Friend ledger')}
          action={pairSnap ? <a {...linkTo(groupPath(pairId))}>{t('打開', 'Open')}</a> : undefined}
        >
          {!pairSnap ? (
            pair.loading || !pair.error ? (
              <div className={s.skel}>
                <Skeleton height={16} width="60%" />
                <Skeleton height={12} width="40%" />
              </div>
            ) : null
          ) : rows.length ? (
            <ul className={s.list} style={{ '--stub-w': stubW + 'px' } as CSSProperties}>
              {rows.map((e, i) => {
                const first = i === 0 || rows[i - 1].date !== e.date;
                return (
                  <ExpenseRow
                    key={e.id}
                    expense={e}
                    snap={pairSnap}
                    meId={pairSnap.me.memberId}
                    pending={pair.pending[e.id]}
                    showDate={first}
                    firstOfDay={first}
                    members={pairMembers}
                  />
                );
              })}
            </ul>
          ) : (
            <p className={s.empty}>{t('還沒有費用', 'No expenses yet')}</p>
          )}
          {pairSnap && pairSnap.expenses.filter(e => !e.deletedAt).length > rows.length ? (
            <a className={s.more} {...linkTo(groupPath(pairId))}>
              {t('看全部 {n} 筆', 'See all {n}', { n: pairSnap.expenses.filter(e => !e.deletedAt).length })}
              <Icon name="chevronRight" size={18} />
            </a>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
