// A group's default split in the app (docs/SPEC.md section 4, Default split): a new expense's
// draft starts from it (features/expenses/editorLogic.ts withDefaultSplit), which split drafts can
// become one (defaultFromDraft: 平均 / 比例 / 份數 that add up, among active members) and whether a
// draft is the group's default (isDefaultDraft), the words for it on 設定 and in the editor
// (editorText.ts), and the feed's sentence for a change (activityText.ts). The rules themselves
// are tests/shared/defaultSplit.test.ts; the Worker's side is tests/worker/default-split.test.ts.

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

import { applyDefaultSplit, type DefaultSplit } from '../../src/shared/defaultSplit';
import type { ActivityDTO } from '../../src/shared/types';
import { describeActivity, type ActivityContext } from '../../src/web/features/activity/activityText';
import {
  buildSplit, defaultFromDraft, emptySplit, isDefaultDraft, newDraft, splitDraftFromInput, withDefaultSplit, withMethod,
} from '../../src/web/features/expenses/editorLogic';
import { defaultPayerText, defaultSplitNote, defaultSplitSummary } from '../../src/web/features/expenses/defaultSplitText';
import { setLocale } from '../../src/web/lib/i18n';

const IDS = ['gino', 'abbie', 'kai'];
const SET_AT = '2026-10-01T00:00:00.000Z';
const rent: DefaultSplit = { method: 'percent', entries: [{ memberId: 'gino', value: 60 }, { memberId: 'abbie', value: 40 }], payerId: 'abbie', setAt: SET_AT };
const members = IDS.map(id => ({ id, active: true, createdAt: '2026-09-01T00:00:00.000Z' }));
const names: Record<string, string> = { gino: 'Gino', abbie: 'Abbie', kai: '佳穎', lily: 'Lily' };
const nameOf = (id: string) => (id === 'gino' ? setLocaleName() : names[id]);
let zhNow = true;
const setLocaleName = () => (zhNow ? '你' : 'you');

beforeEach(() => setLocale('zh-TW'));

afterEach(() => {
  setLocale('zh-TW');
  zhNow = true;
});

describe('a new expense starts from the default', () => {
  it('takes its split and its payer', () => {
    const fresh = newDraft({ id: 'e1', memberIds: IDS, meId: 'gino', currency: 'TWD', date: '2026-10-25' });
    const d = withDefaultSplit(fresh, applyDefaultSplit(rent, members), IDS);
    expect(d.split.method).toBe('percent');
    expect(d.split.percent).toEqual({ gino: '60', abbie: '40' });
    expect(d.payerId).toBe('abbie');
    expect(buildSplit(d.split, IDS, 'TWD')).toEqual({ ok: true, split: { method: 'percent', entries: [{ memberId: 'gino', value: 60 }, { memberId: 'abbie', value: 40 }] } });
  });

  it('keeps 平均分給全部 when there is no default, or when it no longer adds up', () => {
    const fresh = newDraft({ id: 'e1', memberIds: IDS, meId: 'gino', currency: 'TWD', date: '2026-10-25' });
    expect(withDefaultSplit(fresh, null, IDS)).toBe(fresh);
    const gone = members.map(m => (m.id === 'abbie' ? { ...m, active: false } : m));
    const d = withDefaultSplit(fresh, applyDefaultSplit(rent, gone), IDS.filter(id => id !== 'abbie'));
    expect(d.split).toEqual(fresh.split);
    // The payer who left is not used either: whoever adds it pays.
    expect(d.payerId).toBe('gino');
  });

  it('turns 份數 and 平均 defaults into the editor\'s draft', () => {
    const shares = splitDraftFromInput({ method: 'shares', entries: [{ memberId: 'gino', value: 2 }, { memberId: 'kai', value: 1 }] }, IDS);
    expect(shares.shares).toEqual({ gino: '2', abbie: '0', kai: '1' });
    expect(buildSplit(shares, IDS, 'TWD')).toEqual({ ok: true, split: { method: 'shares', entries: [{ memberId: 'gino', value: 2 }, { memberId: 'kai', value: 1 }] } });
    const equal = splitDraftFromInput({ method: 'equal', entries: [{ memberId: 'kai' }, { memberId: 'gino' }] }, IDS);
    expect(equal.included).toEqual(['gino', 'kai']);
  });
});

