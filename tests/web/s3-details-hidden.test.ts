// The line where a member's payment details would be while the server holds them back (Gino's
// decision of 2026-11-21; reviews B2-03 and B4b-02; MemberDTO.detailsHidden and
// FriendDTO.detailsHidden): someone else linked the account by email and its person has not opened
// the group yet. 結算's payment cards and 記錄還款's card say hiddenDetailsNote, a friend's page says
// hiddenFriendNote, with the spaces Chinese needs around a Latin name (zhJoin). Everyone else gets
// null, and the details themselves come empty. The iPhone app's S3DetailsHiddenTests checks the
// same words (SettlePay.hiddenNote, FriendsText.hiddenNote).

import { afterEach, describe, expect, it } from 'vitest';
import type { FriendDTO, MemberDTO } from '../../src/shared/types';
import { hiddenDetailsNote, hiddenFriendNote, payDetailsText, payLines } from '../../src/web/features/groups/groupMath';
import { getLocale, setLocale } from '../../src/web/lib/i18n';

const startLocale = getLocale();
afterEach(() => setLocale(startLocale));

const STAMP = '2026-11-21T00:00:00.000Z';

function member(name: string, over: Partial<MemberDTO> = {}): MemberDTO {
  return {
    id: 'm-' + name, groupId: 'g1', userId: 'u-' + name, name, color: '#2F6FB5', role: 'member', active: true, sort: 1,
    createdAt: STAMP, claimedAt: STAMP, payInfo: '', venmo: '', paypal: '', avatar: null, ...over,
  };
}

/** A member as the server sends one it holds back: its details empty, and the flag. */
const held = (name: string): MemberDTO => member(name, { detailsHidden: true });

function friend(name: string, over: Partial<FriendDTO> = {}): FriendDTO {
  return {
    key: 'u:u-' + name, userId: 'u-' + name, name, color: '#2F6FB5', balances: [], groups: [], pairGroupId: null,
    payInfo: '', venmo: '', paypal: '', avatar: null, ...over,
  };
}

describe('hiddenDetailsNote', () => {
  it('says whose details show once they open the group, with a space only beside a Latin name', () => {
    setLocale('zh-TW');
    expect(hiddenDetailsNote(held('Abbie'))).toBe('Abbie 打開這個群組以後，這裡才會顯示收款方式。');
    expect(hiddenDetailsNote(held('佳穎'))).toBe('佳穎打開這個群組以後，這裡才會顯示收款方式。');
    setLocale('en');
    expect(hiddenDetailsNote(held('Abbie'))).toBe("Abbie's payment details show here once Abbie opens this group.");
    expect(hiddenDetailsNote(held('佳穎'))).toBe("佳穎's payment details show here once 佳穎 opens this group.");
  });

  it('is null for a member the server does not hold back, a placeholder and no member', () => {
    setLocale('zh-TW');
    expect(hiddenDetailsNote(member('Abbie', { venmo: 'abbie' }))).toBeNull();
    // A member who opened the group and added no details: the page's own 「還沒有設定收款方式」 stays.
    expect(hiddenDetailsNote(member('Abbie'))).toBeNull();
    expect(hiddenDetailsNote(member('Kai', { userId: null, claimedAt: null }))).toBeNull();
    expect(hiddenDetailsNote(undefined)).toBeNull();
    expect(hiddenDetailsNote(null)).toBeNull();
  });

  it('comes with no payment line and no text to share for that member', () => {
    expect(payLines(held('Abbie'))).toEqual([]);
    expect(payDetailsText(held('Abbie'))).toBe('');
  });
});

describe('hiddenFriendNote', () => {
  it('says the same on a friend\'s page, for any group the two share', () => {
    setLocale('zh-TW');
    expect(hiddenFriendNote(friend('Abbie', { detailsHidden: true }))).toBe('Abbie 打開你們共同的群組以後，這裡才會顯示收款方式。');
    expect(hiddenFriendNote(friend('佳穎', { detailsHidden: true }))).toBe('佳穎打開你們共同的群組以後，這裡才會顯示收款方式。');
    setLocale('en');
    expect(hiddenFriendNote(friend('Abbie', { detailsHidden: true }))).toBe("Abbie's payment details show here once Abbie opens a group you share.");
  });

  it('is null for a friend the server does not hold back', () => {
    expect(hiddenFriendNote(friend('Abbie', { paypal: 'abbie' }))).toBeNull();
    expect(hiddenFriendNote(friend('Abbie'))).toBeNull();
    expect(hiddenFriendNote(undefined)).toBeNull();
  });
});
