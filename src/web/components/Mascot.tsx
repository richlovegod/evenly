// Mascot (design/PICTUREBOOK.md): 平平, the award site's robot recolored for Evenly (yolk face,
// coral cheeks, paper eyes), drawn in the family's 3 px ink line on a 40 x 40 grid. The logo
// in every top bar (PageHeader, floating gently), and the face of empty states, the welcome
// page and the home hero. Decorative unless `label` is given. Colors come from tokens.

import type { CSSProperties, SVGProps } from 'react';
import s from './Mascot.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface MascotProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'children'> {
  /** Width and height in px (default 38, the top bar's logo). */
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
      viewBox="0 0 40 40"
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
      <g className={s.line}>
        <path d="M20 3v6" />
        <circle className={s.dot} cx="20" cy="3" r="1.5" />
        <rect className={s.face} x="6" y="9" width="28" height="24" rx="9" />
        <ellipse className={s.cheek} cx="10.6" cy="26" rx="2.2" ry="1.5" />
        <ellipse className={s.cheek} cx="29.4" cy="26" rx="2.2" ry="1.5" />
        <circle className={s.eye} cx="14.5" cy="19" r="4.2" />
        <circle className={s.eye} cx="25.5" cy="19" r="4.2" />
        <circle className={s.pupil} cx="14.5" cy="19" r="1.4" />
        <circle className={s.pupil} cx="25.5" cy="19" r="1.4" />
        <path d="M16.5 27q3.5 3 7 0" />
        <path d="M11 38l3-5M29 38l-3-5" />
      </g>
    </svg>
  );
}
