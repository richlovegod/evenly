// Button: picture-book pills with a 3 px ink outline. primary (yolk, the one action color on a
// screen), secondary (paper), ghost (no fill, a 2 px dashed outline: the quiet one), danger
// (coral, for the final destructive step) and danger-quiet (coral tint with coral-ink words,
// for the button that starts a destructive flow, e.g. 刪除這筆). With `href` it renders a link.

import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEvent } from 'react';
import { href as hashHref } from '../lib/router';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Spinner';
import s from './Button.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** '/g/abc' becomes '#/g/abc'; '#/...', 'https://...' and 'mailto:' links pass through. */
function linkTarget(path: string): string {
  return path.startsWith('/') ? hashHref(path) : path;
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-quiet';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** sm 36 drawn (44 hit), md 44, lg 50 (the primary key). */
  size?: 'sm' | 'md' | 'lg';
  /** Full width. */
  block?: boolean;
  /** Shows a spinner in place of the icon and blocks clicks. */
  loading?: boolean;
  icon?: IconName;
  /** An icon after the label (e.g. chevronRight, external). */
  iconEnd?: IconName;
  /** Render as a link: an app path ('/g/abc') or any URL. */
  href?: string;
  /** For href links that leave the app. */
  target?: string;
  rel?: string;
  className?: string;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: s.primary,
  secondary: s.secondary,
  ghost: s.ghost,
  danger: s.danger,
  'danger-quiet': s.dangerQuiet,
};

export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  loading,
  icon,
  iconEnd,
  href,
  target,
  rel,
  className,
  children,
  disabled,
  type,
  onClick,
  ...rest
}: ButtonProps) {
  const cls = cx(s.btn, VARIANT[variant], size === 'sm' && s.sm, size === 'lg' && s.lg, block && s.block, loading && s.busy, className);
  const inactive = disabled || loading;
  const lead = loading ? <Spinner size={16} decorative /> : icon ? <Icon name={icon} /> : null;
  const content = (
    <>
      {lead}
      {children !== undefined && children !== null && children !== false ? <span className={s.label}>{children}</span> : null}
      {iconEnd ? <Icon name={iconEnd} /> : null}
    </>
  );

  if (href !== undefined) {
    const anchorRest = rest as unknown as AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a
        {...anchorRest}
        className={cls}
        href={inactive ? undefined : linkTarget(href)}
        target={target}
        rel={rel ?? (target === '_blank' ? 'noopener noreferrer' : undefined)}
        aria-disabled={inactive || undefined}
        aria-busy={loading || undefined}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          if (inactive) {
            e.preventDefault();
            return;
          }
          (onClick as unknown as ((ev: MouseEvent<HTMLAnchorElement>) => void) | undefined)?.(e);
        }}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      {...rest}
      type={type ?? 'button'}
      className={cls}
      disabled={inactive}
      aria-busy={loading || undefined}
      onClick={onClick}
    >
      {content}
    </button>
  );
}
