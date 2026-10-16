// The thermal-paper slip that comes out of the printer band's slot (DESIGN.md 8.2): the one place on
// a screen that holds the number the screen is for (總覽 totals, a group's status, a friend). It
// feeds out in steps when one of its numbers changed since this session last showed it, and once
// on first launch; never on plain navigation or back (DESIGN.md 10).

import { useEffect, useState, type ReactNode } from 'react';
import { cx } from './cx';
import s from './Slip.module.css';

const PRINT_KEY = 'evenly.slip.';

/** The first slip shown after launch prints once; later first views are plain navigation. */
let launchPrinted = false;

/** True for one feed animation when `value` (a hash of the slip's numbers) changed. */
export function usePrintFeed(slipId: string, value: string): boolean {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    // Nothing to print yet (still loading): not a view of the numbers.
    if (!value) return;
    let prev: string | null = null;
    try {
      prev = sessionStorage.getItem(PRINT_KEY + slipId);
      sessionStorage.setItem(PRINT_KEY + slipId, value);
    } catch {
      prev = value;
    }
    let print = false;
    if (prev === null) {
      print = !launchPrinted;
    } else {
      print = prev !== value;
    }
    launchPrinted = true;
    if (!print) return;
    setPrinting(true);
    const timer = window.setTimeout(() => setPrinting(false), 600);
    return () => {
      window.clearTimeout(timer);
      setPrinting(false);
    };
  }, [slipId, value]);
  return printing;
}

export function Slip({
  children,
  className,
  printing = false,
  testId,
  labelledBy,
  label,
}: {
  children: ReactNode;
  className?: string;
  printing?: boolean;
  testId?: string;
  labelledBy?: string;
  label?: string;
}) {
  return (
    <section className={cx(s.wrap, className)} data-testid={testId} aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : label}>
      <div className={cx(s.slip, printing && s.printing)}>{children}</div>
    </section>
  );
}

/** The dashed rule between parts of a slip. */
export function Dash({ className }: { className?: string }) {
  return <hr className={cx(s.dash, className)} />;
}

/** Dotted leader between a label and its amount. */
export function Leader() {
  return <i className={s.leader} aria-hidden="true" />;
}

/**
 * A ※ footnote line (English: "Note:"); `right` is pushed to the far end (上次同步 12/20 16:12)
 * and wraps under on narrow screens instead of breaking mid-phrase.
 */
export function Foot({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <p className={s.foot}>
      {children ? <span className={s.footMain}>{children}</span> : null}
      {right ? <span className={s.footRight}>{right}</span> : null}
    </p>
  );
}

/** Label ...... value, the receipt line. */
export function Lead({ label, value, className }: { label: ReactNode; value: ReactNode; className?: string }) {
  return (
    <p className={cx(s.lead, className)}>
      <span className={s.leadLabel}>{label}</span>
      <Leader />
      <span className={s.leadValue}>{value}</span>
    </p>
  );
}

/** The 已結清 stamp: the only word a stamp ever says. `land` plays its one landing. */
export function Stamp({ label, className, land = false }: { label: string; className?: string; land?: boolean }) {
  return <span className={cx(s.stamp, land && s.land, className)}>{label}</span>;
}
