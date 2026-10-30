// Expenses and payments (create or edit, delete, restore), their comments and history, and the
// bulk import. Mounted by index.ts under /api; every route needs a signed-in active member.
//
// The money rules live in src/shared: the server recomputes shares with computeSharesFor()
// (rounding leftovers follow a fair, stable order from the expense id) and checks payers with
// checkPayers(); shares sent by a client are ignored. Saving an entry again with the same amount
// and split keeps its stored shares (keepStoredShares).
//
// Saves can arrive late (an outbox replay, an editor left open), so a PUT also handles:
// - a rate chosen against an older group currency (`rateBase`): converted like the stored entries
//   were when the currency changed (groupBaseBody);
// - an edit made from an older copy of the entry: with `base` (the entry as the client last saw
//   it) only the parts the client changed are written, and a part someone else changed too is a
//   409 conflict (mergeEdit); without `base`, a save from an older version that someone else
//   wrote is refused when it would change the entry (legacyConflict).
// A refund (kind 'refund', docs/SPEC.md section 2, Refunds) is saved like an expense. A client that
// does not know refunds sees one as its expense (compat.ts) and saves it that way: such a save is
// merged in that view, then turned back into a refund (legacyFields, backToRefund).
// The pure helpers are exported for tests/worker/expense-validation.test.ts.

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
  splitParticipants,
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
import { activityView, expenseView, knowsRefunds, legacyRoles } from '../compat';
import {
  bumpVersionStmt,
  parseJSON,
  RECEIPT_COLUMNS,
  requireMember,
  toExpenseDTO,
  unarchiveStmt,
  versionFromBatch,
  type CommentRow,
  type ExpenseRow,
  type GroupRow,
  type MemberRow,
  type ReceiptColumns,
} from '../db';
import type { AppEnv } from '../env';
import { fail, json, newId, nowISO, readJson } from '../http';
import { activitySelect, activityStmt, entryActivityData, toActivityDTO, type ActivityJoinedRow } from '../services/activity';
import { getUsdRates, rateToBase } from '../services/fx';
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

const CURRENCY_RE = /^[A-Z]{3}$/;
const currencySchema = z.string().regex(CURRENCY_RE, 'Use a 3-letter currency code');
const memberIdSchema = z.string().min(1).max(64);
const methodSchema = z.custom<SplitMethod>(
  v => typeof v === 'string' && (SPLIT_METHODS as readonly string[]).includes(v),
  'Unknown split method',
);
const repeatSchema = z.custom<Repeat>(v => typeof v === 'string' && (REPEATS as readonly string[]).includes(v), 'Unknown repeat');

/**
 * UpsertExpenseReq. Amounts are safe integers (minor units) and other numbers finite; the money
 * rules themselves (sums, positive shares) are checked by computeShares / checkPayers so their
 * error codes reach the client. Unknown keys (baseVersion, base, id, shares...) are dropped;
 * optional text fields also accept null. `refundOf` is read by the PUT route (refundOfFor), not here.
 */
