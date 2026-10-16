// Sheet (DESIGN.md 8.15): a bottom sheet on phones (drag the grabber or header down past 30%
// or flick it, tap the scrim, press Escape, or tap 取消 to close), a sheet in the phone column
// on 600 to 899 px, and a centered dialog on desktop. Rendered in a portal; the page behind is
// locked (no scroll) and inert while it is open; focus moves in, stays in, and returns where it
// was. The container has data-testid="sheet"; the 取消 button (left of the title) has
// data-testid="sheet-close". Put a confirming 完成 on the right with headerEnd and SheetTextButton.
//
// Also exports the overlay helpers Dialog uses: useOverlay (lock, inert, focus, Escape for the
// topmost layer only) and useViewportBox (follows the iOS keyboard via visualViewport).

import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { parseHash } from '../lib/router';
import s from './Sheet.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------- overlay stack: scroll lock, inert app root, Escape and focus ----------

const stack: number[] = [];
let seq = 0;
let locks = 0;
let saved: { y: number; style: string; path: string } | null = null;

/** The page on screen (hash path, no query). */
function pagePath(): string {
  return parseHash(location.hash).path;
}

function lockPage(): void {
  locks++;
  if (locks > 1) return;
  const body = document.body;
  const rect = body.getBoundingClientRect();
  saved = { y: window.scrollY, style: body.getAttribute('style') ?? '', path: pagePath() };
  // position: fixed is the lock iOS Safari respects; left and width keep the phone column in place
  body.style.position = 'fixed';
  body.style.top = `${-saved.y}px`;
  body.style.left = `${rect.left}px`;
  body.style.width = `${rect.width}px`;
  body.style.overflow = 'hidden';
  const root = document.getElementById('root');
  if (root) root.inert = true;
}

function unlockPage(): void {
  locks = Math.max(0, locks - 1);
  if (locks > 0) return;
  const body = document.body;
  const y = saved?.y ?? 0;
  // A layer that closes because the page changed (Back while a dialog was open, a sheet item
  // that navigates) leaves the new page at its top, not at the old page's scroll position.
  const samePage = saved?.path === pagePath();
  if (saved?.style) body.setAttribute('style', saved.style);
  else body.removeAttribute('style');
  saved = null;
  if (samePage) window.scrollTo(0, y);
  const root = document.getElementById('root');
  if (root) root.inert = false;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(n => n.getClientRects().length > 0);
}

export interface OverlayOptions {
  /** Escape pressed while this layer is on top. */
  onEscape?: () => void;
  /** Element to focus when the layer opens (default: an [autofocus] / [data-autofocus] element, else the container). */
  initialFocus?: () => HTMLElement | null;
  /** Where focus goes back on close (default: what had focus when the layer opened). Needed when
   *  a child autofocuses before the layer's effect runs. */
  returnTo?: () => HTMLElement | null;
}

/**
 * While `active`: locks the page scroll, makes #root inert, moves focus into `ref`, keeps Tab
 * inside it, routes Escape to the topmost layer, and on release puts focus back.
 */
