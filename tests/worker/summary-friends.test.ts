import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entryNet, type LedgerEntry } from '../../src/shared/balances';
import { computeShares, type Portion } from '../../src/shared/split';
import { computeGroupSummary, SUMMARY_VERSION, type GroupSummary } from '../../src/shared/summary';
import type { GroupType } from '../../src/shared/types';
import { entryActivityData, SYSTEM_ACTOR_NAME, toActivityDTO } from '../../src/worker/services/activity';
import {
  balancesWithMe, buildDashboard, chunk, placeholders, storedSummary, usableEntries, type DashGroup, type DashMember,
} from '../../src/worker/services/summary';

// ---------- fixtures ----------

let seq = 0;
function expense(currency: string, fxRate: number, amount: number, payer: string, sharers: string[]): LedgerEntry {
  const r = computeShares(amount, { method: 'equal', entries: sharers.map(memberId => ({ memberId })) }, [payer]);
  if (!r.ok) throw new Error('bad fixture ' + r.code);
  return { id: 'e' + ++seq, kind: 'expense', amount, currency, fxRate, payers: [{ memberId: payer, amount }], shares: r.shares, date: '2026-10-10' };
}

function payment(currency: string, amount: number, from: string, to: string): LedgerEntry {
  return { id: 'p' + ++seq, kind: 'payment', amount, currency, fxRate: 1, payers: [{ memberId: from, amount }], shares: [{ memberId: to, amount }], date: '2026-10-11' };
}

function dashGroup(args: {
  id: string;
  type?: GroupType;
  currency: string;
  updatedAt: string;
  me: string;
  members: DashMember[];
  entries: LedgerEntry[];
  simplify?: boolean;
}): DashGroup {
  const summary = computeGroupSummary({
    currency: args.currency,
    simplify: args.simplify ?? true,
    memberOrder: args.members.map(m => m.id),
    entries: args.entries,
    forVersion: 3,
  });
  return {
    group: { id: args.id, name: args.id, type: args.type ?? 'trip', currency: args.currency, emoji: '', color: '#2F6FB5', version: 3, updatedAt: args.updatedAt },
    myMemberId: args.me,
    summary,
    members: args.members,
  };
}

const m = (id: string, userId: string | null, name: string, active = true): DashMember => ({ id, userId, name, color: '#475569', active });

const people = {
  uAb: { name: 'Abbie Lin', color: '#C2410C', payInfo: '國泰 013-123456', venmo: 'abbie', paypal: '' },
  uTf: { name: 'Tiffany', color: '#15803D', payInfo: '', venmo: '', paypal: 'tiff' },
};

// Niseko trip in JPY: I paid 12,000 for me, Abbie and Kevin. Leo left long ago (balance 0).
const trip = dashGroup({
  id: 'gTrip',
  currency: 'JPY',
  updatedAt: '2026-10-10T00:00:00.000Z',
  me: 'tMe',
  members: [m('tMe', 'uMe', 'Gino'), m('tAb', 'uAb', 'Abbie'), m('tKv', null, 'Kevin'), m('tLeo', null, 'Leo', false)],
  entries: [expense('JPY', 1, 12000, 'tMe', ['tMe', 'tAb', 'tKv'])],
});
// 1:1 ledger with Abbie in TWD: she paid 1,000 for both of us.
const pair = dashGroup({
  id: 'gPair',
  type: 'pair',
  currency: 'TWD',
  updatedAt: '2026-10-15T00:00:00.000Z',
  me: 'pMe',
  members: [m('pMe', 'uMe', 'Gino'), m('pAb', 'uAb', 'Abbie')],
  entries: [expense('TWD', 1, 1000, 'pAb', ['pMe', 'pAb'])],
});
// Home group with nothing recorded yet.
const home = dashGroup({
  id: 'gHome',
  type: 'home',
  currency: 'TWD',
  updatedAt: '2026-10-01T00:00:00.000Z',
  me: 'hMe',
  members: [m('hMe', 'uMe', 'Gino'), m('hAb', 'uAb', 'Abbie'), m('hTf', 'uTf', 'Tiff')],
  entries: [],
});

// ---------- buildDashboard ----------

