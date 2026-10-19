// Pure logic of the expense editor and the expense detail page: the draft the form edits, the
// calculator keypad, parsing what people type, validation reasons, the request body, the live
// preview (always computeSharesFor, so it matches what the server stores), two-person presets,
// possible duplicates, suggestions and history lines.
//
// No React and no browser APIs in this file, so tests/web/editor-logic.test.ts runs it in Node.
// Wording lives in editorText.ts; money math lives in src/shared (never re-implemented here).

import { convertMinor, toBase } from '../../../shared/balances';
import { categoryLabel, detectCategory, isCategoryKey } from '../../../shared/categories';
import { getCurrency, isKnownCurrency } from '../../../shared/currencies';
import { addDays, isISODate, type Repeat } from '../../../shared/dates';
import { MAX_AMOUNT, minorToInput, parseAmount } from '../../../shared/money';
import {
  checkPayers,
  computeSharesFor,
  splitParticipants,
  type PayersErrorCode,
  type Portion,
  type SplitEntry,
  type SplitErrorCode,
  type SplitInput,
  type SplitItem,
  type SplitMethod,
  type SplitResult,
} from '../../../shared/split';
import type { ActivityDTO, ExpenseDTO, ExpenseKind, GroupListItemDTO, GroupSnapshotDTO, MemberDTO, ReceiptScanDTO, UpsertExpenseReq } from '../../../shared/types';

// ---------- the draft ----------

export type PayerMode = 'single' | 'multi';

/** One receipt line while it is being typed. */
export interface ItemDraft {
  id: string;
  name: string;
  amountRaw: string;
  memberIds: string[];
}

/**
 * The split as the form holds it. Every method keeps its own typed values, so switching
 * methods and back loses nothing. `included` is who takes part in an equal or adjusted split
 * (the faces on the editor and the checkboxes in the split sheet).
 */
export interface SplitDraft {
  method: SplitMethod;
  included: string[];
  /** Typed text per member: minor-unit amounts (exact, adjust), percentages, share counts. */
  exact: Record<string, string>;
  percent: Record<string, string>;
  shares: Record<string, string>;
  adjust: Record<string, string>;
  items: ItemDraft[];
}

/** The rate an existing entry was saved with; kept while its currency and date stay the same. */
export interface StoredRate {
  rate: number;
  currency: string;
  date: string;
}

export interface EditorDraft {
  id: string;
  kind: ExpenseKind;
  /** What was typed into the amount: a number or a calculator expression. */
  amountRaw: string;
  currency: string;
  description: string;
  category: string;
  /** The category was picked by hand, so typing a description no longer changes it. */
  categoryManual: boolean;
  date: string;
  notes: string;
  repeat: Repeat;
  payerMode: PayerMode;
  /** The payer when one person paid (for a payment: the sender). */
  payerId: string;
  /** 多人付款: typed amount per member. */
  payerAmounts: Record<string, string>;
  /** Payments only: who received the money. */
  recipientId: string;
  split: SplitDraft;
  /** A rate typed by hand ('' = none). Kept until the currency changes. */
  fxManual: string;
  fxStored: StoredRate | null;
}

/** Keep `ids` that are in `order`, in the order of `order`, without repeats. */
export function orderIds(order: readonly string[], ids: Iterable<string>): string[] {
  const want = new Set(ids);
  return order.filter(id => want.has(id));
}

export function emptySplit(included: readonly string[]): SplitDraft {
  return { method: 'equal', included: [...included], exact: {}, percent: {}, shares: {}, adjust: {}, items: [] };
}

/** A new entry: paid by me (or the first member), split equally among everyone offered. */
export function newDraft(o: { id: string; memberIds: readonly string[]; meId: string; currency: string; date: string }): EditorDraft {
  const payer = o.memberIds.includes(o.meId) ? o.meId : o.memberIds[0] ?? '';
  return {
    id: o.id,
    kind: 'expense',
    amountRaw: '',
    currency: o.currency,
    description: '',
    category: 'general',
    categoryManual: false,
    date: o.date,
    notes: '',
    repeat: 'none',
    payerMode: 'single',
    payerId: payer,
    payerAmounts: {},
    recipientId: '',
    split: emptySplit(o.memberIds),
    fxManual: '',
    fxStored: null,
  };
}

const bySort = (a: MemberDTO, b: MemberDTO): number =>
  a.sort - b.sort || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

/**
 * The members an editor offers, in display order: me first, then the active members by sort
 * order, then removed members the entry being edited still mentions (so editing an old entry
 * never drops anyone silently). Removed members are never offered for new entries.
 */
export function editorMembers(members: readonly MemberDTO[], meId: string, mentioned: readonly string[] = []): MemberDTO[] {
  const active = members
    .filter(m => m.active)
    .sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : bySort(a, b)));
  const extra = members.filter(m => !m.active && mentioned.includes(m.id)).sort(bySort);
  return [...active, ...extra];
}

/**
 * A stand-in for the snapshot of a group this device never opened, from the group as GET /api/me
 * lists it (name, currency, members in their order, my member id), so a new entry can be added
 * offline. It has no entries; anything not in the list (roles, join dates) is a neutral default.
 */
export function snapshotFromListItem(g: GroupListItemDTO): GroupSnapshotDTO {
  return {
    group: {
      id: g.id,
      name: g.name,
      type: g.type,
      currency: g.currency,
      emoji: g.emoji,
      color: g.color,
      simplify: true,
      notes: '',
      createdBy: '',
      createdAt: g.updatedAt,
      updatedAt: g.updatedAt,
      version: g.version,
    },
    members: g.members.map((m, i) => ({
      id: m.id,
      groupId: g.id,
      userId: m.userId,
      name: m.name,
      color: m.color,
      role: 'member' as const,
      active: m.active,
      sort: i,
      createdAt: g.updatedAt,
      claimedAt: null,
      payInfo: '',
      venmo: '',
      paypal: '',
      avatar: m.avatar ?? null,
    })),
    expenses: [],
    me: { memberId: g.myMemberId, role: 'member' },
    inviteCode: '',
  };
}

/** Every member an entry mentions (payers, split, shares). */
export function mentionedIds(e: Pick<ExpenseDTO, 'payers' | 'split' | 'shares'>): string[] {
  const out = new Set<string>();
  for (const p of e.payers) out.add(p.memberId);
  for (const id of splitParticipants(e.split)) out.add(id);
  for (const s of e.shares) out.add(s.memberId);
  return [...out];
}

function numText(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '';
  return String(v);
}

/** The category the description would get automatically. */
export function autoCategory(description: string): string {
  return detectCategory(description) ?? 'general';
}

/**
 * Prefill the form from a saved entry. With `copy`, the result is a new entry (new id, the
 * given date, not repeating) for 複製這筆; the saved rate is then not reused.
 */
