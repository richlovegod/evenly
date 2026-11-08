// 刪除群組 says first what is not settled yet (review B2-04, approved by Gino 2026-11-07;
// unsettledDeleteWarning in features/groups/SettingsTab.tsx): while anyone's balance is not 0, or
// the settle-up plan still has a payment (簡化債務 off keeps debts pair by pair, so it can at nets
// of 0), the first question starts with it, naming the plan's largest payment. A settled group gets
// '' and its dialog is as it was. The iPhone app's S1DeleteGroupWarningTests checks the same words
// for the same groups (GroupsDeleteWarning in GroupSettingsView.swift).

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // config.ts reads both as it loads: the API on this page's own origin, so cookie mode.
  const map = new Map<string, string>([['evenly.api', 'same-origin']]);
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage ??= storage;
  g.sessionStorage ??= storage;
  g.location ??= { origin: 'https://split.test', href: 'https://split.test/', pathname: '/', search: '', hash: '' };
});

import { computeSharesFor, type SplitInput } from '../../src/shared/split';
import type { ExpenseDTO, GroupSnapshotDTO, MemberDTO } from '../../src/shared/types';
import { summarize } from '../../src/web/features/groups/groupMath';
import { unsettledDeleteWarning } from '../../src/web/features/groups/SettingsTab';
import { getLocale, setLocale } from '../../src/web/lib/i18n';

const startLocale = getLocale();
afterEach(() => setLocale(startLocale));

const STAMP = '2026-11-07T00:00:00.000Z';

function member(id: string, name: string, sort: number): MemberDTO {
  return {
    id, groupId: 'g1', userId: sort === 0 ? 'u-gino' : null, name, color: '#2F6FB5', role: sort === 0 ? 'admin' : 'member', active: true, sort,
    createdAt: STAMP, claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null,
  };
}

/** A TWD group: me (gino, Gino), Abbie and 佳穎 (jiaying), in that order. */
function snapOf(expenses: ExpenseDTO[], simplify = true): GroupSnapshotDTO {
  return {
    group: {
      id: 'g1', name: '北海道', type: 'trip', currency: 'TWD', emoji: '', color: '#2F6FB5', simplify, notes: '',
      createdBy: 'u-gino', createdAt: STAMP, updatedAt: STAMP, version: 1, defaultSplit: null,
    },
    members: [member('gino', 'Gino', 0), member('abbie', 'Abbie', 1), member('jiaying', '佳穎', 2)],
    expenses,
    me: { memberId: 'gino', role: 'admin' },
    inviteCode: 'X',
  };
}

let seq = 0;
/** `payer` paid `amount` (NT$) for `among`, in equal parts; a payment goes to the one in `among`. */
function paid(payer: string, amount: number, among: string[], kind: ExpenseDTO['kind'] = 'expense'): ExpenseDTO {
  const id = 'e' + ++seq;
  const split: SplitInput = { method: 'equal', entries: among.map(memberId => ({ memberId })) };
  const r = computeSharesFor(id, amount, split);
  return {
    id, groupId: 'g1', kind, description: '晚餐', category: 'food.dining', amount, currency: 'TWD', fxRate: 1, date: '2026-11-01', notes: '',
    payers: [{ memberId: payer, amount }], split, shares: r.ok ? r.shares : [], repeat: 'none', repeatSeries: null, repeatStart: null,
    createdBy: 'u-gino', createdAt: STAMP, updatedBy: 'u-gino', updatedAt: STAMP, deletedAt: null, deletedBy: null,
    version: 1, commentCount: 0, refundOf: null, receipt: null,
  };
}

/** What the dialog starts with, from the numbers the 設定 tab works out (summarize). */
function words(snap: GroupSnapshotDTO): string {
  const summary = summarize(snap);
  return unsettledDeleteWarning(snap, summary.net, summary.transfers);
}

const ZH_AFTER = '刪除後，大家都看不到這些帳，也沒辦法在這裡結清。';
const EN_AFTER = 'Once it is deleted, no one can see them or settle them here.';

