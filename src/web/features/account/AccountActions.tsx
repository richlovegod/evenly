// 登出 and 刪除帳號. Signing out warns when something would be lost (a device-only account cannot
// come back; unsynced changes are dropped). Deleting asks twice, the second time for the password
// when the account has one.

import { useState, type FormEvent } from 'react';
import type { UserDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { confirmDialog } from '../../components/Dialog';
import { Section } from '../../components/Section';
import { Sheet } from '../../components/Sheet';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, getState, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { ErrorLine } from '../auth/Receipt';
import s from './Account.module.css';

export function AccountActions({ user, deviceOnly }: { user: UserDTO; deviceOnly: boolean }) {
  const { t, zh } = useT();
  const pending = useStore(st => st.outbox.length);
  const [leaving, setLeaving] = useState(false);
  const [askPassword, setAskPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function signOut() {
    const risks: string[] = [];
    if (deviceOnly) {
      risks.push(t('這個帳號沒有 Email 和密碼，登出後就登不回來了。建議先在上面加上 Email 和密碼。', 'This account has no email and password, so you could not sign back in. Add them above first.'));
    }
    const n = getState().outbox.length;
    if (n) risks.push(t('還有 {n} 筆變更沒同步，登出後會不見。', '{n} changes have not synced yet and would be lost.', { n }));
    if (risks.length) {
      const ok = await confirmDialog({
        title: t('確定要登出？', 'Sign out?'),
        message: risks.join(zh ? '' : ' '),
        confirmLabel: t('仍要登出', 'Sign out anyway'),
        cancelLabel: t('先不要', 'Not now'),
        danger: true,
      });
      if (!ok) return;
    }
    setLeaving(true);
    await actions.logout();
  }

  async function finishDelete(pw?: string) {
    setDeleting(true);
    setDeleteError(null);
    try {
      await actions.deleteAccount(pw);
      showToast({ message: t('帳號已刪除', 'Your account is deleted'), kind: 'success' });
    } catch (err) {
      setDeleting(false);
      const msg =
        err instanceof ApiError && err.code === 'invalid_credentials' ? t('密碼不對', 'That password is not correct') : errorMessage(err);
      if (pw === undefined) showToast({ message: msg, kind: 'error' });
      else setDeleteError(msg);
    }
  }

  async function startDelete() {
    const ok = await confirmDialog({
      title: t('刪除帳號？', 'Delete your account?'),
      message: t(
        '帳號會被刪除，所有裝置都會登出。群組裡的紀錄會留著，你的名字會變成還沒人認領的成員。這無法復原。',
        'Your account is deleted and every device is signed out. Groups keep their history, and your name stays as an unclaimed member. This cannot be undone.',
      ),
      confirmLabel: t('刪除帳號', 'Delete account'),
      cancelLabel: t('先不要', 'Not now'),
      danger: true,
    });
    if (!ok) return;
    if (user.hasPassword) {
      setPassword('');
      setDeleteError(null);
      setAskPassword(true);
      return;
    }
    await finishDelete();
  }

  function submitPassword(e?: FormEvent) {
    e?.preventDefault();
    if (deleting) return;
    if (!password) {
      setDeleteError(t('請輸入密碼', 'Enter your password'));
      return;
    }
    void finishDelete(password);
  }

  return (
    <Section title={t('帳號', 'Account')}>
      <div className={s.actions}>
        <Button variant="secondary" block icon="logout" loading={leaving} onClick={() => void signOut()} data-testid="account-logout">
          {t('登出', 'Sign out')}
        </Button>
        {pending > 0 && (
          <p className={s.hint}>{t('還有 {n} 筆變更等待同步', '{n} changes are waiting to sync', { n: pending })}</p>
        )}
        <Button variant="danger-quiet" block icon="trash" onClick={() => void startDelete()} data-testid="account-delete">
          {t('刪除帳號', 'Delete account')}
        </Button>
      </div>

      <Sheet
        open={askPassword}
        onClose={() => {
          if (!deleting) setAskPassword(false);
        }}
        title={t('輸入密碼來刪除帳號', 'Enter your password to delete the account')}
        footer={
          <Button variant="danger" block loading={deleting} onClick={() => submitPassword()} data-testid="account-delete-confirm">
            {t('刪除帳號', 'Delete account')}
          </Button>
        }
      >
        <form className={s.sheetForm} onSubmit={submitPassword} noValidate>
          <input className="sr-only" type="text" autoComplete="username" value={user.email ?? ''} readOnly tabIndex={-1} aria-hidden="true" />
          <TextField
            label={t('密碼', 'Password')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={v => {
              setPassword(v);
              setDeleteError(null);
            }}
            autoFocus
            maxLength={200}
            data-testid="account-delete-password"
          />
          {deleteError && <ErrorLine>{deleteError}</ErrorLine>}
        </form>
      </Sheet>
    </Section>
  );
}