export function draftFromExpense(e: ExpenseDTO, o: { memberIds: readonly string[]; copy?: { id: string; date: string } }): EditorDraft {
  const cur = e.currency;
  const raw = (minor: number) => minorToInput(minor, cur);
  const signedRaw = (minor: number) => (minor < 0 ? '-' + minorToInput(-minor, cur) : minorToInput(minor, cur));
  const ids = o.memberIds;
  const entries = e.split.entries ?? [];
  const shareIds = e.shares.map(s => s.memberId);
  const participants = splitParticipants(e.split);
  const included = orderIds(ids, e.split.method === 'equal' || e.split.method === 'adjust' ? participants : shareIds.length ? shareIds : participants);

  const split: SplitDraft = emptySplit(included);
  split.method = e.kind === 'payment' ? 'equal' : e.split.method;
  if (e.kind === 'expense') {
    switch (e.split.method) {
      case 'exact':
        for (const en of entries) if (en.value) split.exact[en.memberId] = raw(en.value);
        break;
      case 'percent':
        for (const en of entries) if (en.value) split.percent[en.memberId] = numText(en.value);
        break;
      case 'shares':
        for (const id of ids) split.shares[id] = '0';
        for (const en of entries) split.shares[en.memberId] = numText(en.value ?? 0) || '0';
        break;
      case 'adjust':
        for (const en of entries) if (en.value) split.adjust[en.memberId] = signedRaw(en.value);
        break;
      case 'items':
        split.items = (e.split.items ?? []).map((it, i) => ({
          id: it.id || `item-${i + 1}`,
          name: it.name,
          amountRaw: it.amount ? raw(it.amount) : '',
          memberIds: orderIds(ids, it.memberIds),
        }));
        break;
      default:
        break;
    }
  }

  const multi = e.payers.length > 1;
  const payerAmounts: Record<string, string> = {};
  if (multi) for (const p of e.payers) payerAmounts[p.memberId] = raw(p.amount);
  const copy = o.copy;

  return {
    id: copy ? copy.id : e.id,
    kind: e.kind,
    amountRaw: raw(e.amount),
    currency: cur,
    description: e.description,
    category: e.kind === 'payment' ? 'payment' : e.category || 'general',
    categoryManual: e.kind === 'expense' && (e.category || 'general') !== autoCategory(e.description),
    date: copy ? copy.date : e.date,
    notes: e.notes,
    repeat: copy ? 'none' : e.repeat,
    payerMode: multi ? 'multi' : 'single',
    payerId: e.payers[0]?.memberId ?? '',
    payerAmounts,
    recipientId: e.kind === 'payment' ? entries[0]?.memberId ?? e.shares[0]?.memberId ?? '' : '',
    split,
    fxManual: '',
    fxStored: copy ? null : { rate: e.fxRate, currency: cur, date: e.date },
  };
}

/** The request that saves an entry again exactly as it is stored (undo for an edit). */
export function bodyOfExpense(e: ExpenseDTO): UpsertExpenseReq {
  return {
    kind: e.kind,
    description: e.description,
    category: e.category,
    amount: e.amount,
    currency: e.currency,
    fxRate: e.fxRate,
    date: e.date,
    notes: e.notes,
    payers: e.payers.map(p => ({ ...p })),
    split: JSON.parse(JSON.stringify(e.split)) as SplitInput,
    repeat: e.repeat,
    baseVersion: e.version,
  };
}

// ---------- typing into the form ----------

/** The description changed: re-detect the category unless it was picked by hand. */
export function withDescription(d: EditorDraft, description: string): EditorDraft {
  return { ...d, description, category: d.categoryManual || d.kind === 'payment' ? d.category : autoCategory(description) };
}

export function withCategory(d: EditorDraft, category: string): EditorDraft {
  return { ...d, category, categoryManual: true };
}

/** A new currency: a typed rate belonged to the old one, so it is dropped. */
export function withCurrency(d: EditorDraft, currency: string): EditorDraft {
  if (currency === d.currency) return d;
  return { ...d, currency, fxManual: '' };
}

/** Tap a face: take that member out of (or back into) an equal or adjusted split. */
export function toggleIncluded(s: SplitDraft, memberId: string, memberIds: readonly string[]): SplitDraft {
  const has = s.included.includes(memberId);
  const next = has ? s.included.filter(id => id !== memberId) : [...s.included, memberId];
  return { ...s, included: orderIds(memberIds, next) };
}

export function setIncluded(s: SplitDraft, ids: Iterable<string>, memberIds: readonly string[]): SplitDraft {
  return { ...s, included: orderIds(memberIds, ids) };
}

/** Switch methods, seeding the new one from what makes sense (shares start at 1 per person in the split). */
export function withMethod(s: SplitDraft, method: SplitMethod, memberIds: readonly string[]): SplitDraft {
  if (method === s.method) return s;
  const next: SplitDraft = { ...s, method };
  if (method === 'shares' && memberIds.every(id => !(s.shares[id] ?? '').trim())) {
    const shares: Record<string, string> = {};
    for (const id of memberIds) shares[id] = s.included.includes(id) ? '1' : '0';
    next.shares = shares;
  }
  if (method === 'items' && s.items.length === 0) {
    next.items = [{ id: 'item-1', name: '', amountRaw: '', memberIds: [] }];
  }
  return next;
}

/** Shares stepper: steps of 0.5, never below 0. */
export function stepShares(raw: string, dir: 1 | -1): string {
  const cur = parseLooseNumber(raw) ?? 0;
  const v = Math.max(0, Math.round((cur + dir * 0.5) * 2) / 2);
  return String(v);
}

/** A fresh id for a new receipt line ("item-<n>"), unique within the list. */
export function nextItemId(items: readonly ItemDraft[]): string {
  let n = items.length + 1;
  const used = new Set(items.map(i => i.id));
  while (used.has(`item-${n}`)) n++;
  return `item-${n}`;
}

/** Flip the sign of an adjustment ("300" <-> "-300"). */
export function flipSign(raw: string): string {
  const s = raw.trim();
  if (!s) return '-';
  if (/^[-−－]/.test(s)) return s.replace(/^[-−－]\s*/, '');
  return '-' + s.replace(/^[+＋]\s*/, '');
}

// ---------- the calculator keypad ----------

export type PadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '000' | '.' | '+' | '-' | '*' | '/' | 'del' | 'clear';

const OPS = '+-*/';
const MAX_RAW = 32;
/** Digits per operand before the point (DESIGN.md 9.1: 12). */
const MAX_DIGITS = 12;

function lastNumber(raw: string): string {
  let i = raw.length;
  while (i > 0 && !OPS.includes(raw[i - 1])) i--;
  return raw.slice(i);
}

/**
 * Apply one keypad key to the amount text, like a calculator: no leading zeros, at most 12
 * digits per number and `decimals` digits after the point, one operator between numbers
 * (pressing another operator replaces it), no operator at the start, 000 ignored on an empty
 * number.
 */
