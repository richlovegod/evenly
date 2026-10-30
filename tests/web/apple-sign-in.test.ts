// Sign in with Apple in the app (src/web/features/auth/appleSignIn.ts): the start and link links,
// reading the flags the Worker's callback puts in the address and what stays of the query, the
// arrival toast, the note for a new account with a Hide My Email address, and every error 登入
// or 我的 can show, in both languages. The Worker's side is tests/worker/apple-sign-in.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppleErrorCode } from '../../src/shared/types';

type Mod = typeof import('../../src/web/features/auth/appleSignIn');
type I18n = typeof import('../../src/web/lib/i18n');

let a: Mod;
let i18n: I18n;

beforeEach(async () => {
  vi.resetModules();
  i18n = await import('../../src/web/lib/i18n');
  a = await import('../../src/web/features/auth/appleSignIn');
});

const ERRORS: AppleErrorCode[] = [
  'unavailable', 'start', 'denied', 'state', 'failed', 'no_email', 'linked_other', 'rate_limited', 'server', 'apple_taken', 'already_linked',
];
/** The en dash and the em dash (U+2013, U+2014), which no text of the app may use. */
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
const HAN = /\p{Script=Han}/u;

describe('the links', () => {
  it('the start names the page to come back to and the language; 連結 says link=1', () => {
    expect(a.appleStartUrl('', '/join/AbCd1234', 'zh-TW')).toBe('/api/auth/apple/start?return=%2Fjoin%2FAbCd1234&locale=zh-TW');
    expect(a.appleStartUrl('https://split.test', '/', 'en')).toBe('https://split.test/api/auth/apple/start?return=%2F&locale=en');
    expect(a.appleStartUrl('', 'https://evil.test/', 'en')).toBe('/api/auth/apple/start?return=%2F&locale=en');
    expect(a.appleLinkUrl('', 'en')).toBe('/api/auth/apple/start?link=1&locale=en');
  });
});

describe('coming back', () => {
  it('reads the arrival, the error and a link, and keeps the rest of the query', () => {
    expect(a.readAppleReturn('?apple=new')).toEqual({ arrival: 'new', error: null, link: null, search: '' });
    expect(a.readAppleReturn('?install=ABC&apple=back')).toEqual({ arrival: 'back', error: null, link: null, search: '?install=ABC' });
    expect(a.readAppleReturn('?apple=whatever').arrival).toBe('back');
    for (const e of ERRORS) expect(a.readAppleReturn('?apple_error=' + e)).toEqual({ arrival: null, error: e, link: null, search: '' });
    expect(a.readAppleReturn('?apple_error=%3Cb%3E').error).toBe('server');
    expect(a.readAppleReturn('?apple_link=ok')).toEqual({ arrival: null, error: null, link: 'ok', search: '' });
    expect(a.readAppleReturn('?apple_link=apple_taken').link).toBe('apple_taken');
    expect(a.readAppleReturn('?apple_link=nope').link).toBe('server');
    expect(a.readAppleReturn('?google=new')).toEqual({ arrival: null, error: null, link: null, search: '?google=new' });
  });

  it('greets an account that was there (back, linked), and not a new one', () => {
    i18n.setLocale('zh-TW');
    expect(a.appleArrivalText('back', 'Gino')).toBe('歡迎回來，Gino');
    expect(a.appleArrivalText('linked', 'Gino')).toBe('歡迎回來，Gino。這個帳號之後也可以用 Apple 登入');
    expect(a.appleArrivalText('new', 'Gino')).toBeNull();
    i18n.setLocale('en');
    expect(a.appleArrivalText('linked', 'Gino')).toBe('Welcome back, Gino. You can sign in to this account with Apple from now on.');
  });

  it('knows a Hide My Email address, and says once why a new account was made with one', () => {
    expect(a.isRelayEmail('x7k2m9q4p1@privaterelay.appleid.com')).toBe(true);
    expect(a.isRelayEmail('X7K2@PrivateRelay.AppleID.com')).toBe(true);
    for (const e of ['gino@icloud.com', 'a@privaterelay.appleid.com.evil.test', '', null, undefined]) expect(a.isRelayEmail(e)).toBe(false);
    for (const locale of ['zh-TW', 'en'] as const) {
      i18n.setLocale(locale);
      const w = a.relayNewAccountText();
      for (const text of Object.values(w)) {
        expect(HAN.test(text), `${locale} ${text}`).toBe(locale === 'zh-TW');
        expect(DASHES.test(text)).toBe(false);
      }
    }
    i18n.setLocale('zh-TW');
    expect(a.relayNewAccountText().message).toContain('「我的 › 登入方式」連結 Apple');
    i18n.setLocale('en');
    expect(a.relayNewAccountText().message).toContain('link Apple under Account › Sign-in');
  });

  it('says every error in both languages; failed and server alike, every other code its own', () => {
    for (const locale of ['zh-TW', 'en'] as const) {
      i18n.setLocale(locale);
      const seen = new Set<string>();
      for (const e of ERRORS) {
        const text = a.appleErrorText(e);
        expect(text.length, e).toBeGreaterThan(5);
        expect(HAN.test(text), `${locale} ${e}`).toBe(locale === 'zh-TW');
        expect(DASHES.test(text), e).toBe(false);
        seen.add(text);
      }
      expect(seen.size).toBe(ERRORS.length - 1);
    }
    i18n.setLocale('en');
    expect(a.appleErrorText('denied')).toBe('Sign in with Apple was canceled.');
    expect(a.appleErrorText('no_email')).toContain('email code');
    // Apple's current name for the account, as the iPhone app says it.
    expect(a.appleErrorText('apple_taken')).toBe('This Apple Account is already linked to another account.');
    expect(a.appleErrorText('already_linked')).toBe('This account is already linked to another Apple Account.');
    expect(a.appleLinkedText()).toBe('Apple linked. You can sign in with Apple from now on.');
    i18n.setLocale('zh-TW');
    expect(a.appleLinkedText()).toBe('已連結 Apple，之後也可以用 Apple 登入。');
    expect(a.appleErrorText('apple_taken')).toBe('這個 Apple 帳號已經連結到另一個帳號了。');
    expect(a.appleErrorText('linked_other')).toBe('用這個 Email 的帳號已經連結了另一個 Apple 帳號，請改用 Email 驗證碼登入。');
    for (const e of ERRORS) expect(a.appleErrorText(e), e).not.toContain('Apple ID');
  });
});
