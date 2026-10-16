// Segmented: pick one of a few options (a radiogroup; arrow keys move the choice).
// Test ids: each option gets option.testId, or `${data-testid}-${value}` when the control
// itself has a data-testid (data-testid="split-method" gives split-method-equal, ...).

import { useRef, type HTMLAttributes, type KeyboardEvent } from 'react';
import { Icon, type IconName } from './Icon';
import s from './Segmented.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  /** data-testid for this option. */
  testId?: string;
  'data-testid'?: string;
}

export interface SegmentedProps<T extends string> extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  /** Accessible name of the group (e.g. 分法 / Split). */
  label?: string;
  /** No gutter margin: the control fills its container exactly. */
  bare?: boolean;
  className?: string;
}

export function Segmented<T extends string>({ options, value, onChange, size = 'md', label, bare, className, ...rest }: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const prefix = (rest as Record<string, unknown>)['data-testid'];
  const enabled = options.filter(o => !o.disabled);
  // Keep the group reachable with Tab even when the value matches no option.
  const tabStop = enabled.some(o => o.value === value) ? value : enabled[0]?.value;

  function move(e: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key) || !enabled.length) return;
    e.preventDefault();
    const at = Math.max(0, enabled.findIndex(o => o.value === value));
    let next = at;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % enabled.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else next = enabled.length - 1;
    const v = enabled[next].value;
    onChange(v);
    const el = ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(v)}"]`);
    el?.focus();
  }

  return (
    <div
      {...rest}
      ref={ref}
      role="radiogroup"
      aria-label={label ?? rest['aria-label']}
      className={cx(s.track, size === 'sm' && s.sm, options.length > 4 && s.many, bare && s.bare, className)}
      onKeyDown={move}
    >
      {options.map(o => {
        const on = o.value === value;
        const testId = o.testId ?? o['data-testid'] ?? (typeof prefix === 'string' ? `${prefix}-${o.value}` : undefined);
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={o.value === tabStop ? 0 : -1}
            disabled={o.disabled}
            className={s.opt}
            data-value={o.value}
            data-testid={testId}
            onClick={() => {
              if (!on) onChange(o.value);
            }}
          >
            {o.icon ? <Icon name={o.icon} /> : null}
            <span className={s.text}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
