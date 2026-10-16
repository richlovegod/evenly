// GroupAvatar (DESIGN.md 6.3, 8.8, restyled for design/PICTUREBOOK.md): a group's cover, a
// rounded tile (radius 0.3 x size: 14 at 48) with an ink outline, holding a small hand-drawn
// scene picked from the group's emoji (snow mountain, house, sea and island, pines, a plane in
// the clouds, a bowl, a heart, a town) in the family's ink line with pastel fills. Under 28 px
// the scene would not read, so the tile prints the line glyph instead. Emoji outside the table
// print as themselves, grayscale, on the group color's tint (or the name's first letter). With
// `currency` (tiles 34 px and wider) the code sits on a small paper pill on the bottom edge.
// Settled: faded. `CoverArt` exports the scene alone, for a bigger cover.

import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { isHexColor } from '../../shared/colors';
import { Icon, type IconName } from './Icon';
import s from './GroupAvatar.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** DESIGN.md 6.3: emoji to cover art. Anything else prints as the emoji itself. */
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

/** The scenes, on a 48 x 48 grid: 2 px ink lines (thin at small sizes because they scale), fills
 *  by role (classes in the module). Static markup, no user data. */
const SCENES: Partial<Record<IconName, { ground: string; art: ReactNode }>> = {
  mountain: {
    ground: s.gSky,
    art: (
      <>
        <path className={s.fSky} d="M3 41L19.5 17Q24 13 28.5 17L45 41z" />
        <path className={s.fPaper} d="M15.6 22.6L19.5 17Q24 13 28.5 17l3.9 5.6-3.4 2.2-2.6-2.4-2.6 2.6-2.8-2.6-2.6 2.4z" />
        <path className={cx(s.fPaper, s.noLine)} d="M0 39q12-4 24-1t24-2v12H0z" />
        <path d="M0 39q12-4 24-1t24-2" />
        <path className={s.fGrass} d="M36.5 41l4.2-8.5 4.2 8.5zM37.6 35.5l3.1-6.5 3.1 6.5z" />
      </>
    ),
  },
  home: {
    ground: s.gYolk,
    art: (
      <>
        <path className={s.fPaper} d="M13 25h22v15H13z" />
        <path className={s.fSky} d="M9 26.5L24 13l15 13.5z" />
        <path className={s.fYolk} d="M21.5 31h5v9h-5z" />
        <path className={s.fSkyT} d="M15.5 28.5h4v4h-4z" />
        <path d="M5 40h38" />
      </>
    ),
  },
  island: {
    ground: s.gSky,
    art: (
      <>
        <circle className={s.fYolk} cx="35" cy="13" r="5" />
        <path className={s.fGrass} d="M5 34q10-14 24 0z" />
        <path d="M17 23.5v-4.5h3v3.8" />
        <path className={cx(s.fSky, s.noLine)} d="M0 33h48v15H0z" />
        <path d="M0 33h48M8 40.5q3-2.2 6 0t6 0M27 43q3-2.2 6 0t6 0" />
      </>
    ),
  },
  pine: {
    ground: s.gPaper,
    art: (
      <>
        <path className={s.fSkyT} d="M2 40L17 18l9 11 7-8 13 19z" />
        <path className={s.fGrass} d="M7 42l5-10.5L17 42zM8.4 35.4l3.6-7.6 3.6 7.6zM31 42l4.5-9.5L40 42z" />
        <path d="M2 42h44" />
      </>
    ),
  },
  plane: {
    ground: s.gSky,
    art: (
      <>
        <path className={s.fPaper} d="M27 39h11a4.2 4.2 0 0 0-.8-8.3 5.6 5.6 0 0 0-10.6-1.5A4 4 0 0 0 27 39z" />
        <path className={s.fPaper} d="M8 26l26-9c3-1 4.8 2 2.2 3.6L14 31z" />
        <path className={s.fYolk} d="M19.5 22.2L15 13.5h5l8.5 6.4" />
        <path className={s.fYolk} d="M20.5 28.6l-1.8 8.2h5l6-10.2" />
      </>
    ),
  },
  dining: {
    ground: s.gYolk,
    art: (
      <>
        <path d="M27 21.5l9-11M30.5 22.5l8.5-9" />
        <path className={s.fYolk} d="M9 24h30a15 13 0 0 1-30 0z" />
        <path d="M19 38.5h10" />
      </>
    ),
  },
  heart: {
    ground: s.gYolk,
    art: (
      <path className={s.fCoral} d="M24 38s-13-7.4-13-16.2A7 7 0 0 1 24 18a7 7 0 0 1 13 3.8C37 30.6 24 38 24 38z" />
    ),
  },
  city: {
    ground: s.gSky,
    art: (
      <>
        <path className={s.fPaper} d="M8 41V22h10v19" />
        <path className={s.fYolk} d="M18 41V12h11v29" />
        <path className={s.fPaper} d="M29 41V26h11v15" />
        <path d="M21.5 18h4M21.5 23.5h4M21.5 29h4M11.5 27h3M11.5 32h3M32.5 31h4" />
        <path d="M4 41h40" />
      </>
    ),
  },
};

