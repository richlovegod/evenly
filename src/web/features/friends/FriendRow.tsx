// A person in a list (總覽, 朋友): avatar, name, which group the balance comes from (「家用 Gino &
// Abbie」 or 「3 個群組」), and what we owe each other in the first currency (DESIGN.md 8.6).

import type { FriendDTO, GroupListItemDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { ListRow } from '../../components/ListRow';
import { MoneyStatus } from '../../components/Money';
import { useT } from '../../lib/i18n';
import s from './FriendRow.module.css';

export function friendPath(key: string): string {
  return '/f/' + encodeURIComponent(key);
}

/** The group's name as a friend sees it: a 1:1 ledger reads 兩人帳本, not "Gino & Abbie". */
export function groupLabel(g: Pick<GroupListItemDTO, 'type' | 'name'> | undefined, t: (zh: string, en: string) => string): string {
  if (!g) return t('（已刪除的群組）', '(deleted group)');
  return g.type === 'pair' ? t('兩人帳本', 'Friend ledger') : g.name;
}

export function friendSubtitle(f: FriendDTO, groups: ReadonlyMap<string, GroupListItemDTO>, t: (zh: string, en: string, p?: Record<string, string | number>) => string): string {
  const open = f.groups.filter(x => x.amount !== 0);
  const list = open.length ? open : f.groups;
  let text = '';
  if (list.length === 1) text = groupLabel(groups.get(list[0].groupId), t);
  else if (list.length > 1) text = t('{n} 個群組', '{n} groups', { n: list.length });
  if (f.balances.length > 1) {
    const k = f.balances.length - 1;
    const more = t('另有 {k} 種幣別', '+' + (k === 1 ? '1 more currency' : k + ' more currencies'), { k });
    text = text ? t(text + '，' + more, text + ', ' + more) : more;
  }
  return text;
}

export function FriendRow({
  friend: f,
  groups,
  testId,
  className,
}: {
  friend: FriendDTO;
  groups: ReadonlyMap<string, GroupListItemDTO>;
  testId: string;
  className?: string;
}) {
  const { t } = useT();
  const first = f.balances[0];
  return (
    <ListRow
      className={className}
      leading={<Avatar name={f.name} color={f.color} size={40} />}
      title={f.name}
      subtitle={friendSubtitle(f, groups, t)}
      trailing={
        <MoneyStatus
          amount={first ? first.amount : 0}
          currency={first ? first.currency : f.groups[0]?.currency ?? 'TWD'}
          kind="friend"
          size="md"
          className={s.status}
        />
      }
      href={friendPath(f.key)}
      data-testid={testId}
      data-id={f.key}
      data-key={f.key}
    />
  );
}
