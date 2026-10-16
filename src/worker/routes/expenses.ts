// Expenses and payments (create or edit, delete, restore), their comments and history, and the
// bulk import. Mounted by index.ts under /api; every route needs a signed-in active member.
//
// The money rules live in src/shared: the server recomputes shares with computeSharesFor()
// (rounding leftovers follow a fair, stable order from the expense id) and checks payers with
// checkPayers(); shares sent by a client are ignored. The pure helpers (normalizeUpsert, planImport, expenseChanges, repeatFields) are
// exported for tests/worker/expense-validation.test.ts.

import { Hono } from 'hono';
import { z } from 'zod';
import { isCategoryKey } from '../../shared/categories';
import { addDays, isISODate, REPEATS, todayUTC, type Repeat } from '../../shared/dates';
import { convertMinor } from '../../shared/balances';
import { formatMoney, MAX_AMOUNT } from '../../shared/money';
import {
  checkPayers,
  computeShares,
  computeSharesFor,
  SPLIT_METHODS,
  type PayersErrorCode,
  type Portion,
  type SplitEntry,
  type SplitErrorCode,
  type SplitInput,
  type SplitItem,
  type SplitMethod,
} from '../../shared/split';
import type { ActivityData, CommentDTO, ExpenseDTO, ExpenseKind, UpsertExpenseRes } from '../../shared/types';
import { requireUser } from '../auth';
import {
  bumpVersionStmt,
  parseJSON,
  requireMember,
  toExpenseDTO,
  versionFromBatch,
  type CommentRow,
  type ExpenseRow,
  type GroupRow,
  type MemberRow,
} from '../db';
import type { AppEnv } from '../env';
import { fail, json, newId, nowISO, readJson } from '../http';
import { activitySelect, activityStmt, entryActivityData, toActivityDTO, type ActivityJoinedRow } from '../services/activity';
import { refreshSummary } from '../services/summary';

// ---------- limits (SPEC section 6) ----------

/** Ids the client makes for expenses and comments (UUIDs in practice). */
export const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** Live (not deleted) entries per group. */
export const MAX_LIVE_ENTRIES = 5000;
/** Entries per import request. */
export const MAX_IMPORT = 500;
/** Inserts per db.batch during an import. */
export const IMPORT_CHUNK = 50;
export const DESCRIPTION_MAX = 120;
export const NOTES_MAX = 2000;
export const COMMENT_MAX = 1000;
/** Payers, split entries and items per expense, and members per item. */
export const LIST_MAX = 50;
export const ITEM_NAME_MAX = 60;
/** fxRate must be > 0 and below this. */
export const FX_RATE_MAX = 1e9;
export const MIN_DATE = '2000-01-01';
/** The latest allowed date is today (UTC) plus this many days. */
export const MAX_DAYS_AHEAD = 366;
/** Activity keeps at most this many characters (code points) of a comment or a note. */
const SNIPPET_MAX = 200;

// ---------- request schema ----------

const memberIdSchema = z.string().min(1).max(64);
const methodSchema = z.custom<SplitMethod>(
  v => typeof v === 'string' && (SPLIT_METHODS as readonly string[]).includes(v),
  'Unknown split method',
);
const repeatSchema = z.custom<Repeat>(v => typeof v === 'string' && (REPEATS as readonly string[]).includes(v), 'Unknown repeat');

/**
 * UpsertExpenseReq. Amounts are safe integers (minor units) and other numbers finite; the money
 * rules themselves (sums, positive shares) are checked by computeShares / checkPayers so their
 * error codes reach the client. Unknown keys (baseVersion, id, shares...) are dropped; optional
 * text fields also accept null.
 */
export const upsertSchema = z.object({
  kind: z.enum(['expense', 'payment']),
  description: z.string().trim().max(DESCRIPTION_MAX).nullish(),
  /** Any value: a known category key is kept, everything else becomes 'general'. */
  category: z.unknown().optional(),
  amount: z.number().int().min(1).max(MAX_AMOUNT),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
  fxRate: z.number().finite().nullish(),
  date: z.string().max(32),
  notes: z.string().trim().max(NOTES_MAX).nullish(),
  payers: z
    .array(z.object({ memberId: memberIdSchema, amount: z.number().int().safe() }))
    .max(LIST_MAX),
  split: z.object({
    method: methodSchema,
    entries: z
      .array(z.object({ memberId: memberIdSchema, value: z.number().finite().nullish() }))
      .max(LIST_MAX)
      .nullish(),
    items: z
      .array(
        z.object({
          id: z.string().max(64).nullish(),
          name: z.string().trim().max(ITEM_NAME_MAX).nullish(),
          amount: z.number().int().safe(),
          memberIds: z.array(memberIdSchema).max(LIST_MAX),
        }),
      )
      .max(LIST_MAX)
      .nullish(),
  }),
  repeat: repeatSchema.nullish(),
});

