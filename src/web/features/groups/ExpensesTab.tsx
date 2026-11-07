// 費用 tab: search, then the entries by month (newest first) with each month's count and total,
// one ExpenseRow per entry. Deleted entries stay hidden until asked for, then show dimmed with
// 復原. Entries that failed to sync always show, so they can be retried or dropped.
// The search, 顯示已刪除 and how many rows are shown are kept in the page's own history entry, so
// coming back from an entry (or another tab of the group) finds the list as it was, and opening
// the group anew starts with a clean one.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { spendTotals } from '../../../shared/balances';
import { categoryLabel } from '../../../shared/categories';
import { allCurrencies } from '../../../shared/currencies';
import { isoMonth } from '../../../shared/dates';
import { minorToInput } from '../../../shared/money';
import type { ExpenseDTO, MemberDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { IconButton } from '../../components/IconButton';
import { TextField } from '../../components/TextField';
import { useT } from '../../lib/i18n';
import { getRoute, navigate } from '../../lib/router';
import { membersById, visiblePhotos, type GroupView } from '../../lib/store';
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

let currencyMarks: readonly string[] | null = null;

/**
 * What may stand right before or after a typed amount, lower case: every symbol and code the app
 * knows (NT$, US$, ¥, CN¥, €, £, ₩, JPY...), and $, 元, 円, 圓 and NTD. Longest first, so NT$ goes
 * before $.
 */
function marks(): readonly string[] {
  if (currencyMarks) return currencyMarks;
  const set = new Set(['$', '¥', '元', '円', '圓', 'ntd']);
  for (const c of allCurrencies()) {
    set.add(c.code.toLowerCase());
    const sym = c.symbol.trim().toLowerCase();
    if (sym) set.add(sym);
  }
  currencyMarks = [...set].sort((a, b) => b.length - a.length);
  return currencyMarks;
}

/**
 * One search word as an amount: its digits ("12600" for 12,600, ¥12,600, NT$12600, 12600元), ''
 * for a word that is only a currency mark (NT$, JPY), or null for any other word. "Day", "b2" and
 * "3號" are not amounts.
 */
export function amountWord(word: string): string | null {
  let w = word.normalize('NFKC').toLowerCase().replace(/[,，]/g, '');
  const mark = marks().find(m => w.startsWith(m)) ?? marks().find(m => w.endsWith(m));
  if (mark) w = w.startsWith(mark) ? w.slice(mark.length) : w.slice(0, w.length - mark.length);
  if (!w) return mark ? '' : null;
  return /^\d*\.?\d+$/.test(w) ? w : null;
}

/**
 * Does an entry match the search: the whole query in its description, notes, category or people,
 * or else every word of it, each in that text or (a word that is an amount) in the amount
 * ("晚餐 1300", "¥12,600", "NT$ 2400"). A word that is only a currency mark is passed over. So the
 * digits in "Day 3" or "iPhone 15" never match by amount alone: their words have to match too.
 */
export function matchesQuery(e: ExpenseDTO, query: string, members: Record<string, MemberDTO>, locale: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const ids = new Set<string>();
  for (const p of e.payers) ids.add(p.memberId);
  for (const p of e.shares) ids.add(p.memberId);
  const names = [...ids].map(id => members[id]?.name ?? '');
  const hay = [e.description, e.notes, categoryLabel(e.category, locale), ...names].join('\n').toLowerCase();
  if (hay.includes(q)) return true;
  const amount = minorToInput(e.amount, e.currency);
  let matched = false;
  for (const w of q.split(/\s+/)) {
    if (hay.includes(w)) {
      matched = true;
      continue;
    }
    const a = amountWord(w);
    if (a === '') continue;
    if (a === null || !amount.includes(a)) return false;
    matched = true;
  }
  return matched;
}

/** The list as it was left: kept in the history entry it was shown in (history.state.evenlyList). */
export interface ListState {
  gid: string;
  query: string;
  showDeleted: boolean;
  limit: number;
}

const LIST_KEY = 'evenlyList';

/** The list state this history entry holds for group `gid`, if any. */
export function savedListState(state: unknown, gid: string): ListState | null {
  const v = state && typeof state === 'object' ? (state as Record<string, unknown>)[LIST_KEY] : undefined;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.gid !== gid || typeof o.query !== 'string' || typeof o.showDeleted !== 'boolean' || typeof o.limit !== 'number' || !Number.isFinite(o.limit)) return null;
  return { gid, query: o.query, showDeleted: o.showDeleted, limit: Math.max(PAGE, Math.round(o.limit)) };
}

/** The history entry's state with the list state in it, everything else it holds kept (the router's depth). */
export function withListState(state: unknown, list: ListState): Record<string, unknown> {
  return { ...(state && typeof state === 'object' ? (state as Record<string, unknown>) : {}), [LIST_KEY]: list };
}

function readListState(gid: string): ListState | null {
  try {
    return savedListState(history.state, gid);
  } catch {
    return null;
  }
}

/** How long the list waits after a change before it writes it into the history entry. */
const KEEP_MS = 250;

export function ExpensesTab({ gid, view }: { gid: string; view: GroupView }) {
  const { t, locale, money, date } = useT();
  const snap = view.snap;
  // The list as it was left in this history entry (back from an entry, or from another tab of the
  // group); a page opened anew has none. GroupPage gives each group its own tab (key), so another
  // group never starts from this one's search.
  const [saved] = useState(() => readListState(gid));
  const [query, setQuery] = useState(saved?.query ?? '');
  const [showDeleted, setShowDeleted] = useState(saved?.showDeleted ?? false);

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
  const [limit, setLimit] = useState(saved?.limit ?? PAGE);
  const shown = useMemo(() => list.slice(0, limit), [list, limit]);

  // Keep the list in the history entry it is shown in, a moment after each change (Safari refuses
  // many history writes in a row), and only while that entry is still the page.
  const listPath = useRef(getRoute().path);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (getRoute().path !== listPath.current) return;
      try {
        const kept = savedListState(history.state, gid);
        if (kept ? kept.query === query && kept.showDeleted === showDeleted && kept.limit === limit : !query && !showDeleted && limit === PAGE) return;
        history.replaceState(withListState(history.state, { gid, query, showDeleted, limit }), '', location.pathname + location.search + location.hash);
      } catch {
        // History unavailable or refusing: the list starts over next time.
      }
    }, KEEP_MS);
    return () => clearTimeout(timer);
  }, [gid, query, showDeleted, limit]);
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
                    photos={visiblePhotos(e, view.pendingPhotos[e.id], view.pendingReceipts[e.id]).length}
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
