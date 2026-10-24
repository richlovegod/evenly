// The software keyboard and the visual viewport, read one way across the app (DESIGN.md 9.5).
//
// iOS WebKit lays out position: fixed against the layout viewport. A keyboard, or a keyboard
// inset the web view kept after the keyboard left (open WebKit and Chromium bugs on iOS 26 and
// 27), shortens only the visual viewport. The layout viewport then stays put until the visual
// viewport pushes its edge, and it never leaves the document (WebKit: WebPageProxyCocoa.mm
// computeLayoutViewportRect, LocalFrameView::computeUpdatedLayoutViewportRect). So in that state
// visualViewport.offsetTop is the gap between the layout viewport's bottom and the screen's
// bottom, and the page can rest scrolled past its end by up to the inset.
//
// Plain functions over a snapshot, so tests can feed numbers, and the watchers that use them:
// watchTyping (the add sheet's keypad and save bar), startFixedShift (the tab bar) and
// installRootScrollGuard (once, from main.tsx, on iOS).

/** The visual viewport is at least this much shorter than the window: a keyboard is up (as in Sheet.tsx and Toaster.tsx). */
export const KB_UP = 120;
/** The save bar's height (ExpenseEditorPage.module.css .saveBar): bottomInset() never lifts it closer to the top than this. */
const BAR_MIN = 56;
/** How often watchTyping looks again while a text field is focused on a touch screen, ms. */
const POLL_MS = 1000;
/** How long the page must be still before the root scroll guard puts it back, ms. */
const GUARD_MS = 350;
/** Past the end by at most this much is rounding, not a leftover inset, px. */
const PAST_SLACK = 2;
/** After the root scroll guard's scroll, how long the tab bar waits at most for the browser's new numbers, ms (it takes a frame or two). */
const HOLD_MS = 300;
/** Sent on window when the root scroll guard puts the page back; detail.px is how far (startFixedShift and the ?debug=vv overlay listen). */
export const GUARD_EVENT = 'evenly:vvguard';

export interface ViewportSnap {
  innerHeight: number;
  vv: { height: number; offsetTop: number; scale: number } | null;
}

export function readViewport(win: Pick<Window, 'innerHeight' | 'visualViewport'> = window): ViewportSnap {
  const vv = win.visualViewport;
  return { innerHeight: win.innerHeight, vv: vv ? { height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale || 1 } : null };
}

/** Pinch-zoomed: the scale is not about 1, so the visual viewport's numbers say nothing about a keyboard. */
export function pinchZoomed(s: ViewportSnap): boolean {
  return !!s.vv && Math.abs(s.vv.scale - 1) >= 0.01;
}

/** How much shorter the visual viewport is than the window, px: the keyboard. Null: unknown (no visualViewport, or zoomed). */
export function keyboardCover(s: ViewportSnap): number | null {
  if (!s.vv || pinchZoomed(s)) return null;
  return Math.max(0, Math.round(s.innerHeight - s.vv.height));
}

/**
 * From the layout viewport's bottom up to the visual viewport's bottom, px: where a bar riding the
 * keyboard puts its bottom edge. Never so high that the save bar (56 px) leaves the screen at the
 * top, whatever a browser reports; a real keyboard, landscape included, always leaves more than
 * that, so it is never lowered.
 */
export function bottomInset(s: ViewportSnap): number {
  if (!s.vv) return 0;
  const inset = Math.max(0, Math.round(s.innerHeight - (s.vv.height + s.vv.offsetTop)));
  return Math.min(inset, Math.max(0, Math.round(s.innerHeight) - BAR_MIN));
}

/**
 * How far a position: fixed; bottom: 0 bar must move down to sit on the bottom of the screen, px:
 * visualViewport.offsetTop, but only while the visual viewport is a keyboard short (a real keyboard,
 * or the inset the web view kept after one) at scale 1. Otherwise 0, so a stray small offsetTop
 * (iOS 26.0 reported 24 with no keyboard) never moves the bar.
 */
export function fixedShift(s: ViewportSnap): number {
  const cover = keyboardCover(s);
  if (!s.vv || cover === null || cover < KB_UP) return 0;
  return Math.min(Math.round(s.innerHeight), Math.max(0, Math.round(s.vv.offsetTop)));
}

