// One entry in a group's list (DESIGN.md 8.5, design/PICTUREBOOK.md): day, a round category
// circle, what it was and who paid, and on the right what it means for me (the money word over the
// amount, in the money color). No part: 你沒參與. Not synced yet: the row sits in a dashed sky
// outline; failed: a coral-tinted box with 重試 / 放棄. Payments read 「A 付給 B」 with 你收到 /
// 你付出 in ink. Refunds carry a 退款 tag, say 「Gino 收到退款 ¥30,000」, and on the right
// 你可以拿回 / 你要還.

import type { MouseEvent, ReactNode } from 'react';
import { entryNet, memberEffect, toBase } from '../../../shared/balances';
import { currencyName } from '../../../shared/currencies';
import { photosOf } from '../../../shared/receipts';
import type { ExpenseDTO, GroupSnapshotDTO, MemberDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { CategoryIcon } from '../../components/CategoryIcon';
import { confirmDialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { Money, MoneyStatus } from '../../components/Money';
import { ApiError, type ClientErrorCode } from '../../lib/api';
import { nameOf, paidLine, paymentLine, repeatLabel, zhJoin } from '../../lib/describe';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, membersById, type PendingInfo } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { cx } from './cx';
import { expensePath, linkTo } from './links';
import { count } from './plural';
import s from './ExpenseRow.module.css';

export type RowState = 'synced' | 'pending' | 'failed' | 'deleted';

export function rowState(e: ExpenseDTO, pending?: PendingInfo): RowState {
  if (pending?.state === 'failed') return 'failed';
  if (e.deletedAt) return 'deleted';
  if (pending) return 'pending';
  return 'synced';
}

/** What this entry means for me, in the currency the row's right column prints. */
export interface RowEffect {
  kind: 'expense' | 'payment' | 'refund';
  involved: boolean;
  /**
   * Expenses and refunds: my net (positive = I get money back), group currency. Payments: the
   * amount, its own currency.
   */
  amount: number;
  currency: string;
  /** Payments: I sent it. */
  sent: boolean;
}

export function rowEffect(e: ExpenseDTO, meId: string, groupCurrency: string): RowEffect {
  const eff = memberEffect(e, meId);
  if (e.kind === 'payment') {
    const sent = e.payers.some(p => p.memberId === meId);
    return { kind: 'payment', involved: eff.involved, amount: e.amount, currency: e.currency, sent };
  }
  const kind = e.kind === 'refund' ? 'refund' : 'expense';
  if (!eff.involved) return { kind, involved: false, amount: 0, currency: groupCurrency, sent: false };
  try {
    // In the group currency, like the balances it adds up to (a NT$ taxi in a yen trip shows ¥).
    return { kind, involved: true, amount: entryNet(e, groupCurrency).get(meId) ?? 0, currency: groupCurrency, sent: false };
  } catch {
    return { kind, involved: true, amount: eff.net, currency: e.currency, sent: false };
  }
}

/** The text the right column's amount prints, for sizing that column across a list. */
export function stubText(eff: RowEffect, money: (minor: number, currency: string) => string): string | null {
  if (!eff.involved) return null;
  if (eff.kind !== 'payment' && eff.amount === 0) return null;
  return money(Math.abs(eff.amount), eff.currency);
}

/**
 * The right column's width for a list, one value so the rows line up (DESIGN.md 8.5): the longest
 * amount at 16 px in the money font (M PLUS Rounded 1c: 0.65 em a digit, 0.36 a comma or a point,
 * 0.66 a currency glyph) plus 2 px; at least 60 px (88 in English, which fits 「You borrowed」).
 * The list uses it as the column's minimum: a row whose amount prints wider still gets its full
 * width, so an amount is never cut.
 */
export function stubWidth(texts: readonly (string | null)[], english: boolean): number {
  let w = english ? 88 : 60;
  for (const x of texts) {
    if (!x) continue;
    let em = 0;
    for (const ch of x.trim()) em += ch === ',' || ch === '.' ? 0.36 : ch >= '0' && ch <= '9' ? 0.65 : ch === ' ' ? 0.25 : 0.66;
    w = Math.max(w, Math.ceil(16 * em + 2));
  }
  return Math.min(w, 160);
}

/** 「Leo 付給你」 / "Leo paid you": the payment's title (the amount prints on the right). */
export function paymentTitle(e: ExpenseDTO, byId: Record<string, MemberDTO>, meId: string, t: (zh: string, en: string) => string): string {
  const from = e.payers[0]?.memberId ?? '';
  const to = e.shares[0]?.memberId ?? e.split.entries[0]?.memberId ?? '';
  const a = nameOf(from, byId, meId);
  const b = nameOf(to, byId, meId, { lower: true });
  return t(zhJoin(a, '付給') + (/^[A-Za-z0-9(]/.test(b) ? ' ' : '') + b, a + ' paid ' + b);
}

/**
 * The same title in parts, for the row: the names give way (ellipsis), 「付給」 / "paid" never
 * does, so a narrow row reads 「Tiff… paid you」, not 「Tiffany paid …」. The spaces a Latin name
 * needs are no-break spaces inside the verb (a plain one collapses at the edge of a flex item).
 */
function paymentTitleParts(
  e: ExpenseDTO,
  byId: Record<string, MemberDTO>,
  meId: string,
  zh: boolean,
): { from: string; verb: string; to: string; fromMe: boolean; toMe: boolean } {
  const fromId = e.payers[0]?.memberId ?? '';
  const toId = e.shares[0]?.memberId ?? e.split.entries[0]?.memberId ?? '';
  const from = nameOf(fromId, byId, meId);
  const to = nameOf(toId, byId, meId, { lower: true });
  // 你 / you also says the direction, so it never shrinks either; only the other name does.
  const me = { fromMe: fromId === meId, toMe: toId === meId };
  if (!zh) return { from, verb: NO_BREAK + 'paid' + NO_BREAK, to, ...me };
  return { from, verb: (/[A-Za-z0-9)]$/.test(from) ? NO_BREAK : '') + '付給' + (/^[A-Za-z0-9(]/.test(to) ? NO_BREAK : ''), to, ...me };
}

export interface ExpenseRowProps {
  expense: ExpenseDTO;
  snap: GroupSnapshotDTO;
  meId: string;
  pending?: PendingInfo;
  /**
   * How many receipt photos the entry shows, queued ones counted (lib/store.ts visiblePhotos);
   * without it, the stored ones (photosOf).
   */
  photos?: number;
  /** Instead of opening the expense page. */
  onClick?: () => void;
  /** Print the day number and weekday (the first row of a day). Default true. */
  showDate?: boolean;
  /** Draw the full-width rule that starts a new day. */
  firstOfDay?: boolean;
  /** Members by id, when the list already has them. */
  members?: Record<string, MemberDTO>;
  className?: string;
}

const NO_BREAK = String.fromCharCode(160);

export function ExpenseRow({ expense: e, snap, meId, pending, photos, onClick, showDate = true, firstOfDay = false, members, className }: ExpenseRowProps) {
  const { t, zh, money, date, locale } = useT();
  const photoCount = photos ?? photosOf(e).length;
  const byId = members ?? membersById(snap);
  const gid = snap.group.id;
  const base = snap.group.currency;
  const state = rowState(e, pending);
  const isPayment = e.kind === 'payment';
  const isRefund = e.kind === 'refund';
  const eff = rowEffect(e, meId, base);
  const note = e.notes.split('\n')[0]?.trim() ?? '';

  // Amounts spoken with the currency spelled out: 「12,600 日圓」 (English keeps the symbol).
  const spoken = (minor: number, cur: string) => (zh ? money(minor, cur, { bare: true }) + ' ' + currencyName(cur, locale) : money(minor, cur));

  // ----- title and the payer line -----
  let title: string;
  let sub: ReactNode = null;
  let saidLine: string;
  if (isPayment) {
    title = paymentTitle(e, byId, meId, t);
    if (note) sub = <span className={s.nm}>{note}</span>;
    else if (!eff.involved) sub = <Money amount={e.amount} currency={e.currency} tone="neutral" sign="never" size="sm" className={s.subAmt} />;
    saidLine = zh ? title + ' ' + spoken(e.amount, e.currency) : paymentLine(e, byId, meId);
  } else {
    title = e.description || t('（沒有說明）', '(no description)');
    // 「付了」 for an expense, 「收到退款」 / "got back" for a refund (who got the money back).
    const verbZh = isRefund ? '收到退款' : '付了';
    if (e.payers.length === 1) {
      const who = nameOf(e.payers[0].memberId, byId, meId);
      // 「Tiffany 付了」 keeps its space and 「你付了」 has none (zhJoin); a no-break space survives
      // at the start of a flex item, where a plain one would collapse.
      const verb = zh ? zhJoin(who, verbZh).slice(who.length).replace(' ', NO_BREAK) : NO_BREAK + (isRefund ? 'got' + NO_BREAK + 'back' : 'paid');
      sub = (
        <>
          <span className={s.who}>
            <span className={s.nm}>{who}</span>
            <span className={s.vb}>{verb}</span>
          </span>
          <Money amount={e.amount} currency={e.currency} tone="neutral" sign="never" size="sm" className={s.subAmt} />
        </>
      );
      saidLine = zh ? zhJoin(who, verbZh) + ' ' + spoken(e.amount, e.currency) : paidLine(e, byId, meId);
    } else {
      sub = (
        <>
          <span className={s.nm}>
            {isRefund ? t('{n} 人收到退款', '{n} people got back', { n: e.payers.length }) : t('{n} 人付了', '{n} people paid', { n: e.payers.length })}
          </span>
          <Money amount={e.amount} currency={e.currency} tone="neutral" sign="never" size="sm" className={s.subAmt} />
        </>
      );
      saidLine = zh ? e.payers.length + ' 人' + verbZh + ' ' + spoken(e.amount, e.currency) : paidLine(e, byId, meId);
    }
  }

  // ----- converted entries: 「≈ ¥11,400，12/16 匯率」, wraps, never truncates -----
  let fx: ReactNode = null;
  let fxSaid = '';
  if (e.currency !== base) {
    try {
      const total = toBase(e, base).total;
      fx = (
        <span className={s.fx}>
          {'≈ '}
          <Money amount={total} currency={base} tone="neutral" sign="never" size="sm" className={s.fxAmt} />
          {t('，{d} 匯率', ' at the {d} rate', { d: date(e.date, 'md') })}
        </span>
      );
      fxSaid = t('約 {a}', 'about {a}', { a: spoken(total, base) });
    } catch {
      fx = null;
    }
  }

  const syncChip =
    state === 'pending' ? (
      <span className={s.sync}>
        <Icon name="clock" size={13} strokeWidth={2.2} />
        {t('等待同步', 'Waiting to sync')}
      </span>
    ) : state === 'failed' ? (
      <span className={cx(s.sync, s.syncFailed)}>
        <Icon name="warning" size={13} strokeWidth={2.2} />
        {t('同步失敗', 'Sync failed')}
      </span>
    ) : null;

  // ----- what it means for me: the word over the amount -----
  let right: ReactNode;
  if (!eff.involved) {
    right = <MoneyStatus amount={0} currency={eff.currency} kind="rowEffect" involved={false} size="sm" className={s.none} />;
  } else if (isPayment) {
    right = <MoneyStatus amount={eff.sent ? eff.amount : -eff.amount} currency={eff.currency} kind="rowEffect" payment involved size="md" className={s.effect} />;
  } else if (eff.amount === 0) {
    right = <MoneyStatus amount={0} currency={eff.currency} kind="rowEffect" involved size="sm" className={s.none} />;
  } else {
    right = <MoneyStatus amount={eff.amount} currency={eff.currency} kind="rowEffect" refund={isRefund} involved size="md" className={s.effect} />;
  }

  // ----- one sentence for screen readers: 「12 月 18 日，燒肉晚餐，你付了 12,600 日圓，你借出 10,500 日圓」 -----
  const amt = spoken(Math.abs(eff.amount), eff.currency);
  const effectWords = !eff.involved
    ? t('你沒參與', 'not involved')
    : isPayment
      ? eff.sent
        ? t('你付出 {a}', 'you sent {a}', { a: amt })
        : t('你收到 {a}', 'you received {a}', { a: amt })
      : eff.amount > 0
        ? isRefund
          ? t('你可以拿回 {a}', 'you get back {a}', { a: amt })
          : t('你借出 {a}', 'you lent {a}', { a: amt })
        : eff.amount < 0
          ? isRefund
            ? t('你要還 {a}', 'you owe {a}', { a: amt })
            : t('你借入 {a}', 'you borrowed {a}', { a: amt })
          : t('剛好平衡', 'even');
  const stateWords =
    state === 'pending' ? t('等待同步', 'waiting to sync') : state === 'failed' ? t('同步失敗', 'sync failed') : state === 'deleted' ? t('已刪除', 'deleted') : '';
  const day = zh ? Number(e.date.slice(5, 7)) + ' 月 ' + Number(e.date.slice(8, 10)) + ' 日' : date(e.date, 'mdw');
  const extras = [
    e.repeat !== 'none' ? repeatLabel(e.repeat) : '',
    e.commentCount > 0 ? t('{n} 則留言', count(e.commentCount, 'comment', 'comments'), { n: e.commentCount }) : '',
    photoCount > 1 ? t('有 {n} 張收據照片', 'has {n} receipt photos', { n: photoCount }) : photoCount === 1 ? t('有收據照片', 'has a receipt photo') : '',
  ];
  const label = [day, isRefund ? t('退款', 'refund') : '', isPayment ? '' : title, saidLine, isPayment ? note : '', fxSaid, effectWords, ...extras, stateWords]
    .filter(Boolean)
    .join(t('，', ', '));

  const link = onClick
    ? {
        href: linkTo(expensePath(gid, e.id)).href,
        onClick: (ev: MouseEvent<HTMLElement>) => {
          ev.preventDefault();
          onClick();
        },
      }
    : linkTo(expensePath(gid, e.id));

  const weekday = zh ? date(e.date, 'weekday') : date(e.date, 'weekday').slice(0, 3);

  const retry = () => {
    if (pending) actions.retry(pending.itemId);
  };
  const discard = async () => {
    if (!pending) return;
    const ok = await confirmDialog({
      title: t('放棄這筆變更？', 'Discard this change?'),
      message: t('這筆還沒同步的變更會從這台裝置刪除，無法復原。', 'This unsynced change will be removed from this device. This cannot be undone.'),
      confirmLabel: t('放棄', 'Discard'),
      cancelLabel: t('保留', 'Keep'),
      danger: true,
    });
    if (ok) actions.discard(pending.itemId);
  };
  const restore = () => {
    actions.restoreExpense(gid, e.id);
    showToast({ message: t('已復原「{d}」', 'Restored "{d}"', { d: title }), kind: 'success' });
  };

  const failReason =
    state === 'failed' && pending?.error ? errorMessage(new ApiError(0, pending.error.code as ClientErrorCode, pending.error.message)) : '';

  // Expenses: the sync chip gets its own line under the payer line; payments: after the short method line.
  const chipInline = isPayment && !!syncChip;

  return (
    <li className={cx(s.item, className)}>
      <div
        className={cx(s.row, firstOfDay && s.first, state === 'pending' && s.pending, state === 'failed' && s.failed, state === 'deleted' && s.deleted)}
        data-testid="expense-row"
        data-id={e.id}
        data-state={state}
      >
        <a className={s.main} {...link} aria-label={label}>
          <span className={s.day} aria-hidden="true">
            {showDate ? (
              <>
                <b>{Number(e.date.slice(8, 10))}</b>
                <small>{weekday}</small>
              </>
            ) : null}
          </span>
          <span className={s.cat} aria-hidden="true">
            <CategoryIcon category={isPayment ? 'payment' : e.category} size={40} />
          </span>
          <span className={s.body} aria-hidden="true">
            <span className={s.title}>
              {isPayment ? (
                (() => {
                  const p = paymentTitleParts(e, byId, meId, zh);
                  return (
                    <span className={cx(s.titleText, s.titleParts)}>
                      <span className={p.fromMe ? s.titleKeep : s.titleName}>{p.from}</span>
                      <span className={s.titleKeep}>{p.verb}</span>
                      <span className={p.toMe ? s.titleKeep : s.titleName}>{p.to}</span>
                    </span>
                  );
                })()
              ) : (
                <>
                  {isRefund ? (
                    <span className={s.refundTag} data-testid="expense-row-refund">
                      {t('退款', 'Refund')}
                    </span>
                  ) : null}
                  <span className={s.titleText}>{title}</span>
                </>
              )}
              {e.repeat !== 'none' ? (
                <span className={s.meta}>
                  <Icon name="repeat" size={14} />
                </span>
              ) : null}
              {e.commentCount > 0 ? (
                <span className={s.meta}>
                  <Icon name="comment" size={14} />
                  <span className={s.metaN}>{e.commentCount}</span>
                </span>
              ) : null}
              {photoCount > 0 ? (
                <span className={s.meta} data-testid="expense-row-receipt" data-photos={photoCount}>
                  <Icon name="receipt" size={14} />
                </span>
              ) : null}
            </span>
            {sub || chipInline ? (
              <span className={s.sub}>
                {sub}
                {chipInline ? syncChip : null}
              </span>
            ) : null}
            {fx}
            {syncChip && !chipInline ? <span className={s.chipLine}>{syncChip}</span> : null}
          </span>
          <span className={s.total} aria-hidden="true">
            <Money amount={e.amount} currency={e.currency} tone="neutral" sign="never" />
          </span>
          <span className={s.right} aria-hidden="true">
            {state === 'deleted' ? null : right}
          </span>
        </a>
        {state === 'deleted' ? (
          <span className={s.restoreBox}>
            <span className={s.deletedK}>{t('已刪除', 'Deleted')}</span>
            <Button variant="secondary" size="sm" icon="undo" onClick={restore} data-testid="expense-restore">
              {t('復原', 'Restore')}
            </Button>
          </span>
        ) : null}
        {state === 'failed' ? (
          <div className={s.failBar} role="group" aria-label={t('同步失敗', 'Sync failed')}>
            {failReason ? <span className={s.failWhy}>{failReason}</span> : null}
            <span className={s.failActions}>
              <Button variant="secondary" size="sm" icon="sync" onClick={retry} data-testid="expense-retry">
                {t('重試', 'Retry')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void discard()} data-testid="expense-discard">
                {t('放棄', 'Discard')}
              </Button>
            </span>
          </div>
        ) : null}
      </div>
    </li>
  );
}
