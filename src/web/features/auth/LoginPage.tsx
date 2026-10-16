// 登入 with email and password. There is no email sender, so a lost password is reset by the site
// owner (a link from the admin page).

import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { TextField } from '../../components/TextField';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions } from '../../lib/store';
import { InAppHint } from './InAppHint';
import { BarePage, ErrorLine, LinkRow, Links, Note, Slip } from './Receipt';
import { goToReturn } from './session';
import s from './Auth.module.css';

export function LoginPage() {
  const { t } = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  async function submit(e?: FormEvent) {
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

  return (
    <BarePage band={<PageHeader title={t('登入', 'Sign in')} back="/welcome" />}>
      <Slip aria-label={t('用 Email 和密碼登入', 'Sign in with email and password')}>
        <form className={s.slipForm} onSubmit={submit} noValidate>
          <TextField
            bare
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
            maxLength={320}
            data-testid="login-email"
          />
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
        </form>
        <Note>{t('忘記密碼的話，請網站管理員幫你產生重設連結（我們不會寄 Email）', 'Forgot your password? Ask the site owner for a reset link (we never send email).')}</Note>
      </Slip>

      <InAppHint className={s.block} />

      <Links label={t('其他登入方式', 'Other ways in')}>
        <LinkRow to="/link">{t('用其他裝置的登入碼', 'Use a code from another device')}</LinkRow>
        <LinkRow to="/welcome">{t('還沒有帳號？只要名字就能開始', 'New here? Start with just a name')}</LinkRow>
      </Links>
    </BarePage>
  );
}
