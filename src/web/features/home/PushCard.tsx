// 總覽: a small offer to turn on notifications, shown while they are off on this device, the
// person is in a group, and the card was not closed (evenly.pushCard.hidden). Its button turns
// them on right there; Safari shows the permission prompt only for a request made inside the
// tap, so the server's key is fetched while the card shows (preparePush). Drawn like the compact
// 加到主畫面 card next to it; the two never show together (iPhone Safari is needs-install).

import { useEffect, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { useT } from '../../lib/i18n';
import { enablePush, preparePush, usePushState } from '../../lib/push';
import { navigate } from '../../lib/router';
import { useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { pushErrorText } from '../account/NotificationsCard';
import { cx } from '../auth/Receipt';
import s from './PushCard.module.css';

const HIDDEN_KEY = 'evenly.pushCard.hidden';

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHidden(): void {
  try {
    localStorage.setItem(HIDDEN_KEY, '1');
  } catch {
    /* private mode: the card just shows again next time */
  }
}

export function PushCard({ className }: { className?: string }) {
  const { t } = useT();
  const signedIn = useStore(st => !!st.token);
  const me = useStore(st => st.me);
  const [hidden, setHidden] = useState(readHidden);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const inGroup = !!me && me.groups.length > 0;
  const { state } = usePushState(signedIn && inGroup && !hidden);
  const offer = signedIn && inGroup && !hidden && state === 'off';

  useEffect(() => {
    if (offer) preparePush();
  }, [offer]);

  if (!offer) return null;

  function hide() {
    writeHidden();
    setHidden(true);
  }

  async function enable() {
    setBusy(true);
    try {
      // First thing in the tap: Safari only shows the permission prompt from here.
      const r = await enablePush();
      if (r.state === 'on') {
        showToast({ message: t('已開啟通知', 'Notifications are on'), kind: 'success' });
      } else if (r.state === 'denied') {
        showToast({
          message: t('通知被擋下了，到「我的」看怎麼打開', 'Notifications are blocked. See how to allow them in Account.'),
          action: { label: t('怎麼打開', 'Show me'), run: () => navigate('/account') },
        });
      }
    } catch (err) {
      showToast({ message: pushErrorText(err), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={cx(s.card, className)} aria-labelledby={titleId} data-testid="home-push-card">
      <div className={s.head}>
        <span className={s.badge} aria-hidden="true">
          <Icon name="bell" size={18} />
        </span>
        <div className={s.headText}>
          <h2 id={titleId} className={s.title}>
            {t('開啟通知', 'Turn on notifications')}
          </h2>
          <p className={s.why}>
            {t('朋友記了一筆、有人還你錢，或有人加入群組時，就會通知你', 'Get a notification when a friend adds an expense, someone pays you back, or someone joins your group.')}
          </p>
        </div>
        <IconButton icon="close" label={t('不再顯示', 'Do not show again')} onClick={hide} size={20} data-testid="home-push-hide" />
      </div>
      <Button variant="secondary" icon="bell" loading={busy} onClick={() => void enable()} className={s.action} data-testid="home-push-enable">
        {t('開啟通知', 'Turn on notifications')}
      </Button>
    </section>
  );
}