// ---------- normalization (pure) ----------

export type UpsertErrorCode =
  | 'invalid_field'
  | 'description_required'
  | 'unknown_member'
  | 'invalid_date'
  | 'date_out_of_range'
  | 'invalid_fx_rate'
  | 'payment_payer'
  | 'payment_split'
  | 'payment_self'
  | SplitErrorCode
  | PayersErrorCode;

export interface UpsertError {
  code: UpsertErrorCode;
  /** English, for logs and the API error message (the web app words errors from `code`). */
  message: string;
  /** Where the problem is: a field path for schema errors, else 'payers', 'split', 'date'... */
  field?: string;
  /** From computeShares / checkPayers: minor units (or percentage points) still unassigned. */
  diff?: number;
  /** For unknown_member. */
  memberId?: string;
  /** Schema problems (zod issues). */
  issues?: z.ZodIssue[];
}

/** An entry exactly as it will be stored. */
export interface NormalizedEntry {
  kind: ExpenseKind;
  description: string;
  category: string;
  amount: number;
  currency: string;
  /** Exactly 1 when `currency` is the group currency. */
  fxRate: number;
  date: string;
  notes: string;
  payers: Portion[];
  split: SplitInput;
  /** Computed here, never taken from the client. */
  shares: Portion[];
  repeat: Repeat;
}

export type NormalizeResult = { ok: true; entry: NormalizedEntry } | { ok: false; error: UpsertError };

const SPLIT_MESSAGES: Record<SplitErrorCode, string> = {
  invalid_total: 'The amount is not valid',
  no_participants: 'Choose who shares this expense',
  duplicate_member: 'Someone is in the split twice',
  invalid_value: 'A split value is not valid',
  exact_mismatch: 'The amounts do not add up to the total',
  percent_mismatch: 'The percentages do not add up to 100',
  zero_weights: 'Give at least one person a share',
  negative_share: 'The adjustments leave someone with less than nothing',
  no_items: 'Add at least one item with an amount',
  item_no_members: 'Every item needs at least one person',
  items_exceed_total: 'The items add up to more than the total allows',
};

const PAYER_MESSAGES: Record<PayersErrorCode, string> = {
  no_payers: 'Choose who paid',
  duplicate_member: 'Someone is listed twice as a payer',
  invalid_value: 'A paid amount is not valid',
  payers_mismatch: 'The paid amounts do not add up to the total',
};

function bad(error: UpsertError): NormalizeResult {
  return { ok: false, error };
}

/**
 * Validate an UpsertExpenseReq (any JSON value) for a group and return the entry to store, or
 * the first problem found. `memberIds` = every member of the group, active or not; `today` =
 * today's date in UTC (dates may run from 2000-01-01 to today + 366 days). `expenseId` picks
 * the fair rounding order (computeSharesFor); without it the payers absorb leftovers.
 */
