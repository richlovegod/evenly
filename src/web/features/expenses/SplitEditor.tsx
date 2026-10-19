// 分法: the split sheet. Six methods (平均 / 金額 / 比例 / 份數 / 加減 / 品項), each keeping what
// was typed for it, and every person's resulting share shown live (the page computes it with
// computeSharesFor, exactly as the server will store it).

import { useEffect, useRef, type JSX } from 'react';
import type { MemberDTO } from '../../../shared/types';
import { SPLIT_METHODS, type Portion } from '../../../shared/split';
import { getCurrency } from '../../../shared/currencies';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Sheet } from '../../components/Sheet';
import { zhJoin } from '../../lib/describe';
import { useT } from '../../lib/i18n';
import {
  exactSum,
  flipSign,
  itemsSum,
  nextItemId,
  percentSum,
  setIncluded,
  sharesSum,
  stepShares,
  toggleIncluded,
  withMethod,
  type ItemDraft,
  type SplitDraft,
} from './editorLogic';
import { methodHint, methodName, remainingText } from './editorText';
import { AmountText } from './AmountText';
import styles from './SplitEditor.module.css';

export interface SplitEditorProps {
  open: boolean;
  /** 取消, Escape, the scrim or a drag down: the page puts the split back as it was. */
  onClose: () => void;
  /** 完成: close and keep the split (defaults to onClose). */
  onDone?: () => void;
  members: readonly MemberDTO[];
  meId: string;
  currency: string;
  /** The entry total (minor units), or null while the amount is empty. */
  total: number | null;
  split: SplitDraft;
  onChange: (s: SplitDraft) => void;
  /** Each member's share as it will be stored (computeSharesFor). */
  shares: readonly Portion[];
  /** The split problem as a sentence, or null. */
  error: string | null;
  /** The field that cannot be read. */
  badMemberId?: string;
  badItemId?: string;
  /** Opened from this person's face: focus their field. */
  focusMemberId?: string;
}

