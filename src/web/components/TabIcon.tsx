// TabIcon (design/PICTUREBOOK.md, the tab art): the colored drawings of the tab bar and the desktop
// sidebar, in the mascot's style: ink #333 outlines, coral #F48B7B, face #F7A092, gold #F9D976,
// slip #FFFDF7 and blue #A9CBE6 on a 48 grid. Gino's picks (2026-10-25): 總覽 a house whose wall
// is a robot face, 群組 three robots at a table, 朋友 two heads leaning in under a gold heart,
// 動態 a smiling gold bell, 我的 the mascot's head and shoulders. The drawings are his, copied as
// drawn. AppShell fades the tabs that are not current (AppShell.module.css); under forced colors
// the art turns into a line drawing in the system colors (TabIcon.module.css).
// Icon.tsx keeps its own line icons for home, groups, friends, activity and user, which other
// pages use (home is also the 居家 category).
// Always decorative: the tab's label names it.

import type { CSSProperties } from 'react';
import s from './TabIcon.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// TabIcon.module.css picks the ink by this value under forced colors.
const INK = '#333';
const CORAL = '#F48B7B';
const FACE = '#F7A092';
const GOLD = '#F9D976';
const SLIP = '#FFFDF7';
const BLUE = '#A9CBE6';

export type TabIconName = 'home' | 'groups' | 'friends' | 'activity' | 'account';

