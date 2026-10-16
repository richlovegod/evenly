import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  activePreset,
  amountEm,
  clip,
  descriptionToSend,
  applyPreset,
  bodyOfExpense,
  buildSplit,
  descriptionSuggestions,
  draftFromExpense,
  draftSignature,
  editorMembers,
  effectiveRate,
  evaluate,
  findDuplicate,
  flipSign,
  formatRate,
  hasOperator,
  historyLines,
  mentionedIds,
  newDraft,
  nextItemId,
  parseLooseNumber,
  parseRate,
  parseSignedMinor,
  payerAmountsSum,
  percentSum,
  prettyExpression,
  pressKey,
  readAmount,
  recentCurrencies,
  shareRange,
  stepShares,
  toggleIncluded,
  withCategory,
  withCurrency,
  withDescription,
  withMethod,
  withSuggestion,
  type EditorDraft,
  type EvalContext,
  type PadKey,
} from '../../src/web/features/expenses/editorLogic';
import { computeSharesFor, type Portion, type SplitInput } from '../../src/shared/split';
import { toBase } from '../../src/shared/balances';
import type { ActivityDTO, ExpenseDTO, MemberDTO } from '../../src/shared/types';

const ID = '11111111-2222-4333-8444-555555555555';

function member(id: string, name: string, sort: number, extra: Partial<MemberDTO> = {}): MemberDTO {
  return {
    id,
    groupId: 'g1',
    userId: null,
    name,
    color: '#2F6FB5',
    role: 'member',
    active: true,
    sort,
    createdAt: '2026-10-01T00:00:00.000Z',
    claimedAt: null,
    payInfo: '',
    venmo: '',
    paypal: '',
    ...extra,
  };
}

const MEMBERS = [member('kevin', 'Kevin', 2), member('gino', 'Gino', 0), member('abbie', 'Abbie', 1)];
const IDS = ['gino', 'abbie', 'kevin'];

function ctx(over: Partial<EvalContext> = {}): EvalContext {
  return { memberIds: IDS, meId: 'gino', groupCurrency: 'JPY', fetchedRate: null, ...over };
}

function draft(over: Partial<EditorDraft> = {}): EditorDraft {
  return { ...newDraft({ id: ID, memberIds: IDS, meId: 'gino', currency: 'JPY', date: '2026-10-16' }), ...over };
}

function expense(over: Partial<ExpenseDTO> = {}): ExpenseDTO {
  const split: SplitInput = over.split ?? { method: 'equal', entries: IDS.map(memberId => ({ memberId })) };
  const amount = over.amount ?? 12600;
  const id = over.id ?? 'e-1';
  const r = computeSharesFor(id, amount, split);
  return {
    id,
    groupId: 'g1',
    kind: 'expense',
    description: '燒肉晚餐',
    category: 'food.dining',
    amount,
    currency: 'JPY',
    fxRate: 1,
    date: '2026-10-15',
    notes: '',
    payers: [{ memberId: 'gino', amount }],
    split,
    shares: r.ok ? r.shares : [],
    repeat: 'none',
    repeatSeries: null,
    repeatStart: null,
    createdBy: 'u-gino',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedBy: 'u-gino',
    updatedAt: '2026-10-15T10:00:00.000Z',
    deletedAt: null,
    deletedBy: null,
    version: 1,
    commentCount: 0,
    ...over,
  };
}

const sum = (ps: readonly Portion[]) => ps.reduce((a, p) => a + p.amount, 0);

function typeKeys(keys: PadKey[], decimals: number, start = ''): string {
  return keys.reduce((raw, k) => pressKey(raw, k, decimals), start);
}

