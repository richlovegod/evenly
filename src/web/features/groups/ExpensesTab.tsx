// 費用 tab: search, then the entries by month (newest first) with each month's count and total,
// one ExpenseRow per entry. Deleted entries stay hidden until asked for, then show dimmed with
// 復原. Entries that failed to sync always show, so they can be retried or dropped.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { spendTotals } from '../../../shared/balances';
import { categoryLabel } from '../../../shared/categories';
import { isoMonth } from '../../../shared/dates';
import { minorToInput } from '../../../shared/money';
import type { ExpenseDTO, MemberDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { IconButton } from '../../components/IconButton';
import { TextField } from '../../components/TextField';
import { useT } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { membersById, type GroupView } from '../../lib/store';
import { ExpenseRow, rowEffect, stubText, stubWidth } from './ExpenseRow';
import { usableEntries } from './groupMath';
import { count } from './plural';
import s from './ExpensesTab.module.css';

interface MonthGroup {
  key: string;
  items: ExpenseDTO[];
}

/** Rows rendered per page of a long list. */
const PAGE = 150;

/** Does an entry match the search: description, notes, category, people, or the amount typed ("12600", "12,600"). */
export function matchesQuery(e: ExpenseDTO, query: string, members: Record<string, MemberDTO>, locale: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const ids = new Set<string>();
  for (const p of e.payers) ids.add(p.memberId);
  for (const p of e.shares) ids.add(p.memberId);
  const names = [...ids].map(id => members[id]?.name ?? '');
  const hay = [e.description, e.notes, categoryLabel(e.category, locale), ...names].join('\n').toLowerCase();
  if (hay.includes(q)) return true;
  // An amount: drop grouping and any currency symbol around it ("¥12,600", "NT$ 2400").
  const num = q.replace(/[\s,，]/g, '').replace(/^[^\d.]+/, '').replace(/[^\d.]+$/, '');
  if (num && /^\d*\.?\d+$/.test(num) && minorToInput(e.amount, e.currency).includes(num)) return true;
  return false;
}

export function ExpensesTab({ gid, view }: { gid: string; view: GroupView }) {
  const { t, locale, money, date } = useT();
  const snap = view.snap;
  const [query, setQuery] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);

  const members = useMemo(() => membersById(snap), [snap]);
  const expenses = snap?.expenses ?? [];
  const base = snap?.group.currency ?? 'TWD';
  const meId = snap?.me.memberId ?? '';

  const deletedCount = useMemo(() => expenses.filter(e => e.deletedAt).length, [expenses]);
  const liveCount = expenses.length - deletedCount;
  const q = query.trim();

  const list = useMemo(
    () =>
      expenses.filter(e => {
        const visible = !e.deletedAt || showDeleted || view.pending[e.id]?.state === 'failed';
        return visible && matchesQuery(e, q, members, locale);
      }),
    [expenses, showDeleted, view.pending, q, members, locale],
  );

  // A long ledger renders in pages, so a 5,000-entry group still opens at once.
  const [limit, setLimit] = useState(PAGE);
  const shown = useMemo(() => list.slice(0, limit), [list, limit]);
  const more = list.length - shown.length;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = endRef.current;
    if (!el || more <= 0 || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setLimit(n => n + PAGE);
    }, { rootMargin: '0px 0px 600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, limit]);

  const months = useMemo(() => {
    const out: MonthGroup[] = [];
    for (const e of shown) {
      const key = isoMonth(e.date);
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(e);
      else out.push({ key, items: [e] });
    }
    return out;
  }, [shown]);

  // Each month's count and spending over the whole month (not just the rows rendered so far).
  const monthTotals = useMemo(() => {
    const out = new Map<string, { count: number; live: ExpenseDTO[] }>();
    for (const e of list) {
      if (e.deletedAt) continue;
      const key = isoMonth(e.date);
      const m = out.get(key) ?? { count: 0, live: [] };
      m.count++;
      m.live.push(e);
      out.set(key, m);
    }
    const totals = new Map<string, { count: number; spent: number }>();
    for (const [key, m] of out) totals.set(key, { count: m.count, spent: spendTotals(usableEntries(m.live, base), base).spent });
    return totals;
  }, [list, base]);

  const stubW = useMemo(
    () => stubWidth(list.map(e => stubText(rowEffect(e, meId, base), money)), locale === 'en'),
    [list, meId, base, money, locale],
  );

  if (!snap) return null;

  /** 「12 月」 / "December" (the year shows in the month headers). */
  const zhMonth = (key: string) => (locale === 'zh-TW' ? Number(key.slice(5, 7)) + ' 月' : new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(key + '-01T00:00:00Z')));

  const addPath = '/g/' + encodeURIComponent(gid) + '/add';
  const listStyle = { '--stub-w': stubW + 'px' } as CSSProperties;

  const deletedToggle =
    deletedCount > 0 ? (
      <Button
        variant="ghost"
        size="md"
        onClick={() => setShowDeleted(v => !v)}
        aria-pressed={showDeleted}
        data-testid="show-deleted"
        className={s.toggle}
      >
        {showDeleted
          ? t('隱藏已刪除的費用', 'Hide deleted expenses')
          : t('顯示已刪除的費用（{n}）', 'Show deleted expenses ({n})', { n: deletedCount })}
      </Button>
    ) : null;

  if (liveCount === 0 && !q && !list.length) {
    return (
      <div className={s.tab}>
        <div className={s.empty}>
          <EmptyState
            icon="general"
            title={t('還沒有費用', 'No expenses yet')}
            body={t('記下第一筆，誰該付誰會自動算好。', 'Add the first one and the app works out who owes whom.')}
            action={
              <Button variant="primary" icon="plus" onClick={() => navigate(addPath)}>
                {t('新增費用', 'Add expense')}
              </Button>
            }
          />
        </div>
        {deletedToggle ? <div className={s.end}>{deletedToggle}</div> : null}
      </div>
    );
  }

  return (
    <div className={s.tab}>
      <div className={s.tools} role="search">
        <TextField
          label={t('搜尋費用', 'Search expenses')}
          hideLabel
          leadingIcon="search"
          type="search"
          value={query}
          onChange={setQuery}
          placeholder={t('搜尋費用、成員或金額', 'Search expenses, people, amounts')}
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          bare
          data-testid="expense-search"
          trailing={
            query ? <IconButton icon="close" label={t('清除搜尋', 'Clear search')} onClick={() => setQuery('')} size={18} /> : undefined
          }
        />
      </div>

      {q && !list.length ? (
        <div className={s.empty}>
          <EmptyState
            icon="search"
            title={t('找不到「{q}」', 'Nothing found for "{q}"', { q })}
            body={t('換個關鍵字，或清除搜尋。', 'Try another word, or clear the search.')}
            action={
              <Button variant="secondary" onClick={() => setQuery('')}>
                {t('清除搜尋', 'Clear search')}
              </Button>
            }
          />
        </div>
      ) : null}

      {months.map(m => {
        const { count: n, spent } = monthTotals.get(m.key) ?? { count: 0, spent: 0 };
        return (
          <section key={m.key} aria-labelledby={'month-' + m.key} className={s.monthSec}>
            <h2 className={s.month} id={'month-' + m.key}>
              <span>{date(m.key + '-01', 'month')}</span>
              <small className={s.monthMeta}>
                {spent > 0
                  ? t('{n} 筆，共 {amt}', count(n, 'entry', 'entries') + ', {amt} spent', { n, amt: money(spent, base) })
                  : t('{n} 筆', count(n, 'entry', 'entries'), { n })}
              </small>
            </h2>
            <ul className={s.list} style={listStyle}>
              {m.items.map((e, i) => {
                const first = i === 0 || m.items[i - 1].date !== e.date;
                return (
                  <ExpenseRow
                    key={e.id}
                    expense={e}
                    snap={snap}
                    meId={meId}
                    pending={view.pending[e.id]}
                    showDate={first}
                    firstOfDay={first}
                    members={members}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}

      <div className={s.end} ref={endRef}>
        {more > 0 ? (
          <Button variant="ghost" onClick={() => setLimit(n => n + PAGE)} data-testid="expense-more">
            {t('再顯示 {n} 筆', Math.min(more, PAGE) === 1 ? 'Show 1 more entry' : 'Show {n} more entries', { n: Math.min(more, PAGE) })}
          </Button>
        ) : q ? (
          list.length ? <span>{t('找到 {n} 筆符合「{q}」', '{n} found for "{q}"', { n: list.length, q })}</span> : null
        ) : months.length === 1 ? (
          <span>
            {t('{m}的 {n} 筆都在這裡了', "That's all {n} for {m}", {
              m: zhMonth(months[0].key),
              n: liveCount,
            })}
          </span>
        ) : (
          <span>{t('全部 {n} 筆都在這裡了', "That's all {n}", { n: liveCount })}</span>
        )}
        {deletedToggle}
      </div>
    </div>
  );
}
