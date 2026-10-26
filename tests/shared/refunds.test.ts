// 退款 (docs/SPEC.md section 2, Refunds): a refund is exactly a negative expense. The contract's
// example, Gino getting back a ¥30,000 deposit that four people paid equally, worked through the
// balance math, the settle-up plans (simplified and pairwise), spending, one person's effect, a
// refund in another currency, and the refund words (refundDescription, refundSubject). The
// compatibility view old clients get (src/worker/compat.ts) must have the same effect on every
// balance, which a property test checks over random refunds.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { entryNet, ledgerKind, memberEffect, netBalances, spendTotals, toBase, type LedgerEntry } from '../../src/shared/balances';
import { refundDescription, refundSubject } from '../../src/shared/refunds';
import { pairwiseDebts, settlementPlan, simplifyDebts } from '../../src/shared/settle';
import { computeSharesFor, type Portion } from '../../src/shared/split';
import { computeGroupSummary } from '../../src/shared/summary';
import { legacyExpense } from '../../src/worker/compat';
import type { ExpenseDTO } from '../../src/shared/types';

const FOUR = ['gino', 'abbie', 'kevin', 'tiffany'];

function shares(id: string, amount: number, ids: readonly string[] = FOUR): Portion[] {
  const r = computeSharesFor(id, amount, { method: 'equal', entries: ids.map(memberId => ({ memberId })) });
  if (!r.ok) throw new Error(r.code);
  return r.shares;
}

/** The deposit coming back: ¥30,000 to Gino, the four people's money equally. */
const REFUND: LedgerEntry = {
  id: 'r-deposit',
  kind: 'refund',
  amount: 30000,
  currency: 'JPY',
  fxRate: 1,
  payers: [{ memberId: 'gino', amount: 30000 }],
  shares: shares('r-deposit', 30000),
  category: 'travel.hotel',
  date: '2026-10-20',
};

/** The deposit Gino paid for the four at the start. */
const DEPOSIT: LedgerEntry = { ...REFUND, id: 'e-deposit', kind: 'expense', shares: shares('e-deposit', 30000), date: '2026-10-01' };

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

describe('the ¥30,000 example', () => {
  it('Gino owes each of the other three ¥7,500', () => {
    const net = netBalances([REFUND], 'JPY', FOUR);
    expect(net).toEqual({ gino: -22500, abbie: 7500, kevin: 7500, tiffany: 7500 });
    expect(sum(net)).toBe(0);
  });

  it('toBase gives the refund with every amount below zero, and never -0', () => {
    const b = toBase(REFUND, 'JPY');
    expect(b.total).toBe(-30000);
    expect(b.paid).toEqual([{ memberId: 'gino', amount: -30000 }]);
    expect(b.owed.map(o => o.amount)).toEqual([-7500, -7500, -7500, -7500]);
    const zero = toBase({ ...REFUND, currency: 'USD', fxRate: 0.0000001, amount: 1, payers: [{ memberId: 'gino', amount: 1 }], shares: [{ memberId: 'abbie', amount: 1 }] }, 'JPY');
    expect(Object.is(zero.total, -0)).toBe(false);
    expect(zero.paid.every(p => !Object.is(p.amount, -0))).toBe(true);
  });

  it('settles as three transfers from Gino, simplified or pairwise', () => {
    const net = netBalances([REFUND], 'JPY', FOUR);
    const plan = [
      { from: 'gino', to: 'abbie', amount: 7500 },
      { from: 'gino', to: 'kevin', amount: 7500 },
      { from: 'gino', to: 'tiffany', amount: 7500 },
    ];
    expect(simplifyDebts(net, FOUR)).toEqual(plan);
    expect(pairwiseDebts([REFUND], 'JPY', FOUR)).toEqual(plan);
    expect(settlementPlan([REFUND], 'JPY', net, true, FOUR)).toEqual(plan);
  });

  it('cancels the deposit it refunds: everyone is back to even and nothing was spent', () => {
    const net = netBalances([DEPOSIT, REFUND], 'JPY', FOUR);
    expect(net).toEqual({ gino: 0, abbie: 0, kevin: 0, tiffany: 0 });
    const s = computeGroupSummary({ currency: 'JPY', simplify: true, memberOrder: FOUR, entries: [DEPOSIT, REFUND], forVersion: 3 });
    expect(s.spent).toBe(0);
    expect(s.transfers).toEqual([]);
    expect(s.count).toBe(2);
    expect(s.paid).toEqual({ gino: 0 });
    expect(s.share).toEqual({ gino: 0, abbie: 0, kevin: 0, tiffany: 0 });
  });

  it('each person\'s effect: the receiver gives back 22,500, the others get back 7,500', () => {
    expect(memberEffect(REFUND, 'gino')).toEqual({ involved: true, paid: -30000, owed: -7500, net: -22500 });
    expect(memberEffect(REFUND, 'abbie')).toEqual({ involved: true, paid: 0, owed: -7500, net: 7500 });
    expect(memberEffect(REFUND, 'lily')).toEqual({ involved: false, paid: 0, owed: 0, net: 0 });
    expect(Object.fromEntries(entryNet(REFUND, 'JPY'))).toEqual({ gino: -22500, abbie: 7500, kevin: 7500, tiffany: 7500 });
  });
});

