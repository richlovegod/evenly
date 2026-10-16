// A 44 px icon-only button (or link when `href` is set). `label` is its accessible name.

import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEventHandler } from 'react';
import { href as hashHref } from '../lib/router';
import { Icon, type IconName } from './Icon';
import s from './IconButton.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

function linkTarget(path: string): string {
  return path.startsWith('/') ? hashHref(path) : path;
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick'> {
  icon: IconName;
  /** Accessible name (aria-label). */
  label: string;
  onClick?: MouseEventHandler<HTMLElement>;
  /** A count in the corner (unread items). 0 or undefined hides it. */
  badge?: number;
  /** Render as a link: an app path ('/account') or any URL. */
  href?: string;
  /** Icon size in px (default 24). The target stays 44 px. */
  size?: number;
  className?: string;
}

export function IconButton({ icon, label, onClick, badge, href, size = 24, className, disabled, type, ...rest }: IconButtonProps) {
  const count = badge && badge > 0 ? (badge > 99 ? '99+' : String(badge)) : null;
  const name = count ? `${label} (${count})` : label;
  const inner = (
    <>
      <Icon name={icon} size={size} />
      {count ? <span className={s.badge} aria-hidden="true">{count}</span> : null}
    </>
  );
  if (href !== undefined) {
    const anchorRest = rest as unknown as AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a
        {...anchorRest}
        className={cx(s.btn, className)}
        href={disabled ? undefined : linkTarget(href)}
        aria-label={name}
        aria-disabled={disabled || undefined}
        onClick={e => {
          if (disabled) {
            e.preventDefault();
            return;
          }
          onClick?.(e);
        }}
      >
        {inner}
      </a>
    );
  }
  return (
    <button {...rest} type={type ?? 'button'} className={cx(s.btn, className)} aria-label={name} disabled={disabled} onClick={onClick}>
      {inner}
    </button>
  );
}
