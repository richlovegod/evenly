// 結算 tab: where everyone stands (with a one-line "why"), how to settle (one control: 最少筆數
// and 兩兩結清 are the group's 簡化債務 setting, the same one as on 設定; 集中還給… is a choice on
// this device only), one card per transfer with the receiver's payment details and 記錄還款 (its
// header tinted grass when the money comes to me, coral when I pay), 分享結算 for LINE, and
// 分享結算圖卡: the group's summary card as a picture, with the plan shown here (SettleCardSheet).

import { useMemo, useState } from 'react';
import type { Transfer } from '../../../shared/settle';
import type { GroupSummary } from '../../../shared/summary';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { MemberPicker } from '../../components/MemberPicker';
import { Money, MoneyStatus } from '../../components/Money';
import { Segmented } from '../../components/Segmented';
import { orderedMembers } from '../../lib/describe';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { copyText, shareOrCopy } from '../../lib/share';
import { actions, membersById, useStore, type GroupView } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { cx } from './cx';
import { payLines, paymentFlows, settleShareText, usableEntries, type PlanMode } from './groupMath';
import { linkTo, settlePath } from './links';
import { SettleCardSheet } from './SettleCardSheet';
import { Stamp } from './Slip';
import s from './BalancesTab.module.css';

export interface PlanState {
  mode: PlanMode;
  /** The person everyone settles with in 'hub' mode. */
  hub: string | null;
  plan: Transfer[];
  /** Switch to settling through one person (on this device only) or back to the group's setting. */
  setHubMode: (on: boolean) => void;
  setHub: (memberId: string) => void;
}

