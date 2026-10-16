// Toaster (DESIGN.md 8.16): shows lib/toast's newest toast (one at a time) with its action
// (復原, 重試...). Portaled to <body> so it stays usable while a sheet makes the app inert.
// Toasts left at lib/toast's default length follow the design: 3 s, or 5 s with an action;
// an explicit duration is kept. Swipe down (or sideways) to dismiss; toasts that stay
// (duration 0) get a close button.
//
// Time (WCAG 2.2.1): the countdown stops while the toast is pointed at or holds focus, and a toast
// held that way stays up even after lib/toast's own timer lets it go; it closes once the rest of
// its time has run out. If it closes while focus is inside it, focus goes back where it came from
// (or to the page's #main), never to <body>.
// Screen readers (WCAG 4.1.3): two live regions are always in the page, polite and (for errors)
// assertive. Each new toast's words are written into one of them once, so they are read out (a
// region that appears together with its text often is not), a toast shown again after a newer
// one closes is not read twice, and the same words twice in a row (已複製) are read both times.
// The strip itself carries no role, so nothing is read twice.
// Look (Toaster.module.css): the award site's grass pill (coral tint for errors), centered.
// Where: above the bottom bar and its 記一筆 pill; on a full-screen page on a phone, 12 px above
// what the page pins to the bottom of the screen (the add sheet's register, a page's bottom bar),
// so its header (取消, the title, the group button) stays free; at the top when nothing is pinned
// there or while the keyboard is up.
// Test ids: toast, toast-action.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { t as translate, useT } from '../lib/i18n';
import { dismissToast, useToasts, type Toast } from '../lib/toast';
import { Icon, type IconName } from './Icon';
import s from './Toaster.module.css';

const ICON: Record<Toast['kind'], IconName> = { info: 'info', success: 'check', error: 'warning' };

/** How long a toast shows, in ms: lib/toast's defaults (4 s, 6 s with an action) map to the
 *  design's 3 s and 5 s, an explicit duration is kept; null: until it is closed. */
function shownFor(toast: Toast): number | null {
  if (!toast.action && toast.duration === 4000) return 3000;
  if (toast.action && toast.duration === 6000) return 5000;
  return toast.duration > 0 ? toast.duration : null;
}

/** What the live region says: the message, and the action when there is one. */
function spoken(toast: Toast): string {
  if (!toast.action) return toast.message;
  const m = toast.message.replace(/[。.]\s*$/, '');
  return translate('{m}，可以按「{a}」', '{m}. You can choose {a}.', { m, a: toast.action.label });
}

const SILENT = { polite: '', assertive: '' };

export function Toaster() {
  const toasts = useToasts();
  const newest = toasts[toasts.length - 1];
  // The toast being pointed at or focused, kept on screen even once lib/toast has dropped it.
  const [held, setHeld] = useState<Toast | null>(null);
  const current = held && (!newest || newest.id <= held.id) ? held : newest;
  const region = useRef<HTMLDivElement>(null);

  // A newer toast takes the place of the one being held.
  useEffect(() => {
    if (held && newest && newest.id > held.id) setHeld(null);
  }, [held, newest]);

  const hold = useCallback((toast: Toast) => setHeld(h => (h?.id === toast.id ? h : toast)), []);
  const close = useCallback((id: number) => {
    setHeld(h => (h?.id === id ? null : h));
    dismissToast(id);
  }, []);

  // ----- read each toast out once -----
  const [live, setLive] = useState(SILENT);
  const announced = useRef<number[]>([]);
  const currentId = current?.id;
  useEffect(() => {
    // Nothing on screen, or a toast already read out shown again: say nothing new, and leave no
    // stale words in the region for someone moving through the page.
    if (!current || announced.current.includes(current.id)) {
      setLive(SILENT);
      return;
    }
    announced.current = [...announced.current.slice(-19), current.id];
    const words = spoken(current);
    const assertive = current.kind === 'error';
    // Empty first, the words a moment later: WebKit reads the same text again only after the
    // region has been empty for 100 ms or more.
    setLive(SILENT);
    const timer = setTimeout(() => setLive(assertive ? { polite: '', assertive: words } : { polite: words, assertive: '' }), 150);
    return () => clearTimeout(timer);
  }, [currentId]); // once per toast shown, not on every render

  usePinnedPlacement(region, !!current);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{live.polite}</div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{live.assertive}</div>
      <div ref={region} className={s.region}>
        {current ? <ToastView key={current.id} toast={current} onHold={hold} onClose={close} /> : null}
      </div>
    </>,
    document.body,
  );
}

