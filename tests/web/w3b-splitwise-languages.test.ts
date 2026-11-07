// Splitwise exports in other languages than English (review-1106, B6b-01; features/groups/
// splitwiseImport.ts). Splitwise writes the whole file in the account's language: the header, the
// total rows ("Gesamtbilanz", "Solde total", "Saldo total", with blank Category and Cost cells) and
// the payment category ("Zahlung", "Pago"). Such a total row used to come in as an expense, which
// doubled every balance with no warning, and payments came in as expenses. The files below have
// the shapes of real exports (German with CRLF line ends and one-space cells, French with one total
// per currency, Spanish with Pago rows). Also: descriptions cut by UTF-16 units (B6b-03), a file of
// more rows than one call can spread (B6b-06), and what the done screen counts (B6b-02).

import { describe, expect, it, vi } from 'vitest';

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

import {
  buildImport,
  entryRoom,
  importOutcome,
  MAX_ENTRY_ROWS,
  MAX_LIVE_ENTRIES,
  parseSplitwiseCsv,
  type ImportEntry,
  type ImportOptions,
  type SplitwiseFile,
} from '../../src/web/features/groups/splitwiseImport';

const TODAY = '2026-11-07';

function readFile(text: string): SplitwiseFile {
  const r = parseSplitwiseCsv(text);
  if (!r.ok) throw new Error('parse failed: ' + r.error);
  return r.file;
}

function plan(text: string, opts: Partial<ImportOptions> & Pick<ImportOptions, 'groupCurrency' | 'memberIds'>) {
  return buildImport(readFile(text), { groupId: 'grp-1', today: TODAY, fallbackDescription: 'Splitwise', ...opts });
}

// German: Gino paid a pizza, Abbie the groceries, Gino paid Abbie 4.00 back; Splitwise's summary
// says Gino is at -1.00. Its last row's Category and Cost cells hold one space.
const GERMAN = [
  'Datum,Beschreibung,Kategorie,Kosten,Währung,Gino,Abbie',
  '2026-09-01,Pizza,Essen und Trinken,20.00,EUR,10.00,-10.00',
  '2026-09-02,Supermarkt,Lebensmittel,30.00,EUR,-15.00,15.00',
  '2026-09-03,Gino hat Abbie bezahlt,Zahlung,4.00,EUR,4.00,-4.00',
  '',
  '2026-11-07,Gesamtbilanz, , ,EUR,-1.00,1.00',
  '',
].join('\r\n');

// French: one entry in CHF and one in EUR, so Splitwise writes a Solde total row for each.
const FRENCH = [
  'Date,Description,Catégorie,Coût,Devise,Sébastien,Hervé,Cyril',
  '',
  '2026-07-01,Barre de son,Général,300.00,CHF,-100.00,-100.00,200.00',
  '2026-07-02,Parapente,Général,140.00,EUR,-70.00,140.00,-70.00',
  '',
  '2026-08-13,Solde total, , ,CHF,-100.00,-100.00,200.00',
  '2026-08-13,Solde total, , ,EUR,-70.00,140.00,-70.00',
].join('\n');

// Spanish, in a currency without cents: Lucía paid dinner and lodging, Mateo paid her 20,000 back.
const SPANISH = [
  'Fecha,Descripción,Categoría,Coste,Moneda,Lucía,Mateo',
  '2026-01-03,"Posada: cena y alojamiento",Comida,80000.00,COP,40000.00,-40000.00',
  '2026-01-08,Pago de Mateo a Lucía,Pago,20000.00,COP,-20000.00,20000.00',
  '',
  '2026-01-20,Saldo total, , ,COP,20000.00,-20000.00',
].join('\n');

describe('a German export', () => {
  const file = readFile(GERMAN);
  const p = plan(GERMAN, { groupCurrency: 'EUR', memberIds: ['g', 'a'] });

  it('reads Gesamtbilanz as the total row, not as an entry', () => {
    expect(file.english).toBe(false);
    expect(file.people).toEqual(['Gino', 'Abbie']);
    expect(file.rows.map(r => r.description)).toEqual(['Pizza', 'Supermarkt', 'Gino hat Abbie bezahlt']);
    expect(file.totals).toEqual([{ currency: 'EUR', nets: [-100, 100] }]);
  });

  it('imports Zahlung as a payment, which is not spending', () => {
    expect(p.entries).toHaveLength(3);
    expect(p.expenseCount).toBe(2);
    expect(p.paymentCount).toBe(1);
    const pay = p.entries.find(e => e.kind === 'payment')!;
    expect(pay).toMatchObject({ amount: 400, payers: [{ memberId: 'g', amount: 400 }], split: { method: 'exact', entries: [{ memberId: 'a', value: 400 }] } });
    expect(p.spent).toBe(5000);
  });

  it('gives Splitwise\'s own balances, so 和 Splitwise 一樣 can show', () => {
    // Before: the total row came in as a 4th entry, so this was { g: -200, a: 200 } and expected was null.
    expect(p.netByMember).toEqual({ g: -100, a: 100 });
    expect(p.expected).toEqual(p.netByMember);
  });

  it('leaves no skipped row for a settled summary', () => {
    const settled = ['Datum,Beschreibung,Kategorie,Kosten,Währung,Gino,Abbie', '2026-09-01,Pizza,Essen,20.00,EUR,10.00,-10.00', '2026-09-02,Abbie hat Gino bezahlt,Zahlung,10.00,EUR,-10.00,10.00', '2026-09-03,Gesamtbilanz, , ,EUR,0.00,0.00'].join('\n');
    const s = plan(settled, { groupCurrency: 'EUR', memberIds: ['g', 'a'] });
    expect(s.skipped).toEqual([]);
    expect(s.entries).toHaveLength(2);
    expect(s.netByMember).toEqual({ g: 0, a: 0 });
    expect(s.expected).toEqual({ g: 0, a: 0 });
  });
});