export function normalizeUpsert(body: unknown, groupCurrency: string, memberIds: Iterable<string>, today: string, expenseId?: string): NormalizeResult {
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue && issue.path.length ? issue.path.join('.') : undefined;
    return bad({
      code: 'invalid_field',
      message: field ? `${field}: ${issue.message}` : 'The entry is not valid',
      field,
      issues: parsed.error.issues,
    });
  }
  const b = parsed.data;
  const known: ReadonlySet<string> = memberIds instanceof Set ? memberIds : new Set(memberIds);

  const description = b.description ?? '';
  if (b.kind === 'expense' && !description) {
    return bad({ code: 'description_required', field: 'description', message: 'An expense needs a description' });
  }

  const payers: Portion[] = b.payers.map(p => ({ memberId: p.memberId, amount: p.amount }));
  const entries: SplitEntry[] = (b.split.entries ?? []).map(e =>
    e.value === null || e.value === undefined ? { memberId: e.memberId } : { memberId: e.memberId, value: e.value },
  );

  let split: SplitInput;
  let category: string;
  if (b.kind === 'payment') {
    if (payers.length !== 1) return bad({ code: 'payment_payer', field: 'payers', message: 'A payment has exactly one sender' });
    if (b.split.method !== 'exact' || entries.length !== 1) {
      return bad({ code: 'payment_split', field: 'split', message: 'A payment goes to exactly one recipient (exact split)' });
    }
    if (entries[0].memberId === payers[0].memberId) {
      return bad({ code: 'payment_self', field: 'split', message: 'A payment cannot go to the person who sends it' });
    }
    split = { method: 'exact', entries: [entries[0]] };
    category = 'payment';
  } else {
    if (b.split.method === 'items') {
      const items: SplitItem[] = (b.split.items ?? []).map((it, i) => ({
        id: it.id || `item-${i + 1}`,
        name: it.name ?? '',
        amount: it.amount,
        memberIds: [...it.memberIds],
      }));
      split = { method: 'items', entries, items };
    } else {
      // Values mean nothing for an equal split: do not store them.
      split = { method: b.split.method, entries: b.split.method === 'equal' ? entries.map(e => ({ memberId: e.memberId })) : entries };
    }
    const cat = typeof b.category === 'string' ? b.category.trim() : '';
    // 'payment' is reserved for settle-up entries.
    category = cat && cat !== 'payment' && isCategoryKey(cat) ? cat : 'general';
  }

  for (const p of payers) {
    if (!known.has(p.memberId)) return bad({ code: 'unknown_member', field: 'payers', memberId: p.memberId, message: 'A payer is not in this group' });
  }
  const splitIds = [...split.entries.map(e => e.memberId), ...(split.items ?? []).flatMap(it => it.memberIds)];
  for (const id of splitIds) {
    if (!known.has(id)) return bad({ code: 'unknown_member', field: 'split', memberId: id, message: 'Someone in the split is not in this group' });
  }

  if (!isISODate(b.date)) return bad({ code: 'invalid_date', field: 'date', message: 'The date is not a valid YYYY-MM-DD date' });
  if (b.date < MIN_DATE || b.date > addDays(today, MAX_DAYS_AHEAD)) {
    return bad({ code: 'date_out_of_range', field: 'date', message: `The date must be between ${MIN_DATE} and a year from today` });
  }

  let fxRate = 1;
  if (b.currency !== groupCurrency) {
    const r = b.fxRate;
    if (typeof r !== 'number' || !(r > 0) || !(r < FX_RATE_MAX)) {
      return bad({ code: 'invalid_fx_rate', field: 'fxRate', message: 'An entry in another currency needs an exchange rate above 0' });
    }
    fxRate = r;
    // Balances are kept in the group currency; a converted total beyond MAX_AMOUNT would break
    // every later summary of the group, so refuse it here.
    if (convertMinor(b.amount, b.currency, fxRate, groupCurrency) > MAX_AMOUNT) {
      return bad({ code: 'invalid_fx_rate', field: 'fxRate', message: 'The converted amount is too large' });
    }
  }

  const pc = checkPayers(b.amount, payers);
  if (!pc.ok) return bad({ code: pc.code, field: 'payers', diff: pc.diff, message: PAYER_MESSAGES[pc.code] });

  const sr = expenseId ? computeSharesFor(expenseId, b.amount, split) : computeShares(b.amount, split, payers.map(p => p.memberId));
  if (!sr.ok) return bad({ code: sr.code, field: 'split', diff: sr.diff, message: SPLIT_MESSAGES[sr.code] });

  return {
    ok: true,
    entry: {
      kind: b.kind,
      description,
      category,
      amount: b.amount,
      currency: b.currency,
      fxRate,
      date: b.date,
      notes: b.notes ?? '',
      payers,
      split,
      shares: sr.shares,
      repeat: b.repeat ?? 'none',
    },
  };
}

/**
 * repeat_series / repeat_start for a write. When the entry repeats: the series is the existing one
 * (or this id for a new series); the start is kept only while both the repeat and the date stay
 * the same, else it restarts at the entry date (so moving a date never leaves a copy behind on the
 * old schedule). A non-repeating entry keeps whatever series it belongs to.
 */
