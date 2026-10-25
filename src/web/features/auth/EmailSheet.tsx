// 用 Email 加入: the sheet the invite and claim pages open for someone who is not signed in. The
// address, then the code mailed to it (CodeStep): it signs in to the account that has the
// address, or makes one with the name picked on the page, since every new account needs a
// confirmed email (a lost phone then never loses it). The page then joins or claims as it does
// for anyone signed in.

import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { TextField } from '../../components/TextField';
import { useT } from '../../lib/i18n';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { CodeStep } from './CodeStep';
import { cleanEmail, emailOk } from './emailCode';
import { ErrorLine } from './Receipt';
import { useEmailCode } from './useEmailCode';
import s from './Auth.module.css';

export function EmailSheet({ open, onClose, name, onSignedIn }: {
  open: boolean;
  onClose: () => void;
  /** The new account's name (the member picked, or the name typed) when the address has none. */
  name: string;
  /** Signed in: the page goes on with the join or claim. */
  onSignedIn: () => void;
}) {
  const { t } = useT();
  const [address, setAddress] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const flow = useEmailCode({
    start: email => actions.emailStart(email),
    verify: async (email, code) => {
      const r = await actions.emailVerify({ email, code, name: name.trim() });
      if (!r.created) showToast({ message: t('歡迎回來，{name}', 'Welcome back, {name}', { name: r.user.name }), kind: 'success' });
      onSignedIn();
    },
  });

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!emailOk(cleanEmail(address))) {
      setEmailError(t('請輸入正確的 Email', 'Enter a valid email address'));
      return;
    }
    await flow.send(address);
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!flow.verifying) onClose();
      }}
      // Short: the sheet's title sits between 取消 and the edge on a 320 px screen.
      title={t('用 Email 加入', 'Join by email')}
    >
      {flow.step === 'email' ? (
        <form className={s.slipForm} onSubmit={send} noValidate>
          <p className={s.fine}>
            {t('先確認你的 Email：換手機或換瀏覽器時，用它收驗證碼就能登入，帳都還在', 'Confirm your email first: on a new phone or browser, a code sent to it signs you in, with all your entries.')}
          </p>
          <TextField
            bare
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
            autoFocus
            error={emailError}
            data-testid="signin-email"
          />
          {flow.error && <ErrorLine>{flow.error}</ErrorLine>}
          <Button type="submit" variant="primary" size="lg" block loading={flow.sending} data-testid="signin-send">
            {t('寄驗證碼', 'Send code')}
          </Button>
        </form>
      ) : (
        <CodeStep flow={flow} className={s.slipForm} />
      )}
    </Sheet>
  );
}
