// A group's default split (src/shared/defaultSplit.ts, docs/SPEC.md section 4, Default split):
// what may be stored (平均 / 比例 / 份數 among active members, a valid split, a payer who is in the
// group), how a new expense starts from it (members who joined later are left out and named,
// members who left are dropped, a 比例 default that no longer adds up is not applied), and what a
// member leaving does to the stored value.

import { describe, expect, it } from 'vitest';
import {
  applyDefaultSplit, checkDefaultSplit, defaultSplitInput, defaultSplitText, dropMember, parseDefaultSplit, sameDefaultSplit,
  type DefaultSplit, type DefaultSplitMember,
} from '../../src/shared/defaultSplit';

const SET_AT = '2026-10-01T00:00:00.000Z';
const member = (id: string, o: Partial<DefaultSplitMember> = {}): DefaultSplitMember => ({ id, active: true, createdAt: '2026-09-01T00:00:00.000Z', ...o });
const rent: DefaultSplit = { method: 'percent', entries: [{ memberId: 'gino', value: 60 }, { memberId: 'abbie', value: 40 }], payerId: null, setAt: SET_AT };

describe('checkDefaultSplit', () => {
  const active = ['gino', 'abbie', 'kai'];

  it('takes 平均 over a chosen set, with no values', () => {
    const r = checkDefaultSplit({ method: 'equal', entries: [{ memberId: 'gino', value: 3 }, { memberId: 'kai' }] }, active);
    expect(r).toEqual({ ok: true, value: { method: 'equal', entries: [{ memberId: 'gino' }, { memberId: 'kai' }], payerId: null } });
  });

  it('takes 比例 that add up to 100 and drops the members at 0%', () => {
    const r = checkDefaultSplit({ method: 'percent', entries: [{ memberId: 'gino', value: 60 }, { memberId: 'abbie', value: 40 }, { memberId: 'kai', value: 0 }] }, active);
    expect(r).toEqual({ ok: true, value: { method: 'percent', entries: [{ memberId: 'gino', value: 60 }, { memberId: 'abbie', value: 40 }], payerId: null } });
    const short = checkDefaultSplit({ method: 'percent', entries: [{ memberId: 'gino', value: 60 }, { memberId: 'abbie', value: 30 }] }, active);
    expect(short).toEqual({ ok: false, code: 'percent_mismatch', diff: 10 });
  });

  it('takes 份數 with at least one share above 0', () => {
    expect(checkDefaultSplit({ method: 'shares', entries: [{ memberId: 'gino', value: 2 }, { memberId: 'abbie', value: 1 }] }, active).ok).toBe(true);
    expect(checkDefaultSplit({ method: 'shares', entries: [{ memberId: 'gino', value: 0 }] }, active)).toEqual({ ok: false, code: 'no_participants' });
    expect(checkDefaultSplit({ method: 'shares', entries: [{ memberId: 'gino', value: -1 }] }, active)).toEqual({ ok: false, code: 'invalid_value' });
  });

  it('refuses amounts, adjustments and items: they are per expense only', () => {
    for (const method of ['exact', 'adjust', 'items']) {
      expect(checkDefaultSplit({ method: method as 'equal', entries: [{ memberId: 'gino', value: 1 }] }, active)).toEqual({ ok: false, code: 'bad_method' });
    }
  });

  it('refuses members who are not active in the group, twice listed, or without a number', () => {
    expect(checkDefaultSplit({ method: 'equal', entries: [{ memberId: 'left' }] }, active)).toEqual({ ok: false, code: 'unknown_member', memberId: 'left' });
    expect(checkDefaultSplit({ method: 'equal', entries: [{ memberId: 'gino' }, { memberId: 'gino' }] }, active)).toEqual({ ok: false, code: 'duplicate_member', memberId: 'gino' });
    expect(checkDefaultSplit({ method: 'percent', entries: [{ memberId: 'gino' }] }, active)).toEqual({ ok: false, code: 'invalid_value', memberId: 'gino' });
    expect(checkDefaultSplit({ method: 'equal', entries: [] }, active)).toEqual({ ok: false, code: 'no_participants' });
  });

  it('takes a default payer who is in the group, or null for whoever adds it', () => {
    const ok = checkDefaultSplit({ method: 'equal', entries: [{ memberId: 'gino' }], payerId: 'abbie' }, active);
    expect(ok.ok && ok.value.payerId).toBe('abbie');
    expect(checkDefaultSplit({ method: 'equal', entries: [{ memberId: 'gino' }], payerId: 'left' }, active)).toEqual({ ok: false, code: 'unknown_payer', memberId: 'left' });
  });
});

