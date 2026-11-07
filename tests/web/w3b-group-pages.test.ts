// The group pages (review-1106, units B6a and B6b; features/groups): the expense search (B6a-02)
// and the list state kept in the history entry (B6a-05), 統計's category percents and empty card
// (B6a-03), its sparse trip days (B6a-07) and people lines (B6a-04, B6a-17), 結算's "why" line
// (B6a-04) and names in Chinese text (B6a-09, B6a-10), the header's trip dates (B6b-09), cover
// guesses (B6b-10) and adding typed names (B6b-07). Tabs are rendered with react-dom/server.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { ExpenseDTO, GroupSnapshotDTO, GroupType, MemberDTO } from '../../src/shared/types';
import { BalancesTab, type PlanState } from '../../src/web/features/groups/BalancesTab';
import { amountWord, matchesQuery, savedListState, withListState } from '../../src/web/features/groups/ExpensesTab';
import { spendingSpan } from '../../src/web/features/groups/GroupHeader';
import { entryFlows, settleShareText, summarize } from '../../src/web/features/groups/groupMath';
import { namesToAdd } from '../../src/web/features/groups/MembersEditor';
import { guessEmoji } from '../../src/web/features/groups/NewGroupPage';
import { computeStats, StatsTab } from '../../src/web/features/groups/StatsTab';
import { setLocale } from '../../src/web/lib/i18n';
import type { GroupView } from '../../src/web/lib/store';

beforeEach(() => setLocale('zh-TW'));
afterEach(() => setLocale('zh-TW'));

function member(id: string, name: string, over: Partial<MemberDTO> = {}): MemberDTO {
  return {
    id, groupId: 'g1', userId: null, name, color: '#2F6FB5', role: 'member', active: true, sort: 0,
    createdAt: '2026-10-01T00:00:00.000Z', claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null, ...over,
  };
}

const FOUR = ['gino', 'abbie', 'kevin', 'tiffany'];
const MEMBERS = [member('gino', 'Gino', { sort: 0 }), member('abbie', 'Abbie', { sort: 1 }), member('kevin', 'Kevin', { sort: 2 }), member('tiffany', 'Tiffany', { sort: 3 })];

let seq = 0;
function entry(over: Partial<ExpenseDTO> & { payer?: string; among?: string[] } = {}): ExpenseDTO {
  const { payer = 'gino', among = FOUR, ...rest } = over;
  const id = rest.id ?? 'e' + ++seq;
  const amount = rest.amount ?? 1000;
  const split: SplitInput = rest.split ?? { method: 'equal', entries: among.map(memberId => ({ memberId })) };
  const r = computeSharesFor(id, amount, split);
  return {
    id, groupId: 'g1', kind: 'expense', description: '', category: 'general', amount, currency: 'TWD', fxRate: 1, date: '2026-10-01', notes: '',
    payers: [{ memberId: payer, amount }], split, shares: r.ok ? r.shares : [], repeat: 'none', repeatSeries: null, repeatStart: null,
    createdBy: 'u', createdAt: '2026-10-01T10:00:00.000Z', updatedBy: 'u', updatedAt: '2026-10-01T10:00:00.000Z', deletedAt: null, deletedBy: null,
    version: 1, commentCount: 0, refundOf: null, receipt: null, ...rest,
  };
}

function snapOf(expenses: ExpenseDTO[], over: { type?: GroupType; currency?: string; name?: string; members?: MemberDTO[] } = {}): GroupSnapshotDTO {
  return {
    group: {
      id: 'g1', name: over.name ?? '北海道', type: over.type ?? 'trip', currency: over.currency ?? 'TWD', emoji: '', color: '#2F6FB5', simplify: true, notes: '',
      createdBy: 'u', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', version: 1, defaultSplit: null,
    },
    members: over.members ?? MEMBERS,
    expenses,
    me: { memberId: 'gino', role: 'admin' },
    inviteCode: 'X',
  };
}

const viewOf = (snap: GroupSnapshotDTO): GroupView => ({ snap, pending: {}, pendingComments: {}, pendingPhotos: {}, pendingReceipts: {}, loading: false, error: null });
const byId = Object.fromEntries(MEMBERS.map(m => [m.id, m]));

