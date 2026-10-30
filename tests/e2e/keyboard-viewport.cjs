// The keyboard and the visual viewport (src/web/lib/viewport.ts, DESIGN.md 9.5) end to end in
// WebKit (Safari's engine), or Chromium with --chromium, with iPhone 14 emulation in zh-TW,
// against the built app (vite preview on :4173) talking to the staging Worker, as
// tests/e2e/flows.cjs does:
//   npx vite build && npx vite preview --port 4173
//   node tests/e2e/keyboard-viewport.cjs [baseUrl] [--chromium]
// Emulation has no software keyboard and never takes focus away from the page, so an init script
// stands in for both:
// - a fake visualViewport: window.__kb(px, fire) raises a keyboard px tall (0: none) and, with
//   fire, sends resize and scroll; window.__kbLate(px) sends resize first and changes the height
//   after it, as WebKit can; window.__vv.height, .offsetTop, .pageTop and .scale set its numbers
//   (null height or pageTop: what the window says); window.__vvFire(types) sends events;
// - a document.hasFocus() override, window.__pageFocused (null: the real answer);
// - window.__resign(), what WebKit does when Chrome for iOS puts the keyboard away with its own
//   button (endEditing:YES): the page loses focus, a non-bubbling blur goes to the field and a
//   blur to the window, the field stays document.activeElement, and there is no focusout and no
//   visual viewport event.
// In Playwright WebKit a touch tap drops its click when the pointerdown was canceled, as the save
// bar's is (WebKit does that only on WPE and GTK, so an iPhone still clicks): the save bar is
// clicked with the mouse here.
// One device-only account (test-kb-*) and a two-person group with one expense are made through
// the API from Node and deleted at the end, also when a check fails. Requests to production hosts are refused.
//  K1 Chrome's own keyboard button while typing: the save bar goes and the keypad comes back
//     within two frames, the field is blurred, and nothing is focused again with page focus back.
//  K2 A focus loss with no event at all: the 1 s check catches it.
//  K3 The save bar rides the keyboard (300 px; 260 px with the visual viewport scrolled 40), and
//     完成 ends typing.
//  K4 With a mouse (1200 x 800, no touch) a lost page focus blurs nothing.
//  K5 我的: the tab bar moves down by offsetTop while the visual viewport is a keyboard short, and
//     not for a stray offsetTop or while zoomed.
//  K6 The phone column (700 x 900): the shift keeps translateX(-50%).
//  K7 The root scroll guard puts back a page resting 326 px past its end, 350 ms after the last
//     scroll, and never while a text field has real focus; the tab bar drops its shift in the same
//     task as that scroll. Off iOS (the phone column's context) the guard is not installed.
//  K8 The ?debug=vv overlay: taps only on its buttons, a verdict line; five taps on the version
//     line turn it off and on (remembered per tab); 關閉 removes it.
//  K9 The save bar's inset: typing again starts it at 0, not at the last keyboard's height; it
//     reads the visual viewport in the next frame (a resize sent before the height changed) and
//     again on a window focus.
//  K10 Sheets and dialogs: over a kept keyboard inset with nobody typing they cover the screen
//     (moved down by offsetTop, as tall as the window); while someone types in them they are the
//     visual viewport.
//  K11 The detail page's 留言 (installFocusRelease, no add sheet around it): over a kept 326 px
//     inset the root scroll guard leaves the page alone while the field has real focus; two frames
//     after the web view resigns the field is blurred, and once the page has focus again (the next
//     tap, where WebKit would focus the field again with no keyboard) the guard puts the page back.
//  K12 Focus from script (lib/viewport.ts focusFromScript), in the iPhone context and the 1200 x 800
//     one: 新增朋友 and a new expense open, 備註 and 主要幣別 (sheets with a text field) open and
//     close, the 刪除帳號 confirm and the 用邀請連結加入 prompt open and close, 主要幣別 and the
//     confirm with 名字 focused before. On touch no keyboard field is ever focused by script (the sheet or
//     card takes focus, and a field had before is not focused again), and a tap on the field still
//     focuses it; with a mouse the field is focused as it opens and focus goes back, as before.
//  K13 邀請朋友's text box (installFocusRelease, with the tab bar on the page): it opens with no
//     field focused and a message chip never focuses it; typed in over a kept 326 px inset, the
//     guard leaves the page alone and the tab bar sits on the screen's bottom; two frames after
//     the web view resigns the box is blurred, and once the page has focus again nothing is
//     focused, the guard puts the page back, and with the keyboard gone the tab bar drops its shift.
//  K14 The add sheet's receipt pill at 390 x 664 in zh-TW: with three photos (the count where the
//     × was) it is as wide as with one, so the options row lays out exactly as with one photo (the
//     pill where it was, inside the row) and the form is no taller. Nothing is saved, so no photo
//     is uploaded.

const path = require('path');
const fs = require('fs');
const { webkit, chromium, devices } = require('C:/Users/chunju/.claude/tmp/webkit-test/node_modules/playwright');

const args = process.argv.slice(2);
const CHROMIUM = args.includes('--chromium');
const ENGINE = CHROMIUM ? 'chromium' : 'webkit';
const BASE = (args.find(a => !a.startsWith('--')) || 'http://127.0.0.1:4173/').replace(/\/?$/, '/');
const API = (process.env.API || 'https://evenly-api-staging.richlovegod.workers.dev').replace(/\/+$/, '');
const OUT = path.join(__dirname, '..', '..', 'tmp', 'e2e-keyboard');
// Playwright 1.64 asks for Chromium build 1248; use the installed 1247 headless shell when it is there.
const CHROMIUM_EXE = process.env.CHROMIUM_EXE || 'C:/Users/chunju/AppData/Local/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-win64/chrome-headless-shell.exe';
const PRODUCTION = ['split.ginochang.com', 'evenly-api.richlovegod.workers.dev'];
const RUN = Date.now().toString(36);
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
}

const tid = id => `[data-testid="${id}"]`;
const errors = [];
const blocked = [];

const STUBS = `(() => {
  const state = { height: null, offsetTop: 0, pageTop: null, scale: 1 };
  window.__vv = state;
  class FakeVisualViewport extends EventTarget {
    get width() { return window.innerWidth; }
    get height() { return state.height ?? window.innerHeight; }
    get offsetTop() { return state.offsetTop; }
    get offsetLeft() { return 0; }
    get pageTop() { return state.pageTop ?? window.scrollY + state.offsetTop; }
    get pageLeft() { return window.scrollX; }
    get scale() { return state.scale; }
  }
  const fake = new FakeVisualViewport();
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
  window.__vvFire = types => { for (const t of types) fake.dispatchEvent(new Event(t)); };
  window.__kb = (px, fire) => {
    state.height = px > 0 ? window.innerHeight - px : null;
    if (fire) window.__vvFire(['resize', 'scroll']);
  };
  window.__kbLate = px => {
    fake.dispatchEvent(new Event('resize'));
    state.height = px > 0 ? window.innerHeight - px : null;
  };
  const realHasFocus = Document.prototype.hasFocus;
  window.__realHasFocus = () => realHasFocus.call(document);
  window.__pageFocused = null;
  Document.prototype.hasFocus = function () {
    return window.__pageFocused === null ? realHasFocus.call(this) : window.__pageFocused;
  };
  window.__resign = () => {
    window.__pageFocused = false;
    const a = document.activeElement;
    if (a && a !== document.body) a.dispatchEvent(new FocusEvent('blur'));
    window.dispatchEvent(new FocusEvent('blur'));
  };
})();`;

