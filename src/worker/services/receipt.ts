// Reading receipt photos for POST /api/receipts/scan (docs/PLAN-push-scan-cookies.md section 3.1):
// the prompt and JSON schema sent to Workers AI, the request for each model family, reading the
// answer in every shape the models give it, and normalizeReceipt, which turns what a model said
// into a ReceiptScanDTO the editor can use as is (Western calendar dates, known currency codes,
// whole numbers for currencies without decimals, no subtotal, tax or payment lines among the items).
//
// Everything except runReceiptModel is pure, so tests/worker/receipt.test.ts runs it in Node.
// Neither the photo nor the receipt's text is ever logged.

import { CATEGORIES, detectCategory, isCategoryKey } from '../../shared/categories';
import { currencyDecimals, getCurrency, isKnownCurrency } from '../../shared/currencies';
import { addDays, isISODate, todayUTC } from '../../shared/dates';
import { formatMoney, MAX_AMOUNT, parseAmount, pow10 } from '../../shared/money';
import type { Locale, ReceiptScanDTO } from '../../shared/types';
import { fail } from '../http';

// ---------- models ----------

export const DEFAULT_RECEIPT_MODEL = '@cf/google/gemma-4-26b-a4b-it';

/** The models ?model= may pick (the owner only, in every environment), to compare them. */
export const RECEIPT_MODELS: readonly string[] = [
  DEFAULT_RECEIPT_MODEL,
  '@cf/qwen/qwen3.8-27b',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
];

/** Neurons per million input and output tokens (Workers AI pricing page, checked 2026-10-17 and 2026-10-29). */
const NEURON_RATES: Record<string, readonly [number, number]> = {
  '@cf/google/gemma-4-26b-a4b-it': [9_091, 27_273],
  '@cf/qwen/qwen3.8-27b': [40_909, 290_909],
  '@cf/meta/llama-4-scout-17b-16e-instruct': [24_545, 77_273],
};

/** The rates of a model NEURON_RATES lacks (RECEIPT_MODEL may name any model): the dearest known
 *  input and output rates, so it never counts as free. Add a new model's own rates above. */
const DEAREST_RATES: readonly [number, number] = [
  Math.max(...Object.values(NEURON_RATES).map(r => r[0])),
  Math.max(...Object.values(NEURON_RATES).map(r => r[1])),
];

/** Enough for about 60 receipt lines; it also caps the cost of a model that starts repeating itself. */
export const RECEIPT_MAX_TOKENS = 1500;

/**
 * The input tokens (the prompt, the hint and the photo) a scan is counted at before its call
 * (receiptWorstCase). Measured per request in the account's Workers AI analytics, 2026-10-17 to
 * 2026-10-29, with this prompt: Gemma 4 took 1,620 to 1,626 for photos of 1000 x 1400 and 736 x 1600
 * alike (its photo costs the same at any size), Llama 4 Scout 3,587 for both, and Qwen 3.8 2,705 and
 * 2,490: about one token per 1,000 pixels on top of about 1,350 for the prompt, so about 3,850 for
 * the largest photo the app sends (1600 x 1600). 8,000 is twice that. A larger photo, which only a
 * hand-made client sends, is counted at what it really took once the call is back.
 */
export const RECEIPT_INPUT_TOKENS_MAX = 8_000;

/** The Worker stops waiting for the model after this long (the app gives up at 60 s). Gemma 4 usually answers in 2 to 16 s, but took 38 s once on staging (2026-10-17). */
export const RECEIPT_TIMEOUT_MS = 55_000;

const MAX_ITEMS = 50;
const ITEM_NAME_MAX = 60;
const MERCHANT_MAX = 120;

const hasRates = (model: string): boolean => Object.hasOwn(NEURON_RATES, model);

/**
 * What one call cost, from the token counts the model reports (a model without known rates at the
 * dearest known ones). Cloudflare's own count was the same, or lower when part of the prompt was
 * cached (analytics, 2026-10-17 to 2026-10-29), so a count made with it is never behind the bill.
 */
export function neuronsFor(model: string, promptTokens: number, completionTokens: number): number {
  const r = hasRates(model) ? NEURON_RATES[model] : DEAREST_RATES;
  return Math.round((promptTokens * r[0] + completionTokens * r[1]) / 1e3) / 1e3;
}

/**
 * The most one scan with `model` can cost, in whole neurons (rounded up): RECEIPT_INPUT_TOKENS_MAX
 * in and RECEIPT_MAX_TOKENS out at its rates (the dearest known ones for a model without rates).
 * The route sets this much aside from the day's budget before the call.
 */