describe('keypad', () => {
  it('types digits like a calculator', () => {
    expect(typeKeys(['1', '2', '6', '0', '0'], 0)).toBe('12600');
    expect(typeKeys(['1', '2', '000'], 0)).toBe('12000');
  });
  it('never makes leading zeros', () => {
    expect(typeKeys(['0', '0', '5'], 0)).toBe('5');
    expect(typeKeys(['000'], 0)).toBe('');
    expect(typeKeys(['0', '000'], 0)).toBe('0');
  });
  it('allows a point only when the currency has decimals, and caps the decimals', () => {
    expect(typeKeys(['1', '.', '5'], 0)).toBe('15');
    expect(typeKeys(['.', '5'], 2)).toBe('0.5');
    expect(typeKeys(['1', '2', '.', '3', '4', '5'], 2)).toBe('12.34');
    expect(typeKeys(['1', '.', '.', '2'], 2)).toBe('1.2');
    expect(typeKeys(['1', '.', '000'], 2)).toBe('1.');
  });
  it('keeps one operator between numbers and none at the start', () => {
    expect(typeKeys(['+'], 0)).toBe('');
    expect(typeKeys(['8', '4', '0', '0', '+', '-', '4', '2', '0', '0'], 0)).toBe('8400-4200');
    expect(typeKeys(['1', '.', '+'], 2)).toBe('1+');
    expect(typeKeys(['8', '+', '0', '5'], 0)).toBe('8+5');
  });
  it('deletes and clears', () => {
    expect(pressKey('8400+', 'del', 0)).toBe('8400');
    expect(pressKey('', 'del', 0)).toBe('');
    expect(pressKey('8400', 'clear', 0)).toBe('');
  });
  it('caps very long numbers', () => {
    const raw = typeKeys(Array(20).fill('9') as PadKey[], 0);
    expect(raw.length).toBe(12);
    expect(typeKeys(['1', '.', '5', '+', ...(Array(14).fill('9') as PadKey[])], 2)).toBe('1.5+999999999999');
  });
  it('prints expressions with grouping', () => {
    expect(prettyExpression('8400+4200')).toBe('8,400 + 4,200');
    expect(prettyExpression('1712140')).toBe('1,712,140');
    expect(prettyExpression('12345.6')).toBe('12,345.6');
    expect(prettyExpression('3*450')).toBe('3 × 450');
    expect(prettyExpression('')).toBe('');
    expect(hasOperator('8400+')).toBe(true);
    expect(hasOperator('8400')).toBe(false);
  });
});

describe('reading typed values', () => {
  it('reads the total, ignoring a trailing operator', () => {
    expect(readAmount('', 'JPY')).toEqual({ state: 'empty', value: null });
    expect(readAmount('8400+', 'JPY')).toEqual({ state: 'ok', value: 8400 });
    expect(readAmount('8400+4200', 'JPY')).toEqual({ state: 'ok', value: 12600 });
    expect(readAmount('12.5', 'USD')).toEqual({ state: 'ok', value: 1250 });
    expect(readAmount('0', 'JPY')).toEqual({ state: 'zero', value: 0 });
    expect(readAmount('100-200', 'JPY')).toEqual({ state: 'zero', value: 0 });
    expect(readAmount('abc', 'JPY').state).toBe('invalid');
    expect(readAmount('NT$ 1,200', 'TWD')).toEqual({ state: 'ok', value: 1200 });
    expect(readAmount('1..2', 'JPY').state).toBe('invalid');
  });
  it('reads loose numbers for percentages, shares and rates', () => {
    expect(parseLooseNumber('33.3')).toBe(33.3);
    expect(parseLooseNumber('33,3')).toBe(33.3);
    expect(parseLooseNumber('１.５')).toBe(1.5);
    expect(parseLooseNumber(' 2 ')).toBe(2);
    expect(parseLooseNumber('25,400')).toBe(25400);
    expect(parseLooseNumber('0,215')).toBe(0.215);
    expect(parseLooseNumber('4,75')).toBe(4.75);
    expect(parseLooseNumber('1,234.5')).toBe(1234.5);
    expect(parseLooseNumber('50%')).toBe(50);
    expect(parseLooseNumber('')).toBeNull();
    expect(parseLooseNumber('abc')).toBeNull();
    expect(parseLooseNumber('-1')).toBeNull();
  });
  it('reads signed money for adjustments', () => {
    expect(parseSignedMinor('', 'JPY')).toBe(0);
    expect(parseSignedMinor('300', 'JPY')).toBe(300);
    expect(parseSignedMinor('-300', 'JPY')).toBe(-300);
    expect(parseSignedMinor('−1,200', 'JPY')).toBe(-1200);
    expect(parseSignedMinor('+5', 'USD')).toBe(500);
    expect(parseSignedMinor('-', 'JPY')).toBe(0);
    expect(parseSignedMinor('x', 'JPY')).toBeNull();
    expect(flipSign('300')).toBe('-300');
    expect(flipSign('-300')).toBe('300');
    expect(flipSign('')).toBe('-');
  });
  it('reads and prints exchange rates', () => {
    expect(parseRate('31.42')).toBe(31.42);
    expect(parseRate('0')).toBeNull();
    expect(parseRate('')).toBeNull();
    expect(formatRate(31.42)).toBe('31.42');
    expect(formatRate(4.751234)).toBe('4.7512');
    expect(formatRate(0.2105263)).toBe('0.21053');
    expect(formatRate(158.2133)).toBe('158.21');
    expect(formatRate(25412.3)).toBe('25412');
  });
});

