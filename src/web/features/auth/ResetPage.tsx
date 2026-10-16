// 重設密碼 from a link the site owner made on the admin page (30 minutes, one use). Shows whose
// account it is, takes the new password twice, and signs this device in; every other session is
// signed out by the server.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { passwordOk } from '../../lib/crypto';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { BarePage, clockTime, ErrorLine, LinkRow, Links, Note, Slip } from './Receipt';
import { goToReturn } from './session';
import s from './Auth.module.css';

type Info =
  | { state: 'loading' }
  | { state: 'ready'; email: string; expiresAt: string }
  | { state: 'invalid' }
  | { state: 'error'; message: string };

export function ResetPage({ token }: { token: string }) {
  const { t, zh, time } = useT();
  const me = useStore(st => st.me);
  const [info, setInfo] = useState<Info>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [fieldError, setFieldError] = useState<{ which: 'password' | 'again'; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  useEffect(() => {
    let alive = true;
    setInfo({ state: 'loading' });
    actions.resetInfo(token).then(
      r => {
        if (alive) setInfo({ state: 'ready', email: r.email, expiresAt: r.expiresAt });
      },
      err => {
        if (!alive) return;
        if (err instanceof ApiError && (err.code === 'code_invalid' || err.code === 'not_found')) setInfo({ state: 'invalid' });
        else setInfo({ state: 'error', message: errorMessage(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [token, attempt]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (sending.current || info.state !== 'ready') return;
    if (!passwordOk(password)) {
      setFieldError({ which: 'password', message: t('密碼至少要 8 個字元', 'Use at least 8 characters') });
      return;
    }
    if (password !== again) {
      setFieldError({ which: 'again', message: t('兩次輸入的密碼不一樣', 'The two passwords do not match') });
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await actions.resetPassword(token, password);
      showToast({ message: t('密碼已更新，其他裝置都已登出', 'Password changed. Other devices are signed out.'), kind: 'success' });
      goToReturn();
    } catch (err) {
      sending.current = false;
      setBusy(false);
      if (err instanceof ApiError && err.code === 'code_invalid') setInfo({ state: 'invalid' });
      else setError(errorMessage(err));
    }
  }

  const band = <PageHeader title={t('重設密碼', 'Reset password')} back={me ? '/account' : '/login'} />;

  if (info.state === 'loading') {
    return (
      <BarePage band={band}>
        <Slip aria-busy="true" aria-label={t('載入中', 'Loading')}>
          <Skeleton height={14} width="40%" />
          <div className={s.gap8} />
          <Skeleton height={22} width="80%" />
        </Slip>
      </BarePage>
    );
  }

  if (info.state === 'invalid' || info.state === 'error') {
    return (
      <BarePage band={band}>
        <Slip>
          <h2 className={s.slipTitle}>
            {info.state === 'invalid' ? t('這個重設連結不能用了', 'This reset link no longer works') : t('打不開這個重設連結', 'Could not open this reset link')}
          </h2>
          <p className={s.slipText}>
            {info.state === 'invalid'
              ? t('重設連結 30 分鐘內有效，而且只能用一次。請網站管理員再幫你產生一個。', 'Reset links work for 30 minutes, once. Ask the site owner for a new one.')
              : info.message}
          </p>
          {info.state === 'error' && (
            <Button variant="secondary" icon="sync" className={s.slipAction} onClick={() => setAttempt(a => a + 1)}>
              {t('再試一次', 'Try again')}
            </Button>
          )}
        </Slip>
        <Links>
          <LinkRow to={me ? '/' : '/login'}>{me ? t('回到總覽', 'Back to Home') : t('用 Email 和密碼登入', 'Sign in with email and password')}</LinkRow>
        </Links>
      </BarePage>
    );
  }

  const otherAccount = !!me && me.user.email !== info.email;

  return (
    <BarePage band={band}>
      <Slip aria-label={t('要重設的帳號', 'The account to reset')}>
        <p className={s.slipLabel}>{t('帳號', 'Account')}</p>
        <p className={s.slipEmail}>{info.email}</p>
        <Note>{t('這個連結 {time} 前有效，只能用一次', 'This link works until {time}, once.', { time: clockTime(info.expiresAt, zh, time) })}</Note>
      </Slip>

      {otherAccount && (
        <p className={s.info}>
          <Icon name="info" size={18} />
          <span>
            {t('這台裝置目前登入的是「{name}」，設定新密碼後會改用 {email} 登入', 'This device is signed in as {name}. After the reset it is signed in as {email}.', {
              name: me?.user.name ?? '',
              email: info.email,
            })}
          </span>
        </p>
      )}

      <form className={s.form} onSubmit={submit} noValidate>
        {/* Lets password managers save the new password for the right account. */}
        <input className="sr-only" type="text" autoComplete="username" value={info.email} readOnly tabIndex={-1} aria-hidden="true" />
        <TextField
          label={t('新密碼', 'New password')}
          type="password"
          autoComplete="new-password"
          enterKeyHint="next"
          value={password}
          onChange={v => {
            setPassword(v);
            setFieldError(null);
            setError(null);
          }}
          hint={t('至少 8 個字元', 'At least 8 characters')}
          error={fieldError?.which === 'password' ? fieldError.message : undefined}
          maxLength={200}
          data-testid="reset-password"
        />
        <TextField
          label={t('再輸入一次', 'Type it again')}
          type="password"
          autoComplete="new-password"
          enterKeyHint="go"
          value={again}
          onChange={v => {
            setAgain(v);
            setFieldError(null);
            setError(null);
          }}
          error={fieldError?.which === 'again' ? fieldError.message : undefined}
          maxLength={200}
          data-testid="reset-password-again"
        />
        {error && <ErrorLine>{error}</ErrorLine>}
        <Button type="submit" variant="primary" size="lg" block loading={busy} data-testid="reset-submit">
          {t('設定新密碼', 'Set new password')}
        </Button>
        <p className={s.fine}>{t('設定好之後，其他裝置都會被登出，要用新密碼重新登入', 'Afterwards every other device is signed out and needs the new password.')}</p>
      </form>
    </BarePage>
  );
}
