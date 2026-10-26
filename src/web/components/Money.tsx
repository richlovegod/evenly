// Money and MoneyStatus (DESIGN.md 8.3). Money prints one amount with the app's fixed currency
// symbols (US$, NT$, CN¥, never Intl's) in M PLUS Rounded 1c (--font-num) at --fw-num (800; small
// sizes --fw-num-2, 700); MoneyStatus is the single source of the words that say
// which way money goes (你可以拿回 / 你欠 / 欠你 / 你借出 / 你借入 / 你要還 / 你沒參與 / 你收到 /
// 你付出 / 已結清 / 跟你已結清). Amounts are integer minor units. Color only repeats the words; a
// sign is never printed next to a word.

import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { getCurrency } from '../../shared/currencies';
import { zhJoin } from '../lib/describe';
import { useT } from '../lib/i18n';
import s from './Money.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** "1,192.46" with the comma and the point in pull-in spans. */
function digits(body: string): ReactNode[] {
  const out: ReactNode[] = [];
  let run = '';
  let k = 0;
  for (const ch of body) {
    if (ch === ',' || ch === '.') {
      if (run) out.push(run);
      run = '';
      out.push(<span key={k++} className={s.sep}>{ch}</span>);
    } else {
      run += ch;
    }
  }
  if (run) out.push(run);
  return out;
}

export type MoneyTone = 'auto' | 'positive' | 'negative' | 'neutral';

export interface MoneyProps extends HTMLAttributes<HTMLSpanElement> {
  /** Minor units of `currency`. */
  amount: number;
  currency: string;
  /** auto: grass ink above zero, coral ink below, ink at zero. Without a tone the color is inherited. */
  tone?: MoneyTone;
  /** auto: a minus sign below zero; always: also + above zero (charts, exports); never: the absolute value. */
  sign?: 'auto' | 'always' | 'never';
  /**
   * DESIGN.md 8.3: sm 13/700 (meta lines), md 34 (總覽), lg 40 (a group's status), xl 56 (the
   * amount being entered); md, lg and xl shrink with their container. Without a size the font
   * size is inherited (rows 18, chips 14, converted 20).
   */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Print the currency prefix at 0.6 em (on by default for md, lg and xl). */
  display?: boolean;
  className?: string;
}

/** The printed width of an amount in em, measured in M PLUS Rounded 1c 800: 0.65 per digit,
 *  0.33 per separator, 0.4 per prefix glyph (printed at 0.6 em), 0.62 for the sign (0.84 em). */
function amountEm(symbol: string, body: string, signed: boolean): number {
  let em = 0.4 * [...symbol].length + (signed ? 0.62 : 0);
  for (const ch of body) em += ch === ',' || ch === '.' ? 0.33 : 0.65;
  return Math.round(em * 100) / 100;
}

