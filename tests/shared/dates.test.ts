import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addDays, addMonths, daysInMonth, isISODate, isoMonth, nextOccurrence, occurrence, REPEATS, todayISO, todayUTC, type Repeat } from '../../src/shared/dates';

const DAY = 86_400_000;
const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

// Dates from 2000-01-01 to 2099-12-31, biased toward month ends and leap days.
const BASE = Date.UTC(2000, 0, 1);
const plainDateArb = fc.integer({ min: 0, max: 36524 }).map(d => isoOf(BASE + d * DAY));
const monthEndArb = fc
  .record({ y: fc.integer({ min: 2000, max: 2099 }), m: fc.integer({ min: 1, max: 12 }), back: fc.integer({ min: 0, max: 3 }) })
  .map(({ y, m, back }) => `${y}-${String(m).padStart(2, '0')}-${String(daysInMonth(y, m) - back).padStart(2, '0')}`);
const leapDayArb = fc.constantFrom(2000, 2004, 2008, 2012, 2016, 2020, 2024, 2028, 2032, 2096).map(y => `${y}-02-29`);
const dateArb = fc.oneof(plainDateArb, monthEndArb, leapDayArb);
const repeatArb = fc.constantFrom<Repeat>('weekly', 'biweekly', 'monthly', 'yearly');

describe('isISODate', () => {
  it.each(['2026-10-16', '2028-02-29', '2000-02-29', '1970-01-01', '2200-12-31', '2026-01-31', '2026-04-30', '2026-12-31'])('%s is valid', s => {
    expect(isISODate(s)).toBe(true);
  });

  it.each([
    '2026-02-29',
    '2100-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-01-00',
    '2026-01-32',
    '2026-1-01',
    '26-01-01',
    '2026/01/01',
    '2026-01-01T00:00:00Z',
    ' 2026-01-01',
    '',
    '1969-12-31',
    '2201-01-01',
  ])('%j is not valid', s => {
    expect(isISODate(s)).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const v of [20261016, null, undefined, new Date(), {}, ['2026-10-16']]) expect(isISODate(v)).toBe(false);
  });

  it('property: agrees with the calendar for every YYYY-MM-DD shaped string', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1970, max: 2200 }), fc.integer({ min: 0, max: 13 }), fc.integer({ min: 0, max: 32 }), (y, m, d) => {
        const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const t = Date.UTC(y, m - 1, d);
        const real = m >= 1 && m <= 12 && d >= 1 && isoOf(t) === s;
        expect(isISODate(s)).toBe(real);
      }),
      { numRuns: 3000 },
    );
  });
});

