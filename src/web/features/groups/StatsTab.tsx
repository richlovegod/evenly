// 統計: what the group spent (payments are not spending; refunds come off it, and off their
// category, day and month: shared/balances.ts spendTotals), what each person paid against their
// share, where the money went by category, and when (by day on a trip, by month otherwise).
// Home, couple and 1:1 groups open with this month next to last month.
//
// Charts are picture-book marks on paper cards (PICTUREBOOK.md): every bar and column has a 2 px
// ink outline and a pastel fill, square at the baseline and round at the data end. Yolk is what
// was paid (and every category and day), sky is each person's share; the picked column is solid
// yolk among pale ones. The fills are light, so the outline carries the shape and the numbers
// carry the values: bars print their exact value beside them, the column chart prints the tapped
// (or hovered) column's value above it and has a table view. The marks themselves are decorative.

import { useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { spendTotals, toBase } from '../../../shared/balances';
import { categoryLabel } from '../../../shared/categories';
import { addDays, addMonths, isoMonth, todayISO } from '../../../shared/dates';
import type { ExpenseDTO, GroupSnapshotDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { CategoryIcon } from '../../components/CategoryIcon';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { Money } from '../../components/Money';
import { Section } from '../../components/Section';
import { orderedMembers } from '../../lib/describe';
import { useT } from '../../lib/i18n';
import type { GroupView } from '../../lib/store';
import { cx } from './cx';
import { usableEntries } from './groupMath';
import { useNamedT } from './NewGroupPage';
import s from './StatsTab.module.css';

// ---------- numbers ----------

export interface StatsPerson {
  id: string;
  name: string;
  color: string;
  /** The member's account and its photo version (MemberDTO), for the avatar. */
  userId: string | null;
  avatar: string | null;
  me: boolean;
  /** Group-currency minor units, expenses only. */
  paid: number;
  share: number;
}

export interface StatsBar {
  /** Category key, 'YYYY-MM-DD' or 'YYYY-MM'; '' for the folded rest of the categories. */
  key: string;
  amount: number;
}

export interface MonthStats {
  key: string;
  prevKey: string;
  total: number;
  paid: number;
  share: number;
  prevTotal: number;
  prevPaid: number;
  prevShare: number;
}

export interface GroupStats {
  base: string;
  /** Expenses and refunds counted (payments are not). */
  count: number;
  /** How many of them are refunds. */
  refunds: number;
  spent: number;
  myPaid: number;
  myShare: number;
  people: StatsPerson[];
  /** Largest first; past 9 categories the rest folds into one bar with key ''. */
  categories: StatsBar[];
  /** How many categories the '' bar holds. */
  folded: number;
  /** Oldest first: every day from the first to the last expense on a trip, every month otherwise. */
  timeline: StatsBar[];
  timelineKind: 'day' | 'month';
  firstDate: string | null;
  lastDate: string | null;
  month: MonthStats | null;
}

const MAX_CATEGORIES = 8;
/** A trip longer than this shows only the days that had spending. */
const MAX_DAY_SPAN = 62;

/** English singular or plural template (Chinese needs none). */
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function sumMonth(expenses: readonly ExpenseDTO[], key: string, base: string, meId: string) {
  const t = spendTotals(expenses.filter(e => isoMonth(e.date) === key), base);
  return { total: t.spent, paid: t.paid[meId] ?? 0, share: t.share[meId] ?? 0 };
}

/** Days from `a` to `b`, both included. */
export function daySpan(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
}

/** Everything the tab shows, in the group currency, from the merged view (unsynced entries count). */
export function computeStats(snap: GroupSnapshotDTO, today: string): GroupStats {
  const base = snap.group.currency;
  const meId = snap.me.memberId;
  // Spending: expenses, less refunds (toBase gives a refund below zero); payments are not spending.
  const expenses = usableEntries(snap.expenses, base).filter(e => e.kind !== 'payment');
  const totals = spendTotals(expenses, base);

  const people: StatsPerson[] = orderedMembers(snap.members, meId, true)
    .filter(m => m.active || (totals.paid[m.id] ?? 0) !== 0 || (totals.share[m.id] ?? 0) !== 0)
    .map(m => ({
      id: m.id, name: m.name, color: m.color, userId: m.userId, avatar: m.avatar ?? null, me: m.id === meId,
      paid: totals.paid[m.id] ?? 0, share: totals.share[m.id] ?? 0,
    }));

  const cats = Object.entries(totals.byCategory)
    .filter(([, v]) => v > 0)
    .map(([key, amount]) => ({ key, amount }))
    .sort((a, b) => b.amount - a.amount || (a.key < b.key ? -1 : 1));
  let categories = cats;
  let folded = 0;
  if (cats.length > MAX_CATEGORIES + 1) {
    const rest = cats.slice(MAX_CATEGORIES);
    folded = rest.length;
    categories = [...cats.slice(0, MAX_CATEGORIES), { key: '', amount: rest.reduce((a, c) => a + c.amount, 0) }];
  }

  let firstDate: string | null = null;
  let lastDate: string | null = null;
  const trip = snap.group.type === 'trip';
  const byKey = new Map<string, number>();
  for (const e of expenses) {
    if (!firstDate || e.date < firstDate) firstDate = e.date;
    if (!lastDate || e.date > lastDate) lastDate = e.date;
    const k = trip ? e.date : isoMonth(e.date);
    byKey.set(k, (byKey.get(k) ?? 0) + toBase(e, base).total);
  }

  const timeline: StatsBar[] = [];
  if (firstDate && lastDate) {
    if (trip && daySpan(firstDate, lastDate) <= MAX_DAY_SPAN) {
      for (let d = firstDate; d <= lastDate; d = addDays(d, 1)) timeline.push({ key: d, amount: byKey.get(d) ?? 0 });
    } else if (trip) {
      for (const [key, amount] of [...byKey].sort((a, b) => (a[0] < b[0] ? -1 : 1))) timeline.push({ key, amount });
    } else {
      const last = isoMonth(lastDate);
      for (let m = isoMonth(firstDate); m <= last && timeline.length < 1200; m = isoMonth(addMonths(m + '-01', 1))) {
        timeline.push({ key: m, amount: byKey.get(m) ?? 0 });
      }
    }
  }

  let month: MonthStats | null = null;
  if (snap.group.type === 'home' || snap.group.type === 'couple' || snap.group.type === 'pair') {
    const key = isoMonth(today);
    const prevKey = isoMonth(addMonths(key + '-01', -1));
    const cur = sumMonth(expenses, key, base, meId);
    const prev = sumMonth(expenses, prevKey, base, meId);
    month = { key, prevKey, total: cur.total, paid: cur.paid, share: cur.share, prevTotal: prev.total, prevPaid: prev.paid, prevShare: prev.share };
  }

  return {
    base,
    count: expenses.length,
    refunds: expenses.filter(e => e.kind === 'refund').length,
    spent: totals.spent,
    myPaid: totals.paid[meId] ?? 0,
    myShare: totals.share[meId] ?? 0,
    people,
    categories,
    folded,
    timeline,
    timelineKind: trip ? 'day' : 'month',
    firstDate,
    lastDate,
    month,
  };
}

/**
 * Advance of one character of an amount in the number font (M PLUS Rounded 1c 800, measured in
 * WebKit), in em, rounded up: digits 0.65, a comma or point 0.36, currency letters, signs and
 * symbols at most 0.74.
 */
function glyphEm(ch: string): number {
  return ch >= '0' && ch <= '9' ? 0.65 : ch === ',' || ch === '.' ? 0.36 : 0.74;
}

/** Width in px of an amount printed in the number font at `px`, plus a little room. */
function numWidth(text: string, px: number): number {
  let em = 0;
  for (const ch of text) em += glyphEm(ch);
  return Math.ceil(px * em) + 4;
}

/** Width of a display amount in em (DESIGN.md 8.3): the currency prefix prints at 0.6 em. */
function amountEm(text: string): number {
  const m = /^[^\d]*/.exec(text);
  const prefix = (m ? m[0] : '').trim();
  const rest = text.slice(m ? m[0].length : 0);
  let em = 0.1;
  for (const ch of prefix) em += 0.6 * glyphEm(ch);
  for (const ch of rest) em += glyphEm(ch);
  return Math.max(2, Math.round(em * 100) / 100);
}

/** Kana, CJK ideographs, Hangul and full-width forms: text with these stays in Huninn, never the number font. */
const CJK_RE = new RegExp('[\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af\\uff00-\\uffef]');

function percentText(part: number, whole: number, t: (zh: string, en: string) => string): string {
  if (whole <= 0 || part <= 0) return '0%';
  const p = (part / whole) * 100;
  if (p < 1) return t('不到 1%', 'under 1%');
  return Math.round(p) + '%';
}

// ---------- marks ----------

/**
 * A horizontal bar: an ink-outlined pill that grows from the left edge (square there) to its
 * value (round at the data end), at least 10 px long so a tiny value still shows. Series 1 (paid,
 * a category) is yolk, series 2 (share) is sky. The track is the full width; the bar's length is
 * a percentage of it. The value is printed beside it, so the mark is decorative (its title is the
 * mouse tooltip).
 */
function Bar({ value, max, series = 1, title }: { value: number; max: number; series?: 1 | 2; title: string }) {
  const pct = value > 0 && max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <span className={s.track} aria-hidden="true" title={value > 0 ? title : undefined}>
      {value > 0 ? <span className={cx(s.bar, series === 2 && s.bar2)} style={{ '--pct': pct } as CSSProperties} /> : null}
    </span>
  );
}

// ---------- the tab ----------

export function StatsTab({ gid: _gid, view }: { gid: string; view: GroupView }) {
  const { t, money, date, zh, locale } = useT();
  const snap = view.snap;
  const today = todayISO();
  const stats = useMemo(() => (snap ? computeStats(snap, today) : null), [snap, today]);

  if (!snap || !stats) return null;
  const base = stats.base;
  const trip = snap.group.type === 'trip';

  const monthLabel = (key: string, style: 'short' | 'long'): string => {
    const m = Number(key.slice(5, 7));
    if (zh) return style === 'long' ? `${key.slice(0, 4)} 年 ${m} 月` : `${m} 月`;
    const d = new Date(key + '-01T00:00:00Z');
    return new Intl.DateTimeFormat('en-US', style === 'long' ? { month: 'long', year: 'numeric', timeZone: 'UTC' } : { month: 'short', timeZone: 'UTC' }).format(d);
  };

  const span = stats.firstDate && stats.lastDate ? daySpan(stats.firstDate, stats.lastDate) : 0;
  const hasForeign = snap.expenses.some(e => !e.deletedAt && e.currency !== base);

  return (
    <div className={s.tab}>
      {stats.month ? <MonthBlock m={stats.month} base={base} monthLabel={monthLabel} /> : null}

      {stats.count === 0 ? (
        <Section>
          <EmptyState
            icon="chart"
            title={t('還沒有可以統計的費用', 'Nothing to chart yet')}
            body={t('記下費用後，這裡會顯示花了多少、誰付了多少、錢花在哪裡。', 'Once you add expenses, this shows the total, who paid what, and where the money went.')}
          />
        </Section>
      ) : (
        <>
          <Section>
            <div className={s.total}>
              <div className={s.totalMain}>
                <span className={s.k}>{trip ? t('這趟總花費', 'Trip total') : t('總花費', 'Total spent')}</span>
                <span className={s.totalAmt} style={{ '--amt-em': amountEm(money(stats.spent, base)) } as CSSProperties}>
                  <Money amount={stats.spent} currency={base} display />
                </span>
              </div>
              <div className={s.totalMine}>
                <span className={s.k}>{t('你的份', 'Your share')}</span>
                <span className={s.mineAmt}>
                  <Money amount={stats.myShare} currency={base} />
                </span>
              </div>
            </div>
            <p className={s.foot}>
              {stats.refunds
                ? t(
                    '※ {n} 筆費用、{r} 筆退款，退款從花費扣掉，付款（還錢）不算花費',
                    plural(stats.count - stats.refunds, 'Note: {n} expense', 'Note: {n} expenses') +
                      plural(stats.refunds, ' and {r} refund', ' and {r} refunds') +
                      '; refunds come off the spending, payments (paying people back) are not spending',
                    { n: stats.count - stats.refunds, r: stats.refunds },
                  )
                : t('※ {n} 筆費用，付款（還錢）不算花費', plural(stats.count, 'Note: {n} expense; payments (paying people back) are not spending', 'Note: {n} expenses; payments (paying people back) are not spending'), { n: stats.count })}
              {trip && stats.firstDate && stats.lastDate && span > 1
                ? t('。{a}～{b}，{d} 天，平均每天 {amt}', '. {a} to {b}, {d} days, {amt} a day on average', {
                    a: date(stats.firstDate, 'md'),
                    b: date(stats.lastDate, 'md'),
                    d: span,
                    amt: money(Math.round(stats.spent / span), base),
                  })
                : ''}
            </p>
          </Section>

          <PeopleChart people={stats.people} base={base} />

          <Section title={t('花在哪裡', 'By category')}>
            <CategoryChart bars={stats.categories} folded={stats.folded} spent={stats.spent} base={base} locale={locale} />
          </Section>

          {stats.timeline.length > 1 ? (
            <Section title={trip ? t('每天花多少', 'By day') : t('每個月花多少', 'By month')}>
              <ColumnChart
                bars={trip ? stats.timeline : stats.timeline.slice(-12)}
                all={trip ? stats.timeline : stats.timeline.slice().reverse()}
                base={base}
                currentKey={trip ? today : isoMonth(today)}
                tick={(key, n) => (trip ? (n <= 7 ? date(key, 'md') : String(Number(key.slice(8, 10)))) : monthLabel(key, 'short'))}
                label={key => (trip ? date(key, 'mdw') : monthLabel(key, 'long'))}
                title={trip ? t('每天的花費', 'Spending per day') : t('每個月的花費', 'Spending per month')}
                tableLabel={trip ? t('看每天的金額', 'See every day') : t('看每個月的金額', 'See every month')}
              />
            </Section>
          ) : null}

          <p className={s.note}>
            {hasForeign
              ? t('※ 金額都換算成 {base}，用每一筆費用自己的匯率', "Note: amounts are in {base}, converted at each expense's own rate", { base })
              : t('※ 金額單位是 {base}', 'Note: amounts are in {base}', { base })}
          </p>
        </>
      )}
    </div>
  );
}

function MonthBlock({ m, base, monthLabel }: { m: MonthStats; base: string; monthLabel: (key: string, style: 'short' | 'long') => string }) {
  const { t, money } = useT();
  const cur = monthLabel(m.key, 'short');
  const prev = monthLabel(m.prevKey, 'short');
  const diff = m.total - m.prevTotal;
  // Chinese month names start with a digit ("9 月"), so a space goes before them.
  let compare: string;
  if (m.prevTotal === 0 && m.total === 0) compare = t('※ {cur}和 {prev}都還沒有費用', 'Note: no expenses in {cur} or {prev} yet', { cur, prev });
  else if (m.prevTotal === 0) compare = t('※ {prev}沒有費用', 'Note: no expenses in {prev}', { prev });
  else if (diff > 0) compare = t('※ 比 {prev}多花 {amt}', 'Note: {amt} more than {prev}', { prev, amt: money(diff, base) });
  else if (diff < 0) compare = t('※ 比 {prev}少花 {amt}', 'Note: {amt} less than {prev}', { prev, amt: money(-diff, base) });
  else compare = t('※ 和 {prev}花得一樣多', 'Note: the same as {prev}', { prev });

  const rows: { label: string; now: number; before: number }[] = [
    { label: t('總花費', 'Total spent'), now: m.total, before: m.prevTotal },
    { label: t('你付了', 'You paid'), now: m.paid, before: m.prevPaid },
    { label: t('你的份', 'Your share'), now: m.share, before: m.prevShare },
  ];
  return (
    <Section title={t('本月', 'This month')}>
      <div className={s.panel}>
        <table className={s.month}>
          <caption className="sr-only">{t('{cur}和 {prev}的花費', 'Spending in {cur} and {prev}', { cur, prev })}</caption>
          <thead>
            <tr>
              <td />
              <th scope="col" className={s.monthHead}>{cur}</th>
              <th scope="col" className={cx(s.monthHead, s.monthPrev)}>{prev}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label}>
                <th scope="row" className={s.monthLabel}>{r.label}</th>
                <td className={s.monthNow}>
                  <Money amount={r.now} currency={base} />
                </td>
                <td className={cx(s.monthNow, s.monthPrev)}>
                  <Money amount={r.before} currency={base} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={s.foot}>{compare}</p>
      </div>
    </Section>
  );
}

