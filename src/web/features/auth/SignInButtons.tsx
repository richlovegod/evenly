// 使用 Apple 登入 and 使用 Google 帳戶登入 / Sign in with Apple and Sign in with Google on 開始使用,
// 登入 and the friend invite page (DESIGN.md 8.21), above the email form, with a small 或 rule
// under them. Apple's comes first, at least as large as Google's (App Review's rule for the
// iPhone app, kept on the web too). Each is drawn by its maker's guidelines: Apple's black button
// with the Apple logo and Google's light button with its four-color G, in our pill's shape and
// height. Each is a plain link to the Worker's start (appleSignIn.ts, googleSignIn.ts), which sends
// the browser to Apple or Google and back: no Apple or Google script on our pages. They show only
// where they can work: this site offers them (GET /api/auth/providers, remembered for the next
// visit), the session lives in this site's cookies (Bearer mode, vite dev and browsers that keep no
// cookies, cannot get the session a page load sets), and not inside an app's web view (InAppHint
// shows there instead; Google refuses those, and their storage is lost later). The page to come
// back to is the one App remembered before the sign-in gate (an invite, a claim), so a pending join
// goes on after Apple or Google as after an email code. takeProviderReturn reads what the Worker
// puts in the address when the browser comes back, also from a link in 我的 > 登入方式.

import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';
import type { AppleErrorCode, GoogleErrorCode, ProvidersRes, SignInArrival } from '../../../shared/types';
import { peekReturn, takeReturn } from '../../App';
import { confirmDialog } from '../../components/Dialog';
import { API_BASE } from '../../config';
import { api, authMode, browserOnline } from '../../lib/api';
import { getLocale, useT } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import {
  appleArrivalText, appleErrorText, appleLinkedText, appleStartUrl, isRelayEmail, readAppleReturn, relayNewAccountText,
} from './appleSignIn';
import { googleArrivalText, googleErrorText, googleLinkedText, googleStartUrl, readGoogleReturn } from './googleSignIn';
import { cx, ErrorLine } from './Receipt';
import { isEmbeddedBrowser } from './session';
import s from './Auth.module.css';

// ---------- what this site offers ----------

export interface Offered {
  google: boolean;
  apple: boolean;
}

/** The last answer of GET /api/auth/providers, so the buttons are there from the first frame next time. */
const OFFERED_KEY = 'evenly.providers';
/** Google's alone, from before Apple: read when the new key is missing, then dropped. */
const OLD_KEY = 'evenly.google';
const NONE: Offered = { google: false, apple: false };

function rememberedOffer(): Offered | null {
  try {
    const v = localStorage.getItem(OFFERED_KEY);
    if (v) {
      const o = JSON.parse(v) as Partial<Offered> | null;
      if (o && typeof o === 'object') return { google: o.google === true, apple: o.apple === true };
    }
    const old = localStorage.getItem(OLD_KEY);
    return old === '1' ? { google: true, apple: false } : old === '0' ? NONE : null;
  } catch {
    return null;
  }
}

