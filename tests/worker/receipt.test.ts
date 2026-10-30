// Receipt scan (POST /api/receipts/scan, docs/SPEC.md section 6, Receipt scan;
// docs/PLAN-push-scan-cookies.md section 3.1): the pure parts of services/receipt.ts (numbers,
// dates, currencies, line kinds, the normalizer with Japanese, Taiwan and US receipts and with
// photos in parts, answer shapes, the request per model for one photo and for several, a scan's
// worst-case neurons, the photo's size from its header, joining the answers of one call per photo),
// the normalizer's answer going into the editor's applyScan, the neuron counter in rate_limits,
// then the route end to end against the real schema in SQLite with a fake env.AI (image or images,
// the size cap, the limits counted in photos, the day's neuron budget, ?model= and ?joint=, which
// path two or three photos take, the guard, errors).

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { todayUTC } from '../../src/shared/dates';
import type { ReceiptScanDTO } from '../../src/shared/types';
import { applyScan, newDraft } from '../../src/web/features/expenses/editorLogic';
import { addToCount, createSession, takeAmount } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { neuronBudget, RECEIPT_MAX_BYTES, RECEIPT_NEURONS_PER_DAY, readsJointly } from '../../src/worker/routes/receipts';
import {
  aiFailure, DEFAULT_RECEIPT_MODEL, imageSize, lineKind, mergeReadings, minorUnits, neuronsFor, normalizeReceipt, parseJsonText, photosReadFloor,
  readAnswer, RECEIPT_INPUT_TOKENS_MAX, RECEIPT_INPUT_TOKENS_PER_EXTRA_PHOTO, RECEIPT_JOINT_MODELS, RECEIPT_MAX_TOKENS, RECEIPT_MODELS,
  RECEIPT_PHOTOS_PROMPT, RECEIPT_SCAN_MAX_SIDE, RECEIPT_SCHEMA, RECEIPT_SCHEMA_PHOTOS, RECEIPT_SYSTEM_PROMPT, RECEIPT_TIMEOUT_MS,
  RECEIPT_TIMEOUT_MULTI_MS, receiptCategory, receiptCurrency, receiptDate, receiptMaxTokens, receiptNeuronsSpent, receiptRequest,
  receiptUserText, receiptWorstCase, runReceiptModel, secondsToNextUtcDay, type NormalizeContext, type ReceiptPromptContext,
} from '../../src/worker/services/receipt';
import { TestD1 } from './d1-sqlite';

const QWEN = '@cf/qwen/qwen3.8-27b';
const LLAMA = '@cf/meta/llama-4-scout-17b-16e-instruct';

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
    expect(RECEIPT_MODELS.map(m => receiptWorstCase(m))).toEqual([114, 764, 313]);
    for (const m of RECEIPT_MODELS) expect(receiptWorstCase(m)).toBe(Math.ceil(neuronsFor(m, RECEIPT_INPUT_TOKENS_MAX, RECEIPT_MAX_TOKENS)));
  });

  it('a model without known rates counts at the dearest known ones: the largest worst case, never 0', () => {
    const unknown = receiptWorstCase('@cf/other/model');
    expect(unknown).toBe(764);
    expect(unknown).toBe(Math.max(...RECEIPT_MODELS.map(m => receiptWorstCase(m))));
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

  it('wrangler.toml sets production\'s default and staging\'s tripled budget, and with 500 for the REST scripts they stay inside the account\'s free 10,000 a day', () => {
    const production = Number(tomlVar('vars', 'RECEIPT_NEURONS_PER_DAY'));
    const staging = Number(tomlVar('env.staging.vars', 'RECEIPT_NEURONS_PER_DAY'));
    // Staging is three times the code's default outside production since 2026-10-30 (Gino).
    expect([production, staging]).toEqual([RECEIPT_NEURONS_PER_DAY.production, RECEIPT_NEURONS_PER_DAY.other * 3]);
    expect(production + staging + 500).toBeLessThanOrEqual(10_000);
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

/** The real 4 x 4 JPEG of tests/worker/receipt-photos.test.ts (its SOF0 is at byte 140). */
const JPEG_BYTES = Buffer.from(
  '/9j/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC8AGLE/9k=',
  'base64',
);
const dataUrl = (bytes: Uint8Array, mime = 'image/jpeg') => `data:${mime};base64,` + Buffer.from(bytes).toString('base64');
/** The JPEG fixture as a data URL (383 characters): what every one-photo test sends. */
const IMAGE = dataUrl(JPEG_BYTES);
const OWNER = 'owner@evenly.test';

/** A JPEG header of w x h (APP0, a quantization table, then SOFn), padded so its data URL passes the 200-character floor. */
function jpegOfSize(w: number, h: number, sof = 0xc0, pad = 300): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...Array(64).fill(1)];
  const frame = [0xff, sof, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.concat([Buffer.from([0xff, 0xd8, ...app0, ...dqt, ...frame, 0xff, 0xda, 0x00, 0x08]), Buffer.alloc(pad, 7)]);
}
function pngOfSize(w: number, h: number): Buffer {
  const b = Buffer.alloc(33 + 200);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function webpOf(chunk: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number): Buffer {
  const b = Buffer.alloc(30 + 200);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'ascii');
  b.write(chunk, 12, 'ascii');
  b.writeUInt32LE(b.length - 20, 16);
  if (chunk === 'VP8 ') {
    b.set([0x9d, 0x01, 0x2a], 23);
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  } else if (chunk === 'VP8L') {
    const bits = (w - 1) | ((h - 1) << 14);
    b[20] = 0x2f;
    b.writeUInt32LE(bits >>> 0, 21);
  } else {
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  }
  return b;
}
/** Photos of 1200 x 1600 (what the apps send for a portrait receipt). */
const PHOTO = (i: number) => dataUrl(jpegOfSize(1200, 1600, 0xc0, 300 + i));

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
  opts: { body?: unknown; raw?: string; query?: string; run?: Run; env?: Record<string, unknown>; waitUntil?: (p: Promise<unknown>) => void } = {},
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
  const ctx = { waitUntil: opts.waitUntil ?? (() => undefined), passThroughOnException: () => undefined } as unknown as ExecutionContext;
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
    expect(dto).toMatchObject({ merchant: '居酒屋 炉ばた 漁火', date: '2026-10-13', currency: 'JPY', total: 13838, tax: 1258, category: 'food.dining', warnings: [], totalFound: true });
    expect(dto.items).toHaveLength(7);
    expect(dto.usage).toEqual({ model: DEFAULT_RECEIPT_MODEL, promptTokens: 2000, completionTokens: 500, neurons: 31.819, photos: 1, calls: 1 });
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
    const big = dataUrl(Buffer.concat([JPEG_BYTES, Buffer.alloc(750_000)]));
    expect(big.length).toBeGreaterThan(1_000_000);
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

// ======================================================================================
// Two or three photos in one scan
// ======================================================================================

/** receiptRequest for one photo as it was before several photos (6164f11): one photo's request must stay exactly this. */
function requestBefore(model: string, image: string, ctx: { today: string; hint: string | null }): Record<string, unknown> {
  const family = model.includes('/meta/llama') ? 'llama' : model.includes('/qwen/') ? 'qwen' : 'gemma';
  const req: Record<string, unknown> = {
    messages: [
      { role: 'system', content: RECEIPT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: `Today is ${ctx.today}. Currency hint: ${ctx.hint ?? 'none'}.` },
        ],
      },
    ],
    max_tokens: 1500,
    temperature: 0,
  };
  if (family === 'llama') {
    req.response_format = { type: 'json_schema', json_schema: RECEIPT_SCHEMA };
    return req;
  }
  req.response_format = { type: 'json_schema', json_schema: { name: 'receipt', schema: RECEIPT_SCHEMA, strict: true } };
  req.chat_template_kwargs = { enable_thinking: false };
  if (family === 'qwen') req.reasoning_effort = 'low';
  return req;
}

/** The contract's photos paragraph, word for word. */
const PHOTOS_PARAGRAPH =
  'There are {n} photos, in the order the person added them. Usually they are parts of one long receipt, from the top down, and photos next to each other often show some of the same lines; or they are a bill and the card or payment slip of the same payment. Read them together and fill in the fields once, for the whole purchase. items: every purchased line of every photo, in printed order, photo 1 first; a line that shows on two photos where they overlap is one line, so list it once. merchant and date: from whichever photo prints them. total, tax, tip and discount: the bill\'s final amounts, from whichever photo prints them (usually the last); a card or payment slip of the same bill is not another receipt, and when it has a tip and a total written by hand, use that total. sameReceipt: true when the photos are parts of one receipt, or a receipt and the slip of the same payment; false when they show different shops or different purchases, and then fill in every field from the first photo that shows a total and list only that receipt\'s lines. If none of the photos is a receipt or can be read, give "" and 0 for the fields and [] for items.';

describe('receiptRequest with one photo and with several', () => {
  const ctx: ReceiptPromptContext = { today: TODAY, hint: 'TWD' };

  it('one photo (a string or a one-element list) deep-equals the request from before several photos, for all three families', () => {
    for (const model of RECEIPT_MODELS) {
      for (const hint of ['TWD', null]) {
        const before = requestBefore(model, IMAGE, { today: TODAY, hint });
        expect(receiptRequest(model, IMAGE, { today: TODAY, hint })).toEqual(before);
        expect(JSON.stringify(receiptRequest(model, [IMAGE], { today: TODAY, hint }))).toBe(JSON.stringify(before));
      }
    }
  });

  it('three photos: the photos paragraph, the images in order then the text, sameReceipt required last, 3,000 tokens', () => {
    const imgs = [PHOTO(1), PHOTO(2), PHOTO(3)];
    expect(RECEIPT_PHOTOS_PROMPT).toBe(PHOTOS_PARAGRAPH);
    for (const model of [DEFAULT_RECEIPT_MODEL, QWEN]) {
      const r = receiptRequest(model, imgs, ctx) as any;
      expect(r.messages[0]).toEqual({ role: 'system', content: `${RECEIPT_SYSTEM_PROMPT}\n\n${PHOTOS_PARAGRAPH.replace('{n}', '3')}` });
      expect(r.messages[1].content).toEqual([
        ...imgs.map(url => ({ type: 'image_url', image_url: { url } })),
        { type: 'text', text: 'Photos 1 to 3 above, in order. Today is 2026-10-17. Currency hint: TWD.' },
      ]);
      expect(r.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'receipt', schema: RECEIPT_SCHEMA_PHOTOS, strict: true } });
      expect([r.max_tokens, r.temperature, r.chat_template_kwargs]).toEqual([3000, 0, { enable_thinking: false }]);
      expect(r.reasoning_effort).toBe(model === QWEN ? 'low' : undefined);
    }
    expect(Object.keys(RECEIPT_SCHEMA_PHOTOS.properties)).toEqual([...Object.keys(RECEIPT_SCHEMA.properties), 'sameReceipt']);
    expect(RECEIPT_SCHEMA_PHOTOS.properties.sameReceipt).toEqual({ type: 'boolean' });
    expect(RECEIPT_SCHEMA_PHOTOS.required).toEqual([...RECEIPT_SCHEMA.required, 'sameReceipt']);
    expect(RECEIPT_SCHEMA_PHOTOS.additionalProperties).toBe(false);
    // Llama 4 Scout: the schema itself, and its own form.
    const l = receiptRequest(LLAMA, imgs, { ...ctx, hint: null }) as any;
    expect(l.response_format).toEqual({ type: 'json_schema', json_schema: RECEIPT_SCHEMA_PHOTOS });
    expect(l.chat_template_kwargs).toBeUndefined();
    expect(l.messages[1].content.at(-1).text).toBe('Photos 1 to 3 above, in order. Today is 2026-10-17. Currency hint: none.');
    // Two photos: 2,250 tokens and "There are 2 photos".
    const two = receiptRequest(QWEN, imgs.slice(0, 2), ctx) as any;
    expect(two.max_tokens).toBe(2250);
    expect(two.messages[0].content).toContain('There are 2 photos, in the order the person added them.');
  });

  it('one call per photo: today\'s request with one sentence at the end of its text', () => {
    expect(receiptUserText({ ...ctx, part: { i: 2, n: 3 } })).toBe('Today is 2026-10-17. Currency hint: TWD. This is photo 2 of 3 of one receipt, so it may show only some of its lines.');
    const r = receiptRequest(QWEN, PHOTO(1), { ...ctx, part: { i: 1, n: 2 } }) as any;
    expect({ ...r, messages: [r.messages[0], { ...r.messages[1], content: [r.messages[1].content[0], { type: 'text', text: 'Today is 2026-10-17. Currency hint: TWD.' }] }] }).toEqual(requestBefore(QWEN, PHOTO(1), ctx));
    expect(r.messages[1].content[1].text.endsWith(' This is photo 1 of 2 of one receipt, so it may show only some of its lines.')).toBe(true);
  });
});