// ---------- helpers ----------

/** A request from Node to the staging Worker (Bearer). */
async function nodeApi(method, p, { token, body } = {}) {
  const headers = { 'User-Agent': 'evenly-keyboard-viewport/1.0 (Node)' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

async function newDevice(browser, label, token, options) {
  const ctx = await browser.newContext({ locale: 'zh-TW', serviceWorkers: 'block', ...options });
  await ctx.route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    if (PRODUCTION.includes(host)) {
      blocked.push(host);
      return route.abort();
    }
    return route.continue();
  });
  await ctx.addInitScript(({ api, token }) => {
    try {
      localStorage.setItem('evenly.api', api);
      localStorage.setItem('evenly.token', token);
    } catch (e) {}
  }, { api: API, token });
  await ctx.addInitScript(STUBS);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(label + ' pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(label + ' console: ' + m.text());
  });
  return { ctx, page };
}

/** Two animation frames, then a pause for effects and timers. */
async function settle(page, ms = 100) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  if (ms) await page.waitForTimeout(ms);
}

/** The editor as a person sees it: activeElement, the save bar (and its inline bottom), the keypad. */
function editorState(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    const bar = document.querySelector('[data-testid="editor-savebar"]');
    return {
      active: !a || a === document.body ? 'BODY' : a.tagName + (a.id ? '#' + a.id : ''),
      bar: !!bar,
      barBottom: bar ? bar.style.bottom : null,
      pad: !!document.querySelector('[data-testid="key-1"]'),
    };
  });
}

function tabbarShift(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('[data-testid="tabbar"]');
    return {
      prop: nav ? nav.style.getPropertyValue('--vv-shift') : null,
      transform: nav ? getComputedStyle(nav).transform : null,
      html: document.documentElement.style.getPropertyValue('--vv-shift'),
    };
  });
}

const unshifted = t => t.prop === '' && /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(t.transform);

