// The 6-digit email codes in the app (the Worker's side: services/emailCodes.ts): how a typed
// address and a typed or pasted code are cleaned before they are sent, when 重新寄送 may be
// tapped, and what each answer that went wrong says. Pure, so tests/web/email-code.test.ts runs
// it in Node; useEmailCode.ts and CodeStep.tsx are the forms around it.

import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { t } from '../../lib/i18n';

export const CODE_LENGTH = 6;
/** 重新寄送 waits this long after a code went out (the Worker allows 3 codes an address in 15 minutes). */
export const RESEND_AFTER_MS = 60_000;

/** The Worker's rule for a sign-in email (routes/me.ts, services/emailCodes.ts). */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** The address as the Worker keeps it: NFKC (full-width letters typed on a Chinese keyboard become plain), trimmed, lowercase. */
export function cleanEmail(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

/** A cleaned address that looks like one, at most 120 characters. */
export function emailOk(email: string): boolean {
  return email.length <= 120 && EMAIL_RE.test(email);
}

/** What is typed, pasted or filled in from Mail: its digits (full width too), at most 6. */
export function cleanCode(raw: string): string {
  return raw.normalize('NFKC').replace(/[^0-9]/g, '').slice(0, CODE_LENGTH);
}

export function codeComplete(code: string): boolean {
  return code.length === CODE_LENGTH && /^[0-9]+$/.test(code);
}

/** When 重新寄送 works again after a code went out at `sentAt` (a local clock time in ms). */
export function resendAt(sentAt: number): number {
  return sentAt + RESEND_AFTER_MS;
}

/** A wait in seconds as words: 「1 分鐘」, 「12 分鐘」, 「3 小時」 (rounded up, at least a minute). */
export function waitText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 90) return minutes === 1 ? t('1 分鐘', '1 minute') : t('{n} 分鐘', '{n} minutes', { n: minutes });
  const hours = Math.ceil(minutes / 60);
  return t('{n} 小時', '{n} hours', { n: hours });
}

/**
 * What went wrong with an email code, for people: asking for one (`send`) or checking it
 * (`verify`). Answers that mean the same everywhere (offline, email_quota, email_unavailable,
 * name_required) take lib/errors.ts's words.
 */
export function codeErrorText(e: unknown, what: 'send' | 'verify'): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'code_invalid':
        return t('驗證碼不對或已經過期，請再輸入一次，或重新寄送。', 'That code is wrong or has expired. Type it again, or send a new one.');
      case 'rate_limited': {
        const retry = Number((e.details as { retryAfter?: unknown } | undefined)?.retryAfter);
        const wait = Number.isFinite(retry) && retry > 0 ? waitText(retry) : null;
        if (what === 'send') {
          return wait
            ? t('驗證信寄太多次了，請 {w}後再試。', 'Too many codes for now. Try again in {w}.', { w: wait })
            : t('驗證信寄太多次了，請過一會兒再試。', 'Too many codes for now. Try again in a while.');
        }
        return wait
          ? t('輸入錯太多次了，請 {w}後再試。', 'Too many wrong tries. Try again in {w}.', { w: wait })
          : t('輸入錯太多次了，請過一會兒再試。', 'Too many wrong tries. Try again in a while.');
      }
      case 'email_taken':
        return t('這個 Email 已經有別的帳號在用了。', 'Another account already uses this email.');
      case 'validation':
        return t('請輸入正確的 Email。', 'Enter a valid email address.');
    }
  }
  return errorMessage(e);
}