export function repeatFields(
  existing: Pick<ExpenseRow, 'repeat' | 'repeat_series' | 'repeat_start' | 'date'> | null,
  id: string,
  next: { repeat: Repeat; date: string },
): { series: string | null; start: string | null } {
  if (next.repeat === 'none') return { series: existing?.repeat_series ?? null, start: existing?.repeat_start ?? null };
  const series = existing?.repeat_series || id;
  if (existing && existing.repeat === next.repeat && existing.date === next.date && existing.repeat_start) {
    return { series, start: existing.repeat_start };
  }
  return { series, start: next.date };
}

// ---------- change list for 'expense.update' (pure) ----------

/** The fields of an entry that people change, as stored. */
export interface EntryFields {
  kind: string;
  description: string;
  category: string;
  amount: number;
  currency: string;
  fxRate: number;
  date: string;
  notes: string;
  payers: Portion[];
  split: SplitInput;
  shares: Portion[];
  repeat: string;
}

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export function rowFields(r: ExpenseRow): EntryFields {
  return {
    kind: r.kind,
    description: r.description,
    category: r.category,
    amount: r.amount,
    currency: r.currency,
    fxRate: r.fx_rate,
    date: r.date,
    notes: r.notes,
    payers: parseJSON<Portion[]>(r.payers, []),
    split: parseJSON<SplitInput>(r.split, { method: 'equal', entries: [] }),
    shares: parseJSON<Portion[]>(r.shares, []),
    repeat: r.repeat || 'none',
  };
}

const moneyText = (amount: number, currency: string): string => formatMoney(amount, currency, 'en');

function people(list: readonly Portion[], currency: string, names: ReadonlyMap<string, string>, withAmounts: boolean): string {
  return list
    .map(p => {
      const name = names.get(p.memberId) ?? '?';
      return withAmounts ? `${name} ${moneyText(p.amount, currency)}` : name;
    })
    .join(', ');
}

/** The first `max` code points of `s` (never splits an emoji), with an ellipsis when cut. */
export function snippet(s: string, max = SNIPPET_MAX): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join('') + '…';
}

/** JSON with object keys sorted, so equal values always give equal strings. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

/**
 * What changed between two versions of an entry, display-ready: amounts as formatted money
 * ("¥12,600"), payers as names (with amounts when several people paid), the split as each
 * person's resulting share ("Gino ¥3,150, Abbie ¥3,150"), notes cut to 200 characters.
 * category and repeat are keys ('food.dining', 'monthly') the client labels in its language.
 * The split is listed only when the split input changed (not when a new total merely rescales it).
 */
export function expenseChanges(before: EntryFields, after: EntryFields, names: ReadonlyMap<string, string>): FieldChange[] {
  const out: FieldChange[] = [];
  const add = (field: string, from: string, to: string) => {
    if (from !== to) out.push({ field, from, to });
  };
  add('kind', before.kind, after.kind);
  add('description', before.description, after.description);
  add('amount', moneyText(before.amount, before.currency), moneyText(after.amount, after.currency));
  add('currency', before.currency, after.currency);
  add('fxRate', String(before.fxRate), String(after.fxRate));
  add('date', before.date, after.date);
  add('category', before.category, after.category);
  add(
    'payers',
    people(before.payers, before.currency, names, before.payers.length > 1),
    people(after.payers, after.currency, names, after.payers.length > 1),
  );
  if (canonical(before.split) !== canonical(after.split)) {
    add('split', people(before.shares, before.currency, names, true), people(after.shares, after.currency, names, true));
  }
  add('notes', snippet(before.notes), snippet(after.notes));
  add('repeat', before.repeat, after.repeat);
  return out;
}

// ---------- import planning (pure) ----------

export interface SkippedEntry {
  index: number;
  /** An UpsertErrorCode, or 'invalid_id', 'duplicate_id', 'limit_reached', 'exists'. */
  code: string;
  field?: string;
}

export interface ImportPlan {
  accepted: { index: number; id: string; entry: NormalizedEntry }[];
  skipped: SkippedEntry[];
}

