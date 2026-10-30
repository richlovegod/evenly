// Cookie sessions end to end in WebKit (Safari's engine) with iPhone emulation, on the staging
// Worker, which serves the app and the API on one origin (docs/PLAN-push-scan-cookies.md 1.4).
//   node tests/e2e/cookie-flows.cjs [siteUrl] [outDir]
// siteUrl defaults to https://evenly-api-staging.richlovegod.workers.dev/ and must answer
// /api/health with env "staging" (ALLOW_ANY_ENV=1 runs it elsewhere). Every account it makes is
// named test-cookie-* and deleted at the end, also when a check fails: each gets a spare Bearer
// session from Node first, since the browser's own session may be gone by then. Signing up in the
// UI takes an email code: the start answer's devCode (staging's test mode, EMAIL_DEV_ECHO), for
// an address on evenly.test, which is never mailed.
//  1. Signing up sets the HttpOnly session cookie and the readable marker; no token in localStorage.
//  2. With localStorage, IndexedDB, Cache Storage and the service worker deleted, a reload still
//     opens Home (what Safari's 7-day rule leaves: the cookies).
//  3. A token an older build left in localStorage is moved into the cookie and removed.
//  4. Signing out clears both cookies (offline, the app refuses and says it needs a connection).
//  5. A second tab signing in as someone else makes the first tab reload as that account.
//  6. No /api/ answer ends up in any cache.
//  7. A signup over a live session cookie (the page lost track of it) goes on as that account
//     instead of making a second one.
//  8. A browser that keeps no cookies (every Set-Cookie dropped on the way) stays signed in on
//     the token, saved, on that device for good.
//  9. 使用 Apple 登入 comes above Google's on 開始使用 at the same size, drawn as Apple's HIG asks
//     (Apple's logo file as tall as the button, the title at 43% of its height), starts at Apple
//     with the Services ID and a SameSite=None flow cookie (stopped before Apple's page loads), and
//     我的 > 登入方式 shows Apple and Google with 連結 (Apple's row with Apple's logo file as tall as
//     the row). A pending link that is gone (the address a link's callback opens, with an id the
//     Worker never made) says so on 我的 and leaves the address. On a 320 px phone in English the
//     title stays 43% on one line, with at least 8% to the right edge. The iPhone app's Google start
//     opened as the app's sign-in sheet opens it (a load of its own, Sec-Fetch-Site none) goes on
//     to Google, and the same address followed from a page is refused before it sets a cookie.
// Session tokens are compared, never printed.

const path = require('path');
const fs = require('fs');
const { webkit, devices } = require('C:/Users/chunju/.claude/tmp/webkit-test/node_modules/playwright');

const SITE = (process.argv[2] || 'https://evenly-api-staging.richlovegod.workers.dev/').replace(/\/?$/, '/');
const ORIGIN = new URL(SITE).origin;
const HOST = new URL(SITE).hostname;
const OUT = process.argv[3] || path.join(__dirname, '..', '..', 'tmp', 'e2e-cookies');
const RUN = Date.now().toString(36);
const SESSION = '__Host-evenly_session';
const MARKER = '__Host-evenly_user';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
}

const tid = id => `[data-testid="${id}"]`;
const errors = [];
/** Bearer sessions for the cleanup: { label, token }. */
const spares = [];

// ---------- helpers ----------

