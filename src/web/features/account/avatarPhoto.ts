// The profile photo the app uploads (docs/SPEC.md section 8.3, 我的): the picked photo
// center-cropped to a square and drawn at 256 x 256 as a JPEG (quality 0.85, about 15 to 40 KB),
// then PUT /api/me/avatar (store.ts setAvatar). Re-encoding drops its EXIF data (place and time).
// The Worker takes at most 150,000 bytes (routes/avatars.ts AVATAR_MAX_BYTES).

import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { t } from '../../lib/i18n';
import { canvasToDataUrl, decodePhoto } from '../../lib/photo';

/** Width and height of the uploaded photo, in px. */
export const AVATAR_SIDE = 256;
export const AVATAR_QUALITY = 0.85;

/** The picked file cannot be opened as a picture here. */
export class AvatarPhotoError extends Error {
  constructor() {
    super('The photo cannot be opened');
  }
}

/** The largest centered square of a width x height picture: its top left corner and its side, in px. */
export function centerSquare(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/**
 * The photo center-cropped to a square and drawn at AVATAR_SIDE x AVATAR_SIDE as a JPEG data URL.
 * Drawn on white, so a transparent PNG does not turn black. Throws AvatarPhotoError when it cannot
 * be opened.
 */
export async function avatarImage(file: Blob): Promise<string> {
  const img = await decodePhoto(file);
  if (!img) throw new AvatarPhotoError();
  try {
    if (!img.width || !img.height) throw new AvatarPhotoError();
    const { x, y, side } = centerSquare(img.width, img.height);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIDE;
    canvas.height = AVATAR_SIDE;
    const g = canvas.getContext('2d');
    if (!g) throw new AvatarPhotoError();
    g.fillStyle = '#fff';
    g.fillRect(0, 0, AVATAR_SIDE, AVATAR_SIDE);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img.source, x, y, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    const url = await canvasToDataUrl(canvas, AVATAR_QUALITY);
    // Let iOS give the bitmap memory back now rather than at the next collection.
    canvas.width = 0;
    canvas.height = 0;
    if (!url.startsWith('data:image/jpeg;base64,')) throw new AvatarPhotoError();
    return url;
  } finally {
    img.close();
  }
}

/** What went wrong with a photo, for the line under its buttons. */
export function avatarErrorText(e: unknown): string {
  if (e instanceof AvatarPhotoError) return t('打不開這張照片，請換一張試試。', 'This photo cannot be opened. Try another one.');
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'bad_request':
      case 'payload_too_large':
        return t('這張照片不能用，請換一張試試。', 'This photo cannot be used. Try another one.');
      case 'rate_limited':
        return t('今天換照片的次數用完了，明天再試。', 'You have changed your photo too many times today. Try again tomorrow.');
      default:
        break;
    }
  }
  return errorMessage(e);
}
