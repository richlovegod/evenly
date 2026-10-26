// Friend invite links end to end in WebKit (Safari's engine) with iPhone 14 emulation (390 px) in
// zh-TW (docs/SPEC.md sections 4 and 8.3):
//   node tests/e2e/invite-flows.cjs [baseUrl] [shotDir]
// baseUrl: the built app (vite preview on :4173, default) talking to the staging Worker, as
// tests/e2e/flows.cjs does; or the staging site itself, which then also opens the share URL as it
// is (https://<staging>/i/<code>, the page the Worker serves) and proves it lands on #/i/<code>.
// The API must answer /api/health with env "staging" (ALLOW_ANY_ENV=1 runs it elsewhere); requests
// to production hosts are refused. Signing up takes an email code: the start answer's devCode
// (staging's test mode, EMAIL_DEV_ECHO), for an address on evenly.test, which is never mailed.
// Every account and 1:1 ledger the run makes is deleted at the end, also when a check fails.
// The share sheet and the clipboard are stubbed in the inviter's browser (WebKit in Playwright has
// neither), so the checks read exactly what went out.
//  I1 The inviter opens 邀請朋友 from 朋友 (its empty state and its band offer it): the link, its QR
//     code, the three messages; switching chips fills the box, an edit stays until the next chip,
//     and the pick is remembered across a reload (the edit is not).
//  I2 分享 sends the edited text with the link on its own line; 複製文案 copies the same; 複製連結
//     the link alone.
//  I3 A second, signed-out browser opens the link (path form; on the preview, vite's SPA fallback
//     plays the Worker), lands on #/i/<code> with 「Gino 邀請你一起分帳」, signs up with the email
//     code (the sheet asks for a name, the address having no account) and lands in the new 1:1
//     ledger, both people admins.
//  I4 The inviter's 朋友 shows the new friend; the inviter's feed has who joined through the link.
//  I5 Opening the link again says 已經是朋友了 and opens the same ledger.
//  I6 A signed-in third person sees 加為朋友 and gets their own ledger with one tap.
//  I7 The inviter's own link says it is theirs, with a way to 邀請朋友.
//  I8 重設連結 (confirmed) makes the old link say it no longer works; the new one works.
// Screenshots at 390 px go to shotDir: web-inviter.png (and web-inviter-full.png, the whole page),
// web-recipient-signed-out.png, web-recipient-signed-in.png, web-self.png, web-invalid.png (and
// more for a failure).

const path = require('path');
const fs = require('fs');
const { webkit, devices } = require('C:/Users/chunju/.claude/tmp/webkit-test/node_modules/playwright');

const BASE = (process.argv[2] || 'http://127.0.0.1:4173/').replace(/\/?$/, '/');
const SHOTS = process.argv[3] || path.join(__dirname, '..', '..', 'tmp', 'e2e-invite');
const API = (process.env.API || 'https://evenly-api-staging.richlovegod.workers.dev').replace(/\/+$/, '');
const PRODUCTION = ['split.ginochang.com', 'evenly-api.richlovegod.workers.dev'];
const ON_SITE = new URL(BASE).origin === new URL(API).origin;
const RUN = Date.now().toString(36);
fs.mkdirSync(SHOTS, { recursive: true });

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
/** Bearer sessions for the cleanup. */
const spares = [];

// The share sheet and the clipboard, recorded: window.__shared and window.__copied.
const STUBS = `(() => {
  window.__shared = [];
  window.__copied = [];
  Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.__shared.push(data); } });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied.push(text); } } });
})();`;

async function nodeApi(method, p, { token, body } = {}) {
  const headers = { 'User-Agent': 'evenly-invite-flows/1.0 (Node)' };
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
  return { status: res.status, data, text };
}

