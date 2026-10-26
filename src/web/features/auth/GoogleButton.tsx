// 使用 Google 帳戶登入 / Continue with Google on 開始使用 and 登入 (DESIGN.md 8.21, Google), above
// the email form, with a small 或 rule under it. Google's own light button (white, its 1 px gray
// outline, the four-color G, its words), in our pill's shape and height. It is a plain link to the
// Worker's start (googleSignIn.ts googleStartUrl), which sends the browser to Google and back:
// no Google script on our pages. It shows only where it can work: this site offers it (GET
// /api/auth/providers, remembered for the next visit), the session lives in this site's cookies
// (Bearer mode, vite dev and browsers that keep no cookies, cannot get the session a page load
// sets), and not inside an app whose browser Google refuses (InAppHint shows there instead). The
// page to come back to is the one App remembered before the sign-in gate (an invite, a claim),
// so a pending join goes on after Google as after an email code.

import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';
import type { GoogleErrorCode, ProvidersRes } from '../../../shared/types';
import { peekReturn, takeReturn } from '../../App';
import { API_BASE } from '../../config';
import { api, authMode, browserOnline } from '../../lib/api';
import { getLocale, useT } from '../../lib/i18n';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { googleArrivalText, googleErrorText, googleStartUrl, readGoogleReturn, type GoogleReturn } from './googleSignIn';
import { cx, ErrorLine } from './Receipt';
import { isEmbeddedBrowser } from './session';
import s from './Auth.module.css';

// ---------- whether this site offers it ----------

/** The last answer of GET /api/auth/providers, so the button is there from the first frame next time. */
const OFFERED_KEY = 'evenly.google';

function rememberedOffer(): boolean | null {
  try {
    const v = localStorage.getItem(OFFERED_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

let offered: boolean | null = rememberedOffer();
let asked: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Ask the site once a page visit; offline or failing, the remembered answer stands and the next page asks again. */
function askOnce(): void {
  if (asked) return;
  asked = api<ProvidersRes>('GET', '/api/auth/providers', undefined, { anonymous: true, timeoutMs: 10_000 }).then(
    r => {
      offered = r?.google === true;
      try {
        localStorage.setItem(OFFERED_KEY, offered ? '1' : '0');
      } catch {
        /* asked again next visit */
      }
      for (const l of listeners) l();
    },
    () => {
      asked = null;
    },
  );
}

/** Google sign-in can work in this tab, whatever the site says. */
function canWorkHere(): boolean {
  return authMode() === 'cookie' && !isEmbeddedBrowser();
}

/** 使用 Google 帳戶登入 may show. */
export function useGoogleSignIn(): boolean {
  const on = useSyncExternalStore(subscribe, () => offered, () => offered);
  const here = canWorkHere();
  useEffect(() => {
    if (here) askOnce();
  }, [here]);
  return here && on === true;
}

// ---------- the button ----------

/** Google's "G" in its four colors, as Google publishes it (never redrawn or recolored). */
function GoogleG() {
  return (
    <svg className={s.gsiLogo} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/**
 * The button and the 或 rule, or nothing where it cannot work. `error`: why the last Google
 * sign-in came back to 登入 (it shows even when the button does not, so the person knows why).
 */
export function GoogleSignIn({ error, className }: { error?: GoogleErrorCode | null; className?: string }) {
  const { t, locale } = useT();
  const on = useGoogleSignIn();
  const why = error ? <ErrorLine>{googleErrorText(error)}</ErrorLine> : null;
  if (!on) return why ? <div className={cx(s.google, className)}>{why}</div> : null;

  function go(e: MouseEvent<HTMLAnchorElement>) {
    if (!browserOnline()) {
      e.preventDefault();
      showToast({ message: t('沒有網路連線，連線後再用 Google 登入。', 'No connection. Sign in with Google once you are online.'), kind: 'error' });
      return;
    }
    // The page to come back to as it is now (App remembers it before this page shows).
    e.currentTarget.href = googleStartUrl(API_BASE, peekReturn(), getLocale());
  }

  return (
    <div className={cx(s.google, className)}>
      {why}
      <a className={s.gsi} href={googleStartUrl(API_BASE, peekReturn(), locale)} onClick={go} data-testid="google-sign-in">
        <GoogleG />
        <span className={s.gsiLabel}>{t('使用 Google 帳戶登入', 'Continue with Google')}</span>
      </a>
      <p className={s.or}>{t('或', 'or')}</p>
    </div>
  );
}

// ---------- coming back from Google ----------

/** Why the last Google sign-in came back to 登入, until 登入 has shown it. */
let lastError: GoogleErrorCode | null = null;

/** The error 登入 shows (it stays until clearGoogleError, so a second render shows it too). */
export function googleError(): GoogleErrorCode | null {
  return lastError;
}

export function clearGoogleError(): void {
  lastError = null;
}

/**
 * At start (main.tsx): take Google's flag out of the address at once, so a reload or a shared
 * link never repeats it. An error waits for 登入 (googleError); a sign-in waits for the store's
 * start, then greets the account (歡迎回來，{name}, as after an email code) and lets the store
 * finish the sign-in (actions.googleArrived). The callback opened the remembered page already,
 * so the remembered path goes.
 */
export function takeGoogleReturn(booted: Promise<unknown>): void {
  let r: GoogleReturn;
  try {
    r = readGoogleReturn(location.search);
  } catch {
    return;
  }
  if (!r.arrival && !r.error) return;
  history.replaceState(history.state, '', location.pathname + r.search + location.hash);
  if (r.error) lastError = r.error;
  const arrival = r.arrival;
  if (!arrival) return;
  takeReturn();
  void booted
    .then(() => actions.googleArrived())
    .then(me => {
      const text = me ? googleArrivalText(arrival, me.user.name) : null;
      if (text) showToast({ message: text, kind: 'success' });
    })
    .catch(() => undefined);
}
