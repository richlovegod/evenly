// DateField: the day of an expense or payment. A date box that prints the day the app's way
// (formatDate 'mdw': 10/16（五） / Fri, Oct 16; the year too when it is not this year), with
// the native date input laid over it, so a tap opens the phone's own date picker; then the
// quick chips 今天 / 昨天. data-testid and other DOM props go to the native input (what a
// person types into); the chips get "<testid>-today" / "<testid>-yesterday".
// Dates stay inside what the server accepts: 2000-01-01 to a year from today.

import { useId, useRef, type InputHTMLAttributes, type MouseEvent } from 'react';
import { addDays, isISODate, todayISO } from '../../shared/dates';
import { useT } from '../lib/i18n';
import { Chip } from './Chip';
import { Icon } from './Icon';
import s from './DateField.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const MIN_DATE = '2000-01-01';

export interface DateFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'size'> {
  /** 'YYYY-MM-DD'. */
  value: string;
  onChange: (iso: string) => void;
  /** Shown above the box (default: 日期 / Date for screen readers only). */
  label?: string;
  /** One line under the box. */
  hint?: string;
  /** Earliest date (default 2000-01-01). */
  min?: string;
  /** Latest date (default a year from today). */
  max?: string;
  /** Leave out the 今天 / 昨天 chips. */
  hideQuick?: boolean;
  className?: string;
}

export function DateField({ value, onChange, label, hint, min, max, hideQuick, id, disabled, className, onClick, ...rest }: DateFieldProps) {
  const { t, date, zh } = useT();
  const auto = useId();
  const inputId = id ?? 'd' + auto;
  const hintId = inputId + '-hint';
  const input = useRef<HTMLInputElement>(null);

  const today = todayISO();
  const yesterday = addDays(today, -1);
  const lo = min ?? MIN_DATE;
  const hi = max ?? addDays(today, 365);
  const valid = isISODate(value);

  let shown = valid ? date(value, 'mdw') : t('選擇日期', 'Pick a date');
  if (valid && value.slice(0, 4) !== today.slice(0, 4)) {
    shown = zh ? `${value.slice(0, 4)}/${shown}` : `${shown}, ${value.slice(0, 4)}`;
  }

  const testId = (rest as Record<string, unknown>)['data-testid'];
  const chipId = (which: string) => (typeof testId === 'string' && testId ? `${testId}-${which}` : `date-${which}`);

  function pick(iso: string) {
    // The iOS picker's 清除 button sends an empty value; an entry always needs a date, so keep the old one.
    if (!isISODate(iso) || iso < lo || iso > hi) return;
    if (iso !== value) onChange(iso);
  }

  function openPicker(e: MouseEvent<HTMLInputElement>) {
    onClick?.(e);
    if (e.defaultPrevented) return;
    // With a mouse, a click on the text part of a date input only focuses it; open the calendar
    // instead. Touch browsers open their own picker on a tap already.
    const el = input.current;
    if (!el || typeof el.showPicker !== 'function' || !window.matchMedia('(pointer: fine)').matches) return;
    try {
      el.showPicker();
    } catch {
      /* not allowed here (for example inside a cross-origin frame): the field still takes typing */
    }
  }

  return (
    <div className={cx(s.field, disabled && s.disabled, className)}>
      <label htmlFor={inputId} className={label ? s.label : 'sr-only'}>{label ?? t('日期', 'Date')}</label>
      <div className={s.row}>
        <div className={s.box}>
          <Icon name="calendar" size={20} className={s.icon} />
          <span className={s.text} aria-hidden="true">{shown}</span>
          <Icon name="chevronDown" size={18} className={s.chev} />
          <input
            {...rest}
            ref={input}
            id={inputId}
            type="date"
            className={s.input}
            value={valid ? value : ''}
            min={lo}
            max={hi}
            disabled={disabled}
            aria-describedby={hint ? hintId : undefined}
            onChange={e => pick(e.target.value)}
            onClick={openPicker}
          />
        </div>
        {hideQuick ? null : (
          <div className={s.quick} role="group" aria-label={t('快速選擇日期', 'Quick dates')}>
            <Chip size="sm" label={t('今天', 'Today')} selected={value === today} disabled={disabled} onClick={() => pick(today)} data-testid={chipId('today')} />
            <Chip size="sm" label={t('昨天', 'Yesterday')} selected={value === yesterday} disabled={disabled} onClick={() => pick(yesterday)} data-testid={chipId('yesterday')} />
          </div>
        )}
      </div>
      {hint ? <p id={hintId} className={s.hint}>{hint}</p> : null}
    </div>
  );
}
