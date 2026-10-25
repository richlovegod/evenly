// Receipt photos kept with an expense, on this device (docs/SPEC.md section 8.7). A photo is at
// <API base>/api/groups/<gid>/expenses/<eid>/receipt?v=<version>, the version coming with the
// entry (ExpenseDTO.receipt). It loads like a profile photo (lib/avatars.ts usePrivateImage): an
// <img> with the session cookie in cookie mode (the browser keeps it a year: a new photo is a new
// address), fetched with the token and shown from an object URL in bearer mode. A photo still in
// the outbox shows from its own data URL until it is uploaded.

import type { ReceiptDTO } from '../../shared/types';
import { API_BASE } from '../config';
import { usePrivateImage, type AvatarPhoto } from './avatars';

/** The address of an entry's receipt photo at this version. */
export function receiptUrl(gid: string, eid: string, version: string): string {
  return `${API_BASE}/api/groups/${encodeURIComponent(gid)}/expenses/${encodeURIComponent(eid)}/receipt?v=${encodeURIComponent(version)}`;
}

/** The stored photo of an entry, while it can be shown here (src null: none, on its way, or it did not load). */
export function useReceiptImage(gid: string, eid: string, receipt: ReceiptDTO | null | undefined): AvatarPhoto {
  return usePrivateImage(receipt?.version ? receiptUrl(gid, eid, receipt.version) : null);
}

/** The photo's shape for CSS aspect-ratio, so its box keeps its place before the bytes arrive (portrait receipts by default). */
export function receiptAspect(p: { width?: number | null; height?: number | null } | null | undefined): string {
  const w = p?.width ?? 0;
  const h = p?.height ?? 0;
  return w > 0 && h > 0 ? `${w} / ${h}` : '3 / 4';
}