export function pressKey(raw: string, key: PadKey, decimals: number): string {
  if (key === 'clear') return '';
  if (key === 'del') return raw.slice(0, -1);
  const tail = lastNumber(raw);
  const last = raw.slice(-1);
  if (key === '+' || key === '-' || key === '*' || key === '/') {
    if (!raw) return raw;
    if (OPS.includes(last)) return raw.slice(0, -1) + key;
    const base = last === '.' ? raw.slice(0, -1) : raw;
    return base + key;
  }
  if (raw.length >= MAX_RAW) return raw;
  if (key === '.') {
    if (decimals <= 0 || tail.includes('.')) return raw;
    return raw + (tail === '' ? '0.' : '.');
  }
  const dot = tail.indexOf('.');
  if (key === '000') {
    if (tail === '' || tail === '0' || dot >= 0) return raw;
    if (tail.replace(/\D/g, '').length + 3 > MAX_DIGITS) return raw;
    return raw + '000';
  }
  // a digit
  if (dot >= 0 && tail.length - dot - 1 >= decimals) return raw;
  if (tail === '0') return key === '0' ? raw : raw.slice(0, -1) + key;
  if (dot < 0 && tail.replace(/\D/g, '').length >= MAX_DIGITS) return raw;
  return raw + key;
}

/**
 * The amount text as a receipt prints it: digits grouped with commas and a space around each
 * operator ("8400+4200" -> "8,400 + 4,200"). Unusual text is shown as typed.
 */
export function prettyExpression(raw: string): string {
  const parts = raw.split(/([+\-*/×÷])/);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return ' ' + (p === '*' ? '×' : p === '/' ? '÷' : p) + ' ';
      const m = /^(\d+)(\.\d*)?$/.exec(p);
      if (!m) return p;
      return m[1].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (m[2] ?? '');
    })
    .join('')
    .trim();
}

/** True when the amount text holds arithmetic (so the slip shows the expression above the result). */
export function hasOperator(raw: string): boolean {
  return /\d\s*[+\-*/×÷]/.test(raw.trim());
}

// ---------- parsing typed values ----------

const FULL_WIDTH: Record<string, string> = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  '．': '.', '，': ',', '％': '',
};

/**
 * A plain decimal number as people type it ("33.3", "33,3", "１.５", " 2 ", "25,400"), or null.
 * Used for percentages, share counts and exchange rates (not money: money uses parseAmount).
 * A single comma is a decimal comma unless it is followed by exactly three digits after a
 * non-zero number ("25,400" is twenty-five thousand four hundred, "0,215" and "4,75" are decimals).
 */
