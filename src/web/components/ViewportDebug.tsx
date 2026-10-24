// The keyboard debug overlay (DESIGN.md 9.5): live numbers that tell a real keyboard from a keyboard
// inset the web view kept after the keyboard left (WebKit's, or Chrome's own), and the last 60 focus
// and viewport events, for bottom bars that float on an iPhone. Emulation cannot show those states,
// so this is how a phone reports them.
//
// On with ?debug=vv before the # (https://split.ginochang.com/?debug=vv#/account), or with five
// taps on the version line on 我的 (AccountPage.tsx), which needs no typing: typing in Chrome's
// address bar is itself a keyboard cycle and clears the state being looked for. The taps keep the
// flag in sessionStorage (evenly.vvdebug), so it lasts for this tab; evenly:vvdebug on window
// mounts or unmounts the overlay at once. 複製 copies a JSON report (never an input's value), 清除
// empties the log, 關閉 turns it off.
//
// Portaled to body, outside #root, so the MutationObservers on #root (the document title, the
// Toaster) ignore its updates and a sheet's inert root does not reach it. It takes taps only on
// its buttons, and its styles are inline. Off, it renders nothing and listens only for
// evenly:vvdebug.

import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { getRoute } from '../lib/router';
import { copyText } from '../lib/share';
import { showToast } from '../lib/toast';
import { bottomInset, fixedShift, GUARD_EVENT, KB_UP, keyboardCover, pinchZoomed, readViewport, realTyping } from '../lib/viewport';

const FLAG_KEY = 'evenly.vvdebug';
const LOG_KEY = 'evenly.vvlog';
/** Sent on window after the flag changes: the overlay reads it again. */
export const VV_DEBUG_EVENT = 'evenly:vvdebug';
/** Entries kept (and copied). */
const KEEP = 60;
/** Entries shown under the live lines. */
const SHOWN = 12;
/** Scrolls and resizes of one kind fold into one entry per this many ms (it keeps the last numbers and a count), so scrolling adds a few entries a second, not one a frame, and the focus events stay in the log. */
const FOLD_MS = 250;
const FOLDED = new Set(['win scroll', 'win resize', 'vv scroll', 'vv resize']);

// ---------- the flag ----------

function urlFlag(): boolean {
  return new URLSearchParams(location.search).get('debug') === 'vv';
}

