// POST /api/receipts/scan: read one to three photos of a receipt with Workers AI (docs/SPEC.md
// section 6, Receipt scan; docs/PLAN-push-scan-cookies.md section 3.1). The photos are read once and
// dropped: nothing is stored, and neither the photos nor what they say is logged. Limits, in fixed
// UTC days, all counted per environment in its own D1: RECEIPT_PER_DAY photos read per account,
// RECEIPT_GLOBAL_PER_DAY for the whole app, and RECEIPT_NEURONS_PER_DAY Workers AI neurons. The
// account's free 10,000 neurons a day are shared by staging and production, and since the move to
// Workers Paid (2026-10-29) what goes past them is billed instead of refused (error 3036 on the Free
// plan), so each environment stops at its own share: 8,000 in production, 500 elsewhere.
//
// One photo (`image`, what every client sends for one) is one call, exactly as before several
// photos. Two or three (`images`) are one call with every photo where the release check passed in
// this environment (the RECEIPT_JOINT secret is "on" and the model is in RECEIPT_JOINT_MODELS),
// else one call per photo, whose answers mergeReadings joins. Either way it is one tap and one
// reservation of the whole worst case before any call.

import { Hono } from 'hono';
import { z } from 'zod';
import { isKnownCurrency } from '../../shared/currencies';
import { todayUTC } from '../../shared/dates';
import { RECEIPT_PHOTOS_MAX } from '../../shared/receipts';
import type { ReceiptScanDTO } from '../../shared/types';
import { addToCount, limitFrom, requireUser, takeAmount } from '../auth';
import type { AppEnv, Ctx, Env } from '../env';
import { ApiError, fail, forbidden, json } from '../http';
import {
  DEFAULT_RECEIPT_MODEL, imageSize, mergeReadings, neuronsFor, normalizeReceipt, photosReadFloor, RECEIPT_JOINT_MODELS, RECEIPT_MODELS,
  RECEIPT_SCAN_MAX_SIDE, RECEIPT_TIMEOUT_MULTI_MS, receiptNeuronsSpent, receiptWorstCase, runReceiptModel, secondsToNextUtcDay, type AiRunner,
  type ModelAnswer,
} from '../services/receipt';

/** The largest scan body taken (index.ts lets it past the 256 KB gate). The apps send 0.3 to 1 MB a photo, three under 3 MB. */
export const RECEIPT_MAX_BYTES = 3 * 1024 * 1024;

const IMAGE_PREFIXES = ['data:image/jpeg;base64,', 'data:image/png;base64,', 'data:image/webp;base64,'];
/** Far below any real photo: a shorter image is not one. */
const IMAGE_MIN_CHARS = 200;

/** Photos read per account, and by the whole app, in a UTC day (one scan of three photos is 3). */
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
  image: z.string().max(RECEIPT_MAX_BYTES).optional(),
  images: z.array(z.string().max(RECEIPT_MAX_BYTES)).optional(),
  currency: z.string().max(8).optional(),
  locale: z.enum(['zh-TW', 'en']).optional(),
});

/** One photo to read: its data URL and its size from the header. */
interface ScanPhoto {
  url: string;
  width: number;
  height: number;
}

interface ScanBody {
  photos: ScanPhoto[];
  currency?: string;
  locale?: 'zh-TW' | 'en';
}

export const receiptRoutes = new Hono<AppEnv>();

function invalid(path: (string | number)[], message: string): never {
  fail(400, 'validation', 'Some fields are not valid', [{ path, message }]);
}

/**
 * The body, read with this route's own size limit (readJson stops at 256 KB) and parsed once:
 * exactly one of `image` and `images` (1 to 3), each a JPEG, PNG or WebP data URL whose header says
 * a size of at most RECEIPT_SCAN_MAX_SIDE on the longest side (what makes every reservation a true
 * worst case).
 */
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
  const { image, images, currency, locale } = parsed.data;
  if ((image === undefined) === (images === undefined)) invalid(['image'], 'Send image or images');
  if (images && (images.length < 1 || images.length > RECEIPT_PHOTOS_MAX)) invalid(['images'], `Send 1 to ${RECEIPT_PHOTOS_MAX} photos`);
  const list = images ?? [image as string];
  const photos = list.map((url, i): ScanPhoto => {
    const path = images ? ['images', i] : ['image'];
    if (url.length < IMAGE_MIN_CHARS || !IMAGE_PREFIXES.some(p => url.startsWith(p))) invalid(path, 'Send a JPEG, PNG or WebP photo as a base64 data URL');
    const size = imageSize(url);
    if (!size || Math.max(size.width, size.height) > RECEIPT_SCAN_MAX_SIDE) {
      invalid(path, `Send each photo as a JPEG, PNG or WebP of at most ${RECEIPT_SCAN_MAX_SIDE} px on its longest side`);
    }
    return { url, width: size.width, height: size.height };
  });
  return { photos, currency, locale };
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
  if (!RECEIPT_MODELS.includes(asked)) invalid(['model'], 'Use one of ' + RECEIPT_MODELS.join(', '));
  return asked;
}

