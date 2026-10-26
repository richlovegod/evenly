// 旅行結算圖卡 (features/groups/settleCard.ts): what the summary card says about a group and where its
// parts go, the same rules as the iPhone app's (Views/Settle/SettleCard.swift and SettleCardView.swift):
// spending is expenses less refunds (payments are not spending), the days come from expenses and
// refunds, people in the group's order with their own names (never 你), the top 3 categories, the
// plan 結算 shows, and the folds: more than 8 people show 7 and 「還有 N 人」, more than 6 payments
// show 5 and 「還有 N 筆」. Then the row heights and the room left over, the date range in both
// languages, the file name and the tints.

import { describe, expect, it } from 'vitest';
import { computeSharesFor, type SplitInput } from '../../src/shared/split';
import type { ExpenseDTO, GroupSnapshotDTO, MemberDTO } from '../../src/shared/types';
import {
  CARD_H, LAYOUT, PAYMENT_LINES, PEOPLE_LINES, cardCategoryFill, cardDateRange, cardFileName, cardInitial, cardLayout, cardTint,
  paymentLineCount, peopleLineCount, settleCardData,
} from '../../src/web/features/groups/settleCard';

function member(id: string, i: number, over: Partial<MemberDTO> = {}): MemberDTO {
  return {
    id, groupId: 'g1', userId: i === 0 ? 'u-gino' : null, name: id[0].toUpperCase() + id.slice(1), color: '#2F6FB5', role: 'member', active: true,
    sort: i, createdAt: '2026-10-01T00:00:00.000Z', claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null, ...over,
  };
}

let n = 0;
function entry(over: Partial<ExpenseDTO> & Pick<ExpenseDTO, 'amount' | 'payers'>): ExpenseDTO {
  const id = over.id ?? `e-${++n}`;
  const split: SplitInput = over.split ?? { method: 'equal', entries: (over.shares ?? []).map(s => ({ memberId: s.memberId })) };
  const r = computeSharesFor(id, over.amount, split);
  return {
    id, groupId: 'g1', kind: 'expense', description: 'x', category: 'general', currency: 'JPY', fxRate: 1, date: '2026-10-10', notes: '',
    split, shares: r.ok ? r.shares : [], repeat: 'none', repeatSeries: null, repeatStart: null, createdBy: 'u', createdAt: '', updatedBy: 'u',
    updatedAt: '', deletedAt: null, deletedBy: null, version: 1, commentCount: 0, refundOf: null, receipt: null, ...over,
  };
}

function snap(members: MemberDTO[], expenses: ExpenseDTO[], over: Partial<GroupSnapshotDTO['group']> = {}): GroupSnapshotDTO {
  return {
    group: { id: 'g1', name: '北海道滑雪', type: 'trip', currency: 'JPY', emoji: '⛷️', color: '#A8D3E6', simplify: true, notes: '', createdBy: 'u-gino', createdAt: '', updatedAt: '', version: 3, defaultSplit: null, ...over },
    members,
    expenses,
    me: { memberId: members[0].id, role: 'admin' },
    inviteCode: 'X',
  };
}

const four = ['gino', 'abbie', 'kevin', 'tiffany'].map((id, i) => member(id, i));
const equalFour: SplitInput = { method: 'equal', entries: four.map(m => ({ memberId: m.id })) };

