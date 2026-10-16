// Currency table shared by the web app and the Worker.
//
// `decimals` is the number of minor-unit digits this app uses for the currency. It follows
// ISO 4217, except where people only ever split whole units in cash (for example TWD, HUF,
// IDR): there we use 0 so that splits come out in amounts people can actually pay.
// Every amount in the app is stored as an integer count of these minor units.
//
// `symbol` is the prefix shown before the number. Symbols that would be ambiguous in a
// multi-currency group (plain "$", "kr") are replaced by an explicit form (US$, NT$, DKK).

export interface CurrencyInfo {
  code: string;
  decimals: number;
  symbol: string;
  zh: string;
  en: string;
}

const LIST: CurrencyInfo[] = [
  { code: 'TWD', decimals: 0, symbol: 'NT$', zh: '新台幣', en: 'New Taiwan dollar' },
  { code: 'USD', decimals: 2, symbol: 'US$', zh: '美元', en: 'US dollar' },
  { code: 'JPY', decimals: 0, symbol: '¥', zh: '日圓', en: 'Japanese yen' },
  { code: 'CNY', decimals: 2, symbol: 'CN¥', zh: '人民幣', en: 'Chinese yuan' },
  { code: 'HKD', decimals: 2, symbol: 'HK$', zh: '港幣', en: 'Hong Kong dollar' },
  { code: 'MOP', decimals: 2, symbol: 'MOP$', zh: '澳門幣', en: 'Macanese pataca' },
  { code: 'KRW', decimals: 0, symbol: '₩', zh: '韓元', en: 'South Korean won' },
  { code: 'EUR', decimals: 2, symbol: '€', zh: '歐元', en: 'Euro' },
  { code: 'GBP', decimals: 2, symbol: '£', zh: '英鎊', en: 'British pound' },
  { code: 'CAD', decimals: 2, symbol: 'CA$', zh: '加拿大幣', en: 'Canadian dollar' },
  { code: 'AUD', decimals: 2, symbol: 'A$', zh: '澳幣', en: 'Australian dollar' },
  { code: 'NZD', decimals: 2, symbol: 'NZ$', zh: '紐西蘭幣', en: 'New Zealand dollar' },
  { code: 'SGD', decimals: 2, symbol: 'S$', zh: '新加坡幣', en: 'Singapore dollar' },
  { code: 'THB', decimals: 2, symbol: '฿', zh: '泰銖', en: 'Thai baht' },
  { code: 'VND', decimals: 0, symbol: '₫', zh: '越南盾', en: 'Vietnamese dong' },
  { code: 'MYR', decimals: 2, symbol: 'RM', zh: '馬來西亞令吉', en: 'Malaysian ringgit' },
  { code: 'IDR', decimals: 0, symbol: 'Rp', zh: '印尼盾', en: 'Indonesian rupiah' },
  { code: 'PHP', decimals: 2, symbol: '₱', zh: '菲律賓披索', en: 'Philippine peso' },
  { code: 'INR', decimals: 2, symbol: '₹', zh: '印度盧比', en: 'Indian rupee' },
  { code: 'KHR', decimals: 0, symbol: 'KHR ', zh: '柬埔寨瑞爾', en: 'Cambodian riel' },
  { code: 'LAK', decimals: 0, symbol: 'LAK ', zh: '寮國基普', en: 'Lao kip' },
  { code: 'MMK', decimals: 0, symbol: 'MMK ', zh: '緬甸元', en: 'Myanmar kyat' },
  { code: 'NPR', decimals: 2, symbol: 'NPR ', zh: '尼泊爾盧比', en: 'Nepalese rupee' },
  { code: 'LKR', decimals: 2, symbol: 'LKR ', zh: '斯里蘭卡盧比', en: 'Sri Lankan rupee' },
  { code: 'MVR', decimals: 2, symbol: 'MVR ', zh: '馬爾地夫拉菲亞', en: 'Maldivian rufiyaa' },
  { code: 'CHF', decimals: 2, symbol: 'CHF ', zh: '瑞士法郎', en: 'Swiss franc' },
  { code: 'DKK', decimals: 2, symbol: 'DKK ', zh: '丹麥克朗', en: 'Danish krone' },
  { code: 'SEK', decimals: 2, symbol: 'SEK ', zh: '瑞典克朗', en: 'Swedish krona' },
  { code: 'NOK', decimals: 2, symbol: 'NOK ', zh: '挪威克朗', en: 'Norwegian krone' },
  { code: 'ISK', decimals: 0, symbol: 'ISK ', zh: '冰島克朗', en: 'Icelandic krona' },
  { code: 'CZK', decimals: 2, symbol: 'CZK ', zh: '捷克克朗', en: 'Czech koruna' },
  { code: 'PLN', decimals: 2, symbol: 'zł ', zh: '波蘭茲羅提', en: 'Polish zloty' },
  { code: 'HUF', decimals: 0, symbol: 'HUF ', zh: '匈牙利福林', en: 'Hungarian forint' },
  { code: 'RON', decimals: 2, symbol: 'RON ', zh: '羅馬尼亞列伊', en: 'Romanian leu' },
  { code: 'BGN', decimals: 2, symbol: 'BGN ', zh: '保加利亞列弗', en: 'Bulgarian lev' },
  { code: 'TRY', decimals: 2, symbol: '₺', zh: '土耳其里拉', en: 'Turkish lira' },
  { code: 'ILS', decimals: 2, symbol: '₪', zh: '以色列新謝克爾', en: 'Israeli new shekel' },
  { code: 'AED', decimals: 2, symbol: 'AED ', zh: '阿聯酋迪拉姆', en: 'UAE dirham' },
  { code: 'SAR', decimals: 2, symbol: 'SAR ', zh: '沙烏地里亞爾', en: 'Saudi riyal' },
  { code: 'QAR', decimals: 2, symbol: 'QAR ', zh: '卡達里亞爾', en: 'Qatari riyal' },
  { code: 'EGP', decimals: 2, symbol: 'EGP ', zh: '埃及鎊', en: 'Egyptian pound' },
  { code: 'MAD', decimals: 2, symbol: 'MAD ', zh: '摩洛哥迪拉姆', en: 'Moroccan dirham' },
  { code: 'ZAR', decimals: 2, symbol: 'R ', zh: '南非蘭特', en: 'South African rand' },
  { code: 'KES', decimals: 2, symbol: 'KES ', zh: '肯亞先令', en: 'Kenyan shilling' },
  { code: 'TZS', decimals: 0, symbol: 'TZS ', zh: '坦尚尼亞先令', en: 'Tanzanian shilling' },
  { code: 'MXN', decimals: 2, symbol: 'MX$', zh: '墨西哥披索', en: 'Mexican peso' },
  { code: 'BRL', decimals: 2, symbol: 'R$', zh: '巴西雷亞爾', en: 'Brazilian real' },
  { code: 'ARS', decimals: 2, symbol: 'ARS ', zh: '阿根廷披索', en: 'Argentine peso' },
  { code: 'CLP', decimals: 0, symbol: 'CLP ', zh: '智利披索', en: 'Chilean peso' },
  { code: 'COP', decimals: 0, symbol: 'COP ', zh: '哥倫比亞披索', en: 'Colombian peso' },
  { code: 'PEN', decimals: 2, symbol: 'S/ ', zh: '秘魯索爾', en: 'Peruvian sol' },
  { code: 'CRC', decimals: 0, symbol: '₡', zh: '哥斯大黎加科朗', en: 'Costa Rican colon' },
  { code: 'GTQ', decimals: 2, symbol: 'GTQ ', zh: '瓜地馬拉格查爾', en: 'Guatemalan quetzal' },
  { code: 'DOP', decimals: 2, symbol: 'DOP ', zh: '多明尼加披索', en: 'Dominican peso' },
  { code: 'JMD', decimals: 2, symbol: 'JMD ', zh: '牙買加元', en: 'Jamaican dollar' },
  { code: 'FJD', decimals: 2, symbol: 'FJD ', zh: '斐濟元', en: 'Fijian dollar' },
  { code: 'XPF', decimals: 0, symbol: 'XPF ', zh: '太平洋法郎', en: 'CFP franc' },
  { code: 'RUB', decimals: 2, symbol: 'RUB ', zh: '俄羅斯盧布', en: 'Russian ruble' },
  { code: 'UAH', decimals: 2, symbol: 'UAH ', zh: '烏克蘭格里夫納', en: 'Ukrainian hryvnia' },
  { code: 'GEL', decimals: 2, symbol: 'GEL ', zh: '喬治亞拉里', en: 'Georgian lari' },
  { code: 'KZT', decimals: 2, symbol: 'KZT ', zh: '哈薩克堅戈', en: 'Kazakhstani tenge' },
  { code: 'MNT', decimals: 0, symbol: 'MNT ', zh: '蒙古圖格里克', en: 'Mongolian tugrik' },
  { code: 'PKR', decimals: 0, symbol: 'PKR ', zh: '巴基斯坦盧比', en: 'Pakistani rupee' },
  { code: 'BDT', decimals: 2, symbol: 'BDT ', zh: '孟加拉塔卡', en: 'Bangladeshi taka' },
];

const BY_CODE = new Map(LIST.map(c => [c.code, c]));

/** Currencies shown first in pickers, in this order. */
export const COMMON_CURRENCIES = ['TWD', 'USD', 'JPY', 'CNY', 'HKD', 'KRW', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'THB', 'VND'];

export function allCurrencies(): readonly CurrencyInfo[] {
  return LIST;
}

export function isKnownCurrency(code: string): boolean {
  return BY_CODE.has(code);
}

/** Info for a currency code. Unknown but well-formed codes get 2 decimals and the code as prefix. */
export function getCurrency(code: string): CurrencyInfo {
  const hit = BY_CODE.get(code);
  if (hit) return hit;
  return { code, decimals: 2, symbol: code + ' ', zh: code, en: code };
}

export function currencyDecimals(code: string): number {
  return getCurrency(code).decimals;
}

export function currencyName(code: string, locale: string): string {
  const c = getCurrency(code);
  return locale.startsWith('zh') ? c.zh : c.en;
}
