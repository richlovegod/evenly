// Recurring entries. A series is one expense (or payment) and the copies made from it on its
// schedule; only the newest copy, the "head", carries the repeat setting. materializeDue() creates
// every copy that is due by `today`. It runs when a group is opened (GET /groups/:gid) and from the
// daily cron for all groups, so it must be cheap when nothing is due (one query) and never fail
// the request that called it.
//
// Copy ids are deterministic (uuidFrom(series + ':' + date)), so two runs at the same moment can
// never create the same copy twice: each run checks which copies exist, inserts the rest with a
// plain INSERT, and if another run got there first its whole batch (copies, activity, version
// bump) rolls back on the duplicate id. Anyone who ever saw a series can work those ids out, so
// clients may never create an entry with one (isCopyId, routes/expenses.ts): a row of another
// group under a due id would stop the series for good (review B2-07).
//
// 只刪除這一筆 hands a deleted head's repeat to the entry before it (handOverStmt), and 復原 of a
// head leaves its series with at most one live entry that repeats (restoreRepeat, restorePlan).

import { isISODate, nextOccurrence, REPEATS, type Repeat } from '../../shared/dates';
import { computeSharesFor, type Portion, type SplitInput } from '../../shared/split';
import { bumpVersionStmt, currencyGuardStmt, isGuardAbort, parseJSON, toExpenseDTO, unarchiveStmt, type ExpenseRow } from '../db';
import { nowISO, uuidFrom } from '../http';
import { activityStmt, entryActivityData } from './activity';
import { refreshSummary } from './summary';

/**
 * The shape of a copy id (http.ts uuidFrom: a SHA-256 in UUID form, version nibble 5, variant
 * nibble 8). Every id a client makes is a version 4 UUID (crypto.randomUUID, the web's newUuid and
 * importId, the iPhone's UUID()), so only the server ever writes ids of this shape.
 */
const COPY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether `id` has the shape of a recurring copy's id (COPY_ID_RE). Pure. */
export function isCopyId(id: string): boolean {
  return COPY_ID_RE.test(id);
}

/** Copies per series per run; a series further behind catches up on later runs. */
export const MAX_COPIES_PER_SERIES = 60;
/** Copies per group per run (keeps one batch small). */
export const MAX_COPIES_PER_GROUP = 120;
/** Bound parameters per IN (...) lookup (D1 allows 100 per statement). */
const IN_CHUNK = 90;

const REPEATING = REPEATS.filter(r => r !== 'none');

function isRepeating(x: string): x is Exclude<Repeat, 'none'> {
  return (REPEATING as readonly string[]).includes(x);
}

/**
 * The occurrence dates of a series head that are due by `today`, oldest first, at most `max`:
 * every occurrence of the schedule (repeat from repeat_start, or from the head's date) after the
 * head's own date. A head dated before its schedule's start (an older entry that took the repeat
 * over, handOverStmt or planSeries flagTo, after its date was moved earlier) counts from the
 * start instead: the start's occurrence exists already, made by the series' first entry (whose
 * id is the series id, not a copy id) or by the head that restarted the schedule there, so it is
 * never made a second time (review W7-contract-01). Pure.
 */
export function dueDates(
  head: { date: string; repeat: string; repeat_start: string | null },
  today: string,
  max = MAX_COPIES_PER_SERIES,
): string[] {
  if (!isRepeating(head.repeat) || !isISODate(head.date) || !isISODate(today)) return [];
  const start = head.repeat_start && isISODate(head.repeat_start) ? head.repeat_start : head.date;
  const out: string[] = [];
  let after = head.date > start ? head.date : start;
  while (out.length < max) {
    const next = nextOccurrence(start, head.repeat, after);
    if (!next || next > today) break;
    out.push(next);
    after = next;
  }
  return out;
}

export interface DueOccurrence {
  date: string;
  /** uuidFrom(series + ':' + date) */
  id: string;
}

/** What the database already holds under a due copy id. */
export interface ExistingOccurrence {
  group_id: string;
  deleted_at: string | null;
  repeat: string;
}

export interface SeriesPlan {
  /** Copies to insert, oldest first; only the newest may carry the repeat setting. */
  copies: { id: string; date: string; repeat: Repeat }[];
  /** An existing live copy that takes over the repeat setting (it is newer than every new copy). */
  flagTo: string | null;
  /** The head hands the repeat setting on (to a new copy, to flagTo, or to a head already ahead). */
  clearHead: boolean;
}