describe('buildDashboard', () => {
  const dash = buildDashboard({ userId: 'uMe', homeCurrency: 'TWD', groups: [trip, home, pair], people });
  const friend = (key: string) => dash.friends.find(f => f.key === key);

  it('lists groups newest change first with my net and my transfers', () => {
    expect(dash.groups.map(g => g.id)).toEqual(['gPair', 'gTrip', 'gHome']);
    const t = dash.groups.find(g => g.id === 'gTrip')!;
    expect(t.myNet).toBe(8000);
    expect(t.myMemberId).toBe('tMe');
    expect(t.myTransfers).toEqual([
      { from: 'tAb', to: 'tMe', amount: 4000 },
      { from: 'tKv', to: 'tMe', amount: 4000 },
    ]);
    expect(t.spent).toBe(12000);
    expect(t.count).toBe(1);
    expect(t.lastDate).toBe('2026-10-10');
    expect(t.members.map(x => x.id)).toEqual(['tMe', 'tAb', 'tKv', 'tLeo']);
    expect(dash.groups.find(g => g.id === 'gPair')!.myNet).toBe(-500);
    expect(dash.groups.find(g => g.id === 'gHome')!.myNet).toBe(0);
  });

  it('merges a person with an account across groups and currencies', () => {
    const ab = friend('u:uAb')!;
    expect(ab.userId).toBe('uAb');
    expect(ab.name).toBe('Abbie Lin'); // account name, not the name used in one group
    expect(ab.balances).toEqual([
      { currency: 'TWD', amount: -500 }, // home currency first
      { currency: 'JPY', amount: 4000 },
    ]);
    expect(ab.groups).toEqual([
      { groupId: 'gPair', memberId: 'pAb', currency: 'TWD', amount: -500 },
      { groupId: 'gTrip', memberId: 'tAb', currency: 'JPY', amount: 4000 },
      { groupId: 'gHome', memberId: 'hAb', currency: 'TWD', amount: 0 },
    ]);
    expect(ab.pairGroupId).toBe('gPair');
    expect(ab.payInfo).toBe('國泰 013-123456');
    expect(ab.venmo).toBe('abbie');
  });

  it('lists placeholders per group and leaves out members who left with nothing owed', () => {
    const kv = friend('m:tKv')!;
    expect(kv.userId).toBeNull();
    expect(kv.name).toBe('Kevin');
    expect(kv.balances).toEqual([{ currency: 'JPY', amount: 4000 }]);
    expect(kv.pairGroupId).toBeNull();
    expect(kv.payInfo).toBe('');
    expect(friend('m:tLeo')).toBeUndefined();
  });

  it('includes people I only share settled groups with, after everyone with a balance', () => {
    const tf = friend('u:uTf')!;
    expect(tf.balances).toEqual([]);
    expect(tf.groups).toEqual([{ groupId: 'gHome', memberId: 'hTf', currency: 'TWD', amount: 0 }]);
    expect(tf.paypal).toBe('tiff');
    expect(dash.friends.map(f => f.key)).toEqual(['u:uAb', 'm:tKv', 'u:uTf']);
  });

  it('never lists me as a friend', () => {
    expect(dash.friends.some(f => f.userId === 'uMe')).toBe(false);
  });

  it('totals per currency come from my net per group', () => {
    expect(dash.totals).toEqual([
      { currency: 'TWD', owed: 0, owe: 500 },
      { currency: 'JPY', owed: 8000, owe: 0 },
    ]);
  });

  it('keeps a member who left while a transfer still involves them', () => {
    const g = dashGroup({
      id: 'gLeft',
      currency: 'TWD',
      updatedAt: '2026-10-02T00:00:00.000Z',
      me: 'a',
      members: [m('a', 'uMe', 'Gino'), m('b', null, 'Bob', false)],
      entries: [expense('TWD', 1, 300, 'a', ['a', 'b'])],
    });
    const d = buildDashboard({ userId: 'uMe', groups: [g], people: {} });
    expect(d.friends).toEqual([
      expect.objectContaining({ key: 'm:b', balances: [{ currency: 'TWD', amount: 150 }], groups: [{ groupId: 'gLeft', memberId: 'b', currency: 'TWD', amount: 150 }] }),
    ]);
  });

  it('follows pairwise plans when simplify is off', () => {
    // a paid 900 for a, b, c; then c paid 600 for b and c. Pairwise: b owes a 300, c owes a 300, b owes c 300.
    const g = dashGroup({
      id: 'gPw',
      currency: 'TWD',
      updatedAt: '2026-10-03T00:00:00.000Z',
      me: 'a',
      simplify: false,
      members: [m('a', 'uMe', 'Gino'), m('b', 'uB', 'Bea'), m('c', 'uC', 'Cid')],
      entries: [expense('TWD', 1, 900, 'a', ['a', 'b', 'c']), expense('TWD', 1, 600, 'c', ['b', 'c'])],
    });
    const d = buildDashboard({ userId: 'uMe', groups: [g], people: {} });
    expect(d.groups[0].myTransfers).toEqual([
      { from: 'b', to: 'a', amount: 300 },
      { from: 'c', to: 'a', amount: 300 },
    ]);
    expect(d.friends.find(f => f.key === 'u:uB')!.balances).toEqual([{ currency: 'TWD', amount: 300 }]);
    expect(d.friends.find(f => f.key === 'u:uC')!.balances).toEqual([{ currency: 'TWD', amount: 300 }]);
  });

  it('does not treat a pair group with three active people as a 1:1 ledger', () => {
    const g = dashGroup({
      id: 'gOdd',
      type: 'pair',
      currency: 'TWD',
      updatedAt: '2026-10-04T00:00:00.000Z',
      me: 'a',
      members: [m('a', 'uMe', 'Gino'), m('b', 'uB', 'Bea'), m('c', null, 'Cid')],
      entries: [],
    });
    const d = buildDashboard({ userId: 'uMe', groups: [g], people: {} });
    expect(d.friends.every(f => f.pairGroupId === null)).toBe(true);
  });

  it('is empty without groups', () => {
    expect(buildDashboard({ userId: 'uMe', groups: [], people: {} })).toEqual({ groups: [], friends: [], totals: [] });
  });
});

