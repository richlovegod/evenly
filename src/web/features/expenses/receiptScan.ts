// Reading receipt photos (docs/PLAN-push-scan-cookies.md section 3.2, docs/SPEC.md section 8.7):
// shrink each in the browser, then send the expense's photos (up to three) together, once, to
// POST /api/receipts/scan, which answers one receipt for the whole purchase. What is sent for
// reading is never kept: not in the draft, the stash, IndexedDB or a log, only in the editor's
// state and local variables until the form is left. The same decode also makes the smaller copy
// the editor attaches to the expense (lib/photo.ts receiptPhoto), which goes to the outbox once the
// expense is saved. The re-encoding drops the photo's EXIF data (place and time) from both.

import type { Locale, ReceiptScanDTO, ReceiptScanReq } from '../../../shared/types';
import { api, ApiError } from '../../lib/api';
import { canvasToDataUrl, decodePhoto, drawPhoto, receiptPhotoFrom, releaseCanvas, type ReceiptPhoto } from '../../lib/photo';

/** The app waits this long for one photo's answer (the Worker gives up on the model at 55 s). */
export const SCAN_TIMEOUT_MS = 60_000;
/** And for two or three photos (the Worker waits up to 85 s for one call with all of them). */
export const SCAN_TIMEOUT_MULTI_MS = 90_000;
/**
 * Two or three photos each go as their scan copy (JPEG 0.85) when it is at most this long, else as
 * the kept copy (JPEG 0.7, at most about 800,000 characters), so three always fit the Worker's
 * 3 MiB body (routes/receipts.ts RECEIPT_MAX_BYTES).
 */
export const SCAN_COPY_MAX_CHARS = 1_000_000;

/** One photo of the expense as the scan sends it: the kept copy, and the 0.85 scan copy when the editor made one. */
export interface ScanPhoto {
  image: string;
  scanCopy?: string;
}

/** How long the app waits for a scan of `photos` photos. */
export function scanTimeoutMs(photos: number): number {
  return photos > 1 ? SCAN_TIMEOUT_MULTI_MS : SCAN_TIMEOUT_MS;
}

/**
 * The request body: one photo as `image`, its scan copy, exactly as before several photos (so it
 * works on any server); two or three as `images`, in the form's order.
 */
export function scanRequest(photos: readonly ScanPhoto[], o: { currency: string; locale: Locale }): ReceiptScanReq {
  if (photos.length === 1) return { image: photos[0].scanCopy || photos[0].image, currency: o.currency, locale: o.locale };
  const images = photos.map(p => (p.scanCopy && p.scanCopy.length <= SCAN_COPY_MAX_CHARS ? p.scanCopy : p.image));
  return { images, currency: o.currency, locale: o.locale };
}

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
 * Send the expense's shrunk photos (1 to 3, in the form's order) once and get back what the
 * receipt says, one answer for the whole purchase. `currency` is the form's currency when the scan
 * started (the reader's guess for a receipt that shows none, or a bare $, and then the unit of its
 * amounts), `locale` the language of the warnings. Aborting `signal` stops it (the caller then
 * ignores the error); no answer within scanTimeoutMs throws ScanError('timeout'). Never goes
 * through the outbox: a scan needs a connection.
 */
export async function scanReceipt(photos: readonly ScanPhoto[], o: { currency: string; locale: Locale; signal: AbortSignal }): Promise<ReceiptScanDTO> {
  const started = Date.now();
  const timeoutMs = scanTimeoutMs(photos.length);
  try {
    return await api<ReceiptScanDTO>('POST', '/api/receipts/scan', scanRequest(photos, o), { timeoutMs, signal: o.signal });
  } catch (e) {
    // apiRaw reports any abort as 'offline': the caller's own (signal) or its timer.
    if (e instanceof ApiError && e.code === 'offline' && !o.signal.aborted && Date.now() - started >= timeoutMs - 1000) throw new ScanError('timeout');
    throw e;
  }
}
