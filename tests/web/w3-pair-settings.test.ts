// A 1:1 friend ledger's 設定 (review-1106, unit W3; features/groups/settingsRules.ts, SettingsTab.tsx,
// MembersEditor.tsx), as on the iPhone app (GroupSettingsView.swift, GroupsMemberPage.swift): no
// 類型, invite link, add-by-name or 封存, and in a member's sheet no 管理員 or 從群組移除 (rename,
// color, 專屬連結 and 幫他重新登入 stay); leaving one has its own words and goes back to 朋友. A
// group keeps all of it. The tab is rendered with react-dom/server, so no DOM is needed (sheets
// render nothing without one).

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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

import type { GroupSnapshotDTO, GroupType, MemberDTO } from '../../src/shared/types';
import { MembersEditor } from '../../src/web/features/groups/MembersEditor';
import { SettingsTab } from '../../src/web/features/groups/SettingsTab';
import { isPairLedger, leaveMessage, listPathOf, memberBlocks } from '../../src/web/features/groups/settingsRules';
import { getLocale, setLocale } from '../../src/web/lib/i18n';
import type { GroupView } from '../../src/web/lib/store';

const startLocale = getLocale();
afterEach(() => setLocale(startLocale));

function member(id: string, name: string, over: Partial<MemberDTO> = {}): MemberDTO {
  return {
    id,
    groupId: 'g1',
    userId: null,
    name,
    color: '#2F6FB5',
    role: 'member',
    active: true,
    sort: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    claimedAt: null,
    payInfo: '',
    venmo: '',
    paypal: '',
    avatar: null,
    ...over,
  };
}

const GINO = member('m-gino', 'Gino', { userId: 'u-gino', role: 'admin' });

function snapOf(type: GroupType, others: MemberDTO[], role: 'admin' | 'member' = 'admin'): GroupSnapshotDTO {
  return {
    group: {
      id: 'g1', name: type === 'pair' ? 'Gino & 佳穎' : '北海道', type, currency: 'TWD', emoji: '', color: '#2F6FB5', simplify: true, notes: '',
      createdBy: 'u-gino', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', version: 1, defaultSplit: null,
    },
    members: [{ ...GINO, role }, ...others],
    expenses: [],
    me: { memberId: GINO.id, role },
    inviteCode: 'INVITE1234',
  };
}

function viewOf(snap: GroupSnapshotDTO): GroupView {
  return { snap, pending: {}, pendingComments: {}, pendingPhotos: {}, pendingReceipts: {}, loading: false, error: null };
}

/** A friend with an account, and one added by name who has not joined. */
const JIAYING = member('m-jy', '佳穎', { userId: 'u-jy', role: 'admin' });
const PLACEHOLDER = member('m-jy', '佳穎', { role: 'admin' });

describe('the member sheet', () => {
  it('in a 1:1 ledger has no 管理員 and no 從群組移除, but keeps 幫他重新登入 and 專屬連結', () => {
    const withAccount = snapOf('pair', [JIAYING]);
    expect(memberBlocks(withAccount, JIAYING)).toEqual({ personalLink: false, relink: true, admin: false, remove: false });
    expect(memberBlocks(withAccount, GINO)).toEqual({ personalLink: false, relink: false, admin: false, remove: false });
    const byName = snapOf('pair', [PLACEHOLDER]);
    expect(memberBlocks(byName, PLACEHOLDER)).toEqual({ personalLink: true, relink: false, admin: false, remove: false });
  });

  it('in a group shows them to admins as before', () => {
    const abbie = member('m-abbie', 'Abbie', { userId: 'u-abbie' });
    const leo = member('m-leo', 'Leo');
    const snap = snapOf('trip', [abbie, leo]);
    expect(memberBlocks(snap, abbie)).toEqual({ personalLink: false, relink: true, admin: true, remove: true });
    expect(memberBlocks(snap, leo)).toEqual({ personalLink: true, relink: false, admin: false, remove: true });
    // I can stop being an admin, never remove myself (that is 離開群組).
    expect(memberBlocks(snap, GINO)).toEqual({ personalLink: false, relink: false, admin: true, remove: false });
    // Not an admin: only someone's 專屬連結.
    const asMember = snapOf('trip', [abbie, leo], 'member');
    expect(memberBlocks(asMember, abbie)).toEqual({ personalLink: false, relink: false, admin: false, remove: false });
    expect(memberBlocks(asMember, leo)).toEqual({ personalLink: true, relink: false, admin: false, remove: false });
  });
});