export interface TabIconProps {
  name: TabIconName;
  /** Width and height in px (default 30, the tab bar's). */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

function Art({ name }: { name: TabIconName }) {
  switch (name) {
    case 'home':
      // 總覽: a house whose wall is the robot's face, the antenna on the roof
      return (
        <>
          <line x1="24" y1="8" x2="24" y2="4.5" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <circle cx="24" cy="4" r="2.6" fill={CORAL} stroke={INK} strokeWidth="2.4" />
          <rect x="10" y="20" width="28" height="22" rx="6" fill={SLIP} stroke={INK} strokeWidth="3" />
          <path d="M5 23.5 L24 8.5 L43 23.5 Z" fill={CORAL} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <circle cx="19" cy="29.5" r="2.3" fill={INK} />
          <circle cx="29" cy="29.5" r="2.3" fill={INK} />
          <path d="M20.5 34.5 Q24 37.5 27.5 34.5" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="15.5" cy="34" r="1.8" fill={FACE} />
          <circle cx="32.5" cy="34" r="1.8" fill={FACE} />
        </>
      );
    case 'groups':
      // 群組: three robots around a table, the coral one in the middle with the antenna
      return (
        <>
          <rect x="2" y="15" width="14" height="15" rx="5.5" fill={BLUE} stroke={INK} strokeWidth="2.8" />
          <rect x="32" y="15" width="14" height="15" rx="5.5" fill={GOLD} stroke={INK} strokeWidth="2.8" />
          <circle cx="6.8" cy="21.5" r="1.6" fill={INK} />
          <circle cx="11.2" cy="21.5" r="1.6" fill={INK} />
          <circle cx="36.8" cy="21.5" r="1.6" fill={INK} />
          <circle cx="41.2" cy="21.5" r="1.6" fill={INK} />
          <line x1="24" y1="10" x2="24" y2="6" stroke={INK} strokeWidth="2.8" strokeLinecap="round" />
          <circle cx="24" cy="4.8" r="2.5" fill={CORAL} stroke={INK} strokeWidth="2.3" />
          <rect x="16" y="10" width="16" height="20" rx="6.5" fill={CORAL} stroke={INK} strokeWidth="2.8" />
          <circle cx="21" cy="17.5" r="1.9" fill={INK} />
          <circle cx="27" cy="17.5" r="1.9" fill={INK} />
          <path d="M21.5 22 Q24 24.3 26.5 22" fill="none" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
          <rect x="1.5" y="28.5" width="45" height="7" rx="3.5" fill={SLIP} stroke={INK} strokeWidth="3" />
          <line x1="9" y1="36" x2="9" y2="44.5" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <line x1="39" y1="36" x2="39" y2="44.5" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <circle cx="24" cy="32" r="2.2" fill={GOLD} stroke={INK} strokeWidth="1.8" />
        </>
      );
    case 'friends':
      // 朋友: two robot heads leaning in, a gold heart above
      return (
        <>
          <path d="M24 15.5 C 17.5 11, 18.5 4.5, 24 8 C 29.5 4.5, 30.5 11, 24 15.5 Z" fill={GOLD} stroke={INK} strokeWidth="2.6" strokeLinejoin="round" />
          <g transform="rotate(-9 14 30)">
            <rect x="3.5" y="19.5" width="21" height="20" rx="8.5" fill={CORAL} stroke={INK} strokeWidth="3" />
            <circle cx="10.5" cy="28" r="2" fill={INK} />
            <circle cx="17.5" cy="28" r="2" fill={INK} />
            <path d="M11.5 33 Q14 35.3 16.5 33" fill="none" stroke={INK} strokeWidth="2.3" strokeLinecap="round" />
          </g>
          <g transform="rotate(9 34 30)">
            <rect x="23.5" y="19.5" width="21" height="20" rx="8.5" fill={BLUE} stroke={INK} strokeWidth="3" />
            <circle cx="30.5" cy="28" r="2" fill={INK} />
            <circle cx="37.5" cy="28" r="2" fill={INK} />
            <path d="M31.5 33 Q34 35.3 36.5 33" fill="none" stroke={INK} strokeWidth="2.3" strokeLinecap="round" />
          </g>
        </>
      );
    case 'activity':
      // 動態: a smiling gold bell with a coral clapper
      return (
        <>
          <circle cx="24" cy="7" r="2.7" fill={CORAL} stroke={INK} strokeWidth="2.4" />
          <circle cx="24" cy="40.5" r="3.4" fill={CORAL} stroke={INK} strokeWidth="2.6" />
          <path d="M13 34 V23 Q13 10 24 10 Q35 10 35 23 V34 Z" fill={GOLD} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <rect x="8.5" y="32.5" width="31" height="5.5" rx="2.75" fill={GOLD} stroke={INK} strokeWidth="3" />
          <circle cx="20" cy="22" r="2" fill={INK} />
          <circle cx="28" cy="22" r="2" fill={INK} />
          <path d="M21 26.5 Q24 29 27 26.5" fill="none" stroke={INK} strokeWidth="2.3" strokeLinecap="round" />
          <path d="M5 17 Q3.5 21 5 25" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
          <path d="M43 17 Q44.5 21 43 25" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
        </>
      );
    case 'account':
      // 我的: the mascot's own head and shoulders
      return (
        <>
          <line x1="24" y1="10" x2="24" y2="5.5" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <circle cx="24" cy="4.5" r="2.7" fill={CORAL} stroke={INK} strokeWidth="2.4" />
          <rect x="15" y="35" width="18" height="11" rx="5" fill={CORAL} stroke={INK} strokeWidth="3" />
          <rect x="7" y="9.5" width="34" height="27" rx="11.5" fill={CORAL} stroke={INK} strokeWidth="3" />
          <rect x="11.5" y="13.5" width="25" height="19" rx="8" fill={FACE} stroke={INK} strokeWidth="2.4" />
          <circle cx="19" cy="21.5" r="3" fill={GOLD} stroke={INK} strokeWidth="1.6" />
          <circle cx="29" cy="21.5" r="3" fill={GOLD} stroke={INK} strokeWidth="1.6" />
          <path d="M21 27 Q24 29.8 27 27" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
        </>
      );
  }
}

export function TabIcon({ name, size = 30, className, style }: TabIconProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      focusable="false"
      aria-hidden="true"
      className={cx(s.art, className)}
      style={style}
      data-tab-icon={name}
    >
      <Art name={name} />
    </svg>
  );
}