const NOTHING: SeriesPlan = { copies: [], flagTo: null, clearHead: false };

/**
 * Decide what one head needs, given the copies that already exist. Pure.
 * - An occurrence whose row exists is never created again (a deleted one stays deleted).
 * - The newest live occurrence takes the repeat setting: a new copy, or an existing live copy
 *   without a repeat of its own.
 * - If a due occurrence is already a live head with the same repeat, the series has moved on
 *   without this head (for example someone turned repeat on for an older copy): this head just
 *   drops its repeat, so the series never runs twice. A head with another repeat is left alone.
 * - Ids another head of this group plans in the same run are left to that head.
 */
export function planSeries(
  head: { id: string; repeat: Repeat },
  due: readonly DueOccurrence[],
  existing: ReadonlyMap<string, ExistingOccurrence>,
  plannedElsewhere: ReadonlySet<string>,
  groupId: string,
): SeriesPlan {
  const copies: SeriesPlan['copies'] = [];
  let newest: { id: string; fresh: boolean } | null = null;
  for (const d of due) {
    if (d.id === head.id || plannedElsewhere.has(d.id)) continue;
    const ex = existing.get(d.id);
    if (ex) {
      if (ex.group_id !== groupId || ex.deleted_at) continue;
      if (ex.repeat !== 'none') {
        if (ex.repeat === head.repeat) return { copies: [], flagTo: null, clearHead: true };
        continue;
      }
      newest = { id: d.id, fresh: false };
      continue;
    }
    copies.push({ id: d.id, date: d.date, repeat: 'none' });
    newest = { id: d.id, fresh: true };
  }
  if (!newest) return NOTHING;
  if (newest.fresh) copies[copies.length - 1].repeat = head.repeat;
  return { copies, flagTo: newest.fresh ? null : newest.id, clearHead: true };
}

// ---------- database ----------

interface HeadRow extends ExpenseRow {
  g_currency: string;
}

/** The repeats a head can have, for SQL (repeat IN (...)). */
const REPEATING_SQL = REPEATING.map(r => `'${r}'`).join(', ');

const HEADS_SQL = `SELECT e.*, g.currency AS g_currency
  FROM expenses e JOIN groups g ON g.id = e.group_id
  WHERE e.repeat IN (${REPEATING_SQL})
    AND e.deleted_at IS NULL AND g.deleted_at IS NULL`;

async function loadHeads(db: D1Database, groupId: string | undefined): Promise<HeadRow[]> {
  const r = groupId
    ? await db.prepare(HEADS_SQL + ' AND e.group_id = ?').bind(groupId).all<HeadRow>()
    : await db.prepare(HEADS_SQL + ' ORDER BY e.group_id').all<HeadRow>();
  return r.results ?? [];
}

async function loadExisting(db: D1Database, ids: readonly string[]): Promise<Map<string, ExistingOccurrence>> {
  const out = new Map<string, ExistingOccurrence>();
  if (!ids.length) return out;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = ids.slice(i, i + IN_CHUNK);
    stmts.push(
      db
        .prepare(`SELECT id, group_id, deleted_at, repeat FROM expenses WHERE id IN (${part.map(() => '?').join(', ')})`)
        .bind(...part),
    );
  }
  for (const r of await db.batch<ExistingOccurrence & { id: string }>(stmts)) {
    for (const x of r.results ?? []) out.set(x.id, { group_id: x.group_id, deleted_at: x.deleted_at, repeat: x.repeat });
  }
  return out;
}

/**
 * A copy's shares: computed for the copy's own id, like every other write (computeSharesFor), so
 * a later save of the copy never moves a rounding unit and the leftovers rotate across the series
 * instead of landing on the same person every time. The head's shares when its split cannot be
 * read (they are valid for the same amount and split). Pure.
 */
export function copyShares(head: Pick<ExpenseRow, 'amount' | 'split' | 'shares'>, copyId: string): Portion[] {
  const split = parseJSON<SplitInput | null>(head.split, null);
  if (split && typeof split === 'object' && Array.isArray(split.entries)) {
    try {
      const r = computeSharesFor(copyId, head.amount, split);
      if (r.ok) return r.shares;
    } catch {
      // fall back to the head's shares below
    }
  }
  return parseJSON<Portion[]>(head.shares, []);
}

