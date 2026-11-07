// The two steps of every email-code form (開始使用, 登入, joining by an invite or a claim link,
// 加上 Email and 更換 Email on 我的): the address, then the 6-digit code mailed to it. The page
// draws the address step and calls send(); CodeStep draws the code step from this state. Codes
// are asked for with `start`; a code goes to `verify` as soon as its sixth digit is in.

import { useRef, useState } from 'react';
import type { EmailStartRes } from '../../../shared/types';
import { ApiError } from '../../lib/api';
import { t } from '../../lib/i18n';
import { showToast } from '../../lib/toast';
import { afterWrongCode, cleanCode, cleanEmail, codeComplete, codeErrorText, emailOk, resendAt } from './emailCode';

export interface EmailCodeFlow {
  step: 'email' | 'code';
  /** The address the code went to (cleaned). */
  email: string;
  /** The code typed so far (digits only). */
  code: string;
  /** When 重新寄送 works again (a local clock time in ms). */
  resendAt: number;
  /** Test mode only (staging, EMAIL_DEV_ECHO): the code the Worker handed back. */
  devCode: string | null;
  error: string | null;
  sending: boolean;
  verifying: boolean;
  /** Ask for a code for this address; false when none went out (`error` says why). */
  send(raw: string): Promise<boolean>;
  /** A new code to the same address. */
  resend(): Promise<void>;
  /** What is typed or pasted into the code field; all 6 digits are checked at once. */
  type(raw: string): void;
  /** Check the code typed so far (the button). */
  submit(): Promise<void>;
  /** Back to the address step; its field keeps what was typed. */
  changeEmail(): void;
}

export interface EmailCodeOptions {
  start: (email: string) => Promise<EmailStartRes>;
  /** Resolves once the code did its job (signed in, or the email confirmed); throws otherwise. */
  verify: (email: string, code: string) => Promise<void>;
  /** An answer the page shows in its own way (true: no error line), like 登入's name_required. */
  onVerifyError?: (err: unknown) => boolean;
}

export function useEmailCode(opts: EmailCodeOptions): EmailCodeFlow {
  // The newest callbacks, so a check started by a keystroke uses what the page shows now.
  const latest = useRef(opts);
  latest.current = opts;
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [nextSend, setNextSend] = useState(0);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  /** One request at a time: state arrives a render late, a ref at once (a double tap, Enter). */
  const busy = useRef(false);
  /** What the code field holds now, at once (state arrives a render late): a code typed while another is being checked is checked next, and a wrong answer empties the field only while it still holds the code that was checked. */
  const typed = useRef('');

  async function ask(address: string, again: boolean): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setSending(true);
    setError(null);
    try {
      const r = await latest.current.start(address);
      setEmail(address);
      setDevCode(r.devCode ?? null);
      setNextSend(resendAt(Date.now()));
      setCode('');
      typed.current = '';
      setStep('code');
      if (again) showToast({ message: t('已寄出新的驗證碼', 'A new code is on its way'), kind: 'success' });
      return true;
    } catch (err) {
      setError(codeErrorText(err, 'send'));
      return false;
    } finally {
      busy.current = false;
      setSending(false);
    }
  }

  async function check(value: string): Promise<void> {
    if (busy.current) return;
    if (!codeComplete(value)) {
      setError(t('請輸入信裡的 6 位數驗證碼', 'Enter the 6-digit code from the email'));
      return;
    }
    busy.current = true;
    setVerifying(true);
    setError(null);
    let failed = false;
    let failure: unknown = null;
    try {
      await latest.current.verify(email, value);
    } catch (err) {
      failed = true;
      failure = err;
    } finally {
      busy.current = false;
      setVerifying(false);
    }
    if (!failed || latest.current.onVerifyError?.(failure)) return;
    const wrong = failure instanceof ApiError && failure.code === 'code_invalid';
    // Typed over while that code was out (a slow connection): six digits in the field now are the
    // ones to check, not to wipe as wrong; a correction still being typed stays (emailCode.ts afterWrongCode).
    const now = typed.current;
    const next = wrong ? afterWrongCode(value, now) : 'keep';
    if (next === 'recheck') return check(now);
    setError(codeErrorText(failure, 'verify'));
    // Wrong or expired: the field empties, so the next six digits are checked by themselves.
    if (next === 'wipe') {
      typed.current = '';
      setCode('');
    }
  }

  return {
    step,
    email,
    code,
    resendAt: nextSend,
    devCode,
    error,
    sending,
    verifying,
    async send(raw: string) {
      const address = cleanEmail(raw);
      if (!emailOk(address)) {
        setError(t('請輸入正確的 Email。', 'Enter a valid email address.'));
        return false;
      }
      return ask(address, false);
    },
    async resend() {
      if (Date.now() < nextSend) return;
      await ask(email, true);
    },
    type(raw: string) {
      const value = cleanCode(raw);
      setCode(value);
      typed.current = value;
      if (error) setError(null);
      if (codeComplete(value) && value !== code) void check(value);
    },
    submit: () => check(code),
    changeEmail() {
      if (busy.current) return;
      setStep('email');
      setCode('');
      typed.current = '';
      setError(null);
      setDevCode(null);
    },
  };
}
