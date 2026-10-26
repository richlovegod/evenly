// autoFocus for our fields, through lib/viewport.ts focusFromScript (DESIGN.md 9.5). React's own
// autoFocus calls focus() as the field mounts, which is after a route change, an await or a step
// change as often as inside a tap; on iOS such a focus leaves the field focused with no keyboard
// (the tab bar stranded over a blank band, and the root scroll guard waiting for typing that never
// comes). So TextField, AmountInput and the fields with no component of their own take this
// instead: with a mouse the field is focused as it mounts, as autoFocus did; on a touch screen it
// is not, and a tap on it raises the keyboard.

import { useLayoutEffect, type RefObject } from 'react';
import { focusFromScript } from './viewport';

/**
 * On mount, when `on` (read once, as React reads autoFocus): focus the field in `ref` through
 * focusFromScript. In a layout effect, the commit phase React's autoFocus focused in, so a sheet's
 * useOverlay, whose effect runs after it, still finds the field focused with a mouse and leaves it.
 * Refused on a touch screen, focus stays where it is, unless it was lost (the button that showed
 * this field went with the step before it, as EmailSheet's 寄驗證碼 does): inside a sheet or
 * dialog its container then takes focus, so a screen reader stays in there.
 */
export function useAutoFocus(ref: RefObject<HTMLElement | null>, on: boolean | undefined): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el || focusFromScript(el)) return;
    const doc = el.ownerDocument;
    const a = doc.activeElement;
    const lost = !a || a === doc.body || !a.isConnected;
    const box = el.closest<HTMLElement>('[aria-modal="true"]');
    if (lost && box) box.focus({ preventScroll: true });
  }, []); // once, on mount: React's autoFocus never focused again on a later render
}
