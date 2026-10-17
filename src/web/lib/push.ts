// Web Push on this device (docs/PLAN-push-scan-cookies.md, section 2): the state the 通知 cards
// show, turning notifications on and off, and linking this device's subscription to the session
// each time the app starts or someone signs in.
// - iPhone and iPad get Web Push only in the app opened from the Home Screen (iOS 16.4 and later).
// - Safari shows the permission prompt only for a request made inside a tap, so enablePush() asks
//   before it awaits anything. The server's public key is fetched before the tap
//   (loadPushStatus, preparePush) and kept here.
// - A subscription is only made while a worker that shows notifications is in control
//   (evenly-v4 answers the version ping with push: true): Safari stops delivering to a worker
//   that receives pushes and shows nothing.
// - Which account asked for notifications on this device is remembered here (evenly.push.wanted:
//   its id, set by the tap on 開啟通知, cleared by turning them off here). Only for that account
//   does a start link the browser's subscription again or subscribe again by itself, for example
//   after notifications were allowed in Settings or the browser lost the subscription; turning
//   them off here is never undone, and someone else signing in on this device does not inherit
//   them (the subscription counts as off for them until they turn notifications on).
// - When the signed-in account leaves this device (signs out, its session ends, or another
//   account signs in), the browser's subscription is dropped here at once, with no request, so
//   it works offline and also stops a session the server still has (a Bearer sign-out that never
//   reached it): the push service answers 410 from then on, and the server deletes the row. The
//   wish stays, so that account's next sign-in here subscribes again quietly.

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PushPrefsDTO, PushStatusRes, PushSubscriptionReq, PushTestRes } from '../../shared/types';
import { api, ApiError } from './api';
import { isIosSafari, isStandalone, swVersion } from './pwa';

export type PushState =
  /** iPhone or iPad Safari: push works only in the Home Screen app. */
  | 'needs-install'
  /** No Push API here (another browser, an in-app browser, iOS before 16.4). */
  | 'unsupported'
  /** The worker in control does not show notifications yet (an older version, or none yet). */
  | 'waiting-worker'
  /** Notifications are blocked for this app (Settings, or the browser's site settings). */
  | 'denied'
  | 'off'
  | 'on';

/** What the state is decided from (readPushFacts reads them from the browser). */
export interface PushFacts {
  /** iPhone or iPad Safari outside the Home Screen app. */
  iosBrowser: boolean;
  /** Service workers, the Push API and notifications all exist here. */
  supported: boolean;
  /** The worker in control answered the version ping with push: true. */
  workerReady: boolean;
  permission: NotificationPermission;
  /** The browser holds a push subscription for this app. */
  subscribed: boolean;
}

/** The state from the facts, in this order: install first, then support, worker, permission. */
export function decidePushState(f: PushFacts): PushState {
  if (f.iosBrowser) return 'needs-install';
  if (!f.supported) return 'unsupported';
  if (!f.workerReady) return 'waiting-worker';
  if (f.permission === 'denied') return 'denied';
  return f.permission === 'granted' && f.subscribed ? 'on' : 'off';
}

/**
 * The server's VAPID public key (base64url, as GET /api/push/status sends it) as the bytes
 * pushManager.subscribe() takes: an uncompressed P-256 point, 65 bytes starting with 0x04.
 * Throws on anything else, so a broken key never turns into a subscription that cannot work.
 */
export function serverKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const body = key.trim().replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('push key: not base64url');
  const b64 = body.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new Error('push key: not a P-256 public key');
  return bytes;
}

/** True when a subscription's key (PushSubscription.options) is `key`; unknown counts as the same. */
export function sameKey(made: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!made) return true;
  const a = new Uint8Array(made);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

/** The device's IANA time zone ('Asia/Taipei'), or null when the browser does not say. */
export function deviceTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz ? tz : null;
  } catch {
    return null;
  }
}

/** PUT /api/push/subscription: the subscription as the browser writes it, plus the time zone. */
export function subscriptionBody(json: PushSubscriptionJSON, tz: string | null): PushSubscriptionReq {
  return { ...json, ...(tz ? { tz } : {}) } as PushSubscriptionReq;
}

// ---------- the browser ----------

/** Service workers, the Push API and notifications all exist (never true in iPhone Safari itself). */
function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    typeof ServiceWorkerRegistration !== 'undefined' &&
    'showNotification' in ServiceWorkerRegistration.prototype
  );
}

