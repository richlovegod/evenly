// CategoryIcon (DESIGN.md 6.2, restyled for design/PICTUREBOOK.md): the category's line glyph in
// a round sticker with a 2 px ink outline, tinted sky or yolk by its parent (飲食, 交通,
// 旅行...). 40 px: 22 px glyph; 36 px: 20; 30 px: 17. Payments are plain paper. An icon name
// the set does not draw falls back to the category's emoji in grayscale.

import type { HTMLAttributes } from 'react';
import { categoryLabel, getCategory } from '../../shared/categories';
import { useT } from '../lib/i18n';
import { Icon, isIconName } from './Icon';
import s from './CategoryIcon.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const PARENT: Record<string, string | undefined> = {
  food: s.food,
  transport: s.transport,
  travel: s.travel,
  entertainment: s.entertainment,
  home: s.home,
  utilities: s.utilities,
  life: s.life,
  other: s.other,
};

export interface CategoryIconProps extends HTMLAttributes<HTMLSpanElement> {
  /** A category key from src/shared/categories.ts ('food.dining'); unknown keys show 一般. */
  category: string;
  /** Tile size in px (default 36). */
  size?: number;
  /** Speak the category name (otherwise the tile is decorative). */
  labelled?: boolean;
  className?: string;
}

export function CategoryIcon({ category, size = 36, labelled, className, style, ...rest }: CategoryIconProps) {
  const { locale } = useT();
  const c = getCategory(category);
  const glyph = size === 30 ? 17 : Math.round(size * 0.55);
  const name = categoryLabel(c.key, locale);
  return (
    <span
      className={cx(s.tile, PARENT[c.parent] ?? s.other, c.key === 'payment' && s.payment, size < 26 && s.small, className)}
      style={{ width: size, height: size, ...style }}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? name : undefined}
      aria-hidden={labelled ? undefined : true}
      data-category={c.key}
      {...rest}
    >
      {isIconName(c.icon) ? (
        <Icon name={c.icon} size={glyph} />
      ) : (
        <span className={s.emoji} style={{ fontSize: Math.round(size * 0.5) }}>{c.emoji}</span>
      )}
    </span>
  );
}
