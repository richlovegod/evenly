// lib/viewport.ts: the keyboard numbers, which fields count, the add sheet's typing watch, the focus
// release on every other page, the tab bar's shift and the root scroll guard, on fakes built on
// EventTarget (node, no DOM). The IMG_
// cases use the numbers measured on Gino's iPhone screenshots (Chrome for iOS, iOS 27.2): IMG_6977,
// the save bar floating 302 pt up with no keyboard; IMG_6978, the tab bar 326 pt up at the end of
// 我的 over a blank band, the web view still keeping a 326 pt keyboard inset.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bottomInset,
  fixedShift,
  GUARD_EVENT,
  installFocusRelease,
  installRootScrollGuard,
  isTypingField,
  KB_UP,
  keyboardCover,
  keyboardField,
  pinchZoomed,
  realTyping,
  startFixedShift,
  watchTyping,
  type ViewportSnap,
} from '../../src/web/lib/viewport';

const at = (innerHeight: number, vv: ViewportSnap['vv']): ViewportSnap => ({ innerHeight, vv });
const vp = (height: number, offsetTop = 0, scale = 1) => ({ height, offsetTop, scale });

describe('keyboard numbers', () => {
  it.each([
    ['IMG_6977: the visual viewport 302 short', at(752, vp(450)), 302],
    ['IMG_6978: a 326 inset left behind', at(753, vp(427, 326)), 326],
    ['no keyboard', at(664, vp(664)), 0],
    ['a taller visual viewport never counts below 0', at(664, vp(700)), 0],
    ['scale 0.999 counts as 1', at(664, vp(328, 0, 0.999)), 336],
    ['pinch-zoomed: unknown', at(664, vp(300, 0, 1.5)), null],
    ['no visualViewport: unknown', at(664, null), null],
  ] as const)('keyboardCover, %s', (_name, s, want) => {
    expect(keyboardCover(s)).toBe(want);
  });

  it.each([
    ['IMG_6977: on the visual viewport bottom', at(752, vp(450)), 302],
    ['a scrolled visual viewport', at(664, vp(364, 40)), 260],
    ['no keyboard (offsetTop alone never lifts it)', at(664, vp(664, 10)), 0],
    ['a landscape keyboard is kept', at(375, vp(131)), 244],
    ['a zero-height report stops 56 under the top', at(753, vp(0)), 697],
    ['a negative height stops there too', at(753, vp(-200)), 697],
    ['a window under 56 tall gives 0', at(40, vp(0)), 0],
    ['rounded', at(664, vp(363.6)), 300],
    ['zoomed: the visible bottom', at(664, vp(332, 100, 2)), 232],
    ['no visualViewport', at(664, null), 0],
  ] as const)('bottomInset, %s', (_name, s, want) => {
    expect(bottomInset(s)).toBe(want);
  });

  it.each([
    ['IMG_6978: down to the screen bottom', at(753, vp(427, 326)), 326],
    ['a real keyboard with the page scrolled', at(664, vp(328, 200)), 200],
    ['a real keyboard with the page scrolled 40: any offsetTop counts then', at(664, vp(328, 40)), 40],
    ['offsetTop 24 with no keyboard (the iOS 26.0 drift) moves nothing', at(753, vp(753, 24)), 0],
    ['a 119 px gap is not a keyboard', at(753, vp(634, 200)), 0],
    ['120 px is', at(753, vp(633, 200)), 200],
    ['zoomed: never', at(753, vp(427, 326, 2)), 0],
    ['a negative offsetTop', at(753, vp(427, -4)), 0],
    ['never more than the window', at(753, vp(300, 5000)), 753],
    ['no visualViewport', at(753, null), 0],
  ] as const)('fixedShift, %s', (_name, s, want) => {
    expect(fixedShift(s)).toBe(want);
  });

  it('calls a scale away from 1 pinch-zoomed, and no visualViewport not zoomed', () => {
    expect(pinchZoomed(at(664, vp(332, 0, 2)))).toBe(true);
    expect(pinchZoomed(at(664, vp(664, 0, 1.005)))).toBe(false);
    expect(pinchZoomed(at(664, null))).toBe(false);
    expect(KB_UP).toBe(120);
  });
});

// ---------- which fields count ----------

interface ElementBits {
  type?: string;
  readOnly?: boolean;
  inputMode?: string;
  isContentEditable?: boolean;
  focused?: boolean;
}