function PeopleChart({ people, base }: { people: StatsPerson[]; base: string }) {
  const { t, money } = useNamedT();
  const max = Math.max(0, ...people.map(p => Math.max(p.paid, p.share)));
  const valW = Math.max(48, ...people.flatMap(p => [numWidth(money(p.paid, base), 13), numWidth(money(p.share, base), 13)]));
  const diffText = (p: StatsPerson): string => {
    const d = p.paid - p.share;
    if (d > 0) return t('多付 {amt}', 'paid {amt} more', { amt: money(d, base) });
    if (d < 0) return t('少付 {amt}', 'paid {amt} less', { amt: money(-d, base) });
    return p.paid > 0 ? t('剛好付了自己的份', 'paid exactly their share') : t('沒有參與', 'not involved');
  };
  return (
    <Section title={t('誰付了多少', 'Who paid what')}>
      <div className={s.panel}>
        <p className={s.legend}>
          <span className={s.key}>
            <i className={s.swatch} aria-hidden="true" />
            {t('付了', 'Paid')}
          </span>
          <span className={s.key}>
            <i className={cx(s.swatch, s.swatch2)} aria-hidden="true" />
            {t('分到', 'Share')}
          </span>
        </p>
        <ul className={s.people} role="list" style={{ '--val-w': valW + 'px' } as CSSProperties}>
          {people.map(p => {
            const who = p.me ? t('你', 'You') : p.name;
            return (
              <li key={p.id} className={s.person}>
                <div className={s.personHead}>
                  <Avatar name={p.name} color={p.color} userId={p.userId} avatar={p.avatar} size={26} ring={p.me} />
                  <span className={s.personName}>{who}</span>
                  <span className={s.personDiff}>{diffText(p)}</span>
                </div>
                <div className={s.pair}>
                  <Bar value={p.paid} max={max} title={t('{name} 付了 {amt}', '{name} paid {amt}', { name: who, amt: money(p.paid, base) })} />
                  <span className={s.val}>
                    <span className="sr-only">{t('付了', 'Paid')} </span>
                    <Money amount={p.paid} currency={base} size="sm" />
                  </span>
                  <Bar value={p.share} max={max} series={2} title={t('{name} 分到 {amt}', "{name}'s share {amt}", { name: who, amt: money(p.share, base) })} />
                  <span className={s.val}>
                    <span className="sr-only">{t('分到', 'Share')} </span>
                    <Money amount={p.share} currency={base} size="sm" />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <p className={s.foot}>{t('※ 兩條長條用同一個刻度；付款不算在內', 'Note: both bars share one scale; payments are left out')}</p>
      </div>
    </Section>
  );
}

function CategoryChart({ bars, folded, spent, base, locale }: { bars: StatsBar[]; folded: number; spent: number; base: string; locale: string }) {
  const { t, money } = useT();
  const max = Math.max(0, ...bars.map(b => b.amount));
  const valW = Math.max(48, ...bars.map(b => numWidth(money(b.amount, base), 14)));
  return (
    <div className={s.panel}>
      <ul className={s.cats} role="list" style={{ '--val-w': valW + 'px' } as CSSProperties}>
        {bars.map(b => {
          const label = b.key ? categoryLabel(b.key, locale) : t('其他 {n} 類', plural(folded, '{n} more category', '{n} more categories'), { n: folded });
          const pct = percentText(b.amount, spent, t);
          return (
            <li key={b.key || '_rest'} className={s.catRow}>
              {b.key ? (
                <CategoryIcon category={b.key} size={32} />
              ) : (
                <span className={s.restTile} aria-hidden="true">
                  <Icon name="more" size={18} strokeWidth={2.2} />
                </span>
              )}
              <span className={s.catMain}>
                <span className={s.catLabel}>{label}</span>
                <Bar value={b.amount} max={max} title={`${label} ${money(b.amount, base)} (${pct})`} />
              </span>
              <span className={s.catVal}>
                <Money amount={b.amount} currency={base} />
                <small className={cx(s.pct, !CJK_RE.test(pct) && s.num)}>{pct}</small>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const PLOT_H = 112;

/**
 * Columns over time (DESIGN.md 8.20): at most 24 px wide with 2 px between them, ink-outlined
 * with round tops, standing on one ink ground line, 11 px labels. The selected column (today's,
 * the current month's, or the last one until you tap another) is solid yolk among pale yolk ones
 * and its exact value shows above the chart; a mouse hover previews another column. A table view
 * lists every value.
 */
function ColumnChart({
  bars,
  all,
  base,
  currentKey,
  tick,
  label,
  title,
  tableLabel,
}: {
  bars: StatsBar[];
  /** Every value for the table view (bars may be only the latest part). */
  all: StatsBar[];
  base: string;
  currentKey: string;
  tick: (key: string, count: number) => string;
  label: (key: string) => string;
  title: string;
  tableLabel: string;
}) {
  const { money } = useT();
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const keys = bars.map(b => b.key);
  const selected = picked && keys.includes(picked) ? picked : keys.includes(currentKey) ? currentKey : keys[keys.length - 1];
  const shown = bars.find(b => b.key === (hover ?? selected)) ?? null;
  const max = Math.max(0, ...bars.map(b => b.amount));
  const every = Math.max(1, Math.ceil(bars.length / 8));
  const valW = Math.max(48, ...all.map(b => numWidth(money(b.amount, base), 15)));

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = keys.indexOf(selected);
    let j = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = Math.min(keys.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = keys.length - 1;
    else return;
    e.preventDefault();
    setPicked(keys[j]);
    const group = e.currentTarget;
    requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus());
  }

  return (
    <div className={s.panel}>
      <p className={s.readout} aria-live="polite">
        <span className={s.readoutLabel}>{shown ? label(shown.key) : ''}</span>
        {shown ? (
          <span className={s.readoutAmt}>
            <Money amount={shown.amount} currency={base} />
          </span>
        ) : null}
      </p>
      <div className={s.plot} role="group" aria-label={title} onKeyDown={onKey} onPointerLeave={() => setHover(null)}>
        {bars.map((b, i) => {
          const on = b.key === selected;
          const h = max > 0 && b.amount > 0 ? Math.max(6, Math.round((b.amount / max) * PLOT_H)) : 0;
          const showTick = (bars.length - 1 - i) % every === 0;
          const tickText = tick(b.key, bars.length);
          return (
            <button
              key={b.key}
              type="button"
              className={cx(s.slot, on && s.slotOn)}
              aria-pressed={on}
              aria-label={`${label(b.key)} ${money(b.amount, base)}`}
              tabIndex={on ? 0 : -1}
              onClick={() => setPicked(b.key)}
              onPointerEnter={e => {
                if (e.pointerType === 'mouse') setHover(b.key);
              }}
            >
              <span className={s.col} aria-hidden="true">
                {h > 0 ? <span className={s.colMark} style={{ height: h }} /> : null}
              </span>
              <span className={cx(s.tick, !CJK_RE.test(tickText) && s.num, !showTick && s.tickOff)} aria-hidden="true">
                {tickText}
              </span>
            </button>
          );
        })}
      </div>
      <details className={s.table}>
        <summary className={s.tableSummary}>
          <Icon name="chevronDown" size={16} className={s.tableChev} />
          {tableLabel}
        </summary>
        <table className={s.tableBody} style={{ '--val-w': valW + 'px' } as CSSProperties}>
          <caption className="sr-only">{title}</caption>
          <tbody>
            {all.map(b => (
              <tr key={b.key}>
                <th scope="row" className={s.tableKey}>{label(b.key)}</th>
                <td className={cx(s.tableVal, b.amount === 0 && s.zero)}>
                  <Money amount={b.amount} currency={base} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