describe('stats: refunds subtract from spending and from their category', () => {
  const dinner: LedgerEntry = {
    id: 'e-dinner', kind: 'expense', amount: 12000, currency: 'JPY', fxRate: 1, category: 'food.dining',
    payers: [{ memberId: 'abbie', amount: 12000 }], shares: shares('e-dinner', 12000),
  };
  const payment: LedgerEntry = {
    id: 'p-1', kind: 'payment', amount: 5000, currency: 'JPY', fxRate: 1, category: 'payment',
    payers: [{ memberId: 'gino', amount: 5000 }], shares: [{ memberId: 'abbie', amount: 5000 }],
  };

  it('total, categories, paid and share', () => {
    const t = spendTotals([DEPOSIT, dinner, REFUND, payment], 'JPY');
    expect(t.spent).toBe(30000 + 12000 - 30000);
    expect(t.byCategory).toEqual({ 'travel.hotel': 0, 'food.dining': 12000 });
    expect(t.paid).toEqual({ gino: 0, abbie: 12000 });
    expect(t.share).toEqual({ gino: 3000, abbie: 3000, kevin: 3000, tiffany: 3000 });
  });

  it('a refund alone is negative spending (a partial refund of a booking paid elsewhere)', () => {
    const t = spendTotals([REFUND], 'JPY');
    expect(t.spent).toBe(-30000);
    expect(t.byCategory).toEqual({ 'travel.hotel': -30000 });
  });

  it('a deleted refund counts for nothing', () => {
    const t = spendTotals([DEPOSIT, { ...REFUND, deletedAt: '2026-10-21T00:00:00.000Z' }], 'JPY');
    expect(t.spent).toBe(30000);
    expect(netBalances([{ ...REFUND, deletedAt: '2026-10-21T00:00:00.000Z' }], 'JPY', FOUR)).toEqual({ gino: 0, abbie: 0, kevin: 0, tiffany: 0 });
  });
});

describe('currency: a refund in another currency uses the expense rules, negated', () => {
  const usd: LedgerEntry = {
    id: 'r-usd', kind: 'refund', amount: 10001, currency: 'USD', fxRate: 149.37, category: 'transport',
    payers: [{ memberId: 'abbie', amount: 6001 }, { memberId: 'gino', amount: 4000 }], shares: shares('r-usd', 10001, ['gino', 'abbie', 'kevin']),
  };

  it('converts once like the same expense, every amount negated, and nets to zero', () => {
    const asExpense = toBase({ ...usd, kind: 'expense' }, 'JPY');
    const b = toBase(usd, 'JPY');
    // US$100.01 x 149.37 = ¥14,938.49
    expect(asExpense.total).toBe(14938);
    expect(b.total).toBe(-asExpense.total);
    expect(b.paid.map(p => p.amount)).toEqual(asExpense.paid.map(p => -p.amount));
    expect(b.owed.map(o => o.amount)).toEqual(asExpense.owed.map(o => -o.amount));
    const net = netBalances([usd], 'JPY', ['gino', 'abbie', 'kevin']);
    expect(sum(net)).toBe(0);
    expect(spendTotals([usd], 'JPY').spent).toBe(-14938);
  });

  it('an expense and its full refund in the same currency and rate cancel to the unit', () => {
    const net = netBalances([{ ...usd, id: 'r-usd', kind: 'expense' }, usd], 'JPY', ['gino', 'abbie', 'kevin']);
    expect(net).toEqual({ gino: 0, abbie: 0, kevin: 0 });
  });
});

describe('ledgerKind', () => {
  it('reads payment and refund as such and anything else as an expense', () => {
    expect(ledgerKind('payment')).toBe('payment');
    expect(ledgerKind('refund')).toBe('refund');
    expect(ledgerKind('expense')).toBe('expense');
    expect(ledgerKind('')).toBe('expense');
    expect(ledgerKind('transfer')).toBe('expense');
  });
});

