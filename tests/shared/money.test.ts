import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatMoney, isExpression, MAX_AMOUNT, minorToInput, parseAmount, pow10, sumAmounts, toMajor } from '../../src/shared/money';
import { allCurrencies, getCurrency } from '../../src/shared/currencies';

const CODES = allCurrencies().map(c => c.code);
const codeArb = fc.constantFrom(...CODES);
const minorArb = fc.oneof(
  fc.integer({ min: 0, max: 1000 }),
  fc.integer({ min: 0, max: 10_000_000 }),
  fc.integer({ min: 0, max: MAX_AMOUNT }),
  fc.constantFrom(0, 1, 5, 10, 99, 100, 101, 1000, 100000, MAX_AMOUNT),
);

/** ASCII digits and separators to their full-width forms (what a CJK keyboard can produce). */
function fullWidth(s: string): string {
  return s.replace(/[0-9.,+*/()-]/g, ch => {
    if (ch === '-') return '－';
    return String.fromCharCode(ch.charCodeAt(0) + 0xfee0);
  });
}

describe('parseAmount: plain numbers', () => {
  it.each([
    ['1200', 'TWD', 1200],
    ['12.5', 'USD', 1250],
    ['12.50', 'USD', 1250],
    ['0.05', 'USD', 5],
    ['.5', 'USD', 50],
    ['5.', 'USD', 500],
    ['007', 'TWD', 7],
    ['0', 'TWD', 0],
    ['0.00', 'USD', 0],
    ['12600', 'JPY', 12600],
  ])('%s in %s -> %d', (raw, code, want) => {
    expect(parseAmount(raw, code)).toBe(want);
  });
});

describe('parseAmount: separators', () => {
  it.each([
    // Grouping commas.
    ['1,234', 'TWD', 1234],
    ['1,234,567', 'TWD', 1234567],
    ['1,234.5', 'USD', 123450],
    ['1,234,567.89', 'USD', 123456789],
    ['1,23,456.78', 'INR', 12345678],
    // Decimal commas.
    ['12,5', 'EUR', 1250],
    ['0,75', 'EUR', 75],
    ['12,50', 'EUR', 1250],
    ['1234,56', 'EUR', 123456],
    // European grouping dots with a decimal comma, as pasted from a bank statement.
    ['1.234,56', 'EUR', 123456],
    ['1.234.567,89', 'EUR', 123456789],
    ['12.345,6', 'DKK', 1234560],
    // Space and apostrophe grouping.
    ['1 200', 'TWD', 1200],
    ['1 234,56', 'EUR', 123456],
    ["1'234.50", 'CHF', 123450],
  ])('%s in %s -> %d', (raw, code, want) => {
    expect(parseAmount(raw, code)).toBe(want);
  });
});

describe('parseAmount: full-width input', () => {
  it.each([
    ['１２００', 'TWD', 1200],
    ['１，２３４．５', 'USD', 123450],
    ['１２００+３５０', 'TWD', 1550],
    ['１２００＋３５０', 'TWD', 1550],
    ['（８０＋４５）÷２', 'TWD', 63],
    ['２×３', 'TWD', 6],
    ['１０−３', 'TWD', 7],
    ['５－２', 'TWD', 3],
    ['１２．５✕２', 'USD', 2500],
  ])('%s in %s -> %d', (raw, code, want) => {
    expect(parseAmount(raw, code)).toBe(want);
  });
});