// ---------- invariants over random ledgers ----------

const MEMBERS = ['me', 'b', 'c', 'd'];
const USERS: Record<string, string | null> = { me: 'uMe', b: 'uB', c: null, d: 'uD' };

const entryArb = (groupCurrency: string) =>
  fc
    .record({
      payer: fc.constantFrom(...MEMBERS),
      sharers: fc.subarray(MEMBERS, { minLength: 1 }),
      amount: fc.integer({ min: 1, max: 500000 }),
      foreign: fc.boolean(),
      isPayment: fc.boolean(),
      to: fc.constantFrom(...MEMBERS),
    })
    .map(x => {
      if (x.isPayment && x.to !== x.payer) return payment(groupCurrency, x.amount, x.payer, x.to);
      return x.foreign && groupCurrency !== 'USD'
        ? expense('USD', 31.57, x.amount, x.payer, x.sharers)
        : expense(groupCurrency, 1, x.amount, x.payer, x.sharers);
    });

const groupArb = (id: string, currency: string) =>
  fc.record({ entries: fc.array(entryArb(currency), { maxLength: 8 }), simplify: fc.boolean(), day: fc.integer({ min: 1, max: 28 }) }).map(x =>
    dashGroup({
      id,
      currency,
      simplify: x.simplify,
      updatedAt: `2026-09-${String(x.day).padStart(2, '0')}T00:00:00.000Z`,
      me: 'me',
      members: MEMBERS.map(mid => m(mid, USERS[mid], mid)),
      entries: x.entries,
    }),
  );