// ---------- which fields count ----------

/** Input types that never bring up the system keyboard (as in Toaster.tsx). */
const NO_KEYBOARD = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

/**
 * The add sheet's text field rule (its keypad hides while one has focus): any input but a
 * checkbox, radio, button or file picker (the receipt photo), and any textarea. The editor passes
 * it to watchTyping without its keypad's own amount input. By tag name, like the editor's onKey.
 */
export function isTypingField(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file'].includes((el as HTMLInputElement).type);
}

/**
 * A field the system keyboard comes up for (Toaster.tsx keyboardField, by tag name): a text-like
 * input that is not read-only or inputmode none (the add sheet's amount), a textarea that is not
 * read-only, or contenteditable.
 */
export function keyboardField(el: Element | null): el is HTMLElement {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly;
  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement;
    return !input.readOnly && input.inputMode !== 'none' && !NO_KEYBOARD.has(input.type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * Someone is typing right now: a keyboard field is document.activeElement, matches :focus, and the
 * page itself has focus. A field can stay activeElement after the page lost focus (Chrome for iOS's
 * own keyboard button, its address bar), and WebKit then neither matches :focus nor reports
 * hasFocus(), so all three are asked.
 */
export function realTyping(doc: Document = document): boolean {
  const a = doc.activeElement;
  return keyboardField(a) && a.matches(':focus') && doc.hasFocus();
}

// ---------- the add sheet: is someone typing ----------

export interface TypingWatchOptions {
  /** The area whose text fields count (the add sheet's root). */
  root: HTMLElement;
  /** A text field there (the add sheet: isTypingField, without its keypad's amount input). */
  isField: (el: Element) => boolean;
  /** Read at every check: a mouse or trackpad now (typing is then focus alone, and nothing is blurred). */
  fine: () => boolean;
  onChange: (typing: boolean) => void;
  win?: Window;
  doc?: Document;
}

/**
 * Is someone typing in a text field inside `root` (DESIGN.md 9.5: the keypad hides and a save bar
 * rides the keyboard)? A focused text field there, while the page itself has focus and is on
 * screen; with a mouse, the focused field alone, as before.
 *
 * When Chrome for iOS closes the keyboard with its own button (it falls back to
 * [webView endEditing:YES]), its address bar or tab grid takes over, or the app goes to the
 * background, WebKit takes focus away from the page without blurring the field: it fires a
 * non-bubbling blur on the field and a window blur, and tells its UI process the field blurred,
 * but keeps the field as document.activeElement and sends no focusout. So this also follows the
 * page's focus (window blur and focus, visibilitychange, pageshow), and on a touch screen it then
 * blurs the field, so the DOM agrees with WebKit and nothing is focused again when the page comes
 * back. A page sees no event for some of these, so while a text field is focused on a touch screen
 * it also looks again every second (which also catches a focused field removed without focusout).
 * A keyboard going down while the field keeps focus (Android Back) does not end typing.
 * Returns a stop function that removes every listener and timer.
 */
export function watchTyping({ root, isField, fine, onChange, win = window, doc = document }: TypingWatchOptions): () => void {
  let typing = false;
  let frame = 0;
  let soon = 0;
  let blurTimer = 0;
  let poll = 0;

  /** document.hasFocus() has said true during this watch. A host that never says so (none is known;
   *  this guards in-app browsers) is not trusted to report page focus: typing there falls back to
   *  focus alone and nothing is blurred, so a field can always be typed in. */
  let sawFocus = false;

  const field = (): HTMLElement | null => {
    const a = doc.activeElement as HTMLElement | null;
    return a && a !== doc.body && root.contains(a) && isField(a) ? a : null;
  };
  /** The web view is first responder (iOS) or the window has focus, and the page is on screen. */
  const pageFocused = (): boolean => {
    if (doc.visibilityState === 'hidden') return false;
    if (doc.hasFocus()) return (sawFocus = true);
    return !sawFocus;
  };

  function check(): void {
    const f = field();
    const mouse = fine();
    const focused = pageFocused(); // read even with no field, so a focused page is learned early
    const next = !!f && (mouse || focused);
    if (next !== typing) {
      typing = next;
      onChange(typing);
    }
    const watching = !mouse && !!f;
    if (watching && !poll) poll = win.setInterval(tick, POLL_MS);
    else if (!watching && poll) {
      win.clearInterval(poll);
      poll = 0;
    }
  }
  function later(): void {
    if (!frame)
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        check();
      });
  }
  function afterFocusOut(): void {
    // Check once focus has landed: the next field's focusin may follow.
    win.clearTimeout(soon);
    soon = win.setTimeout(check, 0);
  }
  function lost(): void {
    check(); // the page is unfocused or hidden: typing ends now, whatever the viewport says
    if (fine()) return;
    win.clearTimeout(blurTimer);
    blurTimer = win.setTimeout(() => {
      blurTimer = 0;
      const f = field();
      // Only if the page is still away: a focus that came straight back keeps its field. On an
      // unfocused page WebKit skips the blur event and the UI-process call (it made both when focus
      // left) but still clears activeElement and fires focusout.
      if (f && !pageFocused()) f.blur();
      check();
    }, 0);
  }
  function tick(): void {
    if (field() && !pageFocused()) lost();
    else check();
  }
  const onVisibility = () => (doc.visibilityState === 'hidden' ? lost() : later());

  const vv = win.visualViewport;
  root.addEventListener('focusin', check);
  root.addEventListener('focusout', afterFocusOut);
  win.addEventListener('blur', lost);
  win.addEventListener('focus', later);
  win.addEventListener('resize', later);
  win.addEventListener('pageshow', later);
  doc.addEventListener('visibilitychange', onVisibility);
  vv?.addEventListener('resize', later);
  check();

  return () => {
    root.removeEventListener('focusin', check);
    root.removeEventListener('focusout', afterFocusOut);
    win.removeEventListener('blur', lost);
    win.removeEventListener('focus', later);
    win.removeEventListener('resize', later);
    win.removeEventListener('pageshow', later);
    doc.removeEventListener('visibilitychange', onVisibility);
    vv?.removeEventListener('resize', later);
    if (poll) win.clearInterval(poll);
    win.clearTimeout(soon);
    win.clearTimeout(blurTimer);
    if (frame) win.cancelAnimationFrame(frame);
  };
}