async function openEditor(page, gid) {
  await page.goto(BASE + '#/g/' + gid + '/add', { waitUntil: 'networkidle' });
  await page.locator(tid('editor-description')).waitFor({ timeout: 30000 });
  await settle(page, 300);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${ENGINE}-${name}.png`) }).catch(() => undefined);
}

// ---------- the cases ----------

async function phoneCases(page, gid) {
  await openEditor(page, gid);
  check('the real document.hasFocus() is true (typing needs it)', (await page.evaluate(() => window.__realHasFocus())) === true);
  check('the add sheet opens with the keypad', (await editorState(page)).pad);

  console.log("K1 Chrome's own keyboard button while typing");
  await page.tap(tid('editor-description'));
  await page.evaluate(() => window.__kb(336, true));
  await settle(page);
  let s = await editorState(page);
  check('K1 typing over a 336 px keyboard: the save bar rides it at 336px, no keypad', s.bar && s.barBottom === '336px' && !s.pad && s.active === 'INPUT#editor-description', JSON.stringify(s));
  const after = await page.evaluate(async () => {
    window.__resign(); // no visual viewport event: it stays keyboard-short
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    await frame();
    await frame();
    const a = document.activeElement;
    return {
      bar: !!document.querySelector('[data-testid="editor-savebar"]'),
      pad: !!document.querySelector('[data-testid="key-1"]'),
      active: !a || a === document.body ? 'BODY' : a.tagName + (a.id ? '#' + a.id : ''),
    };
  });
  check('K1 two frames after the web view resigns: no save bar, the keypad is back', !after.bar && after.pad, JSON.stringify(after));
  check('K1 and the field is blurred (activeElement BODY)', after.active === 'BODY', JSON.stringify(after));
  await page.evaluate(() => {
    window.__pageFocused = null;
    window.dispatchEvent(new FocusEvent('focus'));
  });
  await settle(page, 200);
  s = await editorState(page);
  check('K1 page focus back: nothing is focused again, still no save bar', s.active === 'BODY' && !s.bar && s.pad, JSON.stringify(s));
  await page.evaluate(() => window.__kb(0, true));
  await settle(page);

  console.log('K2 a focus loss with no event');
  await page.tap(tid('editor-description'));
  await page.evaluate(() => window.__kb(336, true));
  await settle(page);
  s = await editorState(page);
  check('K2 typing again: the save bar is back on the keyboard', s.bar && s.barBottom === '336px' && !s.pad, JSON.stringify(s));
  await page.evaluate(() => {
    window.__pageFocused = false; // no blur, no visibilitychange, no viewport event
  });
  await page.waitForTimeout(1300);
  s = await editorState(page);
  check('K2 within 1.3 s: no save bar, the keypad is back, the field blurred', !s.bar && s.pad && s.active === 'BODY', JSON.stringify(s));
  await page.evaluate(() => {
    window.__pageFocused = null;
    window.__kb(0, true);
  });
  await settle(page);

  console.log('K3 the save bar rides the keyboard');
  await page.tap(tid('editor-description'));
  await page.evaluate(() => window.__kb(300, true));
  await settle(page);
  s = await editorState(page);
  check('K3 a 300 px keyboard: the save bar at bottom 300px', s.bar && s.barBottom === '300px', JSON.stringify(s));
  await page.evaluate(() => {
    window.__vv.offsetTop = 40;
    window.__vvFire(['scroll']);
  });
  await settle(page);
  s = await editorState(page);
  check('K3 the visual viewport scrolled 40: the bar follows to 260px', s.bar && s.barBottom === '260px', JSON.stringify(s));
  await page.click(tid('editor-done'));
  await settle(page, 150);
  s = await editorState(page);
  check('K3 完成 (a mouse click) ends typing: the keypad is back, the field blurred', !s.bar && s.pad && s.active === 'BODY', JSON.stringify(s));
  await page.evaluate(() => {
    window.__vv.offsetTop = 0;
    window.__kb(0, true);
  });
  await settle(page);

  console.log("K9 the save bar's inset");
  // Every style the bar has after it appears (the old values, then the one it has now): the first
  // must be 0.
  await page.evaluate(() => {
    window.__barStyles = [];
    const note = records => {
      for (const r of records) {
        if (r.target.matches && r.target.matches('[data-testid="editor-savebar"]')) window.__barStyles.push(r.oldValue || '');
      }
    };
    window.__barNote = note;
    window.__barWatch = new MutationObserver(note);
    window.__barWatch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true });
  });
  await page.tap(tid('editor-description'));
  await settle(page);
  const styles = await page.evaluate(() => {
    window.__barNote(window.__barWatch.takeRecords());
    window.__barWatch.disconnect();
    const bar = document.querySelector('[data-testid="editor-savebar"]');
    return [...window.__barStyles, bar ? bar.getAttribute('style') || '' : null];
  });
  check("K9 typing again with no keyboard yet: the bar starts at bottom 0px, never at the last keyboard's 260px", /(^|[;\s])bottom: 0px/.test(styles[0] || '') && !styles.some(x => /(^|[;\s])bottom: 260px/.test(x || '')), JSON.stringify(styles));
  await page.evaluate(() => window.__kbLate(336));
  await settle(page);
  s = await editorState(page);
  check('K9 a resize sent before the height changed: the bar still lands at 336px', s.bar && s.barBottom === '336px', JSON.stringify(s));
  await page.evaluate(() => {
    window.__vv.height = window.innerHeight - 280; // another keyboard, and no visual viewport event
    window.dispatchEvent(new FocusEvent('focus'));
  });
  await settle(page);
  s = await editorState(page);
  check('K9 a new keyboard height with only a window focus after it: the bar reads 280px', s.bar && s.barBottom === '280px', JSON.stringify(s));
  await page.click(tid('editor-done'));
  await settle(page, 150);
  await page.evaluate(() => window.__kb(0, true));
  await settle(page);

  console.log('K5 the tab bar on 我的');
  await page.evaluate(() => {
    location.hash = '#/account';
  });
  await page.locator(tid('tabbar')).waitFor({ timeout: 20000 });
  await page.locator(tid('account-version')).waitFor({ timeout: 20000 });
  await settle(page, 200);
  let t = await tabbarShift(page);
  check('K5 no keyboard: no shift', unshifted(t), JSON.stringify(t));
  await page.evaluate(() => {
    window.__vv.height = 427;
    window.__vv.offsetTop = 326;
    window.__vvFire(['scroll']);
  });
  await settle(page);
  t = await tabbarShift(page);
  check('K5 visual viewport 427 tall at offsetTop 326: --vv-shift 326px on the nav (not on html), translateY 326', t.prop === '326px' && t.transform === 'matrix(1, 0, 0, 1, 0, 326)' && t.html === '', JSON.stringify(t));
  await page.evaluate(() => {
    window.__vv.height = null;
    window.__vv.offsetTop = 24;
    window.__vvFire(['scroll']);
  });
  await settle(page);
  t = await tabbarShift(page);
  check('K5 offsetTop 24 with the visual viewport as tall as the window: no shift', unshifted(t), JSON.stringify(t));
  await page.evaluate(() => {
    window.__vv.height = 427;
    window.__vv.offsetTop = 326;
    window.__vv.scale = 2;
    window.__vvFire(['resize', 'scroll']);
  });
  await settle(page);
  t = await tabbarShift(page);
  check('K5 zoomed (scale 2): no shift', unshifted(t), JSON.stringify(t));
  await page.evaluate(() => {
    window.__vv.height = null;
    window.__vv.offsetTop = 0;
    window.__vv.scale = 1;
    window.__vvFire(['resize', 'scroll']);
  });
  await page.waitForTimeout(500); // let the guard's look after those events pass

  console.log('K7 the root scroll guard');
  // A scrollBy that records, moves the stubbed page and says so, as the browser would. It leaves
  // offsetTop as it was, as WebKit does until it reports the scroll a frame or two later. At each
  // evenly:vvguard (AppShell's startFixedShift hears it first), and two frames after it, the tab
  // bar's --vv-shift is noted.
  await page.evaluate(() => {
    window.__scrollBys = [];
    window.__guards = [];
    window.__shiftAtGuard = [];
    window.addEventListener('evenly:vvguard', e => {
      window.__guards.push(e.detail.px);
      const nav = document.querySelector('[data-testid="tabbar"]');
      const note = () => window.__shiftAtGuard.push(nav ? nav.style.getPropertyValue('--vv-shift') : null);
      note();
      requestAnimationFrame(() => requestAnimationFrame(note));
    });
    window.__realScrollBy = window.scrollBy;
    window.scrollBy = (x, y) => {
      window.__scrollBys.push([x, y]);
      if (window.__vv.pageTop !== null) window.__vv.pageTop += y;
      window.dispatchEvent(new Event('scroll'));
    };
  });
  // 我的 at its end as JS sees it while the web view keeps a 326 px keyboard inset: the visual
  // viewport 326 short with its bottom on the document's end, the screen 326 past it.
  const stale = () =>
    page.evaluate(() => {
      const k = 326;
      const h = window.innerHeight;
      const sh = document.documentElement.scrollHeight;
      window.__vv.height = h - k;
      window.__vv.offsetTop = k;
      window.__vv.pageTop = sh - h + k;
      return { past: Math.round(window.visualViewport.pageTop + h - sh), cover: h - window.visualViewport.height };
    });
  const guardLog = () => page.evaluate(() => ({ calls: window.__scrollBys.slice(), guards: window.__guards.slice() }));
  const reset = () =>
    page.evaluate(() => {
      window.__scrollBys = [];
      window.__guards = [];
    });
  const st = await stale();
  check('K7 the stale state as JS sees it: past 326, cover 326', st.past === 326 && st.cover === 326, JSON.stringify(st));
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(200);
  let g = await guardLog();
  const shiftBefore = (await tabbarShift(page)).prop;
  check('K7 200 ms after the last scroll: not yet (the tab bar shifted 326px meanwhile)', g.calls.length === 0 && shiftBefore === '326px', JSON.stringify({ ...g, shiftBefore }));
  await page.waitForTimeout(700);
  g = await guardLog();
  check('K7 350 ms after the last scroll: scrollBy(0, -326) once, and evenly:vvguard with px 326', g.calls.length === 1 && g.calls[0][0] === 0 && g.calls[0][1] === -326 && g.guards.length === 1 && g.guards[0] === 326, JSON.stringify(g));
  const shifts = await page.evaluate(() => window.__shiftAtGuard.slice());
  check('K7 the tab bar drops its shift in the same task as that scroll, and stays put two frames on while offsetTop still says 326', shifts.length === 2 && shifts[0] === '' && shifts[1] === '', JSON.stringify(shifts));
  await reset();
  await stale();
  await page.focus(tid('account-name'));
  const typing = await page.evaluate(() => document.activeElement && document.activeElement.matches(':focus') && document.hasFocus());
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(900);
  g = await guardLog();
  check('K7 with a text field in real focus (名字): never', typing && g.calls.length === 0 && g.guards.length === 0, JSON.stringify({ typing, ...g }));
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(900);
  g = await guardLog();
  check('K7 once the field lets go (focusout): put back', g.calls.length === 1 && g.calls[0][1] === -326, JSON.stringify(g));
  await page.evaluate(() => {
    window.scrollBy = window.__realScrollBy;
    window.__vv.height = null;
    window.__vv.offsetTop = 0;
    window.__vv.pageTop = null;
    window.__vvFire(['resize', 'scroll']);
  });
  await page.waitForTimeout(500); // let the guard's look after those events pass

  console.log('K10 sheets and dialogs');
  // The root of a sheet (data-testid sheet) or dialog (dialog): its inline box from useViewportBox.
  const overlayBox = id =>
    page.evaluate(id => {
      const panel = document.querySelector(`[data-testid="${id}"]`);
      const root = panel && panel.parentElement;
      return root ? { top: root.style.top, height: root.style.height, vvh: root.style.getPropertyValue('--vv-h'), ih: window.innerHeight } : null;
    }, id);
  const screenBox = b => !!b && b.top === '326px' && b.height === b.ih + 'px' && b.vvh === b.ih + 'px';
  const noBox = b => !!b && b.top === '' && b.height === '';
  // The web view keeping a 326 px keyboard inset with nobody typing, as JS sees it on 我的: the
  // visual viewport 326 short at offsetTop 326 (and 0 again).
  const keptInset = on =>
    page.evaluate(on => {
      window.__vv.height = on ? window.innerHeight - 326 : null;
      window.__vv.offsetTop = on ? 326 : 0;
      window.__vvFire(['resize', 'scroll']);
    }, on);
  await keptInset(true);
  await settle(page);
  await page.tap(tid('account-currency'));
  await page.locator(tid('sheet')).waitFor({ timeout: 5000 });
  await settle(page, 300);
  let box = await overlayBox('sheet');
  check('K10 a sheet (主要幣別) over a kept 326 px inset with nobody typing: it covers the screen (top 326px, as tall as the window)', screenBox(box), JSON.stringify(box));
  await keptInset(false);
  await settle(page);
  box = await overlayBox('sheet');
  check("K10 the inset gone: no inline box, the stylesheet's (the layout viewport)", noBox(box), JSON.stringify(box));
  await page.tap(tid('currency-search'));
  await page.evaluate(() => window.__kb(300, true));
  await settle(page);
  box = await overlayBox('sheet');
  check('K10 typing in its search over a 300 px keyboard: the visual viewport (top 0px, the window less 300)', !!box && box.top === '0px' && box.height === box.ih - 300 + 'px', JSON.stringify(box));
  await page.evaluate(() => window.__kb(0, true));
  await settle(page);
  await page.tap(tid('sheet-close'));
  await page.locator(tid('sheet')).waitFor({ state: 'detached', timeout: 5000 });
  await settle(page, 200);

  await keptInset(true);
  await settle(page);
  await page.tap(tid('account-delete'));
  await page.locator(tid('dialog')).waitFor({ timeout: 5000 });
  await settle(page, 300);
  box = await overlayBox('dialog');
  check('K10 the 刪除帳號 confirm over a kept 326 px inset (focus on 先不要): it covers the screen too', screenBox(box), JSON.stringify(box));
  await keptInset(false);
  await settle(page);
  box = await overlayBox('dialog');
  check("K10 and with the inset gone, the stylesheet's box again", noBox(box), JSON.stringify(box));
  await page.keyboard.press('Escape');
  await page.locator(tid('dialog')).waitFor({ state: 'detached', timeout: 5000 });

  await page.evaluate(() => {
    location.hash = '#/groups';
  });
  await page.locator(tid('groups-join')).waitFor({ timeout: 20000 });
  await settle(page, 200);
  await page.tap(tid('groups-join'));
  await page.locator(tid('prompt-input')).waitFor({ timeout: 5000 });
  // On a touch screen the prompt opens with its card focused, not the input (K12): the tap on it
  // focuses it, as on an iPhone, where that tap raises the keyboard.
  await settle(page, 200);
  await page.tap(tid('prompt-input'));
  await page.waitForFunction(() => document.activeElement && document.activeElement.matches('[data-testid="prompt-input"]'), null, { timeout: 3000 });
  await page.evaluate(() => window.__kb(300, true));
  await settle(page);
  box = await overlayBox('dialog');
  check('K10 typing in a prompt (用邀請連結加入) over a 300 px keyboard: the visual viewport (top 0px, the window less 300)', !!box && box.top === '0px' && box.height === box.ih - 300 + 'px', JSON.stringify(box));
  await page.evaluate(() => {
    window.__vv.offsetTop = 40;
    window.__vvFire(['scroll']);
  });
  await settle(page);
  box = await overlayBox('dialog');
  check('K10 and it follows the visual viewport scrolled 40 (top 40px)', !!box && box.top === '40px', JSON.stringify(box));
  await page.evaluate(() => {
    window.__vv.offsetTop = 0;
    window.__kb(0, true);
  });
  await page.keyboard.press('Escape');
  await page.locator(tid('dialog')).waitFor({ state: 'detached', timeout: 5000 });

  console.log('K8 the ?debug=vv overlay');
  await page.goto(BASE + '?debug=vv#/account', { waitUntil: 'networkidle' });
  await page.locator(tid('vv-debug')).waitFor({ timeout: 20000 });
  await page.locator(tid('account-version')).waitFor({ timeout: 20000 });
  await settle(page, 300);
  const ov = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="vv-debug"]');
    return {
      onBody: el.parentElement === document.body,
      inRoot: !!document.querySelector('#root [data-testid="vv-debug"]'),
      pe: getComputedStyle(el).pointerEvents,
      buttons: Array.from(el.querySelectorAll('button')).map(b => getComputedStyle(b).pointerEvents),
      text: el.textContent,
    };
  });
  check('K8 ?debug=vv#/account: the overlay is on, on body outside #root', ov.onBody && !ov.inRoot, JSON.stringify(ov).slice(0, 200));
  check('K8 it takes no taps but its three buttons (pointer-events none, auto)', ov.pe === 'none' && ov.buttons.length === 3 && ov.buttons.every(p => p === 'auto'), JSON.stringify({ pe: ov.pe, buttons: ov.buttons }));
  check('K8 a verdict line', /verdict (OK|KEYBOARD|WK-PHANTOM|EMBEDDER-INSET|PAST-END|ZOOM)/.test(ov.text), ov.text.slice(0, 200));
  await page.evaluate(() => window.__kb(326, true));
  await settle(page, 200);
  let text = await page.locator(tid('vv-debug')).innerText();
  check('K8 the visual viewport 326 short with nobody typing reads WK-PHANTOM, and the log has the vv resize', /verdict WK-PHANTOM/.test(text) && /vv resize/.test(text), text.slice(0, 300));
  await page.evaluate(() => window.__kb(0, true));
  await settle(page);

  const fiveTaps = async () => {
    for (let i = 0; i < 5; i++) await page.tap(tid('account-version'));
  };
  const flagInfo = () =>
    page.evaluate(() => {
      const line = document.querySelector('[data-testid="account-version"]');
      const cs = getComputedStyle(line);
      return {
        search: location.search,
        flag: sessionStorage.getItem('evenly.vvdebug'),
        toast: Array.from(document.querySelectorAll('[data-testid="toast"]')).map(n => n.textContent).join(' | '),
        selected: String(getSelection()),
        userSelect: cs.userSelect || cs.webkitUserSelect,
        role: line.getAttribute('role'),
      };
    });
  await fiveTaps();
  await page.locator(tid('vv-debug')).waitFor({ state: 'detached', timeout: 3000 });
  let info = await flagInfo();
  check('K8 five taps on the version line turn it off: debug=vv out of the URL, toast 已關閉鍵盤除錯資訊', !info.search.includes('debug=vv') && info.flag === null && /已關閉鍵盤除錯資訊/.test(info.toast), JSON.stringify(info));
  check('K8 the line stays plain text and the taps select nothing (user-select none)', info.role === null && info.selected === '' && info.userSelect === 'none', JSON.stringify(info));
  await page.locator(tid('toast')).waitFor({ state: 'detached', timeout: 8000 }).catch(() => undefined);
  await fiveTaps();
  await page.locator(tid('vv-debug')).waitFor({ timeout: 3000 });
  info = await flagInfo();
  check('K8 five more taps turn it on for this tab, toast 已開啟鍵盤除錯資訊', info.flag === '1' && /已開啟鍵盤除錯資訊/.test(info.toast), JSON.stringify(info));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(tid('vv-debug')).waitFor({ timeout: 20000 });
  await settle(page, 400);
  text = await page.locator(tid('vv-debug')).innerText();
  const kept = await page.evaluate(() => {
    const log = JSON.parse(sessionStorage.getItem('evenly.vvlog') || '[]');
    return { entries: log.length, opens: log.filter(e => e.e === 'open').length, resizes: log.filter(e => e.e === 'vv resize').length };
  });
  check('K8 a reload keeps it on, and keeps its log (sessionStorage evenly.vvlog)', /verdict /.test(text) && kept.opens >= 2 && kept.resizes >= 1, JSON.stringify(kept));
  await page.tap(tid('vv-close'));
  await page.locator(tid('vv-debug')).waitFor({ state: 'detached', timeout: 3000 });
  info = await flagInfo();
  check('K8 關閉 removes it and clears the flag', info.flag === null && !info.search.includes('debug=vv'), JSON.stringify(info));
}

/**
 * K14: the options row of the add sheet in zh-TW at 390 x 664 with receipt photos attached: one
 * photo's pill (thumbnail, 收據, ×) and three photos' pill (thumbnail, 收據, the count where × was)
 * are the same width, so three photos lay out exactly as one: 日期, 備註 and 重複 where they were,
 * the pill where it was (at 390 px it has always taken the row's second line, 附收據 too) and inside
 * the row, and the form no taller. Nothing is saved: the photos never leave the page (no KV write).
 */
async function receiptPillCase(page, gid) {
  console.log('K14 the receipt pill with one and with three photos in the 390 x 664 zh-TW add sheet');
  await openEditor(page, gid);
  const jpegs = await page.evaluate(() => [0, 1, 2].map(i => {
    const c = document.createElement('canvas');
    c.width = 60;
    c.height = 90;
    const x = c.getContext('2d');
    x.fillStyle = '#fffcf6';
    x.fillRect(0, 0, 60, 90);
    x.fillStyle = ['#3e3a39', '#2a6480', '#a63d2b'][i];
    for (let y = 8 + i * 3; y < 84; y += 11 + i) x.fillRect(6, y, 48 - i * 8, 4);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }));
  const file = (b64, i) => ({ name: `r${i}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
  const row = () => page.evaluate(() => {
    const box = el => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
    };
    const thumb = document.querySelector('[data-testid="editor-receipt-thumb"]');
    const pill = thumb ? thumb.parentElement : null;
    const date = document.querySelector('[data-testid="editor-date"]');
    const parts = ['editor-date', 'editor-notes', 'editor-repeat'].map(id => document.querySelector(`[data-testid="${id}"]`)).filter(Boolean).concat(pill ? [pill] : []);
    const count = document.querySelector('[data-testid="editor-receipt-count"]');
    const body = date ? date.closest('main') : null;
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      lang: document.documentElement.lang,
      places: parts.map(p => [box(p).top, box(p).left]),
      pill: pill ? box(pill) : null,
      rowRight: date ? Math.round(date.parentElement.getBoundingClientRect().right) : null,
      rowHeight: date ? Math.round(date.parentElement.getBoundingClientRect().height) : null,
      formHeight: body ? Math.round([...body.querySelectorAll('*')].reduce((m, el) => Math.max(m, el.getBoundingClientRect().bottom), 0)) : null,
      count: count ? count.textContent : null,
    };
  });
  await page.locator(tid('editor-receipt-file')).setInputFiles(file(jpegs[0], 0));
  await page.locator(tid('editor-receipt-remove')).waitFor({ timeout: 10000 });
  await settle(page, 200);
  const one = await row();
  await page.locator(tid('editor-receipt-file')).setInputFiles([file(jpegs[1], 1), file(jpegs[2], 2)]);
  await page.locator(tid('editor-receipt-count')).waitFor({ timeout: 10000 });
  await settle(page, 200);
  const three = await row();
  await shot(page, 'k14-three-photos');
  check('K14 the add sheet is 390 x 664 in zh-TW', three.vw === 390 && three.vh === 664 && /^zh/.test(three.lang), JSON.stringify(three));
  check('K14 three photos: the pill shows the count 3', three.count === '3', JSON.stringify(three));
  check('K14 the three-photo pill is as wide as the one-photo pill (within 2 px)', !!one.pill && !!three.pill && Math.abs(one.pill.width - three.pill.width) <= 2, JSON.stringify({ one: one.pill, three: three.pill }));
  check('K14 three photos lay out as one: 日期, 備註, 重複 and the pill in the same places, the row and the form no taller', three.places.length === 4 && JSON.stringify(three.places) === JSON.stringify(one.places) && three.rowHeight === one.rowHeight && three.formHeight <= one.formHeight + 1, JSON.stringify({ one, three }));
  check('K14 the pill stays inside the row', !!three.pill && three.pill.right <= three.rowRight, JSON.stringify(three));
  // Leave without saving: the photos go with the form.
  await page.locator(tid('editor-cancel')).click();
  await page.locator(tid('dialog-confirm')).click({ timeout: 5000 });
  await page.locator(tid('editor-description')).waitFor({ state: 'detached', timeout: 10000 });
}

