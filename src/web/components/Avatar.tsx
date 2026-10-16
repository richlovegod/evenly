// Avatar (a person) and AvatarStack (a few overlapping people plus "+N").
// Initials come from initials() in lib/describe.ts: the first character of a CJK name, else
// the first letters of up to two words.

import type { CSSProperties, HTMLAttributes } from 'react';
import { isHexColor } from '../../shared/colors';
import { initials } from '../lib/describe';
import { useT } from '../lib/i18n';
import { href as hashHref } from '../lib/router';
import s from './Avatar.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Radius 0.3 x size (DESIGN.md 8.7: 12 at 40, 11 at 36, 8 at 26, 7 at 24 and 22); type as in
 *  the reference (17 at 40, 15 at 36, 12 at 26, 11 at 24 and 22). */
function metrics(size: number, letters: number): { radius: number; font: number } {
  const radius = Math.round(size * 0.3);
  let font = size >= 40 ? Math.round(size * 0.425) : size >= 36 ? 15 : size >= 30 ? 14 : size >= 26 ? 12 : size >= 22 ? 11 : Math.max(9, Math.round(size * 0.46));
  if (letters > 1) font = Math.max(9, Math.round(font * 0.86));
  return { radius, font };
}

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name: string;
  /** The stored color (#RRGGBB from src/shared/colors.ts). */
  color: string;
  /** Width and height in px (default 40). */
  size?: number;
  /** You: the white original with an ink ring instead of a tint. */
  ring?: boolean;
  className?: string;
}

export function Avatar({ name, color, size = 40, ring, className, style, ...rest }: AvatarProps) {
  const text = initials(name);
  const m = metrics(size, [...text].length);
  const labelled = rest['aria-label'] !== undefined;
  const css = {
    '--av': isHexColor(color) ? color : undefined,
    width: size,
    height: size,
    borderRadius: m.radius,
    fontSize: m.font,
    ...style,
  } as CSSProperties;
  return (
    <span
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      className={cx(s.avatar, ring && s.ring, className)}
      style={css}
      {...rest}
    >
      {text}
    </span>
  );
}

export interface AvatarStackPerson {
  name: string;
  color: string;
  /** Draw this one as "you" (see Avatar ring). */
  ring?: boolean;
}

export interface AvatarStackProps extends Omit<HTMLAttributes<HTMLElement>, 'onClick'> {
  people: AvatarStackPerson[];
  /** Faces shown before "+N" (default 3). */
  max?: number;
  /** Size of each face in px (default 26). */
  size?: number;
  /** Make the whole stack one 44 px link (an app path like '/g/abc/settings', or a URL). */
  href?: string;
  /** Make the whole stack one 44 px button. */
  onClick?: () => void;
  className?: string;
}

export function AvatarStack({ people, max = 3, size = 26, href: to, onClick, className, style, ...rest }: AvatarStackProps) {
  const { t, zh } = useT();
  const limit = Math.max(1, max);
  const shown = people.slice(0, limit);
  const extra = people.length - shown.length;
  const names = people.map(p => p.name).join(zh ? '、' : ', ');
  const label = rest['aria-label'] ?? t('成員 {n} 人：{names}', '{n} members: {names}', { n: people.length, names });
  const css = {
    '--overlap': `${-Math.round(size * 0.27)}px`,
    '--nudge': `${Math.round(size * 0.23)}px`,
    ...style,
  } as CSSProperties;
  const faces = (
    <>
      {shown.map((p, i) => (
        <Avatar key={i + p.name} name={p.name} color={p.color} ring={p.ring} size={size} className={i < shown.length - 1 ? s.covered : undefined} />
      ))}
      {extra > 0 ? <span className={s.more} aria-hidden="true">+{extra}</span> : null}
    </>
  );
  if (to !== undefined) {
    return (
      <a {...rest} href={to.startsWith('/') ? hashHref(to) : to} className={cx(s.stack, s.target, className)} style={css} aria-label={label} onClick={onClick ? () => onClick() : undefined}>
        {faces}
      </a>
    );
  }
  if (onClick) {
    return (
      <button {...rest} type="button" className={cx(s.stack, s.target, className)} style={css} aria-label={label} onClick={() => onClick()}>
        {faces}
      </button>
    );
  }
  return (
    <span {...rest} role="img" className={cx(s.stack, className)} style={css} aria-label={label}>
      {faces}
    </span>
  );
}