export function receiptWorstCase(model: string): number {
  return Math.ceil(neuronsFor(model, RECEIPT_INPUT_TOKENS_MAX, RECEIPT_MAX_TOKENS));
}

/**
 * What a scan whose call came back counts against the day's budget, in whole neurons (rounded up,
 * so the count is never behind what Cloudflare bills): its neurons from the token counts, but its
 * worst case for a model without known rates or an answer that left out a token count (an answer
 * with a receipt in it always took both), never 0.
 */
export function receiptNeuronsSpent(model: string, promptTokens: number, completionTokens: number): number {
  if (!hasRates(model) || promptTokens <= 0 || completionTokens <= 0) return receiptWorstCase(model);
  return Math.ceil(neuronsFor(model, promptTokens, completionTokens));
}

/** Seconds until 00:00 UTC, when the daily windows (ours and Workers AI's free allowance) start again. */
export function secondsToNextUtcDay(now = Date.now()): number {
  const next = Date.parse(addDays(todayUTC(new Date(now)), 1) + 'T00:00:00Z');
  return Math.max(1, Math.ceil((next - now) / 1000));
}

// ---------- the prompt and the schema ----------

/**
 * The JSON the model fills in. Unknown values are "" and 0 rather than null, which every schema
 * engine and model handles. The fields follow the receipt from top to bottom (the lines, then tax
 * and tip, then the total), so the model reads the total after the lines it covers.
 */
export const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    merchant: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD' },
    currency: { type: 'string', description: 'ISO 4217 code' },
    currencyGuessed: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, amount: { type: 'number' } },
        required: ['name', 'amount'],
        additionalProperties: false,
      },
    },
    tax: { type: 'number' },
    taxIncluded: { type: 'boolean' },
    tip: { type: 'number' },
    discount: { type: 'number' },
    total: { type: 'number' },
    category: { type: 'string' },
  },
  required: ['merchant', 'date', 'currency', 'currencyGuessed', 'items', 'tax', 'taxIncluded', 'tip', 'discount', 'total', 'category'],
  additionalProperties: false,
} as const;

const CATEGORY_KEYS = CATEGORIES.filter(c => c.key !== 'payment').map(c => c.key).join(', ');

export const RECEIPT_SYSTEM_PROMPT = [
  'You read a photo of a receipt from a shop or restaurant and fill in the JSON fields. Use only what is printed or handwritten on it; never make anything up.',
  '',
  'merchant: the shop or restaurant name, with the branch if printed, as written (for example "ローソン 札幌駅前店", "鼎泰豐 信義店", "The Pink Door"). Leave out the address, phone and register numbers, and words such as 領収証, 領收據, 收據, 電子發票證明聯 or Receipt. "" if there is none.',
  '',
  'date: the day of the purchase as YYYY-MM-DD in the Western calendar. Convert era years: 令和N年 is 2018+N (令和8年 is 2026), 平成N年 is 1988+N, and a Taiwan year (民國N年, or three digits such as 115年 or 115/10/05) is 1911+N (115 is 2026). On a Taiwan e-invoice (電子發票證明聯) take the date printed with the time, not the two-month period such as 115年09-10月. 09/27/2026 on a US receipt is September 27. When no year is printed, use the year of today. "" if there is no date.',
  '',
  'currency: the ISO 4217 code. NT$, 元 on a Taiwan receipt, and any Taiwan invoice are TWD. ¥ or 円 on a Japanese receipt is JPY; ¥ or 元 on a mainland China receipt is CNY. A plain $ belongs to the receipt\'s country (Taiwan TWD, Hong Kong HKD, Singapore SGD, Canada CAD, Australia AUD, United States USD). Only when the receipt shows neither the currency nor the country, use the hint and set currencyGuessed to true; otherwise currencyGuessed is false.',
  '',
  'items: each purchased line, in printed order, as {name, amount}. amount is the price of the whole line (quantity times unit price) after any discount printed right under that line. Keep a quantity in the name, such as "生ビール ×6", and leave out marks such as * or ※ that flag the tax rate. On a Taiwan e-invoice the lines are under 交易明細, and a TX after a price only marks it as taxed. Never list subtotals (小計, Subtotal, Food & Bev), totals (合計, 總計, Total), tax lines (消費税, 外税, 内税, (8%対象 ¥974), 稅額, Sales Tax), service charge or tip, a discount on the whole bill, payments (現金, クレジット, 信用卡, 悠遊卡, WAON, Suica, VISA), cash handed over, change, points, or lines without a price. [] if there are none.',
  '',
  'tax: the tax amount printed; add up several tax lines (外税8% and 外税10%). Also the included tax printed as 内税 or 内消費税等. 0 if no tax amount is printed (Taiwan prices include tax and usually print none).',
  'taxIncluded: true when the item prices already include the tax (内税, 税込, Taiwan), false when the tax is added after the subtotal (外税, Sales Tax).',
  'tip: the tip, gratuity or service charge (服務費, サービス料). 0 if none.',
  'discount: a discount on the whole bill, such as "Happy hour disc." after the subtotal, as a positive number. 0 if none.',
  '',
  'total: the final amount paid, with tax, service charge and tip included: 合計, お会計, ご請求額, お買上計, 總計, 合計金額, 應付金額, 實付金額, Total, Amount due, Balance due. When a tip and a new total are written by hand, use the handwritten total. Never the cash handed over (お預り, お預かり, 現金, 收現, Cash, Tendered) or the change (お釣り, 找零, Change). 0 if it cannot be read.',
  '',
  `category: the best fitting key from this list: ${CATEGORY_KEYS}. Restaurants, izakaya and fast food are food.dining. Supermarkets, convenience stores (セブン-イレブン, ローソン, ファミリーマート, 7-ELEVEN, 全家) and grocers are food.groceries. Cafes and drink stands are food.drinks. Use general when nothing fits; never payment.`,
  '',
  'Numbers are plain JSON numbers in the currency\'s main unit, without currency signs or thousands separators: ¥13,838 is 13838, NT$2,222 is 2222, $110.49 is 110.49. Yen, Taiwan dollars and won have no decimals, so in them a comma or a dot between groups of three digits separates thousands (¥1.260 is 1260). Never give a negative number.',
  '',
  'If the photo is not a receipt or cannot be read, give "" and 0 for the fields and [] for items.',
].join('\n');