describe('what the card says', () => {
  const dinner = entry({ id: 'e-dinner', amount: 9000, payers: [{ memberId: 'abbie', amount: 9000 }], split: equalFour, category: 'food.dining', date: '2026-10-09' });
  const ski = entry({ id: 'e-ski', amount: 24000, payers: [{ memberId: 'kevin', amount: 24000 }], split: equalFour, category: 'travel.ski', date: '2026-10-10' });
  const deposit = entry({ id: 'e-dep', amount: 30000, payers: [{ memberId: 'gino', amount: 30000 }], split: equalFour, category: 'travel.hotel', date: '2026-10-08' });
  const refund = entry({ id: 'r-dep', kind: 'refund', amount: 30000, payers: [{ memberId: 'gino', amount: 30000 }], split: equalFour, category: 'travel.hotel', date: '2026-10-11', refundOf: 'e-dep' });
  const payment = entry({ id: 'p-1', kind: 'payment', category: 'payment', amount: 1000, payers: [{ memberId: 'tiffany', amount: 1000 }], split: { method: 'exact', entries: [{ memberId: 'abbie', value: 1000 }] }, date: '2026-10-20' });

  it('spending is expenses less refunds, payments are not spending, and the days skip payments', () => {
    const c = settleCardData(snap(four, [dinner, ski, deposit, refund, payment]), [{ from: 'gino', to: 'kevin', amount: 8250 }]);
    expect(c.spent).toBe(33000);
    expect(c.firstDate).toBe('2026-10-08');
    expect(c.lastDate).toBe('2026-10-11');
    expect(c.categories).toEqual([{ key: 'travel.ski', amount: 24000 }, { key: 'food.dining', amount: 9000 }]);
    expect(c.people.map(p => [p.name, p.paid, p.share])).toEqual([
      ['Gino', 0, 8250], ['Abbie', 9000, 8250], ['Kevin', 24000, 8250], ['Tiffany', 0, 8250],
    ]);
    expect(c.payments).toEqual([{ from: c.people[0], to: c.people[2], amount: 8250 }]);
    expect(c).toMatchObject({ trip: true, currency: 'JPY', emoji: '⛷️', name: '北海道滑雪', morePeople: null, morePayments: 0 });
  });

  it('names everyone by name, never 你, and keeps people who left while their money counts', () => {
    const left = member('leo', 4, { active: false });
    const gone = member('mia', 5, { active: false });
    const leoPaid = entry({ amount: 4000, payers: [{ memberId: 'leo', amount: 4000 }], split: { method: 'equal', entries: [{ memberId: 'leo' }, { memberId: 'gino' }] } });
    const c = settleCardData(snap([...four, left, gone], [leoPaid]), []);
    expect(c.people.map(p => p.name)).toEqual(['Gino', 'Abbie', 'Kevin', 'Tiffany', 'Leo']);
    expect(c.people.some(p => p.name === '你')).toBe(false);
  });

  it('the top 3 categories, largest first, ties by key, none at zero or below', () => {
    const e = (category: string, amount: number) => entry({ amount, payers: [{ memberId: 'gino', amount }], split: equalFour, category });
    const c = settleCardData(snap(four, [e('food.dining', 500), e('transport.taxi', 900), e('food.drinks', 900), e('life.gifts', 100), deposit, refund]), []);
    expect(c.categories).toEqual([{ key: 'food.drinks', amount: 900 }, { key: 'transport.taxi', amount: 900 }, { key: 'food.dining', amount: 500 }]);
  });

  it('an empty group: nothing spent, no days, no categories, settled', () => {
    const c = settleCardData(snap(four, []), []);
    expect(c).toMatchObject({ spent: 0, firstDate: null, lastDate: null, categories: [], payments: [], morePayments: 0 });
    expect(c.people).toHaveLength(4);
  });

  it(`folds past ${PEOPLE_LINES} people and ${PAYMENT_LINES} payments, adding up the folded people`, () => {
    const ten = Array.from({ length: 10 }, (_, i) => member('m' + i, i));
    const all: SplitInput = { method: 'equal', entries: ten.map(m => ({ memberId: m.id })) };
    const big = entry({ amount: 100000, payers: [{ memberId: 'm0', amount: 100000 }], split: all });
    const plan = ten.slice(1).map(m => ({ from: m.id, to: 'm0', amount: 10000 }));
    const c = settleCardData(snap(ten, [big]), plan);
    expect(c.people).toHaveLength(7);
    expect(c.morePeople).toEqual({ count: 3, paid: 0, share: 30000 });
    expect(peopleLineCount(c)).toBe(8);
    expect(c.payments).toHaveLength(5);
    expect(c.morePayments).toBe(4);
    expect(paymentLineCount(c)).toBe(6);
    // Exactly 8 people and 6 payments fit without a fold.
    const eight = ten.slice(0, 8);
    const c8 = settleCardData(snap(eight, [entry({ amount: 80000, payers: [{ memberId: 'm0', amount: 80000 }], split: { method: 'equal', entries: eight.map(m => ({ memberId: m.id })) } })]), plan.slice(0, 6));
    expect(c8.people).toHaveLength(8);
    expect(c8.morePeople).toBeNull();
    expect(c8.payments).toHaveLength(6);
    expect(c8.morePayments).toBe(0);
  });
});