async function detailCase(page, gid, eid) {
  console.log("K11 the detail page's 留言 after Chrome's own keyboard button");
  await page.goto(BASE + '#/g/' + gid + '/e/' + eid, { waitUntil: 'networkidle' });
  await page.locator(tid('comment-input')).waitFor({ timeout: 30000 });
  await settle(page, 300);
  // As in K7: a scrollBy that records, moves the stubbed page and says so.
  await page.evaluate(() => {
    window.__scrollBys = [];
    window.__guards = [];
    window.addEventListener('evenly:vvguard', e => window.__guards.push(e.detail.px));
    window.__realScrollBy = window.scrollBy;
    window.scrollBy = (x, y) => {
      window.__scrollBys.push([x, y]);
      if (window.__vv.pageTop !== null) window.__vv.pageTop += y;
      window.dispatchEvent(new Event('scroll'));
    };
  });
  const guardLog = () => page.evaluate(() => ({ calls: window.__scrollBys.slice(), guards: window.__guards.slice() }));
  const focusState = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      return {
        active: !a || a === document.body ? 'BODY' : a.tagName + (a.id ? '#' + a.id : ''),
        typing: !!a && a !== document.body && a.matches(':focus') && document.hasFocus(),
        value: document.querySelector('[data-testid="comment-input"]').value,
      };
    });
  await page.tap(tid('comment-input'));
  await page.evaluate(() => window.__kb(326, true));
  await page.keyboard.type('收據在我這');
  await settle(page);
  let f = await focusState();
  check('K11 typing in 留言 over a 326 px keyboard', f.active === 'TEXTAREA#comment-input' && f.typing && f.value === '收據在我這', JSON.stringify(f));
  // The page at its end as JS sees it with the 326 px keyboard inset kept, as in K7.
  await page.evaluate(() => {
    const k = 326;
    const h = window.innerHeight;
    window.__vv.height = h - k;
    window.__vv.offsetTop = k;
    window.__vv.pageTop = document.documentElement.scrollHeight - h + k;
    window.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(900);
  let g = await guardLog();
  check('K11 326 px past the end with 留言 in real focus: the guard leaves the page alone', g.calls.length === 0 && g.guards.length === 0, JSON.stringify(g));
  const after = await page.evaluate(async () => {
    window.__resign(); // no visual viewport event: the inset stays
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    await frame();
    await frame();
    const a = document.activeElement;
    return { active: !a || a === document.body ? 'BODY' : a.tagName + (a.id ? '#' + a.id : '') };
  });
  check('K11 two frames after the web view resigns: 留言 is blurred (activeElement BODY)', after.active === 'BODY', JSON.stringify(after));
  await page.evaluate(() => {
    window.__pageFocused = null; // the next tap: the page has focus again
    window.dispatchEvent(new FocusEvent('focus'));
    window.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(900);
  g = await guardLog();
  f = await focusState();
  check('K11 with page focus back: nothing focused again, the text kept, nobody typing', f.active === 'BODY' && !f.typing && f.value === '收據在我這', JSON.stringify(f));
  check('K11 and the guard puts the page back: scrollBy(0, -326) once, evenly:vvguard with px 326', g.calls.length === 1 && g.calls[0][0] === 0 && g.calls[0][1] === -326 && g.guards.length === 1 && g.guards[0] === 326, JSON.stringify(g));
  await page.evaluate(() => {
    window.scrollBy = window.__realScrollBy;
    window.__vv.pageTop = null;
    window.__kb(0, true);
  });
}

/**
 * K13: 邀請朋友's message box, a textarea on a page with the tab bar (no add sheet around it), as
 * K11 does for 留言: the app-wide focus release lets go of it when the web view resigns, so the
 * root scroll guard can put the page back and the tab bar is never stranded mid-screen.
 */
async function inviteCase(page) {
  console.log("K13 邀請朋友's text box after Chrome's own keyboard button");
  await page.evaluate(() => {
    Object.assign(window.__vv, { height: null, offsetTop: 0, pageTop: null, scale: 1 });
    window.__pageFocused = null;
    window.__vvFire(['resize', 'scroll']);
  });
  await page.goto(BASE + '#/invite-friends', { waitUntil: 'networkidle' });
  await page.locator(tid('invite-text')).waitFor({ timeout: 30000 });
  await settle(page, 300);
  let f = await focusNow(page);
  check('K13 邀請朋友 opens with no keyboard field focused', !f.keyboard, JSON.stringify(f));
  await page.tap(tid('invite-template-trip'));
  await settle(page, 200);
  f = await focusNow(page);
  check('K13 a message chip changes the box without focusing it', !f.keyboard && f.testid !== 'invite-text', JSON.stringify(f));
  await page.evaluate(() => {
    // A goto that changes only the hash keeps the document: K11's listener may still be there,
    // filling window.__guards, so a second one would count every guard twice.
    const listening = Array.isArray(window.__guards);
    window.__scrollBys = [];
    window.__guards = [];
    if (!listening) window.addEventListener('evenly:vvguard', e => window.__guards.push(e.detail.px));
    window.__realScrollBy = window.scrollBy;
    window.scrollBy = (x, y) => {
      window.__scrollBys.push([x, y]);
      if (window.__vv.pageTop !== null) window.__vv.pageTop += y;
      window.dispatchEvent(new Event('scroll'));
    };
  });
  const guardLog = () => page.evaluate(() => ({ calls: window.__scrollBys.slice(), guards: window.__guards.slice() }));
  const state = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      return {
        active: !a || a === document.body ? 'BODY' : a.tagName + (a.getAttribute('data-testid') ? '[' + a.getAttribute('data-testid') + ']' : ''),
        typing: !!a && a !== document.body && a.matches(':focus') && document.hasFocus(),
        value: document.querySelector('[data-testid="invite-text"]').value,
      };
    });
  await page.tap(tid('invite-text'));
  await page.evaluate(() => window.__kb(326, true));
  await page.keyboard.press('End');
  await page.keyboard.type('一起去吧');
  await settle(page);
  let s = await state();
  check('K13 typing in the box over a 326 px keyboard', s.active === 'TEXTAREA[invite-text]' && s.typing && s.value.endsWith('一起去吧'), JSON.stringify(s));
  // The page at its end as JS sees it with the 326 px keyboard inset kept, as in K7 and K11.
  await page.evaluate(() => {
    const k = 326;
    const h = window.innerHeight;
    window.__vv.height = h - k;
    window.__vv.offsetTop = k;
    window.__vv.pageTop = document.documentElement.scrollHeight - h + k;
    window.dispatchEvent(new Event('scroll'));
    window.__vvFire(['resize', 'scroll']);
  });
  await page.waitForTimeout(900);
  let g = await guardLog();
  check('K13 326 px past the end with the box in real focus: the guard leaves the page alone', g.calls.length === 0 && g.guards.length === 0, JSON.stringify(g));
  let t = await tabbarShift(page);
  check('K13 and the tab bar sits on the bottom of the screen (shifted 326)', t.prop === '326px', JSON.stringify(t));
  const after = await page.evaluate(async () => {
    window.__resign(); // no visual viewport event: the inset stays
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    await frame();
    await frame();
    const a = document.activeElement;
    return { active: !a || a === document.body ? 'BODY' : a.tagName };
  });
  check('K13 two frames after the web view resigns: the box is blurred (activeElement BODY)', after.active === 'BODY', JSON.stringify(after));
  await page.evaluate(() => {
    window.__pageFocused = null; // the next tap: the page has focus again
    window.dispatchEvent(new FocusEvent('focus'));
    window.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(900);
  g = await guardLog();
  s = await state();
  check('K13 with page focus back: nothing focused again, the text kept, nobody typing', s.active === 'BODY' && !s.typing && s.value.endsWith('一起去吧'), JSON.stringify(s));
  check('K13 and the guard puts the page back: scrollBy(0, -326) once, evenly:vvguard with px 326', g.calls.length === 1 && g.calls[0][1] === -326 && g.guards.length === 1 && g.guards[0] === 326, JSON.stringify(g));
  await page.evaluate(() => {
    window.scrollBy = window.__realScrollBy;
    window.__vv.pageTop = null;
    window.__vv.offsetTop = 0;
    window.__kb(0, true);
  });
  await settle(page, 200);
  t = await tabbarShift(page);
  check('K13 the keyboard gone: the tab bar drops its shift (not stranded mid-screen)', unshifted(t), JSON.stringify(t));
}

/** What has focus, and whether it is a field the system keyboard comes up for (lib/viewport.ts keyboardField). */
function focusNow(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    const NO_KEYBOARD = ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'];
    let keyboard = false;
    if (a && a.tagName === 'TEXTAREA') keyboard = !a.readOnly;
    else if (a && a.tagName === 'INPUT') keyboard = !a.readOnly && a.inputMode !== 'none' && !NO_KEYBOARD.includes(a.type);
    else if (a) keyboard = a.isContentEditable === true;
    return {
      active: !a || a === document.body ? 'BODY' : a.tagName + (a.getAttribute('data-testid') ? '[' + a.getAttribute('data-testid') + ']' : ''),
      testid: a ? a.getAttribute('data-testid') : null,
      keyboard,
    };
  });
}

/**
 * K12: our code never focuses a keyboard field from script on a touch screen; with a mouse and
 * keyboard, autofocus and focus return stay as they were. `touch`: the iPhone context (taps), or
 * the 1200 x 800 desktop one (clicks and keys).
 */
async function scriptFocusCase(page, gid, touch) {
  const tag = touch ? 'K12 touch' : 'K12 desktop';
  console.log(tag + ': focus from script (sheets, dialogs, fields that focus themselves)');
  const press = sel => (touch ? page.tap(sel) : page.click(sel));
  // A goto that changes only the hash keeps the document, and with it the stubbed visual viewport
  // the cases before left (K11 ends at offsetTop 326): start from no keyboard and a focused page.
  await page.evaluate(() => {
    Object.assign(window.__vv, { height: null, offsetTop: 0, pageTop: null, scale: 1 });
    window.__pageFocused = null;
    window.__vvFire(['resize', 'scroll']);
  });

  // A page whose field focuses itself as it opens (TextField autoFocus, lib/autoFocus.ts).
  await page.goto(BASE + '#/add-friend', { waitUntil: 'networkidle' });
  await page.locator(tid('addfriend-name')).waitFor({ timeout: 30000 });
  await settle(page, 300);
  let f = await focusNow(page);
  if (touch) check(tag + ' 新增朋友 opens with no field focused (no keyboard field)', !f.keyboard && f.testid !== 'addfriend-name', JSON.stringify(f));
  else check(tag + ' 新增朋友 opens with 名字 focused, as before', f.testid === 'addfriend-name', JSON.stringify(f));

  // The add sheet on a new expense, and its 備註 sheet, whose textarea the sheet focuses as it opens.
  await openEditor(page, gid);
  f = await focusNow(page);
  if (touch) check(tag + ' a new expense opens with no keyboard field focused (the keypad, not the description)', !f.keyboard, JSON.stringify(f));
  else check(tag + ' a new expense opens with the amount focused, as before', f.testid === 'editor-amount', JSON.stringify(f));
  await press(tid('editor-notes'));
  await page.locator(tid('editor-notes-input')).waitFor({ timeout: 5000 });
  await settle(page, 300);
  f = await focusNow(page);
  if (touch) check(tag + ' 備註 opens with the sheet focused, not its textarea', f.testid === 'sheet' && !f.keyboard, JSON.stringify(f));
  else check(tag + ' 備註 opens with its textarea focused, as before', f.testid === 'editor-notes-input', JSON.stringify(f));
  if (touch) {
    await page.tap(tid('editor-notes-input'));
    f = await focusNow(page);
    check(tag + ' a tap on the textarea focuses it (where an iPhone raises the keyboard)', f.testid === 'editor-notes-input', JSON.stringify(f));
    await page.tap(tid('editor-notes-done'));
  } else {
    await page.keyboard.press('Escape');
  }
  await page.locator(tid('editor-notes-input')).waitFor({ state: 'detached', timeout: 5000 });
  await settle(page, 200);
  f = await focusNow(page);
  if (touch) check(tag + ' 備註 closed: no keyboard field focused', !f.keyboard, JSON.stringify(f));

  // 主要幣別 on 我的, opened while 名字 has focus: the sheet's search is focused as it opens with a
  // mouse only, and on close focus goes back to 名字 with a mouse only.
  await page.goto(BASE + '#/account', { waitUntil: 'networkidle' });
  await page.locator(tid('account-name')).waitFor({ timeout: 30000 });
  await settle(page, 300);
  await press(tid('account-name'));
  f = await focusNow(page);
  check(tag + ' 名字 has focus (a ' + (touch ? 'tap' : 'click') + ')', f.testid === 'account-name', JSON.stringify(f));
  // Opened from script, so 名字 keeps focus until the sheet takes it and is what focus returns to.
  await page.evaluate(() => document.querySelector('[data-testid="account-currency"]').click());
  await page.locator(tid('currency-search')).waitFor({ timeout: 5000 });
  await settle(page, 300);
  f = await focusNow(page);
  if (touch) check(tag + ' 主要幣別 opens with the sheet focused, not its search', f.testid === 'sheet' && !f.keyboard, JSON.stringify(f));
  else check(tag + ' 主要幣別 opens with its search focused, as before', f.testid === 'currency-search', JSON.stringify(f));
  if (touch) await page.tap(tid('sheet-close'));
  else await page.keyboard.press('Escape');
  await page.locator(tid('sheet')).waitFor({ state: 'detached', timeout: 5000 });
  await settle(page, 200);
  f = await focusNow(page);
  if (touch) check(tag + ' 主要幣別 closed: 名字 is not focused again (no keyboard field focused)', !f.keyboard && f.testid !== 'account-name', JSON.stringify(f));
  else check(tag + ' 主要幣別 closed: focus is back on 名字, as before', f.testid === 'account-name', JSON.stringify(f));

  // The 刪除帳號 confirm, opened while 名字 has focus: it starts on 先不要 (a button) either way.
  await press(tid('account-name'));
  await page.evaluate(() => document.querySelector('[data-testid="account-delete"]').click());
  await page.locator(tid('dialog')).waitFor({ timeout: 5000 });
  await settle(page, 300);
  f = await focusNow(page);
  check(tag + ' the 刪除帳號 confirm opens on 先不要', f.testid === 'dialog-cancel', JSON.stringify(f));
  if (touch) await page.tap(tid('dialog-cancel'));
  else await page.keyboard.press('Escape');
  await page.locator(tid('dialog')).waitFor({ state: 'detached', timeout: 5000 });
  await settle(page, 200);
  f = await focusNow(page);
  if (touch) check(tag + ' the confirm closed: 名字 is not focused again (no keyboard field focused)', !f.keyboard && f.testid !== 'account-name', JSON.stringify(f));
  else check(tag + ' the confirm closed: focus is back on 名字, as before', f.testid === 'account-name', JSON.stringify(f));

  // A prompt (用邀請連結加入).
  await page.goto(BASE + '#/groups', { waitUntil: 'networkidle' });
  await page.locator(tid('groups-join')).waitFor({ timeout: 30000 });
  await settle(page, 300);
  if (touch) {
    await page.tap(tid('groups-join'));
  } else {
    await page.focus(tid('groups-join'));
    await page.keyboard.press('Enter');
  }
  await page.locator(tid('prompt-input')).waitFor({ timeout: 5000 });
  await settle(page, 300);
  f = await focusNow(page);
  if (touch) check(tag + ' the prompt opens with its card focused, not the input', f.testid === 'dialog' && !f.keyboard, JSON.stringify(f));
  else check(tag + ' the prompt opens with its input focused, as before', f.testid === 'prompt-input', JSON.stringify(f));
  if (touch) {
    await page.tap(tid('prompt-input'));
    f = await focusNow(page);
    check(tag + ' a tap on the input focuses it (where an iPhone raises the keyboard)', f.testid === 'prompt-input', JSON.stringify(f));
    await page.tap(tid('dialog-cancel'));
  } else {
    await page.keyboard.press('Escape');
  }
  await page.locator(tid('dialog')).waitFor({ state: 'detached', timeout: 5000 });
  await settle(page, 200);
  f = await focusNow(page);
  if (touch) check(tag + ' the prompt closed: no keyboard field focused', !f.keyboard, JSON.stringify(f));
  else check(tag + ' the prompt closed: focus is back on 用邀請連結加入, as before', f.testid === 'groups-join', JSON.stringify(f));
}

async function desktopCase(page, gid) {
  console.log('K4 a mouse and a keyboard (1200 x 800, no touch)');
  await openEditor(page, gid);
  check('K4 the real document.hasFocus() is true', (await page.evaluate(() => window.__realHasFocus())) === true);
  await page.click(tid('editor-description'));
  const footerSave = page.locator('footer ' + tid('editor-save'));
  const before = await footerSave.boundingBox();
  await page.evaluate(() => window.__resign());
  await page.waitForTimeout(300);
  const s = await editorState(page);
  const afterBox = await footerSave.boundingBox();
  check('K4 a lost page focus blurs nothing with a mouse: the description keeps focus', s.active === 'INPUT#editor-description', JSON.stringify(s));
  check('K4 and the footer stays as it was (no save bar, no keypad)', !s.bar && !s.pad && !!before && JSON.stringify(before) === JSON.stringify(afterBox), JSON.stringify({ s, before, afterBox }));
}

async function columnCase(page) {
  console.log('K6 the phone column (700 x 900)');
  await page.goto(BASE + '#/account', { waitUntil: 'networkidle' });
  await page.locator(tid('tabbar')).waitFor({ timeout: 30000 });
  await settle(page, 200);
  let t = await tabbarShift(page);
  check('K6 no keyboard: centered, matrix(1, 0, 0, 1, -240, 0)', t.transform === 'matrix(1, 0, 0, 1, -240, 0)', JSON.stringify(t));
  await page.evaluate(() => {
    window.__vv.height = window.innerHeight - 326;
    window.__vv.offsetTop = 326;
    window.__vvFire(['scroll']);
  });
  await settle(page);
  t = await tabbarShift(page);
  check('K6 shifted 326: matrix(1, 0, 0, 1, -240, 326), translateX(-50%) kept', t.prop === '326px' && t.transform === 'matrix(1, 0, 0, 1, -240, 326)', JSON.stringify(t));

  console.log('K7 off iOS: no root scroll guard');
  // This context is a touch screen, but its user agent is not an iPhone's (main.tsx installs the
  // guard on iOS only): a page resting 326 px past its end, as in K7, stays where it is.
  const off = await page.evaluate(async () => {
    const calls = [];
    const guards = [];
    const real = window.scrollBy;
    window.addEventListener('evenly:vvguard', e => guards.push(e.detail.px));
    window.scrollBy = (x, y) => calls.push([x, y]);
    const h = window.innerHeight;
    window.__vv.pageTop = document.documentElement.scrollHeight - h + 326;
    window.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 900));
    window.scrollBy = real;
    window.__vv.pageTop = null;
    return { ua: navigator.userAgent, platform: navigator.platform, touch: navigator.maxTouchPoints, calls, guards };
  });
  check("K7 off iOS (this user agent is not an iPhone's): no guard, the page stays 326 px past its end", !/iPhone|iPad|iPod/.test(off.ua) && off.calls.length === 0 && off.guards.length === 0, JSON.stringify(off));
}

