// Shown inside LINE, Facebook, Instagram or another app's web view (session.ts isEmbeddedBrowser):
// their browsers keep their own storage, so a sign-in made there is lost later, and Google refuses
// to sign in there (使用 Google 帳戶登入 hides itself, and this card is what is left). LINE reopens
// the page in Safari or Chrome when the link carries ?openExternalBrowser=1; the others need a tap
// on their menu.

import { useId } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { copyText } from '../../lib/share';
import { useT } from '../../lib/i18n';
import { showToast } from '../../lib/toast';
import { cx } from './Receipt';
import { externalBrowserUrl, isEmbeddedBrowser, isIos, isLineBrowser } from './session';
import s from './Auth.module.css';

function appName(): string {
  const ua = navigator.userAgent;
  if (/Line\//.test(ua)) return 'LINE';
  if (/Instagram/.test(ua)) return 'Instagram';
  if (/FBAN|FBAV/.test(ua)) return 'Facebook';
  return '';
}

export function InAppHint({ className }: { className?: string }) {
  const { t } = useT();
  const titleId = useId();
  if (!isEmbeddedBrowser()) return null;
  const ios = isIos();
  const app = appName();
  const browser = ios ? 'Safari' : t('瀏覽器', 'your browser');

  async function copyLink() {
    const ok = await copyText(location.href);
    showToast({
      message: ok
        ? t('已複製連結，貼到 {b} 的網址列打開', 'Link copied. Paste it into {b}.', { b: browser })
        : t('沒辦法複製，請長按網址手動複製', 'Could not copy. Press and hold the address to copy it.'),
      kind: ok ? 'success' : 'error',
    });
  }

  return (
    <aside className={cx(s.hint, className)} aria-labelledby={titleId}>
      <span className={s.hintIcon} aria-hidden="true"><Icon name="info" size={20} /></span>
      <div className={s.hintBody}>
        <h2 id={titleId} className={s.hintTitle}>{t('用 {b} 打開，登入才會留著', 'Open this in {b} to stay signed in', { b: browser })}</h2>
        <p className={s.hintText}>
          {app
            ? t('你現在是在 {app} 裡面看這個頁面。{app} 的瀏覽器會另外存資料，之後可能就登不回來了。', 'You are viewing this page inside {app}. Its browser keeps its own data, so you could be signed out later.', { app })
            : t('你現在是在 App 裡面看這個頁面。它的瀏覽器會另外存資料，之後可能就登不回來了。', 'You are viewing this page inside an app. Its browser keeps its own data, so you could be signed out later.')}
        </p>
        {isLineBrowser() ? (
          <Button variant="secondary" size="sm" icon="link" className={s.hintAction} onClick={() => { location.href = externalBrowserUrl(); }}>
            {t('用 {b} 開啟', 'Open in {b}', { b: ios ? 'Safari' : t('瀏覽器', 'browser') })}
          </Button>
        ) : (
          <>
            <p className={s.hintText}>
              {ios
                ? t('點右上角的「⋯」或分享按鈕，選「在 Safari 中開啟」', 'Tap ⋯ or Share in the corner, then choose Open in Safari.')
                : t('點右上角的「⋮」，選「在瀏覽器中開啟」', 'Tap ⋮ in the corner, then choose Open in browser.')}
            </p>
            <Button variant="secondary" size="sm" icon="copy" className={s.hintAction} onClick={() => void copyLink()}>
              {t('複製連結', 'Copy link')}
            </Button>
          </>
        )}
      </div>
    </aside>
  );
}
