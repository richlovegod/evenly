// CurrencyPicker: a tall picker sheet for an expense, group or home currency.
// A search box (code, Chinese or English name, the symbol, and the names people actually type:
// 日幣, 台幣, 美金, RMB...), then three sections: the `highlight` currencies (group currency,
// recent ones, and the current choice), 常用 / Common (COMMON_CURRENCIES), and 全部 / All (every
// currency, A to Z by code). While searching, one list of matches, best first; Enter picks
// the first. Each row prints the code, the name in the current language and the symbol the
// app uses; the chosen currency is checked wherever it appears.
// Tapping a row calls onSelect; the caller closes the sheet (usually in onSelect).
// Test ids: currency-search (the box), currency-option-<CODE> (each row).

import { useMemo, useState, type HTMLAttributes } from 'react';
import { allCurrencies, COMMON_CURRENCIES, getCurrency, type CurrencyInfo } from '../../shared/currencies';
import { useT } from '../lib/i18n';
import { Icon } from './Icon';
import { Section } from './Section';
import { Sheet } from './Sheet';
import { TextField } from './TextField';
import s from './CurrencyPicker.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Other names people type for a currency: what Taiwan calls it day to day (日幣, 美金), the
 * country, and common English words. Search keys only, never shown.
 */
const ALIASES: Record<string, readonly string[]> = {
  TWD: ['台幣', '新台幣', '台灣', 'ntd', 'nt', 'taiwan'],
  USD: ['美金', '美國', 'usa', 'america', 'dollar'],
  JPY: ['日幣', '日元', '日円', '円', '日本', 'yen', 'japan'],
  CNY: ['rmb', '人民幣', '中國', 'yuan', 'renminbi', 'china'],
  HKD: ['港元', '香港', 'hong kong'],
  MOP: ['澳門元', '澳門', 'macau', 'macao'],
  KRW: ['韓幣', '韓國', 'won', 'korea'],
  EUR: ['歐洲', '歐盟', 'euro', 'europe'],
  GBP: ['英國', 'pound', 'sterling', 'uk', 'britain'],
  CAD: ['加幣', '加元', '加拿大', 'canada'],
  AUD: ['澳元', '澳洲', 'australia'],
  NZD: ['紐幣', '紐元', '紐西蘭', 'new zealand'],
  SGD: ['新幣', '星幣', '新加坡', 'singapore'],
  THB: ['泰幣', '泰國', 'baht', 'thailand'],
  VND: ['越幣', '越南', 'dong', 'vietnam'],
  MYR: ['馬幣', '令吉', '馬來西亞', 'ringgit', 'malaysia'],
  IDR: ['印尼', 'rupiah', 'indonesia', 'bali'],
  PHP: ['披索', '菲律賓', 'peso', 'philippines'],
  INR: ['印度', 'rupee', 'india'],
  CHF: ['瑞士', 'franc', 'switzerland'],
  MXN: ['墨西哥', 'mexico'],
  BRL: ['巴西', 'brazil'],
  TRY: ['土耳其', 'turkey', 'turkiye'],
  AED: ['杜拜', 'dubai', 'uae'],
  ISK: ['冰島', 'iceland'],
  CZK: ['捷克', 'czech', 'prague'],
  KHR: ['柬埔寨', 'cambodia'],
  PEN: ['秘魯', 'peru'],
  CRC: ['哥斯大黎加', 'costa rica'],
};

const VALID = /^[A-Z]{3}$/;
const COMMON_INDEX = new Map(COMMON_CURRENCIES.map((c, i) => [c, i]));

/** Lowercase, full-width letters to half-width, 臺 to 台, single spaces. */
function norm(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/臺/g, '台').replace(/\s+/g, ' ').trim();
}

interface Indexed {
  info: CurrencyInfo;
  code: string;
  symbol: string;
  names: string[];
}

const INDEX: Indexed[] = allCurrencies().map(info => ({
  info,
  code: info.code.toLowerCase(),
  symbol: norm(info.symbol),
  names: [norm(info.zh), norm(info.en), ...(ALIASES[info.code] ?? []).map(norm)],
}));

/** How well a currency matches the query: 0 is best, -1 is no match. */
function rank(c: Indexed, q: string): number {
  if (c.code === q) return 0;
  if (c.symbol === q) return 1;
  if (c.code.startsWith(q)) return 2;
  if (c.names.some(n => n === q)) return 3;
  if (c.names.some(n => n.startsWith(q))) return 4;
  if (c.names.some(n => n.split(/[\s,]+/).some(w => w.startsWith(q)))) return 5;
  if (c.code.includes(q) || c.symbol.includes(q) || c.names.some(n => n.includes(q))) return 6;
  return -1;
}

/** Currencies matching `query`, best first (then common ones, then by code). */
export function searchCurrencies(query: string): CurrencyInfo[] {
  const q = norm(query);
  if (!q) return [];
  return INDEX.map(c => ({ c, r: rank(c, q) }))
    .filter(x => x.r >= 0)
    .sort((a, b) => a.r - b.r || (COMMON_INDEX.get(a.c.info.code) ?? 99) - (COMMON_INDEX.get(b.c.info.code) ?? 99) || (a.c.info.code < b.c.info.code ? -1 : 1))
    .map(x => x.c.info);
}

