// 退款 in the app (docs/SPEC.md section 2, Refunds): 記一筆退款 prefills a refund from an expense
// (editorLogic.draftForRefund), the 費用 / 退款 switch (withKind), what the editor shows and sends for
// a refund (evaluate: the effect, refundOf, never repeating), the two-person quick choices and
// their words, the row's words and effect (ExpenseRow rowEffect, describe.paidLine), the feed's
// sentences and effect (activityText), 統計 (refunds come off the spending and their category),
// the Splitwise import of negative rows and our own CSV export. The ¥30,000 example: Gino got
// back a deposit that four people paid equally.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const map = new Map<string, string>([['evenly.api', 'same-origin']]);
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = storage;
  g.sessionStorage = storage;
  g.location = { origin: 'https://split.test', href: 'https://split.test/', pathname: '/', search: '', hash: '' };
});

import { refundDescription } from '../../src/shared/refunds';
import { computeSharesFor, type SplitInput } from '../../src/shared/split';
import type { ActivityDTO, ExpenseDTO, GroupSnapshotDTO, MemberDTO } from '../../src/shared/types';
import { describeActivity, type ActivityContext } from '../../src/web/features/activity/activityText';
import {
  activePreset, applyPreset, bodyOfExpense, draftForRefund, draftFromExpense, draftSignature, evaluate, newDraft, withKind, type EditorDraft,
} from '../../src/web/features/expenses/editorLogic';
import { historyText, presetLabel } from '../../src/web/features/expenses/editorText';
import { rowEffect, stubText } from '../../src/web/features/groups/ExpenseRow';
import { buildExportRows, buildImport, parseSplitwiseCsv, type ExportLabels } from '../../src/web/features/groups/splitwiseImport';
import { computeStats } from '../../src/web/features/groups/StatsTab';
import { paidLine } from '../../src/web/lib/describe';
import { money, setLocale } from '../../src/web/lib/i18n';

const FOUR = ['gino', 'abbie', 'kevin', 'tiffany'];
const ctx = { memberIds: FOUR, meId: 'gino', groupCurrency: 'JPY', fetchedRate: null, locale: 'zh-TW' };

function entry(over: Partial<ExpenseDTO> = {}): ExpenseDTO {
  const split: SplitInput = over.split ?? { method: 'equal', entries: FOUR.map(memberId => ({ memberId })) };
  const amount = over.amount ?? 30000;
  const id = over.id ?? 'e-deposit';
  const r = computeSharesFor(id, amount, split);
  return {
    id, groupId: 'g1', kind: 'expense', description: '民宿押金', category: 'travel.hotel', amount, currency: 'JPY', fxRate: 1,
    date: '2026-10-01', notes: '訂房網站', payers: [{ memberId: 'gino', amount }], split, shares: r.ok ? r.shares : [],
    repeat: 'none', repeatSeries: null, repeatStart: null, createdBy: 'u-gino', createdAt: '2026-10-01T10:00:00.000Z',
    updatedBy: 'u-gino', updatedAt: '2026-10-01T10:00:00.000Z', deletedAt: null, deletedBy: null, version: 1, commentCount: 0,
    refundOf: null, receipt: null, ...over,
  };
}

const deposit = entry();
const refund = entry({ id: 'r-deposit', kind: 'refund', description: '退款：民宿押金', notes: '', date: '2026-10-20', refundOf: 'e-deposit' });

beforeEach(() => setLocale('zh-TW'));
afterEach(() => setLocale('zh-TW'));

