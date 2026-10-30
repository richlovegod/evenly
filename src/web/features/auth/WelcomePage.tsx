// 開始使用, in the award site's login look: a sky picture (the floating mascot by a level
// balance on a hill, 中文 / English in its corner), the app's name and one line on what it does,
// then a yolk card with the name and the email and 寄驗證碼, and then the 6-digit code that was
// mailed (CodeStep). Every new account has a confirmed email from the start, so a new phone or a
// cleared browser never loses it; an email that has an account already signs in to it instead
// (歡迎回來). 使用 Apple 登入 and 使用 Google 帳戶登入 top the card where they can work
// (SignInButtons.tsx): the name and verified email Apple or Google gives make the account, or
// sign in to the one that has the email. Signing in
// and using a code from another device are links under the card. The Home Screen app's sign-in
// code (?install=) and a remembered page (an invite, a group) go on as before: App leaves this
// page once signed in, and goToReturn opens the remembered page (Google comes back to it).

import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Mascot } from '../../components/Mascot';
import { TextField } from '../../components/TextField';
import { appName } from '../../lib/brand';
import { setLocale, useT } from '../../lib/i18n';
import { href } from '../../lib/router';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { CodeStep } from './CodeStep';
import { cleanEmail, emailOk } from './emailCode';
import { InAppHint } from './InAppHint';
import { LangSwitch } from './LangSwitch';
import { BarePage, cx, ErrorLine } from './Receipt';
import { goToReturn } from './session';
import { claimedNotice, SignInButtons } from './SignInButtons';
import { useEmailCode } from './useEmailCode';
import s from './Auth.module.css';

const NAME_MAX = 60;

/** The picture: a drifting cloud, a hill, the mascot floating beside a level balance (帳平了). */
function Scene() {
  return (
    <svg className={s.scene} viewBox="0 0 120 80" aria-hidden="true" focusable="false">
      <g className={s.ink}>
        <path className={cx(s.cloud, 'drift')} d="M9 23h21a4.6 4.6 0 0 0-1.5-9A6.6 6.6 0 0 0 15.8 12 5.6 5.6 0 0 0 9 23z" />
        <path className={s.hill} d="M0 66q30-10 60 0t60 0v14H0z" />
        <g className={s.sway}>
          <path d="M88 70V43" />
          <path d="M82 70h12" />
          <path d="M74 43h28" />
          <path d="M74 43l-5 9M74 43l5 9M102 43l-5 9M102 43l5 9" />
          <path className={s.pan} d="M67 52h14a7 7 0 0 1-14 0z" />
          <path className={s.pan} d="M95 52h14a7 7 0 0 1-14 0z" />
          <circle className={s.knob} cx="88" cy="41" r="2.2" />
        </g>
      </g>
      <g className="float">
        <Mascot size={40} x={21} y={10} />
      </g>
    </svg>
  );
}

export function WelcomePage() {
  const { t, zh, locale } = useT();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [emailError, setEmailError] = useState<string | undefined>();
  const flow = useEmailCode({
    start: email => actions.emailStart(email),
    verify: async (email, code) => {
      const r = await actions.emailVerify({ email, code, name: name.trim() });
      if (!r.created) showToast({ message: t('歡迎回來，{name}', 'Welcome back, {name}', { name: r.user.name }), kind: 'success' });
      goToReturn();
      if (r.notice === 'claimed') void claimedNotice();
    },
  });

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const missingName = !name.trim();
    const badEmail = !emailOk(cleanEmail(address));
    if (missingName) setNameError(t('先輸入你的名字', 'Enter your name first'));
    if (badEmail) setEmailError(t('請輸入正確的 Email', 'Enter a valid email address'));
    if (missingName || badEmail) return;
    await flow.send(address);
  }

  return (
    <BarePage className={s.welcomePage}>
      <div className={s.welcome}>
        <div className={s.pic}>
          <LangSwitch className={s.lang} value={locale} onChange={setLocale} ids={{ zh: 'lang-zh', en: 'lang-en' }} />
          <Scene />
        </div>

        <h1 className={s.brand}>{appName(zh)}</h1>
        <p className={s.pitch}>{t('出去玩、一起住的花費，記一筆就算好誰該付誰', 'Split costs on trips and at home: log it once and see who owes whom')}</p>

        <InAppHint className={s.welcomeHint} />

        {flow.step === 'email' ? (
          <form className={s.aform} onSubmit={send} noValidate>
            <SignInButtons />
            <TextField
              label={t('你的名字', 'Your name')}
              value={name}
              onChange={v => {
                setName(v);
                setNameError(undefined);
              }}
              placeholder={t('名字或暱稱', 'Name or nickname')}
              autoComplete="nickname"
              enterKeyHint="next"
              maxLength={NAME_MAX}
              hint={t('朋友會在群組裡看到這個名字，之後可以改', 'Friends see this name in your groups. You can change it later.')}
              error={nameError}
              data-testid="welcome-name"
            />
            <TextField
              label="Email"
              type="email"
              inputMode="email"
              autoComplete="email"
              enterKeyHint="send"
              value={address}
              onChange={v => {
                setAddress(v);
                setEmailError(undefined);
              }}
              placeholder="name@example.com"
              maxLength={120}
              hint={t('換手機或換瀏覽器時，用這個 Email 收驗證碼登入', 'Use this email to get a sign-in code on a new phone or browser.')}
              error={emailError}
              data-testid="welcome-email"
            />
            {flow.error && <ErrorLine>{flow.error}</ErrorLine>}
            <Button type="submit" variant="primary" size="lg" block loading={flow.sending} data-testid="welcome-send">
              {t('寄驗證碼', 'Send code')}
            </Button>
            <p className={s.fineCenter}>{t('只會寄登入用的驗證碼給你，不會寄廣告', 'We only email you sign-in codes, never ads.')}</p>
          </form>
        ) : (
          <CodeStep flow={flow} className={s.aform} />
        )}

        <nav className={s.alinks} aria-label={t('其他登入方式', 'Other ways in')}>
          <a className={s.linkish} href={href('/login')} data-testid="welcome-login">{t('已有帳號？登入', 'Have an account? Sign in')}</a>
          <a className={s.linkish} href={href('/link')} data-testid="welcome-link">{t('用其他裝置的登入碼', 'Use a code from another device')}</a>
        </nav>
      </div>
    </BarePage>
  );
}
