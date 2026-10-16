// Add to Home Screen. On iPhone the installed app has its own storage, separate from Safari, so
// it would start signed out: 加到主畫面 first puts a 10-minute one-time sign-in code in this page's
// address (actions.prepareInstall), then shows the steps; the new icon opens already signed in.
// Inside LINE, Facebook or Instagram the card asks to open the page in Safari first.
// Used on 我的 (full) and on Home (compact, dismissible); an outlined paper card on both.

import { useId, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Icon, type IconName } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { shareLink } from '../../config';
import { errorMessage } from '../../lib/errors';
import { t as tr, useT } from '../../lib/i18n';
import { isInAppBrowser, isIosSafari, isStandalone } from '../../lib/pwa';
import { navigate } from '../../lib/router';
import { copyText } from '../../lib/share';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { cx } from '../auth/Receipt';
import { isIos, isLineBrowser } from '../auth/session';
import { CODE_TTL_MS, clearCode, formatCountdown, makeCode, useCodeSlot, useNewSessionWatcher, useSecondsLeft } from './linkCode';
import s from './InstallCard.module.css';

const HIDDEN_KEY = 'evenly.installCard.hidden';
const OFFERED_KEY = 'evenly.installCard.offered';

type Env = 'ios' | 'inapp' | null;

function installEnv(): Env {
  if (isStandalone()) return null;
  if (isInAppBrowser()) return 'inapp';
  if (isIosSafari()) return 'ios';
  return null;
}

/** iPhone or iPad Safari outside the Home Screen app: the card has steps to offer. */
export function canOfferInstall(): boolean {
  return installEnv() === 'ios';
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* private mode: the card just shows again next time */
  }
}

/**
 * Right after joining or claiming on iPhone Safari: one toast per device that points at the
 * steps on 我的. A toast, not a card, so the group opens at once.
 */
export function offerInstallOnce(): void {
  if (!canOfferInstall() || readFlag(OFFERED_KEY)) return;
  writeFlag(OFFERED_KEY);
  showToast({
    message: tr('加到主畫面，Safari 就不會清掉你的登入', 'Add Evenly to your Home Screen so Safari keeps you signed in'),
    action: { label: tr('怎麼加', 'Show me'), run: () => navigate('/account') },
  });
}

const MINUTES = Math.round(CODE_TTL_MS / 60_000);

function Step({ n, icon, chip, children }: { n: number; icon?: IconName; chip?: string; children: ReactNode }) {
  return (
    <li className={s.step}>
      <span className={s.stepNum} aria-hidden="true">{n}</span>
      <span className={cx(s.stepIcon, chip && s.stepChip)} aria-hidden="true">
        {chip ? chip : icon ? <Icon name={icon} size={18} /> : null}
      </span>
      <span className={s.stepText}>{children}</span>
    </li>
  );
}

