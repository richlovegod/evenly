// 我的, on the award site's account cards: who you are (a sky card), the email that protects the
// account (加上 Email, or 確認 Email for one typed before codes), Add to Home Screen on iPhone,
// notifications, profile and payment details, language, 登入方式 (the confirmed email with 更換
// Email, and an optional password), devices, export, sign out, delete, owner tools and the app
// version. 登入方式 also says 已連結 Google when a Google account is linked. Light only, so there is
// no 外觀 choice.

import { useRef, useState } from 'react';
import type { Locale, MeDTO, UserDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ListRow } from '../../components/ListRow';
import { PageHeader } from '../../components/PageHeader';
import { Segmented } from '../../components/Segmented';
import { Skeleton } from '../../components/Spinner';
import { setViewportDebug, viewportDebugOn } from '../../components/ViewportDebug';
import { APP_VERSION } from '../../config';
import { appName } from '../../lib/brand';
import { downloadFile } from '../../lib/csv';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { Card, Dash, ErrorLine, Lead, Note, Slip } from '../auth/Receipt';
import { AccountActions } from './AccountActions';
import { SignInSection } from './CredentialsForm';
import { DevicesSection } from './DevicesSection';
import { AddEmailCard } from './EmailForm';
import { InstallCard } from './InstallCard';
import { NotificationsCard } from './NotificationsCard';
import { ProfileForm } from './ProfileForm';
import s from './Account.module.css';

/** How this account signs in, in a few words. */
function signInWords(u: UserDTO, t: (zh: string, en: string) => string): string {
  if (!u.email) return t('只有這台裝置', 'This device only');
  if (!u.emailVerified) return u.hasPassword ? t('密碼（Email 還沒確認）', 'Password (email not confirmed)') : t('Email 還沒確認', 'Email not confirmed');
  if (u.googleLinked) return u.hasPassword ? t('Email 驗證碼、Google 或密碼', 'Email code, Google or password') : t('Email 驗證碼或 Google', 'Email code or Google');
  return u.hasPassword ? t('Email 驗證碼或密碼', 'Email code or password') : t('Email 驗證碼', 'Email code');
}

function IdentitySlip({ me }: { me: MeDTO }) {
  const { t } = useT();
  const u = me.user;
  return (
    <Slip tint="water" aria-label={t('你的帳號', 'Your account')}>
      <div className={s.who}>
        <Avatar name={u.name} color={u.color} userId={u.id} avatar={u.avatar} size={48} ring />
        <div className={s.whoText}>
          <h2 className={s.whoName}>{u.name}</h2>
          <p className={s.whoSub}>{u.email ?? t('還沒有 Email', 'No email yet')}</p>
        </div>
      </div>
      <Dash />
      <Lead label={t('登入方式', 'Sign-in')}>{signInWords(u, t)}</Lead>
      <Lead label={t('主要幣別', 'Home currency')}>
        <span className={s.code}>{u.currency}</span>
      </Lead>
      <Lead label={t('群組', 'Groups')}>{t('{n} 個', '{n}', { n: me.groups.length })}</Lead>
      {!u.email ? (
        <Note>{t('加上 Email，換手機也能用驗證碼登入', 'Add your email to sign in on any phone with a code.')}</Note>
      ) : !u.emailVerified ? (
        <Note>{t('確認 Email 後，換手機也能用驗證碼登入', 'Confirm your email to sign in on any phone with a code.')}</Note>
      ) : null}
    </Slip>
  );
}

function LanguageSection() {
  const { t, locale } = useT();
  async function change(l: Locale) {
    try {
      await actions.updateMe({ locale: l });
    } catch (err) {
      // The language already changed on this device; only saving it to the account failed.
      showToast({ message: t('語言沒有存到帳號：{e}', 'The language was not saved to your account: {e}', { e: errorMessage(err) }), kind: 'error' });
    }
  }
  return (
    <Card title={t('語言', 'Language')}>
      <Segmented<Locale>
        label={t('語言', 'Language')}
        value={locale}
        onChange={l => void change(l)}
        options={[
          // Each language is named in itself, in both UIs.
          { value: 'zh-TW', label: '中文', testId: 'account-lang-zh' },
          { value: 'en', label: 'English', testId: 'account-lang-en' },
        ]}
      />
    </Card>
  );
}

