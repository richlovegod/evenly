// Photos picked on the device, decoded and re-encoded in a canvas: the receipt scan
// (features/expenses/receiptScan.ts) and the profile photo (features/account/avatarPhoto.ts).
// Re-encoding drops the photo's EXIF data (place and time).

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
