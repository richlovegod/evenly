// 付款人: a sheet listing every member (tap one: that person paid it all) and 多人付款, where
// each person's amount is typed and what is still missing or over shows as you type.

import { useEffect, useState } from 'react';
import type { MemberDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Sheet } from '../../components/Sheet';
import { getCurrency } from '../../../shared/currencies';
import { useT } from '../../lib/i18n';
import { sumTypedMoney, type EditorDraft, type PayerMode } from './editorLogic';
import { remainingText } from './editorText';
import styles from './PayersEditor.module.css';

export type PayersPatch = Partial<Pick<EditorDraft, 'payerMode' | 'payerId' | 'payerAmounts'>>;

export interface PayersEditorProps {
  open: boolean;
  /** 取消, Escape, the scrim or a drag down: the page puts the payers back as they were. */
  onClose: () => void;
  /** 完成, or tapping one person: close and keep the change (defaults to onClose). */
  onDone?: () => void;
  members: readonly MemberDTO[];
  meId: string;
  currency: string;
  /** The entry total (minor units), or null while the amount is empty. */
  total: number | null;
  mode: PayerMode;
  payerId: string;
  amounts: Record<string, string>;
  onChange: (patch: PayersPatch) => void;
  /** A refund: the payers are who got the money back, and the sheet says so (誰收到退款). */
  refund?: boolean;
}

export function PayersEditor({ open, onClose, onDone, members, meId, currency, total, mode, payerId, amounts, onChange, refund = false }: PayersEditorProps) {
  const { t, money } = useT();
  const w = refund
    ? {
        title: t('誰收到退款', 'Who got the money back'),
        list: t('收到退款的人', 'Got the money back'),
        one: t('只有一個人收到', 'One person got it'),
        multi: t('多人收到', 'Several people got it'),
        multiSub: t('輸入每個人收到多少', 'Type what each person got back'),
        hint: (amt: string) => t('輸入每個人收到多少，加起來要等於 {amt}。', 'Type what each person got back. It must add up to {amt}.', { amt }),
        first: t('先輸入總金額，再輸入每個人收到多少。', 'Enter the total first, then what each person got back.'),
        field: (who: string) => t('{name} 收到多少', 'How much {name} got back', { name: who }),
      }
    : {
        title: t('誰付的錢', 'Who paid'),
        list: t('付款人', 'Paid by'),
        one: t('只有一個人付', 'One person paid'),
        multi: t('多人付款', 'Several people paid'),
        multiSub: t('輸入每個人付了多少', 'Type what each person paid'),
        hint: (amt: string) => t('輸入每個人付了多少，加起來要等於 {amt}。', 'Type what each person paid. It must add up to {amt}.', { amt }),
        first: t('先輸入總金額，再輸入每個人付了多少。', 'Enter the total first, then what each person paid.'),
        field: (who: string) => t('{name} 付了多少', 'How much {name} paid', { name: who }),
      };
  const [view, setView] = useState<'list' | 'multi'>(mode === 'multi' ? 'multi' : 'list');
  const done = onDone ?? onClose;

  // Each time the sheet opens it shows the current mode; switching views inside it is local.
  useEffect(() => {
    if (open) setView(mode === 'multi' ? 'multi' : 'list');
  }, [open]); // only when it opens

  const ids = members.map(m => m.id);
  const name = (m: MemberDTO) => (m.id === meId ? t('你', 'You') : m.name);
  const sum = sumTypedMoney(amounts, ids, currency);
  const diff = total !== null ? total - sum : null;
  const symbol = getCurrency(currency).symbol.trim();

  // Tapping a person is the choice itself, so it keeps the change and closes.
  const pick = (id: string) => {
    onChange({ payerMode: 'single', payerId: id });
    done();
  };

  const toMulti = () => {
    setView('multi');
    onChange({ payerMode: 'multi' });
  };

  const toSingle = () => {
    setView('list');
    onChange({ payerMode: 'single' });
  };

  const footer =
    view === 'multi' ? (
      <div className={styles.footer}>
        <button type="button" className={styles.ghost} onClick={toSingle} data-testid="payer-single">
          {w.one}
        </button>
        <button type="button" className={styles.done} onClick={done} data-testid="payer-done">
          {t('完成', 'Done')}
        </button>
      </div>
    ) : undefined;

  return (
    <Sheet open={open} onClose={onClose} title={w.title} footer={footer}>
      {view === 'list' ? (
        <ul className={styles.list} role="radiogroup" aria-label={w.list}>
          {members.map(m => {
            const on = mode === 'single' && payerId === m.id;
            return (
              <li key={m.id} role="none">
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={styles.option}
                  onClick={() => pick(m.id)}
                  data-testid={`payer-option-${m.id}`}
                >
                  <Avatar name={m.name} color={m.color} userId={m.userId} avatar={m.avatar} size={36} ring={m.id === meId} />
                  <span className={styles.name}>
                    {name(m)}
                    {!m.active ? <small className={styles.removed}>{t('（已移除）', '(removed)')}</small> : null}
                  </span>
                  {on ? <Icon name="check" size={22} strokeWidth={2.4} className={styles.check} /> : null}
                </button>
              </li>
            );
          })}
          <li role="none">
            <button type="button" role="radio" aria-checked={mode === 'multi'} className={styles.option} onClick={toMulti} data-testid="payer-multi">
              <span className={styles.multiIcon} aria-hidden="true">
                <Icon name="users" size={22} />
              </span>
              <span className={styles.name}>
                {w.multi}
                <small className={styles.sub}>{w.multiSub}</small>
              </span>
              {mode === 'multi' ? <Icon name="check" size={22} strokeWidth={2.4} className={styles.check} /> : null}
            </button>
          </li>
        </ul>
      ) : (
        <div className={styles.multi}>
          <p className={styles.hint}>
            {total !== null
              ? w.hint(money(total, currency))
              : w.first}
          </p>
          <ul className={styles.rows}>
            {members.map(m => (
              <li key={m.id} className={styles.row}>
                <Avatar name={m.name} color={m.color} userId={m.userId} avatar={m.avatar} size={32} ring={m.id === meId} />
                <label className={styles.rowName} htmlFor={`payer-value-${m.id}`}>
                  {name(m)}
                </label>
                <span className={styles.field}>
                  <span className={styles.prefix} aria-hidden="true">{symbol}</span>
                  <input
                    id={`payer-value-${m.id}`}
                    className={styles.input}
                    value={amounts[m.id] ?? ''}
                    onChange={e => onChange({ payerAmounts: { ...amounts, [m.id]: e.target.value } })}
                    inputMode="decimal"
                    enterKeyHint="next"
                    autoComplete="off"
                    placeholder="0"
                    aria-label={w.field(name(m))}
                    data-testid={`payer-value-${m.id}`}
                  />
                </span>
              </li>
            ))}
          </ul>
          <p
            className={`${styles.status} ${diff === 0 ? styles.ok : diff !== null ? styles.off : ''}`}
            role="status"
            aria-live="polite"
            data-testid="payer-remaining"
          >
            <span>{t('已輸入 {amt}', 'Entered {amt}', { amt: money(sum, currency) })}</span>
            {diff !== null ? <b>{remainingText(diff, currency)}</b> : null}
          </p>
        </div>
      )}
    </Sheet>
  );
}