describe('what a scan of one, two or three photos sets aside', () => {
  it('receiptWorstCase(model, n): Qwen 764 / 1,195 / 1,626, Gemma 114 / 182 / 250, Llama 313 / 498 / 684; an unknown model at the dearest rates', () => {
    expect([RECEIPT_INPUT_TOKENS_MAX, RECEIPT_INPUT_TOKENS_PER_EXTRA_PHOTO]).toEqual([8000, 5200]);
    expect([1, 2, 3].map(n => receiptMaxTokens(n))).toEqual([1500, 2250, 3000]);
    expect([1, 2, 3].map(n => receiptWorstCase(QWEN, n))).toEqual([764, 1195, 1626]);
    expect([1, 2, 3].map(n => receiptWorstCase(DEFAULT_RECEIPT_MODEL, n))).toEqual([114, 182, 250]);
    expect([1, 2, 3].map(n => receiptWorstCase(LLAMA, n))).toEqual([313, 498, 684]);
    expect([1, 2, 3].map(n => receiptWorstCase('@cf/other/model', n))).toEqual([764, 1195, 1626]);
    // One call per photo: three one-photo worst cases.
    expect([QWEN, DEFAULT_RECEIPT_MODEL, LLAMA].map(m => 3 * receiptWorstCase(m, 1))).toEqual([2292, 342, 939]);
    // A call without token counts counts the worst case of what it read.
    expect(receiptNeuronsSpent(QWEN, 0, 0, 3)).toBe(1626);
    expect(receiptNeuronsSpent(QWEN, 7240, 870, 3)).toBe(Math.ceil(neuronsFor(QWEN, 7240, 870)));
  });

  it('in the day\'s 8,000: a three-photo scan is refused once the count passes 6,374 in one call, 5,708 one call per photo; one photo until 7,236', () => {
    expect(8000 - receiptWorstCase(QWEN, 3)).toBe(6374);
    expect(8000 - 3 * receiptWorstCase(QWEN, 1)).toBe(5708);
    expect(8000 - receiptWorstCase(QWEN, 1)).toBe(7236);
    // Staging's 500 with Gemma: three photos in one call, then one call per photo, fit one after the other.
    expect(receiptWorstCase(DEFAULT_RECEIPT_MODEL, 3) + 3 * receiptWorstCase(DEFAULT_RECEIPT_MODEL, 1)).toBeLessThanOrEqual(600);
    expect(3 * receiptWorstCase(DEFAULT_RECEIPT_MODEL, 1)).toBeLessThanOrEqual(500);
  });

  it('the models that may read several photos in one call: Gemma 4 and Qwen 3.8', () => {
    expect(RECEIPT_JOINT_MODELS).toEqual([DEFAULT_RECEIPT_MODEL, QWEN]);
    expect([RECEIPT_TIMEOUT_MS, RECEIPT_TIMEOUT_MULTI_MS, RECEIPT_SCAN_MAX_SIDE]).toEqual([55_000, 85_000, 2000]);
  });
});

