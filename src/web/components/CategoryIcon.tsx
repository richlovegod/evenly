// CategoryIcon (DESIGN.md 6.2): the category's line glyph in a tile tinted by its parent
// (飲食, 交通, 旅行...). 36 px tile, radius 10, 20 px glyph; 30 px tile, radius 9, 17 px glyph.
// Payments have no tint, only a ring. An icon name the set does not draw falls back to the
// category's emoji in grayscale, so it still reads as print.

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
  const glyph = size === 30 ? 17 : Math.round(size * 0.56);
  const radius = size >= 36 ? Math.round(size * 0.28) : size >= 30 ? 9 : Math.max(6, Math.round(size * 0.3));
  const name = categoryLabel(c.key, locale);
  return (
    <span
      className={cx(s.tile, PARENT[c.parent] ?? s.other, c.key === 'payment' && s.payment, className)}
      style={{ width: size, height: size, borderRadius: radius, ...style }}
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