export function parseLooseNumber(raw: string): number | null {
  let s = '';
  for (const ch of raw.trim()) s += FULL_WIDTH[ch] ?? ch;
  s = s.replace(/[\s%]/g, '');
  if (!s) return null;
  if (s.includes(',')) {
    if (s.includes('.')) {
      s = s.lastIndexOf('.') > s.lastIndexOf(',') ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
    } else {
      const parts = s.split(',');
      const thousands = parts.length > 2 || (parts[1].length === 3 && /[1-9]/.test(parts[0]));
      s = thousands ? parts.join('') : parts[0] + '.' + parts[1];
    }
  }
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** Money with an optional leading sign ("-300", "−1,200", "+50"); '' is 0. */
export function parseSignedMinor(raw: string, currency: string): number | null {
  const s = raw.trim();
  if (!s) return 0;
  const neg = /^[-−－]/.test(s);
  const body = s.replace(/^[-−－+＋]\s*/, '');
  if (!body) return neg ? 0 : null;
  const v = parseAmount(body, currency);
  if (v === null) return null;
  return neg ? (v === 0 ? 0 : -v) : v;
}

export type AmountState = 'empty' | 'invalid' | 'zero' | 'ok';

/**
 * The total from the amount text. A trailing operator is ignored, so the slip keeps showing a
 * value while someone is in the middle of typing "8400+".
 */
export function readAmount(raw: string, currency: string): { state: AmountState; value: number | null } {
  let s = raw.trim();
  while (s && /[+\-*/×÷−＋－＊／(\s]$/.test(s)) s = s.slice(0, -1);
  if (!s) return { state: 'empty', value: null };
  const v = parseAmount(s, currency);
  if (v === null) {
    // An expression that comes out below zero ("100-200") is "must be more than 0", not unreadable.
    if (hasOperator(s) && (parseAmount(`0-(${s})`, currency) ?? 0) > 0) return { state: 'zero', value: 0 };
    return { state: 'invalid', value: null };
  }
  if (v === 0) return { state: 'zero', value: 0 };
  return { state: 'ok', value: v };
}

// ---------- payers ----------

/** The payers the form describes for a total (multi: members with a typed amount above 0). */
export function payersOf(d: EditorDraft, total: number, memberIds: readonly string[]): { payers: Portion[]; invalidMember?: string } {
  if (d.kind === 'payment' || d.payerMode === 'single') {
    return { payers: d.payerId ? [{ memberId: d.payerId, amount: total }] : [] };
  }
  const payers: Portion[] = [];
  for (const id of memberIds) {
    const raw = (d.payerAmounts[id] ?? '').trim();
    if (!raw) continue;
    const v = parseAmount(raw, d.currency);
    if (v === null) return { payers, invalidMember: id };
    if (v > 0) payers.push({ memberId: id, amount: v });
  }
  return { payers };
}

/** Sum of typed money amounts for these members (text that cannot be read counts as 0). */
export function sumTypedMoney(map: Readonly<Record<string, string>>, memberIds: readonly string[], currency: string): number {
  let sum = 0;
  for (const id of memberIds) {
    const raw = (map[id] ?? '').trim();
    if (!raw) continue;
    sum += parseAmount(raw, currency) ?? 0;
  }
  return sum;
}

/** Sum of the typed multi-payer amounts (invalid text counts as 0). */
export function payerAmountsSum(d: Pick<EditorDraft, 'payerAmounts' | 'currency'>, memberIds: readonly string[]): number {
  return sumTypedMoney(d.payerAmounts, memberIds, d.currency);
}

/** Members with a typed paid amount above 0 (多人付款). */
export function multiPayerCount(d: Pick<EditorDraft, 'payerAmounts' | 'currency'>, memberIds: readonly string[]): number {
  return memberIds.filter(id => sumTypedMoney(d.payerAmounts, [id], d.currency) > 0).length;
}

// ---------- the split ----------

export type SplitBuild =
  | { ok: true; split: SplitInput }
  | { ok: false; code: 'invalid_value'; memberId?: string; itemId?: string };

function stripZeros(entries: SplitEntry[]): SplitEntry[] {
  const nonZero = entries.filter(e => e.value);
  return nonZero.length ? nonZero : entries;
}

/** The SplitInput the form describes (what is sent and stored), or the field that cannot be read. */
export function buildSplit(s: SplitDraft, memberIds: readonly string[], currency: string): SplitBuild {
  switch (s.method) {
    case 'equal':
      return { ok: true, split: { method: 'equal', entries: orderIds(memberIds, s.included).map(memberId => ({ memberId })) } };
    case 'exact': {
      const entries: SplitEntry[] = [];
      for (const id of memberIds) {
        const raw = (s.exact[id] ?? '').trim();
        const v = raw ? parseAmount(raw, currency) : 0;
        if (v === null) return { ok: false, code: 'invalid_value', memberId: id };
        entries.push({ memberId: id, value: v });
      }
      return { ok: true, split: { method: 'exact', entries: stripZeros(entries) } };
    }
    case 'percent': {
      const entries: SplitEntry[] = [];
      for (const id of memberIds) {
        const raw = (s.percent[id] ?? '').trim();
        const v = raw ? parseLooseNumber(raw) : 0;
        if (v === null) return { ok: false, code: 'invalid_value', memberId: id };
        entries.push({ memberId: id, value: v });
      }
      return { ok: true, split: { method: 'percent', entries: stripZeros(entries) } };
    }
    case 'shares': {
      const entries: SplitEntry[] = [];
      for (const id of memberIds) {
        const typed = s.shares[id];
        const raw = (typed ?? '').trim();
        const v = typed === undefined ? (s.included.includes(id) ? 1 : 0) : raw ? parseLooseNumber(raw) : 0;
        if (v === null) return { ok: false, code: 'invalid_value', memberId: id };
        entries.push({ memberId: id, value: v });
      }
      return { ok: true, split: { method: 'shares', entries: stripZeros(entries) } };
    }
    case 'adjust': {
      const entries: SplitEntry[] = [];
      for (const id of orderIds(memberIds, s.included)) {
        const v = parseSignedMinor(s.adjust[id] ?? '', currency);
        if (v === null) return { ok: false, code: 'invalid_value', memberId: id };
        entries.push(v ? { memberId: id, value: v } : { memberId: id });
      }
      return { ok: true, split: { method: 'adjust', entries } };
    }
    case 'items': {
      const items: SplitItem[] = [];
      for (const it of s.items) {
        const raw = it.amountRaw.trim();
        const name = it.name.trim();
        if (!raw && !name && it.memberIds.length === 0) continue;
        const v = raw ? parseAmount(raw, currency) : 0;
        if (v === null) return { ok: false, code: 'invalid_value', itemId: it.id };
        items.push({ id: it.id, name: name.slice(0, 60), amount: v, memberIds: orderIds(memberIds, it.memberIds) });
      }
      return { ok: true, split: { method: 'items', entries: [], items } };
    }
    default:
      return { ok: false, code: 'invalid_value' };
  }
}

/**
 * How many people a split covers before an amount is known: everyone in an equal or adjusted
 * split, people with a value above 0 for exact, percent and shares, everyone on an item.
 */
export function splitPeople(split: SplitInput | null): number {
  if (!split) return 0;
  switch (split.method) {
    case 'equal':
    case 'adjust':
      return split.entries.length;
    case 'items':
      return splitParticipants(split).length;
    default:
      return split.entries.filter(e => (e.value ?? 0) > 0).length;
  }
}

/** Sum of the typed exact amounts (invalid text counts as 0). */
export function exactSum(s: SplitDraft, memberIds: readonly string[], currency: string): number {
  return sumTypedMoney(s.exact, memberIds, currency);
}

/** Total of the typed share counts (invalid text counts as 0). */
export function sharesSum(s: SplitDraft, memberIds: readonly string[]): number {
  let sum = 0;
  for (const id of memberIds) {
    const typed = s.shares[id];
    sum += typed === undefined ? (s.included.includes(id) ? 1 : 0) : parseLooseNumber(typed) ?? 0;
  }
  return Math.round(sum * 1000) / 1000;
}

/** Sum of the typed percentages, rounded to 3 decimals. */
export function percentSum(s: SplitDraft, memberIds: readonly string[]): number {
  let sum = 0;
  for (const id of memberIds) sum += parseLooseNumber(s.percent[id] ?? '') ?? 0;
  return Math.round(sum * 1000) / 1000;
}

/** Sum of the item amounts (invalid text counts as 0). */
export function itemsSum(s: SplitDraft, currency: string): number {
  let sum = 0;
  for (const it of s.items) sum += parseAmount(it.amountRaw.trim(), currency) ?? 0;
  return sum;
}

// ---------- exchange rate ----------

export type FxSource = 'same' | 'manual' | 'stored' | 'auto' | 'none';

/** A typed exchange rate: above 0 and below 1e9, or null. */
export function parseRate(raw: string): number | null {
  const v = parseLooseNumber(raw);
  return v !== null && v > 0 && v < 1e9 ? v : null;
}

/** A rate for display: up to 5 significant digits, no trailing zeros ("31.42", "0.21053", "158.21"). */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '';
  const v = Number(rate.toPrecision(rate >= 1e5 ? 9 : 5));
  return String(v);
}

/**
 * Which rate the entry uses: 1 for the group currency; else a typed rate, else the rate the
 * entry was saved with (while its currency and date are unchanged), else the fetched one.
 * A typed rate that cannot be read gives no rate at all, so saving stays blocked.
 */
export function effectiveRate(d: EditorDraft, groupCurrency: string, fetched: number | null): { rate: number | null; source: FxSource } {
  if (d.currency === groupCurrency) return { rate: 1, source: 'same' };
  if (d.fxManual.trim()) {
    const r = parseRate(d.fxManual);
    return r !== null ? { rate: r, source: 'manual' } : { rate: null, source: 'none' };
  }
  const st = d.fxStored;
  if (st && st.currency === d.currency && st.date === d.date && st.rate > 0) return { rate: st.rate, source: 'stored' };
  if (fetched !== null && fetched > 0) return { rate: fetched, source: 'auto' };
  return { rate: null, source: 'none' };
}

// ---------- evaluation: validity, body, preview ----------

export type Reason =
  | { code: 'amount_empty' }
  | { code: 'amount_invalid' }
  | { code: 'amount_zero' }
  | { code: 'payer_missing' }
  | { code: 'payers'; error: PayersErrorCode; diff?: number; memberId?: string }
  | { code: 'split'; error: SplitErrorCode; diff?: number; memberId?: string; itemId?: string }
  | { code: 'recipient_missing' }
  | { code: 'payment_self' }
  | { code: 'fx_missing' }
  | { code: 'fx_invalid' }
  | { code: 'converted_too_large' };

export interface EvalContext {
  /** Members the editor offers, in display order. */
  memberIds: readonly string[];
  meId: string;
  groupCurrency: string;
  /** rates[currency] from /api/fx for the entry date, or null. */
  fetchedRate: number | null;
  /** UI language, for the description sent when none was typed (the category's name). */
  locale?: string;
}

/** The first `max` UTF-16 units of `s`, never splitting a surrogate pair (server limits count units). */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * What is sent as the description. A description is optional for the person (DESIGN.md 9.2):
 * an expense saved without one gets its category's name (餐廳, 一般), so the server rule that
 * an expense needs a description still holds. Payments may stay empty.
 */
export function descriptionToSend(d: Pick<EditorDraft, 'kind' | 'description' | 'category'>, locale = 'zh-TW'): string {
  const typed = clip(d.description.trim(), 120);
  if (typed || d.kind === 'payment') return typed;
  return categoryLabel(d.category, locale);
}

export interface Evaluation {
  amountState: AmountState;
  total: number | null;
  payers: Portion[];
  split: SplitInput | null;
  splitResult: SplitResult | null;
  shares: Portion[];
  fx: { rate: number | null; source: FxSource };
  /** The total in the group currency (null without a rate). */
  converted: number | null;
  /** The first thing that stops saving, or null. */
  reason: Reason | null;
  /** The split's own problem (shown in the split sheet even while another reason comes first). */
  splitReason: Extract<Reason, { code: 'split' }> | null;
  /** The payers' own problem (多人付款 amounts). */
  payerReason: Extract<Reason, { code: 'payers' }> | null;
  /** The request to send when there is no reason. */
  body: UpsertExpenseReq | null;
  /** Everyone's part in the group currency (balances.toBase), when the entry is complete. */
  base: { total: number; paid: Portion[]; owed: Portion[] } | null;
  /** My effect: paid minus owed, in the group currency when a rate exists, else the entry currency. */
  me: { involved: boolean; net: number; currency: string } | null;
}

function paymentSplit(recipient: string, total: number): SplitInput {
  return { method: 'exact', entries: [{ memberId: recipient, value: total }] };
}

/** Everything the editor shows and checks, from the draft. Pure and cheap enough to run per keystroke. */
export function evaluate(d: EditorDraft, ctx: EvalContext): Evaluation {
  const amt = readAmount(d.amountRaw, d.currency);
  const total = amt.value;
  const fx = effectiveRate(d, ctx.groupCurrency, ctx.fetchedRate);
  const out: Evaluation = {
    amountState: amt.state,
    total,
    payers: [],
    split: null,
    splitResult: null,
    shares: [],
    fx,
    converted: null,
    reason: null,
    splitReason: null,
    payerReason: null,
    body: null,
    base: null,
    me: null,
  };
  const reasons: Reason[] = [];
  if (amt.state === 'empty') reasons.push({ code: 'amount_empty' });
  else if (amt.state === 'invalid') reasons.push({ code: 'amount_invalid' });
  else if (amt.state === 'zero') reasons.push({ code: 'amount_zero' });

  const t = total && total > 0 ? total : 0;
  if (d.kind === 'payment') {
    out.payers = d.payerId && t ? [{ memberId: d.payerId, amount: t }] : [];
    if (!d.payerId) reasons.push({ code: 'payer_missing' });
    if (!d.recipientId) reasons.push({ code: 'recipient_missing' });
    else if (d.recipientId === d.payerId) reasons.push({ code: 'payment_self' });
    if (d.recipientId) {
      out.split = paymentSplit(d.recipientId, t);
      if (t) {
        out.splitResult = computeSharesFor(d.id, t, out.split);
        if (out.splitResult.ok) out.shares = out.splitResult.shares;
      }
    }
  } else {
    const p = payersOf(d, t, ctx.memberIds);
    out.payers = p.payers;
    if (d.payerMode === 'single' && !d.payerId) reasons.push({ code: 'payer_missing' });
    else if (p.invalidMember) reasons.push({ code: 'payers', error: 'invalid_value', memberId: p.invalidMember });
    else if (t) {
      const pc = checkPayers(t, p.payers);
      if (!pc.ok) reasons.push(pc.diff === undefined ? { code: 'payers', error: pc.code } : { code: 'payers', error: pc.code, diff: pc.diff });
    }
    const b = buildSplit(d.split, ctx.memberIds, d.currency);
    if (!b.ok) {
      reasons.push({ code: 'split', error: 'invalid_value', memberId: b.memberId, itemId: b.itemId });
    } else {
      out.split = b.split;
      if (t) {
        const r = computeSharesFor(d.id, t, b.split);
        out.splitResult = r;
        if (r.ok) out.shares = r.shares;
        else reasons.push(r.diff === undefined ? { code: 'split', error: r.code } : { code: 'split', error: r.code, diff: r.diff });
      }
    }
  }

  if (d.currency !== ctx.groupCurrency) {
    if (fx.rate === null) reasons.push({ code: d.fxManual.trim() ? 'fx_invalid' : 'fx_missing' });
    else if (t) {
      const c = convertMinor(t, d.currency, fx.rate, ctx.groupCurrency);
      out.converted = c;
      if (c > MAX_AMOUNT) reasons.push({ code: 'converted_too_large' });
    }
  } else if (t) {
    out.converted = t;
  }

  out.reason = reasons[0] ?? null;
  for (const r of reasons) {
    if (r.code === 'split' && !out.splitReason) out.splitReason = r;
    if (r.code === 'payers' && !out.payerReason) out.payerReason = r;
  }

  const complete = t > 0 && out.split && out.splitResult?.ok && (d.kind === 'payment' ? !!d.payerId && !!d.recipientId && d.payerId !== d.recipientId : checkPayers(t, out.payers).ok);
  if (complete) {
    const entry = {
      id: d.id,
      kind: d.kind,
      amount: t,
      currency: d.currency,
      fxRate: fx.rate ?? 1,
      payers: out.payers,
      shares: out.shares,
    };
    let paid = 0;
    let owed = 0;
    let involved = false;
    if (fx.rate !== null) {
      const base = toBase(entry, ctx.groupCurrency);
      out.base = base;
      for (const p of base.paid) if (p.memberId === ctx.meId) { paid += p.amount; involved = true; }
      for (const o of base.owed) if (o.memberId === ctx.meId) { owed += o.amount; involved = true; }
      out.me = { involved, net: paid - owed, currency: ctx.groupCurrency };
    } else {
      for (const p of out.payers) if (p.memberId === ctx.meId) { paid += p.amount; involved = true; }
      for (const s of out.shares) if (s.memberId === ctx.meId) { owed += s.amount; involved = true; }
      out.me = { involved, net: paid - owed, currency: d.currency };
    }
  }

  if (!out.reason && t && out.split) {
    out.body = {
      kind: d.kind,
      description: descriptionToSend(d, ctx.locale),
      category: d.kind === 'payment' ? 'payment' : d.category,
      amount: t,
      currency: d.currency,
      fxRate: d.currency === ctx.groupCurrency ? 1 : fx.rate ?? 1,
      date: d.date,
      notes: clip(d.notes.trim(), 2000),
      payers: out.payers,
      split: out.split,
      repeat: d.repeat,
    };
  }
  return out;
}

/** min and max of the shares (for 每人 ¥2,100, or ¥33～¥34 when rounding makes them differ). */
export function shareRange(shares: readonly Portion[]): { min: number; max: number } | null {
  if (!shares.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const s of shares) {
    if (s.amount < min) min = s.amount;
    if (s.amount > max) max = s.amount;
  }
  return { min, max };
}

/** A member's share, in minor units of the entry currency (0 when they have none). */
export function shareOf(shares: readonly Portion[], memberId: string): number {
  let s = 0;
  for (const p of shares) if (p.memberId === memberId) s += p.amount;
  return s;
}

// ---------- two-person presets ----------

export type PresetKey = 'i-equal' | 'i-full' | 'they-equal' | 'they-full';
export const PRESETS: readonly PresetKey[] = ['i-equal', 'i-full', 'they-equal', 'they-full'];

/** 我付，平分 / 我付，對方全付 / 對方付，平分 / 對方付，我全付. "Full" splits stay equal splits of one person, so they follow amount changes. */
export function applyPreset(d: EditorDraft, key: PresetKey, meId: string, otherId: string): EditorDraft {
  const iPay = key === 'i-equal' || key === 'i-full';
  const payerId = iPay ? meId : otherId;
  const included = key === 'i-equal' || key === 'they-equal' ? [meId, otherId] : [iPay ? otherId : meId];
  return { ...d, payerMode: 'single', payerId, split: { ...d.split, method: 'equal', included } };
}

export function activePreset(d: EditorDraft, meId: string, otherId: string): PresetKey | null {
  if (d.kind !== 'expense' || d.payerMode !== 'single' || d.split.method !== 'equal') return null;
  const inc = new Set(d.split.included);
  const both = inc.size === 2 && inc.has(meId) && inc.has(otherId);
  const onlyMe = inc.size === 1 && inc.has(meId);
  const onlyOther = inc.size === 1 && inc.has(otherId);
  if (d.payerId === meId) return both ? 'i-equal' : onlyOther ? 'i-full' : null;
  if (d.payerId === otherId) return both ? 'they-equal' : onlyMe ? 'they-full' : null;
  return null;
}

// ---------- duplicates and suggestions ----------

/** Newest first: by date, then by when it was created. */
function newestFirst(list: readonly ExpenseDTO[]): ExpenseDTO[] {
  return [...list].sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) : a.date < b.date ? 1 : -1));
}