export function SplitEditor(p: SplitEditorProps) {
  const { open, onClose, members, meId, currency, total, split, onChange, shares, error } = p;
  const { t, money } = useT();
  const wrapRef = useRef<HTMLDivElement>(null);

  // Opened from a face with an unequal split: put the caret in that person's field.
  useEffect(() => {
    if (!open || !p.focusMemberId) return;
    const timer = window.setTimeout(() => {
      const el = wrapRef.current?.querySelector<HTMLInputElement>(`[data-testid="split-value-${p.focusMemberId}"]`);
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [open, p.focusMemberId]);

  // The method tabs scroll when they do not fit (English at 320 px): an edge fades where methods
  // are hidden, and the chosen one is scrolled into view (a saved 品項 split opens on its tab).
  const tabsRef = useRef<HTMLDivElement>(null);
  const markTabs = () => {
    const el = tabsRef.current;
    if (!el) return;
    const more = el.scrollWidth - el.clientWidth;
    el.dataset.fade = more <= 1 ? '' : el.scrollLeft <= 1 ? 'end' : el.scrollLeft >= more - 1 ? 'start' : 'both';
  };
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    markTabs();
    void document.fonts?.ready.then(markTabs);
    el.addEventListener('scroll', markTabs, { passive: true });
    window.addEventListener('resize', markTabs);
    return () => {
      el.removeEventListener('scroll', markTabs);
      window.removeEventListener('resize', markTabs);
    };
  }, []);
  useEffect(() => {
    const el = tabsRef.current;
    const on = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!el || !on) return;
    const box = el.getBoundingClientRect();
    const tab = on.getBoundingClientRect();
    const clear = 32; // the width of the fade
    if (tab.left < box.left + clear) el.scrollLeft -= box.left + clear - tab.left;
    else if (tab.right > box.right - clear) el.scrollLeft += tab.right - (box.right - clear);
    markTabs();
  }, [split.method]);

  const ids = members.map(m => m.id);
  const shareOf = new Map(shares.map(s => [s.memberId, s.amount]));
  const name = (m: MemberDTO) => (m.id === meId ? t('你', 'You') : m.name);
  /** The checkbox's name: 「你有參與」「Abbie 有參與」, "You take part" / "Abbie takes part". */
  const takesPart = (m: MemberDTO) =>
    m.id === meId ? t('你有參與', 'You take part') : t(zhJoin(m.name, '有參與'), '{name} takes part', { name: m.name });
  const symbol = getCurrency(currency).symbol.trim();
  const inc = new Set(split.included);

  const setMap = (key: 'exact' | 'percent' | 'shares' | 'adjust', id: string, value: string) =>
    onChange({ ...split, [key]: { ...split[key], [id]: value } });

  const shareText = (id: string) => {
    const v = shareOf.get(id) ?? (total !== null ? 0 : null);
    return v !== null ? <AmountText text={money(v, currency)} /> : null;
  };

  /** The person's share at the right end of a row (rows without a field). */
  const shareCell = (id: string) => (
    <span className={`${styles.share} amt`} data-testid={`split-share-${id}`}>
      {shareText(id)}
    </span>
  );

  /**
   * Avatar and name. `withShare`: the share goes on a second line under the name, for rows
   * whose right side holds a field or a stepper, so the name keeps room on a 320 px phone.
   */
  const person = (m: MemberDTO, withShare = false) => (
    <>
      <Avatar name={m.name} color={m.color} userId={m.userId} avatar={m.avatar} size={32} ring={m.id === meId} />
      <span className={styles.name}>
        <span className={styles.nameText}>{name(m)}</span>
        {!m.active || withShare ? (
          <span className={styles.nameSub}>
            {!m.active ? <small className={styles.removed}>{t('已移除', 'removed')}</small> : null}
            {withShare ? (
              <span className={`${styles.shareLine} amt`} data-testid={`split-share-${m.id}`}>
                {shareText(m.id)}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </>
  );

  let body: JSX.Element;
  let status: JSX.Element | null = null;

  switch (split.method) {
    case 'equal': {
      body = (
        <>
          <div className={styles.tools}>
            <button type="button" className={styles.tool} onClick={() => onChange(setIncluded(split, ids, ids))} data-testid="split-all">
              {t('全選', 'Select all')}
            </button>
            <button type="button" className={styles.tool} onClick={() => onChange(setIncluded(split, [], ids))} data-testid="split-none">
              {t('全不選', 'Select none')}
            </button>
          </div>
          <ul className={styles.rows}>
            {members.map(m => (
              <li key={m.id}>
                <label className={`${styles.row} ${styles.pick}`}>
                  <span className={styles.box}>
                    <input
                      type="checkbox"
                      className={styles.check}
                      checked={inc.has(m.id)}
                      onChange={() => onChange(toggleIncluded(split, m.id, ids))}
                      aria-label={takesPart(m)}
                      data-testid={`split-check-${m.id}`}
                    />
                    <Icon name="check" size={15} strokeWidth={3.2} className={styles.tick} />
                  </span>
                  {person(m)}
                  {shareCell(m.id)}
                </label>
              </li>
            ))}
          </ul>
        </>
      );
      const n = split.included.filter(id => ids.includes(id)).length;
      status = <span>{t('{n} 人平均分', 'Split evenly among {n}', { n })}</span>;
      break;
    }

    case 'exact': {
      body = (
        <ul className={styles.rows}>
          {members.map(m => (
            <li key={m.id} className={styles.row}>
              {person(m)}
              <span className={`${styles.field} ${p.badMemberId === m.id ? styles.bad : ''}`}>
                <span className={styles.prefix} aria-hidden="true">{symbol}</span>
                <input
                  className={styles.input}
                  value={split.exact[m.id] ?? ''}
                  onChange={e => setMap('exact', m.id, e.target.value)}
                  inputMode="decimal"
                  enterKeyHint="next"
                  autoComplete="off"
                  placeholder="0"
                  aria-label={t('{name} 的金額', 'Amount for {name}', { name: name(m) })}
                  aria-invalid={p.badMemberId === m.id || undefined}
                  data-testid={`split-value-${m.id}`}
                />
              </span>
            </li>
          ))}
        </ul>
      );
      const sum = exactSum(split, ids, currency);
      // What is missing or over is said once, by the error line under the list.
      status = (
        <>
          <span>{t('已分 {amt}', 'Assigned {amt}', { amt: money(sum, currency) })}</span>
          {total !== null && (sum === total || !error) ? <b className={sum === total ? styles.ok : styles.off}>{remainingText(total - sum, currency)}</b> : null}
        </>
      );
      break;
    }

    case 'percent': {
      body = (
        <ul className={styles.rows}>
          {members.map(m => (
            <li key={m.id} className={styles.row}>
              {person(m, true)}
              <span className={`${styles.field} ${styles.narrow} ${p.badMemberId === m.id ? styles.bad : ''}`}>
                <input
                  className={styles.input}
                  value={split.percent[m.id] ?? ''}
                  onChange={e => setMap('percent', m.id, e.target.value)}
                  inputMode="decimal"
                  enterKeyHint="next"
                  autoComplete="off"
                  placeholder="0"
                  aria-label={t('{name} 的百分比', 'Percentage for {name}', { name: name(m) })}
                  aria-invalid={p.badMemberId === m.id || undefined}
                  data-testid={`split-value-${m.id}`}
                />
                <span className={styles.suffix} aria-hidden="true">%</span>
              </span>
            </li>
          ))}
        </ul>
      );
      const sum = percentSum(split, ids);
      const left = Math.round((100 - sum) * 1000) / 1000;
      status = (
        <>
          <span>{t('已分 {p}%', 'Assigned {p}%', { p: sum })}</span>
          {left === 0 || !error ? (
            <b className={left === 0 ? styles.ok : styles.off}>
              {left > 0 ? t('還差 {p}%', '{p}% left', { p: left }) : left < 0 ? t('多了 {p}%', '{p}% over', { p: -left }) : t('剛好 100%', 'Exactly 100%')}
            </b>
          ) : null}
        </>
      );
      break;
    }

    case 'shares': {
      body = (
        <ul className={styles.rows}>
          {members.map(m => {
            const raw = split.shares[m.id] ?? (inc.has(m.id) ? '1' : '0');
            return (
              <li key={m.id} className={styles.row}>
                {person(m, true)}
                <span className={`${styles.stepper} ${p.badMemberId === m.id ? styles.bad : ''}`}>
                  <button
                    type="button"
                    className={styles.step}
                    onClick={() => setMap('shares', m.id, stepShares(raw, -1))}
                    aria-label={t('{name} 少半份', 'Half a share less for {name}', { name: name(m) })}
                    data-testid={`split-dec-${m.id}`}
                  >
                    <Icon name="minus" size={18} strokeWidth={2.4} />
                  </button>
                  <input
                    className={`${styles.input} ${styles.count}`}
                    value={raw}
                    onChange={e => setMap('shares', m.id, e.target.value)}
                    onFocus={e => e.target.select()}
                    inputMode="decimal"
                    enterKeyHint="next"
                    autoComplete="off"
                    aria-label={t('{name} 的份數', 'Shares for {name}', { name: name(m) })}
                    aria-invalid={p.badMemberId === m.id || undefined}
                    data-testid={`split-value-${m.id}`}
                  />
                  <button
                    type="button"
                    className={styles.step}
                    onClick={() => setMap('shares', m.id, stepShares(raw, 1))}
                    aria-label={t('{name} 多半份', 'Half a share more for {name}', { name: name(m) })}
                    data-testid={`split-inc-${m.id}`}
                  >
                    <Icon name="plus" size={18} strokeWidth={2.4} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      );
      status = <span>{t('共 {n} 份', '{n} shares in all', { n: sharesSum(split, ids) })}</span>;
      break;
    }

    case 'adjust': {
      body = (
        <ul className={styles.rows}>
          {members.map(m => {
            const raw = split.adjust[m.id] ?? '';
            const neg = /^[-−－]/.test(raw.trim());
            const on = inc.has(m.id);
            return (
              <li key={m.id} className={`${styles.row} ${on ? '' : styles.out}`}>
                <span className={styles.box}>
                  <input
                    type="checkbox"
                    className={styles.check}
                    checked={on}
                    onChange={() => onChange(toggleIncluded(split, m.id, ids))}
                    aria-label={takesPart(m)}
                    data-testid={`split-check-${m.id}`}
                  />
                  <Icon name="check" size={15} strokeWidth={3.2} className={styles.tick} />
                </span>
                {person(m, on)}
                {on ? (
                  <span className={`${styles.field} ${styles.adjust} ${p.badMemberId === m.id ? styles.bad : ''}`}>
                    <button
                      type="button"
                      className={styles.sign}
                      onClick={() => setMap('adjust', m.id, flipSign(raw))}
                      aria-label={neg ? t('改成多付', 'Make it an extra') : t('改成少付', 'Make it a discount')}
                      data-testid={`split-sign-${m.id}`}
                    >
                      {neg ? '−' : '+'}
                    </button>
                    <input
                      className={styles.input}
                      value={raw.replace(/^[-−－+＋]\s*/, '')}
                      onChange={e => {
                        const v = e.target.value;
                        const typedSign = /^[-−－]/.test(v.trim());
                        setMap('adjust', m.id, typedSign || !neg ? v : '-' + v);
                      }}
                      inputMode="decimal"
                      enterKeyHint="next"
                      autoComplete="off"
                      placeholder="0"
                      aria-label={t('{name} 要加減的金額', 'Adjustment for {name}', { name: name(m) })}
                      aria-invalid={p.badMemberId === m.id || undefined}
                      data-testid={`split-value-${m.id}`}
                    />
                  </span>
                ) : (
                  <span className={styles.notIn}>{t('沒參與', 'Not in')}</span>
                )}
              </li>
            );
          })}
        </ul>
      );
      const n = split.included.filter(id => ids.includes(id)).length;
      status = <span>{t('其餘金額平均分給 {n} 人', 'The rest is split evenly among {n}', { n })}</span>;
      break;
    }

    case 'items': {
      const setItem = (id: string, patch: Partial<ItemDraft>) =>
        onChange({ ...split, items: split.items.map(it => (it.id === id ? { ...it, ...patch } : it)) });
      const removeItem = (id: string) => onChange({ ...split, items: split.items.filter(it => it.id !== id) });
      const addItem = () =>
        onChange({ ...split, items: [...split.items, { id: nextItemId(split.items), name: '', amountRaw: '', memberIds: [] }] });
      const sum = itemsSum(split, currency);
      const rest = total !== null ? total - sum : null;
      body = (
        <>
          <ol className={styles.items}>
            {split.items.map((it, i) => (
              <li key={it.id} className={`${styles.item} ${p.badItemId === it.id ? styles.badItem : ''}`}>
                <div className={styles.itemHead}>
                  <input
                    className={styles.itemName}
                    value={it.name}
                    onChange={e => setItem(it.id, { name: e.target.value })}
                    maxLength={60}
                    enterKeyHint="next"
                    autoComplete="off"
                    placeholder={t('品項 {n}', 'Item {n}', { n: i + 1 })}
                    aria-label={t('第 {n} 個品項的名稱', 'Name of item {n}', { n: i + 1 })}
                    data-testid={`item-name-${i}`}
                  />
                  <span className={`${styles.field} ${styles.itemAmount}`}>
                    <span className={styles.prefix} aria-hidden="true">{symbol}</span>
                    <input
                      className={styles.input}
                      value={it.amountRaw}
                      onChange={e => setItem(it.id, { amountRaw: e.target.value })}
                      inputMode="decimal"
                      enterKeyHint="next"
                      autoComplete="off"
                      placeholder="0"
                      aria-label={t('第 {n} 個品項的金額', 'Amount of item {n}', { n: i + 1 })}
                      data-testid={`item-amount-${i}`}
                    />
                  </span>
                  <button
                    type="button"
                    className={styles.remove}
                    onClick={() => removeItem(it.id)}
                    aria-label={t('刪除第 {n} 個品項', 'Remove item {n}', { n: i + 1 })}
                    data-testid={`item-remove-${i}`}
                  >
                    <Icon name="close" size={18} />
                  </button>
                </div>
                <div className={styles.itemPeople} role="group" aria-label={t('誰有份', 'Who had it')}>
                  {members.map(m => {
                    const onIt = it.memberIds.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className={styles.person}
                        aria-pressed={onIt}
                        onClick={() => setItem(it.id, { memberIds: ids.filter(x => (x === m.id ? !onIt : it.memberIds.includes(x))) })}
                        data-testid={`item-member-${i}-${m.id}`}
                      >
                        <span className={styles.personName}>{name(m)}</span>
                      </button>
                    );
                  })}
                  {it.memberIds.length === 0 && (it.amountRaw.trim() || it.name.trim()) ? (
                    <span className={styles.who}>{t('誰有份？', 'Who had it?')}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <button type="button" className={styles.addItem} onClick={addItem} data-testid="item-add">
            <Icon name="plus" size={18} strokeWidth={2.2} />
            {t('新增品項', 'Add an item')}
          </button>
          <div className={styles.rest} data-testid="items-rest">
            <p className={styles.lead}>
              <span>{t('品項合計', 'Items')}</span>
              <span className="amt">
                <AmountText text={money(sum, currency)} />
              </span>
            </p>
            {rest !== null ? (
              <p className={styles.lead}>
                <span>
                  {rest >= 0
                    ? t('其餘（稅、小費、服務費）依比例分攤', 'The rest (tax, tip, service) in proportion')
                    : t('折扣依比例扣除', 'Discount, taken off in proportion')}
                </span>
                <span className="amt">
                  <AmountText text={money(Math.abs(rest), currency)} />
                </span>
              </p>
            ) : null}
          </div>
          <ul className={styles.rows} aria-label={t('每個人的份', 'Each person pays')}>
            {members
              .filter(m => shareOf.has(m.id))
              .map(m => (
                <li key={m.id} className={styles.row}>
                  {person(m)}
                  {shareCell(m.id)}
                </li>
              ))}
          </ul>
        </>
      );
      break;
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('分法', 'Split')}
      size="full"
      footer={
        <button type="button" className={styles.done} onClick={p.onDone ?? onClose} data-testid="split-done">
          {t('完成', 'Done')}
        </button>
      }
    >
      <div ref={wrapRef} className={styles.wrap}>
        <div ref={tabsRef} className={styles.tabs} role="tablist" aria-label={t('分法', 'Split method')}>
          {SPLIT_METHODS.map(m => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={split.method === m}
              className={styles.tab}
              onClick={() => onChange(withMethod(split, m, ids))}
              data-testid={`split-method-${m}`}
            >
              {methodName(m)}
            </button>
          ))}
        </div>
        <p className={styles.hint}>{methodHint(split.method)}</p>
        <p className={styles.total}>
          {total !== null ? (
            <>
              <span>{t('總額', 'Total')}</span>
              <span className="amt">
                <AmountText text={money(total, currency)} />
              </span>
            </>
          ) : (
            <span>{t('還沒輸入金額，也可以先設定怎麼分。', 'No amount yet. You can set up the split first.')}</span>
          )}
        </p>
        {body}
        {status ? (
          <p className={styles.status} role="status" aria-live="polite">
            {status}
          </p>
        ) : null}
        {error ? (
          <p className={styles.error} role="alert" data-testid="split-error">
            <Icon name="warning" size={18} />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
