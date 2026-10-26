// The push sender (src/worker/services/push.ts) and its words (pushText.ts): which activity rows
// may push (pushAtFor), the hold and the 4-minute cap, merging an entry's rows (an undo sends
// nothing), who hears about what, prefs, one notification per person per group, the per-run
// budget and the messages kept for the next runs (push_pending), groups nobody can hear and the
// turns between accounts, the order of a person's devices, and what 404 / 410 / other failures do
// to a subscription. The end-to-end cases go through the real routes (tests/worker/d1-sqlite.ts)
// with fetch stubbed; every message is decrypted the way a browser would. The sentences shared with
// the activity feed are checked against the feed's own code (src/web/features/activity/activityText.ts)
// in both languages.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/worker/services/fx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/worker/services/fx')>();
  return { ...actual, getUsdRates: vi.fn(async (_db: unknown, date: string) => ({ date, rates: { USD: 1, JPY: 150, KRW: 1400, TWD: 32 }, source: 'test' })) };
});

import { todayUTC } from '../../src/shared/dates';
import type { ActivityDTO, GroupSnapshotDTO, PushPayload } from '../../src/shared/types';
import { describeActivity, type ActivityContext } from '../../src/web/features/activity/activityText';
import { setLocale } from '../../src/web/lib/i18n';
import { createSession } from '../../src/worker/auth';
import { b64url, sha256Hex } from '../../src/worker/http';
import worker from '../../src/worker/index';
import { activityStmt, activityStmtWhere, pushAtFor } from '../../src/worker/services/activity';
import {
  budgetOf, FAILURES_MAX, groupMessages, holdSeconds, parsePrefs, runPushSender, type ClaimedGroup, type ClaimedRow,
} from '../../src/worker/services/push';
import { pushNotice, testNotice, type PushGroup, type PushItem } from '../../src/worker/services/pushText';
import { TestD1 } from './d1-sqlite';

const subtle = crypto.subtle;
const utf8 = new TextEncoder();
const text = new TextDecoder();
const TODAY = todayUTC();

// ---------- the policy ----------

describe('pushAtFor', () => {
  const now = '2026-10-17T10:00:00.000Z';

  it('flags new entries, their edits, deletes and restores, joins, adds, new groups, accepted friend invites and the import', () => {
    for (const type of ['expense.create', 'expense.update', 'expense.delete', 'expense.restore', 'member.join', 'member.claim', 'member.add', 'group.create', 'friend.join'] as const) {
      expect(pushAtFor(type, {}, now)).toBe(now);
    }
    expect(pushAtFor('group.update', { changes: [{ field: 'import', from: '', to: '200' }] }, now)).toBe(now);
  });

  it('leaves everything else in the feed only: recurring copies, comments, settings and other member changes', () => {
    for (const type of ['recurring.create', 'comment.add', 'group.delete', 'member.update', 'member.remove', 'member.leave', 'member.unlink'] as const) {
      expect(pushAtFor(type, {}, now)).toBeNull();
    }
    expect(pushAtFor('group.update', { changes: [{ field: 'name', from: 'a', to: 'b' }] }, now)).toBeNull();
    expect(pushAtFor('group.update', { changes: [{ field: 'currency', from: 'TWD', to: 'JPY' }, { field: 'import', from: '', to: '1' }] }, now)).toBeNull();
    expect(pushAtFor('group.update', {}, now)).toBeNull();
    expect(pushAtFor('group.update', null, now)).toBeNull();
  });
});

describe('holdSeconds, budgetOf, parsePrefs', () => {
  it('reads the hold: 30 by default, 0 allowed, at most an hour', () => {
    expect(holdSeconds(undefined)).toBe(30);
    expect(holdSeconds('')).toBe(30);
    expect(holdSeconds('0')).toBe(0);
    expect(holdSeconds('45')).toBe(45);
    expect(holdSeconds('-1')).toBe(30);
    expect(holdSeconds('soon')).toBe(30);
    expect(holdSeconds('99999')).toBe(3600);
  });

  it('reads the budget: 12 by default, 1 to 40', () => {
    expect(budgetOf(undefined)).toBe(12);
    expect(budgetOf(' ')).toBe(12);
    expect(budgetOf('0')).toBe(12);
    expect(budgetOf('5')).toBe(5);
    expect(budgetOf('500')).toBe(40);
  });

  it('treats every pref but an explicit false as on', () => {
    expect(parsePrefs('{}')).toEqual({ expenses: true, payments: true, joins: true });
    expect(parsePrefs(null)).toEqual({ expenses: true, payments: true, joins: true });
    expect(parsePrefs('not json')).toEqual({ expenses: true, payments: true, joins: true });
    expect(parsePrefs('[false]')).toEqual({ expenses: true, payments: true, joins: true });
    expect(parsePrefs('{"payments":false,"joins":0}')).toEqual({ expenses: true, payments: false, joins: true });
  });
});

// ---------- the words ----------

const G: PushGroup = { id: 'g1', name: 'test-東京行', emoji: '🍣', type: 'trip' };
const P = (id: string, name: string) => ({ id, name });
const gino = P('mG', 'Gino');
const abbie = P('mA', 'Abbie');
const leo = P('mL', 'Leo');
const kai = P('mK', '佳穎');

function expenseItem(over: Partial<Extract<PushItem, { kind: 'expense' }>> = {}): PushItem {
  return {
    kind: 'expense', actor: abbie, expenseId: 'e1', description: '燒肉晚餐', amount: 12600, currency: 'JPY',
    nets: { mA: 9450, mL: -3150, mG: -3150, mK: -3150 }, groupCurrency: 'JPY', ...over,
  };
}

const payment = (actor: { id: string; name: string }, from = leo, to = abbie, amount = 500, currency = 'TWD'): PushItem => ({
  kind: 'payment', actor, expenseId: 'p1', from, to, amount, currency,
});

const zhFor = (memberId: string) => ({ memberId, locale: 'zh-TW' as const });
const enFor = (memberId: string) => ({ memberId, locale: 'en' as const });
const body = (items: PushItem[], me: { memberId: string; locale: 'zh-TW' | 'en' }, group = G) => pushNotice(group, items, me)!.payload.body;

describe('pushNotice: one item', () => {
  it('a new expense: the feed sentence and my effect, in both languages', () => {
    expect(body([expenseItem()], zhFor('mL'))).toBe('Abbie 新增了「燒肉晚餐」 ¥12,600\n你借入 ¥3,150');
    expect(body([expenseItem()], enFor('mL'))).toBe('Abbie added "燒肉晚餐" (¥12,600)\nYou borrowed ¥3,150');
    expect(body([expenseItem({ actor: kai })], zhFor('mL'))).toBe('佳穎新增了「燒肉晚餐」 ¥12,600\n你借入 ¥3,150');
    const lent = expenseItem({ actor: gino, nets: { mL: 4200, mA: -4200 } });
    expect(body([lent], zhFor('mL'))).toBe('Gino 新增了「燒肉晚餐」 ¥12,600\n你借出 ¥4,200');
    expect(body([lent], enFor('mL'))).toBe('Gino added "燒肉晚餐" (¥12,600)\nYou lent ¥4,200');
    const even = expenseItem({ nets: { mL: 0, mA: 0 } });
    expect(body([even], zhFor('mL'))).toBe('Abbie 新增了「燒肉晚餐」 ¥12,600\n剛好平衡');
    expect(body([even], enFor('mL'))).toBe('Abbie added "燒肉晚餐" (¥12,600)\nEven');
    const usd = expenseItem({ description: '', amount: 1250, currency: 'USD', nets: { mL: -625 }, groupCurrency: 'USD' });
    expect(body([usd], zhFor('mL'))).toBe('Abbie 新增了一筆費用 US$12.50\n你借入 US$6.25');
    expect(body([usd], enFor('mL'))).toBe('Abbie added an expense (US$12.50)\nYou borrowed US$6.25');
    // Entered in yen, counted in the group's NT$.
    const fx = expenseItem({ nets: { mL: -650 }, groupCurrency: 'TWD' });
    expect(body([fx], zhFor('mL'))).toBe('Abbie 新增了「燒肉晚餐」 ¥12,600\n你借入 NT$650');
  });

  it('a payment: who recorded it decides the sentence; my side is the second line', () => {
    expect(body([payment(leo)], zhFor('mA'))).toBe('Leo 記錄了付給你的還款\n你收到 NT$500');
    expect(body([payment(leo)], enFor('mA'))).toBe('Leo recorded a payment to you\nYou received NT$500');
    expect(body([payment(abbie)], zhFor('mL'))).toBe('Abbie 記錄了你的還款\n你付出 NT$500');
    expect(body([payment(abbie)], enFor('mL'))).toBe('Abbie recorded a payment from you\nYou sent NT$500');
    const k = P('mX', 'Kevin');
    expect(body([payment(k)], zhFor('mA'))).toBe('Kevin 記錄了還款：Leo 付給你\n你收到 NT$500');
    expect(body([payment(k)], enFor('mA'))).toBe('Kevin recorded a payment: Leo paid you\nYou received NT$500');
    expect(body([payment(k)], zhFor('mL'))).toBe('Kevin 記錄了還款：你付給 Abbie\n你付出 NT$500');
    expect(body([payment(k)], enFor('mL'))).toBe('Kevin recorded a payment: You paid Abbie\nYou sent NT$500');
    expect(body([payment(k, leo, kai)], zhFor('mL'))).toBe('Kevin 記錄了還款：你付給佳穎\n你付出 NT$500');
    expect(body([payment(kai, leo, kai)], zhFor('mL'))).toBe('佳穎記錄了你的還款\n你付出 NT$500');
  });

  it('joins, adds, new groups and 1:1 ledgers', () => {
    expect(body([{ kind: 'join', name: 'Abbie' }], zhFor('mG'))).toBe('Abbie 加入了群組');
    expect(body([{ kind: 'join', name: '佳穎' }], zhFor('mG'))).toBe('佳穎加入了群組');
    expect(body([{ kind: 'join', name: 'Abbie' }], enFor('mG'))).toBe('Abbie joined the group');
    expect(body([{ kind: 'add', actor: gino }], zhFor('mA'))).toBe('Gino 把你加進了群組');
    expect(body([{ kind: 'add', actor: gino }], enFor('mA'))).toBe('Gino added you to the group');
    expect(body([{ kind: 'create', actor: gino }], zhFor('mA'))).toBe('Gino 建立了群組，也把你加了進去');
    expect(body([{ kind: 'create', actor: gino }], enFor('mA'))).toBe('Gino created the group and added you');
    const pair: PushGroup = { id: 'g2', name: 'Gino & Abbie', emoji: '', type: 'pair' };
    expect(pushNotice(pair, [{ kind: 'create', actor: gino }], zhFor('mA'))!.payload).toEqual({
      title: '兩人帳本', body: 'Gino 開始了跟你的兩人帳本', path: '/g/g2', tag: 'g:g2',
    });
    expect(pushNotice(pair, [{ kind: 'create', actor: gino }], enFor('mA'))!.payload.title).toBe('Friend ledger');
    expect(body([{ kind: 'create', actor: gino }], enFor('mA'), pair)).toBe('Gino started a ledger with you');
  });

  it('the import summary, sent with low urgency', () => {
    const n = pushNotice(G, [{ kind: 'import', actor: gino, count: 500 }], zhFor('mA'))!;
    expect(n.payload.body).toBe('Gino 匯入了 500 筆費用');
    expect(n.urgency).toBe('low');
    expect(body([{ kind: 'import', actor: gino, count: 500 }], enFor('mA'))).toBe('Gino imported 500 entries');
    expect(body([{ kind: 'import', actor: gino, count: 1 }], enFor('mA'))).toBe('Gino imported 1 entry');
    expect(pushNotice(G, [expenseItem()], zhFor('mL'))!.urgency).toBe('normal');
  });

  it('title, path and tag', () => {
    const n = pushNotice(G, [expenseItem()], zhFor('mL'))!;
    expect(n.payload).toMatchObject({ title: '🍣 test-東京行', path: '/g/g1/e/e1', tag: 'g:g1' });
    expect(pushNotice({ ...G, emoji: '' }, [expenseItem()], zhFor('mL'))!.payload.title).toBe('test-東京行');
    expect(pushNotice({ ...G, name: ' ' }, [expenseItem()], enFor('mL'))!.payload.title).toBe("Gino's Split Lab");
    expect(pushNotice(G, [{ kind: 'join', name: 'Abbie' }], zhFor('mG'))!.payload.path).toBe('/g/g1');
    expect(pushNotice(G, [], zhFor('mG'))).toBeNull();
  });

  it('keeps long text short and the payload small', () => {
    const long = expenseItem({ description: '長'.repeat(500) });
    const n = pushNotice({ ...G, name: '名'.repeat(300) }, [long], zhFor('mL'))!;
    expect([...n.payload.title].length).toBeLessThanOrEqual(100);
    expect([...n.payload.body.split('\n')[0]].length).toBeLessThanOrEqual(240);
    expect(n.payload.body.split('\n')[0].endsWith('…')).toBe(true);
    expect(utf8.encode(JSON.stringify(n.payload)).length).toBeLessThan(3000);
  });

  it('testNotice in both languages', () => {
    expect(testNotice('zh-TW').payload).toEqual({ title: '吉諾分帳所', body: '測試通知：看得到這則，就表示這台裝置收得到通知。', path: '/account', tag: 'test' });
    expect(testNotice('en').payload.title).toBe("Gino's Split Lab");
    expect(testNotice('en').payload.body).toBe('Test notification: if you can see this, notifications work on this device.');
  });
});