describe('parseAmount: pasted symbols and words', () => {
  it.each([
    ['NT$ 1,200', 'TWD', 1200],
    ['NT$1,200元', 'TWD', 1200],
    ['¥12,600', 'JPY', 12600],
    ['12.50 USD', 'USD', 1250],
    ['US$1,250.50', 'USD', 125050],
    ['$5', 'USD', 500],
    ['€12,50', 'EUR', 1250],
    ['£8.99', 'GBP', 899],
    ['₩15,000', 'KRW', 15000],
    ['CHF 12.50', 'CHF', 1250],
    ['HK$ 88', 'HKD', 8800],
    ['฿100', 'THB', 10000],
    ['zł 25,50', 'PLN', 2550],
    ['R$ 19,90', 'BRL', 1990],
    // Peru's sol is written "S/" (and the older "S/."): the slash is not a division.
    ['S/ 25.50', 'PEN', 2550],
    ['S/. 25.50', 'PEN', 2550],
    ['s/25', 'PEN', 2500],
    // A period right after a letter ends an abbreviation ("Rs.", "kr."), it is not a decimal point.
    ['Rs. 1,500', 'INR', 150000],
    ['Rs.500', 'INR', 50000],
    ['kr. 125', 'DKK', 12500],
    ['kr. 1.234,50', 'DKK', 123450],
    ['1.234,50 kr.', 'DKK', 123450],
    ['Kč. 100', 'CZK', 10000],
    ['approx. 12.5', 'USD', 1250],
    ['12.5x.5', 'USD', 625],
  ])('%s in %s -> %d', (raw, code, want) => {
    expect(parseAmount(raw, code)).toBe(want);
  });
});

describe('parseAmount: expressions', () => {
  it.each([
    ['1200+350', 'TWD', 1550],
    ['3*450', 'TWD', 1350],
    ['(80+45)/2', 'USD', 6250],
    ['(80+45)/2', 'TWD', 63], // 62.5 rounds half up
    ['100/3', 'TWD', 33],
    ['200/3', 'TWD', 67],
    ['100/3', 'USD', 3333],
    ['0.1+0.2', 'USD', 30],
    ['1.005*1', 'USD', 101],
    ['2*(3+4)', 'TWD', 14],
    ['10-3', 'TWD', 7],
    ['--5', 'TWD', 5],
    ['1,200+350', 'TWD', 1550],
    ['1,234.5+1,000', 'USD', 223450],
    // Each number decides its own separators: 12,5 is a decimal comma even next to 1.5.
    ['12,5+1.5', 'EUR', 1400],
    // "x" between numbers is a multiplication sign, not a letter to drop (12.5x3 is not 12.53).
    ['12.5x3', 'USD', 3750],
    ['3 x 450', 'TWD', 1350],
    ['2X3', 'TWD', 6],
    ['(1+2)x3', 'TWD', 9],
  ])('%s in %s -> %d', (raw, code, want) => {
    expect(parseAmount(raw, code)).toBe(want);
  });
});

describe('parseAmount: rounding of extra decimals (half up)', () => {
  it.each([
    ['1.005', 'USD', 101],
    ['1.0049', 'USD', 100],
    ['0.995', 'USD', 100],
    ['9.995', 'USD', 1000],
    ['0.125', 'USD', 13],
    ['0.124', 'USD', 12],
    ['0.5', 'TWD', 1],
    ['0.49', 'TWD', 0],
    ['2.5', 'JPY', 3],
    ['1234.5', 'JPY', 1235],
    ['1,234.5', 'JPY', 1235],
  ])('%s in %s -> %d', (raw, code, want) => {
    expect(parseAmount(raw, code)).toBe(want);
  });
});