/** An account with a confirmed email, made from Node with the echoed code (kept for the cleanup). */
async function nodeAccount(name, email) {
  const start = await nodeApi('POST', '/api/auth/email/start', { body: { email, locale: 'zh-TW' } });
  if (!start.data || !start.data.devCode) throw new Error('email start from Node: ' + start.status);
  const r = await nodeApi('POST', '/api/auth/email/verify', { body: { email, code: start.data.devCode, name, locale: 'zh-TW' } });
  if (r.status !== 200 || !r.data || !r.data.token) throw new Error('email verify from Node: ' + r.status);
  spares.push({ label: name, token: r.data.token });
  return { token: r.data.token, userId: r.data.user.id };
}

/** A browser at 390 px; signed in with `token` (Bearer, or moved into the cookie on the site) when given. */
async function newPerson(browser, label, token) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'], locale: 'zh-TW', serviceWorkers: 'block' });
  await ctx.route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    if (PRODUCTION.includes(host)) {
      blocked.push(host);
      return route.abort();
    }
    return route.continue();
  });
  await ctx.addInitScript(({ api, token, onSite }) => {
    try {
      if (!onSite) localStorage.setItem('evenly.api', api);
      if (token && !sessionStorage.getItem('evenly.e2e.seeded')) {
        localStorage.setItem('evenly.token', token);
        sessionStorage.setItem('evenly.e2e.seeded', '1');
      }
    } catch (e) {}
  }, { api: API, token: token || null, onSite: ON_SITE });
  await ctx.addInitScript(STUBS);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(label + ' pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(label + ' console: ' + m.text());
  });
  return { ctx, page };
}

async function settle(page, ms = 300) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  if (ms) await page.waitForTimeout(ms);
}

async function shot(page, name, fullPage = false) {
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage }).catch(() => undefined);
}

/** Ask for a code with `send` and type it in: the code is the start answer's devCode. */
async function enterCode(page, send) {
  const started = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/email/start', { timeout: 20000 });
  await send();
  const res = await started;
  const body = await res.json().catch(() => ({}));
  if (!body.devCode) throw new Error('no devCode in the start answer (' + res.status() + ')');
  await page.locator(tid('code-input')).fill(body.devCode);
  return body.devCode;
}

