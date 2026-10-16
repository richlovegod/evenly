// Exchange rates: one table per day of units per 1 USD, cached in D1 `fx_cache`.
//
// Primary provider: Frankfurter v2 (https://api.frankfurter.dev, no key, 165 currencies).
// Fallback: fawazahmed0 currency-api on jsDelivr, then its Cloudflare Pages mirror.
// See docs/RESEARCH.md. A rate into any base is usd[base] / usd[currency].

import { allCurrencies } from '../../shared/currencies';
import { isISODate, todayUTC } from '../../shared/dates';
import { fail, nowISO } from '../http';

export interface UsdRates {
  /** The day these rates are for (may be earlier than asked for when nothing newer exists). */
  date: string;
  /** rates[C] = units of C per 1 USD; always has USD = 1. */
  rates: Record<string, number>;
  source: string;
}

const USER_AGENT = 'Evenly/1.0 (+https://github.com/richlovegod/evenly)';
const TIMEOUT_MS = 5000;
/** Today's table is fetched again after this long (sources publish at different hours). */
const TODAY_MAX_AGE_MS = 6 * 3_600_000;
/** A provider answer with fewer currencies than this is treated as a failure. */
const MIN_CURRENCIES = 20;

export const SOURCE_FRANKFURTER = 'frankfurter.dev';
export const SOURCE_CURRENCY_API = 'currency-api';

// The fallback also lists crypto tokens with 3-letter codes (BTC, ETH, SOL...), so only these
// money codes are kept from it: what Frankfurter lists, recently retired codes that still matter
// for old dates, and everything in shared/currencies.ts.
const FIAT_CODES: ReadonlySet<string> = new Set([
  ...(
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD ' +
    'CAD CDF CHF CLP CNH CNY COP CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GGP ' +
    'GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS IMP INR IQD IRR ISK JEP JMD JOD JPY KES KGS KHR ' +
    'KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRO MRU MUR MVR MWK MXN ' +
    'MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG ' +
    'SEK SGD SHP SLE SLL SOS SRD SSP STD STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD ' +
    'UYU UZS VED VEF VES VND VUV WST XAF XAG XAU XCD XCG XDR XOF XPD XPF XPT YER ZAR ZMW ZWG ZWL'
  ).split(' '),
  ...allCurrencies().map(c => c.code),
]);

function validRate(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/** Value of 1 `currency` in `base` (usd[base] / usd[currency]); 1 when equal; null when either is missing. */
export function rateToBase(usd: Record<string, number>, currency: string, base: string): number | null {
  if (currency === base) return 1;
  const b = usd[base];
  const c = usd[currency];
  if (!validRate(b) || !validRate(c)) return null;
  // 10 significant digits: plenty for money, and no float noise in JSON.
  return Number((b / c).toPrecision(10));
}

// ---------- providers ----------

/** Units per 1 USD, as parsed from a provider answer. */
type Table = Record<string, number>;

function finish(rates: Table): Table {
  rates.USD = 1;
  if (Object.keys(rates).length < MIN_CURRENCIES) throw new Error('too few currencies in the answer');
  return rates;
}

/**
 * Frankfurter v2: `[{ date, base: 'USD', quote: 'TWD', rate: 32.275 }, ...]`. Quotes can carry
 * different dates (markets publish at different times); each quote's own rate is used.
 */
export function parseFrankfurter(data: unknown): Table {
  if (!Array.isArray(data)) throw new Error('unexpected Frankfurter answer');
  const rates: Table = {};
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const q = item as { base?: unknown; quote?: unknown; rate?: unknown };
    if (q.base !== undefined && q.base !== 'USD') continue;
    if (typeof q.quote !== 'string' || !/^[A-Z]{3}$/.test(q.quote) || !validRate(q.rate)) continue;
    rates[q.quote] = q.rate;
  }
  return finish(rates);
}

