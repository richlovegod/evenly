// 通知 on 我的 (docs/PLAN-push-scan-cookies.md 2.3): whether this device shows notifications, and
// what to do next. On iPhone Safari: add the app to the Home Screen first (the 加到主畫面 card just
// above). Blocked: where to allow it again. Off: one button. On: which kinds of change notify
// (記帳, 還款, 有人加入, for the whole account), how many devices get them, a test notification,
// and turning this device off. The server's key is fetched when the card opens, so the tap on
// 開啟通知 can ask for permission before anything else (lib/push.ts).

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { PushPrefsDTO, PushStatusRes, PushTestRes } from '../../../shared/types';
import { Button } from '../../components/Button';
import { Icon, type IconName } from '../../components/Icon';
import { Skeleton } from '../../components/Spinner';
import { Switch } from '../../components/Switch';
import { ApiError } from '../../lib/api';
import { APP_NAME_ZH } from '../../lib/brand';
import { errorMessage } from '../../lib/errors';
import { t as tr, useT } from '../../lib/i18n';
import { disablePush, enablePush, loadPushStatus, savePushPrefs, sendTestPush, usePushState, type PushState } from '../../lib/push';
import { isIosDevice, isStandalone, updateApp } from '../../lib/pwa';
import { navigate } from '../../lib/router';
import { getState, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { count } from '../groups/plural';
import { Card, ErrorLine, Lead, Note, Tag } from '../auth/Receipt';
import a from './Account.module.css';
import s from './NotificationsCard.module.css';

/**
 * A failed push call in words: the API's own message, or `fallback` for the browser's errors
 * (technical) and for a 404 (here it means the server has no push yet, not a missing entry).
 */
function failText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.status !== 404 ? errorMessage(err) : fallback;
}

/** A failed attempt to turn notifications on or off, in words. */
export function pushErrorText(err: unknown, turning: 'on' | 'off' = 'on'): string {
  return failText(
    err,
    turning === 'on'
      ? tr('沒辦法開啟通知，請稍後再試', 'Could not turn on notifications. Try again later.')
      : tr('沒辦法關閉通知，請稍後再試', 'Could not turn off notifications. Try again later.'),
  );
}

const KINDS: { key: keyof PushPrefsDTO; zh: [string, string]; en: [string, string] }[] = [
  { key: 'expenses', zh: ['記帳', '有人新增你有參與的費用'], en: ['Expenses', 'Someone adds an expense you are part of'] },
  { key: 'payments', zh: ['還款', '有人記錄付給你、或你付出的還款'], en: ['Payments', 'Someone records a payment to you or from you'] },
  { key: 'joins', zh: ['有人加入', '有人加入你的群組，或把你加進群組'], en: ['Someone joins', 'Someone joins your group or adds you to one'] },
];

/** The 加到主畫面 card above (InstallCard): bring it into view and put the focus on its button. */
function showInstallCard(): void {
  const card = document.querySelector<HTMLElement>('[data-testid="install-card"]');
  if (!card) {
    navigate('/account');
    return;
  }
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
  const go = card.querySelector<HTMLElement>('[data-testid="install-start"]') ?? card.querySelector<HTMLElement>('button, a[href]');
  go?.focus({ preventScroll: true });
}

function testToast(r: PushTestRes): { message: string; kind: 'success' | 'error' | 'info' } {
  if (r.sent > 0) {
    const sent = tr('已傳送測試通知到 {n} 台裝置', 'Sent a test notification to ' + count(r.sent, 'device', 'devices'), { n: r.sent });
    const failed = r.failed > 0 ? tr('，{f} 台沒送到', ', ' + r.failed + ' could not be reached', { f: r.failed }) : '';
    return { message: sent + failed, kind: 'success' };
  }
  if (r.failed > 0) return { message: tr('測試通知沒送到，請稍後再試', 'The test notification did not go through. Try again later.'), kind: 'error' };
  return { message: tr('還沒有裝置會收到通知', 'No device gets notifications yet.'), kind: 'info' };
}

/** A sky note: what this device can do, and what to do next. */
function Say({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <p className={s.say}>
      <Icon name={icon} size={18} />
      <span>{children}</span>
    </p>
  );
}

