// TextField: label, input (or textarea), and one line of hint or error. Drawn as the award
// site's .field: a paper box with a 3 px ink outline (radius 16), the label inside it at the
// top left in 12 px, the text under it; the box turns sky tint while focused, coral tint with
// an error. data-testid and other DOM props go to the <input> / <textarea> itself (what a
// person types into).

import { useId, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { useT } from '../lib/i18n';
import { Icon, type IconName } from './Icon';
import s from './TextField.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type' | 'size' | 'children' | 'id' | 'disabled'> {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url' | 'number' | 'date' | 'time';
  inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode'];
  autoComplete?: string;
  error?: string;
  hint?: string;
  maxLength?: number;
  autoFocus?: boolean;
  multiline?: boolean;
  rows?: number;
  /** Enter in a single-line field (not while an IME is composing); Cmd/Ctrl+Enter in a textarea. */
  onEnter?: () => void;
  id?: string;
  disabled?: boolean;
  /** Keep the label for screen readers only (e.g. a search box with a placeholder). */
  hideLabel?: boolean;
  /** An icon inside the box on the left (e.g. search). */
  leadingIcon?: IconName;
  /** A control inside the box on the right (a 44 px button fits). */
  trailing?: ReactNode;
  /** No gutter padding: the field fills its container exactly. */
  bare?: boolean;
  className?: string;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
  autoComplete,
  error,
  hint,
  maxLength,
  autoFocus,
  multiline,
  rows = 3,
  onEnter,
  id,
  disabled,
  hideLabel,
  leadingIcon,
  trailing,
  bare,
  className,
  enterKeyHint,
  onKeyDown,
  ...rest
}: TextFieldProps) {
  const { t } = useT();
  const auto = useId();
  const inputId = id ?? 'f' + auto;
  const msgId = inputId + '-msg';
  const [reveal, setReveal] = useState(false);
  const isPassword = type === 'password' && !multiline;
  const message = error || hint;
  const near = maxLength !== undefined && value.length >= Math.floor(maxLength * 0.8);

  function keyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (onEnter && e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      if (!multiline || e.metaKey || e.ctrlKey) {
        e.preventDefault();
        onEnter();
      }
    }
    (onKeyDown as ((ev: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void) | undefined)?.(e);
  }

  const shared = {
    id: inputId,
    className: s.input,
    value,
    placeholder,
    maxLength,
    autoFocus,
    disabled,
    autoComplete,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': message ? msgId : undefined,
    onKeyDown: keyDown,
  };

  const trail = isPassword ? (
    <button
      type="button"
      className={s.reveal}
      aria-label={reveal ? t('隱藏密碼', 'Hide password') : t('顯示密碼', 'Show password')}
      aria-pressed={reveal}
      onClick={() => setReveal(r => !r)}
    >
      <Icon name={reveal ? 'eyeOff' : 'eye'} size={22} />
    </button>
  ) : trailing;

  return (
    <div className={cx(s.field, bare && s.bare, error && s.invalid, disabled && s.disabled, hideLabel && s.noLabel, multiline && s.multi, leadingIcon && s.hasLead, trail ? s.hasTrail : undefined, className)}>
      <div className={s.box}>
        {leadingIcon ? <Icon name={leadingIcon} className={s.lead} size={20} /> : null}
        <div className={s.stack}>
          <label htmlFor={inputId} className={hideLabel ? 'sr-only' : s.label}>{label}</label>
          {multiline ? (
            <textarea
              {...(rest as unknown as TextareaHTMLAttributes<HTMLTextAreaElement>)}
              {...shared}
              rows={rows}
              enterKeyHint={enterKeyHint}
              onChange={e => onChange(e.target.value)}
            />
          ) : (
            <input
              {...rest}
              {...shared}
              type={isPassword && reveal ? 'text' : type}
              inputMode={inputMode}
              enterKeyHint={enterKeyHint ?? (onEnter ? 'done' : undefined)}
              onChange={e => onChange(e.target.value)}
            />
          )}
        </div>
        {trail ? <div className={s.trail}>{trail}</div> : null}
      </div>
      {message || near ? (
        <div className={s.foot}>
          {error ? (
            <p id={msgId} className={s.error} role="alert">
              <Icon name="warning" />
              <span>{error}</span>
            </p>
          ) : hint ? (
            <p id={msgId} className={s.hint}>{hint}</p>
          ) : null}
          {near && maxLength !== undefined ? (
            <span className={cx(s.count, value.length > maxLength && s.over)} aria-hidden="true">
              {value.length}/{maxLength}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