export function InstallCard({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { t } = useT();
  const env = useMemo(installEnv, []);
  const signedIn = useStore(st => !!st.token);
  const [hidden, setHidden] = useState(() => compact && readFlag(HIDDEN_KEY));
  const slot = useCodeSlot();
  const mine = slot && slot.purpose === 'install' ? slot : null;
  const left = useSecondsLeft(mine ? mine.deadline : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string[] | null>(null);
  const [done, setDone] = useState(false);
  const titleId = useId();

  // The Home Screen app signing in with the code shows up as a new session.
  useNewSessionWatcher(!!mine && left > 0, baseline, () => {
    setDone(true);
    clearCode('install');
  });

  if (!env || !signedIn) return null;
  if (compact && hidden && !mine && !done) return null;

  function hide() {
    writeFlag(HIDDEN_KEY);
    setHidden(true);
  }

  const close = compact ? (
    <IconButton icon="close" label={t('不再顯示', 'Do not show again')} onClick={hide} size={20} />
  ) : null;

  if (env === 'inapp') return <InAppCard compact={compact} close={close} className={className} titleId={titleId} />;

  async function start() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const before = await actions.listSessions().then(
        list => list.map(x => x.id),
        () => null,
      );
      await makeCode('install');
      setBaseline(before);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const why = t('加到主畫面後，就像 App 一樣，而且 Safari 不會清掉你的登入', 'On your Home Screen, Evenly opens like an app, and Safari will not clear your sign-in.');

  let body: ReactNode;
  if (done) {
    body = (
      <p className={s.done} role="status">
        <Icon name="check" size={18} />
        <span>{t('完成了，之後從主畫面的 Evenly 圖示打開就好，這個 Safari 分頁可以關掉', 'All set. From now on, open Evenly from its Home Screen icon. You can close this Safari tab.')}</span>
      </p>
    );
  } else if (mine && left > 0) {
    body = (
      <>
        <ol className={s.steps} aria-label={t('加到主畫面的步驟', 'Steps to add to the Home Screen')}>
          <Step n={1} icon="share">
            {t('點 Safari 的「分享」按鈕（iOS 26 先點網址列旁的「⋯」）', "Tap Safari's Share button (on iOS 26, tap ⋯ next to the address first)")}
          </Step>
          <Step n={2} icon="plus">{t('往下滑，選「加入主畫面」', 'Scroll down and choose Add to Home Screen')}</Step>
          <Step n={3} chip={t('新增', 'Add')}>{t('點右上角的「新增」', 'Tap Add in the top corner')}</Step>
          <Step n={4} icon="home">
            {t('{m} 分鐘內，從主畫面打開新的 Evenly 圖示，就會自動登入', 'Within {m} minutes, open the new Evenly icon on your Home Screen. It signs you in.', { m: MINUTES })}
          </Step>
        </ol>
        <p className={s.timer}>
          <span>{t('登入碼還有', 'Sign-in code valid for')}</span>
          <span className={s.time}>{formatCountdown(left)}</span>
          <button type="button" className={s.textBtn} onClick={() => clearCode('install')}>
            {t('取消', 'Cancel')}
          </button>
        </p>
      </>
    );
  } else {
    body = (
      <>
        {mine && left === 0 && (
          <p className={s.expired}>{t('登入碼過期了，再按一次就好', 'The sign-in code expired. Tap again for a new one.')}</p>
        )}
        {error && (
          <p className={s.error} role="alert">
            <Icon name="warning" size={16} />
            <span>{error}</span>
          </p>
        )}
        <Button variant="secondary" icon="home" loading={busy} onClick={() => void start()} className={s.action} data-testid="install-start">
          {t('加到主畫面', 'Add to Home Screen')}
        </Button>
      </>
    );
  }

  return (
    <section className={cx(s.card, compact && s.compact, className)} aria-labelledby={titleId} data-testid="install-card">
      <div className={s.head}>
        <span className={s.badge} aria-hidden="true"><Icon name="home" size={compact ? 18 : 20} /></span>
        <div className={s.headText}>
          <h2 id={titleId} className={s.title}>{t('加到主畫面', 'Add to Home Screen')}</h2>
          <p className={s.why}>{why}</p>
        </div>
        {close}
      </div>
      {body}
    </section>
  );
}

/** Inside LINE / Facebook / Instagram: open this page in Safari (or Chrome) first, keeping the sign-in. */
function InAppCard({ compact, close, className, titleId }: { compact: boolean; close: ReactNode; className?: string; titleId: string }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const slot = useCodeSlot();
  const ios = isIos();
  const line = isLineBrowser();
  const browser = ios ? 'Safari' : t('瀏覽器', 'your browser');
  // The link stops working when a newer code replaces it (one live code per account).
  const live = link && slot?.purpose === 'handoff' && link.endsWith('/link/' + slot.code) ? link : null;

  /**
   * A one-time code in the link signs the real browser in to this same account. LINE opens a
   * link with ?openExternalBrowser=1 in Safari or Chrome; elsewhere the link is shown to copy
   * with a second tap (browsers only let a tap copy right away, not after a network call).
   */
  async function handoff() {
    setBusy(true);
    try {
      const c = await makeCode('handoff');
      const next = shareLink('/link/' + c.code);
      setLink(next);
      if (line) location.href = next;
    } catch (err) {
      showToast({ message: errorMessage(err), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    const ok = await copyText(text);
    showToast({
      message: ok
        ? t('已複製，{m} 分鐘內貼到 {b} 的網址列打開，就會登入同一個帳號', 'Copied. Paste it into {b} within {m} minutes to stay signed in.', { m: MINUTES, b: browser })
        : t('沒辦法複製，請長按連結手動複製', 'Could not copy. Press and hold the link to copy it.'),
      kind: ok ? 'success' : 'error',
    });
  }

  return (
    <section className={cx(s.card, compact && s.compact, className)} aria-labelledby={titleId} data-testid="install-card">
      <div className={s.head}>
        <span className={s.badge} aria-hidden="true"><Icon name="info" size={compact ? 18 : 20} /></span>
        <div className={s.headText}>
          <h2 id={titleId} className={s.title}>{t('先用 {b} 打開', 'Open this in {b} first', { b: browser })}</h2>
          <p className={s.why}>
            {t('App 裡的瀏覽器會另外存資料，加不了主畫面，登入也可能留不住', 'In-app browsers keep their own data: they cannot add to the Home Screen and may lose your sign-in.')}
          </p>
        </div>
        {close}
      </div>
      {!line && (
        <p className={s.why}>
          {ios
            ? t('先產生登入連結並複製，再點右上角的「⋯」或分享按鈕，選「在 Safari 中開啟」，把連結貼到網址列', 'Make a sign-in link and copy it, then tap ⋯ or Share in the corner, choose Open in Safari, and paste the link into the address bar.')
            : t('先產生登入連結並複製，再點右上角的「⋮」，選「在瀏覽器中開啟」，把連結貼到網址列', 'Make a sign-in link and copy it, then tap ⋮ in the corner, choose Open in browser, and paste the link into the address bar.')}
        </p>
      )}
      {live && (
        <div className={s.handoff}>
          <p className={s.handoffLink}>{live}</p>
          <Button variant="secondary" size="sm" icon="copy" onClick={() => void copy(live)} data-testid="install-handoff-copy">
            {t('複製登入連結', 'Copy sign-in link')}
          </Button>
          <p className={s.why}>{t('{m} 分鐘內有效，只能用一次，不要傳給別人', 'Works for {m} minutes, once. Keep it to yourself.', { m: MINUTES })}</p>
        </div>
      )}
      {!live && (
        <Button variant="secondary" icon="link" loading={busy} onClick={() => void handoff()} className={s.action} data-testid="install-handoff">
          {line ? t('用 {b} 開啟，保持登入', 'Open in {b}, stay signed in', { b: ios ? 'Safari' : t('瀏覽器', 'browser') }) : t('產生登入連結', 'Make a sign-in link')}
        </Button>
      )}
    </section>
  );
}
