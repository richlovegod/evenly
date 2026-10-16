// Money helpers. Every amount is an integer number of minor units (see currencies.ts),
// so arithmetic is exact; floating point is only used for exchange-rate conversion.

import { getCurrency } from './currencies';

/** Largest amount accepted anywhere (minor units). Well inside Number.MAX_SAFE_INTEGER. */
export const MAX_AMOUNT = 1_000_000_000_000;

const POW10 = [1, 10, 100, 1000, 10000, 100000, 1000000];

export function pow10(n: number): number {
  return POW10[n] ?? Math.pow(10, n);
}

/**
 * Minor units to a plain decimal string without grouping, for prefilling inputs:
 * 125050 (2 dp) -> "1250.50", 125000 -> "1250" (whole amounts get no fraction).
 */
export function minorToInput(minor: number, code: string): string {
  const d = getCurrency(code).decimals;
  const neg = minor < 0;
  const abs = Math.abs(minor);
  if (d === 0) return (neg ? '-' : '') + String(abs);
  const s = String(abs).padStart(d + 1, '0');
  const int = s.slice(0, s.length - d);
  const frac = s.slice(s.length - d);
  return (neg ? '-' : '') + int + (/^0+$/.test(frac) ? '' : '.' + frac);
}

/** Minor units to a major-unit number (for display math and charts only). */
export function toMajor(minor: number, code: string): number {
  return minor / pow10(getCurrency(code).decimals);
}

const FULL_WIDTH: Record<string, string> = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  '．': '.', '，': ',', '＋': '+', '－': '-', '＊': '*', '×': '*', '✕': '*', '÷': '/', '／': '/',
  '（': '(', '）': ')', '−': '-',
};

function normalizeInput(raw: string): string {
  let s = '';
  for (const ch of raw) s += FULL_WIDTH[ch] ?? ch;
  // The Peruvian sol symbol "S/" (older "S/.") in front of a number is not a division.
  s = s.replace(/(^|[^a-z])s\/\.?(?=\s*[\d.])/gi, '$1');
  // "x" between two numbers is a multiplication sign ("12.5x3", "3 x 450"), not a letter to drop.
  s = s.replace(/([\d.)])\s*x\s*(?=[\d.(])/gi, '$1*');
  // A period right after a letter ends an abbreviation ("Rs. 500", "kr. 125", "Kč. 100"), it
  // is not a decimal point.
  s = s.replace(/(\p{L})\./gu, '$1');
  // Keep digits, separators and operators; drop spaces, letters and currency symbols
  // people paste in ("NT$ 1,200", "¥12,600", "12.50 USD").
  return s.replace(/[^0-9.,+\-*/()]/g, '');
}

/**
 * Decide, number by number, which separator is the decimal point.
 * Both "," and ".": the one that comes last ("1,234,567.5" US style, "1.234,56" European).
 * Only commas: a decimal comma when there is one comma with a 1 or 2 digit tail ("12,5",
 * "0,75"), else thousands separators ("1,234", "1,234,567").
 */
function fixSeparators(s: string): string {
  if (!s.includes(',')) return s;
  return s.replace(/\d[\d.,]*/g, num => {
    if (!num.includes(',')) return num;
    if (num.includes('.')) {
      return num.lastIndexOf('.') > num.lastIndexOf(',') ? num.replace(/,/g, '') : num.replace(/\./g, '').replace(',', '.');
    }
    const parts = num.split(',');
    const last = parts[parts.length - 1];
    if (parts.length === 2 && last.length > 0 && last.length <= 2) return parts[0] + '.' + last;
    return parts.join('');
  });
}

/** Exact decimal string ("1234.567") to minor units with half-up rounding of extra digits. */
function decimalToMinor(num: string, decimals: number): number | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(num);
  if (!m) return null;
  const intPart = m[1] || '0';
  const fracPart = m[2] ?? '';
  if (intPart === '0' && fracPart === '' && !/\d/.test(num)) return null;
  const keep = fracPart.slice(0, decimals).padEnd(decimals, '0');
  const rest = fracPart.slice(decimals);
  let minor = Number(intPart) * pow10(decimals) + (decimals ? Number(keep) : 0);
  if (rest.length && Number(rest[0]) >= 5) minor += 1;
  if (!Number.isSafeInteger(minor)) return null;
  return minor;
}

type Tok = { t: 'num'; v: string } | { t: 'op'; v: string };