/** Validate an import list entry by entry; `room` = how many more live entries the group can take. */
export function planImport(
  list: readonly unknown[],
  groupCurrency: string,
  memberIds: Iterable<string>,
  today: string,
  room: number,
): ImportPlan {
  const known: ReadonlySet<string> = memberIds instanceof Set ? memberIds : new Set(memberIds);
  const accepted: ImportPlan['accepted'] = [];
  const skipped: SkippedEntry[] = [];
  const seen = new Set<string>();
  list.forEach((raw, index) => {
    const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      skipped.push({ index, code: 'invalid_id', field: 'id' });
      return;
    }
    if (seen.has(id)) {
      skipped.push({ index, code: 'duplicate_id', field: 'id' });
      return;
    }
    const r = normalizeUpsert(raw, groupCurrency, known, today, id);
    if (!r.ok) {
      skipped.push(r.error.field ? { index, code: r.error.code, field: r.error.field } : { index, code: r.error.code });
      return;
    }
    if (accepted.length >= room) {
      skipped.push({ index, code: 'limit_reached' });
      return;
    }
    seen.add(id);
    accepted.push({ index, id, entry: r.entry });
  });
  return { accepted, skipped };
}

// ---------- database helpers ----------

type CommentWithAuthor = CommentRow & { author_name: string | null };

function rows<T>(r: D1Result | undefined): T[] {
  return (r?.results ?? []) as T[];
}

function countOf(r: D1Result | undefined): number {
  return Number(rows<{ n: number }>(r)[0]?.n ?? 0);
}

function commentCountStmt(db: D1Database, eid: string): D1PreparedStatement {
  return db.prepare('SELECT COUNT(*) AS n FROM comments WHERE expense_id = ? AND deleted_at IS NULL').bind(eid);
}

function memberNamesStmt(db: D1Database, gid: string): D1PreparedStatement {
  return db.prepare('SELECT id, name FROM members WHERE group_id = ?').bind(gid);
}

function liveCountStmt(db: D1Database, gid: string): D1PreparedStatement {
  return db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE group_id = ? AND deleted_at IS NULL').bind(gid);
}

const INSERT_COLUMNS = `id, group_id, kind, description, category, amount, currency, fx_rate, date, notes,
  payers, split, shares, repeat, repeat_series, repeat_start, created_by, created_at, updated_by, updated_at, version`;
const INSERT_VALUES = '?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?17, ?18, 1';

function bindEntry(
  stmt: D1PreparedStatement,
  a: { id: string; groupId: string; entry: NormalizedEntry; series: string | null; start: string | null; userId: string; now: string },
): D1PreparedStatement {
  const e = a.entry;
  return stmt.bind(
    a.id, a.groupId, e.kind, e.description, e.category, e.amount, e.currency, e.fxRate, e.date, e.notes,
    JSON.stringify(e.payers), JSON.stringify(e.split), JSON.stringify(e.shares), e.repeat, a.series, a.start, a.userId, a.now,
  );
}

/** Create, or update in place keeping created_* and deleted_*; never touches a row of another group. */
function upsertStmt(db: D1Database, a: Parameters<typeof bindEntry>[1]): D1PreparedStatement {
  return bindEntry(
    db.prepare(
      `INSERT INTO expenses (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, description = excluded.description, category = excluded.category,
         amount = excluded.amount, currency = excluded.currency, fx_rate = excluded.fx_rate, date = excluded.date,
         notes = excluded.notes, payers = excluded.payers, split = excluded.split, shares = excluded.shares,
         repeat = excluded.repeat, repeat_series = excluded.repeat_series, repeat_start = excluded.repeat_start,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at, version = expenses.version + 1
       WHERE expenses.group_id = excluded.group_id
       RETURNING *`,
    ),
    a,
  );
}

function importStmt(db: D1Database, a: Parameters<typeof bindEntry>[1]): D1PreparedStatement {
  return bindEntry(db.prepare(`INSERT OR IGNORE INTO expenses (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})`), a);
}

/**
 * A comment changes no balance, so a summary that was current for the version before the bump is
 * still current after it: move its forVersion along (guarded, so anything else is left alone and
 * gets recomputed on read as usual).
 */
