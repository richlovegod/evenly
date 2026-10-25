// Email through Resend's REST API (https://resend.com/docs/api-reference/emails/send-email). The
// sign-in codes (services/emailCodes.ts) are the only email the service sends: from EMAIL_FROM
// (wrangler.toml), replies to the owner, in the person's language, with no tracking pixel, no
// tags and one link, the app. Open and click tracking are Resend settings of the sending domain,
// off unless someone turns them on there. Anyone can make the Worker mail any address, so a
// message holds only fixed words and the code, never text a person typed.
// Nothing here logs the code, the key or the recipient: a failure is logged as Resend's status
// and error name. Test mode (EMAIL_DEV_ECHO, staging only) hands the code back to the caller
// instead (canEcho), never where ENVIRONMENT is production.

import type { Locale } from '../../shared/types';
import type { Env } from '../env';

export const RESEND_URL = 'https://api.resend.com/emails';
/** Resend usually answers within a second; past this the person is told to try again. */
export const EMAIL_TIMEOUT_MS = 10_000;
/** Where a reply to a code email goes (the address the policy pages give). */
export const EMAIL_REPLY_TO = 'gino@ginochang.com';
/** The one link a code email carries. */
export const EMAIL_APP_LINK = 'https://split.ginochang.com/';

/** Why an email did not go out. The routes answer 503 email_quota for `quota`, else email_unavailable. */
export type EmailFailure = 'not_configured' | 'quota' | 'rejected' | 'unavailable';

export class EmailError extends Error {
  constructor(
    readonly reason: EmailFailure,
    message: string,
  ) {
    super(message);
    this.name = 'EmailError';
  }
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** The key and the sender are both set, so codes can be mailed. */
export function canSend(env: Pick<Env, 'RESEND_API_KEY' | 'EMAIL_FROM'>): boolean {
  return !!env.RESEND_API_KEY?.trim() && !!env.EMAIL_FROM?.trim();
}

/**
 * Test mode: EMAIL_DEV_ECHO is "1" and this is not production. The flag sits in the staging vars
 * only; the check on ENVIRONMENT holds whatever the flag says, so a production Worker never hands
 * out a code, and neither does one whose ENVIRONMENT is missing.
 */
export function canEcho(env: Pick<Env, 'EMAIL_DEV_ECHO' | 'ENVIRONMENT'>): boolean {
  const where = (env.ENVIRONMENT ?? '').trim().toLowerCase();
  return (env.EMAIL_DEV_ECHO ?? '').trim() === '1' && where !== '' && where !== 'production';
}

/** Domains that never receive mail (RFC 2606 and 6761). Test accounts use them (e2e-x@evenly.test). */
const NO_MAIL_TLDS = ['test', 'example', 'invalid', 'localhost'];
const NO_MAIL_DOMAINS = ['example.com', 'example.net', 'example.org'];

/**
 * An address no message can reach. Sending to it would only bounce, and bounces count against
 * the sender with Resend, so codes for it are made but never mailed (test mode still echoes them).
 */
export function undeliverable(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return NO_MAIL_TLDS.some(t => domain === t || domain.endsWith('.' + t)) || NO_MAIL_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

/** Resend's error name ("daily_quota_exceeded"), safe to log: its message may quote the address. */
function errorName(text: string): string {
  try {
    const name = (JSON.parse(text) as { name?: unknown } | null)?.name;
    return typeof name === 'string' && /^[a-z_]{1,64}$/.test(name) ? name : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Send one email through Resend, within EMAIL_TIMEOUT_MS. Throws EmailError: `not_configured`
 * without RESEND_API_KEY or EMAIL_FROM, `quota` when Resend's daily or monthly quota is used up
 * (staging and production share it when they share a key), `rejected` for any other refusal (a
 * key or a sending domain that is not right), `unavailable` without an answer or on Resend's 5xx.
 */
export async function sendEmail(env: Env, msg: EmailMessage): Promise<void> {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!key || !from) throw new EmailError('not_configured', 'Email is not set up here');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMAIL_TIMEOUT_MS);
  let status = 0;
  let text = '';
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: msg.to, reply_to: EMAIL_REPLY_TO, subject: msg.subject, text: msg.text, html: msg.html }),
      signal: ctrl.signal,
      redirect: 'manual',
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    const why = ctrl.signal.aborted ? 'timeout' : err instanceof Error ? err.name : 'error';
    console.error(`email: no answer from Resend (${why})`);
    throw new EmailError('unavailable', 'The email could not be sent');
  } finally {
    clearTimeout(timer);
  }
  if (status >= 200 && status < 300) return;
  const name = errorName(text);
  console.error(`email: Resend answered ${status} ${name}`);
  if (status === 429 && (name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded')) {
    throw new EmailError('quota', 'The email quota is used up');
  }
  throw new EmailError(status >= 500 || status === 429 ? 'unavailable' : 'rejected', 'The email could not be sent');
}

