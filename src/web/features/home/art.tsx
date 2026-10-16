// The picture-book drawings (design/PICTUREBOOK.md): clouds, the hill under the home hero, and
// the scenery of a group's cover band (snow mountains for trips, a house for home groups, an
// island, pines, a plane, a town, or hills), the same scenes the group's cover tile shows
// (components/GroupAvatar), widened into a landscape. One stroke style everywhere: 3 px ink,
// round caps and joins, pastel fills from the tokens. (The mascot is components/Mascot.) Every
// drawing is decorative (aria-hidden); the clouds drift slowly and stop under
// prefers-reduced-motion.

import type { GroupType } from '../../../shared/types';
import { ticketArt } from '../../components/GroupAvatar';
import a from './art.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const hidden = { 'aria-hidden': true, focusable: false } as const;

/** A paper cloud. `big` is the one the beam hangs from; the small ones drift. */
export function Cloud({ size = 'small', drift = false, slow = false, className }: { size?: 'big' | 'small' | 'tiny'; drift?: boolean; slow?: boolean; className?: string }) {
  const cls = cx(a.art, drift && a.drift, slow && a.slow, className);
  if (size === 'big') {
    return (
      <svg viewBox="0 0 66 34" className={cls} {...hidden}>
        <path className={a.fp} d="M12 28h42a9 9 0 0 0-2-17.6A12.5 12.5 0 0 0 28.5 7 10 10 0 0 0 12 28z" />
      </svg>
    );
  }
  if (size === 'tiny') {
    return (
      <svg viewBox="0 0 42 22" className={cls} {...hidden}>
        <path className={cx(a.fp, a.thin)} d="M8 19h27a5.6 5.6 0 0 0-1.6-11A7.6 7.6 0 0 0 19 5.5 6.5 6.5 0 0 0 8 19z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 52 26" className={cls} {...hidden}>
      <path className={cx(a.fp, a.thin)} d="M9 22h34a7 7 0 0 0-2-13.6A9.5 9.5 0 0 0 23 6a8 8 0 0 0-14 16z" />
    </svg>
  );
}

/** The grass hill along the bottom of the home hero; stretches to any width, the line stays 3 px. */
export function Hill({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 390 60" preserveAspectRatio="none" className={cx(a.art, className)} {...hidden}>
      <path className={cx(a.fg, a.fn)} d="M0 30C46 14 96 14 152 25S262 45 322 27 370 15 390 16V60H0z" />
      <path className={a.ns} d="M0 30C46 14 96 14 152 25S262 45 322 27 370 15 390 16" />
    </svg>
  );
}

// ---------- group cover scenery ----------

export type SceneKind = 'mountain' | 'house' | 'island' | 'pines' | 'plane' | 'city' | 'hills';

/** The drawing for a group: the scene its cover tile shows (from the emoji), else by its type. */
export function sceneFor(type: GroupType, emoji: string): SceneKind {
  switch (ticketArt(emoji)) {
    case 'mountain':
      return 'mountain';
    case 'home':
      return 'house';
    case 'island':
      return 'island';
    case 'pine':
      return 'pines';
    case 'plane':
      return 'plane';
    case 'city':
      return 'city';
    case 'dining':
    case 'heart':
      return 'hills';
    default:
      if (type === 'trip') return 'mountain';
      if (type === 'home' || type === 'couple') return 'house';
      return 'hills';
  }
}

/** A two-tier pine standing at (x, y). */
function Pine({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return <path className={cx(a.fg, a.ns)} transform={`translate(${x} ${y}) scale(${s})`} d="M-11 0l11-23 11 23zM-8.5-13.5L0-30.5l8.5 17z" />;
}

/* The scenes on a 200 x 110 grid, anchored bottom right; the ground line crosses at about y 84,
   so things stand there and their feet go under the ground. */
function SceneArt({ kind }: { kind: SceneKind }) {
  switch (kind) {
    case 'mountain':
      return (
        <>
          <path className={a.fp} d="M14 104L58 52Q66 43 74 52L114 98" />
          <path className={a.fs} d="M52 104L118 22Q128 10 138 22L206 104z" />
          <path className={a.fp} d="M100.3 44L118 22Q128 10 138 22L156.2 44l-8 6-8-7-8 8-8-8-8 8-8-7z" />
          <Pine x={168} y={86} />
          <Pine x={187} y={88} s={0.85} />
          <Pine x={74} y={88} s={0.8} />
          <path className={a.thin} d="M160 6v8M156.5 8l7 4M156.5 12l7-4M188 30v6M185.4 31.5l5.2 3M185.4 34.5l5.2-3M84 6v7M81 7.7l6 3.6M81 11.3l6-3.6" />
        </>
      );
    case 'house':
      return (
        <>
          <circle className={a.fy} cx="180" cy="20" r="10" />
          <path className={a.fp} d="M138 28h10v18h-10z" />
          <path className={a.fp} d="M98 52h60v40H98z" />
          <path className={a.fs} d="M88 56l40-34 40 34z" />
          <path className={a.fy} d="M120 68h16v24h-16z" />
          <path className={cx(a.fst, a.thin)} d="M104 64h11v11h-11zM109.5 64v11M104 69.5h11" />
          <path className={cx(a.fst, a.thin)} d="M141 64h11v11h-11zM146.5 64v11M141 69.5h11" />
          <path d="M64 72v18" />
          <circle className={a.fg} cx="64" cy="62" r="13" />
        </>
      );
    case 'island':
      return (
        <>
          <circle className={a.fy} cx="178" cy="22" r="11" />
          <path className={a.fg} d="M58 92q46-44 100 0z" />
          <path d="M110 72q-4-22 6-38" />
          <path className={a.fg} d="M116 34q-16-6-28 4 14-1 28-4zM116 34q14-10 28-2-14 3-28 2zM116 34q-6 10-18 14 8-10 18-14zM116 34q10 6 14 18-9-8-14-18z" />
          <path className={a.thin} d="M40 34q4-4 8 0q4-4 8 0M160 52q3-3 6 0q3-3 6 0" />
        </>
      );
    case 'pines':
      return (
        <>
          <circle className={a.fp} cx="184" cy="18" r="9" />
          <path className={a.fs} d="M18 92L78 34l30 32 26-22 64 48z" />
          <Pine x={56} y={88} s={1.1} />
          <Pine x={150} y={86} s={1.2} />
          <Pine x={176} y={88} s={0.9} />
          <Pine x={104} y={89} s={0.8} />
        </>
      );
    case 'plane':
      return (
        <>
          <path className={cx(a.fp, a.thin)} transform="translate(14 52)" d="M9 22h34a7 7 0 0 0-2-13.6A9.5 9.5 0 0 0 23 6a8 8 0 0 0-14 16z" />
          <path className={a.fp} d="M150 58h28a10 10 0 0 0-2-19.8 13 13 0 0 0-24.6-3.6A9.5 9.5 0 0 0 150 58z" />
          <g transform="translate(46 2) scale(2.3)">
            <path className={cx(a.fp, a.ns)} d="M8 26l26-9c3-1 4.8 2 2.2 3.6L14 31z" />
            <path className={cx(a.fy, a.ns)} d="M19.5 22.2L15 13.5h5l8.5 6.4" />
            <path className={cx(a.fy, a.ns)} d="M20.5 28.6l-1.8 8.2h5l6-10.2" />
          </g>
        </>
      );
    case 'city':
      return (
        <>
          <circle className={a.fy} cx="184" cy="20" r="10" />
          <g transform="translate(52 -6) scale(2.4)">
            <path className={cx(a.fp, a.ns)} d="M8 41V22h10v19" />
            <path className={cx(a.fy, a.ns)} d="M18 41V12h11v29" />
            <path className={cx(a.fp, a.ns)} d="M29 41V26h11v15" />
            <path className={cx(a.thin, a.ns)} d="M21.5 18h4M21.5 23.5h4M21.5 29h4M11.5 27h3M11.5 32h3M32.5 31h4" />
          </g>
        </>
      );
    case 'hills':
    default:
      return (
        <>
          <circle className={a.fy} cx="176" cy="22" r="11" />
          <path className={a.fgt} d="M30 96q50-60 104 0z" />
          <path className={a.fg} d="M96 98q52-52 110 0z" />
          <path d="M70 76v-10M70 66q-6-2-6-8 3-6 6-6t6 6q0 6-6 8z" />
        </>
      );
  }
}

/**
 * The cover band's drawing: the scene anchored to the bottom right, and the ground (snow, sea or
 * grass) across the full width in front of it. Put it inside a positioned, clipped band.
 */
export function CoverScene({ type, emoji, className }: { type: GroupType; emoji: string; className?: string }) {
  const kind = sceneFor(type, emoji);
  const ground = kind === 'mountain' ? a.fp : kind === 'island' ? a.fs : a.fg;
  return (
    <div className={cx(a.cover, className)} aria-hidden="true" data-scene={kind}>
      <Cloud size="tiny" drift className={a.coverCloud} />
      <svg viewBox="0 0 200 110" className={cx(a.art, a.coverScene)} focusable="false">
        <SceneArt kind={kind} />
      </svg>
      <svg viewBox="0 0 390 46" preserveAspectRatio="none" className={cx(a.art, a.coverGround)} focusable="false">
        <path className={cx(ground, a.fn)} d="M0 14Q80 4 170 10T330 10Q366 5 390 6V46H0z" />
        <path className={a.ns} d="M0 14Q80 4 170 10T330 10Q366 5 390 6" />
        {kind === 'island' ? <path className={cx(a.thin, a.ns)} d="M40 26q8-5 16 0t16 0M210 30q8-5 16 0t16 0" /> : null}
      </svg>
    </div>
  );
}
