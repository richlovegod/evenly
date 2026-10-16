// Picture-book pieces for the welcome, sign-in, join, claim, account and owner pages (the award
// site's login and account look, design/PICTUREBOOK.md): the card (.acard: 3 px ink outline,
// radius 22, paper or a pastel tint), label and value rows split by dashed pencil (.kv), the
// dashed rule, ※ notes, small outlined tags, quiet link rows and an inline error line. Slip and
// Lead keep their receipt-era names so every page keeps its imports.

import { useId, useState, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { href } from '../../lib/router';
import s from './Receipt.module.css';

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/** Card grounds: paper, or one of the award site's tints (yolk for forms, sky for information). */
export type Tint = 'paper' | 'yellow' | 'water' | 'coral' | 'green';

const TINT: Record<Tint, string | undefined> = {
  paper: undefined,
  yellow: s.yellow,
  water: s.water,
  coral: s.coral,
  green: s.green,
};

/**
 * A full-screen page without the tab bar: the top bar (a PageHeader) when there is one, then a
 * phone-width column. `footer` is a bar of paper pinned to the bottom (it sits at the bottom of a
 * short page and sticks while a long one scrolls), for the page's one action.
 */
export function BarePage({ band, children, footer, className }: { band?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <div className={cx(s.page, className)}>
      {band}
      <main className={cx(s.main, footer ? s.mainWithBar : undefined)}>
        {children}
        {footer ? <div className={s.bar}>{footer}</div> : null}
      </main>
    </div>
  );
}

/** "16:12" in Chinese (24 h, DESIGN.md 13.2); the locale's own time ("4:12 PM") in English. */
export function clockTime(ts: string, zh: boolean, time: (ts: string) => string): string {
  if (!zh) return time(ts);
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The local calendar day of a timestamp as 'YYYY-MM-DD', for the date formatter. */
export function localDay(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * True the first time this tab shows a card with these numbers (it hops in once then, the
 * award site's arrival), false on plain navigation or back.
 */
export function usePrintOnce(slipId: string, numbers: string): boolean {
  const [printing] = useState(() => {
    const key = 'evenly.print.' + slipId;
    try {
      if (sessionStorage.getItem(key) === numbers) return false;
      sessionStorage.setItem(key, numbers);
    } catch {
      return false;
    }
    return true;
  });
  return printing;
}

/** An untitled card (the page's main card). `printing` makes it hop in once. */
export function Slip({
  children,
  printing = false,
  tint = 'paper',
  className,
  ...rest
}: { children: ReactNode; printing?: boolean; tint?: Tint; className?: string } & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'>) {
  return (
    <section className={cx(s.card, TINT[tint], printing && s.arrive, className)} {...rest}>
      <div className={s.body}>{children}</div>
    </section>
  );
}

/**
 * A titled card (the award site's .acard), with an optional quiet action on the right of the
 * title. Inside, the gutter is the card's own padding, so fields, rows and buttons line up.
 */
export function Card({
  title,
  action,
  tint = 'paper',
  children,
  className,
  bodyClassName,
  ...rest
}: {
  title?: ReactNode;
  action?: ReactNode;
  tint?: Tint;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
} & Omit<HTMLAttributes<HTMLElement>, 'title' | 'className' | 'children'>) {
  const id = useId();
  const titled = title !== undefined && title !== null && title !== '' && title !== false;
  return (
    <section {...rest} className={cx(s.card, TINT[tint], className)} aria-labelledby={titled ? id : rest['aria-labelledby']}>
      {titled || action ? (
        <div className={s.head}>
          {titled ? <h2 id={id} className={s.title}>{title}</h2> : <span />}
          {action ? <div className={s.action}>{action}</div> : null}
        </div>
      ) : null}
      <div className={cx(s.body, bodyClassName)}>{children}</div>
    </section>
  );
}

/** Label and value on one row, a dashed pencil rule under it (the award site's .kv). */
export function Lead({ label, children, tone, className }: { label: ReactNode; children: ReactNode; tone?: 'pos' | 'neg' | 'mute'; className?: string }) {
  return (
    <p className={cx(s.lead, tone && s[tone], className)}>
      <span className={s.leadLabel}>{label}</span>
      <span className={s.leadValue}>{children}</span>
    </p>
  );
}

/** The dashed rule between the parts of a card. */
export function Dash() {
  return <hr className={s.dash} />;
}

/** A ※ footnote ("Note:" in English, DESIGN.md 13.3). */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useT();
  return (
    <p className={cx(s.note, className)}>
      <span className={s.noteMark}>{t('※ ', 'Note: ')}</span>
      {children}
    </p>
  );
}

/** A small outlined pill (管理員, 已加入, 已刪除). */
export function Tag({ children, tint = 'paper', className }: { children: ReactNode; tint?: Tint; className?: string }) {
  return <span className={cx(s.tag, TINT[tint], className)}>{children}</span>;
}

/** A short list of quiet ways out under a form ("已有帳號？登入"). */
export function Links({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <nav className={s.links} aria-label={label}>
      {children}
    </nav>
  );
}

/** One quiet link row: 16 px, 48 px tall, a round chevron at the end. `to` is an app path. */
export function LinkRow({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className' | 'children'>) {
  return (
    <a {...rest} className={cx(s.link, className)} href={href(to)}>
      <span>{children}</span>
      <span className={s.linkGo} aria-hidden="true">
        <Icon name="chevronRight" size={16} strokeWidth={2.4} />
      </span>
    </a>
  );
}

/** An inline error line (coral ink, with a warning icon), announced to screen readers. */
export function ErrorLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cx(s.error, className)} role="alert">
      <Icon name="warning" size={16} />
      <span>{children}</span>
    </p>
  );
}
