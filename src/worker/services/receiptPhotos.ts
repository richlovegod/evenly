// Receipt photos kept with their expense, up to three (docs/SPEC.md section 6, Receipt photos):
// where the bytes live in Workers KV, and the daily cleanup. The routes are in
// routes/receiptPhotos.ts; an expense's first photo is its `receipts` row, the others are rows of
// `receipt_extras` (migration 0016).
//
// Deleting an expense is a soft delete that 復原 can undo, so it keeps its photos; the daily job
// (services/cron.ts) deletes the photos of expenses deleted more than a day ago, and of deleted
// groups (a group cannot be restored). It picks expenses, not photos, so an expense's photos go
// together. Each photo goes from KV first and then from D1, so a KV delete that fails leaves its
// row, and the next run tries again: no object is ever left without its row.

import type { Env } from '../env';

/** The KV key of one photo: a new photo of the same expense gets a new key (its version). */
export function receiptKey(expenseId: string, version: string): string {
  return `receipt:${expenseId}:${version}`;
}

/** How long a deleted expense keeps its photos, so 復原 brings them back. */
export const RECEIPT_UNDO_MS = 86_400_000;

/**
 * Expenses whose photos one daily run deletes at most: today's 25 expenses a run, so at most 75
 * photos. Not a spending cap: each photo is still deleted once, and more than this in a day (a big
 * group deleted) waits for the next runs, oldest deletion first. Limits checked 2026-10-30: Workers
 * Paid allows 10,000 subrequests an invocation and 15 minutes of CPU for a daily Cron Trigger, and
 * KV 1,000 operations an invocation; this step makes one D1 read, at most 75 KV deletes and one D1
 * batch (77 subrequests, 75 KV operations). Workers Paid includes 1,000,000 KV deletes a month for
 * the account, far above 75 a day.
 */
export const RECEIPT_CLEANUP_EXPENSES_PER_RUN = 25;

/** Every photo of the due expenses (deleted a day ago, or in a deleted group), oldest deletion first, each with its table. */
const DUE_SQL = `WITH photos AS (SELECT expense_id, kv_key, 'first' AS t FROM receipts
                  UNION ALL SELECT expense_id, kv_key, 'extra' FROM receipt_extras),
  due AS (SELECT p.expense_id, MIN(COALESCE(g.deleted_at, e.deleted_at)) AS gone FROM photos p
          JOIN expenses e ON e.id = p.expense_id JOIN groups g ON g.id = e.group_id
          WHERE g.deleted_at IS NOT NULL OR (e.deleted_at IS NOT NULL AND e.deleted_at < ?1)
          GROUP BY p.expense_id ORDER BY gone LIMIT ?2)
  SELECT p.expense_id, p.kv_key, p.t FROM photos p JOIN due USING (expense_id)`;

/**
 * Delete the photos of expenses deleted before `now` minus a day, or whose group was deleted, at
 * most RECEIPT_CLEANUP_EXPENSES_PER_RUN expenses a run: the KV objects, then the rows of the ones
 * that went, each from its own table (kv_key in the WHERE, so a photo stored again meanwhile stays).
 * Returns how many photos went and how many KV deletes failed (those stay for the next run).
 * Without the KV binding nothing is deleted.
 */
export async function cleanupReceiptPhotos(env: Pick<Env, 'DB' | 'RECEIPTS'>, now: Date): Promise<{ deleted: number; failed: number }> {
  const kv = env.RECEIPTS;
  if (!kv) return { deleted: 0, failed: 0 };
  const db = env.DB;
  const cutoff = new Date(now.getTime() - RECEIPT_UNDO_MS).toISOString();
  const due = (await db.prepare(DUE_SQL).bind(cutoff, RECEIPT_CLEANUP_EXPENSES_PER_RUN).all<{ expense_id: string; kv_key: string; t: string }>()).results ?? [];
  if (!due.length) return { deleted: 0, failed: 0 };
  const results = await Promise.allSettled(due.map(r => kv.delete(r.kv_key)));
  const gone = due.filter((_, i) => results[i].status === 'fulfilled');
  if (gone.length) {
    await db.batch(
      gone.map(r => db.prepare(`DELETE FROM ${r.t === 'first' ? 'receipts' : 'receipt_extras'} WHERE expense_id = ? AND kv_key = ?`).bind(r.expense_id, r.kv_key)),
    );
  }
  return { deleted: gone.length, failed: due.length - gone.length };
}
