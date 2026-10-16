// Section: an optional title with an action on the right (a link like 全部朋友 or 建立群組),
// then the content. List rows inside run full width; other content lines up with the title.

import { useId, type HTMLAttributes, type ReactNode } from 'react';
import s from './Section.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  /** No side padding: children span the full width (they handle their own gutters). */
  flush?: boolean;
  className?: string;
}

export function Section({ title, action, children, flush, className, ...rest }: SectionProps) {
  const id = useId();
  const hasHead = (title !== undefined && title !== null && title !== '') || (action !== undefined && action !== null);
  return (
    <section {...rest} className={cx(s.section, flush && s.flush, className)} aria-labelledby={title ? id : rest['aria-labelledby']}>
      {hasHead ? (
        <div className={s.head}>
          {title ? <h2 id={id} className={s.title}>{title}</h2> : <span />}
          {action !== undefined && action !== null ? <div className={s.action}>{action}</div> : null}
        </div>
      ) : null}
      <div className={s.body}>{children}</div>
    </section>
  );
}