/** The scene for a cover emoji on its ground, a square drawing (48 x 48 grid) that fits its box,
 *  with 3 px ink lines at any size; null when the emoji has no scene. For a big cover:
 *  <CoverArt emoji={g.emoji} className={...} /> (the class sets the width and height). */
export function CoverArt({ emoji, className }: { emoji: string; className?: string }) {
  const art = ticketArt(emoji);
  const scene = art ? SCENES[art] : undefined;
  if (!scene) return null;
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" className={cx(s.big, scene.ground, className)}>
      <g className={s.line}>{scene.art}</g>
    </svg>
  );
}

export interface GroupAvatarProps extends HTMLAttributes<HTMLSpanElement> {
  emoji: string;
  /** The group color (#RRGGBB). */
  color: string;
  name: string;
  /** Cover width in px (default 44). */
  size?: number;
  /** Print the group currency on the cover (covers 34 px and wider). */
  currency?: string;
  /** A settled group: faded. */
  settled?: boolean;
  className?: string;
}

export function GroupAvatar({ emoji, color, name, size = 44, currency, settled, className, style, ...rest }: GroupAvatarProps) {
  const art = ticketArt(emoji);
  const scene = art && size >= 28 ? SCENES[art] : undefined;
  const showCode = !!currency && size >= 34;
  const bare = emoji.trim();
  const letter = [...name.trim()][0]?.toUpperCase() ?? '?';
  const labelled = rest['aria-label'] !== undefined;
  const line = size >= 40 ? 2.5 : size >= 26 ? 2 : 1.5;
  const css = {
    '--tk': isHexColor(color) ? color : undefined,
    '--tk-line': `${line}px`,
    '--tk-r': `${Math.max(4, Math.round(size * 0.3))}px`,
    width: size,
    height: size,
    ...style,
  } as CSSProperties;

  let face;
  if (scene) {
    face = (
      <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" className={s.scene}>
        <g className={s.line}>{scene.art}</g>
      </svg>
    );
  } else if (art) face = <Icon name={art} size={Math.round(size * 0.6)} className={s.glyph} />;
  else if (bare) face = <span className={s.emoji} style={{ fontSize: Math.round(size * 0.46) }}>{bare}</span>;
  else face = <span className={s.letter} style={{ fontSize: Math.round(size * 0.42) }}>{letter}</span>;

  return (
    <span
      className={cx(s.wrap, className)}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      {...rest}
    >
      <span className={cx(s.cover, scene ? scene.ground : s.tinted, settled && s.settled)} style={css}>
        <span className={s.clip}>{face}</span>
        {/* The code sits on the cover's bottom edge, like the award site's 搜尋 button on its card */}
        {showCode ? <b className={s.code} style={{ fontSize: Math.max(8, Math.round((size * 9) / 44)) }}>{currency}</b> : null}
      </span>
    </span>
  );
}
