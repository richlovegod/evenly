// Toast queue (one visible at a time). Rendered by components/Toaster.tsx.

import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
  /** Milliseconds; 0 = stays until dismissed. Default 4000, 6000 with an action. */
  duration: number;
}

let toasts: Toast[] = [];
let seq = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const l of listeners) l();
}

export function showToast(t: { message: string; kind?: Toast['kind']; action?: Toast['action']; duration?: number }): number {
  const id = seq++;
  const duration = t.duration ?? (t.action ? 6000 : 4000);
  toasts = [...toasts.slice(-2), { id, message: t.message, kind: t.kind ?? 'info', action: t.action, duration }];
  emit();
  if (duration > 0) timers.set(id, setTimeout(() => dismissToast(id), duration));
  return id;
}

export function dismissToast(id: number): void {
  const tm = timers.get(id);
  if (tm) clearTimeout(tm);
  timers.delete(id);
  const next = toasts.filter(t => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts, () => toasts);
}
