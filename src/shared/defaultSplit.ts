// A group's default split (docs/SPEC.md section 4, Default split): one per group, shared by its
// members; a new expense in the group starts from it. Pure. The Worker validates and stores it
// (routes/groups.ts), the web app applies it (features/expenses), and the iPhone app ports these
// rules as they are.
//
// - The methods are 平均 (over the members it lists), 比例 (percent) and 份數 (shares). Amounts,
//   adjustments and items are per expense only.
// - It lists its members by id. A member who joins later is not in it until someone edits it
//   (`newMembers` names them, so the editor can say so). A member who leaves is dropped from it
//   (the Worker writes that in the same batch as the leave, dropMember).
// - What remains must still be a valid split (percentages that add up to 100, a share above 0,
//   someone in it); otherwise it is not applied, and `problem` says why.
// - It may hold a default payer: a member, or null for whoever adds the expense.

import { computeShares, type SplitEntry, type SplitErrorCode, type SplitInput } from './split';

export type DefaultSplitMethod = 'equal' | 'percent' | 'shares';

export const DEFAULT_SPLIT_METHODS: readonly DefaultSplitMethod[] = ['equal', 'percent', 'shares'];

/** At most this many members in a default split (as in an expense's split). */
export const DEFAULT_SPLIT_MAX = 50;

/** The total a split is tried with to check it is valid (percent and shares do not depend on it). */
const PROBE_TOTAL = 1_000_000;

/** A group's default split as stored (groups.default_split) and sent (GroupDTO.defaultSplit). */
export interface DefaultSplit {
  method: DefaultSplitMethod;
  /** Its members in display order; `value` is the percentage (0 to 100) or the share count (>= 0), none for 平均. */
  entries: SplitEntry[];
  /** The member who pays by default, or null: whoever adds the expense. */
  payerId: string | null;
  /** When it was last set (ISO 8601): members who joined after this are not in it. */
  setAt: string;
}

/** What a client sends to set one (UpdateGroupReq.defaultSplit); the Worker adds setAt. */
export interface DefaultSplitInput {
  method: DefaultSplitMethod;
  entries: { memberId: string; value?: number | null }[];
  payerId?: string | null;
}

export type DefaultSplitErrorCode = SplitErrorCode | 'unknown_member' | 'unknown_payer' | 'bad_method' | 'too_many';

export type DefaultSplitCheck =
  | { ok: true; value: Omit<DefaultSplit, 'setAt'> }
  | { ok: false; code: DefaultSplitErrorCode; memberId?: string; diff?: number };

function isMethod(m: unknown): m is DefaultSplitMethod {
  return typeof m === 'string' && (DEFAULT_SPLIT_METHODS as readonly string[]).includes(m);
}

/** The split input a default stands for (its entries as they are). */
export function defaultSplitInput(d: Pick<DefaultSplit, 'method' | 'entries'>): SplitInput {
  return d.method === 'equal'
    ? { method: 'equal', entries: d.entries.map(e => ({ memberId: e.memberId })) }
    : { method: d.method, entries: d.entries.map(e => ({ memberId: e.memberId, value: e.value })) };
}

/**
 * A default split to store, from what a client sent, for a group whose active members are
 * `activeIds`: only those members, each once; 平均 keeps no values; 比例 and 份數 drop the members
 * at 0 (as an expense's split does) and must still be a valid split; the payer is null or an active
 * member. The first problem found, else the value to store (without setAt).
 */
export function checkDefaultSplit(input: DefaultSplitInput, activeIds: Iterable<string>): DefaultSplitCheck {
  const active = new Set(activeIds);
  if (!isMethod(input.method)) return { ok: false, code: 'bad_method' };
  const list = Array.isArray(input.entries) ? input.entries : [];
  if (list.length > DEFAULT_SPLIT_MAX) return { ok: false, code: 'too_many' };
  const seen = new Set<string>();
  const entries: SplitEntry[] = [];
  for (const e of list) {
    if (!e || typeof e.memberId !== 'string' || !active.has(e.memberId)) return { ok: false, code: 'unknown_member', memberId: e?.memberId };
    if (seen.has(e.memberId)) return { ok: false, code: 'duplicate_member', memberId: e.memberId };
    seen.add(e.memberId);
    if (input.method === 'equal') {
      entries.push({ memberId: e.memberId });
      continue;
    }
    const v = e.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, code: 'invalid_value', memberId: e.memberId };
    if (v !== 0) entries.push({ memberId: e.memberId, value: v });
  }
  const r = computeShares(PROBE_TOTAL, defaultSplitInput({ method: input.method, entries }));
  if (!r.ok) return r.diff === undefined ? { ok: false, code: r.code } : { ok: false, code: r.code, diff: r.diff };
  const payerId = input.payerId ?? null;
  if (payerId !== null && (typeof payerId !== 'string' || !active.has(payerId))) return { ok: false, code: 'unknown_payer', memberId: String(payerId) };
  return { ok: true, value: { method: input.method, entries, payerId } };
}

