// AddExpenseChooser: where a new expense goes, when the 新增費用 key cannot tell (outside a
// group, with no last-used group on this device). A picker sheet with my groups (most recent
// first; archived ones left out; 1:1 friend ledgers are listed under 朋友 instead), then the
// friends I have a 1:1 ledger with, then 建立群組. Picking a group or friend opens that ledger's
// add sheet (/g/<gid>/add), as the iPhone's PickGroupView does.
// A friend with an account but no 1:1 ledger is not offered: POST /api/friends links an account
// by email only, so starting a ledger from here by name made a placeholder ledger that friend
// never sees. They are reached through a group we share, 新增朋友 with their email, or 邀請朋友
// (the friend page says the same).
// With every group archived and no ledger, it says so (the iPhone's words), else 還沒有群組.
// Test ids: chooser-group (data-id), chooser-friend (data-key), chooser-new-group.

import type { HTMLAttributes } from 'react';
import type { FriendDTO, GroupListItemDTO } from '../../shared/types';
import { useT } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
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

/** A friend the chooser offers: one with a 1:1 ledger to add to. */
export type LedgerFriend = FriendDTO & { pairGroupId: string };

export interface ChooserLists {
  /** My groups that are not archived, the most recently changed first (1:1 ledgers are under friends). */
  groups: GroupListItemDTO[];
  /** Friends with a 1:1 ledger, in the dashboard's order. */
  friends: LedgerFriend[];
  /** Nothing to pick, and that is because every group of mine is archived. */
  allArchived: boolean;
}

/** What the chooser lists (the same rules as the iPhone's PickGroupView). Pure, for tests. */
export function chooserLists(groups: readonly GroupListItemDTO[] | undefined, friends: readonly FriendDTO[] | undefined): ChooserLists {
  const all = (groups ?? []).filter(g => g.type !== 'pair');
  // Archived groups are off my lists (their page still has 新增費用).
  const shown = all
    .filter(g => !g.archived)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  // Only a ledger that is there already: by name alone POST /api/friends would make a
  // placeholder, not a ledger with the friend's account.
  const people = (friends ?? []).filter((f): f is LedgerFriend => !!f.pairGroupId);
  return { groups: shown, friends: people, allArchived: !shown.length && !people.length && all.some(g => g.archived) };
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

  const open = (gid: string) => {
    navigate(addPath(gid));
    onClose();
  };

  if (!loaded) {
    return (
      <div className={s.loading}>
        <Spinner size={24} />
      </div>
    );
  }

  const { groups: list, friends: people, allArchived } = chooserLists(groups, friends);

  if (!list.length && !people.length) {
    const newGroup = (
      <Button variant="primary" icon="plus" href="/new-group" onClick={onClose} data-testid="chooser-new-group">
        {t('建立群組', 'New group')}
      </Button>
    );
    // Every group archived: say so, as the iPhone does, instead of 還沒有群組.
    return allArchived ? (
      <EmptyState
        icon="groups"
        title={t('你的群組都封存了', 'All your groups are archived')}
        body={t('在「群組」最下面的「已封存」取消封存，或建立一個新的群組。', 'Unarchive one under Archived at the bottom of Groups, or create a new group.')}
        action={newGroup}
      />
    ) : (
      <EmptyState
        icon="groups"
        title={t('還沒有群組', 'No groups yet')}
        body={t('建立一個群組，邀朋友一起記帳。', 'Create a group and invite friends to add expenses together.')}
        action={newGroup}
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
                  chevron
                  onClick={() => open(f.pairGroupId)}
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