describe('記一筆退款: a refund from an expense', () => {
  it('starts as the expense was, read as whose money it is and who got it back', () => {
    const d = draftForRefund(deposit, { id: 'r-1', memberIds: FOUR, date: '2026-10-20', description: refundDescription(deposit.description, 'zh-TW') });
    expect(d).toMatchObject({
      id: 'r-1', kind: 'refund', amountRaw: '30000', currency: 'JPY', description: '退款：民宿押金', category: 'travel.hotel', categoryManual: true,
      date: '2026-10-20', notes: '', repeat: 'none', payerMode: 'single', payerId: 'gino', refundOf: 'e-deposit', fxStored: null,
    });
    expect(d.split.method).toBe('equal');
    expect(d.split.included).toEqual(FOUR);
  });

  it('keeps several payers with their amounts, and an unequal split with its values', () => {
    const shared = entry({
      payers: [{ memberId: 'gino', amount: 20000 }, { memberId: 'abbie', amount: 10000 }],
      split: { method: 'percent', entries: [{ memberId: 'gino', value: 70 }, { memberId: 'abbie', value: 30 }] },
    });
    const d = draftForRefund(shared, { id: 'r-2', memberIds: FOUR, date: '2026-10-20', description: 'Refund: x' });
    expect(d.payerMode).toBe('multi');
    expect(d.payerAmounts).toEqual({ gino: '20000', abbie: '10000' });
    expect(d.split.method).toBe('percent');
    expect(d.split.percent).toEqual({ gino: '70', abbie: '30' });
  });

  it('the editor shows the ¥30,000 example: Gino owes the others ¥22,500; each of them gets back ¥7,500', () => {
    const d = draftForRefund(deposit, { id: 'r-1', memberIds: FOUR, date: '2026-10-20', description: '退款：民宿押金' });
    const mine = evaluate(d, ctx);
    expect(mine.reason).toBeNull();
    expect(mine.shares.map(s => s.amount)).toEqual([7500, 7500, 7500, 7500]);
    expect(mine.me).toEqual({ involved: true, net: -22500, currency: 'JPY' });
    expect(evaluate(d, { ...ctx, meId: 'abbie' }).me).toEqual({ involved: true, net: 7500, currency: 'JPY' });
    expect(mine.body).toMatchObject({ kind: 'refund', refundOf: 'e-deposit', repeat: 'none', description: '退款：民宿押金', category: 'travel.hotel' });
  });

  it('in another currency without a rate yet, the effect is in that currency, the other way round too', () => {
    const d = { ...draftForRefund(deposit, { id: 'r-1', memberIds: FOUR, date: '2026-10-20', description: 'x' }), currency: 'USD', amountRaw: '200' };
    const ev = evaluate(d, ctx);
    expect(ev.reason).toEqual({ code: 'fx_missing' });
    expect(ev.me).toEqual({ involved: true, net: -15000, currency: 'USD' });
    const withRate = evaluate(d, { ...ctx, fetchedRate: 150 });
    expect(withRate.me).toEqual({ involved: true, net: -22500, currency: 'JPY' });
    expect(withRate.converted).toBe(30000);
  });
});

describe('the 費用 / 退款 switch', () => {
  it('flips the kind and keeps the people and amounts; a refund never repeats, an expense links nothing', () => {
    const fresh: EditorDraft = { ...newDraft({ id: 'e-9', memberIds: FOUR, meId: 'gino', currency: 'JPY', date: '2026-10-20' }), amountRaw: '8000', description: '門票', repeat: 'monthly' };
    const r = withKind(fresh, 'refund');
    expect(r).toMatchObject({ kind: 'refund', amountRaw: '8000', description: '門票', repeat: 'none', payerId: 'gino' });
    expect(evaluate(r, ctx).body).toMatchObject({ kind: 'refund', repeat: 'none' });
    expect(evaluate(r, ctx).body?.refundOf).toBeUndefined();
    const back = withKind({ ...r, refundOf: 'e-1' }, 'expense');
    expect(back).toMatchObject({ kind: 'expense', refundOf: null });
    expect(withKind(r, 'refund')).toBe(r);
    // A payment has no switch.
    const pay = { ...fresh, kind: 'payment' as const };
    expect(withKind(pay, 'refund')).toBe(pay);
    // Switching is a change to save.
    expect(draftSignature(r)).not.toBe(draftSignature({ ...r, kind: 'expense' }));
  });

  it('each refund chip sets the same payer and split as before, and its words say the debt it leaves', () => {
    const two = ['gino', 'abbie'];
    const d = withKind(newDraft({ id: 'r-4', memberIds: two, meId: 'gino', currency: 'JPY', date: '2026-10-20' }), 'refund');
    const want = {
      // payer = who got the money back, included = whose money it is; net = what I get back (+) or owe (-) of ¥1,000.
      'i-equal': { payer: 'gino', included: ['gino', 'abbie'], net: -500, zh: '我欠 Abbie 一半', en: 'I owe Abbie half' },
      'i-full': { payer: 'gino', included: ['abbie'], net: -1000, zh: '我欠 Abbie 全部', en: 'I owe Abbie all of it' },
      'they-equal': { payer: 'abbie', included: ['gino', 'abbie'], net: 500, zh: 'Abbie 欠我一半', en: 'Abbie owes me half' },
      'they-full': { payer: 'abbie', included: ['gino'], net: 1000, zh: 'Abbie 欠我全部', en: 'Abbie owes me all of it' },
    } as const;
    for (const k of ['i-equal', 'i-full', 'they-equal', 'they-full'] as const) {
      const p = applyPreset(d, k, 'gino', 'abbie');
      expect(p.kind).toBe('refund');
      expect([p.payerMode, p.payerId, p.split.method, [...p.split.included].sort()]).toEqual(['single', want[k].payer, 'equal', [...want[k].included].sort()]);
      expect(activePreset(p, 'gino', 'abbie')).toBe(k);
      expect(evaluate({ ...p, amountRaw: '1000' }, { ...ctx, memberIds: two }).me?.net).toBe(want[k].net);
      setLocale('zh-TW');
      expect(presetLabel(k, 'Abbie', true)).toBe(want[k].zh);
      setLocale('en');
      expect(presetLabel(k, 'Abbie', true)).toBe(want[k].en);
    }
  });

  it('the two-person choices work for a refund', () => {
    const two = ['gino', 'abbie'];
    const d = withKind(newDraft({ id: 'r-3', memberIds: two, meId: 'gino', currency: 'JPY', date: '2026-10-20' }), 'refund');
    expect(activePreset(d, 'gino', 'abbie')).toBe('i-equal');
    const theirs = applyPreset(d, 'i-full', 'gino', 'abbie');
    expect(activePreset(theirs, 'gino', 'abbie')).toBe('i-full');
    const ev = evaluate({ ...theirs, amountRaw: '1000' }, { ...ctx, memberIds: two });
    // I got it all back and it is all Abbie's: I owe her 1,000.
    expect(ev.me?.net).toBe(-1000);
  });

  it('an edit of a refund keeps its link, and its undo puts the link back', () => {
    const d = draftFromExpense(refund, { memberIds: FOUR });
    expect(d.kind).toBe('refund');
    expect(d.refundOf).toBe('e-deposit');
    expect(d.split.method).toBe('equal');
    expect(evaluate(d, ctx).body?.refundOf).toBe('e-deposit');
    expect(bodyOfExpense(refund)).toMatchObject({ kind: 'refund', refundOf: 'e-deposit' });
    expect('refundOf' in bodyOfExpense(deposit)).toBe(false);
    // A copy of a refund refunds nothing in particular.
    expect(draftFromExpense(refund, { memberIds: FOUR, copy: { id: 'c-1', date: '2026-10-21' } }).refundOf).toBeNull();
  });
});