export function useOverlay(active: boolean, ref: RefObject<HTMLElement | null>, options: OverlayOptions = {}): void {
  const opts = useRef(options);
  opts.current = options;
  useEffect(() => {
    if (!active) return;
    const id = ++seq;
    stack.push(id);
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previous = opts.current.returnTo?.() ?? (focused && !ref.current?.contains(focused) ? focused : null);
    lockPage();
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      const target = opts.current.initialFocus?.() ?? el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? el;
      target.focus({ preventScroll: true });
    }
    function onKey(e: KeyboardEvent) {
      if (stack[stack.length - 1] !== id) return;
      const box = ref.current;
      if (e.key === 'Escape') {
        if (opts.current.onEscape) {
          e.preventDefault();
          e.stopPropagation();
          opts.current.onEscape();
        }
      } else if (e.key === 'Tab' && box) {
        const list = focusables(box);
        if (!list.length) {
          e.preventDefault();
          box.focus();
          return;
        }
        const first = list[0];
        const last = list[list.length - 1];
        const now = document.activeElement;
        if (e.shiftKey && (now === first || now === box || !box.contains(now))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (now === last || !box.contains(now))) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
      unlockPage();
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [active, ref]);
}

export interface ViewportBox {
  /** Visual viewport offset from the top of the layout viewport, px. */
  top: number;
  /** Visual viewport height, px. */
  height: number;
  /** The software keyboard (or something like it) takes the bottom of the screen. */
  keyboard: boolean;
}

/** The visible part of the screen, updated when the iOS keyboard or browser toolbars move. */
export function useViewportBox(active: boolean): ViewportBox | null {
  const [box, setBox] = useState<ViewportBox | null>(null);
  useEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const keyboard = window.innerHeight - vv.height > 120;
      setBox(prev => (prev && prev.top === vv.offsetTop && prev.height === vv.height && prev.keyboard === keyboard ? prev : { top: vv.offsetTop, height: vv.height, keyboard }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [active]);
  return active ? box : null;
}

/** Inline style for a fixed overlay root that should cover exactly the visible viewport. */
export function viewportStyle(box: ViewportBox | null): CSSProperties | undefined {
  if (!box) return undefined;
  return { top: box.top, height: box.height, ['--vv-h' as string]: `${box.height}px` } as CSSProperties;
}

// ---------- Sheet ----------

/** A header text button in the sheet style (17 px, 44 px tall), e.g. a confirming 完成 on the right. */
export function SheetTextButton({ className, type, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...rest} type={type ?? 'button'} className={cx(s.textBtn, s.strong, className)} />;
}

export interface SheetProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  /** Sticks to the bottom, above the home indicator (and above the keyboard). */
  footer?: ReactNode;
  /** auto: as tall as the content (up to the screen); full: the full height. */
  size?: 'auto' | 'full';
  /** false: no scrim tap, Escape, drag or 取消 (the content must offer a way out). */
  dismissible?: boolean;
  /** Left of the title, instead of the 取消 button. */
  headerStart?: ReactNode;
  /** Right of the title (e.g. a confirming 完成: <SheetTextButton>). */
  headerEnd?: ReactNode;
  /** Leave out the 取消 button (when headerStart or headerEnd already closes). */
  hideClose?: boolean;
  /** Label of the close button (default 取消 / Cancel; e.g. 關閉 / Close for a sheet that only shows something). */
  closeLabel?: string;
  /** Accessible name when there is no visible title. */
  label?: string;
  /** No side padding in the body (custom full-width content). */
  flush?: boolean;
  bodyClassName?: string;
  className?: string;
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'auto',
  dismissible = true,
  headerStart,
  headerEnd,
  hideClose,
  closeLabel,
  label,
  flush,
  bodyClassName,
  className,
  ...rest
}: SheetProps) {
  const { t } = useT();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const box = useViewportBox(mounted);
  const close = useRef(onClose);
  close.current = onClose;

  // Remember what had focus when the sheet opened, before any autofocus child takes it.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined') {
    const el = document.activeElement;
    opener.current = el instanceof HTMLElement && el !== document.body ? el : null;
  }
  wasOpen.current = open;

  // Mount on open; on close play the exit, then unmount.
  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 260);
    return () => clearTimeout(timer);
  }, [open]); // `mounted` is read, not watched: only a change of `open` starts or stops the exit

  useOverlay(open && mounted, panel, {
    onEscape: dismissible ? () => close.current() : undefined,
    returnTo: () => opener.current,
  });

  // ---- drag the header down to dismiss ----
  const drag = useRef<{ y0: number; t0: number; dy: number; moving: boolean; id: number } | null>(null);
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dismissible || e.button !== 0 || window.matchMedia('(min-width: 900px)').matches) return;
    drag.current = { y0: e.clientY, t0: e.timeStamp, dy: 0, moving: false, id: e.pointerId };
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    const el = panel.current;
    if (!d || d.id !== e.pointerId || !el) return;
    const dy = e.clientY - d.y0;
    if (!d.moving) {
      if (dy < 6) return;
      d.moving = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      el.style.transition = 'none';
    }
    d.dy = Math.max(0, dy);
    el.style.transform = `translateY(${d.dy}px)`;
  }
  function onPointerEnd(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    const el = panel.current;
    drag.current = null;
    if (!d || !d.moving || !el) return;
    const speed = d.dy / Math.max(1, e.timeStamp - d.t0);
    el.style.transition = '';
    // DESIGN.md 8.15: past 30% of the sheet, or faster than 500 px/s
    if (d.dy > el.offsetHeight * 0.3 || speed > 0.5) {
      close.current();
    } else {
      el.style.transform = '';
    }
  }

  if (!mounted || typeof document === 'undefined') return null;

  const showClose = dismissible && !hideClose && !headerStart;
  const hasHead = !!title || !!headerStart || !!headerEnd || showClose;
  const passedTestId = (rest as Record<string, unknown>)['data-testid'];
  const panelRest = { ...rest } as Record<string, unknown>;
  delete panelRest['data-testid'];

  return createPortal(
    <div
      className={cx(s.root, closing && s.closing, box?.keyboard && s.kb)}
      style={viewportStyle(box)}
      aria-hidden={closing || undefined}
    >
      <div className={s.scrim} onClick={dismissible && !closing ? () => close.current() : undefined} />
      <div
        {...(panelRest as HTMLAttributes<HTMLDivElement>)}
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : label}
        tabIndex={-1}
        data-testid="sheet"
        data-sheet={typeof passedTestId === 'string' ? passedTestId : undefined}
        className={cx(s.panel, size === 'full' && s.full, footer ? s.withFoot : undefined, flush && s.flush, className)}
        onAnimationEnd={e => {
          if (closing && e.target === e.currentTarget) {
            setMounted(false);
            setClosing(false);
          }
        }}
      >
        <div
          className={cx(s.drag, !hasHead && s.noHead)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          {dismissible ? <span className={s.grabber} aria-hidden="true" /> : null}
          {hasHead ? (
            <div className={s.head}>
              <div className={s.start}>
                {headerStart ??
                  (showClose ? (
                    <button type="button" className={s.textBtn} data-testid="sheet-close" onClick={() => close.current()}>
                      {closeLabel ?? t('取消', 'Cancel')}
                    </button>
                  ) : null)}
              </div>
              <h2 id={titleId} className={s.title}>{title}</h2>
              <div className={s.end}>{headerEnd}</div>
            </div>
          ) : null}
        </div>
        <div className={cx(s.body, bodyClassName)}>{children}</div>
        {footer ? <div className={s.foot}>{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
