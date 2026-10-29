// Receipt scan (POST /api/receipts/scan, docs/PLAN-push-scan-cookies.md section 3.1): the pure
// parts of services/receipt.ts (numbers, dates, currencies, line kinds, the normalizer with Japanese,
// Taiwan and US receipts, answer shapes, the request per model, a scan's worst-case neurons), the
// normalizer's answer going into the editor's applyScan, the neuron counter in rate_limits, then the
// route end to end against the real schema in SQLite with a fake env.AI (limits, the day's neuron
// budget, ?model=, errors).

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { todayUTC } from '../../src/shared/dates';
import type { ReceiptScanDTO } from '../../src/shared/types';
import { applyScan, newDraft } from '../../src/web/features/expenses/editorLogic';
import { addToCount, createSession, takeAmount } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { neuronBudget, RECEIPT_MAX_BYTES, RECEIPT_NEURONS_PER_DAY } from '../../src/worker/routes/receipts';
import {
  aiFailure, DEFAULT_RECEIPT_MODEL, lineKind, minorUnits, neuronsFor, normalizeReceipt, parseJsonText, readAnswer, RECEIPT_INPUT_TOKENS_MAX,
  RECEIPT_MAX_TOKENS, RECEIPT_MODELS, RECEIPT_SCHEMA, receiptCategory, receiptCurrency, receiptDate, receiptNeuronsSpent, receiptRequest,
  receiptWorstCase, runReceiptModel, secondsToNextUtcDay, type NormalizeContext,
} from '../../src/worker/services/receipt';
import { TestD1 } from './d1-sqlite';

const TODAY = '2026-10-17';
const zh: NormalizeContext = { hint: 'TWD', locale: 'zh-TW', today: TODAY };
const en: NormalizeContext = { ...zh, locale: 'en' };

const lines = (...xs: [string, number][]) => xs.map(([name, amount]) => ({ name, amount }));

/** The izakaya receipt in tmp/receipts (外税: tax added after the subtotal). */
const IZAKAYA = {
  merchant: '居酒屋 炉ばた 漁火',
  date: '2026-10-13',
  currency: 'JPY',
  currencyGuessed: false,
  items: lines(['お通し ×4', 1760], ['生ビール ×6', 3960], ['刺身盛り合わせ', 2380], ['ほっけ焼き', 980], ['じゃがバター', 580], ['ハイボール ×4', 2240], ['〆の焼きおにぎり ×2', 680]),
  tax: 1258,
  taxIncluded: false,
  tip: 0,
  discount: 0,
  total: 13838,
  category: 'food.dining',
};

/** The Pink Door: a discount on the whole bill, sales tax and a handwritten tip and total. */
const PINK_DOOR = {
  merchant: 'The Pink Door',
  date: '2026-09-27',
  currency: 'USD',
  currencyGuessed: false,
  items: lines(['Linguine alle Vongole', 31], ['Lasagna Verde', 27], ['Burrata', 18], ['2 Glass Chianti', 28]),
  tax: 8.49,
  taxIncluded: false,
  tip: 20,
  discount: 22,
  total: 110.49,
  category: 'food.dining',
};

// ---------- pure helpers ----------

describe('minorUnits', () => {
  it('turns major units into minor units through exact decimals', () => {
    expect(minorUnits(1.005, 'USD')).toBe(101);
    expect(minorUnits(110.49, 'USD')).toBe(11049);
    expect(minorUnits(0.1 + 0.2, 'USD')).toBe(30);
    expect(minorUnits(1260, 'JPY')).toBe(1260);
    expect(minorUnits(-22, 'USD')).toBe(-2200);
  });
  it('refuses a fraction in a currency without decimals (¥1,260 misread as 1.26)', () => {
    expect(minorUnits(1.26, 'JPY')).toBeNull();
    expect(minorUnits(12.5, 'TWD')).toBeNull();
    expect(minorUnits(13.838, 'JPY')).toBeNull();
  });
  it('reads numbers written as text and refuses the rest', () => {
    expect(minorUnits('13,838', 'JPY')).toBe(13838);
    expect(minorUnits('¥1,260', 'JPY')).toBe(1260);
    expect(minorUnits('12,50', 'EUR')).toBe(1250);
    expect(minorUnits('abc', 'USD')).toBeNull();
    expect(minorUnits(null, 'USD')).toBeNull();
    expect(minorUnits(Number.NaN, 'USD')).toBeNull();
    expect(minorUnits(1e13, 'USD')).toBeNull();
  });
});

describe('receiptDate', () => {
  it('keeps a Western date up to tomorrow', () => {
    expect(receiptDate('2026-10-13', TODAY)).toEqual({ date: '2026-10-13', bad: false });
    expect(receiptDate('2026-10-18', TODAY)).toEqual({ date: '2026-10-18', bad: false });
    expect(receiptDate('2026年10月12日(月) 12:34', TODAY)).toEqual({ date: '2026-10-12', bad: false });
    expect(receiptDate('2026-10-13T21:47', TODAY).date).toBe('2026-10-13');
    expect(receiptDate('09/27/2026', TODAY).date).toBe('2026-09-27');
  });
  it('converts 令和 and 民國 years when the model did not', () => {
    expect(receiptDate('令和8年10月13日', TODAY).date).toBe('2026-10-13');
    expect(receiptDate('R8.10.13', TODAY).date).toBe('2026-10-13');
    expect(receiptDate('平成31年4月30日', TODAY).date).toBe('2019-04-30');
    expect(receiptDate('115/10/05', TODAY).date).toBe('2026-10-05');
    expect(receiptDate('115年10月5日', TODAY).date).toBe('2026-10-05');
    expect(receiptDate('民國115年10月5日', TODAY).date).toBe('2026-10-05');
    expect(receiptDate('0115-10-05', TODAY).date).toBe('2026-10-05');
  });
  it('puts a date without a year in the last twelve months', () => {
    expect(receiptDate('10/13', TODAY).date).toBe('2026-10-13');
    expect(receiptDate('12月24日', TODAY).date).toBe('2025-12-24');
  });
  it('flags dates that cannot be right, and says nothing when there was none', () => {
    expect(receiptDate('2026-10-19', TODAY)).toEqual({ date: null, bad: true });
    expect(receiptDate('1999-12-31', TODAY)).toEqual({ date: null, bad: true });
    expect(receiptDate('2026-02-30', TODAY)).toEqual({ date: null, bad: true });
    expect(receiptDate('soon', TODAY)).toEqual({ date: null, bad: true });
    expect(receiptDate('', TODAY)).toEqual({ date: null, bad: false });
    expect(receiptDate(42, TODAY)).toEqual({ date: null, bad: false });
  });
});

