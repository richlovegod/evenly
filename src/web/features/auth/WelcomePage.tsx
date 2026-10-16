// 開始使用: what Evenly does, a sample receipt that prints out of the printer (the memorable
// element, DESIGN.md 2.1), and a name field. No email or password is needed to start.

import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Money } from '../../components/Money';
import { PageHeader, Wordmark } from '../../components/PageHeader';
import { TextField } from '../../components/TextField';
import { zhJoin } from '../../lib/describe';
import { errorMessage } from '../../lib/errors';
import { setLocale, useT } from '../../lib/i18n';
import { actions } from '../../lib/store';
import { InAppHint } from './InAppHint';
import { LangSwitch } from './LangSwitch';
import { BarePage, Dash, ErrorLine, Lead, LinkRow, Links, Note, Slip, usePrintOnce } from './Receipt';
import { goToReturn } from './session';
import s from './Auth.module.css';

const NAME_MAX = 60;

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The sample receipt: one dinner, three people, who owes you what. */
function SampleSlip() {
  const { t, zh, locale, date } = useT();
  // Prints the first time in a session, and again when the language changes its numbers.
  const printing = usePrintOnce('welcome', locale);
  const currency = zh ? 'JPY' : 'USD';
  const friends = zh ? ['Abbie', '佳穎'] : ['Abbie', 'Kevin'];
  return (
    <Slip printing={printing} aria-label={t('範例收據', 'Sample receipt')}>
      <p className={s.sampleHead}>
        <span>{t('範例', 'Example')}</span>
        <span className={s.sampleDate}>{date(todayISO(), 'md')}</span>
      </p>
      <Lead label={t('燒肉晚餐（你付的）', 'Dinner (you paid)')}>
        <Money amount={12600} currency={currency} tone="neutral" />
      </Lead>
      <Lead label={t('3 人平分，每人', 'Split 3 ways, each')} tone="mute">
        <Money amount={4200} currency={currency} />
      </Lead>
      <Dash />
      {friends.map(f => (
        <Lead key={f} label={t(zhJoin(f, '欠你'), '{name} owes you', { name: f })} tone="pos">
          <Money amount={4200} currency={currency} tone="positive" />
        </Lead>
      ))}
      <Note>{t('記一筆，誰該付誰自動算好', 'Log it once and who owes whom is worked out')}</Note>
    </Slip>
  );
}

export function WelcomePage() {
  const { t, locale } = useT();
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
    <BarePage
      band={
        <PageHeader
          large
          title={<Wordmark />}
          actions={<LangSwitch value={locale} onChange={setLocale} ids={{ zh: 'lang-zh', en: 'lang-en' }} />}
        />
      }
    >
      {/* Remounts on a language switch, so the sample prints again with its new numbers. */}
      <SampleSlip key={locale} />

      <p className={s.lede}>{t('出去玩、一起住的花費，記一筆就算好誰該付誰', 'Split costs on trips and at home: log it once and see who owes whom')}</p>

      <InAppHint className={s.block} />

      <form className={s.form} onSubmit={start} noValidate>
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
        <p className={s.fine}>{t('不用 Email，也不用密碼，之後想加再加', 'No email or password needed. You can add them later.')}</p>
      </form>

      <Links label={t('其他登入方式', 'Other ways in')}>
        <LinkRow to="/login" data-testid="welcome-login">{t('已有帳號？登入', 'Have an account? Sign in')}</LinkRow>
        <LinkRow to="/link" data-testid="welcome-link">{t('用其他裝置的登入碼', 'Use a code from another device')}</LinkRow>
      </Links>
    </BarePage>
  );
}
