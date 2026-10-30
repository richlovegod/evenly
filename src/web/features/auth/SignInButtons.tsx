// 使用 Apple 登入 and 使用 Google 帳戶登入 / Sign in with Apple and Sign in with Google on 開始使用,
// 登入 and the friend invite page (DESIGN.md 8.21), above the email form, with a small 或 rule
// under them. Apple's comes first, at least as large as Google's (App Review's rule for the
// iPhone app, kept on the web too). Each is drawn by its maker's guidelines: Apple's black button
// with Apple's own logo artwork and Google's light button with its four-color G, in our pill's
// shape and height. Each is a plain link to the Worker's start (appleSignIn.ts, googleSignIn.ts), which sends
// the browser to Apple or Google and back: no Apple or Google script on our pages. They show only
// where they can work: this site offers them (GET /api/auth/providers, remembered for the next
// visit), the session lives in this site's cookies (Bearer mode, vite dev and browsers that keep no
// cookies, cannot get the session a page load sets), and not inside an app's web view (InAppHint
// shows there instead; Google refuses those, and their storage is lost later). The page to come
// back to is the one App remembered before the sign-in gate (an invite, a claim), so a pending join
// goes on after Apple or Google as after an email code. takeProviderReturn reads what the Worker
// puts in the address when the browser comes back, also from a link in 我的 > 登入方式, which
// waits for the person to confirm it (signInNotices.ts).

import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';
import type { AppleErrorCode, GoogleErrorCode, PendingLinkDTO, ProvidersRes, SignInArrival } from '../../../shared/types';
import { peekReturn, takeReturn } from '../../App';
import { confirmDialog } from '../../components/Dialog';
import { API_BASE } from '../../config';
import { api, ApiError, authMode, browserOnline } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
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
import { claimedNoticeText, pendingExpiredText, pendingLinkedText, pendingLinkQuestion, readNoticeReturn } from './signInNotices';
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

/**
 * The Apple logo's outline in Apple's own artwork (Apple Design Resources, "Logo - SIWA",
 * downloaded 2026-10-30), in the 31 x 44 box of its left-aligned files: the logo with the padding
 * Apple draws around it.
 */
const APPLE_LOGO_PATH =
  'M15.7099491,14.8846154 C16.5675461,14.8846154 17.642562,14.3048315 18.28274,13.5317864 C18.8625238,12.8312142 19.2852829,11.852829 19.2852829,10.8744437 C19.2852829,10.7415766 19.2732041,10.6087095 19.2490464,10.5 C18.2948188,10.5362365 17.1473299,11.140178 16.4588366,11.9494596 C15.9152893,12.56548 15.4200572,13.5317864 15.4200572,14.5222505 C15.4200572,14.6671964 15.4442149,14.8121424 15.4562937,14.8604577 C15.5166879,14.8725366 15.6133185,14.8846154 15.7099491,14.8846154 Z M12.6902416,29.5 C13.8618881,29.5 14.3812778,28.714876 15.8428163,28.714876 C17.3285124,28.714876 17.6546408,29.4758423 18.9591545,29.4758423 C20.2395105,29.4758423 21.0971074,28.292117 21.9063891,27.1325493 C22.8123013,25.8038779 23.1867451,24.4993643 23.2109027,24.4389701 C23.1263509,24.4148125 20.6743484,23.4122695 20.6743484,20.5979021 C20.6743484,18.1579784 22.6069612,17.0588048 22.7156707,16.974253 C21.4353147,15.1382708 19.490623,15.0899555 18.9591545,15.0899555 C17.5217737,15.0899555 16.3501271,15.9596313 15.6133185,15.9596313 C14.8161157,15.9596313 13.7652575,15.1382708 12.521138,15.1382708 C10.1536872,15.1382708 7.75,17.0950413 7.75,20.7911634 C7.75,23.0861411 8.64383344,25.513986 9.74300699,27.0842339 C10.6851558,28.4129053 11.5065162,29.5 12.6902416,29.5 Z';

/**
 * Apple's "Left-aligned, White, Medium" logo file as it is (the white logo on its black box), for
 * the button: the HIG asks for that file in a button with a title, as tall as the button, with no
 * padding added above or below it (Auth.module.css .asiLogo).
 */
function AppleButtonLogo() {
  return (
    <svg className={s.asiLogo} viewBox="0 0 31 44" aria-hidden="true" focusable="false">
      <rect width="31" height="44" fill="#000000" />
      <path fill="#FFFFFF" d={APPLE_LOGO_PATH} />
    </svg>
  );
}

/**
 * Apple's "Left-aligned, Black, Medium" logo file as it is (the black logo on its 31 x 44 white
 * box, nothing cropped), for 我的 > 登入方式's Apple row: the logo before the word Apple, as in a
 * button with a title, on a card whose paper the white box all but matches.
 */
