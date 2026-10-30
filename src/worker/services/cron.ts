// The daily job (wrangler.toml: cron "0 9 * * *", started by scheduled() in index.ts): clean up
// expired sign-in rows (the iPhone app's Google codes and pending links from 我的 among them; an
// expired Apple link's grant is kept for its Apple ID's account or revoked first) and day-old
// email codes, delete the receipt photos of expenses deleted a
// day ago and of deleted groups, create the recurring copies due in every group,
// and warm today's exchange rates. Each step runs on its own, so one failing never stops the others, and runDaily never
// throws (it runs inside ctx.waitUntil).

import { todayUTC } from '../../shared/dates';
import type { Env } from '../env';
import { getUsdRates } from './fx';
import { settleExpiredPendingLinks } from './links';
import { cleanupReceiptPhotos } from './receiptPhotos';
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
    // Kept iPhone messages a day old, as push_pending above.
    db.prepare('DELETE FROM apns_pending WHERE created_at < ?').bind(dayAgo),
    // The iPhone app's Google codes and link tickets once they expire (5 minutes), used or not.
    db.prepare('DELETE FROM google_app_codes WHERE expires_at < ?').bind(iso),
    // What started Google and Apple flows were bound to, once they expire (10 minutes).
    db.prepare('DELETE FROM sign_in_flows WHERE expires_at < ?').bind(iso),
    // The iPhone app's Google sign-in codes once they expire (5 minutes), used or not.
    db.prepare('DELETE FROM google_sign_in_codes WHERE expires_at < ?').bind(iso),
    // Pending links from 我的 once they expire (10 minutes), except Apple's with a grant, which the
    // 'pending links' step settles first (settleExpiredPendingLinks).
    db.prepare('DELETE FROM pending_links WHERE expires_at < ? AND refresh_token IS NULL').bind(iso),
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
 * Runs the daily maintenance. Order matters on the Workers free plan (50 subrequests per run, each
 * D1 call and KV delete one): cleanup is one batch, then the receipt photos (the photos of at most
 * RECEIPT_CLEANUP_EXPENSES_PER_RUN expenses, at most 75 KV deletes and two D1 calls, since the
 * privacy page promises them gone; Workers Paid allows 10,000 subrequests a run),
 * recurring copies next because people see them, rates last (they are also fetched on demand).
 */
export async function runDaily(env: Env, now: Date = new Date()): Promise<void> {
  const db = env.DB;
  const today = todayUTC(now);
  await step('cleanup', async () => {
    const res = await db.batch(cleanupStmts(db, now));
    const [sessions, codes, claims, limits, kept, emailCodes, keptApns, appCodes, flows, signInCodes, pending] = res.map(r => r.meta?.changes ?? 0);
    return `removed ${sessions} sessions, ${codes} codes, ${claims} claim links, ${limits} rate limits, ${kept + keptApns} kept pushes, ${emailCodes} email codes, ${appCodes + signInCodes} app codes, ${flows} sign-in flows, ${pending} pending links`;
  });
  await step('pending links', async () => `settled ${await settleExpiredPendingLinks(env, now)} expired Apple links`);
  await step('receipts', async () => {
    const r = await cleanupReceiptPhotos(env, now);
    return `removed ${r.deleted} receipt photos` + (r.failed ? `, ${r.failed} KV deletes failed (tried again next run)` : '');
  });
  await step('recurring', async () => `created ${await materializeDue(db, { today })} copies`);
  await step('fx', async () => {
    const r = await getUsdRates(db, today);
    return `rates for ${r.date} (${r.source})`;
  });
}
