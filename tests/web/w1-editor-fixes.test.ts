// Review fixes in the expense editor (review-1106, unit W1): a refund carried to another group,
// the stash and the copy its save merges against, an edit's save and its 復原, typed money when the
// currency loses decimals, the amount field's blur format, a rate still loading, and English
// plurals; and the stash is the account's that typed it (I1-correct-01; that it goes with the
// session is in w2-session.test.ts). The merges themselves run against the real Worker in
// tests/worker/w1-edit-merge.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// editorText.ts reaches lib/api.ts, which reads location and storage when it loads; the stash uses
// sessionStorage.
vi.hoisted(() => {
  const store = () => {
    const map = new Map<string, string>([['evenly.api', 'same-origin']]);
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    };
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage ??= store();
  g.sessionStorage ??= store();
  g.location ??= { origin: 'https://split.test', href: 'https://split.test/', pathname: '/', search: '', hash: '' };
});

import {
  draftFromExpense,
  draftSignature,
  evaluate,
  fitDecimals,
  newDraft,
  readAmount,
  undoOfEdit,
  withCurrency,
  withEditBase,
  withKind,
  type EditorDraft,
  type EvalContext,
} from '../../src/web/features/expenses/editorLogic';
import { carryDraft, clearCarried, clearStash, dropStaleStash, peekCarried, peekStash, stashDraft, withCarried } from '../../src/web/features/expenses/editorPrefs';
import { payerChipText, reasonShort, reasonText } from '../../src/web/features/expenses/editorText';
import { setLocale } from '../../src/web/lib/i18n';
import { computeSharesFor, type SplitInput } from '../../src/shared/split';
import type { ExpenseDTO, MemberDTO } from '../../src/shared/types';

const IDS = ['gino', 'abbie', 'kevin'];

function member(id: string, name: string, sort: number): MemberDTO {
  return {
    id, groupId: 'g1', userId: null, name, color: '#2F6FB5', role: 'member', active: true, sort, createdAt: '2026-10-01T00:00:00.000Z',
    claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null,
  };
}

function draft(over: Partial<EditorDraft> = {}): EditorDraft {
  return { ...newDraft({ id: 'e-new', memberIds: IDS, meId: 'gino', currency: 'TWD', date: '2026-11-05' }), ...over };
}

function ctx(over: Partial<EvalContext> = {}): EvalContext {
  return { memberIds: IDS, meId: 'gino', groupCurrency: 'TWD', fetchedRate: null, ...over };
}

function expense(over: Partial<ExpenseDTO> = {}): ExpenseDTO {
  const split: SplitInput = over.split ?? { method: 'equal', entries: IDS.map(memberId => ({ memberId })) };
  const amount = over.amount ?? 3000;
  const id = over.id ?? 'e-1';
  const r = computeSharesFor(id, amount, split);
  return {
    id, groupId: 'g1', kind: 'expense', description: '晚餐', category: 'food.dining', amount, currency: 'TWD', fxRate: 1, date: '2026-11-05',
    notes: '', payers: [{ memberId: 'gino', amount }], split, shares: r.ok ? r.shares : [], repeat: 'none', repeatSeries: null, repeatStart: null,
    createdBy: 'u-gino', createdAt: '2026-11-05T10:00:00.000Z', updatedBy: 'u-gino', updatedAt: '2026-11-05T10:00:00.000Z', deletedAt: null,
    deletedBy: null, version: 4, commentCount: 0, refundOf: null, receipt: null, ...over,
  };
}

afterEach(() => {
  setLocale('zh-TW');
  clearCarried();
  clearStash();
});

/** What carryDraft keeps of `d`. */
function peekCarriedFrom(d: EditorDraft) {
  carryDraft('g-carry', d);
  return peekCarried('g-carry')!;
}

