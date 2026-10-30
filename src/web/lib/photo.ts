// Photos picked on the device, decoded and re-encoded in a canvas: the receipt scan
// (features/expenses/receiptScan.ts), the receipt photo kept with an expense (receiptPhoto below)
// and the profile photo (features/account/avatarPhoto.ts). Decoding applies the camera's
// orientation, and re-encoding drops the photo's EXIF data (place and time, GPS).

export interface DecodedPhoto {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/**
 * Decode with the camera's orientation applied (createImageBitmap, or an <img> where that fails).
 * Null when the file cannot be opened.
 */
export async function decodePhoto(file: Blob): Promise<DecodedPhoto | null> {
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
    return null;
  }
}

/** The canvas as a JPEG data URL ('' when the browser gives nothing). */
export function canvasToDataUrl(canvas: HTMLCanvasElement, quality: number): Promise<string> {
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
 * The size that fits `maxSide` on the longest side, keeping the shape, never larger than the
 * photo and never under 1 px.
 */
export function fitSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The photo drawn on a canvas with its longest side at most `maxSide`, on white (so a transparent
 * PNG does not turn black). Null when the browser gives no 2D context.
 */
export function drawPhoto(img: Pick<DecodedPhoto, 'source' | 'width' | 'height'>, maxSide: number): HTMLCanvasElement | null {
  const size = fitSize(img.width, img.height, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size.width, size.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img.source, 0, 0, size.width, size.height);
  return canvas;
}

/** Let iOS give a canvas's bitmap memory back now rather than at the next collection. */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

const BASE64_MARK = ';base64,';

/** How many bytes a base64 data URL holds (0 for anything else), without decoding it. */
export function dataUrlBytes(url: string): number {
  const at = url.indexOf(BASE64_MARK);
  if (!url.startsWith('data:') || at < 0) return 0;
  const b64 = url.length - at - BASE64_MARK.length;
  const pad = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64 * 3) / 4) - pad);
}

/**
 * A kept photo's version, as the Worker names it (routes/receiptPhotos.ts): the first 16 lowercase
 * hex characters of the SHA-256 of its bytes. The add route's address carries it, and the form
 * and the outbox key photos by it, so the same picture picked twice is one photo. '' when the data
 * URL holds no bytes.
 */
export async function photoVersion(image: string): Promise<string> {
  const p = dataUrlToBytes(image);
  if (!p || !p.bytes.length) return '';
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', p.bytes));
  return [...d.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The bytes and the type of a base64 data URL (null for anything else). */
export function dataUrlToBytes(url: string): { mime: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const at = url.indexOf(BASE64_MARK);
  if (!url.startsWith('data:') || at < 0) return null;
  let bin: string;
  try {
    bin = atob(url.slice(at + BASE64_MARK.length));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: url.slice(5, at), bytes };
}

// ---------- the receipt photo kept with an expense ----------

/**
 * The receipt photo as the app keeps it (docs/SPEC.md section 8.7): longest side at most 1600 px
 * (small print stays readable), JPEG at about 0.7 (150 to 400 KB), under the Worker's 600,000
 * bytes (routes/receiptPhotos.ts RECEIPT_PHOTO_MAX_BYTES).
 */
export const RECEIPT_PHOTO = { maxSide: 1600, quality: 0.7, maxBytes: 600_000 } as const;

/** Qualities tried in turn when a photo comes out too big (a busy picture), then smaller sizes. */
const RECEIPT_QUALITIES = [RECEIPT_PHOTO.quality, 0.55, 0.4];
const RECEIPT_SCALES = [1, 0.75, 0.5];

/** A receipt photo ready to keep: a JPEG data URL, its size in px and in bytes. */
export interface ReceiptPhoto {
  image: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * The first encoding that fits `maxBytes`: quality 0.7, then 0.55 and 0.4, then the same at 3/4
 * and 1/2 of the size. `encode(width, height, quality)` gives a JPEG data URL of the photo at that
 * size ('' when the browser gives nothing). Null when none fits, or nothing is a JPEG.
 */
export async function encodeWithin(
  size: { width: number; height: number },
  encode: (width: number, height: number, quality: number) => Promise<string>,
  maxBytes: number = RECEIPT_PHOTO.maxBytes,
): Promise<ReceiptPhoto | null> {
  for (const scale of RECEIPT_SCALES) {
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    for (const quality of RECEIPT_QUALITIES) {
      const image = await encode(width, height, quality);
      if (!image.startsWith('data:image/jpeg;base64,')) return null;
      const bytes = dataUrlBytes(image);
      if (bytes > 0 && bytes <= maxBytes) return { image, width, height, bytes };
    }
  }
  return null;
}

/** The receipt photo from a canvas already drawn at the right size (drawPhoto with RECEIPT_PHOTO.maxSide). */
export function receiptPhotoFrom(canvas: HTMLCanvasElement): Promise<ReceiptPhoto | null> {
  return encodeWithin({ width: canvas.width, height: canvas.height }, async (width, height, quality) => {
    if (width === canvas.width && height === canvas.height) return canvasToDataUrl(canvas, quality);
    const small = drawPhoto({ source: canvas, width: canvas.width, height: canvas.height }, Math.max(width, height));
    if (!small) return '';
    try {
      return await canvasToDataUrl(small, quality);
    } finally {
      releaseCanvas(small);
    }
  });
}

/**
 * A picked photo as a receipt photo to keep. Null when it cannot be opened or made small enough.
 * The image lives in memory until the expense is saved, then in the outbox (IndexedDB) until it
 * is uploaded; never in a log.
 */
export async function receiptPhoto(file: Blob): Promise<ReceiptPhoto | null> {
  const img = await decodePhoto(file);
  if (!img) return null;
  try {
    if (!img.width || !img.height) return null;
    const canvas = drawPhoto(img, RECEIPT_PHOTO.maxSide);
    if (!canvas) return null;
    try {
      return await receiptPhotoFrom(canvas);
    } finally {
      releaseCanvas(canvas);
    }
  } finally {
    img.close();
  }
}