describe('members', () => {
  it('orders me first, then by sort, then removed members the entry mentions', () => {
    const list = [...MEMBERS, member('leo', 'Leo', 3, { active: false }), member('old', 'Old', 4, { active: false })];
    expect(editorMembers(list, 'gino').map(m => m.id)).toEqual(['gino', 'abbie', 'kevin']);
    expect(editorMembers(list, 'kevin', ['leo']).map(m => m.id)).toEqual(['kevin', 'gino', 'abbie', 'leo']);
    expect(mentionedIds(expense({ payers: [{ memberId: 'leo', amount: 12600 }] })).sort()).toEqual(['abbie', 'gino', 'kevin', 'leo']);
  });
});

describe('a new entry', () => {
  it('defaults to me paying, split equally among everyone', () => {
    const d = draft({ amountRaw: '12600', description: '燒肉晚餐' });
    const ev = evaluate(d, ctx());
    expect(ev.reason).toBeNull();
    expect(ev.body?.payers).toEqual([{ memberId: 'gino', amount: 12600 }]);
    expect(ev.body?.split).toEqual({ method: 'equal', entries: IDS.map(memberId => ({ memberId })) });
    expect(ev.shares.map(s => s.amount)).toEqual([4200, 4200, 4200]);
    expect(ev.me).toEqual({ involved: true, net: 8400, currency: 'JPY' });
    expect(ev.body?.fxRate).toBe(1);
  });

  it('previews exactly what the server stores (computeSharesFor with the entry id)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), fc.subarray(IDS, { minLength: 1 }), fc.uuid(), (amount, people, id) => {
        const d = draft({ id, amountRaw: String(amount), description: 'x', split: { ...draft().split, included: people } });
        const ev = evaluate(d, ctx());
        const server = computeSharesFor(id, amount, ev.body!.split);
        expect(server.ok && server.shares).toEqual(ev.shares);
        expect(sum(ev.shares)).toBe(amount);
      }),
      { numRuns: 200 },
    );
  });

  it('gives the first reason that stops saving', () => {
    expect(evaluate(draft(), ctx()).reason).toEqual({ code: 'amount_empty' });
    expect(evaluate(draft({ amountRaw: '0' }), ctx()).reason).toEqual({ code: 'amount_zero' });
    expect(evaluate(draft({ amountRaw: '5-9' }), ctx()).reason).toEqual({ code: 'amount_zero' });
    expect(evaluate(draft({ amountRaw: '5..9' }), ctx()).reason).toEqual({ code: 'amount_invalid' });
    // A description is optional: without one the category's name is sent (DESIGN.md 9.2).
    expect(evaluate(draft({ amountRaw: '100' }), ctx()).reason).toBeNull();
    expect(evaluate(draft({ amountRaw: '100' }), ctx()).body?.description).toBe('一般');
    expect(evaluate(draft({ amountRaw: '100', description: '  ', category: 'food.dining' }), ctx({ locale: 'en' })).body?.description).toBe('Dining out');
    expect(descriptionToSend({ kind: 'payment', description: ' ', category: 'payment' })).toBe('');
    expect(clip('ab😀', 3)).toBe('ab');
    expect(clip('abc', 3)).toBe('abc');
    const nobody = draft({ amountRaw: '100', description: 'x', split: { ...draft().split, included: [] } });
    expect(evaluate(nobody, ctx()).reason).toEqual({ code: 'split', error: 'no_participants' });
    expect(evaluate(nobody, ctx()).body).toBeNull();
  });

  it('re-detects the category until one is picked by hand', () => {
    let d = withDescription(draft(), '燒肉晚餐');
    expect(d.category).toBe('food.dining');
    d = withDescription(d, 'Uber to airport');
    expect(d.category).toBe('transport.taxi');
    d = withDescription(d, '');
    expect(d.category).toBe('general');
    d = withCategory(d, 'travel.hotel');
    d = withDescription(d, '拉麵');
    expect(d.category).toBe('travel.hotel');
  });

  it('drops a typed rate when the currency changes', () => {
    const d = withCurrency(draft({ currency: 'TWD', fxManual: '4.8' }), 'USD');
    expect(d.fxManual).toBe('');
    expect(withCurrency(d, 'USD')).toBe(d);
  });
});

