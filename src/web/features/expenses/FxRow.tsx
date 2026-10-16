// The exchange-rate lines on the receipt when an entry is paid in another currency:
// "以 JPY 記入群組 / 1 TWD = 4.75 JPY，10/15 匯率" on the left, "≈ ¥11,400" and 改匯率 on
// the right. The rate can be typed (a typed rate is kept); with no rate at all the input shows
// right away and saving waits for it.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import type { FxSource } from './editorLogic';
import { formatRate, parseRate } from './editorLogic';
import type { FxInfo } from './useFx';
import { AmountText } from './AmountText';
import styles from './FxRow.module.css';

export interface FxRowProps {
  currency: string;
  groupCurrency: string;
  /** The entry date (the rate is for this day). */
  date: string;
  fx: FxInfo;
  /** The rate in use and where it came from (editorLogic.effectiveRate). */
  rate: number | null;
  source: FxSource;
  /** The total converted to the group currency, or null. */
  converted: number | null;
  /** The typed rate ('' = none). */
  manual: string;
  onManualChange: (raw: string) => void;
  /** 用自動匯率: the typed rate is dropped and no longer carried forward for this group. */
  onReset?: () => void;
}

export function FxRow({ currency, groupCurrency, date, fx, rate, source, converted, manual, onManualChange, onReset }: FxRowProps) {
  const { t, money, date: fmtDate } = useT();
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** The text the input started with when 改匯率 was tapped over an automatic or saved rate. */
  const startText = useRef<string | null>(null);
  const noRate = rate === null && !manual.trim() && !fx.loading;
  const showInput = editing || noRate || (!!manual.trim() && parseRate(manual) === null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEdit = () => {
    if (!manual.trim() && rate !== null) {
      const text = formatRate(rate);
      startText.current = text;
      onManualChange(text);
    } else {
      startText.current = null;
    }
    setEditing(true);
  };
  const finish = () => {
    // Leaving the number as it was keeps the automatic (or saved) rate at full precision.
    if (startText.current !== null && manual.trim() === startText.current) onManualChange('');
    startText.current = null;
    setEditing(false);
  };

  let note: string;
  if (source === 'manual') note = t('，你輸入的匯率', ', the rate you typed');
  else if (source === 'stored') note = t('，儲存時的匯率', ', the rate it was saved with');
  else if (fx.rateDate) {
    const d = fmtDate(fx.rateDate, 'md');
    note = fx.stale ? t('，{d} 匯率（離線）', ' at the {d} rate (offline)', { d }) : t('，{d} 匯率', ' at the {d} rate', { d });
  } else note = '';

  return (
    <div className={styles.fx} data-testid="fx-row">
      <div className={styles.left}>
        <span>{t('以 {c} 記入群組', 'Booked in {c}', { c: groupCurrency })}</span>
        {showInput ? (
          <label className={styles.rateEdit}>
            <span className={styles.one}>1 {currency} =</span>
            <input
              ref={inputRef}
              className={styles.rateInput}
              value={manual}
              onChange={e => onManualChange(e.target.value)}
              onFocus={() => setEditing(true)}
              onBlur={finish}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  finish();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              placeholder={fx.rate !== null ? formatRate(fx.rate) : '0'}
              aria-label={t('匯率：1 {a} 等於多少 {b}', 'Exchange rate: 1 {a} in {b}', { a: currency, b: groupCurrency })}
              data-testid="fx-rate-input"
            />
            <span className={styles.one}>{groupCurrency}</span>
          </label>
        ) : fx.loading && rate === null ? (
          <span className={styles.loading}>{t('正在取得 {d} 的匯率…', 'Getting the {d} rate…', { d: fmtDate(date, 'md') })}</span>
        ) : rate !== null ? (
          <span>
            <span className="amt">
              1 {currency} = {formatRate(rate)} {groupCurrency}
            </span>
            {note}
          </span>
        ) : null}
        {noRate ? (
          <span className={styles.warn} role="status">
            {t('拿不到這天的匯率，輸入匯率就能儲存', 'No rate for this day. Type one to save')}
          </span>
        ) : null}
      </div>
      <div className={styles.right}>
        {converted !== null ? (
          <span className={`amt ${styles.converted}`} aria-label={t('約 {amt}', 'about {amt}', { amt: money(converted, groupCurrency) })}>
            ≈ <AmountText text={money(converted, groupCurrency)} />
          </span>
        ) : null}
        {showInput && !noRate ? (
          <span className={styles.actions} onPointerDown={e => e.preventDefault()} onMouseDown={e => e.preventDefault()}>
            {source === 'manual' && fx.rate !== null ? (
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  onManualChange('');
                  onReset?.();
                  setEditing(false);
                }}
                data-testid="fx-rate-auto"
              >
                {t('用自動匯率', 'Use the auto rate')}
              </button>
            ) : null}
            <button type="button" className={styles.link} onClick={finish} data-testid="fx-rate-done">
              {t('完成', 'Done')}
            </button>
          </span>
        ) : rate !== null ? (
          <button type="button" className={styles.link} onClick={startEdit} data-testid="fx-rate" aria-label={t('改匯率，現在 1 {a} = {r} {b}', 'Edit rate, now 1 {a} = {r} {b}', { a: currency, r: formatRate(rate), b: groupCurrency })}>
            {t('改匯率', 'Edit rate')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