function ToastView({ toast, onHold, onClose }: { toast: Toast; onHold: (toast: Toast) => void; onClose: (id: number) => void }) {
  const { t } = useT();
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);

  // ----- the countdown, stopped while the toast is pointed at or holds focus -----
  const ms = shownFor(toast);
  const left = useRef(ms ?? 0);
  const pointed = useRef(false);
  const focused = useRef(false);
  const [paused, setPaused] = useState(false);
  const recheck = () => {
    const p = pointed.current || focused.current;
    if (p) onHold(toast);
    setPaused(p);
  };
  useEffect(() => {
    if (ms === null || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => onClose(toast.id), Math.max(0, left.current));
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - started;
    };
  }, [ms, paused, toast.id, onClose]);

  // ----- focus: closing with focus inside hands it back to where it came from -----
  const cameFrom = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const node = el.current;
    return () => {
      if (!node || !node.contains(document.activeElement)) return;
      const back = [cameFrom.current, document.getElementById('main')].find(
        (n): n is HTMLElement => !!n && n.isConnected && !n.closest('[inert]'),
      );
      back?.focus({ preventScroll: true });
    };
  }, []);

  function reset() {
    const node = el.current;
    if (!node) return;
    node.style.transform = '';
    node.style.opacity = '';
  }

  return (
    <div
      ref={el}
      className={`${s.toast} ${toast.kind === 'error' ? s.error : ''}`}
      data-testid="toast"
      data-kind={toast.kind}
      onPointerEnter={() => {
        pointed.current = true;
        recheck();
      }}
      onPointerLeave={() => {
        pointed.current = false;
        recheck();
      }}
      onFocus={e => {
        if (!focused.current) {
          const from = e.relatedTarget;
          cameFrom.current = from instanceof HTMLElement && !e.currentTarget.contains(from) ? from : null;
        }
        focused.current = true;
        recheck();
      }}
      onBlur={e => {
        const to = e.relatedTarget;
        if (to instanceof Node && e.currentTarget.contains(to)) return;
        focused.current = false;
        recheck();
      }}
      onPointerDown={e => {
        if ((e.target as HTMLElement).closest('button')) return;
        drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const d = drag.current;
        const node = el.current;
        if (!d || d.id !== e.pointerId || !node) return;
        const dx = e.clientX - d.x;
        const dy = Math.max(0, e.clientY - d.y);
        node.style.transform = `translate(${dx}px, ${dy}px)`;
        node.style.opacity = String(Math.max(0.2, 1 - Math.max(Math.abs(dx), dy) / 160));
      }}
      onPointerUp={e => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const dx = Math.abs(e.clientX - d.x);
        const dy = e.clientY - d.y;
        if (dx > 70 || dy > 36) onClose(toast.id);
        else reset();
      }}
      onPointerCancel={() => {
        drag.current = null;
        reset();
      }}
    >
      <Icon name={ICON[toast.kind]} />
      <span className={s.message}>{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className={s.action}
          data-testid="toast-action"
          onClick={() => {
            const run = toast.action?.run;
            onClose(toast.id);
            run?.();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      {toast.duration === 0 ? (
        <button type="button" className={s.close} aria-label={t('關閉', 'Close')} onClick={() => onClose(toast.id)}>
          <Icon name="close" size={20} />
        </button>
      ) : null}
    </div>
  );
}

// ---------- where the toast sits on a full-screen page ----------

const PHONE = '(max-width: 899.98px)';
const NO_KEYBOARD = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

/** A field the on-screen keyboard comes up for (the add sheet's amount, inputmode none, is not). */
function keyboardField(el: Element | null): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) return !el.readOnly && el.inputMode !== 'none' && !NO_KEYBOARD.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * On a full-screen page (no bottom bar) on a phone: how far above the bottom of the layout
 * viewport the toast's lower edge goes, 12 px over what the page pins to the bottom of the screen.
 * That is the outermost box under the bottom middle of the screen that is at most half the screen
 * tall and ends on its bottom edge: the add sheet's register, its save bar, a page's bottom bar.
 * Found by walking down the page's own boxes (not by hit testing, which skips the app while a
 * sheet makes it inert), so sheets and dialogs over the page never move the toast. The box's
 * height, not its top, sets the place, so a sheet still rising into place gives the final one.
 * Null: keep the stylesheet's place (above the bottom bar, else at the top), also while the iOS
 * keyboard is up and when the toast would cover the field being typed in.
 */