// ---------- the tab bar ----------

/**
 * Keeps the custom property --vv-shift on `el` (the phone tab bar) at fixedShift(): how far it must
 * move down from the layout viewport's bottom to sit on the bottom of the screen. Set on the bar
 * itself, not on <html>, so a change restyles one element instead of the whole document every
 * frame while it moves. Removed at 0, which is the normal case; above 0 only while the visual
 * viewport is a keyboard short: behind a real keyboard (as in native apps), and on the bottom of
 * the screen while the web view keeps a keyboard inset after the keyboard left (the page then
 * scrolls past its end, and a plain fixed bar rides up with it). Read at most once a frame.
 *
 * When the root scroll guard scrolls the page back (GUARD_EVENT, sent right after its scrollBy),
 * the bar takes the place that scroll gives it at once, in the same task, so the scroll and the
 * move reach the screen in one frame. WebKit applies the scroll in its next frame but reports the
 * new visual viewport a frame or two later, and the old offsetTop would meanwhile draw the bar
 * that far below the screen; so the reading from before the scroll is ignored until a different
 * one comes, or HOLD_MS passes. Returns a stop function that also removes the property.
 */
export function startFixedShift(el: HTMLElement, win: Window = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => undefined;
  const doc = win.document;
  let frame = 0;
  let shown = 0;
  /** After the guard's scroll: the reading from before it, which the browser may still report. */
  let held: number | null = null;
  let release = 0;
  const show = (px: number) => {
    if (px === shown) return;
    shown = px;
    if (px) el.style.setProperty('--vv-shift', `${px}px`);
    else el.style.removeProperty('--vv-shift');
  };
  const write = () => {
    frame = 0;
    const px = fixedShift(readViewport(win));
    if (px === held) return;
    held = null;
    show(px);
  };
  const later = () => {
    if (!frame) frame = win.requestAnimationFrame(write);
  };
  const onGuard = (e: Event) => {
    const back = (e as CustomEvent<{ px?: number }>).detail?.px ?? 0;
    if (!shown || !(back > 0)) return;
    // The page moved up by `back`, and the layout viewport stayed at the document's end: offsetTop,
    // and with it the shift, went down by as much.
    held = shown;
    show(Math.max(0, shown - back));
    win.clearTimeout(release);
    release = win.setTimeout(() => {
      // No new numbers came: go by what the browser says.
      release = 0;
      held = null;
      later();
    }, HOLD_MS);
  };
  write();
  vv.addEventListener('resize', later);
  vv.addEventListener('scroll', later);
  win.addEventListener('resize', later);
  win.addEventListener('scroll', later);
  win.addEventListener('pageshow', later);
  win.addEventListener(GUARD_EVENT, onGuard);
  doc.addEventListener('visibilitychange', later);
  return () => {
    vv.removeEventListener('resize', later);
    vv.removeEventListener('scroll', later);
    win.removeEventListener('resize', later);
    win.removeEventListener('scroll', later);
    win.removeEventListener('pageshow', later);
    win.removeEventListener(GUARD_EVENT, onGuard);
    doc.removeEventListener('visibilitychange', later);
    if (frame) win.cancelAnimationFrame(frame);
    win.clearTimeout(release);
    el.style.removeProperty('--vv-shift');
  };
}

