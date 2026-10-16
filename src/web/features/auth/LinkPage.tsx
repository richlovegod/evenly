// 用登入碼登入: type the 8-character code shown on a signed-in device (我的 > 在其他裝置登入), or open
// its QR / link (#/link/<code>), which signs in right away.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { confirmDialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, getState, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { codeFromInput, codeReady, NEVER_IN_CODE, normalizeCode } from './code';
import { InAppHint } from './InAppHint';
import { BarePage, cx, ErrorLine, LinkRow, Links, Note, Slip } from './Receipt';
import { goToReturn } from './session';
import s from './Auth.module.css';

export function LinkPage({ code }: { code?: string }) {
  const { t, zh } = useT();
  const signedIn = useStore(st => !!st.token);
  const myName = useStore(st => st.me?.user.name ?? '');
  const [value, setValue] = useState(() => codeFromInput(code ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const autoTried = useRef(false);
  const inputId = useId();
  const helpId = useId();

  const misread = NEVER_IN_CODE.test(normalizeCode(value));
  const ready = codeReady(value);

  /** Signing in with a code replaces the account on this device: say what could be lost. */
  async function confirmSwitch(): Promise<boolean> {
    const st = getState();
    const user = st.me?.user;
    const parts = [
      t('這台裝置目前登入的是「{name}」。用登入碼登入後，會換成產生這組登入碼的帳號。', 'This device is signed in as {name}. The code signs it in to the account that made the code.', { name: user?.name ?? myName }),
    ];
    const risky = (user && !user.hasPassword) || st.outbox.length > 0;
    if (user && !user.hasPassword) {
      parts.push(t('目前這個帳號沒有 Email 和密碼，如果登入碼是別的帳號的，就回不來了。', 'The current account has no email and password, so if the code is for another account you could not come back to it.'));
    }
    if (st.outbox.length) {
      parts.push(t('還有 {n} 筆變更沒同步，換回這個帳號登入時會再送出。', '{n} changes have not synced yet; they will be sent when this account signs in again.', { n: st.outbox.length }));
    }
    return confirmDialog({
      title: t('換成另一個帳號？', 'Switch accounts?'),
      message: parts.join(zh ? '' : ' '),
      confirmLabel: t('用登入碼登入', 'Use the code'),
      cancelLabel: t('先不要', 'Not now'),
      danger: risky,
    });
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (sending.current) return;
    if (!ready) {
      setError(
        misread
          ? t('登入碼不會有 0、O、1、I、L，請再看一次', 'Codes never contain 0, O, 1, I or L. Check it again.')
          : t('登入碼有 8 個字，像 ABCD-2345', 'The code has 8 characters, like ABCD-2345.'),
      );
      return;
    }
    sending.current = true;
    if (getState().token && !(await confirmSwitch())) {
      sending.current = false;
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await actions.linkLogin(normalizeCode(value));
      showToast({ message: t('已登入', 'Signed in'), kind: 'success' });
      goToReturn();
    } catch (err) {
      sending.current = false;
      setBusy(false);
      setError(
        err instanceof ApiError && err.code === 'code_invalid'
          ? t('這組登入碼不對，或已經過期、用過了。請在另一台裝置重新產生一組。', 'That code is wrong, expired or already used. Make a new one on your other device.')
          : errorMessage(err),
      );
    }
  }

  // Opened from a QR code or a shared link: sign in right away (not over an existing sign-in).
  useEffect(() => {
    if (autoTried.current) return;
    autoTried.current = true;
    if (code && codeReady(code) && !getState().token) void submit();
    // Runs once for the code the page was opened with.
  }, []);

  const showError = error ?? (misread ? t('登入碼不會有 0、O、1、I、L，請再看一次', 'Codes never contain 0, O, 1, I or L. Check it again.') : null);

  return (
    <BarePage band={<PageHeader title={t('用登入碼登入', 'Sign in with a code')} back={signedIn ? '/account' : '/welcome'} />}>
      <Slip tint="yellow" aria-label={t('登入碼', 'Sign-in code')}>
        <form className={s.slipForm} onSubmit={submit} noValidate>
          <div className={cx(s.codeField, showError && s.codeBad)}>
            <label className={s.codeLabel} htmlFor={inputId}>{t('登入碼', 'Sign-in code')}</label>
            <input
              id={inputId}
              className={s.codeInput}
              value={value}
              onChange={e => {
                setValue(codeFromInput(e.target.value));
                setError(null);
              }}
              placeholder="XXXX-XXXX"
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="go"
              autoFocus={!code}
              aria-invalid={showError ? true : undefined}
              aria-describedby={helpId}
              data-testid="link-code"
            />
          </div>
          {showError && <ErrorLine>{showError}</ErrorLine>}
          <Button type="submit" variant="primary" size="lg" block loading={busy} data-testid="link-submit">
            {t('登入', 'Sign in')}
          </Button>
        </form>
        <div id={helpId}>
          <Note>{t('在已登入的裝置打開「我的」，點「在其他裝置登入」，就會看到登入碼和 QR code', 'On a signed-in device, open Account and tap Sign in on another device to see a code and a QR code.')}</Note>
          <Note>{t('登入碼 10 分鐘內有效，只能用一次', 'A code works for 10 minutes, once.')}</Note>
        </div>
      </Slip>

      {signedIn && myName && (
        <p className={s.info}>
          <Icon name="info" size={18} />
          <span>{t('這台裝置目前登入的是「{name}」', 'This device is signed in as {name}.', { name: myName })}</span>
        </p>
      )}

      <InAppHint className={s.block} />

      {!signedIn && (
        <Links label={t('其他登入方式', 'Other ways in')}>
          <LinkRow to="/login">{t('用 Email 和密碼登入', 'Sign in with email and password')}</LinkRow>
        </Links>
      )}
    </BarePage>
  );
}
