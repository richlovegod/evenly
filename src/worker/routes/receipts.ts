// POST /api/receipts/scan: read a receipt photo with Workers AI (docs/PLAN-push-scan-cookies.md
// section 3.1). The photo is read once and dropped: nothing is stored, and neither the photo nor
// what it says is logged. Limits, in fixed UTC days: RECEIPT_PER_DAY scans per account,
// RECEIPT_GLOBAL_PER_DAY for the whole app, and RECEIPT_NEURONS_PER_DAY Workers AI neurons. The
// account's free 10,000 neurons a day are shared by staging and production, and since the move to
// Workers Paid (2026-10-29) what goes past them is billed instead of refused (error 3036 on the Free
// plan), so each environment stops at its own share: 8,000 in production, 500 elsewhere. All three
// are counted per environment, in its own D1.

import { Hono } from 'hono';
import { z } from 'zod';
import { isKnownCurrency } from '../../shared/currencies';
import { todayUTC } from '../../shared/dates';
import type { ReceiptScanDTO } from '../../shared/types';
import { addToCount, limitFrom, rateLimit, requireUser, takeAmount } from '../auth';
import type { AppEnv, Ctx, Env } from '../env';
import { ApiError, fail, forbidden, json } from '../http';
import {
  DEFAULT_RECEIPT_MODEL, neuronsFor, normalizeReceipt, RECEIPT_MODELS, receiptNeuronsSpent, receiptWorstCase, runReceiptModel,
  secondsToNextUtcDay, type AiRunner,
} from '../services/receipt';

/** The largest scan body taken (index.ts lets it past the 256 KB gate). The app sends 0.3 to 1 MB. */
export const RECEIPT_MAX_BYTES = 3 * 1024 * 1024;

const IMAGE_PREFIXES = ['data:image/jpeg;base64,', 'data:image/png;base64,', 'data:image/webp;base64,'];
/** Far below any real photo: a shorter `image` is not one. */
const IMAGE_MIN_CHARS = 200;

const PER_DAY = 30;
const GLOBAL_PER_DAY = 300;

/**
 * Workers AI neurons the scans may use in a UTC day (key receipt:neurons:<day>; RECEIPT_NEURONS_PER_DAY
 * overrides it): production's share and that of every other environment (staging, wrangler dev),
 * of the account's free 10,000 a day. The 1,500 left over are for model comparisons run straight
 * against the REST API, which no Worker counts.
 */
export const RECEIPT_NEURONS_PER_DAY = { production: 8_000, other: 500 } as const;

/** This environment's neuron budget for a day. */
export function neuronBudget(env: Pick<Env, 'ENVIRONMENT' | 'RECEIPT_NEURONS_PER_DAY'>): number {
  const fallback = env.ENVIRONMENT === 'production' ? RECEIPT_NEURONS_PER_DAY.production : RECEIPT_NEURONS_PER_DAY.other;
  return limitFrom(env.RECEIPT_NEURONS_PER_DAY, fallback);
}

const ScanSchema = z.object({
  // Only type and length checks: a regex over a megabyte of base64 would cost CPU.
  image: z.string().max(RECEIPT_MAX_BYTES),
  currency: z.string().max(8).optional(),
  locale: z.enum(['zh-TW', 'en']).optional(),
});

type ScanBody = z.infer<typeof ScanSchema>;

export const receiptRoutes = new Hono<AppEnv>();

/** The body, read with this route's own size limit (readJson stops at 256 KB) and parsed once. */
async function readScanBody(c: Ctx): Promise<ScanBody> {
  const len = Number(c.req.header('content-length') || '0');
  if (len > RECEIPT_MAX_BYTES) fail(413, 'payload_too_large', 'The photo is too large');
  const text = await c.req.text();
  if (text.length > RECEIPT_MAX_BYTES) fail(413, 'payload_too_large', 'The photo is too large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail(400, 'bad_request', 'Body is not valid JSON');
  }
  const parsed = ScanSchema.safeParse(raw);
  if (!parsed.success) fail(400, 'validation', 'Some fields are not valid', parsed.error.issues);
  const { image } = parsed.data;
  if (image.length < IMAGE_MIN_CHARS || !IMAGE_PREFIXES.some(p => image.startsWith(p))) {
    fail(400, 'validation', 'Some fields are not valid', [{ path: ['image'], message: 'Send a JPEG, PNG or WebP photo as a base64 data URL' }]);
  }
  return parsed.data;
}