/**
 * ?joint=1 (one call with every photo) or ?joint=0 (one call per photo), whatever the settings say:
 * the owner only, in every environment, for the release check and comparisons. Null when not sent.
 * It does nothing for one photo.
 */
function pickJoint(c: Ctx): boolean | null {
  const asked = c.req.query('joint');
  if (asked === undefined) return null;
  if (!c.get('user').isOwner) forbidden('Only the owner can pick how the photos are read');
  if (asked !== '0' && asked !== '1') invalid(['joint'], 'Use 0 or 1');
  return asked === '1';
}

/** Whether two or three photos go in one call: ?joint=, else RECEIPT_JOINT "on" for a model in RECEIPT_JOINT_MODELS. */
export function readsJointly(env: Pick<Env, 'RECEIPT_JOINT'>, model: string, photos: number, forced: boolean | null): boolean {
  if (photos < 2) return false;
  if (forced !== null) return forced;
  return env.RECEIPT_JOINT?.trim().toLowerCase() === 'on' && RECEIPT_JOINT_MODELS.includes(model);
}

/** `n` photos taken from today's count for `key`, only when they fit under `limit` (nothing written
 *  otherwise); 429 with the scope and the seconds until the next UTC day. */
async function takePhotos(c: Ctx, key: string, n: number, limit: number, scope: 'user' | 'app', now: number): Promise<void> {
  if (await takeAmount(c.env.DB, key, n, limit, 86_400)) return;
  fail(429, 'rate_limited', scope === 'user' ? 'No receipt scans left today' : 'Receipt scans are used up for today', {
    scope,
    retryAfter: secondsToNextUtcDay(now),
  });
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

/** What one call of a scan of one call per photo came to: its answer, or why it failed. */
type CallResult = { ok: true; answer: ModelAnswer & { data: Record<string, unknown> } } | { ok: false; reason: 'timeout' | 'quota' | 'model' };

function failureOf(err: unknown): 'timeout' | 'quota' | 'model' {
  if (!(err instanceof ApiError)) return 'model';
  if (err.status === 429) return 'quota';
  return (err.details as { reason?: unknown } | undefined)?.reason === 'timeout' ? 'timeout' : 'model';
}

receiptRoutes.post('/receipts/scan', requireUser, async c => {
  const body = await readScanBody(c);
  const model = pickModel(c);
  const forced = pickJoint(c);
  const ai = c.env.AI;
  if (!ai) fail(502, 'scan_failed', 'Receipt reading is not set up here', { reason: 'model' });
  const runner = ai as unknown as AiRunner;
  const photos = body.photos;
  const n = photos.length;

  const now = Date.now();
  const day = todayUTC(new Date(now));
  // Both counts count photos read: ten scans of three use what thirty of one do.
  await takePhotos(c, `receipt:user:${c.get('user').id}:${day}`, n, limitFrom(c.env.RECEIPT_PER_DAY, PER_DAY), 'user', now);
  await takePhotos(c, `receipt:app:${day}`, n, limitFrom(c.env.RECEIPT_GLOBAL_PER_DAY, GLOBAL_PER_DAY), 'app', now);
  // The day's neurons: the scan's whole worst case is set aside before any call, only when it fits
  // in the budget, so scans at the same time, or one whose client went away mid-call, cannot take
  // the day past it. What the calls really took replaces it once they are back; a call that fails
  // counts its own worst case, since it may have run all the same, and a scan that throws keeps all.
  const joint = readsJointly(c.env, model, n, forced);
  const neuronKey = `receipt:neurons:${day}`;
  const reserved = n === 1 || joint ? receiptWorstCase(model, n) : n * receiptWorstCase(model, 1);
  if (!(await takeAmount(c.env.DB, neuronKey, reserved, neuronBudget(c.env), 86_400))) {
    fail(429, 'rate_limited', 'The day\'s Workers AI budget for receipt scans is used up', { scope: 'ai', retryAfter: secondsToNextUtcDay(now) });
  }

  const hint = body.currency && /^[A-Z]{3}$/.test(body.currency) && isKnownCurrency(body.currency) ? body.currency : null;
  const prompt = { today: day, hint };
  const norm = { hint, locale: body.locale ?? ('zh-TW' as const), today: day, photos: n };
  let scan: Omit<ReceiptScanDTO, 'usage'>;
  let usage: NonNullable<ReceiptScanDTO['usage']>;
  if (n === 1 || joint) {
    // One call: the one-photo request as it always was, or every photo in one.
    const answer = n === 1
      ? await runReceiptModel(runner, model, photos[0].url, prompt)
      : await runReceiptModel(runner, model, photos.map(p => p.url), prompt, RECEIPT_TIMEOUT_MULTI_MS);
    await settleNeurons(c, neuronKey, reserved, receiptNeuronsSpent(model, answer.promptTokens, answer.completionTokens, n));
    // Qwen counts each photo's pixels: far fewer prompt tokens than that means it saw only some.
    const floor = n > 1 ? photosReadFloor(model, photos) : null;
    const notAllRead = floor !== null && answer.promptTokens > 0 && answer.promptTokens < floor;
    if (notAllRead) console.warn(`receipt scan: ${model} read ${n} photos in one call with ${answer.promptTokens} prompt tokens, under the floor of ${floor}`);
    scan = normalizeReceipt(answer.data, { ...norm, notAllRead });
    usage = {
      model,
      promptTokens: answer.promptTokens,
      completionTokens: answer.completionTokens,
      neurons: neuronsFor(model, answer.promptTokens, answer.completionTokens),
      photos: n,
      calls: 1,
    };
  } else {
    // One call per photo, all at once: each is the one-photo request with a sentence saying which part it is.
    const calls: CallResult[] = await Promise.all(
      photos.map((p, i) =>
        runReceiptModel(runner, model, p.url, { ...prompt, part: { i: i + 1, n } }).then(
          (answer): CallResult => ({ ok: true, answer }),
          (err: unknown): CallResult => ({ ok: false, reason: failureOf(err) }),
        ),
      ),
    );
    const one = receiptWorstCase(model, 1);
    const spent = calls.reduce((s, r) => s + (r.ok ? receiptNeuronsSpent(model, r.answer.promptTokens, r.answer.completionTokens) : one), 0);
    await settleNeurons(c, neuronKey, reserved, spent);
    const answered = calls.flatMap(r => (r.ok ? [r.answer] : []));
    if (!answered.length) {
      const reasons = calls.map(r => (r.ok ? 'model' : r.reason));
      if (reasons.includes('timeout')) fail(502, 'scan_failed', 'Reading the receipt took too long', { reason: 'timeout' });
      if (reasons.includes('quota')) fail(429, 'rate_limited', 'The daily Workers AI allowance is used up', { scope: 'ai', retryAfter: secondsToNextUtcDay() });
      fail(502, 'scan_failed', 'The receipt could not be read', { reason: 'model' });
    }
    const merged = mergeReadings(calls.map(r => (r.ok ? r.answer.data : null)), prompt);
    scan = normalizeReceipt(merged.raw, { ...norm, merged: merged.notes });
    const promptTokens = answered.reduce((s, a) => s + a.promptTokens, 0);
    const completionTokens = answered.reduce((s, a) => s + a.completionTokens, 0);
    const neurons = answered.reduce((s, a) => s + neuronsFor(model, a.promptTokens, a.completionTokens), 0);
    usage = { model, promptTokens, completionTokens, neurons: Math.round(neurons * 1e3) / 1e3, photos: n, calls: n };
  }
  if (scan.total === null && scan.items.length === 0 && scan.merchant === null) {
    fail(502, 'scan_failed', n === 1 ? 'Nothing could be read on this photo' : 'Nothing could be read on these photos', { reason: 'unreadable' });
  }
  const res: ReceiptScanDTO = { ...scan, usage };
  return json(c, res);
});