// ---------- the code email ----------

interface CodeWords {
  lang: string;
  subject: string;
  lead: string;
  valid: string;
  notYou: string;
  app: string;
}

function codeWords(locale: Locale, code: string): CodeWords {
  return locale === 'en'
    ? {
        lang: 'en',
        subject: `Gino's Split Lab code: ${code}`,
        lead: "Your Gino's Split Lab code is:",
        valid: 'It is valid for 10 minutes.',
        notYou: 'If this was not you, ignore this email.',
        app: "Gino's Split Lab",
      }
    : {
        lang: 'zh-Hant-TW',
        subject: `吉諾分帳所驗證碼：${code}`,
        lead: '你的吉諾分帳所驗證碼是：',
        valid: '10 分鐘內有效。',
        notYou: '不是你本人操作的話，忽略這封信就好。',
        app: '吉諾分帳所',
      };
}

const PAPER = '#FFFCF6';
const INK = '#3E3A39';
const INK_2 = '#6B6461';
const YOLK_TINT = '#FCF1D3';
/** System fonts only: a web font would be another request out of the message. */
const FONT = `-apple-system, BlinkMacSystemFont, 'PingFang TC', 'Microsoft JhengHei', 'Noto Sans TC', 'Segoe UI', Roboto, Arial, sans-serif`;

/**
 * The code email in `locale`: the subject names the code (phones show it in the notification),
 * then plain text and a small HTML version in the picture-book look (paper, ink, a 3 px outline,
 * the code on a yolk field), and one link, the app. `code` is six digits, so nothing needs escaping.
 */
export function codeMessage(locale: Locale, code: string): Omit<EmailMessage, 'to'> {
  const w = codeWords(locale, code);
  const text = [w.lead, '', code, '', w.valid, w.notYou, '', w.app, EMAIL_APP_LINK, ''].join('\n');
  const html = `<!doctype html>
<html lang="${w.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${w.subject}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
<tr><td align="center" style="padding:28px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:420px;border:3px solid ${INK};border-radius:22px;background:${PAPER};">
<tr><td style="padding:22px 22px 24px;font-family:${FONT};color:${INK};">
<p style="margin:0 0 14px;font-size:16px;line-height:1.5;">${w.lead}</p>
<p style="margin:0 0 14px;padding:12px 16px;border:3px solid ${INK};border-radius:16px;background:${YOLK_TINT};font-size:34px;line-height:1.2;letter-spacing:6px;font-weight:700;text-align:center;">${code}</p>
<p style="margin:0 0 6px;font-size:15px;line-height:1.5;">${w.valid}</p>
<p style="margin:0;font-size:14px;line-height:1.5;color:${INK_2};">${w.notYou}</p>
</td></tr>
</table>
<p style="margin:16px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;"><a href="${EMAIL_APP_LINK}" style="color:${INK};">${w.app}</a></p>
</td></tr>
</table>
</body>
</html>
`;
  return { subject: w.subject, text, html };
}