describe('where the parts go', () => {
  it('rows get shorter as the lists get longer, and the room left over is shared out', () => {
    const base = settleCardData(snap(four, []), []);
    const l = cardLayout(base);
    // 4 people and the settled stamp: 4 lines.
    expect(l.row).toBe(72);
    expect(l.people).toBe(2 * 18 + 50 + 4 * 72);
    expect(l.plan).toBe(2 * 18 + 50 + LAYOUT.settled);
    const spare = CARD_H - LAYOUT.ground - LAYOUT.header - LAYOUT.summary - l.people - l.plan;
    expect(l.top).toBeCloseTo(28 + (spare - 76) / 5);
    expect(l.gap).toBeCloseTo(16 + (spare - 76) / 5);
    expect(l.summaryTop).toBeCloseTo(l.top + LAYOUT.header + l.gap);
    expect(l.avatar).toBe(48);
    expect(l.mascot).toBe(176);
    // Everything stacked ends above the ground.
    expect(l.top + LAYOUT.header + l.gap + LAYOUT.summary + l.gap + l.people + l.gap + l.plan).toBeLessThanOrEqual(CARD_H - LAYOUT.ground + 0.001);
  });

  it('the longest card (8 lines of people, 6 of payments) still fits, with the smallest rows', () => {
    const ten = Array.from({ length: 10 }, (_, i) => member('m' + i, i));
    const plan = ten.slice(1).map(m => ({ from: m.id, to: 'm0', amount: 10000 }));
    const l = cardLayout(settleCardData(snap(ten, []), plan));
    expect(l.row).toBe(45);
    expect(l.avatar).toBe(39);
    // 1350 - 104 - 112 - 220 - 446 - 356 = 112 to spare, 36 over the minimum: 7.2 more per space.
    expect(l.top).toBeCloseTo(35.2);
    expect(l.gap).toBeCloseTo(23.2);
    // Less room above the summary card: the mascot is shorter than its tallest.
    expect(l.mascot).toBeCloseTo(35.2 + 112 + 23.2 - 12);
    expect(l.top + LAYOUT.header + l.gap + LAYOUT.summary + l.gap + l.people + l.gap + l.plan).toBeLessThanOrEqual(CARD_H - LAYOUT.ground);
  });
});

describe('the words and colors', () => {
  it('the days, in both languages', () => {
    expect(cardDateRange('2026-10-09', '2026-10-11', true)).toBe('2026/10/9～10/11');
    expect(cardDateRange('2026-10-09', '2026-10-09', true)).toBe('2026/10/9');
    expect(cardDateRange('2026-12-30', '2027-01-02', true)).toBe('2026/12/30～2027/1/2');
    expect(cardDateRange('2026-07-01', '2026-07-05', false)).toBe('Jul 1 to Jul 5, 2026');
    expect(cardDateRange('2026-07-01', '2026-07-01', false)).toBe('Jul 1, 2026');
    expect(cardDateRange('2026-12-30', '2027-01-02', false)).toBe('Dec 30, 2026 to Jan 2, 2027');
  });

  it('the file name, without what a file name cannot hold', () => {
    expect(cardFileName('北海道滑雪', true, '吉諾分帳所')).toBe('北海道滑雪 結算圖卡.png');
    expect(cardFileName('Trip: 2026/10 "ski"', false, "Gino's Split Lab")).toBe('Trip 2026 10 ski summary card.png');
    expect(cardFileName('  ', true, '吉諾分帳所')).toBe('吉諾分帳所 結算圖卡.png');
  });

  it('initials, tints and category fills', () => {
    expect(cardInitial('abbie')).toBe('A');
    expect(cardInitial(' 佳穎')).toBe('佳');
    expect(cardInitial('')).toBe('?');
    // 30% of the color into paper (#FFFCF6), as the app's avatars mix it.
    expect(cardTint('#000000')).toBe('#B3B0AC');
    expect(cardTint('#FFFCF6')).toBe('#FFFCF6');
    expect(cardTint('nope')).toBe('#FCF1D3');
    expect(cardCategoryFill('food')).toBe('#FCF1D3');
    expect(cardCategoryFill('transport')).toBe('#E6F2F8');
    expect(cardCategoryFill('other')).toBe('#FFFCF6');
  });
});
