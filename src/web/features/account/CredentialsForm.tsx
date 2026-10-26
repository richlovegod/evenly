// 登入方式 for an account with a confirmed email: the email a sign-in code goes to, with 更換 Email
// (EmailForm.tsx), then an optional password, to sign in with the email and the password as well
// as with a code, changed with the current one. The password key is salted with the account's
// email (lib/crypto.ts), and POST /api/me/credentials takes only that email. Accounts without a
// confirmed email get AddEmailCard at the top of 我的 instead.

import { useState, type FormEvent } from 'react';
import type { UserDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { passwordOk } from '../../lib/crypto';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { Dash, ErrorLine } from '../auth/Receipt';
import { ChangeEmail } from './EmailForm';
import s from './Account.module.css';

type Field = 'password' | 'current';

/** The password part: set one (none yet), or change it with the current one. */
export function CredentialsForm({ user }: { user: UserDTO }) {
  const { t } = useT();
  const hasPassword = user.hasPassword;
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: Field; message: string } | null>(null);

  function fieldError(f: Field): string | undefined {
    return error?.field === f ? error.message : undefined;
  }

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (busy || !user.email) return;
    if (!passwordOk(password)) {
      setError({ field: 'password', message: hasPassword ? t('新密碼至少要 8 個字元', 'Use at least 8 characters for the new password') : t('密碼至少要 8 個字元', 'Use at least 8 characters') });
      return;
    }
    if (hasPassword && !current) {
      setError({ field: 'current', message: t('請輸入目前的密碼', 'Enter your current password') });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await actions.setCredentials({ email: user.email, password, ...(hasPassword ? { currentPassword: current } : {}) });
      showToast({ message: hasPassword ? t('已更新密碼', 'Password updated') : t('已設定密碼', 'Password set'), kind: 'success' });
      setPassword('');
      setCurrent('');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'invalid_credentials') setError({ field: 'current', message: t('目前的密碼不對', 'The current password is not correct') });
      else if (code === 'weak_password') setError({ field: 'password', message: t('密碼至少要 8 個字元', 'Use at least 8 characters') });
      else setError({ message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={s.fields} onSubmit={save} noValidate>
      <p className={s.lead}>
        {hasPassword
          ? t('也可以用 Email 和密碼登入。要改密碼，請輸入目前的密碼。', 'You can also sign in with your email and password. To change the password, enter the current one.')
          : t('也可以設一個密碼，用 Email 和密碼登入（選用）', 'You can also set a password, to sign in with your email and password (optional).')}
      </p>
      {/* Lets password managers save the password for the right account. */}
      <input className="sr-only" type="text" autoComplete="username" value={user.email ?? ''} readOnly tabIndex={-1} aria-hidden="true" />
      <TextField
        label={hasPassword ? t('新密碼', 'New password') : t('密碼', 'Password')}
        type="password"
        autoComplete="new-password"
        enterKeyHint={hasPassword ? 'next' : 'done'}
        value={password}
        onChange={v => {
          setPassword(v);
          setError(null);
        }}
        maxLength={200}
        hint={t('至少 8 個字元', 'At least 8 characters')}
        error={fieldError('password')}
        data-testid="account-password"
      />
      {hasPassword && (
        <TextField
          label={t('目前的密碼', 'Current password')}
          type="password"
          autoComplete="current-password"
          enterKeyHint="done"
          value={current}
          onChange={v => {
            setCurrent(v);
            setError(null);
          }}
          maxLength={200}
          error={fieldError('current')}
          data-testid="account-current-password"
        />
      )}
      {error && !error.field && <ErrorLine className={s.pad}>{error.message}</ErrorLine>}
      <div className={s.pad}>
        <Button type="submit" variant="secondary" icon="lock" loading={busy} data-testid="account-save-credentials">
          {hasPassword ? t('更新密碼', 'Update password') : t('設定密碼', 'Set password')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The whole 登入方式 card body: the email (更換 Email), 已連結 Google when a Google account is
 * linked (no unlink in v1: docs/SPEC.md section 10), a dashed rule, the password.
 */
export function SignInSection({ user }: { user: UserDTO }) {
  const { t } = useT();
  return (
    <div className={s.credentials}>
      <p className={s.lead}>
        {t('目前用 {email} 登入：在新的裝置輸入這個 Email，就會收到驗證碼。', 'You sign in with {email}: on a new device, enter it and we email you a code.', { email: user.email ?? '' })}
      </p>
      {user.googleLinked === true && (
        <p className={s.lead} data-testid="account-google">
          {t('已連結 Google：也可以按「使用 Google 帳戶登入」登入。', 'Google linked: you can also sign in with Continue with Google.')}
        </p>
      )}
      <ChangeEmail user={user} />
      <div className={s.pad}>
        <Dash />
      </div>
      <CredentialsForm user={user} />
    </div>
  );
}