function element(tagName: string, bits: ElementBits = {}): Element {
  const { focused = false, ...rest } = bits;
  return { tagName, type: '', readOnly: false, inputMode: '', isContentEditable: false, matches: (sel: string) => sel === ':focus' && focused, ...rest } as unknown as Element;
}
const input = (type: string, bits: ElementBits = {}) => element('INPUT', { type, ...bits });

describe('isTypingField: the add sheet keypad rule, unchanged', () => {
  it.each(['text', 'email', 'search', 'number', 'tel', 'url', 'password', 'date'])('an input of type %s is a text field', type => {
    expect(isTypingField(input(type))).toBe(true);
  });
  it.each(['checkbox', 'radio', 'button', 'file'])('an input of type %s is not (file: the receipt photo)', type => {
    expect(isTypingField(input(type))).toBe(false);
  });
  it('takes any textarea, and nothing else', () => {
    expect(isTypingField(element('TEXTAREA'))).toBe(true);
    expect(isTypingField(element('SELECT'))).toBe(false);
    expect(isTypingField(element('DIV', { isContentEditable: true }))).toBe(false);
    expect(isTypingField(null)).toBe(false);
  });
});

describe('keyboardField: what brings up the system keyboard (as in Toaster.tsx)', () => {
  it.each(['text', 'email', 'search', 'number', 'tel', 'url', 'password', 'date'])('an input of type %s', type => {
    expect(keyboardField(input(type))).toBe(true);
  });
  it.each(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])('not an input of type %s', type => {
    expect(keyboardField(input(type))).toBe(false);
  });
  it('leaves out inputmode none (the add sheet amount) and read-only fields', () => {
    expect(keyboardField(input('text', { inputMode: 'none' }))).toBe(false);
    expect(keyboardField(input('text', { readOnly: true }))).toBe(false);
    expect(keyboardField(element('TEXTAREA', { readOnly: true }))).toBe(false);
  });
  it('takes textareas and contenteditable, and nothing else', () => {
    expect(keyboardField(element('TEXTAREA'))).toBe(true);
    expect(keyboardField(element('DIV', { isContentEditable: true }))).toBe(true);
    expect(keyboardField(element('DIV'))).toBe(false);
    expect(keyboardField(element('BODY'))).toBe(false);
    expect(keyboardField(null)).toBe(false);
  });
});

describe('realTyping', () => {
  const doc = (activeElement: Element, focused: boolean) => ({ activeElement, hasFocus: () => focused }) as unknown as Document;
  it('needs a keyboard field that matches :focus on a page with focus', () => {
    expect(realTyping(doc(input('text', { focused: true }), true))).toBe(true);
  });
  it("is false after Chrome's own keyboard button: the field kept, the page unfocused", () => {
    expect(realTyping(doc(input('text', { focused: true }), false))).toBe(false);
  });
  it('is false when the field does not match :focus (WebKit: the frame is not focused and active)', () => {
    expect(realTyping(doc(input('text', { focused: false }), true))).toBe(false);
  });
  it('is false on the amount (inputmode none) and on the body', () => {
    expect(realTyping(doc(input('text', { focused: true, inputMode: 'none' }), true))).toBe(false);
    expect(realTyping(doc(element('BODY'), true))).toBe(false);
  });
});

// ---------- fakes: a window, a document and a visual viewport ----------

type ListenerOpts = boolean | AddEventListenerOptions | EventListenerOptions | undefined;
const listenerIds = new WeakMap<object, number>();
let nextListenerId = 1;

/** Counts the listeners a target holds, the way EventTarget keeps them: one per type, function and capture flag. */
function tracked<T extends EventTarget>(target: T, label: string, live: Set<string>): T {
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  const key = (type: string, fn: EventListenerOrEventListenerObject | null, opts: ListenerOpts): string | null => {
    if (!fn) return null;
    if (!listenerIds.has(fn)) listenerIds.set(fn, nextListenerId++);
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    return `${label} ${type} ${listenerIds.get(fn)} ${capture}`;
  };
  target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: ListenerOpts) => {
    const k = key(type, fn, opts);
    if (k) live.add(k);
    add(type, fn, opts);
  };
  target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: ListenerOpts) => {
    const k = key(type, fn, opts);
    if (k) live.delete(k);
    remove(type, fn, opts);
  };
  return target;
}

class FakeViewport extends EventTarget {
  height = 664;
  offsetTop = 0;
  scale = 1;
  /** The visual viewport's top in the page (the guard reads it). */
  pageTop = 0;
}