describe('leaving', () => {
  it('a group says it leaves my list and the invite link brings me back', () => {
    setLocale('zh-TW');
    const snap = snapOf('trip', [member('m-abbie', 'Abbie', { userId: 'u-abbie' })]);
    expect(leaveMessage(snap)).toBe('你的帳已經結清。離開後，這個群組會從你的列表消失，舊的費用還是會顯示你的名字。想回來的話，請別人再傳邀請連結給你。');
    setLocale('en');
    expect(leaveMessage(snap)).toBe(
      'You are settled up. The group disappears from your list, and old expenses still show your name. To come back, ask someone for the invite link.',
    );
  });

  it('a 1:1 ledger with a friend who has an account names no invite link', () => {
    setLocale('zh-TW');
    const snap = snapOf('pair', [JIAYING]);
    expect(leaveMessage(snap)).toBe('你的帳已經結清。離開後，你就看不到這本兩人帳本了，舊的費用還是會顯示你的名字。');
    setLocale('en');
    expect(leaveMessage(snap)).toBe('You are settled up. You will no longer see this friend ledger, and old expenses still show your name.');
  });

  it('a 1:1 ledger with a friend added by name says nobody can open it again, and offers 刪除群組 to admins', () => {
    setLocale('zh-TW');
    expect(leaveMessage(snapOf('pair', [PLACEHOLDER]))).toBe(
      '你的帳已經結清。佳穎還沒有用自己的帳號加入，你離開後，就沒有人能再打開這本兩人帳本了。不需要它的話，可以改用「刪除群組」。',
    );
    const abbie = member('m-abbie', 'Abbie', { role: 'admin' });
    expect(leaveMessage(snapOf('pair', [abbie]))).toBe(
      '你的帳已經結清。Abbie 還沒有用自己的帳號加入，你離開後，就沒有人能再打開這本兩人帳本了。不需要它的話，可以改用「刪除群組」。',
    );
    expect(leaveMessage(snapOf('pair', [abbie], 'member'))).toBe('你的帳已經結清。Abbie 還沒有用自己的帳號加入，你離開後，就沒有人能再打開這本兩人帳本了。');
    setLocale('en');
    expect(leaveMessage(snapOf('pair', [abbie]))).toBe(
      'You are settled up. Abbie has not joined with an account, so once you leave, nobody can open this friend ledger again. If you no longer need it, use Delete group instead.',
    );
  });

  it('a 1:1 ledger the friend already left says nobody can open it again', () => {
    setLocale('zh-TW');
    const gone = member('m-jy', '佳穎', { userId: 'u-jy', role: 'admin', active: false });
    expect(leaveMessage(snapOf('pair', [gone]))).toBe('你的帳已經結清。你離開後，就沒有人能再打開這本兩人帳本了。不需要它的話，可以改用「刪除群組」。');
    setLocale('en');
    expect(leaveMessage(snapOf('pair', [gone]))).toBe(
      'You are settled up. Once you leave, nobody can open this friend ledger again. If you no longer need it, use Delete group instead.',
    );
  });

  it('goes back to 朋友 from a 1:1 ledger and to 群組 from a group', () => {
    expect(listPathOf({ type: 'pair' })).toBe('/friends');
    expect(isPairLedger({ type: 'pair' })).toBe(true);
    for (const type of ['trip', 'home', 'couple', 'other'] as const) {
      expect(listPathOf({ type })).toBe('/groups');
      expect(isPairLedger({ type })).toBe(false);
    }
  });
});

describe('the 設定 tab', () => {
  const render = (snap: GroupSnapshotDTO) => renderToStaticMarkup(createElement(SettingsTab, { gid: 'g1', view: viewOf(snap) }));

  it('of a 1:1 ledger has no type, invite link, add-by-name or archive', () => {
    setLocale('zh-TW');
    for (const friend of [JIAYING, PLACEHOLDER]) {
      const html = render(snapOf('pair', [friend]));
      expect(html).toContain('data-testid="settings-name"');
      expect(html).toContain('data-testid="member-row"');
      expect(html).toContain('data-testid="settings-leave"');
      expect(html).not.toContain('settings-type-');
      expect(html).not.toContain('邀請連結</');
      expect(html).not.toContain('data-testid="settings-invite-link"');
      expect(html).not.toContain('data-testid="settings-member-add-input"');
      expect(html).not.toContain('用名字加入的人馬上就能一起分帳');
      expect(html).not.toContain('data-testid="settings-archive"');
    }
  });

  it('of a group keeps all of them', () => {
    setLocale('zh-TW');
    const html = render(snapOf('trip', [member('m-abbie', 'Abbie', { userId: 'u-abbie' }), member('m-leo', 'Leo')]));
    expect(html).toContain('data-testid="settings-type-trip"');
    expect(html).toContain('data-testid="settings-invite-link"');
    expect(html).toContain('data-testid="settings-member-add-input"');
    expect(html).toContain('用名字加入的人馬上就能一起分帳');
    expect(html).toContain('data-testid="settings-archive"');
  });

  it('members of a 1:1 ledger have no add row, also when the editor is used on its own', () => {
    const html = renderToStaticMarkup(createElement(MembersEditor, { gid: 'g1', view: viewOf(snapOf('pair', [PLACEHOLDER])) }));
    expect(html).toContain('data-id="m-jy"');
    expect(html).not.toContain('data-testid="settings-member-add"');
  });
});