function pinnedOffset(region: HTMLElement): number | null {
  const html = document.documentElement;
  if (html.hasAttribute('data-tabbar') || !window.matchMedia(PHONE).matches) return null;
  const root = document.getElementById('root');
  if (!root) return null;
  const vv = window.visualViewport;
  // The iOS keyboard takes the bottom of the screen (as in Sheet's useViewportBox).
  if (vv && window.innerHeight - vv.height > 120) return null;
  const viewH = vv ? vv.height : window.innerHeight;
  const viewB = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const x = window.innerWidth / 2;
  const y = viewB - 2;
  let node: Element = root;
  for (let depth = 0; depth < 32; depth++) {
    let next: Element | null = null;
    let box: DOMRect | null = null;
    for (let i = node.children.length - 1; i >= 0 && !next; i--) {
      const r = node.children[i].getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
        next = node.children[i];
        box = r;
      }
    }
    if (!next || !box) return null;
    // Up to 40 px under the edge: the add sheet rises 32 px into place.
    if (box.height <= viewH / 2 && box.bottom >= viewB - 2 && box.bottom <= viewB + 40) {
      const gap = parseFloat(getComputedStyle(html).getPropertyValue('--toast-gap')) || 12;
      const offset = Math.round(window.innerHeight - viewB + box.height + gap);
      // Never over the field being typed in (a save bar riding the keyboard has it right above).
      const a = document.activeElement;
      if (keyboardField(a)) {
        const f = a.getBoundingClientRect();
        const lower = window.innerHeight - offset;
        if (f.bottom > lower - region.offsetHeight - 4 && f.top < lower + 4) return null;
      }
      return offset;
    }
    node = next;
  }
  return null;
}

/** While a toast shows, keeps the region at pinnedOffset(): again whenever the page changes, the
 *  screen or the visible viewport resizes, focus moves (the keyboard) or an animation ends. */
function usePinnedPlacement(region: RefObject<HTMLDivElement | null>, showing: boolean): void {
  useLayoutEffect(() => {
    const el = region.current;
    if (!el || !showing) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const offset = pinnedOffset(el);
      el.style.top = offset === null ? '' : 'auto';
      el.style.bottom = offset === null ? '' : `${offset}px`;
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    const watch = new MutationObserver(later);
    const root = document.getElementById('root');
    if (root) watch.observe(root, { childList: true, subtree: true });
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tabbar'] });
    const vv = window.visualViewport;
    const events = ['focusin', 'focusout', 'animationend', 'transitionend'] as const;
    window.addEventListener('resize', later);
    vv?.addEventListener('resize', later);
    for (const name of events) document.addEventListener(name, later);
    return () => {
      watch.disconnect();
      window.removeEventListener('resize', later);
      vv?.removeEventListener('resize', later);
      for (const name of events) document.removeEventListener(name, later);
      if (frame) cancelAnimationFrame(frame);
      el.style.top = '';
      el.style.bottom = '';
    };
  }, [region, showing]);
}