describe('pushNotice: several items', () => {
  it('one person adding several entries: a count, and my total for expenses', () => {
    const items = [expenseItem(), expenseItem({ expenseId: 'e2', nets: { mL: -1000 } }), expenseItem({ expenseId: 'e3', nets: { mL: 500 } })];
    const n = pushNotice(G, items, zhFor('mL'))!;
    expect(n.payload.body).toBe('Abbie 新增了 3 筆費用\n你借入 ¥3,650');
    expect(n.payload.path).toBe('/g/g1');
    expect(body(items, enFor('mL'))).toBe('Abbie added 3 entries\nYou borrowed ¥3,650');
    expect(body([expenseItem(), payment(abbie)], zhFor('mL'))).toBe('Abbie 新增了 2 筆費用');
    expect(body([payment(abbie), { ...payment(abbie), expenseId: 'p2' } as PushItem], zhFor('mL'))).toBe('Abbie 記錄了 2 筆還款');
    expect(body([payment(abbie), { ...payment(abbie), expenseId: 'p2' } as PushItem], enFor('mL'))).toBe('Abbie recorded 2 payments');
    expect(body([expenseItem({ actor: kai }), expenseItem({ actor: kai, expenseId: 'e2' })], zhFor('mL'))).toBe('佳穎新增了 2 筆費用\n你借入 ¥6,300');
  });

  it('several joins: the names', () => {
    const j = (name: string): PushItem => ({ kind: 'join', name });
    expect(body([j('Abbie'), j('Leo')], zhFor('mG'))).toBe('Abbie、Leo 加入了群組');
    expect(body([j('Abbie'), j('佳穎')], zhFor('mG'))).toBe('Abbie、佳穎加入了群組');
    expect(body([j('Abbie'), j('Leo')], enFor('mG'))).toBe('Abbie and Leo joined the group');
    expect(body([j('Abbie'), j('Leo'), j('Kai')], enFor('mG'))).toBe('Abbie, Leo, and Kai joined the group');
    expect(body([j('Abbie'), j('Leo'), j('Kai'), j('Mo')], zhFor('mG'))).toBe('Abbie 等 4 人加入了群組');
    expect(body([j('Abbie'), j('Leo'), j('Kai'), j('Mo')], enFor('mG'))).toBe('Abbie and 3 others joined the group');
    expect(body([j('Abbie'), j('Abbie')], zhFor('mG'))).toBe('Abbie 加入了群組');
  });

  it('anything else: the first thing that happened, and how many more', () => {
    const items: PushItem[] = [{ kind: 'create', actor: gino }, expenseItem({ actor: gino }), expenseItem({ actor: gino, expenseId: 'e2' })];
    expect(body(items, zhFor('mL'))).toBe('Gino 建立了群組，也把你加了進去\n還有 2 筆新動態');
    expect(body(items, enFor('mL'))).toBe('Gino created the group and added you\nand 2 more updates');
    expect(body([expenseItem(), expenseItem({ actor: gino, expenseId: 'e2' })], enFor('mL'))).toBe('Abbie added "燒肉晚餐" (¥12,600)\nand 1 more update');
  });
});

// ---------- the same sentences as the feed ----------

describe('push sentences match the activity feed', () => {
  afterEach(() => setLocale('zh-TW'));

  const ctx: ActivityContext = { meUserId: 'uL', names: { g1: { mG: 'Gino', mA: 'Abbie', mL: 'Leo', mK: '佳穎', mX: 'Kevin' } }, myMember: { g1: 'mL' } };
  const dto = (over: Partial<ActivityDTO>): ActivityDTO => ({
    id: 'a1', groupId: 'g1', groupName: 'test-東京行', groupEmoji: '🍣', groupType: 'trip', userId: 'uA', memberId: 'mA', actorName: 'Abbie',
    type: 'expense.create', expenseId: 'e1', data: {}, createdAt: '2026-10-17T10:00:00.000Z', ...over,
  });
  const cases: { name: string; feed: ActivityDTO; item: PushItem }[] = [
    {
      name: 'a new expense',
      feed: dto({ data: { kind: 'expense', description: '燒肉晚餐', amount: 12600, currency: 'JPY', nets: { mA: 9450, mL: -3150 }, groupCurrency: 'JPY' } }),
      item: expenseItem(),
    },
    {
      name: 'a new expense by someone with a Chinese name, without a description',
      feed: dto({ userId: 'uK', memberId: 'mK', actorName: '佳穎', data: { kind: 'expense', description: '', amount: 1250, currency: 'USD', nets: { mL: -625 }, groupCurrency: 'USD' } }),
      item: expenseItem({ actor: kai, description: '', amount: 1250, currency: 'USD', nets: { mL: -625 }, groupCurrency: 'USD' }),
    },
    {
      name: 'a payment the sender recorded',
      feed: dto({ userId: 'uA', memberId: 'mA', actorName: 'Abbie', data: { kind: 'payment', description: '', amount: 500, currency: 'TWD', nets: { mA: 500, mL: -500 }, groupCurrency: 'TWD' } }),
      item: payment(abbie, abbie, leo),
    },
    {
      name: 'a payment the recipient recorded',
      feed: dto({ userId: 'uA', memberId: 'mA', actorName: 'Abbie', data: { kind: 'payment', description: '', amount: 500, currency: 'TWD', nets: { mL: 500, mA: -500 }, groupCurrency: 'TWD' } }),
      item: payment(abbie, leo, abbie),
    },
    {
      name: 'a payment someone else recorded',
      feed: dto({ userId: 'uX', memberId: 'mX', actorName: 'Kevin', data: { kind: 'payment', description: '', amount: 500, currency: 'TWD', nets: { mK: 500, mL: -500 }, groupCurrency: 'TWD' } }),
      item: payment(P('mX', 'Kevin'), kai, leo),
    },
    {
      name: 'a join',
      feed: dto({ type: 'member.join', expenseId: null, data: { memberId: 'mA', memberName: 'Abbie' } }),
      item: { kind: 'join', name: 'Abbie' },
    },
    {
      name: 'a claim',
      feed: dto({ type: 'member.claim', expenseId: null, userId: 'uK', memberId: 'mK', actorName: '佳穎', data: { memberId: 'mK', memberName: '佳穎' } }),
      item: { kind: 'join', name: '佳穎' },
    },
    {
      name: 'an import',
      feed: dto({ type: 'group.update', expenseId: null, userId: 'uG', memberId: 'mG', actorName: 'Gino', data: { groupName: 'x', changes: [{ field: 'import', from: '', to: '500' }] } }),
      item: { kind: 'import', actor: gino, count: 500 },
    },
    {
      // Leo's link: data.memberId is the link owner's member, the one who hears it.
      name: 'a friend invite accepted',
      feed: dto({ type: 'friend.join', expenseId: null, groupType: 'pair', data: { groupName: 'Leo & Abbie', memberId: 'mL', memberName: 'Leo' } }),
      item: { kind: 'invite', actor: abbie },
    },
    {
      name: 'a friend invite accepted by someone with a Chinese name',
      feed: dto({ type: 'friend.join', expenseId: null, groupType: 'pair', userId: 'uK', memberId: 'mK', actorName: '佳穎', data: { groupName: 'Leo & 佳穎', memberId: 'mL', memberName: 'Leo' } }),
      item: { kind: 'invite', actor: kai },
    },
  ];

  for (const locale of ['zh-TW', 'en'] as const) {
    for (const c of cases) {
      it(`${c.name} (${locale})`, () => {
        setLocale(locale);
        const feed = describeActivity(c.feed, ctx).text;
        expect(body([c.item], { memberId: 'mL', locale }).split('\n')[0]).toBe(feed);
      });
    }
  }
});

// ---------- groupMessages (pure) ----------

