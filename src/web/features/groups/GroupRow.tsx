// A group in a list (總覽, 群組): its ticket, name, how many people and who I settle with
// (「6 人，來自 Tiffany」), and where I stand; a settled group shows the 已結清 stamp
// (DESIGN.md 8.6). Two-person groups name the other person: 「Abbie 欠你」.

import type { GroupListItemDTO } from '../../../shared/types';
import { GroupAvatar } from '../../components/GroupAvatar';
import { ListRow } from '../../components/ListRow';
import { MoneyStatus } from '../../components/Money';
import { zhJoin } from '../../lib/describe';
import { useT } from '../../lib/i18n';
import { groupPath } from './links';
import { count } from './plural';

const LATIN_START = /^[A-Za-z0-9(]/;

type T = (zh: string, en: string, p?: Record<string, string | number>) => string;

/** 「來自 Tiffany」 / 「付給 Kevin 等 2 人」: who my balance in the group comes from or goes to. */
export function counterparty(g: GroupListItemDTO, t: T): string {
  const me = g.myMemberId;
  if (g.myNet === 0) return '';
  const names = new Map(g.members.map(m => [m.id, m.name]));
  const owedToMe = g.myNet > 0;
  const others = g.myTransfers
    .filter(tr => (owedToMe ? tr.to === me : tr.from === me))
    .sort((a, b) => b.amount - a.amount)
    .map(tr => names.get(owedToMe ? tr.from : tr.to) ?? '');
  const first = others[0];
  if (!first) return '';
  const zhVerb = owedToMe ? '來自' : '付給';
  const enVerb = owedToMe ? 'from' : 'to';
  const zhName = (LATIN_START.test(first) ? ' ' : '') + first;
  if (others.length === 1) return t(zhVerb + zhName, enVerb + ' ' + first);
  return t(zhVerb + zhJoin(zhName, '等 {n} 人'), enVerb + ' ' + first + ' and {k} more', { n: others.length, k: others.length - 1 });
}

export function GroupRow({ group: g, testId, className }: { group: GroupListItemDTO; testId?: string; className?: string }) {
  const { t } = useT();
  const active = g.members.filter(m => m.active);
  const people = t('{n} 人', count(active.length, 'person', 'people'), { n: active.length });
  const cp = counterparty(g, t);
  const subtitle = cp ? t(people + '，' + cp, people + ', ' + cp) : people;
  const twoPeople = active.length === 2;
  const other = twoPeople ? active.find(m => m.id !== g.myMemberId)?.name : undefined;

  return (
    <ListRow
      className={className}
      leading={<GroupAvatar emoji={g.emoji} color={g.color} name={g.name} currency={g.currency} settled={g.myNet === 0} />}
      title={g.name}
      subtitle={subtitle}
      trailing={<MoneyStatus amount={g.myNet} currency={g.currency} kind={other ? 'friend' : 'groupMine'} name={other} size="md" />}
      href={groupPath(g.id)}
      data-testid={testId}
      data-id={g.id}
    />
  );
}
