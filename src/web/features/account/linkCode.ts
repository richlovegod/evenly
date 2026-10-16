// The one live sign-in code of this account. The server keeps a single unused code per account
// (a new one replaces the old), so the 在其他裝置登入 panel and the Add to Home Screen steps share
// this slot: whichever made the newest code shows it, and the other stops showing a dead one.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionDTO } from '../../../shared/types';
import { getRoute } from '../../lib/router';
import { actions } from '../../lib/store';

export type CodePurpose = 'device' | 'install' | 'handoff';

export interface CodeSlot {
  code: string;
  expiresAt: string;
  /** Local clock time (ms) when the code stops working. */
  deadline: number;
  purpose: CodePurpose;
}

/** How long the server keeps a code (LinkCodeRes: valid 10 minutes). */
export const CODE_TTL_MS = 10 * 60_000;

let slot: CodeSlot | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useCodeSlot(): CodeSlot | null {
  return useSyncExternalStore(subscribe, () => slot, () => slot);
}

/**
 * When a server timestamp expires, as a local deadline. The device clock may be off, so a value
 * that looks wrong (already past, or later than the known lifetime) falls back to now + ttl.
 */
export function localDeadline(expiresAt: string, ttlMs: number): number {
  const left = Date.parse(expiresAt) - Date.now();
  return Date.now() + (left > 0 && left <= ttlMs ? left : ttlMs);
}

let expiryTimer: ReturnType<typeof setTimeout> | undefined;

/** Ask the server for a new code (Add to Home Screen also puts it in this page's URL). */
export async function makeCode(purpose: CodePurpose): Promise<CodeSlot> {
  const r = purpose === 'install' ? await actions.prepareInstall() : await actions.createLinkCode();
  if (purpose === 'install') startAtHome();
  const next: CodeSlot = { code: r.code, expiresAt: r.expiresAt, deadline: localDeadline(r.expiresAt, CODE_TTL_MS), purpose };
  slot = next;
  emit();
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => {
    if (slot === next) dropInstallParam(next.code);
  }, Math.max(0, next.deadline - Date.now()) + 1000);
  return next;
}

export function clearCode(purpose?: CodePurpose): void {
  if (!slot || (purpose && slot.purpose !== purpose)) return;
  if (slot.purpose === 'install') dropInstallParam(slot.code);
  slot = null;
  emit();
}

/** Marks an address whose hash was pointed at Home for the Home Screen app (see startAtHome). */
const START_HASH = '#/?from=install';

/**
 * The Home Screen app starts at the address Safari shows when it is added, hash included, so
 * point that at Home rather than at this page (otherwise the app would open on 我的 every time).
 * The router is not told, so this page stays on screen; "?from=install" keeps the hash different
 * from "#/", so a tap on Home still changes it and navigates.
 */
function startAtHome(): void {
  const u = new URL(location.href);
  if (u.hash === '' || u.hash === '#' || u.hash === '#/') return;
  u.hash = START_HASH;
  history.replaceState(history.state, '', u.toString());
}

/** Take a used or expired install code out of the address, so a later Add to Home Screen does not carry it. */
function dropInstallParam(code: string): void {
  const u = new URL(location.href);
  let changed = false;
  if (u.searchParams.get('install') === code) {
    u.searchParams.delete('install');
    changed = true;
  }
  if (u.hash === START_HASH) {
    // Still on the page that made the code: give the address its real hash back.
    const r = getRoute();
    const q = r.query.toString();
    u.hash = '#' + r.path + (q ? '?' + q : '');
    changed = true;
  }
  if (changed) history.replaceState(history.state, '', u.toString());
}

/** Whole seconds until `deadline` (0 once passed), ticking every second. */
export function useSecondsLeft(deadline: number | null): number {
  const calc = () => (deadline === null ? 0 : Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
  const [left, setLeft] = useState(calc);
  useEffect(() => {
    setLeft(calc());
    if (deadline === null) return;
    const id = setInterval(() => {
      const v = calc();
      setLeft(v);
      if (v <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
    // calc only depends on deadline
  }, [deadline]);
  return left;
}

/** 9:05 */
export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * While `active`, poll this account's sessions (every 4 s while the page is visible) and call
 * `onNew` once for the first session that was not in `baseline` (the new device signed in).
 */
export function useNewSessionWatcher(active: boolean, baseline: readonly string[] | null, onNew: (s: SessionDTO) => void): void {
  const latest = useRef({ baseline, onNew });
  useEffect(() => {
    latest.current = { baseline, onNew };
  });
  useEffect(() => {
    if (!active) return;
    let known: Set<string> | null = latest.current.baseline ? new Set(latest.current.baseline) : null;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === 'visible') {
        try {
          const list = await actions.listSessions();
          if (!alive) return;
          if (!known) {
            known = new Set(list.map(x => x.id));
          } else {
            const fresh = list.find(x => !x.current && !known!.has(x.id));
            if (fresh) {
              latest.current.onNew(fresh);
              return;
            }
          }
        } catch {
          /* no connection for a moment: try again on the next tick */
        }
      }
      timer = setTimeout(() => void tick(), 4000);
    };
    timer = setTimeout(() => void tick(), 4000);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [active]);
}
