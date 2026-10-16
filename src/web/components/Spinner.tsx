// Loading indicators: Spinner (an arc that turns) and Skeleton (a block shaped like the content).

import type { CSSProperties, HTMLAttributes } from 'react';
import { useT } from '../lib/i18n';
import s from './Spinner.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  /** Diameter in px (default 20). */
  size?: number;
  /** What is loading, for screen readers (default 載入中 / Loading). */
  label?: string;
  /** Inside a control that already says it is busy: no status role, hidden from screen readers. */
  decorative?: boolean;
  className?: string;
}

export function Spinner({ size = 20, label, decorative, className, style, ...rest }: SpinnerProps) {
  const { t } = useT();
  const box: CSSProperties = { width: size, height: size, ...style };
  const art = (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle className={s.track} cx="12" cy="12" r="9" />
      <path className={s.arc} d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
  if (decorative) {
    return <span className={cx(s.spinner, className)} style={box} aria-hidden="true" {...rest}>{art}</span>;
  }
  return (
    <span role="status" className={cx(s.spinner, className)} style={box} {...rest}>
      {art}
      <span className="sr-only">{label ?? t('載入中', 'Loading')}</span>
    </span>
  );
}

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  /** Height in px (default 16). */
  height?: number;
  /** Width in px or any CSS length (default 100%). */
  width?: number | string;
  /** Corner radius in px (default the tile radius). */
  radius?: number;
  className?: string;
}

export function Skeleton({ height = 16, width = '100%', radius, className, style, ...rest }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx(s.skeleton, className)}
      style={{ height, width, borderRadius: radius, ...style }}
      {...rest}
    />
  );
}
