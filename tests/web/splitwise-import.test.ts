// The Splitwise CSV importer (src/web/features/groups/splitwiseImport.ts): CSV reading, the
// mapping of rows to entries, rounding for currencies without cents, and our own CSV export rows.
// The last block runs the Worker's own import validation on what the importer produces.

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('../../src/worker/auth', () => ({
  requireUser: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../src/worker/services/summary', () => ({
  refreshSummary: vi.fn(async () => null),
}));
vi.mock('../../src/worker/services/activity', () => ({
  activityStmt: vi.fn(),
  activitySelect: vi.fn(() => ''),
  entryActivityData: vi.fn(() => ({})),
  toActivityDTO: vi.fn((r: unknown) => r),
}));
vi.mock('../../src/worker/services/fx', () => ({
  getUsdRates: vi.fn(async () => ({ date: '2026-10-16', rates: { USD: 1 }, source: 'test' })),
}));

import { entryNet } from '../../src/shared/balances';
import { checkPayers, computeSharesFor } from '../../src/shared/split';
import type { ExpenseDTO, MemberDTO } from '../../src/shared/types';
import {
  buildExportRows,
  buildImport,
  centsToMinor,
  decimalString,
  detectDelimiter,
  fileCurrencies,
  foreignCurrencies,
  importId,
  mapSplitwiseCategory,
  parseCents,
  parseCsvRecords,
  parseSplitwiseCsv,
  parseSplitwiseDate,
  suggestMembers,
  type ExportLabels,
  type ImportEntry,
  type ImportOptions,
  type SplitwiseFile,
} from '../../src/web/features/groups/splitwiseImport';

const TODAY = '2026-10-16';
const BOM = String.fromCharCode(0xfeff);

// A group export as Splitwise writes it: blank line after the header, quoted descriptions with
// commas, doubled quotes and a line break, Chinese text, payments, a row that changes nobody's
// balance, two people paying one bill, and the "Total balance" row at the end.
const GROUP_CSV = [
  'Date,Description,Category,Cost,Currency,Gino Chang,Abbie Lin,Kevin Lin',
  '',
  '2026-09-01,Groceries,Groceries,45.00,USD,30.00,-15.00,-15.00',
  '2026-09-03,"Dinner, with wine",Dining out,120.00,USD,-40.00,80.00,-40.00',
  '2026-09-04,"燒肉晚餐 ""大份""",Dining out,90.00,USD,60.00,-30.00,-30.00',
  '2026-09-05,Hotel Shibuya,Hotel,300.00,USD,-100.00,-100.00,200.00',
  '2026-09-06,Uber to airport,General,36.00,USD,24.00,-12.00,-12.00',
  '2026-09-07,Gino C. paid Abbie W.,Payment,15.00,USD,15.00,-15.00,0.00',
  '2026-09-08,Ski lift tickets,General,300.00,USD,50.00,50.00,-100.00',
  '2026-09-09,便利商店,General,9.99,USD,-3.33,-3.33,6.66',
  '2026-09-10,Personal souvenir,General,20.00,USD,0.00,0.00,0.00',
  '2026-09-11,"Train tickets',
  'Tokyo to Kyoto",Bus/train,150.00,USD,-50.00,-50.00,100.00',
  '2026-09-12,Abbie W. paid Kevin L.,Payment,50.00,USD,0.00,50.00,-50.00',
  '',
  '2026-10-16,Total balance, , ,USD,-14.33,-45.33,59.66',
  '',
].join('\n');

const IDS = ['g', 'a', 'k'];

function readFile(text: string): SplitwiseFile {
  const r = parseSplitwiseCsv(text);
  if (!r.ok) throw new Error('parse failed: ' + r.error);
  return r.file;
}

function plan(text: string, opts: Partial<ImportOptions> = {}) {
  const file = readFile(text);
  return buildImport(file, {
    groupId: 'grp-1',
    groupCurrency: 'USD',
    memberIds: IDS,
    today: TODAY,
    fallbackDescription: 'Splitwise',
    ...opts,
  });
}

/** Net effect of each entry per member, in the entry's own currency, as the server would store it. */
function entryNets(e: ImportEntry): Record<string, number> {
  const sr = computeSharesFor(e.id, e.amount, e.split);
  if (!sr.ok) throw new Error('split does not add up: ' + sr.code);
  const out: Record<string, number> = {};
  for (const p of e.payers) out[p.memberId] = (out[p.memberId] ?? 0) + p.amount;
  for (const s of sr.shares) out[s.memberId] = (out[s.memberId] ?? 0) - s.amount;
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
}