/** A request from Node: no Origin, so the Worker sets no cookie and answers with the token. */
async function nodeApi(method, p, { token, body } = {}) {
  const headers = { 'User-Agent': 'evenly-cookie-flows/1.0 (Node)' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(ORIGIN + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/** A device-only account made from Node (its token is kept for the cleanup). */
async function nodeAccount(name) {
  const r = await nodeApi('POST', '/api/auth/signup', { body: { name, locale: 'zh-TW' } });
  if (r.status !== 200 || !r.data || !r.data.token) throw new Error('signup from Node: ' + r.status);
  spares.push({ label: name, token: r.data.token });
  return { token: r.data.token, userId: r.data.user.id };
}

/** Same-origin fetch from the page: the browser adds the cookies (and Origin on writes). */
async function pageApi(page, method, p, body) {
  return page.evaluate(async ({ method, p, body }) => {
    const r = await fetch(p, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: r.status, vary: r.headers.get('Vary'), data };
  }, { method, p, body });
}

/** A second Bearer session for the account the page is signed in as: a link code made in the page, spent from Node. */
async function spareSession(page, label) {
  const code = await pageApi(page, 'POST', '/api/auth/link-code', {});
  if (code.status !== 200) throw new Error('link-code for ' + label + ': ' + code.status);
  const r = await nodeApi('POST', '/api/auth/link', { body: { code: code.data.code } });
  if (r.status !== 200) throw new Error('link for ' + label + ': ' + r.status);
  spares.push({ label, token: r.data.token });
  return r.data.token;
}

function watch(page, label) {
  page.on('pageerror', e => errors.push(label + ' pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(label + ' console: ' + m.text());
  });
}

async function newDevice(browser, label, options = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'], locale: 'zh-TW', ...options });
  const page = await ctx.newPage();
  watch(page, label);
  return { ctx, page };
}

async function siteCookies(ctx) {
  const all = await ctx.cookies(SITE);
  return { session: all.find(c => c.name === SESSION), marker: all.find(c => c.name === MARKER) };
}

/** A cookie's attributes for a failure line (never the session's value). */
function describe(c) {
  if (!c) return 'missing';
  return JSON.stringify({ ...c, value: c.name === SESSION ? '(hidden)' : c.value });
}

/**
 * Sign up through the Welcome page: the name, an email on evenly.test, then the code from the
 * start answer (devCode). Resolves the Set-Cookie lines of the answer that signed in (verify).
 */
async function signUpInUi(page, name) {
  await page.goto(SITE, { waitUntil: 'networkidle' });
  await page.locator(tid('welcome-name')).waitFor({ timeout: 30000 });
  await page.locator(tid('welcome-name')).fill(name);
  await page.locator(tid('welcome-email')).fill(name.toLowerCase() + '@evenly.test');
  const started = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/email/start', { timeout: 30000 });
  await page.locator(tid('welcome-send')).click();
  const start = await started;
  const { devCode } = (await start.json().catch(() => null)) || {};
  if (!devCode) throw new Error('no devCode in the start answer (' + start.status() + '): the Worker needs the email routes and EMAIL_DEV_ECHO');
  const answer = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/email/verify', { timeout: 30000 });
  await page.locator(tid('code-input')).fill(devCode);
  const res = await answer;
  await page.locator(tid('home-new-group')).first().waitFor({ timeout: 30000 });
  return (await res.headersArray()).filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value);
}

/** The attributes of one cookie in Set-Cookie lines, lowercased ('httponly', 'samesite=lax'); null if absent. */
function setCookieAttrs(lines, name) {
  const line = lines.flatMap(l => l.split('\n')).find(l => l.startsWith(name + '='));
  return line ? line.split(';').slice(1).map(s => s.trim().toLowerCase()) : null;
}

/** Poll `fn` until it returns something truthy (or the time is up; then its last value). */
async function waitFor(fn, timeout = 20000, every = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v || Date.now() - t0 > timeout) return v;
    await new Promise(r => setTimeout(r, every));
  }
}

/** A plain file of the site, where no app code runs: for storage work on this origin. */
async function plainPage(page) {
  await page.goto(SITE + 'version.json?plain=' + Date.now());
}

/** What Safari's 7-day rule deletes: localStorage, sessionStorage, IndexedDB, Cache Storage, service workers. */
async function wipeScriptStorage(page) {
  await plainPage(page);
  return page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const dbs = indexedDB.databases ? await indexedDB.databases() : [{ name: 'evenly' }];
    await Promise.all(dbs.map(d => new Promise(res => {
      const r = indexedDB.deleteDatabase(d.name);
      r.onsuccess = r.onerror = r.onblocked = () => res();
    })));
    for (const k of await caches.keys()) await caches.delete(k);
    const sw = navigator.serviceWorker;
    if (sw) for (const reg of await sw.getRegistrations()) await reg.unregister();
    return {
      localStorage: localStorage.length,
      databases: indexedDB.databases ? (await indexedDB.databases()).length : 0,
      caches: (await caches.keys()).length,
      workers: sw ? (await sw.getRegistrations()).length : 0,
    };
  });
}

/** URLs under /api/ in any Cache Storage cache of the page's origin. */
async function cachedApi(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) {
      for (const r of await (await caches.open(k)).keys()) if (new URL(r.url).pathname.startsWith('/api/')) out.push(k + ' ' + r.url);
    }
    return out;
  });
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + '.png') }).catch(() => undefined);
}

// ---------- the flows ----------

