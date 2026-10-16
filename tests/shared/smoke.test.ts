import { describe, expect, it } from 'vitest';
import { allocate } from '../../src/shared/alloc';
import { computeShares } from '../../src/shared/split';
import { netBalances, convertMinor } from '../../src/shared/balances';
import { simplifyDebts, pairwiseDebts } from '../../src/shared/settle';
import { parseAmount, formatMoney } from '../../src/shared/money';
import { detectCategory } from '../../src/shared/categories';
import { nextOccurrence } from '../../src/shared/dates';

describe('smoke', () => {
  it('allocates exactly with payer priority', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(100, [1, 1, 1], [2])).toEqual([33, 33, 34]);
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
  });

  it('splits NT$1000 three ways with the payer absorbing rounding', () => {
    const r = computeShares(1000, { method: 'equal', entries: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }] }, ['b']);
    expect(r).toEqual({ ok: true, shares: [{ memberId: 'a', amount: 333 }, { memberId: 'b', amount: 334 }, { memberId: 'c', amount: 333 }] });
  });

  it('nets to zero and simplifies', () => {
    const entries = [
      { id: '1', kind: 'expense' as const, amount: 1000, currency: 'TWD', fxRate: 1, payers: [{ memberId: 'a', amount: 1000 }], shares: [{ memberId: 'a', amount: 334 }, { memberId: 'b', amount: 333 }, { memberId: 'c', amount: 333 }] },
      { id: '2', kind: 'expense' as const, amount: 600, currency: 'TWD', fxRate: 1, payers: [{ memberId: 'b', amount: 600 }], shares: [{ memberId: 'b', amount: 300 }, { memberId: 'c', amount: 300 }] },
    ];
    const net = netBalances(entries, 'TWD', ['a', 'b', 'c']);
    expect(net).toEqual({ a: 666, b: -33, c: -633 });
    const plan = simplifyDebts(net, ['a', 'b', 'c']);
    expect(plan.reduce((s, t) => s + t.amount, 0)).toBe(666);
    const pw = pairwiseDebts(entries, 'TWD', ['a', 'b', 'c']);
    expect(pw).toEqual([
      { from: 'b', to: 'a', amount: 333 },
      { from: 'c', to: 'a', amount: 333 },
      { from: 'c', to: 'b', amount: 300 },
    ]);
  });

  it('converts and parses', () => {
    expect(convertMinor(1000000, 'JPY', 0.2105, 'TWD')).toBe(210500);
    expect(convertMinor(1250, 'USD', 31.5, 'TWD')).toBe(394);
    expect(parseAmount('1,234.5', 'USD')).toBe(123450);
    expect(parseAmount('１２００+３５０', 'TWD')).toBe(1550);
    expect(parseAmount('12,5', 'EUR')).toBe(1250);
    expect(formatMoney(125050, 'USD', 'en')).toBe('US$1,250.50');
    expect(formatMoney(-1200, 'TWD', 'zh-TW')).toBe('-NT$1,200');
  });

  it('detects categories and recurrences', () => {
    expect(detectCategory('燒肉晚餐')).toBe('food.dining');
    expect(detectCategory('Uber to airport')).toBe('transport.taxi');
    expect(detectCategory('Car rental + gas + toll')).toBe('transport.car');
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-02-10')).toBe('2026-02-28');
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-02-28')).toBe('2026-03-31');
  });
});
