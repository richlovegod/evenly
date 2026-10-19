import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  activePreset,
  amountEm,
  clip,
  descriptionToSend,
  applyPreset,
  applyScan,
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
  hasTypedItems,
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
  receiptMinor,
  recentCurrencies,
  revertScan,
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
  type ScanOptions,
} from '../../src/web/features/expenses/editorLogic';
import { computeSharesFor, type Portion, type SplitInput } from '../../src/shared/split';
import { toBase } from '../../src/shared/balances';
import type { ActivityDTO, ExpenseDTO, MemberDTO, ReceiptScanDTO } from '../../src/shared/types';

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
    avatar: null,
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

describe('a scanned receipt', () => {
  const TODAY = '2026-10-17';
  const scan = (over: Partial<ReceiptScanDTO> = {}): ReceiptScanDTO => ({
    merchant: null, date: null, currency: null, total: null, items: [], tax: null, tip: null, category: null, warnings: [], ...over,
  });
  /** A rate typed by hand earlier in this JPY group for TWD, none for USD. */
  const remembered: Record<string, string> = { TWD: '4.75' };
  const opts = (started: EditorDraft, over: Partial<ScanOptions> = {}): ScanOptions => ({
    started, base: draft(), groupCurrency: 'JPY', today: TODAY, rateFor: c => remembered[c] ?? '', ...over,
  });

  it('turns receipt numbers into minor units exactly, and refuses fractions without decimals', () => {
    expect(receiptMinor(1.005, 'USD')).toBe(101);
    expect(receiptMinor(110.49, 'USD')).toBe(11049);
    expect(receiptMinor(0.1 + 0.2, 'USD')).toBe(30);
    expect(receiptMinor(1260, 'JPY')).toBe(1260);
    expect(receiptMinor(0, 'JPY')).toBe(0);
    expect(receiptMinor(1.26, 'JPY')).toBeNull();
    expect(receiptMinor(12.5, 'TWD')).toBeNull();
    expect(receiptMinor(-1, 'USD')).toBeNull();
    expect(receiptMinor(1e21, 'JPY')).toBeNull();
    expect(receiptMinor(Number.NaN, 'USD')).toBeNull();
    expect(receiptMinor(null, 'USD')).toBeNull();
  });

  it('a TWD receipt in a JPY group: the currency first (with the rate typed earlier), then the rest', () => {
    const d = draft();
    const s = scan({
      merchant: '全家便利商店 台北松江店', date: '2026-10-05', currency: 'TWD', total: 485, category: 'food.groceries',
      items: [{ name: '御飯糰 鮪魚', amount: 39 }, { name: '舒潔 衛生紙', amount: 189 }],
    });
    const r = applyScan(d, s, opts(d));
    expect(r.filled).toEqual(['currency', 'amount', 'date', 'description', 'category', 'items']);
    expect(r.draft).toMatchObject({
      currency: 'TWD', fxManual: '4.75', amountRaw: '485', date: '2026-10-05', description: '全家便利商店 台北松江店', category: 'food.groceries', categoryManual: false,
    });
    expect(r.draft.split.items).toEqual([
      { id: 'item-1', name: '御飯糰 鮪魚', amountRaw: '39', memberIds: [] },
      { id: 'item-2', name: '舒潔 衛生紙', amountRaw: '189', memberIds: [] },
    ]);
    expect(r).toMatchObject({ items: 2, openSplit: false, notes: [] });
    // The lines wait under 品項: the split stays equal, so it saves as before (485 x 4.75 = 2303.75).
    const ev = evaluate(r.draft, ctx());
    expect(ev.reason).toBeNull();
    expect(ev.body?.split.method).toBe('equal');
    expect(ev.converted).toBe(2304);
  });

  it('a USD receipt: two decimals, and no rate typed yet (the fetched one is used)', () => {
    const d = draft();
    const r = applyScan(d, scan({ currency: 'USD', total: 110.49, items: [{ name: 'Burrata', amount: 18 }, { name: '2 Glass Chianti', amount: 28.5 }] }), opts(d));
    expect(r.draft).toMatchObject({ currency: 'USD', fxManual: '', amountRaw: '110.49' });
    expect(r.draft.split.items.map(i => i.amountRaw)).toEqual(['18', '28.50']);
    expect(evaluate(r.draft, ctx({ fetchedRate: 150 })).converted).toBe(16574);
  });

  it('a misread total (¥13,838 read as 13.838) is not filled in; readable lines still are', () => {
    const d = draft();
    const r = applyScan(d, scan({
      currency: 'JPY', total: 13.838,
      items: [{ name: 'お通し ×4', amount: 1760 }, { name: '生ビール ×6', amount: 3960 }, { name: '割り箸', amount: 0 }, { name: '?', amount: 1.5 }],
    }), opts(d));
    expect(r.filled).toEqual(['items']);
    expect(r.notes).toEqual([{ code: 'total_unreadable' }]);
    expect(r.draft.amountRaw).toBe('');
    expect(r.draft.split.items.map(i => [i.name, i.amountRaw])).toEqual([['お通し ×4', '1760'], ['生ビール ×6', '3960']]);
  });

  it('keeps the split method; when it already is 品項 the split sheet should open', () => {
    const d = draft({ split: withMethod(draft().split, 'items', IDS) });
    expect(hasTypedItems(d.split.items)).toBe(false);
    const r = applyScan(d, scan({ currency: 'JPY', total: 4400, items: [{ name: '牛排', amount: 3000 }, { name: '沙拉', amount: 1000 }] }), opts(d));
    expect(r.openSplit).toBe(true);
    expect(r.draft.split.method).toBe('items');
    expect(r.draft.split.items).toHaveLength(2);
    expect(evaluate(r.draft, ctx()).reason).toEqual({ code: 'split', error: 'item_no_members' });
  });

  it('leaves alone what the person changed while the photo was read', () => {
    const started = draft();
    const now = { ...withDescription(started, '晚餐'), amountRaw: '500', date: '2026-10-15' };
    const r = applyScan(now, scan({ merchant: '居酒屋 炉ばた 漁火', currency: 'JPY', total: 13838, date: '2026-10-13', category: 'food.dining' }), opts(started));
    expect(r.filled).toEqual([]);
    expect(r.notes).toEqual([{ code: 'kept', fields: ['amount', 'date', 'description'] }]);
    expect(r.draft).toEqual(now);
  });

  it('fills the store name only into an untouched description, and keeps a category picked by hand', () => {
    const typed = withDescription(draft(), '朋友生日');
    const r = applyScan(typed, scan({ merchant: '鼎泰豐 信義店', category: 'food.dining', currency: 'JPY', total: 2222 }), opts(typed));
    expect(r.draft).toMatchObject({ description: '朋友生日', category: typed.category, amountRaw: '2222' });
    expect(r.filled).toEqual(['amount']);

    const picked = withCategory(draft(), 'travel.hotel');
    const p = applyScan(picked, scan({ merchant: 'ローソン 札幌駅前店', category: 'food.groceries' }), opts(picked));
    expect(p.draft).toMatchObject({ description: 'ローソン 札幌駅前店', category: 'travel.hotel', categoryManual: true });
    expect(p.filled).toEqual(['description']);

    // Never payment: then the category comes from the store name.
    expect(applyScan(draft(), scan({ merchant: 'Uber', category: 'payment' }), opts(draft())).draft.category).toBe('transport.taxi');
  });

  it('fills the date only within the last 90 days (and tomorrow)', () => {
    const d = draft();
    expect(applyScan(d, scan({ date: '2026-07-19' }), opts(d)).draft.date).toBe('2026-07-19');
    expect(applyScan(d, scan({ date: '2026-10-18' }), opts(d)).draft.date).toBe('2026-10-18');
    const old = applyScan(d, scan({ date: '2016-10-15' }), opts(d));
    expect(old.draft.date).toBe(d.date);
    expect(old.notes).toEqual([{ code: 'date_outside', date: '2016-10-15' }]);
    expect(applyScan(d, scan({ date: '2026-07-18' }), opts(d)).notes).toEqual([{ code: 'date_outside', date: '2026-07-18' }]);
    expect(applyScan(d, scan({ date: '2026-10-19' }), opts(d)).draft.date).toBe(d.date);
  });

  it('takes no amounts in another currency than one picked meanwhile', () => {
    const started = draft();
    const now = { ...started, currency: 'USD' };
    const r = applyScan(now, scan({ currency: 'TWD', total: 485, items: [{ name: 'a', amount: 39 }] }), opts(started));
    expect(r.draft).toEqual(now);
    expect(r.notes).toEqual([{ code: 'kept', fields: ['currency'] }, { code: 'currency_changed' }]);
  });

  it('without a currency the amounts are read in the form currency', () => {
    const usd = draft({ currency: 'USD' });
    expect(applyScan(usd, scan({ total: 12.5 }), opts(usd)).draft).toMatchObject({ currency: 'USD', amountRaw: '12.50' });
    expect(applyScan(draft(), scan({ total: 12.5 }), opts(draft())).notes).toEqual([{ code: 'total_unreadable' }]);
  });

  it('back in the group currency, a typed rate is dropped (as setCurrency does)', () => {
    const d = draft({ currency: 'TWD', fxManual: '4.8' });
    expect(applyScan(d, scan({ currency: 'JPY', total: 1260 }), opts(d)).draft).toMatchObject({ currency: 'JPY', fxManual: '', amountRaw: '1260' });
  });

  it('keeps typed 品項 lines when the person says so', () => {
    const mine = [{ id: 'item-1', name: '牛排', amountRaw: '3000', memberIds: ['gino'] }];
    const d = draft({ split: { ...draft().split, items: mine } });
    expect(hasTypedItems(d.split.items)).toBe(true);
    const s = scan({ currency: 'JPY', items: [{ name: '沙拉', amount: 1000 }] });
    const kept = applyScan(d, s, opts(d, { replaceItems: false }));
    expect(kept.draft.split.items).toBe(mine);
    expect(kept.notes).toEqual([{ code: 'items_kept' }]);
    // Lines a scan put in, untouched since, are replaced without asking.
    const replaced = applyScan(d, s, opts(d)).draft.split.items;
    expect(hasTypedItems(replaced, replaced)).toBe(false);
    expect(hasTypedItems(replaced, mine)).toBe(true);
  });

  it('does nothing to a payment', () => {
    const p = draft({ kind: 'payment', category: 'payment' });
    const r = applyScan(p, scan({ currency: 'TWD', total: 485, merchant: 'x' }), opts(p));
    expect(r.draft).toBe(p);
    expect(r.filled).toEqual([]);
  });

  it('undo puts back only what still shows the scan', () => {
    const before = draft();
    const s = scan({ merchant: '全家', date: '2026-10-05', currency: 'TWD', total: 485, items: [{ name: 'a', amount: 39 }], category: 'food.groceries' });
    const after = applyScan(before, s, opts(before)).draft;
    expect(revertScan(after, before, after)).toEqual(before);
    // Changed after the scan: the description and the date stay as the person set them.
    const edited = { ...after, description: '早餐', date: '2026-10-06' };
    const undone = revertScan(edited, before, after);
    expect(undone).toMatchObject({ currency: 'JPY', fxManual: '', amountRaw: '', description: '早餐', date: '2026-10-06' });
    expect(undone.split.items).toEqual([]);
    // A line edited after the scan keeps every line, and the currency they are in with the total.
    const lineEdited = { ...after, split: { ...after.split, items: [{ ...after.split.items[0], memberIds: ['gino'] }] } };
    const kept = revertScan(lineEdited, before, after);
    expect(kept.split.items).toEqual(lineEdited.split.items);
    expect(kept).toMatchObject({ currency: 'TWD', fxManual: '4.75', amountRaw: '485', description: before.description, date: before.date });
  });

  it('undo keeps the scan currency when numbers were typed in it since, and its amounts with it', () => {
    // A TWD group: a Japanese receipt switches the form to yen but its total is unreadable, so the
    // person types the yen amount. 復原 must not turn ¥13,838 into NT$13,838.
    const before = draft({ currency: 'TWD' });
    const o = opts(before, { groupCurrency: 'TWD' });
    const after = applyScan(before, scan({ merchant: '居酒屋 炉ばた 漁火', date: '2026-10-13', currency: 'JPY', total: 13.838, category: 'food.dining' }), o).draft;
    expect(after).toMatchObject({ currency: 'JPY', amountRaw: '' });
    expect(revertScan({ ...after, amountRaw: '13838' }, before, after)).toMatchObject({
      currency: 'JPY', fxManual: after.fxManual, amountRaw: '13838', description: before.description, date: before.date, category: before.category,
    });

    // A rate typed for yen, or a person's amount in yen: the scan's total and lines stay in yen too.
    const filled = applyScan(before, scan({ currency: 'JPY', total: 1260, items: [{ name: 'おにぎり', amount: 160 }] }), o).draft;
    const rated = revertScan({ ...filled, fxManual: '0.21' }, before, filled);
    expect(rated).toMatchObject({ currency: 'JPY', fxManual: '0.21', amountRaw: '1260' });
    expect(rated.split.items).toEqual(filled.split.items);
    for (const typed of [
      { ...filled, split: { ...filled.split, exact: { gino: '600' } } },
      { ...filled, payerMode: 'multi' as const, payerAmounts: { gino: '1000', abbie: '260' } },
    ]) {
      expect(revertScan(typed, before, filled)).toMatchObject({ currency: 'JPY', amountRaw: '1260' });
    }
    // Only spaces or empty values added: nothing was typed, so everything goes back.
    expect(revertScan({ ...filled, split: { ...filled.split, exact: { gino: ' ' } } }, before, filled).currency).toBe('TWD');
    expect(revertScan(filled, before, filled)).toEqual(before);
  });

  it('undo of a scan in the form currency still puts back its lines when only the amount was retyped', () => {
    const before = draft();
    const after = applyScan(before, scan({ currency: 'JPY', total: 1260, items: [{ name: 'おにぎり', amount: 160 }] }), opts(before)).draft;
    const undone = revertScan({ ...after, amountRaw: '1300' }, before, after);
    expect(undone).toMatchObject({ currency: 'JPY', amountRaw: '1300' });
    expect(undone.split.items).toEqual([]);
  });

  it('a receipt without a currency was read in the form currency the scan started with', () => {
    // runScan sends the form's currency as the hint, so the amounts are in its decimals.
    const started = draft({ currency: 'USD' });
    const s = scan({ total: 9.75, items: [{ name: 'Latte', amount: 4.5 }, { name: 'Water', amount: 2 }] });
    expect(applyScan(started, s, opts(started)).draft).toMatchObject({ currency: 'USD', amountRaw: '9.75' });
    // Switched to TWD meanwhile: those amounts are not Taiwan dollars.
    const now = { ...started, currency: 'TWD' };
    const r = applyScan(now, s, opts(started));
    expect(r.draft).toEqual(now);
    expect(r.notes).toEqual([{ code: 'currency_changed' }]);
  });

  it('a second receipt replaces the store name and category the first one filled', () => {
    // The wrong photo first (Lawson), then the right one (鼎泰豐).
    const d = draft();
    const first = applyScan(d, scan({ merchant: 'ローソン 札幌駅前店', currency: 'JPY', total: 1260, date: '2026-10-15', category: 'food.groceries' }), opts(d));
    // A receipt's category that is not its store name's counts as picked (withSuggestion), which on
    // its own would keep it through the next scan.
    expect(first.draft).toMatchObject({ description: 'ローソン 札幌駅前店', category: 'food.groceries', categoryManual: true });
    expect(first.scannedText).toEqual({ description: 'ローソン 札幌駅前店', category: { key: 'food.groceries', manual: true } });
    const dtf = scan({ merchant: '鼎泰豐 信義店', currency: 'TWD', total: 2222, date: '2026-10-16', category: 'food.dining' });
    const second = applyScan(first.draft, dtf, opts(first.draft, { lastScanned: first.scannedText }));
    expect(second.draft).toMatchObject({ currency: 'TWD', amountRaw: '2222', date: '2026-10-16', description: '鼎泰豐 信義店', category: 'food.dining' });
    expect(second.filled).toEqual(['currency', 'amount', 'date', 'description', 'category']);
    expect(second.notes).toEqual([]);
    expect(second.scannedText).toMatchObject({ description: '鼎泰豐 信義店', category: { key: 'food.dining' } });

    // The first receipt gave only a category: the second's store name and category still go in.
    const onlyCategory = applyScan(d, scan({ category: 'food.groceries' }), opts(d));
    expect(onlyCategory.draft).toMatchObject({ description: '', category: 'food.groceries', categoryManual: true });
    const after = applyScan(onlyCategory.draft, dtf, opts(onlyCategory.draft, { lastScanned: onlyCategory.scannedText }));
    expect(after.draft).toMatchObject({ description: '鼎泰豐 信義店', category: 'food.dining' });
  });

  it('what the person did to a scanned store name or category stays through the next scan', () => {
    const d = draft();
    const first = applyScan(d, scan({ merchant: 'ローソン 札幌駅前店', category: 'food.groceries' }), opts(d));
    const dtf = scan({ merchant: '鼎泰豐 信義店', category: 'food.dining' });
    const next = (from: EditorDraft) => applyScan(from, dtf, opts(from, { lastScanned: first.scannedText }));
    // The name typed over: kept, with its category.
    const typed = next(withDescription(first.draft, 'ローソン 早餐'));
    expect(typed.draft).toMatchObject({ description: 'ローソン 早餐', category: 'food.groceries' });
    expect(typed.filled).toEqual([]);
    // A category picked by hand: kept, while the store name is replaced.
    const picked = next(withCategory(first.draft, 'travel.hotel'));
    expect(picked.draft).toMatchObject({ description: '鼎泰豐 信義店', category: 'travel.hotel', categoryManual: true });
    expect(picked.filled).toEqual(['description']);
    expect(picked.scannedText.category).toEqual(first.scannedText.category);
    // A category picked by hand before the first scan is not one a scan set.
    const handFirst = applyScan(withCategory(d, 'travel.hotel'), scan({ merchant: 'ローソン 札幌駅前店', category: 'food.groceries' }), opts(d));
    expect(handFirst.scannedText).toEqual({ description: 'ローソン 札幌駅前店' });
    // A receipt without a store name may be the same one again: the first name and category stay.
    const nameless = applyScan(first.draft, scan({ category: 'food.dining' }), opts(first.draft, { lastScanned: first.scannedText }));
    expect(nameless.draft).toBe(first.draft);
    expect(nameless.scannedText).toEqual(first.scannedText);
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