/**
 * A live entry that looks like the one being typed: same kind, amount, currency, date and
 * payers, another id. Only a gentle hint; saving is never blocked.
 */
export function findDuplicate(
  expenses: readonly ExpenseDTO[],
  probe: { id: string; kind: ExpenseKind; amount: number; currency: string; date: string; payerIds: readonly string[] },
): ExpenseDTO | null {
  if (!probe.amount) return null;
  const want = [...new Set(probe.payerIds)].sort().join('|');
  for (const e of newestFirst(expenses)) {
    if (e.deletedAt || e.id === probe.id || e.kind !== probe.kind) continue;
    if (e.amount !== probe.amount || e.currency !== probe.currency || e.date !== probe.date) continue;
    const ids = [...new Set(e.payers.map(p => p.memberId))].sort().join('|');
    if (ids === want) return e;
  }
  return null;
}

/** For the currency picker: the group currency, then currencies this group used, most recent first. */
export function recentCurrencies(expenses: readonly ExpenseDTO[], groupCurrency: string, limit = 6): string[] {
  const out = [groupCurrency];
  for (const e of newestFirst(expenses)) {
    if (e.deletedAt) continue;
    if (!out.includes(e.currency)) out.push(e.currency);
    if (out.length >= limit) break;
  }
  return out;
}