// ---------- the page past its end ----------

/**
 * The safety net for a keyboard inset the web view kept after the keyboard left: WebKit then lets
 * the page come to rest scrolled past its end by up to the inset, a blank band under the last row.
 * Once the page has been still for 350 ms (no window scroll, visual viewport resize or scroll,
 * lifted finger or focusout since), with no finger down, at scale 1, no sheet holding the scroll
 * lock (html[data-locked]) and nobody typing (realTyping), it scrolls back by what is past the end
 * and sends GUARD_EVENT on window. Only a keyboard's space lets a page rest past its end, so a page
 * by itself never sets it off. A browser's own keyboard over a page nobody types in can (Android
 * Chrome's find in page, where the guard would scroll the match away), so main.tsx installs it on
 * iOS only, where the inset bug lives. Returns a stop function.
 */
export function installRootScrollGuard(win: Window = window, doc: Document = document): () => void {
  let timer = 0;
  let down = false;

  const settle = () => {
    timer = 0;
    if (down || realTyping(doc) || doc.documentElement.hasAttribute('data-locked')) return;
    const s = readViewport(win);
    if (pinchZoomed(s)) return; // a zoomed page pans around inside itself: not ours to move
    const vv = win.visualViewport;
    const top = vv ? vv.pageTop : win.scrollY;
    const past = Math.round(top + win.innerHeight - doc.documentElement.scrollHeight);
    if (past <= PAST_SLACK) return;
    win.scrollBy(0, -past);
    win.dispatchEvent(new CustomEvent(GUARD_EVENT, { detail: { px: past } }));
  };
  const soon = () => {
    win.clearTimeout(timer);
    timer = win.setTimeout(settle, GUARD_MS);
  };
  const onTouch = (e: Event) => {
    // touches lists the fingers still down; a touch event without one counts by its type.
    const touches = (e as TouchEvent).touches;
    down = touches ? touches.length > 0 : e.type === 'touchstart';
    if (!down) soon();
  };
  const touchOpts: AddEventListenerOptions = { passive: true, capture: true };

  const vv = win.visualViewport;
  win.addEventListener('scroll', soon);
  vv?.addEventListener('resize', soon);
  vv?.addEventListener('scroll', soon);
  win.addEventListener('touchstart', onTouch, touchOpts);
  win.addEventListener('touchend', onTouch, touchOpts);
  win.addEventListener('touchcancel', onTouch, touchOpts);
  doc.addEventListener('focusout', soon, true);

  return () => {
    win.removeEventListener('scroll', soon);
    vv?.removeEventListener('resize', soon);
    vv?.removeEventListener('scroll', soon);
    win.removeEventListener('touchstart', onTouch, touchOpts);
    win.removeEventListener('touchend', onTouch, touchOpts);
    win.removeEventListener('touchcancel', onTouch, touchOpts);
    doc.removeEventListener('focusout', soon, true);
    win.clearTimeout(timer);
  };
}