/**
 * The configured model, or the one ?model= names: only the owner may pick one, in every
 * environment. Workers AI's free daily allowance belongs to the Cloudflare account, so scans on
 * staging spend what production scans need, and the dearer models cost 5 to 10 times as much.
 * Anyone else gets 403 rather than the default model, so a comparison run cannot quietly compare
 * one model with itself.
 */
function pickModel(c: Ctx): string {
  const fallback = c.env.RECEIPT_MODEL?.trim() || DEFAULT_RECEIPT_MODEL;
  const asked = c.req.query('model');
  if (!asked) return fallback;
  if (!c.get('user').isOwner) forbidden('Only the owner can pick the model');
  if (!RECEIPT_MODELS.includes(asked)) {
    fail(400, 'validation', 'Some fields are not valid', [{ path: ['model'], message: 'Use one of ' + RECEIPT_MODELS.join(', ') }]);
  }
  return asked;
}

/** One scan counted in today's window for `key`; over the limit is 429 with the scope and the
 *  seconds until the next UTC day (the key names the day, so the count starts over then). */
async function countScan(c: Ctx, key: string, limit: number, scope: 'user' | 'app', now: number): Promise<void> {
  try {
    await rateLimit(c.env.DB, key, limit, 86_400);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 429) throw err;
    fail(429, 'rate_limited', scope === 'user' ? 'No receipt scans left today' : 'Receipt scans are used up for today', {
      scope,
      retryAfter: secondsToNextUtcDay(now),
    });
  }
}

/** The scan's real neurons in place of the worst case set aside for it. A write that fails is
 *  logged, and the worst case stays counted. */
async function settleNeurons(c: Ctx, key: string, reserved: number, spent: number): Promise<void> {
  if (spent === reserved) return;
  try {
    await addToCount(c.env.DB, key, spent - reserved);
  } catch (err) {
    console.error(`receipt scan: the neuron count was not corrected (${err instanceof Error ? err.name : 'error'})`);
  }
}

receiptRoutes.post('/receipts/scan', requireUser, async c => {
  const body = await readScanBody(c);
  const model = pickModel(c);
  const ai = c.env.AI;
  if (!ai) fail(502, 'scan_failed', 'Receipt reading is not set up here', { reason: 'model' });

  const now = Date.now();
  const day = todayUTC(new Date(now));
  await countScan(c, `receipt:user:${c.get('user').id}:${day}`, limitFrom(c.env.RECEIPT_PER_DAY, PER_DAY), 'user', now);
  await countScan(c, `receipt:app:${day}`, limitFrom(c.env.RECEIPT_GLOBAL_PER_DAY, GLOBAL_PER_DAY), 'app', now);
  // The day's neurons: the scan's worst case is set aside before the call, only when it fits in the
  // budget, so scans at the same time, or one whose client went away mid-call, cannot take the day
  // past it. What the call really took replaces it once it is back; a call that fails keeps its
  // worst case, since it may have run all the same.
  const neuronKey = `receipt:neurons:${day}`;
  const reserved = receiptWorstCase(model);
  if (!(await takeAmount(c.env.DB, neuronKey, reserved, neuronBudget(c.env), 86_400))) {
    fail(429, 'rate_limited', 'The day\'s Workers AI budget for receipt scans is used up', { scope: 'ai', retryAfter: secondsToNextUtcDay(now) });
  }

  const hint = body.currency && /^[A-Z]{3}$/.test(body.currency) && isKnownCurrency(body.currency) ? body.currency : null;
  const answer = await runReceiptModel(ai as unknown as AiRunner, model, body.image, { today: day, hint });
  await settleNeurons(c, neuronKey, reserved, receiptNeuronsSpent(model, answer.promptTokens, answer.completionTokens));
  const scan = normalizeReceipt(answer.data, { hint, locale: body.locale ?? 'zh-TW', today: day });
  if (scan.total === null && scan.items.length === 0 && scan.merchant === null) {
    fail(502, 'scan_failed', 'Nothing could be read on this photo', { reason: 'unreadable' });
  }
  const res: ReceiptScanDTO = {
    ...scan,
    usage: {
      model,
      promptTokens: answer.promptTokens,
      completionTokens: answer.completionTokens,
      neurons: neuronsFor(model, answer.promptTokens, answer.completionTokens),
    },
  };
  return json(c, res);
});