export interface Suggestion {
  description: string;
  category: string;
}

function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim();
}

/**
 * Descriptions this group used before (DESIGN.md 9.2). With an empty query: the most used,
 * then the most recent; while typing: the ones starting with the query, then the ones
 * containing it (most recent first), never the query itself.
 */
export function descriptionSuggestions(expenses: readonly ExpenseDTO[], query: string, limit = 6): Suggestion[] {
  const q = fold(query);
  const found = new Map<string, { s: Suggestion; count: number; order: number }>();
  let order = 0;
  for (const e of newestFirst(expenses)) {
    if (e.deletedAt || e.kind !== 'expense') continue;
    const desc = e.description.trim();
    const key = fold(desc);
    if (!key) continue;
    const hit = found.get(key);
    if (hit) hit.count++;
    else found.set(key, { s: { description: desc, category: e.category }, count: 1, order: order++ });
  }
  const all = [...found.entries()];
  if (!q) {
    return all
      .sort(([, a], [, b]) => b.count - a.count || a.order - b.order)
      .slice(0, limit)
      .map(([, v]) => v.s);
  }
  const starts = all.filter(([k]) => k !== q && k.startsWith(q)).map(([, v]) => v.s);
  const contains = all.filter(([k]) => k !== q && !k.startsWith(q) && k.includes(q)).map(([, v]) => v.s);
  return [...starts, ...contains].slice(0, limit);
}

/** Fill the form from a suggestion: its description and the category it was saved with. */
export function withSuggestion(d: EditorDraft, s: Suggestion): EditorDraft {
  if (d.categoryManual) return { ...d, description: s.description };
  return { ...d, description: s.description, category: s.category, categoryManual: s.category !== autoCategory(s.description) };
}

// ---------- a scanned receipt (docs/PLAN-push-scan-cookies.md 3.2) ----------

/**
 * A receipt amount (major units, a plain number from the Worker) as minor units of `currency`, or
 * null when it cannot be one: not a number, negative, too large, or a fraction in a currency
 * without decimals (¥1,260 misread as 1.26 must not become ¥1). Goes through toFixed and
 * parseAmount: Math.round(1.005 * 100) is 100, String(1e21) parses as 1+21.
 */
export function receiptMinor(v: number | null | undefined, currency: string): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 1e15) return null;
  const d = decimalsOf(currency);
  if (d === 0 && Math.abs(v - Math.round(v)) > 1e-9) return null;
  const m = parseAmount(v.toFixed(Math.min(d + 2, 20)), currency);
  return m !== null && m <= MAX_AMOUNT ? m : null;
}

/** What a scan can fill in. */
export type ScanField = 'currency' | 'amount' | 'date' | 'description' | 'category' | 'items';

/** Things the editor tells the person after a scan (editorText.scanNoteText says them). */
export type ScanNote =
  /** Changed by the person while the photo was being read, so left as they set it. */
  | { code: 'kept'; fields: ScanField[] }
  /** The receipt's date is outside the last 90 days (plus tomorrow): not filled in. */
  | { code: 'date_outside'; date: string }
  /** The person picked another currency meanwhile, so the receipt's amounts do not fit. */
  | { code: 'currency_changed' }
  /** The total cannot be an amount in this currency (a fraction of a yen). */
  | { code: 'total_unreadable' }
  /** The person chose to keep the 品項 lines they had typed. */
  | { code: 'items_kept' };

/** What earlier scans of this form put into the description and the category, as they left them
 *  (missing: no scan filled it). Nobody typed those, so a later receipt may replace them. */