describe('imageSize', () => {
  it('reads the JPEG fixture (SOF0 at byte 140, after the segments before it) and a progressive JPEG', () => {
    expect([JPEG_BYTES[140], JPEG_BYTES[141]]).toEqual([0xff, 0xc0]);
    expect(imageSize(IMAGE)).toEqual({ width: 4, height: 4 });
    expect(imageSize(dataUrl(jpegOfSize(1200, 1600)))).toEqual({ width: 1200, height: 1600 });
    expect(imageSize(dataUrl(jpegOfSize(1600, 900, 0xc2)))).toEqual({ width: 1600, height: 900 });
    // A Huffman table (C4) before the frame is not the frame, nor are fill bytes.
    const dhtFirst = Buffer.from([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x04, 0x01, 0x02, 0xff, 0xff, 0xc1, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, ...Array(200).fill(0)]);
    expect(imageSize(dataUrl(dhtFirst))).toEqual({ width: 48, height: 32 });
  });

  it('reads PNG IHDR and WebP VP8, VP8L and VP8X', () => {
    expect(imageSize(dataUrl(pngOfSize(800, 2000), 'image/png'))).toEqual({ width: 800, height: 2000 });
    expect(imageSize(dataUrl(webpOf('VP8 ', 1000, 1400), 'image/webp'))).toEqual({ width: 1000, height: 1400 });
    expect(imageSize(dataUrl(webpOf('VP8L', 1000, 1400), 'image/webp'))).toEqual({ width: 1000, height: 1400 });
    expect(imageSize(dataUrl(webpOf('VP8X', 3000, 2000), 'image/webp'))).toEqual({ width: 3000, height: 2000 });
  });

  it('is null for garbage and for a header cut off', () => {
    expect(imageSize(dataUrl(Buffer.from('not an image at all, only some words that run on for a while')))).toBeNull();
    expect(imageSize(dataUrl(JPEG_BYTES.subarray(0, 145)))).toBeNull();
    expect(imageSize(dataUrl(pngOfSize(10, 10).subarray(0, 20), 'image/png'))).toBeNull();
    expect(imageSize(dataUrl(webpOf('VP8 ', 10, 10).subarray(0, 26), 'image/webp'))).toBeNull();
    expect(imageSize(dataUrl(pngOfSize(0, 10), 'image/png'))).toBeNull();
    // The scan data before any frame header.
    expect(imageSize(dataUrl(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, ...Array(40).fill(0)])))).toBeNull();
    expect(imageSize('data:image/jpeg;base64,@@@@not-base64@@@@')).toBeNull();
    expect(imageSize('data:image/jpeg,raw')).toBeNull();
    // A frame header past the first 64 KB is not looked for.
    const late = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(0xfffd), jpegOfSize(100, 100).subarray(2)]);
    expect(imageSize(dataUrl(late))).toBeNull();
  });
});

describe('the Qwen guard\'s floor', () => {
  it('1,200 plus 1 per 1,400 px of each photo, for Qwen only', () => {
    const three = [{ width: 1200, height: 1600 }, { width: 1200, height: 1600 }, { width: 1200, height: 1600 }];
    expect(photosReadFloor(QWEN, three)).toBe(5313);
    expect(photosReadFloor(DEFAULT_RECEIPT_MODEL, three)).toBeNull();
    expect(photosReadFloor(LLAMA, three)).toBeNull();
  });
});

// ---------- joining one call per photo ----------

const line = (name: string, amount: number) => ({ name, amount });
/** The long supermarket receipt (tmp/receipts jp-supermarket-long) in three photos, two lines shared at each cut. */
const AEON_LINES = [
  line('北海道牛乳 1L', 238), line('卵 10個', 268), line('食パン 6枚', 158), line('バナナ', 198), line('豚こま切れ', 398), line('鶏もも肉', 458),
  line('キャベツ', 178), line('玉ねぎ 3個', 198), line('にんじん', 128), line('じゃがいも', 248), line('納豆 3P', 98), line('豆腐', 88),
  line('ヨーグルト', 158), line('味噌', 398), line('サッポロクラシック 6缶', 1218),
];
const reading = (o: Record<string, unknown>) => ({
  merchant: '', date: '', currency: 'JPY', currencyGuessed: false, items: [], tax: 0, taxIncluded: false, tip: 0, discount: 0, total: 0, category: '', ...o,
});
const AEON_PARTS = [
  reading({ merchant: 'イオン 札幌桑園店', date: '2026-10-14', items: AEON_LINES.slice(0, 6), category: 'food.groceries' }),
  reading({ items: AEON_LINES.slice(4, 11) }),
  reading({ items: AEON_LINES.slice(9), tax: 379, total: 4809 }),
];
const mctx = { hint: 'TWD', today: TODAY };

