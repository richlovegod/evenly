// Avatar and group colors. Chosen to stay readable with white initials (contrast >= 4.5:1).

export const AVATAR_COLORS: readonly string[] = [
  '#2F6FB5', // blue
  '#C2410C', // burnt orange
  '#15803D', // green
  '#9333EA', // violet
  '#B91C5C', // raspberry
  '#0F766E', // teal
  '#A16207', // ochre
  '#4338CA', // indigo
  '#BE123C', // red
  '#475569', // slate
];

export const GROUP_COLORS: readonly string[] = AVATAR_COLORS;

/** Deterministic color for a seed (an id or a name). */
export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Next color not yet used in a list, falling back to a deterministic pick. */
export function nextColor(used: readonly string[], seed: string): string {
  const free = AVATAR_COLORS.find(c => !used.includes(c));
  return free ?? colorFor(seed);
}

export function isHexColor(s: unknown): s is string {
  return typeof s === 'string' && /^#[0-9A-Fa-f]{6}$/.test(s);
}