function copyStmt(
  db: D1Database,
  head: ExpenseRow,
  copy: { id: string; date: string; repeat: Repeat },
  shares: readonly Portion[],
  series: string,
  start: string,
  now: string,
): D1PreparedStatement {
  // Plain INSERT on purpose: see the note at the top of the file.
  return db
    .prepare(
      `INSERT INTO expenses (id, group_id, kind, description, category, amount, currency, fx_rate, date, notes,
         payers, split, shares, repeat, repeat_series, repeat_start, created_by, created_at, updated_by, updated_at, version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?17, ?18, 1)`,
    )
    .bind(
      copy.id, head.group_id, head.kind, head.description, head.category, head.amount, head.currency, head.fx_rate,
      copy.date, head.notes, head.payers, head.split, JSON.stringify(shares), copy.repeat, series, start, head.created_by, now,
    );
}

function isDuplicateId(e: unknown): boolean {
  const msg = (x: unknown): string => (x instanceof Error ? x.message : String(x ?? ''));
  const cause = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  return /UNIQUE constraint failed/i.test(msg(e) + ' ' + msg(cause));
}

/**
 * 只刪除這一筆 (DELETE /groups/:gid/expenses/:eid?keep=series, review B2-05): the statement that
 * hands a head's repeat on to the newest live entry of its series dated before it, for the batch
 * that deletes the head (`deletedAt`, the delete's time: nothing is handed on when someone else's
 * delete got there first). The series then goes on without the deleted date: its row stays, so
 * planSeries never makes it again. Only for a head that is a copy on its own date (its id is that
 * date's copy id): a head whose date was moved restarted the schedule there under its old id, so
 * the date it left would come back. Null when there is nothing to hand on. The entry that takes it
 * over gets the head's repeat and schedule start and keeps its own date; 復原 gives the repeat back
 * only while it is still so (restoreRepeat).
 */
export async function handOverStmt(db: D1Database, head: ExpenseRow, deletedAt: string): Promise<D1PreparedStatement | null> {
  if (!isRepeating(head.repeat) || !head.repeat_series || head.deleted_at || !isISODate(head.date)) return null;
  if (head.id !== (await uuidFrom(`${head.repeat_series}:${head.date}`))) return null;
  const start = head.repeat_start && isISODate(head.repeat_start) ? head.repeat_start : head.date;
  return db
    .prepare(
      `UPDATE expenses SET repeat = ?1, repeat_series = ?2, repeat_start = ?3, version = version + 1
       WHERE id = (SELECT id FROM expenses
                   WHERE group_id = ?4 AND repeat_series = ?2 AND deleted_at IS NULL AND id <> ?5 AND date < ?6
                   ORDER BY date DESC, created_at DESC LIMIT 1)
         AND repeat = 'none'
         AND EXISTS (SELECT 1 FROM expenses WHERE id = ?5 AND deleted_at = ?7)`,
    )
    .bind(head.repeat, head.repeat_series, start, head.group_id, head.id, head.date, deletedAt);
}

// ---------- 復原 of a head ----------

/** Where an entry's schedule starts: repeat_start, else its date (as dueDates counts). */
function scheduleStart(e: { date: string; repeat_start: string | null }): string {
  return e.repeat_start && isISODate(e.repeat_start) ? e.repeat_start : e.date;
}

/** A live entry of a series that repeats. */
export interface RepeatingEntry {
  id: string;
  date: string;
  repeat: string;
  repeat_start: string | null;
}

/** A deleted head's series as its 復原 finds it (seriesAtRestore). */
export interface SeriesAtRestore {
  /** The live entries of the series that repeat, the head left out (at most two are read). */
  repeating: RepeatingEntry[];
  /** The newest live entry of the series dated before the head: the one handOverStmt would pick now. */
  before: string | null;
  /** Since the head was deleted, a copy of the series was made: the series went on past it. */
  moved: boolean;
  /** Since then, an entry of the series that repeats was deleted, or one had its repeat changed. */
  stopped: boolean;
}

export type RestoreRepeat =
  /** The restored head keeps its repeat; nothing else changes. */
  | { kind: 'keep' }
  /** An exact undo of 只刪除這一筆: entry `from` gives the repeat back to the restored head. */
  | { kind: 'takeBack'; from: string }
  /** The restored head comes back without its repeat, as a plain entry of its series. */
  | { kind: 'drop' };