describe('dashboard invariants', () => {
  it('per group, what friends owe me adds up to my net; per currency, friends and totals agree', () => {
    fc.assert(
      fc.property(fc.tuple(groupArb('g1', 'TWD'), groupArb('g2', 'TWD'), groupArb('g3', 'JPY')), groups => {
        // Members are per group, so give each group its own member ids (one person = one user id).
        const renamed = groups.map(g => {
          const map = (id: string) => (id === 'me' ? 'me' : `${g.group.id}:${id}`);
          return {
            ...g,
            members: g.members.map(x => ({ ...x, id: map(x.id) })),
            summary: {
              ...g.summary,
              net: Object.fromEntries(Object.entries(g.summary.net).map(([k, v]) => [map(k), v])),
              transfers: g.summary.transfers.map(t => ({ ...t, from: map(t.from), to: map(t.to) })),
            },
          };
        });
        const d = buildDashboard({ userId: 'uMe', homeCurrency: 'TWD', groups: renamed, people: {} });

        for (const g of renamed) {
          const item = d.groups.find(x => x.id === g.group.id)!;
          const sum = d.friends.flatMap(f => f.groups).filter(x => x.groupId === g.group.id).reduce((s, x) => s + x.amount, 0);
          expect(sum).toBe(item.myNet);
          expect(item.myTransfers.every(t => t.from === 'me' || t.to === 'me')).toBe(true);
        }
        for (const cur of ['TWD', 'JPY']) {
          const fromFriends = d.friends.flatMap(f => f.balances).filter(b => b.currency === cur).reduce((s, b) => s + b.amount, 0);
          const net = d.groups.filter(g => g.currency === cur).reduce((s, g) => s + g.myNet, 0);
          const t = d.totals.find(x => x.currency === cur);
          expect(fromFriends).toBe(net);
          expect((t?.owed ?? 0) - (t?.owe ?? 0)).toBe(net);
          if (t) expect(t.owed > 0 || t.owe > 0).toBe(true);
        }
        for (const f of d.friends) {
          expect(f.balances.every(b => b.amount !== 0)).toBe(true);
          expect(f.userId === null ? f.key.startsWith('m:') : f.key === 'u:' + f.userId).toBe(true);
        }
        // People with accounts are one friend across all three groups.
        expect(d.friends.filter(f => f.userId === 'uB')).toHaveLength(1);
        expect(d.friends.filter(f => f.userId === 'uB')[0].groups).toHaveLength(3);
        // The placeholder appears once per group.
        expect(d.friends.filter(f => f.userId === null)).toHaveLength(3);
      }),
      { numRuns: 300 },
    );
  });
});

// ---------- small helpers ----------

describe('balancesWithMe', () => {
  it('signs transfers from my side and ignores the others', () => {
    const r = balancesWithMe('me', [
      { from: 'a', to: 'me', amount: 100 },
      { from: 'me', to: 'b', amount: 40 },
      { from: 'a', to: 'b', amount: 7 },
      { from: 'a', to: 'me', amount: 5 },
    ]);
    expect([...r]).toEqual([
      ['a', 105],
      ['b', -40],
    ]);
  });
});

describe('storedSummary', () => {
  const s: GroupSummary = computeGroupSummary({ currency: 'TWD', simplify: true, memberOrder: ['a'], entries: [], forVersion: 7 });
  const row = (summary: string | null, version = 7, currency = 'TWD') => ({ summary, version, currency });

  it('returns the stored summary when it matches the group version, math version and currency', () => {
    expect(storedSummary(row(JSON.stringify(s)))).toEqual(s);
    expect(s.v).toBe(SUMMARY_VERSION);
  });

  it('treats anything else as stale', () => {
    expect(storedSummary(row(null))).toBeNull();
    expect(storedSummary(row('not json'))).toBeNull();
    expect(storedSummary(row(JSON.stringify(s), 8))).toBeNull();
    expect(storedSummary(row(JSON.stringify(s), 7, 'JPY'))).toBeNull();
    expect(storedSummary(row(JSON.stringify({ ...s, v: SUMMARY_VERSION + 1 })))).toBeNull();
    expect(storedSummary(row(JSON.stringify({ ...s, transfers: null })))).toBeNull();
  });
});

describe('usableEntries', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => spy.mockRestore());

  it('keeps consistent entries and drops corrupt ones', () => {
    const good = expense('TWD', 1, 1000, 'a', ['a', 'b']);
    const foreign = expense('USD', 31.5, 1250, 'a', ['a', 'b']);
    const badSum: LedgerEntry = { ...good, id: 'x1', shares: [{ memberId: 'a', amount: 1 }] };
    const noPayers: LedgerEntry = { ...good, id: 'x2', payers: [] };
    const badRate: LedgerEntry = { ...foreign, id: 'x3', fxRate: 0 };
    const fractional: LedgerEntry = { ...good, id: 'x4', amount: 10.5, payers: [{ memberId: 'a', amount: 10.5 }], shares: [{ memberId: 'b', amount: 10.5 }] };
    const kept = usableEntries([good, badSum, foreign, noPayers, badRate, fractional], 'TWD', 'g');
    expect(kept.map(e => e.id)).toEqual([good.id, foreign.id]);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('accepts a rate of 0 when the entry is in the group currency (the rate is not used)', () => {
    const e = { ...expense('TWD', 1, 500, 'a', ['a']), fxRate: 0 };
    expect(usableEntries([e], 'TWD')).toHaveLength(1);
  });
});