function tokenize(s: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const v = s.slice(i, j);
      if ((v.match(/\./g) || []).length > 1) return null;
      out.push({ t: 'num', v });
      i = j;
    } else if ('+-*/()'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Parse what a person typed into an amount field into minor units.
 * Accepts grouping commas, decimal commas, full-width digits, pasted symbols and simple
 * arithmetic ("1200+350", "3*450", "(80+45)/2"). Returns null when it is not a number
 * or is negative; returns 0 for zero (callers decide whether zero is allowed).
 */
export function parseAmount(raw: string, code: string): number | null {
  const decimals = getCurrency(code).decimals;
  let s = normalizeInput(raw);
  if (!s) return null;
  s = fixSeparators(s);
  const toks = tokenize(s);
  if (!toks || toks.length === 0) return null;

  // Plain number: parse exactly as a decimal string.
  if (toks.length === 1 && toks[0].t === 'num') {
    const v = decimalToMinor(toks[0].v, decimals);
    return v !== null && v <= MAX_AMOUNT ? v : null;
  }

  // Expression: recursive descent over floats, rounded once at the end.
  let pos = 0;
  const peek = () => toks[pos];
  const fail = (): never => { throw new Error('bad'); };
  const factor = (): number => {
    const tk = peek();
    if (!tk) return fail();
    if (tk.t === 'op' && tk.v === '-') { pos++; return -factor(); }
    if (tk.t === 'op' && tk.v === '(') {
      pos++;
      const v = expr();
      const close = peek();
      if (!close || close.t !== 'op' || close.v !== ')') return fail();
      pos++;
      return v;
    }
    if (tk.t === 'num') {
      pos++;
      if (tk.v === '.' ) return fail();
      return Number(tk.v);
    }
    return fail();
  };
  const term = (): number => {
    let v = factor();
    for (;;) {
      const tk = peek();
      if (tk && tk.t === 'op' && (tk.v === '*' || tk.v === '/')) {
        pos++;
        const r = factor();
        if (tk.v === '*') v *= r;
        else { if (r === 0) return fail(); v /= r; }
      } else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      const tk = peek();
      if (tk && tk.t === 'op' && (tk.v === '+' || tk.v === '-')) {
        pos++;
        const r = term();
        v = tk.v === '+' ? v + r : v - r;
      } else return v;
    }
  };
  try {
    const v = expr();
    if (pos !== toks.length || !Number.isFinite(v) || v < 0) return null;
    const minor = Math.round(Number((v * pow10(decimals)).toPrecision(15)));
    return Number.isSafeInteger(minor) && minor <= MAX_AMOUNT ? minor : null;
  } catch {
    return null;
  }
}

/** True when the input contains arithmetic, so the UI can show the computed result. */
export function isExpression(raw: string): boolean {
  const s = normalizeInput(raw);
  return /\d\s*[+*/\-]\s*[\d(]/.test(s) || s.includes('(');
}

const nfCache = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: string, decimals: number): Intl.NumberFormat {
  const key = locale + ':' + decimals;
  let nf = nfCache.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(locale.startsWith('zh') ? 'zh-TW' : 'en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: true,
    });
    nfCache.set(key, nf);
  }
  return nf;
}

export interface FormatOptions {
  /** 'auto' shows "-" for negatives (default), 'always' also shows "+", 'never' shows the absolute value. */
  sign?: 'auto' | 'always' | 'never';
  /** Leave out the currency symbol. */
  bare?: boolean;
}

/** Format minor units for display: formatMoney(125050, 'USD') -> "US$1,250.50", (-1200, 'TWD') -> "-NT$1,200". */
export function formatMoney(minor: number, code: string, locale = 'zh-TW', opts: FormatOptions = {}): string {
  const c = getCurrency(code);
  const abs = Math.abs(minor) / pow10(c.decimals);
  const body = numberFormat(locale, c.decimals).format(abs);
  const sign = opts.sign ?? 'auto';
  let prefix = '';
  if (minor < 0 && sign !== 'never') prefix = '-';
  else if (minor > 0 && sign === 'always') prefix = '+';
  return prefix + (opts.bare ? '' : c.symbol) + body;
}

/** Sum of portion amounts. */
export function sumAmounts(list: { amount: number }[]): number {
  let s = 0;
  for (const p of list) s += p.amount;
  return s;
}