export interface ReceiptPromptContext {
  /** Today in UTC (YYYY-MM-DD), for receipts that print no year. */
  today: string;
  /** The currency the app sent (the form's when the scan started), for receipts that show
   *  neither currency nor country. */
  hint: string | null;
}

export function receiptUserText(ctx: ReceiptPromptContext): string {
  return `Today is ${ctx.today}. Currency hint: ${ctx.hint ?? 'none'}.`;
}

type Family = 'gemma' | 'qwen' | 'llama';

function familyOf(model: string): Family {
  if (model.includes('/meta/llama')) return 'llama';
  if (model.includes('/qwen/')) return 'qwen';
  return 'gemma';
}

/**
 * The input for env.AI.run. Gemma 4 and Qwen 3.8 take the OpenAI shape (json_schema with a name,
 * thinking off); Llama 4 Scout takes the schema itself under json_schema. The image goes first, as
 * Google recommends for Gemma, and always as a data URL (Llama 4 Scout refuses http links).
 */
export function receiptRequest(model: string, image: string, ctx: ReceiptPromptContext): Record<string, unknown> {
  const family = familyOf(model);
  const req: Record<string, unknown> = {
    messages: [
      { role: 'system', content: RECEIPT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: receiptUserText(ctx) },
        ],
      },
    ],
    max_tokens: RECEIPT_MAX_TOKENS,
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

// ---------- reading the answer ----------

type Loose = Record<string, unknown>;

