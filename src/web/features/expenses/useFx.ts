// Exchange rate for an entry in another currency: rates into the group currency for the entry
// date, through actions.getFx (which falls back to cached rates when offline).

import { useEffect, useState } from 'react';
import { actions } from '../../lib/store';

export interface FxInfo {
  /** A request is running. */
  loading: boolean;
  /** Value of 1 unit of the entry currency in the group currency, or null. */
  rate: number | null;
  /** The date the provider's rates are for (may be earlier than the entry date). */
  rateDate: string | null;
  /** Rates came from this device's cache because the server could not be reached. */
  stale: boolean;
  /** The request finished and there is no rate at all. */
  missing: boolean;
}

const IDLE: FxInfo = { loading: false, rate: null, rateDate: null, stale: false, missing: false };
const LOADING: FxInfo = { ...IDLE, loading: true };

export function useFx(groupCurrency: string, date: string, currency: string): FxInfo {
  const needed = !!groupCurrency && !!currency && currency !== groupCurrency;
  const key = `${groupCurrency}:${currency}:${date}`;
  // The result is kept with the request it answers, so a rate never shows for another currency or date.
  const [result, setResult] = useState<{ key: string; info: FxInfo } | null>(null);

  useEffect(() => {
    if (!needed) return;
    let live = true;
    actions
      .getFx(groupCurrency, date)
      .then(r => {
        if (!live) return;
        const rate = r?.rates?.[currency];
        const info: FxInfo =
          r && typeof rate === 'number' && rate > 0
            ? { loading: false, rate, rateDate: r.date, stale: !!r.stale, missing: false }
            : { loading: false, rate: null, rateDate: r?.date ?? null, stale: !!r?.stale, missing: true };
        setResult({ key, info });
      })
      .catch(() => {
        if (live) setResult({ key, info: { ...IDLE, missing: true } });
      });
    return () => {
      live = false;
    };
  }, [needed, key, groupCurrency, date, currency]);

  if (!needed) return IDLE;
  return result && result.key === key ? result.info : LOADING;
}
