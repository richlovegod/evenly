// Friend invite links in the app: reading the code out of a pasted link of either form
// (src/shared/invites.ts inviteCodeInLink) and where the 群組 paste box sends it
// (features/invite/inviteFlow.ts pastedInvitePath), the two routes, the mark that lets a sign-in
// started on the invite page accept it on the way back (markAccept, takeAccept), the remembered
// message, the inviter's photo address, the message as it is shared, and the feed's friend.join
// sentence from both sides. The Worker's side is tests/worker/friend-invites.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class MemoryStorage {
    readonly map = new Map<string, string>();
    getItem(k: string): string | null {
      return this.map.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.map.set(k, String(v));
    }
    removeItem(k: string): void {
      this.map.delete(k);
    }
    clear(): void {
      this.map.clear();
    }
  }
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  // config.ts reads both as it loads: the API on this page's own origin.
  local.setItem('evenly.api', 'same-origin');
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = local;
  g.sessionStorage = session;
  g.location = { origin: 'https://split.test', href: 'https://split.test/', pathname: '/', search: '', hash: '' };
  return { local, session };
});

import { inviteCodeInLink, inviteTemplates, inviteUrl } from '../../src/shared/invites';
import type { ActivityDTO } from '../../src/shared/types';
import { describeActivity, type ActivityContext } from '../../src/web/features/activity/activityText';
import {
  ACCEPT_MS, inviteAvatarUrl, inviteCodeFrom, lastTemplate, markAccept, pastedInvitePath, rememberTemplate, takeAccept,
} from '../../src/web/features/invite/inviteFlow';
import { setLocale } from '../../src/web/lib/i18n';
import { parseHash } from '../../src/web/lib/router';
import { shareMessage } from '../../src/web/lib/share';

const CODE = 'AbCdEfGh12345678';

beforeEach(() => {
  h.session.clear();
  h.local.map.delete('evenly.inviteTemplate');
});

afterEach(() => setLocale('zh-TW'));

describe('a pasted friend invite link', () => {
  it('gives its code in either form, with the query, the message around it, or a trailing slash', () => {
    for (const text of [
      `https://split.ginochang.com/i/${CODE}?openExternalBrowser=1`,
      `https://split.ginochang.com/i/${CODE}`,
      `https://split.ginochang.com/i/${CODE}/`,
      `https://split.ginochang.com/?openExternalBrowser=1#/i/${CODE}`,
      `https://split.ginochang.com/#/i/${CODE}`,
      `split.ginochang.com/i/${CODE}`,
      `  ${inviteTemplates('zh-TW')[0].text}\nhttps://evenly-api-staging.richlovegod.workers.dev/i/${CODE}?openExternalBrowser=1  `,
      inviteUrl('https://split.ginochang.com/', CODE),
    ]) {
      expect(inviteCodeInLink(text), text).toBe(CODE);
    }
  });

  it('is not a bare code, a group link, a short code, or another site\'s /hi/ path', () => {
    for (const text of [CODE, `https://split.ginochang.com/#/join/${CODE}`, 'https://split.ginochang.com/i/short', 'https://example.com/hi/AbCdEfGh12345678', 'https://split.ginochang.com/i/', '']) {
      expect(inviteCodeInLink(text), text).toBeNull();
    }
  });

  it('opens the friend invite from the 群組 paste box; a group link or a bare code still opens the group invite', () => {
    expect(pastedInvitePath(`https://split.ginochang.com/i/${CODE}?openExternalBrowser=1`)).toBe('/i/' + CODE);
    expect(pastedInvitePath(`https://split.ginochang.com/?openExternalBrowser=1#/i/${CODE}`)).toBe('/i/' + CODE);
    expect(pastedInvitePath('https://split.ginochang.com/?openExternalBrowser=1#/join/Grp123456')).toBe('/join/Grp123456');
    expect(pastedInvitePath('Grp123456')).toBe('/join/Grp123456');
    expect(pastedInvitePath('not a link at all')).toBeNull();
    expect(inviteCodeFrom(' https://x/#/join/Grp123456 ')).toBe('Grp123456');
  });

  it('builds the share link the server sends, on the app\'s URL', () => {
    expect(inviteUrl('https://split.ginochang.com/', CODE)).toBe(`https://split.ginochang.com/i/${CODE}?openExternalBrowser=1`);
    expect(inviteUrl('https://evenly-api-staging.richlovegod.workers.dev', CODE)).toBe(`https://evenly-api-staging.richlovegod.workers.dev/i/${CODE}?openExternalBrowser=1`);
  });
});

