// A 44 px icon-only button (or link when `href` is set). `label` is its accessible name.
// Drawn as the award site's .icon-btn: a round 38 px paper button with a 3 px ink outline
// (icons under 20 px get a 30 px circle with a 2 px outline, for buttons inside fields and
// rows). The target stays 44 px either way.

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
  const cls = cx(s.btn, size < 20 && s.small, className);
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
        className={cls}
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
    <button {...rest} type={type ?? 'button'} className={cls} aria-label={name} disabled={disabled} onClick={onClick}>
      {inner}
    </button>
  );
}
