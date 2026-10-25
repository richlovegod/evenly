// 加上 Email, 確認 Email and 更換 Email on 我的: the address, then the code mailed to it (POST
// /api/me/email, CodeStep). The account's sign-in email is then confirmed, so on a new phone or
// browser a code sent to it signs in. A password's key is salted with the email (lib/crypto.ts),
// so a new address takes the password with it (passwordCleared): an account with a password is
// asked first.

import { useState, type FormEvent } from 'react';
import type { UserDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { confirmDialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { TextField } from '../../components/TextField';
import { t as tr, useT } from '../../lib/i18n';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { CodeStep } from '../auth/CodeStep';
import { cleanEmail, emailOk } from '../auth/emailCode';
import { ErrorLine } from '../auth/Receipt';
import { useEmailCode } from '../auth/useEmailCode';
import s from './Account.module.css';

/** A new address on an account with a password removes that password: say so before the code goes out. */
async function passwordGoesFirst(user: UserDTO, address: string): Promise<boolean> {
  if (!user.hasPassword || cleanEmail(address) === user.email) return true;
  return confirmDialog({
    title: tr('換成新的 Email？', 'Change your email?'),
    message: tr(
      '你的密碼是跟目前的 Email 一起算出來的，換成新的 Email 後，密碼就會移除。之後用新的 Email 收驗證碼登入，也可以再設一個新密碼。',
      'Your password is tied to your current email, so a new email removes it. You then sign in with a code sent to the new email, and you can set a new password.',
    ),
    confirmLabel: tr('換 Email', 'Change email'),
    cancelLabel: tr('先不要', 'Not now'),
    danger: true,
  });
}

/** The code flow for this account's email, with the toast that says what changed. */
function useAccountEmail(user: UserDTO, onDone?: () => void) {
  return useEmailCode({
    start: email => actions.addEmailStart(email),
    verify: async (email, code) => {
      const before = user.email;
      const r = await actions.addEmailVerify(email, code);
      const what = !before
        ? tr('已加上 Email，換手機也能用它登入', 'Email added. Use it to sign in on any phone.')
        : before === r.user.email
          ? tr('已確認 Email', 'Email confirmed')
          : tr('已更換 Email', 'Email changed');
      const cleared = r.passwordCleared ? tr('密碼已經移除，需要的話可以再設一個。', 'Your password was removed; set a new one if you like.') : '';
      showToast({ message: cleared ? what + tr('。', '. ') + cleared : what, kind: 'success', duration: cleared ? 6000 : undefined });
      onDone?.();
    },
  });
}

/**
 * An account without a confirmed email (a name only, or an email typed before codes): the yolk
 * card at the top of 我的. Once the code is in, the account's email is confirmed and the card goes.
 */
export function AddEmailCard({ user }: { user: UserDTO }) {
  const { t } = useT();
  const [address, setAddress] = useState(user.email ?? '');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const flow = useAccountEmail(user);
  const confirming = !!user.email;

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!emailOk(cleanEmail(address))) {
      setFieldError(t('請輸入正確的 Email', 'Enter a valid email address'));
      return;
    }
    if (!(await passwordGoesFirst(user, address))) return;
    await flow.send(address);
  }

  return (
    <section className={s.protect} aria-labelledby="account-protect-h" data-testid="account-protect">
      <div className={s.protectHead}>
        <span className={s.protectIcon} aria-hidden="true"><Icon name={confirming ? 'mail' : 'lock'} size={22} /></span>
        <h2 id="account-protect-h" className={s.protectTitle}>
          {confirming ? t('確認你的 Email', 'Confirm your email') : t('這個帳號只存在這台裝置上', 'This account lives only on this device')}
        </h2>
      </div>
      <p className={s.protectText}>
        {confirming
          ? t('寄一組驗證碼到你的 Email，確認它是你的。之後在新的裝置，用它收驗證碼就能登入。', 'We email you a code to confirm the address is yours. Then a code sent to it signs you in on any new device.')
          : t(
              '換手機或清除瀏覽器資料後，這個帳號就找不回來了。加上 Email，在任何裝置都能用驗證碼登入，群組和帳都還在。',
              'A new phone or cleared browser data would lose this account. Add your email to sign in on any device with a code, with all your groups.',
            )}
      </p>
      <div className={s.emailBlock}>
        {flow.step === 'email' ? (
          <form className={s.emailForm} onSubmit={send} noValidate>
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
                setFieldError(undefined);
              }}
              placeholder="name@example.com"
              maxLength={120}
              hint={t('只會寄登入用的驗證碼給你，不會寄廣告', 'We only email you sign-in codes, never ads.')}
              error={fieldError}
              data-testid="add-email-input"
            />
            {flow.error && <ErrorLine>{flow.error}</ErrorLine>}
            <Button type="submit" variant="primary" block icon="mail" loading={flow.sending} data-testid="add-email-start">
              {t('寄驗證碼', 'Send code')}
            </Button>
          </form>
        ) : (
          <CodeStep flow={flow} className={s.emailForm} />
        )}
      </div>
    </section>
  );
}

/** 更換 Email under 登入方式 (a confirmed email): the new address, then its code. */
export function ChangeEmail({ user }: { user: UserDTO }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const flow = useAccountEmail(user, () => {
    setOpen(false);
    setAddress('');
  });

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const next = cleanEmail(address);
    if (!emailOk(next)) {
      setFieldError(t('請輸入正確的 Email', 'Enter a valid email address'));
      return;
    }
    if (next === user.email) {
      setFieldError(t('這就是你現在的 Email', 'That is your email already'));
      return;
    }
    if (!(await passwordGoesFirst(user, address))) return;
    await flow.send(address);
  }

  function close() {
    flow.changeEmail();
    setOpen(false);
    setAddress('');
    setFieldError(undefined);
  }

  if (!open) {
    return (
      <div className={s.pad}>
        <Button variant="secondary" icon="edit" onClick={() => setOpen(true)} data-testid="change-email">
          {t('更換 Email', 'Change email')}
        </Button>
      </div>
    );
  }

  return (
    <div className={s.emailBlock}>
      {flow.step === 'email' ? (
        <form className={s.emailForm} onSubmit={send} noValidate>
          <TextField
            bare
            label={t('新的 Email', 'New email')}
            type="email"
            inputMode="email"
            autoComplete="email"
            enterKeyHint="send"
            value={address}
            onChange={v => {
              setAddress(v);
              setFieldError(undefined);
            }}
            placeholder="name@example.com"
            maxLength={120}
            autoFocus
            hint={user.hasPassword ? t('換了 Email，密碼就會移除', 'A new email removes your password') : undefined}
            error={fieldError}
            data-testid="change-email-input"
          />
          {flow.error && <ErrorLine>{flow.error}</ErrorLine>}
          <div className={s.emailActions}>
            <Button type="submit" variant="primary" icon="mail" loading={flow.sending} data-testid="change-email-send">
              {t('寄驗證碼', 'Send code')}
            </Button>
            <Button variant="ghost" onClick={close} data-testid="change-email-cancel">
              {t('取消', 'Cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <CodeStep flow={flow} className={s.emailForm} />
      )}
    </div>
  );
}
