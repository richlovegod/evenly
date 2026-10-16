// MemberPicker: choose one person of a group (who paid, paid to whom, who everyone settles with).
// A sheet with a paper panel of people: you first (「你」, the white original with an ink ring),
// then the others in group order; the chosen one is checked. Members who left the group stay
// pickable when the caller passes them (old entries still name them) and say so.
// Tapping a person calls onSelect; the caller closes the sheet (usually in onSelect).
// data-testid on each row: member-option-<memberId>.

import type { HTMLAttributes, ReactNode } from 'react';
import type { MemberDTO } from '../../shared/types';
import { orderedMembers } from '../lib/describe';
import { useT } from '../lib/i18n';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import s from './MemberPicker.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface MemberPickerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onSelect'> {
  open: boolean;
  onClose: () => void;
  /** The sheet title, a question: 「誰付的？」. */
  title: string;
  members: MemberDTO[];
  /** The member id now chosen (checked). */
  value?: string;
  onSelect: (memberId: string) => void;
  /** My member id in this group: shown first, as 你 / You. */
  meId?: string;
  /** A line above the list (what the choice does). */
  description?: ReactNode;
  /** Member ids shown but not choosable (for example the other side of a payment). */
  disabledIds?: string[];
}

export function MemberPicker({ open, onClose, title, members, value, onSelect, meId, description, disabledIds, className, ...rest }: MemberPickerProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title} className={className} {...rest}>
      <MemberList title={title} members={members} value={value} onSelect={onSelect} meId={meId} description={description} disabledIds={disabledIds} />
    </Sheet>
  );
}

function MemberList({ title, members, value, onSelect, meId, description, disabledIds }: Omit<MemberPickerProps, 'open' | 'onClose'>) {
  const { t } = useT();
  const list = orderedMembers(members, meId, true);
  const blocked = new Set(disabledIds ?? []);

  if (!list.length) {
    return <p className={s.empty}>{t('這個群組還沒有其他成員', 'No one else is in this group yet')}</p>;
  }

  return (
    <>
      {description ? <p className={s.description}>{description}</p> : null}
      <ul className={s.panel} role="radiogroup" aria-label={title}>
        {list.map(m => {
          const me = !!meId && m.id === meId;
          const on = m.id === value;
          const off = blocked.has(m.id) && !on;
          const name = me ? t('你', 'You') : m.name;
          return (
            <li key={m.id} role="none">
              <button
                type="button"
                role="radio"
                aria-checked={on}
                disabled={off}
                className={cx(s.option, on && s.on)}
                onClick={() => onSelect(m.id)}
                data-testid={`member-option-${m.id}`}
                data-id={m.id}
              >
                <Avatar name={m.name} color={m.color} size={36} ring={me} />
                <span className={s.main}>
                  <span className={s.name}>{name}</span>
                  {!m.active ? <span className={s.sub}>{t('已離開群組', 'Left the group')}</span> : null}
                </span>
                {on ? <Icon name="check" size={22} strokeWidth={2.4} className={s.check} /> : <span className={s.checkSlot} aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