function expectStorable(e: ImportEntry) {
  expect(e.id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  expect(Number.isSafeInteger(e.amount) && e.amount > 0).toBe(true);
  expect(checkPayers(e.amount, e.payers)).toEqual({ ok: true });
  expect(computeSharesFor(e.id, e.amount, e.split).ok).toBe(true);
  expect(e.split.method).toBe('exact');
  if (e.kind === 'payment') {
    expect(e.description).toBe('');
    expect(e.category).toBe('payment');
    expect(e.payers).toHaveLength(1);
    expect(e.split.entries).toHaveLength(1);
    expect(e.split.entries[0].memberId).not.toBe(e.payers[0].memberId);
  } else {
    expect(e.description.length).toBeGreaterThan(0);
    expect(e.category).not.toBe('payment');
  }
}

describe('CSV text', () => {
  it('reads quotes, doubled quotes, commas and line breaks inside fields', () => {
    const recs = parseCsvRecords('a,"b, c","say ""hi""","two\nlines"\n1,2,3,4\n');
    expect(recs).toEqual([
      { line: 1, cells: ['a', 'b, c', 'say "hi"', 'two\nlines'] },
      { line: 3, cells: ['1', '2', '3', '4'] },
    ]);
  });

  it('handles CRLF, a byte order mark, empty fields and a last line without a newline', () => {
    const recs = parseCsvRecords(BOM + 'x,y\r\n,\r\n"",z');
    expect(recs.map(r => r.cells)).toEqual([['x', 'y'], ['', ''], ['', 'z']]);
    expect(recs.map(r => r.line)).toEqual([1, 2, 3]);
  });

  it('keeps a stray quote inside an unquoted field', () => {
    expect(parseCsvRecords('5" screen,ok')[0].cells).toEqual(['5" screen', 'ok']);
  });

  it('detects the delimiter from the header', () => {
    expect(detectDelimiter('Date,Description,Cost')).toBe(',');
    expect(detectDelimiter('Date;Description;Cost;"a,b"')).toBe(';');
    expect(detectDelimiter('Date\tDescription\tCost')).toBe('\t');
  });

  it('reads amounts as hundredths', () => {
    expect(parseCents('45.00')).toBe(4500);
    expect(parseCents('-12.50')).toBe(-1250);
    expect(parseCents('1,234.56')).toBe(123456);
    expect(parseCents('(7.25)')).toBe(-725);
    expect(parseCents('12,50')).toBe(1250);
    expect(parseCents(String.fromCharCode(0x2212) + '3.33')).toBe(-333);
    expect(parseCents('')).toBe(0);
    expect(parseCents(' ')).toBe(0);
    expect(parseCents('-0.00')).toBe(0);
    expect(parseCents('abc')).toBeNull();
    expect(parseCents('1+2')).toBeNull();
  });

  it('reads dates', () => {
    expect(parseSplitwiseDate('2026-09-01')).toBe('2026-09-01');
    expect(parseSplitwiseDate('2026-09-01T23:10:00Z')).toBe('2026-09-01');
    expect(parseSplitwiseDate('2026/9/1')).toBe('2026-09-01');
    expect(parseSplitwiseDate('9/1/2026')).toBe('2026-09-01');
    expect(parseSplitwiseDate('2026-02-30')).toBeNull();
    expect(parseSplitwiseDate('yesterday')).toBeNull();
  });
});

describe('reading a Splitwise export', () => {
  it('finds the people, the rows and the total row', () => {
    const file = readFile(GROUP_CSV);
    expect(file.people).toEqual(['Gino Chang', 'Abbie Lin', 'Kevin Lin']);
    expect(file.rows).toHaveLength(11);
    expect(file.totals).toEqual([{ currency: 'USD', nets: [-1433, -4533, 5966] }]);
    const dinner = file.rows[1];
    expect(dinner.description).toBe('Dinner, with wine');
    expect(dinner.nets).toEqual([-4000, 8000, -4000]);
    expect(file.rows[2].description).toBe('燒肉晚餐 "大份"');
    expect(file.rows[9].description).toBe('Train tickets\nTokyo to Kyoto');
    expect(file.rows[9].line).toBe(12);
    expect(file.rows[10].line).toBe(14);
    expect(file.rows.filter(r => r.isPayment)).toHaveLength(2);
  });

  it('rejects files that are not Splitwise exports', () => {
    expect(parseSplitwiseCsv('')).toEqual({ ok: false, error: 'empty' });
    expect(parseSplitwiseCsv('\n\n')).toEqual({ ok: false, error: 'empty' });
    expect(parseSplitwiseCsv('name,email\nGino,g@example.com\nAbbie,a@example.com')).toEqual({ ok: false, error: 'not_splitwise' });
    expect(parseSplitwiseCsv('Date,Description,Category,Cost,Currency\n2026-09-01,x,General,1.00,USD')).toEqual({ ok: false, error: 'no_people' });
  });

  it('accepts a header in another language by position', () => {
    const r = parseSplitwiseCsv('Datum,Beschreibung,Kategorie,Kosten,Währung,Gino,Abbie\n2026-09-01,Pizza,Essen,20.00,EUR,10.00,-10.00');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.people).toEqual(['Gino', 'Abbie']);
  });
});

