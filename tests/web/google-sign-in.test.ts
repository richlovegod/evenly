// Sign in with Google in the app (src/web/features/auth/googleSignIn.ts): the start and link
// links and the page they bring back, reading the flags the Worker's callback puts in the address
// and what stays of the query, the arrival toast and every error 登入 or 我的 can show in both
// languages, and which
// browsers count as an app's web view (Google refuses to sign in there). The store's end of the
// sign-in (actions.googleArrived) is in session-reload.test.ts; the Worker's side in
// tests/worker/google-sign-in.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleErrorCode } from '../../src/shared/types';

type Mod = typeof import('../../src/web/features/auth/googleSignIn');
type I18n = typeof import('../../src/web/lib/i18n');

let g: Mod;
let i18n: I18n;

beforeEach(async () => {
  vi.resetModules();
  i18n = await import('../../src/web/lib/i18n');
  g = await import('../../src/web/features/auth/googleSignIn');
});

const ERRORS: GoogleErrorCode[] = [
  'unavailable', 'start', 'denied', 'state', 'failed', 'unverified', 'linked_other', 'rate_limited', 'server', 'google_taken', 'already_linked',
  'email_unconfirmed',
];
/** The en dash and the em dash (U+2013, U+2014), which no text of the app may use. */
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
const HAN = /\p{Script=Han}/u;

describe('the start link', () => {
  it('names the page to come back to and the language, on the API base', () => {
    expect(g.googleStartUrl('', '/join/AbCd1234', 'zh-TW')).toBe('/api/auth/google/start?return=%2Fjoin%2FAbCd1234&locale=zh-TW');
    expect(g.googleStartUrl('', '/g/x/settle?from=a&to=b', 'en')).toBe('/api/auth/google/start?return=%2Fg%2Fx%2Fsettle%3Ffrom%3Da%26to%3Db&locale=en');
    expect(g.googleStartUrl('https://split.test', '/', 'en')).toBe('https://split.test/api/auth/google/start?return=%2F&locale=en');
    // Anything but an app path goes Home (the Worker checks again).
    expect(g.googleStartUrl('', 'https://evil.test/', 'en')).toBe('/api/auth/google/start?return=%2F&locale=en');
    // 連結 on 我的.
    expect(g.googleLinkUrl('', 'zh-TW')).toBe('/api/auth/google/start?link=1&locale=zh-TW');
  });
});