describe('the expense search (B6a-02)', () => {
  const dinner = entry({ description: 'Dinner', amount: 1300 });
  const taxi = entry({ description: 'Taxi', amount: 230 });
  const day3 = entry({ description: 'Day 3 tickets', amount: 4500 });
  const iphone = entry({ description: 'iPhone case', amount: 1500 });
  const hotel = entry({ description: 'Hotel', amount: 31500 });
  const zhDinner = entry({ description: '晚餐', amount: 1300 });
  const ramen = entry({ description: 'Ramen', amount: 12600, currency: 'JPY', fxRate: 0.21 });
  const all = [dinner, taxi, day3, iphone, hotel, zhDinner, ramen];
  const find = (q: string) => all.filter(e => matchesQuery(e, q, byId, 'zh-TW')).map(e => e.description);

  it('does not read the digits of a text query as an amount on their own', () => {
    expect(find('Day 3')).toEqual(['Day 3 tickets']);
    expect(find('iPhone 15')).toEqual(['iPhone case']);
    expect(find('B2')).toEqual([]);
  });

  it('still finds amounts, alone or next to words, with or without a currency mark', () => {
    expect(find('1300')).toEqual(['Dinner', '晚餐']);
    expect(find('1,300')).toEqual(['Dinner', '晚餐']);
    expect(find('晚餐 1300')).toEqual(['晚餐']);
    expect(find('NT$ 1300')).toEqual(['Dinner', '晚餐']);
    expect(find('NT$1,300')).toEqual(['Dinner', '晚餐']);
    expect(find('1300元')).toEqual(['Dinner', '晚餐']);
    expect(find('１３００')).toEqual(['Dinner', '晚餐']);
    expect(find('¥12,600')).toEqual(['Ramen']);
    expect(find('￥12600')).toEqual(['Ramen']);
    expect(find('Ramen 126')).toEqual(['Ramen']);
    expect(find('NT$')).toEqual([]);
    expect(find('dinner')).toEqual(['Dinner']);
  });

  it('reads one word as an amount, a currency mark alone, or text', () => {
    expect(amountWord('12,600')).toBe('12600');
    expect(amountWord('¥12,600')).toBe('12600');
    expect(amountWord('nt$2400')).toBe('2400');
    expect(amountWord('2400元')).toBe('2400');
    expect(amountWord('12.5usd')).toBe('12.5');
    expect(amountWord('usd')).toBe('');
    expect(amountWord('nt$')).toBe('');
    expect(amountWord('day')).toBeNull();
    expect(amountWord('b2')).toBeNull();
    expect(amountWord('3號')).toBeNull();
  });
});

describe('the list kept in its history entry (B6a-05)', () => {
  it('keeps what else the entry holds, and belongs to its own group only', () => {
    const state = withListState({ evenlyDepth: 3 }, { gid: 'g1', query: '晚餐', showDeleted: true, limit: 300 });
    expect(state.evenlyDepth).toBe(3);
    expect(savedListState(state, 'g1')).toEqual({ gid: 'g1', query: '晚餐', showDeleted: true, limit: 300 });
    expect(savedListState(state, 'g2')).toBeNull();
    expect(savedListState(null, 'g1')).toBeNull();
    expect(savedListState({ evenlyDepth: 2 }, 'g1')).toBeNull();
    expect(savedListState({ evenlyList: { gid: 'g1', query: 1 } }, 'g1')).toBeNull();
    // Never fewer rows than a page.
    expect(savedListState(withListState(null, { gid: 'g1', query: '', showDeleted: false, limit: 3 }), 'g1')?.limit).toBe(150);
  });
});

