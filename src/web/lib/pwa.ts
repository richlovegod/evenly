// Service worker registration, update prompt, the worker's messages (a notification tap opens
// its page; which version is in control), and Home Screen helpers.

import { t } from './i18n';
import { navigate } from './router';
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
  // A notification tapped while the app is open: the worker asks this page to show what it is
  // about (public/sw.js, notificationclick), so the app keeps its state instead of reloading.
  navigator.serviceWorker.addEventListener('message', e => {
    const path = openPath(e.data);
    if (path) navigate(path);
  });
  navigator.serviceWorker.startMessages();
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

/** The app page a worker message asks to open ({ type: 'open', path: '/g/abc' }), or null. */
export function openPath(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { type?: unknown; path?: unknown };
  if (d.type !== 'open' || typeof d.path !== 'string') return null;
  return d.path.startsWith('/') && !d.path.startsWith('//') ? d.path : null;
}

export interface WorkerVersion {
  version: string;
  /** The worker shows push notifications (evenly-v4 and later). */
  push: boolean;
}

/** A worker's answer to { type: 'version' }, or null for anything else. */
export function readVersion(data: unknown): WorkerVersion | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { type?: unknown; version?: unknown; push?: unknown };
  return d.type === 'version' && typeof d.version === 'string' ? { version: d.version, push: d.push === true } : null;
}

// A worker never changes its own script, so one answer holds for as long as it is in control.
let answered: { sw: ServiceWorker; version: WorkerVersion } | null = null;

/**
 * Ask the worker in control which version it is (over a MessageChannel). null when no worker
 * controls this page, or when it does not answer within `timeoutMs`: evenly-v3 and older ignore
 * the question, and a worker without push handlers must not get a push subscription.
 */
export function swVersion(timeoutMs = 2000): Promise<WorkerVersion | null> {
  const sw = typeof navigator !== 'undefined' && navigator.serviceWorker ? navigator.serviceWorker.controller : null;
  if (!sw || typeof MessageChannel === 'undefined') return Promise.resolve(null);
  if (answered && answered.sw === sw) return Promise.resolve(answered.version);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = (v: WorkerVersion | null) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      if (v) answered = { sw, version: v };
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    channel.port1.onmessage = e => finish(readVersion(e.data));
    try {
      sw.postMessage({ type: 'version' }, [channel.port2]);
    } catch {
      finish(null);
    }
  });
}

/**
 * Put the newest worker in control. 'reloading': a waiting worker takes over (the page then
 * reloads, see registerServiceWorker), or a page that no worker controls reloads to get one.
 * 'downloading': a newer version is being installed, and the 有新版本 toast offers it when ready.
 * 'none': nothing newer was found, so closing and opening the app again is what is left.
 */
export async function updateApp(): Promise<'reloading' | 'downloading' | 'none'> {
  const container = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
  const reg = container ? await container.getRegistration().catch(() => undefined) : undefined;
  if (!container || !reg) return 'none';
  if (!reg.waiting && reg.active && !container.controller) {
    location.reload();
    return 'reloading';
  }
  if (!reg.waiting) await reg.update().catch(() => undefined);
  if (reg.waiting) {
    reg.waiting.postMessage('skipWaiting');
    return 'reloading';
  }
  return reg.installing ? 'downloading' : 'none';
}

/** Running as an installed Home Screen app. */
export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** iPhone, iPad or iPod, in any browser (iPadOS reports itself as a Mac with touch). */
export function isIosDevice(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** iPhone or iPad Safari (not an in-app browser), where "Add to Home Screen" is in the Share menu. */
export function isIosSafari(): boolean {
  const inApp = /Line\/|FBAN|FBAV|Instagram|CriOS|FxiOS|EdgiOS|GSA\//.test(navigator.userAgent);
  return isIosDevice() && !inApp;
}

/** In-app browsers (LINE, Facebook, Instagram) keep their own storage, so sign-in does not carry over. */
export function isInAppBrowser(): boolean {
  return /Line\/|FBAN|FBAV|Instagram/.test(navigator.userAgent);
}