describe('rows, the payer line and the effect', () => {
  const members: Record<string, MemberDTO> = Object.fromEntries(
    FOUR.map((id, i) => [id, { id, groupId: 'g1', userId: null, name: id[0].toUpperCase() + id.slice(1), color: '#2F6FB5', role: 'member', active: true, sort: i, createdAt: '', claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null } as MemberDTO]),
  );

  it('the right column is the refund effect', () => {
    expect(rowEffect(refund, 'gino', 'JPY')).toEqual({ kind: 'refund', involved: true, amount: -22500, currency: 'JPY', sent: false });
    expect(rowEffect(refund, 'abbie', 'JPY')).toEqual({ kind: 'refund', involved: true, amount: 7500, currency: 'JPY', sent: false });
    expect(rowEffect(refund, 'lily', 'JPY')).toMatchObject({ kind: 'refund', involved: false });
    expect(stubText(rowEffect(refund, 'gino', 'JPY'), (m, c) => money(m, c))).toBe('¥22,500');
  });

  it('「Gino 收到退款 ¥30,000」 / "Gino got back ¥30,000"', () => {
    expect(paidLine(refund, members, 'abbie')).toBe('Gino 收到退款 ¥30,000');
    expect(paidLine(refund, members, 'gino')).toBe('你收到退款 ¥30,000');
    const two = { ...refund, payers: [{ memberId: 'gino', amount: 20000 }, { memberId: 'abbie', amount: 10000 }] };
    expect(paidLine(two, members, 'gino')).toBe('2 人收到退款 ¥30,000');
    setLocale('en');
    expect(paidLine(refund, members, 'abbie')).toBe('Gino got back ¥30,000');
    expect(paidLine(refund, members, 'gino')).toBe('You got back ¥30,000');
    expect(paidLine(deposit, members, 'abbie')).toBe('Gino paid ¥30,000');
  });
});