/**
 * What 復原 does with a deleted head's repeat (review B2-05, Gino's call of 2026-11-21): afterwards
 * its series has at most one live entry that repeats, and none of its dates is made twice. Pure.
 * - The only other live entry that repeats is the one a hand-over from this head would pick now
 *   (the newest live entry before it), with the head's repeat and schedule start, and no copy was
 *   made since: it is as 只刪除這一筆 left it, and gives the repeat back (an exact undo). The
 *   schedule is the head's again, so its next date is the one it had before the delete. An entry
 *   that repeats deleted since does not stop this, such as the entry that took over deleted with
 *   只刪除這一筆 in turn (the one before it holds the repeat as a hand-over leaves it; the deleted
 *   date stays skipped).
 * - Nothing else repeats and nothing changed since the delete (刪除並停止重複, or 只刪除這一筆 that
 *   nothing could take over): the head repeats again, as 復原 always brought a stopped series back.
 * - Anything else, such as the entry that took over moved to another date or set to another repeat,
 *   a copy made since, or the series stopped since (an entry that repeats deleted, a repeat turned
 *   off): the change wins, and the head comes back without its repeat. Its row keeps its date's
 *   copy id, so planSeries never makes that date again; the series goes on from the entry that
 *   repeats now, or stays stopped, and nothing is made for dates it has passed.
 */
export function restoreRepeat(head: { date: string; repeat: string; repeat_start: string | null }, s: SeriesAtRestore): RestoreRepeat {
  if (!isRepeating(head.repeat)) return { kind: 'keep' };
  if (!s.repeating.length) return s.moved || s.stopped ? { kind: 'drop' } : { kind: 'keep' };
  const [t] = s.repeating;
  const asLeft = s.repeating.length === 1 && t.id === s.before && t.repeat === head.repeat && scheduleStart(t) === scheduleStart(head);
  return asLeft && !s.moved ? { kind: 'takeBack', from: t.id } : { kind: 'drop' };
}

/**
 * What happened in a series after one of its entries was deleted, that is after that entry's
 * 'expense.delete' row in the activity's order (created_at, then rowid, so a step in the same
 * millisecond still falls on the right side). `moved`: a copy was made ('recurring.create').
 * `stopped`: an entry that still repeats was deleted, or an entry's repeat was changed (an
 * 'expense.update' whose changes list repeat). ?1 group, ?2 series, ?3 the deleted entry, ?4 its
 * deleted_at (the time of its delete row).
 */
const SINCE_SQL = `SELECT
    COALESCE(MAX(a.type = 'recurring.create'), 0) AS moved,
    COALESCE(MAX((a.type = 'expense.delete' AND e.deleted_at IS NOT NULL AND e.repeat IN (${REPEATING_SQL}))
      OR (a.type = 'expense.update' AND a.data LIKE '%"field":"repeat"%')), 0) AS stopped
  FROM activity a JOIN expenses e ON e.id = a.expense_id
  WHERE a.group_id = ?1 AND a.created_at >= ?4
    AND (a.created_at > ?4
      OR a.rowid > (SELECT COALESCE(MAX(rowid), 0) FROM activity WHERE expense_id = ?3 AND type = 'expense.delete' AND created_at = ?4))
    AND e.group_id = ?1 AND e.repeat_series = ?2 AND e.id <> ?3`;

/** What restoreRepeat needs to know about a deleted head's series, read in one batch. */
export async function seriesAtRestore(db: D1Database, head: ExpenseRow): Promise<SeriesAtRestore> {
  const series = head.repeat_series || head.id;
  const [rRes, bRes, sRes] = await db.batch([
    db
      .prepare(
        `SELECT id, date, repeat, repeat_start FROM expenses
         WHERE group_id = ?1 AND repeat_series = ?2 AND id <> ?3 AND deleted_at IS NULL AND repeat IN (${REPEATING_SQL})
         LIMIT 2`,
      )
      .bind(head.group_id, series, head.id),
    // The entry handOverStmt picks.
    db
      .prepare(
        `SELECT id FROM expenses WHERE group_id = ?1 AND repeat_series = ?2 AND id <> ?3 AND deleted_at IS NULL AND date < ?4
         ORDER BY date DESC, created_at DESC LIMIT 1`,
      )
      .bind(head.group_id, series, head.id, head.date),
    db.prepare(SINCE_SQL).bind(head.group_id, series, head.id, head.deleted_at),
  ]);
  const since = (sRes.results?.[0] ?? {}) as { moved?: number; stopped?: number };
  return {
    repeating: (rRes.results ?? []) as RepeatingEntry[],
    before: ((bRes.results ?? [])[0] as { id: string } | undefined)?.id ?? null,
    moved: !!since.moved,
    stopped: !!since.stopped,
  };
}

