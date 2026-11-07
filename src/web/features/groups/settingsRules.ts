// What group settings offer, by the same rules as the iPhone app (GroupSettingsView.swift and
// GroupsMemberPage.swift): the blocks in a member's sheet, what 離開群組 says once I am settled up,
// and where leaving or deleting goes.
//
// A 1:1 friend ledger (type 'pair', made from 朋友) holds just the two people: the Worker refuses a
// third (409 limit_reached), and the ledger lives under 朋友, not on the 群組 list. So its settings
// have no 類型, invite link or add-by-name, and a member's sheet there has no 管理員 (both people
// are admins) and no 從群組移除, which would leave a ledger of one that neither list shows.

import type { GroupDTO, GroupSnapshotDTO, MemberDTO } from '../../../shared/types';
import { zhJoin } from '../../lib/describe';
import { t } from '../../lib/i18n';

export function isPairLedger(group: Pick<GroupDTO, 'type'>): boolean {
  return group.type === 'pair';
}

/** Where to go once I left or deleted it: a 1:1 ledger is listed under 朋友. */
export function listPathOf(group: Pick<GroupDTO, 'type'>): '/friends' | '/groups' {
  return isPairLedger(group) ? '/friends' : '/groups';
}

/** The blocks under a member's name and color in their sheet. */
export interface MemberBlocks {
  /** 專屬連結: someone added by name, still in the group. */
  personalLink: boolean;
  /** 換手機或登不進來 (幫他重新登入, 只解除帳號連結): admins, for someone else with an account. */
  relink: boolean;
  /** 管理員: admins, for anyone in the group with an account; none in a 1:1 ledger. */
  admin: boolean;
  /** 從群組移除: admins, for someone else in the group; none in a 1:1 ledger. */
  remove: boolean;
}

export function memberBlocks(snap: Pick<GroupSnapshotDTO, 'group' | 'me'>, m: Pick<MemberDTO, 'id' | 'userId' | 'active'>): MemberBlocks {
  const pair = isPairLedger(snap.group);
  const isMe = m.id === snap.me.memberId;
  const iAmAdmin = snap.me.role === 'admin';
  return {
    personalLink: !m.userId && m.active,
    relink: !!m.userId && !isMe && iAmAdmin,
    admin: !pair && iAmAdmin && !!m.userId && m.active,
    remove: !pair && iAmAdmin && !isMe && m.active,
  };
}

/**
 * What 離開群組 asks once I am settled up (call it from an event: it uses the language now). A
 * group: it leaves my list, and someone can send the invite link again. A 1:1 ledger has no invite
 * link: with a friend who has an account it just leaves my view; with one added by name (or gone),
 * nobody can open it again after I leave, so that is said, and admins are pointed to 刪除群組.
 */
export function leaveMessage(snap: Pick<GroupSnapshotDTO, 'group' | 'members' | 'me'>): string {
  if (!isPairLedger(snap.group)) {
    return t(
      '你的帳已經結清。離開後，這個群組會從你的列表消失，舊的費用還是會顯示你的名字。想回來的話，請別人再傳邀請連結給你。',
      'You are settled up. The group disappears from your list, and old expenses still show your name. To come back, ask someone for the invite link.',
    );
  }
  const meId = snap.me.memberId;
  const other = snap.members.find(m => m.active && m.id !== meId);
  if (other?.userId) {
    return t(
      '你的帳已經結清。離開後，你就看不到這本兩人帳本了，舊的費用還是會顯示你的名字。',
      'You are settled up. You will no longer see this friend ledger, and old expenses still show your name.',
    );
  }
  const admin = snap.me.role === 'admin';
  const zh =
    '你的帳已經結清。' +
    (other ? zhJoin(other.name, '還沒有用自己的帳號加入，') : '') +
    '你離開後，就沒有人能再打開這本兩人帳本了。' +
    (admin ? '不需要它的話，可以改用「刪除群組」。' : '');
  const en =
    'You are settled up. ' +
    (other ? other.name + ' has not joined with an account, so once you leave' : 'Once you leave') +
    ', nobody can open this friend ledger again.' +
    (admin ? ' If you no longer need it, use Delete group instead.' : '');
  return t(zh, en);
}