describe('payers', () => {
  it('checks several payers against the total', () => {
    const d = draft({ amountRaw: '12600', description: 'x', payerMode: 'multi', payerAmounts: { gino: '10000', abbie: '2000' } });
    const ev = evaluate(d, ctx());
    expect(ev.reason).toEqual({ code: 'payers', error: 'payers_mismatch', diff: 600 });
    expect(payerAmountsSum(d, IDS)).toBe(12000);
    const ok = evaluate({ ...d, payerAmounts: { gino: '10000', abbie: '2600', kevin: '' } }, ctx());
    expect(ok.reason).toBeNull();
    expect(ok.body?.payers).toEqual([{ memberId: 'gino', amount: 10000 }, { memberId: 'abbie', amount: 2600 }]);
    const over = evaluate({ ...d, payerAmounts: { gino: '13000' } }, ctx());
    expect(over.reason).toEqual({ code: 'payers', error: 'payers_mismatch', diff: -400 });
    const bad = evaluate({ ...d, payerAmounts: { gino: '1..0' } }, ctx());
    expect(bad.reason).toEqual({ code: 'payers', error: 'invalid_value', memberId: 'gino' });
  });

  it('keeps the split problem for the split sheet while a payer problem comes first', () => {
    const d = draft({ amountRaw: '1000', payerMode: 'multi', payerAmounts: { gino: '900' }, split: { ...draft().split, included: [] } });
    const ev = evaluate(d, ctx());
    expect(ev.reason?.code).toBe('payers');
    expect(ev.payerReason).toEqual({ code: 'payers', error: 'payers_mismatch', diff: 100 });
    expect(ev.splitReason).toEqual({ code: 'split', error: 'no_participants' });
  });
});

