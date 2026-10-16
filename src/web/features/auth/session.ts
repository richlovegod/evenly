// Small helpers shared by the sign-in, join and claim pages.

import { takeReturn } from '../../App';
import { actions, getState } from '../../lib/store';
import { getRoute, href, navigate } from '../../lib/router';

/**
 * After signing in, go to the page that was saved before the sign-in gate (or Home).
 * App also sends signed-in people from the guest-only screens to Home in an effect. If that
 * effect lands after this navigation, go on to the saved page once more.
 */
export function goToReturn(): void {
  const dest = takeReturn();
  navigate(dest, { replace: true });
  if (dest === '/') return;
  window.setTimeout(() => {
    if (getRoute().name === 'home' && location.hash !== href(dest)) navigate(dest, { replace: true });
  }, 80);
}

/** Open a group after joining or claiming, replacing the join page in the history. */
export function openGroup(groupId: string): void {
  navigate('/g/' + encodeURIComponent(groupId), { replace: true });
}

/** Create a device-only account with this name unless this device is signed in already. */
export async function ensureAccount(name: string): Promise<void> {
  if (getState().token) return;
  await actions.signup({ name: name.trim() });
}

/** iPhone, iPad or iPod (iPadOS reports itself as a Mac with touch). */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** LINE's in-app browser, which honors ?openExternalBrowser=1. */
export function isLineBrowser(): boolean {
  return /Line\//.test(navigator.userAgent);
}

/** This page's URL with ?openExternalBrowser=1, so LINE hands it to Safari or Chrome. */
export function externalBrowserUrl(): string {
  const u = new URL(location.href);
  u.searchParams.set('openExternalBrowser', '1');
  return u.toString();
}
