// CategoryPicker: every expense category as a grid of tinted tiles with their names, grouped
// like CATEGORY_GROUPS (飲食, 交通, 旅行...). Payments are not a category a person picks, so
// 付款 is left out. The chosen tile carries a check badge (the same mark as the faces on the
// add sheet) and opens scrolled into view.
// Tapping a tile calls onSelect; the caller closes the sheet (usually in onSelect).
// Test ids: category-option-<key> (each tile).

import { useLayoutEffect, useRef, type HTMLAttributes } from 'react';
import { CATEGORIES, CATEGORY_GROUPS, type Category } from '../../shared/categories';
import { useT } from '../lib/i18n';
import { CategoryIcon } from './CategoryIcon';
import { Icon } from './Icon';
import { Section } from './Section';
import { Sheet } from './Sheet';
import s from './CategoryPicker.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Categories by group, in the order of CATEGORY_GROUPS, without the internal 'payment'. */
const GROUPED: { key: string; zh: string; en: string; items: Category[] }[] = CATEGORY_GROUPS.map(g => ({
  ...g,
  items: CATEGORIES.filter(c => c.parent === g.key && c.key !== 'payment'),
})).filter(g => g.items.length > 0);

export interface CategoryPickerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onSelect'> {
  open: boolean;
  onClose: () => void;
  /** The category key now chosen ('food.dining'). */
  value: string;
  onSelect: (key: string) => void;
  /** Sheet title (default 分類 / Category). */
  title?: string;
}

export function CategoryPicker({ open, onClose, value, onSelect, title, className, ...rest }: CategoryPickerProps) {
  const { t } = useT();
  return (
    <Sheet open={open} onClose={onClose} title={title ?? t('分類', 'Category')} className={className} {...rest}>
      <CategoryGrid value={value} onSelect={onSelect} />
    </Sheet>
  );
}

function CategoryGrid({ value, onSelect }: Pick<CategoryPickerProps, 'value' | 'onSelect'>) {
  const { t, zh } = useT();
  const chosen = useRef<HTMLButtonElement>(null);

  // Open with the chosen tile in view (生活 and 其他 sit far down the list). Only the sheet
  // body scrolls; the page behind stays where it is.
  useLayoutEffect(() => {
    const el = chosen.current;
    const box = el ? scrollParent(el) : null;
    if (!el || !box) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.bottom > b.bottom - 12) box.scrollTop += r.bottom - b.bottom + Math.min(b.height / 3, 120);
  }, []);

  return (
    <>
      {GROUPED.map(g => {
        const groupName = zh ? g.zh : g.en;
        return (
          <Section key={g.key} title={groupName} className={s.section}>
            <div className={s.grid} role="radiogroup" aria-label={groupName}>
              {g.items.map(c => {
                const on = c.key === value;
                const name = zh ? c.zh : c.en;
                // Under its group's heading, 「其他交通」 / "Transportation, other" prints as 其他 / Other
                // (the long English word would not fit a tile); the full name is still what is spoken.
                const short = c.key.endsWith('.other') ? t('其他', 'Other') : name;
                return (
                  <button
                    key={c.key}
                    ref={on ? chosen : undefined}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={short !== name ? name : undefined}
                    className={cx(s.tile, on && s.on)}
                    onClick={() => onSelect(c.key)}
                    data-testid={`category-option-${c.key}`}
                    data-category={c.key}
                  >
                    <span className={s.art}>
                      <CategoryIcon category={c.key} size={40} className={on ? s.iconOn : undefined} />
                      {on ? (
                        <span className={s.badge} aria-hidden="true">
                          <Icon name="check" size={12} strokeWidth={3} />
                        </span>
                      ) : null}
                    </span>
                    <span className={s.label}>{short}</span>
                  </button>
                );
              })}
            </div>
          </Section>
        );
      })}
    </>
  );
}

/** The nearest ancestor that scrolls vertically (the sheet body). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}