describe('categories', () => {
  it('maps Splitwise names, else detects from the description, else general', () => {
    expect(mapSplitwiseCategory('Dining out', 'whatever')).toBe('food.dining');
    expect(mapSplitwiseCategory('Groceries', '')).toBe('food.groceries');
    expect(mapSplitwiseCategory('Hotel', '')).toBe('travel.hotel');
    expect(mapSplitwiseCategory('Taxi', '')).toBe('transport.taxi');
    expect(mapSplitwiseCategory('Bus/train', '')).toBe('transport.train');
    expect(mapSplitwiseCategory('TV/Phone/Internet', '')).toBe('utilities.internet');
    expect(mapSplitwiseCategory('Medical expenses', '')).toBe('life.medical');
    expect(mapSplitwiseCategory('Food and drink - Dining out', '')).toBe('food.dining');
    expect(mapSplitwiseCategory('General', 'Uber to airport')).toBe('transport.taxi');
    expect(mapSplitwiseCategory('General', '燒肉晚餐')).toBe('food.dining');
    expect(mapSplitwiseCategory('Other', 'Something odd')).toBe('general');
    expect(mapSplitwiseCategory('', '')).toBe('general');
  });
});

describe('building the import', () => {
  it('maps a whole group export', () => {
    const p = plan(GROUP_CSV);
    expect(p.entries).toHaveLength(10);
    expect(p.expenseCount).toBe(8);
    expect(p.paymentCount).toBe(2);
    expect(p.skipped).toEqual([{ line: 11, date: '2026-09-10', description: 'Personal souvenir', reason: 'no_change' }]);
    expect(p.firstDate).toBe('2026-09-01');
    expect(p.lastDate).toBe('2026-09-12');
    expect(p.rounded).toBe(0);
    for (const e of p.entries) expectStorable(e);

    // Balances after the import equal Splitwise's own total row.
    expect(p.netByMember).toEqual({ g: -1433, a: -4533, k: 5966 });
    expect(p.expected).toEqual({ g: -1433, a: -4533, k: 5966 });
    // Spending counts expenses only.
    expect(p.spent).toBe(4500 + 12000 + 9000 + 30000 + 3600 + 10000 + 999 + 15000);
  });

  it('turns a one-payer row into the full cost and exact shares', () => {
    const [groceries, dinner] = plan(GROUP_CSV).entries;
    expect(groceries).toMatchObject({
      kind: 'expense',
      description: 'Groceries',
      category: 'food.groceries',
      amount: 4500,
      currency: 'USD',
      fxRate: 1,
      date: '2026-09-01',
      notes: '',
      payers: [{ memberId: 'g', amount: 4500 }],
      split: { method: 'exact', entries: [{ memberId: 'g', value: 1500 }, { memberId: 'a', value: 1500 }, { memberId: 'k', value: 1500 }] },
    });
    expect(dinner.payers).toEqual([{ memberId: 'a', amount: 12000 }]);
    expect(dinner.description).toBe('Dinner, with wine');
    expect(dinner.category).toBe('food.dining');
  });

  it('rebuilds a several-payer row from the balances and keeps the cost in the notes', () => {
    const lift = plan(GROUP_CSV).entries.find(e => e.date === '2026-09-08')!;
    expect(lift).toMatchObject({
      kind: 'expense',
      category: 'travel.ski',
      amount: 10000,
      payers: [{ memberId: 'g', amount: 5000 }, { memberId: 'a', amount: 5000 }],
      split: { method: 'exact', entries: [{ memberId: 'k', value: 10000 }] },
    });
    expect(lift.notes).toBe('Splitwise cost: 300.00 USD');
    const custom = plan(GROUP_CSV, { costNote: (c, cur) => `Splitwise 原始金額 ${cur} ${c}` }).entries.find(e => e.date === '2026-09-08')!;
    expect(custom.notes).toBe('Splitwise 原始金額 USD 300.00');
  });

  it('maps payments: positive sender, negative recipient, no description', () => {
    const pays = plan(GROUP_CSV).entries.filter(e => e.kind === 'payment');
    expect(pays.map(e => ({ from: e.payers[0].memberId, to: e.split.entries[0].memberId, amount: e.amount }))).toEqual([
      { from: 'g', to: 'a', amount: 1500 },
      { from: 'a', to: 'k', amount: 5000 },
    ]);
  });

  it('keeps Chinese descriptions and flattens line breaks', () => {
    const p = plan(GROUP_CSV);
    expect(p.entries.find(e => e.date === '2026-09-04')!.description).toBe('燒肉晚餐 "大份"');
    const shop = p.entries.find(e => e.date === '2026-09-09')!;
    expect(shop.description).toBe('便利商店');
    expect(shop.category).toBe('food.groceries');
    expect(p.entries.find(e => e.date === '2026-09-11')!.description).toBe('Train tickets Tokyo to Kyoto');
  });

  it('preserves every row exactly in a 2-decimal currency', () => {
    const file = readFile(GROUP_CSV);
    const p = plan(GROUP_CSV);
    const kept = file.rows.filter(r => r.date !== '2026-09-10');
    p.entries.forEach((e, i) => {
      const want: Record<string, number> = {};
      kept[i].nets.forEach((v, c) => { if (v) want[IDS[c]] = v; });
      expect(entryNets(e)).toEqual(want);
    });
  });

  it('gives the same ids every time, different ids in another group, and distinct ids to identical rows', () => {
    const text = GROUP_CSV + '2026-09-01,Groceries,Groceries,45.00,USD,30.00,-15.00,-15.00\n';
    const a = plan(text);
    const b = plan(text);
    expect(a.entries.map(e => e.id)).toEqual(b.entries.map(e => e.id));
    expect(new Set(a.entries.map(e => e.id)).size).toBe(a.entries.length);
    const twins = a.entries.filter(e => e.date === '2026-09-01');
    expect(twins).toHaveLength(2);
    expect(twins[0].id).not.toBe(twins[1].id);
    const other = plan(text, { groupId: 'grp-2' });
    expect(other.entries[0].id).not.toBe(a.entries[0].id);
    // Ids depend on the row, not on how columns are mapped.
    const remapped = plan(text, { memberIds: ['x', 'y', 'z'] });
    expect(remapped.entries.map(e => e.id)).toEqual(a.entries.map(e => e.id));
    const file = readFile(text);
    expect(importId('grp-1', file.rows[0], 0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('merges columns mapped to the same member', () => {
    const p = plan(GROUP_CSV, { memberIds: ['g', 'g', 'k'] });
    const groceries = p.entries[0];
    expect(groceries.payers).toEqual([{ memberId: 'g', amount: 4500 }]);
    expect(groceries.split.entries).toEqual([{ memberId: 'g', value: 3000 }, { memberId: 'k', value: 1500 }]);
    // Gino paying Abbie becomes a payment to oneself, which changes nothing: skipped.
    expect(p.skipped.map(s => s.reason)).toContain('no_change');
    expect(p.netByMember).toEqual({ g: -1433 - 4533, k: 5966 });
  });

  it('gives unmatched columns temporary ids', () => {
    const p = plan(GROUP_CSV, { memberIds: ['g', '', ''] });
    expect(Object.keys(p.netByMember)).toEqual(['g', 'new:1', 'new:2']);
  });

  it('rounds currencies without cents one entry at a time and still adds up', () => {
    const csv = BOM + 'Date,Description,Category,Cost,Currency,Gino Chang,Abbie Lin\r\n'
      + '2026-08-01,水電費,Electricity,1001.00,TWD,500.50,-500.50\r\n'
      + '2026-08-02,Taxi,Taxi,250.00,TWD,-125.00,125.00\r\n'
      + '2026-08-03,Abbie W. paid Gino C.,Payment,375.50,TWD,-375.50,375.50\r\n'
      + '2026-08-04,Total balance, , ,TWD,0.00,0.00\r\n';
    const p = plan(csv, { groupCurrency: 'TWD', memberIds: ['g', 'a'] });
    expect(p.entries).toHaveLength(3);
    expect(p.rounded).toBe(2);
    for (const e of p.entries) expectStorable(e);
    const [power, taxi, pay] = p.entries;
    expect(power.amount).toBe(1001);
    expect(power.category).toBe('utilities.electricity');
    expect(power.split.entries.map(x => x.value).sort()).toEqual([500, 501]);
    expect(taxi).toMatchObject({ amount: 250, payers: [{ memberId: 'a', amount: 250 }] });
    expect(pay).toMatchObject({ kind: 'payment', amount: 376, payers: [{ memberId: 'a', amount: 376 }] });
    expect(p.expected).toEqual({ g: 0, a: 0 });
    expect(Math.abs(p.netByMember.g)).toBeLessThanOrEqual(1);
    expect(p.netByMember.g + p.netByMember.a).toBe(0);
  });

  it('asks for a rate for other currencies, and can relabel a currency', () => {
    const csv = 'Date,Description,Category,Cost,Currency,Gino,Abbie\n'
      + '2026-07-01,Ramen,Dining out,2400.00,JPY,1200.00,-1200.00\n'
      + '2026-07-02,Bento,Dining out,1000.00,USD,500.00,-500.00\n'
      + '2026-07-03,Tea,Dining out,300.00,TWD,150.00,-150.00\n';
    const file = readFile(csv);
    expect(fileCurrencies(file)).toEqual(['JPY', 'TWD', 'USD']);
    expect(foreignCurrencies(file, 'TWD')).toEqual([{ currency: 'JPY', rows: 1 }, { currency: 'USD', rows: 1 }]);
    expect(foreignCurrencies(file, 'TWD', { USD: 'JPY' })).toEqual([{ currency: 'JPY', rows: 2 }]);

    const noRates = plan(csv, { groupCurrency: 'TWD', memberIds: ['g', 'a'] });
    expect(noRates.entries.map(e => e.date)).toEqual(['2026-07-03']);
    expect(noRates.skipped.map(s => s.reason)).toEqual(['no_rate', 'no_rate']);

    const rated = plan(csv, { groupCurrency: 'TWD', memberIds: ['g', 'a'], rates: { JPY: 0.2149, USD: 32.3 } });
    expect(rated.entries.map(e => [e.currency, e.fxRate, e.amount])).toEqual([['JPY', 0.2149, 2400], ['USD', 32.3, 100000], ['TWD', 1, 300]]);

    // "$" rows that were really yen: relabel USD as JPY (whole yen, the JPY rate applies).
    const fixed = plan(csv, { groupCurrency: 'TWD', memberIds: ['g', 'a'], rates: { JPY: 0.2149 }, relabel: { USD: 'JPY' } });
    expect(fixed.entries.map(e => [e.currency, e.fxRate, e.amount])).toEqual([['JPY', 0.2149, 2400], ['JPY', 0.2149, 1000], ['TWD', 1, 300]]);
    // Relabeling into the group currency needs no rate.
    const home = plan(csv, { groupCurrency: 'JPY', memberIds: ['g', 'a'], relabel: { USD: 'JPY', TWD: 'JPY' } });
    expect(home.entries.every(e => e.currency === 'JPY' && e.fxRate === 1)).toBe(true);
    expect(home.netByMember).toEqual({ g: 1200 + 500 + 150, a: -(1200 + 500 + 150) });
  });

  it('reads semicolon files with decimal commas', () => {
    const p = plan('Date;Description;Category;Cost;Currency;Gino;Abbie\n2026-07-01;Pizza;Dining out;12,50;EUR;6,25;-6,25\n', {
      groupCurrency: 'EUR',
      memberIds: ['g', 'a'],
    });
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]).toMatchObject({ amount: 1250, currency: 'EUR', payers: [{ memberId: 'g', amount: 1250 }] });
  });

  it('skips rows it cannot import and says why', () => {
    const csv = 'Date,Description,Category,Cost,Currency,Gino,Abbie,Kevin\n'
      + 'yesterday,Bad date,General,10.00,USD,5.00,-5.00,0.00\n'
      + '2030-01-01,Far future,General,10.00,USD,5.00,-5.00,0.00\n'
      + '1999-12-31,Too old,General,10.00,USD,5.00,-5.00,0.00\n'
      + '2026-09-01,Bad number,General,10.00,USD,abc,-5.00,0.00\n'
      + '2026-09-01,Bad currency,General,10.00,$,5.00,-5.00,0.00\n'
      + '2026-09-01,Does not add up,General,10.00,USD,10.00,-5.00,0.00\n'
      + '2026-09-01,Three-way payment,Payment,10.00,USD,10.00,-5.00,-5.00\n'
      + '2026-09-01,Fine,General,10.00,USD,5.00,-5.00,0.00\n';
    const p = plan(csv);
    expect(p.entries.map(e => e.description)).toEqual(['Fine']);
    expect(p.skipped.map(s => [s.line, s.reason])).toEqual([
      [2, 'bad_date'],
      [3, 'date_range'],
      [4, 'date_range'],
      [5, 'bad_amount'],
      [6, 'bad_currency'],
      [7, 'unbalanced'],
      [8, 'payment_shape'],
    ]);
  });

  it('uses the fallback for an expense without a description and cuts long ones', () => {
    const long = 'x'.repeat(130);
    const p = plan(`Date,Description,Category,Cost,Currency,Gino,Abbie\n2026-09-01,,General,10.00,USD,5.00,-5.00\n2026-09-02,${long},General,10.00,USD,5.00,-5.00\n`, {
      memberIds: ['g', 'a'],
      fallbackDescription: '（無說明）',
    });
    expect(p.entries[0].description).toBe('（無說明）');
    expect(p.entries[1].description).toHaveLength(120);
  });

  it('handles a payer who is not part of the split', () => {
    const p = plan('Date,Description,Category,Cost,Currency,Gino,Abbie,Kevin\n2026-09-01,Gift for Kevin,Gifts,60.00,USD,60.00,-30.00,-30.00\n');
    expect(p.entries[0]).toMatchObject({
      amount: 6000,
      payers: [{ memberId: 'g', amount: 6000 }],
      split: { method: 'exact', entries: [{ memberId: 'a', value: 3000 }, { memberId: 'k', value: 3000 }] },
      category: 'life.gifts',
    });
  });

  it('keeps every entry storable for random balanced rows', () => {
    const currencies = ['USD', 'EUR', 'TWD', 'JPY'];
    const row = fc.record({
      people: fc.integer({ min: 2, max: 6 }),
      cents: fc.array(fc.integer({ min: -500000, max: 500000 }), { minLength: 5, maxLength: 5 }),
      extra: fc.integer({ min: 0, max: 100000 }),
      currency: fc.constantFrom(...currencies),
      payment: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(row, { minLength: 1, maxLength: 12 }), rows => {
        const lines = ['Date,Description,Category,Cost,Currency,P0,P1,P2,P3,P4,P5'];
        const want = new Map<string, { nets: Record<string, number>; payment: boolean; currency: string; positive: number }>();
        rows.forEach((r, i) => {
          const nets = new Array(6).fill(0);
          for (let k = 0; k < r.people - 1; k++) nets[k] = r.cents[k];
          nets[r.people - 1] = -nets.reduce((a: number, b: number) => a + b, 0);
          const positive = nets.filter(v => v > 0).reduce((a: number, b: number) => a + b, 0);
          const cost = positive + r.extra;
          const payment = r.payment && nets.filter(v => v > 0).length === 1 && nets.filter(v => v < 0).length === 1;
          const date = `2026-09-${String(i + 1).padStart(2, '0')}`;
          lines.push([date, `Row ${i}`, payment ? 'Payment' : 'General', (cost / 100).toFixed(2), r.currency, ...nets.map(v => (v / 100).toFixed(2))].join(','));
          const byMember: Record<string, number> = {};
          nets.forEach((v, k) => { if (v) byMember['m' + k] = v; });
          want.set(date, { nets: byMember, payment, currency: r.currency, positive });
        });
        const p = plan(lines.join('\n'), {
          groupCurrency: 'USD',
          memberIds: ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'],
          rates: { EUR: 1.1, TWD: 0.031, JPY: 0.0067 },
        });
        for (const s of p.skipped) {
          const w = want.get(s.date)!;
          if (Object.keys(w.nets).length === 0) expect(s.reason).toBe('no_change');
          // Under half a yen or dollar in a currency without cents rounds to nothing.
          else expect([s.reason, w.positive < 50 && (w.currency === 'TWD' || w.currency === 'JPY')]).toEqual(['bad_amount', true]);
        }
        expect(p.entries.length + p.skipped.length).toBe(rows.length);
        for (const e of p.entries) {
          const w = want.get(e.date)!;
          expectStorable(e);
          expect(e.kind).toBe(w.payment ? 'payment' : 'expense');
          if (!w.payment) expect(e.description).toMatch(/^Row \d+$/);
          const got = entryNets(e);
          if (e.currency === 'USD' || e.currency === 'EUR') expect(got).toEqual(w.nets);
          else {
            // Whole units: each person is within rounding of the original, and the entry adds up.
            for (const m of new Set([...Object.keys(w.nets), ...Object.keys(got)])) {
              expect(Math.abs((got[m] ?? 0) - (w.nets[m] ?? 0) / 100)).toBeLessThan(2);
            }
          }
        }
        const total = Object.values(p.netByMember).reduce((a, b) => a + b, 0);
        expect(total).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});

describe('matching people to members', () => {
  const members = [
    { id: 'm1', name: 'Gino', active: true },
    { id: 'm2', name: 'Abbie Lin', active: true },
    { id: 'm3', name: 'Kevin Lin', active: true },
    { id: 'm4', name: '佳穎', active: false },
  ];

  it('matches names case-insensitively, me by my account name, then a unique first name', () => {
    expect(suggestMembers(['Gino Chang', 'abbie  wu', 'Kevin', 'Leo', '佳穎'], members, { memberId: 'm1', names: ['Gino Chang'] }))
      .toEqual(['m1', 'm2', 'm3', null, 'm4']);
  });

  it('never suggests one member for two columns', () => {
    expect(suggestMembers(['Gino', 'gino'], members)).toEqual(['m1', null]);
  });

  it('does not guess between two members with the same first name', () => {
    const two = [...members, { id: 'm5', name: 'Kevin Chen', active: true }];
    expect(suggestMembers(['Kevin'], two)).toEqual([null]);
  });
});

describe('money helpers', () => {
  it('rounds hundredths to whole units half away from zero', () => {
    expect(centsToMinor(50050, 'TWD')).toBe(501);
    expect(centsToMinor(50049, 'TWD')).toBe(500);
    expect(centsToMinor(-50050, 'TWD')).toBe(-501);
    expect(centsToMinor(-40, 'JPY')).toBe(0);
    expect(centsToMinor(1234, 'USD')).toBe(1234);
  });

  it('writes plain decimals for spreadsheets', () => {
    expect(decimalString(125050, 'USD')).toBe('1250.50');
    expect(decimalString(5, 'USD')).toBe('0.05');
    expect(decimalString(-5, 'USD')).toBe('-0.05');
    expect(decimalString(0, 'USD')).toBe('0.00');
    expect(decimalString(-1712140, 'JPY')).toBe('-1712140');
  });
});

describe('CSV export rows', () => {
  const member = (id: string, name: string, sort: number, active = true): MemberDTO => ({
    id, groupId: 'grp', userId: null, name, color: '#2F6FB5', role: 'member', active, sort,
    createdAt: '2026-01-01T00:00:00Z', claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null,
  });
  const entry = (e: Partial<ExpenseDTO> & Pick<ExpenseDTO, 'id' | 'kind' | 'amount' | 'currency' | 'payers' | 'shares' | 'date'>): ExpenseDTO => ({
    groupId: 'grp', description: '', category: 'general', fxRate: 1, notes: '',
    split: { method: 'exact', entries: e.shares.map(s => ({ memberId: s.memberId, value: s.amount })) },
    repeat: 'none', repeatSeries: null, repeatStart: null, createdBy: 'u', createdAt: e.date + 'T10:00:00Z',
    updatedBy: 'u', updatedAt: e.date + 'T10:00:00Z', deletedAt: null, deletedBy: null, version: 1, commentCount: 0, refundOf: null, receipt: null,
    ...e,
  });
  const labels: ExportLabels = {
    date: 'Date', description: 'Description', category: 'Category', kind: 'Kind', amount: 'Amount', currency: 'Currency',
    fxRate: 'FX rate', baseAmount: 'Amount in group currency', paidBy: 'Paid by', expense: 'Expense', payment: 'Payment', refund: 'Refund',
    total: 'Total balance', categoryLabel: k => 'cat:' + k, paymentDescription: (a, b) => `${a} paid ${b}`,
    separator: ', ', unknownMember: '(removed)',
  };

  it('lists entries oldest first with each member effect and a balance row', () => {
    const snap = {
      group: { currency: 'TWD' },
      members: [member('g', 'Gino', 0), member('a', '=Abbie', 1), member('x', 'Left early', 2, false), member('y', 'Never used', 3, false)],
      expenses: [
        entry({ id: 'e3', kind: 'expense', description: 'Ramen', category: 'food.dining', amount: 1000, currency: 'JPY', fxRate: 0.2, date: '2026-09-03',
          payers: [{ memberId: 'a', amount: 1000 }], shares: [{ memberId: 'g', amount: 500 }, { memberId: 'a', amount: 500 }] }),
        entry({ id: 'e2', kind: 'payment', category: 'payment', amount: 150, currency: 'TWD', date: '2026-09-02',
          payers: [{ memberId: 'a', amount: 150 }], shares: [{ memberId: 'g', amount: 150 }] }),
        entry({ id: 'e1', kind: 'expense', description: '=SUM(A1)', category: 'food.groceries', amount: 300, currency: 'TWD', date: '2026-09-01',
          payers: [{ memberId: 'g', amount: 200 }, { memberId: 'x', amount: 100 }], shares: [{ memberId: 'g', amount: 150 }, { memberId: 'a', amount: 150 }] }),
        entry({ id: 'e0', kind: 'expense', description: 'Deleted', amount: 999, currency: 'TWD', date: '2026-09-01', deletedAt: '2026-09-02T00:00:00Z',
          payers: [{ memberId: 'y', amount: 999 }], shares: [{ memberId: 'y', amount: 999 }] }),
      ],
    };
    const rows = buildExportRows(snap, labels);
    expect(rows[0]).toEqual(['Date', 'Description', 'Category', 'Kind', 'Amount', 'Currency', 'FX rate', 'Amount in group currency', 'Paid by', 'Gino', "'=Abbie", 'Left early']);
    expect(rows[1]).toEqual(['2026-09-01', "'=SUM(A1)", 'cat:food.groceries', 'Expense', '300', 'TWD', '1', '300', 'Gino (200), Left early (100)', '50', '-150', '100']);
    expect(rows[2]).toEqual(['2026-09-02', "'=Abbie paid Gino", 'cat:payment', 'Payment', '150', 'TWD', '1', '150', "'=Abbie", '-150', '150', '0']);
    expect(rows[3]).toEqual(['2026-09-03', 'Ramen', 'cat:food.dining', 'Expense', '1000', 'JPY', '0.2', '200', "'=Abbie", '-100', '100', '0']);
    expect(rows[4]).toEqual(['', 'Total balance', '', '', '', 'TWD', '', '', '', '-200', '100', '100']);
    // Each entry row sums to zero across members, and so does the balance row.
    for (const r of rows.slice(1)) expect(r.slice(9).reduce((a, v) => a + Number(v), 0)).toBe(0);
    // The member columns match the shared balance math.
    expect(entryNet(snap.expenses[0], 'TWD').get('g')).toBe(-100);
  });
});

describe('server validation', () => {
  // The Worker's own import planner (normalizeUpsert for every entry) must accept everything
  // the importer produces. Loaded by path at run time so the web typecheck does not pull in the
  // Worker sources.
  const WORKER_EXPENSES = '../../src/worker/routes/expenses';

  it('accepts every entry of a real-looking export', async () => {
    const mod = (await import(/* @vite-ignore */ WORKER_EXPENSES)) as {
      planImport: (list: readonly unknown[], groupCurrency: string, memberIds: Iterable<string>, today: string, room: number) => {
        accepted: { index: number; id: string; entry: { shares: { memberId: string; amount: number }[]; amount: number } }[];
        skipped: { index: number; code: string }[];
      };
    };
    const p = plan(GROUP_CSV);
    const res = mod.planImport(p.entries, 'USD', IDS, TODAY, 5000);
    expect(res.skipped).toEqual([]);
    expect(res.accepted).toHaveLength(p.entries.length);
    // The server stores the same shares the importer previewed.
    res.accepted.forEach((a, i) => {
      const sr = computeSharesFor(p.entries[i].id, p.entries[i].amount, p.entries[i].split);
      expect(sr.ok && sr.shares).toEqual(a.entry.shares);
    });

    const twd = plan('Date,Description,Category,Cost,Currency,Gino,Abbie,Kevin\n2026-08-01,三人晚餐,Dining out,1000.00,TWD,666.67,-333.33,-333.34\n2026-08-02,Ramen,Dining out,3600.00,JPY,-1200.00,2400.00,-1200.00\n', {
      groupCurrency: 'TWD',
      rates: { JPY: 0.2149 },
    });
    const res2 = mod.planImport(twd.entries, 'TWD', IDS, TODAY, 5000);
    expect(res2.skipped).toEqual([]);
    expect(res2.accepted).toHaveLength(2);
  });
});