export interface CurrencyPickerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onSelect'> {
  open: boolean;
  onClose: () => void;
  /** The currency now chosen (checked, and listed with the highlights). */
  value: string;
  onSelect: (code: string) => void;
  /** Shown first: the group currency, then recent ones. */
  highlight?: string[];
  /** Title of the highlight section (default 建議 / Suggested). */
  highlightTitle?: string;
  /** Sheet title (default 幣別 / Currency). */
  title?: string;
}

export function CurrencyPicker({ open, onClose, value, onSelect, highlight, highlightTitle, title, className, ...rest }: CurrencyPickerProps) {
  const { t } = useT();
  const heading = title ?? t('幣別', 'Currency');
  return (
    <Sheet open={open} onClose={onClose} title={heading} className={cx(s.sheet, className)} {...rest}>
      <CurrencyList value={value} onSelect={onSelect} highlight={highlight} highlightTitle={highlightTitle} />
    </Sheet>
  );
}

/** The sheet body. Its own component, so the search starts empty every time the sheet opens. */
function CurrencyList({ value, onSelect, highlight, highlightTitle }: Pick<CurrencyPickerProps, 'value' | 'onSelect' | 'highlight' | 'highlightTitle'>) {
  const { t, zh } = useT();
  const [query, setQuery] = useState('');

  const sections = useMemo(() => {
    const top: string[] = [];
    for (const raw of [...(highlight ?? []), value]) {
      const code = (raw ?? '').trim().toUpperCase();
      if (VALID.test(code) && !top.includes(code)) top.push(code);
    }
    const common = COMMON_CURRENCIES.filter(c => !top.includes(c));
    const all = allCurrencies().slice().sort((a, b) => (a.code < b.code ? -1 : 1));
    // getCurrency also covers a well-formed code outside the table (its name is the code).
    return { top: top.map(getCurrency), common: common.map(getCurrency), all };
  }, [highlight, value]);

  const results = useMemo(() => searchCurrencies(query), [query]);
  const searching = norm(query) !== '';

  const row = (c: CurrencyInfo, key: string) => {
    const on = c.code === value;
    const symbol = c.symbol.trim();
    return (
      <li key={key} role="none">
        <button
          type="button"
          role="radio"
          aria-checked={on}
          className={cx(s.option, on && s.on)}
          onClick={() => onSelect(c.code)}
          data-testid={`currency-option-${c.code}`}
          data-code={c.code}
        >
          <span className={s.code}>{c.code}</span>
          <span className={s.name}>{zh ? c.zh : c.en}</span>
          {symbol && symbol !== c.code ? <span className={s.symbol} aria-hidden="true">{symbol}</span> : null}
          {on ? <Icon name="check" size={22} strokeWidth={2.4} className={s.check} /> : <span className={s.checkSlot} aria-hidden="true" />}
        </button>
      </li>
    );
  };

  const group = (title: string, list: CurrencyInfo[], key: string) =>
    list.length ? (
      <Section title={title} key={key} className={s.section}>
        <ul className={s.panel} role="radiogroup" aria-label={title}>
          {list.map(c => row(c, key + c.code))}
        </ul>
      </Section>
    ) : null;

  return (
    <>
      <div className={s.search}>
        <TextField
          label={t('搜尋幣別', 'Search currencies')}
          hideLabel
          bare
          type="search"
          value={query}
          onChange={setQuery}
          placeholder={t('搜尋代碼或名稱，例如 JPY、日幣', 'Code or name, like JPY or yen')}
          leadingIcon="search"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          maxLength={40}
          onEnter={() => {
            if (results[0]) onSelect(results[0].code);
          }}
          trailing={
            query ? (
              <button type="button" className={s.clear} onClick={() => setQuery('')} aria-label={t('清除搜尋', 'Clear search')}>
                <Icon name="close" size={20} />
              </button>
            ) : undefined
          }
          data-testid="currency-search"
          // With a mouse and keyboard, start typing right away: the sheet focuses the search as it
          // opens. On a phone it focuses the sheet instead and the keyboard stays down (most picks
          // are one of the first rows), the rule for every sheet (Sheet.tsx useOverlay, DESIGN.md 9.5).
          data-autofocus=""
        />
      </div>

      {searching ? (
        results.length ? (
          <ul className={cx(s.panel, s.results)} role="radiogroup" aria-label={t('搜尋結果', 'Search results')}>
            {results.map(c => row(c, 'r' + c.code))}
          </ul>
        ) : (
          <p className={s.none} role="status">
            {t('找不到「{q}」的幣別', 'No currency matches "{q}"', { q: query.trim() })}
          </p>
        )
      ) : (
        <>
          {group(highlightTitle ?? t('建議', 'Suggested'), sections.top, 'h')}
          {group(t('常用', 'Common'), sections.common, 'c')}
          {group(t('全部', 'All'), sections.all, 'a')}
        </>
      )}
    </>
  );
}