function isObject(v: unknown): v is Loose {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const tokenCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** JSON from a model's text: as is, inside ``` fences, or the outermost {...} after some prose. */
export function parseJsonText(text: string): Loose | null {
  if (text.length > 200_000) return null;
  let s = text.trim();
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(s);
  if (fenced) s = fenced[1].trim();
  if (!s.startsWith('{')) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    s = s.slice(a, b + 1);
  }
  try {
    const v: unknown = JSON.parse(s);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

export interface ModelAnswer {
  /** The object the model filled in, or null when it gave nothing usable. */
  data: Loose | null;
  promptTokens: number;
  completionTokens: number;
}

/**
 * The receipt object and the token counts from any answer shape: {choices: [{message: {content}}]}
 * (content a string or text parts), {response: string | object} and the REST {result: ...} wrapper.
 */
export function readAnswer(raw: unknown): ModelAnswer {
  const outer = isObject(raw) ? raw : {};
  const r = isObject(outer.result) ? outer.result : outer;
  let payload: unknown;
  if (Array.isArray(r.choices) && r.choices.length) {
    const first = r.choices[0];
    const message = isObject(first) && isObject(first.message) ? first.message : null;
    const content = message?.content;
    payload = Array.isArray(content)
      ? content.map(p => (typeof p === 'string' ? p : isObject(p) && typeof p.text === 'string' ? p.text : '')).join('')
      : content;
  }
  if (payload === undefined || payload === null || payload === '') payload = r.response;
  const data = typeof payload === 'string' ? parseJsonText(payload) : isObject(payload) ? payload : null;
  const usage = isObject(r.usage) ? r.usage : isObject(outer.usage) ? outer.usage : {};
  return {
    data,
    promptTokens: tokenCount(usage.prompt_tokens ?? usage.input_tokens),
    completionTokens: tokenCount(usage.completion_tokens ?? usage.output_tokens),
  };
}

/** What a thrown Workers AI error was: the free daily allowance (3036), or something else (with a
 *  short label for the log: the error code or name, never the message itself). */
export function aiFailure(err: unknown): { quota: boolean; label: string } {
  const e = isObject(err) || err instanceof Error ? (err as { message?: unknown; code?: unknown; name?: unknown }) : {};
  const text = [e.code, e.message, e.name, typeof err === 'string' ? err : '']
    .map(v => (typeof v === 'string' || typeof v === 'number' ? String(v) : ''))
    .join(' ')
    .slice(0, 600);
  const quota = /\b3036\b/.test(text) || /daily free allocation/i.test(text);
  const code = /\b([1-9]\d{3})\b/.exec(text)?.[1];
  const name = typeof e.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'error';
  return { quota, label: code ? `Workers AI ${code}` : name };
}

/** The parts of the AI binding used here (tests pass a fake). */
export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

const TIMED_OUT = Symbol('timed out');

/**
 * Ask the model to read the photo. Throws 429 rate_limited {scope: 'ai'} when the account's free
 * Workers AI allowance is used up (3036, which only the Free plan answers: Workers Paid bills that
 * use instead, so the route's neuron budget stops first) and 502 scan_failed for any other failure,
 * a timeout or an answer without JSON.
 */
export async function runReceiptModel(
  ai: AiRunner,
  model: string,
  image: string,
  ctx: ReceiptPromptContext,
  timeoutMs = RECEIPT_TIMEOUT_MS,
): Promise<ModelAnswer & { data: Loose }> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  let raw: unknown;
  try {
    raw = await Promise.race([ai.run(model, receiptRequest(model, image, ctx), { signal: ctrl.signal }), timeout]);
  } catch (err) {
    const f = aiFailure(err);
    if (f.quota) fail(429, 'rate_limited', 'The daily Workers AI allowance is used up', { scope: 'ai', retryAfter: secondsToNextUtcDay() });
    fail(502, 'scan_failed', `The receipt could not be read (${f.label})`, { reason: 'model' });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (raw === TIMED_OUT) {
    ctrl.abort();
    fail(502, 'scan_failed', 'Reading the receipt took too long', { reason: 'timeout' });
  }
  const answer = readAnswer(raw);
  if (!answer.data) fail(502, 'scan_failed', 'The model gave no usable answer', { reason: 'model' });
  return { ...answer, data: answer.data };
}

// ---------- normalizing what the model said ----------

export interface NormalizeContext {
  /** The currency the app sent (the form's when the scan started, which is where the editor puts
   *  a receipt without a currency): the amounts' unit when the receipt shows none. */
  hint: string | null;
  /** Language of the warnings. */
  locale: Locale;
  /** Today in UTC (YYYY-MM-DD). */
  today: string;
}

/** Codes and signs a model may write instead of an ISO code (keys after NFKC and uppercasing). */
const CURRENCY_SIGNS: Record<string, string> = {
  'NT$': 'TWD', NT: 'TWD', NTD: 'TWD', 'TW$': 'TWD', '新台幣': 'TWD', '新臺幣': 'TWD',
  '円': 'JPY', 'JP¥': 'JPY', '日圓': 'JPY', '日元': 'JPY',
  RMB: 'CNY', 'CN¥': 'CNY', '人民幣': 'CNY', '人民币': 'CNY',
  'US$': 'USD', 'HK$': 'HKD', 'S$': 'SGD', 'SG$': 'SGD', 'A$': 'AUD', 'AU$': 'AUD', 'C$': 'CAD', 'CA$': 'CAD',
  'NZ$': 'NZD', 'MX$': 'MXN', 'R$': 'BRL', '€': 'EUR', '£': 'GBP', '₩': 'KRW', '원': 'KRW', '฿': 'THB', '₫': 'VND',
  RM: 'MYR', RP: 'IDR', '₱': 'PHP', '₹': 'INR', '₺': 'TRY', '₪': 'ILS',
};

/** The currency a model named: a known ISO code (or a sign that names one) and whether it was a guess. */
export function receiptCurrency(v: unknown, hint: string | null): { code: string | null; guessed: boolean } {
  if (typeof v !== 'string') return { code: null, guessed: true };
  const s = v.normalize('NFKC').trim().toUpperCase().slice(0, 12);
  if (!s) return { code: null, guessed: true };
  if (/^[A-Z]{3}$/.test(s)) return isKnownCurrency(s) ? { code: s, guessed: false } : { code: null, guessed: true };
  const named = CURRENCY_SIGNS[s];
  if (named) return { code: named, guessed: false };
  if (s === '¥') return { code: hint === 'CNY' ? 'CNY' : 'JPY', guessed: false };
  if (s === '$' && hint && getCurrency(hint).symbol.includes('$')) return { code: hint, guessed: true };
  return { code: null, guessed: true };
}

/** A number as a model may write it when it ignores the schema ("13,838", "¥1,260", "12,50"). */
function looseNumber(s: string): number {
  let t = s.normalize('NFKC').slice(0, 40).replace(/[^\d.,-]/g, '');
  t = /^-?\d+,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
  return t && t !== '-' ? Number(t) : NaN;
}

/** The number a model gave, a JSON number or text (NaN: none). */
function givenNumber(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'string' ? looseNumber(v) : NaN;
}

/**
 * A model number (major units) as integer minor units of `code`, keeping the sign, or null: not a
 * number, too large, or a fraction in a currency without decimals (¥1,260 misread as 1.26). Goes
 * through toFixed and parseAmount, so 1.005 USD is 101 cents, never 100.
 */
export function minorUnits(v: unknown, code: string): number | null {
  const n = givenNumber(v);
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e13) return null;
  const d = currencyDecimals(code);
  if (d === 0 && Math.abs(abs - Math.round(abs)) > 1e-9) return null;
  const m = parseAmount(abs.toFixed(Math.min(d + 2, 20)), code);
  if (m === null || m > MAX_AMOUNT) return null;
  return n < 0 && m > 0 ? -m : m;
}

/** The first `max` UTF-16 units, never splitting a surrogate pair (the server limits count units). */
function clipUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** One line of text: NFKC (half-width katakana and full-width letters made regular), single spaces. */
function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.slice(0, 500).normalize('NFKC').replace(/[\u0000-\u001f\u007f\u200b]/g, ' ').replace(/\s+/g, ' ').trim();
  return clipUnits(s, max);
}