describe('coming back', () => {
  it('reads the arrival, keeps the rest of the query', () => {
    expect(g.readGoogleReturn('?google=new')).toEqual({ arrival: 'new', error: null, link: null, search: '' });
    expect(g.readGoogleReturn('?google=back&openExternalBrowser=1')).toEqual({ arrival: 'back', error: null, link: null, search: '?openExternalBrowser=1' });
    expect(g.readGoogleReturn('?install=ABC&google=linked')).toEqual({ arrival: 'linked', error: null, link: null, search: '?install=ABC' });
    // A flag from a newer Worker still means signed in.
    expect(g.readGoogleReturn('?google=whatever').arrival).toBe('back');
  });

  it('reads an error; an unknown one is server', () => {
    for (const e of ERRORS) expect(g.readGoogleReturn('?google_error=' + e)).toEqual({ arrival: null, error: e, link: null, search: '' });
    expect(g.readGoogleReturn('?google_error=%3Cb%3E').error).toBe('server');
  });

  it('reads a link from 我的: ok or its error, and leaves Apple\'s flags for appleSignIn.ts', () => {
    expect(g.readGoogleReturn('?google_link=ok')).toEqual({ arrival: null, error: null, link: 'ok', search: '' });
    expect(g.readGoogleReturn('?google_link=google_taken&apple=new')).toEqual({ arrival: null, error: null, link: 'google_taken', search: '?apple=new' });
    expect(g.readGoogleReturn('?google_link=whatever').link).toBe('server');
  });

  it('no flag: nothing to do', () => {
    expect(g.readGoogleReturn('')).toEqual({ arrival: null, error: null, link: null, search: '' });
    expect(g.readGoogleReturn('?install=ABC')).toEqual({ arrival: null, error: null, link: null, search: '?install=ABC' });
  });

  it('greets an account that was there (back, linked), and not a new one', () => {
    i18n.setLocale('zh-TW');
    expect(g.googleArrivalText('back', 'Abbie')).toBe('歡迎回來，Abbie');
    expect(g.googleArrivalText('linked', 'Abbie')).toBe('歡迎回來，Abbie。這個帳號之後也可以用 Google 登入');
    expect(g.googleArrivalText('new', 'Abbie')).toBeNull();
    i18n.setLocale('en');
    expect(g.googleArrivalText('back', 'Abbie')).toBe('Welcome back, Abbie');
    expect(g.googleArrivalText('linked', 'Abbie')).toBe('Welcome back, Abbie. You can sign in to this account with Google from now on.');
  });

  it('says every error in both languages', () => {
    for (const locale of ['zh-TW', 'en'] as const) {
      i18n.setLocale(locale);
      const seen = new Set<string>();
      for (const e of ERRORS) {
        const text = g.googleErrorText(e);
        expect(text.length, e).toBeGreaterThan(5);
        expect(HAN.test(text), `${locale} ${e}`).toBe(locale === 'zh-TW');
        expect(DASHES.test(text), e).toBe(false);
        seen.add(text);
      }
      // failed and server say the same; every other code has its own words.
      expect(seen.size).toBe(ERRORS.length - 1);
    }
    i18n.setLocale('en');
    expect(g.googleErrorText('denied')).toBe('Google sign-in was canceled.');
    expect(g.googleErrorText('linked_other')).toContain('email code');
    // The way out when the Google account is on the new account a sign-in made a moment ago.
    expect(g.googleErrorText('google_taken')).toBe(
      'This Google account is already linked to another account. If that is a new account you just made with it, sign in to it with Google, delete it under Account, then come back here and link.',
    );
    expect(g.googleErrorText('email_unconfirmed')).toBe("Confirm this account's email under Account first, then link Google.");
    expect(g.googleLinkedText()).toBe('Google linked. You can sign in with Google from now on.');
    i18n.setLocale('zh-TW');
    expect(g.googleLinkedText()).toBe('已連結 Google，之後也可以用 Google 登入。');
    expect(g.googleErrorText('google_taken')).toBe('這個 Google 帳戶已經連結到另一個帳號了。如果那是剛才用它建立的新帳號，請先用 Google 登入那個帳號，在「我的」刪除它，再回來這裡連結。');
    expect(g.googleErrorText('email_unconfirmed')).toBe('請先在「我的」確認這個帳號的 Email，再連結 Google。');
  });

  it('a link from 我的 refused as unverified asks for another Google account, never for a sign-in by email code (round 3)', () => {
    i18n.setLocale('zh-TW');
    expect(g.googleLinkErrorText('unverified')).toBe('Google 沒有提供這個帳戶驗證過的 Email，所以不能連結。請換一個 Google 帳戶。');
    i18n.setLocale('en');
    expect(g.googleLinkErrorText('unverified')).toBe("Google did not share a verified email for this account, so it can't be linked. Try another Google account.");
    // The sign-in page keeps its own words.
    expect(g.googleErrorText('unverified')).toBe('This Google account has not verified its email. Sign in with an email code instead.');
  });

  it('no link\'s words tell a signed-in person to sign in: start, denied, unavailable, failed and server speak of linking, as the iPhone app does (round 4)', () => {
    const banned = ['email code', '驗證碼登入', 'Email 驗證碼', 'Sign in with Google', '使用 Google 帳戶登入'];
    for (const locale of ['zh-TW', 'en'] as const) {
      i18n.setLocale(locale);
      for (const e of ERRORS) {
        const text = g.googleLinkErrorText(e);
        for (const b of banned) expect(text.includes(b), `${locale} ${e}: ${text}`).toBe(false);
        expect(HAN.test(text), `${locale} ${e}`).toBe(locale === 'zh-TW');
        expect(DASHES.test(text), e).toBe(false);
      }
    }
    i18n.setLocale('zh-TW');
    expect(['start', 'denied', 'unavailable', 'failed', 'server'].map(e => g.googleLinkErrorText(e as GoogleErrorCode))).toEqual([
      '連結的時間過了，請再試一次。', '已取消連結 Google。', '現在不能連結 Google，請稍後再試。', '沒能連結 Google，請再試一次。', '沒能連結 Google，請再試一次。',
    ]);
    i18n.setLocale('en');
    expect(['start', 'denied', 'unavailable', 'failed', 'server'].map(e => g.googleLinkErrorText(e as GoogleErrorCode))).toEqual([
      'The link timed out. Try again.', 'Linking Google was canceled.', 'Google cannot be linked right now. Try again later.', 'Could not link Google. Try again.', 'Could not link Google. Try again.',
    ]);
    // These read as the sign-in page's, which say nothing about signing in another way.
    for (const e of ['state', 'rate_limited', 'google_taken', 'already_linked', 'email_unconfirmed'] as const) expect(g.googleLinkErrorText(e), e).toBe(g.googleErrorText(e));
  });
});

describe('browsers Google refuses', () => {
  const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
  const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1';
  const GOOGLE_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/385.0.795060468 Mobile/15E148 Safari/604.1';
  const IOS_WEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
  const ANDROID_WEBVIEW = 'Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36';
  const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';

  it('an Android WebView and an iOS web view are; the browsers are not', () => {
    expect(g.webViewUa(ANDROID_WEBVIEW)).toBe(true);
    expect(g.webViewUa(IOS_WEBVIEW)).toBe(true);
    for (const ua of [SAFARI, CHROME_IOS, GOOGLE_APP, ANDROID_CHROME, MAC_SAFARI, '']) expect(g.webViewUa(ua), ua).toBe(false);
  });
});
