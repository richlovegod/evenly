// Reading a receipt photo (docs/PLAN-push-scan-cookies.md section 3.2): shrink it in the browser,
// then send it once to POST /api/receipts/scan. What is sent for reading is never kept: not in the
// draft, the stash, IndexedDB or a log, only in local variables until the request is over. The same
// decode also makes the smaller copy the editor attaches to the expense (lib/photo.ts
// receiptPhoto, docs/SPEC.md section 8.7), which goes to the outbox once the expense is saved. The
// re-encoding drops the photo's EXIF data (place and time) from both.

import type { Locale, ReceiptScanDTO } from '../../../shared/types';
import { api, ApiError } from '../../lib/api';
import { canvasToDataUrl, decodePhoto, drawPhoto, receiptPhotoFrom, releaseCanvas, type ReceiptPhoto } from '../../lib/photo';

/** The app waits this long for an answer (the Worker gives up on the model at 55 s). */
export const SCAN_TIMEOUT_MS = 60_000;

/** Longest side sent, in px: enough for small receipt print, about 0.3 to 1 MB as JPEG. */
const MAX_SIDE = 1600;
const QUALITY = 0.85;
/** The Worker takes at most 3 MiB (routes/receipts.ts RECEIPT_MAX_BYTES); stay under it. */
const MAX_DATA_URL = 2_800_000;

/** Why a scan stopped on this side: the photo could not be opened, or no answer in time. */
export class ScanError extends Error {
  constructor(public reason: 'image' | 'timeout') {
    super(reason === 'image' ? 'The photo cannot be opened' : 'Reading the receipt took too long');
  }
}

/**
 * The photo for reading, as a JPEG data URL with its long side at most 1600 px (drawn on white,
 * so a transparent PNG does not turn black), and the receipt photo to keep with the expense, from
 * the same drawing (null when it would not come out small enough; the scan still runs). One decode
 * of a 12 MP photo is all a phone has memory for. Throws ScanError('image') when it cannot be opened.
 */
export async function scanPhotos(file: Blob): Promise<{ scan: string; receipt: ReceiptPhoto | null }> {
  const img = await decodePhoto(file);
  if (!img) throw new ScanError('image');
  try {
    if (!img.width || !img.height) throw new ScanError('image');
    const canvas = drawPhoto(img, MAX_SIDE);
    if (!canvas) throw new ScanError('image');
    try {
      let url = await canvasToDataUrl(canvas, QUALITY);
      if (url.length > MAX_DATA_URL) url = await canvasToDataUrl(canvas, 0.7);
      const ok = url.startsWith('data:image/jpeg;base64,') || url.startsWith('data:image/png;base64,');
      if (!ok || url.length > MAX_DATA_URL) throw new ScanError('image');
      const receipt = await receiptPhotoFrom(canvas);
      return { scan: url, receipt };
    } finally {
      releaseCanvas(canvas);
    }
  } finally {
    img.close();
  }
}

/**
 * Send the shrunk photo once and get back what the receipt says. `currency` is the form's currency
 * when the scan started (the reader's guess for a receipt that shows none, or a bare $, and then
 * the unit of its amounts), `locale` the language of the warnings. Aborting `signal`
 * stops it (the caller then ignores the error); no answer within SCAN_TIMEOUT_MS throws
 * ScanError('timeout'). Never goes through the outbox: a scan needs a connection.
 */
export async function scanReceipt(image: string, o: { currency: string; locale: Locale; signal: AbortSignal }): Promise<ReceiptScanDTO> {
  const started = Date.now();
  try {
    return await api<ReceiptScanDTO>('POST', '/api/receipts/scan', { image, currency: o.currency, locale: o.locale }, { timeoutMs: SCAN_TIMEOUT_MS, signal: o.signal });
  } catch (e) {
    // apiRaw reports any abort as 'offline': the caller's own (signal) or its timer.
    if (e instanceof ApiError && e.code === 'offline' && !o.signal.aborted && Date.now() - started >= SCAN_TIMEOUT_MS - 1000) throw new ScanError('timeout');
    throw e;
  }
}