export const upsertSchema = z.object({
  kind: z.enum(['expense', 'payment', 'refund']),
  description: z.string().trim().max(DESCRIPTION_MAX).nullish(),
  /** Any value: a known category key is kept, everything else becomes 'general'. */
  category: z.unknown().optional(),
  amount: z.number().int().min(1).max(MAX_AMOUNT),
  currency: currencySchema,
  fxRate: z.number().finite().nullish(),
  /**
   * The group currency `fxRate` was chosen against (the one the client saw). The PUT and import
   * routes convert a rate for an older group currency first (groupBaseBody); normalizeUpsert
   * refuses one that was not converted. `baseCurrency` is accepted as another name for it.
   */
  rateBase: currencySchema.nullish(),
  baseCurrency: currencySchema.nullish(),
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
  if (b.kind !== 'payment' && !description) {
    return bad({ code: 'description_required', field: 'description', message: b.kind === 'refund' ? 'A refund needs a description' : 'An expense needs a description' });
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
    // An expense or a refund: the same split and category rules (a refund's payers are who got
    // the money back, its split whose money it is).
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
    // A rate for another group currency must be converted first (groupBaseBody), never stored as is.
    const said = b.rateBase ?? b.baseCurrency;
    if (said && said !== groupCurrency) {
      return bad({ code: 'invalid_fx_rate', field: 'rateBase', message: `The exchange rate is for ${said}, not for the group currency ${groupCurrency}` });
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
      // Money coming back once: a refund never repeats.
      repeat: b.kind === 'refund' ? 'none' : b.repeat ?? 'none',
    },
  };
}

// ---------- refunds saved by clients that do not know them (pure) ----------

/** Whether two versions of an entry have the same money (kind, amount, currency, rate, payers, split). */
export function sameMoney(a: EntryFields, b: EntryFields): boolean {
  return partKey(a, 'money') === partKey(b, 'money');
}

/** A stored refund as a client without refunds sees it (compat.ts legacyExpense), as EntryFields. */
export function legacyFields(f: EntryFields): EntryFields {
  return { ...f, kind: 'expense', ...legacyRoles(f) };
}

/**
 * Whether a save of the stored refund `real` was made in the legacy view: always from a client that
 * does not know refunds (unless it sends a refund itself), and from one that does when it saves an
 * expense whose base (or, without one, the save itself) has the legacy view's money. An edit queued
 * by the iPhone app before an update taught it refunds goes out later with the new header.
 */
export function savedInLegacyView(real: EntryFields, refunds: boolean, mine: EntryFields, base: EntryFields | null): boolean {
  if (real.kind !== 'refund' || mine.kind === 'refund') return false;
  if (!refunds) return true;
  return mine.kind === 'expense' && sameMoney(base ?? mine, legacyFields(real));
}

/**
 * A save merged in the legacy view, as the refund to store. Money as the legacy view shows it
 * keeps the stored refund's own (its split as it was made); changed money is read back the other
 * way round: the people the expense is split among got the money back (the refund's payers, with
 * their shares), and its payers are whose money it was (an exact split). A payment stays a payment.
 * The result goes through normalizeUpsert again.
 */
export function backToRefund(merged: EntryFields, real: EntryFields): EntryFields {
  if (merged.kind !== 'expense') return merged;
  if (sameMoney(merged, legacyFields(real))) {
    return {
      ...merged, kind: 'refund', amount: real.amount, currency: real.currency, fxRate: real.fxRate,
      payers: real.payers, split: real.split, shares: real.shares, repeat: 'none',
    };
  }
  return {
    ...merged,
    kind: 'refund',
    payers: merged.shares.map(s => ({ memberId: s.memberId, amount: s.amount })),
    split: { method: 'exact', entries: merged.payers.map(p => ({ memberId: p.memberId, value: p.amount })) },
    shares: merged.payers.map(p => ({ memberId: p.memberId, amount: p.amount })),
    repeat: 'none',
  };
}

/**
 * refund_of to store (ExpenseDTO.refundOf). Only a refund has one. `sent` is the save's refundOf:
 * undefined when the save leaves it out (an older client, or the legacy view), which keeps
 * `stored`; an id is kept when `target` (that entry in this group, or null) is an expense other
 * than this one; anything else is null. Never refused: the link only joins two pages.
 */
export function refundOfFor(kind: string, sent: unknown, stored: string | null, target: { id: string; kind: string } | null, id: string): string | null {
  if (kind !== 'refund') return null;
  if (sent === undefined) return stored;
  if (typeof sent !== 'string' || !target || target.id !== sent || target.id === id || target.kind !== 'expense') return null;
  return sent;
}

// ---------- rates chosen against an older group currency (pure) ----------
//
// fxRate means "1 unit of the entry currency in the group currency". When someone changes the
// group currency, PATCH /groups re-bases every stored entry (routes/groups.ts rebaseStmt), but a
// save made before the change can arrive after it: an outbox entry replayed on reconnect, or an
// editor that was open across the change. Its rate still means the old group currency, so it is
// converted the same way the stored entries were.

/** A change of the group currency, as logged in the group's history (oldest first). */
export interface CurrencySwitch {
  from: string;
  to: string;
  /** Value of 1 `from` in `to` that the stored entries were re-based with (when any needed it). */
  rate?: number;
}

/** The currency changes in these 'group.update' activity data strings (JSON), oldest first. */
export function parseCurrencyHistory(datas: readonly string[]): CurrencySwitch[] {
  const out: CurrencySwitch[] = [];
  for (const d of datas) {
    const data = parseJSON<unknown>(d, null);
    const changes = data && typeof data === 'object' ? (data as { changes?: unknown }).changes : null;
    if (!Array.isArray(changes)) continue;
    for (const ch of changes) {
      if (!ch || typeof ch !== 'object') continue;
      const { field, from, to, rate } = ch as Record<string, unknown>;
      if (field !== 'currency' || typeof from !== 'string' || typeof to !== 'string') continue;
      if (!CURRENCY_RE.test(from) || !CURRENCY_RE.test(to) || from === to) continue;
      out.push(typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? { from, to, rate } : { from, to });
    }
  }
  return out;
}

/** The group currency a body says its rate is for (rateBase, or baseCurrency), if any. */
function declaredBase(b: Record<string, unknown>): string | null {
  if (typeof b.rateBase === 'string') return b.rateBase;
  if (typeof b.baseCurrency === 'string') return b.baseCurrency;
  return null;
}

export type RateBaseClaim =
  | { kind: 'current' }
  /** The body says its rate is for this older group currency. */
  | { kind: 'stale'; base: string }
  /**
   * No rateBase (an app from before it, or a save queued in its outbox) and a rate of exactly 1
   * for a currency other than the group's: the editor sends 1 only for the group currency, so if
   * the group used this currency before, the body was made back then.
   */
  | { kind: 'legacy'; currency: string };

/**
 * Whether a body's rate may be meant for another group currency. Bodies in the group currency
 * never are (their rate is always 1), and malformed ones are left to normalizeUpsert.
 */
export function rateBaseClaim(raw: unknown, groupCurrency: string): RateBaseClaim {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'current' };
  const b = raw as Record<string, unknown>;
  if (typeof b.currency !== 'string' || !CURRENCY_RE.test(b.currency) || b.currency === groupCurrency) return { kind: 'current' };
  const said = declaredBase(b);
  if (said !== null) return CURRENCY_RE.test(said) && said !== groupCurrency ? { kind: 'stale', base: said } : { kind: 'current' };
  return b.fxRate === 1 ? { kind: 'legacy', currency: b.currency } : { kind: 'current' };
}