describe('mergeReadings', () => {
  it('the receipt in three parts: every line once, in order, the total and tax from the bottom, the store and date from the top', () => {
    const { raw, notes } = mergeReadings(AEON_PARTS, mctx);
    expect(raw.items).toEqual(AEON_LINES);
    expect(raw).toMatchObject({ merchant: 'イオン 札幌桑園店', date: '2026-10-14', currency: 'JPY', currencyGuessed: false, total: 4809, tax: 379, taxIncluded: false, category: 'food.groceries', sameReceipt: true });
    expect(notes).toEqual({ overlapDropped: 4, totalsDiffer: null, unread: [] });
    const r = normalizeReceipt(raw, { hint: 'TWD', locale: 'en', today: TODAY, photos: 3, merged: notes });
    expect(r).toMatchObject({ merchant: 'イオン 札幌桑園店', date: '2026-10-14', currency: 'JPY', total: 4809, tax: 379, totalFound: true });
    expect(r.items).toEqual(AEON_LINES);
    expect(r.warnings).toEqual(['4 items were on two photos, so they were counted once']);
  });

  it('drops an overlap of 1 to 8 lines, the longest that matches, and no more than 8', () => {
    const base = Array.from({ length: 10 }, (_, i) => line(`品 ${i}`, 100 + i));
    for (let k = 1; k <= 9; k++) {
      const next = [...base.slice(base.length - k), line('新しい 1', 51), line('新しい 2', 52)];
      const { raw, notes } = mergeReadings([reading({ items: base }), reading({ items: next, total: 1 })], mctx);
      const dropped = k <= 8 ? k : 0;
      expect([k, notes.overlapDropped, (raw.items as unknown[]).length]).toEqual([k, dropped, base.length + next.length - dropped]);
    }
  });

  it('matches names after NFKC and lowercase, without spaces or tax marks, and amounts in minor units; another amount is another line', () => {
    // Half-width katakana, case, spaces and tax marks do not matter.
    const a = [line('ｺｰﾋｰ L *', 210), line('Bagel', 3.25)];
    const b = [line('コーヒー l', 210), line('bagel ※', 3.25), line('Water', 2)];
    const joined = mergeReadings([reading({ items: a, currency: 'USD' }), reading({ items: b, currency: 'USD' })], mctx);
    expect([joined.notes.overlapDropped, joined.raw.items]).toEqual([2, [...a, line('Water', 2)]]);
    // 3.25 and 3.250 are the same cents; 3.25 and 3.26 are not.
    expect(mergeReadings([reading({ items: [line('Tea', 3.25)], currency: 'USD' }), reading({ items: [line('Tea', 3.250)], currency: 'USD' })], mctx).notes.overlapDropped).toBe(1);
    expect(mergeReadings([reading({ items: [line('Tea', 3.25)], currency: 'USD' }), reading({ items: [line('Tea', 3.26)], currency: 'USD' })], mctx).notes.overlapDropped).toBe(0);
    // The same name at another price is a line of its own.
    const other = mergeReadings([reading({ items: [line('Beer', 5)] }), reading({ items: [line('Beer', 6)] })], mctx);
    expect(other.raw.items).toEqual([line('Beer', 5), line('Beer', 6)]);
  });

  it('a line repeated right at a boundary counts as the overlap: Beer, Beer then Beer, Fries is Beer, Beer, Fries', () => {
    const { raw, notes } = mergeReadings([reading({ items: [line('Fries', 300), line('Beer', 500), line('Beer', 500)] }), reading({ items: [line('Beer', 500), line('Fries', 300)] })], mctx);
    expect(raw.items).toEqual([line('Fries', 300), line('Beer', 500), line('Beer', 500), line('Fries', 300)]);
    expect(notes.overlapDropped).toBe(1);
  });

  it('the bill and its card slip: the slip\'s total and tip, the bill\'s tax and discount, and totalsDiffer', () => {
    const bill = reading({ merchant: 'The Pink Door', date: '2026-09-27', currency: 'USD', items: PINK_DOOR.items, tax: 8.49, discount: 22, total: 90.49 });
    const slip = reading({ merchant: 'THE PINK DOOR', date: '09/27/2026', currency: 'USD', tip: 20, total: 110.49 });
    const { raw, notes } = mergeReadings([bill, slip], { hint: 'USD', today: TODAY });
    expect(raw).toMatchObject({ merchant: 'The Pink Door', total: 110.49, tip: 20, tax: 8.49, discount: 22, sameReceipt: true });
    expect(notes.totalsDiffer).toEqual({ photo: 2, total: 110.49 });
    const r = normalizeReceipt(raw, { hint: 'USD', locale: 'en', today: TODAY, photos: 2, merged: notes });
    expect(r).toMatchObject({ total: 110.49, tip: 20, tax: 8.49 });
    expect(r.warnings).toEqual(['The photos show more than one total, so US$110.49 from photo 2 was used. Check it']);
    const zh = normalizeReceipt(raw, { hint: 'USD', locale: 'zh-TW', today: TODAY, photos: 2, merged: notes });
    expect(zh.warnings).toEqual(['照片上有不只一個總額，用了第 2 張的 US$110.49，請確認']);
    // The same total on both: nothing to say.
    expect(mergeReadings([bill, { ...slip, total: 90.49, tip: 0 }], mctx).notes.totalsDiffer).toBeNull();
  });

  it('the store from the first photo that names one, the date from the first with one, and a currency read off the receipt over a guess', () => {
    const { raw } = mergeReadings([
      reading({ currency: 'TWD', currencyGuessed: true, items: [line('A', 1)] }),
      reading({ merchant: 'ローソン', category: 'food.groceries', currency: 'JPY', currencyGuessed: false, items: [line('B', 2)] }),
      reading({ date: '2026-10-12', currency: 'JPY', total: 3 }),
    ], mctx);
    expect(raw).toMatchObject({ merchant: 'ローソン', category: 'food.groceries', date: '2026-10-12', currency: 'JPY', currencyGuessed: false });
    // Only guesses: the first that names one, still a guess.
    expect(mergeReadings([reading({ currency: '', items: [] }), reading({ currency: 'TWD', currencyGuessed: true })], mctx).raw).toMatchObject({ currency: 'TWD', currencyGuessed: true });
  });

  it('a part without the store\'s name is not another receipt for its date: the model wrote today\'s on parts that print none (staging, 2026-10-30)', () => {
    // What Gemma 4 gave on staging for the bottom photo: no store, and today's date.
    const parts = [AEON_PARTS[0], { ...AEON_PARTS[1], date: TODAY }, { ...AEON_PARTS[2], date: TODAY }];
    const { raw, notes } = mergeReadings(parts, mctx);
    expect(raw).toMatchObject({ sameReceipt: true, merchant: 'イオン 札幌桑園店', date: '2026-10-14', total: 4809 });
    expect(raw.items).toEqual(AEON_LINES);
    expect(notes.overlapDropped).toBe(4);
    // The store's photo gives the date also when it is not the first.
    expect(mergeReadings([{ ...AEON_PARTS[1], date: TODAY }, AEON_PARTS[0]], mctx).raw.date).toBe('2026-10-14');
    // Two photos that name the store with different dates are still two receipts.
    expect(mergeReadings([AEON_PARTS[0], { ...AEON_PARTS[2], merchant: 'イオン 札幌桑園店', date: '2026-10-15' }], mctx).raw.sameReceipt).toBe(false);
  });

  it('different stores or dates: sameReceipt false, and the fields of the first photo with a total, never the two added together', () => {
    const a = reading({ merchant: '全家便利商店', date: '2026-10-05', currency: 'TWD', items: [line('御飯糰', 39)], total: 39 });
    const b = reading({ merchant: '7-ELEVEN', date: '2026-10-05', currency: 'TWD', items: [line('咖啡', 65)], total: 65 });
    const { raw, notes } = mergeReadings([a, b], mctx);
    expect(raw).toEqual({ ...a, sameReceipt: false });
    expect(notes.overlapDropped).toBe(0);
    const r = normalizeReceipt(raw, { hint: 'TWD', locale: 'zh-TW', today: TODAY, photos: 2, merged: notes });
    expect([r.total, r.items.length]).toEqual([39, 1]);
    expect(r.warnings).toEqual(['這幾張照片好像不是同一張收據，請確認金額和品項']);
    expect(mergeReadings([a, { ...a, date: '2026-10-06' }], mctx).raw.sameReceipt).toBe(false);
    // Only the second shows a total: its fields.
    expect(mergeReadings([{ ...a, total: 0 }, b], mctx).raw.merchant).toBe('7-ELEVEN');
  });

  it('a photo whose call failed is left out and named; no overlap is looked for across it', () => {
    const { raw, notes } = mergeReadings([reading({ items: [line('A', 1), line('B', 2)] }), null, reading({ items: [line('B', 2), line('C', 3)], total: 6 })], mctx);
    expect(notes.unread).toEqual([2]);
    expect(raw.items).toEqual([line('A', 1), line('B', 2), line('B', 2), line('C', 3)]);
    const r = normalizeReceipt(raw, { hint: 'JPY', locale: 'en', today: TODAY, photos: 3, merged: notes });
    expect(r.warnings[0]).toBe('Photo 2 could not be read, so it was left out');
    expect(mergeReadings([null, null], mctx)).toEqual({ raw: {}, notes: { overlapDropped: 0, totalsDiffer: null, unread: [1, 2] } });
  });
});

