// Refunds (docs/SPEC.md section 2, Refunds): money coming back, such as a deposit returned, an item
// sent back or a booking cancelled. A refund is exactly a negative expense (balances.ts toBase): it
// is stored with positive amounts, its payers are who got the money back and its split is whose
// money it is. These are the words both apps and the Worker's notifications use for one.

import type { Locale } from './types';

/** The description field's limit (routes/expenses.ts DESCRIPTION_MAX, UTF-16 code units). */
const DESCRIPTION_MAX = 120;

const PREFIX: Record<Locale, string> = { 'zh-TW': '退款：', en: 'Refund: ' };

/** 「退款：」 or "Refund:" at the start, with either colon and any spaces around it. */
const PREFIX_RE = /^\s*(?:退款|refund)\s*[:：]\s*/i;

/**
 * What 記一筆退款 prefills as the description of a refund of the expense `original`:
 * 「退款：押金」 / "Refund: Deposit", cut (never inside a character) to the field's 120.
 */
export function refundDescription(original: string, locale: Locale): string {
  const text = PREFIX[locale] + original.trim();
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > DESCRIPTION_MAX) break;
    out += ch;
  }
  return out;
}

/**
 * A refund's description without its 「退款：」 / "Refund:" prefix, for sentences that already say
 * 退款 (the activity feed, notifications): 「押金」 for 「退款：押金」, the description itself when it
 * has no prefix, and '' for nothing but the word (退款, Refund).
 */
export function refundSubject(description: string): string {
  const rest = description.replace(PREFIX_RE, '').trim();
  return /^(?:退款|refund)$/i.test(rest) ? '' : rest;
}