/**
 * The currency changes that took the group from `from` to `to`: the last time it left `from`,
 * then every later change. Null when the history shows no such path.
 */
export function switchesSince(history: readonly CurrencySwitch[], from: string, to: string): CurrencySwitch[] | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].from !== from) continue;
    const path = history.slice(i);
    for (let j = 1; j < path.length; j++) if (path[j].from !== path[j - 1].to) return null;
    return path[path.length - 1].to === to ? path : null;
  }
  return null;
}

/**
 * The fxRate of an entry in `currency` at `fxRate` (against the first step's `from`) after the
 * group went through `steps`, computed exactly like rebaseStmt in routes/groups.ts: 1 once the
 * entry is in the group currency, the step's rate while it is in the old one, else rate x step
 * rate at 10 significant digits. `rateOf` gives a rate for a step that did not log one; null when
 * a rate is missing.
 */
export function rebasedRate(
  currency: string,
  fxRate: number,
  steps: readonly CurrencySwitch[],
  rateOf: (from: string, to: string) => number | null,
): number | null {
  let r = fxRate;
  for (const s of steps) {
    if (currency === s.to) {
      r = 1;
      continue;
    }
    const k = s.rate ?? rateOf(s.from, s.to);
    if (k === null || !Number.isFinite(k) || k <= 0) return null;
    r = currency === s.from ? k : Number((r * k).toPrecision(10));
  }
  return r;
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

/** canonical() of each value, sorted: for lists whose order means nothing. */
function sortedKeys(list: readonly unknown[]): string[] {
  return list.map(canonical).sort();
}

/** Payers or shares compared as a set: the order they are listed in changes nothing. */
function portionsKey(list: readonly Portion[]): string {
  return JSON.stringify(sortedKeys(list.map(p => [p.memberId, p.amount])));
}

/**
 * A split compared by meaning: entry order (the editor lists "me" first), item ids and the
 * values of an equal split change nothing (shares follow a fair order from the expense id, not
 * from the list order).
 */
export function splitKey(s: SplitInput): string {
  const entries = (s.entries ?? []).map(e => [e.memberId, s.method === 'equal' ? null : e.value ?? null]);
  const items = s.method === 'items' ? (s.items ?? []).map(it => [it.name ?? '', it.amount, [...(it.memberIds ?? [])].sort()]) : [];
  return JSON.stringify([s.method, sortedKeys(entries), sortedKeys(items)]);
}

/**
 * What changed between two versions of an entry, display-ready: amounts as formatted money
 * ("¥12,600"), payers as names (with amounts when several people paid), the split as each
 * person's resulting share ("Gino ¥3,150, Abbie ¥3,150"), notes cut to 200 characters.
 * category and repeat are keys ('food.dining', 'monthly') the client labels in its language.
 * Payers and the split are compared without regard to order. The split is listed when the split
 * input changed, or when the shares moved while the amount stayed (not when a new total merely
 * rescales them), so no balance change goes unlisted.
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
  if (portionsKey(before.payers) !== portionsKey(after.payers)) {
    add(
      'payers',
      people(before.payers, before.currency, names, before.payers.length > 1),
      people(after.payers, after.currency, names, after.payers.length > 1),
    );
  }
  const splitChanged = splitKey(before.split) !== splitKey(after.split);
  const sharesMoved = before.amount === after.amount && before.currency === after.currency && portionsKey(before.shares) !== portionsKey(after.shares);
  if (splitChanged || sharesMoved) {
    add('split', people(before.shares, before.currency, names, true), people(after.shares, after.currency, names, true));
  }
  add('notes', snippet(before.notes), snippet(after.notes));
  add('repeat', before.repeat, after.repeat);
  return out;
}

// ---------- saves made from an older copy of the entry (pure) ----------

/**
 * The parts of an entry a save is merged by. The money is one part: the payers and the split
 * must add up to the amount, and the rate belongs to the currency.
 */
export const EDIT_PARTS = ['money', 'description', 'category', 'date', 'notes', 'repeat'] as const;
export type EditPart = (typeof EDIT_PARTS)[number];

function partKey(e: EntryFields, part: EditPart): string {
  switch (part) {
    case 'money':
      return JSON.stringify([e.kind, e.amount, e.currency, e.fxRate, portionsKey(e.payers), splitKey(e.split)]);
    case 'description':
      return e.description;
    case 'category':
      return e.category;
    case 'date':
      return e.date;
    case 'notes':
      return e.notes;
    case 'repeat':
      return e.repeat;
  }
}

function copyPart(to: EntryFields, from: EntryFields, part: EditPart): void {
  switch (part) {
    case 'money':
      to.kind = from.kind;
      to.amount = from.amount;
      to.currency = from.currency;
      to.fxRate = from.fxRate;
      to.payers = from.payers;
      to.split = from.split;
      to.shares = from.shares;
      return;
    case 'description':
      to.description = from.description;
      return;
    case 'category':
      to.category = from.category;
      return;
    case 'date':
      to.date = from.date;
      return;
    case 'notes':
      to.notes = from.notes;
      return;
    case 'repeat':
      to.repeat = from.repeat;
      return;
  }
}

/** The parts in which two versions of an entry differ. */
export function changedParts(a: EntryFields, b: EntryFields): EditPart[] {
  return EDIT_PARTS.filter(p => partKey(a, p) !== partKey(b, p));
}

export interface EditMerge {
  /** What to store: each part from my save when I changed it (mine differs from base), else as stored. */
  merged: EntryFields;
  /** Parts that someone else changed after `base` too, to something other than what I saved. */
  conflicts: EditPart[];
}

/**
 * A three-way merge of an edit: `base` is the entry as I last saw it, `mine` what I saved, and
 * `stored` what the server holds now. A retry of a save that already went in finds nothing to
 * change and no conflict.
 */
export function mergeEdit(stored: EntryFields, base: EntryFields, mine: EntryFields): EditMerge {
  const merged: EntryFields = { ...stored };
  const conflicts: EditPart[] = [];
  for (const part of EDIT_PARTS) {
    const b = partKey(base, part);
    const m = partKey(mine, part);
    if (m === b) continue;
    const s = partKey(stored, part);
    if (s !== b && s !== m) conflicts.push(part);
    copyPart(merged, mine, part);
  }
  return { merged, conflicts };
}

/**
 * A save that carries no `base` (only baseVersion, as apps from before `base` send it, read from
 * their view at save time): it was made from an older version, and the last change to the entry
 * was someone else's. The caller refuses it only when it would change the entry. Saves by the
 * same person (an undo right after an edit, a second save before the first one was confirmed)
 * and saves whose baseVersion counts local unsynced edits (it is then ahead) go through.
 */
export function legacyConflict(stored: Pick<ExpenseRow, 'version' | 'updated_by'>, baseVersion: unknown, userId: string): boolean {
  return typeof baseVersion === 'number' && Number.isSafeInteger(baseVersion) && baseVersion < stored.version && stored.updated_by !== userId;
}

/**
 * The shares to store for `next`: the stored ones when the entry keeps its kind, amount,
 * currency and split, so saving again never moves a rounding unit (also for rows whose leftovers
 * were placed by an older rule, such as recurring copies made with their head's shares, or rows
 * from before the fair order). They must still be a rounding of that split that computeShares
 * could give: the same total, and each person's share between what they get when they are
 * ranked last and when they are ranked first for the leftovers.
 */
export function keepStoredShares(stored: Pick<EntryFields, 'kind' | 'amount' | 'currency' | 'split' | 'shares'>, next: NormalizedEntry): Portion[] {
  if (stored.kind !== next.kind || stored.amount !== next.amount || stored.currency !== next.currency) return next.shares;
  if (splitKey(stored.split) !== splitKey(next.split)) return next.shares;
  const mine = new Map<string, number>();
  let sum = 0;
  for (const s of stored.shares) {
    if (!s || typeof s.memberId !== 'string' || mine.has(s.memberId) || !Number.isSafeInteger(s.amount) || s.amount <= 0) return next.shares;
    mine.set(s.memberId, s.amount);
    sum += s.amount;
  }
  if (sum !== next.amount) return next.shares;
  const ids = splitParticipants(next.split);
  if ([...mine.keys()].some(id => !ids.includes(id))) return next.shares;
  for (const id of ids) {
    const rest = ids.filter(x => x !== id);
    const high = computeShares(next.amount, next.split, [id, ...rest]);
    const low = computeShares(next.amount, next.split, [...rest, id]);
    if (!high.ok || !low.ok) return next.shares;
    const of = (list: readonly Portion[]) => list.find(p => p.memberId === id)?.amount ?? 0;
    const s = mine.get(id) ?? 0;
    if (s < of(low.shares) || s > of(high.shares)) return next.shares;
  }
  return stored.shares.map(s => ({ memberId: s.memberId, amount: s.amount }));
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

/** One entry with its receipt photos' metadata (ReceiptColumns), checked to be in group `gid`. */
function entryStmt(db: D1Database, eid: string, gid: string): D1PreparedStatement {
  return db.prepare(`SELECT e.*, ${RECEIPT_COLUMNS} FROM expenses e LEFT JOIN receipts r ON r.expense_id = e.id WHERE e.id = ? AND e.group_id = ?`).bind(eid, gid);
}

/**
 * The receipt columns of `r`: an UPDATE ... RETURNING * row has none, and none of these writes
 * changes the photos, so the answer takes them (every photo) from the row read before.
 */
function receiptOf(r: ReceiptColumns): ReceiptColumns {
  return { r_version: r.r_version, r_mime: r.r_mime, r_width: r.r_width, r_height: r.r_height, r_bytes: r.r_bytes, r_extras: r.r_extras };
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
  payers, split, shares, repeat, repeat_series, repeat_start, created_by, created_at, updated_by, updated_at, version, refund_of`;
const INSERT_VALUES = '?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?17, ?18, 1, ?19';

function bindEntry(
  stmt: D1PreparedStatement,
  a: {
    id: string; groupId: string; entry: NormalizedEntry; series: string | null; start: string | null; userId: string; now: string;
    /** refund_of (refundOfFor); null for everything but a refund started from an expense. */
    refundOf: string | null;
  },
): D1PreparedStatement {
  const e = a.entry;
  return stmt.bind(
    a.id, a.groupId, e.kind, e.description, e.category, e.amount, e.currency, e.fxRate, e.date, e.notes,
    JSON.stringify(e.payers), JSON.stringify(e.split), JSON.stringify(e.shares), e.repeat, a.series, a.start, a.userId, a.now,
    a.refundOf,
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
         updated_by = excluded.updated_by, updated_at = excluded.updated_at, version = expenses.version + 1,
         refund_of = excluded.refund_of
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
 * A comment (or a receipt photo, routes/receiptPhotos.ts) changes no balance, so a summary that
 * was current for the version before the bump is still current after it: move its forVersion along
 * (guarded, so anything else is left alone and gets recomputed on read as usual).
 */
export function carrySummaryStmt(db: D1Database, gid: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE groups SET summary = json_set(summary, '$.forVersion', version)
       WHERE id = ? AND summary IS NOT NULL
         AND (CASE WHEN json_valid(summary) THEN json_extract(summary, '$.forVersion') END) = version - 1`,
    )
    .bind(gid);
}

/** The group's currency changes, oldest first (from its 'group.update' activity). */
async function loadCurrencyHistory(db: D1Database, gid: string): Promise<CurrencySwitch[]> {
  const r = await db
    .prepare(`SELECT data FROM activity WHERE group_id = ? AND type = 'group.update' AND data LIKE ? ORDER BY created_at, rowid`)
    .bind(gid, '%"field":"currency"%')
    .all<{ data: string }>();
  return parseCurrencyHistory((r.results ?? []).map(x => x.data));
}

/** The group's currency history and today's rates, each read at most once per request, only when needed. */
interface RateLookup {
  history(): Promise<CurrencySwitch[]>;
  usd(): Promise<Record<string, number>>;
}

function rateLookup(db: D1Database, gid: string): RateLookup {
  let history: Promise<CurrencySwitch[]> | undefined;
  let usd: Promise<Record<string, number>> | undefined;
  return {
    history: () => (history ??= loadCurrencyHistory(db, gid)),
    usd: () => (usd ??= getUsdRates(db, todayUTC()).then(r => r.rates)),
  };
}

/**
 * A save (any JSON value) with its exchange rate moved onto the current group currency when it
 * was chosen against an older one (rateBaseClaim): converted through the currency changes since
 * then with the rates they used (rebasedRate), falling back to today's rate for a change that did
 * not log one. Every other body comes back as it is, for normalizeUpsert to validate.
 */
async function groupBaseBody(raw: unknown, groupCurrency: string, rates: RateLookup): Promise<{ body: unknown } | { error: UpsertError }> {
  const claim = rateBaseClaim(raw, groupCurrency);
  if (claim.kind === 'current') return { body: raw };
  const history = await rates.history();
  let base: string;
  if (claim.kind === 'stale') base = claim.base;
  else if (history.some(s => s.from === claim.currency)) base = claim.currency;
  else return { body: raw };

  const b = raw as Record<string, unknown>;
  const currency = b.currency as string;
  const sent = b.fxRate;
  // A rate for a third currency must be usable to convert; else normalizeUpsert explains why not.
  if (currency !== base && !(typeof sent === 'number' && Number.isFinite(sent) && sent > 0 && sent < FX_RATE_MAX)) return { body: raw };
  const steps = switchesSince(history, base, groupCurrency) ?? [{ from: base, to: groupCurrency }];
  const usd = steps.some(s => s.rate === undefined && s.to !== currency) ? await rates.usd() : null;
  const r = rebasedRate(currency, currency === base ? 1 : (sent as number), steps, (f, t) => (usd ? rateToBase(usd, f, t) : null));
  if (r === null) {
    return { error: { code: 'invalid_fx_rate', field: 'fxRate', message: `There is no exchange rate from ${base} to ${groupCurrency} to convert this entry` } };
  }
  return { body: { ...b, fxRate: r, rateBase: groupCurrency, baseCurrency: null } };
}

/**
 * The `base` of a save (the entry as the client last saw it), for mergeEdit. Its rate is for the
 * same group currency as the save's (rateBase) unless it says otherwise.
 */
function editBaseOf(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const base = body.base;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return null;
  const b = base as Record<string, unknown>;
  const said = declaredBase(body);
  return declaredBase(b) === null && said !== null ? { ...b, rateBase: said } : b;
}

function baseVersionOf(raw: unknown): unknown {
  return raw && typeof raw === 'object' ? (raw as { baseVersion?: unknown }).baseVersion : undefined;
}

/** EntryFields of a stored row as normalizeUpsert would produce them (rate 1 in the group currency). */
function storedFields(r: ExpenseRow, groupCurrency: string): EntryFields {
  const f = rowFields(r);
  return r.currency === groupCurrency ? { ...f, fxRate: 1 } : f;
}

/** An entry as an upsert body (to validate a merged entry again). */
function bodyOf(e: EntryFields): Record<string, unknown> {
  return {
    kind: e.kind, description: e.description, category: e.category, amount: e.amount, currency: e.currency, fxRate: e.fxRate,
    date: e.date, notes: e.notes, payers: e.payers, split: e.split, repeat: e.repeat,
  };
}

/**
 * 409: someone else changed these parts after the client's copy; details carry the entry as stored
 * now, as this client sees it (`refunds`, compat.ts).
 */
function editConflict(row: ExpenseRow & ReceiptColumns, comments: number, fields: readonly EditPart[], refunds: boolean): never {
  return fail(409, 'conflict', 'Someone else changed this entry after you opened it. Discard this change, then edit the entry again.', {
    code: 'edited_elsewhere',
    fields,
    expense: expenseView(toExpenseDTO(row, comments), refunds),
  });
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

/**
 * Soft delete (deleted = true) or restore; idempotent when the entry is already in that state. The
 * answer shows the entry as this client sees it (`refunds`, compat.ts).
 */
async function setDeleted(
  db: D1Database,
  group: GroupRow,
  member: MemberRow,
  userId: string,
  eid: string,
  deleted: boolean,
  refunds: boolean,
): Promise<{ expense: ExpenseDTO; groupVersion: number }> {
  const [eRes, cRes] = await db.batch([entryStmt(db, eid, group.id), commentCountStmt(db, eid)]);
  const row = rows<ExpenseRow & ReceiptColumns>(eRes)[0];
  if (!row) fail(404, 'not_found', 'Expense not found');
  const comments = countOf(cRes);
  if (!!row.deleted_at === deleted) return { expense: expenseView(toExpenseDTO(row, comments), refunds), groupVersion: group.version };

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
    // A restored entry is back in everyone's balances: the group comes back for those who
    // archived it (not for the person restoring it).
    ...(deleted ? [] : [unarchiveStmt(db, group.id, member.id)]),
  ]);
  let stored: ExpenseRow & ReceiptColumns = rows<ExpenseRow>(res[0])[0];
  if (stored) {
    // Deleting keeps the photos (the daily job removes them a day later, services/receiptPhotos.ts),
    // so 復原 within that day brings every one back.
    stored = { ...stored, ...receiptOf(row) };
  } else {
    // Someone else changed it at the same moment: report what is stored now.
    stored = (await entryStmt(db, eid, group.id).first<ExpenseRow & ReceiptColumns>()) ?? row;
  }
  const groupVersion = versionFromBatch(res, 2);
  await refreshSummary(db, group.id);
  return { expense: expenseView(toExpenseDTO(stored, comments), refunds), groupVersion };
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
  // Whether this client knows refunds (compat.ts): what it gets back, and how its save is read.
  const refunds = knowsRefunds(c);
  // The expense a refund says it refunds (refundOfFor), looked up with the rest.
  const sentRefundOf = body && typeof body === 'object' && !Array.isArray(body) ? (body as { refundOf?: unknown }).refundOf : undefined;
  const lookUpRefundOf = typeof sentRefundOf === 'string' && ID_RE.test(sentRefundOf) && sentRefundOf !== eid;

  const [mRes, eRes, nRes, cRes, tRes] = await db.batch([
    memberNamesStmt(db, gid),
    db.prepare(`SELECT e.*, ${RECEIPT_COLUMNS} FROM expenses e LEFT JOIN receipts r ON r.expense_id = e.id WHERE e.id = ?`).bind(eid),
    liveCountStmt(db, gid),
    commentCountStmt(db, eid),
    ...(lookUpRefundOf ? [db.prepare('SELECT id, kind FROM expenses WHERE id = ? AND group_id = ?').bind(sentRefundOf, gid)] : []),
  ]);
  const names = new Map(rows<{ id: string; name: string }>(mRes).map(m => [m.id, m.name]));
  const memberIds = new Set(names.keys());
  const existing = rows<ExpenseRow & ReceiptColumns>(eRes)[0] ?? null;
  if (existing && existing.group_id !== gid) fail(404, 'not_found', 'Expense not found');

  const today = todayUTC();
  const rates = rateLookup(db, gid);
  const normalize = async (raw: unknown): Promise<NormalizeResult> => {
    const g = await groupBaseBody(raw, group.currency, rates);
    return 'error' in g ? { ok: false, error: g.error } : normalizeUpsert(g.body, group.currency, memberIds, today, eid);
  };
  const result = await normalize(body);
  if (!result.ok) validationFail(result.error);
  let entry = result.entry;
  if (!existing && countOf(nRes) >= MAX_LIVE_ENTRIES) {
    fail(409, 'limit_reached', `A group can hold up to ${MAX_LIVE_ENTRIES} entries`);
  }

  if (existing) {
    const real = storedFields(existing, group.currency);
    const baseRaw = editBaseOf(body);
    const base = baseRaw ? await normalize(baseRaw) : null;
    // A refund saved in the legacy view (compat.ts) is merged in that view, then made a refund again.
    const legacy = savedInLegacyView(real, refunds, entry, base?.ok ? base.entry : null);
    const stored = legacy ? legacyFields(real) : real;
    if (base?.ok) {
      // Write only what this save changed since the client's copy; a part someone else changed too is a conflict.
      const m = mergeEdit(stored, base.entry, entry);
      if (m.conflicts.length) editConflict(existing, countOf(cRes), m.conflicts, refunds);
      const merged = normalizeUpsert(bodyOf(m.merged), group.currency, memberIds, today, eid);
      if (!merged.ok) editConflict(existing, countOf(cRes), changedParts(base.entry, entry), refunds);
      entry = merged.entry;
    } else {
      if (base) console.warn(`PUT expense ${eid}: ignoring a base that is not valid (${base.error.code})`);
      if (legacyConflict(existing, baseVersionOf(body), user.id)) {
        const parts = changedParts(stored, entry);
        if (parts.length) editConflict(existing, countOf(cRes), parts, refunds);
      }
    }
    if (legacy) {
      const back = normalizeUpsert(bodyOf(backToRefund(entry, real)), group.currency, memberIds, today, eid);
      if (!back.ok) validationFail(back.error);
      entry = back.entry;
    }
    entry = { ...entry, shares: keepStoredShares(rowFields(existing), entry) };
  }

  const target = lookUpRefundOf ? rows<{ id: string; kind: string }>(tRes)[0] ?? null : null;
  const refundOf = refundOfFor(entry.kind, sentRefundOf, existing?.refund_of ?? null, target, eid);
  const now = nowISO();
  const { series, start } = repeatFields(existing, eid, entry);
  const changes = existing ? expenseChanges(rowFields(existing), entry, names) : [];
  const stmts: D1PreparedStatement[] = [upsertStmt(db, { id: eid, groupId: gid, entry, series, start, userId: user.id, now, refundOf })];
  // A repeated identical save (an outbox retry after a lost response) still bumps the entry's
  // version, but adds no history line.
  if (!existing || changes.length) {
    const data: ActivityData = { ...entryActivityData({ ...entry, id: eid }, group.currency) };
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
  // A new entry by someone else can be a new debt: the group comes back on the lists of everyone
  // who archived it, except the author (docs/SPEC.md section 4, Archive). Edits do not.
  if (!existing) stmts.push(unarchiveStmt(db, gid, member.id));
  stmts.push(commentCountStmt(db, eid));

  const res = await db.batch(stmts);
  const row = rows<ExpenseRow>(res[0])[0];
  if (!row) fail(404, 'not_found', 'Expense not found');
  const groupVersion = versionFromBatch(res, bumpAt);
  await refreshSummary(db, gid);
  // A save never changes the photos: the answer has the ones read with the entry.
  const saved = toExpenseDTO(existing ? { ...row, ...receiptOf(existing) } : row, countOf(res[res.length - 1]));
  const out: UpsertExpenseRes = { expense: expenseView(saved, refunds), groupVersion };
  return json(c, out);
});

