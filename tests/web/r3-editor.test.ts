// Review-1106, third pass, in the expense editor's logic (editorLogic.ts): a currency picked by
// mistake and picked back keeps what was typed (W1-correct-02, pickCurrency), and a refund in
// another currency shows its group-currency shares as entered, as the iPhone app does (I1-correct-04,
// baseShares). The 復原 built from the copy the save was merged against runs against the real
// Worker in tests/worker/w1-edit-merge.test.ts (W1-correct-01).

import { describe, expect, it, vi } from 'vitest';

// editorLogic reaches lib/api.ts, which reads location and storage when it loads.
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
  baseShares,
  evaluate,
  newDraft,
  pickCurrency,
  shareRange,
  withKind,
  type EditorDraft,
  type EvalContext,
  type FitUndo,
} from '../../src/web/features/expenses/editorLogic';

const IDS = ['gino', 'abbie', 'kevin'];

function draft(over: Partial<EditorDraft> = {}): EditorDraft {
  return { ...newDraft({ id: 'e-new', memberIds: IDS, meId: 'gino', currency: 'USD', date: '2026-11-05' }), ...over };
}

function ctx(over: Partial<EvalContext> = {}): EvalContext {
  return { memberIds: IDS, meId: 'gino', groupCurrency: 'USD', fetchedRate: null, ...over };
}

/** Picks one currency after another, keeping the undo from pick to pick as the page does. */
function pickAll(d: EditorDraft, codes: string[]): EditorDraft {
  let undo: FitUndo | null = null;
  for (const code of codes) {
    const r = pickCurrency(d, code, undo);
    d = r.draft;
    undo = r.undo;
  }
  return d;
}

describe('a currency picked by mistake and picked back (review W1-correct-02)', () => {
  const typed = draft({
    amountRaw: '12.50',
    split: { method: 'exact', included: IDS, exact: { gino: '4.25', abbie: '8.25' }, percent: {}, shares: {}, adjust: {}, items: [] },
  });

  it('TWD shows what it reads as (13, 4 / 8), and USD again brings back 12.50 with 4.25 / 8.25, which saves US$12.50', () => {
    const twd = pickAll(typed, ['TWD']);
    expect([twd.currency, twd.amountRaw, twd.split.exact]).toEqual(['TWD', '13', { gino: '4', abbie: '8' }]);
    const back = pickAll(typed, ['TWD', 'USD']);
    expect([back.currency, back.amountRaw, back.split.exact]).toEqual(['USD', '12.50', { gino: '4.25', abbie: '8.25' }]);
    const ev = evaluate(back, ctx());
    expect(ev.reason).toBeNull();
    expect(ev.body?.amount).toBe(1250);
  });

  it('a pasted 12.345 taken to JPY and back is 12.345 again (not 12,345 dollars)', () => {
    const pasted = draft({ amountRaw: '12.345' });
    expect(pickAll(pasted, ['JPY']).amountRaw).toBe('12345');
    expect(pickAll(pasted, ['JPY', 'USD']).amountRaw).toBe('12.345');
  });

  it('also through a currency that changes nothing on the way (TWD, then JPY, then USD)', () => {
    expect(pickAll(typed, ['TWD', 'JPY', 'USD']).amountRaw).toBe('12.50');
    expect(pickAll(typed, ['TWD', 'EUR', 'USD']).split.exact).toEqual({ gino: '4.25', abbie: '8.25' });
  });

  it('keeps what was typed after the pick: the fit is not undone then', () => {
    const r1 = pickCurrency(typed, 'TWD', null);
    const retyped = { ...r1.draft, amountRaw: '400' };
    const r2 = pickCurrency(retyped, 'USD', r1.undo);
    expect(r2.draft.amountRaw).toBe('400');
    expect(r2.draft.split.exact).toEqual({ gino: '4', abbie: '8' });
  });

  it('drops the typed rate as before, and decides the same when run twice with the same undo (React may)', () => {
    const r1 = pickCurrency({ ...typed, fxManual: '32.1' }, 'TWD', null);
    expect(r1.draft.fxManual).toBe('');
    const a = pickCurrency(r1.draft, 'USD', r1.undo);
    const b = pickCurrency(r1.draft, 'USD', r1.undo);
    expect(a).toEqual(b);
    expect(a.undo).toBeNull();
    // Picking the currency it has changes nothing.
    expect(pickCurrency(typed, 'USD', null).draft).toBe(typed);
  });
});

describe('a refund in another currency, in the group currency (review I1-correct-04)', () => {
  it('¥30,000 at 0.2105 split by 4: each about NT$1,578, as entered (the iPhone app shows the same)', () => {
    const four = ['gino', 'abbie', 'kevin', 'mia'];
    const refund = withKind({ ...newDraft({ id: 'e-refund', memberIds: four, meId: 'gino', currency: 'JPY', date: '2026-11-05' }), amountRaw: '30000' }, 'refund');
    const ev = evaluate(refund, { memberIds: four, meId: 'gino', groupCurrency: 'TWD', fetchedRate: 0.2105 });
    expect(ev.reason).toBeNull();
    // toBase gives a refund's parts below zero.
    expect(ev.base!.owed.every(o => o.amount < 0)).toBe(true);
    const shown = baseShares(ev, true)!;
    expect(shareRange(shown)).toEqual({ min: 1578, max: 1579 });
    expect(shown.find(o => o.memberId === 'gino')!.amount).toBeGreaterThan(0);
    // In the group currency the lines show no second amount.
    expect(baseShares(ev, false)).toBeNull();
  });
});