describe('normalizeReceipt with two or three photos', () => {
  const multi = (photos: number, locale: 'zh-TW' | 'en' = 'zh-TW'): NormalizeContext => ({ hint: 'JPY', locale, today: TODAY, photos });

  it('the overlap safety net drops the second copy of a repeated block only when that makes the lines fit a printed total', () => {
    const items = [line('A', 100), line('B', 200), line('C', 300), line('B', 200), line('C', 300), line('D', 400)];
    const fits = normalizeReceipt(reading({ items, total: 1000 }), multi(2, 'en'));
    expect(fits.items).toEqual([line('A', 100), line('B', 200), line('C', 300), line('D', 400)]);
    expect(fits.warnings).toEqual(['2 items were on two photos, so they were counted once']);
    // The lines fit with both copies (two really bought): nothing goes.
    const bought = normalizeReceipt(reading({ items, total: 1500 }), multi(2));
    expect([bought.items.length, bought.warnings]).toEqual([6, []]);
    // No printed total: nothing goes, and the lines' sum is the total, as with one photo.
    const none = normalizeReceipt(reading({ items }), multi(2, 'en'));
    expect([none.items.length, none.total, none.totalFound]).toEqual([6, 1500, false]);
    expect(none.warnings).toEqual(['No total was found, so ¥1,500 from the items was used. Check it']);
    // One photo: never.
    const one = normalizeReceipt(reading({ items, total: 1000 }), { ...multi(1), photos: 1 });
    expect(one.items).toHaveLength(6);
    // Three photos: up to two blocks, one per boundary.
    const twice = [line('A', 100), line('B', 200), line('B', 200), line('C', 300), line('D', 400), line('D', 400)];
    expect(normalizeReceipt(reading({ items: twice, total: 1000 }), multi(3)).items).toEqual([line('A', 100), line('B', 200), line('C', 300), line('D', 400)]);
    expect(normalizeReceipt(reading({ items: twice, total: 1000 }), multi(2)).items).toHaveLength(6);
  });

  it('lines that still do not fit: a line counted twice, lines missing, or either, in both languages', () => {
    const twice = reading({ items: [line('生ビール', 500), line('枝豆', 300), line('唐揚げ', 200), line('生ビール', 500)], total: 1000 });
    expect(normalizeReceipt(twice, multi(2)).warnings).toEqual(['品項加起來比總額多 ¥500，剛好是「生ビール」的金額，可能在兩張照片重疊的地方算了兩次']);
    expect(normalizeReceipt(twice, multi(2, 'en')).warnings).toEqual(['The items come to ¥500 more than the total, the price of "生ビール". It may be counted twice where two photos overlap']);
    const missing = reading({ items: [line('A', 500)], total: 800 });
    expect(normalizeReceipt(missing, multi(3)).warnings).toEqual(['品項加起來比總額少 ¥300，照片之間可能漏了幾行']);
    expect(normalizeReceipt(missing, multi(3, 'en')).warnings).toEqual(['The items come to ¥300 less than the total. Some lines may be missing between the photos']);
    const either = reading({ items: [line('A', 500), line('B', 300)], total: 600 });
    expect(normalizeReceipt(either, multi(2)).warnings).toEqual(['品項加起來是 ¥800，跟總額 ¥600 對不起來，可能是照片重疊的地方多算或漏了品項，請再看一下']);
    expect(normalizeReceipt(either, multi(2, 'en')).warnings).toEqual(['The items add up to ¥800, which does not fit the total of ¥600. Lines where the photos overlap may be counted twice or missed. Check them']);
    // With one photo it is today's note.
    expect(normalizeReceipt(either, { ...multi(1) }).warnings).toEqual(['品項加起來是 ¥800，跟總額 ¥600 對不起來，請再看一下']);
    // The tip and a discount on the whole bill are taken into account; the tax as printed.
    const tipped = reading({ items: [line('A', 500), line('B', 300)], tip: 100, total: 600 });
    expect(normalizeReceipt(tipped, multi(2, 'en')).warnings).toEqual(['The items come to ¥300 more than the total, the price of "B". It may be counted twice where two photos overlap']);
  });

  it('today\'s two tax notes keep their place before the photo notes', () => {
    const r = normalizeReceipt({ ...IZAKAYA, total: 12580 }, { ...zh, photos: 2 });
    expect(r.warnings).toEqual(['總額 ¥12,580 好像沒有加上稅 ¥1,258，請核對']);
  });

  it('sameReceipt false adds notSameReceipt, in both languages', () => {
    expect(normalizeReceipt({ ...IZAKAYA, sameReceipt: false }, { ...zh, photos: 2 }).warnings).toEqual(['這幾張照片好像不是同一張收據，請確認金額和品項']);
    expect(normalizeReceipt({ ...IZAKAYA, sameReceipt: false }, { ...en, photos: 2 }).warnings).toEqual(['These photos may not all be from the same receipt. Check the amount and the items']);
    expect(normalizeReceipt({ ...IZAKAYA, sameReceipt: true }, { ...zh, photos: 2 }).warnings).toEqual([]);
  });

  it('notAllRead, and totalFound only where the route asks for it (one photo gives what it always gave)', () => {
    expect(normalizeReceipt(IZAKAYA, { ...en, photos: 3, notAllRead: true }).warnings).toEqual(['Not every photo seems to have been read. Check the amount and the items']);
    expect(normalizeReceipt(IZAKAYA, { ...zh, photos: 3, notAllRead: true }).warnings).toEqual(['這次好像沒有讀到每一張照片，請核對金額和品項']);
    expect(normalizeReceipt(IZAKAYA, zh)).not.toHaveProperty('totalFound');
    expect(normalizeReceipt(IZAKAYA, { ...zh, photos: 1 })).toEqual({ ...normalizeReceipt(IZAKAYA, zh), totalFound: true });
    expect(normalizeReceipt({ ...IZAKAYA, total: 0 }, { ...zh, photos: 1 }).totalFound).toBe(false);
  });
});

// ---------- the route with two or three photos ----------