describe('a French export with a total per currency', () => {
  it('reads both Solde total rows as totals, so no balance is doubled', () => {
    const file = readFile(FRENCH);
    expect(file.english).toBe(false);
    expect(file.rows).toHaveLength(2);
    expect(file.totals.map(t => t.currency)).toEqual(['CHF', 'EUR']);
    // The EUR rows were really CHF: then both totals are in the group currency and can be compared.
    const p = plan(FRENCH, { groupCurrency: 'CHF', memberIds: ['s', 'h', 'c'], relabel: { EUR: 'CHF' } });
    expect(p.entries).toHaveLength(2);
    expect(p.netByMember).toEqual({ s: -17000, h: 4000, c: 13000 });
    expect(p.expected).toEqual(p.netByMember);
  });

  it('compares nothing while a total is in another currency, as for an English file', () => {
    const p = plan(FRENCH, { groupCurrency: 'CHF', memberIds: ['s', 'h', 'c'], rates: { EUR: 0.94 } });
    expect(p.entries).toHaveLength(2);
    expect(p.expected).toBeNull();
  });

  it('keeps a payment in a language not seen yet as an expense, with the balances still right', () => {
    // 'Paiement' is not in the list (no real export seen): the review step then shows its language
    // note (file.english false and no payment found).
    const text = ['Date,Description,Catégorie,Coût,Devise,Sébastien,Hervé', '2026-07-01,Hervé a payé Sébastien,Paiement,50.00,CHF,-50.00,50.00'].join('\n');
    const file = readFile(text);
    const p = plan(text, { groupCurrency: 'CHF', memberIds: ['s', 'h'] });
    expect(file.english).toBe(false);
    expect(p.paymentCount).toBe(0);
    expect(p.netByMember).toEqual({ s: -5000, h: 5000 });
  });
});

describe('a Spanish export', () => {
  it('imports Pago rows as payments and matches Saldo total', () => {
    const p = plan(SPANISH, { groupCurrency: 'COP', memberIds: ['l', 'm'] });
    expect(p.paymentCount).toBe(1);
    expect(p.expenseCount).toBe(1);
    // Payments are not spending: before, the Pago row added COP 20,000 to it.
    expect(p.spent).toBe(80000);
    expect(p.netByMember).toEqual({ l: 20000, m: -20000 });
    expect(p.expected).toEqual(p.netByMember);
    expect(p.entries.find(e => e.kind === 'payment')).toMatchObject({ payers: [{ memberId: 'm', amount: 20000 }] });
  });
});

describe('English files are read as before', () => {
  it('imports a row typed by hand with blank Category and Cost cells', () => {
    const text = ['Date,Description,Category,Cost,Currency,Gino,Abbie', '2026-09-01,Hand typed, , ,USD,5.00,-5.00', '2026-10-01,Total balance, , ,USD,5.00,-5.00'].join('\n');
    const file = readFile(text);
    expect(file.english).toBe(true);
    expect(file.rows.map(r => r.description)).toEqual(['Hand typed']);
    expect(file.totals).toHaveLength(1);
    const p = plan(text, { groupCurrency: 'USD', memberIds: ['g', 'a'] });
    expect(p.entries).toHaveLength(1);
    expect(p.netByMember).toEqual({ g: 500, a: -500 });
    expect(p.expected).toEqual(p.netByMember);
  });

  it('knows a payment only by the category Payment there', () => {
    // A category named Pago in a file with the English header is an expense category someone made.
    const text = ['Date,Description,Category,Cost,Currency,Gino,Abbie', '2026-09-01,Abbie paid Gino,Payment,5.00,USD,-5.00,5.00', '2026-09-02,Rent,Pago,5.00,USD,2.50,-2.50'].join('\n');
    const p = plan(text, { groupCurrency: 'USD', memberIds: ['g', 'a'] });
    expect(p.entries.map(e => e.kind)).toEqual(['payment', 'expense']);
  });
});

