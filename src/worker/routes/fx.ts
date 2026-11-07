// GET /api/fx?base=TWD&date=YYYY-MM-DD: exchange rates into `base` (no sign-in needed).

import { Hono } from 'hono';
import { z } from 'zod';
import { isISODate, todayUTC } from '../../shared/dates';
import type { FxRes } from '../../shared/types';
import { ipKey, rateLimit } from '../auth';
import type { AppEnv } from '../env';
import { ApiError, clientIp, fail } from '../http';
import { getUsdRates, rateToBase } from '../services/fx';
import { MIN_DATE } from './expenses';

export const fxRoutes = new Hono<AppEnv>();

/**
 * Provider fetches one address may start in 15 minutes (only days not cached yet, or due for a
 * refresh, cost one). Past it the answer comes from the nearest cached day, as when the providers
 * are down, so anyone without a sign-in cannot keep the Worker calling them (review B2-09).
 */
export const FX_FETCHES_PER_15M = 120;

const querySchema = z.object({
  base: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter uppercase currency code'),
  // No entry can be dated before MIN_DATE (routes/expenses.ts), so no rate before it is asked for.
  date: z
    .string()
    .optional()
    .refine(d => d === undefined || d === '' || (isISODate(d) && d >= MIN_DATE), `Use a real date from ${MIN_DATE} on, as YYYY-MM-DD`),
});

fxRoutes.get('/fx', async c => {
  const parsed = querySchema.safeParse({ base: c.req.query('base') ?? '', date: c.req.query('date') });
  if (!parsed.success) fail(400, 'validation', 'Some fields are not valid', parsed.error.issues);
  const { base, date } = parsed.data;

  const db = c.env.DB;
  const usd = await getUsdRates(db, date || todayUTC(), {
    mayFetch: async () => {
      try {
        await rateLimit(db, 'fx:ip:' + ipKey(clientIp(c)), FX_FETCHES_PER_15M, 900);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) return false;
        throw err;
      }
    },
  });
  // Every currency the table has, as the value of 1 unit in `base`. A base the provider does not
  // list gets only itself, so the app falls back to a rate typed by hand.
  const rates: Record<string, number> = {};
  for (const code of Object.keys(usd.rates).sort()) {
    const r = rateToBase(usd.rates, code, base);
    if (r !== null) rates[code] = r;
  }
  rates[base] = 1;

  const res: FxRes = { base, date: usd.date, rates, source: usd.source };
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(res);
});
