// Owner tools (#/admin, only for OWNER_EMAILS): 概況 counts, who signed up (searchable, newest
// first; a tap opens the account's details), and a password reset link for an email. No email is
// ever sent, so the owner passes the link on (LINE, iMessage); it works for 30 minutes, once.

import { useEffect, useState, type FormEvent } from 'react';
import type { AdminUserRow } from '../../../shared/types';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { href } from '../../lib/router';
import { actions, useStore } from '../../lib/store';
import { Card, ErrorLine, Slip } from '../auth/Receipt';
import { Overview, type BasicCounts } from './admin/Overview';
import { makeResetLink, ResetLinkResult, type ResetLinkState } from './admin/ResetLink';
import { UserList } from './admin/UserList';
import { UserSheet } from './admin/UserSheet';
import { useAdminUsers } from './admin/useAdminUsers';
import s from './AdminPage.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** The reset-link form: type someone's email, get a link to send them. */
function ResetForm() {
  const { t } = useT();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<ResetLinkState | null>(null);

  async function makeLink(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    const em = email.trim().toLowerCase();
    if (!EMAIL_RE.test(em)) {
      setError(t('請輸入正確的 Email', 'Enter a valid email address'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setLink(await makeResetLink(em));
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'not_found' ? t('沒有帳號使用這個 Email', 'No account uses this email') : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('重設密碼連結', 'Password reset link')} tint="yellow">
      <p className={s.lead}>
        {t('我們不寄 Email。替忘記密碼的人產生連結，再用 LINE 或簡訊傳給他。', 'We never send email. Make a link for someone who forgot their password, then send it to them yourself.')}
      </p>
      <form className={s.form} onSubmit={makeLink} noValidate>
        <TextField
          label={t('對方的 Email', 'Their email')}
          type="email"
          inputMode="email"
          autoComplete="off"
          value={email}
          onChange={v => {
            setEmail(v);
            setError(null);
          }}
          placeholder="name@example.com"
          maxLength={320}
          data-testid="admin-email"
        />
        {error && <ErrorLine>{error}</ErrorLine>}
        <Button type="submit" variant="primary" icon="link" loading={busy} data-testid="admin-reset-submit">
          {t('產生重設連結', 'Make reset link')}
        </Button>
      </form>
      {link && <ResetLinkResult link={link} testIdPrefix="admin-reset" />}
    </Card>
  );
}

export function AdminPage() {
  const { t } = useT();
  const me = useStore(st => st.me);
  const isOwner = !!me?.user.isAdmin;
  const list = useAdminUsers(isOwner);
  const [open, setOpen] = useState<AdminUserRow | null>(null);
  const [basic, setBasic] = useState<BasicCounts | null>(null);
  const listFailed = !list.stats && !!list.error;

  // The user list did not load (for example a Worker from before /api/admin/users): the counts
  // from /api/admin/stats still show.
  useEffect(() => {
    if (!isOwner || !listFailed) return;
    let alive = true;
    actions.adminStats().then(
      r => {
        if (alive) setBasic(r);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [isOwner, listFailed]);

  const header = <PageHeader title={t('管理工具', 'Owner tools')} back="/account" />;

  if (!me) {
    return (
      <div className={s.page}>
        {header}
        <Slip aria-busy="true" aria-label={t('載入中', 'Loading')}>
          <Skeleton height={120} />
        </Slip>
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className={s.page}>
        {header}
        <Slip>
          <p className={s.text}>{t('只有網站管理員能用這個頁面', 'Only the site owner can use this page.')}</p>
          <a className={s.back} href={href('/account')}>{t('回到「我的」', 'Back to Account')}</a>
        </Slip>
      </div>
    );
  }

  return (
    <div className={s.page}>
      {header}
      <Overview stats={list.stats} basic={basic} error={list.stats ? null : list.error} onRetry={list.retry} />
      <UserList list={list} onOpen={setOpen} />
      <ResetForm />
      <UserSheet user={open} onClose={() => setOpen(null)} />
    </div>
  );
}
