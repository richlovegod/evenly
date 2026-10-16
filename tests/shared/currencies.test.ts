import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allCurrencies, COMMON_CURRENCIES, currencyDecimals, currencyName, getCurrency, isKnownCurrency } from '../../src/shared/currencies';
import { AVATAR_COLORS, colorFor, GROUP_COLORS, isHexColor, nextColor } from '../../src/shared/colors';
import { GROUP_TYPES } from '../../src/shared/types';

describe('currencies', () => {
  it('uses 0 decimals where people split whole units (SPEC section 2) and 2 elsewhere', () => {
    for (const code of ['TWD', 'JPY', 'KRW', 'VND', 'IDR', 'HUF']) expect(currencyDecimals(code)).toBe(0);
    for (const code of ['USD', 'EUR', 'CNY', 'HKD', 'GBP', 'CAD', 'SGD', 'THB']) expect(currencyDecimals(code)).toBe(2);
  });

  it('describes a known currency', () => {
    expect(getCurrency('TWD')).toEqual({ code: 'TWD', decimals: 0, symbol: 'NT$', zh: '新台幣', en: 'New Taiwan dollar' });
    expect(currencyName('JPY', 'zh-TW')).toBe('日圓');
    expect(currencyName('JPY', 'en')).toBe('Japanese yen');
    expect(isKnownCurrency('USD')).toBe(true);
  });

  it('gives an unknown but well-formed code 2 decimals and the code as its prefix', () => {
    expect(getCurrency('XYZ')).toEqual({ code: 'XYZ', decimals: 2, symbol: 'XYZ ', zh: 'XYZ', en: 'XYZ' });
    expect(isKnownCurrency('XYZ')).toBe(false);
    expect(currencyName('XYZ', 'zh-TW')).toBe('XYZ');
  });

  it('table: unique 3-letter codes, 0 or 2 decimals, unambiguous symbols without digits', () => {
    const list = allCurrencies();
    const codes = list.map(c => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    const symbols = list.map(c => c.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
    for (const c of list) {
      expect(c.code).toMatch(/^[A-Z]{3}$/);
      expect([0, 2]).toContain(c.decimals);
      expect(c.symbol.length).toBeGreaterThan(0);
      // parseAmount strips pasted symbols, so a symbol must not contain digits.
      expect(c.symbol).not.toMatch(/[0-9]/);
      expect(['$', 'kr', 'kr ']).not.toContain(c.symbol);
      expect(c.zh.length).toBeGreaterThan(0);
      expect(c.en.length).toBeGreaterThan(0);
      expect(getCurrency(c.code)).toBe(c);
    }
  });

  it('common currencies are known, unique and start with TWD', () => {
    expect(COMMON_CURRENCIES[0]).toBe('TWD');
    expect(new Set(COMMON_CURRENCIES).size).toBe(COMMON_CURRENCIES.length);
    for (const c of COMMON_CURRENCIES) expect(isKnownCurrency(c)).toBe(true);
  });
});

/** WCAG 2 contrast ratio of a #RRGGBB color against white. */
function contrastWithWhite(hex: string): number {
  const ch = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return 1.05 / (lum + 0.05);
}

describe('colors', () => {
  it('every avatar color is a hex color readable with white initials (contrast >= 4.5:1)', () => {
    expect(AVATAR_COLORS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(AVATAR_COLORS).size).toBe(AVATAR_COLORS.length);
    for (const c of AVATAR_COLORS) {
      expect(isHexColor(c)).toBe(true);
      expect(contrastWithWhite(c)).toBeGreaterThanOrEqual(4.5);
    }
    expect(GROUP_COLORS).toEqual(AVATAR_COLORS);
  });

  it('colorFor is deterministic and always in the palette', () => {
    expect(colorFor('')).toBe(AVATAR_COLORS[0]);
    expect(colorFor('a')).toBe(AVATAR_COLORS[97 % AVATAR_COLORS.length]);
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 40 }), s => {
        expect(AVATAR_COLORS).toContain(colorFor(s));
        expect(colorFor(s)).toBe(colorFor(s));
      }),
      { numRuns: 500 },
    );
  });

  it('nextColor picks the first unused color, then falls back to colorFor', () => {
    expect(nextColor([], 'x')).toBe(AVATAR_COLORS[0]);
    expect(nextColor([AVATAR_COLORS[0], AVATAR_COLORS[2]], 'x')).toBe(AVATAR_COLORS[1]);
    expect(nextColor([...AVATAR_COLORS], 'gino')).toBe(colorFor('gino'));
  });

  it('isHexColor accepts #RRGGBB only', () => {
    for (const ok of ['#2F6FB5', '#000000', '#ffffff', '#AbCdEf']) expect(isHexColor(ok)).toBe(true);
    for (const bad of ['#abc', '2F6FB5', '#GGGGGG', '#2F6FB5 ', '#2F6FB5FF', '', 123, null, undefined]) expect(isHexColor(bad)).toBe(false);
  });
});

describe('types', () => {
  it('GROUP_TYPES lists every group type', () => {
    expect(GROUP_TYPES).toEqual(['trip', 'home', 'couple', 'other', 'pair']);
  });
});
