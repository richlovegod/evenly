// 登入, on a yolk form card (the award site's .aform). The email first: 寄驗證碼 mails a 6-digit
// code, which signs in to the account that has the address (CodeStep); an address without an
// account asks for a name and makes one, so nobody has to start over on 開始使用. 用密碼登入 shows
// the email and password form for accounts that have a password (the App Review demo account),
// and a forgotten password needs no reset email: 忘記密碼？用驗證碼登入 goes back to the code with
// the email kept. 使用 Google 帳戶登入 tops the code card where it can work (GoogleButton.tsx), and
// a Google sign-in that came back here says why in that spot (googleError).

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { CodeStep } from './CodeStep';
import { cleanEmail, emailOk } from './emailCode';
import { clearGoogleError, googleError, GoogleSignIn } from './GoogleButton';
import { InAppHint } from './InAppHint';
import { BarePage, ErrorLine, LinkRow, Links, Slip } from './Receipt';
import { goToReturn } from './session';
import { useEmailCode } from './useEmailCode';
import s from './Auth.module.css';

const NAME_MAX = 60;

export function LoginPage() {
  const { t } = useT();
  // Why the Google sign-in that came back here did not happen; shown until this page goes.
  const [googleWhy] = useState(googleError);
  useEffect(() => clearGoogleError, []);
  const [mode, setMode] = useState<'code' | 'password'>('code');
  // One address for both forms, so switching between them keeps it.
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  // The code was right but no account has the address: the name of the new one.
  const [needName, setNeedName] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const flow = useEmailCode({
    start: address => actions.emailStart(address),
    verify: async (address, code) => {
      const n = name.trim();
      if (needName && !n) {
        setNameError(t('請輸入你的名字', 'Enter your name'));
        return;
      }
      const r = await actions.emailVerify({ email: address, code, ...(needName ? { name: n } : {}) });
      if (!r.created) showToast({ message: t('歡迎回來，{name}', 'Welcome back, {name}', { name: r.user.name }), kind: 'success' });
      goToReturn();
    },
    onVerifyError: err => {
      if (!(err instanceof ApiError) || err.code !== 'name_required') return false;
      setNeedName(true);
      return true;
    },
  });

  // ---------- the password form ----------
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    if (!emailOk(cleanEmail(email))) {
      setEmailError(t('請輸入正確的 Email', 'Enter a valid email address'));
      return;
    }
    setNeedName(false);
    await flow.send(email);
  }

  async function signInWithPassword(e?: FormEvent) {
    e?.preventDefault();
    if (sending.current) return;
    const em = email.trim();
    if (!em || !password) {
      setError(t('請輸入 Email 和密碼', 'Enter your email and password'));
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await actions.login({ email: em, password });
      goToReturn();
    } catch (err) {
      sending.current = false;
      setBusy(false);
      setError(errorMessage(err));
    }
  }

  function switchMode(next: 'code' | 'password') {
    setMode(next);
    setError(null);
    setEmailError(undefined);
    if (next === 'code' && flow.step === 'code') flow.changeEmail();
  }

  const emailField = (
    <TextField
      bare
      label="Email"
      type="email"
      inputMode="email"
      // The password form pairs it with current-password for password managers.
      autoComplete={mode === 'password' ? 'username' : 'email'}
      enterKeyHint={mode === 'password' ? 'next' : 'send'}
      value={email}
      onChange={v => {
        setEmail(v);
        setEmailError(undefined);
        setError(null);
      }}
      placeholder="name@example.com"
      maxLength={320}
      error={emailError}
      data-testid="login-email"
    />
  );

  return (
    <BarePage band={<PageHeader title={t('登入', 'Sign in')} back="/welcome" />}>
      {mode === 'code' ? (
        <Slip tint="yellow" aria-label={t('用 Email 收驗證碼登入', 'Sign in with a code sent to your email')}>
          {flow.step === 'email' ? (
            <form className={s.slipForm} onSubmit={sendCode} noValidate>
              <GoogleSignIn error={googleWhy} />
              {emailField}
              {flow.error && <ErrorLine>{flow.error}</ErrorLine>}
              <Button type="submit" variant="primary" size="lg" block loading={flow.sending} data-testid="login-send">
                {t('寄驗證碼', 'Send code')}
              </Button>
              <p className={s.fine}>{t('我們會寄 6 位數驗證碼到這個 Email，不用密碼', "We email you a 6-digit code. No password needed.")}</p>
              <Button variant="ghost" block icon="key" onClick={() => switchMode('password')} data-testid="login-password-toggle">
                {t('用密碼登入', 'Sign in with a password')}
              </Button>
            </form>
          ) : (
            <CodeStep flow={flow} className={s.slipForm} submitLabel={needName ? t('建立帳號', 'Create account') : undefined}>
              {needName && (
                <>
                  <p className={s.fine}>{t('這個 Email 還沒有帳號，輸入名字就會建立一個', 'No account uses this email yet. Enter a name to make one.')}</p>
                  <TextField
                    bare
                    label={t('你的名字', 'Your name')}
                    value={name}
                    onChange={v => {
                      setName(v);
                      setNameError(undefined);
                    }}
                    placeholder={t('名字或暱稱', 'Name or nickname')}
                    autoComplete="nickname"
                    enterKeyHint="go"
                    maxLength={NAME_MAX}
                    // Shows once the code was sent, after an await: focused with a mouse only; on a
                    // phone a tap here raises the keyboard (TextField autoFocus, DESIGN.md 9.5).
                    autoFocus
                    error={nameError}
                    data-testid="code-name"
                  />
                </>
              )}
            </CodeStep>
          )}
        </Slip>
      ) : (
        <Slip tint="yellow" aria-label={t('用 Email 和密碼登入', 'Sign in with email and password')}>
          <form className={s.slipForm} onSubmit={signInWithPassword} noValidate>
            {emailField}
            <TextField
              bare
              label={t('密碼', 'Password')}
              type="password"
              autoComplete="current-password"
              enterKeyHint="go"
              value={password}
              onChange={v => {
                setPassword(v);
                setError(null);
              }}
              maxLength={200}
              data-testid="login-password"
            />
            {error && <ErrorLine>{error}</ErrorLine>}
            <Button type="submit" variant="primary" size="lg" block loading={busy} data-testid="login-submit">
              {t('登入', 'Sign in')}
            </Button>
            <Button variant="ghost" block icon="mail" onClick={() => switchMode('code')} data-testid="login-code-toggle">
              {t('忘記密碼？用驗證碼登入', 'Forgot it? Sign in with a code')}
            </Button>
          </form>
        </Slip>
      )}

      <InAppHint className={s.block} />

      <Links label={t('其他登入方式', 'Other ways in')}>
        <LinkRow to="/link">{t('用其他裝置的登入碼', 'Use a code from another device')}</LinkRow>
        <LinkRow to="/welcome">{t('還沒有帳號？用 Email 開始', 'New here? Start with your email')}</LinkRow>
      </Links>
    </BarePage>
  );
}
