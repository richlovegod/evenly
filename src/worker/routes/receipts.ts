// POST /api/receipts/scan: read a receipt photo with Workers AI (docs/PLAN-push-scan-cookies.md
// section 3.1). The photo is read once and dropped: nothing is stored, and neither the photo nor
// what it says is logged. Limits: RECEIPT_PER_DAY scans per account and RECEIPT_GLOBAL_PER_DAY for
// the whole app, in fixed UTC days, on top of Workers AI's own daily allowance (error 3036). That
// allowance is the Cloudflare account's, shared by staging and production, while our two limits are
// counted per environment: staging keeps a small RECEIPT_GLOBAL_PER_DAY (wrangler.toml).

import { Hono } from 'hono';
import { z } from 'zod';
import { isKnownCurrency } from '../../shared/currencies';
import { todayUTC } from '../../shared/dates';
import type { ReceiptScanDTO } from '../../shared/types';
import { limitFrom, rateLimit, requireUser } from '../auth';
import type { AppEnv, Ctx } from '../env';
import { ApiError, fail, forbidden, json } from '../http';
import {
  DEFAULT_RECEIPT_MODEL, neuronsFor, normalizeReceipt, RECEIPT_MODELS, runReceiptModel, secondsToNextUtcDay, type AiRunner,
} from '../services/receipt';

/** The largest scan body taken (index.ts lets it past the 256 KB gate). The app sends 0.3 to 1 MB. */
export const RECEIPT_MAX_BYTES = 3 * 1024 * 1024;

const IMAGE_PREFIXES = ['data:image/jpeg;base64,', 'data:image/png;base64,', 'data:image/webp;base64,'];
/** Far below any real photo: a shorter `image` is not one. */
const IMAGE_MIN_CHARS = 200;

const PER_DAY = 30;
const GLOBAL_PER_DAY = 300;

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

receiptRoutes.post('/receipts/scan', requireUser, async c => {
  const body = await readScanBody(c);
  const model = pickModel(c);
  const ai = c.env.AI;
  if (!ai) fail(502, 'scan_failed', 'Receipt reading is not set up here', { reason: 'model' });

  const now = Date.now();
  const day = todayUTC(new Date(now));
  await countScan(c, `receipt:user:${c.get('user').id}:${day}`, limitFrom(c.env.RECEIPT_PER_DAY, PER_DAY), 'user', now);
  await countScan(c, `receipt:app:${day}`, limitFrom(c.env.RECEIPT_GLOBAL_PER_DAY, GLOBAL_PER_DAY), 'app', now);

  const hint = body.currency && /^[A-Z]{3}$/.test(body.currency) && isKnownCurrency(body.currency) ? body.currency : null;
  const answer = await runReceiptModel(ai as unknown as AiRunner, model, body.image, { today: day, hint });
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
