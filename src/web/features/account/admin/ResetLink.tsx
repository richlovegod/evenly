// A password reset link the owner passes on (LINE, iMessage): no email is ever sent. It works
// for 30 minutes, once, and a newer link replaces it. Used by the form on the owner page and by
// an account's detail sheet.

import { useT } from '../../../lib/i18n';
import { shareLink } from '../../../config';
import { copyText, shareOrCopy } from '../../../lib/share';
import { actions } from '../../../lib/store';
import { showToast } from '../../../lib/toast';
import { Button } from '../../../components/Button';
import { clockTime, Note } from '../../auth/Receipt';
import { formatCountdown, localDeadline, useSecondsLeft } from '../linkCode';
import s from './Admin.module.css';

export const RESET_TTL_MS = 30 * 60_000;

export interface ResetLinkState {
  email: string;
  url: string;
  expiresAt: string;
  /** Local clock time (ms) when the link stops working. */
  deadline: number;
}

/** Rebuild the server's link on this app's own address, with ?openExternalBrowser=1 for LINE. */
export function sendableLink(serverUrl: string): string {
  const i = serverUrl.indexOf('#/reset/');
  return i >= 0 ? shareLink(serverUrl.slice(i + 1)) : serverUrl;
}

/** Ask the server for a new reset link for this email (the old one stops working). */
export async function makeResetLink(email: string): Promise<ResetLinkState> {
  const r = await actions.adminResetLink(email);
  return { email, url: sendableLink(r.url), expiresAt: r.expiresAt, deadline: localDeadline(r.expiresAt, RESET_TTL_MS) };
}

/** The link as it will be sent, with its countdown, 複製 and 分享. Test ids: `${testIdPrefix}-link`, -copy, -share. */
export function ResetLinkResult({ link, testIdPrefix = 'admin-reset' }: { link: ResetLinkState; testIdPrefix?: string }) {
  const { t, zh, time: localTime } = useT();
  const time = (ts: string) => clockTime(ts, zh, localTime);
  const left = useSecondsLeft(link.deadline);

  async function copy() {
    const ok = await copyText(link.url);
    showToast({ message: ok ? t('已複製連結', 'Link copied') : t('沒辦法複製', 'Could not copy'), kind: ok ? 'success' : 'error' });
  }

  function share() {
    void shareOrCopy({
      title: t('吉諾分帳所重設密碼', "Reset your Gino's Split Lab password"),
      text: t('用這個連結設定新的吉諾分帳所密碼，{time} 前有效，只能用一次', "Set a new Gino's Split Lab password with this link. It works until {time}, once.", { time: time(link.expiresAt) }),
      url: link.url,
    });
  }

  return (
    <div className={s.result} aria-live="polite">
      <p className={s.resultKey}>{t('給 {email} 的重設連結', 'Reset link for {email}', { email: link.email })}</p>
      <p className={s.url} data-testid={testIdPrefix + '-link'}>{link.url}</p>
      <p className={s.expiry}>
        {left > 0
          ? t('{time} 前有效（還有 {left}），只能用一次', 'Works until {time} ({left} left), once.', { time: time(link.expiresAt), left: formatCountdown(left) })
          : t('這個連結過期了，請再產生一個', 'This link expired. Make a new one.')}
      </p>
      {left > 0 && (
        <div className={s.resultActions}>
          <Button variant="secondary" size="sm" icon="copy" onClick={() => void copy()} data-testid={testIdPrefix + '-copy'}>
            {t('複製', 'Copy')}
          </Button>
          <Button variant="secondary" size="sm" icon="share" onClick={share} data-testid={testIdPrefix + '-share'}>
            {t('分享', 'Share')}
          </Button>
        </div>
      )}
      <Note>{t('對方設定新密碼後，他的其他裝置都會被登出。新的連結會讓舊的失效。', 'After they set a new password, their other devices are signed out. A new link replaces the old one.')}</Note>
    </div>
  );
}