describe('groupMessages', () => {
  const NOW = Date.parse('2026-10-17T10:10:00.000Z');
  let seq = 0;
  const row = (type: string, over: Partial<ClaimedRow> = {}, data: object = {}): ClaimedRow => ({
    seq: ++seq, id: 'a' + seq, group_id: 'g1', user_id: 'uA', member_id: 'mA', type, expense_id: null, data: JSON.stringify(data),
    created_at: new Date(NOW - 60_000 + seq * 1000).toISOString(), ...over,
  });
  const entry = (amount: number, nets: Record<string, number> = { mA: amount / 2, mL: -amount / 2 }, kind = 'expense') => ({
    kind, description: 'dinner', amount, currency: 'TWD', nets, groupCurrency: 'TWD',
  });
  const sub = (user: string, n = 1) => ({ id: `s-${user}-${n}`, user_id: user, endpoint: `https://web.push.apple.com/${user}-${n}`, p256dh: b64url(new Uint8Array([4, ...new Array(64).fill(1)])), auth: b64url(new Uint8Array(16)) });
  const claimed = (rows: ClaimedRow[], over: Partial<ClaimedGroup> = {}): ClaimedGroup => ({
    group: { id: 'g1', name: 'Trip', emoji: '', type: 'trip' },
    rows,
    members: [
      { id: 'mA', user_id: 'uA', name: 'Abbie', active: 1, claimed_at: '2026-10-01T00:00:00.000Z', locale: 'en', notify_prefs: '{}' },
      { id: 'mL', user_id: 'uL', name: 'Leo', active: 1, claimed_at: '2026-10-01T00:00:00.000Z', locale: 'zh-TW', notify_prefs: '{}' },
      { id: 'mG', user_id: 'uG', name: 'Gino', active: 1, claimed_at: '2026-10-01T00:00:00.000Z', locale: 'zh-TW', notify_prefs: '{}' },
      { id: 'mC', user_id: null, name: 'Cy', active: 1, claimed_at: null, locale: null, notify_prefs: null },
      { id: 'mO', user_id: 'uO', name: 'Olga', active: 0, claimed_at: '2026-10-01T00:00:00.000Z', locale: 'en', notify_prefs: '{}' },
    ],
    subscriptions: [sub('uA'), sub('uL'), sub('uG'), sub('uO')],
    entries: [],
    ...over,
  });
  const read = (out: ReturnType<typeof groupMessages>) =>
    out.map(o => ({ to: o.subId, ...(JSON.parse(text.decode(o.message.payload)) as PushPayload) }));

  it('merges an entry: an undo sends nothing, edits send the last values, rows without a create send nothing', () => {
    const e = { expense_id: 'e1' };
    expect(groupMessages(claimed([row('expense.create', e, entry(1000)), row('expense.delete', e, entry(1000))]), NOW)).toEqual([]);
    const edited = read(groupMessages(claimed([row('expense.create', e, entry(1000)), row('expense.update', { ...e, user_id: 'uG', member_id: 'mG' }, entry(3000))]), NOW));
    // Abbie created it and Gino edited it: both already know; Leo hears "added" with the last values.
    expect(edited).toEqual([{ to: 's-uL-1', title: 'Trip', body: 'Abbie 新增了「dinner」 NT$3,000\n你借入 NT$1,500', path: '/g/g1/e/e1', tag: 'g:g1' }]);
    expect(groupMessages(claimed([row('expense.update', e, entry(1000)), row('expense.delete', e, entry(1000))]), NOW)).toEqual([]);
    const back = read(groupMessages(claimed([row('expense.create', e, entry(1000)), row('expense.delete', e, entry(1000)), row('expense.restore', e, entry(1000))]), NOW));
    expect(back.map(b => b.to)).toEqual(['s-uL-1']);
    expect(groupMessages(claimed([row('recurring.create', e, entry(1000)), row('comment.add', e, { comment: 'hi' })]), NOW)).toEqual([]);
  });

  it('reaches only active members with an account in the nets, never the actor', () => {
    const r = row('expense.create', { expense_id: 'e1' }, entry(1000, { mA: 600, mL: -200, mC: -200, mO: -200 }));
    expect(read(groupMessages(claimed([r]), NOW)).map(x => x.to)).toEqual(['s-uL-1']);
  });

  it('a payment whose nets are 0 finds its sender and recipient in the stored entry', () => {
    const r = row('expense.create', { expense_id: 'p1', user_id: 'uG', member_id: 'mG' }, { ...entry(1, { mL: 0, mA: 0 }, 'payment'), currency: 'KRW' });
    const stored = { id: 'p1', payers: JSON.stringify([{ memberId: 'mL', amount: 1 }]), shares: JSON.stringify([{ memberId: 'mA', amount: 1 }]) };
    const out = read(groupMessages(claimed([r], { entries: [stored] }), NOW));
    expect(out).toEqual([
      expect.objectContaining({ to: 's-uL-1', body: 'Gino 記錄了還款：你付給 Abbie\n你付出 ₩1' }),
      expect.objectContaining({ to: 's-uA-1', body: 'Gino recorded a payment: Leo paid you\nYou received ₩1' }),
    ]);
    // Without the stored entry there is nobody to tell.
    expect(groupMessages(claimed([r]), NOW)).toEqual([]);
  });

  it('an expense without nets (a rate that could not convert) reaches its payers and sharers', () => {
    const r = row('expense.create', { expense_id: 'e9', user_id: 'uG', member_id: 'mG' }, entry(1000, {}));
    const stored = { id: 'e9', payers: JSON.stringify([{ memberId: 'mG', amount: 1000 }]), shares: JSON.stringify([{ memberId: 'mL', amount: 1000 }]) };
    expect(read(groupMessages(claimed([r], { entries: [stored] }), NOW))).toEqual([
      expect.objectContaining({ to: 's-uL-1', body: 'Gino 新增了「dinner」 NT$1,000' }),
    ]);
  });

  it('a join reaches everyone else once; an add only the added account; a placeholder nobody', () => {
    const joins = read(groupMessages(claimed([
      row('member.join', { user_id: 'uL', member_id: 'mL' }, { memberId: 'mL', memberName: 'Leo' }),
      row('member.join', { user_id: 'uL', member_id: 'mL' }, { memberId: 'mL', memberName: 'Leo' }),
    ]), NOW));
    expect(joins.map(j => [j.to, j.body])).toEqual([['s-uA-1', 'Leo joined the group'], ['s-uG-1', 'Leo 加入了群組']]);
    const added = read(groupMessages(claimed([row('member.add', { user_id: 'uG', member_id: 'mG' }, { memberId: 'mA', memberName: 'Abbie' })]), NOW));
    expect(added.map(j => [j.to, j.body])).toEqual([['s-uA-1', 'Gino added you to the group']]);
    expect(groupMessages(claimed([row('member.add', { user_id: 'uG', member_id: 'mG' }, { memberId: 'mC', memberName: 'Cy' })]), NOW)).toEqual([]);
  });

  it('tells only people who were linked when it happened', () => {
    // Leo took over his member after the group was made, so he was not "added" when it was.
    const g = claimed([row('group.create', { user_id: 'uG', member_id: 'mG', created_at: '2026-10-06T00:00:00.000Z' }, { groupName: 'Trip' })]);
    g.members[1].claimed_at = '2026-10-06T00:00:30.000Z';
    expect(read(groupMessages(g, Date.parse('2026-10-06T00:01:00.000Z'))).map(x => [x.to, x.body])).toEqual([['s-uA-1', 'Gino created the group and added you']]);
    // No claimed_at (older rows): linked all along.
    g.members[1].claimed_at = null;
    expect(read(groupMessages(g, Date.parse('2026-10-06T00:01:00.000Z'))).map(x => x.to)).toEqual(['s-uA-1', 's-uL-1']);
  });

  it('respects each person\'s prefs', () => {
    const rows = [
      row('expense.create', { expense_id: 'e1', user_id: 'uG', member_id: 'mG' }, entry(1000, { mG: 500, mL: -500, mA: 0 })),
      row('member.join', { user_id: 'uG', member_id: 'mG' }, { memberId: 'mG', memberName: 'Gino' }),
    ];
    const g = claimed(rows);
    g.members[0].notify_prefs = '{"joins":false}';
    g.members[1].notify_prefs = '{"expenses":false}';
    const out = read(groupMessages(g, NOW));
    expect(out.map(o => [o.to, o.body])).toEqual([
      ['s-uA-1', 'Gino added "dinner" (NT$1,000)\nEven'],
      ['s-uL-1', 'Gino 加入了群組'],
    ]);
  });

  it('reads malformed activity data as missing instead of failing', () => {
    const r = row('expense.create', { expense_id: 'e1', user_id: 'uG', member_id: 'mG' }, { kind: 'expense', description: 5, amount: 'x', currency: 7, nets: { mL: -100, mA: 'y' }, groupCurrency: 'TWD' });
    const j = row('member.join', { user_id: 'uG', member_id: 'mG' }, { memberName: { no: 1 } });
    expect(read(groupMessages(claimed([r]), NOW)).map(x => x.body)).toEqual(['Gino 新增了一筆費用\n你借入 NT$100']);
    expect(read(groupMessages(claimed([j]), NOW)).map(x => x.body)).toEqual(['Gino joined the group', 'Gino 加入了群組']);
    const broken = { ...row('member.join', { user_id: 'uG', member_id: 'mG' }), data: '{not json' };
    expect(read(groupMessages(claimed([broken]), NOW)).map(x => x.body)).toEqual(['Gino joined the group', 'Gino 加入了群組']);
  });

  it('drops rows older than a day, and everything in a deleted group', () => {
    const old = row('member.join', { user_id: 'uL', member_id: 'mL', created_at: new Date(NOW - 25 * 3600_000).toISOString() }, { memberName: 'Leo' });
    expect(groupMessages(claimed([old]), NOW)).toEqual([]);
    expect(groupMessages(claimed([row('member.join', { user_id: 'uL', member_id: 'mL' }, { memberName: 'Leo' })], { group: null }), NOW)).toEqual([]);
  });

  it('orders messages by device: every person\'s newest device before anyone\'s second', () => {
    const r = row('member.join', { user_id: 'uG', member_id: 'mG' }, { memberName: 'Gino' });
    const out = groupMessages(claimed([r], { subscriptions: [sub('uA', 1), sub('uA', 2), sub('uA', 3), sub('uL', 1), sub('uL', 2)] }), NOW);
    expect(out.map(o => [o.subId, o.rank])).toEqual([['s-uA-1', 0], ['s-uL-1', 0], ['s-uA-2', 1], ['s-uL-2', 1], ['s-uA-3', 2]]);
  });
});

// ---------- end to end ----------

interface Device {
  user: string;
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  auth: Uint8Array;
}

interface Sent {
  endpoint: string;
  user: string;
  urgency: string | null;
  payload: PushPayload;
}

let vapidVars: Record<string, string>;
let db: TestD1;
let env: Record<string, unknown>;
const tokens: Record<string, string> = {};
let devices: Map<string, Device>;
let sent: Sent[];
let answer: (endpoint: string) => number;

const label = (s: string): Uint8Array => {
  const t = utf8.encode(s);
  const out = new Uint8Array(t.length + 1);
  out.set(t);
  return out;
};

async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, bits: number): Promise<ArrayBuffer> {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits);
}

/** What the browser does (RFC 8291, one record, no padding). */
async function decrypt(msg: Uint8Array, d: Device): Promise<string> {
  const salt = msg.slice(0, 16);
  const keyid = msg.slice(21, 86);
  const as = await subtle.importKey('raw', keyid, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = await subtle.deriveBits({ name: 'ECDH', public: as }, d.privateKey, 256);
  const info = new Uint8Array([...label('WebPush: info'), ...d.publicRaw, ...keyid]);
  const ikm = await hkdf(d.auth, ecdh, info, 256);
  const cek = await hkdf(salt, ikm, label('Content-Encoding: aes128gcm'), 128);
  const nonce = await hkdf(salt, ikm, label('Content-Encoding: nonce'), 96);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, msg.slice(86)));
  expect(plain[plain.length - 1]).toBe(2);
  return text.decode(plain.slice(0, -1));
}

async function api<T = any>(user: string | null, method: string, path: string, reqBody?: unknown): Promise<{ status: number; data: T }> {
  const h: Record<string, string> = {};
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  if (reqBody !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request('http://api.test' + path, { method, headers: h, body: reqBody === undefined ? undefined : JSON.stringify(reqBody) });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const t = await res.text();
  return { status: res.status, data: t ? JSON.parse(t) : undefined };
}

async function addUser(id: string, name: string, email: string, locale: 'zh-TW' | 'en'): Promise<void> {
  const now = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, locale, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name, email, locale, '#2F6FB5', now, now);
  tokens[id] = await createSession(db.d1, id, 'test');
}