describe('receiptCurrency', () => {
  it('takes known ISO codes and the signs that name one currency', () => {
    expect(receiptCurrency('jpy', 'TWD')).toEqual({ code: 'JPY', guessed: false });
    expect(receiptCurrency('NT$', null)).toEqual({ code: 'TWD', guessed: false });
    expect(receiptCurrency('円', null)).toEqual({ code: 'JPY', guessed: false });
    expect(receiptCurrency('￥', 'TWD')).toEqual({ code: 'JPY', guessed: false });
    expect(receiptCurrency('¥', 'CNY')).toEqual({ code: 'CNY', guessed: false });
  });
  it('treats a bare $ as the hint, and anything unknown as unsure', () => {
    expect(receiptCurrency('$', 'TWD')).toEqual({ code: 'TWD', guessed: true });
    expect(receiptCurrency('$', 'JPY')).toEqual({ code: null, guessed: true });
    expect(receiptCurrency('XYZ', 'TWD')).toEqual({ code: null, guessed: true });
    expect(receiptCurrency('', 'TWD')).toEqual({ code: null, guessed: true });
    expect(receiptCurrency(undefined, 'TWD')).toEqual({ code: null, guessed: true });
  });
});

describe('lineKind', () => {
  it('knows subtotals, totals, payments and change', () => {
    for (const name of ['小計 (6点)', '合計 6 項', '總計', 'Subtotal', 'Sub-total', 'Total:', 'Amount', 'お預り', 'お釣り', '現金', '找零', 'クレジット', 'VISA ****1234', '(8%対象', '計 3点']) {
      expect([name, lineKind(name)]).toEqual([name, 'skip']);
    }
  });
  it('knows tax, tips and service charges, and discounts', () => {
    expect(lineKind('外税8%')).toBe('tax');
    expect(lineKind('消費税 10%')).toBe('tax');
    expect(lineKind('(内消費税等')).toBe('tax');
    expect(lineKind('Sales Tax 10.35%')).toBe('tax');
    expect(lineKind('服務費 10%')).toBe('tip');
    expect(lineKind('サービス料')).toBe('tip');
    expect(lineKind('Tip:')).toBe('tip');
    expect(lineKind('Happy hour disc.')).toBe('discount');
    expect(lineKind('値引')).toBe('discount');
    expect(lineKind('20% off')).toBe('discount');
  });
  it('leaves real items alone', () => {
    for (const name of ['おにぎり 鮭', 'Taxi to airport', 'Totally Tofu', 'Cashew chicken', '計程車資', '小籠包 10入 ×2']) {
      expect([name, lineKind(name)]).toEqual([name, 'item']);
    }
  });
});

describe('receiptCategory', () => {
  it('uses the model key, never payment, and falls back to the store name', () => {
    expect(receiptCategory('food.dining', 'x')).toBe('food.dining');
    expect(receiptCategory('payment', '')).toBeNull();
    expect(receiptCategory('payment', '全家便利商店')).toBe('food.groceries');
    expect(receiptCategory('general', 'LAWSON')).toBe('food.groceries');
    expect(receiptCategory('general', 'ローソン')).toBe('general');
    expect(receiptCategory('food.dinner', '')).toBe('food.other');
    expect(receiptCategory('nonsense', '')).toBeNull();
    expect(receiptCategory(7, '')).toBeNull();
  });
});

// ---------- the normalizer ----------

