// Chip (DESIGN.md 8.13): a small rounded control. With onClick it is a button (aria-pressed
// when `selected` is given, so it reads as a toggle); without onClick it is a static label.
// md: the payer and split chips (40 drawn, 44 hit; put an Avatar size 24 in `leading` and
// trailingIcon="chevronDown"). sm: the balance chip and filters (32 drawn, 44 hit).

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import s from './Chip.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  label: ReactNode;
  /** Icon before the label. */
  icon?: IconName;
  onClick?: () => void;
  /** Pressed state of a toggle chip (solid ink when true). */
  selected?: boolean;
  /** accent: carbon blue ring; warning: register red ring. */
  tone?: 'default' | 'accent' | 'warning';
  /** Anything before the label instead of an icon, e.g. an Avatar. */
  leading?: ReactNode;
  /** Icon after the label, e.g. chevronDown on a chip that opens a picker. */
  trailingIcon?: IconName;
  size?: 'sm' | 'md';
  className?: string;
}

export function Chip({ label, icon, onClick, selected, tone = 'default', leading, trailingIcon, size = 'md', className, type, disabled, ...rest }: ChipProps) {
  const cls = cx(
    s.chip,
    size === 'sm' && s.sm,
    selected && s.selected,
    !selected && tone === 'accent' && s.accent,
    !selected && tone === 'warning' && s.warning,
    leading ? s.withLead : undefined,
    className,
  );
  const inner = (
    <>
      {leading ? <span className={s.lead}>{leading}</span> : icon ? <Icon name={icon} /> : null}
      <span className={s.label}>{label}</span>
      {trailingIcon ? <Icon name={trailingIcon} /> : null}
    </>
  );
  if (!onClick) {
    const spanRest = rest as unknown as HTMLAttributes<HTMLSpanElement>;
    return <span {...spanRest} className={cls}>{inner}</span>;
  }
  return (
    <button
      {...rest}
      type={type ?? 'button'}
      className={cls}
      disabled={disabled}
      aria-pressed={selected === undefined ? undefined : selected}
      onClick={() => onClick()}
    >
      {inner}
    </button>
  );
}