/** groups.default_split as stored, or null (missing, not JSON, or not the shape). */
export function parseDefaultSplit(raw: string | null | undefined): DefaultSplit | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isMethod(o.method) || !Array.isArray(o.entries) || typeof o.setAt !== 'string') return null;
  const entries: SplitEntry[] = [];
  for (const e of o.entries as unknown[]) {
    if (!e || typeof e !== 'object' || typeof (e as SplitEntry).memberId !== 'string') return null;
    const value = (e as SplitEntry).value;
    entries.push(typeof value === 'number' && Number.isFinite(value) && o.method !== 'equal' ? { memberId: (e as SplitEntry).memberId, value } : { memberId: (e as SplitEntry).memberId });
  }
  const payerId = typeof o.payerId === 'string' ? o.payerId : null;
  return { method: o.method, entries, payerId, setAt: o.setAt };
}

/** The same default (method, members, values and payer; when it was set does not count). */
export function sameDefaultSplit(a: Omit<DefaultSplit, 'setAt'> | null, b: Omit<DefaultSplit, 'setAt'> | null): boolean {
  if (!a || !b) return a === b;
  if (a.method !== b.method || (a.payerId ?? null) !== (b.payerId ?? null) || a.entries.length !== b.entries.length) return false;
  return a.entries.every((e, i) => e.memberId === b.entries[i].memberId && (a.method === 'equal' || e.value === b.entries[i].value));
}

/**
 * The default without a member who left: out of its entries, and no longer its payer. null when
 * nobody is left in it. The same object when the member was not in it.
 */
export function dropMember(d: DefaultSplit, memberId: string): DefaultSplit | null {
  const inIt = d.entries.some(e => e.memberId === memberId);
  if (!inIt && d.payerId !== memberId) return d;
  const entries = d.entries.filter(e => e.memberId !== memberId);
  if (!entries.length) return null;
  return { ...d, entries, payerId: d.payerId === memberId ? null : d.payerId };
}

/** A member as the rules need it (MemberDTO has these fields). */
export interface DefaultSplitMember {
  id: string;
  active: boolean;
  /** When the member was added to the group (ISO 8601). */
  createdAt: string;
}

export interface AppliedDefault {
  /** The split a new expense starts from, or null when what remains is not a valid split (`problem`). */
  split: SplitInput | null;
  /** The payer a new expense starts from, or null: whoever adds it. */
  payerId: string | null;
  /** Active members who joined after the default was set: they are not in it. */
  newMembers: string[];
  /** Why `split` is null (computeShares' code, and for percent_mismatch the points left). */
  problem: { code: SplitErrorCode; diff?: number } | null;
}

/**
 * How a new expense starts in a group with this default (null: the group has none): only its
 * members who are still active, the payer if still active, which active members are new since it
 * was set, and whether what remains is still a valid split.
 */
export function applyDefaultSplit(d: DefaultSplit | null | undefined, members: readonly DefaultSplitMember[]): AppliedDefault | null {
  if (!d) return null;
  const active = new Set(members.filter(m => m.active).map(m => m.id));
  const entries = d.entries.filter(e => active.has(e.memberId));
  const listed = new Set(entries.map(e => e.memberId));
  const newMembers = members.filter(m => m.active && !listed.has(m.id) && m.createdAt > d.setAt).map(m => m.id);
  const payerId = d.payerId && active.has(d.payerId) ? d.payerId : null;
  const split = defaultSplitInput({ method: d.method, entries });
  if (!entries.length) return { split: null, payerId, newMembers, problem: { code: 'no_participants' } };
  const r = computeShares(PROBE_TOTAL, split);
  if (!r.ok) return { split: null, payerId, newMembers, problem: r.diff === undefined ? { code: r.code } : { code: r.code, diff: r.diff } };
  return { split, payerId, newMembers, problem: null };
}

/**
 * A default as language-neutral text, for the 'group.update' activity line clients from before
 * default splits show as it is: "Gino, Abbie", "Gino 60%, Abbie 40%", "Gino x2, Abbie x1", '' for none.
 */
export function defaultSplitText(d: Pick<DefaultSplit, 'method' | 'entries'> | null, nameOf: (memberId: string) => string): string {
  if (!d) return '';
  return d.entries
    .map(e => (d.method === 'percent' ? `${nameOf(e.memberId)} ${e.value}%` : d.method === 'shares' ? `${nameOf(e.memberId)} x${e.value}` : nameOf(e.memberId)))
    .join(', ');
}
