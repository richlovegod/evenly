// Calendar dates as 'YYYY-MM-DD' strings. All math runs in UTC so time zones and DST never
// shift a date.

export type Repeat = 'none' | 'weekly' | 'biweekly' | 'monthly' | 'yearly';
export const REPEATS: readonly Repeat[] = ['none', 'weekly', 'biweekly', 'monthly', 'yearly'];

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function parts(iso: string): [number, number, number] {
  const m = RE.exec(iso);
  if (!m) throw new Error('bad date ' + iso);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function fmt(y: number, m: number, d: number): string {
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = parts(iso);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Add months keeping the anchor day, clamped to the month's length (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso: string, n: number, anchorDay?: number): string {
  const [y, m, d] = parts(iso);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(ny, nm));
  return fmt(ny, nm, day);
}

/** The n-th occurrence (n = 0 is `start` itself) of a series. */
export function occurrence(start: string, repeat: Repeat, n: number): string {
  switch (repeat) {
    case 'weekly': return addDays(start, 7 * n);
    case 'biweekly': return addDays(start, 14 * n);
    case 'monthly': return addMonths(start, n, parts(start)[2]);
    case 'yearly': return addMonths(start, 12 * n, parts(start)[2]);
    default: return start;
  }
}

/** First occurrence of the series strictly after `after`, or null for 'none'. */
export function nextOccurrence(start: string, repeat: Repeat, after: string): string | null {
  // An unknown value (say 'daily' from a bad row) is treated as 'none': occurrence() would
  // return `start` forever and the loop below would never end.
  if (repeat === 'none' || !REPEATS.includes(repeat)) return null;
  if (start > after) return start;
  // Estimate n, then step forward; occurrence() is monotonic in n.
  let n = 1;
  if (repeat === 'monthly' || repeat === 'yearly') {
    const [sy, sm] = parts(start);
    const [ay, am] = parts(after);
    const months = (ay - sy) * 12 + (am - sm);
    n = Math.max(1, repeat === 'monthly' ? months : Math.floor(months / 12));
    while (n > 1 && occurrence(start, repeat, n - 1) > after) n--;
  } else {
    const step = repeat === 'weekly' ? 7 : 14;
    const days = Math.round((Date.parse(after + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000);
    n = Math.max(1, Math.floor(days / step));
  }
  let d = occurrence(start, repeat, n);
  while (d <= after) d = occurrence(start, repeat, ++n);
  return d;
}

/** Today's date in a time zone (default: the runtime's local zone). */
export function todayISO(now: Date = new Date(), timeZone?: string): string {
  if (timeZone) {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return f.format(now);
  }
  return fmt(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Today's date in UTC. */
export function todayUTC(now: Date = new Date()): string {
  return fmt(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
}

export function isoMonth(iso: string): string {
  return iso.slice(0, 7);
}
