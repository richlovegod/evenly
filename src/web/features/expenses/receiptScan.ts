// Reading a receipt photo (docs/PLAN-push-scan-cookies.md section 3.2): shrink it in the browser,
// then send it once to POST /api/receipts/scan. The photo is never kept: not in the draft, the
// stash, IndexedDB or a log. It only lives in local variables until the request is over, and the
// re-encoding below drops its EXIF data (place and time).

import type { Locale, ReceiptScanDTO } from '../../../shared/types';
import { api, ApiError } from '../../lib/api';

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

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/** Decode with the camera's orientation applied (createImageBitmap, or an <img> where that fails). */
async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* older Safari or a format it cannot decode this way: try an <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new ScanError('image');
  }
}

function canvasToDataUrl(canvas: HTMLCanvasElement, quality: number): Promise<string> {
  return new Promise(resolve => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(canvas.toDataURL('image/jpeg', quality));
      return;
    }
    canvas.toBlob(
      blob => {
        if (!blob) {
          resolve('');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
      },
      'image/jpeg',
      quality,
    );
  });
}

/**
 * The photo as a JPEG data URL with its long side at most 1600 px. Drawn on white, so a
 * transparent PNG does not turn black. Throws ScanError('image') when it cannot be opened.
 */
export async function shrinkPhoto(file: Blob): Promise<string> {
  const img = await decode(file);
  try {
    if (!img.width || !img.height) throw new ScanError('image');
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const g = canvas.getContext('2d');
    if (!g) throw new ScanError('image');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img.source, 0, 0, canvas.width, canvas.height);
    let url = await canvasToDataUrl(canvas, QUALITY);
    if (url.length > MAX_DATA_URL) url = await canvasToDataUrl(canvas, 0.7);
    // Let iOS give the bitmap memory back now rather than at the next collection.
    canvas.width = 0;
    canvas.height = 0;
    const ok = url.startsWith('data:image/jpeg;base64,') || url.startsWith('data:image/png;base64,');
    if (!ok || url.length > MAX_DATA_URL) throw new ScanError('image');
    return url;
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