describe('「設為這個群組的預設分法」', () => {
  it('turns 平均, 比例 and 份數 that add up into a default', () => {
    const equal = { ...emptySplit(['gino', 'kai']) };
    expect(defaultFromDraft(equal, IDS, 'TWD')).toEqual({ ok: true, input: { method: 'equal', entries: [{ memberId: 'gino' }, { memberId: 'kai' }] } });
    const pct = { ...emptySplit(IDS), method: 'percent' as const, percent: { gino: '60', abbie: '40' } };
    expect(defaultFromDraft(pct, IDS, 'TWD')).toEqual({ ok: true, input: { method: 'percent', entries: [{ memberId: 'gino', value: 60 }, { memberId: 'abbie', value: 40 }] } });
  });

  it('refuses amounts, adjustments and items, and a split that does not add up', () => {
    for (const m of ['exact', 'adjust', 'items'] as const) {
      expect(defaultFromDraft(withMethod(emptySplit(IDS), m, IDS), IDS, 'TWD')).toEqual({ ok: false, reason: 'method' });
    }
    const short = { ...emptySplit(IDS), method: 'percent' as const, percent: { gino: '60', abbie: '30' } };
    expect(defaultFromDraft(short, IDS, 'TWD')).toEqual({ ok: false, reason: 'invalid', code: 'percent_mismatch', diff: 10 });
  });

  it('knows when the draft already is the group\'s default (the payer does not count)', () => {
    const pct = { ...emptySplit(IDS), method: 'percent' as const, percent: { abbie: '40', gino: '60' } };
    expect(isDefaultDraft(pct, rent, IDS, 'TWD')).toBe(true);
    expect(isDefaultDraft({ ...pct, percent: { gino: '50', abbie: '50' } }, rent, IDS, 'TWD')).toBe(false);
    expect(isDefaultDraft(emptySplit(IDS), rent, IDS, 'TWD')).toBe(false);
    expect(isDefaultDraft(pct, null, IDS, 'TWD')).toBe(false);
  });
});

describe('the words', () => {
  it('says the default, who pays, and why it is not used, in both languages', () => {
    expect(defaultSplitSummary(rent, nameOf)).toBe('比例：你 60%、Abbie 40%');
    expect(defaultSplitSummary({ method: 'shares', entries: [{ memberId: 'gino', value: 2 }, { memberId: 'kai', value: 1 }] }, nameOf)).toBe('份數：你 2、佳穎 1');
    expect(defaultSplitSummary({ method: 'equal', entries: [{ memberId: 'gino' }, { memberId: 'kai' }] }, nameOf)).toBe('平均：你、佳穎');
    expect(defaultPayerText(null, nameOf)).toBe('新增的人付款');
    expect(defaultPayerText('abbie', nameOf)).toBe('Abbie 付款');
    expect(defaultPayerText('kai', nameOf)).toBe('佳穎付款');
    expect(defaultSplitNote({ newMembers: ['lily'], problem: null }, nameOf, 'editor')).toBe('新成員不在預設分法裡：Lily');
    expect(defaultSplitNote({ newMembers: [], problem: { code: 'percent_mismatch', diff: 40 } }, nameOf, 'editor')).toBe('預設分法的比例加起來不是 100%（有人離開了），這筆先平均分');
    expect(defaultSplitNote({ newMembers: [], problem: { code: 'no_participants' } }, nameOf, 'settings')).toBe('預設分法裡的人都不在群組了，新的費用會先平均分');
    expect(defaultSplitNote({ newMembers: [], problem: null }, nameOf, 'editor')).toBeNull();
    setLocale('en');
    zhNow = false;
    expect(defaultSplitSummary(rent, nameOf)).toBe('Percent: you 60%, Abbie 40%');
    expect(defaultPayerText(null, nameOf)).toBe('Whoever adds it pays');
    expect(defaultSplitNote({ newMembers: ['lily', 'kai'], problem: null }, nameOf, 'editor')).toBe('New members are not in the default split: Lily, 佳穎');
  });

  it('says in the feed who changed it, to what, or that it was cleared', () => {
    const ctx: ActivityContext = { meUserId: 'u-gino', names: { g1: { gino: 'Gino', abbie: 'Abbie' } }, myMember: { g1: 'gino' } };
    const row = (data: ActivityDTO['data']): ActivityDTO => ({
      id: 'a1', groupId: 'g1', groupName: '我們家', groupEmoji: '', groupType: 'home', userId: 'u-abbie', memberId: 'abbie', actorName: 'Abbie',
      type: 'group.update', expenseId: null, data, createdAt: '2026-10-25T10:00:00.000Z',
    });
    const set = row({ changes: [{ field: 'defaultSplit', from: '', to: 'Gino 60%, Abbie 40%' }], defaultSplit: { method: 'percent', entries: rent.entries, payerId: null } });
    expect(describeActivity(set, ctx).text).toBe('Abbie 把預設分法改成「比例：你 60%、Abbie 40%」');
    const cleared = row({ changes: [{ field: 'defaultSplit', from: 'Gino 60%, Abbie 40%', to: '' }], defaultSplit: null });
    expect(describeActivity(cleared, ctx).text).toBe('Abbie 清除了預設分法');
    // A row without the structured copy uses its plain text.
    const plain = row({ changes: [{ field: 'defaultSplit', from: '', to: 'Gino, Abbie' }] });
    expect(describeActivity(plain, ctx).text).toBe('Abbie 把預設分法改成「Gino, Abbie」');
    setLocale('en');
    expect(describeActivity(set, ctx).text).toBe('Abbie changed the default split to "Percent: you 60%, Abbie 40%"');
    expect(describeActivity(cleared, ctx).text).toBe('Abbie cleared the default split');
  });
});