describe('split methods', () => {
  const base = () => draft({ amountRaw: '40000', description: '住宿' });

  it('shares: starts at 1 per person in the split, steps by 0.5', () => {
    const s = withMethod(toggleIncluded(base().split, 'kevin', IDS), 'shares', IDS);
    expect(s.shares).toEqual({ gino: '1', abbie: '1', kevin: '0' });
    const d = { ...base(), split: { ...s, shares: { gino: '2', abbie: '1', kevin: '1' } } };
    const ev = evaluate(d, ctx());
    expect(Object.fromEntries(ev.shares.map(p => [p.memberId, p.amount]))).toEqual({ gino: 20000, abbie: 10000, kevin: 10000 });
    expect(stepShares('1', 1)).toBe('1.5');
    expect(stepShares('0.5', -1)).toBe('0');
    expect(stepShares('0', -1)).toBe('0');
    expect(stepShares('', 1)).toBe('0.5');
  });

  it('exact: shows what is left and stores only people with an amount', () => {
    const s = { ...withMethod(base().split, 'exact', IDS), exact: { gino: '20000', abbie: '15000' } };
    const ev = evaluate({ ...base(), split: s }, ctx());
    expect(ev.reason).toEqual({ code: 'split', error: 'exact_mismatch', diff: 5000 });
    const done = evaluate({ ...base(), split: { ...s, exact: { gino: '20000', abbie: '15000', kevin: '5000' } } }, ctx());
    expect(done.reason).toBeNull();
    const only = evaluate({ ...base(), split: { ...s, exact: { gino: '40000' } } }, ctx());
    expect(only.body?.split).toEqual({ method: 'exact', entries: [{ memberId: 'gino', value: 40000 }] });
    const bad = buildSplit({ ...s, exact: { gino: '1..2' } }, IDS, 'JPY');
    expect(bad).toEqual({ ok: false, code: 'invalid_value', memberId: 'gino' });
  });

  it('percent: needs 100 in total', () => {
    const s = { ...withMethod(base().split, 'percent', IDS), percent: { gino: '50', abbie: '25' } };
    expect(percentSum(s, IDS)).toBe(75);
    expect(evaluate({ ...base(), split: s }, ctx()).reason).toEqual({ code: 'split', error: 'percent_mismatch', diff: 25 });
    const ok = evaluate({ ...base(), split: { ...s, percent: { gino: '50', abbie: '25', kevin: '25' } } }, ctx());
    expect(ok.shares.map(p => p.amount)).toEqual([20000, 10000, 10000]);
  });

  it('adjust: plus or minus on top of an equal split of the rest', () => {
    const s = { ...withMethod(base().split, 'adjust', IDS), adjust: { kevin: '-1000', abbie: '+2500' } };
    const ev = evaluate({ ...base(), amountRaw: '30000', split: s }, ctx());
    expect(ev.reason).toBeNull();
    expect(Object.fromEntries(ev.shares.map(p => [p.memberId, p.amount]))).toEqual({ gino: 9500, abbie: 12000, kevin: 8500 });
    expect(ev.body?.split.entries).toEqual([{ memberId: 'gino' }, { memberId: 'abbie', value: 2500 }, { memberId: 'kevin', value: -1000 }]);
    const neg = evaluate({ ...base(), amountRaw: '3000', split: { ...s, adjust: { kevin: '-5000' } } }, ctx());
    expect(neg.reason).toEqual({ code: 'split', error: 'negative_share' });
  });

  it('items: the rest (tax, tip) is spread in proportion', () => {
    const s = {
      ...withMethod(base().split, 'items', IDS),
      items: [
        { id: 'item-1', name: '牛排', amountRaw: '3000', memberIds: ['gino'] },
        { id: 'item-2', name: '沙拉', amountRaw: '1000', memberIds: ['gino', 'abbie'] },
        { id: 'item-3', name: '', amountRaw: '', memberIds: [] },
      ],
    };
    const ev = evaluate({ ...base(), amountRaw: '4400', split: s }, ctx());
    expect(ev.reason).toBeNull();
    expect(ev.body?.split.items?.length).toBe(2);
    expect(Object.fromEntries(ev.shares.map(p => [p.memberId, p.amount]))).toEqual({ gino: 3850, abbie: 550 });
    const none = evaluate({ ...base(), amountRaw: '4400', split: { ...s, items: [{ id: 'item-1', name: 'x', amountRaw: '100', memberIds: [] }] } }, ctx());
    expect(none.reason).toEqual({ code: 'split', error: 'item_no_members' });
    expect(nextItemId(s.items)).toBe('item-4');
    expect(withMethod(base().split, 'items', IDS).items).toHaveLength(1);
  });

  it('keeps what was typed for each method when switching back and forth', () => {
    let s = withMethod(base().split, 'exact', IDS);
    s = { ...s, exact: { gino: '100' } };
    s = withMethod(s, 'percent', IDS);
    s = withMethod(s, 'exact', IDS);
    expect(s.exact).toEqual({ gino: '100' });
  });
});

describe('exchange rate', () => {
  it('uses a typed rate, then the saved one while currency and date stay, then the fetched one', () => {
    const d = draft({ currency: 'TWD' });
    expect(effectiveRate(draft(), 'JPY', null)).toEqual({ rate: 1, source: 'same' });
    expect(effectiveRate(d, 'JPY', null)).toEqual({ rate: null, source: 'none' });
    expect(effectiveRate(d, 'JPY', 4.75)).toEqual({ rate: 4.75, source: 'auto' });
    expect(effectiveRate({ ...d, fxManual: '4.8' }, 'JPY', 4.75)).toEqual({ rate: 4.8, source: 'manual' });
    expect(effectiveRate({ ...d, fxManual: 'abc' }, 'JPY', 4.75)).toEqual({ rate: null, source: 'none' });
    const stored = { ...d, fxStored: { rate: 4.7, currency: 'TWD', date: d.date } };
    expect(effectiveRate(stored, 'JPY', 4.75)).toEqual({ rate: 4.7, source: 'stored' });
    expect(effectiveRate({ ...stored, date: '2026-10-01' }, 'JPY', 4.75)).toEqual({ rate: 4.75, source: 'auto' });
  });

  it('blocks saving only when there is no rate at all', () => {
    const d = draft({ currency: 'TWD', amountRaw: '2400', description: '機場接送', payerId: 'kevin' });
    expect(evaluate(d, ctx()).reason).toEqual({ code: 'fx_missing' });
    expect(evaluate({ ...d, fxManual: '0' }, ctx()).reason).toEqual({ code: 'fx_invalid' });
    const ev = evaluate(d, ctx({ fetchedRate: 4.75 }));
    expect(ev.reason).toBeNull();
    expect(ev.converted).toBe(11400);
    expect(ev.body?.fxRate).toBe(4.75);
    expect(ev.body?.currency).toBe('TWD');
    // My part in the group currency, through balances.toBase (converted once, then allocated).
    const b = toBase({ id: ID, kind: 'expense', amount: 2400, currency: 'TWD', fxRate: 4.75, payers: ev.payers, shares: ev.shares }, 'JPY');
    expect(ev.base).toEqual(b);
    expect(ev.me).toEqual({ involved: true, net: -3800, currency: 'JPY' });
  });
});

