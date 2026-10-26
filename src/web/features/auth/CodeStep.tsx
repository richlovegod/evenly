// The second step of an email-code form: the code that was mailed. One field for the 6 digits
// (the number pad; autocomplete one-time-code, so iOS offers the code from Mail and Messages),
// checked as soon as the sixth digit is in; 重新寄送 a minute after a code went out; 換一個 Email
// back to the address. Drawn with the 8-character sign-in code's field (LinkPage), big rounded
// digits in an award field. Used by 開始使用, 登入, the join sheet and 我的; `children` come above
// the code (登入 asks for a name there when the email has no account yet).
// The step shows once the code was sent, after an await, so the code field takes focus as it
// mounts with a mouse only (lib/autoFocus.ts): on a phone iOS would raise no keyboard for it, and
// a tap on it raises the number pad (DESIGN.md 9.5).

import { useId, useRef, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { useAutoFocus } from '../../lib/autoFocus';
import { useT } from '../../lib/i18n';
import { useSecondsLeft } from '../account/linkCode';
import { cx, ErrorLine, Note } from './Receipt';
import type { EmailCodeFlow } from './useEmailCode';
import s from './Auth.module.css';

export function CodeStep({ flow, submitLabel, children, className }: { flow: EmailCodeFlow; submitLabel?: string; children?: ReactNode; className?: string }) {
  const { t } = useT();
  const inputId = useId();
  const helpId = useId();
  const wait = useSecondsLeft(flow.resendAt || null);
  const codeRef = useRef<HTMLInputElement>(null);
  useAutoFocus(codeRef, true);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    void flow.submit();
  }

  return (
    <form className={cx(s.codeStep, className)} onSubmit={submit} noValidate>
      <div className={s.sent}>
        <p className={s.sentTo}>{t('驗證碼已寄到 {email}', 'We sent a code to {email}', { email: flow.email })}</p>
        <p className={s.fine}>{t('沒收到的話，看看垃圾郵件匣', 'Not there? Check your spam folder.')}</p>
      </div>
      {children}
      <div className={cx(s.codeField, flow.error && s.codeBad)}>
        <label className={s.codeLabel} htmlFor={inputId}>{t('6 位數驗證碼', '6-digit code')}</label>
        <input
          ref={codeRef}
          id={inputId}
          className={cx(s.codeInput, s.digits)}
          value={flow.code}
          onChange={e => flow.type(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          aria-invalid={flow.error ? true : undefined}
          aria-describedby={helpId}
          data-testid="code-input"
        />
      </div>
      {flow.error && <ErrorLine>{flow.error}</ErrorLine>}
      <Button type="submit" variant="primary" size="lg" block loading={flow.verifying} data-testid="code-submit">
        {submitLabel ?? t('確認', 'Confirm')}
      </Button>
      <div className={s.codeActions}>
        <Button
          variant="secondary"
          size="sm"
          icon="sync"
          loading={flow.sending}
          disabled={wait > 0 || flow.verifying}
          onClick={() => void flow.resend()}
          data-testid="code-resend"
        >
          {wait > 0 ? t('重新寄送（{n} 秒）', 'Send again ({n} s)', { n: wait }) : t('重新寄送', 'Send again')}
        </Button>
        <Button variant="ghost" size="sm" disabled={flow.verifying} onClick={flow.changeEmail} data-testid="code-change-email">
          {t('換一個 Email', 'Use another email')}
        </Button>
      </div>
      <div id={helpId}>
        <Note>{t('驗證碼 10 分鐘內有效', 'The code works for 10 minutes.')}</Note>
        {/* Staging's test mode only (never production): a person testing without email still gets in. */}
        {flow.devCode && (
          <p className={s.fine} data-testid="code-dev">
            {t('測試模式：驗證碼是 {code}', 'Test mode: the code is {code}', { code: flow.devCode })}
          </p>
        )}
      </div>
    </form>
  );
}