describe('daysInMonth', () => {
  it('knows month lengths and leap years', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('property: the last valid day of every month', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1970, max: 2199 }), fc.integer({ min: 1, max: 12 }), (y, m) => {
        const n = daysInMonth(y, m);
        const mm = String(m).padStart(2, '0');
        expect(isISODate(`${y}-${mm}-${n}`)).toBe(true);
        expect(isISODate(`${y}-${mm}-${n + 1}`)).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('addDays', () => {
  it.each([
    ['2026-01-31', 1, '2026-02-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2026-10-16', 0, '2026-10-16'],
    ['2026-10-16', 365, '2027-10-16'],
    ['2026-10-16', -365, '2025-10-16'],
    // US daylight saving changes (2026-03-08, 2026-11-01) never shift a date.
    ['2026-03-07', 1, '2026-03-08'],
    ['2026-03-08', 1, '2026-03-09'],
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-11-01', 1, '2026-11-02'],
  ])('%s %+d -> %s', (d, n, want) => {
    expect(addDays(d, n)).toBe(want);
  });

  it('throws on a malformed date', () => {
    expect(() => addDays('2026/10/16', 1)).toThrow(/bad date/);
  });

  it('property: exact day distance, reversible, always a valid date', () => {
    fc.assert(
      fc.property(dateArb, fc.integer({ min: -4000, max: 4000 }), (d, n) => {
        const r = addDays(d, n);
        expect(isISODate(r)).toBe(true);
        expect(dayDiff(d, r)).toBe(n);
        expect(addDays(r, -n)).toBe(d);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('addMonths', () => {
  it.each([
    ['2026-01-31', 1, undefined, '2026-02-28'],
    ['2028-01-31', 1, undefined, '2028-02-29'],
    ['2026-03-31', -1, undefined, '2026-02-28'],
    ['2026-01-15', 12, undefined, '2027-01-15'],
    ['2026-11-30', 3, undefined, '2027-02-28'],
    ['2026-01-15', -13, undefined, '2024-12-15'],
    ['2026-12-31', 1, undefined, '2027-01-31'],
    ['2026-02-28', 1, undefined, '2026-03-28'],
    // The anchor day brings a clamped date back to the 31st.
    ['2026-02-28', 1, 31, '2026-03-31'],
    ['2026-02-28', 2, 31, '2026-04-30'],
    ['2026-02-28', 0, 31, '2026-02-28'],
  ])('%s %+d months (anchor %s) -> %s', (d, n, anchor, want) => {
    expect(addMonths(d, n, anchor)).toBe(want);
  });

  it('property: lands in the right month on min(anchor, month length)', () => {
    // Offsets keep results inside isISODate's 1970 to 2200 range for starts in 2000 to 2099.
    fc.assert(
      fc.property(dateArb, fc.integer({ min: -360, max: 400 }), fc.option(fc.integer({ min: 1, max: 31 }), { nil: undefined }), (d, n, anchor) => {
        const r = addMonths(d, n, anchor);
        expect(isISODate(r)).toBe(true);
        const [y, m, day] = d.split('-').map(Number);
        const total = y * 12 + (m - 1) + n;
        const ry = Math.floor(total / 12);
        const rm = (total % 12) + 1;
        expect(r.slice(0, 7)).toBe(`${ry}-${String(rm).padStart(2, '0')}`);
        expect(Number(r.slice(8))).toBe(Math.min(anchor ?? day, daysInMonth(ry, rm)));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('occurrence', () => {
  it('weekly and every two weeks', () => {
    expect(occurrence('2026-10-16', 'weekly', 0)).toBe('2026-10-16');
    expect(occurrence('2026-10-16', 'weekly', 1)).toBe('2026-10-23');
    expect(occurrence('2026-10-16', 'weekly', 3)).toBe('2026-11-06');
    expect(occurrence('2026-12-25', 'weekly', 1)).toBe('2027-01-01');
    expect(occurrence('2026-10-16', 'biweekly', 2)).toBe('2026-11-13');
  });

  it('monthly keeps the start day, clamped at month ends, including leap years', () => {
    const got = [0, 1, 2, 3, 13, 25].map(n => occurrence('2026-01-31', 'monthly', n));
    expect(got).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2027-02-28', '2028-02-29']);
    expect(occurrence('2026-08-30', 'monthly', 6)).toBe('2027-02-28');
    expect(occurrence('2026-08-30', 'monthly', 7)).toBe('2027-03-30');
  });

  it('yearly from a leap day falls back to Feb 28 and returns to Feb 29 in leap years', () => {
    expect([1, 2, 3, 4, 8].map(n => occurrence('2024-02-29', 'yearly', n))).toEqual(['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29', '2032-02-29']);
    // 2100 is not a leap year.
    expect(occurrence('2096-02-29', 'yearly', 4)).toBe('2100-02-28');
  });

  it("'none' always returns the start", () => {
    expect(occurrence('2026-10-16', 'none', 5)).toBe('2026-10-16');
  });

  it('property: strictly increasing in n for every repeat', () => {
    fc.assert(
      fc.property(dateArb, repeatArb, fc.integer({ min: 0, max: 600 }), (start, rep, n) => {
        expect(occurrence(start, rep, n + 1) > occurrence(start, rep, n)).toBe(true);
        expect(occurrence(start, rep, 0)).toBe(start);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('nextOccurrence', () => {
  it('examples, including month ends', () => {
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-02-10')).toBe('2026-02-28');
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-02-28')).toBe('2026-03-31');
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-03-31')).toBe('2026-04-30');
    expect(nextOccurrence('2024-02-29', 'yearly', '2025-03-01')).toBe('2026-02-28');
    expect(nextOccurrence('2024-02-29', 'yearly', '2027-02-28')).toBe('2028-02-29');
    expect(nextOccurrence('2026-10-16', 'weekly', '2026-10-16')).toBe('2026-10-23');
    expect(nextOccurrence('2026-10-16', 'weekly', '2026-10-22')).toBe('2026-10-23');
    expect(nextOccurrence('2026-10-16', 'weekly', '2026-10-23')).toBe('2026-10-30');
    expect(nextOccurrence('2026-01-01', 'biweekly', '2026-12-31')).toBe('2027-01-14');
  });

  it('returns the start while it is still in the future, and null for no repeat', () => {
    expect(nextOccurrence('2026-11-01', 'monthly', '2026-10-16')).toBe('2026-11-01');
    expect(nextOccurrence('2026-10-16', 'none', '2026-10-01')).toBeNull();
    expect(nextOccurrence('2026-10-16', 'none', '2026-12-01')).toBeNull();
  });

  it('treats an unknown repeat value (bad data) as no repeat instead of looping forever', () => {
    expect(nextOccurrence('2026-10-01', 'daily' as Repeat, '2026-10-16')).toBeNull();
    expect(nextOccurrence('2026-10-01', '' as Repeat, '2026-10-16')).toBeNull();
  });

  it('property: the result is the first occurrence strictly after `after`, with none in between', () => {
    fc.assert(
      fc.property(dateArb, repeatArb, fc.integer({ min: -400, max: 20 * 366 }), (start, rep, offset) => {
        const after = addDays(start, offset);
        const got = nextOccurrence(start, rep, after);
        // Brute force: walk the series from the start.
        let n = 0;
        while (occurrence(start, rep, n) <= after) n++;
        expect(got).toBe(occurrence(start, rep, n));
        expect(got! > after).toBe(true);
        if (n > 0) expect(occurrence(start, rep, n - 1) <= after).toBe(true);
        else expect(got).toBe(start);
      }),
      { numRuns: 1500 },
    );
  });
});

describe('today and months', () => {
  it('todayUTC and todayISO in a time zone', () => {
    const late = new Date('2026-10-16T23:30:00Z');
    expect(todayUTC(late)).toBe('2026-10-16');
    expect(todayISO(late, 'Asia/Taipei')).toBe('2026-10-17');
    expect(todayISO(new Date('2026-10-16T06:30:00Z'), 'America/Los_Angeles')).toBe('2026-10-15');
    expect(todayISO(new Date('2026-01-01T00:30:00Z'), 'Asia/Tokyo')).toBe('2026-01-01');
    expect(todayISO(new Date('2026-01-01T00:30:00Z'), 'America/New_York')).toBe('2025-12-31');
  });

  it('todayISO without a zone uses the local calendar date', () => {
    expect(todayISO(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05');
    expect(todayISO(new Date(2028, 1, 29, 0, 1))).toBe('2028-02-29');
  });

  it('isoMonth and REPEATS', () => {
    expect(isoMonth('2026-10-16')).toBe('2026-10');
    expect(REPEATS).toEqual(['none', 'weekly', 'biweekly', 'monthly', 'yearly']);
  });
});