function iosBrowser(): boolean {
  return isIosSafari() && !isStandalone();
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function readPushFacts(): Promise<PushFacts> {
  const ios = iosBrowser();
  const supported = !ios && pushSupported();
  if (!supported) return { iosBrowser: ios, supported, workerReady: false, permission: 'default', subscribed: false };
  const version = await swVersion();
  const reg = version?.push ? await registration() : null;
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  // A subscription another account turned on here is not this account's: off until it turns them on.
  return { iosBrowser: false, supported, workerReady: !!version?.push, permission: Notification.permission, subscribed: !!sub && wanted() };
}

/** This device's push state right now. */
export async function pushState(): Promise<PushState> {
  try {
    return decidePushState(await readPushFacts());
  } catch {
    // Some private modes refuse service worker calls.
    return 'unsupported';
  }
}

// ---------- remembered on this device ----------

const WANTED_KEY = 'evenly.push.wanted';

/** The signed-in account (main.tsx keeps it current); null while signed out or not known yet. */
let account: string | null = null;
/** The session key main.tsx passed last (State.token in lib/store.ts). */
let session: string | null = null;
/** The account last known on that session: it stays while `me` loads again. */
let owner: string | null = null;
/**
 * Bumped when a sync on its way must stop: notifications were turned off here, or the signed-in
 * account changed or left. runSync checks it after every await, before it changes anything.
 */
let generation = 0;

/**
 * main.tsx passes the store's session key and the signed-in account's id (null until `me` is
 * known) whenever either changes. A session key going null, or the account turning into another
 * one, means the account left this device (leaveDevice). `me` missing for a moment while the
 * session stays (it loads after a Bearer sign-in and at start) is not leaving.
 */
export function setPushSession(key: string | null, userId: string | null): void {
  const ended = !!session && !key;
  const switched = !!key && !!userId && !!owner && userId !== owner;
  session = key;
  owner = key ? (userId ?? owner) : null;
  const now = key ? userId : null;
  if (account !== now) {
    account = now;
    generation++;
    changed();
  }
  if (ended || switched) leaveDevice();
}

/**
 * Settles once the subscription of an account that left is dropped. A sync, or a tap on
 * 開啟通知, waits for it, so neither takes over a subscription that is about to go.
 */
let leaving: Promise<void> = Promise.resolve();

/**
 * The account signed in here left: drop the browser's subscription now, and tell the server
 * nothing (the session may be gone, the device may be offline). A row the server still has for
 * it then gets 404 or 410 from the push service, and the sender deletes it. evenly.push.wanted
 * stays, so a later sign-in of the account that wants them subscribes again (runSync).
 */
function leaveDevice(): void {
  generation++;
  const drop = dropHere().catch(() => undefined);
  leaving = leaving.then(() => drop);
}

async function dropHere(): Promise<void> {
  if (iosBrowser() || !pushSupported()) return;
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  await sub.unsubscribe();
  changed();
}

/** This account tapped 開啟通知 on this device, and did not turn notifications off here since. */
function wanted(): boolean {
  if (!account) return false;
  try {
    return localStorage.getItem(WANTED_KEY) === account;
  } catch {
    return false;
  }
}

function setWanted(on: boolean): void {
  try {
    if (on && account) localStorage.setItem(WANTED_KEY, account);
    else if (!on) localStorage.removeItem(WANTED_KEY);
  } catch {
    /* private mode: a later start just does not subscribe again by itself */
  }
}

// Pages refresh their state after push is turned on or off anywhere in the app.
let epoch = 0;
const listeners = new Set<() => void>();

function changed(): void {
  epoch++;
  for (const l of listeners) l();
}

function subscribeEpoch(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- the server ----------

/** The key from the last GET /api/push/status (the same for every account). */
let serverKey: string | null = null;

/** GET /api/push/status: the key to subscribe with, this account's choices, how many devices get pushes. */
export async function loadPushStatus(): Promise<PushStatusRes> {
  const res = await api<PushStatusRes>('GET', '/api/push/status');
  if (res && typeof res.publicKey === 'string' && res.publicKey) serverKey = res.publicKey;
  return res;
}

/** Fetch the key ahead of a tap that may turn notifications on (errors are left for that tap). */
export function preparePush(): void {
  if (!serverKey) loadPushStatus().catch(() => undefined);
}

async function currentKey(): Promise<Uint8Array<ArrayBuffer>> {
  return serverKeyBytes(serverKey ?? (await loadPushStatus()).publicKey);
}

async function saveSubscription(sub: PushSubscription): Promise<number> {
  const res = await api<{ ok: true; devices: number }>('PUT', '/api/push/subscription', subscriptionBody(sub.toJSON(), deviceTimeZone()));
  return res.devices;
}

/** Drop the browser's subscription first (pushes to it stop at once), then tell the server. */
async function dropSubscription(sub: PushSubscription): Promise<void> {
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await forgetEndpoint(endpoint);
}

/** DELETE /api/push/subscription for an endpoint the browser has dropped. Never throws. */
async function forgetEndpoint(endpoint: string): Promise<void> {
  try {
    await api('DELETE', '/api/push/subscription', { endpoint });
  } catch (err) {
    // 404: the server had already dropped it. Anything else: the push service now answers 410
    // for this endpoint, and the server deletes it on the next send.
    if (err instanceof ApiError && err.status === 404) return;
  }
}

/** PUT /api/push/prefs: which kinds of change notify this account, on every device. */
export function savePushPrefs(patch: Partial<PushPrefsDTO>): Promise<PushPrefsDTO> {
  return api<PushPrefsDTO>('PUT', '/api/push/prefs', patch);
}

/** POST /api/push/test: one notification to each of this account's devices, now (5 an hour). */
export function sendTestPush(): Promise<PushTestRes> {
  return api<PushTestRes>('POST', '/api/push/test');
}

// ---------- on and off ----------

/** Notification.requestPermission(), promise or callback style (older Safari takes a callback). */
function askPermission(): Promise<NotificationPermission> {
  return new Promise((resolve, reject) => {
    if (typeof Notification === 'undefined') {
      reject(new Error('push: notifications are not available'));
      return;
    }
    try {
      const p = Notification.requestPermission(resolve);
      if (p && typeof p.then === 'function') p.then(resolve, () => resolve(Notification.permission));
    } catch {
      resolve(Notification.permission);
    }
  });
}

export interface EnableResult {
  /** 'on'; 'denied' when blocked; 'off' when the prompt was closed without an answer. */
  state: PushState;
  /** How many devices of this account get notifications now (when the server said). */
  devices?: number;
}

/**
 * Turn notifications on for this device. Call it straight from the tap, before anything else
 * awaits: Safari shows the permission prompt only then. Rejects when subscribing or saving fails,
 * and then leaves no subscription behind. The wish stays, so allowing notifications in Settings
 * later, or the next start after a failed save, finishes the job (syncPush).
 */
export function enablePush(): Promise<EnableResult> {
  const asked = askPermission();
  setWanted(true);
  return finishEnable(asked);
}

async function finishEnable(asked: Promise<NotificationPermission>): Promise<EnableResult> {
  const permission = await asked;
  if (permission !== 'granted') {
    changed();
    return { state: permission === 'denied' ? 'denied' : 'off' };
  }
  // A subscription being dropped for an account that just left is not one to take over.
  await leaving;
  const reg = await registration();
  if (!reg?.active) throw new Error('push: no service worker');
  // Permission is granted now, so subscribing no longer needs the tap.
  const key = await currentKey();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    await dropSubscription(sub).catch(() => undefined);
    sub = null;
  }
  const fresh = !sub;
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  let devices: number;
  try {
    devices = await saveSubscription(sub);
  } catch (err) {
    // The server does not know this device: do not leave a subscription that says "on".
    if (fresh) await sub.unsubscribe().catch(() => false);
    throw err;
  }
  changed();
  return { state: 'on', devices };
}

/** Turn notifications off for this device only (the account's other devices keep theirs). */
export async function disablePush(): Promise<void> {
  setWanted(false);
  // A sync on its way (the start sync) stops before it saves or makes anything (runSync).
  generation++;
  const reg = 'serviceWorker' in navigator ? await registration() : null;
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  try {
    if (sub) await dropSubscription(sub);
  } finally {
    changed();
  }
}

/** The run on its way or waiting, and the generation it was asked for in. */
let syncing: { gen: number; done: Promise<void> } | null = null;
/** The last run asked for: a new one starts after it, so two never overlap. */
let lastRun: Promise<void> = Promise.resolve();

/**
 * At start and after each sign-in: link this device's subscription to the current session (PUT
 * again, so it follows a password reset or a new sign-in), make a new one quietly when there is
 * none while notifications are allowed and wanted here, replace one made with an older server
 * key, and drop it when notifications were blocked since. Never asks for permission, never throws.
 * One run at a time (StrictMode runs effects twice); a run asked for before notifications were
 * turned off or the account changed stops at its next step, and a new one follows it, so a quick
 * sign-out and sign-in still links the new session.
 */
export function syncPush(): Promise<void> {
  if (syncing && syncing.gen === generation) return syncing.done;
  const gen = generation;
  const done: Promise<void> = lastRun
    .then(() => runSync(gen))
    .catch(() => undefined)
    .finally(() => {
      if (syncing?.done === done) syncing = null;
    });
  syncing = { gen, done };
  lastRun = done;
  return done;
}

/**
 * One sync, asked for in generation `gen`. 關閉這台裝置的通知 may be tapped, or the account may
 * change, during any await: from then on the run saves and makes nothing (and drops a
 * subscription it made itself).
 */
async function runSync(gen: number): Promise<void> {
  if (iosBrowser() || !pushSupported()) return;
  await leaving;
  const who = account;
  const still = () => gen === generation && wanted();
  const reg = await registration();
  if (!reg) return;
  let sub = await reg.pushManager.getSubscription();
  // Asked for before the change: the run asked for since (if any) does the work.
  if (gen !== generation) return;
  const permission = Notification.permission;
  if (permission === 'denied') {
    // Blocked in Settings since: stop sending here. `wanted` stays, so allowing them again brings them back.
    if (sub) {
      await dropSubscription(sub);
      changed();
    }
    return;
  }
  if (permission !== 'granted') return;
  // Only for the account that turned them on here: never link, or make, a subscription for
  // someone else who signs in on this device.
  if (!still()) return;
  const key = await currentKey().catch(() => null);
  if (!still()) return;
  let replaced = false;
  try {
    if (sub && key && !sameKey(sub.options?.applicationServerKey, key)) {
      // Made with an older server key: the push service refuses what the server signs now.
      await dropSubscription(sub).catch(() => undefined);
      sub = null;
      replaced = true;
    }
    if (!sub) {
      if (!key || !(await swVersion())?.push || !still()) return;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      replaced = true;
      if (!still()) {
        await sub.unsubscribe().catch(() => false);
        return;
      }
    }
    await saveSubscription(sub);
    if (!still() && account === who && (await reg.pushManager.getSubscription())?.endpoint !== sub.endpoint) {
      // Turned off here while the PUT was on its way: the DELETE of that tap may have reached
      // the server first, so it goes again now that the PUT is done.
      await forgetEndpoint(sub.endpoint);
    }
  } finally {
    if (replaced) changed();
  }
}

function currentPermission(): NotificationPermission | null {
  return typeof Notification !== 'undefined' ? Notification.permission : null;
}

/**
 * While someone is signed in (main.tsx): syncPush now, and again when the app comes back to the
 * front with another notification permission than it had when it left (allowed or blocked in
 * Settings meanwhile). Returns the function that stops watching.
 */
export function startPushSync(): () => void {
  let seen = currentPermission();
  void syncPush();
  const onVisibility = () => {
    const now = currentPermission();
    if (document.visibilityState === 'visible' && now !== seen) void syncPush();
    seen = now;
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}

// ---------- for pages ----------

/**
 * This device's push state for a card: read when `active`, and again when the app comes back to
 * the front (after a change in Settings), when another worker takes control, and after push is
 * turned on or off anywhere in the app. null until the first answer.
 */
export function usePushState(active = true): { state: PushState | null; refresh: () => void } {
  const ep = useSyncExternalStore(subscribeEpoch, () => epoch, () => epoch);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<PushState | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    void pushState().then(s => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, [active, ep, tick]);

  useEffect(() => {
    if (!active) return;
    const again = () => setTick(n => n + 1);
    const onVisible = () => {
      if (document.visibilityState === 'visible') again();
    };
    document.addEventListener('visibilitychange', onVisible);
    const container = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    container?.addEventListener('controllerchange', again);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      container?.removeEventListener('controllerchange', again);
    };
  }, [active]);

  return { state: active ? state : null, refresh: () => setTick(n => n + 1) };
}