/**
 * restoreRepeat's takeBack, for the batch that restores `head`, ahead of the restore: entry `from`
 * stops repeating, only while it still has the head's repeat and schedule start and the head is
 * still in the deletion that was read (its deleted_at), so it does nothing when another request
 * restored the head first.
 */
export function handBackStmt(db: D1Database, head: ExpenseRow, from: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE expenses SET repeat = 'none', version = version + 1
       WHERE id = ?1 AND group_id = ?2 AND deleted_at IS NULL AND repeat = ?3 AND COALESCE(repeat_start, date) = ?4
         AND EXISTS (SELECT 1 FROM expenses WHERE id = ?5 AND deleted_at = ?6)`,
    )
    .bind(from, head.group_id, head.repeat, scheduleStart(head), head.id, head.deleted_at);
}

/**
 * SQL for the repeat an entry comes back with, inside the UPDATE that restores it
 * (routes/expenses.ts setDeleted), given the placeholders it binds for the entry's id, its group,
 * its series and `drop` (1 when restoreRepeat dropped the repeat, else 0): 'none' when dropped,
 * and also when another live entry of its series repeats as the batch runs (after handBackStmt),
 * so a 復原 never leaves two entries of a series repeating, even when something changed between
 * restorePlan's reads and the write. Otherwise the repeat as stored.
 */
export function restoredRepeatSql(id: string, groupId: string, series: string, drop: string): string {
  return `CASE WHEN ${drop} = 1 OR (repeat IN (${REPEATING_SQL}) AND EXISTS (
      SELECT 1 FROM expenses o WHERE o.group_id = ${groupId} AND o.repeat_series = ${series} AND o.id <> ${id}
        AND o.deleted_at IS NULL AND o.repeat IN (${REPEATING_SQL})))
    THEN 'none' ELSE repeat END`;
}

/**
 * 復原 of a deleted entry (POST .../restore, routes/expenses.ts setDeleted): for a head, reads its
 * series and decides with restoreRepeat. `drop` goes into the restore's UPDATE (restoredRepeatSql),
 * `handBack` ahead of it in the same batch. Nothing to decide for an entry that does not repeat.
 */
export async function restorePlan(db: D1Database, head: ExpenseRow): Promise<{ drop: boolean; handBack: D1PreparedStatement | null }> {
  if (!head.deleted_at || !isRepeating(head.repeat) || !isISODate(head.date)) return { drop: false, handBack: null };
  const r = restoreRepeat(head, await seriesAtRestore(db, head));
  return { drop: r.kind === 'drop', handBack: r.kind === 'takeBack' ? handBackStmt(db, head, r.from) : null };
}

async function materializeGroup(
  db: D1Database,
  groupId: string,
  groupCurrency: string,
  heads: { row: HeadRow; dates: string[] }[],
  now: string,
): Promise<number> {
  const items: { head: HeadRow; series: string; start: string; due: DueOccurrence[] }[] = [];
  for (const { row, dates } of heads) {
    const series = row.repeat_series || row.id;
    const start = row.repeat_start && isISODate(row.repeat_start) ? row.repeat_start : row.date;
    const due = await Promise.all(dates.map(async date => ({ date, id: await uuidFrom(`${series}:${date}`) })));
    items.push({ head: row, series, start, due });
  }
  const existing = await loadExisting(db, [...new Set(items.flatMap(i => i.due.map(d => d.id)))]);
  for (const [id, ex] of existing) {
    // Never written by this group: planSeries skips the date, so the series cannot pass it.
    if (ex.group_id !== groupId) console.warn(`materializeDue: copy id ${id} of group ${groupId} is taken by group ${ex.group_id}; that date is skipped`);
  }

  const planned = new Set<string>();
  const stmts: D1PreparedStatement[] = [];
  let created = 0;
  for (const it of items) {
    const repeat = it.head.repeat as Repeat;
    const plan = planSeries({ id: it.head.id, repeat }, it.due, existing, planned, groupId);
    if (!plan.copies.length && !plan.flagTo && !plan.clearHead) continue;
    if (plan.copies.length) {
      const head = toExpenseDTO(it.head);
      for (const copy of plan.copies) {
        planned.add(copy.id);
        const shares = copyShares(it.head, copy.id);
        stmts.push(copyStmt(db, it.head, copy, shares, it.series, it.start, now));
        // Each copy's own effect: its shares, and its id for the rounding of a converted amount.
        const data = entryActivityData({ ...head, id: copy.id, shares }, groupCurrency);
        stmts.push(
          activityStmt(db, { groupId, userId: null, memberId: null, type: 'recurring.create', expenseId: copy.id, data, now }),
        );
        created++;
      }
    }
    if (plan.flagTo) {
      planned.add(plan.flagTo);
      stmts.push(
        db
          .prepare(
            `UPDATE expenses SET repeat = ?1, repeat_series = ?2, repeat_start = ?3, version = version + 1
             WHERE id = ?4 AND group_id = ?5 AND deleted_at IS NULL AND repeat = 'none'`,
          )
          .bind(repeat, it.series, it.start, plan.flagTo, groupId),
      );
    }
    if (plan.clearHead) {
      // Guarded by the repeat we read, so a concurrent edit of the head is not undone.
      stmts.push(
        db.prepare(`UPDATE expenses SET repeat = 'none', version = version + 1 WHERE id = ? AND repeat = ?`).bind(it.head.id, repeat),
      );
    }
  }
  if (!stmts.length) return 0;
  stmts.push(bumpVersionStmt(db, groupId, now));
  // A new copy is a new debt nobody wrote by hand: the group comes back for everyone who archived
  // it (docs/SPEC.md section 4, Archive).
  if (created) stmts.push(unarchiveStmt(db, groupId, null));
  // The copies take the head's rate, which is for the currency loadHeads read: nothing is written
  // if PATCH /groups changed the currency since (review B2-06).
  if (created) stmts.push(currencyGuardStmt(db, groupId, groupCurrency));

  try {
    await db.batch(stmts);
  } catch (e) {
    if (isGuardAbort(e)) {
      console.log(`materializeDue: the currency of group ${groupId} changed meanwhile; nothing written, the next read tries again`);
      return 0;
    }
    if (!isDuplicateId(e)) throw e;
    console.log(`materializeDue: another run created the copies for group ${groupId} first; nothing written`);
    return 0;
  }
  await refreshSummary(db, groupId); // logs and returns null on failure; summaries are recomputed on read
  return created;
}

/**
 * Create the recurring copies due by `today` (YYYY-MM-DD, UTC) in one group, or in every group
 * when `groupId` is left out. Returns how many copies were created. Never throws: problems are
 * logged and the group is tried again on its next read or the next cron run.
 */
export async function materializeDue(db: D1Database, opts: { groupId?: string; today: string }): Promise<number> {
  if (!isISODate(opts.today)) return 0;
  let created = 0;
  try {
    const heads = await loadHeads(db, opts.groupId);
    if (!heads.length) return 0;

    // Work out what is due without touching the database; most of the time nothing is.
    const groups = new Map<string, { currency: string; budget: number; heads: { row: HeadRow; dates: string[] }[] }>();
    for (const row of heads) {
      let g = groups.get(row.group_id);
      if (!g) {
        g = { currency: row.g_currency, budget: MAX_COPIES_PER_GROUP, heads: [] };
        groups.set(row.group_id, g);
      }
      if (g.budget <= 0) continue;
      const dates = dueDates(row, opts.today, Math.min(MAX_COPIES_PER_SERIES, g.budget));
      if (!dates.length) continue;
      g.budget -= dates.length;
      g.heads.push({ row, dates });
    }

    const now = nowISO();
    for (const [gid, g] of groups) {
      if (!g.heads.length) continue;
      try {
        created += await materializeGroup(db, gid, g.currency, g.heads, now);
      } catch (e) {
        console.error('materializeDue failed for group', gid, e);
      }
    }
  } catch (e) {
    console.error('materializeDue failed', e);
  }
  return created;
}
