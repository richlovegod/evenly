// GroupAvatar (DESIGN.md 6.3, 8.8): a group's ticket, 44 x 46, notched on both sides, tinted
// with the group color, printing a cover glyph chosen from the group's emoji and (when given)
// the currency code under it. Emoji outside the table print as themselves, grayscale, so the
// ticket still reads as ink. Mini tickets (under 34 px) leave out the code. Settled: plain
// paper, faded ink.

import type { CSSProperties, HTMLAttributes } from 'react';
import { isHexColor } from '../../shared/colors';
import { Icon, type IconName } from './Icon';
import s from './GroupAvatar.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** DESIGN.md 6.3: emoji to ticket art. Anything else prints as the emoji itself. */
const ART: [IconName, string][] = [
  ['mountain', '⛷🏂🏔🗻⛰'],
  ['home', '🏠🏡🏘🛋'],
  ['island', '🏝🏖🌊⛱🐚'],
  ['pine', '🌲🌳⛺🏕'],
  ['plane', '✈🛫🧳'],
  ['dining', '🍜🍣🍱🍽🍲'],
  ['heart', '❤💑💕'],
  ['city', '🏙🌆🗼🗽'],
];

/** U+FE0E and U+FE0F (text and emoji presentation selectors) and skin-tone modifiers, built
 *  from code points so the source stays plain ASCII here. */
const PRESENTATION = new RegExp('[' + String.fromCharCode(0xfe0e, 0xfe0f) + ']|\\uD83C[\\uDFFB-\\uDFFF]', 'g');

const ART_BY_CHAR = new Map<string, IconName>();
for (const [icon, chars] of ART) for (const ch of chars) ART_BY_CHAR.set(ch, icon);

/** The line-art glyph for a cover emoji, or null when the emoji prints as itself. */
export function ticketArt(emoji: string): IconName | null {
  const bare = emoji.replace(PRESENTATION, '').trim();
  if (!bare) return null;
  const first = [...bare][0];
  return ART_BY_CHAR.get(bare) ?? ART_BY_CHAR.get(first) ?? null;
}

export interface GroupAvatarProps extends HTMLAttributes<HTMLSpanElement> {
  emoji: string;
  /** The group color (#RRGGBB). */
  color: string;
  name: string;
  /** Ticket width in px (default 44; the height is 2 px more). */
  size?: number;
  /** Print the group currency under the art (tickets 34 px and wider). */
  currency?: string;
  /** A settled group: plain paper, faded ink. */
  settled?: boolean;
  className?: string;
}

export function GroupAvatar({ emoji, color, name, size = 44, currency, settled, className, style, ...rest }: GroupAvatarProps) {
  const art = ticketArt(emoji);
  const showCode = !!currency && size >= 34;
  const glyph = Math.round(size * 0.5);
  const bare = emoji.trim();
  const letter = [...name.trim()][0]?.toUpperCase() ?? '?';
  const labelled = rest['aria-label'] !== undefined;
  const css = {
    '--tk': isHexColor(color) ? color : undefined,
    '--notch': `${Math.max(2, Math.round(size * 0.102 * 10) / 10)}px`,
    width: size,
    height: size + 2,
    ...style,
  } as CSSProperties;

  let face;
  if (art) face = <Icon name={art} size={glyph} />;
  else if (bare) face = <span className={s.emoji} style={{ fontSize: Math.round((size * 18) / 44) }}>{bare}</span>;
  else face = <span className={s.letter} style={{ fontSize: Math.round(size * 0.42) }}>{letter}</span>;

  return (
    <span
      className={cx(s.wrap, className)}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      {...rest}
    >
      <span className={cx(s.ticket, settled && s.settled)} style={css}>
        {face}
        {showCode ? <b className={s.code} style={{ fontSize: Math.max(8, Math.round((size * 10) / 44)) }}>{currency}</b> : null}
      </span>
    </span>
  );
}