/** The overlay is on: ?debug=vv in the URL, or the flag this tab keeps. */
export function viewportDebugOn(): boolean {
  if (typeof location === 'undefined') return false;
  if (urlFlag()) return true;
  try {
    return sessionStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/** Turn the overlay on or off for this tab. Off also takes debug=vv out of the URL (no reload), so it stays off. */
export function setViewportDebug(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(FLAG_KEY, '1');
    else sessionStorage.removeItem(FLAG_KEY);
  } catch {
    /* storage blocked: only ?debug=vv works then */
  }
  if (!on && urlFlag()) {
    const q = new URLSearchParams(location.search);
    q.delete('debug');
    const rest = q.toString();
    history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  }
  window.dispatchEvent(new Event(VV_DEBUG_EVENT));
}

function subscribeFlag(fn: () => void): () => void {
  window.addEventListener(VV_DEBUG_EVENT, fn);
  return () => window.removeEventListener(VV_DEBUG_EVENT, fn);
}

/** Mounted once by App, in every return path, so the log follows the whole visit (the editor to 我的). */
export function ViewportDebug() {
  const on = useSyncExternalStore(subscribeFlag, viewportDebugOn, () => false);
  return on && typeof document !== 'undefined' ? createPortal(<Panel />, document.body) : null;
}

// ---------- the numbers ----------

type Snap = Record<string, string | number | boolean | null>;

interface Entry {
  /** Date.now() of the first event in this entry. */
  at: number;
  /** HH:MM:SS.mmm, local time. */
  t: string;
  /** What happened: 'win blur', 'focusin', 'vv resize', 'pd' (pointerdown), 'guard'... */
  e: string;
  /** Its target: tag#id or data-testid, window, document, vv. */
  d: string;
  /** Events folded into this entry, when more than one. */
  n?: number;
  /** evenly:vvguard: how far the root scroll guard scrolled back. */
  px?: number;
  /** Resizes: innerHeight and the visual viewport one frame later (WebKit can fire resize before the height changes). */
  f?: string;
  /** The numbers when it happened. */
  s: Snap;
}

function name(n: EventTarget | null): string {
  if (!n) return '-';
  if (n === window) return 'window';
  if (n === document) return 'document';
  if (n === window.visualViewport) return 'vv';
  if (!(n instanceof Element)) return '?';
  if (n === document.body) return 'BODY';
  const id = n.id || n.getAttribute('data-testid') || '';
  return n.tagName + (id ? '#' + id : '');
}

/** ZOOM, KEYBOARD (someone types over a keyboard), WK-PHANTOM (the visual viewport is a keyboard short and nobody types), EMBEDDER-INSET (the browser shrank the window itself), PAST-END, else OK. */
function verdict(zoom: boolean, typing: boolean, cover: number | null, ih: number, ch: number, past: number): string {
  if (zoom) return 'ZOOM';
  const c = cover ?? 0;
  if (c >= KB_UP) return typing ? 'KEYBOARD' : 'WK-PHANTOM';
  if (ih < ch - 40) return 'EMBEDDER-INSET';
  if (past > 2) return 'PAST-END';
  return 'OK';
}

function snap(): Snap {
  const v = readViewport();
  const vv = window.visualViewport;
  const html = document.documentElement;
  const a = document.activeElement;
  const tab = document.querySelector<HTMLElement>('[data-testid="tabbar"]');
  const r = tab?.getBoundingClientRect();
  const cover = keyboardCover(v);
  const typing = realTyping(document);
  const ch = html.clientHeight;
  const sh = html.scrollHeight;
  const past = Math.round((vv ? vv.pageTop : window.scrollY) + window.innerHeight - sh);
  return {
    verdict: verdict(pinchZoomed(v), typing, cover, v.innerHeight, ch, past),
    route: getRoute().name,
    ih: v.innerHeight,
    ch,
    vvh: vv ? Math.round(vv.height) : null,
    vvt: vv ? Math.round(vv.offsetTop) : null,
    vvpt: vv ? Math.round(vv.pageTop) : null,
    sc: vv ? +(vv.scale || 1).toFixed(2) : null,
    cover,
    inset: bottomInset(v),
    shift: fixedShift(v),
    sy: Math.round(window.scrollY),
    sh,
    past,
    hf: document.hasFocus(),
    vis: document.visibilityState,
    ae: name(a),
    af: !!a && a !== document.body && a.matches(':focus'),
    typing,
    bar: !!document.querySelector('[data-testid="editor-savebar"]'),
    pad: !!document.querySelector('[data-testid="key-1"]'),
    tab: tab && r ? `${Math.round(r.top)}-${Math.round(r.bottom)} ${getComputedStyle(tab).transform}` : null,
  };
}

const yn = (b: unknown) => (b ? 'Y' : 'N');
const dash = (x: unknown) => (x === null || x === undefined ? '-' : String(x));

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function entryLine(x: Entry): string {
  const s = x.s;
  const what = x.e + (x.n && x.n > 1 ? ` x${x.n}` : '') + (x.px !== undefined ? ` ${x.px}px` : '');
  return `${x.t} ${what} ${x.d} | ${dash(s.ih)} vv ${dash(s.vvh)}@${dash(s.vvt)}${x.f ? ' > ' + x.f : ''} hf ${yn(s.hf)} ${dash(s.ae)}`;
}

/** The live lines (the first one is the verdict), then the newest entries. */
function render(s: Snap, log: readonly Entry[]): string {
  return [
    `verdict ${s.verdict} | ${s.route} | typing ${yn(s.typing)}`,
    `ih ${s.ih} ch ${s.ch} | vv ${dash(s.vvh)} @${dash(s.vvt)} pt ${dash(s.vvpt)} x${dash(s.sc)} | cover ${dash(s.cover)} inset ${s.inset} shift ${s.shift}`,
    `sy ${s.sy} sh ${s.sh} past ${s.past} | hf ${yn(s.hf)} ${s.vis}`,
    `${s.ae} :focus ${yn(s.af)} | savebar ${yn(s.bar)} keypad ${yn(s.pad)}`,
    `tab ${dash(s.tab)}`,
    ...log.slice(0, SHOWN).map(entryLine),
  ].join('\n');
}

function readLog(): Entry[] {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(LOG_KEY) ?? '[]');
    return Array.isArray(v) ? (v.filter(x => !!x && typeof x === 'object' && typeof (x as Entry).e === 'string') as Entry[]).slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

function writeLog(log: readonly Entry[]): void {
  try {
    if (log.length) sessionStorage.setItem(LOG_KEY, JSON.stringify(log));
    else sessionStorage.removeItem(LOG_KEY);
  } catch {
    /* full or blocked: the log still shows and copies */
  }
}

// ---------- the panel ----------

const PANEL: CSSProperties = {
  position: 'fixed',
  top: 'calc(var(--safe-t) + 4px)',
  left: 'calc(var(--safe-l) + 4px)',
  right: 'calc(var(--safe-r) + 4px)',
  zIndex: 40, // over toasts (--z-toast 30), sheets and dialogs
  maxHeight: '45vh',
  overflow: 'hidden',
  padding: 6,
  border: 'var(--line-2)',
  borderRadius: 10,
  background: 'color-mix(in srgb, var(--paper) 90%, transparent)',
  color: 'var(--ink)',
  font: '11px/1.35 ui-monospace, Menlo, Consolas, monospace',
  pointerEvents: 'none',
};
const BUTTONS: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 4 };
const BUTTON: CSSProperties = {
  pointerEvents: 'auto',
  minHeight: 32,
  padding: '0 12px',
  border: 'var(--line-2)',
  borderRadius: 16,
  background: 'var(--paper)',
  color: 'var(--ink)',
  fontSize: 13,
};
const TEXT: CSSProperties = { margin: 0, font: 'inherit', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' };

function Panel() {
  const { t } = useT();
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLPreElement>(null);
  const log = useRef<Entry[]>([]);
  const repaint = useRef<() => void>(() => undefined);

  useEffect(() => {
    log.current = readLog();
    let alive = true;
    let frame = 0;
    let saveTimer = 0;
    const paint = () => {
      frame = 0;
      const s = snap();
      // Down by offsetTop, so it stays on screen while WebKit holds the layout viewport above it.
      const vv = window.visualViewport;
      if (box.current) box.current.style.transform = `translateY(${vv ? Math.round(vv.offsetTop) : 0}px)`;
      if (text.current) text.current.textContent = render(s, log.current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    repaint.current = schedule;
    const save = () => {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
      writeLog(log.current);
    };
    const saveSoon = () => {
      if (!saveTimer) saveTimer = window.setTimeout(save, FOLD_MS);
    };
    const push = (e: string, target: EventTarget | null, extra?: Pick<Entry, 'px'>): Entry => {
      const now = Date.now();
      const s = snap();
      // Fold into the newest entry of this kind among the scroll and resize entries on top, not
      // only into the newest entry: on iOS a window scroll and a visual viewport scroll come in the
      // same frame, so the newest entry keeps changing kind.
      const i = FOLDED.has(e) ? log.current.findIndex(x => x.e === e || !FOLDED.has(x.e)) : -1;
      const prev = i >= 0 && log.current[i].e === e && now - log.current[i].at < FOLD_MS ? log.current[i] : null;
      let entry: Entry;
      if (prev) {
        prev.n = (prev.n ?? 1) + 1;
        prev.s = s;
        entry = prev;
      } else {
        entry = { at: now, t: clock(now), e, d: name(target), s, ...extra };
        log.current = [entry, ...log.current].slice(0, KEEP);
      }
      saveSoon();
      schedule();
      return entry;
    };
    const pushResize = (e: string, target: EventTarget) => {
      const entry = push(e, target);
      requestAnimationFrame(() => {
        if (!alive) return;
        const vv = window.visualViewport;
        entry.f = `${window.innerHeight} vv ${vv ? `${Math.round(vv.height)}@${Math.round(vv.offsetTop)}` : '-'}`;
        saveSoon();
        schedule();
      });
    };

    const offs: (() => void)[] = [];
    const on = (target: EventTarget, type: string, fn: (ev: Event) => void, capture = false) => {
      target.addEventListener(type, fn, { capture, passive: true });
      offs.push(() => target.removeEventListener(type, fn, { capture }));
    };
    // Captured, so the non-bubbling blur WebKit sends a field when the page loses focus shows too.
    for (const type of ['focusin', 'focusout', 'focus', 'blur']) on(document, type, ev => push(type, ev.target), true);
    for (const type of ['blur', 'focus', 'pageshow', 'orientationchange']) on(window, type, () => push('win ' + type, window));
    on(window, 'pagehide', () => {
      push('win pagehide', window);
      save();
    });
    on(window, 'resize', () => pushResize('win resize', window));
    on(window, 'scroll', () => push('win scroll', window));
    on(document, 'visibilitychange', () => {
      push('visibility ' + document.visibilityState, document);
      if (document.visibilityState === 'hidden') save();
    });
    const vv = window.visualViewport;
    if (vv) {
      on(vv, 'resize', () => pushResize('vv resize', vv));
      on(vv, 'scroll', () => push('vv scroll', vv));
    }
    on(window, GUARD_EVENT, ev => push('guard', window, { px: (ev as CustomEvent<{ px?: number }>).detail?.px }));
    // The add sheet's controls: a pointerdown with no click after it is a dead tap.
    for (const type of ['pointerdown', 'click']) {
      on(
        document,
        type,
        ev => {
          const hit = ev.target instanceof Element ? ev.target.closest('[data-testid^="editor-"]') : null;
          if (hit) push(type === 'click' ? 'click' : 'pd', hit);
        },
        true,
      );
    }
    // hasFocus() and the rest can change with no event at all (that is the bug): look every second.
    const tick = window.setInterval(schedule, 1000);
    push('open', null);

    return () => {
      alive = false;
      for (const off of offs) off();
      window.clearInterval(tick);
      if (frame) cancelAnimationFrame(frame);
      save();
      repaint.current = () => undefined;
    };
  }, []);

  const copy = async () => {
    const report = JSON.stringify(
      {
        ua: navigator.userAgent,
        standalone: matchMedia('(display-mode: standalone)').matches,
        fine: matchMedia('(pointer: fine)').matches,
        dpr: devicePixelRatio,
        screenH: screen.height,
        now: snap(),
        log: log.current,
      },
      null,
      1,
    );
    const ok = await copyText(report);
    showToast(ok ? { message: t('已複製除錯資訊', 'Debug report copied'), kind: 'success' } : { message: t('沒有複製成功', 'Could not copy it'), kind: 'error' });
  };
  const clear = () => {
    log.current = [];
    writeLog(log.current);
    repaint.current();
  };

  return (
    <div ref={box} style={PANEL} data-testid="vv-debug">
      <div style={BUTTONS}>
        <button type="button" style={BUTTON} onClick={() => void copy()} data-testid="vv-copy">
          {t('複製', 'Copy')}
        </button>
        <button type="button" style={BUTTON} onClick={clear} data-testid="vv-clear">
          {t('清除', 'Clear')}
        </button>
        <button type="button" style={BUTTON} onClick={() => setViewportDebug(false)} data-testid="vv-close">
          {t('關閉', 'Close')}
        </button>
      </div>
      <pre ref={text} style={TEXT} />
    </div>
  );
}
