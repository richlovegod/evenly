// 我的, on the award site's account cards: who you are (a sky card), Add to Home Screen on
// iPhone, sign-in protection, profile and payment details, language, devices, export, sign
// out, delete, owner tools and the app version. Light only, so there is no 外觀 choice.

import { useState } from 'react';
import type { Locale, MeDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ListRow } from '../../components/ListRow';
import { PageHeader } from '../../components/PageHeader';
import { Segmented } from '../../components/Segmented';
import { Skeleton } from '../../components/Spinner';
import { APP_VERSION } from '../../config';
import { appName } from '../../lib/brand';
import { downloadFile } from '../../lib/csv';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { Card, Dash, ErrorLine, Lead, Note, Slip } from '../auth/Receipt';
import { AccountActions } from './AccountActions';
import { CredentialsForm } from './CredentialsForm';
import { DevicesSection } from './DevicesSection';
import { InstallCard } from './InstallCard';
import { ProfileForm } from './ProfileForm';
import s from './Account.module.css';

function IdentitySlip({ me, deviceOnly }: { me: MeDTO; deviceOnly: boolean }) {
  const { t } = useT();
  const u = me.user;
  return (
    <Slip tint="water" aria-label={t('你的帳號', 'Your account')}>
      <div className={s.who}>
        <Avatar name={u.name} color={u.color} size={48} ring />
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

export function AccountPage() {
  const { t, zh } = useT();
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

      {!deviceOnly && (
        <Card title={t('登入方式', 'Sign-in')}>
          <CredentialsForm user={user} protect={false} />
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

      <p className={s.about}>{t('{app}，版本 {v}', '{app}, version {v}', { app: appName(zh), v: APP_VERSION })}</p>
    </div>
  );
}
