// Sign in with Apple in the app (the Worker's side: services/apple.ts and the /api/auth/apple
// routes; docs/SPEC.md section 3, Apple), as googleSignIn.ts is for Google. The app never runs
// Apple's script: 使用 Apple 登入 is a link to /api/auth/apple/start, Apple's pages do the rest, and
// the Worker sends the browser back to the app with the session cookies set and a flag in the
// address: `?apple=<arrival>` before the #route on success, `?apple_error=<code>` before #/login
// otherwise, and `?apple_link=<ok|code>` before #/account for a link from 我的. This module is the
// pure part (the links, reading and removing the flags, the words, Hide My Email), so
// tests/web/apple-sign-in.test.ts runs it in Node; SignInButtons.tsx is the rest.

import type { AppleErrorCode, Locale, SignInArrival } from '../../../shared/types';
import { t } from '../../lib/i18n';

export const APPLE_START_PATH = '/api/auth/apple/start';
/** Apple's Hide My Email addresses (the Worker counts them as confirmed, like any address Apple gives). */
export const RELAY_DOMAIN = 'privaterelay.appleid.com';

/** The start link for the page to come back to (a hash route) in the app's language. */
export function appleStartUrl(apiBase: string, returnTo: string, locale: Locale): string {
  const back = returnTo.startsWith('/') ? returnTo : '/';
  return apiBase + APPLE_START_PATH + '?' + new URLSearchParams({ return: back, locale }).toString();
}

/** The link from 我的 > 登入方式 that links an Apple ID to the account signed in here. */
export function appleLinkUrl(apiBase: string, locale: Locale): string {
  return apiBase + APPLE_START_PATH + '?' + new URLSearchParams({ link: '1', locale }).toString();
}

const ARRIVALS: readonly SignInArrival[] = ['new', 'back', 'linked'];
export const APPLE_ERRORS: readonly AppleErrorCode[] = [
  'unavailable', 'start', 'denied', 'state', 'failed', 'no_email', 'linked_other', 'rate_limited', 'server', 'apple_taken', 'already_linked',
];

export interface AppleReturn {
  arrival: SignInArrival | null;
  error: AppleErrorCode | null;
  /** A link from 我的: 'ok', or why it did not happen. */
  link: 'ok' | AppleErrorCode | null;
  /** The query without the three flags ('' or '?...'), for history.replaceState. */
  search: string;
}

/**
 * The flags in a page address's query (location.search). An unknown arrival still counts as
 * signed in (`back`), an unknown error as `server`; other parameters are kept.
 */
export function readAppleReturn(search: string): AppleReturn {
  const params = new URLSearchParams(search);
  const a = params.get('apple');
  const e = params.get('apple_error');
  const l = params.get('apple_link');
  for (const k of ['apple', 'apple_error', 'apple_link']) params.delete(k);
  const rest = params.toString();
  const code = (v: string): AppleErrorCode => (APPLE_ERRORS.includes(v as AppleErrorCode) ? (v as AppleErrorCode) : 'server');
  return {
    arrival: a === null ? null : ARRIVALS.includes(a as SignInArrival) ? (a as SignInArrival) : 'back',
    error: e === null ? null : code(e),
    link: l === null ? null : l === 'ok' ? 'ok' : code(l),
    search: rest ? '?' + rest : '',
  };
}

/** What the arrival toast says (none for a new account, as after an email code). */
export function appleArrivalText(arrival: SignInArrival, name: string): string | null {
  if (arrival === 'back') return t('歡迎回來，{name}', 'Welcome back, {name}', { name });
  if (arrival === 'linked') {
    return t('歡迎回來，{name}。這個帳號之後也可以用 Apple 登入', 'Welcome back, {name}. You can sign in to this account with Apple from now on.', { name });
  }
  return null;
}

/** An address Apple's Hide My Email forwards. */
export function isRelayEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith('@' + RELAY_DOMAIN);
}

/**
 * Said once, after a sign-in with Apple made a new account whose email is a relay address: the
 * person hid the email, so no account of theirs could be found by it.
 */
export function relayNewAccountText(): { title: string; message: string; ok: string; haveOne: string } {
  return {
    title: t('這是新的帳號', 'This is a new account'),
    message: t(
      '你在 Apple 選了隱藏 Email，所以找不到你原本的帳號，就建立了一個新的。已經有帳號的話：登出，用原本的方式登入，再到「我的 › 登入方式」連結 Apple。',
      'You chose to hide your email with Apple, so no account of yours could be found and a new one was made. If you already have an account: sign out, sign in the way you used to, then link Apple under Account › Sign-in.',
    ),
    ok: t('知道了', 'Got it'),
    haveOne: t('我已經有帳號', 'I have an account'),
  };
}

/** Why the Apple sign-in (or a link from 我的) did not happen. */
export function appleErrorText(code: AppleErrorCode): string {
  switch (code) {
    case 'unavailable':
      return t('這裡暫時不能用 Apple 登入，請改用 Email 驗證碼。', 'Sign in with Apple is not available here right now. Use an email code instead.');
    case 'start':
      return t('請在這個頁面按「使用 Apple 登入」再試一次。', 'Tap Sign in with Apple on this page to try again.');
    case 'denied':
      return t('Apple 登入已取消。', 'Sign in with Apple was canceled.');
    case 'state':
      return t('Apple 登入逾時了，或在另一個分頁重新開始過，請再試一次。', 'The Apple sign-in timed out or was started again in another tab. Try again.');
    case 'no_email':
      return t('Apple 沒有提供 Email，請改用 Email 驗證碼登入。', 'Apple did not share an email. Sign in with an email code instead.');
    case 'linked_other':
      return t('用這個 Email 的帳號已經連結了另一個 Apple ID，請改用 Email 驗證碼登入。', 'The account with this email is linked to another Apple ID. Sign in with an email code instead.');
    case 'rate_limited':
      return t('嘗試太多次了，請過幾分鐘再試。', 'Too many attempts. Wait a few minutes and try again.');
    case 'apple_taken':
      return t('這個 Apple ID 已經連結到另一個帳號了。', 'This Apple ID is already linked to another account.');
    case 'already_linked':
      return t('這個帳號已經連結了另一個 Apple ID。', 'This account is already linked to another Apple ID.');
    case 'failed':
    case 'server':
      return t('Apple 登入沒有成功，請再試一次，或改用 Email 驗證碼。', 'Sign in with Apple did not work. Try again, or use an email code.');
  }
}

/** The toast after a link from 我的 came back linked. */
export function appleLinkedText(): string {
  return t('已連結 Apple，之後也可以用 Apple 登入。', 'Apple linked. You can sign in with Apple from now on.');
}