describe('刪除群組 with balances not settled (B2-04)', () => {
  it('says nothing for a settled group, so the dialog is as it was', () => {
    setLocale('zh-TW');
    expect(words(snapOf([]))).toBe('');
    // Abbie paid back her half: settled.
    expect(words(snapOf([paid('gino', 2400, ['gino', 'abbie']), paid('abbie', 1200, ['gino'], 'payment')]))).toBe('');
    setLocale('en');
    expect(words(snapOf([]))).toBe('');
  });

  it('names the one payment left, with the spaces Chinese needs around a name', () => {
    const abbie = snapOf([paid('gino', 2400, ['gino', 'abbie'])]);
    const jiaying = snapOf([paid('gino', 2400, ['gino', 'jiaying'])]);
    setLocale('zh-TW');
    expect(words(abbie)).toBe('這個群組還有沒結清的帳：Abbie 還要付你 NT$1,200。' + ZH_AFTER);
    expect(words(jiaying)).toBe('這個群組還有沒結清的帳：佳穎還要付你 NT$1,200。' + ZH_AFTER);
    setLocale('en');
    expect(words(abbie)).toBe('This group still has balances that are not settled: Abbie still owes you NT$1,200. ' + EN_AFTER);
    expect(words(jiaying)).toBe('This group still has balances that are not settled: 佳穎 still owes you NT$1,200. ' + EN_AFTER);
  });

  it('says it when I am the one who owes', () => {
    const snap = snapOf([paid('jiaying', 2400, ['gino', 'jiaying'])]);
    setLocale('zh-TW');
    expect(words(snap)).toBe('這個群組還有沒結清的帳：你還要付佳穎 NT$1,200。' + ZH_AFTER);
    setLocale('en');
    expect(words(snap)).toBe('This group still has balances that are not settled: you still owe 佳穎 NT$1,200. ' + EN_AFTER);
  });

  it('names the largest of several payments, also between two other people', () => {
    // Abbie paid NT$3,600 for the three of us, I paid NT$600 for 佳穎: 佳穎 pays Abbie NT$1,800 and I pay her NT$600.
    const snap = snapOf([paid('abbie', 3600, ['gino', 'abbie', 'jiaying']), paid('gino', 600, ['jiaying'])]);
    expect(summarize(snap).transfers).toEqual([
      { from: 'gino', to: 'abbie', amount: 600 },
      { from: 'jiaying', to: 'abbie', amount: 1800 },
    ]);
    setLocale('zh-TW');
    expect(words(snap)).toBe('這個群組還有沒結清的帳，最大的一筆：佳穎還要付 Abbie NT$1,800。' + ZH_AFTER);
    setLocale('en');
    expect(words(snap)).toBe('This group still has balances that are not settled. The largest: 佳穎 still owes Abbie NT$1,800. ' + EN_AFTER);
  });

  it('counts the pair-by-pair plan at nets of 0 (簡化債務 off), and says nothing once 簡化債務 is on', () => {
    // A circle: everyone's balance is 0, but pair by pair each of us still pays the next one NT$1,200.
    const circle = [paid('gino', 1200, ['abbie']), paid('abbie', 1200, ['jiaying']), paid('jiaying', 1200, ['gino'])];
    const pairs = snapOf(circle, false);
    expect(Object.values(summarize(pairs).net).every(v => v === 0)).toBe(true);
    expect(summarize(pairs).transfers).toHaveLength(3);
    setLocale('zh-TW');
    // All three are the same amount: the first in the plan's order is named.
    expect(words(pairs)).toBe('這個群組還有沒結清的帳，最大的一筆：你還要付佳穎 NT$1,200。' + ZH_AFTER);
    setLocale('en');
    expect(words(pairs)).toBe('This group still has balances that are not settled. The largest: you still owe 佳穎 NT$1,200. ' + EN_AFTER);
    expect(words(snapOf(circle, true))).toBe('');
  });

  it('says the words without a payment when the plan could not be worked out, and names someone no longer listed', () => {
    const snap = snapOf([]);
    setLocale('zh-TW');
    expect(unsettledDeleteWarning(snap, { gino: 1200, abbie: -1200 }, [])).toBe('這個群組還有沒結清的帳。' + ZH_AFTER);
    expect(unsettledDeleteWarning(snap, { gino: 500, ghost: -500 }, [{ from: 'ghost', to: 'gino', amount: 500 }])).toBe(
      '這個群組還有沒結清的帳：（已移除）還要付你 NT$500。' + ZH_AFTER,
    );
    setLocale('en');
    expect(unsettledDeleteWarning(snap, { gino: 1200, abbie: -1200 }, [])).toBe('This group still has balances that are not settled. ' + EN_AFTER);
    expect(unsettledDeleteWarning(snap, { gino: 500, ghost: -500 }, [{ from: 'ghost', to: 'gino', amount: 500 }])).toBe(
      'This group still has balances that are not settled: (removed) still owes you NT$500. ' + EN_AFTER,
    );
  });
});