describe('the routes', () => {
  it('#/i/<code> is the invite page and #/invite-friends is 邀請朋友', () => {
    expect(parseHash('#/i/' + CODE)).toMatchObject({ name: 'invite', params: { code: CODE } });
    expect(parseHash('#/invite-friends')).toMatchObject({ name: 'inviteFriends', params: {} });
    expect(parseHash('#/i/' + CODE + '/x').name).toBe('notFound');
  });
});

describe('a sign-in started on the invite page accepts it on the way back', () => {
  it('once, for that code, within 30 minutes', () => {
    const t0 = 1_800_000_000_000;
    markAccept(CODE, t0);
    expect(takeAccept(CODE, t0 + 60_000)).toBe(true);
    expect(takeAccept(CODE, t0 + 60_000)).toBe(false);

    markAccept(CODE, t0);
    expect(takeAccept('SomeOtherCode123', t0 + 1)).toBe(false);
    // The mark went with that look too.
    expect(takeAccept(CODE, t0 + 1)).toBe(false);

    markAccept(CODE, t0);
    expect(takeAccept(CODE, t0 + ACCEPT_MS)).toBe(false);
    h.session.setItem('evenly.inviteAccept', 'not json');
    expect(takeAccept(CODE)).toBe(false);
  });
});

describe('the message picked last', () => {
  it('is remembered on the device, and anything else reads as none', () => {
    expect(lastTemplate()).toBeNull();
    rememberTemplate('trip');
    expect(lastTemplate()).toBe('trip');
    h.local.setItem('evenly.inviteTemplate', 'party');
    expect(lastTemplate()).toBeNull();
  });

  it('goes out as the text, then the link on its own line', () => {
    const t = inviteTemplates('en')[1];
    const url = inviteUrl('https://split.ginochang.com/', CODE);
    expect(shareMessage({ text: t.text, url })).toBe(t.text + '\n' + url);
    expect(shareMessage({ text: '', url })).toBe(url);
  });
});

describe('the inviter\'s photo', () => {
  it('is at the invite\'s own address, on the API base', () => {
    expect(inviteAvatarUrl(CODE, '0123456789abcdef')).toBe(`/api/invite/${CODE}/avatar?v=0123456789abcdef`);
  });
});

describe('friend.join in the activity feed', () => {
  const dto = (over: Partial<ActivityDTO>): ActivityDTO => ({
    id: 'a1', groupId: 'g1', groupName: 'Gino & Abbie', groupEmoji: '', groupType: 'pair', userId: 'uA', memberId: 'mA', actorName: 'Abbie',
    type: 'friend.join', expenseId: null, data: { groupName: 'Gino & Abbie', memberId: 'mG', memberName: 'Gino' }, createdAt: '2026-10-25T10:00:00.000Z', ...over,
  });
  const names = { g1: { mG: 'Gino', mA: 'Abbie' } };

  it('tells the link\'s owner who joined through their link', () => {
    const owner: ActivityContext = { meUserId: 'uG', names, myMember: { g1: 'mG' } };
    expect(describeActivity(dto({}), owner).text).toBe('Abbie 透過你的邀請連結加入');
    setLocale('en');
    expect(describeActivity(dto({}), owner).text).toBe('Abbie joined through your invite link');
  });

  it('tells the one who joined whose link it was', () => {
    const joiner: ActivityContext = { meUserId: 'uA', names, myMember: { g1: 'mA' } };
    expect(describeActivity(dto({}), joiner).text).toBe('你透過 Gino 的邀請連結加入');
    expect(describeActivity(dto({ data: { memberId: 'mK', memberName: '佳穎' } }), { meUserId: 'uA', names: { g1: { mA: 'Abbie' } }, myMember: { g1: 'mA' } }).text).toBe('你透過佳穎的邀請連結加入');
    setLocale('en');
    expect(describeActivity(dto({}), joiner).text).toBe("You joined through Gino's invite link");
  });
});
