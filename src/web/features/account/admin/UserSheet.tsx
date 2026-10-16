// One account in full, in a sheet: profile and how it signs in, payment details, its devices,
// its groups (a link when you are in that group too), what it did lately, and 產生重設密碼連結
// for an account with an email.

import { useEffect, useState } from 'react';
import type { AdminUserGroupDTO, AdminUserRes, AdminUserRow } from '../../../../shared/types';
import { Avatar } from '../../../components/Avatar';
import { Button } from '../../../components/Button';
import { GroupAvatar } from '../../../components/GroupAvatar';
import { Icon } from '../../../components/Icon';
import { Sheet } from '../../../components/Sheet';
import { Skeleton } from '../../../components/Spinner';
import { ApiError } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { useT } from '../../../lib/i18n';
import { href } from '../../../lib/router';
import { actions, useStore } from '../../../lib/store';
import { Card, clockTime, cx, ErrorLine, Lead, localDay, Note, Tag } from '../../auth/Receipt';
import { adminActivityText, shortDay, signsInAnywhere } from './adminText';
import { makeResetLink, ResetLinkResult, type ResetLinkState } from './ResetLink';
import s from './Admin.module.css';

type Load = { state: 'loading' } | { state: 'ready'; data: AdminUserRes } | { state: 'error'; message: string };

function GroupRow({ g, linked }: { g: AdminUserGroupDTO; linked: boolean }) {
  const { t, date } = useT();
  const body = (
    <>
      <GroupAvatar emoji={g.emoji} color={g.color} name={g.name} size={40} settled={g.deleted} />
      <span className={s.itemMain}>
        <span className={s.itemTop}>
          <span className={s.itemTitle}>{g.name}</span>
          {g.role === 'admin' && <Tag tint="yellow">{t('管理員', 'Admin')}</Tag>}
          {!g.active && <Tag tint="coral">{t('已離開', 'Left')}</Tag>}
          {g.deleted && <Tag>{t('已刪除', 'Deleted')}</Tag>}
        </span>
        <span className={s.itemMeta}>
          {[
            g.currency,
            t('{n} 人', '{n} members', { n: g.memberCount }),
            t('{n} 筆', '{n} entries', { n: g.entries }),
            g.lastDate ? t('最後一筆 {d}', 'latest {d}', { d: date(g.lastDate, 'md') }) : null,
          ]
            .filter(Boolean)
            .join(t('・', ' · '))}
        </span>
      </span>
      {linked && <Icon name="chevronRight" size={18} className={s.chev} />}
    </>
  );
  return linked ? (
    <a className={cx(s.item, s.itemLink)} href={href('/g/' + encodeURIComponent(g.id))} data-testid="admin-user-group">
      {body}
    </a>
  ) : (
    <div className={s.item} data-testid="admin-user-group">
      {body}
    </div>
  );
}

function ResetCard({ email }: { email: string | null }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<ResetLinkState | null>(null);

  async function make() {
    if (!email || busy) return;
    setBusy(true);
    setError(null);
    try {
      setLink(await makeResetLink(email));
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'not_found' ? t('沒有帳號使用這個 Email', 'No account uses this email') : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('重設密碼', 'Password reset')} tint="yellow">
      {email ? (
        <>
          <p className={s.resetLead}>{t('對方忘記密碼時，產生連結再用 LINE 或簡訊傳給他。我們不寄 Email。', 'If they forgot their password, make a link and send it to them yourself. We never send email.')}</p>
          <Button variant="primary" icon="link" loading={busy} onClick={() => void make()} data-testid="admin-user-reset">
            {link ? t('再產生一個', 'Make a new one') : t('產生重設密碼連結', 'Make a reset link')}
          </Button>
          {error && <ErrorLine className={s.more}>{error}</ErrorLine>}
          {link && <ResetLinkResult link={link} testIdPrefix="admin-user-reset" />}
        </>
      ) : (
        <p className={s.resetLead}>
          {t('這個帳號沒有 Email，不能用重設連結。請對方在已登入的裝置上打開「我的」，產生登入碼。', 'This account has no email, so a reset link cannot work. They can make a sign-in code on a signed-in device (Account page).')}
        </p>
      )}
    </Card>
  );
}

