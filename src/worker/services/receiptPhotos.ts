// Receipt photos kept with their expense, up to three (docs/SPEC.md section 6, Receipt photos):
// where the bytes live in Workers KV, and the daily cleanup. The routes are in
// routes/receiptPhotos.ts; an expense's first photo is its `receipts` row, the others are rows of
// `receipt_extras` (migration 0016).
//
// Deleting an expense is a soft delete that 復原 can undo, so it keeps its photos; the daily job
// (services/cron.ts) deletes the photos of expenses deleted more than a day ago, and of deleted
// groups (a group cannot be restored). It picks expenses, not photos, so an expense's photos go
// together. Each photo goes from KV first and then from D1, so a KV delete that fails leaves its
// row, and the next run tries again: no object is ever left without its row. The owner's erase of
// a deleted group (POST /api/admin/groups/:gid/purge, routes/admin.ts) deletes its photos the same
// way, with deletePhotoObjects and photoRowDeleteStmt.

import type { Env } from '../env';
import { touchGroupsStmts } from './summary';

/** The KV key of one photo: a new photo of the same expense gets a new key (its version). */
export function receiptKey(expenseId: string, version: string): string {
  return `receipt:${expenseId}:${version}`;
}

/** How long a deleted expense keeps its photos, so 復原 brings them back. */
export const RECEIPT_UNDO_MS = 86_400_000;

/**
 * Expenses whose photos one daily run deletes at most: 100 expenses a run, so at most 300 photos.
 * Not a spending cap: each photo is still deleted once, and more than this in a day (a big group
 * deleted) waits for the next runs, oldest deletion first. It was 25 until review B4b-13: a deleted
 * group with 300 photo entries then took 12 days, and every deletion after it waited behind it.
 * Limits checked 2026-10-30: Workers Paid allows 10,000 subrequests an invocation and 15 minutes of
 * CPU for a daily Cron Trigger, KV 1,000 operations an invocation, and D1 1,000 queries an
 * invocation, which this step shares with the rest of the daily job (recurring copies above all).
 * This step makes one D1 read, at most 300 KV deletes and one D1 batch of at most 300 row deletes
 * plus the version bumps of their groups (one statement per 90 groups): 302 subrequests, 300 KV
 * operations and about 300 D1 statements. Workers Paid includes 1,000,000 KV deletes a month for
 * the account, far above 300 a day.
 */
export const RECEIPT_CLEANUP_EXPENSES_PER_RUN = 100;

/** A stored photo to delete: its expense, its KV key, and its table ('first': receipts, 'extra': receipt_extras). */
export interface PhotoRef {
  expense_id: string;
  kv_key: string;
  t: string;
}

/**
 * Every photo of the due expenses (deleted a day ago, or in a deleted group), oldest deletion first,
 * each with its table and the group of its expense (whose snapshot lists it).
 */
const DUE_SQL = `WITH photos AS (SELECT expense_id, kv_key, 'first' AS t FROM receipts
                  UNION ALL SELECT expense_id, kv_key, 'extra' FROM receipt_extras),
  due AS (SELECT p.expense_id, e.group_id, MIN(COALESCE(g.deleted_at, e.deleted_at)) AS gone FROM photos p
          JOIN expenses e ON e.id = p.expense_id JOIN groups g ON g.id = e.group_id
          WHERE g.deleted_at IS NOT NULL OR (e.deleted_at IS NOT NULL AND e.deleted_at < ?1)
          GROUP BY p.expense_id, e.group_id ORDER BY gone LIMIT ?2)
  SELECT p.expense_id, due.group_id, p.kv_key, p.t FROM photos p JOIN due USING (expense_id)`;

/**
 * Deletes these photos' KV objects, all at once. `gone`: the ones whose object went, whose rows may
 * go now; `failed`: how many deletes failed, whose rows must stay so a later run finds them again.
 */
export async function deletePhotoObjects<T extends PhotoRef>(kv: KVNamespace, photos: readonly T[]): Promise<{ gone: T[]; failed: number }> {
  const results = await Promise.allSettled(photos.map(p => kv.delete(p.kv_key)));
  const gone = photos.filter((_, i) => results[i].status === 'fulfilled');
  return { gone, failed: photos.length - gone.length };
}

/** Deletes one photo's row from its own table, by (expense_id, kv_key): a photo stored again meanwhile stays. */
export function photoRowDeleteStmt(db: D1Database, p: PhotoRef): D1PreparedStatement {
  return db.prepare(`DELETE FROM ${p.t === 'first' ? 'receipts' : 'receipt_extras'} WHERE expense_id = ? AND kv_key = ?`).bind(p.expense_id, p.kv_key);
}

/**
 * Delete the photos of expenses deleted before `now` minus a day, or whose group was deleted, at
 * most RECEIPT_CLEANUP_EXPENSES_PER_RUN expenses a run: the KV objects, then the rows of the ones
 * that went, each from its own table (kv_key in the WHERE, so a photo stored again meanwhile stays),
 * in one batch with the version bump of each group whose photos went. Returns how many photos went
 * and how many KV deletes failed (those stay for the next run). Without the KV binding nothing is
 * deleted.
 */
export async function cleanupReceiptPhotos(env: Pick<Env, 'DB' | 'RECEIPTS'>, now: Date): Promise<{ deleted: number; failed: number }> {
  const kv = env.RECEIPTS;
  if (!kv) return { deleted: 0, failed: 0 };
  const db = env.DB;
  const cutoff = new Date(now.getTime() - RECEIPT_UNDO_MS).toISOString();
  const due = (await db.prepare(DUE_SQL).bind(cutoff, RECEIPT_CLEANUP_EXPENSES_PER_RUN).all<PhotoRef & { group_id: string }>()).results ?? [];
  if (!due.length) return { deleted: 0, failed: 0 };
  const { gone, failed } = await deletePhotoObjects(kv, due);
  if (gone.length) {
    // Every photo write bumps its group's version (docs/SPEC.md section 6), and so does this one
    // (review B4a-02): a cached snapshot, whose ETag is the version, would otherwise keep listing
    // these photos on their deleted entry, where they now answer 404. No balance moves, so a
    // current summary stays current (touchGroupsStmts drops repeated ids); a deleted group's bump
    // is harmless. One batch, so a row goes only with its group's bump.
    await db.batch([...gone.map(p => photoRowDeleteStmt(db, p)), ...touchGroupsStmts(db, gone.map(p => p.group_id))]);
  }
  return { deleted: gone.length, failed };
}