describe('統計 (B6a-03, B6a-04, B6a-07, B6a-17)', () => {
  const render = (snap: GroupSnapshotDTO) => renderToStaticMarkup(createElement(StatsTab, { gid: 'g1', view: viewOf(snap) }));

  it('prints category percents of the bars shown, and says which categories it left out', () => {
    const rent = entry({ description: '房租', category: 'home.rent', amount: 30000, payer: 'gino' });
    const back = entry({ kind: 'refund', description: '押金退回', category: 'general', amount: 10000, payer: 'gino' });
    const snap = snapOf([rent, back], { type: 'home' });
    const s = computeStats(snap, '2026-10-25');
    expect(s.spent).toBe(20000);
    expect(s.categories).toEqual([{ key: 'home.rent', amount: 30000 }]);
    expect(s.negativeCategories).toBe(1);
    const html = render(snap);
    expect(html).toContain('100%');
    expect(html).not.toContain('150%');
    expect(html).toContain('※ 1 個分類的退款比花費多，沒有列在這裡');
    setLocale('en');
    expect(render(snap)).toContain('Note: 1 category got back more than it spent and is not shown');
  });

  it('draws no 花在哪裡 card when every category comes to zero', () => {
    const booking = entry({ description: '訂房', category: 'travel.hotel', amount: 8000 });
    const cancelled = entry({ kind: 'refund', description: '退款：訂房', category: 'travel.hotel', amount: 8000 });
    const snap = snapOf([booking, cancelled]);
    expect(computeStats(snap, '2026-10-25').categories).toEqual([]);
    const html = render(snap);
    expect(html).not.toContain('花在哪裡');
    // Everyone was in both, and the refund cancels the booking: not 「沒有參與」.
    expect(html).toContain('費用和退款剛好抵銷');
    expect(html).not.toContain('沒有參與');
  });

  it('labels the days of a long trip with their dates and averages over the days with spending', () => {
    const deposit = entry({ description: '民宿訂金', amount: 40000, currency: 'JPY', date: '2026-03-02' });
    const days = ['10', '11', '12', '13', '14', '15', '16'].map(d => entry({ description: '吃飯', amount: 4000, currency: 'JPY', date: '2026-07-' + d }));
    const snap = snapOf([deposit, ...days], { currency: 'JPY' });
    const s = computeStats(snap, '2026-07-20');
    expect(s.sparse).toBe(true);
    expect(s.spendDays).toBe(8);
    expect(s.timeline.map(b => b.key)).toEqual(['2026-03-02', ...days.map(e => e.date)]);
    const html = render(snap);
    expect(html).toContain('。3/2～7/16，有花費的 8 天平均每天 ¥8,500');
    expect(html).not.toContain('137 天');
    // Every column says its month: no bare 「2」 next to 「10」.
    expect(html).toContain('>3/2</span>');
    expect(html).toContain('>7/10</span>');
    setLocale('en');
    expect(render(snap)).toContain('. Mar 2 to Jul 16; ¥8,500 a day over the 8 days with spending');
  });

  it('keeps every day of a short trip and its average over all of them', () => {
    const a = entry({ amount: 3000, date: '2026-10-01' });
    const b = entry({ amount: 1000, date: '2026-10-03' });
    const s = computeStats(snapOf([a, b]), '2026-10-25');
    expect(s.sparse).toBe(false);
    expect(s.timeline).toHaveLength(3);
    expect(render(snapOf([a, b]))).toContain('。10/1～10/3，3 天，平均每天 NT$1,333');
  });

  it('says "your share" on my own line in English', () => {
    const mine = entry({ amount: 2000, payer: 'gino', among: ['gino', 'abbie'] });
    const hers = entry({ amount: 2000, payer: 'abbie', among: ['gino', 'abbie'] });
    setLocale('en');
    const html = render(snapOf([mine, hers]));
    expect(html).toContain('paid exactly your share');
    expect(html).toContain('paid exactly their share');
    expect(html).toContain('not involved');
  });
});

