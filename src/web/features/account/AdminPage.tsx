// Owner tools (#/admin): counts, and a password reset link for an email. No email is ever sent,
// so the owner passes the link on (LINE, iMessage); it works for 30 minutes, once.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { Skeleton } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { shareLink } from '../../config';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { href } from '../../lib/router';
import { copyText, shareOrCopy } from '../../lib/share';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { clockTime, ErrorLine, Lead, Note, Slip } from '../auth/Receipt';
import { formatCountdown, localDeadline, useSecondsLeft } from './linkCode';
import s from './AdminPage.module.css';

const RESET_TTL_MS = 30 * 60_000;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

interface Stats {
  users: number;
  groups: number;
  expenses: number;
}

interface ResetLink {
  email: string;
  url: string;
  expiresAt: string;
  deadline: number;
}

/** Rebuild the server's link on this app's own address, with ?openExternalBrowser=1 for LINE. */
function sendableLink(serverUrl: string): string {
  const i = serverUrl.indexOf('#/reset/');
  return i >= 0 ? shareLink(serverUrl.slice(i + 1)) : serverUrl;
}

export function AdminPage() {
  const { t, zh, num, time: localTime } = useT();
  const time = (ts: string) => clockTime(ts, zh, localTime);
  const me = useStore(st => st.me);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<ResetLink | null>(null);
  const left = useSecondsLeft(link ? link.deadline : null);
  const isOwner = !!me?.user.isAdmin;

  const loadStats = useCallback(async () => {
    setStatsError(null);
    try {
      setStats(await actions.adminStats());
    } catch (err) {
      setStatsError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (isOwner) void loadStats();
  }, [isOwner, loadStats]);

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
      const r = await actions.adminResetLink(em);
      setLink({ email: em, url: sendableLink(r.url), expiresAt: r.expiresAt, deadline: localDeadline(r.expiresAt, RESET_TTL_MS) });
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'not_found' ? t('沒有帳號使用這個 Email', 'No account uses this email') : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    const ok = await copyText(url);
    showToast({ message: ok ? t('已複製連結', 'Link copied') : t('沒辦法複製', 'Could not copy'), kind: ok ? 'success' : 'error' });
  }

  function share(l: ResetLink) {
    void shareOrCopy({
      title: t('Evenly 重設密碼', 'Reset your Evenly password'),
      text: t('用這個連結設定新的 Evenly 密碼，{time} 前有效，只能用一次', 'Set a new Evenly password with this link. It works until {time}, once.', { time: time(l.expiresAt) }),
      url: l.url,
    });
  }

  const header = <PageHeader title={t('管理工具', 'Owner tools')} back="/account" />;

  if (!me) {
    return (
      <div className={s.page}>
        {header}
        <div className={s.pad}>
          <Skeleton height={120} />
        </div>
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className={s.page}>
        {header}
        <div className={s.pad}>
          <p className={s.text}>{t('只有網站管理員能用這個頁面', 'Only the site owner can use this page.')}</p>
          <a className={s.back} href={href('/account')}>{t('回到「我的」', 'Back to Account')}</a>
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      {header}

      <Slip aria-label={t('目前的數量', 'Counts')}>
        {stats ? (
          <>
            <Lead label={t('使用者', 'People')}><span className={s.count}>{num(stats.users, 0)}</span></Lead>
            <Lead label={t('群組', 'Groups')}><span className={s.count}>{num(stats.groups, 0)}</span></Lead>
            <Lead label={t('費用', 'Expenses')}><span className={s.count}>{num(stats.expenses, 0)}</span></Lead>
            <Note>{t('不含已刪除的群組和費用', 'Deleted groups and expenses are not counted.')}</Note>
          </>
        ) : statsError ? (
          <>
            <ErrorLine>{statsError}</ErrorLine>
            <Button variant="ghost" size="sm" icon="sync" onClick={() => void loadStats()}>
              {t('再試一次', 'Try again')}
            </Button>
          </>
        ) : (
          <div aria-busy="true">
            <Skeleton height={14} />
            <div className={s.gap} />
            <Skeleton height={14} />
            <div className={s.gap} />
            <Skeleton height={14} />
          </div>
        )}
      </Slip>

      <Section title={t('重設密碼連結', 'Password reset link')}>
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

        {link && (
          <div className={s.result} aria-live="polite">
            <p className={s.resultKey}>{t('給 {email} 的重設連結', 'Reset link for {email}', { email: link.email })}</p>
            <p className={s.url} data-testid="admin-reset-link">{link.url}</p>
            <p className={s.expiry}>
              {left > 0
                ? t('{time} 前有效（還有 {left}），只能用一次', 'Works until {time} ({left} left), once.', { time: time(link.expiresAt), left: formatCountdown(left) })
                : t('這個連結過期了，請再產生一個', 'This link expired. Make a new one.')}
            </p>
            {left > 0 && (
              <div className={s.resultActions}>
                <Button variant="secondary" size="sm" icon="copy" onClick={() => void copy(link.url)} data-testid="admin-reset-copy">
                  {t('複製', 'Copy')}
                </Button>
                <Button variant="secondary" size="sm" icon="share" onClick={() => share(link)} data-testid="admin-reset-share">
                  {t('分享', 'Share')}
                </Button>
              </div>
            )}
            <Note>{t('對方設定新密碼後，他的其他裝置都會被登出。新的連結會讓舊的失效。', 'After they set a new password, their other devices are signed out. A new link replaces the old one.')}</Note>
          </div>
        )}
      </Section>
    </div>
  );
}