describe('the words', () => {
  it('refundDescription prefills 「退款：<original>」 / "Refund: <original>", at most 120', () => {
    expect(refundDescription('押金', 'zh-TW')).toBe('退款：押金');
    expect(refundDescription('  Deposit ', 'en')).toBe('Refund: Deposit');
    const long = refundDescription('房'.repeat(130), 'zh-TW');
    expect(long.length).toBe(120);
    expect(long.startsWith('退款：房')).toBe(true);
    // An emoji at the cut is left out whole, never split.
    const emoji = refundDescription('x'.repeat(109) + '🏨🏨', 'en');
    expect(emoji).toBe('Refund: ' + 'x'.repeat(109) + '🏨');
    expect(emoji.length).toBe(119);
  });

  it('refundSubject drops the prefix, and the bare word', () => {
    expect(refundSubject('退款：押金')).toBe('押金');
    expect(refundSubject('退款: 押金')).toBe('押金');
    expect(refundSubject('Refund: Deposit')).toBe('Deposit');
    expect(refundSubject('refund:Deposit')).toBe('Deposit');
    expect(refundSubject('押金退回')).toBe('押金退回');
    expect(refundSubject('退款')).toBe('');
    expect(refundSubject(' Refund ')).toBe('');
    expect(refundSubject('退款：')).toBe('');
  });
});

// ---------- the view old clients get ----------

function dto(e: LedgerEntry, split: ExpenseDTO['split']): ExpenseDTO {
  return {
    id: e.id, groupId: 'g', kind: e.kind, description: '退款：押金', category: e.category ?? 'general', amount: e.amount, currency: e.currency,
    fxRate: e.fxRate, date: e.date ?? '2026-10-20', notes: '', payers: e.payers, split, shares: e.shares, repeat: 'none', repeatSeries: null,
    repeatStart: null, createdBy: 'u', createdAt: '', updatedBy: 'u', updatedAt: '', deletedAt: null, deletedBy: null, version: 1, commentCount: 0,
    refundOf: 'e-deposit', receipt: null,
  };
}

describe('legacyExpense (src/worker/compat.ts)', () => {
  it('shows the ¥30,000 refund as the expense the four paid for Gino', () => {
    const old = legacyExpense(dto(REFUND, { method: 'equal', entries: FOUR.map(memberId => ({ memberId })) }));
    expect(old.kind).toBe('expense');
    expect(old.payers).toEqual(REFUND.shares);
    expect(old.split).toEqual({ method: 'exact', entries: [{ memberId: 'gino', value: 30000 }] });
    expect(old.shares).toEqual([{ memberId: 'gino', amount: 30000 }]);
    expect(Object.fromEntries(entryNet(old, 'JPY'))).toEqual(Object.fromEntries(entryNet(REFUND, 'JPY')));
    // Its split is one the server computes the same shares from.
    const r = computeSharesFor(old.id, old.amount, old.split);
    expect(r.ok && r.shares).toEqual(old.shares);
    // Expenses and payments come through untouched.
    const exp = dto(DEPOSIT, { method: 'equal', entries: [] });
    expect(legacyExpense(exp)).toBe(exp);
  });

  it('has the same effect on every balance as the refund, for any refund in any currency', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const portionsArb = (amount: number) =>
      fc.array(fc.integer({ min: 0, max: 9 }), { minLength: ids.length, maxLength: ids.length }).map(w => {
        const weights = w.every(x => x === 0) ? w.map((_, i) => (i === 0 ? 1 : 0)) : w;
        const W = weights.reduce((a, b) => a + b, 0);
        const out = ids.map((memberId, i) => ({ memberId, amount: Math.floor((amount * weights[i]) / W) }));
        out[weights.findIndex(x => x > 0)].amount += amount - out.reduce((a, p) => a + p.amount, 0);
        return out.filter(p => p.amount > 0);
      });
    const arb = fc
      .record({
        id: fc.string({ minLength: 8, maxLength: 12 }),
        amount: fc.integer({ min: 1, max: 5_000_000 }),
        currency: fc.constantFrom('JPY', 'USD', 'TWD', 'EUR', 'KRW'),
        rate: fc.double({ min: -3, max: 3, noNaN: true }).map(u => Number(Math.pow(10, u).toPrecision(6))),
      })
      .chain(r => fc.tuple(fc.constant(r), portionsArb(r.amount), portionsArb(r.amount)));
    fc.assert(
      fc.property(arb, ([r, payers, owed]) => {
        const refund: LedgerEntry = { id: r.id, kind: 'refund', amount: r.amount, currency: r.currency, fxRate: r.currency === 'JPY' ? 1 : r.rate, payers, shares: owed };
        const old = legacyExpense(dto(refund, { method: 'exact', entries: owed.map(o => ({ memberId: o.memberId, value: o.amount })) }));
        const a = Object.fromEntries(entryNet(refund, 'JPY'));
        const b = Object.fromEntries(entryNet(old, 'JPY'));
        for (const id of ids) expect(b[id] ?? 0).toBe(a[id] ?? 0);
      }),
      { numRuns: 400 },
    );
  });
});