export interface ScannedText {
  description?: string;
  category?: { key: string; manual: boolean };
}

export interface ScanOptions {
  /** The form when the scan started: a field that differs from it now was changed meanwhile. Its
   *  currency is the hint the photo was read with (runScan sends it), so a receipt without a
   *  currency has amounts in that one. */
  started: EditorDraft;
  /** What counts as no change (init.base): the store name fills the description only while it still matches. */
  base: EditorDraft;
  groupCurrency: string;
  /** Today on this device (YYYY-MM-DD). */
  today: string;
  /** The rate typed by hand earlier for this group and currency ('' = none), as setCurrency uses it. */
  rateFor: (currency: string) => string;
  /** false: keep the 品項 lines that are there (the person said so). Default true. */
  replaceItems?: boolean;
  /** What the scans before this one left in the description and the category (ScanApplied.scannedText). */
  lastScanned?: ScannedText | null;
}

export interface ScanApplied {
  draft: EditorDraft;
  /** What changed, in this order: currency, amount, date, description, category, items. */
  filled: ScanField[];
  notes: ScanNote[];
  /** How many 品項 lines were put in. */
  items: number;
  /** The split already is 品項: open the split sheet so people say who had each line. */
  openSplit: boolean;
  /** What this scan and the ones before it left in the description and the category: pass it as
   *  lastScanned to the next scan. */
  scannedText: ScannedText;
}

/** The receipt's lines as 品項 lines in `currency` (unreadable and zero lines left out, at most 50). */
export function scanItems(scan: Pick<ReceiptScanDTO, 'items'>, currency: string): ItemDraft[] {
  const out: ItemDraft[] = [];
  for (const it of Array.isArray(scan.items) ? scan.items : []) {
    if (out.length >= 50) break;
    const m = receiptMinor(it?.amount, currency);
    if (m === null || m === 0) continue;
    const name = typeof it.name === 'string' ? clip(it.name.replace(/\s+/g, ' ').trim(), 60) : '';
    out.push({ id: `item-${out.length + 1}`, name, amountRaw: minorToInput(m, currency), memberIds: [] });
  }
  return out;
}

function sameItems(a: readonly ItemDraft[], b: readonly ItemDraft[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.id === y.id && x.name === y.name && x.amountRaw === y.amountRaw && x.memberIds.join('|') === y.memberIds.join('|');
  });
}

/** 品項 lines with something in them that did not come from the last scan as they are now (a scan
 *  asks before replacing those). */
export function hasTypedItems(items: readonly ItemDraft[], lastScanned?: readonly ItemDraft[] | null): boolean {
  if (lastScanned && sameItems(items, lastScanned)) return false;
  return items.some(i => i.name.trim() || i.amountRaw.trim() || i.memberIds.length > 0);
}

/**
 * Put what a receipt says into the form, in one step (one exchange-rate fetch, one undo). The
 * currency comes first, with setCurrency's rules (a typed rate belongs to the old currency; a rate
 * typed earlier for the new one comes back). Then the printed total, the date when it is within
 * the last 90 days (plus tomorrow), the store name while the description is untouched together
 * with the category (through withSuggestion, so a category picked by hand stays), and the lines
 * into split.items without switching the split method. Fields the person changed while the photo
 * was being read are left alone, and so are amounts that would be in another currency than the
 * form's. A store name and category an earlier scan filled count as untouched. Payments are never
 * touched.
 */
export function applyScan(d: EditorDraft, scan: ReceiptScanDTO, o: ScanOptions): ScanApplied {
  const out: ScanApplied = { draft: d, filled: [], notes: [], items: 0, openSplit: false, scannedText: { ...o.lastScanned } };
  if (d.kind !== 'expense') return out;
  const st = o.started;
  const kept: ScanField[] = [];
  let next = d;

  // The currency first: it decides how the amounts are read.
  const code = typeof scan.currency === 'string' && /^[A-Z]{3}$/.test(scan.currency) && isKnownCurrency(scan.currency) ? scan.currency : null;
  if (code && code !== d.currency) {
    if (d.currency !== st.currency) kept.push('currency');
    else {
      next = { ...withCurrency(next, code), fxManual: code !== o.groupCurrency ? o.rateFor(code) : '' };
      out.filled.push('currency');
    }
  }
  const currency = next.currency;
  // Without a currency (the Worker could not tell) the amounts are in the hint's decimals, and the
  // hint was the form's currency when the scan started: they fit only while the form keeps it.
  const amountsFit = code ? code === currency : currency === st.currency;
  if (!amountsFit) out.notes.push({ code: 'currency_changed' });

  if (amountsFit && typeof scan.total === 'number') {
    const m = receiptMinor(scan.total, currency);
    if (m === null || m === 0) out.notes.push({ code: 'total_unreadable' });
    else if (d.amountRaw !== st.amountRaw) kept.push('amount');
    else {
      const raw = minorToInput(m, currency);
      if (raw !== next.amountRaw) {
        next = { ...next, amountRaw: raw };
        out.filled.push('amount');
      }
    }
  }

  if (isISODate(scan.date)) {
    if (scan.date < addDays(o.today, -90) || scan.date > addDays(o.today, 1)) out.notes.push({ code: 'date_outside', date: scan.date });
    else if (d.date !== st.date) kept.push('date');
    else if (scan.date !== next.date) {
      next = { ...next, date: scan.date };
      out.filled.push('date');
    }
  }

  // The store name, only into a description nobody has typed; the category goes with it. Nobody
  // typed what an earlier scan put there either: a receipt with a store name replaces it (the right
  // photo after a wrong one), one without leaves it (the same receipt again, its name missed).
  const merchant = typeof scan.merchant === 'string' ? clip(scan.merchant.replace(/\s+/g, ' ').trim(), 120) : '';
  const scanned = typeof scan.category === 'string' && scan.category !== 'payment' && isCategoryKey(scan.category) ? scan.category : null;
  const last = o.lastScanned;
  const fromScan = !!merchant && last?.description !== undefined && d.description === last.description;
  const untouched = d.description === st.description && (d.description.trim() === o.base.description.trim() || fromScan);
  if (untouched && (merchant || scanned)) {
    // A category a scan set, still as it left it, was not picked by hand, even when it counts as
    // manual (a receipt's category that is not its store name's), so this receipt's replaces it.
    const lc = last?.category;
    const from = lc && next.category === lc.key && next.categoryManual === lc.manual ? { ...next, categoryManual: false } : next;
    const description = merchant || next.description;
    const category = scanned ?? (merchant ? autoCategory(merchant) : next.category);
    const was = next;
    next = withSuggestion(from, { description, category });
    if (next.description !== was.description) out.filled.push('description');
    if (next.category !== was.category) out.filled.push('category');
    if (merchant) out.scannedText.description = next.description;
    if (!from.categoryManual) out.scannedText.category = { key: next.category, manual: next.categoryManual };
  } else if (merchant && d.description !== st.description) {
    kept.push('description');
  }

  if (amountsFit) {
    const lines = scanItems(scan, currency);
    if (lines.length) {
      if (!sameItems(d.split.items, st.split.items)) kept.push('items');
      else if (o.replaceItems === false) out.notes.push({ code: 'items_kept' });
      else {
        next = { ...next, split: { ...next.split, items: lines } };
        out.filled.push('items');
        out.items = lines.length;
        out.openSplit = next.split.method === 'items';
      }
    }
  }

  if (kept.length) out.notes.unshift({ code: 'kept', fields: kept });
  out.draft = next;
  return out;
}

