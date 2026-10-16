import { pbkdf2Sync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertMinor } from '../../src/shared/balances';
import {
  constantTimeEqual, DUMMY_PASSWORD_HASH, hashPassword, ipKey, limitFrom, normalizeEmail, PBKDF2_ITERATIONS, validPassword,
  verifyPassword,
} from '../../src/worker/auth';
import { ApiError, b64url, fromB64url } from '../../src/worker/http';
import {
  getUsdRates, parseCurrencyApi, parseFrankfurter, rateToBase, SOURCE_CURRENCY_API, SOURCE_FRANKFURTER,
} from '../../src/worker/services/fx';

const HASH_RE = /^pbkdf2-sha256\$4000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;

describe('hashPassword / verifyPassword', () => {
  it('produces the documented format with 4,000 iterations, a 16-byte salt and a 32-byte key', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(HASH_RE);
    expect(PBKDF2_ITERATIONS).toBe(4000);
    const [, iter, salt, key] = h.split('$');
    expect(Number(iter)).toBe(4000);
    expect(fromB64url(salt).length).toBe(16);
    expect(fromB64url(key).length).toBe(32);
  });

  it('accepts the right password and rejects others', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('Correct horse battery', h)).toBe(false);
    expect(await verifyPassword('correct horse battery ', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  it('salts every hash differently', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('matches an independent PBKDF2 implementation (node:crypto)', async () => {
    const pw = 'abbie password 1';
    const h = await hashPassword(pw);
    const [, , salt, key] = h.split('$');
    const expected = pbkdf2Sync(pw, Buffer.from(fromB64url(salt)), 4000, 32, 'sha256');
    expect(b64url(new Uint8Array(expected))).toBe(key);
  });

  it('verifies a known PBKDF2-HMAC-SHA256 test vector with its own iteration count', async () => {
    // password "password", salt "salt", 4096 iterations, 32 bytes
    const key = Buffer.from('c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a', 'hex');
    const stored = `pbkdf2-sha256$4096$${b64url(new TextEncoder().encode('salt'))}$${b64url(new Uint8Array(key))}`;
    expect(await verifyPassword('password', stored)).toBe(true);
    expect(await verifyPassword('Password', stored)).toBe(false);
  });

  it('handles Chinese, emoji and differently composed accents', async () => {
    const h = await hashPassword('我的密碼是祕密🙂');
    expect(await verifyPassword('我的密碼是祕密🙂', h)).toBe(true);
    expect(await verifyPassword('我的密碼是秘密🙂', h)).toBe(false);
    const composed = 'café au lait'; // e-acute as one code point (NFC)
    const decomposed = 'café au lait'; // e + combining accent (NFD)
    expect(composed).not.toBe(decomposed);
    const cafe = await hashPassword(composed);
    expect(await verifyPassword(decomposed, cafe)).toBe(true);
    expect(await verifyPassword('cafe au lait', cafe)).toBe(false);
  });

  it('returns false (never throws) for malformed stored values', async () => {
    const good = await hashPassword('password123');
    const [, , salt, key] = good.split('$');
    const bad = [
      '',
      'not a hash',
      `bcrypt$100000$${salt}$${key}`,
      `pbkdf2-sha256$100000$${salt}`,
      `pbkdf2-sha256$100000$${salt}$${key}$extra`,
      `pbkdf2-sha256$0$${salt}$${key}`,
      `pbkdf2-sha256$abc$${salt}$${key}`,
      `pbkdf2-sha256$-5$${salt}$${key}`,
      `pbkdf2-sha256$100001$${salt}$${key}`, // more than Workers allow
      `pbkdf2-sha256$100000$${salt}$${key.slice(0, 10)}`, // key too short
      `pbkdf2-sha256$100000$$${key}`,
      `pbkdf2-sha256$100000$${salt}$not+base64/url=`,
      `pbkdf2-sha256$100000$${salt}$a`, // impossible base64 length
    ];
    for (const s of bad) expect(await verifyPassword('password123', s)).toBe(false);
  });

  it('has a dummy hash that costs a full check and matches nothing', async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(HASH_RE);
    expect(await verifyPassword('password', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword('', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe('small auth helpers', () => {
  it('compares bytes', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });

  it('validates passwords: 8 to 200 characters, not only spaces', () => {
    expect(validPassword('short')).toBe(false);
    expect(validPassword('1234567')).toBe(false);
    expect(validPassword('12345678')).toBe(true);
    expect(validPassword('        ')).toBe(false);
    expect(validPassword('correct horse')).toBe(true);
    expect(validPassword('x'.repeat(200))).toBe(true);
    expect(validPassword('x'.repeat(201))).toBe(false);
    expect(validPassword('🙂'.repeat(8))).toBe(true); // 8 characters, 16 UTF-16 units
    expect(validPassword('🙂'.repeat(7))).toBe(false);
    expect(validPassword('密碼密碼密碼密碼')).toBe(true);
  });

  it('normalizes sign-in emails', () => {
    expect(normalizeEmail('  Gino.Chang+trip@Example.COM ')).toBe('gino.chang+trip@example.com');
    expect(normalizeEmail('test-a-x1@evenly.test')).toBe('test-a-x1@evenly.test');
    expect(normalizeEmail('abbie@mail.co.jp')).toBe('abbie@mail.co.jp');
    for (const bad of ['', 'gino', 'gino@', '@example.com', 'gino@localhost', 'gi no@example.com', 'a@b@c.com', 'gino@example.', 'gino@.com']) {
      expect(normalizeEmail(bad)).toBeNull();
    }
    expect(normalizeEmail('e'.repeat(108) + '@evenly.test')).not.toBeNull(); // 120 characters
    expect(normalizeEmail('e'.repeat(109) + '@evenly.test')).toBeNull(); // 121 characters
  });

  it('reads rate-limit overrides', () => {
    expect(limitFrom(undefined, 10)).toBe(10);
    expect(limitFrom('', 10)).toBe(10);
    expect(limitFrom('1000', 10)).toBe(1000);
    expect(limitFrom(' 200 ', 10)).toBe(200);
    expect(limitFrom('abc', 10)).toBe(10);
    expect(limitFrom('0', 10)).toBe(10);
    expect(limitFrom('-3', 10)).toBe(10);
    expect(limitFrom(25, 10)).toBe(25);
  });

  it('groups IPv6 clients by /64 and keeps IPv4 as is', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('2001:db8:85a3:0:0:8a2e:370:7334')).toBe('2001:db8:85a3:0::/64');
    expect(ipKey('2001:0DB8:85A3:0000:1111:8a2e:370:7334')).toBe('2001:db8:85a3:0::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('::ffff:198.51.100.4')).toBe('198.51.100.4');
    expect(ipKey('')).toBe('unknown');
  });
});

// ---------- exchange rates ----------

const USD_TABLE: Record<string, number> = { USD: 1, TWD: 32.275, JPY: 158.19, EUR: 0.89256, KRW: 1385.2, CNY: 7.1234 };

describe('rateToBase', () => {
  it('is 1 for the same currency, even one the table lacks', () => {
    expect(rateToBase(USD_TABLE, 'TWD', 'TWD')).toBe(1);
    expect(rateToBase({}, 'XYZ', 'XYZ')).toBe(1);
  });

  it('converts through USD: usd[base] / usd[currency]', () => {
    expect(rateToBase(USD_TABLE, 'USD', 'TWD')).toBe(32.275);
    expect(rateToBase(USD_TABLE, 'TWD', 'USD')).toBeCloseTo(1 / 32.275, 12);
    expect(rateToBase(USD_TABLE, 'JPY', 'TWD')).toBeCloseTo(32.275 / 158.19, 10);
    expect(rateToBase(USD_TABLE, 'EUR', 'JPY')).toBeCloseTo(158.19 / 0.89256, 6);
    expect(rateToBase(USD_TABLE, 'KRW', 'CNY')).toBeCloseTo(7.1234 / 1385.2, 12);
  });

  it('round-trips to 1 and rounds away float noise', () => {
    for (const a of Object.keys(USD_TABLE)) {
      for (const b of Object.keys(USD_TABLE)) {
        const ab = rateToBase(USD_TABLE, a, b)!;
        const ba = rateToBase(USD_TABLE, b, a)!;
        expect(ab * ba).toBeCloseTo(1, 8);
        expect(Number(ab.toPrecision(10))).toBe(ab); // already rounded to 10 significant digits
      }
    }
  });

  it('returns null when a rate is missing or unusable', () => {
    expect(rateToBase(USD_TABLE, 'XYZ', 'TWD')).toBeNull();
    expect(rateToBase(USD_TABLE, 'TWD', 'XYZ')).toBeNull();
    expect(rateToBase({ USD: 1, TWD: 0 }, 'TWD', 'USD')).toBeNull();
    expect(rateToBase({ USD: 1, TWD: -3 }, 'USD', 'TWD')).toBeNull();
    expect(rateToBase({ USD: 1, TWD: Number.NaN }, 'USD', 'TWD')).toBeNull();
  });

  it('gives a rate that converts a yen bill into Taiwan dollars as expected', () => {
    const r = rateToBase(USD_TABLE, 'JPY', 'TWD')!;
    expect(convertMinor(10000, 'JPY', r, 'TWD')).toBe(2040); // 10,000 JPY at 0.2040 TWD/JPY
  });
});

// Enough currencies for the provider answers to count as real tables (at least 20).
const CODES = ['TWD', 'JPY', 'CNY', 'KRW', 'EUR', 'GBP', 'HKD', 'SGD', 'THB', 'VND', 'AUD', 'CAD', 'CHF', 'MYR', 'IDR',
  'PHP', 'INR', 'NZD', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL', 'ZAR'];
const rateOf = (code: string): number => (code === 'TWD' ? 32.275 : code === 'JPY' ? 158.19 : 1 + CODES.indexOf(code) / 10);

function frankfurterAnswer(date: string): unknown[] {
  return [
    { date, base: 'USD', quote: 'USD', rate: 1 },
    ...CODES.map((quote, i) => ({ date: i % 3 ? date : '2026-10-14', base: 'USD', quote, rate: rateOf(quote) })),
    { date, base: 'EUR', quote: 'GBP', rate: 0.85 }, // other base: ignored
    { date, base: 'USD', quote: 'bad', rate: 2 }, // not a code: ignored
    { date, base: 'USD', quote: 'XXA', rate: 0 }, // not a rate: ignored
    null,
  ];
}

function currencyApiAnswer(date: string): unknown {
  const usd: Record<string, unknown> = { usd: 1, btc: 0.0000121, eth: 0.00031, '1inch': 3.2, usdt: 1, twd: 32.44 };
  for (const code of CODES) if (code !== 'TWD') usd[code.toLowerCase()] = rateOf(code);
  return { date, usd };
}

describe('provider parsers', () => {
  it('parses Frankfurter v2, keeping each quote with its own date', () => {
    const t = parseFrankfurter(frankfurterAnswer('2026-10-16'));
    expect(t.USD).toBe(1);
    expect(t.TWD).toBe(32.275);
    expect(t.JPY).toBe(158.19); // quoted with an older date: still used
    expect(Object.keys(t).sort()).toEqual(['USD', ...CODES].sort());
  });

  it('parses currency-api, uppercasing codes and dropping crypto tokens', () => {
    const t = parseCurrencyApi(currencyApiAnswer('2026-10-16'));
    expect(t.TWD).toBe(32.44);
    expect(t.USD).toBe(1);
    expect(t.BTC).toBeUndefined();
    expect(t.ETH).toBeUndefined();
    expect(Object.keys(t).every(k => /^[A-Z]{3}$/.test(k))).toBe(true);
  });

  it('rejects answers that are not tables', () => {
    expect(() => parseFrankfurter({ message: 'not found' })).toThrow();
    expect(() => parseFrankfurter([{ base: 'USD', quote: 'TWD', rate: 32 }])).toThrow(); // too few
    expect(() => parseCurrencyApi({ date: '2026-10-16' })).toThrow();
    expect(() => parseCurrencyApi(null)).toThrow();
  });
});

// ---------- getUsdRates with an in-memory fx_cache and a fake network ----------

interface FxRow {
  day: string;
  rates: string;
  source: string;
  fetched_at: string;
}

/** Just enough of D1 for the four fx_cache statements in services/fx.ts. */
class FakeFxDb {
  rows = new Map<string, FxRow>();
  writes = 0;
  prepare(sql: string) {
    const s = sql.replace(/\s+/g, ' ');
    const rows = this.rows;
    const self = this;
    return {
      bind(...args: unknown[]) {
        const arg = String(args[0]);
        return {
          async first(): Promise<FxRow | null> {
            const sorted = [...rows.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
            if (s.includes('WHERE day = ?')) return rows.get(arg) ?? null;
            if (s.includes('WHERE day <= ?')) return sorted.filter(r => r.day <= arg).pop() ?? null;
            if (s.includes('WHERE day > ?')) return sorted.find(r => r.day > arg) ?? null;
            throw new Error('unexpected SQL: ' + s);
          },
          async run() {
            if (!s.startsWith('INSERT INTO fx_cache')) throw new Error('unexpected SQL: ' + s);
            const [day, rates, source, fetched_at] = args as string[];
            rows.set(day, { day, rates, source, fetched_at });
            self.writes++;
            return { success: true, meta: {}, results: [] };
          },
        };
      },
    };
  }
}

type Db = Parameters<typeof getUsdRates>[0];
type Route = (url: string) => unknown; // JSON body, or a number = HTTP error status

function fakeNetwork(route: Route) {
  const calls: { url: string; userAgent: string | undefined }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, userAgent: headers.get('User-Agent') ?? undefined });
    const out = route(url);
    if (typeof out === 'number') return new Response('error', { status: out });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const dateParam = (url: string): string | null => new URL(url).searchParams.get('date');

describe('getUsdRates', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T08:00:00Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches the newest table for today, sends a User-Agent and caches it', async () => {
    const db = new FakeFxDb();
    const calls = fakeNetwork(url => (url.includes('frankfurter') ? frankfurterAnswer('2026-10-16') : 500));
    const r = await getUsdRates(db as unknown as Db, '2026-10-16');
    expect(r).toMatchObject({ date: '2026-10-16', source: SOURCE_FRANKFURTER });
    expect(r.rates.TWD).toBe(32.275);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.frankfurter.dev/v2/rates?base=USD');
    expect(calls[0].userAgent).toMatch(/Evenly/);
    expect(db.rows.get('2026-10-16')?.source).toBe(SOURCE_FRANKFURTER);

    // Within 6 hours: served from D1.
    vi.setSystemTime(new Date('2026-10-16T13:00:00Z'));
    await getUsdRates(db as unknown as Db, '2026-10-16');
    expect(calls).toHaveLength(1);

    // Older than 6 hours: fetched again.
    vi.setSystemTime(new Date('2026-10-16T15:00:00Z'));
    await getUsdRates(db as unknown as Db, '2026-10-16');
    expect(calls).toHaveLength(2);
  });

  it('treats a future date as today', async () => {
    const db = new FakeFxDb();
    const calls = fakeNetwork(() => frankfurterAnswer('2026-10-16'));
    const r = await getUsdRates(db as unknown as Db, '2027-01-01');
    expect(r.date).toBe('2026-10-16');
    expect(dateParam(calls[0].url)).toBeNull();
  });

  it('fetches a past day by date once and then serves it from the cache', async () => {
    const db = new FakeFxDb();
    const calls = fakeNetwork(url => frankfurterAnswer(dateParam(url) ?? '2026-10-16'));
    const r = await getUsdRates(db as unknown as Db, '2024-03-15');
    expect(r.date).toBe('2024-03-15');
    expect(dateParam(calls[0].url)).toBe('2024-03-15');
    await getUsdRates(db as unknown as Db, '2024-03-15');
    expect(calls).toHaveLength(1);
  });

  it('replaces a table saved while its day was still running, once', async () => {
    const db = new FakeFxDb();
    const calls = fakeNetwork(url => frankfurterAnswer(dateParam(url) ?? '2026-10-15'));
    await getUsdRates(db as unknown as Db, '2026-10-16'); // saved during 10-16
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
    await getUsdRates(db as unknown as Db, '2026-10-16'); // now a past day: final table
    expect(calls).toHaveLength(2);
    expect(dateParam(calls[1].url)).toBe('2026-10-16');
    await getUsdRates(db as unknown as Db, '2026-10-16');
    expect(calls).toHaveLength(2);
  });

  it('falls back to currency-api (jsDelivr, then the Pages mirror) without crypto', async () => {
    const db = new FakeFxDb();
    const calls = fakeNetwork(url => (url.includes('pages.dev') ? currencyApiAnswer('2024-03-15') : 503));
    const r = await getUsdRates(db as unknown as Db, '2024-03-15');
    expect(r.source).toBe(SOURCE_CURRENCY_API);
    expect(r.rates.TWD).toBe(32.44);
    expect(r.rates.BTC).toBeUndefined();
    expect(calls.map(c => new URL(c.url).hostname)).toEqual(['api.frankfurter.dev', 'cdn.jsdelivr.net', '2024-03-15.currency-api.pages.dev']);
    expect(calls[1].url).toBe('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2024-03-15/v1/currencies/usd.json');
  });

  it('uses currency-api "latest" for today', async () => {
    const db = new FakeFxDb();
    const calls = fakeNetwork(url => (url.includes('jsdelivr') ? currencyApiAnswer('2026-10-16') : 500));
    const r = await getUsdRates(db as unknown as Db, '2026-10-16');
    expect(r.source).toBe(SOURCE_CURRENCY_API);
    expect(calls[1].url).toContain('@latest/');
  });

  it('serves the nearest cached day when every provider fails', async () => {
    const db = new FakeFxDb();
    db.rows.set('2026-10-10', { day: '2026-10-10', rates: JSON.stringify(USD_TABLE), source: SOURCE_FRANKFURTER, fetched_at: '2026-10-11T00:00:00.000Z' });
    db.rows.set('2026-10-20', { day: '2026-10-20', rates: JSON.stringify({ ...USD_TABLE, TWD: 33 }), source: SOURCE_FRANKFURTER, fetched_at: '2026-10-21T00:00:00.000Z' });
    fakeNetwork(() => 500);
    const r = await getUsdRates(db as unknown as Db, '2026-10-12');
    expect(r.date).toBe('2026-10-10');
    expect(r.rates.TWD).toBe(32.275);
    const older = await getUsdRates(db as unknown as Db, '2026-01-01'); // nothing before: the oldest after
    expect(older.date).toBe('2026-10-10');
    expect(db.writes).toBe(0);
  });

  it('keeps a stale today table when the providers are down', async () => {
    const db = new FakeFxDb();
    db.rows.set('2026-10-16', { day: '2026-10-16', rates: JSON.stringify(USD_TABLE), source: SOURCE_FRANKFURTER, fetched_at: '2026-10-16T00:10:00.000Z' });
    const calls = fakeNetwork(() => 500);
    const r = await getUsdRates(db as unknown as Db, '2026-10-16');
    expect(calls.length).toBeGreaterThan(0);
    expect(r).toMatchObject({ date: '2026-10-16', source: SOURCE_FRANKFURTER });
  });

  it('throws 503 fx_unavailable when nothing is cached and every provider fails', async () => {
    const db = new FakeFxDb();
    fakeNetwork(() => 500);
    const err = await getUsdRates(db as unknown as Db, '2026-10-16').catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'fx_unavailable' });
  });

  it('rejects a malformed date', async () => {
    const db = new FakeFxDb();
    fakeNetwork(() => 500);
    await expect(getUsdRates(db as unknown as Db, '2026-02-30')).rejects.toMatchObject({ status: 400, code: 'validation' });
  });
});
