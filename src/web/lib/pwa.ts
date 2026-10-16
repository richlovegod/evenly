// Service worker registration, update prompt, and Home Screen helpers.

import { t } from './i18n';
import { showToast } from './toast';

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  const url = (import.meta.env.BASE_URL || '/') + 'sw.js';
  // Only a page that was already controlled can be "out of date". WebKit reports a controller
  // during the very first install too, so remember the state from before registering.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(url).then(reg => {
      const offer = (sw: ServiceWorker) => {
        if (!hadController) return;
        showToast({
          message: t('有新版本可以使用。', 'A new version is ready.'),
          action: { label: t('更新', 'Update'), run: () => sw.postMessage('skipWaiting') },
          duration: 12000,
        });
      };
      if (reg.waiting) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed') offer(sw);
        });
      });
      // Check for a new version when the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => undefined);
      });
    }).catch(() => undefined);
  });
}

/** Running as an installed Home Screen app. */
export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** iPhone or iPad Safari (not an in-app browser), where "Add to Home Screen" is in the Share menu. */
export function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inApp = /Line\/|FBAN|FBAV|Instagram|CriOS|FxiOS|EdgiOS|GSA\//.test(ua);
  return ios && !inApp;
}

/** In-app browsers (LINE, Facebook, Instagram) keep their own storage, so sign-in does not carry over. */
export function isInAppBrowser(): boolean {
  return /Line\/|FBAN|FBAV|Instagram/.test(navigator.userAgent);
}