(async () => {
  console.log(`Keyboard and visual viewport in ${ENGINE} against ${BASE} (API ${API})`);
  if (PRODUCTION.includes(new URL(API).hostname) || PRODUCTION.includes(new URL(BASE).hostname)) {
    console.log('Refusing to run against production.');
    process.exit(2);
  }
  const health = await nodeApi('GET', '/api/health').catch(() => ({ status: 0, data: null }));
  if (!(health.status === 200 && health.data && health.data.env === 'staging') && !process.env.ALLOW_ANY_ENV) {
    console.log('The API does not say staging: ' + JSON.stringify(health));
    process.exit(2);
  }
  const type = CHROMIUM ? chromium : webkit;
  const browser = await type.launch(CHROMIUM && fs.existsSync(CHROMIUM_EXE) ? { executablePath: CHROMIUM_EXE } : {});
  let token = null;
  let gid = null;
  const pages = [];
  try {
    const signup = await nodeApi('POST', '/api/auth/signup', { body: { name: 'test-kb-' + RUN, locale: 'zh-TW' } });
    if (signup.status !== 200 || !signup.data || !signup.data.token) throw new Error('signup from Node: ' + signup.status);
    token = signup.data.token;
    const group = await nodeApi('POST', '/api/groups', { token, body: { name: '鍵盤測試 ' + RUN, type: 'trip', currency: 'TWD', members: [{ name: 'Abbie' }] } });
    if (group.status !== 200 || !group.data || !group.data.group) throw new Error('group from Node: ' + group.status);
    gid = group.data.group.id;
    check('a device-only account and a two-person group from the API', group.data.members.length === 2, JSON.stringify(group.data.members.map(m => m.name)));
    const meId = group.data.me && group.data.me.memberId;
    const eid = crypto.randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    const expense = await nodeApi('PUT', `/api/groups/${encodeURIComponent(gid)}/expenses/${eid}`, {
      token,
      body: { kind: 'expense', description: '鍵盤測試午餐', category: 'food.dining', amount: 600, currency: 'TWD', fxRate: 1, date: today, payers: [{ memberId: meId, amount: 600 }], split: { method: 'equal', entries: group.data.members.map(m => ({ memberId: m.id })) } },
    });
    check('and one expense in it, for the detail page', expense.status === 200 && expense.data && expense.data.expense && expense.data.expense.id === eid, JSON.stringify(expense.data));

    const phone = await newDevice(browser, 'phone', token, { ...devices['iPhone 14'] });
    pages.push(['phone', phone.page]);
    await phoneCases(phone.page, gid).catch(async e => {
      check('phone cases ran without exceptions', false, e.stack || e.message);
      await shot(phone.page, 'phone-error');
    });
    await detailCase(phone.page, gid, eid).catch(async e => {
      check('detail case ran without exceptions', false, e.stack || e.message);
      await shot(phone.page, 'detail-error');
    });
    await scriptFocusCase(phone.page, gid, true).catch(async e => {
      check('touch focus case ran without exceptions', false, e.stack || e.message);
      await shot(phone.page, 'focus-touch-error');
    });
    await inviteCase(phone.page).catch(async e => {
      check('invite case ran without exceptions', false, e.stack || e.message);
      await shot(phone.page, 'invite-error');
    });
    await receiptPillCase(phone.page, gid).catch(async e => {
      check('receipt pill case ran without exceptions', false, e.stack || e.message);
      await shot(phone.page, 'receipt-pill-error');
    });

    const desk = await newDevice(browser, 'desktop', token, { viewport: { width: 1200, height: 800 } });
    pages.push(['desktop', desk.page]);
    await desktopCase(desk.page, gid).catch(async e => {
      check('desktop case ran without exceptions', false, e.stack || e.message);
      await shot(desk.page, 'desktop-error');
    });
    await scriptFocusCase(desk.page, gid, false).catch(async e => {
      check('desktop focus case ran without exceptions', false, e.stack || e.message);
      await shot(desk.page, 'focus-desktop-error');
    });

    const column = await newDevice(browser, 'column', token, { viewport: { width: 700, height: 900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    pages.push(['column', column.page]);
    await columnCase(column.page).catch(async e => {
      check('column case ran without exceptions', false, e.stack || e.message);
      await shot(column.page, 'column-error');
    });
  } catch (e) {
    check('run completed without exceptions', false, e.stack || e.message);
  } finally {
    if (fail) for (const [label, page] of pages) await shot(page, label + '-end');
    // Delete what this run made, whatever happened above.
    if (token && gid) {
      const r = await nodeApi('DELETE', '/api/groups/' + encodeURIComponent(gid), { token }).catch(() => ({ status: 0 }));
      check('cleanup: delete the group', r.status === 200, r.status);
    }
    if (token) {
      const r = await nodeApi('DELETE', '/api/me', { token, body: {} }).catch(() => ({ status: 0 }));
      check('cleanup: delete the account', r.status === 200, r.status);
    }
    check('no page errors', errors.length === 0, errors.join('\n'));
    check('no request went to production', blocked.length === 0, blocked.join(', '));
    await browser.close();
    console.log(`\n${pass} passed, ${fail} failed (${ENGINE}).` + (fail ? ` Screenshots: ${OUT}` : ''));
    if (fail) {
      console.log('Failed:\n - ' + failures.join('\n - '));
      process.exit(1);
    }
  }
})();