function Detail({ row }: { row: AdminUserRow }) {
  const { t, zh, date, time: localTime, relative } = useT();
  const me = useStore(st => st.me);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoad({ state: 'loading' });
    actions.adminUser(row.id).then(
      data => {
        if (alive) setLoad({ state: 'ready', data });
      },
      err => {
        if (alive) setLoad({ state: 'error', message: errorMessage(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [row.id, attempt]);

  const data = load.state === 'ready' ? load.data : null;
  const u = data?.user ?? row;
  const anywhere = signsInAnywhere(u);
  const myGroups = new Set((me?.groups ?? []).map(g => g.id));
  const when = (ts: string) => `${date(localDay(ts), 'long')} ${clockTime(ts, zh, localTime)}`;
  const pay = data
    ? [
        data.user.venmo ? { key: 'venmo', label: 'Venmo', value: '@' + data.user.venmo } : null,
        data.user.paypal ? { key: 'paypal', label: 'PayPal.me', value: data.user.paypal } : null,
        data.user.payInfo ? { key: 'other', label: t('其他', 'Other'), value: data.user.payInfo } : null,
      ].filter((x): x is { key: string; label: string; value: string } => !!x)
    : [];

  return (
    <div className={s.detail} data-testid="admin-user-detail" data-id={row.id}>
      <div className={s.profile}>
        <Avatar name={u.name} color={u.color} size={56} />
        <div className={s.profileText}>
          <p className={s.profileName}>{u.name}</p>
          <p className={cx(s.profileSub, !u.email && s.noEmail)}>{u.email ?? t('沒有 Email（只在這台裝置）', 'No email (on their device only)')}</p>
          <p className={s.profileTags}>
            {u.isOwner && <Tag tint="yellow">{t('管理員', 'Owner')}</Tag>}
            <Tag tint={anywhere ? 'water' : 'coral'}>{anywhere ? t('有密碼', 'Has a password') : t('只在裝置上', 'Device only')}</Tag>
          </p>
        </div>
      </div>

      <Card title={t('帳號', 'Account')}>
        <Lead label={t('加入', 'Joined')}>{when(u.createdAt)}</Lead>
        <Lead label={t('最近上線', 'Last seen')}>{u.lastActiveAt ? relative(u.lastActiveAt) : t('沒有登入中的裝置', 'Not signed in anywhere')}</Lead>
        <Lead label={t('登入方式', 'Sign-in')}>
          {anywhere ? t('Email 和密碼', 'Email and password') : u.email ? t('只在裝置上（沒有密碼）', 'Device only (no password)') : t('只在裝置上（沒有 Email）', 'Device only (no email)')}
        </Lead>
        <Lead label={t('語言', 'Language')}>{u.locale === 'en' ? 'English' : '中文'}</Lead>
        <Lead label={t('主要幣別', 'Home currency')}>{u.currency}</Lead>
        <Lead label={t('群組', 'Groups')}>{t('{n} 個', '{n}', { n: u.groups })}</Lead>
        <Lead label={t('費用', 'Expenses')}>
          {u.lastEntryAt
            ? t('{n} 筆，最後一筆 {d}', '{n}, latest {d}', { n: u.entries, d: shortDay(u.lastEntryAt) })
            : t('{n} 筆', '{n}', { n: u.entries })}
        </Lead>
        <p className={s.idLine}>
          {t('帳號 ID', 'Account ID')} <span className={s.id}>{u.id}</span>
        </p>
      </Card>

      {load.state === 'loading' && (
        <Card aria-busy="true" aria-label={t('載入中', 'Loading')}>
          <Skeleton height={14} width="50%" />
          <div className={s.skelGap} />
          <Skeleton height={40} />
          <div className={s.skelGap} />
          <Skeleton height={40} />
        </Card>
      )}

      {load.state === 'error' && (
        <Card>
          <ErrorLine>{load.message}</ErrorLine>
          <Button variant="secondary" size="sm" icon="sync" className={s.more} onClick={() => setAttempt(a => a + 1)}>
            {t('再試一次', 'Try again')}
          </Button>
        </Card>
      )}

      {data && (
        <>
          {pay.length > 0 && (
            <Card title={t('收款方式', 'How to pay them')}>
              {pay.map(p => (
                <Lead key={p.key} label={p.label}>
                  <span className={p.key === 'other' ? s.pre : undefined}>{p.value}</span>
                </Lead>
              ))}
            </Card>
          )}

          <Card title={t('裝置（{n}）', 'Devices ({n})', { n: data.sessions.length })}>
            {data.sessions.length ? (
              <ul className={s.items}>
                {data.sessions.map((x, i) => (
                  <li key={i}>
                    <div className={s.item}>
                      <span className={s.deviceIcon} aria-hidden="true"><Icon name="device" size={18} /></span>
                      <span className={s.itemMain}>
                        <span className={s.itemTitle}>{x.label || t('未知的裝置', 'Unknown device')}</span>
                        <span className={s.itemMeta}>
                          {t('上次使用 {when}・{day} 登入', 'Last used {when} · signed in {day}', { when: relative(x.lastUsedAt), day: shortDay(x.createdAt) })}
                        </span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={s.empty}>{t('沒有登入中的裝置', 'Not signed in anywhere')}</p>
            )}
          </Card>

          <Card title={t('群組（{n}）', 'Groups ({n})', { n: data.groups.length })}>
            {data.groups.length ? (
              <ul className={s.items}>
                {data.groups.map(g => (
                  <li key={g.id}>
                    <GroupRow g={g} linked={!g.deleted && myGroups.has(g.id)} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className={s.empty}>{t('還沒有加入群組', 'Not in any group yet')}</p>
            )}
            {data.groups.some(g => !g.deleted && !myGroups.has(g.id)) && (
              <Note>{t('你也在的群組才能打開', 'You can open only the groups you are in too.')}</Note>
            )}
          </Card>

          <Card title={t('最近動態', 'Recent activity')}>
            {data.activity.length ? (
              <ul className={s.items}>
                {data.activity.map(a => {
                  const v = adminActivityText(a, me);
                  return (
                    <li key={a.id}>
                      <div className={s.act} data-testid="admin-user-activity">
                        <p className={s.actText}>{v.text}</p>
                        {v.detail && <p className={s.actDetail}>{v.detail}</p>}
                        <p className={s.actMeta}>{[a.groupName, relative(a.createdAt)].filter(Boolean).join(t('・', ' · '))}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={s.empty}>{t('還沒有動態', 'Nothing yet')}</p>
            )}
          </Card>
        </>
      )}

      <ResetCard email={u.email} />
    </div>
  );
}

/** The detail sheet for `user` (null: closed). The last account stays drawn while the sheet slides away. */
export function UserSheet({ user, onClose }: { user: AdminUserRow | null; onClose: () => void }) {
  const { t } = useT();
  const [shown, setShown] = useState<AdminUserRow | null>(user);
  useEffect(() => {
    if (user) setShown(user);
  }, [user]);
  return (
    <Sheet open={!!user} onClose={onClose} title={t('使用者資料', 'Account details')} closeLabel={t('關閉', 'Close')} size="full">
      {shown ? <Detail key={shown.id} row={shown} /> : null}
    </Sheet>
  );
}
