// 登入方式. A device-only account (name only) gets a strong but friendly card: Safari may clear a
// site's data, so add an email and password. An account with a password can change either one,
// with the current password.

import { useId, useState, type FormEvent } from 'react';
import type { UserDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { passwordOk } from '../../lib/crypto';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { ErrorLine } from '../auth/Receipt';
import s from './Account.module.css';

/** The server's rule (routes/me.ts), checked here first so the message can say which field. */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

type Field = 'email' | 'password' | 'current';

export function CredentialsForm({ user, protect }: { user: UserDTO; protect: boolean }) {
  const { t } = useT();
  const hasPassword = user.hasPassword && !!user.email;
  const [email, setEmail] = useState(user.email ?? '');
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: Field; message: string } | null>(null);
  const titleId = useId();

  const cleanEmail = email.trim().toLowerCase();
  const emailChanged = cleanEmail !== (user.email ?? '');
  const somethingToSave = !hasPassword || emailChanged || password.length > 0;

  function fieldError(f: Field): string | undefined {
    return error?.field === f ? error.message : undefined;
  }

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 120) {
      setError({ field: 'email', message: t('請輸入正確的 Email', 'Enter a valid email address') });
      return;
    }
    if (!hasPassword && !passwordOk(password)) {
      setError({ field: 'password', message: t('密碼至少要 8 個字元', 'Use at least 8 characters') });
      return;
    }
    if (hasPassword) {
      if (!somethingToSave) return;
      if (password && !passwordOk(password)) {
        setError({ field: 'password', message: t('新密碼至少要 8 個字元', 'Use at least 8 characters for the new password') });
        return;
      }
      if (!current) {
        setError({ field: 'current', message: t('請輸入目前的密碼', 'Enter your current password') });
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      if (hasPassword) {
        // Changing only the email still needs a password: the key sent to the server is salted
        // with the email, so the current password is used again under the new one.
        await actions.setCredentials({ email: cleanEmail, password: password || current, currentPassword: current });
        showToast({ message: t('已更新登入方式', 'Sign-in details updated'), kind: 'success' });
      } else {
        await actions.setCredentials({ email: cleanEmail, password });
        showToast({ message: t('已儲存，換手機也能用 Email 和密碼登入', 'Saved. Sign in with this email and password on any device.'), kind: 'success' });
      }
      setPassword('');
      setCurrent('');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'invalid_credentials') setError({ field: 'current', message: t('目前的密碼不對', 'The current password is not correct') });
      else if (code === 'email_taken') setError({ field: 'email', message: t('這個 Email 已經被別的帳號用了', 'Another account already uses this email') });
      else if (code === 'validation') setError({ field: 'email', message: t('請輸入正確的 Email', 'Enter a valid email address') });
      else if (code === 'weak_password') setError({ field: 'password', message: t('密碼至少要 8 個字元', 'Use at least 8 characters') });
      else setError({ message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form className={s.fields} onSubmit={save} noValidate>
      <TextField
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="username"
        enterKeyHint="next"
        value={email}
        onChange={v => {
          setEmail(v);
          setError(null);
        }}
        placeholder="name@example.com"
        maxLength={120}
        hint={protect ? t('只用來登入，我們不會寄信給你', 'Only for signing in. We never send email.') : undefined}
        error={fieldError('email')}
        data-testid="account-email"
      />
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
        hint={hasPassword ? t('只改 Email 的話可以留空', 'Leave empty to change only the email') : t('至少 8 個字元', 'At least 8 characters')}
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
        <Button
          type="submit"
          variant={protect ? 'primary' : 'secondary'}
          block={protect}
          icon="lock"
          loading={busy}
          disabled={hasPassword && !somethingToSave}
          data-testid="account-save-credentials"
        >
          {hasPassword ? t('更新登入方式', 'Update sign-in') : t('儲存 Email 和密碼', 'Save email and password')}
        </Button>
      </div>
    </form>
  );

  if (protect) {
    return (
      <section className={s.protect} aria-labelledby={titleId}>
        <div className={s.protectHead}>
          <span className={s.protectIcon} aria-hidden="true"><Icon name="lock" size={22} /></span>
          <h2 id={titleId} className={s.protectTitle}>{t('這個帳號只存在這台裝置上', 'This account lives only on this device')}</h2>
        </div>
        <p className={s.protectText}>
          {t(
            'Safari 一段時間沒打開就可能清掉網站資料；換手機或清除瀏覽器資料後，這個帳號也找不回來。加上 Email 和密碼，在任何裝置都能登入，群組和帳都還在。',
            "Safari can clear a site's data when you have not opened it for a while, and a new phone or cleared browser data would lose this account. Add an email and password to sign in from any device, with all your groups.",
          )}
        </p>
        {form}
      </section>
    );
  }

  return (
    <div className={s.credentials}>
      <p className={s.lead}>
        {t('目前用 {email} 登入。要改 Email 或密碼，請輸入目前的密碼。', 'You sign in with {email}. To change the email or password, enter your current password.', { email: user.email ?? '' })}
      </p>
      {form}
    </div>
  );
}