let offered: Offered | null = rememberedOffer();
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
      offered = { google: r?.google === true, apple: r?.apple === true };
      try {
        localStorage.setItem(OFFERED_KEY, JSON.stringify(offered));
        localStorage.removeItem(OLD_KEY);
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

/** Apple and Google sign-ins can work in this tab, whatever the site says. */
function canWorkHere(): boolean {
  return authMode() === 'cookie' && !isEmbeddedBrowser();
}

/** Which of 使用 Apple 登入 and 使用 Google 帳戶登入 may show here (and 連結 on 我的). */
export function useProviders(): Offered {
  const on = useSyncExternalStore(subscribe, () => offered, () => offered);
  const here = canWorkHere();
  useEffect(() => {
    if (here) askOnce();
  }, [here]);
  return here && on ? on : NONE;
}

// ---------- the buttons ----------

/** The Apple logo, as Apple's Sign in with Apple buttons draw it, in the button's own white. */
export function AppleLogo({ className }: { className?: string }) {
  return (
    <svg className={className ?? s.asiLogo} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
      />
    </svg>
  );
}

/** Google's "G" in its four colors, as Google publishes it (never redrawn or recolored). */
export function GoogleG({ className }: { className?: string }) {
  return (
    <svg className={className ?? s.gsiLogo} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/**
 * A start link's tap: offline it shows a toast and stays; online the address is made again now
 * (the page to come back to, or the language, may have changed since the render).
 */
export function startTap(make: () => string, offline: string) {
  return (e: MouseEvent<HTMLElement>) => {
    if (!browserOnline()) {
      e.preventDefault();
      showToast({ message: offline, kind: 'error' });
      return;
    }
    (e.currentTarget as HTMLAnchorElement).href = make();
  };
}

/** Why the last Apple or Google sign-in came back to 登入. */
export type ProviderError = { provider: 'google'; code: GoogleErrorCode } | { provider: 'apple'; code: AppleErrorCode };

export function providerErrorText(e: ProviderError): string {
  return e.provider === 'apple' ? appleErrorText(e.code) : googleErrorText(e.code);
}

/**
 * The buttons and the 或 rule, or nothing where neither can work. `error`: why the last Apple or
 * Google sign-in came back to 登入 (it shows even when no button does, so the person knows why).
 */
export function SignInButtons({ error, className }: { error?: ProviderError | null; className?: string }) {
  const { t, locale } = useT();
  const on = useProviders();
  const why = error ? <ErrorLine>{providerErrorText(error)}</ErrorLine> : null;
  if (!on.apple && !on.google) return why ? <div className={cx(s.google, className)}>{why}</div> : null;
  return (
    <div className={cx(s.google, className)}>
      {why}
      {on.apple && (
        <a
          className={s.asi}
          href={appleStartUrl(API_BASE, peekReturn(), locale)}
          onClick={startTap(() => appleStartUrl(API_BASE, peekReturn(), getLocale()), t('沒有網路連線，連線後再用 Apple 登入。', 'No connection. Sign in with Apple once you are online.'))}
          data-testid="apple-sign-in"
        >
          <AppleLogo />
          <span className={s.gsiLabel}>{t('使用 Apple 登入', 'Sign in with Apple')}</span>
        </a>
      )}
      {on.google && (
        <a
          className={s.gsi}
          href={googleStartUrl(API_BASE, peekReturn(), locale)}
          onClick={startTap(() => googleStartUrl(API_BASE, peekReturn(), getLocale()), t('沒有網路連線，連線後再用 Google 登入。', 'No connection. Sign in with Google once you are online.'))}
          data-testid="google-sign-in"
        >
          <GoogleG />
          <span className={s.gsiLabel}>{t('使用 Google 帳戶登入', 'Sign in with Google')}</span>
        </a>
      )}
      <p className={s.or}>{t('或', 'or')}</p>
    </div>
  );
}

// ---------- coming back from Apple or Google ----------

/** Why the last sign-in came back to 登入, until 登入 has shown it. */
let lastError: ProviderError | null = null;

/** The error 登入 shows (it stays until clearProviderError, so a second render shows it too). */
export function providerError(): ProviderError | null {
  return lastError;
}

export function clearProviderError(): void {
  lastError = null;
}

/**
 * Said once, for a new account made by Sign in with Apple with a Hide My Email address: someone
 * with an account already can go to 我的, sign out, sign in the old way and link Apple there.
 */
async function relayNotice(): Promise<void> {
  const w = relayNewAccountText();
  const ok = await confirmDialog({ title: w.title, message: w.message, confirmLabel: w.ok, cancelLabel: w.haveOne });
  if (!ok) navigate('/account');
}

/**
 * At start (main.tsx): take Google's and Apple's flags out of the address at once, so a reload or
 * a shared link never repeats them. An error waits for 登入 (providerError). A sign-in waits for
 * the store's start, then greets the account (歡迎回來，{name}, as after an email code) and lets the
 * store finish the sign-in (actions.googleArrived, the same for both); a new Apple account with a
 * relay address gets relayNotice instead. The callback opened the remembered page already, so the
 * remembered path goes. A link from 我的 says how it went once the account is loaded again.
 */
export function takeProviderReturn(booted: Promise<unknown>): void {
  let g: ReturnType<typeof readGoogleReturn>;
  let a: ReturnType<typeof readAppleReturn>;
  try {
    g = readGoogleReturn(location.search);
    a = readAppleReturn(g.search);
  } catch {
    return;
  }
  if (!g.arrival && !g.error && !g.link && !a.arrival && !a.error && !a.link) return;
  history.replaceState(history.state, '', location.pathname + a.search + location.hash);
  if (g.error) lastError = { provider: 'google', code: g.error };
  if (a.error) lastError = { provider: 'apple', code: a.error };

  const link = g.link
    ? { ok: g.link === 'ok', text: g.link === 'ok' ? googleLinkedText() : googleErrorText(g.link) }
    : a.link
      ? { ok: a.link === 'ok', text: a.link === 'ok' ? appleLinkedText() : appleErrorText(a.link) }
      : null;
  if (link) {
    void booted
      .then(() => actions.loadMe())
      .then(() => showToast({ message: link.text, kind: link.ok ? 'success' : 'error' }))
      .catch(() => undefined);
  }

  const came: { provider: 'google' | 'apple'; arrival: SignInArrival } | null = g.arrival
    ? { provider: 'google', arrival: g.arrival }
    : a.arrival
      ? { provider: 'apple', arrival: a.arrival }
      : null;
  if (!came) return;
  takeReturn();
  void booted
    .then(() => actions.googleArrived())
    .then(me => {
      if (!me) return;
      if (came.provider === 'apple' && came.arrival === 'new' && isRelayEmail(me.user.email)) return relayNotice();
      const text = came.provider === 'apple' ? appleArrivalText(came.arrival, me.user.name) : googleArrivalText(came.arrival, me.user.name);
      if (text) showToast({ message: text, kind: 'success' });
    })
    .catch(() => undefined);
}
