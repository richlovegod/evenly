// Receipt photos kept with an expense, up to three (docs/SPEC.md section 6, Receipt photos): the
// rule every client reads an entry's photos by. ExpenseDTO.receipt is the first photo, the only one
// clients from before several photos know, and ExpenseDTO.receipts is the whole list, first to
// last. The iPhone app has the same rule as ExpenseDTO.photos.

import type { ExpenseDTO, ReceiptDTO } from './types';

/** The most photos an expense keeps (the Worker refuses a fourth with 409 limit_reached). */
export const RECEIPT_PHOTOS_MAX = 3;

/** A ReceiptDTO as the server sends it: a version, a type, and the size in px and in bytes. */
export function isReceiptDTO(v: unknown): v is ReceiptDTO {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Partial<Record<keyof ReceiptDTO, unknown>>;
  return (
    typeof r.version === 'string' && r.version !== '' && typeof r.mime === 'string' &&
    typeof r.width === 'number' && typeof r.height === 'number' && typeof r.bytes === 'number'
  );
}

/**
 * An entry's photos, first to last, at most RECEIPT_PHOTOS_MAX:
 * 1. `receipts` when it is an array, without elements that are not a ReceiptDTO; otherwise
 *    `receipt` alone (a server or a cached copy from before several photos).
 * 2. When `receipt`'s version is the list's first (both missing count as equal): the list.
 * 3. Otherwise a client from before several photos patched only `receipt` in a cached copy (an old
 *    web tab writes its patched snapshot to the IndexedDB every tab shares), and the legacy routes'
 *    meaning applies: a `receipt` replaced the first photo (and a photo 2 or 3 with its bytes moved
 *    up), and a null `receipt` took the first photo off.
 */
export function photosOf(e: Pick<ExpenseDTO, 'receipt'> & { receipts?: unknown }): ReceiptDTO[] {
  const first = isReceiptDTO(e.receipt) ? e.receipt : null;
  const list = Array.isArray(e.receipts) ? e.receipts.filter(isReceiptDTO) : first ? [first] : [];
  let out: ReceiptDTO[];
  if ((first?.version ?? null) === (list[0]?.version ?? null)) out = list;
  else if (first) out = [first, ...list.slice(1).filter(p => p.version !== first.version)];
  else out = list.slice(1);
  return out.slice(0, RECEIPT_PHOTOS_MAX);
}
