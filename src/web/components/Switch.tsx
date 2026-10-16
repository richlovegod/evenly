// Switch: a full-width settings row (label, optional one-line explanation, switch on the right).
// The row is one <button role="switch">, so a tap anywhere on it toggles.

import { useId, type ButtonHTMLAttributes } from 'react';
import s from './Switch.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onChange, label, description, disabled, className, ...rest }: SwitchProps) {
  const id = useId();
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={id + 't'}
      aria-describedby={description ? id + 'd' : undefined}
      disabled={disabled}
      className={cx(s.row, checked && s.on, className)}
      onClick={() => onChange(!checked)}
    >
      <span className={s.text}>
        <span id={id + 't'} className={s.title}>{label}</span>
        {description ? <span id={id + 'd'} className={s.desc}>{description}</span> : null}
      </span>
      <span className={s.track} aria-hidden="true" />
    </button>
  );
}
