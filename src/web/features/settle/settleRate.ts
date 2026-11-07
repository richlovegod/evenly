// The exchange rate a payment in another currency is booked at. The rate box reads typed text
// with the same parser as the expense editor (editorLogic.parseRate): 「1,400」 and 「1,342.55」
// are thousands, 「0,215」 and 「4,75」 decimal commas. Text that cannot be read gives no rate
// (saving stays blocked) instead of silently falling back to the fetched rate.

import { convertMinor } from '../../../shared/balances';
import { parseRate } from '../expenses/editorLogic';

export { parseRate };

/**
 * What an amount box nobody typed in holds (it follows the plan), in minor units of the payment's
 * `currency`: the plan's payment `suggested` (minor units of the group currency `base`), and in
 * another currency the amount whose value at `rate` (1 currency = rate base) comes closest to it.
 * Null leaves the box empty: no plan payment, or another currency with no rate yet (loading, no
 * answer, or a typed rate that cannot be read), where the number would be the old currency's read
 * in the new one (NT$1,500 as US$1,500 in the Venmo and PayPal links, review A7-01). The rate's
 * arrival fills it in. The iPhone app's SettlePlan.followText does the same. Pure.
 */
export function followAmount(suggested: number, base: string, currency: string, rate: number | null): number | null {
  if (!(suggested > 0)) return null;
  if (!currency || currency === base) return suggested;
  if (rate === null || !(rate > 0)) return null;
  try {
    const guess = convertMinor(suggested, base, 1 / rate, currency);
    let best = guess;
    let gap = Infinity;
    for (const c of [guess - 1, guess, guess + 1]) {
      if (c <= 0) continue;
      const d = Math.abs(convertMinor(c, currency, rate, base) - suggested);
      if (d < gap) {
        best = c;
        gap = d;
      }
    }
    return best > 0 ? best : null;
  } catch {
    // No amount in this currency: the number in the box was for another one, so it goes too.
    return null;
  }
}

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
