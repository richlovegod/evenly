// The receipt photos in the expense editor (docs/SPEC.md section 8.7), without React: the list the
// form holds (up to three, in order), where it starts from, what picking more does, what 儲存
// queues, and what the scan button offers. ExpenseEditorPage.tsx keeps the list in its state; the
// photos are never in the draft or the stash (hundreds of KB each), so leaving the editor drops them.

import { RECEIPT_PHOTOS_MAX } from '../../../shared/receipts';
import type { VisiblePhoto } from '../../lib/outbox';

/**
 * One photo of the form. `stored`: on the server (it loads from its versioned address). `queued`:
 * an add still in the outbox from an earlier save (shown from its data URL). `new`: picked in this
 * form; while adding an expense it also has the 0.85 copy a scan sends (component state only).
 */
export interface FormPhoto {
  version: string;
  kind: 'stored' | 'queued' | 'new';
  /** The JPEG kept with the entry, as a data URL (queued and new photos). */
  image?: string;
  width: number;
  height: number;
  scanCopy?: string;
}

/** The form's photos as an entry has them now (its visiblePhotos): empty for a new expense, a copy or a refund. */
export function startingPhotos(visible: readonly VisiblePhoto[]): FormPhoto[] {
  return visible.slice(0, RECEIPT_PHOTOS_MAX).map(p =>
    p.queued
      ? { version: p.version, kind: 'queued', image: p.queued.image, width: p.width, height: p.height }
      : { version: p.version, kind: 'stored', width: p.width, height: p.height },
  );
}

/** The versions in order: two lists are the same photos when their keys are equal. */
export function photosKey(photos: readonly Pick<FormPhoto, 'version'>[]): string {
  return photos.map(p => p.version).join(',');
}

/**
 * Picking `files` files with `held` photos in the form: they are taken in the browser's order, up
 * to the free places, and the rest are trimmed.
 */
export function pickPlan(held: number, files: number): { take: number; trimmed: number } {
  const take = Math.max(0, Math.min(files, RECEIPT_PHOTOS_MAX - held));
  return { take, trimmed: files - take };
}

/** The form with `photo` added last, or 'duplicate' when its version is already there (or 'full'). */
export function withPhoto(photos: readonly FormPhoto[], photo: FormPhoto): FormPhoto[] | 'duplicate' | 'full' {
  if (photos.some(p => p.version === photo.version)) return 'duplicate';
  if (photos.length >= RECEIPT_PHOTOS_MAX) return 'full';
  return [...photos, photo];
}

/**
 * What 儲存 queues after the save: the starting photos the form no longer has (taken off first, so
 * there is room under three), then the new ones, in the form's order.
 */
export function photoSavePlan(start: readonly FormPhoto[], form: readonly FormPhoto[]): { drops: string[]; adds: FormPhoto[] } {
  const kept = new Set(form.map(p => p.version));
  return {
    drops: start.filter(p => !kept.has(p.version)).map(p => p.version),
    adds: form.filter(p => p.kind === 'new'),
  };
}

/**
 * What the scan button offers for the form's photos: 'pick' (no photo: the header's 掃描 opens the
 * picker, then scans what was picked), 'scan' (this list has not been scanned: one tap reads them
 * all), 'scanned' (this exact list was the last one scanned: nothing to send), 'reading'.
 */
export function scanOffer(photos: readonly FormPhoto[], scannedKey: string | null, reading: boolean): 'pick' | 'scan' | 'scanned' | 'reading' {
  if (reading) return 'reading';
  if (!photos.length) return 'pick';
  return scannedKey !== null && photosKey(photos) === scannedKey ? 'scanned' : 'scan';
}
