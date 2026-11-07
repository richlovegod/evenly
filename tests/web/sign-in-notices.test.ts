// What the app says when the Worker flags a sign-in or a link (src/web/features/auth/signInNotices.ts):
// reading `link_pending` and `notice` from the address and what stays of the query, the question
// 我的 asks before a pending link links (by the email, or 「隱藏的 Email」 for a relay address or
// none), the toasts after 連結 (an empty account moved or not), a link that is gone, and the
// claimed notice, in both languages; and a notice asked again on the page a sign-in moves on to,
// so only a no given on the page that asked opens 我的. The Worker's side is
// tests/worker/apple-sign-in.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('../../src/web/features/auth/signInNotices');
type I18n = typeof import('../../src/web/lib/i18n');

let n: Mod;
let i18n: I18n;

beforeEach(async () => {
  vi.resetModules();
  i18n = await import('../../src/web/lib/i18n');
  n = await import('../../src/web/features/auth/signInNotices');
});

/** The en dash and the em dash (U+2013, U+2014), which no text of the app may use. */
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
const HAN = /\p{Script=Han}/u;
const ID = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

describe('coming back', () => {
  it('reads a pending link and the claimed notice, and keeps the rest of the query', () => {
    expect(ID).toHaveLength(43);
    expect(n.readNoticeReturn('?link_pending=' + ID)).toEqual({ pending: ID, claimed: false, search: '' });
    expect(n.readNoticeReturn('?install=ABC&link_pending=' + ID)).toEqual({ pending: ID, claimed: false, search: '?install=ABC' });
    expect(n.readNoticeReturn('?notice=claimed')).toEqual({ pending: null, claimed: true, search: '' });
    // Only the Worker's kind of id; a flag that is not one is still taken out of the address.
    for (const bad of ['short', ID + 'x', 'x'.repeat(42) + '%2F', '']) expect(n.readNoticeReturn('?link_pending=' + bad), bad).toEqual({ pending: null, claimed: false, search: '' });
    expect(n.readNoticeReturn('?notice=other')).toEqual({ pending: null, claimed: false, search: '' });
    expect(n.readNoticeReturn('?google=linked')).toEqual({ pending: null, claimed: false, search: '?google=linked' });
    expect(n.readNoticeReturn('')).toEqual({ pending: null, claimed: false, search: '' });
  });
});

describe('the words', () => {
  it('asks before it links: the provider account by its email, a Hide My Email address as it is, and to tap 取消 when it was not the person', () => {
    i18n.setLocale('zh-TW');
    expect(n.pendingLinkQuestion({ provider: 'google', email: 'm.lin@gmail.com' })).toEqual({
      title: '把 Google 帳戶 m.lin@gmail.com 連結到這個帳號？',
      message: '連結後，也能用 Google 登入這個帳號。如果你剛才沒有在 Google 的頁面完成登入，請按「取消」。',
      ok: '連結',
      cancel: '取消',
    });
    expect(n.pendingLinkQuestion({ provider: 'google', email: null }).title).toBe('把這個 Google 帳戶連結到這個帳號？');
    expect(n.pendingLinkQuestion({ provider: 'apple', email: 'gino@icloud.com' }).title).toBe('把 Apple 帳號 gino@icloud.com 連結到這個帳號？');
    // A relay address is that Apple ID's own for this service: shown, so someone else's is told apart.
    expect(n.pendingLinkQuestion({ provider: 'apple', email: 'x7k2m9q4p1@privaterelay.appleid.com' }).title).toBe('把 Apple 帳號 x7k2m9q4p1@privaterelay.appleid.com 連結到這個帳號？');
    expect(n.pendingLinkQuestion({ provider: 'apple', email: null }).title).toBe('把這個 Apple 帳號連結到這個帳號？');
    expect(n.pendingLinkQuestion({ provider: 'apple', email: null }).message).toBe('連結後，也能用 Apple 登入這個帳號。如果你剛才沒有在 Apple 的頁面完成登入，請按「取消」。');
    for (const email of ['x7k2m9q4p1@privaterelay.appleid.com', null]) expect(n.pendingLinkQuestion({ provider: 'apple', email }).title).not.toContain('隱藏的 Email');
    i18n.setLocale('en');
    expect(n.pendingLinkQuestion({ provider: 'google', email: 'm.lin@gmail.com' })).toEqual({
      title: 'Link the Google account m.lin@gmail.com to this account?',
      message: "Once linked, you can also sign in to this account with Google. If you did not just finish signing in on Google's page, tap Cancel.",
      ok: 'Link',
      cancel: 'Cancel',
    });
    expect(n.pendingLinkQuestion({ provider: 'apple', email: 'x7k2m9q4p1@privaterelay.appleid.com' }).title).toBe('Link the Apple Account x7k2m9q4p1@privaterelay.appleid.com to this account?');
    expect(n.pendingLinkQuestion({ provider: 'apple', email: 'gino@icloud.com' }).title).toBe('Link the Apple Account gino@icloud.com to this account?');
    expect(n.pendingLinkQuestion({ provider: 'apple', email: null }).title).toBe('Link this Apple Account to this account?');
  });

  it('says how 連結 went: linked, or linked off an empty account that is gone now; a link that timed out', () => {
    i18n.setLocale('zh-TW');
    expect(n.pendingLinkedText('apple', false)).toBe('已連結 Apple，之後也可以用 Apple 登入。');
    expect(n.pendingLinkedText('google', false)).toBe('已連結 Google，之後也可以用 Google 登入。');
    expect(n.pendingLinkedText('apple', true)).toBe('已連結 Apple。之前用它建立的空帳號已經刪除。');
    expect(n.pendingLinkedText('google', true)).toBe('已連結 Google。之前用它建立的空帳號已經刪除。');
    expect(n.pendingExpiredText()).toBe('連結的時間過了，請再試一次。');
    i18n.setLocale('en');
    expect(n.pendingLinkedText('apple', true)).toBe('Apple linked. The empty account made with it earlier was deleted.');
    expect(n.pendingExpiredText()).toBe('The link timed out. Try again.');
  });

  it('the claimed notice in the coordinator\'s words, with the app\'s own names in English', () => {
    i18n.setLocale('zh-TW');
    expect(n.claimedNoticeText()).toEqual({
      title: '已確認你的 Email',
      message: '為了安全，這個帳號原本的密碼已經清除，其他裝置也已登出。你可以到「我的 › 登入方式」重新設定密碼。',
      ok: '知道了',
      setPassword: '設定密碼',
    });
    i18n.setLocale('en');
    expect(n.claimedNoticeText().message).toBe(
      "For your security, this account's old password was removed and its other devices were signed out. You can set a new password under Me › Sign-in.",
    );
  });

  it('every text in each language only, and without an en or em dash', () => {
    for (const locale of ['zh-TW', 'en'] as const) {
      i18n.setLocale(locale);
      const texts = [
        ...Object.values(n.pendingLinkQuestion({ provider: 'google', email: 'm.lin@gmail.com' })),
        ...Object.values(n.pendingLinkQuestion({ provider: 'apple', email: null })),
        n.pendingLinkedText('apple', true), n.pendingLinkedText('google', true), n.pendingExpiredText(),
        ...Object.values(n.claimedNoticeText()),
      ];
      for (const text of texts) {
        expect(HAN.test(text), `${locale} ${text}`).toBe(locale === 'zh-TW');
        expect(DASHES.test(text), text).toBe(false);
      }
    }
  });
});

