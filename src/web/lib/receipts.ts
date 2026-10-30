// Receipt photos kept with an expense, up to three, on this device (docs/SPEC.md section 8.7).
// Every photo is at <API base>/api/groups/<gid>/expenses/<eid>/receipt?v=<version>, the versions
// coming with the entry (ExpenseDTO.receipts, read through shared/receipts.ts photosOf; the list as
// the outbox will leave it is lib/outbox.ts visiblePhotos). A photo loads like a profile photo
// (lib/avatars.ts usePrivateImage): an <img> with the session cookie in cookie mode (the browser
// keeps it a year: a new photo is a new address), fetched with the token and shown from an object
// URL in bearer mode. A photo still in the outbox shows from its own data URL until it is uploaded.

import { API_BASE } from '../config';
import { usePrivateImage, type AvatarPhoto } from './avatars';

/** The address of one of an entry's receipt photos, at its version. */
export function receiptUrl(gid: string, eid: string, version: string): string {
  return `${API_BASE}/api/groups/${encodeURIComponent(gid)}/expenses/${encodeURIComponent(eid)}/receipt?v=${encodeURIComponent(version)}`;
}

/**
 * A stored photo of an entry (a ReceiptDTO, or anything with its version), while it can be shown
 * here: src null for none, while it is on its way, and after it did not load (then `failed`).
 */
export function useReceiptImage(gid: string, eid: string, photo: { version: string } | null | undefined): AvatarPhoto {
  return usePrivateImage(photo?.version && !photo.version.startsWith('legacy:') ? receiptUrl(gid, eid, photo.version) : null);
}

/** The photo's shape for CSS aspect-ratio, so its box keeps its place before the bytes arrive (portrait receipts by default). */
export function receiptAspect(p: { width?: number | null; height?: number | null } | null | undefined): string {
  const w = p?.width ?? 0;
  const h = p?.height ?? 0;
  return w > 0 && h > 0 ? `${w} / ${h}` : '3 / 4';
}
