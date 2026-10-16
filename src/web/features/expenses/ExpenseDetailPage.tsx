// 費用明細 (#/g/<gid>/e/<eid>): the bill printed on a slip under the band (amount, what, when,
// who added it, the conversion), then who paid, each person's share (my line marked), notes,
// repeat, comments and the history. 編輯 / 複製這筆 / 刪除 (with 復原); a deleted entry shows a
// banner with 復原. Payments read 「A 付給 B」 with the same layout.

import { useEffect, useMemo, useRef, useState } from 'react';
import { entryNet, toBase } from '../../../shared/balances';
import { categoryLabel } from '../../../shared/categories';
import { nextOccurrence, todayISO } from '../../../shared/dates';
import type { ActivityDTO, CommentDTO, ExpenseDTO, GroupSnapshotDTO, MemberDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { CategoryIcon } from '../../components/CategoryIcon';
import { confirmDialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { Money } from '../../components/Money';
import { PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { Skeleton, Spinner } from '../../components/Spinner';
import { methodLabel, nameOf, zhJoin } from '../../lib/describe';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { actions, membersById, useGroupView, useStore, type GroupView } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { AmountText } from './AmountText';
import { formatRate, historyLines, shareOf } from './editorLogic';
import { addedByText, editedByText, historyText, repeatName } from './editorText';
import styles from './ExpenseDetailPage.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function ExpenseDetailPage({ gid, eid }: { gid: string; eid: string }) {
  const { t } = useT();
  const view = useGroupView(gid);
  useEffect(() => {
    void actions.loadGroup(gid);
  }, [gid]);

  const snap = view.snap;
  const expense = snap?.expenses.find(e => e.id === eid);

  if (!snap || !expense) {
    const waiting = !snap ? !view.error : view.loading;
    return (
      <div className={styles.page}>
        <PageHeader title={snap?.group.name ?? t('費用', 'Expense')} back={`/g/${gid}`} />
        {waiting ? (
          <div className={styles.loading} aria-busy="true">
            <Skeleton height={120} />
            <Skeleton height={56} />
            <Skeleton height={56} />
          </div>
        ) : (
          <div className={styles.empty}>
            <EmptyState
              icon="warning"
              title={t('找不到這筆費用', 'Expense not found')}
              body={
                view.error?.code === 'not_found' && !snap
                  ? t('這個群組可能已被刪除，或你不在這個群組。', 'The group may have been deleted, or you are not in it.')
                  : t('它可能已被移除，或還沒同步到這支手機。', 'It may have been removed, or has not synced to this device yet.')
              }
              action={
                <Button variant="secondary" href={`/g/${gid}`}>
                  {t('回到群組', 'Back to the group')}
                </Button>
              }
            />
          </div>
        )}
      </div>
    );
  }
  return <Detail key={eid} gid={gid} snap={snap} view={view} expense={expense} />;
}

interface ShownComment {
  id: string;
  body: string;
  authorName: string;
  userId: string | null;
  createdAt: string;
  pending: boolean;
}

function Detail({ gid, snap, view, expense: e }: { gid: string; snap: GroupSnapshotDTO; view: GroupView; expense: ExpenseDTO }) {
  const { t, zh, locale, money, date: fmtDate, relative } = useT();
  const me = useStore(s => s.me);
  const online = useStore(s => s.online);
  const myUserId = me?.user.id ?? '';
  const meId = snap.me.memberId;
  const members = useMemo(() => membersById(snap), [snap]);
  const groupCurrency = snap.group.currency;
  const payment = e.kind === 'payment';
  const foreign = e.currency !== groupCurrency;
  const deleted = !!e.deletedAt;
  const pending = view.pending[e.id];

  // ----- people and money -----
  const name = (id: string, lower = false) => nameOf(id, members, meId, { lower });
  const base = useMemo(() => toBase(e, groupCurrency), [e, groupCurrency]);
  const net = useMemo(() => entryNet(e, groupCurrency).get(meId) ?? 0, [e, groupCurrency, meId]);
  const involved = e.payers.some(p => p.memberId === meId) || e.shares.some(s => s.memberId === meId);

  const fromId = e.payers[0]?.memberId ?? '';
  const toId = e.shares[0]?.memberId ?? e.split.entries[0]?.memberId ?? '';
  const title = payment ? paymentTitle(name(fromId), name(toId, true), zh) : e.description || categoryLabel(e.category, locale);

  const author = (userId: string) => {
    if (userId && userId === myUserId) return t('你', 'you');
    return snap.members.find(m => m.userId === userId)?.name ?? t('有人', 'someone');
  };
  const added = addedByText(author(e.createdBy), relative(e.createdAt));
  const edited =
    e.updatedAt && Date.parse(e.updatedAt) - Date.parse(e.createdAt) > 60_000 ? editedByText(author(e.updatedBy), relative(e.updatedAt)) : null;

  // ----- comments: loaded from the server, plus the ones still waiting in the outbox -----
  const pendingList = view.pendingComments[e.id] ?? [];
  const [comments, setComments] = useState<CommentDTO[] | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Comments sent from here stay shown between leaving the outbox and the next reload.
  const sentRef = useRef(new Map<string, { id: string; body: string; createdAt: number }>());
  for (const p of pendingList) sentRef.current.set(p.id, p);
  const pendingKey = pendingList.map(p => p.id).join(',');

  useEffect(() => {
    let live = true;
    actions
      .loadComments(gid, e.id)
      .then(list => {
        if (!live) return;
        setComments(list);
        setCommentsError(null);
        for (const c of list) sentRef.current.delete(c.id);
      })
      .catch(err => {
        if (live) setCommentsError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [gid, e.id, e.commentCount, pendingKey]);

  const shownComments: ShownComment[] = useMemo(() => {
    const out: ShownComment[] = (comments ?? []).map(c => ({
      id: c.id,
      body: c.body,
      authorName: c.userId === myUserId ? t('你', 'You') : c.authorName,
      userId: c.userId,
      createdAt: c.createdAt,
      pending: false,
    }));
    const have = new Set(out.map(c => c.id));
    const waiting = new Set(pendingList.map(p => p.id));
    for (const p of [...sentRef.current.values()]) {
      if (have.has(p.id)) continue;
      out.push({ id: p.id, body: p.body, authorName: t('你', 'You'), userId: myUserId, createdAt: new Date(p.createdAt).toISOString(), pending: waiting.has(p.id) });
    }
    return out;
  }, [comments, pendingKey, myUserId, t]);

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    actions.addComment(gid, e.id, body.slice(0, 1000));
    setDraft('');
  };

  const removeComment = async (c: ShownComment) => {
    const ok = await confirmDialog({
      title: t('刪除這則留言？', 'Delete this comment?'),
      confirmLabel: t('刪除', 'Delete'),
      cancelLabel: t('取消', 'Cancel'),
      danger: true,
    });
    if (!ok) return;
    try {
      await actions.deleteComment(gid, c.id);
      setComments(list => (list ? list.filter(x => x.id !== c.id) : list));
      showToast({ message: t('已刪除留言', 'Comment deleted'), kind: 'success' });
    } catch (err) {
      showToast({ message: errorMessage(err), kind: 'error' });
    }
  };

  // ----- history -----
  const [history, setHistory] = useState<ActivityDTO[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    actions
      .loadHistory(gid, e.id)
      .then(items => {
        if (!live) return;
        setHistory(items);
        setHistoryError(null);
      })
      .catch(err => {
        if (live) setHistoryError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [gid, e.id, e.version, e.deletedAt]);
  const lines = useMemo(() => historyLines(history ?? []), [history]);
  const actorName = (l: { actorUserId: string | null; actorMemberId: string | null; actorName: string }) =>
    (l.actorUserId && l.actorUserId === myUserId) || (l.actorMemberId && l.actorMemberId === meId) ? t('你', 'You') : l.actorName;

  // ----- actions -----
  const label = payment ? title : e.description || categoryLabel(e.category, locale);
  const remove = async () => {
    const ok = await confirmDialog({
      title: payment ? t('刪除這筆付款？', 'Delete this payment?') : t('刪除這筆費用？', 'Delete this expense?'),
      message: t('刪除後大家的帳會重新計算，之後也可以復原。', 'Everyone\'s balances are recalculated. You can restore it later.'),
      confirmLabel: t('刪除', 'Delete'),
      cancelLabel: t('取消', 'Cancel'),
      danger: true,
    });
    if (!ok) return;
    actions.deleteExpense(gid, e.id);
    showToast({
      message: t('已刪除「{d}」', 'Deleted "{d}"', { d: label }),
      action: { label: t('復原', 'Undo'), run: () => actions.restoreExpense(gid, e.id) },
    });
  };
  const restore = () => {
    actions.restoreExpense(gid, e.id);
    showToast({ message: t('已復原「{d}」', 'Restored "{d}"', { d: label }), kind: 'success' });
  };

  // ----- the effect line on the slip -----
  let effect: { label: string; tone: string; amount: number | null };
  if (!involved) effect = { label: t('你沒參與', 'Not involved'), tone: 'mute', amount: null };
  else if (payment) {
    effect =
      net > 0
        ? { label: t('你付出', 'You sent'), tone: '', amount: net }
        : net < 0
          ? { label: t('你收到', 'You received'), tone: '', amount: -net }
          : { label: t('剛好平衡', 'Even'), tone: 'mute', amount: null };
  } else if (net > 0) effect = { label: t('你借出', 'You lent'), tone: 'pos', amount: net };
  else if (net < 0) effect = { label: t('你借入', 'You borrowed'), tone: 'neg', amount: -net };
  else effect = { label: t('剛好平衡', 'Even'), tone: 'mute', amount: null };

  const owedBase = (id: string) => base.owed.find(o => o.memberId === id)?.amount ?? 0;
  const paidBase = (id: string) => base.paid.find(p => p.memberId === id)?.amount ?? 0;
  const next = e.repeat !== 'none' && !deleted ? nextOccurrence(e.repeatStart ?? e.date, e.repeat, todayISO()) : null;
  const sharesSorted = [...e.shares].sort((a, b) => (a.memberId === meId ? -1 : b.memberId === meId ? 1 : 0));

  return (
    <div className={styles.page}>
      <PageHeader title={title} subtitle={snap.group.name} back={`/g/${gid}`} />

      <section className={styles.slipWrap} aria-labelledby="detail-title">
        <div className={cx(styles.slip, deleted && styles.slipDeleted)}>
          <div className={styles.what}>
            <CategoryIcon category={payment ? 'payment' : e.category} size={36} labelled={!payment} />
            <div className={styles.whatText}>
              <h2 id="detail-title" className={styles.title}>
                {title}
                {e.repeat !== 'none' ? <Icon name="repeat" size={14} className={styles.metaIc} title={repeatName(e.repeat)} /> : null}
              </h2>
              <p className={styles.sub}>
                <span>{fmtDate(e.date, 'mdw')}</span>
                {!payment ? <span>{categoryLabel(e.category, locale)}</span> : null}
              </p>
            </div>
          </div>

          <p className={styles.amountLine}>
            <span className={styles.amountLabel}>{payment ? t('付款金額', 'Amount paid') : t('總額', 'Total')}</span>
            <Money amount={e.amount} currency={e.currency} size="lg" className={styles.amount} data-testid="detail-amount" />
          </p>

          {foreign ? (
            <div className={styles.fx} data-testid="detail-fx">
              <p className={styles.lead}>
                <span className={styles.leadLabel}>{t('以 {c} 記入群組', 'Booked in {c}', { c: groupCurrency })}</span>
                <i className={styles.leader} aria-hidden="true" />
                <span className={cx('amt', styles.leadVal)}>
                  ≈ <AmountText text={money(base.total, groupCurrency)} />
                </span>
              </p>
              <p className={styles.foot}>
                <span className="amt">
                  1 {e.currency} = {formatRate(e.fxRate)} {groupCurrency}
                </span>
                <span>{t('原始金額 {a}', 'Original amount {a}', { a: money(e.amount, e.currency) })}</span>
              </p>
            </div>
          ) : null}

          <hr className={styles.dash} />
          <p className={cx(styles.lead, effect.tone)}>
            <span className={styles.leadLabel}>{effect.label}</span>
            <i className={styles.leader} aria-hidden="true" />
            {effect.amount !== null ? (
              <span className={cx('amt', styles.leadVal)}>
                <AmountText text={money(effect.amount, groupCurrency)} />
              </span>
            ) : null}
          </p>

          <p className={styles.foot}>
            <span>※ {added}</span>
            {edited ? <span>{edited}</span> : null}
          </p>

          {pending ? (
            <div className={cx(styles.sync, pending.state === 'failed' && styles.syncFailed)} role="status" data-testid="detail-sync">
              <Icon name={pending.state === 'failed' ? 'warning' : 'clock'} size={14} strokeWidth={2.2} />
              <span>
                {pending.state === 'failed'
                  ? t('同步失敗', 'Sync failed') + (pending.error?.message ? t('：{m}', ': {m}', { m: pending.error.message }) : '')
                  : online
                    ? t('等待同步', 'Waiting to sync')
                    : t('等待同步，連線後會自動送出', 'Waiting to sync. It goes out when you reconnect')}
              </span>
              {pending.state === 'failed' ? (
                <span className={styles.syncActions}>
                  <Button size="sm" variant="secondary" onClick={() => actions.retry(pending.itemId)} data-testid="detail-retry">
                    {t('重試', 'Retry')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => actions.discard(pending.itemId)} data-testid="detail-discard">
                    {t('放棄', 'Discard')}
                  </Button>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {deleted ? (
        <div className={styles.deleted} role="status">
          <Icon name="trash" size={18} />
          <span className={styles.deletedText}>
            {t('這筆已刪除，不會算進大家的帳。', 'This was deleted and no longer counts in balances.')}
          </span>
          <Button variant="secondary" size="sm" icon="restore" onClick={restore} data-testid="detail-restore">
            {t('復原', 'Restore')}
          </Button>
        </div>
      ) : (
        <div className={styles.actions}>
          <Button variant="secondary" icon="edit" href={`/g/${gid}/e/${e.id}/edit`} data-testid="detail-edit">
            {t('編輯', 'Edit')}
          </Button>
          {!payment ? (
            <Button variant="secondary" icon="copy" onClick={() => navigate(`/g/${gid}/add?from=${encodeURIComponent(e.id)}`)} data-testid="detail-duplicate">
              {t('複製這筆', 'Duplicate')}
            </Button>
          ) : null}
          <Button variant="danger-quiet" icon="trash" onClick={() => void remove()} data-testid="detail-delete">
            {t('刪除', 'Delete')}
          </Button>
        </div>
      )}

      <Section title={payment ? t('付款的人', 'Sent by') : e.payers.length > 1 ? t('付款人（{n} 人）', 'Paid by ({n})', { n: e.payers.length }) : t('付款人', 'Paid by')}>
        <ul className={styles.rows}>
          {e.payers.map(p => (
            <PersonRow
              key={p.memberId}
              member={members[p.memberId]}
              name={name(p.memberId)}
              me={p.memberId === meId}
              amount={p.amount}
              currency={e.currency}
              baseAmount={foreign ? paidBase(p.memberId) : null}
              groupCurrency={groupCurrency}
              verb={payment ? t('付出', 'sent') : t('付了', 'paid')}
              testId="payer-row"
            />
          ))}
        </ul>
      </Section>

      <Section
        title={payment ? t('收款的人', 'Received by') : t('每個人的份', 'Each person\'s share')}
        action={!payment ? <span className={styles.method}>{methodLabel(e.split.method)}</span> : undefined}
      >
        <ul className={styles.rows}>
          {sharesSorted.map(s => (
            <PersonRow
              key={s.memberId}
              member={members[s.memberId]}
              name={name(s.memberId)}
              me={s.memberId === meId}
              amount={shareOf(e.shares, s.memberId)}
              currency={e.currency}
              baseAmount={foreign ? owedBase(s.memberId) : null}
              groupCurrency={groupCurrency}
              verb={payment ? t('收到', 'received') : t('分到', 'owes')}
              detail={!payment ? splitDetail(e, s.memberId, money, t) : undefined}
              testId="share-row"
            />
          ))}
        </ul>
        {!payment && e.split.method === 'items' && e.split.items?.length ? (
          <ul className={styles.items} aria-label={t('品項', 'Items')}>
            {e.split.items.map(it => (
              <li key={it.id} className={styles.item}>
                <span className={styles.itemName}>{it.name || t('品項', 'Item')}</span>
                <span className={styles.itemWho}>{it.memberIds.map(id => name(id)).join(zh ? '、' : ', ')}</span>
                <span className={cx('amt', styles.itemAmount)}>
                  <AmountText text={money(it.amount, e.currency)} />
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {e.notes.trim() ? (
        <Section title={t('備註', 'Note')}>
          <p className={styles.notes}>{e.notes}</p>
        </Section>
      ) : null}

      {e.repeat !== 'none' ? (
        <Section title={t('重複', 'Repeat')}>
          <p className={styles.repeat}>
            <Icon name="repeat" size={18} />
            <span>
              {repeatName(e.repeat)}
              {next ? t('，下次 {d}', ', next on {d}', { d: fmtDate(next, 'mdw') }) : null}
            </span>
          </p>
        </Section>
      ) : null}

      <Section title={t('留言', 'Comments')}>
        {shownComments.length ? (
          <ul className={styles.comments}>
            {shownComments.map(c => (
              <li key={c.id} className={cx(styles.comment, c.pending && styles.commentPending)} data-testid="comment-item" data-id={c.id}>
                <div className={styles.commentHead}>
                  <b className={styles.commentAuthor}>{c.authorName}</b>
                  <span className={styles.commentTime}>{c.pending ? t('等待同步', 'Waiting to sync') : relative(c.createdAt)}</span>
                  {c.userId === myUserId && !c.pending && comments?.some(x => x.id === c.id) ? (
                    <IconButton icon="trash" label={t('刪除留言', 'Delete comment')} size={18} onClick={() => void removeComment(c)} className={styles.commentDelete} data-testid="comment-delete" />
                  ) : null}
                </div>
                <p className={styles.commentBody}>{c.body}</p>
              </li>
            ))}
          </ul>
        ) : comments === null && !commentsError ? (
          <div className={styles.inlineLoading}>
            <Spinner size={18} decorative />
          </div>
        ) : (
          <p className={styles.mute}>{commentsError && !online ? t('離線中，連線後會顯示留言。', 'Offline: comments show when you reconnect.') : t('還沒有留言。', 'No comments yet.')}</p>
        )}
        {commentsError && online ? <p className={styles.error}>{commentsError}</p> : null}
        <form
          className={styles.composer}
          onSubmit={ev => {
            ev.preventDefault();
            send();
          }}
        >
          <label className="sr-only" htmlFor="comment-input">
            {t('留言', 'Comment')}
          </label>
          <textarea
            id="comment-input"
            className={styles.commentInput}
            value={draft}
            onChange={ev => setDraft(ev.target.value)}
            onKeyDown={ev => {
              if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault();
                send();
              }
            }}
            rows={1}
            maxLength={1000}
            placeholder={t('寫點什麼，例如「收據在我這」', 'Write something, like "I have the receipt"')}
            autoComplete="off"
            data-testid="comment-input"
          />
          <Button type="submit" variant="primary" size="md" disabled={!draft.trim()} data-testid="comment-send">
            {t('送出', 'Send')}
          </Button>
        </form>
      </Section>

      <Section title={t('紀錄', 'History')}>
        {lines.length ? (
          <ol className={styles.history}>
            {lines.map(l => (
              <li key={l.key} className={styles.historyItem} data-testid="history-item">
                <span className={styles.historyText}>{historyText(l, actorName(l))}</span>
                <time className={styles.historyTime} dateTime={l.at}>
                  {relative(l.at)}
                </time>
              </li>
            ))}
          </ol>
        ) : history === null && !historyError ? (
          <div className={styles.inlineLoading}>
            <Spinner size={18} decorative />
          </div>
        ) : (
          <p className={styles.mute}>
            {historyError ? (online ? historyError : t('離線中，連線後會顯示紀錄。', 'Offline: the history shows when you reconnect.')) : t('還沒有紀錄。', 'No history yet.')}
          </p>
        )}
      </Section>
    </div>
  );
}

/** 「Leo 付給你」 / "Leo paid you" (no amount: the amount is printed big right under it). */
function paymentTitle(from: string, to: string, zh: boolean): string {
  if (!zh) return `${from} paid ${to}`;
  const sep = /^[A-Za-z0-9(]/.test(to) ? ' ' : '';
  return zhJoin(from, '付給') + sep + to;
}

/** What a person typed in for the split, shown under their name ("2 份", "30%", "+¥300"). */
function splitDetail(e: ExpenseDTO, memberId: string, money: (m: number, c: string) => string, t: ReturnType<typeof useT>['t']): string | undefined {
  const en = e.split.entries.find(x => x.memberId === memberId);
  switch (e.split.method) {
    case 'shares':
      return en?.value !== undefined ? t('{n} 份', '{n} shares', { n: en.value }) : undefined;
    case 'percent':
      return en?.value !== undefined ? `${en.value}%` : undefined;
    case 'adjust':
      if (!en?.value) return undefined;
      return en.value > 0 ? t('多付 {a}', '{a} extra', { a: money(en.value, e.currency) }) : t('少付 {a}', '{a} less', { a: money(-en.value, e.currency) });
    case 'items': {
      const n = (e.split.items ?? []).filter(it => it.memberIds.includes(memberId)).length;
      return n ? t('{n} 個品項', '{n} items', { n }) : undefined;
    }
    default:
      return undefined;
  }
}

function PersonRow({
  member,
  name,
  me,
  amount,
  currency,
  baseAmount,
  groupCurrency,
  verb,
  detail,
  testId,
}: {
  member: MemberDTO | undefined;
  name: string;
  me: boolean;
  amount: number;
  currency: string;
  baseAmount: number | null;
  groupCurrency: string;
  verb: string;
  detail?: string;
  testId: string;
}) {
  const { t, money } = useT();
  return (
    <li className={cx(styles.row, me && styles.rowMe)} data-testid={testId} data-id={member?.id} data-me={me ? 'true' : undefined}>
      <Avatar name={member?.name ?? name} color={member?.color ?? ''} size={36} ring={me} />
      <span className={styles.rowMain}>
        <span className={styles.rowName}>
          {name}
          {member && !member.active ? <small className={styles.removed}>{t('（已移除）', '(removed)')}</small> : null}
        </span>
        {detail ? <span className={styles.rowSub}>{detail}</span> : null}
      </span>
      <span className={styles.rowAmt}>
        <Money amount={amount} currency={currency} />
        {baseAmount !== null ? (
          <span className={cx('amt', styles.rowBase)}>
            ≈ <AmountText text={money(baseAmount, groupCurrency)} />
          </span>
        ) : null}
      </span>
    </li>
  );
}