/** An item name without the marks that flag a tax rate (おにぎり 鮭 * -> おにぎり 鮭). */
function cleanItemName(v: unknown): string {
  const s = cleanText(v, 200).replace(/^[*※★☆✱]+\s*/u, '').replace(/(\s*[*※★☆✱])+$/u, '').trim();
  return clipUnits(s, ITEM_NAME_MAX);
}

const TAX_LINE = /^(消費税|内消費税|内税|外税|税額|税金|稅額|稅金|營業稅|营业税|(sales\s*)?tax\b|vat\b|gst\b|hst\b|pst\b)/;
const TIP_LINE = /^(サービス料|服務費|服务费|服務料|小費|小费|tips?\b|gratuity|service\s*(charge|fee)\b)/;
// Totals, payments and change; also the taxable base of a rate ((8%対象 ¥974)), which is not tax.
const NOT_AN_ITEM = /^(小計|小计|合計|合计|総計|總計|总计|総合計|お会計|御会計|ご請求|請求額|お買上|お買い上げ|お支払|支払|お預|預り|預かり|お釣|おつり|釣銭|釣り銭|現金|クレジット|カード|ポイント|找零|找錢|找钱|收現|實收|實付|應收|應付|应付|信用卡|悠遊卡|一卡通|載具|課税|非課税|sub\s*-?\s*total|total\b|amount\b|balance\b|change\b|cash\b|tendered|visa\b|master\s*card|amex\b|card\b)|^計(?!\p{Script=Han})|\d+(\.\d+)?\s*%\s*対象|税率/u;
const DISCOUNT_START = /^(割引|値引|クーポン|折扣|折價|折价|優惠|优惠|discount|disc\b|coupon)/;
const DISCOUNT_END = /(割引|値引|折扣|折價|折价|優惠|优惠|discount|disc\.?|coupon|off)$/;

type LineKind = 'item' | 'discount' | 'tax' | 'tip' | 'skip';

