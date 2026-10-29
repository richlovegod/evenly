// Receipt photos kept with their expense (docs/SPEC.md section 6, Receipt photos): where the
// bytes live in Workers KV, and the daily cleanup. The routes are in routes/receiptPhotos.ts.
//
// Deleting an expense is a soft delete that 復原 can undo, so it keeps the photo; the daily job
// (services/cron.ts) deletes the photos of expenses deleted more than a day ago, and of deleted
// groups (a group cannot be restored). Each one goes from KV first and then from D1, so a KV delete
// that fails leaves the row, and the next run tries again: no object is ever left without its row.

import type { Env } from '../env';

/** The KV key of one photo: a new photo of the same expense gets a new key (its version). */
export function receiptKey(expenseId: string, version: string): string {
  return `receipt:${expenseId}:${version}`;
}

/** How long a deleted expense keeps its photo, so 復原 brings it back. */
export const RECEIPT_UNDO_MS = 86_400_000;

/**
 * Photos one daily run deletes at most. Workers Free allows 50 subrequests an invocation, and
 * every KV delete and D1 call is one: this step makes one D1 read, at most this many KV deletes
 * and one D1 batch, which leaves the rest of the run (the recurring copies, the rates) room. More
 * than this in a day (a big group deleted) waits for the next runs, oldest deletion first. Workers
 * Paid includes 1,000,000 KV deletes a month for the account, far above this.
 */
export const RECEIPT_CLEANUP_PER_RUN = 25;

const DUE_SQL = `SELECT r.expense_id, r.kv_key FROM receipts r
  JOIN expenses e ON e.id = r.expense_id
  JOIN groups g ON g.id = r.group_id
  WHERE g.deleted_at IS NOT NULL OR (e.deleted_at IS NOT NULL AND e.deleted_at < ?1)
  ORDER BY COALESCE(g.deleted_at, e.deleted_at)
  LIMIT ?2`;

/**
 * Delete the photos whose expense was deleted before `now` minus a day, or whose group was deleted:
 * the KV objects, then the rows of the ones that went (kv_key in the WHERE, so a photo stored again
 * meanwhile stays). Returns how many went and how many KV deletes failed (those stay for the next
 * run). Without the KV binding nothing is deleted.
 */
export async function cleanupReceiptPhotos(env: Pick<Env, 'DB' | 'RECEIPTS'>, now: Date): Promise<{ deleted: number; failed: number }> {
  const kv = env.RECEIPTS;
  if (!kv) return { deleted: 0, failed: 0 };
  const db = env.DB;
  const cutoff = new Date(now.getTime() - RECEIPT_UNDO_MS).toISOString();
  const due = (await db.prepare(DUE_SQL).bind(cutoff, RECEIPT_CLEANUP_PER_RUN).all<{ expense_id: string; kv_key: string }>()).results ?? [];
  if (!due.length) return { deleted: 0, failed: 0 };
  const results = await Promise.allSettled(due.map(r => kv.delete(r.kv_key)));
  const gone = due.filter((_, i) => results[i].status === 'fulfilled');
  if (gone.length) {
    await db.batch(gone.map(r => db.prepare('DELETE FROM receipts WHERE expense_id = ? AND kv_key = ?').bind(r.expense_id, r.kv_key)));
  }
  return { deleted: gone.length, failed: due.length - gone.length };
}
