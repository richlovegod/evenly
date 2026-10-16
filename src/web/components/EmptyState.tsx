// EmptyState: a picture-book card that says what to do next (還沒有費用 / 記下第一筆...). The
// award site's .empty: a 3 px dashed ink outline (radius 22) on sky tint, with the mascot and
// the state's icon on a small paper badge beside it.

import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Mascot } from './Mascot';
import s from './EmptyState.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: IconName;
  title: string;
  body?: string;
  /** Usually one primary Button. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon = 'general', title, body, action, className, ...rest }: EmptyStateProps) {
  return (
    <div {...rest} className={cx(s.wrap, className)}>
      <div className={s.card}>
        <span className={s.art} aria-hidden="true">
          <Mascot size={56} float />
          <span className={s.badge}>
            <Icon name={icon} size={18} />
          </span>
        </span>
        <h3 className={s.title}>{title}</h3>
        {body ? <p className={s.body}>{body}</p> : null}
        {action ? <div className={s.action}>{action}</div> : null}
      </div>
    </div>
  );
}