/** Two maps of typed text with the same values (empty ones and spaces around them do not count). */
function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  return a === b || JSON.stringify(nonEmpty(a)) === JSON.stringify(nonEmpty(b));
}

/**
 * Undo a scan: every field it set goes back to `before`, but only where the form still shows what
 * the scan put there (`after`), so changes made since are kept. The currency and the amounts go
 * together, since an amount means nothing without its currency: anything typed since the scan
 * (the amount, a 品項 line, a payer's or a person's amount, a rate) was typed in the scan's
 * currency, which then stays, and so do the scan's own amounts; the amounts from before the scan
 * come back only into the currency they were typed in.
 */
export function revertScan(current: EditorDraft, before: EditorDraft, after: EditorDraft): EditorDraft {
  let d = current;
  const typedSince =
    current.amountRaw !== after.amountRaw ||
    !sameItems(current.split.items, after.split.items) ||
    !sameMap(current.payerAmounts, after.payerAmounts) ||
    !sameMap(current.split.exact, after.split.exact) ||
    !sameMap(current.split.adjust, after.split.adjust);
  if (!typedSince && current.currency === after.currency && current.fxManual === after.fxManual) {
    d = { ...d, currency: before.currency, fxManual: before.fxManual };
  }
  if (d.currency === before.currency) {
    if (current.amountRaw === after.amountRaw) d = { ...d, amountRaw: before.amountRaw };
    if (current.split.method === after.split.method && sameItems(current.split.items, after.split.items)) {
      d = { ...d, split: { ...d.split, method: before.split.method, items: before.split.items } };
    }
  }
  if (current.date === after.date) d = { ...d, date: before.date };
  if (current.description === after.description) d = { ...d, description: before.description };
  if (current.category === after.category && current.categoryManual === after.categoryManual) {
    d = { ...d, category: before.category, categoryManual: before.categoryManual };
  }
  return d;
}

// ---------- unsaved changes ----------

function nonEmpty(map: Record<string, string>): [string, string][] {
  return Object.entries(map)
    .map(([k, v]) => [k, v.trim()] as [string, string])
    .filter(([, v]) => v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * What would be saved, as a string: two drafts with the same signature save the same entry.
 * Values typed for a method that is not selected do not count.
 */
export function draftSignature(d: EditorDraft): string {
  const s = d.split;
  let split: unknown = null;
  if (d.kind === 'expense') {
    switch (s.method) {
      case 'equal': split = [...s.included].sort(); break;
      case 'exact': split = nonEmpty(s.exact); break;
      case 'percent': split = nonEmpty(s.percent); break;
      case 'shares': split = nonEmpty(s.shares); break;
      case 'adjust': split = [[...s.included].sort(), nonEmpty(s.adjust)]; break;
      case 'items': split = s.items.filter(i => i.name.trim() || i.amountRaw.trim() || i.memberIds.length).map(i => [i.name.trim(), i.amountRaw.trim(), [...i.memberIds].sort()]); break;
    }
  }
  return JSON.stringify([
    d.kind,
    d.amountRaw.trim(),
    d.currency,
    d.description.trim(),
    d.kind === 'expense' ? d.category : '',
    d.date,
    d.notes.trim(),
    d.repeat,
    d.kind === 'payment' || d.payerMode === 'single' ? d.payerId : nonEmpty(d.payerAmounts),
    d.kind === 'payment' ? d.recipientId : '',
    d.kind === 'expense' ? s.method : '',
    split,
    d.fxManual.trim(),
  ]);
}

// ---------- history ----------

export type HistoryKind = 'created' | 'recurring' | 'deleted' | 'restored' | 'changed' | 'edited' | 'commented';

export interface HistoryLine {
  key: string;
  at: string;
  kind: HistoryKind;
  actorName: string;
  actorUserId: string | null;
  actorMemberId: string | null;
  /** For 'changed': the field and its display-ready values (category and repeat are keys). */
  field?: string;
  from?: string;
  to?: string;
  comment?: string;
}

/**
 * One line per thing that happened, oldest first: an edit that changed three fields gives three
 * lines. Comments are left out unless asked for (the detail page lists them separately).
 */
export function historyLines(items: readonly ActivityDTO[], opts: { comments?: boolean } = {}): HistoryLine[] {
  const out: HistoryLine[] = [];
  const sorted = [...items].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const a of sorted) {
    const base = { at: a.createdAt, actorName: a.actorName, actorUserId: a.userId, actorMemberId: a.memberId };
    switch (a.type) {
      case 'expense.create': out.push({ ...base, key: a.id, kind: 'created' }); break;
      case 'recurring.create': out.push({ ...base, key: a.id, kind: 'recurring' }); break;
      case 'expense.delete': out.push({ ...base, key: a.id, kind: 'deleted' }); break;
      case 'expense.restore': out.push({ ...base, key: a.id, kind: 'restored' }); break;
      case 'expense.update': {
        const changes = a.data.changes ?? [];
        if (!changes.length) out.push({ ...base, key: a.id, kind: 'edited' });
        changes.forEach((c, i) => out.push({ ...base, key: `${a.id}:${i}`, kind: 'changed', field: c.field, from: c.from, to: c.to }));
        break;
      }
      case 'comment.add':
        if (opts.comments) out.push({ ...base, key: a.id, kind: 'commented', comment: a.data.comment ?? '' });
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------- display helpers ----------

/**
 * The printed width of the amount being entered, in em of the money font (DESIGN.md 8.3,
 * `--amt-em`): 0.6 per glyph, minus 0.34 per separator (they are pulled in), the currency
 * prefix 0.36 per glyph (it prints at 0.6 em), plus 0.13 for the caret. The editor divides the
 * available width by it, so a long amount shrinks instead of overflowing.
 */
export function amountEm(prefix: string, body: string, opts: { caret?: boolean; equals?: boolean } = {}): number {
  let em = 0;
  for (const ch of body) {
    if (ch === ' ') continue;
    em += 0.6;
    if (ch === ',' || ch === '.') em -= 0.34;
  }
  em += [...prefix.replace(/\s+/g, '')].length * 0.36;
  if (opts.caret) em += 0.13;
  if (opts.equals) em += 0.42;
  return Math.max(1, Math.round(em * 1000) / 1000);
}

/** Decimals of a currency (0 for TWD, JPY...). */
export function decimalsOf(currency: string): number {
  return getCurrency(currency).decimals;
}