describe('what the Worker takes', () => {
  // The Worker's own import planner, loaded by path at run time (as in splitwise-import.test.ts).
  const WORKER_EXPENSES = '../../src/worker/routes/expenses';
  type PlanImport = (list: readonly unknown[], groupCurrency: string, memberIds: Iterable<string>, today: string, room: number) => {
    accepted: { index: number }[];
    skipped: { index: number; code: string; field?: string }[];
  };

  it('accepts every entry of the localized files', async () => {
    const { planImport } = (await import(/* @vite-ignore */ WORKER_EXPENSES)) as { planImport: PlanImport };
    const de = plan(GERMAN, { groupCurrency: 'EUR', memberIds: ['g', 'a'] });
    expect(planImport(de.entries, 'EUR', ['g', 'a'], TODAY, 5000).skipped).toEqual([]);
    const es = plan(SPANISH, { groupCurrency: 'COP', memberIds: ['l', 'm'] });
    expect(planImport(es.entries, 'COP', ['l', 'm'], TODAY, 5000).skipped).toEqual([]);
  });

  it('accepts a long description with emoji: it is cut by UTF-16 units, between characters (B6b-03)', async () => {
    const { planImport } = (await import(/* @vite-ignore */ WORKER_EXPENSES)) as { planImport: PlanImport };
    // 110 Chinese characters and 10 emoji: 120 characters, but 130 UTF-16 units.
    const long = '晚'.repeat(110) + '🍜'.repeat(10);
    const family = 'x'.repeat(115) + '👨‍👩‍👧';
    const p = plan(['Date,Description,Category,Cost,Currency,Gino,Abbie', `2026-09-01,${long},General,10.00,USD,5.00,-5.00`, `2026-09-02,${family},General,10.00,USD,5.00,-5.00`].join('\n'), {
      groupCurrency: 'USD',
      memberIds: ['g', 'a'],
    });
    const [a, b] = p.entries.map((e: ImportEntry) => e.description);
    expect(a.length).toBe(120);
    expect(a).toBe('晚'.repeat(110) + '🍜'.repeat(5));
    // A family emoji is one character of 8 units: it does not fit, so it is left out whole, never cut in half.
    expect(b).toBe('x'.repeat(115));
    expect(planImport(p.entries, 'USD', ['g', 'a'], TODAY, 5000).skipped).toEqual([]);
  });
});

describe('a very large file (B6b-06)', () => {
  it('is read without spreading every row into one call', () => {
    // More rows than Math.max(...rows) takes in Node (it throws at about 125,000 arguments; Safari
    // at about 65,000).
    const n = 130_000;
    const rows = new Array<string>(n).fill('2026-09-01,x,General,1.00,USD,0.50,-0.50');
    const r = parseSplitwiseCsv(['Date,Description,Category,Cost,Currency,Gino,Abbie', ...rows].join('\n'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.file.rows).toHaveLength(n);
      expect(r.file.people).toEqual(['Gino', 'Abbie']);
    }
  });
});

describe('the room a group has, and the done screen (B6b-02)', () => {
  const entry = (deleted: boolean) => ({ deletedAt: deleted ? '2026-10-01T00:00:00.000Z' : null });

  it('counts 5,000 live entries, or 20,000 with deleted ones', () => {
    expect(entryRoom([])).toEqual({ room: MAX_LIVE_ENTRIES, byRows: false });
    expect(entryRoom(Array.from({ length: 4300 }, () => entry(false)))).toEqual({ room: 700, byRows: false });
    const mostlyDeleted = [...Array.from({ length: 100 }, () => entry(false)), ...Array.from({ length: MAX_ENTRY_ROWS - 150 }, () => entry(true))];
    expect(entryRoom(mostlyDeleted)).toEqual({ room: 50, byRows: true });
    expect(entryRoom(Array.from({ length: 5001 }, () => entry(false))).room).toBe(0);
  });

  it('tells entries already in the group from those the Worker did not take, and why', () => {
    // 1,200 rows into a group with room for 700: 700 go in, 500 are left out by the limit.
    expect(importOutcome(1200, 1200, 700, 700)).toEqual({ imported: 700, already: 0, limited: 500, refused: 0 });
    // The same file again: nothing is sent, all of it was imported before.
    expect(importOutcome(1200, 0, 0, 0)).toEqual({ imported: 0, already: 1200, limited: 0, refused: 0 });
    // Room enough, but the Worker refused one entry.
    expect(importOutcome(10, 8, 7, 5000)).toEqual({ imported: 7, already: 2, limited: 0, refused: 1 });
  });
});