/** What a line in `items` really is, from its name. */
export function lineKind(name: string): LineKind {
  const k = name.toLowerCase().replace(/^[\s([{【「*※]+/u, '');
  if (TAX_LINE.test(k)) return 'tax';
  if (TIP_LINE.test(k)) return 'tip';
  if (NOT_AN_ITEM.test(k)) return 'skip';
  if (DISCOUNT_START.test(k) || DISCOUNT_END.test(k)) return 'discount';
  return 'item';
}

interface Line {
  name: string;
  /** Minor units; negative for a discount. */
  minor: number;
}

const sumOf = (lines: readonly Line[]): number => lines.reduce((a, l) => a + l.minor, 0);

/** How the tax relates to the line prices: added after the subtotal (外税), already in them (内税), or not known. */
type TaxMode = 'added' | 'included' | 'either';

/**
 * Whether the rest of the bill (total minus the lines) is explained by what the receipt printed:
 * the tax when it was added on top, the tip, less a discount on the whole bill, within `tol`
 * minor units (per-line rounding).
 */
function restFits(rest: number, tax: number, tip: number, discount: number, tol: number, mode: TaxMode): boolean {
  const taxes = !tax ? [0] : mode === 'added' ? [tax] : mode === 'included' ? [0] : [0, tax];
  for (const a of taxes) {
    for (const b of tip ? [0, tip] : [0]) {
      for (const c of discount ? [0, discount] : [0]) {
        if (Math.abs(rest - a - b + c) <= tol) return true;
      }
    }
  }
  return false;
}

/**
 * Drop lines that are really a subtotal or the total (equal to the total, to all lines above them,
 * or to all other lines), but only when that makes the lines fit the total. The latest such line
 * goes first; at most three.
 */
function dropSums(lines: Line[], total: number | null, fits: (sum: number) => boolean): Line[] {
  if (total === null) return lines;
  let out = lines;
  for (let pass = 0; pass < 3 && out.length > 1 && !fits(sumOf(out)); pass++) {
    const all = sumOf(out);
    let prefix = 0;
    let cut = -1;
    out.forEach((l, i) => {
      const m = l.minor;
      const looksLikeSum = m > 0 && (m === total || (i >= 2 && m === prefix) || m === all - m);
      if (looksLikeSum && fits(all - m)) cut = i;
      prefix += m;
    });
    if (cut < 0) break;
    out = out.filter((_, i) => i !== cut);
  }
  return out;
}

/**
 * Discounts listed as lines. After the last bought line they are a discount on the whole bill (the
 * total already has it, and the 品項 split spreads it in proportion), so they are dropped and
 * counted in `discount`. Higher up they belong to the line just above, which takes them when it
 * stays at 0 or more; otherwise they are dropped.
 */
function settleDiscounts(lines: Line[]): { lines: Line[]; billDiscount: number } {
  let last = -1;
  lines.forEach((l, i) => {
    if (l.minor > 0) last = i;
  });
  const out: Line[] = [];
  let billDiscount = 0;
  lines.forEach((l, i) => {
    if (l.minor > 0) out.push({ ...l });
    else if (i > last) billDiscount -= l.minor;
    else {
      const prev = out[out.length - 1];
      if (prev && prev.minor + l.minor >= 0) prev.minor += l.minor;
    }
  });
  return { lines: out.filter(l => l.minor > 0), billDiscount };
}

/** Western calendar [year, month, day] from the ways receipts and models write dates (null year:
 *  none was printed), or null. The model is asked for YYYY-MM-DD; this is the safety net. */
function parseDateParts(s: string): [number | null, number, number] | null {
  const SEP = '\\s*[年./-]\\s*';
  const SEP2 = '\\s*[月./-]\\s*';
  let m = new RegExp(`^(令和|平成|r|h)\\s*(\\d{1,2}|元)${SEP}(\\d{1,2})${SEP2}(\\d{1,2})`, 'i').exec(s);
  if (m) {
    const n = m[2] === '元' ? 1 : Number(m[2]);
    const reiwa = m[1] === '令和' || m[1].toLowerCase() === 'r';
    return [(reiwa ? 2018 : 1988) + n, Number(m[3]), Number(m[4])];
  }
  m = new RegExp(`^(?:中華民國|民國|民国)\\s*(\\d{1,3})${SEP}(\\d{1,2})${SEP2}(\\d{1,2})`).exec(s);
  if (m) return [1911 + Number(m[1]), Number(m[2]), Number(m[3])];
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?!\d)/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a > 12 ? [Number(m[3]), b, a] : [Number(m[3]), a, b]; // 27/09/2026, else US 09/27/2026
  }
  m = new RegExp(`^(\\d{1,4})${SEP}(\\d{1,2})${SEP2}(\\d{1,2})(?!\\d)`).exec(s);
  if (m) {
    let y = Number(m[1]);
    if (y >= 100 && y < 200) y += 1911; // 115/10/05, 0115-10-05: a Taiwan year
    else if (y < 100) y += 2000; // 26/10/13
    return [y, Number(m[2]), Number(m[3])];
  }
  m = /^(\d{1,2})\s*[月/.]\s*(\d{1,2})\s*日?$/.exec(s);
  if (m) return [null, Number(m[1]), Number(m[2])];
  return null;
}

const isoOf = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The receipt's date as YYYY-MM-DD, or null; `bad` when one was given but cannot be right
 *  (unreadable, before 2000, or after tomorrow, which covers every time zone). */
export function receiptDate(v: unknown, today: string): { date: string | null; bad: boolean } {
  if (typeof v !== 'string') return { date: null, bad: false };
  const s = v.normalize('NFKC').trim().slice(0, 40);
  if (!s) return { date: null, bad: false };
  const parts = parseDateParts(s);
  if (!parts) return { date: null, bad: true };
  const [y, mo, d] = parts;
  const latest = addDays(today, 1);
  let iso: string;
  if (y === null) {
    // No year printed: this year, or last year when that would be in the future (a December receipt read in January).
    const thisYear = Number(today.slice(0, 4));
    iso = isoOf(thisYear, mo, d);
    if (iso > latest) iso = isoOf(thisYear - 1, mo, d);
  } else {
    iso = isoOf(y, mo, d);
  }
  if (!isISODate(iso) || iso < '2000-01-01' || iso > latest) return { date: null, bad: true };
  return { date: iso, bad: false };
}

/** A category key the editor can use (never payment): the model's, else one from the store name. */
export function receiptCategory(v: unknown, merchant: string): string | null {
  const k = typeof v === 'string' ? v.trim().toLowerCase().slice(0, 40) : '';
  if (k && k !== 'payment' && k !== 'general' && isCategoryKey(k)) return k;
  const guess = merchant ? detectCategory(merchant) : null;
  if (guess && guess !== 'payment') return guess;
  const parent = k.split('.')[0];
  if (parent && isCategoryKey(parent + '.other')) return parent + '.other';
  return k === 'general' ? 'general' : null;
}

function fill(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/**
 * What a model said, made safe for the editor. Amounts are checked in the receipt's currency (or
 * the hint), 0-decimal currencies refuse fractions, lines that are subtotals, tax, tips, payments
 * or change are taken out, discounts are settled, the date is Western and not in the future, and
 * warnings (in ctx.locale) say what the person should check.
 */
export function normalizeReceipt(raw: unknown, ctx: NormalizeContext): Omit<ReceiptScanDTO, 'usage'> {
  const o: Loose = isObject(raw) ? raw : {};
  const warnings: string[] = [];
  const warn = (zh: string, en: string, params?: Record<string, string | number>) => warnings.push(fill(ctx.locale === 'en' ? en : zh, params));

  // The currency comes first: it says how many decimals every amount has.
  const named = receiptCurrency(o.currency, ctx.hint);
  // The model's own currencyGuessed only counts when its answer is the hint (it fell back on the
  // currency the app sent). Naming another currency means it read one off the receipt: Gemma flags
  // ¥ on a Japanese receipt as a guess at times, which would leave that receipt in a TWD group.
  const guessed = !named.code || named.guessed || (o.currencyGuessed === true && named.code === ctx.hint);
  const unit = named.code ?? ctx.hint;
  const code = unit ?? 'XXX'; // unknown: 2 decimals
  const money = (minor: number) => (unit ? formatMoney(minor, unit, ctx.locale) : formatMoney(minor, code, ctx.locale, { bare: true }));
  const positive = (v: unknown): number | null => {
    const m = minorUnits(v, code);
    return m === null || m === 0 ? null : Math.abs(m);
  };
  // A number we refused (a fraction in yen, or too large), as opposed to 0 for "could not read it".
  const misread = (v: unknown): boolean => {
    const n = givenNumber(v);
    return Number.isFinite(n) && n !== 0 && minorUnits(v, code) === null;
  };

  // The lines: tax, tip, payment and total lines out, discounts kept with their sign for now. A
  // line whose price we refused is left out and counted, since the lines then miss part of the bill.
  const lines: Line[] = [];
  let taxLines = 0;
  let tipLines = 0;
  let misreadItems = 0;
  let misreadExtras = false;
  for (const it of Array.isArray(o.items) ? o.items.slice(0, 200) : []) {
    if (!isObject(it)) continue;
    const name = cleanItemName(it.name);
    const m = minorUnits(it.amount, code);
    if (m === 0) continue;
    const kind = lineKind(name);
    if (m === null) {
      if (kind === 'item' || kind === 'discount') misreadItems += misread(it.amount) ? 1 : 0;
      else if (kind !== 'skip' && misread(it.amount)) misreadExtras = true;
      continue;
    }
    if (kind === 'tax') taxLines += Math.abs(m);
    else if (kind === 'tip') tipLines += Math.abs(m);
    else if (kind === 'discount') lines.push({ name, minor: -Math.abs(m) });
    else if (kind === 'item') lines.push({ name, minor: m });
  }

  let total = positive(o.total);
  const totalMisread = total === null && misread(o.total);
  const tax = positive(o.tax) ?? (taxLines || null);
  const tip = positive(o.tip) ?? (tipLines || null);
  let discount = positive(o.discount);
  // Money we refused anywhere but the total (a line, the tax, the tip, the discount): what the
  // lines add up to would then leave it out, so that sum is never offered as the total.
  const partial = misreadItems > 0 || misreadExtras || misread(o.tax) || misread(o.tip) || misread(o.discount);
  // 外税 or 内税 as the model read it; without an answer the tax may be either.
  const taxMode: TaxMode = o.taxIncluded === false ? 'added' : o.taxIncluded === true ? 'included' : 'either';
  const tol = (n: number) => Math.max(1, n);
  const fitsWith = (sum: number, count: number, disc: number | null, mode: TaxMode = taxMode) =>
    total !== null && restFits(total - sum, tax ?? 0, tip ?? 0, disc ?? 0, tol(count), mode);

  const noSums = dropSums(lines, total, sum => fitsWith(sum, lines.length, discount));
  const settled = settleDiscounts(noSums);
  if (settled.billDiscount && discount === null) discount = settled.billDiscount;
  const kept = settled.lines;
  const itemsSum = sumOf(kept);

  // The total: the printed one, else what the lines add up to (and say so) unless some money on
  // the receipt was refused. A printed total the lines do not explain gets a warning; the two usual
  // misreads of tax get their own words (the 小計 taken for the total on a 外税 receipt, 内税
  // added a second time).
  if (total === null && kept.length && !partial) {
    const added = taxMode === 'added' && tax ? tax : 0;
    const fallback = itemsSum - (discount ?? 0) + (tip ?? 0) + added;
    if (fallback > 0) {
      total = fallback;
      if (totalMisread) warn('總額看不清楚，先用品項加起來的 {v}，請確認', 'The total could not be read, so {v} from the items was used. Check it', { v: money(total) });
      else warn('沒讀到總額，先用品項加起來的 {v}，請確認', 'No total was found, so {v} from the items was used. Check it', { v: money(total) });
    }
  } else if (total !== null && kept.length && !fitsWith(itemsSum, kept.length, discount)) {
    const p = { s: money(itemsSum), t: money(total), tax: money(tax ?? 0) };
    if (tax && taxMode === 'added' && fitsWith(itemsSum, kept.length, discount, 'included')) {
      warn('總額 {t} 好像沒有加上稅 {tax}，請核對', 'The total of {t} may leave out the tax of {tax}. Check it', p);
    } else if (tax && taxMode === 'included' && fitsWith(itemsSum, kept.length, discount, 'added')) {
      warn('總額 {t} 好像把內含的稅 {tax} 又加了一次，請核對', 'The total of {t} may count the included tax of {tax} twice. Check it', p);
    } else {
      warn('品項加起來是 {s}，跟總額 {t} 對不起來，請再看一下', 'The items add up to {s}, which does not fit the total of {t}. Check them', p);
    }
  }
  if (total === null && totalMisread) warn('總額看起來讀錯了，沒有填入', 'The total looks misread, so it was left out');
  else if (total === null && kept.length && partial) warn('沒讀到總額，請自己輸入金額', 'No total was found. Type in the amount');
  if (misreadItems) {
    const one = misreadItems === 1;
    warn('有 {n} 個品項的金額看起來讀錯了，沒有放進來', one ? '1 item looks misread, so it was left out' : '{n} items look misread, so they were left out', { n: misreadItems });
  }
  if (kept.length > MAX_ITEMS) warn('品項超過 {n} 個，只放了前 {n} 個', 'More than {n} items: only the first {n} were kept', { n: MAX_ITEMS });

  const merchant = cleanText(o.merchant, MERCHANT_MAX);
  const date = receiptDate(o.date, ctx.today);
  if (date.bad) warn('收據上的日期看起來不對，沒有填入', 'The date on the receipt looks wrong, so it was left out');
  if (guessed && (total !== null || kept.length > 0)) warn('看不出收據用哪種貨幣，請確認幣別', 'Could not tell the receipt\'s currency. Check it');

  const major = (minor: number) => minor / pow10(currencyDecimals(code));
  return {
    merchant: merchant || null,
    date: date.date,
    currency: guessed ? null : named.code,
    total: total === null ? null : major(total),
    items: kept.slice(0, MAX_ITEMS).map(l => ({ name: l.name, amount: major(l.minor) })),
    tax: tax === null ? null : major(tax),
    tip: tip === null ? null : major(tip),
    category: receiptCategory(o.category, merchant),
    warnings,
  };
}
