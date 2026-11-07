// Members' names cut to what the Worker takes (review-1106, unit W3; features/groups/memberNames.ts):
// at most 60 UTF-16 units, the way zod counts the Worker's name60, cut between characters as the
// iPhone app does (GroupsNames.clip). Names typed in 建立群組 and 設定 > 成員 (splitNames), a
// rename and a Splitwise import's new people all go through cleanName.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MEMBER_NAME_MAX, cleanName, clipUnits, splitNames } from '../../src/web/features/groups/memberNames';

/** The Worker's name60 (routes/groups.ts), which POST /groups, POST and PATCH /members and POST /friends check. */
const name60 = z.string().trim().min(1, 'Enter a name').max(60, 'At most 60 characters');

/** 🍣 and 𠮷: two UTF-16 units each. */
const SUSHI = '\u{1F363}';
const RARE = '\u{20BB7}';
/** A family emoji, one character of 8 UTF-16 units (man, ZWJ, woman, ZWJ, girl), and its first 5 units. */
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
const FAMILY_CUT = '\u{1F468}\u{200D}\u{1F469}';
/** 🇹🇼, one character of 4 UTF-16 units (two regional indicators). */
const FLAG = '\u{1F1F9}\u{1F1FC}';

/** Half of a surrogate pair on its own. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('cleanName', () => {
  it('keeps 30 of 31 sushi: 60 UTF-16 units, which the Worker takes (31 were sent and refused)', () => {
    const typed = SUSHI.repeat(31);
    expect(Array.from(typed)).toHaveLength(31);
    expect(name60.safeParse(typed).success).toBe(false);
    expect(cleanName(typed)).toBe(SUSHI.repeat(30));
    expect(name60.safeParse(cleanName(typed)).success).toBe(true);
    expect(cleanName(RARE.repeat(31))).toBe(RARE.repeat(30));
  });

  it('never ends in half a surrogate pair: one letter and 30 sushi keep 29 sushi', () => {
    const name = cleanName('a' + SUSHI.repeat(30));
    expect(name).toBe('a' + SUSHI.repeat(29));
    expect(name).toHaveLength(59);
    expect(LONE.test(name)).toBe(false);
  });

  it('keeps an emoji made of several code points whole, as the iPhone does', () => {
    expect(FAMILY).toHaveLength(8);
    expect(cleanName('a'.repeat(55) + FAMILY)).toBe('a'.repeat(55));
    expect(cleanName('a'.repeat(52) + FAMILY)).toBe('a'.repeat(52) + FAMILY);
    expect(cleanName('a'.repeat(58) + FLAG)).toBe('a'.repeat(58));
  });

  it('leaves names that fit as they are, with runs of spaces made one and the ends trimmed', () => {
    expect(cleanName('Abbie')).toBe('Abbie');
    expect(cleanName('  Abbie \t  Chen ')).toBe('Abbie Chen');
    expect(cleanName('佳穎')).toBe('佳穎');
    expect(cleanName('x'.repeat(60))).toBe('x'.repeat(60));
    expect(cleanName('x'.repeat(61))).toBe('x'.repeat(60));
    expect(cleanName('   ')).toBe('');
  });

  it('trims a cut that ends on a space, as the Worker trims', () => {
    expect(cleanName('a'.repeat(59) + ' bc')).toBe('a'.repeat(59));
  });

  it('gives a name the Worker takes for any text, the start of what was typed', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 90 }), fc.string({ unit: 'grapheme', maxLength: 70 })), raw => {
        const name = cleanName(raw);
        const typed = raw.replace(/\s+/g, ' ').trim();
        expect(name.length).toBeLessThanOrEqual(MEMBER_NAME_MAX);
        expect(LONE.test(name)).toBe(false);
        expect(typed.startsWith(name)).toBe(true);
        if (typed.length <= MEMBER_NAME_MAX) expect(name).toBe(typed);
        if (name) expect(name60.safeParse(name).success).toBe(true);
      }),
    );
  });
});

describe('clipUnits', () => {
  it('cuts by UTF-16 units, between characters', () => {
    expect(clipUnits('abc', 3)).toBe('abc');
    expect(clipUnits('abcd', 3)).toBe('abc');
    expect(clipUnits(SUSHI + SUSHI, 3)).toBe(SUSHI);
    expect(clipUnits(SUSHI, 1)).toBe('');
  });

  it('without Intl.Segmenter (Firefox before 125) cuts between code points, still never inside a surrogate pair', () => {
    const real = Intl.Segmenter;
    const intl = Intl as { Segmenter?: unknown };
    try {
      intl.Segmenter = undefined;
      expect(clipUnits('a'.repeat(55) + FAMILY, 60)).toBe('a'.repeat(55) + FAMILY_CUT);
      expect(cleanName(SUSHI.repeat(31))).toBe(SUSHI.repeat(30));
      expect(cleanName('a' + SUSHI.repeat(30))).toBe('a' + SUSHI.repeat(29));
    } finally {
      intl.Segmenter = real;
    }
    expect(clipUnits('a'.repeat(55) + FAMILY, 60)).toBe('a'.repeat(55));
  });
});

describe('splitNames', () => {
  it('splits a typed or pasted list on commas, 、, semicolons, tabs and new lines', () => {
    expect(splitNames('Abbie, Kevin、Leo\n佳穎；小明;Ann\tBo，Cy\r\n')).toEqual(['Abbie', 'Kevin', 'Leo', '佳穎', '小明', 'Ann', 'Bo', 'Cy']);
    expect(splitNames(' , 、\n')).toEqual([]);
  });

  it('cuts each name to what the Worker takes', () => {
    const names = splitNames(SUSHI.repeat(31) + '、' + RARE.repeat(40) + ', Abbie');
    expect(names).toEqual([SUSHI.repeat(30), RARE.repeat(30), 'Abbie']);
    for (const n of names) expect(name60.safeParse(n).success).toBe(true);
  });
});
