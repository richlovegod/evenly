// Runtime configuration for the web app.

const STAGING_API = 'https://evenly-api-staging.richlovegod.workers.dev';

/**
 * An API base as written in VITE_API_BASE or localStorage['evenly.api']: 'same-origin' or '/'
 * mean the Worker that serves this page ('' here, so calls go to /api on this origin).
 */
function apiBaseFrom(raw: string): string {
  const v = raw.trim();
  return v === 'same-origin' ? '' : v.replace(/\/+$/, '');
}

/**
 * Builds served by the Worker (scripts/build-web.sh) call the API on their own origin; vite dev
 * keeps calling staging. VITE_API_BASE chooses explicitly.
 */
function defaultApi(): string {
  const env = import.meta.env.VITE_API_BASE as string | undefined;
  if (env && env.trim()) return apiBaseFrom(env);
  return import.meta.env.DEV ? STAGING_API : '';
}

function readOverride(): string | null {
  try {
    return localStorage.getItem('evenly.api');
  } catch {
    return null;
  }
}

/**
 * Worker base URL without a trailing slash; '' for this page's own origin. Tests and dev can point
 * it elsewhere with localStorage['evenly.api'].
 */
export const API_BASE: string = (() => {
  const o = readOverride();
  return o && o.trim() ? apiBaseFrom(o) : defaultApi();
})();

function sameOriginApi(base: string): boolean {
  if (!base) return true;
  try {
    return new URL(base).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * How requests are signed in (src/web/lib/api.ts). cookie: the API is on this page's origin, so
 * the Worker keeps the session in an HttpOnly cookie that Safari does not clear with the site's
 * other data. bearer: the API is elsewhere (vite dev, tests), so the token is kept in localStorage.
 */
export const AUTH_MODE: 'cookie' | 'bearer' = sameOriginApi(API_BASE) ? 'cookie' : 'bearer';

/** The app's own URL (origin + base path, ending with "/"), used to build share links. */
export const APP_URL: string = new URL(import.meta.env.BASE_URL || '/', location.origin).toString();

/** Build an absolute link to a hash route: appLink('/join/abc') -> https://.../evenly/#/join/abc */
export function appLink(hashPath: string): string {
  return APP_URL + '#' + (hashPath.startsWith('/') ? hashPath : '/' + hashPath);
}

/**
 * A link meant to be pasted into LINE, WhatsApp or iMessage (invites, claim links). The
 * `openExternalBrowser=1` query makes LINE open it in Safari or Chrome instead of its in-app
 * browser, whose storage would not keep the sign-in.
 */
export function shareLink(hashPath: string): string {
  return APP_URL + '?openExternalBrowser=1#' + (hashPath.startsWith('/') ? hashPath : '/' + hashPath);
}

export const APP_VERSION = '0.1.0';