describe('chunk and placeholders', () => {
  it('splits IN lists at 90 ids by default', () => {
    const ids = Array.from({ length: 200 }, (_, i) => 'id' + i);
    const parts = chunk(ids);
    expect(parts.map(p => p.length)).toEqual([90, 90, 20]);
    expect(parts.flat()).toEqual(ids);
    expect(chunk([])).toEqual([]);
    expect(placeholders(3)).toBe('?, ?, ?');
  });
});

// ---------- activity helpers ----------

describe('entryActivityData', () => {
  it('records each member effect in the group currency, netting to zero', () => {
    const payers: Portion[] = [{ memberId: 'a', amount: 12600 }];
    const shares: Portion[] = [
      { memberId: 'a', amount: 4200 },
      { memberId: 'b', amount: 4200 },
      { memberId: 'c', amount: 4200 },
    ];
    const d = entryActivityData({ id: 'e-yakiniku', kind: 'expense', description: '燒肉', amount: 12600, currency: 'JPY', fxRate: 0.2105, payers, shares }, 'TWD');
    expect(d).toMatchObject({ kind: 'expense', description: '燒肉', amount: 12600, currency: 'JPY', groupCurrency: 'TWD' });
    expect(d.nets).toEqual({ a: 1768, b: -884, c: -884 });
    expect(Object.values(d.nets!).reduce((s, v) => s + v, 0)).toBe(0);
  });

  it('matches the entry\'s real effect when a converted amount has rounding ties (they follow the entry id)', () => {
    // ¥1,200 at 0.2040268032 is NT$245 for three people: one of them owes NT$81, the others NT$82.
    const payers: Portion[] = [{ memberId: 'dora', amount: 1200 }];
    const shares: Portion[] = [
      { memberId: 'a', amount: 400 },
      { memberId: 'b', amount: 400 },
      { memberId: 'c', amount: 400 },
    ];
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const id = `jpy-1200-${i}`;
      const e = { id, kind: 'expense' as const, amount: 1200, currency: 'JPY', fxRate: 0.2040268032, payers, shares };
      const d = entryActivityData({ ...e, description: '三人分' }, 'TWD');
      expect(d.nets).toEqual(Object.fromEntries(entryNet(e, 'TWD')));
      seen.add(JSON.stringify(d.nets));
    }
    // Different ids put the leftover on different people, so an id-less ledger would be wrong for some.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('keeps involved members at zero and treats unknown kinds as expenses', () => {
    const d = entryActivityData(
      { id: 'e-x', kind: 'weird', description: 'x', amount: 100, currency: 'TWD', fxRate: 1, payers: [{ memberId: 'a', amount: 100 }], shares: [{ memberId: 'a', amount: 100 }] },
      'TWD',
    );
    expect(d.kind).toBe('expense');
    expect(d.nets).toEqual({ a: 0 });
  });

  it('never throws on a bad rate', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = entryActivityData(
      { id: 'p-x', kind: 'payment', description: '', amount: 100, currency: 'USD', fxRate: 0, payers: [{ memberId: 'a', amount: 100 }], shares: [{ memberId: 'b', amount: 100 }] },
      'TWD',
    );
    spy.mockRestore();
    expect(d.kind).toBe('payment');
    expect(d.nets).toEqual({});
  });
});

describe('toActivityDTO', () => {
  const base = {
    id: 'a1', group_id: 'g1', user_id: 'u1', member_id: 'm1', type: 'expense.create', expense_id: 'e1',
    data: JSON.stringify({ description: '晚餐', nets: { m1: 100 } }), created_at: '2026-10-16T00:00:00.000Z',
    group_name: '日本', group_emoji: '🗾', group_type: 'trip', actor_name: 'Gino',
  };

  it('maps the joined row', () => {
    expect(toActivityDTO(base)).toEqual({
      id: 'a1', groupId: 'g1', groupName: '日本', groupEmoji: '🗾', groupType: 'trip', userId: 'u1', memberId: 'm1',
      actorName: 'Gino', type: 'expense.create', expenseId: 'e1', data: { description: '晚餐', nets: { m1: 100 } },
      createdAt: '2026-10-16T00:00:00.000Z',
    });
  });

  it('falls back for the system actor, broken data and unknown group types', () => {
    const d = toActivityDTO({ ...base, user_id: null, member_id: null, actor_name: null, data: '[1,2]', group_type: 'party' });
    expect(d.actorName).toBe(SYSTEM_ACTOR_NAME);
    expect(d.data).toEqual({});
    expect(d.groupType).toBe('other');
    expect(toActivityDTO({ ...base, data: 'oops' }).data).toEqual({});
  });
});