/** currency-api: `{ date: '2024-03-15', usd: { twd: 31.6, btc: 0.0000139, ... } }`, lowercase codes. */
export function parseCurrencyApi(data: unknown): Table {
  if (!data || typeof data !== 'object') throw new Error('unexpected currency-api answer');
  const usd = (data as { usd?: unknown }).usd;
  if (!usd || typeof usd !== 'object') throw new Error('unexpected currency-api answer');
  const rates: Table = {};
  for (const [k, v] of Object.entries(usd as Record<string, unknown>)) {
    if (!/^[a-z]{3}$/.test(k) || !validRate(v)) continue;
    const code = k.toUpperCase();
    if (FIAT_CODES.has(code)) rates[code] = v;
  }
  return finish(rates);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/** `day` null = the newest table. */
async function fromFrankfurter(day: string | null): Promise<Table> {
  return parseFrankfurter(await getJson('https://api.frankfurter.dev/v2/rates?base=USD' + (day ? '&date=' + day : '')));
}

async function fromCurrencyApi(day: string | null): Promise<Table> {
  const tag = day ?? 'latest';
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/v1/currencies/usd.json`,
    `https://${tag}.currency-api.pages.dev/v1/currencies/usd.json`,
  ];
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      return parseCurrencyApi(await getJson(url));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('currency-api failed');
}

/** Try each provider in order; null when all fail. */
async function fetchTable(day: string | null): Promise<{ rates: Table; source: string } | null> {
  const providers: [string, (d: string | null) => Promise<Table>][] = [
    [SOURCE_FRANKFURTER, fromFrankfurter],
    [SOURCE_CURRENCY_API, fromCurrencyApi],
  ];
  for (const [source, get] of providers) {
    try {
      return { rates: await get(day), source };
    } catch (err) {
      console.warn(`fx: ${source} failed for ${day ?? 'latest'}:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

// ---------- cache ----------

interface CacheRow {
  day: string;
  rates: string;
  source: string;
  fetched_at: string;
}

function decode(row: CacheRow | null): (UsdRates & { fetchedAt: string }) | null {
  if (!row) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(row.rates);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const rates: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (validRate(v)) rates[k] = v;
  if (Object.keys(rates).length < 2) return null;
  rates.USD = 1;
  return { date: row.day, rates, source: row.source, fetchedAt: row.fetched_at };
}

/**
 * The USD table for `date` ('YYYY-MM-DD'). Today and future dates use the newest rates. Each day
 * is cached in fx_cache (today's row is refreshed after 6 hours; a row saved while its day was
 * still running is replaced by the final table once). When every provider fails, the cached day
 * nearest before the date is used (or the oldest one after it); with nothing cached at all this
 * throws 503 `fx_unavailable`.
 */
export async function getUsdRates(db: D1Database, date: string): Promise<UsdRates> {
  if (!isISODate(date)) fail(400, 'validation', 'Invalid date', [{ path: ['date'], message: 'Use YYYY-MM-DD' }]);
  const today = todayUTC();
  const day = date > today ? today : date;
  const isToday = day === today;

  const cached = decode(await db.prepare('SELECT * FROM fx_cache WHERE day = ?').bind(day).first<CacheRow>());
  if (cached) {
    const age = Date.now() - Date.parse(cached.fetchedAt);
    // Saved on or before its own day = possibly a partial table (some sources had not published yet).
    const provisional = cached.fetchedAt.slice(0, 10) <= day;
    if (isToday ? age < TODAY_MAX_AGE_MS : !provisional) return strip(cached);
  }

  const got = await fetchTable(isToday ? null : day);
  if (got) {
    const out: UsdRates = { date: day, rates: got.rates, source: got.source };
    try {
      await db
        .prepare(
          `INSERT INTO fx_cache (day, rates, source, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET rates = excluded.rates, source = excluded.source, fetched_at = excluded.fetched_at`,
        )
        .bind(day, JSON.stringify(out.rates), out.source, nowISO())
        .run();
    } catch (err) {
      console.error('fx: could not cache rates', err);
    }
    return out;
  }

  if (cached) return strip(cached);
  const nearest =
    decode(await db.prepare('SELECT * FROM fx_cache WHERE day <= ? ORDER BY day DESC LIMIT 1').bind(day).first<CacheRow>()) ??
    decode(await db.prepare('SELECT * FROM fx_cache WHERE day > ? ORDER BY day ASC LIMIT 1').bind(day).first<CacheRow>());
  if (nearest) return strip(nearest);
  fail(503, 'fx_unavailable', 'Exchange rates are unavailable right now');
}

function strip(r: UsdRates & { fetchedAt: string }): UsdRates {
  return { date: r.date, rates: r.rates, source: r.source };
}
