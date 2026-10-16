// 開始使用, in the award site's login look: a sky picture (the floating mascot by a level
// balance on a hill, 中文 / English in its corner), 「Evenly 分帳」 and one line on what it does,
// then the name field and the yolk 開始使用 pill on a yolk card. No email or password is needed
// to start; signing in and using a code from another device are links under it.

import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Mascot } from '../../components/Mascot';
import { TextField } from '../../components/TextField';
import { errorMessage } from '../../lib/errors';
import { setLocale, useT } from '../../lib/i18n';
import { href } from '../../lib/router';
import { actions } from '../../lib/store';
import { InAppHint } from './InAppHint';
import { LangSwitch } from './LangSwitch';
import { BarePage, cx, ErrorLine } from './Receipt';
import { goToReturn } from './session';
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
  const [nameError, setNameError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  async function start(e?: FormEvent) {
    e?.preventDefault();
    if (sending.current) return;
    const n = name.trim();
    if (!n) {
      setNameError(t('先輸入你的名字', 'Enter your name first'));
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await actions.signup({ name: n });
      goToReturn();
    } catch (err) {
      sending.current = false;
      setBusy(false);
      setError(errorMessage(err));
    }
  }

  return (
    <BarePage className={s.welcomePage}>
      <div className={s.welcome}>
        <div className={s.pic}>
          <LangSwitch className={s.lang} value={locale} onChange={setLocale} ids={{ zh: 'lang-zh', en: 'lang-en' }} />
          <Scene />
        </div>

        <h1 className={s.brand}>{zh ? 'Evenly 分帳' : 'Evenly'}</h1>
        <p className={s.pitch}>{t('出去玩、一起住的花費，記一筆就算好誰該付誰', 'Split costs on trips and at home: log it once and see who owes whom')}</p>

        <InAppHint className={s.welcomeHint} />

        <form className={s.aform} onSubmit={start} noValidate>
          <TextField
            label={t('你的名字', 'Your name')}
            value={name}
            onChange={v => {
              setName(v);
              setNameError(undefined);
              setError(null);
            }}
            placeholder={t('名字或暱稱', 'Name or nickname')}
            autoComplete="nickname"
            enterKeyHint="go"
            maxLength={NAME_MAX}
            hint={t('朋友會在群組裡看到這個名字，之後可以改', 'Friends see this name in your groups. You can change it later.')}
            error={nameError}
            data-testid="welcome-name"
          />
          {error && <ErrorLine>{error}</ErrorLine>}
          <Button type="submit" variant="primary" size="lg" block loading={busy} data-testid="welcome-start">
            {t('開始使用', 'Get started')}
          </Button>
          <p className={s.fineCenter}>{t('不用 Email，也不用密碼，之後想加再加', 'No email or password needed. You can add them later.')}</p>
        </form>

        <nav className={s.alinks} aria-label={t('其他登入方式', 'Other ways in')}>
          <a className={s.linkish} href={href('/login')} data-testid="welcome-login">{t('已有帳號？登入', 'Have an account? Sign in')}</a>
          <a className={s.linkish} href={href('/link')} data-testid="welcome-link">{t('用其他裝置的登入碼', 'Use a code from another device')}</a>
        </nav>
      </div>
    </BarePage>
  );
}
