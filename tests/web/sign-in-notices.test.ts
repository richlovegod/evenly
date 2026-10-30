// What the app says when the Worker flags a sign-in or a link (src/web/features/auth/signInNotices.ts):
// reading `link_pending` and `notice` from the address and what stays of the query, the question
// 我的 asks before a pending link links (by the email, or 「隱藏的 Email」 for a relay address or
// none), the toasts after 連結 (an empty account moved or not), a link that is gone, and the
// claimed notice, in both languages. The Worker's side is tests/worker/apple-sign-in.test.ts.

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
  it('asks before it links: the provider account by its email, 「隱藏的 Email」 for a relay address or none', () => {
    i18n.setLocale('zh-TW');
    expect(n.pendingLinkQuestion({ provider: 'google', email: 'm.lin@gmail.com' })).toEqual({
      title: '把 Google 帳戶 m.lin@gmail.com 連結到這個帳號？', message: '連結後，也能用 Google 登入這個帳號。', ok: '連結', cancel: '取消',
    });
    expect(n.pendingLinkQuestion({ provider: 'google', email: null }).title).toBe('把這個 Google 帳戶連結到這個帳號？');
    expect(n.pendingLinkQuestion({ provider: 'apple', email: 'gino@icloud.com' }).title).toBe('把 Apple 帳號 gino@icloud.com 連結到這個帳號？');
    expect(n.pendingLinkQuestion({ provider: 'apple', email: 'x7k2m9q4p1@privaterelay.appleid.com' }).title).toBe('把 Apple 帳號（隱藏的 Email）連結到這個帳號？');
    expect(n.pendingLinkQuestion({ provider: 'apple', email: null }).title).toBe('把 Apple 帳號（隱藏的 Email）連結到這個帳號？');
    expect(n.pendingLinkQuestion({ provider: 'apple', email: null }).message).toBe('連結後，也能用 Apple 登入這個帳號。');
    i18n.setLocale('en');
    expect(n.pendingLinkQuestion({ provider: 'google', email: 'm.lin@gmail.com' })).toEqual({
      title: 'Link the Google account m.lin@gmail.com to this account?', message: 'Once linked, you can also sign in to this account with Google.', ok: 'Link', cancel: 'Cancel',
    });
    expect(n.pendingLinkQuestion({ provider: 'apple', email: 'x7k2m9q4p1@privaterelay.appleid.com' }).title).toBe('Link the Apple Account (a hidden email) to this account?');
    expect(n.pendingLinkQuestion({ provider: 'apple', email: 'gino@icloud.com' }).title).toBe('Link the Apple Account gino@icloud.com to this account?');
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
      "For your security, this account's old password was removed and its other devices were signed out. You can set a new password under Account › Sign-in.",
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
