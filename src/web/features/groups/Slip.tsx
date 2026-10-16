// The card that holds the number a screen is for (a group's status, a friend's totals, the forms
// that open from them): a picture-book card, 3 px ink outline, radius 22, paper, dashed pencil
// rules between its parts (design/PICTUREBOOK.md). It hops once when one of its numbers changed
// since this session last showed it, and once on first launch; never on plain navigation or back.
// (The names Slip, Dash, Leader and Lead are kept from the first, receipt design.)

import { useEffect, useState, type ReactNode } from 'react';
import { Money } from '../../components/Money';
import { cx } from './cx';
import s from './Slip.module.css';

const PRINT_KEY = 'evenly.slip.';

/** The first card shown after launch hops once; later first views are plain navigation. */
let launchPrinted = false;

/** True for one hop when `value` (a hash of the card's numbers) changed. */
export function usePrintFeed(slipId: string, value: string): boolean {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    // Nothing to show yet (still loading): not a view of the numbers.
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

/** The dashed pencil rule between parts of a card. */
export function Dash({ className }: { className?: string }) {
  return <hr className={cx(s.dash, className)} />;
}

/** The space between a label and its amount (a flexible gap; no dotted leader). */
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

/** Label on the left, value on the right. */
export function Lead({ label, value, className }: { label: ReactNode; value: ReactNode; className?: string }) {
  return (
    <p className={cx(s.lead, className)}>
      <span className={s.leadLabel}>{label}</span>
      <Leader />
      <span className={s.leadValue}>{value}</span>
    </p>
  );
}

/** The 已結清 pill (sky, 2 px outline): the only word it ever says. `land` plays its one hop. */
export function Stamp({ label, className, land = false }: { label: string; className?: string; land?: boolean }) {
  return <span className={cx(s.stamp, land && s.land, className)}>{label}</span>;
}

/**
 * A directional amount the way the picture book prints it next to its words: + when the money
 * comes to you, − (U+2212) when it goes from you, in the money color. `amount` is signed (above
 * zero: toward you). The sign is drawn only; the words beside it and Money's spoken text carry
 * the direction for screen readers. `tone` "neutral" prints ink without a sign.
 */
export function Signed({
  amount,
  currency,
  tone = 'auto',
  display = false,
  className,
  'data-testid': testId,
}: {
  amount: number;
  currency: string;
  tone?: 'auto' | 'neutral';
  display?: boolean;
  className?: string;
  'data-testid'?: string;
}) {
  const dir = tone === 'neutral' ? 0 : Math.sign(amount);
  return (
    <span className={cx(s.signed, dir > 0 && s.pos, dir < 0 && s.neg, className)} data-testid={testId}>
      {dir !== 0 ? (
        <span className={s.sign} aria-hidden="true">
          {dir > 0 ? '+' : '−'}
        </span>
      ) : null}
      <Money amount={Math.abs(amount)} currency={currency} sign="never" display={display} className={s.signedAmt} />
    </span>
  );
}