export function BalancesTab({ gid, view, summary, planState }: { gid: string; view: GroupView; summary: GroupSummary; planState: PlanState }) {
  const { t, zh, money } = useT();
  const online = useStore(st => st.online);
  const snap = view.snap;
  const [saving, setSaving] = useState(false);
  const [pickHub, setPickHub] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);

  const byId = useMemo(() => membersById(snap), [snap]);
  const flows = useMemo(() => (snap ? paymentFlows(usableEntries(snap.expenses, snap.group.currency), snap.group.currency) : { sent: {}, received: {} }), [snap]);

  if (!snap) return null;
  const meId = snap.me.memberId;
  const cur = snap.group.currency;
  const { mode, hub, plan } = planState;

  // Everyone who is in the group, plus people who left while still owed or owing; me first.
  const people = orderedMembers(snap.members, meId, true).filter(m => m.active || (summary.net[m.id] ?? 0) !== 0);
  const name = (id: string, lower = false) => (id === meId ? (lower ? t('你', 'you') : t('你', 'You')) : byId[id]?.name ?? t('（已移除）', '(removed)'));

  const why = (id: string): string => {
    const parts: string[] = [];
    const paid = summary.paid[id] ?? 0;
    const share = summary.share[id] ?? 0;
    const sent = flows.sent[id] ?? 0;
    const received = flows.received[id] ?? 0;
    if (paid) parts.push(t('付了 {a}', 'paid {a}', { a: money(paid, cur) }));
    if (share) parts.push(t('分到 {a}', 'share {a}', { a: money(share, cur) }));
    if (sent) parts.push(t('已還款 {a}', 'paid back {a}', { a: money(sent, cur) }));
    if (received) parts.push(t('收到還款 {a}', 'got back {a}', { a: money(received, cur) }));
    if (!parts.length) return t('還沒有費用', 'Nothing yet');
    const text = parts.join(t('，', ', '));
    return text.charAt(0).toUpperCase() + text.slice(1);
  };

  const setGroupSimplify = async (simplify: boolean) => {
    if (simplify === snap.group.simplify) return;
    if (!online) {
      showToast({ message: t('要連上網路才能改群組設定。', 'Connect to the internet to change group settings.'), kind: 'error' });
      return;
    }
    setSaving(true);
    try {
      await actions.updateGroup(gid, { simplify });
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const onMode = (m: PlanMode) => {
    if (m === 'hub') {
      planState.setHubMode(true);
      return;
    }
    planState.setHubMode(false);
    void setGroupSimplify(m === 'simplified');
  };

  const hubName = hub ? (hub === meId ? '你' : name(hub)) : '';
  // 最少筆數 and 兩兩結清 are the group's setting (everyone sees the same plan); offline it cannot
  // change, so the hint says why one of them is greyed out.
  const groupWide = online
    ? t('這是群組設定，所有人看到的建議都會跟著改。', 'This is a group setting: everyone sees the same plan.')
    : t('要連上網路才能更改這個群組設定。', 'Connect to the internet to change this group setting.');
  const modeHint =
    mode === 'hub' && hub
      ? t(
          '大家都跟' + zhPad(hubName) + '結清：欠錢的付給' + zhLead(hubName) + '，' + hubName + zhTrail(hubName) + '再付給該拿回錢的人。這個選擇只存在這台裝置上。',
          hub === meId
            ? 'Everyone settles with you: whoever owes pays you, and you pay whoever gets money back. This choice stays on this device.'
            : 'Everyone settles with ' + hubName + ': whoever owes pays ' + hubName + ', and ' + hubName + ' pays whoever gets money back. This choice stays on this device.',
        )
      : (mode === 'pairwise'
          ? t('只在一起分過帳的人之間結清，筆數可能比較多。', 'Settles only between people who shared expenses; it can take more transfers.')
          : t('用最少的轉帳筆數結清，每個人要付或拿回的總額不變。', 'The fewest transfers to settle everyone; nobody pays or gets back a different total.')) +
        (zh ? '' : ' ') +
        groupWide;

  const mine = plan.filter(tr => tr.from === meId || tr.to === meId);
  const others = plan.filter(tr => tr.from !== meId && tr.to !== meId);
  const ordered = [...mine, ...others];

  const share = async () => {
    const text = settleShareText(snap, plan);
    const r = await shareOrCopy({ title: t(snap.group.name + ' 結算', snap.group.name + ': settle up'), text });
    if (r === 'failed') showToast({ message: t('無法分享，請再試一次。', 'Could not share. Try again.'), kind: 'error' });
  };

  const copy = async (text: string) => {
    const ok = await copyText(text);
    showToast({ message: ok ? t('已複製', 'Copied') : t('無法複製', 'Could not copy'), kind: ok ? 'success' : 'error' });
  };

  const remind = async (tr: Transfer) => {
    const me = byId[meId];
    const details = me ? payLines(me).map(l => l.label + ' ' + l.value).join(t('、', ', ')) : '';
    const amt = money(tr.amount, cur);
    const who = name(tr.from);
    const zhText = '嗨' + zhLead(who) + '，' + snap.group.name + ' 還有 ' + amt + ' 要付給我。' + (details ? '收款方式：' + details : '');
    const enText = 'Hi ' + who + ', for ' + snap.group.name + ' you still owe me ' + amt + '.' + (details ? ' How to pay me: ' + details : '');
    await shareOrCopy({ text: t(zhText, enText) });
  };

  const activeMembers = orderedMembers(snap.members, meId);

  return (
    <div className={s.tab}>
      <section className={s.sec} aria-labelledby="bal-people">
        <h2 className={s.secH} id="bal-people">
          {t('每個人的結餘', 'Where everyone stands')}
        </h2>
        <ul className={s.people}>
          {people.map(m => {
            const net = summary.net[m.id] ?? 0;
            const isMe = m.id === meId;
            return (
              <li key={m.id} className={s.person} data-testid="balance-row" data-id={m.id}>
                <Avatar name={m.name} color={m.color} userId={m.userId} avatar={m.avatar} size={40} ring={isMe} />
                <span className={s.personMain}>
                  <span className={s.personName}>
                    {isMe ? t('你', 'You') : m.name}
                    {!m.active ? <span className={s.left}>{t('（已離開）', ' (left)')}</span> : null}
                  </span>
                  <span className={s.why}>{why(m.id)}</span>
                </span>
                {/* Plain 已結清 words here: a stamp on every settled person would shout. */}
                <MoneyStatus amount={net} currency={cur} kind={isMe ? 'groupMine' : 'member'} size="md" stamp={false} className={s.bal} />
              </li>
            );
          })}
        </ul>
      </section>

      <section className={s.sec} aria-labelledby="bal-plan">
        <div className={s.secHead}>
          <h2 className={s.secH} id="bal-plan">
            {t('怎麼結清', 'How to settle up')}
          </h2>
          <span className={s.secActions}>
            <Button variant="ghost" size="sm" icon="image" onClick={() => setCardOpen(true)} data-testid="share-card">
              {t('分享結算圖卡', 'Share card')}
            </Button>
            <Button variant="ghost" size="sm" icon="share" onClick={() => void share()} data-testid="share-summary">
              {t('分享結算', 'Share')}
            </Button>
          </span>
        </div>

        <div className={s.modes}>
          <Segmented<PlanMode>
            options={[
              // Offline (or while a change is being saved), the group's own setting cannot change;
              // leaving 集中還給 for it still works.
              { value: 'simplified', label: t('最少筆數', 'Fewest'), disabled: (!online || saving) && !snap.group.simplify },
              { value: 'pairwise', label: t('兩兩結清', 'Pair by pair'), disabled: (!online || saving) && snap.group.simplify },
              { value: 'hub', label: t('集中還給…', 'Through one…') },
            ]}
            value={mode}
            onChange={onMode}
            size="sm"
            bare
            label={t('結清方式', 'How to settle')}
            data-testid="plan-mode"
          />
          <p className={s.modeHint}>{modeHint}</p>
          {mode === 'hub' && hub ? (
            <button type="button" className={s.hubPick} onClick={() => setPickHub(true)} data-testid="plan-hub">
              <span className={s.hubK}>{t('集中還給', 'Settle through')}</span>
              <Avatar name={byId[hub]?.name ?? '?'} color={byId[hub]?.color ?? ''} userId={byId[hub]?.userId} avatar={byId[hub]?.avatar} size={26} ring={hub === meId} />
              <span className={s.hubName}>{name(hub)}</span>
              <Icon name="chevronDown" size={18} />
            </button>
          ) : null}
        </div>

        {ordered.length === 0 ? (
          <div className={s.settled}>
            <Stamp label={t('已結清', 'Settled up')} />
            <p className={s.settledText}>{t('大家都結清了，不用再轉帳。', 'Everyone is settled up. No transfers needed.')}</p>
          </div>
        ) : (
          <ul className={s.coupons}>
            {ordered.map(tr => {
              const involvesMe = tr.from === meId || tr.to === meId;
              const receiver = byId[tr.to];
              const lines = receiver ? payLines(receiver) : [];
              const tone = tr.to === meId ? 'positive' : tr.from === meId ? 'negative' : 'neutral';
              return (
                <li key={tr.from + '>' + tr.to} className={s.couponW}>
                  <div
                    className={cx(s.coupon, !involvesMe && s.others, tr.to === meId && s.toMe, tr.from === meId && s.fromMe)}
                    data-testid="transfer-row"
                    data-from={tr.from}
                    data-to={tr.to}
                  >
                    <div className={s.couponH}>
                      <span className={s.who2}>
                        <Avatar
                          name={byId[tr.from]?.name ?? '?'}
                          color={byId[tr.from]?.color ?? ''}
                          userId={byId[tr.from]?.userId}
                          avatar={byId[tr.from]?.avatar}
                          size={26}
                          ring={tr.from === meId}
                        />
                        <span className={cx(s.whoName, tr.from === meId && s.whoMe)}>{name(tr.from)}</span>
                        <span className={s.arrow} aria-hidden="true">
                          <Icon name="chevronRight" size={16} />
                        </span>
                        <span className="sr-only">{t('付給', 'pays')}</span>
                        <Avatar
                          name={byId[tr.to]?.name ?? '?'}
                          color={byId[tr.to]?.color ?? ''}
                          userId={byId[tr.to]?.userId}
                          avatar={byId[tr.to]?.avatar}
                          size={26}
                          ring={tr.to === meId}
                        />
                        <span className={cx(s.whoName, tr.to === meId && s.whoMe)}>{name(tr.to)}</span>
                      </span>
                      <Money amount={tr.amount} currency={cur} tone={tone} sign="never" className={s.couponAmt} />
                    </div>
                    <div className={s.couponBody}>
                      {lines.length ? (
                        <div className={s.payinfo}>
                          <span className={s.pk}>
                            {tr.to === meId
                              ? t('你的收款方式（{n} 會看到）', 'How to pay you ({n} sees this)', { n: name(tr.from) })
                              : t('{n} 的收款方式', 'How to pay {n}', { n: name(tr.to) })}
                          </span>
                          {lines.map(l => (
                            <p className={s.payLine} key={l.label}>
                              <b className={s.payK}>{l.label}</b>
                              <span className={cx(s.payV, l.mono && s.mono)}>{l.value}</span>
                              <Button variant="secondary" size="sm" icon="copy" onClick={() => void copy(l.copy)} aria-label={t('複製{k}', 'Copy {k}', { k: l.label })}>
                                {t('複製', 'Copy')}
                              </Button>
                            </p>
                          ))}
                        </div>
                      ) : tr.to === meId ? (
                        <p className={s.noInfo}>
                          {t('還沒有收款方式。', 'No payment details yet.')}{' '}
                          <a {...linkTo('/account')} className={s.inlineLink}>
                            {t('到「我的」加上 Venmo、PayPal 或轉帳資訊', 'Add Venmo, PayPal or bank details on Account')}
                          </a>
                        </p>
                      ) : null}
                      <div className={s.couponA}>
                        {tr.to === meId ? (
                          <Button variant="secondary" icon="share" onClick={() => void remind(tr)} className={s.remind}>
                            <span className={s.remindText}>{t('提醒' + zhLead(name(tr.from)), 'Remind ' + name(tr.from))}</span>
                          </Button>
                        ) : null}
                        <a
                          {...linkTo(settlePath(gid, tr.from, tr.to, tr.amount))}
                          className={cx(s.settleBtn, involvesMe ? s.settlePrimary : s.settleSecondary)}
                          data-testid="transfer-settle"
                        >
                          {t('記錄還款', 'Record a payment')}
                        </a>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {cardOpen ? <SettleCardSheet snap={snap} plan={plan} onClose={() => setCardOpen(false)} /> : null}

      <MemberPicker
        open={pickHub}
        onClose={() => setPickHub(false)}
        title={t('大家都跟誰結清？', 'Who should everyone settle with?')}
        members={activeMembers}
        value={hub ?? undefined}
        meId={meId}
        onSelect={(id: string) => {
          planState.setHub(id);
          setPickHub(false);
        }}
      />
    </div>
  );
}

const LATIN_START = /^[A-Za-z0-9(]/;
const LATIN_END = /[A-Za-z0-9)]$/;

/** A name inside Chinese text: spaces around a Latin name only ("跟 Gino 結清", "跟佳穎結清"). */
function zhPad(n: string): string {
  return (LATIN_START.test(n) ? ' ' : '') + n + (LATIN_END.test(n) ? ' ' : '');
}

/** A name after Chinese text and before punctuation ("付給 Gino，"). */
function zhLead(n: string): string {
  return (LATIN_START.test(n) ? ' ' : '') + n;
}

/** The space after a Latin name when Chinese text follows ("Gino 再付給"). */
function zhTrail(n: string): string {
  return LATIN_END.test(n) ? ' ' : '';
}