describe('the feed', () => {
  const actx: ActivityContext = { meUserId: 'u-abbie', names: { g1: { gino: 'Gino', abbie: 'Abbie', kevin: 'Kevin', tiffany: 'Tiffany' } }, myMember: { g1: 'abbie' } };
  const row = (over: Partial<ActivityDTO>): ActivityDTO => ({
    id: 'a1', groupId: 'g1', groupName: '北海道', groupEmoji: '⛷️', groupType: 'trip', userId: 'u-gino', memberId: 'gino', actorName: 'Gino',
    type: 'expense.create', expenseId: 'r-deposit', createdAt: '2026-10-20T10:00:00.000Z',
    data: { kind: 'refund', description: '退款：民宿押金', amount: 30000, currency: 'JPY', nets: { gino: -22500, abbie: 7500, kevin: 7500, tiffany: 7500 }, groupCurrency: 'JPY' },
    ...over,
  });

  it('says 退款 with the description less its prefix, and the effect is a refund', () => {
    const v = describeActivity(row({}), actx);
    expect(v.text).toBe('Gino 新增了退款「民宿押金」 ¥30,000');
    expect(v.effect).toEqual({ kind: 'refund', amount: 7500, currency: 'JPY', involved: true, void: false });
    expect(describeActivity(row({ type: 'expense.update', data: { ...row({}).data, changes: [{ field: 'kind', from: 'expense', to: 'refund' }] } }), actx)).toMatchObject({
      text: 'Gino 修改了退款「民宿押金」',
      detail: '類型：費用 → 退款',
    });
    expect(describeActivity(row({ type: 'expense.delete' }), actx).text).toBe('Gino 刪除了退款「民宿押金」 ¥30,000');
    expect(describeActivity(row({ type: 'comment.add', data: { kind: 'refund', description: '退款：民宿押金', comment: '收到了' } }), actx).text).toBe('Gino 在退款「民宿押金」留言');
    setLocale('en');
    expect(describeActivity(row({}), actx).text).toBe('Gino added the refund "民宿押金" (¥30,000)');
    expect(describeActivity(row({ data: { ...row({}).data, description: '退款' } }), actx).text).toBe('Gino added a refund (¥30,000)');
  });

  it('history: a change of kind reads with its articles', () => {
    setLocale('en');
    expect(historyText({ key: 'k', at: '', kind: 'changed', actorName: 'Gino', actorUserId: null, actorMemberId: null, field: 'kind', from: 'expense', to: 'refund' }, 'Gino')).toBe(
      'Gino changed it from an expense to a refund',
    );
    setLocale('zh-TW');
    expect(historyText({ key: 'k', at: '', kind: 'changed', actorName: 'Gino', actorUserId: null, actorMemberId: null, field: 'kind', from: 'expense', to: 'refund' }, 'Gino')).toBe(
      'Gino 把類型從費用改成退款',
    );
  });
});

describe('統計', () => {
  const snap = (expenses: ExpenseDTO[]): GroupSnapshotDTO => ({
    group: { id: 'g1', name: '北海道', type: 'trip', currency: 'JPY', emoji: '', color: '#2F6FB5', simplify: true, notes: '', createdBy: '', createdAt: '', updatedAt: '', version: 1, defaultSplit: null },
    members: FOUR.map((id, i) => ({ id, groupId: 'g1', userId: null, name: id, color: '#2F6FB5', role: 'member', active: true, sort: i, createdAt: '', claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null })),
    expenses,
    me: { memberId: 'gino', role: 'admin' },
    inviteCode: 'X',
  });
  const dinner = entry({ id: 'e-dinner', description: '晚餐', category: 'food.dining', amount: 12000, payers: [{ memberId: 'abbie', amount: 12000 }], date: '2026-10-05' });

  it('refunds come off the total, their category and the people; payments do not count', () => {
    const pay = entry({ id: 'p-1', kind: 'payment', category: 'payment', amount: 5000, payers: [{ memberId: 'gino', amount: 5000 }], split: { method: 'exact', entries: [{ memberId: 'abbie', value: 5000 }] } });
    const s = computeStats(snap([deposit, dinner, refund, pay]), '2026-10-25');
    expect(s.spent).toBe(12000);
    expect(s.count).toBe(3);
    expect(s.refunds).toBe(1);
    expect(s.categories).toEqual([{ key: 'food.dining', amount: 12000 }]);
    expect(s.people.find(p => p.id === 'gino')).toMatchObject({ paid: 0, share: 3000 });
    expect(s.people.find(p => p.id === 'abbie')).toMatchObject({ paid: 12000, share: 3000 });
    expect(s.timeline.find(b => b.key === '2026-10-20')?.amount).toBe(-30000);
  });

  it('a partial refund leaves the rest of its category', () => {
    const half = entry({ id: 'r-half', kind: 'refund', amount: 10000, payers: [{ memberId: 'gino', amount: 10000 }], date: '2026-10-20' });
    const s = computeStats(snap([deposit, half]), '2026-10-25');
    expect(s.spent).toBe(20000);
    expect(s.categories).toEqual([{ key: 'travel.hotel', amount: 20000 }]);
  });
});