expenseRoutes.delete('/groups/:gid/expenses/:eid', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const { group, member } = await requireMember(db, c.req.param('gid'), user.id);
  return json(c, await setDeleted(db, group, member, user.id, c.req.param('eid'), true, knowsRefunds(c)));
});

expenseRoutes.post('/groups/:gid/expenses/:eid/restore', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const { group, member } = await requireMember(db, c.req.param('gid'), user.id);
  return json(c, await setDeleted(db, group, member, user.id, c.req.param('eid'), false, knowsRefunds(c)));
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
  const refunds = knowsRefunds(c);
  return json(c, { items: rows<ActivityJoinedRow>(hRes).map(r => activityView(toActivityDTO(r), refunds)) });
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
  // Rates chosen against an older group currency are converted first, like a single save; an
  // entry that cannot be converted is skipped as invalid_fx_rate.
  const rates = rateLookup(db, gid);
  const list = await Promise.all(
    input.expenses.map(async raw => {
      const g = await groupBaseBody(raw, group.currency, rates);
      return 'error' in g ? { ...(raw as Record<string, unknown>), fxRate: null, rateBase: group.currency, baseCurrency: null } : g.body;
    }),
  );
  const plan = planImport(list, group.currency, memberIds, todayUTC(), room);

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
          // An imported refund links to nothing (refundOf is a link made by 記一筆退款).
          return importStmt(db, { id: a.id, groupId: gid, entry: a.entry, series, start, userId: user.id, now, refundOf: null });
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
        unarchiveStmt(db, gid, member.id),
      ]);
      groupVersion = versionFromBatch(res, 1);
      await refreshSummary(db, gid);
    }
  }
  skipped.sort((a, b) => a.index - b.index);
  return json(c, { imported, skipped, groupVersion });
});
