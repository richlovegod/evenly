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
// watchTyping (the add sheet's keypad and save bar), installFocusRelease (every other page, once,
// from main.tsx), startFixedShift (the tab bar) and installRootScrollGuard (once, from main.tsx, on
// iOS). focusFromScript keeps our own code from focusing a text field with no keyboard on a touch
// screen in the first place.

/** The visual viewport is at least this much shorter than the window: a keyboard is up (as in Sheet.tsx and Toaster.tsx). */
export const KB_UP = 120;
/** The save bar's height (ExpenseEditorPage.module.css .saveBar): bottomInset() never lifts it closer to the top than this. */
const BAR_MIN = 56;
/** How often watchTyping and installFocusRelease look again while a text field is focused on a touch screen, ms. */
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

// ---------- focus from script ----------

/** A mouse or trackpad now: `(pointer: fine)`, read at the call. With no window or no matchMedia, false (a touch screen). */
export function finePointer(win: Pick<Window, 'matchMedia'> | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  return !!win?.matchMedia?.('(pointer: fine)').matches;
}

export interface ScriptFocusOptions extends FocusOptions {
  /** Read at the call: a mouse or trackpad now (default finePointer). */
  fine?: () => boolean;
}

/**
 * The one way our code moves focus from script, outside a tap (DESIGN.md 9.5): sheets and dialogs
 * as they open and close (Sheet.tsx useOverlay), fields that focus themselves when a page, sheet or
 * step appears (lib/autoFocus.ts useAutoFocus), and the rest that run after a timer or an await.
 * On a touch screen (`fine`, read at the call, says false) a keyboard field (keyboardField) is
 * never focused this way. iOS raises the keyboard only for a focus inside the tap's own handler,
 * so any other focus leaves the field focused with no keyboard: realTyping() then says someone
 * types, the root scroll guard keeps the page past its end, sheets follow a stale visual viewport,
 * and the tab bar strands mid-screen over a keyboard-sized blank band, as Gino hit twice. Anything
 * else (a button, a heading, a sheet's container, the add sheet's amount with inputmode none), and
 * every element with a mouse, is focused as before. Returns whether `el` has focus afterwards;
 * false tells the caller to focus a container instead or leave focus where it is.
 */
export function focusFromScript(el: HTMLElement | null | undefined, { fine = finePointer, ...options }: ScriptFocusOptions = {}): boolean {
  if (!el) return false;
  if (keyboardField(el) && !fine()) return false;
  el.focus(options);
  return el.ownerDocument.activeElement === el;
}

/**
 * A sheet or dialog opening (Sheet.tsx useOverlay): `target` (its initialFocus, an [autofocus] or
 * [data-autofocus] element, or `box` itself) takes focus through focusFromScript. Refused (a
 * keyboard field on a touch screen: Dialog's prompt input, CurrencyPicker's search) or unable to
 * take it, the container `box` takes it instead, so a screen reader starts inside the layer and no
 * field holds focus with no keyboard; a tap on the field raises the keyboard as it focuses it.
 */
export function focusLayerOpen(box: HTMLElement, target: HTMLElement | null, options: ScriptFocusOptions = {}): void {
  if (target && target !== box && focusFromScript(target, options)) return;
  box.focus({ preventScroll: options.preventScroll });
}

/**
 * A sheet or dialog closing (useOverlay): focus goes back to `previous`, what had it when the layer
 * opened, through focusFromScript, if it is still in the page. A keyboard field on a touch screen
 * is refused (the 留言 field someone typed in before a sheet or dialog opened over it; focused
 * again here it would hold focus with no keyboard): if it lies in a sheet or dialog that stays open
 * (one under `box`), that one's container takes focus, for screen readers; otherwise focus stays
 * where it is.
 */
export function focusLayerReturn(box: HTMLElement | null, previous: HTMLElement | null, options: ScriptFocusOptions = {}): void {
  if (!previous || !previous.isConnected || focusFromScript(previous, options)) return;
  const under = previous.closest<HTMLElement>('[aria-modal="true"]');
  if (under && under !== box && !box?.contains(under)) under.focus({ preventScroll: options.preventScroll });
}

// ---------- a field the page lost focus with ----------

/** The page's own focus, read one way by watchTyping and installFocusRelease (one per watch). */
interface PageFocus {
  /** The web view is first responder (iOS) or the window has focus, and the page is on screen. */
  focused(): boolean;
  /** document.hasFocus() has said true during this watch. A host that never says so (none is known;
   *  this guards in-app browsers) is not trusted to report page focus: nothing is blurred there, so
   *  a field can always be typed in. */
  seen(): boolean;
}

function pageFocus(doc: Document): PageFocus {
  let sawFocus = false;
  return {
    focused() {
      if (doc.visibilityState === 'hidden') return false;
      if (doc.hasFocus()) return (sawFocus = true);
      return !sawFocus;
    },
    seen: () => sawFocus,
  };
}

/**
 * Blurs field() one task after the page lost focus, if the page is still away by then and has
 * reported focus before (PageFocus.seen), then calls `after`. soon() starts it again from the top;
 * cancel() drops it. Only if the page is still away: a focus that came straight back keeps its
 * field. On an unfocused page WebKit skips the blur event and the UI-process call (it made both when
 * focus left) but still clears activeElement and fires focusout.
 */
