// 登入方式: Apple and Google, linked or with 連結, for every account; with a confirmed email also the
// email a sign-in code goes to, with 更換 Email (EmailForm.tsx), and an optional password, to sign
// in with the email and the password as well as with a code, changed with the current one. The
// password key is salted with the account's email (lib/crypto.ts), and POST /api/me/credentials
// takes only that email. Accounts without a confirmed email get AddEmailCard at the top of 我的
// for those (an account with Apple or Google linked only when it has an email to confirm).

import { useState, type FormEvent } from 'react';
import type { UserDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { API_BASE } from '../../config';
import { ApiError } from '../../lib/api';
import { passwordOk } from '../../lib/crypto';
import { errorMessage } from '../../lib/errors';
import { getLocale, useT } from '../../lib/i18n';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { appleLinkUrl, isRelayEmail } from '../auth/appleSignIn';
import { googleLinkUrl } from '../auth/googleSignIn';
import { Dash, ErrorLine } from '../auth/Receipt';
import { AppleLogo, GoogleG, startTap, useProviders } from '../auth/SignInButtons';
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

/** A link of this site as a whole URL: Button takes a path starting with "/" for a hash route. */
function siteUrl(url: string): string {
  return new URL(url, location.href).href;
}

/**
 * Apple and Google: 已連結, or 連結 where it can work in this tab (SignInButtons.tsx useProviders),
 * which goes to Apple or Google and comes back to 我的, which asks before it links that Apple ID or
 * Google account whatever its email there (Hide My Email above all); else 未連結. No unlink yet
 * (docs/SPEC.md section 10).
 */
function ProviderRows({ user }: { user: UserDTO }) {
  const { t, locale } = useT();
  const on = useProviders();
  // An email typed before codes links nothing until it is confirmed (the card at the top of 我的):
  // the Worker answers email_unconfirmed.
  const unconfirmed = !!user.email && user.emailVerified !== true;
  const rows = [
    {
      id: 'apple', name: 'Apple', logo: <AppleLogo className={s.providerLogoApple} />, linked: user.appleLinked === true, can: on.apple,
      url: () => siteUrl(appleLinkUrl(API_BASE, getLocale())), offline: t('沒有網路連線，連線後再連結 Apple。', 'No connection. Link Apple once you are online.'),
    },
    {
      id: 'google', name: 'Google', logo: <GoogleG className={s.providerLogo} />, linked: user.googleLinked === true, can: on.google,
      url: () => siteUrl(googleLinkUrl(API_BASE, getLocale())), offline: t('沒有網路連線，連線後再連結 Google。', 'No connection. Link Google once you are online.'),
    },
  ];
  return (
    <div className={s.providers}>
      <p className={s.lead}>{t('也可以用 Apple 或 Google 登入這個帳號，用的 Email 不一樣也沒關係。', 'You can also sign in to this account with Apple or Google, even with a different email there.')}</p>
      <ul className={s.providerList}>
        {rows.map(r => (
          <li key={r.id} className={s.provider} data-testid={'account-' + r.id}>
            <span className={s.providerName}>
              {r.logo}
              {r.name}
            </span>
            {r.linked ? (
              <span className={s.providerState}>{t('已連結', 'Linked')}</span>
            ) : r.can && unconfirmed ? (
              <span className={s.providerState} data-testid={'account-confirm-first-' + r.id}>{t('先確認 Email', 'Confirm email first')}</span>
            ) : r.can ? (
              <Button variant="secondary" size="sm" href={siteUrl(r.id === 'apple' ? appleLinkUrl(API_BASE, locale) : googleLinkUrl(API_BASE, locale))} onClick={startTap(r.url, r.offline)} data-testid={'account-link-' + r.id}>
                {t('連結', 'Link')}
              </Button>
            ) : (
              <span className={s.providerState}>{t('未連結', 'Not linked')}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The whole 登入方式 card body: with a confirmed email, the email (更換 Email; a Hide My Email
 * address says Apple forwards it) and a dashed rule; Apple and Google (ProviderRows) for every
 * account; then, with a confirmed email, a dashed rule and the password.
 */
export function SignInSection({ user }: { user: UserDTO }) {
  const { t } = useT();
  // An older client's field may be missing: not confirmed.
  const confirmed = !!user.email && user.emailVerified === true;
  return (
    <div className={s.credentials}>
      {confirmed && (
        <>
          <p className={s.lead}>
            {t('目前用 {email} 登入：在新的裝置輸入這個 Email，就會收到驗證碼。', 'You sign in with {email}: on a new device, enter it and we email you a code.', { email: user.email ?? '' })}
          </p>
          {isRelayEmail(user.email) && (
            <p className={s.lead} data-testid="account-relay">
              {t('這是 Apple「隱藏我的電子郵件」的地址：寄到這裡的信，Apple 會轉到你的信箱。', 'This is an Apple Hide My Email address: Apple forwards what is sent to it to your own inbox.')}
            </p>
          )}
          <ChangeEmail user={user} />
          <div className={s.pad}>
            <Dash />
          </div>
        </>
      )}
      <ProviderRows user={user} />
      {confirmed && (
        <>
          <div className={s.pad}>
            <Dash />
          </div>
          <CredentialsForm user={user} />
        </>
      )}
    </div>
  );
}
