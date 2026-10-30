// What the app says when the Worker flags a sign-in or a link (docs/SPEC.md section 3):
// - A link from 我的 that came back through Apple's or Google's pages waits for the person to
//   confirm it: the Worker sends the browser to `/?link_pending=<id>#/account`, and 我的 asks
//   「把 Google 帳戶 {email} 連結到這個帳號？」 (GET /api/me/links/pending/<id>) before 連結 links it
//   (POST) or 取消 drops it (DELETE). A flow someone else started or finished links nothing the
//   person did not see and accept.
// - A sign-in that was the first to prove an account's unconfirmed email took the account over:
//   its old password was removed and its other devices signed out. `notice: "claimed"` in the
//   answer (an email code) or `&notice=claimed` in the address (Apple and Google) says it once.
// This module is the pure part (reading and removing the flags, the words), so
// tests/web/sign-in-notices.test.ts runs it in Node; SignInButtons.tsx asks and says it.

import type { PendingLinkDTO } from '../../../shared/types';
import { t } from '../../lib/i18n';
import { appleLinkedText, isRelayEmail } from './appleSignIn';
import { googleLinkedText } from './googleSignIn';

/** A pending link's id as the Worker makes them (32 random bytes, base64url). */
const PENDING_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export interface NoticeReturn {
  /** The pending link to ask about, or null (none, or not an id the Worker makes). */
  pending: string | null;
  /** The sign-in took an unconfirmed email over. */
  claimed: boolean;
  /** The query without the two flags ('' or '?...'), for history.replaceState. */
  search: string;
}

/** The flags in a page address's query (location.search); other parameters are kept. */
export function readNoticeReturn(search: string): NoticeReturn {
  const params = new URLSearchParams(search);
  const p = params.get('link_pending');
  const n = params.get('notice');
  params.delete('link_pending');
  params.delete('notice');
  const rest = params.toString();
  return { pending: p !== null && PENDING_ID_RE.test(p) ? p : null, claimed: n === 'claimed', search: rest ? '?' + rest : '' };
}

/**
 * What 我的 asks before a pending link links: the provider account by its email, or 「隱藏的 Email」
 * for an Apple ID with a Hide My Email address or none.
 */
export function pendingLinkQuestion(p: Pick<PendingLinkDTO, 'provider' | 'email'>): { title: string; message: string; ok: string; cancel: string } {
  let title: string;
  if (p.provider === 'apple') {
    title = p.email && !isRelayEmail(p.email)
      ? t('把 Apple ID {email} 連結到這個帳號？', 'Link the Apple ID {email} to this account?', { email: p.email })
      : t('把 Apple ID（隱藏的 Email）連結到這個帳號？', 'Link the Apple ID (a hidden email) to this account?');
  } else {
    title = p.email
      ? t('把 Google 帳戶 {email} 連結到這個帳號？', 'Link the Google account {email} to this account?', { email: p.email })
      : t('把這個 Google 帳戶連結到這個帳號？', 'Link this Google account to this account?');
  }
  const name = p.provider === 'apple' ? 'Apple' : 'Google';
  return {
    title,
    message: t('連結後，也能用 {name} 登入這個帳號。', 'Once linked, you can also sign in to this account with {name}.', { name }),
    ok: t('連結', 'Link'),
    cancel: t('取消', 'Cancel'),
  };
}

/** The toast once 連結 went through; `moved`: the Apple ID or Google account came off an empty account, now deleted. */
export function pendingLinkedText(provider: 'apple' | 'google', moved: boolean): string {
  if (!moved) return provider === 'apple' ? appleLinkedText() : googleLinkedText();
  return provider === 'apple'
    ? t('已連結 Apple。之前用它建立的空帳號已經刪除。', 'Apple linked. The empty account made with it earlier was deleted.')
    : t('已連結 Google。之前用它建立的空帳號已經刪除。', 'Google linked. The empty account made with it earlier was deleted.');
}

/** A pending link that is gone: over 10 minutes old, answered already, or another session's (404). */
export function pendingExpiredText(): string {
  return t('連結的時間過了，請再試一次。', 'The link timed out. Try again.');
}

/** Said once after a sign-in that took an unconfirmed email over (`notice: "claimed"`). */
export function claimedNoticeText(): { title: string; message: string; ok: string; setPassword: string } {
  return {
    title: t('已確認你的 Email', 'Your email is confirmed'),
    message: t(
      '為了安全，這個帳號原本的密碼已經清除，其他裝置也已登出。你可以到「我的 › 登入方式」重新設定密碼。',
      "For your security, this account's old password was removed and its other devices were signed out. You can set a new password under Account › Sign-in.",
    ),
    ok: t('知道了', 'Got it'),
    setPassword: t('設定密碼', 'Set a password'),
  };
}