describe('payments', () => {
  it('builds a payment from sender, recipient and amount', () => {
    const d = draft({ kind: 'payment', amountRaw: '5000', payerId: 'abbie', recipientId: 'gino', category: 'payment' });
    const ev = evaluate(d, ctx());
    expect(ev.reason).toBeNull();
    expect(ev.body).toMatchObject({
      kind: 'payment',
      description: '',
      category: 'payment',
      payers: [{ memberId: 'abbie', amount: 5000 }],
      split: { method: 'exact', entries: [{ memberId: 'gino', value: 5000 }] },
    });
    expect(ev.me).toEqual({ involved: true, net: -5000, currency: 'JPY' });
    expect(evaluate({ ...d, recipientId: 'abbie' }, ctx()).reason).toEqual({ code: 'payment_self' });
    expect(evaluate({ ...d, recipientId: '' }, ctx()).reason).toEqual({ code: 'recipient_missing' });
  });
});

describe('editing and copying', () => {
  const methods: SplitInput[] = [
    { method: 'equal', entries: [{ memberId: 'gino' }, { memberId: 'kevin' }] },
    { method: 'exact', entries: [{ memberId: 'gino', value: 6000 }, { memberId: 'abbie', value: 6600 }] },
    { method: 'percent', entries: [{ memberId: 'gino', value: 33.3 }, { memberId: 'abbie', value: 66.7 }] },
    { method: 'shares', entries: [{ memberId: 'gino', value: 2 }, { memberId: 'abbie', value: 1.5 }, { memberId: 'kevin', value: 0 }] },
    { method: 'adjust', entries: [{ memberId: 'gino', value: 600 }, { memberId: 'abbie' }, { memberId: 'kevin', value: -300 }] },
    { method: 'items', entries: [], items: [{ id: 'a', name: '牛排', amount: 9000, memberIds: ['gino'] }, { id: 'b', name: '酒', amount: 3000, memberIds: ['abbie', 'kevin'] }] },
  ];

  for (const split of methods) {
    it(`prefills a ${split.method} split so saving again stores the same shares`, () => {
      const e = expense({ split });
      const d = draftFromExpense(e, { memberIds: IDS });
      expect(d.split.method).toBe(split.method);
      const ev = evaluate(d, ctx());
      expect(ev.reason).toBeNull();
      expect(ev.shares).toEqual(e.shares);
      expect(ev.body?.amount).toBe(e.amount);
      expect(d.categoryManual).toBe(false);
    });
  }

  it('prefills several payers, a manual category and the saved rate', () => {
    const e = expense({
      currency: 'TWD',
      fxRate: 4.7,
      amount: 2400,
      category: 'travel.hotel',
      payers: [{ memberId: 'gino', amount: 2000 }, { memberId: 'abbie', amount: 400 }],
      split: { method: 'equal', entries: [{ memberId: 'gino' }, { memberId: 'abbie' }] },
    });
    const d = draftFromExpense(e, { memberIds: IDS });
    expect(d.payerMode).toBe('multi');
    expect(d.payerAmounts).toEqual({ gino: '2000', abbie: '400' });
    expect(d.categoryManual).toBe(true);
    const ev = evaluate(d, ctx({ fetchedRate: 4.75 }));
    expect(ev.fx).toEqual({ rate: 4.7, source: 'stored' });
    expect(ev.reason).toBeNull();
  });

  it('copies an entry with a new id, a new date, no repeat and no saved rate', () => {
    const e = expense({ repeat: 'monthly', currency: 'TWD', fxRate: 4.7 });
    const d = draftFromExpense(e, { memberIds: IDS, copy: { id: 'new-id', date: '2026-10-16' } });
    expect(d.id).toBe('new-id');
    expect(d.date).toBe('2026-10-16');
    expect(d.repeat).toBe('none');
    expect(d.fxStored).toBeNull();
    expect(d.description).toBe(e.description);
  });

  it('builds the undo body from the stored entry', () => {
    const e = expense({ notes: 'n', repeat: 'weekly' });
    const b = bodyOfExpense(e);
    expect(b).toMatchObject({ kind: 'expense', amount: 12600, notes: 'n', repeat: 'weekly', split: e.split, payers: e.payers });
    expect(b.split).not.toBe(e.split);
  });

  it('treats typing and erasing as no change', () => {
    const d = draft();
    let x = withDescription(d, '燒');
    x = withDescription(x, '');
    x = { ...x, split: { ...withMethod(x.split, 'exact', IDS), exact: { gino: '' } } };
    x = { ...x, split: withMethod(x.split, 'equal', IDS) };
    expect(draftSignature(x)).toBe(draftSignature(d));
    expect(draftSignature({ ...d, amountRaw: '1' })).not.toBe(draftSignature(d));
    const fromSaved = draftFromExpense(expense(), { memberIds: IDS });
    expect(draftSignature(draftFromExpense(expense(), { memberIds: IDS }))).toBe(draftSignature(fromSaved));
  });
});