function carrySummaryStmt(db: D1Database, gid: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE groups SET summary = json_set(summary, '$.forVersion', version)
       WHERE id = ? AND summary IS NOT NULL
         AND (CASE WHEN json_valid(summary) THEN json_extract(summary, '$.forVersion') END) = version - 1`,
    )
    .bind(gid);
}

function validationFail(e: UpsertError): never {
  if (e.issues) return fail(400, 'validation', e.message, e.issues);
  const details: { code: string; diff?: number; field?: string; memberId?: string } = { code: e.code };
  if (e.diff !== undefined) details.diff = e.diff;
  if (e.field !== undefined) details.field = e.field;
  if (e.memberId !== undefined) details.memberId = e.memberId;
  return fail(400, 'validation', e.message, details);
}

function toCommentDTO(r: CommentRow, authorName: string): CommentDTO {
  return {
    id: r.id,
    expenseId: r.expense_id,
    userId: r.user_id,
    memberId: r.member_id,
    authorName,
    body: r.body,
    createdAt: r.created_at,
  };
}

/** Soft delete (deleted = true) or restore; idempotent when the entry is already in that state. */
async function setDeleted(
  db: D1Database,
  group: GroupRow,
  member: MemberRow,
  userId: string,
  eid: string,
  deleted: boolean,
): Promise<{ expense: ExpenseDTO; groupVersion: number }> {
  const [eRes, cRes] = await db.batch([
    db.prepare('SELECT * FROM expenses WHERE id = ? AND group_id = ?').bind(eid, group.id),
    commentCountStmt(db, eid),
  ]);
  const row = rows<ExpenseRow>(eRes)[0];
  if (!row) fail(404, 'not_found', 'Expense not found');
  const comments = countOf(cRes);
  if (!!row.deleted_at === deleted) return { expense: toExpenseDTO(row, comments), groupVersion: group.version };

  const now = nowISO();
  const update = deleted
    ? db
        .prepare('UPDATE expenses SET deleted_at = ?, deleted_by = ?, version = version + 1 WHERE id = ? AND group_id = ? AND deleted_at IS NULL RETURNING *')
        .bind(now, userId, eid, group.id)
    : db
        .prepare('UPDATE expenses SET deleted_at = NULL, deleted_by = NULL, version = version + 1 WHERE id = ? AND group_id = ? AND deleted_at IS NOT NULL RETURNING *')
        .bind(eid, group.id);
  const res = await db.batch([
    update,
    activityStmt(db, {
      groupId: group.id,
      userId,
      memberId: member.id,
      type: deleted ? 'expense.delete' : 'expense.restore',
      expenseId: eid,
      data: entryActivityData(toExpenseDTO(row), group.currency),
      now,
    }),
    bumpVersionStmt(db, group.id, now),
  ]);
  let stored = rows<ExpenseRow>(res[0])[0];
  if (!stored) {
    // Someone else changed it at the same moment: report what is stored now.
    stored = (await db.prepare('SELECT * FROM expenses WHERE id = ? AND group_id = ?').bind(eid, group.id).first<ExpenseRow>()) ?? row;
  }
  const groupVersion = versionFromBatch(res, 2);
  await refreshSummary(db, group.id);
  return { expense: toExpenseDTO(stored, comments), groupVersion };
}

// ---------- routes ----------

// requireUser is attached per route (not with use('*')): this sub-app is mounted at /api next to
// other route modules, and a catch-all middleware here would also run for their routes.
export const expenseRoutes = new Hono<AppEnv>();

expenseRoutes.put('/groups/:gid/expenses/:eid', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  const { group, member } = await requireMember(db, gid, user.id);
  if (!ID_RE.test(eid)) fail(400, 'bad_request', 'The expense id is not valid');
  const body = await readJson(c, z.unknown());

  const [mRes, eRes, nRes] = await db.batch([
    memberNamesStmt(db, gid),
    db.prepare('SELECT * FROM expenses WHERE id = ?').bind(eid),
    liveCountStmt(db, gid),
  ]);
  const names = new Map(rows<{ id: string; name: string }>(mRes).map(m => [m.id, m.name]));
  const existing = rows<ExpenseRow>(eRes)[0] ?? null;
  if (existing && existing.group_id !== gid) fail(404, 'not_found', 'Expense not found');

  const result = normalizeUpsert(body, group.currency, new Set(names.keys()), todayUTC(), eid);
  if (!result.ok) validationFail(result.error);
  const entry = result.entry;
  if (!existing && countOf(nRes) >= MAX_LIVE_ENTRIES) {
    fail(409, 'limit_reached', `A group can hold up to ${MAX_LIVE_ENTRIES} entries`);
  }

  const now = nowISO();
  const { series, start } = repeatFields(existing, eid, entry);
  const changes = existing ? expenseChanges(rowFields(existing), entry, names) : [];
  const stmts: D1PreparedStatement[] = [upsertStmt(db, { id: eid, groupId: gid, entry, series, start, userId: user.id, now })];
  // A repeated identical save (an outbox retry after a lost response) still bumps the entry's
  // version, but adds no history line.
  if (!existing || changes.length) {
    const data: ActivityData = { ...entryActivityData(entry, group.currency) };
    if (changes.length) data.changes = changes;
    stmts.push(
      activityStmt(db, {
        groupId: gid,
        userId: user.id,
        memberId: member.id,
        type: existing ? 'expense.update' : 'expense.create',
        expenseId: eid,
        data,
        now,
      }),
    );
  }
  stmts.push(bumpVersionStmt(db, gid, now));
  const bumpAt = stmts.length - 1;
  stmts.push(commentCountStmt(db, eid));

  const res = await db.batch(stmts);
  const row = rows<ExpenseRow>(res[0])[0];
  if (!row) fail(404, 'not_found', 'Expense not found');
  const groupVersion = versionFromBatch(res, bumpAt);
  await refreshSummary(db, gid);
  const out: UpsertExpenseRes = { expense: toExpenseDTO(row, countOf(res[res.length - 1])), groupVersion };
  return json(c, out);
});

expenseRoutes.delete('/groups/:gid/expenses/:eid', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const { group, member } = await requireMember(db, c.req.param('gid'), user.id);
  return json(c, await setDeleted(db, group, member, user.id, c.req.param('eid'), true));
});

expenseRoutes.post('/groups/:gid/expenses/:eid/restore', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const { group, member } = await requireMember(db, c.req.param('gid'), user.id);
  return json(c, await setDeleted(db, group, member, user.id, c.req.param('eid'), false));
});

expenseRoutes.get('/groups/:gid/expenses/:eid/history', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  await requireMember(db, gid, user.id);
  const [eRes, hRes] = await db.batch([
    db.prepare('SELECT id FROM expenses WHERE id = ? AND group_id = ?').bind(eid, gid),
    db.prepare(activitySelect('a.group_id = ? AND a.expense_id = ?', 'ORDER BY a.created_at, a.rowid LIMIT 1000')).bind(gid, eid),
  ]);
  if (!rows(eRes).length) fail(404, 'not_found', 'Expense not found');
  return json(c, { items: rows<ActivityJoinedRow>(hRes).map(r => toActivityDTO(r)) });
});

expenseRoutes.get('/groups/:gid/expenses/:eid/comments', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  await requireMember(db, gid, user.id);
  const [eRes, cRes] = await db.batch([
    db.prepare('SELECT id FROM expenses WHERE id = ? AND group_id = ?').bind(eid, gid),
    db
      .prepare(
        `SELECT c.*, COALESCE(m.name, u.name) AS author_name
         FROM comments c
         LEFT JOIN members m ON m.id = c.member_id
         LEFT JOIN users u ON u.id = c.user_id
         WHERE c.group_id = ? AND c.expense_id = ? AND c.deleted_at IS NULL
         ORDER BY c.created_at, c.rowid
         LIMIT 1000`,
      )
      .bind(gid, eid),
  ]);
  if (!rows(eRes).length) fail(404, 'not_found', 'Expense not found');
  const comments: CommentDTO[] = rows<CommentWithAuthor>(cRes).map(r => toCommentDTO(r, r.author_name ?? '?'));
  return json(c, { comments });
});

const commentSchema = z.object({
  id: z.string().regex(ID_RE, 'Not a valid id').nullish(),
  body: z.string().trim().min(1).max(COMMENT_MAX),
});

expenseRoutes.post('/groups/:gid/expenses/:eid/comments', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  const { group, member } = await requireMember(db, gid, user.id);
  const input = await readJson(c, commentSchema);
  const id = input.id ?? newId();

  const [eRes, pRes] = await db.batch([
    db.prepare('SELECT * FROM expenses WHERE id = ? AND group_id = ?').bind(eid, gid),
    db.prepare('SELECT * FROM comments WHERE id = ?').bind(id),
  ]);
  const expense = rows<ExpenseRow>(eRes)[0];
  if (!expense) fail(404, 'not_found', 'Expense not found');
  const prior = rows<CommentRow>(pRes)[0];
  if (prior) {
    // The same comment sent again (an outbox retry): answer as if it were new, write nothing.
    if (prior.group_id !== gid || prior.expense_id !== eid || prior.user_id !== user.id) {
      fail(409, 'conflict', 'That comment id is already in use');
    }
    return json(c, { comment: toCommentDTO(prior, member.name), groupVersion: group.version });
  }

  const now = nowISO();
  const e = toExpenseDTO(expense);
  const res = await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO comments (id, group_id, expense_id, user_id, member_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, gid, eid, user.id, member.id, input.body, now),
    activityStmt(db, {
      groupId: gid,
      userId: user.id,
      memberId: member.id,
      type: 'comment.add',
      expenseId: eid,
      data: { comment: snippet(input.body), description: e.description, kind: e.kind, amount: e.amount, currency: e.currency },
      now,
    }),
    bumpVersionStmt(db, gid, now),
    carrySummaryStmt(db, gid),
  ]);
  const comment: CommentDTO = {
    id,
    expenseId: eid,
    userId: user.id,
    memberId: member.id,
    authorName: member.name,
    body: input.body,
    createdAt: now,
  };
  return json(c, { comment, groupVersion: versionFromBatch(res, 2) });
});

expenseRoutes.delete('/groups/:gid/comments/:cid', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const gid = c.req.param('gid');
  const cid = c.req.param('cid');
  const { group } = await requireMember(db, gid, user.id);
  const cm = await db.prepare('SELECT * FROM comments WHERE id = ? AND group_id = ?').bind(cid, gid).first<CommentRow>();
  if (!cm) fail(404, 'not_found', 'Comment not found');
  if (cm.user_id !== user.id) fail(403, 'forbidden', 'Only the person who wrote a comment can delete it');
  if (cm.deleted_at) return json(c, { ok: true, groupVersion: group.version });
  const now = nowISO();
  const res = await db.batch([
    db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(now, cid),
    bumpVersionStmt(db, gid, now),
    carrySummaryStmt(db, gid),
  ]);
  return json(c, { ok: true, groupVersion: versionFromBatch(res, 1) });
});

const importSchema = z.object({ expenses: z.array(z.unknown()).max(MAX_IMPORT) });

expenseRoutes.post('/groups/:gid/import', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const gid = c.req.param('gid');
  const { group, member } = await requireMember(db, gid, user.id);
  const input = await readJson(c, importSchema);

  const [mRes, nRes] = await db.batch([memberNamesStmt(db, gid), liveCountStmt(db, gid)]);
  const memberIds = new Set(rows<{ id: string }>(mRes).map(m => m.id));
  const room = Math.max(0, MAX_LIVE_ENTRIES - countOf(nRes));
  const plan = planImport(input.expenses, group.currency, memberIds, todayUTC(), room);

  const now = nowISO();
  const skipped = [...plan.skipped];
  let imported = 0;
  let groupVersion = group.version;
  try {
    for (let i = 0; i < plan.accepted.length; i += IMPORT_CHUNK) {
      const chunk = plan.accepted.slice(i, i + IMPORT_CHUNK);
      const res = await db.batch(
        chunk.map(a => {
          const { series, start } = repeatFields(null, a.id, a.entry);
          return importStmt(db, { id: a.id, groupId: gid, entry: a.entry, series, start, userId: user.id, now });
        }),
      );
      res.forEach((r, k) => {
        if ((r.meta?.changes ?? 0) > 0) imported++;
        else skipped.push({ index: chunk[k].index, code: 'exists', field: 'id' });
      });
    }
  } finally {
    // Also after a failed chunk: whatever went in must reach clients (version) and the feed.
    if (imported > 0) {
      const res = await db.batch([
        activityStmt(db, {
          groupId: gid,
          userId: user.id,
          memberId: member.id,
          type: 'group.update',
          expenseId: null,
          data: { groupName: group.name, changes: [{ field: 'import', from: '', to: String(imported) }] },
          now,
        }),
        bumpVersionStmt(db, gid, now),
      ]);
      groupVersion = versionFromBatch(res, 1);
      await refreshSummary(db, gid);
    }
  }
  skipped.sort((a, b) => a.index - b.index);
  return json(c, { imported, skipped, groupVersion });
});