describe('POST /api/receipts/scan with images', () => {
  const imgs = [PHOTO(1), PHOTO(2), PHOTO(3)];
  const prod = { ENVIRONMENT: 'production' };
  const qwenJoint = '?model=' + encodeURIComponent(QWEN) + '&joint=1';
  const qwenSplit = '?model=' + encodeURIComponent(QWEN) + '&joint=0';
  const count = (key: string) => db.rows<{ count: number }>('SELECT count FROM rate_limits WHERE key = ?', key)[0]?.count ?? null;
  const photosOf = (inputs: Record<string, unknown>) => ((inputs.messages as any[])[1].content as any[]).filter(p => p.type === 'image_url').map(p => p.image_url.url);

  beforeEach(async () => {
    db = new TestD1();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    addUser('ann', 'ann@evenly.test');
    addUser('owner', OWNER);
    for (const id of ['ann', 'owner']) tokens[id] = await createSession(db.d1, id, 'test');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exactly one of image and images, 1 to 3 photos, each a data URL of at least 200 characters: 400 validation before anything is counted', async () => {
    const cases: [unknown, (string | number)[]][] = [
      [{ currency: 'TWD' }, ['image']],
      [{ image: IMAGE, images: [IMAGE] }, ['image']],
      [{ images: [] }, ['images']],
      [{ images: [IMAGE, IMAGE, IMAGE, IMAGE] }, ['images']],
      [{ images: [IMAGE, 'data:text/plain;base64,' + 'A'.repeat(400)] }, ['images', 1]],
      [{ images: [IMAGE, 'data:image/jpeg;base64,AAAA'] }, ['images', 1]],
      [{ images: 'one' }, ['images']],
    ];
    for (const [body, path] of cases) {
      const r = await scan('ann', { body });
      expect([JSON.stringify(body).slice(0, 50), r.status, r.data.error.code, r.data.error.details[0].path]).toEqual([JSON.stringify(body).slice(0, 50), 400, 'validation', path]);
      expect(r.run).not.toHaveBeenCalled();
    }
    expect((await scan('ann', { body: { currency: 'TWD' } })).data.error.details[0].message).toBe('Send image or images');
    expect(db.rows('SELECT key FROM rate_limits')).toEqual([]);
  });

  it('every photo, the one image too, has a size its header says, at most 2,000 px on the longest side', async () => {
    const big = dataUrl(jpegOfSize(2001, 1000));
    const most = dataUrl(jpegOfSize(2000, 2000));
    const message = 'Send each photo as a JPEG, PNG or WebP of at most 2000 px on its longest side';
    const one = await scan('ann', { body: { image: big } });
    expect([one.status, one.data.error.details]).toEqual([400, [{ path: ['image'], message }]]);
    const several = await scan('ann', { body: { images: [most, dataUrl(jpegOfSize(100, 2001))] } });
    expect([several.status, several.data.error.details]).toEqual([400, [{ path: ['images', 1], message }]]);
    const unreadable = await scan('ann', { body: { image: 'data:image/jpeg;base64,' + '/9j/4AAQSkZJRg'.repeat(40) } });
    expect([unreadable.status, unreadable.data.error.details[0].path]).toEqual([400, ['image']]);
    expect(db.rows('SELECT key FROM rate_limits')).toEqual([]);
    expect((await scan('ann', { body: { image: most } })).status).toBe(200);
    expect((await scan('ann', { body: { images: [most, most] }, run: async () => gemmaAnswer({ ...IZAKAYA, sameReceipt: true }) })).status).toBe(200);
    // PNG and WebP photos of the right size pass too.
    expect((await scan('ann', { body: { images: [dataUrl(pngOfSize(1200, 1600), 'image/png'), dataUrl(webpOf('VP8X', 1200, 1600), 'image/webp')] } })).status).toBe(200);
  });

  it('three photos of 1,000,000 characters each fit the 3 MiB body', async () => {
    const photo = dataUrl(Buffer.concat([jpegOfSize(1200, 1600), Buffer.alloc(749_000)]));
    expect(photo.length).toBeGreaterThan(999_000);
    expect(photo.length).toBeLessThanOrEqual(1_000_000);
    expect((await scan('ann', { body: { images: [photo, photo, photo], currency: 'JPY' } })).status).toBe(200);
  });

  it('one call with every photo: one ai.run with the three in order, 1,626 set aside during it, corrected after, 3 taken from both counts', async () => {
    let during: number | null = null;
    const r = await scan('owner', {
      query: qwenJoint, env: prod, body: { images: imgs, currency: 'JPY', locale: 'en' },
      run: async (_m, inputs) => {
        during = neurons();
        expect(photosOf(inputs)).toEqual(imgs);
        expect(inputs.max_tokens).toBe(3000);
        return gemmaAnswer({ ...reading({ merchant: 'イオン 札幌桑園店', date: '2026-10-14', items: AEON_LINES, tax: 379, total: 4809 }), sameReceipt: true }, { prompt_tokens: 7240, completion_tokens: 870 });
      },
    });
    expect(r.status).toBe(200);
    expect(r.run).toHaveBeenCalledTimes(1);
    expect(during).toBe(1626);
    expect(neurons()).toBe(Math.ceil(neuronsFor(QWEN, 7240, 870)));
    expect(count(`receipt:user:owner:${todayUTC()}`)).toBe(3);
    expect(count(`receipt:app:${todayUTC()}`)).toBe(3);
    expect(r.data).toMatchObject({ total: 4809, tax: 379, totalFound: true, warnings: [] });
    expect(r.data.usage).toEqual({ model: QWEN, promptTokens: 7240, completionTokens: 870, neurons: neuronsFor(QWEN, 7240, 870), photos: 3, calls: 1 });
  });

  it('one call with every photo: refused with 429 ai once the day\'s count passes 6,374, while one photo still fits; 429 user when 28 + 3 passes 30, writing nothing', async () => {
    setNeurons(6375);
    const r = await scan('owner', { query: qwenJoint, env: prod, body: { images: imgs } });
    expect([r.status, r.data.error.details.scope]).toEqual([429, 'ai']);
    expect(Number(r.headers.get('Retry-After'))).toBe(r.data.error.details.retryAfter);
    expect(r.run).not.toHaveBeenCalled();
    expect(neurons()).toBe(6375);
    const one = await scan('owner', { query: '?model=' + encodeURIComponent(QWEN), env: prod, body: { image: IMAGE } });
    expect(one.status).toBe(200);
    setNeurons(6374);
    expect((await scan('owner', { query: qwenJoint, env: prod, body: { images: imgs }, run: async () => gemmaAnswer({ ...IZAKAYA, sameReceipt: true }) })).status).toBe(200);

    db.exec('INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)', `receipt:user:ann:${todayUTC()}`, 28, Date.now() + 86_400_000);
    const app = count(`receipt:app:${todayUTC()}`);
    const user = await scan('ann', { body: { images: imgs }, env: prod });
    expect([user.status, user.data.error.details.scope]).toEqual([429, 'user']);
    expect(count(`receipt:user:ann:${todayUTC()}`)).toBe(28);
    expect(count(`receipt:app:${todayUTC()}`)).toBe(app);
    // Two photos still fit.
    expect((await scan('ann', { body: { images: imgs.slice(0, 2) }, env: prod })).status).toBe(200);
    expect(count(`receipt:user:ann:${todayUTC()}`)).toBe(30);
  });

  it('one call with every photo that fails or runs out of time keeps its 1,626; it waits 85 s, not 55', async () => {
    const failed = await scan('owner', { query: qwenJoint, env: prod, body: { images: imgs }, run: async () => { throw new Error('AiError: 3040: Out of capacity'); } });
    expect([failed.status, failed.data.error.details.reason]).toEqual([502, 'model']);
    expect(neurons()).toBe(1626);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let done = false;
    let asked = 0;
    const slow = scan('owner', {
      query: qwenJoint, env: prod, body: { images: imgs },
      run: () => {
        asked++;
        return new Promise(() => undefined);
      },
    }).then(r => {
      done = true;
      return r;
    });
    // The model was asked, so the Worker's own timer runs (the session check before it is real work).
    while (!asked) await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(25_000);
    const r = await slow;
    expect([r.status, r.data.error.details.reason]).toEqual([502, 'timeout']);
    expect(neurons()).toBe(2 * 1626);
  });

  it('one call per photo: three calls at once, one reservation of 2,292, one correction for their sum', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: number[] = [];
    const usage = [{ prompt_tokens: 2700, completion_tokens: 300 }, { prompt_tokens: 2600, completion_tokens: 260 }, { prompt_tokens: 2650, completion_tokens: 280 }];
    const pending = scan('owner', {
      query: qwenSplit, env: prod, body: { images: imgs, currency: 'JPY', locale: 'en' },
      run: async (_m, inputs) => {
        const i = imgs.indexOf(photosOf(inputs)[0]);
        expect(photosOf(inputs)).toHaveLength(1);
        expect((inputs.messages as any[])[1].content[1].text).toBe(`Today is ${todayUTC()}. Currency hint: JPY. This is photo ${i + 1} of 3 of one receipt, so it may show only some of its lines.`);
        expect(inputs.max_tokens).toBe(1500);
        seen.push(neurons()!);
        await gate;
        return gemmaAnswer(AEON_PARTS[i], usage[i]);
      },
    });
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen).toEqual([2292, 2292, 2292]);
    release();
    const r = await pending;
    expect(r.status).toBe(200);
    const spent = usage.reduce((s, u) => s + receiptNeuronsSpent(QWEN, u.prompt_tokens, u.completion_tokens), 0);
    expect(neurons()).toBe(spent);
    expect(db.log.filter(sql => /UPDATE rate_limits SET count = count \+/.test(sql))).toHaveLength(1);
    expect(r.data.items).toEqual(AEON_LINES);
    expect(r.data).toMatchObject({ merchant: 'イオン 札幌桑園店', total: 4809, totalFound: true, warnings: ['4 items were on two photos, so they were counted once'] });
    expect(r.data.usage).toEqual({
      model: QWEN, promptTokens: 7950, completionTokens: 840, photos: 3, calls: 3,
      neurons: Math.round(usage.reduce((s, u) => s + neuronsFor(QWEN, u.prompt_tokens, u.completion_tokens), 0) * 1e3) / 1e3,
    });
  });

  it('one call per photo: a failed call counts its worst case and its photo is named; all failed is 502, timeout when any timed out', async () => {
    const r = await scan('owner', {
      query: qwenSplit, env: prod, body: { images: imgs, locale: 'en' },
      run: async (_m, inputs) => {
        const i = imgs.indexOf(photosOf(inputs)[0]);
        if (i === 1) throw new Error('AiError: 3040: Out of capacity');
        return gemmaAnswer(AEON_PARTS[i], { prompt_tokens: 2700, completion_tokens: 300 });
      },
    });
    expect(r.status).toBe(200);
    expect(r.data.warnings[0]).toBe('Photo 2 could not be read, so it was left out');
    expect(neurons()).toBe(2 * receiptNeuronsSpent(QWEN, 2700, 300) + 764);
    expect(r.data.usage).toMatchObject({ photos: 3, calls: 3, promptTokens: 5400 });

    setNeurons(0);
    const all = await scan('owner', { query: qwenSplit, env: prod, body: { images: imgs }, run: async () => { throw new Error('boom'); } });
    expect([all.status, all.data.error.details.reason]).toEqual([502, 'model']);
    expect(neurons()).toBe(2292);

    setNeurons(0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let asked = 0;
    const slow = scan('owner', {
      query: qwenSplit, env: prod, body: { images: imgs },
      run: async (_m, inputs) => {
        asked++;
        if (imgs.indexOf(photosOf(inputs)[0]) === 0) return new Promise(() => undefined);
        throw new Error('boom');
      },
    });
    while (asked < 3) await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(54_000);
    expect(asked).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    const timed = await slow;
    expect([timed.status, timed.data.error.details.reason]).toEqual([502, 'timeout']);
    expect(neurons()).toBe(2292);
  });

  it('which path: RECEIPT_JOINT unset reads one call per photo; "on" one call for a model in RECEIPT_JOINT_MODELS, not for another', async () => {
    const answer = async () => gemmaAnswer({ ...IZAKAYA, sameReceipt: true });
    const calls = async (env: Record<string, unknown>) => (await scan('ann', { body: { images: imgs }, env: { RECEIPT_NEURONS_PER_DAY: '5000', ...env }, run: answer })).run.mock.calls.length;
    expect(await calls({})).toBe(3);
    expect(await calls({ RECEIPT_JOINT: 'on' })).toBe(1);
    expect(await calls({ RECEIPT_JOINT: ' ON ' })).toBe(1);
    expect(await calls({ RECEIPT_JOINT: 'off' })).toBe(3);
    expect(await calls({ RECEIPT_JOINT: 'on', RECEIPT_MODEL: LLAMA, RECEIPT_NEURONS_PER_DAY: '2000' })).toBe(3);
    expect(readsJointly({ RECEIPT_JOINT: 'on' }, QWEN, 3, null)).toBe(true);
    expect(readsJointly({ RECEIPT_JOINT: 'on' }, QWEN, 1, true)).toBe(false);
    expect(readsJointly({}, LLAMA, 2, true)).toBe(true);
    expect(readsJointly({ RECEIPT_JOINT: 'on' }, DEFAULT_RECEIPT_MODEL, 2, false)).toBe(false);
  });

  it('?joint= is the owner\'s only (403 otherwise), 0 or 1 (400 otherwise), checked before anything is counted, and does nothing for one photo', async () => {
    const r = await scan('ann', { query: '?joint=1', body: { images: imgs } });
    expect([r.status, r.data.error.code]).toEqual([403, 'forbidden']);
    for (const v of ['2', 'yes', '']) {
      const bad = await scan('owner', { query: '?joint=' + v, body: { images: imgs } });
      expect([v, bad.status, bad.data.error.details[0].path]).toEqual([v, 400, ['joint']]);
    }
    expect(db.rows('SELECT key FROM rate_limits')).toEqual([]);
    const one = await scan('owner', { query: '?joint=1', body: { image: IMAGE } });
    expect(one.status).toBe(200);
    expect(one.data.usage).toMatchObject({ photos: 1, calls: 1 });
    expect(one.run.mock.calls[0][1]).toEqual(requestBefore(DEFAULT_RECEIPT_MODEL, IMAGE, { today: todayUTC(), hint: null }));
    expect((await scan('owner', { query: '?joint=0', body: { images: imgs }, env: { RECEIPT_JOINT: 'on' } })).run).toHaveBeenCalledTimes(3);
  });

  it('the guard: one Qwen call whose prompt tokens are under the floor gets notAllRead and a log line without the photos; above it, nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const low = await scan('owner', {
      query: qwenJoint, env: prod, body: { images: imgs, locale: 'en' },
      run: async () => gemmaAnswer({ ...IZAKAYA, sameReceipt: true }, { prompt_tokens: 2700, completion_tokens: 400 }),
    });
    expect(low.data.warnings).toEqual(['Not every photo seems to have been read. Check the amount and the items']);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toBe(`receipt scan: ${QWEN} read 3 photos in one call with 2700 prompt tokens, under the floor of 5313`);
    expect(logged).not.toContain('base64');
    warn.mockClear();
    const full = await scan('owner', {
      query: qwenJoint, env: prod, body: { images: imgs, locale: 'en' },
      run: async () => gemmaAnswer({ ...IZAKAYA, sameReceipt: true }, { prompt_tokens: 7240, completion_tokens: 400 }),
    });
    expect(full.data.warnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    // Gemma's photo tokens do not grow with the size: no guard.
    setNeurons(0);
    const gemma = await scan('owner', { query: '?joint=1', body: { images: imgs }, run: async () => gemmaAnswer({ ...IZAKAYA, sameReceipt: true }, { prompt_tokens: 1700, completion_tokens: 400 }) });
    expect(gemma.data.warnings).toEqual([]);
  });

  it('nothing read on any photo: 502 unreadable, after the neurons are counted', async () => {
    const r = await scan('ann', { body: { images: imgs }, run: async () => gemmaAnswer(reading({ currency: '' })) });
    expect([r.status, r.data.error.details.reason]).toEqual([502, 'unreadable']);
    expect(neurons()).toBe(3 * receiptNeuronsSpent(DEFAULT_RECEIPT_MODEL, 2000, 500));
  });

  it('the calls and the correction of the day\'s neurons run inside waitUntil, so a client that goes away mid-call does not stop them (review I2)', async () => {
    const kept: Promise<unknown>[] = [];
    for (const body of [{ image: IMAGE }, { images: imgs }]) {
      const r = await scan('ann', { body, waitUntil: p => kept.push(p) });
      expect(r.status).toBe(200);
    }
    expect(kept).toHaveLength(2);
    await Promise.all(kept);
    // Corrected to what they really took: one call, then three.
    expect(neurons()).toBe(4 * receiptNeuronsSpent(DEFAULT_RECEIPT_MODEL, 2000, 500));
    // A scan that fails still hands its work over, and its rejection is caught there.
    const failed = await scan('ann', { body: { image: IMAGE }, waitUntil: p => kept.push(p), run: async () => { throw new Error('boom'); } });
    expect(failed.status).toBe(502);
    await expect(kept[2]).resolves.toBeUndefined();
  });
});