describe('two-person presets', () => {
  const two = ['gino', 'abbie'];
  const d2 = () => ({ ...newDraft({ id: ID, memberIds: two, meId: 'gino', currency: 'USD', date: '2026-10-16' }), amountRaw: '50', description: 'Groceries' });
  const c2 = { memberIds: two, meId: 'gino', groupCurrency: 'USD', fetchedRate: null };

  it('sets payer and split', () => {
    const owe = (k: Parameters<typeof applyPreset>[1]) => {
      const ev = evaluate(applyPreset(d2(), k, 'gino', 'abbie'), c2);
      return [ev.payers[0].memberId, Object.fromEntries(ev.shares.map(s => [s.memberId, s.amount]))];
    };
    expect(owe('i-equal')).toEqual(['gino', { gino: 2500, abbie: 2500 }]);
    expect(owe('i-full')).toEqual(['gino', { abbie: 5000 }]);
    expect(owe('they-equal')).toEqual(['abbie', { gino: 2500, abbie: 2500 }]);
    expect(owe('they-full')).toEqual(['abbie', { gino: 5000 }]);
  });

  it('knows which preset is active', () => {
    expect(activePreset(d2(), 'gino', 'abbie')).toBe('i-equal');
    for (const k of ['i-equal', 'i-full', 'they-equal', 'they-full'] as const) {
      expect(activePreset(applyPreset(d2(), k, 'gino', 'abbie'), 'gino', 'abbie')).toBe(k);
    }
    expect(activePreset({ ...d2(), payerMode: 'multi' }, 'gino', 'abbie')).toBeNull();
  });
});

