// Splitwise CSV import, and the rows of our own CSV export. Pure TypeScript: no React, no
// browser APIs, so it runs (and is tested) in Node.
//
// A Splitwise "Export as spreadsheet" file (from a group or a friend) looks like this:
//
//   Date,Description,Category,Cost,Currency,Gino Chang,Abbie Lin
//
//   2026-09-01,Groceries,Groceries,45.00,USD,22.50,-22.50
//   2026-09-03,"Dinner, with wine",Dining out,120.00,USD,-60.00,60.00
//   2026-09-05,Gino C. paid Abbie W.,Payment,37.50,USD,37.50,-37.50
//
//   2026-10-16,Total balance, , ,USD,0.00,0.00
//
// Every person column holds that row's effect on the person's balance: positive when they paid
// (or sent a payment), negative when they owe (or received one). Splitwise writes 2 decimals in
// every currency, so amounts are read as hundredths first and then rounded to the currency's own
// minor units (TWD and JPY have none) one entry at a time with the largest-remainder rule of
// shared/alloc, so every entry still adds up exactly and every share is its exact value rounded
// down or up. Which people get the units left over in a row also counts how far earlier rows
// already rounded each of them, so everyone's total stays close to Splitwise's Total balance.
// Ties are broken by the person's column, never by member id: the preview (which uses
// placeholder ids for people not added yet) rounds exactly like the import.

import { fairOrder, rankIndexes } from '../../../shared/alloc';
import { convertMinor, entryNet, netBalances, toBase, type LedgerEntry } from '../../../shared/balances';
import { detectCategory } from '../../../shared/categories';
import { getCurrency } from '../../../shared/currencies';
import { addDays, isISODate } from '../../../shared/dates';
import { MAX_AMOUNT, parseAmount } from '../../../shared/money';
import { computeSharesFor, type Portion } from '../../../shared/split';
import type { ExpenseDTO, MemberDTO, UpsertExpenseReq } from '../../../shared/types';

// ---------- CSV text ----------

/** One CSV record and the (1-based) line of the file where it starts. */
export interface CsvRecord {
  line: number;
  cells: string[];
}

/** The delimiter of the first non-empty line: comma, semicolon or tab, whichever is most common. */
export function detectDelimiter(text: string): string {
  const first = text.split(/\r\n|\n|\r/).find(l => l.trim() !== '') ?? '';
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    let n = 0;
    let quoted = false;
    for (const ch of first) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) n++;
    }
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/**
 * RFC 4180 CSV: quoted fields may hold the delimiter, line breaks and doubled quotes ("").
 * Lenient where files in the wild are sloppy: a quote inside an unquoted field is kept as a
 * character, and text after a closing quote is kept too. A leading byte order mark is dropped.
 */
export function parseCsvRecords(text: string, delimiter = ','): CsvRecord[] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let fieldHasQuote = false;
  let line = 1;
  let start = 1;
  const endField = () => {
    cells.push(field);
    field = '';
    fieldHasQuote = false;
  };
  const endRecord = () => {
    endField();
    out.push({ line: start, cells });
    cells = [];
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n' || (ch === '\r' && s[i + 1] !== '\n')) line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '' && !fieldHasQuote) {
      quoted = true;
      fieldHasQuote = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      endRecord();
      line++;
      start = line;
    } else {
      field += ch;
    }
  }
  if (field !== '' || fieldHasQuote || cells.length > 0) endRecord();
  return out;
}

// ---------- reading a Splitwise export ----------

export interface SplitwiseRow {
  /** Line in the file where the row starts (for messages). */
  line: number;
  /** 'YYYY-MM-DD', or null when the date cell is not a date. */
  date: string | null;
  rawDate: string;
  description: string;
  /** The Splitwise category name as written ("Dining out", "Payment"). */
  category: string;
  /** The Cost cell as written. */
  costText: string;
  /** Cost in hundredths, or null when it is not a number. */
  cost: number | null;
  /** Upper-cased currency cell. */
  currency: string;
  /** One value per person column, in hundredths (an empty cell is 0); null when not a number. */
  nets: (number | null)[];
  /** The raw person cells, for a stable id. */
  netTexts: string[];
  isPayment: boolean;
}

export interface SplitwiseTotal {
  currency: string;
  /** Hundredths per person column. */
  nets: number[];
}

export interface SplitwiseFile {
  /** Person column names, in file order. */
  people: string[];
  rows: SplitwiseRow[];
  /** The "Total balance" rows (one per currency). */
  totals: SplitwiseTotal[];
}

export type SplitwiseParseError = 'empty' | 'not_splitwise' | 'no_people';

