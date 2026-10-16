// Two languages, written side by side at the call site: t('新增費用', 'Add expense').
// Placeholders: t('{n} 位成員', '{n} members', { n: 3 }).

import { useSyncExternalStore } from 'react';
import { formatMoney, type FormatOptions } from '../../shared/money';
import type { Locale } from '../../shared/types';

const KEY = 'evenly.locale';

function detect(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'zh-TW') return saved;
  } catch {
    /* ignore */
  }
  const langs = typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : [];
  return langs.some(l => /^zh/i.test(l)) ? 'zh-TW' : 'en';
}

let locale: Locale = detect();
const listeners = new Set<() => void>();
applyDocumentLang();

function applyDocumentLang() {
  if (typeof document !== 'undefined') document.documentElement.lang = locale === 'zh-TW' ? 'zh-Hant-TW' : 'en';
}

export function getLocale(): Locale {
  return locale;
}

export function setLocale(l: Locale): void {
  if (l === locale) return;
  locale = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* ignore */
  }
  applyDocumentLang();
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export type Params = Record<string, string | number>;

function fill(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/** Translate outside React (toasts, errors). Inside components prefer useT(). */
export function t(zh: string, en: string, params?: Params): string {
  return fill(locale === 'zh-TW' ? zh : en, params);
}

// ---------- formatting ----------

const dfCache = new Map<string, Intl.DateTimeFormat>();
function df(opts: Intl.DateTimeFormatOptions, key: string): Intl.DateTimeFormat {
  const k = locale + key;
  let f = dfCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale === 'zh-TW' ? 'zh-TW' : 'en-US', { timeZone: 'UTC', ...opts });
    dfCache.set(k, f);
  }
  return f;
}

function isoToDate(iso: string): Date {
  return new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
}

export type DateStyle = 'md' | 'mdw' | 'long' | 'month' | 'weekday';

/** Format a 'YYYY-MM-DD' date. md: 12/18 or Dec 18; mdw: 12/18（四） or Thu, Dec 18; long; month. */
export function formatDate(iso: string, style: DateStyle = 'md'): string {
  if (!iso) return '';
  const d = isoToDate(iso.slice(0, 10));
  if (Number.isNaN(d.getTime())) return iso;
  const zh = locale === 'zh-TW';
  switch (style) {
    case 'md':
      return zh ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : df({ month: 'short', day: 'numeric' }, 'md').format(d);
    case 'mdw': {
      if (zh) {
        const w = '日一二三四五六'[d.getUTCDay()];
        return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${w}）`;
      }
      return df({ weekday: 'short', month: 'short', day: 'numeric' }, 'mdw').format(d);
    }
    case 'long':
      return zh ? `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日` : df({ year: 'numeric', month: 'short', day: 'numeric' }, 'long').format(d);
    case 'month':
      return zh ? `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月` : df({ year: 'numeric', month: 'long' }, 'month').format(d);
    case 'weekday':
      return zh ? '週' + '日一二三四五六'[d.getUTCDay()] : df({ weekday: 'long' }, 'wd').format(d);
  }
}

/** Local time of a timestamp, e.g. 下午 3:05 / 3:05 PM. */
export function formatTime(isoTs: string): string {
  const d = new Date(isoTs);
  return new Intl.DateTimeFormat(locale === 'zh-TW' ? 'zh-TW' : 'en-US', { hour: 'numeric', minute: '2-digit' }).format(d);
}

/** "剛剛 / 5 分鐘前 / 3 小時前 / 昨天 / 12/18" for a timestamp. */
export function formatRelative(isoTs: string, now = Date.now()): string {
  const ts = Date.parse(isoTs);
  if (Number.isNaN(ts)) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return t('剛剛', 'just now');
  const m = Math.round(s / 60);
  if (m < 60) return t('{n} 分鐘前', '{n} min ago', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('{n} 小時前', '{n} h ago', { n: h });
  const d = Math.round(h / 24);
  if (d === 1) return t('昨天', 'yesterday');
  if (d < 7) return t('{n} 天前', '{n} days ago', { n: d });
  const local = new Date(ts);
  const iso = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  const thisYear = new Date(now).getFullYear() === local.getFullYear();
  return formatDate(iso, thisYear ? 'md' : 'long');
}

/** Money in the current locale: money(125050, 'USD') -> "US$1,250.50". */
export function money(minor: number, currency: string, opts?: FormatOptions): string {
  return formatMoney(minor, currency, locale, opts);
}

export function formatNumber(n: number, maxFrac = 2): string {
  return new Intl.NumberFormat(locale === 'zh-TW' ? 'zh-TW' : 'en-US', { maximumFractionDigits: maxFrac }).format(n);
}

export interface I18n {
  locale: Locale;
  zh: boolean;
  t: typeof t;
  money: typeof money;
  date: typeof formatDate;
  time: typeof formatTime;
  relative: typeof formatRelative;
  num: typeof formatNumber;
}

const api = (): I18n => ({ locale, zh: locale === 'zh-TW', t, money, date: formatDate, time: formatTime, relative: formatRelative, num: formatNumber });
let snapshot = api();
listeners.add(() => { snapshot = api(); });

/** Re-renders the component when the language changes. */
export function useT(): I18n {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
