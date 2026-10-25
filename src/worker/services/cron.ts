// The daily job (wrangler.toml: cron "0 9 * * *", started by scheduled() in index.ts): clean up
// expired sign-in rows and day-old email codes, create the recurring copies due in every group,
// and warm today's exchange rates. Each step runs on its own, so one failing never stops the others, and runDaily never
// throws (it runs inside ctx.waitUntil).

import { todayUTC } from '../../shared/dates';
import type { Env } from '../env';
import { getUsdRates } from './fx';
import { materializeDue } from './recurring';

const DAY_MS = 86_400_000;

/**
 * Deletes expired sessions, sign-in / reset codes and claim links, and rate-limit windows that
 * ended more than a day ago (ISO times compare as text; rate_limits.reset_at is epoch ms).
 */
export function cleanupStmts(db: D1Database, now: Date): D1PreparedStatement[] {
  const iso = now.toISOString();
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  return [
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(iso),
    db.prepare('DELETE FROM login_codes WHERE expires_at < ?').bind(iso),
    db.prepare('DELETE FROM claim_tokens WHERE expires_at < ?').bind(iso),
    db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(now.getTime() - DAY_MS),
    // Kept push messages a day old (services/push.ts drops them too, but not while push is off or
    // its cron is stopped); the privacy page promises at most a day.
    db.prepare('DELETE FROM push_pending WHERE created_at < ?').bind(dayAgo),
    // Email codes once they expire (10 minutes after they were made), used or not: every row a
    // day old goes, and since this runs once a day, none lasts much past a day (the privacy page
    // promises a day). Deleting only day-old rows would keep some for almost two.
    db.prepare('DELETE FROM email_codes WHERE expires_at < ?').bind(iso),
  ];
}

async function step(name: string, work: () => Promise<string>): Promise<void> {
  try {
    console.log(`cron ${name}: ${await work()}`);
  } catch (e) {
    console.error(`cron ${name} failed`, e);
  }
}

/**
 * Runs the daily maintenance. Order matters on the Workers free plan (50 D1 calls per run):
 * cleanup is one batch, recurring copies come next because people see them, rates last (they are
 * also fetched on demand).
 */
export async function runDaily(env: Env, now: Date = new Date()): Promise<void> {
  const db = env.DB;
  const today = todayUTC(now);
  await step('cleanup', async () => {
    const res = await db.batch(cleanupStmts(db, now));
    const [sessions, codes, claims, limits, kept, emailCodes] = res.map(r => r.meta?.changes ?? 0);
    return `removed ${sessions} sessions, ${codes} codes, ${claims} claim links, ${limits} rate limits, ${kept} kept pushes, ${emailCodes} email codes`;
  });
  await step('recurring', async () => `created ${await materializeDue(db, { today })} copies`);
  await step('fx', async () => {
    const r = await getUsdRates(db, today);
    return `rates for ${r.date} (${r.source})`;
  });
}