function DataSection() {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  async function exportJson() {
    setBusy(true);
    try {
      const data = await actions.exportData();
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      downloadFile(`split-lab-${stamp}.json`, 'application/json', JSON.stringify(data, null, 2));
    } catch (err) {
      showToast({ message: errorMessage(err), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title={t('資料', 'Your data')}>
      <p className={s.lead}>{t('下載你看得到的所有群組、成員和費用（JSON 檔）', 'Download every group, member and expense you can see, as a JSON file.')}</p>
      <div className={s.pad}>
        <Button variant="secondary" icon="download" loading={busy} onClick={() => void exportJson()} data-testid="account-export">
          {t('匯出資料', 'Export data')}
        </Button>
      </div>
    </Card>
  );
}

/**
 * The app's name and version. Five taps on it within 3 s turn the keyboard debug overlay on or off
 * for this tab (components/ViewportDebug.tsx, DESIGN.md 9.5). A gesture rather than ?debug=vv:
 * typing into Chrome's address bar brings up a keyboard, and that keyboard cycle clears the iOS
 * state the overlay is there to catch. The line stays plain text for screen readers (no role), and
 * the taps never select it (Account.module.css .about).
 */
function AboutLine() {
  const { t, zh } = useT();
  const taps = useRef<number[]>([]);
  const onTap = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter(at => now - at < 3000), now];
    if (taps.current.length < 5) return;
    taps.current = [];
    const on = !viewportDebugOn();
    setViewportDebug(on);
    showToast({ message: on ? t('已開啟鍵盤除錯資訊', 'Keyboard debug on') : t('已關閉鍵盤除錯資訊', 'Keyboard debug off') });
  };
  return (
    <p className={s.about} onClick={onTap} data-testid="account-version">
      {t('{app}，版本 {v}', '{app}, version {v}', { app: appName(zh), v: APP_VERSION })}
    </p>
  );
}

export function AccountPage() {
  const { t } = useT();
  const me = useStore(st => st.me);
  const meError = useStore(st => st.meError);
  const meLoading = useStore(st => st.meLoading);

  const header = <PageHeader title={t('我的', 'Account')} back="/" />;

  if (!me) {
    return (
      <div className={s.page}>
        {header}
        {meError && !meLoading ? (
          <Slip>
            <ErrorLine>{errorMessage(meError)}</ErrorLine>
            <div className={s.gap} />
            <Button variant="secondary" icon="sync" onClick={() => void actions.loadMe()}>
              {t('再試一次', 'Try again')}
            </Button>
          </Slip>
        ) : (
          <Slip tint="water" aria-busy="true" aria-label={t('載入中', 'Loading')}>
            <Skeleton height={44} width="60%" />
            <div className={s.gap} />
            <Skeleton height={14} />
            <div className={s.gap} />
            <Skeleton height={14} width="80%" />
          </Slip>
        )}
      </div>
    );
  }

  const user = me.user;
  // No email: nothing but this device's session (or a code from it) ever signs in again.
  const deviceOnly = !user.email;
  // An older client's field may be missing: not confirmed.
  const confirmed = !!user.email && user.emailVerified === true;

  return (
    <div className={s.page}>
      {header}
      <IdentitySlip me={me} />

      {/* A name-only account is one cleared Safari away from being lost: that comes first. */}
      {!confirmed && <AddEmailCard user={user} />}

      <InstallCard className={s.card} />

      {/* Right under 加到主畫面: on iPhone that comes first, and this card points back up to it. */}
      <NotificationsCard />

      <ProfileForm user={user} />

      <LanguageSection />

      {confirmed && (
        <Card title={t('登入方式', 'Sign-in')}>
          <SignInSection user={user} />
        </Card>
      )}

      <DevicesSection deviceOnly={deviceOnly} />

      <DataSection />

      <AccountActions user={user} deviceOnly={deviceOnly} />

      {user.isAdmin && (
        <Card tint="yellow">
          <ListRow
            href="/admin"
            chevron
            leading={<span className={s.tile} aria-hidden="true"><Icon name="settings" size={20} /></span>}
            title={t('管理工具', 'Owner tools')}
            subtitle={t('誰註冊了、統計數字、重設密碼連結', 'Who signed up, counts and password reset links')}
            data-testid="account-admin"
          />
        </Card>
      )}

      <AboutLine />
    </div>
  );
}
