// Recurring entries. A series is one expense (or payment) and the copies made from it on its
// schedule; only the newest copy, the "head", carries the repeat setting. materializeDue() creates
// every copy that is due by `today`. It runs when a group is opened (GET /groups/:gid) and from the
// daily cron for all groups, so it must be cheap when nothing is due (one query) and never fail
// the request that called it.
//
// Copy ids are deterministic (uuidFrom(series + ':' + date)), so two runs at the same moment can
// never create the same copy twice: each run checks which copies exist, inserts the rest with a
// plain INSERT, and if another run got there first its whole batch (copies, activity, version
// bump) rolls back on the duplicate id.

import { isISODate, nextOccurrence, REPEATS, type Repeat } from '../../shared/dates';
import { computeSharesFor, type Portion, type SplitInput } from '../../shared/split';
import { bumpVersionStmt, parseJSON, toExpenseDTO, type ExpenseRow } from '../db';
import { nowISO, uuidFrom } from '../http';
import { activityStmt, entryActivityData } from './activity';
import { refreshSummary } from './summary';

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
 * head's own date. Pure.
 */
export function dueDates(
  head: { date: string; repeat: string; repeat_start: string | null },
  today: string,
  max = MAX_COPIES_PER_SERIES,
): string[] {
  if (!isRepeating(head.repeat) || !isISODate(head.date) || !isISODate(today)) return [];
  const start = head.repeat_start && isISODate(head.repeat_start) ? head.repeat_start : head.date;
  const out: string[] = [];
  let after = head.date;
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

const HEADS_SQL = `SELECT e.*, g.currency AS g_currency
  FROM expenses e JOIN groups g ON g.id = e.group_id
  WHERE e.repeat IN (${REPEATING.map(r => `'${r}'`).join(', ')})
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

  try {
    await db.batch(stmts);
  } catch (e) {
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