describe('a notice on the page the sign-in lands on', () => {
  /** A page and a dialog on it: each ask is answered by the next of `answers`, which may move the page first. */
  function screen(start: string, answers: ((go: (path: string) => void) => boolean)[]) {
    let page = start;
    const askedOn: string[] = [];
    const ask = async () => {
      askedOn.push(page);
      const answer = answers[askedOn.length - 1];
      if (!answer) throw new Error('asked once too often');
      return answer(p => {
        page = p;
      });
    };
    return { ask, page: () => page, askedOn };
  }

  it('a yes, or a no on the page that asked, is the answer', async () => {
    const yes = screen('/i/AbCd1234', [() => true]);
    expect(await n.askOnLandingPage(yes.ask, yes.page)).toBe(true);
    const no = screen('/i/AbCd1234', [() => false]);
    expect(await n.askOnLandingPage(no.ask, no.page)).toBe(false);
    expect(no.askedOn).toEqual(['/i/AbCd1234']);
  });

  it('a no that came with a page change (the invite opened the ledger) is asked again there, and that answer counts', async () => {
    const left = screen('/i/AbCd1234', [go => (go('/g/g1'), false), () => false]);
    expect(await n.askOnLandingPage(left.ask, left.page)).toBe(false);
    expect(left.askedOn).toEqual(['/i/AbCd1234', '/g/g1']);
    const ok = screen('/join/AbCd1234', [go => (go('/g/g1'), false), () => true]);
    expect(await n.askOnLandingPage(ok.ask, ok.page)).toBe(true);
    // 登入's way back through Home, then the invite opening the ledger: four pages, still asked.
    const login = screen('/i/AbCd1234', [go => (go('/'), false), go => (go('/i/AbCd1234'), false), go => (go('/g/g1'), false), () => false]);
    expect(await n.askOnLandingPage(login.ask, login.page)).toBe(false);
    expect(login.askedOn).toEqual(['/i/AbCd1234', '/', '/i/AbCd1234', '/g/g1']);
  });

  it('a page that never stops moving gets no answer, and nothing opens', async () => {
    let i = 0;
    const moving = screen('/', Array.from({ length: n.NOTICE_PAGES }, () => (go: (path: string) => void) => (go('/g/g' + ++i), false)));
    expect(await n.askOnLandingPage(moving.ask, moving.page)).toBeNull();
    expect(moving.askedOn).toHaveLength(n.NOTICE_PAGES);
  });
});