describe('a new entry carried to another group (B5-02)', () => {
  it('stays a refund, refunding nothing in particular there and never repeating', () => {
    const left = withKind(draft({ amountRaw: '30000', description: '退款：民宿押金', currency: 'JPY', refundOf: 'e-deposit' }), 'refund');
    carryDraft('g2', left);
    const carried = peekCarried('g2');
    expect(carried?.kind).toBe('refund');
    const fresh = { ...draft({ id: 'e-there', repeat: 'monthly' }), payerId: 'abbie' };
    const d = withCarried(fresh, carried!);
    expect(d).toMatchObject({ id: 'e-there', kind: 'refund', amountRaw: '30000', description: '退款：民宿押金', currency: 'JPY', payerId: 'abbie' });
    expect(d.repeat).toBe('none');
    // refundOf named the other group's expense: not carried, so nothing is sent for it.
    expect(d.refundOf).toBeUndefined();
    const body = evaluate(d, ctx({ groupCurrency: 'JPY' })).body;
    expect(body?.kind).toBe('refund');
    expect(body && 'refundOf' in body).toBe(false);
  });

  it('keeps an expense an expense, also over a form the route opened as a refund', () => {
    carryDraft('g2', draft({ amountRaw: '1200', description: '計程車' }));
    const carried = peekCarried('g2')!;
    expect(carried.kind).toBe('expense');
    expect(withCarried(draft(), carried).kind).toBe('expense');
    const asRefund = withKind(draft(), 'refund');
    expect(withCarried(asRefund, carried)).toMatchObject({ kind: 'expense', refundOf: null, description: '計程車' });
  });

  it('never makes a carried refund repeat', () => {
    const carried = { ...peekCarriedFrom(withKind(draft({ amountRaw: '500' }), 'refund')), repeat: 'monthly' as const };
    expect(withCarried(draft(), carried).repeat).toBe('none');
    expect(withCarried(draft(), { ...carried, kind: 'expense' }).repeat).toBe('monthly');
  });

  it('carries a payment over as an expense, as before', () => {
    carryDraft('g2', draft({ kind: 'payment', amountRaw: '500' }));
    expect(peekCarried('g2')?.kind).toBe('expense');
  });
});