describe('normalizeReceipt', () => {
  it('JP 外税: the lines plus the tax make the total', () => {
    const r = normalizeReceipt(IZAKAYA, zh);
    expect(r).toEqual({
      merchant: '居酒屋 炉ばた 漁火',
      date: '2026-10-13',
      currency: 'JPY',
      total: 13838,
      items: IZAKAYA.items,
      tax: 1258,
      tip: null,
      category: 'food.dining',
      warnings: [],
    });
  });

  it('JP 内税: the lines already make the total', () => {
    const r = normalizeReceipt(
      { merchant: 'セブン-イレブン 札幌北口店', date: '2026-10-16', currency: 'JPY', items: lines(['おにぎり', 160], ['お茶', 140], ['からあげ', 260]), tax: 41, taxIncluded: true, tip: 0, discount: 0, total: 560, category: 'food.groceries' },
      zh,
    );
    expect(r.total).toBe(560);
    expect(r.items).toHaveLength(3);
    expect(r.tax).toBe(41);
    expect(r.warnings).toEqual([]);
  });

  it('names the two usual tax misreads: the 小計 as the total (外税), 内税 added twice', () => {
    const subtotal = normalizeReceipt({ ...IZAKAYA, total: 12580 }, zh);
    expect(subtotal.total).toBe(12580);
    expect(subtotal.warnings).toEqual(['總額 ¥12,580 好像沒有加上稅 ¥1,258，請核對']);
    const twice = normalizeReceipt(
      { merchant: 'セブン-イレブン', currency: 'JPY', items: lines(['おにぎり', 160], ['お茶', 140], ['からあげ', 260]), tax: 41, taxIncluded: true, total: 601 },
      en,
    );
    expect(twice.warnings).toEqual(['The total of ¥601 may count the included tax of ¥41 twice. Check it']);
  });

  it('drops subtotal, tax and payment lines that slipped into the items, and keeps their tax', () => {
    const r = normalizeReceipt(
      { ...IZAKAYA, tax: 0, items: [...IZAKAYA.items, ...lines(['小計', 12580], ['消費税 10%', 1258], ['ご請求額', 13838], ['クレジット', 13838])] },
      zh,
    );
    expect(r.items).toEqual(IZAKAYA.items);
    expect(r.tax).toBe(1258);
    expect(r.warnings).toEqual([]);
  });

  it('drops a line that is the sum of the lines above it when that makes the total fit', () => {
    const r = normalizeReceipt({ ...PINK_DOOR, items: [...PINK_DOOR.items, { name: 'Food', amount: 104 }] }, en);
    expect(r.items).toEqual(PINK_DOOR.items);
    expect(r.warnings).toEqual([]);
  });

  it('TW e-invoice: a 民國 date, a $ total, change and cash lines out, the category from the store', () => {
    const r = normalizeReceipt(
      {
        merchant: '全家便利商店 台北松江店',
        date: '115/10/05',
        currency: 'TWD',
        currencyGuessed: false,
        items: lines(['御飯糰 鮪魚', 39], ['義美 豆漿', 25], ['光泉 鮮乳 936ml', 95], ['咖啡 拿鐵 大', 65], ['舒潔 衛生紙', 189], ['乖乖 椰子', 72], ['合計 6 項', 485], ['現金', 500], ['找零', 15]),
        tax: 0,
        taxIncluded: true,
        tip: 0,
        discount: 0,
        total: 485,
        category: 'general',
      },
      zh,
    );
    expect(r.date).toBe('2026-10-05');
    expect(r.currency).toBe('TWD');
    expect(r.total).toBe(485);
    expect(r.items.map(i => i.amount)).toEqual([39, 25, 95, 65, 189, 72]);
    expect(r.tax).toBeNull();
    expect(r.category).toBe('food.groceries');
    expect(r.warnings).toEqual([]);
  });

  it('TW restaurant: 服務費 is the tip, also when it was listed as a line', () => {
    const r = normalizeReceipt(
      {
        merchant: '鼎泰豐 信義店', date: '2026-10-09', currency: 'TWD', currencyGuessed: false,
        items: lines(['小籠包 10入 ×2', 560], ['蝦仁蛋炒飯', 300], ['排骨蛋炒飯', 300], ['紅燒牛肉麵', 300], ['元盅雞湯', 280], ['炒高麗菜', 280], ['服務費 10%', 202]),
        tax: 0, taxIncluded: true, tip: 0, discount: 0, total: 2222, category: 'food.dining',
      },
      zh,
    );
    expect(r.items).toHaveLength(6);
    expect(r.tip).toBe(202);
    expect(r.warnings).toEqual([]);
  });

  it('US: tax, a discount on the whole bill and a handwritten tip fit the total', () => {
    const r = normalizeReceipt(PINK_DOOR, en);
    expect(r).toMatchObject({ currency: 'USD', total: 110.49, tax: 8.49, tip: 20, warnings: [] });
    expect(r.items).toEqual(PINK_DOOR.items);
  });

  it('a discount listed after the last item is the bill discount, not part of an item', () => {
    for (const disc of [-22, 22]) {
      const r = normalizeReceipt({ ...PINK_DOOR, discount: 0, items: [...PINK_DOOR.items, { name: 'Happy hour disc.', amount: disc }] }, en);
      expect(r.items).toEqual(PINK_DOOR.items);
      expect(r.warnings).toEqual([]);
    }
  });

  it('a discount printed under a line comes off that line', () => {
    const r = normalizeReceipt(
      { merchant: 'イオン', date: '2026-10-14', currency: 'JPY', items: lines(['鶏もも肉', 458], ['値引', -92], ['豆腐', 88]), tax: 0, taxIncluded: true, tip: 0, discount: 0, total: 454, category: 'food.groceries' },
      zh,
    );
    expect(r.items).toEqual(lines(['鶏もも肉', 366], ['豆腐', 88]));
    expect(r.warnings).toEqual([]);
  });

  it('refuses fractions in yen: a misread total falls back to the lines, a misread line is dropped', () => {
    const misreadTotal = normalizeReceipt({ ...IZAKAYA, total: 13.838 }, zh);
    expect(misreadTotal.total).toBe(13838);
    expect(misreadTotal.warnings).toEqual(['總額看不清楚，先用品項加起來的 ¥13,838，請確認']);

    const misreadLine = normalizeReceipt({ ...IZAKAYA, items: [{ name: 'お通し ×4', amount: 1.76 }, ...IZAKAYA.items.slice(1)] }, zh);
    expect(misreadLine.items).toHaveLength(6);
    expect(misreadLine.total).toBe(13838);
    expect(misreadLine.warnings).toEqual(['品項加起來是 ¥10,820，跟總額 ¥13,838 對不起來，請再看一下', '有 1 個品項的金額看起來讀錯了，沒有放進來']);

    const nothing = normalizeReceipt({ ...IZAKAYA, items: [], total: 1.26 }, en);
    expect(nothing.total).toBeNull();
    expect(nothing.warnings).toEqual(['The total looks misread, so it was left out']);
  });

  it('never offers what the lines add up to as the total when some money on the receipt was refused', () => {
    // A US cafe receipt without a currency sign, read with a TWD hint: the cents are refused, and
    // NT$2 (the one whole line) is not the bill.
    const cafe = {
      merchant: 'Corner Cafe', date: '2026-10-16', currency: 'TWD', currencyGuessed: true,
      items: lines(['Latte', 4.5], ['Bagel', 3.25], ['Water', 2]), tax: 0, taxIncluded: true, tip: 0, discount: 0, total: 9.75, category: 'food.drinks',
    };
    const twd = normalizeReceipt(cafe, en);
    expect(twd).toMatchObject({ currency: null, total: null, items: lines(['Water', 2]) });
    expect(twd.warnings).toEqual(['The total looks misread, so it was left out', '2 items look misread, so they were left out', 'Could not tell the receipt\'s currency. Check it']);
    // With the form's currency as the hint (USD), the same answer is the whole bill.
    for (const currency of ['USD', '$']) {
      const usd = normalizeReceipt({ ...cafe, currency }, { ...en, hint: 'USD' });
      expect(usd).toMatchObject({ currency: null, total: 9.75, items: cafe.items });
      expect(usd.warnings).toEqual(['Could not tell the receipt\'s currency. Check it']);
    }

    // A misread total with a misread line: the other lines would leave ¥1,760 out.
    const both = normalizeReceipt({ ...IZAKAYA, total: 13.838, items: [{ name: 'お通し ×4', amount: 1.76 }, ...IZAKAYA.items.slice(1)] }, zh);
    expect(both.total).toBeNull();
    expect(both.items).toHaveLength(6);
    expect(both.warnings).toEqual(['總額看起來讀錯了，沒有填入', '有 1 個品項的金額看起來讀錯了，沒有放進來']);
    // No total printed and the 外税 misread: the lines alone would leave the tax out.
    const tax = normalizeReceipt({ ...IZAKAYA, total: 0, tax: 1258.5 }, en);
    expect(tax.total).toBeNull();
    expect(tax.warnings).toEqual(['No total was found. Type in the amount']);
    // A misread subtotal or payment line is no money left out: the lines still make the total.
    const paid = normalizeReceipt({ ...IZAKAYA, total: 0, items: [...IZAKAYA.items, ...lines(['小計', 12580.5], ['クレジット', 13838.2])] }, en);
    expect(paid.total).toBe(13838);
  });

  it('uses the lines when no total was read, and says so', () => {
    const r = normalizeReceipt({ ...IZAKAYA, total: 0 }, en);
    expect(r.total).toBe(13838);
    expect(r.warnings).toEqual(['No total was found, so ¥13,838 from the items was used. Check it']);
  });

  it('leaves out a date that cannot be right, and says so', () => {
    const r = normalizeReceipt({ ...IZAKAYA, date: '2026-11-13' }, zh);
    expect(r.date).toBeNull();
    expect(r.warnings).toEqual(['收據上的日期看起來不對，沒有填入']);
  });

  it('a guessed currency is no currency: the amounts follow the hint, and the person is told', () => {
    const r = normalizeReceipt({ ...IZAKAYA, currency: 'TWD', currencyGuessed: true }, zh);
    expect(r.currency).toBeNull();
    expect(r.total).toBe(13838);
    expect(r.warnings).toEqual(['看不出收據用哪種貨幣，請確認幣別']);
    const dollars = normalizeReceipt({ ...PINK_DOOR, currency: '$' }, { ...en, hint: 'USD' });
    expect(dollars.currency).toBeNull();
    expect(dollars.total).toBe(110.49);
  });

  it('a currency other than the hint counts as read off the receipt, even when the model calls it a guess', () => {
    // Seen on staging (2026-10-17): Gemma 4 named JPY for Japanese receipts in a TWD group but set
    // currencyGuessed, which used to leave them in TWD.
    const r = normalizeReceipt({ ...IZAKAYA, currency: 'JPY', currencyGuessed: true }, zh);
    expect(r.currency).toBe('JPY');
    expect(r.warnings).toEqual([]);
  });

  it('caps the lines at 50 and clips names and the store name', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: 'x'.repeat(80) + i, amount: 10 }));
    const r = normalizeReceipt({ merchant: 'M'.repeat(150), currency: 'JPY', items: many, total: 600 }, zh);
    expect(r.items).toHaveLength(50);
    expect(r.items[0].name).toHaveLength(60);
    expect(r.merchant).toHaveLength(120);
    expect(r.warnings).toEqual(['品項超過 50 個，只放了前 50 個']);
  });

  it('cleans text: NFKC, single spaces, no tax-rate marks', () => {
    const r = normalizeReceipt({ merchant: '  ﾛｰｿﾝ   札幌駅前店 ', currency: 'JPY', items: lines(['おにぎり 鮭 *', 160], ['※ 緑茶 525ml', 128]), total: 288 }, zh);
    expect(r.merchant).toBe('ローソン 札幌駅前店');
    expect(r.items.map(i => i.name)).toEqual(['おにぎり 鮭', '緑茶 525ml']);
  });

  it('survives anything that is not the expected object', () => {
    for (const raw of [null, 'text', 42, [], { items: 'no' }, { items: [null, 5, { name: 3, amount: 'x' }] }]) {
      const r = normalizeReceipt(raw, zh);
      expect(r).toMatchObject({ merchant: null, date: null, currency: null, total: null, items: [], tax: null, tip: null, category: null });
    }
  });
});

