// Mascot: the logo since 2026-10-16, Gino's coral robot hugging a coin split down the middle and
// a receipt. The same drawing as public/icons/icon.svg (its 512 grid, without the icon's cream
// tile), cropped to a square around the robot. The logo in every top bar (PageHeader, floating
// gently), and the face of empty states, the welcome page and the home hero. Decorative unless
// `label` is given. It keeps the logo's own colors on any ground.

import type { CSSProperties, SVGProps } from 'react';
import s from './Mascot.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const INK = '#333333';
const CORAL = '#F48B7B';
const FACE = '#F7A092';
const GOLD = '#F9D976';
const GOLD_T = '#FBE498';
const SLIP = '#FFFDF7';

export interface MascotProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'children'> {
  /** Width and height in px (default 38, the top bar's logo). The robot fills the height. */
  size?: number;
  /** Bob gently (3.4 s, the award site's .float); stops under reduced motion. */
  float?: boolean;
  /** Accessible name. Without it the drawing is decorative (aria-hidden). */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

export function Mascot({ size = 38, float, label, className, style, ...rest }: MascotProps) {
  return (
    <svg
      viewBox="49 38 414 414"
      width={size}
      height={size}
      focusable="false"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx(s.mascot, float && s.float, className)}
      style={style}
      {...rest}
    >
      {/* antenna */}
      <line x1="256" y1="78" x2="256" y2="128" stroke={INK} strokeWidth="14" strokeLinecap="round" />
      <circle cx="256" cy="64" r="20" fill={CORAL} stroke={INK} strokeWidth="12" />
      {/* feet */}
      <rect x="202" y="388" width="42" height="58" rx="21" fill={CORAL} stroke={INK} strokeWidth="12" />
      <rect x="268" y="388" width="42" height="58" rx="21" fill={CORAL} stroke={INK} strokeWidth="12" />
      {/* body */}
      <rect x="186" y="285" width="140" height="125" rx="50" fill={CORAL} stroke={INK} strokeWidth="12" />
      {/* head and face */}
      <rect x="136" y="122" width="240" height="184" rx="76" fill={CORAL} stroke={INK} strokeWidth="14" />
      <rect x="160" y="144" width="192" height="140" rx="56" fill={FACE} stroke={INK} strokeWidth="11" />
      <circle cx="212" cy="210" r="22" fill={GOLD} />
      <circle cx="300" cy="210" r="22" fill={GOLD} />
      <path d="M 238 236 Q 256 254 274 236" fill="none" stroke={INK} strokeWidth="11" strokeLinecap="round" />
      {/* the receipt behind the coin */}
      <rect x="255" y="255" width="85" height="105" rx="10" transform="rotate(15 295 305)" fill={SLIP} stroke={INK} strokeWidth="11" />
      <line x1="278" y1="280" x2="320" y2="291" stroke={INK} strokeWidth="8" strokeLinecap="round" />
      <line x1="272" y1="302" x2="314" y2="313" stroke={INK} strokeWidth="8" strokeLinecap="round" />
      {/* the coin, split down the middle */}
      <circle cx="235" cy="340" r="58" fill={GOLD} stroke={INK} strokeWidth="12" />
      <circle cx="235" cy="340" r="38" fill={GOLD_T} stroke={INK} strokeWidth="8" />
      <line x1="195" y1="380" x2="275" y2="300" stroke={INK} strokeWidth="9" strokeDasharray="10,10" strokeLinecap="round" />
      {/* hands */}
      <ellipse cx="172" cy="342" rx="26" ry="20" transform="rotate(15 172 342)" fill={CORAL} stroke={INK} strokeWidth="12" />
      <ellipse cx="332" cy="336" rx="26" ry="20" transform="rotate(-15 332 336)" fill={CORAL} stroke={INK} strokeWidth="12" />
    </svg>
  );
}