describe('duplicates and suggestions', () => {
  const list = [
    expense({ id: 'a', amount: 4550, description: '拉麵', date: '2026-10-15', createdAt: '2026-10-15T12:00:00Z' }),
    expense({ id: 'b', amount: 12600, description: '燒肉晚餐', date: '2026-10-15', createdAt: '2026-10-15T20:00:00Z' }),
    expense({ id: 'c', amount: 900, description: '便利商店', date: '2026-10-14', currency: 'TWD', fxRate: 4.7 }),
    expense({ id: 'd', amount: 700, description: '拉麵', date: '2026-10-13' }),
    expense({ id: 'x', amount: 100, description: '計程車', date: '2026-10-16', deletedAt: '2026-10-16T00:00:00Z' }),
  ];

  it('finds a live entry with the same amount, currency, date and payer', () => {
    const probe = { id: ID, kind: 'expense' as const, amount: 12600, currency: 'JPY', date: '2026-10-15', payerIds: ['gino'] };
    expect(findDuplicate(list, probe)?.id).toBe('b');
    expect(findDuplicate(list, { ...probe, id: 'b' })).toBeNull();
    expect(findDuplicate(list, { ...probe, payerIds: ['abbie'] })).toBeNull();
    expect(findDuplicate(list, { ...probe, currency: 'USD' })).toBeNull();
    expect(findDuplicate(list, { ...probe, amount: 100, date: '2026-10-16' })).toBeNull();
  });

  it('lists the currencies the group used, group currency first', () => {
    expect(recentCurrencies(list, 'JPY')).toEqual(['JPY', 'TWD']);
    expect(recentCurrencies([], 'USD')).toEqual(['USD']);
  });

  it('suggests descriptions used before', () => {
    expect(descriptionSuggestions(list, '').map(s => s.description)).toEqual(['拉麵', '燒肉晚餐', '便利商店']);
    expect(descriptionSuggestions(list, '拉').map(s => s.description)).toEqual(['拉麵']);
    expect(descriptionSuggestions(list, '拉麵')).toEqual([]);
    expect(descriptionSuggestions(list, '晚餐').map(s => s.description)).toEqual(['燒肉晚餐']);
    const d = withSuggestion(draft(), { description: '燒肉晚餐', category: 'food.dining' });
    expect(d).toMatchObject({ description: '燒肉晚餐', category: 'food.dining', categoryManual: false });
  });
});

describe('history', () => {
  const act = (over: Partial<ActivityDTO>): ActivityDTO => ({
    id: 'a1',
    groupId: 'g1',
    groupName: 'Niseko',
    groupEmoji: '',
    groupType: 'trip',
    userId: 'u-gino',
    memberId: 'gino',
    actorName: 'Gino',
    type: 'expense.create',
    expenseId: 'e-1',
    data: {},
    createdAt: '2026-10-15T10:00:00Z',
    ...over,
  });

  it('gives one line per change, oldest first, without comments', () => {
    const lines = historyLines([
      act({ id: 'a3', type: 'comment.add', createdAt: '2026-10-15T12:00:00Z', data: { comment: 'hi' } }),
      act({
        id: 'a2',
        type: 'expense.update',
        actorName: 'Abbie',
        createdAt: '2026-10-15T11:00:00Z',
        data: { changes: [{ field: 'amount', from: '¥4,000', to: '¥4,550' }, { field: 'description', from: '麵', to: '拉麵' }] },
      }),
      act({ id: 'a1' }),
    ]);
    expect(lines.map(l => [l.kind, l.actorName, l.field ?? '', l.from ?? '', l.to ?? ''])).toEqual([
      ['created', 'Gino', '', '', ''],
      ['changed', 'Abbie', 'amount', '¥4,000', '¥4,550'],
      ['changed', 'Abbie', 'description', '麵', '拉麵'],
    ]);
    expect(new Set(lines.map(l => l.key)).size).toBe(3);
    expect(historyLines([act({ type: 'comment.add', data: { comment: 'hi' } })], { comments: true })[0]).toMatchObject({ kind: 'commented', comment: 'hi' });
  });
});

describe('display helpers', () => {
  it('measures amounts so long ones can shrink (DESIGN.md 8.3)', () => {
    // 6 glyphs x 0.6, minus 0.34 for the comma, 0.36 for the prefix, 0.13 for the caret
    expect(amountEm('¥', '12,600', { caret: true })).toBeCloseTo(3.75, 5);
    expect(amountEm('US$', '12,345.67')).toBeCloseTo(9 * 0.6 - 2 * 0.34 + 3 * 0.36, 5);
    expect(amountEm('KHR ', '1,000')).toBeCloseTo(5 * 0.6 - 0.34 + 3 * 0.36, 5);
    expect(amountEm('', '')).toBe(1);
  });
  it('gives the range of equal shares', () => {
    expect(shareRange([{ memberId: 'a', amount: 34 }, { memberId: 'b', amount: 33 }, { memberId: 'c', amount: 33 }])).toEqual({ min: 33, max: 34 });
    expect(shareRange([])).toBeNull();
  });
});