describe('a form left behind (B5-03)', () => {
  it('keeps the group currency of its rates and, for an edit, the copy its save merges against', () => {
    const opened = expense();
    const d = { ...draftFromExpense(opened, { memberIds: IDS }), notes: 'my note' };
    stashDraft('g1:e-1', d, { userId: 'u-gino', rateBase: 'TWD', opened: { entry: opened, rateBase: 'TWD' } });
    const back = peekStash('g1:e-1', 'u-gino');
    expect(back?.draft).toEqual(d);
    expect(back?.rateBase).toBe('TWD');
    expect(back?.opened).toEqual({ entry: opened, rateBase: 'TWD' });
    // Another editor's key finds nothing.
    expect(peekStash('g1:new', 'u-gino')).toBeNull();
  });

  it('reads a record without a currency as one, and leaves out a copy that cannot be a merge base', () => {
    const d = draft({ amountRaw: '120' });
    sessionStorage.setItem('evenly.editorRescue', JSON.stringify({ key: 'g1:new', userId: 'u-gino', at: Date.now(), draft: d }));
    expect(peekStash('g1:new', 'u-gino')).toEqual({ draft: d, rateBase: null, opened: null });
    // The form then merges against the entry as it is.
    sessionStorage.setItem(
      'evenly.editorRescue',
      JSON.stringify({ key: 'g1:e-1', userId: 'u-gino', at: Date.now(), draft: d, rateBase: 'TWD', opened: { entry: { id: 'e-1' }, rateBase: 'TWD' } }),
    );
    expect(peekStash('g1:e-1', 'u-gino')?.opened).toBeNull();
  });

  it('is gone after 30 minutes', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
      stashDraft('g1:new', draft({ amountRaw: '120' }), { userId: 'u-gino', rateBase: 'TWD' });
      vi.setSystemTime(new Date('2026-11-07T10:29:00Z'));
      expect(peekStash('g1:new', 'u-gino')?.draft.amountRaw).toBe('120');
      vi.setSystemTime(new Date('2026-11-07T10:31:00Z'));
      expect(peekStash('g1:new', 'u-gino')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a form left behind is the account\'s that typed it (review I1-correct-01)', () => {
  const stored = () => sessionStorage.getItem('evenly.editorRescue');

  it('only that account gets it back: not another one signed in in this tab, and not a signed-out page', () => {
    stashDraft('g1:new', draft({ amountRaw: '48600', notes: '訂位代號 A12' }), { userId: 'u-gino', rateBase: 'JPY' });
    expect(peekStash('g1:new', 'u-abbie')).toBeNull();
    expect(peekStash('g1:new', null)).toBeNull();
    expect(peekStash('g1:new', 'u-gino')?.draft).toMatchObject({ amountRaw: '48600', notes: '訂位代號 A12' });
  });

  it('keeps nothing without an account (signed out, or the editor that goes with a sign-out)', () => {
    stashDraft('g1:new', draft({ amountRaw: '120' }), { userId: null, rateBase: 'TWD' });
    expect(stored()).toBeNull();
  });

  it('a stash kept before 2026-11-07 names no account, so nobody gets it', () => {
    const d = draft({ amountRaw: '120' });
    sessionStorage.setItem('evenly.editorRescue', JSON.stringify({ key: 'g1:new', at: Date.now(), draft: d, rateBase: 'TWD' }));
    expect(peekStash('g1:new', 'u-gino')).toBeNull();
  });

  it('a page that starts as that account keeps it; one that starts as another account, or signed out, drops it', () => {
    const keep = () => stashDraft('g1:new', draft({ amountRaw: '120' }), { userId: 'u-gino', rateBase: 'TWD' });
    keep();
    dropStaleStash('u-gino');
    expect(peekStash('g1:new', 'u-gino')?.draft.amountRaw).toBe('120');
    dropStaleStash('u-abbie');
    expect(stored()).toBeNull();
    keep();
    dropStaleStash(null);
    expect(stored()).toBeNull();
    // One that names no account, or cannot be read, goes too.
    sessionStorage.setItem('evenly.editorRescue', JSON.stringify({ key: 'g1:new', at: Date.now(), draft: draft() }));
    dropStaleStash('u-gino');
    expect(stored()).toBeNull();
    sessionStorage.setItem('evenly.editorRescue', '{not json');
    dropStaleStash('u-gino');
    expect(stored()).toBeNull();
  });

  it('a page that starts after its 30 minutes drops it, as the iPhone app does at launch', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
      stashDraft('g1:new', draft({ amountRaw: '120' }), { userId: 'u-gino', rateBase: 'TWD' });
      vi.setSystemTime(new Date('2026-11-07T10:31:00Z'));
      dropStaleStash('u-gino');
      expect(stored()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an edit's save and its 復原 (B5-03, B5-04)", () => {
  const opened = expense({ notes: '' });
  const edited = evaluate({ ...draftFromExpense(opened, { memberIds: IDS }), amountRaw: '3600', payerAmounts: {} }, ctx()).body!;

  it('the save says the group currency of its rates, and merges against the copy the form opened with', () => {
    const body = withEditBase(edited, opened, { groupCurrency: 'JPY', openedBase: 'TWD' });
    expect(body).toMatchObject({ amount: 3600, rateBase: 'JPY', baseVersion: 4 });
    expect(body.base).toMatchObject({ amount: 3000, description: '晚餐', rateBase: 'TWD' });
    expect(body.base && 'baseVersion' in body.base).toBe(false);
    expect(body.base && 'base' in body.base).toBe(false);
  });

  it('復原 puts back the copy it is given (the page gives the one the save was merged against), merged against what the save sent', () => {
    const sent = withEditBase(edited, opened, { groupCurrency: 'TWD', openedBase: 'TWD' });
    const shown = { ...opened, notes: 'Booking A12', version: 5 };
    const undo = undoOfEdit(sent, shown, 'TWD');
    expect(undo).toMatchObject({ amount: 3000, notes: 'Booking A12', rateBase: 'TWD', baseVersion: 5 });
    const { base: _b, baseVersion: _v, ...sentBody } = sent;
    expect(undo.base).toEqual(sentBody);
  });
});

describe('a currency with fewer decimals (B5-08)', () => {
  it('turns typed numbers into what they read as there', () => {
    const d = draft({
      currency: 'USD',
      amountRaw: '12.50',
      payerMode: 'multi',
      payerAmounts: { gino: '6.25', abbie: '6.25', kevin: '' },
      split: {
        method: 'exact', included: IDS, exact: { gino: '4.5', abbie: '8' }, percent: { gino: '33.3' }, shares: {}, adjust: { kevin: '-1.50' },
        items: [{ id: 'item-1', name: '牛排', amountRaw: '9.75', memberIds: ['gino'] }],
      },
    });
    const fit = withCurrency(fitDecimals(d, 'TWD'), 'TWD');
    expect(fit.amountRaw).toBe('13');
    expect(fit.payerAmounts).toEqual({ gino: '6', abbie: '6', kevin: '' });
    expect(fit.split.exact).toEqual({ gino: '5', abbie: '8' });
    expect(fit.split.adjust).toEqual({ kevin: '-2' });
    expect(fit.split.items[0].amountRaw).toBe('10');
    // Not money: as typed.
    expect(fit.split.percent).toEqual({ gino: '33.3' });
    // What the card shows is what is saved.
    expect(readAmount(fit.amountRaw, 'TWD')).toEqual({ state: 'ok', value: 13 });
    expect(evaluate({ ...fit, payerMode: 'single', split: { ...fit.split, method: 'equal' } }, ctx()).body?.amount).toBe(13);
  });

  it('leaves expressions, whole numbers and a lone sign as typed', () => {
    const d = draft({ currency: 'USD', amountRaw: '12.50+3', split: { ...draft().split, adjust: { gino: '-', abbie: '300' } } });
    const fit = fitDecimals(d, 'JPY');
    expect(fit.amountRaw).toBe('12.50+3');
    expect(fit.split.adjust).toEqual({ gino: '-', abbie: '300' });
    expect(fitDecimals(draft({ currency: 'USD', amountRaw: '1,234.56' }), 'JPY').amountRaw).toBe('1235');
  });

  it('changes nothing when the new currency has as many decimals or more', () => {
    const d = draft({ currency: 'TWD', amountRaw: '1200' });
    expect(fitDecimals(d, 'USD')).toBe(d);
    const usd = draft({ currency: 'USD', amountRaw: '12.50' });
    expect(fitDecimals(usd, 'EUR')).toBe(usd);
  });
});

describe('the amount as the mouse field formats it (B5-09)', () => {
  it('is no change', () => {
    const base = draftFromExpense(expense({ amount: 1200 }), { memberIds: IDS });
    expect(base.amountRaw).toBe('1200');
    expect(draftSignature({ ...base, amountRaw: '1,200' })).toBe(draftSignature(base));
    const usd = draft({ currency: 'USD', amountRaw: '12' });
    expect(draftSignature({ ...usd, amountRaw: '12.00' })).toBe(draftSignature(usd));
  });

  it('still tells a different amount, or a first one, from none', () => {
    const base = draftFromExpense(expense({ amount: 1200 }), { memberIds: IDS });
    expect(draftSignature({ ...base, amountRaw: '1,201' })).not.toBe(draftSignature(base));
    expect(draftSignature(draft({ amountRaw: '1' }))).not.toBe(draftSignature(draft()));
    expect(draftSignature(draft({ amountRaw: '0' }))).not.toBe(draftSignature(draft()));
  });
});

describe('a rate still on its way (B5-11)', () => {
  const jpy = draft({ currency: 'JPY', amountRaw: '3000', description: '拉麵' });

  it('waits for it instead of asking for one by hand', () => {
    expect(evaluate(jpy, ctx({ fxLoading: true })).reason).toEqual({ code: 'fx_loading' });
    expect(evaluate(jpy, ctx()).reason).toEqual({ code: 'fx_missing' });
    // A typed rate that cannot be read is still what to fix.
    expect(evaluate({ ...jpy, fxManual: '0' }, ctx({ fxLoading: true })).reason).toEqual({ code: 'fx_invalid' });
    // Once it is here, nothing stops the save.
    expect(evaluate(jpy, ctx({ fetchedRate: 0.2105, fxLoading: false })).reason).toBeNull();
  });

  it('says so in both languages', () => {
    expect(reasonText({ code: 'fx_loading' }, 'JPY')).toBe('正在取得匯率，請稍等一下。');
    expect(reasonShort({ code: 'fx_loading' })).toBe('正在取得匯率');
    setLocale('en');
    expect(reasonText({ code: 'fx_loading' }, 'JPY')).toBe('Getting the exchange rate. One moment.');
    expect(reasonShort({ code: 'fx_loading' })).toBe('Getting the rate');
  });
});

describe('English plurals (B5-13)', () => {
  const members = [member('gino', 'Gino', 0), member('abbie', 'Abbie', 1), member('kevin', 'Kevin', 2)];

  beforeEach(() => setLocale('en'));

  it('the payer chip says 1 person, then people', () => {
    const multi = draft({ payerMode: 'multi', payerAmounts: { gino: '1200' } });
    expect(payerChipText(multi, members, 'gino')).toBe('1 person');
    expect(payerChipText({ ...multi, payerAmounts: { gino: '1200', abbie: '300' } }, members, 'gino')).toBe('2 people');
    setLocale('zh-TW');
    expect(payerChipText(multi, members, 'gino')).toBe('1 人');
  });
});