describe('mergeReadings, after the review (C4, C7, C8)', () => {
  const tomorrow = '2026-10-18';
  const parts = (top: Record<string, unknown>, middle: Record<string, unknown>, bottom: Record<string, unknown>) => [
    reading({ merchant: 'Target', currency: 'USD', items: [line('Milk', 3.49), line('Eggs', 4.99)], ...top }),
    reading({ currency: 'USD', items: [line('Eggs', 4.99), line('Bread', 2.5)], ...middle }),
    reading({ currency: 'USD', items: [line('Bread', 2.5), line('Apples', 5.79)], tax: 0, total: 16.77, ...bottom }),
  ];

  it('C4: the date printed at the bottom wins over today, which the model filled in on the parts that print none', () => {
    const { raw } = mergeReadings(parts({ date: TODAY }, { date: TODAY }, { date: '2026-10-15' }), mctx);
    expect([raw.date, raw.sameReceipt]).toEqual(['2026-10-15', true]);
    expect(mergeReadings(parts({ date: '' }, { date: TODAY }, { date: '10/15/2026' }), mctx).raw.date).toBe('10/15/2026');
    // The bottom names the store too (a footer): the store's two dates are one printed date and today, so one receipt.
    const footer = mergeReadings(parts({ date: TODAY }, {}, { merchant: 'TARGET', date: '2026-10-15' }), mctx);
    expect([footer.raw.sameReceipt, footer.raw.date, (footer.raw.items as unknown[]).length]).toEqual([true, '2026-10-15', 4]);
    // Every part says today (a receipt from today): today.
    expect(mergeReadings(parts({ date: TODAY }, { date: TODAY }, { date: TODAY }), mctx).raw.date).toBe(TODAY);
    // Two printed dates on photos that name the store are still two receipts.
    expect(mergeReadings(parts({ date: '2026-10-14' }, {}, { merchant: 'Target', date: '2026-10-15' }), mctx).raw.sameReceipt).toBe(false);
    // The top prints the date; the bottom has the total, a footer with the store and today from
    // the model: one receipt, from the printed date.
    const top = mergeReadings(parts({ date: '2026-10-15' }, {}, { merchant: 'TARGET', date: TODAY }), mctx);
    expect([top.raw.sameReceipt, top.raw.date, (top.raw.items as unknown[]).length]).toEqual([true, '2026-10-15', 4]);
  });

  it('C4 (fix check): a receipt printed today or tomorrow with its own total is a real date, so two receipts from one store on two days stay apart', () => {
    const a = (date: string) => reading({ merchant: 'Target', date, currency: 'USD', items: [line('Desk', 200), line('Lamp', 40)], total: 240 });
    const b = reading({ merchant: 'Target', date: '2026-10-12', currency: 'USD', items: [line('Chair', 120)], total: 120 });
    for (const date of [TODAY, tomorrow]) {
      for (const order of [[a(date), b], [b, a(date)]]) {
        const { raw } = mergeReadings(order, { hint: 'USD', today: TODAY });
        const first = order[0];
        expect([date, raw.sameReceipt, raw.total, raw.date, (raw.items as unknown[]).length]).toEqual([date, false, first.total, first.date, first.items.length]);
        const r = normalizeReceipt(raw, { hint: 'USD', locale: 'en', today: TODAY, photos: 2 });
        expect(r.warnings).toContain('These photos may not all be from the same receipt. Check the amount and the items');
      }
    }
  });

  it('C4 (fix check): in Taiwan\'s early hours a receipt prints UTC tomorrow, a real date, which wins over the UTC today the model wrote on the parts', () => {
    const { raw } = mergeReadings(parts({ date: TODAY }, { date: TODAY }, { date: tomorrow }), mctx);
    expect([raw.date, raw.sameReceipt]).toEqual([tomorrow, true]);
    // With a footer that names the store: still one receipt, every line.
    const footer = mergeReadings(parts({ date: TODAY }, {}, { merchant: 'TARGET', date: tomorrow }), mctx);
    expect([footer.raw.sameReceipt, footer.raw.date, (footer.raw.items as unknown[]).length]).toEqual([true, tomorrow, 4]);
    // The AEON replay at that hour: the top's printed date stays.
    const aeon = mergeReadings([{ ...AEON_PARTS[0], date: tomorrow }, { ...AEON_PARTS[1], date: TODAY }, { ...AEON_PARTS[2], date: TODAY }], { hint: 'JPY', today: TODAY });
    expect([aeon.raw.date, aeon.raw.sameReceipt]).toEqual([tomorrow, true]);
  });

  it('C7: a card slip that prints the name its own way, or in another script, is the slip of the bill', () => {
    const bill = reading({ merchant: 'The Pink Door', date: '2026-09-27', currency: 'USD', items: PINK_DOOR.items, tax: 8.49, discount: 22, total: 90.49 });
    for (const name of ['PINK DOOR', 'The Pink Door Restaurant', 'the  pink-door', 'ピンクドア']) {
      const slip = reading({ merchant: name, date: '2026-09-27', currency: 'USD', tip: 20, total: 110.49 });
      const { raw } = mergeReadings([bill, slip], { hint: 'USD', today: TODAY });
      expect([name, raw.sameReceipt, raw.total, raw.tip, (raw.items as unknown[]).length]).toEqual([name, true, 110.49, 20, 4]);
    }
    // Another shop with lines of its own, or with a smaller total, is another receipt.
    const other = reading({ merchant: 'Pike Place Chowder', date: '2026-09-27', currency: 'USD', items: [line('Chowder', 9)], total: 9 });
    expect(mergeReadings([bill, other], { hint: 'USD', today: TODAY }).raw.sameReceipt).toBe(false);
    const smaller = reading({ merchant: 'Pike Place Chowder', date: '2026-09-27', currency: 'USD', total: 9 });
    expect(mergeReadings([bill, smaller], { hint: 'USD', today: TODAY }).raw.sameReceipt).toBe(false);
    // Names too short to tell match only themselves.
    expect(mergeReadings([reading({ merchant: 'AB', items: [line('x', 1)], total: 1 }), reading({ merchant: 'ABC', items: [line('y', 2)], total: 2 })], mctx).raw.sameReceipt).toBe(false);
  });

  it('C8: a currency other than the hint counts as read off the receipt, as normalizeReceipt reads one answer', () => {
    const ps = [reading({ currency: 'TWD', currencyGuessed: true, items: [line('おにぎり', 160)] }), reading({ currency: 'JPY', currencyGuessed: true, items: [line('お茶', 140)], total: 300 })];
    const { raw, notes } = mergeReadings(ps, mctx);
    expect(raw).toMatchObject({ currency: 'JPY', currencyGuessed: true });
    const r = normalizeReceipt(raw, { hint: 'TWD', locale: 'en', today: TODAY, photos: 2, merged: notes });
    expect([r.currency, r.total, r.warnings]).toEqual(['JPY', 300, []]);
    // Every photo the hint, guessed: still a guess.
    const guesses = mergeReadings([reading({ currency: 'TWD', currencyGuessed: true }), reading({ currency: 'TWD', currencyGuessed: true, total: 300 })], mctx);
    expect(normalizeReceipt(guesses.raw, { hint: 'TWD', locale: 'en', today: TODAY, photos: 2, merged: guesses.notes }).currency).toBeNull();
  });
});

describe('the overlap safety net on a degenerate answer (review C9)', () => {
  it('200 identical lines over three photos with a total they do not fit: tried by kind, not by every pair, and quickly', () => {
    const items = Array.from({ length: 200 }, () => line('Beer', 100));
    const t0 = performance.now();
    const r = normalizeReceipt(reading({ items, total: 1000 }), { hint: 'JPY', locale: 'en', today: TODAY, photos: 3 });
    const ms = performance.now() - t0;
    expect(r.items).toHaveLength(50);
    expect(ms).toBeLessThan(150);
    // A block repeated twice across three photos still goes when that makes the lines fit.
    const two = [line('A', 100), line('B', 200), line('B', 200), line('B', 200), line('C', 300)];
    expect(normalizeReceipt(reading({ items: two, total: 600 }), { hint: 'JPY', locale: 'en', today: TODAY, photos: 3 }).items).toEqual([line('A', 100), line('B', 200), line('C', 300)]);
  });
});
