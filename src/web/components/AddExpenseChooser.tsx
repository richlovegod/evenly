// AddExpenseChooser: where a new expense goes, when the 新增費用 key cannot tell (outside a
// group, with no last-used group on this device). A picker sheet with my groups (most recent
// first; 1:1 friend ledgers are listed under 朋友 instead), then friends I can add an expense
// with, then 建立群組. Picking a group or friend opens that ledger's add sheet
// (/g/<gid>/add). A friend with an account but no 1:1 ledger yet gets one first
// (actions.addFriend with their name); that needs a connection.
// Test ids: chooser-group (data-id), chooser-friend (data-key), chooser-new-group.

import { useEffect, useRef, useState, type HTMLAttributes } from 'react';
import type { FriendDTO, GroupListItemDTO } from '../../shared/types';
import { errorMessage } from '../lib/errors';
import { useT } from '../lib/i18n';
import { navigate } from '../lib/router';
import { actions, useStore } from '../lib/store';
import { showToast } from '../lib/toast';
import { Avatar } from './Avatar';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { GroupAvatar } from './GroupAvatar';
import { Icon } from './Icon';
import { ListRow } from './ListRow';
import { Section } from './Section';
import { Sheet } from './Sheet';
import { Spinner } from './Spinner';
import s from './AddExpenseChooser.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

function addPath(gid: string): string {
  return `/g/${encodeURIComponent(gid)}/add`;
}

export interface AddExpenseChooserProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  open: boolean;
  onClose: () => void;
}

export function AddExpenseChooser({ open, onClose, className, ...rest }: AddExpenseChooserProps) {
  const { t } = useT();
  return (
    <Sheet open={open} onClose={onClose} title={t('新增費用', 'Add expense')} className={className} {...rest}>
      <ChooserBody onClose={onClose} />
    </Sheet>
  );
}

function ChooserBody({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const groups = useStore(st => st.me?.groups);
  const friends = useStore(st => st.me?.friends);
  const loaded = useStore(st => !!st.me);
  const [busy, setBusy] = useState<string | null>(null);
  // Closing the sheet while a 1:1 ledger is being made cancels the trip to its add sheet.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const open = (gid: string) => {
    navigate(addPath(gid));
    onClose();
  };

  async function startWith(f: FriendDTO) {
    if (busy) return;
    if (f.pairGroupId) {
      open(f.pairGroupId);
      return;
    }
    setBusy(f.key);
    try {
      const gid = await actions.addFriend({ name: f.name });
      if (alive.current) open(gid);
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  if (!loaded) {
    return (
      <div className={s.loading}>
        <Spinner size={24} />
      </div>
    );
  }

  const list: GroupListItemDTO[] = (groups ?? [])
    .filter(g => g.type !== 'pair')
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const people: FriendDTO[] = (friends ?? []).filter(f => !!f.pairGroupId || !!f.userId);

  if (!list.length && !people.length) {
    return (
      <EmptyState
        icon="groups"
        title={t('還沒有群組', 'No groups yet')}
        body={t('建立一個群組，邀朋友一起記帳。', 'Create a group and invite friends to add expenses together.')}
        action={
          <Button variant="primary" icon="plus" href="/new-group" onClick={onClose} data-testid="chooser-new-group">
            {t('建立群組', 'New group')}
          </Button>
        }
      />
    );
  }

  return (
    <>
      <p className={s.lead}>{t('要記在哪裡？', 'Where does it go?')}</p>
      {list.length ? (
        <Section title={t('群組', 'Groups')} className={s.section}>
          <ul className={s.panel}>
            {list.map(g => {
              const n = g.members.filter(m => m.active).length;
              return (
                <li key={g.id}>
                  <ListRow
                    leading={<GroupAvatar emoji={g.emoji} color={g.color} name={g.name} currency={g.currency} />}
                    title={g.name}
                    subtitle={t('{n} 人', n === 1 ? '{n} person' : '{n} people', { n })}
                    chevron
                    disabled={!!busy}
                    onClick={() => open(g.id)}
                    data-testid="chooser-group"
                    data-id={g.id}
                  />
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      {people.length ? (
        <Section title={t('朋友', 'Friends')} className={s.section}>
          <ul className={s.panel}>
            {people.map(f => (
              <li key={f.key}>
                <ListRow
                  leading={<Avatar name={f.name} color={f.color} userId={f.userId} avatar={f.avatar} size={40} />}
                  title={f.name}
                  subtitle={f.pairGroupId ? undefined : t('會先建立你們兩人的帳', 'Starts a ledger for the two of you')}
                  trailing={busy === f.key ? <Spinner size={20} label={t('正在建立', 'Setting up')} /> : undefined}
                  chevron={busy !== f.key}
                  disabled={!!busy && busy !== f.key}
                  onClick={() => void startWith(f)}
                  aria-busy={busy === f.key || undefined}
                  data-testid="chooser-friend"
                  data-key={f.key}
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <ul className={cx(s.panel, s.newGroup)}>
        <li>
          <ListRow
            leading={
              <span className={s.newIcon} aria-hidden="true">
                <Icon name="plus" size={22} />
              </span>
            }
            title={t('建立群組', 'New group')}
            href="/new-group"
            onClick={onClose}
            chevron
            data-testid="chooser-new-group"
          />
        </li>
      </ul>
    </>
  );
}
