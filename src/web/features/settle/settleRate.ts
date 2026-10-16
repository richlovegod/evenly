// The exchange rate a payment in another currency is booked at. The rate box reads typed text
// with the same parser as the expense editor (editorLogic.parseRate): 「1,400」 and 「1,342.55」
// are thousands, 「0,215」 and 「4,75」 decimal commas. Text that cannot be read gives no rate
// (saving stays blocked) instead of silently falling back to the fetched rate.

import { parseRate } from '../expenses/editorLogic';

export { parseRate };

export type SettleRateSource = 'same' | 'typed' | 'auto' | 'invalid' | 'none';

export function settleRate(foreign: boolean, typed: string, fetched: number | null): { rate: number | null; source: SettleRateSource } {
  if (!foreign) return { rate: 1, source: 'same' };
  if (typed.trim()) {
    const r = parseRate(typed);
    return r !== null ? { rate: r, source: 'typed' } : { rate: null, source: 'invalid' };
  }
  return fetched !== null && fetched > 0 ? { rate: fetched, source: 'auto' } : { rate: null, source: 'none' };
}

/** How far apart two rates may be before a typed one gets a second look (5 times either way). */
const FAR = 5;

/**
 * A typed rate far from the market rate: a comma read the other way (「1,085」 meant as 1.085),
 * a rate typed upside down, or a missing digit. Nothing stops it; the page asks once.
 */
export function rateLooksOff(typed: number | null, market: number | null): boolean {
  if (typed === null || market === null || !(typed > 0) || !(market > 0)) return false;
  const ratio = typed / market;
  return ratio > FAR || ratio < 1 / FAR;
}
