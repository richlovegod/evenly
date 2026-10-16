// EmptyState: a blank slip that says what to do next (還沒有費用 / 記下第一筆...).

import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
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
      <div className={s.slip}>
        <Icon name={icon} className={s.icon} />
        <h3 className={s.title}>{title}</h3>
        {body ? <p className={s.body}>{body}</p> : null}
        {action ? <div className={s.action}>{action}</div> : null}
      </div>
    </div>
  );
}
