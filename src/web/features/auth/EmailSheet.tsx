// 用 Email 加入: the sheet the invite, claim and friend invite pages open for someone who is not
// signed in. The address, then the code mailed to it (CodeStep): it signs in to the account that
// has the address, or makes one with the name picked on the page, since every new account needs a
// confirmed email (a lost phone then never loses it). A page with no name to give (a friend
// invite) gets one here: when the address has no account yet, the code step asks for it, as 登入
// does. The page then joins, claims or accepts as it does for anyone signed in.

import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { CodeStep } from './CodeStep';
import { cleanEmail, emailOk } from './emailCode';
import { ErrorLine } from './Receipt';
import { useEmailCode } from './useEmailCode';
import s from './Auth.module.css';

const NAME_MAX = 60;

export function EmailSheet({ open, onClose, name, onSignedIn }: {
  open: boolean;
  onClose: () => void;
  /**
   * The new account's name (the member picked, or the name typed) when the address has none. Empty:
   * the sheet asks for one then.
   */
  name: string;
  /** Signed in: the page goes on with the join or claim. */
  onSignedIn: () => void;
}) {
  const { t } = useT();
  const [address, setAddress] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  // The code was right but no account has the address, and the page gave no name: the new one's.
  const [needName, setNeedName] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const given = name.trim();
  const flow = useEmailCode({
    start: email => actions.emailStart(email),
    verify: async (email, code) => {
      const n = given || typedName.trim();
      if (needName && !n) {
        setNameError(t('請輸入你的名字', 'Enter your name'));
        return;
      }
      const r = await actions.emailVerify({ email, code, ...(n ? { name: n } : {}) });
      if (!r.created) showToast({ message: t('歡迎回來，{name}', 'Welcome back, {name}', { name: r.user.name }), kind: 'success' });
      onSignedIn();
    },
    onVerifyError: err => {
      if (given || !(err instanceof ApiError) || err.code !== 'name_required') return false;
      setNeedName(true);
      return true;
    },
  });

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!emailOk(cleanEmail(address))) {
      setEmailError(t('請輸入正確的 Email', 'Enter a valid email address'));
      return;
    }
    setNeedName(false);
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
            // Focused as the sheet opens with a mouse only; on a phone the sheet takes focus and a
            // tap here raises the keyboard (TextField autoFocus, DESIGN.md 9.5).
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
        <CodeStep flow={flow} className={s.slipForm} submitLabel={needName ? t('建立帳號', 'Create account') : undefined}>
          {needName && (
            <>
              <p className={s.fine}>{t('這個 Email 還沒有帳號，輸入名字就會建立一個', 'No account uses this email yet. Enter a name to make one.')}</p>
              <TextField
                bare
                label={t('你的名字', 'Your name')}
                value={typedName}
                onChange={v => {
                  setTypedName(v);
                  setNameError(undefined);
                }}
                placeholder={t('名字或暱稱', 'Name or nickname')}
                autoComplete="nickname"
                enterKeyHint="go"
                maxLength={NAME_MAX}
                // Shows after the code was checked, an await: focused with a mouse only; on a phone
                // a tap here raises the keyboard (TextField autoFocus, DESIGN.md 9.5).
                autoFocus
                hint={t('朋友會看到這個名字，之後可以改', 'Friends see this name. You can change it later.')}
                error={nameError}
                data-testid="code-name"
              />
            </>
          )}
        </CodeStep>
      )}
    </Sheet>
  );
}
