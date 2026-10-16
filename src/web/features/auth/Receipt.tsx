// Receipt pieces for the welcome, sign-in, join, claim and account pages: the slip that feeds out
// of the printer band's slot (PageHeader), dotted leader lines, the dashed rule, ※ notes and an
// inline error line. Geometry follows DESIGN.md 8.2.

import { useState, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { href } from '../../lib/router';
import s from './Receipt.module.css';

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/**
 * A full-screen page without the tab bar: the band (a PageHeader) on top, a centered column
 * below. `footer` is a bar of paper pinned to the bottom (it sits at the bottom of a short page
 * and sticks while a long one scrolls), for the page's one action.
 */
export function BarePage({ band, children, footer, className }: { band: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) {
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
 * True when a slip should print (the stepped feed): its numbers differ from what this tab showed
 * last time, including the first time (DESIGN.md 10). Never on plain navigation or back.
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

/** The slip: paper fed out of the slot above it (put it right after the PageHeader). */
export function Slip({
  children,
  printing = false,
  className,
  ...rest
}: { children: ReactNode; printing?: boolean; className?: string } & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'>) {
  return (
    <section className={cx(s.slipWrap, className)} {...rest}>
      <div className={cx(s.slip, printing && s.printing)}>{children}</div>
    </section>
  );
}

/** Label ...... value, the receipt line. */
export function Lead({ label, children, tone, className }: { label: ReactNode; children: ReactNode; tone?: 'pos' | 'neg' | 'mute'; className?: string }) {
  return (
    <p className={cx(s.lead, tone && s[tone], className)}>
      <span className={s.leadLabel}>{label}</span>
      <i className={s.leader} aria-hidden="true" />
      <span className={s.leadValue}>{children}</span>
    </p>
  );
}

/** The dashed rule between the parts of a slip. */
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

/** A short list of quiet ways out under a form ("已有帳號？登入"). */
export function Links({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <nav className={s.links} aria-label={label}>
      {children}
    </nav>
  );
}

/** One quiet link row: 15 px, 44 px tall, chevron at the end. `to` is an app path. */
export function LinkRow({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className' | 'children'>) {
  return (
    <a {...rest} className={cx(s.link, className)} href={href(to)}>
      <span>{children}</span>
      <Icon name="chevronRight" size={18} />
    </a>
  );
}

/** An inline error line (red, with a warning icon), announced to screen readers. */
export function ErrorLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cx(s.error, className)} role="alert">
      <Icon name="warning" size={16} />
      <span>{children}</span>
    </p>
  );
}
