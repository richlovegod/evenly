// 使用者: who signed up, newest first, with a search box (name or email). Each row: avatar,
// name, email (or 沒有 Email（只在這台裝置）), when they joined and were last seen, how many groups
// and entries, and their device labels. A tap opens the account's detail sheet.

import type { AdminUserRow } from '../../../../shared/types';
import { Avatar } from '../../../components/Avatar';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { Skeleton } from '../../../components/Spinner';
import { TextField } from '../../../components/TextField';
import { useT } from '../../../lib/i18n';
import { Card, cx, ErrorLine, Tag } from '../../auth/Receipt';
import { allLoaded, shortDay } from './adminText';
import type { AdminUserList } from './useAdminUsers';
import s from './Admin.module.css';

function UserRow({ u, onOpen }: { u: AdminUserRow; onOpen: (u: AdminUserRow) => void }) {
  const { t, relative } = useT();
  return (
    <button type="button" className={s.user} onClick={() => onOpen(u)} data-testid="admin-user-row" data-id={u.id}>
      <Avatar name={u.name} color={u.color} size={40} />
      <span className={s.userMain}>
        <span className={s.userTop}>
          <span className={s.userName}>{u.name}</span>
          {u.isOwner && <Tag tint="yellow">{t('管理員', 'Owner')}</Tag>}
        </span>
        <span className={cx(s.userSub, !u.email && s.noEmail)}>{u.email ?? t('沒有 Email（只在這台裝置）', 'No email (on their device only)')}</span>
        <span className={s.userMeta}>
          <span>{t('{day} 加入', 'Joined {day}', { day: shortDay(u.createdAt) })}</span>
          <span>{u.lastActiveAt ? t('最近上線 {when}', 'Last seen {when}', { when: relative(u.lastActiveAt) }) : t('沒有登入中的裝置', 'Not signed in anywhere')}</span>
        </span>
        <span className={s.userMeta}>
          <span>{t('群組 {n}', 'Groups {n}', { n: u.groups })}</span>
          <span>{t('費用 {n}', 'Expenses {n}', { n: u.entries })}</span>
        </span>
        {u.devices.length > 0 && (
          <span className={s.devices}>
            {u.devices.map(d => (
              <Tag key={d}>{d}</Tag>
            ))}
          </span>
        )}
      </span>
      <Icon name="chevronRight" size={18} className={s.chev} />
    </button>
  );
}

export function UserList({ list, onOpen }: { list: AdminUserList; onOpen: (u: AdminUserRow) => void }) {
  const { t, num } = useT();
  const { users, total, query, loading, error } = list;
  const left = users ? Math.max(0, total - users.length) : 0;

  let count: string | null = null;
  if (users && !error) {
    count = query
      ? t('找到 {n} 人', '{n} found', { n: num(total, 0) })
      : t('共 {n} 人，新註冊的在最上面', 'Total: {n}, newest first', { n: num(total, 0) });
  } else if (loading) {
    count = t('載入中…', 'Loading…');
  }

  return (
    <Card title={t('使用者', 'People')}>
      <TextField
        className={s.search}
        type="search"
        label={t('搜尋名字或 Email', 'Search names or emails')}
        hideLabel
        leadingIcon="search"
        placeholder={t('搜尋名字或 Email', 'Search names or emails')}
        value={list.text}
        onChange={list.setText}
        onEnter={list.searchNow}
        enterKeyHint="search"
        autoComplete="off"
        maxLength={100}
        data-testid="admin-search"
      />
      {count && <p className={s.count} aria-live="polite">{count}</p>}

      {error && (
        <>
          <ErrorLine>{error}</ErrorLine>
          <Button variant="secondary" size="sm" icon="sync" className={s.more} onClick={list.retry}>
            {t('再試一次', 'Try again')}
          </Button>
        </>
      )}

      {!users && loading && (
        <div aria-busy="true">
          {[0, 1, 2].map(i => (
            <div key={i} className={s.rowSkel}>
              <Skeleton width={40} height={40} radius={20} />
              <div className={s.userMain}>
                <Skeleton height={14} width="45%" />
                <div className={s.skelGap} />
                <Skeleton height={12} width="70%" />
              </div>
            </div>
          ))}
        </div>
      )}

      {users && (
        <>
          <ul className={cx(s.users, loading && s.stale)} data-testid="admin-users" aria-busy={loading || undefined}>
            {users.map(u => (
              <li key={u.id}>
                <UserRow u={u} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          {!users.length && !loading && (
            <p className={s.empty}>
              {query ? t('沒有符合「{q}」的使用者', 'Nobody matches "{q}"', { q: query }) : t('還沒有人註冊', 'Nobody has signed up yet')}
            </p>
          )}
          {!allLoaded(users.length, total) && (
            <Button variant="secondary" block className={s.more} loading={list.loadingMore} onClick={() => void list.loadMore()} data-testid="admin-users-more">
              {t('顯示更多（還有 {n} 人）', 'Show more ({n} more)', { n: num(left, 0) })}
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