const endpointOf = (user: string, n: number) => `https://web.push.apple.com/test-${user}-${n}`;

/** A browser that turned notifications on: its keys, stored as PUT /api/push/subscription would (on `token`'s session). */
async function addDevice(user: string, n = 1, ageMs = 0, token = tokens[user]): Promise<string> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = endpointOf(user, n);
  devices.set(endpoint, { user, privateKey: pair.privateKey, publicRaw, auth });
  db.exec(
    'INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, tz, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    await sha256Hex(endpoint), user, await sha256Hex(token), endpoint, b64url(publicRaw), b64url(auth), 'Asia/Taipei', 'iPhone Safari',
    new Date(Date.now() - ageMs).toISOString(),
  );
  return endpoint;
}

const run = (afterMs = 31_000, extra: Record<string, unknown> = {}) => runPushSender({ ...env, ...extra } as never, new Date(Date.now() + afterMs));
const pending = () => db.rows<{ type: string; push_at: string }>('SELECT type, push_at FROM activity WHERE push_at IS NOT NULL');
/** Messages kept for the next runs (push_pending), in the order they go out. */
const kept = () => db.rows<{ sub_id: string; user_id: string; rank: number; payload: string; urgency: string }>('SELECT sub_id, user_id, rank, payload, urgency FROM push_pending ORDER BY rank, id');
/** A kept message as a run would have stored it. */
async function keep(user: string, endpoint: string, body: string, ageMs = 0): Promise<void> {
  db.exec(
    'INSERT INTO push_pending (sub_id, user_id, rank, payload, urgency, created_at) VALUES (?, ?, 0, ?, ?, ?)',
    await sha256Hex(endpoint), user, JSON.stringify({ title: 'test-Kept', body, path: '/g/x', tag: 'g:x' }), 'normal', new Date(Date.now() - ageMs).toISOString(),
  );
}
/** Forget pushes the setup itself caused (the new group's own create row). */
const settle = () => db.exec('UPDATE activity SET push_at = NULL');
const to = (user: string) => sent.filter(s => s.user === user).map(s => s.payload);

/** A group written straight to the tables, named after its id, with `people` in it (the first is
 *  m0) and a join by Gino at `at` pending: everyone else in it hears that. */
async function joinedGroup(gid: string, people: readonly string[], at: string): Promise<void> {
  db.exec("INSERT INTO groups (id, name, type, currency, invite_code, created_by, created_at, updated_at) VALUES (?, ?, 'trip', 'TWD', ?, 'uG', ?, ?)", gid, gid, 'inv-' + gid, at, at);
  people.forEach((u, i) => db.exec("INSERT INTO members (id, group_id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, '#2F6FB5', ?)", `${gid}-m${i}`, gid, u, 'P' + i, at));
  await db.d1.batch([activityStmt(db.d1, { groupId: gid, userId: 'uG', memberId: `${gid}-m0`, type: 'member.join', data: { memberName: 'Gino' }, now: at })]);
}

/** The test database behind a D1 that counts its calls the way Workers Free does (a batch is one). */
function countedD1(): { d1: unknown; calls: number } {
  const out = { d1: undefined as unknown, calls: 0 };
  const wrap = (s: ReturnType<TestD1['prepare']>): unknown => ({
    stmt: s,
    bind: (...p: unknown[]) => wrap(s.bind(...p)),
    all: () => (out.calls++, s.all()),
    run: () => (out.calls++, s.run()),
    first: (col?: string) => (out.calls++, s.first(col)),
  });
  out.d1 = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (stmts: { stmt: ReturnType<TestD1['prepare']> }[]) => (out.calls++, db.batch(stmts.map(s => s.stmt))),
  };
  return out;
}

interface World {
  gid: string;
  /** Members: G Gino (the creator), A Abbie (en, two devices), L Leo, K 佳穎, C Cy (no account). */
  m: Record<'G' | 'A' | 'L' | 'K' | 'C', string>;
}

async function world(name = 'test-東京行'): Promise<World> {
  const r = await api<GroupSnapshotDTO>('uG', 'POST', '/api/groups', {
    name, type: 'trip', currency: 'JPY', emoji: '🍣',
    members: [{ name: 'Abbie', email: 'a@evenly.test' }, { name: 'Leo', email: 'l@evenly.test' }, { name: '佳穎', email: 'k@evenly.test' }, { name: 'Cy' }],
  });
  expect(r.status).toBe(200);
  const id = (n: string) => r.data.members.find(x => x.name === n)!.id;
  settle();
  return { gid: r.data.group.id, m: { G: id('Gino'), A: id('Abbie'), L: id('Leo'), K: id('佳穎'), C: id('Cy') } };
}

function expense(payer: string, amount: number, among: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'expense', description: '燒肉晚餐', category: 'food.dining', amount, currency: 'JPY', fxRate: 1, date: TODAY,
    payers: [{ memberId: payer, amount }], split: { method: 'equal', entries: among.map(memberId => ({ memberId })) }, ...over,
  };
}

function pay(from: string, toMember: string, amount: number, currency = 'JPY', fxRate = 1): Record<string, unknown> {
  return {
    kind: 'payment', description: '', category: 'payment', amount, currency, fxRate, date: TODAY,
    payers: [{ memberId: from, amount }], split: { method: 'exact', entries: [{ memberId: toMember, value: amount }] },
  };
}

const put = (user: string, w: World, eid: string, b: Record<string, unknown>) => api(user, 'PUT', `/api/groups/${w.gid}/expenses/${eid}`, b);

beforeAll(async () => {
  const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
  const jwk = (await subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  vapidVars = {
    VAPID_PUBLIC_KEY: b64url(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))),
    VAPID_SUBJECT: 'mailto:gino@ginochang.com',
    VAPID_PRIVATE_JWK: JSON.stringify({ kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }),
  };
});

/** Six people with devices (Abbie has two), fetch answering for their push services. */
async function setup(): Promise<void> {
  db = new TestD1();
  env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'http://app.test/', ENVIRONMENT: 'test', ...vapidVars };
  devices = new Map();
  sent = [];
  answer = () => 201;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const req = new Request(input, init);
    const d = devices.get(req.url);
    if (!d) throw new Error('push to an unknown endpoint');
    const payload = JSON.parse(await decrypt(new Uint8Array(await req.arrayBuffer()), d)) as PushPayload;
    sent.push({ endpoint: req.url, user: d.user, urgency: req.headers.get('urgency'), payload });
    return new Response(null, { status: answer(req.url) });
  }));
  await addUser('uG', 'Gino', 'g@evenly.test', 'zh-TW');
  await addUser('uA', 'Abbie', 'a@evenly.test', 'en');
  await addUser('uL', 'Leo', 'l@evenly.test', 'zh-TW');
  await addUser('uK', '佳穎', 'k@evenly.test', 'zh-TW');
  await addUser('uX', 'Xavier', 'x@evenly.test', 'zh-TW');
  await addUser('uY', 'Yuki', 'y@evenly.test', 'en');
  await addDevice('uG');
  await addDevice('uA', 1, 60_000);
  await addDevice('uA', 2);
  await addDevice('uL');
  await addDevice('uK');
  await addDevice('uX');
  await addDevice('uY');
}