describe('結算 (B6a-04, B6a-09, B6a-10)', () => {
  const planState = (plan: PlanState['plan'] = []): PlanState => ({
    mode: 'simplified', hub: null, plan, setHubMode: () => undefined, setHub: () => undefined, setSimplify: () => undefined, cancelSimplify: () => undefined,
  });
  const render = (snap: GroupSnapshotDTO, plan: PlanState['plan'] = []) =>
    renderToStaticMarkup(createElement(BalancesTab, { gid: 'g1', view: viewOf(snap), summary: summarize(snap), planState: planState(plan) }));

  // Abbie paid a ¥30,000 deposit for the four of us; the deposit came back to Gino.
  const deposit = entry({ id: 'e-deposit', description: '民宿押金', amount: 30000, currency: 'JPY', payer: 'abbie' });
  const back = entry({ id: 'r-deposit', kind: 'refund', description: '退款：民宿押金', amount: 30000, currency: 'JPY', payer: 'gino' });
  const snap = snapOf([deposit, back], { currency: 'JPY' });

  it('explains each balance with the money that moved, never a minus sign next to a word', () => {
    const f = entryFlows(snap.expenses, 'JPY');
    expect(f.paid).toEqual({ abbie: 30000 });
    expect(f.refundGot).toEqual({ gino: 30000 });
    expect(f.refundShare).toEqual({ gino: 7500, abbie: 7500, kevin: 7500, tiffany: 7500 });
    const html = render(snap);
    expect(html).toContain('分到 ¥7,500，收到退款 ¥30,000，分到退款 ¥7,500');
    expect(html).toContain('付了 ¥30,000，分到 ¥7,500，分到退款 ¥7,500');
    expect(html).not.toMatch(/付了 [-−]/);
    // Kevin is in both entries: not 「還沒有費用」.
    expect(html).not.toContain('還沒有費用');
    setLocale('en');
    const en = render(snap);
    expect(en).toContain('Share ¥7,500, got back ¥30,000 in refunds, refund share ¥7,500');
  });

  it('says received payments apart from refunds', () => {
    const pay = entry({ kind: 'payment', category: 'payment', amount: 5000, currency: 'JPY', payer: 'kevin', split: { method: 'exact', entries: [{ memberId: 'abbie', value: 5000 }] } });
    setLocale('en');
    const html = render(snapOf([deposit, pay], { currency: 'JPY' }));
    expect(html).toContain('Paid ¥30,000, share ¥7,500, received ¥5,000 in payments');
    expect(html).toContain('Share ¥7,500, paid back ¥5,000');
  });

  it('puts no space between two Chinese characters around a name', () => {
    const members = [
      member('gino', 'Gino', { venmo: 'gino' }),
      member('jy', '佳穎'),
      member('zm', '志明', { payInfo: '台新 812' }),
      member('tf', 'Tiffany'),
    ];
    const s2 = snapOf([], { members });
    const html = render(s2, [
      { from: 'jy', to: 'gino', amount: 1000 },
      { from: 'tf', to: 'gino', amount: 500 },
      { from: 'gino', to: 'zm', amount: 300 },
    ]);
    expect(html).toContain('你的收款方式（佳穎會看到）');
    expect(html).toContain('你的收款方式（Tiffany 會看到）');
    expect(html).toContain('志明的收款方式');
    expect(html).toContain('aria-label="複製 Venmo"');
    expect(html).toContain('aria-label="複製其他"');
  });

  it('starts the shared text with the group name and 結算, spaced only after a Latin name', () => {
    expect(settleShareText(snapOf([], { name: '北海道' }), []).split('\n')[0]).toBe('北海道結算');
    expect(settleShareText(snapOf([], { name: 'Niseko 滑雪 2026' }), []).split('\n')[0]).toBe('Niseko 滑雪 2026 結算');
  });
});

describe('the trip dates in the header (B6b-09)', () => {
  it('leave out payments, as 統計 and the 結算圖卡 do', () => {
    const a = entry({ date: '2025-12-16' });
    const b = entry({ date: '2025-12-20' });
    const pay = entry({ kind: 'payment', category: 'payment', date: '2026-01-05' });
    const gone = entry({ date: '2025-12-01', deletedAt: '2025-12-02T00:00:00.000Z' });
    expect(spendingSpan([a, b, pay, gone])).toEqual({ lo: '2025-12-16', hi: '2025-12-20' });
    expect(spendingSpan([pay])).toBeNull();
  });
});

describe('cover guesses (B6b-10)', () => {
  it('skip places and words that only look like snow, sea, island or home', () => {
    for (const name of ['上海出差', '海外旅行', '海鮮吃到飽', '雪梨跨年', '廣島賞楓', '鹿兒島', '北海道自由行', '家人旅行', '青島啤酒節']) {
      expect(guessEmoji(name)).toBeNull();
    }
  });

  it('still guess the real ones', () => {
    expect(guessEmoji('北海道滑雪')).toBe('⛷️');
    expect(guessEmoji('Niseko 2026')).toBe('⛷️');
    expect(guessEmoji('沖繩')).toBe('🏝️');
    expect(guessEmoji('墾丁海邊')).toBe('🏝️');
    expect(guessEmoji('石垣島')).toBe('🏝️');
    expect(guessEmoji('我們家')).toBe('🏠');
  });
});

describe('adding typed names (B6b-07)', () => {
  it('adds each name once, and none an active member has', () => {
    const members = [{ name: 'Gino', active: true }, { name: 'Abbie', active: true }, { name: 'Leo', active: false }];
    expect(namesToAdd(['Kevin', 'kevin', 'ＫＥＶＩＮ'], members)).toEqual({ names: ['Kevin'], skipped: 2 });
    expect(namesToAdd(['Abbie', 'Kevin'], members)).toEqual({ names: ['Kevin'], skipped: 1 });
    // Someone who left can be added again.
    expect(namesToAdd(['Leo'], members)).toEqual({ names: ['Leo'], skipped: 0 });
  });
});
