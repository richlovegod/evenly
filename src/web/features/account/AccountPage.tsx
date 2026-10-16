// 我的: who you are (a slip from the printer), Add to Home Screen on iPhone, sign-in protection,
// profile and payment details, language, appearance, devices, export, sign out, delete, owner
// tools and the app version.

import { useState } from 'react';
import type { Locale, MeDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ListRow } from '../../components/ListRow';
import { PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { Segmented } from '../../components/Segmented';
import { Skeleton } from '../../components/Spinner';
import { APP_VERSION } from '../../config';
import { downloadFile } from '../../lib/csv';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { Dash, ErrorLine, Lead, Note, Slip } from '../auth/Receipt';
import { AccountActions } from './AccountActions';
import { CredentialsForm } from './CredentialsForm';
import { DevicesSection } from './DevicesSection';
import { InstallCard } from './InstallCard';
import { ProfileForm } from './ProfileForm';
import { setTheme, useTheme, type ThemeChoice } from './theme';
import s from './Account.module.css';

function IdentitySlip({ me, deviceOnly }: { me: MeDTO; deviceOnly: boolean }) {
  const { t } = useT();
  const u = me.user;
  return (
    <Slip aria-label={t('你的帳號', 'Your account')}>
      <div className={s.who}>
        <Avatar name={u.name} color={u.color} size={44} />
        <div className={s.whoText}>
          <h2 className={s.whoName}>{u.name}</h2>
          <p className={s.whoSub}>{u.email ?? t('還沒有 Email', 'No email yet')}</p>
        </div>
      </div>
      <Dash />
      <Lead label={t('登入方式', 'Sign-in')}>{deviceOnly ? t('只有這台裝置', 'This device only') : t('Email 和密碼', 'Email and password')}</Lead>
      <Lead label={t('主要幣別', 'Home currency')}>
        <span className={s.code}>{u.currency}</span>
      </Lead>
      <Lead label={t('群組', 'Groups')}>{t('{n} 個', '{n}', { n: me.groups.length })}</Lead>
      {deviceOnly && <Note>{t('加上 Email 和密碼，換手機也能登入', 'Add an email and password to sign in on any phone.')}</Note>}
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
    <Section title={t('語言', 'Language')}>
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
    </Section>
  );
}

function AppearanceSection() {
  const { t } = useT();
  const theme = useTheme();
  return (
    <Section title={t('外觀', 'Appearance')}>
      <Segmented<ThemeChoice>
        label={t('外觀', 'Appearance')}
        value={theme}
        onChange={setTheme}
        data-testid="account-theme"
        options={[
          { value: 'system', label: t('跟隨系統', 'System'), icon: 'device' },
          { value: 'light', label: t('淺色', 'Light'), icon: 'sun' },
          { value: 'dark', label: t('深色', 'Dark'), icon: 'moon' },
        ]}
      />
    </Section>
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
      downloadFile(`evenly-${stamp}.json`, 'application/json', JSON.stringify(data, null, 2));
    } catch (err) {
      showToast({ message: errorMessage(err), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title={t('資料', 'Your data')}>
      <p className={s.lead}>{t('下載你看得到的所有群組、成員和費用（JSON 檔）', 'Download every group, member and expense you can see, as a JSON file.')}</p>
      <div className={s.pad}>
        <Button variant="secondary" icon="download" loading={busy} onClick={() => void exportJson()} data-testid="account-export">
          {t('匯出資料', 'Export data')}
        </Button>
      </div>
    </Section>
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
          <div className={s.pad}>
            <ErrorLine>{errorMessage(meError)}</ErrorLine>
            <Button variant="secondary" icon="sync" onClick={() => void actions.loadMe()}>
              {t('再試一次', 'Try again')}
            </Button>
          </div>
        ) : (
          <Slip aria-busy="true" aria-label={t('載入中', 'Loading')}>
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
  const deviceOnly = !user.email || !user.hasPassword;

  return (
    <div className={s.page}>
      {header}
      <IdentitySlip me={me} deviceOnly={deviceOnly} />

      {/* A name-only account is one cleared Safari away from being lost: that comes first. */}
      {deviceOnly && <CredentialsForm user={user} protect />}

      <InstallCard className={s.card} />

      <ProfileForm user={user} />

      <LanguageSection />

      <AppearanceSection />

      {!deviceOnly && (
        <Section title={t('登入方式', 'Sign-in')}>
          <CredentialsForm user={user} protect={false} />
        </Section>
      )}

      <DevicesSection deviceOnly={deviceOnly} />

      <DataSection />

      <AccountActions user={user} deviceOnly={deviceOnly} />

      {user.isAdmin && (
        <Section>
          <ListRow
            href="/admin"
            chevron
            leading={<span className={s.tile} aria-hidden="true"><Icon name="settings" size={20} /></span>}
            title={t('管理工具', 'Owner tools')}
            subtitle={t('統計數字、重設密碼連結', 'Counts and password reset links')}
            data-testid="account-admin"
          />
        </Section>
      )}

      <p className={s.about}>{t('Evenly 分帳，版本 {v}', 'Evenly, version {v}', { v: APP_VERSION })}</p>
    </div>
  );
}