describe('runPushSender', () => {
  beforeEach(setup);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('waits out the hold, then sends a new expense to the people in it, in their language, once', async () => {
    const w = await world();
    expect((await put('uG', w, 'exp-0001', expense(w.m.G, 12600, [w.m.G, w.m.A, w.m.L]))).status).toBe(200);
    expect(pending().map(p => p.type)).toEqual(['expense.create']);

    expect(await run(0)).toEqual({ groups: 0, sent: 0, removed: 0, failed: 0 });
    expect(sent).toEqual([]);
    expect(pending()).toHaveLength(1);

    expect(await run()).toEqual({ groups: 1, sent: 3, removed: 0, failed: 0 });
    expect(to('uL')).toEqual([{ title: '🍣 test-東京行', body: 'Gino 新增了「燒肉晚餐」 ¥12,600\n你借入 ¥4,200', path: `/g/${w.gid}/e/exp-0001`, tag: `g:${w.gid}` }]);
    // Abbie reads English, on both of her devices.
    expect(to('uA')).toEqual([
      { title: '🍣 test-東京行', body: 'Gino added "燒肉晚餐" (¥12,600)\nYou borrowed ¥4,200', path: `/g/${w.gid}/e/exp-0001`, tag: `g:${w.gid}` },
      { title: '🍣 test-東京行', body: 'Gino added "燒肉晚餐" (¥12,600)\nYou borrowed ¥4,200', path: `/g/${w.gid}/e/exp-0001`, tag: `g:${w.gid}` },
    ]);
    expect(sent.every(s => s.urgency === 'normal')).toBe(true);
    // Not the one who added it, not 佳穎 (not in it), not Cy (no account).
    expect(to('uG')).toEqual([]);
    expect(to('uK')).toEqual([]);
    expect(pending()).toEqual([]);
    expect(db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions WHERE last_ok_at IS NOT NULL')[0].n).toBe(3);

    sent = [];
    expect(await run(60_000)).toEqual({ groups: 0, sent: 0, removed: 0, failed: 0 });
    expect(sent).toEqual([]);
  });

  it('never sends rows written before the migration (push_at NULL)', async () => {
    const w = await world();
    db.exec(
      "INSERT INTO activity (id, group_id, user_id, member_id, type, expense_id, data, created_at) VALUES ('old', ?, 'uG', ?, 'member.join', NULL, '{}', ?)",
      w.gid, w.m.G, new Date().toISOString(),
    );
    expect(await run(3_600_000)).toEqual({ groups: 0, sent: 0, removed: 0, failed: 0 });
    expect(sent).toEqual([]);
  });

  it('writes push_at in the same statement as the activity row, conditional inserts included', async () => {
    const w = await world();
    const now = new Date().toISOString();
    await db.d1.batch([
      activityStmt(db.d1, { groupId: w.gid, userId: 'uG', memberId: w.m.G, type: 'comment.add', expenseId: 'e1', data: { comment: 'hi' }, now }),
      activityStmtWhere(db.d1, { groupId: w.gid, userId: 'uL', memberId: w.m.L, type: 'member.claim', data: {}, now }, '1 = ?', [1]),
      activityStmtWhere(db.d1, { groupId: w.gid, userId: 'uL', memberId: w.m.L, type: 'member.claim', data: {}, now }, '1 = ?', [0]),
    ]);
    expect(db.rows('SELECT type, push_at FROM activity ORDER BY rowid DESC LIMIT 2')).toEqual([
      { type: 'member.claim', push_at: now },
      { type: 'comment.add', push_at: null },
    ]);
  });

  it('sends nothing for an entry added and deleted again (the undo), and one "added" with the last values after edits', async () => {
    const w = await world();
    await put('uG', w, 'exp-undo', expense(w.m.G, 9000, [w.m.G, w.m.L]));
    expect((await api('uG', 'DELETE', `/api/groups/${w.gid}/expenses/exp-undo`)).status).toBe(200);
    await put('uG', w, 'exp-edit', expense(w.m.G, 1000, [w.m.G, w.m.A, w.m.L]));
    expect((await put('uL', w, 'exp-edit', { ...expense(w.m.G, 3000, [w.m.G, w.m.A, w.m.L]), description: '壽司' })).status).toBe(200);
    expect(await run()).toMatchObject({ groups: 1, sent: 2 });
    // Gino added it and Leo edited it: only Abbie hears, with the edited values.
    expect(sent.map(s => s.user)).toEqual(['uA', 'uA']);
    expect(to('uA')[0].body).toBe('Gino added "壽司" (¥3,000)\nYou borrowed ¥1,000');

    // Edits and deletes of entries that already went out stay in the feed only.
    sent = [];
    await put('uL', w, 'exp-edit', expense(w.m.G, 6000, [w.m.G, w.m.A, w.m.L]));
    await api('uG', 'DELETE', `/api/groups/${w.gid}/expenses/exp-edit`);
    expect(pending()).toHaveLength(2);
    expect(await run()).toMatchObject({ groups: 1, sent: 0 });
    expect(pending()).toEqual([]);
  });

  it('a payment reaches its sender and recipient, worded by who recorded it', async () => {
    const w = await world();
    await put('uL', w, 'pay-0001', pay(w.m.L, w.m.A, 5000)); // Leo recorded his own payment
    await put('uA', w, 'pay-0002', pay(w.m.L, w.m.A, 3000)); // Abbie recorded Leo's payment to her
    await put('uG', w, 'pay-0003', pay(w.m.K, w.m.L, 700)); // Gino recorded 佳穎 paying Leo
    expect(await run()).toMatchObject({ groups: 1, failed: 0 });
    expect(to('uA').map(p => p.body)).toEqual(['Leo recorded a payment to you\nYou received ¥5,000', 'Leo recorded a payment to you\nYou received ¥5,000']);
    // Leo hears about the two he did not record, in one notification.
    expect(to('uL')).toEqual([{ title: '🍣 test-東京行', body: 'Abbie 記錄了你的還款\n還有 1 筆新動態', path: `/g/${w.gid}`, tag: `g:${w.gid}` }]);
    expect(to('uK').map(p => p.body)).toEqual(['Gino 記錄了還款：你付給 Leo\n你付出 ¥700']);
    expect(to('uG')).toEqual([]);
  });

  it('a payment that converts to 0 still reaches both sides (read from the entry)', async () => {
    const w = await world();
    // 1 won at 0.1 yen rounds to 0 yen: both nets are 0.
    expect((await put('uG', w, 'pay-tiny', pay(w.m.L, w.m.K, 1, 'KRW', 0.1))).status).toBe(200);
    await run();
    expect(to('uL').map(p => p.body)).toEqual(['Gino 記錄了還款：你付給佳穎\n你付出 ₩1']);
    expect(to('uK').map(p => p.body)).toEqual(['Gino 記錄了還款：Leo 付給你\n你收到 ₩1']);
  });

  it('joins reach everyone else; several merge into one notification', async () => {
    const w = await world();
    const snap = (await api<GroupSnapshotDTO>('uG', 'GET', '/api/groups/' + w.gid)).data;
    expect((await api('uX', 'POST', '/api/join/' + snap.inviteCode, { name: 'Xavier' })).status).toBe(200);
    expect((await api('uY', 'POST', '/api/join/' + snap.inviteCode, { name: 'Yuki' })).status).toBe(200);
    await run();
    expect(to('uG').map(p => p.body)).toEqual(['Xavier、Yuki 加入了群組']);
    expect(to('uA').map(p => p.body)).toEqual(['Xavier and Yuki joined the group', 'Xavier and Yuki joined the group']);
    expect(to('uK').map(p => p.body)).toEqual(['Xavier、Yuki 加入了群組']);
    // Xavier was in the group when Yuki joined; Yuki was not there yet when Xavier did.
    expect(to('uX').map(p => p.body)).toEqual(['Yuki 加入了群組']);
    expect(to('uY')).toEqual([]);
  });

  it('picking a name on the invite page (a claim) is a join', async () => {
    const w = await world();
    db.exec("UPDATE members SET user_id = NULL WHERE id = ?", w.m.K); // 佳穎 is a placeholder again
    const snap = (await api<GroupSnapshotDTO>('uG', 'GET', '/api/groups/' + w.gid)).data;
    expect((await api('uK', 'POST', '/api/join/' + snap.inviteCode, { memberId: w.m.K })).status).toBe(200);
    await run();
    expect(to('uL').map(p => p.body)).toEqual(['佳穎加入了群組']);
    expect(to('uK')).toEqual([]);
  });

  it('adding someone by email tells only them; a placeholder tells nobody', async () => {
    const w = await world();
    expect((await api('uG', 'POST', `/api/groups/${w.gid}/members`, { name: 'Xavier', email: 'x@evenly.test' })).status).toBe(200);
    expect((await api('uG', 'POST', `/api/groups/${w.gid}/members`, { name: 'Mo' })).status).toBe(200);
    await run();
    expect(sent.map(s => [s.user, s.payload.body])).toEqual([['uX', 'Gino 把你加進了群組']]);
    expect(sent[0].payload).toMatchObject({ title: '🍣 test-東京行', path: `/g/${w.gid}` });
  });

  it('a new group tells the linked others, a 1:1 ledger the other person', async () => {
    const g = await api<GroupSnapshotDTO>('uG', 'POST', '/api/groups', {
      name: 'test-Home', type: 'home', currency: 'TWD', emoji: '🏠', members: [{ name: 'Abbie', email: 'a@evenly.test' }, { name: 'Mo' }],
    });
    expect(g.status).toBe(200);
    const f = await api<{ groupId: string }>('uG', 'POST', '/api/friends', { name: 'Leo', email: 'l@evenly.test' });
    expect(f.status).toBe(200);
    expect(await run()).toMatchObject({ groups: 2, sent: 3 });
    expect(to('uA').map(p => [p.title, p.body])).toEqual([['🏠 test-Home', 'Gino created the group and added you'], ['🏠 test-Home', 'Gino created the group and added you']]);
    expect(to('uL')).toEqual([{ title: '兩人帳本', body: 'Gino 開始了跟你的兩人帳本', path: `/g/${f.data.groupId}`, tag: `g:${f.data.groupId}` }]);
  });

  it('a friend invite accepted tells the link\'s owner who joined, in their language, and nobody else', async () => {
    const zh = (await api<{ code: string }>('uG', 'GET', '/api/me/invite')).data.code;
    const en = (await api<{ code: string }>('uA', 'GET', '/api/me/invite')).data.code;
    const yuki = await api<{ groupId: string; existed: boolean }>('uY', 'POST', '/api/invite/' + zh);
    const kai = await api<{ groupId: string; existed: boolean }>('uK', 'POST', '/api/invite/' + en);
    expect([yuki.status, yuki.data.existed, kai.status, kai.data.existed]).toEqual([200, false, 200, false]);
    expect(pending().map(p => p.type)).toEqual(['friend.join', 'friend.join']);
    expect(await run()).toMatchObject({ groups: 2, sent: 3, failed: 0 });
    expect(to('uG')).toEqual([{ title: '兩人帳本', body: 'Yuki 透過你的邀請連結加入\n你們現在是朋友了', path: `/g/${yuki.data.groupId}`, tag: `g:${yuki.data.groupId}` }]);
    expect(to('uA').map(p => [p.title, p.body, p.path])).toEqual([
      ['Friend ledger', "佳穎 joined through your invite link\nYou're friends now", `/g/${kai.data.groupId}`],
      ['Friend ledger', "佳穎 joined through your invite link\nYou're friends now", `/g/${kai.data.groupId}`],
    ]);
    expect(to('uY')).toEqual([]);
    expect(to('uK')).toEqual([]);
    // Accepting again changes nothing, so it sends nothing.
    expect((await api<{ existed: boolean }>('uY', 'POST', '/api/invite/' + zh)).data.existed).toBe(true);
    expect(pending()).toEqual([]);
  });

  it('a new group is not news to someone who joined it after it was made', async () => {
    const g = await api<GroupSnapshotDTO>('uG', 'POST', '/api/groups', { name: 'test-Ski', type: 'trip', currency: 'JPY', emoji: '⛷️', members: [{ name: 'Abbie', email: 'a@evenly.test' }] });
    const snap = (await api<GroupSnapshotDTO>('uG', 'GET', '/api/groups/' + g.data.group.id)).data;
    expect((await api('uL', 'POST', '/api/join/' + snap.inviteCode, { name: 'Leo' })).status).toBe(200);
    await run();
    expect(to('uA').map(p => p.body)).toEqual(['Gino created the group and added you\nand 1 more update', 'Gino created the group and added you\nand 1 more update']);
    expect(to('uG').map(p => p.body)).toEqual(['Leo 加入了群組']);
    expect(to('uL')).toEqual([]);
  });

  it('a Splitwise import in several requests is one low-urgency summary for everyone else', async () => {
    const w = await world();
    const entries = (ids: string[]) => ({ expenses: ids.map(id => ({ id, ...expense(w.m.G, 100, [w.m.G, w.m.L]) })) });
    expect((await api('uG', 'POST', `/api/groups/${w.gid}/import`, entries(['imp-0001', 'imp-0002']))).status).toBe(200);
    expect((await api('uG', 'POST', `/api/groups/${w.gid}/import`, entries(['imp-0003']))).status).toBe(200);
    expect(pending().map(p => p.type)).toEqual(['group.update', 'group.update']);
    await run();
    expect(to('uL').map(p => p.body)).toEqual(['Gino 匯入了 3 筆費用']);
    expect(to('uA').map(p => p.body)).toEqual(['Gino imported 3 entries', 'Gino imported 3 entries']);
    expect(to('uK').map(p => p.body)).toEqual(['Gino 匯入了 3 筆費用']);
    expect(to('uG')).toEqual([]);
    expect(sent.every(s => s.urgency === 'low')).toBe(true);
  });

  it('several entries by one person are one notification with my total', async () => {
    const w = await world();
    await put('uG', w, 'exp-000a', expense(w.m.G, 3000, [w.m.G, w.m.L]));
    await put('uG', w, 'exp-000b', expense(w.m.G, 1000, [w.m.G, w.m.L]));
    await put('uG', w, 'exp-000c', expense(w.m.L, 600, [w.m.G, w.m.L]));
    await run();
    expect(to('uL')).toEqual([{ title: '🍣 test-東京行', body: 'Gino 新增了 3 筆費用\n你借入 ¥1,700', path: `/g/${w.gid}`, tag: `g:${w.gid}` }]);
  });

  it('one notification per person per group: two groups make two', async () => {
    const a = await world('test-A');
    const b = await world('test-B');
    await put('uG', a, 'exp-0001', expense(a.m.G, 1000, [a.m.G, a.m.L]));
    await put('uG', b, 'exp-0002', expense(b.m.G, 2000, [b.m.G, b.m.L]));
    expect(await run()).toMatchObject({ groups: 2, sent: 2 });
    expect(to('uL').map(p => p.title).sort()).toEqual(['🍣 test-A', '🍣 test-B']);
  });

  it('respects prefs: expenses off still hears joins; payments off; joins off', async () => {
    const w = await world();
    db.exec(`UPDATE users SET notify_prefs = '{"expenses":false}' WHERE id = 'uL'`);
    db.exec(`UPDATE users SET notify_prefs = '{"joins":false,"payments":false}' WHERE id = 'uK'`);
    await put('uG', w, 'exp-0001', expense(w.m.G, 3000, [w.m.G, w.m.L, w.m.K]));
    await put('uG', w, 'pay-0001', pay(w.m.K, w.m.G, 100));
    const snap = (await api<GroupSnapshotDTO>('uG', 'GET', '/api/groups/' + w.gid)).data;
    await api('uX', 'POST', '/api/join/' + snap.inviteCode, { name: 'Xavier' });
    await run();
    expect(to('uL').map(p => p.body)).toEqual(['Xavier 加入了群組']);
    expect(to('uK').map(p => p.body)).toEqual(['Gino 新增了「燒肉晚餐」 ¥3,000\n你借入 ¥1,000']);
  });

  it('does not wait forever in a busy group: the oldest row goes after 4 minutes, newer ones wait their hold', async () => {
    const w = await world();
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    // The group and its people were there before the first join.
    db.exec('UPDATE members SET claimed_at = ? WHERE group_id = ? AND user_id IS NOT NULL', at(10 * 60_000), w.gid);
    await db.d1.batch([
      activityStmt(db.d1, { groupId: w.gid, userId: 'uX', memberId: w.m.C, type: 'member.join', data: { memberId: 'm-old', memberName: 'Old' }, now: at(5 * 60_000) }),
      activityStmt(db.d1, { groupId: w.gid, userId: 'uY', memberId: w.m.C, type: 'member.join', data: { memberId: 'm-new', memberName: 'New' }, now: at(5_000) }),
    ]);
    expect(await run(0)).toMatchObject({ groups: 1 });
    expect(to('uL').map(p => p.body)).toEqual(['Old 加入了群組']);
    expect(pending()).toHaveLength(1);
  });

  it('staging sends right away (PUSH_HOLD_SECONDS = 0)', async () => {
    const w = await world();
    await put('uG', w, 'exp-0001', expense(w.m.G, 1000, [w.m.G, w.m.L]));
    expect(await run(0, { PUSH_HOLD_SECONDS: '0' })).toMatchObject({ groups: 1, sent: 1 });
  });

  it('keeps to the budget: what does not fit waits, and the next run sends it', async () => {
    const a = await world('test-A');
    const b = await world('test-B');
    await put('uG', a, 'exp-0001', expense(a.m.G, 1000, [a.m.G, a.m.A])); // Abbie: 2 devices
    await put('uG', b, 'exp-0002', expense(b.m.G, 3000, [b.m.G, b.m.L, b.m.K])); // Leo and 佳穎: 2 devices
    expect(await run(31_000, { PUSH_MAX_PER_RUN: '3' })).toEqual({ groups: 2, sent: 3, removed: 0, failed: 0 });
    // test-A fits; of test-B only Leo's message does, and 佳穎's waits with its words.
    expect(sent.map(s => [s.user, s.payload.title]).sort()).toEqual([['uA', '🍣 test-A'], ['uA', '🍣 test-A'], ['uL', '🍣 test-B']]);
    expect(pending()).toEqual([]);
    const words = { title: '🍣 test-B', body: 'Gino 新增了「燒肉晚餐」 ¥3,000\n你借入 ¥1,000', path: `/g/${b.gid}/e/exp-0002`, tag: `g:${b.gid}` };
    expect(kept().map(k => [k.user_id, k.rank, JSON.parse(k.payload), k.urgency])).toEqual([['uK', 0, words, 'normal']]);
    sent = [];
    expect(await run(32_000, { PUSH_MAX_PER_RUN: '3' })).toEqual({ groups: 0, sent: 1, removed: 0, failed: 0 });
    expect(to('uK')).toEqual([words]);
    expect(sent[0].urgency).toBe('normal');
    expect(kept()).toEqual([]);
    sent = [];
    expect(await run(33_000, { PUSH_MAX_PER_RUN: '3' })).toEqual({ groups: 0, sent: 0, removed: 0, failed: 0 });
  });

  it('a group with more messages than the budget: every person\'s newest device now, the others next run', async () => {
    const w = await world();
    const kaiNew = await addDevice('uK', 2);
    db.exec('UPDATE push_subscriptions SET created_at = ? WHERE endpoint = ?', new Date(Date.now() - 3_600_000).toISOString(), endpointOf('uK', 1));
    await put('uG', w, 'exp-0001', expense(w.m.G, 4000, [w.m.G, w.m.A, w.m.L, w.m.K]));
    // Abbie 2 devices, Leo 1, 佳穎 2: five messages, three fit.
    expect(await run(31_000, { PUSH_MAX_PER_RUN: '3' })).toEqual({ groups: 1, sent: 3, removed: 0, failed: 0 });
    expect(sent.map(s => s.endpoint).sort()).toEqual([endpointOf('uA', 2), endpointOf('uL', 1), kaiNew].sort());
    expect(pending()).toEqual([]);
    expect(kept().map(k => [k.user_id, k.rank])).toEqual([['uA', 1], ['uK', 1]]);
    const first = new Map(sent.map(s => [s.user, s.payload]));
    sent = [];
    expect(await run(32_000, { PUSH_MAX_PER_RUN: '3' })).toEqual({ groups: 0, sent: 2, removed: 0, failed: 0 });
    expect(sent.map(s => s.endpoint).sort()).toEqual([endpointOf('uA', 1), endpointOf('uK', 1)]);
    // The same notification as on the person's other device.
    for (const s of sent) expect(s.payload).toEqual(first.get(s.user));
    expect(kept()).toEqual([]);
  });

  it('an event for more people than the budget reaches every one of them over the next runs', async () => {
    // A trip of fifteen with a device each (Abbie two), and Xavier joining: 14 people, 15 messages.
    const others = ['a', 'l', 'k', 'y'].map(x => ({ name: x.toUpperCase(), email: `${x}@evenly.test` }));
    for (let i = 0; i < 9; i++) {
      await addUser('u' + i, 'P' + i, `p${i}@evenly.test`, 'en');
      await addDevice('u' + i);
      others.push({ name: 'P' + i, email: `p${i}@evenly.test` });
    }
    const g = await api<GroupSnapshotDTO>('uG', 'POST', '/api/groups', { name: 'test-Ski', type: 'trip', currency: 'JPY', emoji: '⛷️', members: others });
    expect(g.status).toBe(200);
    settle();
    expect((await api('uX', 'POST', '/api/join/' + g.data.inviteCode, { name: 'Xavier' })).status).toBe(200);
    expect(await run()).toEqual({ groups: 1, sent: 12, removed: 0, failed: 0 });
    // Twelve people heard first; the other two, and Abbie's second device, wait.
    expect(new Set(sent.map(s => s.user)).size).toBe(12);
    expect(kept().map(k => k.rank)).toEqual([0, 0, 1]);
    expect(await run(32_000)).toEqual({ groups: 0, sent: 3, removed: 0, failed: 0 });
    const heard = sent.map(s => s.endpoint).sort();
    const everyone = [...devices.keys()].filter(e => !e.includes('test-uX-')).sort();
    expect(heard).toEqual(everyone);
    expect(new Set(sent.map(s => s.payload.body.split('\n')[0]))).toEqual(new Set(['Xavier joined the group', 'Xavier 加入了群組']));
    expect(kept()).toEqual([]);
  });

  it('a friend\'s notification goes out the run after a big group\'s, while the rest of the big group is still kept', async () => {
    // Leo and 佳穎 have three devices each: Xavier's join in test-A reaches 9, four a run.
    for (const u of ['uL', 'uK']) for (const n of [2, 3]) await addDevice(u, n);
    const a = await world('test-A');
    const snap = (await api<GroupSnapshotDTO>('uG', 'GET', '/api/groups/' + a.gid)).data;
    expect((await api('uX', 'POST', '/api/join/' + snap.inviteCode, { name: 'Xavier' })).status).toBe(200);
    expect(await run(31_000, { PUSH_MAX_PER_RUN: '4' })).toEqual({ groups: 1, sent: 4, removed: 0, failed: 0 });
    expect(kept()).toHaveLength(5);
    // Xavier starts a ledger with Yuki: one device hears it.
    const f = await api<{ groupId: string }>('uX', 'POST', '/api/friends', { name: 'Yuki', email: 'y@evenly.test' });
    expect(f.status).toBe(200);
    sent = [];
    // A group is due, so the kept messages take half the budget; the ledger goes, and the room it
    // leaves goes to one more kept message.
    expect(await run(62_000, { PUSH_MAX_PER_RUN: '4' })).toEqual({ groups: 1, sent: 4, removed: 0, failed: 0 });
    expect(to('uY')).toEqual([{ title: 'Friend ledger', body: 'Xavier started a ledger with you', path: `/g/${f.data.groupId}`, tag: `g:${f.data.groupId}` }]);
    expect(sent.filter(s => s.payload.title === '🍣 test-A')).toHaveLength(3);
    expect(kept()).toHaveLength(2);
    expect(await run(93_000, { PUSH_MAX_PER_RUN: '4' })).toEqual({ groups: 0, sent: 2, removed: 0, failed: 0 });
    expect(kept()).toEqual([]);
    expect(pending()).toEqual([]);
  });

  it('a group that does not fit while a rest is kept gets its rows back, and goes whole later with what came after', async () => {
    for (const u of ['uL', 'uK']) for (const n of [2, 3]) await addDevice(u, n);
    const a = await world('test-A');
    const snap = (await api<GroupSnapshotDTO>('uG', 'GET', '/api/groups/' + a.gid)).data;
    expect((await api('uX', 'POST', '/api/join/' + snap.inviteCode, { name: 'Xavier' })).status).toBe(200);
    expect(await run(31_000, { PUSH_MAX_PER_RUN: '4' })).toEqual({ groups: 1, sent: 4, removed: 0, failed: 0 });
    // Gino starts a ledger with Leo: three devices, more than the two the next run has left.
    const f = await api<{ groupId: string }>('uG', 'POST', '/api/friends', { name: 'Leo', email: 'l@evenly.test' });
    expect(f.status).toBe(200);
    const created = db.rows<{ created_at: string }>("SELECT created_at FROM activity WHERE group_id = ? AND type = 'group.create'", f.data.groupId)[0].created_at;
    sent = [];
    expect(await run(62_000, { PUSH_MAX_PER_RUN: '4' })).toEqual({ groups: 0, sent: 4, removed: 0, failed: 0 });
    expect(sent.every(s => s.payload.title === '🍣 test-A')).toBe(true);
    // Claimed and given back as it was written; push_pending still holds test-A's rest alone.
    expect(pending()).toEqual([{ type: 'group.create', push_at: created }]);
    expect(new Set(kept().map(k => JSON.parse(k.payload).tag))).toEqual(new Set([`g:${a.gid}`]));
    // Meanwhile Gino adds an expense in the ledger.
    const ledger = (await api<GroupSnapshotDTO>('uG', 'GET', '/api/groups/' + f.data.groupId)).data;
    const gino = ledger.members.find(m => m.userId === 'uG')!.id;
    const leo = ledger.members.find(m => m.userId === 'uL')!.id;
    expect((await api('uG', 'PUT', `/api/groups/${f.data.groupId}/expenses/exp-0001`, expense(gino, 1000, [gino, leo], { currency: ledger.group.currency }))).status).toBe(200);
    sent = [];
    // The last kept message empties push_pending, and the ledger goes whole: one notification on each of Leo's devices.
    expect(await run(93_000, { PUSH_MAX_PER_RUN: '4' })).toEqual({ groups: 1, sent: 4, removed: 0, failed: 0 });
    expect(to('uL').filter(p => p.title === '兩人帳本').map(p => p.body)).toEqual(new Array(3).fill('Gino 開始了跟你的兩人帳本\n還有 1 筆新動態'));
    expect(kept()).toEqual([]);
    expect(pending()).toEqual([]);
  });

  it('a big group that keeps writing leaves the rest of one group at most, and is not even claimed while that rest goes out', async () => {
    // Gino's expenses in test-A reach Abbie (2 devices), Leo and 佳穎 (3 each): 8, four a run.
    for (const u of ['uL', 'uK']) for (const n of [2, 3]) await addDevice(u, n);
    const a = await world('test-A');
    const f = await api<{ groupId: string }>('uX', 'POST', '/api/friends', { name: 'Yuki', email: 'y@evenly.test' });
    settle();
    const ledger = (await api<GroupSnapshotDTO>('uX', 'GET', '/api/groups/' + f.data.groupId)).data;
    const xavier = ledger.members.find(m => m.userId === 'uX')!.id;
    const yuki = ledger.members.find(m => m.userId === 'uY')!.id;
    const claims = () => db.log.filter(sql => sql.startsWith('UPDATE activity SET push_at = NULL WHERE group_id')).length;
    const ledgerDue = () => db.rows('SELECT 1 FROM activity WHERE group_id = ? AND push_at IS NOT NULL', f.data.groupId).length > 0;
    const paidAt: number[] = [];
    const heardAt: number[] = [];
    const devicesHeard = new Set<string>();
    for (let i = 1; i <= 14; i++) {
      // Someone writes in test-A every minute for 8 minutes, and Xavier pays Yuki every other one.
      if (i <= 8) await put('uG', a, `exp-000${i}`, expense(a.m.G, 4000, [a.m.G, a.m.A, a.m.L, a.m.K]));
      if (i <= 8 && i % 2 === 0) {
        expect((await api('uX', 'PUT', `/api/groups/${f.data.groupId}/expenses/pay-000${i}`, pay(xavier, yuki, 100 * i, ledger.group.currency))).status).toBe(200);
        paidAt.push(i);
      }
      const before = kept().length;
      const due = ledgerDue();
      sent = [];
      db.log.splice(0);
      expect((await run(31_000 * i, { PUSH_MAX_PER_RUN: '4' })).sent).toBeLessThanOrEqual(4);
      expect(new Set(kept().map(k => JSON.parse(k.payload).tag)).size).toBeLessThanOrEqual(1);
      // A run that starts with more kept than its two takes passes test-A over: only the ledger is claimed.
      if (i <= 8 && before > 2) expect(claims()).toBe(due ? 1 : 0);
      heardAt.push(...to('uY').map(() => i));
      for (const s of sent) if (s.payload.title === '🍣 test-A') devicesHeard.add(s.endpoint);
    }
    expect(kept()).toEqual([]);
    expect(pending()).toEqual([]);
    // Each payment reached Yuki in its own run, or the next one when test-A was cut first.
    expect(heardAt).toHaveLength(4);
    heardAt.forEach((at, n) => expect(at - paidAt[n]).toBeLessThanOrEqual(1));
    expect(devicesHeard.size).toBe(8);
  });

  it('kept messages that can no longer go are deleted before the take, so they never use the budget', async () => {
    const w = await world();
    for (const u of ['uL', 'uK', 'uG']) await keep(u, endpointOf(u, 1), 'a day old', 25 * 3600_000);
    await keep('uA', endpointOf('uK', 1), 'moved');
    await keep('uX', endpointOf('uX', 1), 'session ended');
    db.exec('UPDATE sessions SET expires_at = ? WHERE user_id = ?', new Date(Date.now() - 1000).toISOString(), 'uX');
    await keep('uY', endpointOf('uY', 1), 'fresh');
    await put('uG', w, 'exp-0001', expense(w.m.G, 1000, [w.m.G, w.m.L]));
    // Five of the six cannot go: the one left takes half of the two, and the expense the other half.
    expect(await run(31_000, { PUSH_MAX_PER_RUN: '2' })).toEqual({ groups: 1, sent: 2, removed: 0, failed: 0 });
    expect(sent.map(s => [s.user, s.payload.body.split('\n')[0]]).sort()).toEqual([['uL', 'Gino 新增了「燒肉晚餐」 ¥1,000'], ['uY', 'fresh']]);
    expect(kept()).toEqual([]);
    expect(vi.mocked(console.log).mock.calls.map(c => String(c[0]))).toContain('push: 1 groups, 2 sent, 0 removed, 0 failed, 0 kept for later, 5 kept ones dropped, 0 groups waiting');
  });

  it('drops a kept message a day old, or whose device moved to another account or lost its session; signing out deletes them', async () => {
    await keep('uG', endpointOf('uG', 1), 'fresh');
    await keep('uL', endpointOf('uL', 1), 'a day old', 25 * 3600_000);
    // Written for Abbie, but the device is 佳穎's now (it changed account).
    await keep('uA', endpointOf('uK', 1), 'moved');
    await keep('uX', endpointOf('uX', 1), 'session ended');
    db.exec('UPDATE sessions SET expires_at = ? WHERE user_id = ?', new Date(Date.now() - 1000).toISOString(), 'uX');
    await keep('uY', endpointOf('uY', 1), 'signed out');
    expect((await api('uY', 'POST', '/api/auth/logout')).status).toBe(200);
    expect(kept().map(k => k.user_id)).toEqual(['uG', 'uL', 'uA', 'uX']);
    expect(await run()).toEqual({ groups: 0, sent: 1, removed: 0, failed: 0 });
    expect(sent.map(s => [s.user, s.payload.body])).toEqual([['uG', 'fresh']]);
    expect(kept()).toEqual([]);
    // Not silently: the run's log line counts them (counts only, nothing that names a device).
    expect(vi.mocked(console.log).mock.calls.map(c => String(c[0]))).toContain('push: 0 groups, 1 sent, 0 removed, 0 failed, 0 kept for later, 3 kept ones dropped, 0 groups waiting');
  });

  it('two runs at once never send a kept message twice', async () => {
    for (const u of ['uG', 'uL', 'uK']) await keep(u, endpointOf(u, 1), 'once');
    const both = await Promise.all([run(0, { PUSH_MAX_PER_RUN: '2' }), run(0, { PUSH_MAX_PER_RUN: '2' })]);
    expect(both[0].sent + both[1].sent).toBe(3);
    expect(sent.map(s => s.user).sort()).toEqual(['uG', 'uK', 'uL']);
    expect(kept()).toEqual([]);
  });

  it('each person\'s device in use goes first: the one whose session was used last', async () => {
    const w = await world();
    db.exec("DELETE FROM push_subscriptions WHERE user_id = 'uL'");
    // Leo's laptop (on the session from setup, last used a week ago) and his phone (a session of
    // its own, used now). Their ids sort the laptop first, and the last run reached both at once.
    let phone = 3;
    while ((await sha256Hex(endpointOf('uL', 2))) > (await sha256Hex(endpointOf('uL', phone)))) phone++;
    const laptop = await addDevice('uL', 2);
    const phoneToken = await createSession(db.d1, 'uL', 'phone');
    const phoneEndpoint = await addDevice('uL', phone, 3_600_000, phoneToken);
    db.exec('UPDATE sessions SET last_used_at = ? WHERE id = ?', new Date(Date.now() - 7 * 86_400_000).toISOString(), await sha256Hex(tokens.uL));
    db.exec("UPDATE push_subscriptions SET last_ok_at = '2026-10-16T12:00:00.000Z' WHERE user_id = 'uL'");
    await put('uG', w, 'exp-0001', expense(w.m.G, 1000, [w.m.G, w.m.L]));
    expect(await run(31_000, { PUSH_MAX_PER_RUN: '1' })).toMatchObject({ groups: 1, sent: 1 });
    expect(sent.map(s => s.endpoint)).toEqual([phoneEndpoint]);
    sent = [];
    expect(await run(32_000, { PUSH_MAX_PER_RUN: '1' })).toMatchObject({ groups: 0, sent: 1 });
    expect(sent.map(s => s.endpoint)).toEqual([laptop]);
  });

  it('deletes a subscription the push service says is gone, counts other failures, and deletes after 5 in a row', async () => {
    const w = await world();
    const gone = 'https://web.push.apple.com/test-uA-1';
    const flaky = 'https://web.push.apple.com/test-uL-1';
    answer = e => (e === gone ? 410 : e === flaky ? 500 : 201);
    await put('uG', w, 'exp-0001', expense(w.m.G, 3000, [w.m.G, w.m.A, w.m.L]));
    expect(await run()).toEqual({ groups: 1, sent: 1, removed: 1, failed: 1 });
    const subs = () => db.rows<{ endpoint: string; failures: number; last_ok_at: string | null }>('SELECT endpoint, failures, last_ok_at FROM push_subscriptions');
    expect(subs().some(s => s.endpoint === gone)).toBe(false);
    expect(subs().find(s => s.endpoint === flaky)!.failures).toBe(1);
    expect(subs().find(s => s.endpoint === 'https://web.push.apple.com/test-uA-2')!.last_ok_at).not.toBeNull();
    for (let i = 2; i <= FAILURES_MAX; i++) {
      await put('uG', w, 'exp-000' + i, expense(w.m.G, 3000, [w.m.G, w.m.L]));
      expect(await run(31_000 * i)).toMatchObject({ failed: 1 });
    }
    expect(subs().some(s => s.endpoint === flaky)).toBe(false);
    // A success resets the count.
    db.exec("UPDATE push_subscriptions SET failures = 3 WHERE endpoint = 'https://web.push.apple.com/test-uK-1'");
    await put('uG', w, 'exp-okay', expense(w.m.G, 3000, [w.m.G, w.m.K]));
    await run(31_000 * 10);
    expect(subs().find(s => s.endpoint === 'https://web.push.apple.com/test-uK-1')!.failures).toBe(0);
  });

  it('skips devices whose session expired, and groups that were deleted', async () => {
    const w = await world();
    db.exec('UPDATE sessions SET expires_at = ? WHERE user_id = ?', new Date(Date.now() - 1000).toISOString(), 'uL');
    await put('uG', w, 'exp-0001', expense(w.m.G, 3000, [w.m.G, w.m.A, w.m.L]));
    await run();
    expect(sent.map(s => s.user)).toEqual(['uA', 'uA']);

    sent = [];
    await put('uG', w, 'exp-0002', expense(w.m.G, 3000, [w.m.G, w.m.A]));
    expect((await api('uG', 'DELETE', '/api/groups/' + w.gid)).status).toBe(200);
    // Nobody hears a deleted group: its rows are cleared without using a claim.
    expect(await run(62_000)).toEqual({ groups: 0, sent: 0, removed: 0, failed: 0 });
    expect(pending()).toEqual([]);
  });

  it('without VAPID keys sends nothing, keeps a day of rows and drops older ones', async () => {
    const w = await world();
    await put('uG', w, 'exp-0001', expense(w.m.G, 3000, [w.m.G, w.m.L]));
    db.exec(
      "INSERT INTO activity (id, group_id, user_id, member_id, type, expense_id, data, created_at, push_at) VALUES ('stale', ?, 'uG', ?, 'member.join', NULL, '{}', ?, ?)",
      w.gid, w.m.G, new Date(Date.now() - 2 * 86_400_000).toISOString(), new Date(Date.now() - 2 * 86_400_000).toISOString(),
    );
    expect(await run(31_000, { VAPID_PRIVATE_JWK: undefined })).toEqual({ groups: 0, sent: 0, removed: 0, failed: 0 });
    expect(sent).toEqual([]);
    expect(pending().map(p => p.type)).toEqual(['expense.create']);
    // Once the keys are there, it goes out.
    expect(await run()).toMatchObject({ groups: 1, sent: 1 });
  });

  it('a claim that fails mid-run still sends what the earlier claims took', async () => {
    const a = await world('test-A');
    const b = await world('test-B');
    await put('uG', a, 'exp-0001', expense(a.m.G, 1000, [a.m.G, a.m.L]));
    await put('uG', b, 'exp-0002', expense(b.m.G, 1000, [b.m.G, b.m.K]));
    let batches = 0;
    const flaky = {
      prepare: (sql: string) => db.prepare(sql),
      batch: (stmts: Parameters<TestD1['batch']>[0]) => {
        // After the run's start and the first claim, the second claim fails; the delivery batch works.
        if (++batches === 3) return Promise.reject(new Error('D1 is busy'));
        return db.batch(stmts);
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runPushSender({ ...env, DB: flaky } as never, new Date(Date.now() + 31_000))).toEqual({ groups: 1, sent: 1, removed: 0, failed: 0 });
    expect(sent.map(s => [s.user, s.payload.title])).toEqual([['uL', '🍣 test-A']]);
    // test-B was never claimed: it goes next time.
    sent = [];
    expect(await run()).toMatchObject({ groups: 1, sent: 1 });
    expect(sent.map(s => [s.user, s.payload.title])).toEqual([['uK', '🍣 test-B']]);
  });

  it('stays under 50 subrequests (D1 calls and fetches) in every run, at any budget, and sends every message once', async () => {
    // Ten people with a device each in twelve groups, and a join pending in every group: 9 messages a group.
    const people = ['uG', 'uA', 'uL', 'uK', 'uX', 'uY'];
    for (const id of ['u7', 'u8', 'u9', 'u10']) {
      await addUser(id, 'P' + id, id + '@evenly.test', 'en');
      await addDevice(id);
      people.push(id);
    }
    db.exec("DELETE FROM push_subscriptions WHERE endpoint = 'https://web.push.apple.com/test-uA-2'");
    const at = new Date(Date.now() - 60_000).toISOString();
    for (let g = 0; g < 12; g++) await joinedGroup('grp-' + String(g).padStart(4, '0'), people, new Date(Date.parse(at) + g).toISOString());
    const counted = countedD1();
    // A run cuts the group that does not fit and keeps the rest: 12 (9 and 3), then 40 (the 6 kept,
    // three groups and 7), 12, 40, and the last 4.
    const got: string[] = [];
    for (const [budget, groups, messages] of [['12', 2, 12], ['40', 4, 40], ['12', 2, 12], ['40', 4, 40], ['12', 0, 4]] as const) {
      counted.calls = 0;
      sent = [];
      const r = await runPushSender({ ...env, DB: counted.d1, PUSH_MAX_PER_RUN: budget } as never, new Date());
      expect(r).toEqual({ groups, sent: messages, removed: 0, failed: 0 });
      expect(sent).toHaveLength(messages);
      // Two more are the run route's own sign-in check.
      expect(counted.calls + sent.length + 2).toBeLessThanOrEqual(50);
      got.push(...sent.map(s => s.user + ' ' + s.payload.title));
    }
    // Everyone heard about every group, once.
    expect(got).toHaveLength(108);
    expect(new Set(got).size).toBe(108);
    expect(pending()).toEqual([]);
    expect(kept()).toEqual([]);
  });

  it('a run that gives groups back and fills the room with kept messages stays under 50 subrequests too', async () => {
    // Leo, 佳穎 and Xavier with eight devices each in five groups, a join by Gino pending in each:
    // 24 messages a group, more than the 20 a run at budget 40 leaves for groups while 50 are kept.
    for (const u of ['uL', 'uK', 'uX']) for (let n = 2; n <= 8; n++) await addDevice(u, n);
    const at = new Date(Date.now() - 60_000).toISOString();
    for (let g = 0; g < 5; g++) await joinedGroup('big-' + g, ['uG', 'uL', 'uK', 'uX'], new Date(Date.parse(at) + g).toISOString());
    for (let i = 0; i < 50; i++) await keep('uG', endpointOf('uG', 1), 'kept ' + i);
    const counted = countedD1();
    const got: string[] = [];
    const runs: { groups: number; sent: number; calls: number }[] = [];
    for (let i = 0; i < 8 && (kept().length || pending().length); i++) {
      counted.calls = 0;
      sent = [];
      const r = await runPushSender({ ...env, DB: counted.d1, PUSH_MAX_PER_RUN: '40' } as never, new Date());
      expect(r.sent).toBe(sent.length);
      // Two more are the run route's own sign-in check.
      expect(counted.calls + sent.length + 2).toBeLessThanOrEqual(50);
      runs.push({ groups: r.groups, sent: r.sent, calls: counted.calls });
      got.push(...sent.map(s => `${s.endpoint} ${s.payload.title} ${s.payload.body}`));
      // The first run's four claims (all a run at budget 40 makes) gave their rows back: all five joins wait.
      if (i === 0) expect(pending()).toHaveLength(5);
    }
    expect(runs).toEqual([
      // 20 kept, four claims given back, 20 more kept: 7 D1 calls and 40 fetches.
      { groups: 0, sent: 40, calls: 7 },
      // The last 10 kept, a group, and 6 of the next one, whose 18 others are kept.
      { groups: 2, sent: 40, calls: 5 },
      { groups: 1, sent: 40, calls: 4 },
      { groups: 2, sent: 40, calls: 5 },
      { groups: 0, sent: 10, calls: 2 },
    ]);
    // Every kept message and every device of every group, once.
    expect(got).toHaveLength(170);
    expect(new Set(got).size).toBe(170);
  });

  // ---------- groups nobody can hear, and turns ----------

  it('groups nobody can hear never use a claim: one account\'s many solo groups do not hold up a friend\'s expense', async () => {
    const w = await world();
    await addUser('uZ', 'Zed', 'z@evenly.test', 'en');
    await addDevice('uZ');
    // 35 groups of Zed alone (his own device does not count), one Yuki left, and one he deleted.
    for (let i = 0; i < 35; i++) expect((await api('uZ', 'POST', '/api/groups', { name: 'test-Solo ' + i, type: 'other', currency: 'TWD' })).status).toBe(200);
    const left = await api<GroupSnapshotDTO>('uZ', 'POST', '/api/groups', { name: 'test-Left', type: 'other', currency: 'TWD', members: [{ name: 'Yuki', email: 'y@evenly.test' }] });
    const yuki = left.data.members.find(m => m.name === 'Yuki')!.id;
    expect((await api('uY', 'DELETE', `/api/groups/${left.data.group.id}/members/${yuki}`)).status).toBe(200);
    const gone = await api<GroupSnapshotDTO>('uZ', 'POST', '/api/groups', { name: 'test-Gone', type: 'other', currency: 'TWD', members: [{ name: 'Yuki', email: 'y@evenly.test' }] });
    expect((await api('uZ', 'DELETE', '/api/groups/' + gone.data.group.id)).status).toBe(200);
    await put('uG', w, 'exp-0001', expense(w.m.G, 1000, [w.m.G, w.m.L]));
    expect(pending()).toHaveLength(38);
    // All of them are older than Gino's expense, and still it goes in the first run.
    expect(await run()).toEqual({ groups: 1, sent: 1, removed: 0, failed: 0 });
    expect(to('uL').map(p => p.title)).toEqual(['🍣 test-東京行']);
    expect(pending()).toEqual([]);
  });

  it('a new entry someone else deleted stays an undo, even when only that person has a device', async () => {
    const w = await world();
    db.exec("DELETE FROM push_subscriptions WHERE user_id <> 'uL'");
    await put('uG', w, 'exp-undo', expense(w.m.G, 9000, [w.m.G, w.m.L]));
    expect((await api('uL', 'DELETE', `/api/groups/${w.gid}/expenses/exp-undo`)).status).toBe(200);
    // The group is decided as a whole: Leo's delete keeps Gino's create company, so nothing goes out.
    expect(await run()).toEqual({ groups: 1, sent: 0, removed: 0, failed: 0 });
    expect(sent).toEqual([]);
    expect(pending()).toEqual([]);
  });

  it('groups take turns by who wrote them: one account\'s backlog does not hold up anyone else', async () => {
    const w = await world();
    await addUser('uZ', 'Zed', 'z@evenly.test', 'en');
    // Twelve groups of Zed with Yuki in each (she has a device), all older than Gino's expense.
    for (let i = 0; i < 12; i++) {
      const r = await api('uZ', 'POST', '/api/groups', { name: 'test-Z' + i, type: 'other', currency: 'TWD', members: [{ name: 'Yuki', email: 'y@evenly.test' }] });
      expect(r.status).toBe(200);
    }
    await put('uG', w, 'exp-0001', expense(w.m.G, 1000, [w.m.G, w.m.L]));
    // Ten claims a run: Zed's oldest group, Gino's, then Zed's next ones.
    expect(await run()).toEqual({ groups: 10, sent: 10, removed: 0, failed: 0 });
    expect(to('uL').map(p => p.title)).toEqual(['🍣 test-東京行']);
    expect(to('uY').map(p => p.title).sort()).toEqual(['test-Z0', 'test-Z1', 'test-Z2', 'test-Z3', 'test-Z4', 'test-Z5', 'test-Z6', 'test-Z7', 'test-Z8']);
    sent = [];
    expect(await run(32_000)).toEqual({ groups: 3, sent: 3, removed: 0, failed: 0 });
    expect(to('uY').map(p => p.title).sort()).toEqual(['test-Z10', 'test-Z11', 'test-Z9']);
  });

  it('a claim reads the new entries by their key, never every entry of the group', async () => {
    const w = await world();
    await put('uG', w, 'exp-0001', expense(w.m.G, 1000, [w.m.G, w.m.L]));
    db.log.splice(0);
    await run();
    const reads = db.log.filter(sql => /\bexpenses\b/.test(sql));
    expect(reads).toHaveLength(1);
    // D1 keeps no table statistics, so the plan is what SQLite picks without them, as here.
    const plan = db.rows<{ detail: string }>('EXPLAIN QUERY PLAN ' + reads[0]).map(r => r.detail);
    expect(plan.some(d => /USING INDEX idx_activity_push/.test(d))).toBe(true);
    expect(plan.some(d => /SEARCH e USING INDEX sqlite_autoindex_expenses_1 \(id=\?\)/.test(d))).toBe(true);
    expect(plan.some(d => /idx_expenses_group|SCAN e\b|SCAN expenses/.test(d))).toBe(false);
  });
});