describe('the Worker and the editor together', () => {
  it('a receipt without a currency lands in the form currency the scan started with (the hint)', () => {
    // A TWD group on a US trip: the form opened in USD. The editor sends the form's currency as the
    // hint, the Worker reads the cents in it, and applyScan puts them into that form.
    const form = newDraft({ id: 'e-1', memberIds: ['gino', 'abbie'], meId: 'gino', currency: 'USD', date: TODAY });
    const answer = {
      merchant: 'Corner Cafe', date: '2026-10-16', currency: 'USD', currencyGuessed: true,
      items: lines(['Latte', 4.5], ['Bagel', 3.25], ['Water', 2]), tax: 0, taxIncluded: true, tip: 0, discount: 0, total: 9.75, category: 'general',
    };
    const dto = normalizeReceipt(answer, { ...en, hint: form.currency });
    expect(dto.currency).toBeNull();
    const r = applyScan(form, dto, { started: form, base: form, groupCurrency: 'TWD', today: TODAY, rateFor: () => '' });
    expect(r.draft.currency).toBe('USD');
    expect(r.draft.amountRaw).toBe('9.75');
    expect(r.draft.split.items.map(i => [i.name, i.amountRaw])).toEqual([['Latte', '4.50'], ['Bagel', '3.25'], ['Water', '2']]);
  });
});

// ---------- talking to the model ----------

describe('readAnswer', () => {
  const obj = { merchant: 'A', total: 1 };
  it('reads every answer shape', () => {
    const usage = { prompt_tokens: 1200, completion_tokens: 300 };
    expect(readAnswer({ choices: [{ message: { content: JSON.stringify(obj) } }], usage })).toEqual({ data: obj, promptTokens: 1200, completionTokens: 300 });
    expect(readAnswer({ choices: [{ message: { content: [{ type: 'text', text: JSON.stringify(obj) }] } }] }).data).toEqual(obj);
    expect(readAnswer({ response: JSON.stringify(obj), usage }).data).toEqual(obj);
    expect(readAnswer({ response: obj }).data).toEqual(obj);
    expect(readAnswer({ result: { response: obj, usage } })).toEqual({ data: obj, promptTokens: 1200, completionTokens: 300 });
    expect(readAnswer({ choices: [{ message: { content: null } }], response: obj }).data).toEqual(obj);
  });
  it('finds JSON inside code fences and after some prose', () => {
    expect(parseJsonText('```json\n{"merchant":"A","total":1}\n```')).toEqual(obj);
    expect(parseJsonText('Here it is: {"merchant":"A","total":1} Hope this helps.')).toEqual(obj);
    expect(readAnswer({ response: '```\n{"merchant":"A","total":1}\n```' }).data).toEqual(obj);
  });
  it('gives null for answers without a JSON object', () => {
    expect(readAnswer({ response: 'I cannot read this image.' }).data).toBeNull();
    expect(readAnswer({ response: '[1, 2]' }).data).toBeNull();
    expect(readAnswer({ choices: [] }).data).toBeNull();
    expect(readAnswer(null)).toEqual({ data: null, promptTokens: 0, completionTokens: 0 });
  });
});

