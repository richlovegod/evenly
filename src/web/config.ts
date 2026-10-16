// Runtime configuration for the web app.

const DEFAULT_API = (import.meta.env.VITE_API_BASE as string | undefined) || 'https://evenly-api-staging.richlovegod.workers.dev';

function readOverride(): string | null {
  try {
    return localStorage.getItem('evenly.api');
  } catch {
    return null;
  }
}

/** Worker base URL without a trailing slash. Tests can point it elsewhere with localStorage['evenly.api']. */
export const API_BASE: string = (readOverride() || DEFAULT_API).replace(/\/+$/, '');

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
