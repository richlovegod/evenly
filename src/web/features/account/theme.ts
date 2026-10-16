// 外觀 (DESIGN.md 11): follow the system, or always light or dark. The choice is kept on this
// device and set as <html data-theme>, which tokens.css reads. AppShell watches that attribute
// and keeps <meta name="theme-color"> on the printer band's color.

import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'evenly.theme';

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* storage unavailable: follow the system */
  }
  return 'system';
}

let choice: ThemeChoice = read();
const listeners = new Set<() => void>();

function setAttribute(): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function setTheme(next: ThemeChoice): void {
  if (next === choice) return;
  choice = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* the choice still applies until the page reloads */
  }
  setAttribute();
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribe, () => choice, () => choice);
}

/**
 * Put the saved choice on <html>. Safe to call more than once. It runs when this module loads,
 * which is at app start because App.tsx imports the account page eagerly; main.tsx (or an inline
 * script in index.html, to avoid a flash) can call it explicitly instead.
 */
export function applySavedTheme(): void {
  if (typeof document === 'undefined') return;
  choice = read();
  setAttribute();
}

applySavedTheme();
