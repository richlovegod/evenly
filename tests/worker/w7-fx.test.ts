// Review-1106 unit W7, B2-09: GET /api/fx (no sign-in) on the worker.fetch harness with the real
// schema (tests/worker/d1-sqlite.ts), the real services/fx.ts and a fake network. Dates before
// 2000-01-01 are refused, a day every provider failed for is not fetched again for MISS_TTL_MS,
// and provider fetches are counted per address (FX_FETCHES_PER_15M); past that, the answer comes
// from the nearest cached day, as when the providers are down.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker/index';
import { FX_FETCHES_PER_15M } from '../../src/worker/routes/fx';
import { MISS_TTL_MS } from '../../src/worker/services/fx';
import { TestD1 } from './d1-sqlite';

const IP = '203.0.113.9';
const CODES = ['USD', 'TWD', 'JPY', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'KRW', 'SGD', 'THB', 'NZD', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL', 'INR', 'IDR', 'MYR', 'PHP', 'VND'];

let db: TestD1;
let fetches: string[];
let answer: (url: string) => number | 'ok';

function frankfurter(day: string) {
  return CODES.map((quote, i) => ({ date: day, base: 'USD', quote, rate: quote === 'USD' ? 1 : quote === 'TWD' ? 32.3 : 1 + i }));
}

async function getFx(query: string): Promise<{ status: number; data: any }> {
  const req = new Request('https://split.test/api/fx?' + query, { headers: { 'cf-connecting-ip': IP } });
  const env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'https://split.test/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

function cacheDay(day: string): void {
  const rates = Object.fromEntries(frankfurter(day).map(q => [q.quote, q.rate]));
  db.exec('INSERT INTO fx_cache (day, rates, source, fetched_at) VALUES (?, ?, ?, ?)', day, JSON.stringify(rates), 'frankfurter.dev', '2026-10-01T00:00:00.000Z');
}

const ipCount = () => db.rows<{ count: number }>('SELECT count FROM rate_limits WHERE key = ?', 'fx:ip:' + IP)[0]?.count ?? 0;

beforeEach(() => {
  db = new TestD1();
  fetches = [];
  answer = () => 'ok';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-07T08:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      fetches.push(url);
      const a = answer(url);
      if (a !== 'ok') return new Response('no', { status: a });
      const day = new URL(url).searchParams.get('date') ?? '2026-11-07';
      return new Response(JSON.stringify(frankfurter(day)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/fx (B2-09)', () => {
  it('refuses a date before 2000-01-01, as no entry can have one', async () => {
    const r = await getFx('base=TWD&date=1999-12-31');
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('validation');
    expect(fetches).toEqual([]);
    const ok = await getFx('base=TWD&date=2000-01-01');
    expect(ok.status).toBe(200);
    expect(ok.data.date).toBe('2000-01-01');
  });

  it('a day the providers fail for is not asked for again for a while; the nearest cached day answers', async () => {
    cacheDay('2024-03-10');
    answer = () => 500;
    const first = await getFx('base=TWD&date=2024-03-15');
    expect(first.status).toBe(200);
    expect(first.data.date).toBe('2024-03-10');
    const tried = fetches.length;
    expect(tried).toBe(3); // Frankfurter, then both currency-api addresses

    const again = await getFx('base=TWD&date=2024-03-15');
    expect(again.data.date).toBe('2024-03-10');
    expect(fetches).toHaveLength(tried);

    vi.setSystemTime(new Date(Date.now() + MISS_TTL_MS + 1000));
    answer = () => 'ok';
    const later = await getFx('base=TWD&date=2024-03-15');
    expect(later.data.date).toBe('2024-03-15');
    expect(fetches).toHaveLength(tried + 1);
  });

  it('counts provider fetches per address; past the limit it answers from the cache without fetching', async () => {
    cacheDay('2024-03-10');
    expect((await getFx('base=TWD&date=2024-03-11')).data.date).toBe('2024-03-11');
    expect(ipCount()).toBe(1);
    // A cached final day costs no fetch and is not counted.
    expect((await getFx('base=TWD&date=2024-03-11')).status).toBe(200);
    expect(ipCount()).toBe(1);

    db.exec('UPDATE rate_limits SET count = ? WHERE key = ?', FX_FETCHES_PER_15M, 'fx:ip:' + IP);
    const n = fetches.length;
    const r = await getFx('base=TWD&date=2024-03-20');
    expect(r.status).toBe(200);
    expect(r.data.date).toBe('2024-03-11');
    expect(fetches).toHaveLength(n);
  });

  it('with nothing cached and no fetch allowed: 503 fx_unavailable, as when the providers are down', async () => {
    db.exec('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)', 'fx:ip:' + IP, FX_FETCHES_PER_15M, Date.now() + 900_000);
    const r = await getFx('base=TWD&date=2024-03-20');
    expect(r.status).toBe(503);
    expect(r.data.error.code).toBe('fx_unavailable');
    expect(fetches).toEqual([]);
  });
});