(async () => {
  console.log('Cookie flows against ' + SITE + ' run ' + RUN);
  const health = await nodeApi('GET', '/api/health').catch(e => ({ status: 0, data: { error: e.message } }));
  if (!health.data || health.data.env !== 'staging') {
    if (process.env.ALLOW_ANY_ENV !== '1') {
      console.log('  FAIL ' + SITE + ' is not staging (' + JSON.stringify(health.data) + '); set ALLOW_ANY_ENV=1 to run anyway');
      process.exit(1);
    }
  }
  const browser = await webkit.launch();
  try {
    // 1. Sign up (a name, an email and its code).
    const A = await newDevice(browser, 'A');
    const calls = [];
    A.page.on('request', r => {
      const u = new URL(r.url());
      if (!u.pathname.startsWith('/api/')) return;
      const h = r.headers();
      calls.push({ origin: u.origin, path: u.pathname, user: h['x-evenly-user'] || null, bearer: !!h['authorization'] });
    });
    const signupCookies = await signUpInUi(A.page, 'test-cookie-A-' + RUN);
    await shot(A.page, '01-signed-up');
    const a = await siteCookies(A.ctx);
    const aId = a.marker ? a.marker.value : null;
    if (aId) await spareSession(A.page, 'A');
    // What the Worker sent (the browser's cookie list may not report SameSite: WebKit on Windows).
    const sessionAttrs = setCookieAttrs(signupCookies, SESSION);
    const markerAttrs = setCookieAttrs(signupCookies, MARKER);
    const want = ['max-age=31536000', 'path=/', 'secure', 'samesite=lax'];
    check('the sign-up answer sets the session cookie: HttpOnly, Secure, SameSite=Lax, Path=/, a year, no Domain',
      !!sessionAttrs && [...want, 'httponly'].every(x => sessionAttrs.includes(x)) && !sessionAttrs.some(x => x.startsWith('domain')), JSON.stringify(sessionAttrs));
    check('the sign-up answer sets the marker: not HttpOnly, otherwise the same',
      !!markerAttrs && want.every(x => markerAttrs.includes(x)) && !markerAttrs.includes('httponly') && !markerAttrs.some(x => x.startsWith('domain')), JSON.stringify(markerAttrs));
    check('the browser keeps the session cookie HttpOnly, Secure, for this host only',
      !!a.session && a.session.httpOnly && a.session.secure && a.session.path === '/' && a.session.domain === HOST, describe(a.session));
    check('the browser keeps the marker readable, Secure, for this host only',
      !!a.marker && !a.marker.httpOnly && a.marker.secure && a.marker.domain === HOST, describe(a.marker));
    // Requests use the cookie; localStorage keeps a copy of the token for the day the cookie is
    // gone but localStorage is not (a Home Screen app whose cookie WebKit capped).
    const copy = await waitFor(() => A.page.evaluate(() => {
      const t = localStorage.getItem('evenly.token');
      return t ? { t, owner: localStorage.getItem('evenly.tokenUser') } : null;
    }));
    check('localStorage keeps a copy of the token, marked with its account', !!copy && copy.t === a.session?.value && copy.owner === aId, copy ? copy.owner : 'none');
    const docCookie = await A.page.evaluate(() => document.cookie);
    check('the page sees the marker but not the session cookie', docCookie.includes(MARKER + '=') && !docCookie.includes(SESSION), docCookie.replace(/__Host-evenly_session=[^;]*/, '(session)'));
    const me = await pageApi(A.page, 'GET', '/api/me');
    check('GET /api/me with the cookie is this account', me.status === 200 && !!aId && me.data.user.id === aId, me.status);
    check('API answers say Vary: *', me.vary === '*', me.vary);

    // 6 (first look). Under the service worker, after a reload with API traffic: nothing from /api/ is cached.
    await A.page.evaluate(() => (navigator.serviceWorker
      ? Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise(r => setTimeout(() => r(false), 10000))])
      : false)).catch(() => false);
    const fromReload = calls.length;
    await A.page.reload({ waitUntil: 'networkidle' });
    await A.page.locator(tid('home-new-group')).first().waitFor({ timeout: 30000 });
    await A.page.waitForTimeout(1500);
    const controlled = await A.page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller));
    const hits = await cachedApi(A.page);
    check('no /api/ answer in Cache Storage (service worker ' + (controlled ? 'in control' : 'not in control') + ')', hits.length === 0, hits.join(', '));
    // Started on the cookie: the app's calls carry X-Evenly-User and never a token.
    const appCalls = calls.slice(fromReload);
    check('after a reload the app signs in with the cookie and X-Evenly-User, never a token',
      appCalls.some(c => c.path === '/api/me' && c.user === aId) && appCalls.every(c => !c.bearer), JSON.stringify(appCalls.slice(0, 6)));
    check('every API call goes to the site itself', calls.length > 0 && calls.every(c => c.origin === ORIGIN), [...new Set(calls.map(c => c.origin))].join(', '));

    // 2. Safari deletes the site's script storage after 7 days without use; the cookies stay.
    const wiped = await wipeScriptStorage(A.page);
    check('script storage deleted (localStorage, IndexedDB, caches, service worker)', wiped.localStorage === 0 && wiped.databases === 0 && wiped.caches === 0 && wiped.workers === 0, JSON.stringify(wiped));
    check('the cookies are still there', !!(await siteCookies(A.ctx)).session);
    await A.page.goto(SITE, { waitUntil: 'networkidle' });
    const home = await A.page.locator(tid('home-new-group')).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    const welcome = await A.page.locator(tid('welcome-name')).count();
    await shot(A.page, '02-after-wipe');
    check('after the wipe the app opens signed in (Home, not Welcome)', home && welcome === 0, 'welcome fields: ' + welcome);
    const meAgain = await pageApi(A.page, 'GET', '/api/me');
    check('same account after the wipe', meAgain.status === 200 && meAgain.data.user.id === aId, meAgain.status);
    check('after the wipe it runs on the cookie alone (no token copy came back)', (await A.page.evaluate(() => localStorage.getItem('evenly.token'))) === null);

    // 4. Sign out: only the Worker can end the cookie session, so offline the app refuses.
    await A.page.goto(SITE + '#/account', { waitUntil: 'networkidle' });
    await A.ctx.setOffline(true);
    await A.page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await A.page.locator(tid('account-logout')).click({ timeout: 20000 });
    await A.page.locator(tid('dialog-confirm')).click({ timeout: 5000 }).catch(() => undefined);
    const refused = await A.page.locator('[role="alert"]', { hasText: '登出需要網路連線' }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    check('signing out offline is refused, saying it needs a connection', refused && !!(await siteCookies(A.ctx)).session);
    await shot(A.page, '04-sign-out-offline');
    await A.ctx.setOffline(false);
    await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
    // Online: the Worker clears both cookies.
    await A.page.locator(tid('account-logout')).click({ timeout: 20000 });
    // Unsynced changes would make the app ask first; nothing else does for an account with an email.
    await A.page.locator(tid('dialog-confirm')).click({ timeout: 5000 }).catch(() => undefined);
    await A.page.locator(tid('welcome-name')).waitFor({ timeout: 20000 });
    const out = await siteCookies(A.ctx);
    check('sign-out clears both cookies', !out.session && !out.marker, describe(out.session) + ' ' + describe(out.marker));
    await A.page.reload({ waitUntil: 'networkidle' });
    check('signed out after a reload too', await A.page.locator(tid('welcome-name')).waitFor({ timeout: 20000 }).then(() => true, () => false));
    const spareA = spares.find(s => s.label === 'A');
    if (spareA) check("sign-out ended only this browser's session", (await nodeApi('GET', '/api/me', { token: spareA.token })).status === 200);
    await A.ctx.close();

    // 3. A token an older build saved in localStorage is moved into the cookie.
    const B = await newDevice(browser, 'B');
    const legacy = await nodeAccount('test-cookie-B-' + RUN);
    await plainPage(B.page);
    await B.page.evaluate(t => localStorage.setItem('evenly.token', t), legacy.token);
    await B.page.goto(SITE, { waitUntil: 'networkidle' });
    const bHome = await B.page.locator(tid('home-new-group')).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    check('with a saved token the app opens signed in', bHome);
    const moved = await waitFor(async () => {
      const owner = await B.page.evaluate(() => localStorage.getItem('evenly.tokenUser'));
      const c = await siteCookies(B.ctx);
      return owner && c.session && c.marker ? c : null;
    });
    const bCopy = await B.page.evaluate(() => [localStorage.getItem('evenly.token'), localStorage.getItem('evenly.tokenUser')]);
    check('the saved token is moved into the cookie, and kept in localStorage as the copy',
      !!moved && moved.session.value === legacy.token && moved.marker.value === legacy.userId && moved.session.httpOnly
        && bCopy[0] === legacy.token && bCopy[1] === legacy.userId, moved ? describe(moved.marker) : 'not moved');
    const bSessions = await nodeApi('GET', '/api/auth/sessions', { token: legacy.token });
    check('moving it made no new session', bSessions.status === 200 && bSessions.data.sessions.length === 1, bSessions.status + ' ' + (bSessions.data && bSessions.data.sessions && bSessions.data.sessions.length));
    const bCalls = [];
    B.page.on('request', r => {
      if (new URL(r.url()).pathname.startsWith('/api/')) bCalls.push(!!r.headers()['authorization']);
    });
    await B.page.reload({ waitUntil: 'networkidle' });
    await B.page.locator(tid('home-new-group')).first().waitFor({ timeout: 30000 }).catch(() => undefined);
    await B.page.waitForTimeout(1000);
    const bMe = await pageApi(B.page, 'GET', '/api/me');
    check('after a reload it is signed in with the cookie alone (no Authorization header)',
      bMe.status === 200 && bMe.data.user.id === legacy.userId && bCalls.length > 0 && bCalls.every(x => !x), bMe.status + ' calls ' + JSON.stringify(bCalls));

    // 3b. The cookie is gone but localStorage is not (a Home Screen app after WebKit capped the
    // cookie and the app sat unused): the app starts on the copy and puts it back into the cookie.
    await B.ctx.clearCookies();
    await B.page.reload({ waitUntil: 'networkidle' });
    const bBack = await B.page.locator(tid('home-new-group')).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    const restored = await waitFor(async () => {
      const c = await siteCookies(B.ctx);
      return c.session && c.marker ? c : null;
    });
    check('without its cookie the app starts on the token copy and puts it back into the cookie',
      bBack && !!restored && restored.session.value === legacy.token && restored.marker.value === legacy.userId, restored ? 'restored' : 'no cookie');
    await shot(B.page, '03-adopted');
    check('no /api/ answer in Cache Storage (B)', (await cachedApi(B.page)).length === 0);
    await B.ctx.close();

    // 5. Two tabs of one browser; the second signs in to another account with a code.
    const D = await newDevice(browser, 'D');
    const tab1 = D.page;
    await signUpInUi(tab1, 'test-cookie-D-' + RUN);
    const d = await siteCookies(D.ctx);
    const dId = d.marker ? d.marker.value : null;
    const spareD = dId ? await spareSession(tab1, 'D') : null;
    const other = await nodeAccount('test-cookie-E-' + RUN);
    const code = await nodeApi('POST', '/api/auth/link-code', { token: other.token, body: {} });
    if (code.status !== 200) throw new Error('link-code for E: ' + code.status);
    await tab1.evaluate(() => { window.__beforeSwitch = 1; });
    const tab2 = await D.ctx.newPage();
    watch(tab2, 'D tab 2');
    await tab2.goto(SITE + '#/link/' + code.data.code, { waitUntil: 'networkidle' });
    // Signed in already, so the code waits for a tap, and the app asks before switching.
    await tab2.locator(tid('link-submit')).click({ timeout: 20000 });
    await tab2.locator(tid('dialog-confirm')).click({ timeout: 10000 });
    await tab2.locator(tid('home-new-group')).first().waitFor({ timeout: 30000 });
    const e = await siteCookies(D.ctx);
    check('the second tab signed this browser in to the other account', !!e.marker && e.marker.value === other.userId, describe(e.marker));
    const reloaded = await waitFor(async () => (await tab1.evaluate(() => window.__beforeSwitch)) === undefined);
    check('the first tab reloads by itself', !!reloaded);
    const tab1User = await waitFor(async () => {
      const r = await pageApi(tab1, 'GET', '/api/me');
      return r.status === 200 ? r.data.user.id : null;
    });
    check('the first tab is the other account after the reload', tab1User === other.userId, tab1User);
    const tab1Home = await tab1.locator(tid('home-new-group')).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    check('the first tab shows Home', tab1Home);
    await shot(tab1, '05-first-tab');
    if (spareD) {
      const left = await nodeApi('GET', '/api/auth/sessions', { token: spareD });
      check("switching deleted the browser's previous session (only the spare is left)", left.status === 200 && left.data.sessions.length === 1, left.status + ' ' + (left.data && left.data.sessions && left.data.sessions.length));
    }
    check('no /api/ answer in Cache Storage (D)', (await cachedApi(tab1)).length === 0);
    await D.ctx.close();

    // 7. The page lost the marker and its storage, the session cookie lives: the page load
    // renews both cookies (src/worker/index.ts), so the app starts as that account, and a signup
    // sent over the live cookie anyway is refused, so no second account is made over it.
    const F = await newDevice(browser, 'F');
    const fName = 'test-cookie-F-' + RUN;
    await signUpInUi(F.page, fName);
    const f = await siteCookies(F.ctx);
    const fId = f.marker ? f.marker.value : null;
    if (fId) await spareSession(F.page, 'F');
    await wipeScriptStorage(F.page);
    await F.ctx.clearCookies({ name: MARKER });
    await F.page.goto(SITE, { waitUntil: 'networkidle' });
    const fHome = await F.page.locator(tid('home-new-group')).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    const fBack = await siteCookies(F.ctx);
    check('without the marker, the page load puts it back and the app starts as that account',
      fHome && !!fBack.marker && fBack.marker.value === fId, describe(fBack.marker));
    const fMe = await pageApi(F.page, 'GET', '/api/me');
    check('same account, same name', fMe.status === 200 && fMe.data.user.id === fId && fMe.data.user.name === fName, fMe.status);
    const again = await pageApi(F.page, 'POST', '/api/auth/signup', { name: 'test-cookie-F2-' + RUN });
    check('a signup over the live cookie is refused (409 already_signed_in, no second account)',
      again.status === 409 && again.data && again.data.error.code === 'already_signed_in' && again.data.error.details.userId === fId, again.status);
    await shot(F.page, '07-marker-restored');
    await F.ctx.close();

    // 8. No cookies kept: the page's API requests are made from Node instead (route.fetch() would
    // store the answer's cookies in the browser), and answered without their Set-Cookie lines.
    // No service worker here: requests passing through one are not routed.
    const G = await newDevice(browser, 'G', { serviceWorkers: 'block' });
    await G.page.route(url => new URL(url).pathname.startsWith('/api/'), async route => {
      const req = route.request();
      const headers = { ...(await req.allHeaders()) };
      for (const h of ['host', 'connection', 'content-length', 'accept-encoding', 'cookie']) delete headers[h];
      const r = await fetch(req.url(), { method: req.method(), headers, body: req.postDataBuffer() || undefined });
      const out = {};
      r.headers.forEach((v, k) => {
        if (!['set-cookie', 'content-encoding', 'content-length'].includes(k)) out[k] = v;
      });
      await route.fulfill({ status: r.status, headers: out, body: Buffer.from(await r.arrayBuffer()) });
    });
    const gCalls = [];
    G.page.on('request', r => {
      if (new URL(r.url()).pathname.startsWith('/api/')) gCalls.push(!!r.headers()['authorization']);
    });
    await signUpInUi(G.page, 'test-cookie-G-' + RUN);
    const gToken = await G.page.evaluate(() => localStorage.getItem('evenly.token'));
    if (gToken) spares.push({ label: 'G', token: gToken });
    check('no cookies kept: the app saves the token and stays on it', !!gToken && !(await siteCookies(G.ctx)).session
      && (await G.page.evaluate(() => localStorage.getItem('evenly.auth'))) === 'bearer');
    const gFrom = gCalls.length;
    await G.page.reload({ waitUntil: 'networkidle' });
    const gHome = await G.page.locator(tid('home-new-group')).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    await G.page.waitForTimeout(1000);
    check('after a reload it is still signed in, with the token', gHome && gCalls.length > gFrom && gCalls.slice(gFrom).every(Boolean));
    await G.ctx.close();

    // 9. Sign in with Apple and Google, with none of Apple's or Google's pages: on 開始使用,
    // 使用 Apple 登入 comes first, above Google's and as large, where the site offers both, with
    // Apple's logo file as tall as the button and the title at 43% of its height; a tap on it
    // leaves for appleid.apple.com with the Services ID (stopped there) after setting the
    // SameSite=None flow cookie; 我的 > 登入方式 shows Apple and Google, each with 連結; and a
    // pending link that is gone says so on 我的.
    const H = await newDevice(browser, 'H');
    const offered = await nodeApi('GET', '/api/auth/providers');
    await H.page.goto(SITE, { waitUntil: 'networkidle' });
    if (offered.data && offered.data.apple && offered.data.google) {
      await H.page.locator(tid('apple-sign-in')).waitFor({ timeout: 30000 });
      const order = await H.page.evaluate(() => {
        const a = document.querySelector('[data-testid="apple-sign-in"]');
        const g = document.querySelector('[data-testid="google-sign-in"]');
        if (!a || !g) return null;
        const ra = a.getBoundingClientRect();
        const rg = g.getBoundingClientRect();
        return {
          appleFirst: !!(a.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING),
          above: rg.top - ra.top,
          sameSize: Math.abs(ra.width - rg.width) < 1 && Math.abs(ra.height - rg.height) < 1,
          text: a.textContent,
        };
      });
      check('開始使用: 使用 Apple 登入 above Google\'s, at the same size', !!order && order.appleFirst && order.above > 0 && order.sameSize && /使用 Apple 登入/.test(order.text), JSON.stringify(order));
      const hig = await H.page.evaluate(() => {
        const a = document.querySelector('[data-testid="apple-sign-in"]');
        const logo = a && a.querySelector('svg');
        const label = a && a.querySelector('span');
        if (!a || !logo || !label) return null;
        const ra = a.getBoundingClientRect();
        const rl = logo.getBoundingClientRect();
        return { button: ra.height, logo: rl.height, logoTop: rl.top - ra.top, box: logo.getAttribute('viewBox'), title: parseFloat(getComputedStyle(label).fontSize) };
      });
      check('使用 Apple 登入 as the HIG draws it: Apple\'s 31 x 44 logo file as tall as the button, the title 43% of its height',
        !!hig && hig.box === '0 0 31 44' && Math.abs(hig.logo - hig.button) < 1 && Math.abs(hig.logoTop) < 1 && Math.abs(hig.title - hig.button * 0.43) < 0.6, JSON.stringify(hig));
      await shot(H.page, '09-welcome-apple-google');
      let bound = null;
      await H.page.route('https://appleid.apple.com/**', route => {
        bound = route.request().url();
        return route.abort();
      });
      await H.page.locator(tid('apple-sign-in')).click();
      await waitFor(async () => bound, 15000, 200);
      const u = bound ? new URL(bound) : null;
      check('a tap on it starts at Apple with the Services ID and this site\'s callback',
        !!u && u.pathname === '/auth/authorize' && u.searchParams.get('client_id') === 'com.ginochang.evenly.web'
        && u.searchParams.get('redirect_uri') === ORIGIN + '/api/auth/apple/callback' && u.searchParams.get('response_mode') === 'form_post',
        bound && bound.replace(/(state|nonce)=[^&]+/g, '$1=...'));
      const flowCookie = (await H.ctx.cookies(SITE)).find(c => c.name === '__Host-evenly_apple');
      check('the Apple flow cookie is HttpOnly, Secure and SameSite=None', !!flowCookie && flowCookie.httpOnly && flowCookie.secure && flowCookie.sameSite === 'None',
        flowCookie && JSON.stringify({ ...flowCookie, value: '(hidden)' }));
      await H.page.unroute('https://appleid.apple.com/**');
      await signUpInUi(H.page, 'test-cookie-H-' + RUN);
      await spareSession(H.page, 'H');
      await H.page.goto(SITE + '#/account', { waitUntil: 'networkidle' });
      await H.page.locator(tid('account-apple')).waitFor({ timeout: 30000 });
      const rows = await H.page.evaluate(() => ['apple', 'google'].map(id => {
        const link = document.querySelector(`[data-testid="account-link-${id}"]`);
        return { id, row: !!document.querySelector(`[data-testid="account-${id}"]`), link: link ? link.getAttribute('href') : '' };
      }));
      check('我的 > 登入方式: Apple and Google, each with 連結 to its link start', rows.every(r => r.row && r.link.startsWith(ORIGIN + '/api/auth/' + r.id + '/start?link=1')), JSON.stringify(rows));
      const rowLogo = await H.page.evaluate(() => {
        const row = document.querySelector('[data-testid="account-apple"]');
        const svg = row && row.querySelector('svg');
        if (!row || !svg) return null;
        return { box: svg.getAttribute('viewBox'), height: svg.getBoundingClientRect().height, row: row.getBoundingClientRect().height };
      });
      check('我的 > 登入方式: the Apple row shows Apple\'s 31 x 44 logo file uncropped, as tall as the row',
        !!rowLogo && rowLogo.box === '0 0 31 44' && Math.abs(rowLogo.height - 44) < 1 && rowLogo.row >= 44, JSON.stringify(rowLogo));
      await H.page.locator(tid('account-apple')).scrollIntoViewIfNeeded();
      await shot(H.page, '09-account-sign-in');
      // The address a link's callback opens, with an id the Worker never made (or one that timed out).
      await H.page.goto(SITE + '?link_pending=' + 'x'.repeat(43) + '#/account', { waitUntil: 'networkidle' });
      const gone = await H.page.locator(tid('toast')).filter({ hasText: '連結的時間過了' }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
      const address = await H.page.evaluate(() => location.search + location.hash);
      check('a pending link that is gone: 我的 says it timed out, and the flag leaves the address', gone && address === '#/account', address);

      // A 320 px phone in English: the title keeps 43% on one line, the padding gives way.
      const N = await newDevice(browser, 'N', { viewport: { width: 320, height: 640 }, locale: 'en' });
      await N.page.addInitScript(() => { try { localStorage.setItem('evenly.locale', 'en'); } catch (e) {} });
      await N.page.goto(SITE, { waitUntil: 'networkidle' });
      await N.page.locator(tid('apple-sign-in')).waitFor({ timeout: 30000 });
      const narrow = await N.page.evaluate(() => {
        const a = document.querySelector('[data-testid="apple-sign-in"]');
        const logo = a.querySelector('svg');
        const label = a.querySelector('span');
        const ra = a.getBoundingClientRect();
        const rl = logo.getBoundingClientRect();
        const rt = label.getBoundingClientRect();
        const st = getComputedStyle(label);
        return {
          text: label.textContent, width: ra.width, button: ra.height, logo: rl.height, title: parseFloat(st.fontSize),
          lines: Math.round(rt.height / parseFloat(st.lineHeight)), right: ra.right - rt.right, left: rl.left - ra.left,
          clip: getComputedStyle(a).overflow,
        };
      });
      check('320 px, English: Sign in with Apple at 43% on one line, the logo file as tall as the button and inside its pill, at least 8% to the right edge',
        narrow.text === 'Sign in with Apple' && narrow.width < 280 && Math.abs(narrow.title - narrow.button * 0.43) < 0.6 && narrow.lines === 1
          && Math.abs(narrow.logo - narrow.button) < 1 && narrow.right >= narrow.width * 0.08 - 0.5 && narrow.left >= -0.5
          && narrow.clip === 'hidden', JSON.stringify(narrow));
      await N.page.locator(tid('apple-sign-in')).screenshot({ path: path.join(OUT, '09-apple-320-en.png') });

      // The iPhone app's Google start, opened as ASWebAuthenticationSession opens it (a load of its
      // own): what Fetch Metadata the browser sends, and that it goes on to Google. Stopped there.
      const startUrl = ORIGIN + '/api/auth/google/start?client=ios&challenge=' + 'A'.repeat(43) + '&locale=en';
      const sentSite = [];
      N.page.on('request', req => {
        if (req.url().startsWith(ORIGIN + '/api/auth/google/start')) void req.allHeaders().then(h => sentSite.push(h['sec-fetch-site'] || '(none sent)'), () => undefined);
      });
      let toGoogle = null;
      await N.page.route('https://accounts.google.com/**', route => {
        toGoogle = route.request().url();
        return route.abort();
      });
      await N.page.goto(startUrl).catch(() => undefined);
      await waitFor(async () => toGoogle, 15000, 200);
      check('the iPhone start loaded on its own (as the app\'s sign-in sheet loads it) goes on to Google',
        !!toGoogle && toGoogle.startsWith('https://accounts.google.com/'), JSON.stringify({ sent: sentSite }));
      console.log('       (the start\'s own load sent Sec-Fetch-Site: ' + (sentSite[0] || 'nothing seen') + ')');
      // The same address followed from a page on another site (served here by the test): refused,
      // and no flow cookie is set.
      toGoogle = null;
      await N.ctx.clearCookies();
      await N.page.route('https://elsewhere.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<a id="go" href="${startUrl}">go</a>` }));
      await N.page.goto('https://elsewhere.test/');
      await N.page.click('#go');
      await waitFor(async () => N.page.url().includes('/app/auth/google'), 15000, 200);
      const flowAfter = (await N.ctx.cookies(SITE)).find(c => c.name === '__Host-evenly_google');
      check('the same start followed from a page is refused (start) and sets no flow cookie',
        N.page.url() === ORIGIN + '/app/auth/google?error=start' && !flowAfter && !toGoogle, JSON.stringify({ url: N.page.url(), sent: sentSite.slice(1) }));
      await N.ctx.close();
    } else {
      check('this site offers Apple and Google (GET /api/auth/providers)', false, JSON.stringify(offered.data));
    }
    await H.ctx.close();
  } catch (err) {
    check('flows completed without exceptions', false, err.stack || err.message);
  } finally {
    // Delete every account this run made (one spare session each), whatever happened above.
    for (const s of spares) {
      const r = await nodeApi('DELETE', '/api/me', { token: s.token, body: {} }).catch(() => ({ status: 0 }));
      check('cleanup: delete ' + s.label, r.status === 200, r.status);
    }
    check('no page errors', errors.length === 0, errors.join('\n'));
    await browser.close();
    console.log(`\n${pass} passed, ${fail} failed. Screenshots: ${OUT}`);
    if (fail) {
      console.log('Failed:\n - ' + failures.join('\n - '));
      process.exit(1);
    }
  }
})();