/** The address a browser opens for the share URL: itself on the site; on the preview, the same path there. */
function openable(url) {
  if (ON_SITE) return url;
  const u = new URL(url);
  return BASE + u.pathname.replace(/^\//, '') + u.search;
}

async function cardState(page) {
  const card = page.locator(tid('invite-card'));
  await card.waitFor({ timeout: 20000 });
  return { state: await card.getAttribute('data-state'), title: (await page.locator(tid('invite-title')).innerText()).trim(), hash: await page.evaluate(() => location.hash) };
}

(async () => {
  console.log(`Friend invite links against ${BASE} (API ${API})`);
  if (PRODUCTION.includes(new URL(API).hostname) || PRODUCTION.includes(new URL(BASE).hostname)) {
    console.log('Refusing to run against production.');
    process.exit(2);
  }
  const health = await nodeApi('GET', '/api/health').catch(() => ({ status: 0, data: null }));
  if (!(health.status === 200 && health.data && health.data.env === 'staging') && !process.env.ALLOW_ANY_ENV) {
    console.log('The API does not say staging: ' + JSON.stringify(health.data));
    process.exit(2);
  }
  const browser = await webkit.launch();
  const pages = [];
  let gino = null;
  let kai = null;
  let abbieToken = null;
  let firstUrl = null;
  try {
    gino = await nodeAccount('Gino', `e2e-inv-g-${RUN}@evenly.test`);
    kai = await nodeAccount('佳穎', `e2e-inv-k-${RUN}@evenly.test`);
    const G = await newPerson(browser, 'Gino', gino.token);
    pages.push(['gino', G.page]);
    const g = G.page;

    // I1 邀請朋友 from 朋友.
    console.log('I1 the inviter opens 邀請朋友');
    await g.goto(BASE + '#/friends', { waitUntil: 'networkidle' });
    await g.locator(tid('friends-empty-invite')).waitFor({ timeout: 30000 });
    check('I1 朋友 with no friends offers 邀請朋友 in its empty state and its band', (await g.locator(tid('friends-invite')).count()) === 1);
    await g.locator(tid('friends-invite')).click();
    await g.locator(tid('invite-link')).waitFor({ timeout: 20000 });
    check('I1 the band button opens #/invite-friends', (await g.evaluate(() => location.hash)) === '#/invite-friends');
    firstUrl = (await g.locator(tid('invite-link')).innerText()).trim();
    const code = (/\/i\/([A-Za-z0-9]+)\?openExternalBrowser=1$/.exec(firstUrl) || [])[1];
    check('I1 the link is the server\'s share URL: <site>/i/<code>?openExternalBrowser=1', !!code && firstUrl.startsWith(API + '/i/'), firstUrl);
    check('I1 with its QR code', (await g.locator('svg[role="img"][aria-label*="QR"]').count()) === 1);
    const me = await nodeApi('GET', '/api/me/invite?locale=zh-TW', { token: gino.token });
    const templates = me.data.templates;
    const box = g.locator(tid('invite-text'));
    const pressed = async () => Promise.all(['everyday', 'trip', 'roommates'].map(k => g.locator(tid('invite-template-' + k)).getAttribute('aria-pressed')));
    check('I1 three messages, 日常 picked, its words in the box', JSON.stringify(await pressed()) === '["true","false","false"]' && (await box.inputValue()) === templates[0].text, await box.inputValue());
    await g.locator(tid('invite-template-trip')).click();
    check('I1 旅行 fills the box with its own words', (await box.inputValue()) === templates[1].text && JSON.stringify(await pressed()) === '["false","true","false"]');
    await g.locator(tid('invite-template-roommates')).click();
    check('I1 室友 too', (await box.inputValue()) === templates[2].text);
    const edited = templates[2].text.replace('房租', '房租和網路費');
    await box.fill(edited);
    check('I1 the box takes an edit', (await box.inputValue()) === edited);
    await g.reload({ waitUntil: 'networkidle' });
    await g.locator(tid('invite-text')).waitFor({ timeout: 20000 });
    check('I1 a reload keeps the pick (室友) but not the edit', (await g.locator(tid('invite-text')).inputValue()) === templates[2].text && (await g.locator(tid('invite-template-roommates')).getAttribute('aria-pressed')) === 'true');
    await g.locator(tid('invite-template-everyday')).click();
    await settle(g);
    await g.evaluate(() => window.scrollTo(0, 0));
    await shot(g, 'web-inviter');
    await shot(g, 'web-inviter-full', true);

    // I2 分享, 複製文案, 複製連結.
    console.log('I2 share and copy');
    const mine = '週末去爬山，用吉諾分帳所記帳吧';
    await g.locator(tid('invite-text')).fill(mine);
    await g.locator(tid('invite-share')).click();
    await settle(g, 200);
    const shared = await g.evaluate(() => window.__shared);
    check('I2 分享 sends the text, then the link on its own line', shared.length === 1 && shared[0].text === mine + '\n' + firstUrl, JSON.stringify(shared));
    await g.locator(tid('invite-copy-text')).click();
    await g.locator(tid('toast')).first().waitFor({ timeout: 5000 });
    await g.locator(tid('invite-copy-link')).click();
    await settle(g, 300);
    const copied = await g.evaluate(() => window.__copied);
    check('I2 複製文案 copies the same message, 複製連結 the link alone', copied.length === 2 && copied[0] === mine + '\n' + firstUrl && copied[1] === firstUrl, JSON.stringify(copied));

    // I3 A signed-out browser opens the link and signs up.
    console.log('I3 a signed-out browser opens the link');
    const A = await newPerson(browser, 'Abbie', null);
    pages.push(['abbie', A.page]);
    const a = A.page;
    await a.goto(openable(firstUrl), { waitUntil: 'networkidle' });
    let st = await cardState(a);
    check('I3 the link lands on #/i/<code>, signed out, 「Gino 邀請你一起分帳」', st.hash === '#/i/' + code && st.state === 'signed-out' && st.title === 'Gino 邀請你一起分帳', JSON.stringify(st));
    check('I3 the address keeps ?openExternalBrowser=1 before the hash', await a.evaluate(() => location.search === '?openExternalBrowser=1' && location.pathname === '/'), await a.evaluate(() => location.href));
    await settle(a);
    await shot(a, 'web-recipient-signed-out');
    await a.locator(tid('invite-accept')).click();
    await a.locator(tid('signin-email')).waitFor({ timeout: 10000 });
    await a.locator(tid('signin-email')).fill(`e2e-inv-a-${RUN}@evenly.test`);
    await enterCode(a, () => a.locator(tid('signin-send')).click());
    await a.locator(tid('code-name')).waitFor({ timeout: 15000 });
    check('I3 an address with no account: the sheet asks for a name', true);
    await a.locator(tid('code-name')).fill('Abbie');
    await a.locator(tid('code-submit')).click();
    await a.locator(tid('group-title')).waitFor({ timeout: 30000 });
    const gid = (/#\/g\/([^/?]+)/.exec(a.url()) || [])[1];
    abbieToken = await a.evaluate(() => localStorage.getItem('evenly.token'));
    const aMe = await a.evaluate(async api => {
      const token = localStorage.getItem('evenly.token');
      const r = await fetch(api + '/api/me', { headers: token ? { Authorization: 'Bearer ' + token } : {}, credentials: 'same-origin' });
      return r.json();
    }, ON_SITE ? '' : API);
    if (!abbieToken) abbieToken = null;
    check('I3 signed up as Abbie, with the email confirmed', aMe.user && aMe.user.name === 'Abbie' && aMe.user.emailVerified === true, JSON.stringify(aMe.user));
    const snap = await nodeApi('GET', '/api/groups/' + gid, { token: gino.token });
    const people = snap.data && snap.data.members ? snap.data.members.map(m => [m.name, m.role, !!m.userId]) : [];
    check('I3 landed in the new 1:1 ledger with Gino, both admins', !!gid && snap.data.group.type === 'pair' && JSON.stringify(people) === JSON.stringify([['Gino', 'admin', true], ['Abbie', 'admin', true]]), JSON.stringify(people));
    // Keep a Bearer session for the cleanup (on the site the browser's is a cookie).
    if (aMe.user) {
      const s = await nodeApi('POST', '/api/auth/email/start', { body: { email: `e2e-inv-a-${RUN}@evenly.test` } });
      const v = await nodeApi('POST', '/api/auth/email/verify', { body: { email: `e2e-inv-a-${RUN}@evenly.test`, code: s.data && s.data.devCode } });
      if (v.data && v.data.token) spares.push({ label: 'Abbie', token: v.data.token });
    }

    // I4 The inviter's 朋友 and feed.
    console.log("I4 the inviter's friends and feed");
    await g.goto(BASE + '#/friends', { waitUntil: 'networkidle' });
    await g.locator(tid('friend-row'), { hasText: 'Abbie' }).first().waitFor({ timeout: 30000 }).then(() => check('I4 Gino\'s 朋友 lists Abbie', true)).catch(() => check('I4 Gino\'s 朋友 lists Abbie', false));
    const feed = await nodeApi('GET', '/api/activity', { token: gino.token });
    const joined = feed.data && feed.data.items ? feed.data.items.find(i => i.type === 'friend.join') : null;
    check('I4 Gino\'s feed: Abbie joined through his link', !!joined && joined.actorName === 'Abbie' && joined.groupId === gid, JSON.stringify(feed.data && feed.data.items && feed.data.items.slice(0, 2)));

    // I5 The link again: already friends.
    console.log('I5 the link again');
    await a.goto(openable(firstUrl), { waitUntil: 'networkidle' });
    st = await cardState(a);
    check('I5 says they are friends already', st.state === 'friends' && st.title === '你和 Gino 已經是朋友了', JSON.stringify(st));
    await a.locator(tid('invite-open-ledger')).click();
    await a.locator(tid('group-title')).waitFor({ timeout: 20000 });
    check('I5 and opens the same ledger', a.url().includes('#/g/' + gid), a.url());

    // I6 A signed-in third person.
    console.log('I6 a signed-in third person');
    const K = await newPerson(browser, '佳穎', kai.token);
    pages.push(['kai', K.page]);
    const k = K.page;
    await k.goto(BASE + '#/', { waitUntil: 'networkidle' });
    await k.goto(openable(firstUrl), { waitUntil: 'networkidle' });
    st = await cardState(k);
    check('I6 signed in: 「Gino 邀請你一起分帳」 with 加為朋友', st.state === 'ready' && st.title === 'Gino 邀請你一起分帳' && (await k.locator(tid('invite-accept')).count()) === 1, JSON.stringify(st));
    await settle(k);
    await shot(k, 'web-recipient-signed-in');
    await k.locator(tid('invite-accept')).click();
    await k.locator(tid('group-title')).waitFor({ timeout: 30000 });
    const kGid = (/#\/g\/([^/?]+)/.exec(k.url()) || [])[1];
    check('I6 one tap: a ledger of their own', !!kGid && kGid !== gid, k.url());

    // I7 The inviter's own link.
    console.log("I7 the inviter's own link");
    await g.goto(openable(firstUrl), { waitUntil: 'networkidle' });
    st = await cardState(g);
    check('I7 says it is his own link', st.state === 'self' && st.title === '這是你自己的邀請連結', JSON.stringify(st));
    await settle(g);
    await shot(g, 'web-self');
    await g.locator(tid('invite-self-open')).click();
    await g.locator(tid('invite-link')).waitFor({ timeout: 20000 });
    check('I7 with a way to 邀請朋友', (await g.evaluate(() => location.hash)) === '#/invite-friends');

    // I8 Reset.
    console.log('I8 reset the link');
    await g.locator(tid('invite-reset')).click();
    await g.locator(tid('dialog-confirm')).click({ timeout: 5000 });
    await g.waitForFunction(old => {
      const el = document.querySelector('[data-testid="invite-link"]');
      return !!el && el.textContent.trim() !== old;
    }, firstUrl, { timeout: 20000 });
    const newUrl = (await g.locator(tid('invite-link')).innerText()).trim();
    check('I8 a new link in its place', newUrl !== firstUrl && /\/i\/[A-Za-z0-9]{16}\?openExternalBrowser=1$/.test(newUrl), newUrl);
    await a.goto(openable(firstUrl), { waitUntil: 'networkidle' });
    await a.locator(tid('invite-invalid')).waitFor({ timeout: 20000 }).then(() => check('I8 the old link says it no longer works', true)).catch(() => check('I8 the old link says it no longer works', false));
    await shot(a, 'web-invalid');
    await a.goto(openable(newUrl), { waitUntil: 'networkidle' });
    st = await cardState(a);
    check('I8 the new one works (and they are still friends)', st.state === 'friends', JSON.stringify(st));
  } catch (e) {
    check('run completed without exceptions', false, e.stack || e.message);
  } finally {
    if (fail) for (const [label, page] of pages) await shot(page, 'zz-' + label + '-end');
    // Delete what this run made: every 1:1 ledger of the accounts, then the accounts.
    for (const s of spares) {
      const me = await nodeApi('GET', '/api/me', { token: s.token }).catch(() => ({ status: 0 }));
      for (const grp of (me.data && me.data.groups) || []) await nodeApi('DELETE', '/api/groups/' + encodeURIComponent(grp.id), { token: s.token }).catch(() => undefined);
    }
    for (const s of spares) {
      const r = await nodeApi('DELETE', '/api/me', { token: s.token, body: {} }).catch(() => ({ status: 0 }));
      check('cleanup: delete ' + s.label, r.status === 200 || r.status === 401, r.status);
    }
    check('no page errors', errors.length === 0, errors.join('\n'));
    check('no request went to production', blocked.length === 0, blocked.join(', '));
    await browser.close();
    console.log(`\n${pass} passed, ${fail} failed. Screenshots: ${SHOTS}`);
    if (fail) {
      console.log('Failed:\n - ' + failures.join('\n - '));
      process.exit(1);
    }
  }
})();
