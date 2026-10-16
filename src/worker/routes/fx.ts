// GET /api/fx?base=TWD&date=YYYY-MM-DD: exchange rates into `base` (no sign-in needed).

import { Hono } from 'hono';
import { z } from 'zod';
import { isISODate, todayUTC } from '../../shared/dates';
import type { FxRes } from '../../shared/types';
import type { AppEnv } from '../env';
import { fail } from '../http';
import { getUsdRates, rateToBase } from '../services/fx';

export const fxRoutes = new Hono<AppEnv>();

const querySchema = z.object({
  base: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter uppercase currency code'),
  date: z
    .string()
    .optional()
    .refine(d => d === undefined || d === '' || isISODate(d), 'Use a real date as YYYY-MM-DD'),
});

fxRoutes.get('/fx', async c => {
  const parsed = querySchema.safeParse({ base: c.req.query('base') ?? '', date: c.req.query('date') });
  if (!parsed.success) fail(400, 'validation', 'Some fields are not valid', parsed.error.issues);
  const { base, date } = parsed.data;

  const usd = await getUsdRates(c.env.DB, date || todayUTC());
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