const FIXED = ['date', 'description', 'category', 'cost', 'currency'] as const;

/** The Unicode minus sign, which some spreadsheets write instead of a hyphen. */
const MINUS_SIGN = String.fromCharCode(0x2212);

function norm(s: string): string {
  return s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** "12.50", "-12.50", "1,234.56", "(12.50)" or "" (= 0) to hundredths; null when not a number. */
export function parseCents(raw: string): number | null {
  let s = raw.split(MINUS_SIGN).join('-').trim();
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  if (!/^[0-9.,\s]+$/.test(s) || !/\d/.test(s)) return null;
  const v = parseAmount(s, 'USD');
  if (v === null) return null;
  return neg && v !== 0 ? -v : v;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "2026-09-01" (also with a time, or with / or . separators) or US "9/1/2026"; null otherwise. */
export function parseSplitwiseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  let iso: string | null = null;
  if (m) iso = `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
  else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: .*)?$/.exec(s);
    if (m) iso = `${m[3]}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`;
  }
  return iso && isISODate(iso) ? iso : null;
}

/** Read a Splitwise group or friend export. */
export function parseSplitwiseCsv(text: string): { ok: true; file: SplitwiseFile } | { ok: false; error: SplitwiseParseError } {
  const records = parseCsvRecords(text, detectDelimiter(text)).filter(r => r.cells.some(c => c.trim() !== ''));
  if (records.length === 0) return { ok: false, error: 'empty' };
  const header = records[0].cells.map(c => c.trim());
  const named = header.map(norm);

  // Columns by name when the header is in English, else by position (Date, Description,
  // Category, Cost, Currency come first in every Splitwise export).
  const byName = FIXED.map(k => named.indexOf(k));
  const englishHeader = byName.every(i => i >= 0);
  const fixed = englishHeader ? byName : [0, 1, 2, 3, 4];
  const [dateCol, descCol, catCol, costCol, curCol] = fixed;
  const headerKey = header.join('\u0000');
  const data = records.slice(1).filter(r => r.cells.map(c => c.trim()).join('\u0000') !== headerKey);

  if (!englishHeader) {
    // No English header: accept the file only if it looks like Splitwise's layout.
    const coded = data.filter(r => /^[A-Za-z]{3}$/.test((r.cells[curCol] ?? '').trim())).length;
    if (data.length === 0 || coded * 2 < data.length) return { ok: false, error: 'not_splitwise' };
  }

  const width = Math.max(header.length, ...data.map(r => r.cells.length));
  const personCols: number[] = [];
  for (let c = 0; c < width; c++) {
    if (fixed.includes(c)) continue;
    const name = header[c] ?? '';
    const used = data.some(r => (r.cells[c] ?? '').trim() !== '');
    if (name || used) personCols.push(c);
  }
  if (personCols.length === 0) return { ok: false, error: 'no_people' };
  const people = personCols.map((c, i) => header[c] || `#${i + 1}`);

  const rows: SplitwiseRow[] = [];
  const totals: SplitwiseTotal[] = [];
  for (const r of data) {
    const cell = (c: number) => (r.cells[c] ?? '').trim();
    const description = cell(descCol);
    const currency = cell(curCol).toUpperCase();
    const netTexts = personCols.map(cell);
    const nets = netTexts.map(parseCents);
    if (norm(description) === 'total balance') {
      totals.push({ currency, nets: nets.map(v => v ?? 0) });
      continue;
    }
    const category = cell(catCol);
    const costText = cell(costCol);
    rows.push({
      line: r.line,
      date: parseSplitwiseDate(cell(dateCol)),
      rawDate: cell(dateCol),
      description,
      category,
      costText,
      cost: costText ? parseCents(costText) : null,
      currency,
      nets,
      netTexts,
      isPayment: norm(category) === 'payment',
    });
  }
  return { ok: true, file: { people, rows, totals } };
}

// ---------- categories ----------

/** Splitwise category names (lower case) to ours. "General" and "Other" are left to detection. */
const SPLITWISE_CATEGORIES: Readonly<Record<string, string>> = {
  'dining out': 'food.dining',
  'groceries': 'food.groceries',
  'liquor': 'food.liquor',
  'food and drink': 'food.other',
  'games': 'entertainment.games',
  'movies': 'entertainment.movies',
  'music': 'entertainment.music',
  'sports': 'entertainment.sports',
  'entertainment': 'entertainment.other',
  'electronics': 'home.electronics',
  'furniture': 'home.furniture',
  'household supplies': 'home.supplies',
  'maintenance': 'home.maintenance',
  'mortgage': 'home.mortgage',
  'pets': 'home.pets',
  'rent': 'home.rent',
  'services': 'home.services',
  'home': 'home.other',
  'childcare': 'life.childcare',
  'clothing': 'life.clothing',
  'education': 'life.education',
  'gifts': 'life.gifts',
  'insurance': 'life.insurance',
  'medical expenses': 'life.medical',
  'medical': 'life.medical',
  'taxes': 'life.taxes',
  'life': 'life.other',
  'bicycle': 'transport.bicycle',
  'bus/train': 'transport.train',
  'car': 'transport.car',
  'gas/fuel': 'transport.gas',
  'hotel': 'travel.hotel',
  'parking': 'transport.parking',
  'plane': 'transport.plane',
  'taxi': 'transport.taxi',
  'transportation': 'transport.other',
  'cleaning': 'utilities.cleaning',
  'electricity': 'utilities.electricity',
  'heat/gas': 'utilities.gas',
  'trash': 'utilities.trash',
  'tv/phone/internet': 'utilities.internet',
  'water': 'utilities.water',
  'utilities': 'utilities.other',
};

/** Our category for a Splitwise category name, else one detected from the description, else general. */
export function mapSplitwiseCategory(name: string, description: string): string {
  const k = norm(name);
  const direct = SPLITWISE_CATEGORIES[k];
  if (direct) return direct;
  // "Food and drink - Dining out" or "Home > Rent" style: try the last part.
  const parts = k.split(/\s+[->:]\s+/);
  const last = parts.length > 1 ? SPLITWISE_CATEGORIES[parts[parts.length - 1]] : undefined;
  if (last) return last;
  return detectCategory(description) ?? 'general';
}

// ---------- matching people to members ----------

export interface MemberLike {
  id: string;
  name: string;
  active: boolean;
}

/**
 * A member id for each person column, or null for "add as a new member". A column takes a member
 * whose name matches exactly (case and spacing ignored), or `me` when it matches one of my
 * names, or else the one member that shares the first name ("Gino Chang" and "Gino").
 * Each member is suggested for one column at most.
 */
export function suggestMembers(
  people: readonly string[],
  members: readonly MemberLike[],
  me?: { memberId: string; names: readonly string[] },
): (string | null)[] {
  const taken = new Set<string>();
  const out: (string | null)[] = people.map(() => null);
  const ordered = [...members].sort((a, b) => Number(b.active) - Number(a.active));
  const myNames = new Set((me?.names ?? []).map(norm).filter(Boolean));

  people.forEach((p, i) => {
    const n = norm(p);
    const hit = ordered.find(m => !taken.has(m.id) && norm(m.name) === n);
    if (hit) {
      out[i] = hit.id;
      taken.add(hit.id);
    }
  });
  if (me) {
    people.forEach((p, i) => {
      if (out[i] === null && !taken.has(me.memberId) && myNames.has(norm(p))) {
        out[i] = me.memberId;
        taken.add(me.memberId);
      }
    });
  }
  const first = (s: string) => norm(s).split(' ')[0] ?? '';
  people.forEach((p, i) => {
    if (out[i] !== null) return;
    const f = first(p);
    if (!f) return;
    const cands = ordered.filter(m => !taken.has(m.id) && first(m.name) === f);
    if (cands.length === 1) {
      out[i] = cands[0].id;
      taken.add(cands[0].id);
    }
  });
  return out;
}

// ---------- building the import ----------

export type SplitwiseSkipReason =
  | 'bad_date'
  | 'date_range'
  | 'bad_amount'
  | 'bad_currency'
  | 'no_rate'
  | 'no_change'
  | 'unbalanced'
  | 'payment_shape'
  | 'too_large'
  | 'too_many_people';

export interface SkippedRow {
  line: number;
  date: string;
  description: string;
  reason: SplitwiseSkipReason;
}

export type ImportEntry = UpsertExpenseReq & { id: string };

export interface ImportOptions {
  /** The group the entries go to (part of every entry id, so another group never collides). */
  groupId: string;
  groupCurrency: string;
  /** One member id per person column; columns given the same id are merged into that member. */
  memberIds: readonly string[];
  /** 1 unit of a foreign currency = rate units of the group currency. */
  rates?: Readonly<Record<string, number>>;
  /** Splitwise currency -> the currency those rows really were in (fixes "$" that was yen). */
  relabel?: Readonly<Record<string, string>>;
  /** Today, 'YYYY-MM-DD' (dates may run up to a year ahead, like the server allows). */
  today: string;
  /** Description for an expense that has none. */
  fallbackDescription?: string;
  /** Note on entries rebuilt from balances (several people paid): the original Cost. */
  costNote?: (cost: string, currency: string) => string;
}

export interface ImportPlan {
  entries: ImportEntry[];
  skipped: SkippedRow[];
  expenseCount: number;
  paymentCount: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Net effect per member id in the group currency once imported (positive = gets back). */
  netByMember: Record<string, number>;
  /** Spending (expenses only) in the group currency. */
  spent: number;
  /** Entries whose amounts had cents the currency does not use, rounded to whole units. */
  rounded: number;
  /**
   * Splitwise's own "Total balance" per member id, in group-currency minor units, when every
   * total row is in the group currency (so the two can be compared); otherwise null.
   */
  expected: Record<string, number> | null;
}

const MIN_DATE = '2000-01-01';
const MAX_DAYS_AHEAD = 366;
const LIST_MAX = 50;
const DESCRIPTION_MAX = 120;
const FX_RATE_MAX = 1e9;

/** Hundredths to the currency's minor units, rounding half away from zero. */
export function centsToMinor(cents: number, currency: string): number {
  const d = getCurrency(currency).decimals;
  if (d >= 2) return cents * 10 ** (d - 2);
  const div = 10 ** (2 - d);
  const abs = Math.floor((Math.abs(cents) + div / 2) / div);
  return cents < 0 && abs !== 0 ? -abs : abs;
}

function hasLostCents(cents: number, currency: string): boolean {
  const d = getCurrency(currency).decimals;
  return d < 2 && cents % 10 ** (2 - d) !== 0;
}

/** 128-bit non-cryptographic hash (cyrb128), as four unsigned 32-bit words. */
function hash128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function rowSignature(row: SplitwiseRow): string {
  return [row.rawDate, row.description, row.category, row.costText, row.currency, ...row.netTexts].join('\u001f');
}

/**
 * A UUID-shaped id that depends only on the group and the row's own text (plus how many
 * identical rows came before it), so importing the same file twice adds nothing new: the
 * server skips ids it already has.
 */
export function importId(groupId: string, row: SplitwiseRow, occurrence: number): string {
  const hex = hash128(`evenly:splitwise:${groupId}:${occurrence}:${rowSignature(row)}`)
    .map(h => h.toString(16).padStart(8, '0'))
    .join('');
  const variant = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function cleanDescription(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  const cps = Array.from(one);
  return cps.length > DESCRIPTION_MAX ? cps.slice(0, DESCRIPTION_MAX).join('').trim() : one;
}

/**
 * Split `total` (> 0, minor units) over parts in proportion to their positive weights
 * (hundredths). Each part gets its exact share rounded down, or one unit more, and the parts add
 * up to exactly `total` (largest remainder, as in shared/alloc). Of the parts whose share is not
 * whole, the units left over go to the highest `want(i, floor)` first (`floor` is part i's share
 * rounded down), then in `tie` order (indexes of `parts`), then by index.
 */
function allocateBy(total: number, parts: readonly Portion[], want: (i: number, floor: number) => number, tie: readonly number[]): Portion[] {
  const T = BigInt(total);
  let W = 0n;
  for (const p of parts) W += BigInt(p.amount);
  const out: number[] = [];
  const open: number[] = [];
  let left = total;
  parts.forEach((p, i) => {
    const exact = T * BigInt(p.amount);
    out.push(Number(exact / W));
    left -= out[i];
    if (exact % W !== 0n) open.push(i);
  });
  const rank = new Map<number, number>();
  tie.forEach((idx, k) => { if (!rank.has(idx)) rank.set(idx, k); });
  const score = new Map(open.map(i => [i, want(i, out[i])]));
  open.sort((a, b) =>
    score.get(b)! - score.get(a)! ||
    (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ||
    a - b,
  );
  for (let k = 0; k < open.length && left > 0; k++, left--) out[open[k]] += 1;
  return parts.map((p, i) => ({ memberId: p.memberId, amount: out[i] })).filter(p => p.amount !== 0);
}

/**
 * The unit rounding is measured in: hundredths for currencies with up to 2 decimals (what
 * Splitwise writes), else the currency's own minor units. `perMinor` and `perCent` are how many
 * of them one minor unit and one hundredth are.
 */
function fineUnits(currency: string): { perMinor: number; perCent: number } {
  const d = getCurrency(currency).decimals;
  return d <= 2 ? { perMinor: 10 ** (2 - d), perCent: 1 } : { perMinor: 1, perCent: 10 ** (d - 2) };
}

/**
 * Turn the rows of a Splitwise export into entries for POST /groups/:gid/import.
 * - Payments: the person with the positive amount sent it to the one with the negative amount.
 * - An expense with one positive person: that person paid the whole Cost; their share is Cost
 *   minus their amount, and each negative person's share is what they owe (an exact split).
 * - Several positive people: each paid their positive amount and each negative person owes
 *   theirs, so the total is the sum of the positive amounts; the original Cost goes in the notes.
 * Rows that cannot be imported are listed in `skipped` with the reason.
 */
export function buildImport(file: SplitwiseFile, opts: ImportOptions): ImportPlan {
  const entries: ImportEntry[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Map<string, number>();
  const maxDate = addDays(opts.today, MAX_DAYS_AHEAD);
  const ledger: LedgerEntry[] = [];
  const costNote = opts.costNote ?? ((c: string, cur: string) => `Splitwise cost: ${c} ${cur}`);
  let rounded = 0;
  let expenseCount = 0;
  let paymentCount = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  const columnMember = (i: number) => opts.memberIds[i] || `new:${i}`;
  // Rounding ties are broken by each member's first column, never by the member id itself, so
  // the preview (placeholder ids for people not added yet) and the import (their real ids, known
  // only once they are added) round every row the same way.
  const slotOf = new Map<string, string>();
  file.people.forEach((_, i) => {
    const m = columnMember(i);
    if (!slotOf.has(m)) slotOf.set(m, `col:${i}`);
  });
  const slot = (m: string) => slotOf.get(m) ?? m;
  // Per currency: how far rounding has moved each member's balance away from Splitwise's own
  // numbers in the rows so far (fineUnits; positive = more in their favor than in Splitwise).
  const drift = new Map<string, Map<string, number>>();

  for (const row of file.rows) {
    const sig = rowSignature(row);
    const occurrence = seen.get(sig) ?? 0;
    seen.set(sig, occurrence + 1);
    const skip = (reason: SplitwiseSkipReason) =>
      skipped.push({ line: row.line, date: row.date ?? row.rawDate, description: row.description, reason });

    const date = row.date;
    if (!date) { skip('bad_date'); continue; }
    if (date < MIN_DATE || date > maxDate) { skip('date_range'); continue; }
    if (!/^[A-Z]{3}$/.test(row.currency)) { skip('bad_currency'); continue; }
    if (row.nets.some(v => v === null) || (row.costText !== '' && row.cost === null)) { skip('bad_amount'); continue; }

    const currency = opts.relabel?.[row.currency] || row.currency;
    if (!/^[A-Z]{3}$/.test(currency)) { skip('bad_currency'); continue; }
    let fxRate = 1;
    if (currency !== opts.groupCurrency) {
      const r = opts.rates?.[currency];
      if (typeof r !== 'number' || !(r > 0) || !(r < FX_RATE_MAX)) { skip('no_rate'); continue; }
      fxRate = r;
    }

    // Each member's amount in hundredths (merged columns add up).
    const net = new Map<string, number>();
    row.nets.forEach((v, i) => {
      if (!v) return;
      const m = columnMember(i);
      net.set(m, (net.get(m) ?? 0) + v);
    });
    const pos: Portion[] = [];
    const neg: Portion[] = [];
    let sum = 0;
    let nonZero = 0;
    for (const [memberId, v] of net) {
      sum += v;
      if (v > 0) pos.push({ memberId, amount: v });
      else if (v < 0) neg.push({ memberId, amount: -v });
      if (v !== 0) nonZero++;
    }
    if (nonZero === 0) { skip('no_change'); continue; }
    if (pos.length === 0 || neg.length === 0 || Math.abs(sum) > nonZero) { skip('unbalanced'); continue; }
    if (pos.length > LIST_MAX || neg.length + 1 > LIST_MAX) { skip('too_many_people'); continue; }

    const id = importId(opts.groupId, row, occurrence);
    const cost = row.cost ?? 0;
    let req: UpsertExpenseReq;
    let lost = hasLostCents(cost, currency) || row.nets.some(v => v !== null && hasLostCents(v, currency));

    const { perMinor, perCent } = fineUnits(currency);
    const moved = drift.get(currency) ?? new Map<string, number>();
    const movedOf = (m: string) => moved.get(m) ?? 0;
    const fair = (parts: readonly Portion[]) => {
      const slots = parts.map(p => slot(p.memberId));
      return rankIndexes(slots, fairOrder(id, slots));
    };
    // Who owes one unit more: whoever rounding has favored most so far, counting how much of a
    // unit rounding their share down would give them in this row (and `bonus`: what rounding
    // the cost already gave the payer). Rounding down and up both stay within one unit.
    const owe = (total: number, parts: readonly Portion[], bonus?: { memberId: string; fine: number }) =>
      allocateBy(
        total,
        parts,
        (i, floor) =>
          movedOf(parts[i].memberId) + parts[i].amount * perCent - floor * perMinor + (bonus?.memberId === parts[i].memberId ? bonus.fine : 0),
        fair(parts),
      );
    // Who paid one unit more: whoever rounding has favored least so far.
    const pay = (total: number, parts: readonly Portion[]) =>
      allocateBy(total, parts, (i, floor) => parts[i].amount * perCent - floor * perMinor - movedOf(parts[i].memberId), fair(parts));

    if (row.isPayment) {
      if (pos.length !== 1 || neg.length !== 1) { skip('payment_shape'); continue; }
      const amount = centsToMinor(pos[0].amount, currency);
      if (amount <= 0) { skip('bad_amount'); continue; }
      req = {
        kind: 'payment',
        description: '',
        category: 'payment',
        amount,
        currency,
        fxRate,
        date,
        notes: '',
        payers: [{ memberId: pos[0].memberId, amount }],
        split: { method: 'exact', entries: [{ memberId: neg[0].memberId, value: amount }] },
      };
    } else {
      const description = cleanDescription(row.description) || cleanDescription(opts.fallbackDescription ?? '') || 'Splitwise';
      const category = mapSplitwiseCategory(row.category, row.description);
      const payerOwn = pos.length === 1 ? cost - pos[0].amount : -1;
      let amount: number;
      let payers: Portion[];
      let shares: Portion[];
      let notes = '';
      if (pos.length === 1 && cost > 0 && payerOwn >= 0) {
        // One person paid the whole bill.
        amount = centsToMinor(cost, currency);
        const weights: Portion[] = [];
        if (payerOwn > 0) weights.push({ memberId: pos[0].memberId, amount: payerOwn });
        weights.push(...neg);
        payers = [{ memberId: pos[0].memberId, amount }];
        shares = amount > 0 ? owe(amount, weights, { memberId: pos[0].memberId, fine: amount * perMinor - cost * perCent }) : [];
      } else {
        // Several people paid (or the Cost does not fit): rebuild the entry from the balances.
        const paidTotal = pos.reduce((a, p) => a + p.amount, 0);
        amount = centsToMinor(paidTotal, currency);
        payers = amount > 0 ? pay(amount, pos) : [];
        shares = amount > 0 ? owe(amount, neg) : [];
        notes = costNote(row.costText || '0', row.currency);
        lost = lost || hasLostCents(paidTotal, currency);
      }
      if (amount <= 0 || shares.length === 0) { skip('bad_amount'); continue; }
      req = {
        kind: 'expense',
        description,
        category,
        amount,
        currency,
        fxRate,
        date,
        notes,
        payers,
        split: { method: 'exact', entries: shares.map(s => ({ memberId: s.memberId, value: s.amount })) },
      };
    }

    if (req.amount > MAX_AMOUNT || convertMinor(req.amount, currency, fxRate, opts.groupCurrency) > MAX_AMOUNT) {
      skip('too_large');
      continue;
    }
    const sr = computeSharesFor(id, req.amount, req.split);
    if (!sr.ok) { skip('bad_amount'); continue; }

    if (lost) rounded++;
    if (req.kind === 'payment') paymentCount++;
    else expenseCount++;
    if (!firstDate || date < firstDate) firstDate = date;
    if (!lastDate || date > lastDate) lastDate = date;
    entries.push({ id, ...req });
    ledger.push({ id, kind: req.kind, amount: req.amount, currency, fxRate, payers: req.payers, shares: sr.shares, category: req.category, date });

    // How far this entry moved each balance from the row's own numbers, for the rows after it.
    const add = (m: string, v: number) => moved.set(m, movedOf(m) + v);
    for (const p of req.payers) add(p.memberId, p.amount * perMinor);
    for (const s of sr.shares) add(s.memberId, -s.amount * perMinor);
    for (const [m, v] of net) add(m, -v * perCent);
    drift.set(currency, moved);
  }

  const memberOrder = [...new Set(file.people.map((_, i) => columnMember(i)))];
  const netByMember = netBalances(ledger, opts.groupCurrency, memberOrder);
  let spent = 0;
  for (const e of ledger) if (e.kind === 'expense') spent += toBase(e, opts.groupCurrency).total;

  let expected: Record<string, number> | null = null;
  if (file.totals.length > 0 && file.totals.every(t => (opts.relabel?.[t.currency] || t.currency) === opts.groupCurrency)) {
    const cents: Record<string, number> = {};
    for (const m of memberOrder) cents[m] = 0;
    for (const t of file.totals) t.nets.forEach((v, i) => { cents[columnMember(i)] += v; });
    expected = {};
    for (const m of memberOrder) expected[m] = centsToMinor(cents[m], opts.groupCurrency);
  }

  return { entries, skipped, expenseCount, paymentCount, firstDate, lastDate, netByMember, spent, rounded, expected };
}

/** A plan's money with every member id replaced by the member's first column. */
function planShape(file: SplitwiseFile, plan: ImportPlan, memberIds: readonly string[]): string {
  const col = new Map<string, number>();
  file.people.forEach((_, i) => {
    const m = memberIds[i] || `new:${i}`;
    if (!col.has(m)) col.set(m, i);
  });
  const c = (m: string) => col.get(m) ?? m;
  return JSON.stringify({
    entries: plan.entries.map(e => [
      e.id,
      e.kind,
      e.amount,
      e.currency,
      e.fxRate,
      e.payers.map(p => [c(p.memberId), p.amount]),
      e.split.entries.map(x => [c(x.memberId), x.value]),
    ]),
    nets: [...col].map(([m, i]) => [i, plan.netByMember[m] ?? 0]),
    spent: plan.spent,
    skipped: plan.skipped.length,
  });
}

/**
 * True when two plans of the same file import the same entries and give every column the same
 * balance. Each was built with its own member ids: the preview with placeholders ('' or 'new:i')
 * for people still to be added, the import with the ids they got. Entries in another currency are
 * converted with ties broken by member id when balances are shown, so adding people can still move
 * a unit there; the import shows the new numbers again before it goes ahead.
 */
export function samePreview(file: SplitwiseFile, a: ImportPlan, aIds: readonly string[], b: ImportPlan, bIds: readonly string[]): boolean {
  return planShape(file, a, aIds) === planShape(file, b, bIds);
}

// ---------- sending the import ----------

/**
 * Bytes per import request. The Worker turns away bodies over 256 KB with 413 payload_too_large
 * (MAX_BODY_BYTES in src/worker/http.ts), and one entry per person per row adds up fast in a big
 * group, so requests are cut by size, with room to spare.
 */
export const IMPORT_BATCH_BYTES = 200 * 1024;
/** Entries per request (the Worker takes 500; store.importExpenses sends 200 at a time). */
export const IMPORT_BATCH_ENTRIES = 200;

/** Length in bytes of a string sent as UTF-8 (what Content-Length counts). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Entries cut into requests, in order: each body (`{"expenses":[...]}` as JSON) stays within
 * `maxBytes`, and holds at most `maxEntries`. An entry bigger than `maxBytes` on its own goes alone.
 */
export function importBatches<T>(entries: readonly T[], maxBytes = IMPORT_BATCH_BYTES, maxEntries = IMPORT_BATCH_ENTRIES): T[][] {
  const wrapper = utf8Bytes(JSON.stringify({ expenses: [] }));
  const out: T[][] = [];
  let cur: T[] = [];
  let size = wrapper;
  for (const e of entries) {
    const bytes = utf8Bytes(JSON.stringify(e));
    if (cur.length > 0 && (cur.length >= maxEntries || size + 1 + bytes > maxBytes)) {
      out.push(cur);
      cur = [];
      size = wrapper;
    }
    size += (cur.length > 0 ? 1 : 0) + bytes;
    cur.push(e);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Send entries in importBatches() order with `send` (which returns how many were new) and return
 * the total. A batch the server still finds too large (`tooLarge(error)`) is split in half and
 * sent again; that is safe because entry ids are fixed and the server skips ids it already has.
 * Any other error stops the import: whatever went in stays, and running it again adds only the rest.
 */
export async function importInBatches<T>(
  entries: readonly T[],
  send: (batch: T[]) => Promise<number>,
  tooLarge: (error: unknown) => boolean,
  onProgress?: (imported: number) => void,
  maxBytes = IMPORT_BATCH_BYTES,
): Promise<number> {
  let imported = 0;
  const run = async (batch: T[]): Promise<void> => {
    let n: number;
    try {
      n = await send(batch);
    } catch (e) {
      if (batch.length < 2 || !tooLarge(e)) throw e;
      const half = Math.ceil(batch.length / 2);
      await run(batch.slice(0, half));
      await run(batch.slice(half));
      return;
    }
    imported += n;
    onProgress?.(imported);
  };
  for (const batch of importBatches(entries, maxBytes)) await run(batch);
  return imported;
}

/** Currencies (after relabeling) other than the group currency, with how many rows use each. */
export function foreignCurrencies(
  file: SplitwiseFile,
  groupCurrency: string,
  relabel?: Readonly<Record<string, string>>,
): { currency: string; rows: number }[] {
  const count = new Map<string, number>();
  for (const r of file.rows) {
    if (!/^[A-Z]{3}$/.test(r.currency)) continue;
    const c = relabel?.[r.currency] || r.currency;
    if (c !== groupCurrency) count.set(c, (count.get(c) ?? 0) + 1);
  }
  return [...count]
    .map(([currency, rows]) => ({ currency, rows }))
    .sort((a, b) => b.rows - a.rows || (a.currency < b.currency ? -1 : 1));
}

/** Every currency the file uses (before relabeling), most used first. */
export function fileCurrencies(file: SplitwiseFile): string[] {
  const count = new Map<string, number>();
  for (const r of file.rows) if (/^[A-Z]{3}$/.test(r.currency)) count.set(r.currency, (count.get(r.currency) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([c]) => c);
}

// ---------- our own CSV export ----------

export interface ExportLabels {
  date: string;
  description: string;
  category: string;
  kind: string;
  amount: string;
  currency: string;
  fxRate: string;
  baseAmount: string;
  paidBy: string;
  expense: string;
  payment: string;
  /** Description of the last row (each member's balance). */
  total: string;
  categoryLabel: (key: string) => string;
  /** "Leo 付給 Gino" / "Leo paid Gino". */
  paymentDescription: (from: string, to: string) => string;
  /** Between payer names: "、" or ", ". */
  separator: string;
  /** Name for a member id that is not in the group any more. */
  unknownMember: string;
}

/** A plain decimal ("1250.50", "-333", "0.00") in the currency's own decimals, for spreadsheets. */
export function decimalString(minor: number, currency: string): string {
  const d = getCurrency(currency).decimals;
  const neg = minor < 0;
  const abs = String(Math.abs(minor));
  if (d === 0) return (neg ? '-' : '') + abs;
  const s = abs.padStart(d + 1, '0');
  return (neg ? '-' : '') + s.slice(0, s.length - d) + '.' + s.slice(s.length - d);
}

/** A text cell a spreadsheet would run as a formula (=, +, -, @) gets a leading apostrophe. */
function safeText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function rateText(r: number): string {
  return String(Number(r.toPrecision(10)));
}

/**
 * Rows for the group's CSV export (header first): Date, Description, Category, Kind, Amount,
 * Currency, FX rate, Amount in group currency, Paid by, one column per member with that entry's
 * effect on them in the group currency, and a last row with each member's balance.
 * Deleted entries are left out; oldest first.
 */
export function buildExportRows(
  snap: { group: { currency: string }; members: readonly MemberDTO[]; expenses: readonly ExpenseDTO[] },
  labels: ExportLabels,
): string[][] {
  const base = snap.group.currency;
  const live = snap.expenses
    .filter(e => !e.deletedAt)
    .slice()
    .sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) : a.date < b.date ? -1 : 1));
  const used = new Set<string>();
  for (const e of live) {
    for (const p of e.payers) used.add(p.memberId);
    for (const s of e.shares) used.add(s.memberId);
  }
  const members = snap.members
    .filter(m => m.active || used.has(m.id))
    .slice()
    .sort((a, b) => a.sort - b.sort || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const byId = new Map(snap.members.map(m => [m.id, m]));
  const nameOf = (id: string) => byId.get(id)?.name ?? labels.unknownMember;

  const rows: string[][] = [[
    labels.date, labels.description, labels.category, labels.kind, labels.amount, labels.currency,
    labels.fxRate, labels.baseAmount, labels.paidBy, ...members.map(m => safeText(m.name)),
  ]];
  for (const e of live) {
    const effect = entryNet(e, base);
    const isPayment = e.kind === 'payment';
    const to = e.shares[0]?.memberId ?? e.split.entries[0]?.memberId ?? '';
    const description = isPayment ? labels.paymentDescription(nameOf(e.payers[0]?.memberId ?? ''), nameOf(to)) : e.description;
    const paidBy = e.payers.length === 1
      ? nameOf(e.payers[0].memberId)
      : e.payers.map(p => `${nameOf(p.memberId)} (${decimalString(p.amount, e.currency)})`).join(labels.separator);
    rows.push([
      e.date,
      safeText(description),
      safeText(labels.categoryLabel(isPayment ? 'payment' : e.category)),
      isPayment ? labels.payment : labels.expense,
      decimalString(e.amount, e.currency),
      e.currency,
      rateText(e.currency === base ? 1 : e.fxRate),
      decimalString(toBase(e, base).total, base),
      safeText(paidBy),
      ...members.map(m => decimalString(effect.get(m.id) ?? 0, base)),
    ]);
  }
  const balances = netBalances(live, base, members.map(m => m.id));
  rows.push(['', labels.total, '', '', '', base, '', '', '', ...members.map(m => decimalString(balances[m.id] ?? 0, base))]);
  return rows;
}