export function NotificationsCard() {
  const { t } = useT();
  const session = useStore(st => st.token);
  const online = useStore(st => st.online);
  const { state } = usePushState(!!session);
  const [status, setStatus] = useState<PushStatusRes | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'enable' | 'disable' | 'test' | 'update' | null>(null);
  const [saving, setSaving] = useState<keyof PushPrefsDTO | null>(null);

  // Also the key for 開啟通知: fetched now, so the tap does not wait for it.
  const load = useCallback(async () => {
    const at = getState().token;
    try {
      const next = await loadPushStatus();
      if (getState().token !== at) return;
      setStatus(next);
      setStatusError(null);
    } catch (err) {
      if (getState().token === at) setStatusError(failText(err, tr('暫時讀不到通知設定，請稍後再試', 'Notification settings are unavailable right now. Try again later.')));
    }
  }, []);

  useEffect(() => {
    if (session) void load();
  }, [load, session, online]);

  if (!session) return null;

  async function enable() {
    setBusy('enable');
    try {
      // First thing in the tap: Safari only shows the permission prompt from here.
      const r = await enablePush();
      if (r.state === 'on') {
        const devices = r.devices;
        if (devices !== undefined) setStatus(st => (st ? { ...st, devices } : st));
        showToast({ message: t('已開啟通知', 'Notifications are on'), kind: 'success' });
        if (!status) void load();
      }
    } catch (err) {
      showToast({ message: pushErrorText(err), kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function disable() {
    setBusy('disable');
    try {
      await disablePush();
      // Not counted any more (load() brings the server's number).
      setStatus(st => (st ? { ...st, devices: Math.max(0, st.devices - 1) } : st));
      showToast({ message: t('這台裝置不會再收到通知', 'This device will no longer get notifications'), kind: 'success' });
      void load();
    } catch (err) {
      showToast({ message: pushErrorText(err, 'off'), kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    try {
      const r = await sendTestPush();
      showToast(testToast(r));
      if (r.removed > 0) void load();
    } catch (err) {
      const limited = err instanceof ApiError && err.status === 429;
      showToast({
        message: limited
          ? t('測試通知一小時最多傳 5 次，晚一點再試', 'You can send 5 test notifications an hour. Try again later.')
          : failText(err, t('測試通知沒送出，請稍後再試', 'The test notification was not sent. Try again later.')),
        kind: 'error',
      });
    } finally {
      setBusy(null);
    }
  }

  async function update() {
    setBusy('update');
    try {
      const r = await updateApp();
      if (r === 'downloading') {
        showToast({ message: t('正在下載新版本，好了會出現「更新」', 'Downloading the new version. An Update button shows up when it is ready.') });
      } else if (r === 'none') {
        showToast({ message: t('請關掉吉諾分帳所，再重新打開', "Close Gino's Split Lab and open it again.") });
      }
    } finally {
      setBusy(null);
    }
  }

  async function setPref(key: keyof PushPrefsDTO, value: boolean) {
    if (!status) return;
    const before = status.prefs[key];
    setStatus(st => (st ? { ...st, prefs: { ...st.prefs, [key]: value } } : st));
    setSaving(key);
    try {
      const prefs = await savePushPrefs({ [key]: value });
      setStatus(st => (st ? { ...st, prefs } : st));
    } catch (err) {
      setStatus(st => (st ? { ...st, prefs: { ...st.prefs, [key]: before } } : st));
      showToast({ message: failText(err, t('設定沒有存起來，請稍後再試', 'The setting was not saved. Try again later.')), kind: 'error' });
    } finally {
      setSaving(null);
    }
  }

  const ios = isIosDevice();
  const app = isStandalone();
  const devices = status?.devices ?? 0;
  // This device is off, but the account's other devices still get notifications.
  const others =
    state !== 'on' && devices > 0 ? (
      <Note>{t('你有 {n} 台其他裝置會收到通知', count(devices, 'other device gets', 'other devices get') + ' notifications.', { n: devices })}</Note>
    ) : null;

  let body: ReactNode;
  switch (state) {
    case null:
      body = (
        <div className={s.loading} aria-busy="true">
          <Skeleton height={44} />
        </div>
      );
      break;
    case 'needs-install':
      body = (
        <>
          <Say icon="home">
            {t('iPhone 和 iPad 要從主畫面打開吉諾分帳所，才收得到通知（iOS 16.4 以上）', "On iPhone and iPad, notifications only work when Gino's Split Lab is opened from the Home Screen (iOS 16.4 or later).")}
          </Say>
          <Button variant="secondary" icon="home" onClick={showInstallCard} className={s.action} data-testid="push-show-install">
            {t('先加到主畫面', 'Add to Home Screen first')}
          </Button>
          <Note>{t('已經加過了？從主畫面的圖示打開，再到「我的」開啟通知', 'Already added it? Open it from the Home Screen icon, then turn notifications on in Account.')}</Note>
          {others}
        </>
      );
      break;
    case 'unsupported':
      body = (
        <>
          <Say icon="info">
            {ios && app
              ? t('要 iOS 16.4 或更新的版本才收得到通知，可以到「設定 > 一般 > 軟體更新」更新', 'Notifications need iOS 16.4 or later. Update in Settings > General > Software Update.')
              : ios
                ? t('iPhone 和 iPad 要用 Safari 把吉諾分帳所加到主畫面，從主畫面打開才收得到通知', "On iPhone and iPad, add Gino's Split Lab to your Home Screen from Safari, then open it from there to get notifications.")
                : t('這個瀏覽器收不到通知，可以改用 Chrome、Edge、Firefox 或 Safari', 'This browser cannot show notifications. Try Chrome, Edge, Firefox or Safari.')}
          </Say>
          {others}
        </>
      );
      break;
    case 'waiting-worker':
      body = (
        <>
          <Say icon="sync">{t('App 要先更新到新版本，才能開啟通知', 'Update the app to the new version first, then turn on notifications.')}</Say>
          <Button variant="secondary" icon="sync" loading={busy === 'update'} onClick={() => void update()} className={s.action} data-testid="push-update">
            {t('更新', 'Update')}
          </Button>
          {others}
        </>
      );
      break;
    case 'denied':
      // Settings lists the app under its Home Screen name (index.html apple-mobile-web-app-title),
      // 吉諾分帳所 in either language.
      body = (
        <>
          <Say icon="bell">
            {ios && app
              ? t('通知被關掉了。到 iPhone 的「設定 > 通知 > {app}」打開「允許通知」，再回到這裡', 'Notifications are off. On your iPhone, open Settings > Notifications > {app}, turn on Allow Notifications, then come back here.', { app: APP_NAME_ZH })
              : app
                ? t('通知被擋下了。到裝置的設定裡，允許{app}傳送通知', "Notifications are blocked. Allow notifications for Gino's Split Lab in your device's settings.", { app: APP_NAME_ZH })
                : t('通知被擋下了。點網址列旁的網站設定，把「通知」改成允許，再重新整理這一頁', 'Notifications are blocked. Open the site settings next to the address bar, allow Notifications, then reload this page.')}
          </Say>
          {others}
        </>
      );
      break;
    case 'off': {
      // The server answers an empty key when it cannot sign pushes: do not ask for permission then.
      const noKey = !!status && !status.publicKey;
      body = (
        <>
          {noKey ? <Say icon="info">{t('伺服器還沒準備好通知，請晚一點再試', 'Notifications are not set up on the server yet. Try again later.')}</Say> : null}
          <Button
            variant="primary"
            icon="bell"
            loading={busy === 'enable'}
            disabled={noKey}
            onClick={() => void enable()}
            className={noKey ? s.action : s.cta}
            data-testid="push-enable"
          >
            {t('開啟通知', 'Turn on notifications')}
          </Button>
          {others}
        </>
      );
      break;
    }
    case 'on':
      body = (
        <>
          {status ? (
            <div className={s.kinds} role="group" aria-label={t('通知哪些事', 'What notifies you')}>
              {KINDS.map(k => (
                <div key={k.key} className={s.kind}>
                  <Switch
                    checked={status.prefs[k.key]}
                    onChange={v => void setPref(k.key, v)}
                    disabled={saving === k.key}
                    label={t(k.zh[0], k.en[0])}
                    description={t(k.zh[1], k.en[1])}
                    data-testid={'push-pref-' + k.key}
                  />
                </div>
              ))}
            </div>
          ) : statusError ? (
            <div className={s.retry}>
              <ErrorLine>{statusError}</ErrorLine>
              <Button variant="ghost" size="sm" icon="sync" onClick={() => void load()}>
                {t('再試一次', 'Try again')}
              </Button>
            </div>
          ) : (
            <div className={s.loading} aria-busy="true">
              <Skeleton height={52} />
            </div>
          )}
          {status ? <Lead label={t('收到通知的裝置', 'Devices notified')}>{t('{n} 台', '{n}', { n: devices })}</Lead> : null}
          <div className={s.actions}>
            <Button variant="secondary" size="sm" icon="bell" loading={busy === 'test'} disabled={busy === 'disable'} onClick={() => void test()} data-testid="push-test">
              {t('傳送測試通知', 'Send a test notification')}
            </Button>
            <Button variant="ghost" size="sm" loading={busy === 'disable'} disabled={busy === 'test'} onClick={() => void disable()} data-testid="push-disable">
              {t('關閉這台裝置的通知', 'Turn off on this device')}
            </Button>
          </div>
          <Note>{t('記帳、還款、有人加入這三項，套用到你所有的裝置', 'These three choices apply to all your devices.')}</Note>
        </>
      );
      break;
  }

  const tag = tagFor(state);
  return (
    <Card title={t('通知', 'Notifications')} action={tag} data-testid="account-push" data-state={state ?? undefined}>
      <p className={a.lead}>
        {t('朋友記了一筆、有人還你錢，或有人加入群組時，就會通知你', 'Get a notification when a friend adds an expense, someone pays you back, or someone joins your group.')}
      </p>
      {body}
    </Card>
  );
}

function tagFor(state: PushState | null): ReactNode {
  if (state === null) return null;
  if (state === 'on') return <Tag tint="water">{tr('已開啟', 'On')}</Tag>;
  if (state === 'denied') return <Tag tint="coral">{tr('被擋下', 'Blocked')}</Tag>;
  return <Tag>{tr('未開啟', 'Off')}</Tag>;
}
