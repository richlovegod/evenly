// Sign in with Google in the app (the Worker's side: services/google.ts and the /api/auth/google
// routes; docs/SPEC.md section 3, Google). The app never runs Google's script: 使用 Google 帳戶登入
// is a link to /api/auth/google/start, Google's pages do the rest, and the Worker sends the browser
// back to the app with the session cookies set and a flag in the address: `?google=<arrival>`
// before the #route on success, `?google_error=<code>` before #/login otherwise, and
// `?google_link=<ok|code>` before #/account for a link from 我的. This module is the pure part (the
// links, reading and removing the flags, the words, which browsers Google refuses), so
// tests/web/google-sign-in.test.ts runs it in Node; SignInButtons.tsx is the rest (appleSignIn.ts
// is Apple's twin).

import type { GoogleArrival, GoogleErrorCode, Locale } from '../../../shared/types';
import { t } from '../../lib/i18n';

export const GOOGLE_START_PATH = '/api/auth/google/start';

/** The start link for the page to come back to (a hash route) in the app's language. */
export function googleStartUrl(apiBase: string, returnTo: string, locale: Locale): string {
  const back = returnTo.startsWith('/') ? returnTo : '/';
  return apiBase + GOOGLE_START_PATH + '?' + new URLSearchParams({ return: back, locale }).toString();
}

/** The link from 我的 > 登入方式 that links a Google account to the account signed in here. */
export function googleLinkUrl(apiBase: string, locale: Locale): string {
  return apiBase + GOOGLE_START_PATH + '?' + new URLSearchParams({ link: '1', locale }).toString();
}

const ARRIVALS: readonly GoogleArrival[] = ['new', 'back', 'linked'];
export const GOOGLE_ERRORS: readonly GoogleErrorCode[] = [
  'unavailable', 'start', 'denied', 'state', 'failed', 'unverified', 'linked_other', 'rate_limited', 'server', 'google_taken', 'already_linked',
];

export interface GoogleReturn {
  arrival: GoogleArrival | null;
  error: GoogleErrorCode | null;
  /** A link from 我的: 'ok', or why it did not happen. */
  link: 'ok' | GoogleErrorCode | null;
  /** The query without the three flags ('' or '?...'), for history.replaceState. */
  search: string;
}

/**
 * The flags in a page address's query (location.search). An unknown arrival still counts as
 * signed in (`back`), an unknown error as `server`; other parameters are kept.
 */
export function readGoogleReturn(search: string): GoogleReturn {
  const params = new URLSearchParams(search);
  const a = params.get('google');
  const e = params.get('google_error');
  const l = params.get('google_link');
  for (const k of ['google', 'google_error', 'google_link']) params.delete(k);
  const rest = params.toString();
  const code = (v: string): GoogleErrorCode => (GOOGLE_ERRORS.includes(v as GoogleErrorCode) ? (v as GoogleErrorCode) : 'server');
  return {
    arrival: a === null ? null : ARRIVALS.includes(a as GoogleArrival) ? (a as GoogleArrival) : 'back',
    error: e === null ? null : code(e),
    link: l === null ? null : l === 'ok' ? 'ok' : code(l),
    search: rest ? '?' + rest : '',
  };
}

/** What the arrival toast says (none for a new account, as after an email code). */
export function googleArrivalText(arrival: GoogleArrival, name: string): string | null {
  if (arrival === 'back') return t('歡迎回來，{name}', 'Welcome back, {name}', { name });
  if (arrival === 'linked') {
    return t('歡迎回來，{name}。這個帳號之後也可以用 Google 登入', 'Welcome back, {name}. You can sign in to this account with Google from now on.', { name });
  }
  return null;
}

/** Why the Google sign-in (or a link from 我的) did not happen, for 登入 (or 我的). */
export function googleErrorText(code: GoogleErrorCode): string {
  switch (code) {
    case 'unavailable':
      return t('這裡暫時不能用 Google 登入，請改用 Email 驗證碼。', 'Google sign-in is not available here right now. Use an email code instead.');
    case 'start':
      return t('請在這個頁面按「使用 Google 帳戶登入」再試一次。', 'Tap Sign in with Google on this page to try again.');
    case 'denied':
      return t('Google 登入已取消。', 'Google sign-in was canceled.');
    case 'state':
      return t('Google 登入逾時了，或在另一個分頁重新開始過，請再試一次。', 'The Google sign-in timed out or was started again in another tab. Try again.');
    case 'unverified':
      return t('這個 Google 帳戶的 Email 還沒有驗證，請改用 Email 驗證碼登入。', 'This Google account has not verified its email. Sign in with an email code instead.');
    case 'linked_other':
      return t('用這個 Email 的帳號已經連結了另一個 Google 帳戶，請改用 Email 驗證碼登入。', 'The account with this email is linked to another Google account. Sign in with an email code instead.');
    case 'rate_limited':
      return t('嘗試太多次了，請過幾分鐘再試。', 'Too many attempts. Wait a few minutes and try again.');
    case 'google_taken':
      return t('這個 Google 帳戶已經連結到另一個帳號了。', 'This Google account is already linked to another account.');
    case 'already_linked':
      return t('這個帳號已經連結了另一個 Google 帳戶。', 'This account is already linked to another Google account.');
    case 'failed':
    case 'server':
      return t('Google 登入沒有成功，請再試一次，或改用 Email 驗證碼。', 'Google sign-in did not work. Try again, or use an email code.');
  }
}

/** The toast after a link from 我的 came back linked. */
export function googleLinkedText(): string {
  return t('已連結 Google，之後也可以用 Google 登入。', 'Google linked. You can sign in with Google from now on.');
}

/**
 * A web view inside some app (not Safari, Chrome or another browser), where Google refuses to
 * sign in (its "disallowed_useragent" page): Android's WebView says "; wv)", and an iOS web view
 * lacks the "Safari/" every iOS browser sends. The Home Screen app lacks it too, and is no web
 * view: the caller rules it out (pwa.ts isStandalone).
 */
export function webViewUa(ua: string): boolean {
  if (/; wv\)/.test(ua)) return true;
  return /\b(?:iPhone|iPad|iPod)\b/.test(ua) && /AppleWebKit\//.test(ua) && !/Safari\//.test(ua);
}
