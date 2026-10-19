// Avatar (a person) and AvatarStack (a few overlapping people plus "+N"). Picture-book stickers:
// circles with a 2 px ink outline, filled with the member color mixed into paper (30 %), the
// initial in ink (Huninn). You (`ring`) are always yolk.
// Initials come from initials() in lib/describe.ts: the first character of a CJK name, else
// the first letters of up to two words.
// Someone with a profile photo (`userId` and `avatar` from the DTO) shows it in the same circle,
// size and outline; the initial is the fallback when it does not load (lib/avatars.ts).

import type { CSSProperties, HTMLAttributes } from 'react';
import { isHexColor } from '../../shared/colors';
import { useAvatarPhoto } from '../lib/avatars';
import { initials } from '../lib/describe';
import { useT } from '../lib/i18n';
import { href as hashHref } from '../lib/router';
import s from './Avatar.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** The ink outline (2 px, 1.5 under 22) and the type (17 at 40, 15 at 36, 13 at 30, 12 at 26,
 *  11 at 24 and 22). */
function metrics(size: number, letters: number): { line: number; font: number } {
  const line = size >= 22 ? 2 : 1.5;
  let font = size >= 40 ? Math.round(size * 0.425) : size >= 36 ? 15 : size >= 30 ? 13 : size >= 26 ? 12 : size >= 22 ? 11 : Math.max(9, Math.round(size * 0.46));
  if (letters > 1) font = Math.max(9, Math.round(font * 0.86));
  return { line, font };
}

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name: string;
  /** The stored color (#RRGGBB from src/shared/colors.ts). */
  color: string;
  /** The person's account (null for a placeholder): with `avatar`, their photo is shown. */
  userId?: string | null;
  /** The account's photo version (the DTO's `avatar`); null or missing: the initial. */
  avatar?: string | null;
  /** Width and height in px (default 40). */
  size?: number;
  /** You: yolk instead of your color's tint (你 is always yolk). */
  ring?: boolean;
  className?: string;
}

export function Avatar({ name, color, userId, avatar, size = 40, ring, className, style, ...rest }: AvatarProps) {
  const text = initials(name);
  const photo = useAvatarPhoto(userId, avatar);
  const m = metrics(size, [...text].length);
  const labelled = rest['aria-label'] !== undefined;
  const css = {
    '--av': isHexColor(color) ? color : undefined,
    '--av-line': `${m.line}px`,
    width: size,
    height: size,
    fontSize: m.font,
    ...style,
  } as CSSProperties;
  return (
    <span
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      className={cx(s.avatar, ring && s.ring, photo.src && s.hasPhoto, className)}
      style={css}
      {...rest}
    >
      {photo.src ? <img className={s.photo} src={photo.src} alt="" draggable={false} onError={photo.onError} /> : text}
    </span>
  );
}

export interface AvatarStackPerson {
  name: string;
  color: string;
  /** The account and its photo version (see Avatar). */
  userId?: string | null;
  avatar?: string | null;
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
        <Avatar
          key={i + p.name}
          name={p.name}
          color={p.color}
          userId={p.userId}
          avatar={p.avatar}
          ring={p.ring}
          size={size}
          className={i < shown.length - 1 ? s.covered : undefined}
        />
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
