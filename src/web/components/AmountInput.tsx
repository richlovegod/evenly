// AmountInput: a decimal amount in a currency, in M PLUS Rounded 1c 800; the currency code is an
// outlined pill on the left (sky when it is not the group's). The raw text goes back to the caller unchanged
// (calculator expressions allowed: "1200+350"); when it is an expression, "= <result>" shows
// under it, computed with parseAmount. data-testid goes to the <input>; the currency chip gets
// currencyTestId, or "<x>-currency" when the input's test id is "<x>-amount"
// (editor-amount gives editor-currency).

import { useId, useRef, type CSSProperties, type FocusEvent, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { currencyName, getCurrency } from '../../shared/currencies';
import { isExpression, parseAmount } from '../../shared/money';
import { useT } from '../lib/i18n';
import { Icon } from './Icon';
import { Money } from './Money';
import s from './AmountInput.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Width of the amount in em in M PLUS Rounded 1c 800 (digits 0.65 em, separators 0.33, other
 *  characters such as operators about 0.72; the prefix prints at 0.6 em), plus room for the
 *  caret, so the number can shrink to fit its line. */
function fitEm(text: string, symbol: string): number {
  let em = 0.3 + 0.4 * [...symbol].length;
  for (const ch of text) em += ch >= '0' && ch <= '9' ? 0.65 : ch === ',' || ch === '.' ? 0.33 : 0.72;
  return em;
}

export interface AmountInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size' | 'type' | 'children'> {
  /** What the person typed (not parsed). */
  value: string;
  onChange: (raw: string) => void;
  currency: string;
  /** Makes the currency a tappable chip (opens a picker). */
  onCurrencyClick?: () => void;
  autoFocus?: boolean;
  /** md: a boxed field; lg: 34 px; xl: 56 px, the amount being entered. */
  size?: 'md' | 'lg' | 'xl';
  error?: string;
  label?: string;
  /** One line under the amount (e.g. the converted total). */
  hint?: ReactNode;
  /** Fill the chip with sky: this currency is not the group's. */
  currencyForeign?: boolean;
  /** data-testid for the currency chip. */
  currencyTestId?: string;
  onEnter?: () => void;
  /** On blur, rewrite a plain number with separators ("12600" to "12,600"), DESIGN.md 9.1. Default true. */
  formatOnBlur?: boolean;
  /** No gutter padding: fills its container exactly. */
  bare?: boolean;
  className?: string;
}

export function AmountInput({
  value,
  onChange,
  currency,
  onCurrencyClick,
  autoFocus,
  size = 'md',
  error,
  label,
  hint,
  currencyForeign,
  currencyTestId,
  onEnter,
  formatOnBlur = true,
  bare,
  className,
  id,
  placeholder,
  enterKeyHint,
  onKeyDown,
  onBlur,
  ...rest
}: AmountInputProps) {
  const { t, locale, money } = useT();
  const auto = useId();
  const inputId = id ?? 'a' + auto;
  const msgId = inputId + '-msg';
  const ref = useRef<HTMLInputElement>(null);
  const c = getCurrency(currency);
  const shown = value || placeholder || '0';
  const expr = isExpression(value);
  const result = expr ? parseAmount(value, currency) : null;
  const testId = (rest as Record<string, unknown>)['data-testid'];
  const chipTestId = currencyTestId ?? (typeof testId === 'string' && testId.endsWith('-amount') ? testId.replace(/-amount$/, '-currency') : undefined);
  const fit = fitEm(shown, c.symbol);
  const message = error || hint;

  function keyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (onEnter && e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      onEnter();
    }
    onKeyDown?.(e);
  }

  function blur(e: FocusEvent<HTMLInputElement>) {
    if (formatOnBlur && value.trim() && !isExpression(value)) {
      const minor = parseAmount(value, currency);
      if (minor !== null) {
        const pretty = money(minor, currency, { bare: true });
        if (pretty !== value) onChange(pretty);
      }
    }
    onBlur?.(e);
  }

  return (
    <div className={cx(s.wrap, size === 'md' ? s.md : size === 'lg' ? s.lg : s.xl, bare && s.bare, error && s.invalid, className)}>
      {label ? <label htmlFor={inputId} className={s.label}>{label}</label> : null}
      <div className={s.line}>
        {onCurrencyClick ? (
          <button
            type="button"
            className={cx(s.chip, currencyForeign && s.foreign)}
            onClick={onCurrencyClick}
            aria-label={t('幣別：{name} {code}，點一下更換', 'Currency: {name} ({code}). Tap to change.', { name: currencyName(c.code, locale), code: c.code })}
            data-testid={chipTestId}
          >
            {c.code}
            <Icon name="chevronDown" />
          </button>
        ) : null}
        <div className={s.box} onClick={() => ref.current?.focus()}>
          <span className={s.text} style={{ '--fit': fit.toFixed(2) } as CSSProperties}>
            <span className={s.cur} aria-hidden="true">{c.symbol}</span>
            <span className={s.sizer} data-value={shown}>
              <input
                {...rest}
                ref={ref}
                id={inputId}
                className={s.input}
                type="text"
                inputMode="decimal"
                enterKeyHint={enterKeyHint ?? 'next'}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={autoFocus}
                size={1}
                value={value}
                placeholder={placeholder ?? '0'}
                aria-label={label ? undefined : rest['aria-label'] ?? t('金額（{code}）', 'Amount ({code})', { code: c.code })}
                aria-invalid={error ? true : undefined}
                aria-describedby={message ? msgId : undefined}
                onKeyDown={keyDown}
                onBlur={blur}
                onChange={e => onChange(e.target.value)}
              />
            </span>
          </span>
        </div>
      </div>
      {expr ? (
        <p className={s.result}>
          <span className={s.eq}>=</span>
          {result !== null ? <Money className={s.value} amount={result} currency={currency} /> : <span>{t('算式不完整', 'Incomplete')}</span>}
        </p>
      ) : null}
      {error ? (
        <p id={msgId} className={s.error} role="alert">
          <Icon name="warning" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={msgId} className={s.hint}>{hint}</p>
      ) : null}
    </div>
  );
}