class FakeStyle {
  readonly props = new Map<string, string>();
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
  removeProperty(name: string): string {
    const v = this.props.get(name) ?? '';
    this.props.delete(name);
    return v;
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? '';
  }
}

interface FakeField extends EventTarget {
  tagName: string;
  type: string;
  readOnly: boolean;
  inputMode: string;
  isContentEditable: boolean;
  matches(sel: string): boolean;
  blur: ReturnType<typeof vi.fn>;
}

interface World {
  win: Window;
  doc: Document;
  vv: FakeViewport;
  root: HTMLElement;
  /** The description, a text field inside root. */
  field: FakeField;
  /** The detail page's 留言, a textarea outside root. */
  other: FakeField;
  body: Element;
  html: { style: FakeStyle; attrs: Set<string>; scrollHeight: number; hasAttribute(name: string): boolean };
  state: { focused: boolean; visibility: DocumentVisibilityState; active: Element; scrollY: number };
  /** dy of every window.scrollBy call. */
  scrolls: number[];
  /** Listeners on the window, the document, root and the visual viewport. */
  listeners(): number;
}

function world(): World {
  const live = new Set<string>();
  const vv = tracked(new FakeViewport(), 'vv', live);
  const html = {
    style: new FakeStyle(),
    attrs: new Set<string>(),
    scrollHeight: 2000,
    hasAttribute(name: string) {
      return this.attrs.has(name);
    },
  };
  const body = element('BODY');
  const state = { focused: true, visibility: 'visible' as DocumentVisibilityState, active: body, scrollY: 0 };
  const root = tracked(new EventTarget(), 'root', live) as unknown as HTMLElement;
  const doc = tracked(new EventTarget(), 'doc', live) as unknown as Document;
  const fakeField = (tagName: string, type: string, inRoot: boolean): FakeField => {
    const f = new EventTarget() as FakeField;
    Object.assign(f, {
      tagName,
      type,
      readOnly: false,
      inputMode: '',
      isContentEditable: false,
      matches: (sel: string) => sel === ':focus' && state.active === (f as unknown as Element) && state.focused,
      // Blurring a focused field: activeElement goes back to the body and focusout bubbles up.
      blur: vi.fn(() => {
        if (state.active !== (f as unknown as Element)) return;
        state.active = body;
        if (inRoot) root.dispatchEvent(new Event('focusout'));
        doc.dispatchEvent(new Event('focusout'));
      }),
    });
    return f;
  };
  const field = fakeField('INPUT', 'text', true);
  const other = fakeField('TEXTAREA', 'textarea', false);
  (root as unknown as { contains: (n: unknown) => boolean }).contains = n => n === field || n === root;
  Object.defineProperties(doc, {
    body: { value: body },
    documentElement: { value: html },
    activeElement: { get: () => state.active },
    visibilityState: { get: () => state.visibility },
  });
  (doc as unknown as { hasFocus: () => boolean }).hasFocus = () => state.focused;
  const win = tracked(new EventTarget(), 'win', live) as unknown as Window;
  const scrolls: number[] = [];
  Object.defineProperty(win, 'scrollY', { get: () => state.scrollY });
  Object.assign(win, {
    innerHeight: 664,
    visualViewport: vv,
    document: doc,
    // The page moves, and says so, as a browser's would.
    scrollBy: (_x: number, y: number) => {
      scrolls.push(y);
      vv.pageTop += y;
      state.scrollY += y;
      win.dispatchEvent(new Event('scroll'));
    },
    setTimeout: (f: () => void, ms?: number) => setTimeout(f, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (f: () => void, ms?: number) => setInterval(f, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    requestAnimationFrame: (f: FrameRequestCallback) => setTimeout(() => f(Date.now()), 16),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
  return { win, doc, vv, root, field, other, body, html, state, scrolls, listeners: () => live.size };
}

/** A tap in the description: it becomes activeElement and focusin bubbles to root and the document. */
function focusField(w: World): void {
  w.state.active = w.field as unknown as Element;
  w.root.dispatchEvent(new Event('focusin'));
  w.doc.dispatchEvent(new Event('focusin'));
}

/** A tap in the detail page's 留言, outside root: focusin bubbles to the document only. */
function focusOther(w: World): void {
  w.state.active = w.other as unknown as Element;
  w.doc.dispatchEvent(new Event('focusin'));
}

/** What WebKit does when Chrome for iOS puts the keyboard away with endEditing:YES: the page loses
 *  focus, a non-bubbling blur goes to the field and a blur to the window, the field stays
 *  activeElement, and there is no focusout and no visual viewport event. */
function resignWebView(w: World): void {
  w.state.focused = false;
  w.state.active.dispatchEvent?.(new Event('blur')); // the fake body is no EventTarget
  w.win.dispatchEvent(new Event('blur'));
}

// ---------- watchTyping ----------

/** Starts watchTyping on the description, and notes its stop function for afterEach. */
function typingWatch(w: World, stops: (() => void)[], fine = false) {
  const seen: boolean[] = [];
  const stop = watchTyping({ root: w.root, isField: el => el === (w.field as unknown as Element), fine: () => fine, onChange: t => seen.push(t), win: w.win, doc: w.doc });
  stops.push(stop);
  return { seen, stop };
}

describe('watchTyping', () => {
  // Every watch is stopped after its case: a running one keeps its root on the list that
  // installFocusRelease leaves to it.
  const stops: (() => void)[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stops.splice(0).forEach(stop => stop());
    vi.useRealTimers();
  });

  const start = (w: World, fine = false) => typingWatch(w, stops, fine);

  it('starts typing on focusin', () => {
    const w = world();
    const { seen } = start(w);
    focusField(w);
    expect(seen).toEqual([true]);
  });

  it("ends typing at once when the web view resigns (Chrome's own keyboard button), then blurs the field", () => {
    const w = world();
    const { seen } = start(w);
    focusField(w);
    w.vv.height = 328;
    w.vv.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(20);
    resignWebView(w); // the visual viewport stays keyboard-short: IMG_6977
    expect(seen).toEqual([true, false]);
    expect(w.field.blur).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(w.field.blur).toHaveBeenCalledTimes(1);
    expect(w.doc.activeElement).toBe(w.body);
    // The page gets focus back: nothing is focused again, nobody is typing.
    w.state.focused = true;
    w.win.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(20);
    expect(seen).toEqual([true, false]);
    expect(w.doc.activeElement).toBe(w.body);
  });

  it('keeps the field when page focus comes back before the blur runs', () => {
    const w = world();
    const { seen } = start(w);
    focusField(w);
    resignWebView(w);
    w.state.focused = true;
    w.win.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(20);
    expect(w.field.blur).not.toHaveBeenCalled();
    expect(seen).toEqual([true, false, true]);
  });

  it('never blurs with a mouse, and typing stays focus alone', () => {
    const w = world();
    const { seen } = start(w, true);
    focusField(w);
    resignWebView(w);
    w.state.visibility = 'hidden';
    w.doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(3000);
    expect(w.field.blur).not.toHaveBeenCalled();
    expect(seen).toEqual([true]);
  });

  it('counts a hidden page as one without focus (app switch): typing ends and the field is blurred', () => {
    const w = world();
    const { seen } = start(w);
    focusField(w);
    w.state.visibility = 'hidden'; // hasFocus() still says true
    w.doc.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual([true, false]);
    vi.advanceTimersByTime(1);
    expect(w.field.blur).toHaveBeenCalledTimes(1);
  });

  it('catches a focus loss that sent no event, within the 1 s poll', () => {
    const w = world();
    const { seen } = start(w);
    focusField(w);
    w.state.focused = false; // no blur, no visibilitychange
    vi.advanceTimersByTime(999);
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true, false]);
    vi.advanceTimersByTime(1);
    expect(w.field.blur).toHaveBeenCalledTimes(1);
  });

  it('notices a focused field removed without focusout, within the poll', () => {
    const w = world();
    const { seen } = start(w);
    focusField(w);
    w.state.active = w.body; // WebKit drops a removed node's focus silently
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([true, false]);
    expect(w.field.blur).not.toHaveBeenCalled();
  });

  it('keeps typing when the keyboard goes down under a focused field (Android Back): no keyboard rule', () => {
    const w = world();
    const { seen } = start(w);
    focusField(w);
    w.vv.height = 328;
    w.vv.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(20);
    w.vv.height = 664;
    w.vv.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(2500);
    expect(seen).toEqual([true]);
    expect(w.field.blur).not.toHaveBeenCalled();
  });

  it('starts typing at the window focus when the tap came while the page had no focus yet', () => {
    const w = world();
    const { seen } = start(w);
    w.state.focused = false; // just after Chrome's address bar: focusin arrives first
    focusField(w);
    expect(seen).toEqual([]);
    w.state.focused = true;
    w.win.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(20);
    expect(seen).toEqual([true]);
    expect(w.field.blur).not.toHaveBeenCalled();
  });

  it('falls back to focus alone where the page never reports focus (an in-app browser): never blurs', () => {
    const w = world();
    w.state.focused = false; // this host's document.hasFocus() never says true
    const { seen } = start(w);
    focusField(w);
    expect(seen).toEqual([true]);
    w.win.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(3000);
    expect(seen).toEqual([true]);
    expect(w.field.blur).not.toHaveBeenCalled();
    // A hidden page still ends typing (app switch), and blurs nothing there either.
    w.state.visibility = 'hidden';
    w.doc.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual([true, false]);
    vi.advanceTimersByTime(1);
    expect(w.field.blur).not.toHaveBeenCalled();
  });

  it('ends typing on a real blur (focusout), once focus has landed', () => {
    const w = world();
    const { seen } = start(w);
    focusField(w);
    w.field.blur();
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true, false]);
  });

  it('removes every listener and timer when stopped', () => {
    const w = world();
    const before = w.listeners();
    const { stop } = start(w);
    focusField(w);
    resignWebView(w); // a blur pending, the poll running
    w.vv.dispatchEvent(new Event('resize')); // a frame pending
    expect(w.listeners()).toBeGreaterThan(before);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stop();
    expect(w.listeners()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------- installFocusRelease ----------

describe('installFocusRelease', () => {
  const stops: (() => void)[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stops.splice(0).forEach(stop => stop());
    vi.useRealTimers();
  });

  const install = (w: World, fine = false) => {
    const stop = installFocusRelease(() => fine, w.win, w.doc);
    stops.push(stop);
    return stop;
  };

  it("blurs 留言 (no add sheet around it) one task after the web view resigns (Chrome's own keyboard button)", () => {
    const w = world();
    install(w);
    focusOther(w);
    resignWebView(w); // the field stays activeElement, no focusout
    expect(w.other.blur).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(w.other.blur).toHaveBeenCalledTimes(1);
    expect(w.doc.activeElement).toBe(w.body);
    // The next tap gives the page focus back: nothing to focus again, nobody typing.
    w.state.focused = true;
    w.win.dispatchEvent(new Event('focus'));
    expect(realTyping(w.doc)).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // no poll with nothing focused
  });

  it('blurs it on a hidden page (app switch) too, and keeps it when page focus comes back before the blur runs', () => {
    const w = world();
    install(w);
    focusOther(w);
    w.state.visibility = 'hidden';
    w.doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1);
    expect(w.other.blur).toHaveBeenCalledTimes(1);

    const w2 = world();
    install(w2);
    focusOther(w2);
    resignWebView(w2);
    w2.state.focused = true;
    vi.advanceTimersByTime(1);
    expect(w2.other.blur).not.toHaveBeenCalled();
    expect(realTyping(w2.doc)).toBe(true);
  });

  it('catches a focus loss that sent no event, within the 1 s poll', () => {
    const w = world();
    install(w);
    focusOther(w);
    w.state.focused = false; // no blur, no visibilitychange
    vi.advanceTimersByTime(999);
    expect(w.other.blur).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(w.other.blur).toHaveBeenCalledTimes(1);
    expect(w.doc.activeElement).toBe(w.body);
    vi.advanceTimersByTime(1000); // and the poll stops with nothing focused
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs no poll and blurs nothing without a focused keyboard field (the body, a read-only field)', () => {
    const w = world();
    install(w);
    w.doc.dispatchEvent(new Event('focusin'));
    expect(vi.getTimerCount()).toBe(0);
    w.other.readOnly = true;
    focusOther(w);
    expect(vi.getTimerCount()).toBe(0);
    resignWebView(w);
    vi.advanceTimersByTime(3000);
    expect(w.other.blur).not.toHaveBeenCalled();
  });

  it('never blurs with a mouse, and runs no poll', () => {
    const w = world();
    install(w, true);
    focusOther(w);
    expect(vi.getTimerCount()).toBe(0);
    resignWebView(w);
    w.state.visibility = 'hidden';
    w.doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(3000);
    expect(w.other.blur).not.toHaveBeenCalled();
    expect(w.doc.activeElement).toBe(w.other);
  });

  it('never blurs where the page never reports focus (an in-app browser), hidden or not', () => {
    const w = world();
    w.state.focused = false; // this host's document.hasFocus() never says true
    install(w);
    focusOther(w);
    w.win.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(3000);
    w.state.visibility = 'hidden';
    w.doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(3000);
    expect(w.other.blur).not.toHaveBeenCalled();
    expect(w.doc.activeElement).toBe(w.other);
  });

  it("leaves the add sheet's fields to its watchTyping (one blur timer and one poll), and takes them once that stops", () => {
    const w = world();
    install(w);
    const { stop } = typingWatch(w, stops);
    focusField(w);
    expect(vi.getTimerCount()).toBe(1); // watchTyping's poll
    resignWebView(w);
    expect(vi.getTimerCount()).toBe(2); // and its blur
    vi.advanceTimersByTime(1);
    expect(w.field.blur).toHaveBeenCalledTimes(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    w.state.focused = true;
    focusField(w);
    expect(vi.getTimerCount()).toBe(1); // installFocusRelease's poll now
    resignWebView(w);
    vi.advanceTimersByTime(1);
    expect(w.field.blur).toHaveBeenCalledTimes(2);
  });

  it('lets the root scroll guard put the page back after the next tap gives the page focus again (IMG_6978 on the detail page)', () => {
    const w = world();
    install(w);
    stops.push(installRootScrollGuard(w.win, w.doc));
    stale(w);
    focusOther(w);
    resignWebView(w);
    vi.advanceTimersByTime(1); // blurred: focusout sets the guard off
    w.state.focused = true; // a tap: WebKit would have focused 留言 again here
    w.win.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(350);
    expect(w.scrolls).toEqual([-326]);
  });

  it('removes every listener and timer when stopped', () => {
    const w = world();
    const before = w.listeners();
    const stop = install(w);
    focusOther(w);
    resignWebView(w); // a blur pending, the poll running
    expect(w.listeners()).toBeGreaterThan(before);
    expect(vi.getTimerCount()).toBe(2);
    stop();
    expect(w.listeners()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3000);
    expect(w.other.blur).not.toHaveBeenCalled();
  });
});

// ---------- startFixedShift ----------

describe('startFixedShift', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const bar = () => {
    const style = new FakeStyle();
    return { style, el: { style } as unknown as HTMLElement };
  };

  it('keeps --vv-shift on the bar (not on html) from offsetTop while the visual viewport is a keyboard short', () => {
    const w = world();
    (w.win as unknown as { innerHeight: number }).innerHeight = 753;
    const b = bar();
    startFixedShift(b.el, w.win);
    expect(b.style.props.has('--vv-shift')).toBe(false);
    // IMG_6978: the end of 我的 with a 326 inset left behind.
    w.vv.height = 427;
    w.vv.offsetTop = 326;
    w.vv.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    expect(b.style.getPropertyValue('--vv-shift')).toBe('326px');
    expect(w.html.style.props.size).toBe(0);
    // A window scroll reads it again.
    w.vv.offsetTop = 300;
    w.win.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    expect(b.style.getPropertyValue('--vv-shift')).toBe('300px');
    // The keyboard space gone: removed, even with a stray offsetTop left (24, as iOS 26.0 reported).
    w.vv.height = 753;
    w.vv.offsetTop = 24;
    w.vv.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(20);
    expect(b.style.props.has('--vv-shift')).toBe(false);
  });

  it('drops the shift while the page is zoomed, and brings it back at scale 1', () => {
    const w = world();
    const b = bar();
    startFixedShift(b.el, w.win);
    w.vv.height = 338;
    w.vv.offsetTop = 326;
    w.vv.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    expect(b.style.getPropertyValue('--vv-shift')).toBe('326px');
    w.vv.scale = 2;
    w.vv.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(20);
    expect(b.style.props.has('--vv-shift')).toBe(false);
    w.vv.scale = 1;
    w.vv.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(20);
    expect(b.style.getPropertyValue('--vv-shift')).toBe('326px');
  });

  it("drops the shift in the same task as the root scroll guard's scroll, and keeps it while the old numbers last (IMG_6978)", () => {
    const w = world();
    const b = bar();
    startFixedShift(b.el, w.win);
    installRootScrollGuard(w.win, w.doc);
    stale(w);
    w.win.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    expect(b.style.getPropertyValue('--vv-shift')).toBe('326px');
    const atGuard: string[] = [];
    w.win.addEventListener(GUARD_EVENT, () => atGuard.push(b.style.getPropertyValue('--vv-shift')));
    vi.advanceTimersByTime(330); // 350 ms after the scroll
    expect(w.scrolls).toEqual([-326]);
    expect(atGuard).toEqual(['']); // gone already when the guard's event goes out, right after its scrollBy
    // The next frames still read offsetTop 326: WebKit has not reported the scroll yet.
    vi.advanceTimersByTime(40);
    expect(b.style.props.has('--vv-shift')).toBe(false);
    // It reports offsetTop 0, then the page is scrolled into the inset again: shifted as before.
    w.vv.offsetTop = 0;
    w.vv.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    expect(b.style.props.has('--vv-shift')).toBe(false);
    w.vv.offsetTop = 120;
    w.win.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    expect(b.style.getPropertyValue('--vv-shift')).toBe('120px');
  });

  it('keeps the rest when the guard scrolls back less than the shift, until a new reading comes', () => {
    const w = world();
    const b = bar();
    startFixedShift(b.el, w.win);
    w.vv.height = 338;
    w.vv.offsetTop = 326;
    w.vv.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    w.win.dispatchEvent(new CustomEvent(GUARD_EVENT, { detail: { px: 200 } }));
    expect(b.style.getPropertyValue('--vv-shift')).toBe('126px');
    w.win.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    expect(b.style.getPropertyValue('--vv-shift')).toBe('126px'); // the old 326, ignored
    w.vv.offsetTop = 140;
    w.vv.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    expect(b.style.getPropertyValue('--vv-shift')).toBe('140px');
  });

  it('goes by the numbers again when no new ones come within 300 ms of the guard', () => {
    const w = world();
    const b = bar();
    startFixedShift(b.el, w.win);
    w.vv.height = 338;
    w.vv.offsetTop = 326;
    w.vv.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    w.win.dispatchEvent(new CustomEvent(GUARD_EVENT, { detail: { px: 326 } }));
    w.win.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(280);
    expect(b.style.props.has('--vv-shift')).toBe(false);
    vi.advanceTimersByTime(40); // the hold ends at 300 ms, and the next frame reads 326 again
    expect(b.style.getPropertyValue('--vv-shift')).toBe('326px');
  });

  it('does nothing at the guard while the bar is not shifted', () => {
    const w = world();
    const b = bar();
    startFixedShift(b.el, w.win);
    w.win.dispatchEvent(new CustomEvent(GUARD_EVENT, { detail: { px: 326 } }));
    expect(b.style.props.has('--vv-shift')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    w.vv.height = 338;
    w.vv.offsetTop = 326;
    w.vv.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    expect(b.style.getPropertyValue('--vv-shift')).toBe('326px');
  });

  it('removes the property, every listener and every timer when stopped', () => {
    const w = world();
    const before = w.listeners();
    const b = bar();
    const stop = startFixedShift(b.el, w.win);
    w.vv.height = 338;
    w.vv.offsetTop = 326;
    w.vv.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    w.win.dispatchEvent(new CustomEvent(GUARD_EVENT, { detail: { px: 100 } })); // a hold pending
    w.win.dispatchEvent(new Event('resize')); // a frame pending
    expect(w.listeners()).toBeGreaterThan(before);
    expect(vi.getTimerCount()).toBeGreaterThan(1);
    stop();
    expect(b.style.props.has('--vv-shift')).toBe(false);
    expect(w.listeners()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does nothing without visualViewport', () => {
    const w = world();
    (w.win as unknown as { visualViewport: null }).visualViewport = null;
    const before = w.listeners();
    const b = bar();
    const stop = startFixedShift(b.el, w.win);
    expect(w.listeners()).toBe(before);
    stop();
    expect(b.style.props.size).toBe(0);
  });
});

// ---------- installRootScrollGuard ----------

/** 我的 at its end as JS sees it while the web view keeps a keyboard inset of k: the visual viewport
 *  k short with its bottom on the document's end, so the screen shows k past the end. */
function stale(w: World, k = 326): void {
  w.vv.height = w.win.innerHeight - k;
  w.vv.offsetTop = k;
  w.vv.pageTop = w.html.scrollHeight - w.win.innerHeight + k;
}

function touch(w: World, type: 'touchstart' | 'touchend' | 'touchcancel', fingers: number): void {
  w.win.dispatchEvent(Object.assign(new Event(type), { touches: { length: fingers } }));
}

describe('installRootScrollGuard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const install = (w: World) => {
    const guards: number[] = [];
    w.win.addEventListener(GUARD_EVENT, e => guards.push((e as CustomEvent<{ px: number }>).detail.px));
    const stop = installRootScrollGuard(w.win, w.doc);
    return { guards, stop };
  };
  const scroll = (w: World) => w.win.dispatchEvent(new Event('scroll'));

  it('scrolls back once, 350 ms after the last scroll, what rests past the end (IMG_6978)', () => {
    const w = world();
    const { guards } = install(w);
    stale(w);
    scroll(w);
    vi.advanceTimersByTime(200);
    scroll(w); // still moving: wait again
    vi.advanceTimersByTime(349);
    expect(w.scrolls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.scrolls).toEqual([-326]);
    expect(guards).toEqual([326]);
    // Its own scroll sets it off again, and then the page is at its end: nothing more.
    vi.advanceTimersByTime(2000);
    expect(w.scrolls).toEqual([-326]);
    expect(guards).toEqual([326]);
  });

  it('is set off by a visual viewport resize or scroll, a lifted finger or a focusout too', () => {
    for (const fire of [
      (w: World) => w.vv.dispatchEvent(new Event('resize')),
      (w: World) => w.vv.dispatchEvent(new Event('scroll')),
      (w: World) => touch(w, 'touchend', 0),
      (w: World) => touch(w, 'touchcancel', 0),
      (w: World) => w.doc.dispatchEvent(new Event('focusout')),
    ]) {
      const w = world();
      const { guards } = install(w);
      stale(w, 200);
      fire(w);
      vi.advanceTimersByTime(350);
      expect(guards).toEqual([200]);
    }
  });

  it('waits for the finger to lift', () => {
    const w = world();
    install(w);
    stale(w);
    touch(w, 'touchstart', 1);
    scroll(w);
    vi.advanceTimersByTime(1000);
    expect(w.scrolls).toEqual([]);
    touch(w, 'touchstart', 2);
    touch(w, 'touchend', 1); // one finger still down
    vi.advanceTimersByTime(1000);
    expect(w.scrolls).toEqual([]);
    touch(w, 'touchend', 0);
    vi.advanceTimersByTime(349);
    expect(w.scrolls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.scrolls).toEqual([-326]);
  });

  it('never moves the page while someone types, and does once the field lets go', () => {
    const w = world();
    install(w);
    stale(w);
    w.state.active = w.field as unknown as Element; // focused, :focus, page focused: realTyping
    scroll(w);
    vi.advanceTimersByTime(1000);
    expect(w.scrolls).toEqual([]);
    w.field.blur(); // focusout
    vi.advanceTimersByTime(350);
    expect(w.scrolls).toEqual([-326]);
  });

  it('never moves a zoomed page', () => {
    const w = world();
    install(w);
    stale(w);
    w.vv.scale = 2;
    scroll(w);
    vi.advanceTimersByTime(1000);
    expect(w.scrolls).toEqual([]);
  });

  it("never moves the page under a sheet's scroll lock (html[data-locked])", () => {
    const w = world();
    install(w);
    stale(w);
    w.html.attrs.add('data-locked');
    scroll(w);
    vi.advanceTimersByTime(1000);
    expect(w.scrolls).toEqual([]);
  });

  it('does nothing on a normal page, nor for 2 px past the end; 3 px is put back', () => {
    const w = world();
    const { guards } = install(w);
    w.vv.pageTop = w.html.scrollHeight - w.win.innerHeight; // at the end, no inset
    scroll(w);
    vi.advanceTimersByTime(1000);
    w.vv.pageTop += 2;
    scroll(w);
    vi.advanceTimersByTime(1000);
    expect(w.scrolls).toEqual([]);
    w.vv.pageTop += 1;
    scroll(w);
    vi.advanceTimersByTime(350);
    expect(w.scrolls).toEqual([-3]);
    expect(guards).toEqual([3]);
  });

  it('reads scrollY where there is no visualViewport', () => {
    const w = world();
    (w.win as unknown as { visualViewport: null }).visualViewport = null;
    const { guards } = install(w);
    w.state.scrollY = w.html.scrollHeight - w.win.innerHeight + 50;
    scroll(w);
    vi.advanceTimersByTime(350);
    expect(w.scrolls).toEqual([-50]);
    expect(guards).toEqual([50]);
  });

  it('removes every listener and timer when stopped', () => {
    const w = world();
    const before = w.listeners();
    const stop = installRootScrollGuard(w.win, w.doc);
    stale(w);
    scroll(w); // a check pending
    expect(w.listeners()).toBeGreaterThan(before);
    stop();
    expect(w.listeners()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(w.scrolls).toEqual([]);
  });
});