export function AppleLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 31 44" aria-hidden="true" focusable="false">
      <rect width="31" height="44" fill="#FFFFFF" />
      <path fill="#000000" d={APPLE_LOGO_PATH} />
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
          <AppleButtonLogo />
          <span className={s.asiLabel}>{t('使用 Apple 登入', 'Sign in with Apple')}</span>
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
 * Said once after a sign-in that took an unconfirmed email over (`notice: "claimed"`, an email code
 * on 開始使用, 登入 or the invite page, or Apple and Google): the old password is gone and the other
 * devices are signed out. 設定密碼 opens 我的, whose 登入方式 sets one. Call it on the page the
 * sign-in opens (a dialog belongs to the page that asked).
 */
export async function claimedNotice(): Promise<void> {
  const w = claimedNoticeText();
  const ok = await confirmDialog({ title: w.title, message: w.message, confirmLabel: w.ok, cancelLabel: w.setPassword });
  if (!ok) navigate('/account');
}

/** Why 連結 did not link: gone (404), or a 409 in the link's words; anything else as any error. */
function pendingRefusal(provider: PendingLinkDTO['provider'], err: unknown): string {
  if (err instanceof ApiError && err.status === 404) return pendingExpiredText();
  const code = err instanceof ApiError ? err.code : null;
  if (provider === 'apple' && (code === 'apple_taken' || code === 'already_linked' || code === 'email_unconfirmed')) return appleErrorText(code);
  if (provider === 'google' && (code === 'google_taken' || code === 'already_linked' || code === 'email_unconfirmed')) return googleErrorText(code);
  return errorMessage(err);
}

/** A link's reasons can run two sentences (apple_taken's way out): long enough to read. */
const LINK_TOAST_MS = 8000;

/**
 * A link from 我的 that came back through Apple's or Google's pages (`?link_pending=<id>`): nothing
 * is linked until the person says so. 我的 asks 「把 Google 帳戶 {email} 連結到這個帳號？」 (Apple's:
 * the email or 「隱藏的 Email」); 連結 links it, anything else (取消, Escape, leaving the page) drops
 * it. Then the account is loaded again and a toast says how it went.
 */
async function askPendingLink(id: string): Promise<void> {
  let p: PendingLinkDTO;
  try {
    p = await actions.pendingLink(id);
  } catch (err) {
    showToast({ message: err instanceof ApiError && err.status === 404 ? pendingExpiredText() : errorMessage(err), kind: 'error' });
    return;
  }
  const q = pendingLinkQuestion(p);
  if (!(await confirmDialog({ title: q.title, message: q.message, confirmLabel: q.ok, cancelLabel: q.cancel }))) {
    await actions.dropPendingLink(id).catch(() => undefined);
    return;
  }
  try {
    const r = await actions.confirmPendingLink(id);
    showToast({ message: pendingLinkedText(p.provider, r.movedFromEmpty === true), kind: 'success', duration: r.movedFromEmpty ? 6000 : undefined });
  } catch (err) {
    showToast({ message: pendingRefusal(p.provider, err), kind: 'error', duration: LINK_TOAST_MS });
  }
  void actions.loadMe();
}

/**
 * At start (main.tsx): take Google's and Apple's flags out of the address at once, so a reload or
 * a shared link never repeats them. An error waits for 登入 (providerError). A sign-in waits for
 * the store's start, then greets the account (歡迎回來，{name}, as after an email code) and lets the
 * store finish the sign-in (actions.googleArrived, the same for both); a new Apple account with a
 * relay address gets relayNotice instead, and one that took an unconfirmed email over
 * (`notice=claimed`) gets claimedNotice too. The callback opened the remembered page already, so
 * the remembered path goes. A link from 我的 asks first (`link_pending`, askPendingLink); one
 * that failed says why once the account is loaded again.
 */
export function takeProviderReturn(booted: Promise<unknown>): void {
  let g: ReturnType<typeof readGoogleReturn>;
  let a: ReturnType<typeof readAppleReturn>;
  let n: ReturnType<typeof readNoticeReturn>;
  try {
    g = readGoogleReturn(location.search);
    a = readAppleReturn(g.search);
    n = readNoticeReturn(a.search);
  } catch {
    return;
  }
  if (!g.arrival && !g.error && !g.link && !a.arrival && !a.error && !a.link && !n.pending && !n.claimed && n.search === a.search) return;
  history.replaceState(history.state, '', location.pathname + n.search + location.hash);
  if (g.error) lastError = { provider: 'google', code: g.error };
  if (a.error) lastError = { provider: 'apple', code: a.error };
  if (n.pending) {
    const id = n.pending;
    void booted.then(() => askPendingLink(id)).catch(() => undefined);
  }

  const link = g.link
    ? { ok: g.link === 'ok', text: g.link === 'ok' ? googleLinkedText() : googleErrorText(g.link) }
    : a.link
      ? { ok: a.link === 'ok', text: a.link === 'ok' ? appleLinkedText() : appleErrorText(a.link) }
      : null;
  if (link) {
    void booted
      .then(() => actions.loadMe())
      .then(() => showToast({ message: link.text, kind: link.ok ? 'success' : 'error', duration: link.ok ? undefined : LINK_TOAST_MS }))
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
      if (n.claimed) return claimedNotice();
    })
    .catch(() => undefined);
}
