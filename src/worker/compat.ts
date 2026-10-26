// Clients from before a new kind of entry (docs/SPEC.md section 6, Compatibility). A client lists
// the newer parts of the API it understands in the X-Evenly-Features request header, comma
// separated; today the only one is `refunds`. The iPhone app released before refunds decodes an
// entry's kind as expense or payment only, so one refund would break the whole group for it (the
// snapshot, the feed and an entry's history all fail to decode).
//
// A client that does not say `refunds` sees each refund as the expense with the same effect on every
// balance: its payers are whose money it is (the refund's split), its split is exact, the people
// who got the money back with what they got (the refund's payers), and its shares are those. A
// ¥30,000 deposit returned to Gino and split among four reads as Abbie, Kevin, Tiffany and Gino
// paying ¥7,500 each for something that is all Gino's. Every net, total and settle-up plan is the
// same; only the old app's own spending stats count it as spent. That app edits it as such, and
// routes/expenses.ts turns its save back into a refund (legacyFields, backToRefund).

import type { Portion, SplitInput } from '../shared/split';
import type { ActivityDTO, ExpenseDTO, GroupSnapshotDTO } from '../shared/types';

export const FEATURES_HEADER = 'X-Evenly-Features';

/** The features a request's client says it understands, lowercased. */
export function clientFeatures(header: string | null | undefined): Set<string> {
  return new Set((header ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * Whether the client that sent this request knows refunds (X-Evenly-Features lists `refunds`).
 * Takes any Hono context (typed by shape, so the web app's tests can import this file).
 */
export function knowsRefunds(c: { req: { header(name: string): string | undefined } }): boolean {
  return clientFeatures(c.req.header(FEATURES_HEADER)).has('refunds');
}

/** A refund's money in the roles of the expense with the same effect (see the top of this file). */
export function legacyRoles(refund: { payers: readonly Portion[]; shares: readonly Portion[] }): { payers: Portion[]; split: SplitInput; shares: Portion[] } {
  return {
    payers: refund.shares.map(s => ({ memberId: s.memberId, amount: s.amount })),
    split: { method: 'exact', entries: refund.payers.map(p => ({ memberId: p.memberId, value: p.amount })) },
    shares: refund.payers.map(p => ({ memberId: p.memberId, amount: p.amount })),
  };
}

/** An entry as a client without `refunds` sees it: a refund becomes its expense, the rest are as they are. */
export function legacyExpense(e: ExpenseDTO): ExpenseDTO {
  if (e.kind !== 'refund') return e;
  return { ...e, kind: 'expense', ...legacyRoles(e) };
}

export function expenseView(e: ExpenseDTO, refunds: boolean): ExpenseDTO {
  return refunds ? e : legacyExpense(e);
}

export function snapshotView(s: GroupSnapshotDTO, refunds: boolean): GroupSnapshotDTO {
  if (refunds || !s.expenses.some(e => e.kind === 'refund')) return s;
  return { ...s, expenses: s.expenses.map(legacyExpense) };
}

/**
 * An activity row as a client without `refunds` sees it: data.kind 'refund' reads 'expense', and so
 * does a refund in a change of kind (a change that is then from expense to expense is left out).
 * The nets are the same either way.
 */
export function activityView(a: ActivityDTO, refunds: boolean): ActivityDTO {
  const d = a.data;
  if (refunds || !d) return a;
  const kindChange = (d.changes ?? []).some(ch => ch.field === 'kind' && (ch.from === 'refund' || ch.to === 'refund'));
  if (d.kind !== 'refund' && !kindChange) return a;
  const data = { ...d };
  if (data.kind === 'refund') data.kind = 'expense';
  if (kindChange && data.changes) {
    const old = (k: string) => (k === 'refund' ? 'expense' : k);
    data.changes = data.changes
      .map(ch => (ch.field === 'kind' ? { ...ch, from: old(ch.from), to: old(ch.to) } : ch))
      .filter(ch => ch.field !== 'kind' || ch.from !== ch.to);
  }
  return { ...a, data };
}

/**
 * A group snapshot's ETag. The two views of one group version differ, so a client without
 * `refunds` gets its own tag ("12-legacy"), and an app that learns refunds in an update never keeps
 * the old view on a 304.
 */
export function snapshotETag(version: number, refunds: boolean): string {
  return refunds ? `"${version}"` : `"${version}-legacy"`;
}
