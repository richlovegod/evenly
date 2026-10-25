// 裝置: the sessions signed in to this account (sign out any other one), and 在其他裝置登入: a
// one-time code shown as XXXX-XXXX plus a QR code in a dashed code box, valid 10 minutes. While
// the code is up the list is polled, so the box can say when the new device is in.

import { useCallback, useEffect, useState } from 'react';
import type { SessionDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { confirmDialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { ListRow } from '../../components/ListRow';
import { QRCode } from '../../components/QRCode';
import { Skeleton } from '../../components/Spinner';
import { appLink, shareLink } from '../../config';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { copyText, shareOrCopy } from '../../lib/share';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { formatCode } from '../auth/code';
import { Card, ErrorLine, Note } from '../auth/Receipt';
import { CODE_TTL_MS, clearCode, formatCountdown, makeCode, useCodeSlot, useNewSessionWatcher, useSecondsLeft } from './linkCode';
import s from './Account.module.css';

const MINUTES = Math.round(CODE_TTL_MS / 60_000);

export function DevicesSection({ deviceOnly }: { deviceOnly: boolean }) {
  const { t, relative } = useT();
  const [sessions, setSessions] = useState<SessionDTO[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const slot = useCodeSlot();
  const code = slot && slot.purpose === 'device' ? slot : null;
  const left = useSecondsLeft(code ? code.deadline : null);
  const [busy, setBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string[] | null>(null);

  const load = useCallback(async (): Promise<SessionDTO[] | null> => {
    try {
      const list = await actions.listSessions();
      setSessions(list);
      setLoadError(null);
      return list;
    } catch (err) {
      setLoadError(errorMessage(err));
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useNewSessionWatcher(!!code && left > 0, baseline, fresh => {
    showToast({
      message: fresh.label ? t('「{d}」已登入', '{d} is signed in', { d: fresh.label }) : t('新的裝置已登入', 'The new device is signed in'),
      kind: 'success',
    });
    clearCode('device');
    void load();
  });

  async function newCode() {
    setBusy(true);
    setCodeError(null);
    try {
      const before = await load();
      await makeCode('device');
      setBaseline(before ? before.map(x => x.id) : null);
    } catch (err) {
      setCodeError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(x: SessionDTO) {
    const name = x.label || t('那台裝置', 'that device');
    const ok = await confirmDialog({
      title: t('讓「{d}」登出？', 'Sign out {d}?', { d: name }),
      message: deviceOnly
        ? t('這個帳號沒有 Email。那台裝置登出後，只能用新的登入碼再登入。', 'This account has no email. That device could only sign in again with a new code.')
        : t('那台裝置下次打開吉諾分帳所時要重新登入', 'That device will need to sign in again next time.'),
      confirmLabel: t('登出', 'Sign out'),
      danger: true,
    });
    if (!ok) return;
    try {
      await actions.revokeSession(x.id);
      setSessions(list => (list ? list.filter(y => y.id !== x.id) : list));
      showToast({ message: t('已讓「{d}」登出', '{d} is signed out', { d: name }), kind: 'success' });
    } catch (err) {
      showToast({ message: errorMessage(err), kind: 'error' });
    }
  }

  async function copyCode(c: string) {
    const ok = await copyText(formatCode(c));
    showToast({ message: ok ? t('已複製登入碼', 'Code copied') : t('沒辦法複製', 'Could not copy'), kind: ok ? 'success' : 'error' });
  }

  function shareCode(c: string) {
    void shareOrCopy({
      title: t('吉諾分帳所登入連結', "Gino's Split Lab sign-in link"),
      text: t('用這個連結在另一台裝置登入我的吉諾分帳所，{m} 分鐘內有效', "Sign in to my Gino's Split Lab account on another device with this link. It works for {m} minutes.", { m: MINUTES }),
      url: shareLink('/link/' + c),
    });
  }

  return (
    <Card title={t('裝置', 'Devices')}>
      <p className={s.lead}>{t('登入這個帳號的裝置', 'Devices signed in to this account')}</p>

      {sessions === null && !loadError && (
        <div className={s.pad} aria-busy="true">
          <Skeleton height={52} />
        </div>
      )}
      {loadError && (
        <div className={s.pad}>
          <ErrorLine>{loadError}</ErrorLine>
          <Button variant="ghost" size="sm" icon="sync" onClick={() => void load()}>
            {t('再試一次', 'Try again')}
          </Button>
        </div>
      )}
      {sessions && (
        <ul>
          {sessions.map(x => (
            <li key={x.id}>
              <ListRow
                leading={<span className={s.tile} aria-hidden="true"><Icon name="device" size={20} /></span>}
                title={x.label || t('未知的裝置', 'Unknown device')}
                subtitle={x.current ? t('這台裝置', 'This device') : t('上次使用：{when}', 'Last used {when}', { when: relative(x.lastUsedAt) })}
                trailing={
                  x.current ? undefined : (
                    <Button variant="secondary" size="sm" onClick={() => void revoke(x)} aria-label={t('讓「{d}」登出', 'Sign out {d}', { d: x.label || t('那台裝置', 'that device') })}>
                      {t('登出', 'Sign out')}
                    </Button>
                  )
                }
                data-testid="account-session"
                data-id={x.id}
              />
            </li>
          ))}
        </ul>
      )}

      <div className={s.linkBlock}>
        {code && (
          <div className={s.codePanel} aria-live="polite">
            {left > 0 ? (
              <>
                <p className={s.codeKey}>{t('登入碼', 'Sign-in code')}</p>
                <p className={s.codeValue} data-testid="account-link-code-value">{formatCode(code.code)}</p>
                <div className={s.qr}>
                  <QRCode text={appLink('/link/' + code.code)} size={168} />
                </div>
                <ol className={s.codeSteps}>
                  <li>{t('在新的裝置打開吉諾分帳所，點「用其他裝置的登入碼」，輸入上面這組代碼', "On the new device, open Gino's Split Lab, tap Use a code from another device, and type the code above.")}</li>
                  <li>{t('或用新裝置的相機掃這個 QR code', "Or scan this QR code with the new device's camera.")}</li>
                </ol>
                <p className={s.codeTimer}>
                  {t('還有', 'Valid for')} <span className={s.time}>{formatCountdown(left)}</span>
                  {t('，只能用一次', ', once')}
                </p>
                <div className={s.codeActions}>
                  <Button variant="secondary" size="sm" icon="copy" onClick={() => void copyCode(code.code)}>
                    {t('複製登入碼', 'Copy code')}
                  </Button>
                  <Button variant="secondary" size="sm" icon="share" onClick={() => shareCode(code.code)}>
                    {t('分享連結', 'Share link')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => clearCode('device')}>
                    {t('完成', 'Done')}
                  </Button>
                </div>
                <Note>{t('拿到登入碼的人就能登入你的帳號，只用在你自己的裝置上', 'Anyone with this code can sign in as you. Use it only on your own devices.')}</Note>
              </>
            ) : (
              <p className={s.codeExpired}>{t('登入碼過期了，再產生一組就好', 'The code expired. Make a new one.')}</p>
            )}
          </div>
        )}
        <Button variant="secondary" icon="qr" loading={busy} onClick={() => void newCode()} data-testid="account-link-code">
          {code && left > 0 ? t('換一組登入碼', 'Get a new code') : t('在其他裝置登入', 'Sign in on another device')}
        </Button>
        {codeError && <ErrorLine>{codeError}</ErrorLine>}
      </div>
    </Card>
  );
}