describe('parseAmount: invalid, negative and too large', () => {
  it.each([
    ['', 'TWD'],
    ['   ', 'TWD'],
    ['abc', 'TWD'],
    ['NT$', 'TWD'],
    ['.', 'USD'],
    ['1.2.3', 'USD'],
    ['1..5', 'USD'],
    ['5+', 'TWD'],
    ['+5', 'TWD'],
    ['*5', 'TWD'],
    ['()', 'TWD'],
    ['(5', 'TWD'],
    ['5)', 'TWD'],
    ['5/0', 'TWD'],
    [',5', 'EUR'],
    // Negative results are rejected (an amount is never negative).
    ['-5', 'TWD'],
    ['10-20', 'TWD'],
    ['−５', 'TWD'],
    ['-NT$1,200', 'TWD'],
    // Above MAX_AMOUNT.
    ['1000000000001', 'TWD'],
    ['10000000000.01', 'USD'],
    ['999999999999+2', 'TWD'],
    ['99999999999999999999', 'TWD'],
  ])('%j in %s -> null', (raw, code) => {
    expect(parseAmount(raw, code)).toBeNull();
  });

  it('accepts exactly MAX_AMOUNT and zero results', () => {
    expect(parseAmount('1000000000000', 'TWD')).toBe(MAX_AMOUNT);
    expect(parseAmount('10000000000.00', 'USD')).toBe(MAX_AMOUNT);
    expect(parseAmount('999999999999+1', 'TWD')).toBe(MAX_AMOUNT);
    expect(parseAmount('5-5', 'TWD')).toBe(0);
    const negZero = parseAmount('-0', 'TWD');
    expect(negZero).toBe(0);
    expect(Object.is(negZero, -0)).toBe(false);
  });

  it('property: the result is always null or a safe integer between 0 and MAX_AMOUNT', () => {
    const pieces = fc.constantFrom('1', '2', '9', '0', '.', ',', '+', '-', '*', '/', '(', ')', ' ', 'x', 'S/', '$', '¥', '１', '，', '．', 'e', '00');
    fc.assert(
      fc.property(fc.array(pieces, { maxLength: 14 }).map(p => p.join('')), codeArb, (raw, code) => {
        const v = parseAmount(raw, code);
        if (v !== null) {
          expect(Number.isSafeInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(MAX_AMOUNT);
          expect(Object.is(v, -0)).toBe(false);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('property: text without digits is never an amount', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 20 }).filter(s => !/[0-9０-９]/.test(s.normalize('NFKC'))), codeArb, (raw, code) => {
        expect(parseAmount(raw, code)).toBeNull();
      }),
      { numRuns: 1000 },
    );
  });

  it('property: a subtraction that goes below zero is rejected', () => {
    fc.assert(
      fc.property(minorArb, fc.integer({ min: 1, max: 1_000_000 }), codeArb, (a, d, code) => {
        expect(parseAmount(minorToInput(a, code) + '-' + minorToInput(a + d, code), code)).toBeNull();
      }),
      { numRuns: 500 },
    );
  });
});

describe('parseAmount: round trips', () => {
  it('property: minorToInput then parseAmount gives the same minor units, for every currency', () => {
    fc.assert(
      fc.property(minorArb, codeArb, (minor, code) => {
        expect(parseAmount(minorToInput(minor, code), code)).toBe(minor);
      }),
      { numRuns: 3000 },
    );
  });

  it('property: full-width digits parse the same as ASCII ones', () => {
    fc.assert(
      fc.property(minorArb, codeArb, (minor, code) => {
        expect(parseAmount(fullWidth(minorToInput(minor, code)), code)).toBe(minor);
      }),
      { numRuns: 1000 },
    );
  });

  it("property: the app's own formatMoney output pastes back to the same amount, for every currency and both locales", () => {
    fc.assert(
      fc.property(minorArb, codeArb, fc.constantFrom('en', 'zh-TW'), fc.boolean(), (minor, code, locale, bare) => {
        const text = formatMoney(minor, code, locale, { bare });
        expect(parseAmount(text, code)).toBe(minor);
      }),
      { numRuns: 3000 },
    );
  });

  it('property: European formatting (1.234,56) pastes back for currencies with cents', () => {
    const centCodes = CODES.filter(c => getCurrency(c).decimals === 2);
    const de = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fr = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    fc.assert(
      fc.property(minorArb, fc.constantFrom(...centCodes), fc.constantFrom(de, fr), (minor, code, nf) => {
        expect(parseAmount(nf.format(minor / 100), code)).toBe(minor);
      }),
      { numRuns: 2000 },
    );
  });

  it('property: sums and products of typed amounts', () => {
    fc.assert(
      fc.property(minorArb, minorArb, fc.integer({ min: 0, max: 50 }), codeArb, (a, b, k, code) => {
        const sum = parseAmount(minorToInput(a, code) + '+' + minorToInput(b, code), code);
        expect(sum).toBe(a + b <= MAX_AMOUNT ? a + b : null);
        const product = parseAmount(minorToInput(a, code) + '*' + k, code);
        expect(product).toBe(a * k <= MAX_AMOUNT ? a * k : null);
        const times = parseAmount(minorToInput(a, code) + 'x' + k, code);
        expect(times).toBe(product);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('isExpression', () => {
  it.each([
    ['1200+350', true],
    ['3*450', true],
    ['(80+45)/2', true],
    ['１２００＋３５０', true],
    ['10-3', true],
    ['12.5x3', true],
    ['(5)', true],
    ['12.5', false],
    ['5', false],
    ['-5', false],
    ['5-', false],
    ['1,234', false],
    ['12,5', false],
    ['NT$1,200', false],
    ['S/ 25.50', false],
    ['', false],
  ])('%s -> %s', (raw, want) => {
    expect(isExpression(raw)).toBe(want);
  });
});

describe('formatMoney', () => {
  it.each([
    [125050, 'USD', 'en', 'US$1,250.50'],
    [125050, 'USD', 'zh-TW', 'US$1,250.50'],
    [-1200, 'TWD', 'zh-TW', '-NT$1,200'],
    [1200, 'TWD', 'en', 'NT$1,200'],
    [1260000, 'JPY', 'zh-TW', '¥1,260,000'],
    [1250, 'EUR', 'en', '€12.50'],
    [899, 'GBP', 'en', '£8.99'],
    [1250, 'CHF', 'en', 'CHF 12.50'],
    [4000, 'KHR', 'en', 'KHR 4,000'],
    [2550, 'PEN', 'en', 'S/ 25.50'],
    [15000, 'KRW', 'zh-TW', '₩15,000'],
    [2500000, 'VND', 'en', '₫2,500,000'],
    [0, 'TWD', 'zh-TW', 'NT$0'],
    [0, 'USD', 'en', 'US$0.00'],
    [5, 'USD', 'en', 'US$0.05'],
    [-5, 'USD', 'en', '-US$0.05'],
    [1234, 'XYZ', 'en', 'XYZ 12.34'],
    [MAX_AMOUNT, 'USD', 'en', 'US$10,000,000,000.00'],
    [MAX_AMOUNT - 1, 'USD', 'en', 'US$9,999,999,999.99'],
    [MAX_AMOUNT, 'TWD', 'zh-TW', 'NT$1,000,000,000,000'],
  ])('(%d, %s, %s) -> %s', (minor, code, locale, want) => {
    expect(formatMoney(minor, code, locale)).toBe(want);
  });

  it('signs: auto, always and never, and zero never signed', () => {
    expect(formatMoney(1200, 'TWD', 'zh-TW', { sign: 'always' })).toBe('+NT$1,200');
    expect(formatMoney(-1200, 'TWD', 'zh-TW', { sign: 'always' })).toBe('-NT$1,200');
    expect(formatMoney(0, 'TWD', 'zh-TW', { sign: 'always' })).toBe('NT$0');
    expect(formatMoney(-1200, 'TWD', 'zh-TW', { sign: 'never' })).toBe('NT$1,200');
    expect(formatMoney(1200, 'TWD', 'zh-TW', { sign: 'never' })).toBe('NT$1,200');
    expect(formatMoney(-0, 'USD', 'en')).toBe('US$0.00');
  });

  it('bare leaves out the symbol', () => {
    expect(formatMoney(125050, 'USD', 'en', { bare: true })).toBe('1,250.50');
    expect(formatMoney(-125050, 'USD', 'en', { bare: true })).toBe('-1,250.50');
    expect(formatMoney(125050, 'USD', 'en', { bare: true, sign: 'always' })).toBe('+1,250.50');
  });

  it('defaults to zh-TW and treats any zh locale as zh-TW, anything else as en-US', () => {
    expect(formatMoney(123456, 'USD')).toBe('US$1,234.56');
    expect(formatMoney(123456, 'USD', 'zh')).toBe('US$1,234.56');
    expect(formatMoney(123456, 'USD', 'zh-Hant-TW')).toBe('US$1,234.56');
    expect(formatMoney(123456, 'USD', 'ja')).toBe('US$1,234.56');
  });

  it("property: every currency shows exactly its decimals, its symbol, and '-' or '+' in front", () => {
    fc.assert(
      fc.property(minorArb, codeArb, fc.constantFrom('en', 'zh-TW'), (minor, code, locale) => {
        const c = getCurrency(code);
        const body = formatMoney(minor, code, locale, { bare: true });
        const frac = c.decimals ? '\\.\\d{' + c.decimals + '}' : '';
        expect(body).toMatch(new RegExp('^\\d{1,3}(,\\d{3})*' + frac + '$'));
        const full = formatMoney(minor, code, locale);
        expect(full).toBe(c.symbol + body);
        expect(formatMoney(-minor, code, locale)).toBe(minor === 0 ? full : '-' + full);
        expect(formatMoney(-minor, code, locale, { sign: 'never' })).toBe(full);
        expect(formatMoney(minor, code, locale, { sign: 'always' })).toBe(minor === 0 ? full : '+' + full);
        expect(formatMoney(minor, code, 'en')).toBe(formatMoney(minor, code, 'zh-TW'));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('minorToInput', () => {
  it.each([
    [125050, 'USD', '1250.50'],
    [125000, 'USD', '1250'],
    [125005, 'USD', '1250.05'],
    [125010, 'USD', '1250.10'],
    [5, 'USD', '0.05'],
    [50, 'USD', '0.50'],
    [0, 'USD', '0'],
    [-125050, 'USD', '-1250.50'],
    [1200, 'TWD', '1200'],
    [-1200, 'TWD', '-1200'],
    [0, 'TWD', '0'],
    [MAX_AMOUNT, 'TWD', '1000000000000'],
    [MAX_AMOUNT, 'USD', '10000000000'],
  ])('(%d, %s) -> %s', (minor, code, want) => {
    expect(minorToInput(minor, code)).toBe(want);
  });

  it('property: plain digits, no grouping, either no fraction or all of the currency decimals', () => {
    fc.assert(
      fc.property(minorArb, codeArb, fc.boolean(), (minor, code, neg) => {
        const d = getCurrency(code).decimals;
        const s = minorToInput(neg && minor ? -minor : minor, code);
        expect(s).toMatch(new RegExp('^-?\\d+' + (d ? '(\\.\\d{' + d + '})?' : '') + '$'));
        if (minor % pow10(d) === 0) expect(s).not.toContain('.');
        expect(s.startsWith('-')).toBe(neg && minor !== 0);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('small helpers', () => {
  it('toMajor', () => {
    expect(toMajor(125050, 'USD')).toBe(1250.5);
    expect(toMajor(1200, 'TWD')).toBe(1200);
    expect(toMajor(-5, 'USD')).toBe(-0.05);
  });

  it('pow10', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(pow10)).toEqual([1, 10, 100, 1000, 10000, 100000, 1000000]);
    expect(pow10(8)).toBe(100000000);
  });

  it('sumAmounts', () => {
    expect(sumAmounts([])).toBe(0);
    expect(sumAmounts([{ amount: 120 }, { amount: -20 }, { amount: 900 }])).toBe(1000);
  });

  it('MAX_AMOUNT is 1e12 and stays a safe integer even times 1000', () => {
    expect(MAX_AMOUNT).toBe(1_000_000_000_000);
    expect(Number.isSafeInteger(MAX_AMOUNT * 1000)).toBe(true);
  });
});