function fieldRelease(win: Window, field: () => HTMLElement | null, page: PageFocus, after: () => void) {
  let timer = 0;
  return {
    soon(): void {
      win.clearTimeout(timer);
      timer = win.setTimeout(() => {
        timer = 0;
        const f = field();
        if (f && !page.focused() && page.seen()) f.blur();
        after();
      }, 0);
    },
    cancel(): void {
      win.clearTimeout(timer);
      timer = 0;
    },
  };
}

/** The roots a watchTyping is running on (the add sheet's): installFocusRelease leaves their fields
 *  to it, so a lost page focus there sets one blur timer and one poll, not two. A list, not a set,
 *  so two watches on one root each keep their place. */
const typingRoots: HTMLElement[] = [];

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
 * A keyboard going down while the field keeps focus (Android Back) does not end typing. Where
 * document.hasFocus() never says true (PageFocus.seen), typing falls back to focus alone and nothing
 * is blurred. installFocusRelease leaves the fields in `root` to this watch while it runs.
 * Returns a stop function that removes every listener and timer.
 */
export function watchTyping({ root, isField, fine, onChange, win = window, doc = document }: TypingWatchOptions): () => void {
  let typing = false;
  let frame = 0;
  let soon = 0;
  let poll = 0;

  const page = pageFocus(doc);
  const field = (): HTMLElement | null => {
    const a = doc.activeElement as HTMLElement | null;
    return a && a !== doc.body && root.contains(a) && isField(a) ? a : null;
  };
  const release = fieldRelease(win, field, page, check);

  function check(): void {
    const f = field();
    const mouse = fine();
    const focused = page.focused(); // read even with no field, so a focused page is learned early
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
    if (!fine()) release.soon();
  }
  function tick(): void {
    if (field() && !page.focused()) lost();
    else check();
  }
  const onVisibility = () => (doc.visibilityState === 'hidden' ? lost() : later());

  const vv = win.visualViewport;
  typingRoots.push(root);
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
    const at = typingRoots.indexOf(root);
    if (at >= 0) typingRoots.splice(at, 1);
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
    release.cancel();
    if (frame) win.cancelAnimationFrame(frame);
  };
}

// ---------- every other page: let go of a field the page lost focus with ----------

/**
 * What watchTyping does for the add sheet, for every page (DESIGN.md 9.5): on a touch screen
 * (`fine`, read at every check, says false), a keyboard field (keyboardField) that is still
 * document.activeElement after the page lost focus is blurred, one task later and only if the page
 * is still away. Chrome for iOS's own keyboard button ([webView endEditing:YES]), its address bar
 * and tab grid, and an app switch leave the field focused with no focusout (watchTyping has the
 * details). WebKit then focuses that field again, with no keyboard, at the next tap on the page, so
 * realTyping() says someone types: the root scroll guard leaves the page resting past its end over
 * the blank band of a kept keyboard inset (the detail page's 留言 field, as in IMG_6978), and sheets
 * follow the stale visual viewport. Blurred, the field has nothing to come back to.
 *
 * It looks at a window blur and a visibilitychange to hidden, and while a keyboard field is focused
 * on a touch screen, every second (a page sees no event for some of these). With a mouse nothing is
 * blurred, nor where document.hasFocus() never says true (PageFocus.seen). Fields inside a root a
 * watchTyping runs on are left to it. Installed once, from main.tsx. Returns a stop function that
 * removes every listener and timer.
 */
export function installFocusRelease(fine: () => boolean, win: Window = window, doc: Document = document): () => void {
  let poll = 0;

  const page = pageFocus(doc);
  const field = (): HTMLElement | null => {
    const a = doc.activeElement;
    return keyboardField(a) && !typingRoots.some(r => r.contains(a)) ? a : null;
  };
  const release = fieldRelease(win, field, page, check);

  /** Runs the 1 s look while a keyboard field is focused on a touch screen, and only then. */
  function check(): void {
    page.focused(); // read even with no field, so a focused page is learned early
    const watching = !fine() && !!field();
    if (watching && !poll) poll = win.setInterval(tick, POLL_MS);
    else if (!watching && poll) {
      win.clearInterval(poll);
      poll = 0;
    }
  }
  function lost(): void {
    check();
    if (!fine() && field()) release.soon();
  }
  function tick(): void {
    if (field() && !page.focused()) lost();
    else check();
  }
  const onVisibility = () => (doc.visibilityState === 'hidden' ? lost() : check());

  doc.addEventListener('focusin', check);
  win.addEventListener('blur', lost);
  win.addEventListener('focus', check);
  doc.addEventListener('visibilitychange', onVisibility);
  check();

  return () => {
    doc.removeEventListener('focusin', check);
    win.removeEventListener('blur', lost);
    win.removeEventListener('focus', check);
    doc.removeEventListener('visibilitychange', onVisibility);
    if (poll) win.clearInterval(poll);
    release.cancel();
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
 * iOS only, where the inset bug lives. A field the page lost focus with would read as typing again
 * after the next tap (WebKit focuses it again, with no keyboard) and hold the page there:
 * installFocusRelease blurs it first. Returns a stop function.
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