describe('applyDefaultSplit', () => {
  const members = [member('gino'), member('abbie'), member('kai')];

  it('is null for a group without one', () => {
    expect(applyDefaultSplit(null, members)).toBeNull();
    expect(applyDefaultSplit(undefined, members)).toBeNull();
  });

  it('starts a new expense from it, with the default payer', () => {
    const a = applyDefaultSplit({ ...rent, payerId: 'abbie' }, members);
    expect(a).toEqual({
      split: { method: 'percent', entries: [{ memberId: 'gino', value: 60 }, { memberId: 'abbie', value: 40 }] },
      payerId: 'abbie',
      newMembers: [],
      problem: null,
    });
  });

  it('leaves out a member who joined later, and names them', () => {
    const later = [...members, member('lily', { createdAt: '2026-10-05T00:00:00.000Z' })];
    const a = applyDefaultSplit(rent, later)!;
    expect(a.split?.entries.map(e => e.memberId)).toEqual(['gino', 'abbie']);
    expect(a.newMembers).toEqual(['lily']);
    // Kai was there when it was set and left out on purpose: not "new".
    expect(a.newMembers).not.toContain('kai');
  });

  it('drops a member who left; a 比例 default that no longer adds up is not applied', () => {
    const gone = [member('gino'), member('abbie', { active: false }), member('kai')];
    expect(applyDefaultSplit(rent, gone)).toEqual({ split: null, payerId: null, newMembers: [], problem: { code: 'percent_mismatch', diff: 40 } });
    const equal: DefaultSplit = { method: 'equal', entries: [{ memberId: 'gino' }, { memberId: 'abbie' }], payerId: 'abbie', setAt: SET_AT };
    expect(applyDefaultSplit(equal, gone)).toEqual({ split: { method: 'equal', entries: [{ memberId: 'gino' }] }, payerId: null, newMembers: [], problem: null });
  });

  it('says so when nobody in it is still in the group', () => {
    const a = applyDefaultSplit({ method: 'shares', entries: [{ memberId: 'gone', value: 1 }], payerId: null, setAt: SET_AT }, members);
    expect(a).toEqual({ split: null, payerId: null, newMembers: [], problem: { code: 'no_participants' } });
  });

  it('works the same in a 1:1 ledger', () => {
    const pair = [member('gino'), member('abbie')];
    const a = applyDefaultSplit({ method: 'shares', entries: [{ memberId: 'gino', value: 3 }, { memberId: 'abbie', value: 1 }], payerId: 'gino', setAt: SET_AT }, pair);
    expect(a?.split).toEqual({ method: 'shares', entries: [{ memberId: 'gino', value: 3 }, { memberId: 'abbie', value: 1 }] });
    expect(a?.payerId).toBe('gino');
  });
});

describe('dropMember, sameDefaultSplit, parseDefaultSplit, defaultSplitText', () => {
  it('drops a member who leaves, and clears them as the payer; nobody left is null', () => {
    expect(dropMember(rent, 'kai')).toBe(rent);
    expect(dropMember(rent, 'abbie')).toEqual({ ...rent, entries: [{ memberId: 'gino', value: 60 }] });
    expect(dropMember({ ...rent, payerId: 'kai' }, 'kai')).toEqual({ ...rent, payerId: null });
    const one: DefaultSplit = { method: 'equal', entries: [{ memberId: 'gino' }], payerId: null, setAt: SET_AT };
    expect(dropMember(one, 'gino')).toBeNull();
  });

  it('compares method, members, values and payer, not when it was set', () => {
    const later: DefaultSplit = { ...rent, setAt: '2027-01-01T00:00:00.000Z' };
    expect(sameDefaultSplit(rent, later)).toBe(true);
    expect(sameDefaultSplit(rent, { ...rent, payerId: 'gino' })).toBe(false);
    expect(sameDefaultSplit(rent, { ...rent, entries: [{ memberId: 'gino', value: 50 }, { memberId: 'abbie', value: 50 }] })).toBe(false);
    expect(sameDefaultSplit(null, null)).toBe(true);
    expect(sameDefaultSplit(rent, null)).toBe(false);
  });

  it('reads the stored JSON back, and anything else as none', () => {
    expect(parseDefaultSplit(JSON.stringify(rent))).toEqual(rent);
    expect(parseDefaultSplit(null)).toBeNull();
    expect(parseDefaultSplit('not json')).toBeNull();
    expect(parseDefaultSplit(JSON.stringify({ method: 'exact', entries: [], setAt: SET_AT }))).toBeNull();
    expect(parseDefaultSplit(JSON.stringify({ method: 'equal', entries: [{ memberId: 'gino', value: 1 }], payerId: 3, setAt: SET_AT }))).toEqual({
      method: 'equal', entries: [{ memberId: 'gino' }], payerId: null, setAt: SET_AT,
    });
  });

  it('writes the plain text the activity line keeps', () => {
    const names: Record<string, string> = { gino: 'Gino', abbie: 'Abbie' };
    const n = (id: string) => names[id];
    expect(defaultSplitText(rent, n)).toBe('Gino 60%, Abbie 40%');
    expect(defaultSplitText({ method: 'shares', entries: [{ memberId: 'gino', value: 2 }, { memberId: 'abbie', value: 1 }] }, n)).toBe('Gino x2, Abbie x1');
    expect(defaultSplitText({ method: 'equal', entries: [{ memberId: 'gino' }, { memberId: 'abbie' }] }, n)).toBe('Gino, Abbie');
    expect(defaultSplitText(null, n)).toBe('');
    expect(defaultSplitInput(rent)).toEqual({ method: 'percent', entries: rent.entries });
  });
});