describe('receiptRequest', () => {
  const image = 'data:image/jpeg;base64,AAAA';
  const ctx = { today: TODAY, hint: 'TWD' };

  it('Gemma 4: OpenAI json_schema with a name, thinking off, the photo first', () => {
    const r = receiptRequest(DEFAULT_RECEIPT_MODEL, image, ctx) as any;
    expect(r.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'receipt', schema: RECEIPT_SCHEMA, strict: true } });
    expect(r.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(r.reasoning_effort).toBeUndefined();
    expect(r.temperature).toBe(0);
    expect(r.max_tokens).toBe(RECEIPT_MAX_TOKENS);
    expect(r.messages[0].role).toBe('system');
    expect(r.messages[1].content[0]).toEqual({ type: 'image_url', image_url: { url: image } });
    expect(r.messages[1].content[1].text).toBe('Today is 2026-10-17. Currency hint: TWD.');
  });
  it('Qwen 3.8: the same, with low reasoning effort', () => {
    const r = receiptRequest('@cf/qwen/qwen3.8-27b', image, { ...ctx, hint: null }) as any;
    expect(r.response_format.json_schema.name).toBe('receipt');
    expect(r.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(r.reasoning_effort).toBe('low');
    expect(r.messages[1].content[1].text).toBe('Today is 2026-10-17. Currency hint: none.');
  });
  it('Llama 4 Scout: the schema itself under json_schema', () => {
    const r = receiptRequest('@cf/meta/llama-4-scout-17b-16e-instruct', image, ctx) as any;
    expect(r.response_format).toEqual({ type: 'json_schema', json_schema: RECEIPT_SCHEMA });
    expect(r.chat_template_kwargs).toBeUndefined();
  });
  it('the schema asks for every field, nothing else', () => {
    expect([...RECEIPT_SCHEMA.required].sort()).toEqual(Object.keys(RECEIPT_SCHEMA.properties).sort());
    expect(RECEIPT_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('aiFailure and neurons', () => {
  it('spots the used-up daily allowance (3036)', () => {
    expect(aiFailure(new Error('3036: You have used up your daily free allocation of 10,000 neurons.')).quota).toBe(true);
    expect(aiFailure({ code: 3036, message: 'Account limited' }).quota).toBe(true);
    expect(aiFailure(new Error('AiError: you have used up your daily free allocation')).quota).toBe(true);
  });
  it('labels other failures by code or name only', () => {
    expect(aiFailure(new Error('AiError: 3040: Out of capacity'))).toEqual({ quota: false, label: 'Workers AI 3040' });
    expect(aiFailure(new Error("JSON Mode couldn't be met"))).toEqual({ quota: false, label: 'Error' });
    expect(aiFailure('boom')).toEqual({ quota: false, label: 'error' });
  });
  it('counts neurons from the token counts with each model rate, and a model without rates at the dearest ones', () => {
    expect(neuronsFor(DEFAULT_RECEIPT_MODEL, 2000, 500)).toBe(31.819);
    expect(neuronsFor('@cf/qwen/qwen3.8-27b', 1_000_000, 0)).toBe(40909);
    expect(neuronsFor('@cf/meta/llama-4-scout-17b-16e-instruct', 0, 1_000_000)).toBe(77273);
    // Never 0: Qwen 3.8's input and output rates, the dearest known. Not fooled by Object's own keys.
    expect(neuronsFor('@cf/other/model', 1000, 1000)).toBe(331.818);
    expect(neuronsFor('constructor', 1000, 1000)).toBe(331.818);
  });
  it('counts the seconds to the next UTC day', () => {
    expect(secondsToNextUtcDay(Date.parse('2026-10-17T23:59:00Z'))).toBe(60);
    expect(secondsToNextUtcDay(Date.parse('2026-10-17T00:00:00Z'))).toBe(86400);
  });
  it('gives up on a model that does not answer in time', async () => {
    let signal: AbortSignal | undefined;
    const ai = { run: (_m: string, _i: Record<string, unknown>, o?: { signal?: AbortSignal }) => { signal = o?.signal; return new Promise(() => undefined); } };
    await expect(runReceiptModel(ai, DEFAULT_RECEIPT_MODEL, 'data:image/jpeg;base64,AAAA', { today: TODAY, hint: null }, 10)).rejects.toMatchObject({
      status: 502,
      code: 'scan_failed',
      details: { reason: 'timeout' },
    });
    expect(signal?.aborted).toBe(true);
  });
});

// ---------- the day's neuron budget ----------

/** The value of `name` in one table of wrangler.toml ('vars' or 'env.staging.vars'). */
function tomlVar(table: string, name: string): string | undefined {
  let current = '';
  for (const raw of readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[{1,2}([^\]]+)\]{1,2}$/.exec(line);
    if (header) current = header[1].trim();
    else if (current === table) {
      const m = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
      if (m && m[1] === name) return m[2];
    }
  }
  return undefined;
}

describe('the neuron budget', () => {
  it('a scan\'s worst case: RECEIPT_INPUT_TOKENS_MAX in and RECEIPT_MAX_TOKENS out at its model\'s rates, rounded up', () => {
    expect([RECEIPT_INPUT_TOKENS_MAX, RECEIPT_MAX_TOKENS]).toEqual([8000, 1500]);
    // Gemma 4, Qwen 3.8, Llama 4 Scout.
    expect(RECEIPT_MODELS.map(receiptWorstCase)).toEqual([114, 764, 313]);
    for (const m of RECEIPT_MODELS) expect(receiptWorstCase(m)).toBe(Math.ceil(neuronsFor(m, RECEIPT_INPUT_TOKENS_MAX, RECEIPT_MAX_TOKENS)));
  });

  it('a model without known rates counts at the dearest known ones: the largest worst case, never 0', () => {
    const unknown = receiptWorstCase('@cf/other/model');
    expect(unknown).toBe(764);
    expect(unknown).toBe(Math.max(...RECEIPT_MODELS.map(receiptWorstCase)));
    expect(receiptWorstCase('constructor')).toBe(764);
    // Its real price is not known, so its scan keeps the worst case after the call too.
    expect(receiptNeuronsSpent('@cf/other/model', 2000, 500)).toBe(unknown);
  });

  it('a scan whose call came back counts its neurons rounded up, or its worst case without both token counts', () => {
    expect(receiptNeuronsSpent(DEFAULT_RECEIPT_MODEL, 2000, 500)).toBe(32);
    expect(receiptNeuronsSpent(DEFAULT_RECEIPT_MODEL, 1625, 164)).toBe(20);
    expect(receiptNeuronsSpent('@cf/meta/llama-4-scout-17b-16e-instruct', 3587, 262)).toBe(109);
    expect(receiptNeuronsSpent(DEFAULT_RECEIPT_MODEL, 0, 0)).toBe(114);
    expect(receiptNeuronsSpent(DEFAULT_RECEIPT_MODEL, 0, 300)).toBe(114);
    expect(receiptNeuronsSpent(DEFAULT_RECEIPT_MODEL, 1625, 0)).toBe(114);
    // A photo that took more than the allowance: what it took, past its worst case.
    expect(receiptNeuronsSpent('@cf/qwen/qwen3.8-27b', 17_000, 1500)).toBe(1132);
  });

  it('per environment: 8,000 a day in production and 500 anywhere else, unless RECEIPT_NEURONS_PER_DAY says otherwise', () => {
    expect(RECEIPT_NEURONS_PER_DAY).toEqual({ production: 8000, other: 500 });
    expect(neuronBudget({ ENVIRONMENT: 'production' })).toBe(8000);
    for (const ENVIRONMENT of ['staging', 'test', 'Production', '']) expect([ENVIRONMENT, neuronBudget({ ENVIRONMENT })]).toEqual([ENVIRONMENT, 500]);
    expect(neuronBudget({ ENVIRONMENT: 'production', RECEIPT_NEURONS_PER_DAY: '6000' })).toBe(6000);
    expect(neuronBudget({ ENVIRONMENT: 'staging', RECEIPT_NEURONS_PER_DAY: '1200' })).toBe(1200);
    expect(neuronBudget({ ENVIRONMENT: 'staging', RECEIPT_NEURONS_PER_DAY: 'lots' })).toBe(500);
  });

  it('wrangler.toml sets the code\'s two defaults, and together they stay under the account\'s free 10,000 a day', () => {
    const production = Number(tomlVar('vars', 'RECEIPT_NEURONS_PER_DAY'));
    const staging = Number(tomlVar('env.staging.vars', 'RECEIPT_NEURONS_PER_DAY'));
    expect([production, staging]).toEqual([RECEIPT_NEURONS_PER_DAY.production, RECEIPT_NEURONS_PER_DAY.other]);
    expect(production + staging).toBeLessThan(10_000);
    // The two names the defaults go by.
    expect([tomlVar('vars', 'ENVIRONMENT'), tomlVar('env.staging.vars', 'ENVIRONMENT')]).toEqual(['production', 'staging']);
  });
});

describe('takeAmount and addToCount (an amount in rate_limits)', () => {
  let d: TestD1;
  beforeEach(() => {
    d = new TestD1();
  });
  const row = (key: string) => d.rows<{ count: number; reset_at: number }>('SELECT count, reset_at FROM rate_limits WHERE key = ?', key)[0] ?? null;

  it('adds an amount only while the window\'s count stays at most the limit, and writes nothing otherwise', async () => {
    expect(await takeAmount(d.d1, 'k', 60, 100, 86_400)).toBe(true);
    expect(await takeAmount(d.d1, 'k', 40, 100, 86_400)).toBe(true);
    expect(row('k')?.count).toBe(100);
    expect(await takeAmount(d.d1, 'k', 1, 100, 86_400)).toBe(false);
    expect(row('k')?.count).toBe(100);
    // More than the limit on its own never fits, not even with nothing counted yet.
    expect(await takeAmount(d.d1, 'other', 101, 100, 86_400)).toBe(false);
    expect(row('other')).toBeNull();
  });

  it('starts a new window once the old one ended', async () => {
    d.exec('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)', 'k', 100, Date.now() - 1);
    expect(await takeAmount(d.d1, 'k', 30, 100, 86_400)).toBe(true);
    expect(row('k')?.count).toBe(30);
    expect(row('k')!.reset_at).toBeGreaterThan(Date.now() + 86_000_000);
  });

  it('corrects the count by any amount, whatever the limit, and leaves a missing row alone', async () => {
    await takeAmount(d.d1, 'k', 114, 500, 86_400);
    await addToCount(d.d1, 'k', 32 - 114);
    expect(row('k')?.count).toBe(32);
    await addToCount(d.d1, 'k', 1000);
    expect(row('k')?.count).toBe(1032);
    await addToCount(d.d1, 'gone', 5);
    expect(row('gone')).toBeNull();
  });
});

// ---------- the route ----------

const IMAGE = 'data:image/jpeg;base64,' + '/9j/4AAQSkZJRg'.repeat(40);
const OWNER = 'owner@evenly.test';

let db: TestD1;
const tokens: Record<string, string> = {};

type Run = (model: string, inputs: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;

interface Res {
  status: number;
  data: any;
  headers: Headers;
}

const gemmaAnswer = (obj: unknown, usage = { prompt_tokens: 2000, completion_tokens: 500 }) => ({
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(obj) }, finish_reason: 'stop' }],
  usage,
});

async function scan(
  user: string | null,
  opts: { body?: unknown; raw?: string; query?: string; run?: Run; env?: Record<string, unknown> } = {},
): Promise<Res & { run: Mock<Run> }> {
  const run = vi.fn<Run>(opts.run ?? (async () => gemmaAnswer(IZAKAYA)));
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  const text = opts.raw ?? JSON.stringify(opts.body ?? { image: IMAGE, currency: 'TWD', locale: 'zh-TW' });
  const req = new Request('http://api.test/api/receipts/scan' + (opts.query ?? ''), { method: 'POST', headers: h, body: text });
  const env = {
    DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'http://app.test/', ENVIRONMENT: 'test', OWNER_EMAILS: OWNER,
    AI: { run },
    ...opts.env,
  };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const body = await res.text();
  return { status: res.status, data: body ? JSON.parse(body) : undefined, headers: res.headers, run };
}

function addUser(id: string, email: string | null): void {
  const at = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, id, email, '#2F6FB5', at, at);
}

/** Today's neurons in the counter (null: none counted yet). */
const neurons = (): number | null =>
  db.rows<{ count: number }>('SELECT count FROM rate_limits WHERE key = ?', 'receipt:neurons:' + todayUTC())[0]?.count ?? null;

/** Puts today's neuron count at `n`. */
function setNeurons(n: number): void {
  db.exec('INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)', 'receipt:neurons:' + todayUTC(), n, Date.now() + 86_400_000);
}

describe('POST /api/receipts/scan', () => {
  beforeEach(async () => {
    db = new TestD1();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    addUser('ann', 'ann@evenly.test');
    addUser('bob', null);
    addUser('owner', OWNER);
    for (const id of ['ann', 'bob', 'owner']) tokens[id] = await createSession(db.d1, id, 'test');
  });

  it('needs a session', async () => {
    const r = await scan(null);
    expect(r.status).toBe(401);
    expect(r.run).not.toHaveBeenCalled();
  });

  it('reads the photo with the default model and returns the receipt and what it cost', async () => {
    const r = await scan('ann');
    expect(r.status).toBe(200);
    const dto = r.data as ReceiptScanDTO;
    expect(dto).toMatchObject({ merchant: '居酒屋 炉ばた 漁火', date: '2026-10-13', currency: 'JPY', total: 13838, tax: 1258, category: 'food.dining', warnings: [] });
    expect(dto.items).toHaveLength(7);
    expect(dto.usage).toEqual({ model: DEFAULT_RECEIPT_MODEL, promptTokens: 2000, completionTokens: 500, neurons: 31.819 });
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    const [model, inputs] = r.run.mock.calls[0];
    expect(model).toBe(DEFAULT_RECEIPT_MODEL);
    const user = (inputs.messages as any[])[1];
    expect(user.content[0].image_url.url).toBe(IMAGE);
    expect(user.content[1].text).toContain('Currency hint: TWD.');
  });

  it('writes the warnings in the language asked for', async () => {
    const r = await scan('ann', { body: { image: IMAGE, currency: 'JPY', locale: 'en' }, run: async () => gemmaAnswer({ ...IZAKAYA, date: '2030-01-01' }) });
    expect(r.status).toBe(200);
    expect(r.data.warnings).toEqual(['The date on the receipt looks wrong, so it was left out']);
  });

  it('accepts Llama answers ({response: object}) and builds the Llama request', async () => {
    const r = await scan('owner', {
      query: '?model=' + encodeURIComponent('@cf/meta/llama-4-scout-17b-16e-instruct'),
      run: async () => ({ response: PINK_DOOR, usage: { prompt_tokens: 100, completion_tokens: 100 } }),
    });
    expect(r.status).toBe(200);
    expect(r.data.total).toBe(110.49);
    expect(r.data.usage.model).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
    expect((r.run.mock.calls[0][1].response_format as any).json_schema).toEqual(RECEIPT_SCHEMA);
  });

  it('lets only the owner pick a model with ?model=, in every environment, and only a listed one', async () => {
    const qwen = '?model=' + encodeURIComponent('@cf/qwen/qwen3.8-27b');
    // Workers AI's daily allowance is the Cloudflare account's: staging scans spend production's.
    // (Staging's own neuron budget never fits a Qwen 3.8 scan, so this one raises it.)
    for (const env of [{ ENVIRONMENT: 'staging', RECEIPT_NEURONS_PER_DAY: '2000' }, { ENVIRONMENT: 'production' }]) {
      for (const query of [qwen, '?model=@cf/someone/else']) {
        const r = await scan('ann', { query, env });
        expect([env.ENVIRONMENT, query, r.status, r.data.error.code]).toEqual([env.ENVIRONMENT, query, 403, 'forbidden']);
        expect(r.run).not.toHaveBeenCalled();
      }
      expect((await scan('owner', { query: qwen, env })).run.mock.calls[0][0]).toBe('@cf/qwen/qwen3.8-27b');
      expect((await scan('owner', { query: '?model=@cf/someone/else', env })).status).toBe(400);
    }
    // Refused before anything is counted.
    expect(db.rows("SELECT key FROM rate_limits WHERE key LIKE 'receipt:user:ann:%'")).toEqual([]);
    // The configured model is everyone's.
    expect((await scan('ann', { env: { ENVIRONMENT: 'production', RECEIPT_MODEL: '@cf/qwen/qwen3.8-27b' } })).run.mock.calls[0][0]).toBe('@cf/qwen/qwen3.8-27b');
  });

  it('refuses bodies that are not a photo, before counting a scan', async () => {
    const bad = await scan('ann', { raw: '{"image":' });
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe('bad_request');
    for (const body of [{}, { image: 42 }, { image: 'data:text/plain;base64,' + 'A'.repeat(400) }, { image: 'data:image/jpeg;base64,AAAA' }, { image: IMAGE, locale: 'fr' }]) {
      const r = await scan('ann', { body });
      expect([JSON.stringify(body).slice(0, 40), r.status, r.data.error.code]).toEqual([JSON.stringify(body).slice(0, 40), 400, 'validation']);
      expect(r.run).not.toHaveBeenCalled();
    }
    expect(db.rows('SELECT key FROM rate_limits')).toEqual([]);
  });

  it('takes photos up to RECEIPT_MAX_BYTES past the 256 KB gate, and no bigger', async () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(1_000_000);
    expect((await scan('ann', { body: { image: big } })).status).toBe(200);
    const huge = await scan('ann', { body: { image: big + 'A'.repeat(RECEIPT_MAX_BYTES) } });
    expect(huge.status).toBe(413);
    expect(huge.data.error.code).toBe('payload_too_large');
  });

  it('limits scans per account and per day (scope user)', async () => {
    const env = { RECEIPT_PER_DAY: '2' };
    expect((await scan('ann', { env })).status).toBe(200);
    expect((await scan('ann', { env })).status).toBe(200);
    const third = await scan('ann', { env });
    expect(third.status).toBe(429);
    expect(third.data.error.code).toBe('rate_limited');
    expect(third.data.error.details.scope).toBe('user');
    expect(third.data.error.details.retryAfter).toBeGreaterThan(0);
    expect(third.data.error.details.retryAfter).toBeLessThanOrEqual(86400);
    expect(Number(third.headers.get('Retry-After'))).toBe(third.data.error.details.retryAfter);
    expect(third.run).not.toHaveBeenCalled();
    expect((await scan('bob', { env })).status).toBe(200);
  });

  it('limits scans for the whole app (scope app)', async () => {
    const env = { RECEIPT_GLOBAL_PER_DAY: '1' };
    expect((await scan('ann', { env })).status).toBe(200);
    const bob = await scan('bob', { env });
    expect(bob.status).toBe(429);
    expect(bob.data.error.details.scope).toBe('app');
    expect(bob.run).not.toHaveBeenCalled();
  });

  it('turns the used-up Workers AI allowance (3036) into 429 scope ai', async () => {
    const r = await scan('ann', { run: async () => { throw new Error('3036: You have used up your daily free allocation of 10,000 neurons.'); } });
    expect(r.status).toBe(429);
    expect(r.data.error).toMatchObject({ code: 'rate_limited', details: { scope: 'ai' } });
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('turns every other model failure into 502 scan_failed', async () => {
    const cases: [Run, string][] = [
      [async () => { throw new Error("JSON Mode couldn't be met"); }, 'model'],
      [async () => ({ response: 'Sorry, I cannot help with that.' }), 'model'],
      [async () => gemmaAnswer({ merchant: '', date: '', currency: '', items: [], total: 0, category: 'general' }), 'unreadable'],
    ];
    for (const [run, reason] of cases) {
      const r = await scan('ann', { run });
      expect([r.status, r.data.error.code, r.data.error.details?.reason]).toEqual([502, 'scan_failed', reason]);
    }
  });

  it('says so when the AI binding is missing', async () => {
    const r = await scan('ann', { env: { AI: undefined } });
    expect(r.status).toBe(502);
    expect(r.data.error.code).toBe('scan_failed');
  });

  // ---------- the day's neurons ----------

  it('counts what a scan really took once its call is back; during the call its worst case is set aside', async () => {
    let during: number | null = null;
    const r = await scan('ann', { run: async () => { during = neurons(); return gemmaAnswer(IZAKAYA); } });
    expect(r.status).toBe(200);
    expect(during).toBe(receiptWorstCase(DEFAULT_RECEIPT_MODEL));
    // 2,000 tokens in and 500 out: 31.819 neurons, counted as 32.
    expect(r.data.usage.neurons).toBe(31.819);
    expect(neurons()).toBe(32);
    expect((await scan('bob')).status).toBe(200);
    expect(neurons()).toBe(64);
    // A model that answered but read nothing still took its neurons.
    const unreadable = await scan('ann', { run: async () => gemmaAnswer({ merchant: '', date: '', currency: '', items: [], total: 0, category: 'general' }) });
    expect(unreadable.data.error.details.reason).toBe('unreadable');
    expect(neurons()).toBe(96);
  });

  it('counts a photo that took more input than the allowance at what it really took', async () => {
    const qwen = '?model=' + encodeURIComponent('@cf/qwen/qwen3.8-27b');
    const r = await scan('owner', { query: qwen, env: { ENVIRONMENT: 'production' }, run: async () => gemmaAnswer(IZAKAYA, { prompt_tokens: 17_000, completion_tokens: 1500 }) });
    expect(r.status).toBe(200);
    expect(neurons()).toBe(1132);
  });

  it('refuses a scan whose worst case would take the day past the budget: 429 scope ai, before the model', async () => {
    const env = { ENVIRONMENT: 'production' };
    const worst = receiptWorstCase(DEFAULT_RECEIPT_MODEL);
    setNeurons(8000 - worst + 1);
    const r = await scan('ann', { env });
    expect(r.status).toBe(429);
    expect(r.data.error).toMatchObject({ code: 'rate_limited', details: { scope: 'ai' } });
    expect(Math.abs(r.data.error.details.retryAfter - secondsToNextUtcDay())).toBeLessThanOrEqual(2);
    expect(Number(r.headers.get('Retry-After'))).toBe(r.data.error.details.retryAfter);
    expect(r.run).not.toHaveBeenCalled();
    expect(neurons()).toBe(8000 - worst + 1);
    // One neuron fewer, and the worst case fits exactly.
    setNeurons(8000 - worst);
    expect((await scan('ann', { env })).status).toBe(200);
    expect(neurons()).toBe(8000 - worst + 32);
  });

  it('a scan still reading holds its worst case, so one at the same time cannot take that room', async () => {
    const env = { ENVIRONMENT: 'production' };
    const worst = receiptWorstCase(DEFAULT_RECEIPT_MODEL);
    // Room for one worst case, not two.
    setNeurons(8000 - 2 * worst + 1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = scan('ann', { env, run: async () => { await gate; return gemmaAnswer(IZAKAYA); } });
    await vi.waitFor(() => expect(neurons()).toBe(8000 - worst + 1));
    const second = await scan('bob', { env });
    expect([second.status, second.data.error.details.scope]).toEqual([429, 'ai']);
    expect(second.run).not.toHaveBeenCalled();
    release();
    expect((await first).status).toBe(200);
    expect(neurons()).toBe(8000 - 2 * worst + 1 + 32);
  });

  it('budgets 8,000 neurons a day in production and 500 anywhere else; RECEIPT_NEURONS_PER_DAY overrides', async () => {
    const worst = receiptWorstCase(DEFAULT_RECEIPT_MODEL);
    setNeurons(500 - worst + 1);
    for (const ENVIRONMENT of ['staging', 'test']) {
      const r = await scan('ann', { env: { ENVIRONMENT } });
      expect([ENVIRONMENT, r.status, r.data.error?.details?.scope]).toEqual([ENVIRONMENT, 429, 'ai']);
    }
    expect((await scan('ann', { env: { ENVIRONMENT: 'production' } })).status).toBe(200);
    setNeurons(500 - worst + 1);
    expect((await scan('ann', { env: { ENVIRONMENT: 'staging', RECEIPT_NEURONS_PER_DAY: '600' } })).status).toBe(200);
    setNeurons(8000 - worst + 1);
    expect((await scan('ann', { env: { ENVIRONMENT: 'production', RECEIPT_NEURONS_PER_DAY: '9000' } })).status).toBe(200);
    // Qwen 3.8's worst case alone passes staging's 500: there it never fits.
    setNeurons(0);
    const qwen = await scan('owner', { query: '?model=' + encodeURIComponent('@cf/qwen/qwen3.8-27b'), env: { ENVIRONMENT: 'staging' } });
    expect([qwen.status, qwen.data.error.details.scope]).toEqual([429, 'ai']);
    expect(neurons()).toBe(0);
  });

  it('a model without known rates (RECEIPT_MODEL) counts its worst case, during and after the call, never 0', async () => {
    let during: number | null = null;
    const r = await scan('ann', {
      env: { ENVIRONMENT: 'production', RECEIPT_MODEL: '@cf/other/model' },
      run: async () => { during = neurons(); return gemmaAnswer(IZAKAYA); },
    });
    expect(r.status).toBe(200);
    expect(r.run.mock.calls[0][0]).toBe('@cf/other/model');
    expect([during, neurons()]).toEqual([764, 764]);
    // What it says it cost: its tokens at the dearest known rates.
    expect(r.data.usage.neurons).toBe(227.273);
  });

  it('keeps the worst case counted when the call fails or its answer has no token counts: it may have run', async () => {
    const worst = receiptWorstCase(DEFAULT_RECEIPT_MODEL);
    const failed = await scan('ann', { run: async () => { throw new Error("JSON Mode couldn't be met"); } });
    expect(failed.status).toBe(502);
    expect(neurons()).toBe(worst);
    const noUsage = await scan('ann', { run: async () => ({ response: IZAKAYA }) });
    expect(noUsage.status).toBe(200);
    expect(neurons()).toBe(2 * worst);
  });
});
