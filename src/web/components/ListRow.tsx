// ListRow: leading (avatar, ticket, tile), title and subtitle, trailing (balance, chevron).
// With href it is a link, with onClick a button, otherwise a plain row. data-testid, data-id
// and aria props go to that element.

import type { HTMLAttributes, ReactNode } from 'react';
import { href as hashHref } from '../lib/router';
import { Icon } from './Icon';
import s from './ListRow.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

function linkTarget(path: string): string {
  return path.startsWith('/') ? hashHref(path) : path;
}

export interface ListRowProps extends Omit<HTMLAttributes<HTMLElement>, 'title' | 'onClick'> {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  /** An app path ('/g/abc') or any URL. */
  href?: string;
  onClick?: () => void;
  /** A chevron at the end (rows that open a page). */
  chevron?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ListRow({ leading, title, subtitle, trailing, href, onClick, chevron, disabled, className, ...rest }: ListRowProps) {
  const interactive = !disabled && (href !== undefined || onClick !== undefined);
  const cls = cx(s.row, leading !== undefined && leading !== null && s.withLead, interactive && s.interactive, disabled && s.disabled, className);
  const body = (
    <>
      {leading !== undefined && leading !== null ? <span className={s.leading}>{leading}</span> : null}
      <span className={s.main}>
        <span className={s.title}>{title}</span>
        {subtitle !== undefined && subtitle !== null && subtitle !== '' ? <span className={s.subtitle}>{subtitle}</span> : null}
      </span>
      {trailing !== undefined && trailing !== null ? <span className={s.trailing}>{trailing}</span> : null}
      {chevron ? <Icon name="chevronRight" className={s.chevron} /> : null}
    </>
  );

  if (href !== undefined && !disabled) {
    return (
      <a {...rest} className={cls} href={linkTarget(href)} onClick={onClick ? () => onClick() : undefined}>
        {body}
      </a>
    );
  }
  if (onClick && !disabled) {
    return (
      <button {...rest} type="button" className={cls} onClick={() => onClick()}>
        {body}
      </button>
    );
  }
  return (
    <div {...rest} className={cls} aria-disabled={disabled || undefined}>
      {body}
    </div>
  );
}