describe('Splitwise import: negative rows', () => {
  const csv = (rows: string[]) => ['Date,Description,Category,Cost,Currency,Gino,Abbie,Kevin,Tiffany', ...rows].join('\n');
  const opts = { groupId: 'g1', groupCurrency: 'JPY', memberIds: FOUR, today: '2026-10-25' };

  it('one person got the money back: a refund of the whole Cost', () => {
    const f = parseSplitwiseCsv(csv(['2026-10-20,Deposit back,Hotel,-30000.00,JPY,-22500.00,7500.00,7500.00,7500.00']));
    if (!f.ok) throw new Error(f.error);
    const plan = buildImport(f.file, opts);
    expect(plan.skipped).toEqual([]);
    expect(plan.refundCount).toBe(1);
    expect(plan.entries).toHaveLength(1);
    const e = plan.entries[0];
    expect(e).toMatchObject({ kind: 'refund', amount: 30000, currency: 'JPY', category: 'travel.hotel', payers: [{ memberId: 'gino', amount: 30000 }] });
    expect(e.split.entries.map(x => [x.memberId, x.value])).toEqual([['gino', 7500], ['abbie', 7500], ['kevin', 7500], ['tiffany', 7500]]);
    expect(plan.netByMember).toEqual({ gino: -22500, abbie: 7500, kevin: 7500, tiffany: 7500 });
    expect(plan.spent).toBe(-30000);
  });

  it('several people got money back: not clear who got how much, so as before (an expense with the same balances)', () => {
    const f = parseSplitwiseCsv(csv(['2026-10-20,Deposit back,Hotel,-30000.00,JPY,-15000.00,-7500.00,15000.00,7500.00']));
    if (!f.ok) throw new Error(f.error);
    const plan = buildImport(f.file, opts);
    expect(plan.refundCount).toBe(0);
    expect(plan.entries[0].kind).toBe('expense');
    expect(plan.netByMember).toEqual({ gino: -15000, abbie: -7500, kevin: 15000, tiffany: 7500 });
  });

  it('odd cents in a currency with them still add up', () => {
    const f = parseSplitwiseCsv(csv(['2026-10-20,Refund,General,-100.01,USD,-75.01,25.01,25.00,25.00']));
    if (!f.ok) throw new Error(f.error);
    const plan = buildImport(f.file, { ...opts, groupCurrency: 'USD' });
    const e = plan.entries[0];
    expect(e.kind).toBe('refund');
    expect(e.amount).toBe(10001);
    expect(e.split.entries.reduce((a, x) => a + (x.value ?? 0), 0)).toBe(10001);
    expect(plan.netByMember).toEqual({ gino: -7501, abbie: 2501, kevin: 2500, tiffany: 2500 });
  });
});

describe('our CSV export', () => {
  const labels: ExportLabels = {
    date: 'Date', description: 'Description', category: 'Category', kind: 'Kind', amount: 'Amount', currency: 'Currency',
    fxRate: 'FX rate', baseAmount: 'Amount in group currency', paidBy: 'Paid by', expense: 'Expense', payment: 'Payment', refund: 'Refund',
    total: 'Total balance', categoryLabel: k => 'cat:' + k, paymentDescription: (a, b) => `${a} paid ${b}`, separator: ', ', unknownMember: '(removed)',
  };

  it('marks the kind, writes a refund\'s amounts below zero, and the balances net out', () => {
    const members = FOUR.map((id, i) => ({ id, groupId: 'g1', userId: null, name: id, color: '#2F6FB5', role: 'member' as const, active: true, sort: i, createdAt: '', claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null }));
    const rows = buildExportRows({ group: { currency: 'JPY' }, members, expenses: [deposit, refund] }, labels);
    expect(rows[1].slice(0, 9)).toEqual(['2026-10-01', '民宿押金', 'cat:travel.hotel', 'Expense', '30000', 'JPY', '1', '30000', 'gino']);
    expect(rows[2].slice(0, 9)).toEqual(['2026-10-20', '退款：民宿押金', 'cat:travel.hotel', 'Refund', '-30000', 'JPY', '1', '-30000', 'gino']);
    expect(rows[2].slice(9)).toEqual(['-22500', '7500', '7500', '7500']);
    expect(rows[3].slice(9)).toEqual(['0', '0', '0', '0']);
  });
});