export function Money({ amount, currency, tone, sign = 'auto', size, display, className, style, ...rest }: MoneyProps) {
  const { money, zh } = useT();
  const value = Number.isFinite(amount) ? amount : 0;
  const c = getCurrency(currency);
  const body = money(Math.abs(value), currency, { bare: true });
  // A real minus (U+2212), and only where no word says the direction (charts, exports).
  const signChar = value < 0 && sign !== 'never' ? '−' : value > 0 && sign === 'always' ? '+' : '';
  const toneCls =
    tone === 'auto' ? (value > 0 ? s.pos : value < 0 ? s.neg : s.neutral)
      : tone === 'positive' ? s.pos
        : tone === 'negative' ? s.neg
          : tone === 'neutral' ? s.neutral
            : undefined;
  const sizeCls = size === 'sm' ? s.sm : size === 'md' ? s.md : size === 'lg' ? s.lg : size === 'xl' ? s.xl : undefined;
  const isDisplay = display ?? (size === 'md' || size === 'lg' || size === 'xl');
  const spoken = zh
    ? `${signChar === '−' ? '負 ' : signChar === '+' ? '正 ' : ''}${body} ${c.zh}`
    : `${signChar === '−' ? 'minus ' : signChar === '+' ? 'plus ' : ''}${c.symbol.trim()}${body}`;
  const css = size === 'xl' ? ({ '--amt-em': amountEm(c.symbol, body, !!signChar), ...style } as CSSProperties) : style;
  return (
    <span className={cx(s.amt, sizeCls, toneCls, isDisplay && s.display, className)} style={css} data-amount={value} data-currency={c.code} {...rest}>
      <span aria-hidden="true">
        {signChar ? <span className={s.sign}>{signChar}</span> : null}
        <span className={s.cur}>{c.symbol}</span>
        {digits(body)}
      </span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}

// ---------- MoneyStatus ----------

/**
 * groupMine: 你可以拿回 / 你欠 / 已結清 (my balance in a group).
 * friend: 欠你 / 你欠 / 已結清 (with `name`: Abbie 欠你 / 你欠 Abbie / Abbie 跟你已結清).
 * rowEffect: 你借出 / 你借入 / 剛好平衡, or 你沒參與 when not involved (my effect on one entry;
 *   with `payment`: 你付出 above zero, 你收到 below, in ink; with `refund`: 你可以拿回 above zero,
 *   你要還 below, since nobody lent or borrowed anything when money comes back).
 * member (third person): 可拿回 / 要付 / 已結清.
 * payment: 你收到 above zero, 你付出 below (ink; above zero = money came to you).
 * settledWith: 跟你已結清 (for people listed on a slip; never stamped).
 */
export type MoneyStatusKind = 'groupMine' | 'friend' | 'rowEffect' | 'member' | 'payment' | 'settledWith';

export interface MoneyStatusProps extends HTMLAttributes<HTMLSpanElement> {
  /** Signed minor units: above zero money comes to the subject (you, or the member), below zero it goes out. */
  amount: number;
  currency: string;
  kind: MoneyStatusKind;
  /** rowEffect only: false when I have no part in the entry (你沒參與). Default true. */
  involved?: boolean;
  /** sm: one line at 13 px. md: label over amount (rows, stubs). lg: label left, display amount right (a slip). */
  size?: 'sm' | 'md' | 'lg';
  /** Override the layout chosen by size: inline (one line), stack (label over amount), split (label left, amount right). */
  layout?: 'inline' | 'stack' | 'split';
  /** Stack alignment (default end, like a receipt). */
  align?: 'start' | 'end';
  /** friend and member kinds: say who ("Abbie 欠你", "你欠 Abbie", "Kevin 可拿回"). */
  name?: string;
  /** rowEffect for a payment: 你付出 (above zero) / 你收到 (below zero) in ink instead of 你借出 / 你借入. */
  payment?: boolean;
  /** rowEffect for a refund: 你可以拿回 (above zero) / 你要還 (below zero) instead of 你借出 / 你借入. */
  refund?: boolean;
  /** Settled shows the 已結清 stamp in stack and split layouts (default true); false prints plain words. */
  stamp?: boolean;
  /** The balance just reached zero by your action: the stamp lands once (DESIGN.md 10). */
  stampLands?: boolean;
  className?: string;
}

type Tone = 'pos' | 'neg' | 'neutral' | 'mute';

interface Words {
  label: string;
  tone: Tone;
  /** Show the amount next to the words. */
  amount: boolean;
  /** A zero balance: the stamp may replace the amount. */
  settled: boolean;
}

/** "你欠 Abbie" needs a space before a Latin name, "你欠佳穎" does not. */
function zhBefore(prefix: string, name: string): string {
  return prefix + (/^[A-Za-z0-9(]/.test(name) ? ' ' : '') + name;
}

function useWords(kind: MoneyStatusKind, amount: number, involved: boolean, name: string | undefined, payment: boolean, refund: boolean): Words {
  const { t, zh } = useT();
  const up = amount > 0;
  const down = amount < 0;
  const settled: Words = { label: t('已結清', 'Settled up'), tone: 'mute', amount: false, settled: true };
  const even: Words = { label: t('剛好平衡', 'Even'), tone: 'mute', amount: false, settled: false };
  switch (kind) {
    case 'groupMine':
      if (up) return { label: t('你可以拿回', 'You get back'), tone: 'pos', amount: true, settled: false };
      if (down) return { label: t('你欠', 'You owe'), tone: 'neg', amount: true, settled: false };
      return settled;
    case 'friend':
      if (name) {
        if (up) return { label: zh ? zhJoin(name, '欠你') : `${name} owes you`, tone: 'pos', amount: true, settled: false };
        if (down) return { label: zh ? zhBefore('你欠', name) : `You owe ${name}`, tone: 'neg', amount: true, settled: false };
        return { ...settled, label: zh ? zhJoin(name, '跟你已結清') : `${name} is settled up with you` };
      }
      if (up) return { label: t('欠你', 'Owes you'), tone: 'pos', amount: true, settled: false };
      if (down) return { label: t('你欠', 'You owe'), tone: 'neg', amount: true, settled: false };
      return settled;
    case 'member':
      if (name) {
        if (up) return { label: zh ? zhJoin(name, '可拿回') : `${name} gets back`, tone: 'pos', amount: true, settled: false };
        if (down) return { label: zh ? zhJoin(name, '要付') : `${name} owes`, tone: 'neg', amount: true, settled: false };
        return { ...settled, label: zh ? zhJoin(name, '已結清') : `${name} is settled up` };
      }
      if (up) return { label: t('可拿回', 'Gets back'), tone: 'pos', amount: true, settled: false };
      if (down) return { label: t('要付', 'Owes'), tone: 'neg', amount: true, settled: false };
      return settled;
    case 'payment':
      if (up) return { label: t('你收到', 'You received'), tone: 'neutral', amount: true, settled: false };
      if (down) return { label: t('你付出', 'You sent'), tone: 'neutral', amount: true, settled: false };
      return even;
    case 'settledWith':
      return { label: t('跟你已結清', 'Settled up with you'), tone: 'mute', amount: false, settled: false };
    case 'rowEffect':
      if (!involved) return { label: t('你沒參與', 'Not involved'), tone: 'mute', amount: false, settled: false };
      if (payment) {
        if (up) return { label: t('你付出', 'You sent'), tone: 'neutral', amount: true, settled: false };
        if (down) return { label: t('你收到', 'You received'), tone: 'neutral', amount: true, settled: false };
        return even;
      }
      if (refund) {
        if (up) return { label: t('你可以拿回', 'You get back'), tone: 'pos', amount: true, settled: false };
        if (down) return { label: t('你要還', 'You owe'), tone: 'neg', amount: true, settled: false };
        return even;
      }
      if (up) return { label: t('你借出', 'You lent'), tone: 'pos', amount: true, settled: false };
      if (down) return { label: t('你借入', 'You borrowed'), tone: 'neg', amount: true, settled: false };
      return even;
  }
}

const TONE: Record<Tone, string> = { pos: s.pos, neg: s.neg, neutral: s.neutral, mute: s.mute };

export function MoneyStatus({
  amount,
  currency,
  kind,
  involved = true,
  size = 'md',
  layout,
  align = 'end',
  name,
  payment = false,
  refund = false,
  stamp = true,
  stampLands,
  className,
  ...rest
}: MoneyStatusProps) {
  const { t } = useT();
  const value = Number.isFinite(amount) ? amount : 0;
  const w = useWords(kind, value, involved, name, payment, refund);
  const mode = layout ?? (size === 'sm' ? 'inline' : size === 'lg' ? 'split' : 'stack');
  const sizeCls = size === 'sm' ? s.sm : size === 'lg' ? s.lg : s.md;
  const tone = TONE[w.tone];
  const amountEl = w.amount ? (
    <Money amount={value} currency={currency} sign="never" display={mode === 'split'} className={cx(s.amount, mode === 'split' && tone)} />
  ) : null;
  const stamped = w.settled && stamp && mode !== 'inline';

  if (stamped) {
    // The stamp only ever says 已結清; who it is settled with is spoken, not stamped.
    const plain = t('已結清', 'Settled up');
    return (
      <span className={cx(s.status, mode === 'split' ? cx(s.split, s.settledRow) : s.stack, sizeCls, align === 'start' && s.start, className)} data-kind={kind} {...rest}>
        <span className={cx(s.stamp, size === 'lg' && s.big, stampLands && s.lands)} aria-hidden={w.label !== plain || undefined}>{plain}</span>
        {w.label !== plain ? <span className="sr-only">{w.label}</span> : null}
      </span>
    );
  }

  if (mode === 'inline') {
    return (
      <span className={cx(s.status, s.inline, sizeCls, tone, className)} data-kind={kind} {...rest}>
        <span className={s.label}>{w.label}</span>
        {amountEl}
      </span>
    );
  }

  if (mode === 'split') {
    return (
      <span className={cx(s.status, s.split, sizeCls, className)} data-kind={kind} {...rest}>
        <span className={cx(s.label, !w.amount && tone)}>{w.label}</span>
        {amountEl}
      </span>
    );
  }

  return (
    <span className={cx(s.status, s.stack, sizeCls, (kind === 'rowEffect' || kind === 'payment') && s.effect, align === 'start' && s.start, tone, className)} data-kind={kind} {...rest}>
      <span className={s.label}>{w.label}</span>
      {amountEl}
    </span>
  );
}
