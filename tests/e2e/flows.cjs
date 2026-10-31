// End-to-end UI flows in WebKit (Safari's engine) with iPhone emulation, against the built app
// (vite preview on :4173) talking to the staging Worker.
//   npm run build (with VITE_API_BASE=staging) && npx vite preview --port 4173
//   node tests/e2e/flows.cjs [baseUrl] [outDir]
// Two people (Gino and Abbie) in separate browser contexts: sign up with an email code, create a
// group, add expenses in two currencies, keep a receipt photo with one and see it on its detail
// page, keep three with another (tiles, the viewer's paging, 移除這張 on one), split by shares,
// settle up, invite and join (the invite asks for an email code too), offline add and sync, set a
// password, sign out and back in with it and with a code, the two-person quick splits at 320 px in
// both languages, for an expense and a refund (13 W's on all four chips in Chinese and 10 in
// English, 對方 / They for one more), switch language. Every code comes from the start answer's
// devCode, read off the network: staging's test mode (EMAIL_DEV_ECHO), so the Worker this runs
// against must have the email routes. Addresses are on evenly.test, which is never mailed.
// Screenshots go to outDir.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { webkit, devices } = require('C:/Users/chunju/.claude/tmp/webkit-test/node_modules/playwright');

const BASE = (process.argv[2] || 'http://127.0.0.1:4173/').replace(/\/?$/, '/');
const OUT = process.argv[3] || path.join(__dirname, '..', '..', 'tmp', 'e2e');
const API = process.env.API || 'https://evenly-api-staging.richlovegod.workers.dev';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
}

const tid = id => `[data-testid="${id}"]`;
const RUN = Date.now().toString(36);

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });
}

async function newPerson(browser, label, deviceName = 'iPhone 14') {
  const ctx = await browser.newContext({ ...devices[deviceName], locale: 'zh-TW' });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(label + ' pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(label + ' console: ' + m.text()); });
  await ctx.addInitScript(api => { try { localStorage.setItem('evenly.api', api); } catch (e) {} }, API);
  return { ctx, page };
}

async function apiGet(page, p) {
  return page.evaluate(async ({ api, p }) => {
    const token = localStorage.getItem('evenly.token');
    const r = await fetch(api + p, { headers: { Authorization: 'Bearer ' + token } });
    return r.json();
  }, { api: API, p });
}

async function waitSynced(page, text, timeout = 20000) {
  const row = page.locator(tid('expense-row'), { hasText: text }).first();
  await row.waitFor({ timeout });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await row.getAttribute('data-state');
    if (st === 'synced') return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Ask for a code with `send` (a click that posts /api/auth/email/start) and type it in: the code
 * is the start answer's devCode. The code field checks a complete code by itself.
 */
async function enterCode(page, send) {
  const started = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/email/start', { timeout: 20000 });
  await send();
  const res = await started;
  const body = await res.json().catch(() => ({}));
  if (!body.devCode) throw new Error('no devCode in the start answer (' + res.status() + '): the Worker needs the email routes and EMAIL_DEV_ECHO');
  await page.locator(tid('code-input')).fill(body.devCode);
  return body.devCode;
}

/**
 * Make crypto.subtle.digest in the page take `ms` longer (0: as it was). Each picked receipt photo
 * gets its version from it, so photos then take a while to prepare, long enough to tap things meanwhile.
 */
async function slowDigest(page, ms) {
  await page.evaluate(ms => {
    const s = crypto.subtle;
    if (!ms) {
      delete s.digest;
      return;
    }
    const real = Object.getPrototypeOf(s).digest;
    s.digest = async (...args) => {
      await new Promise(r => setTimeout(r, ms));
      return real.apply(s, args);
    };
  }, ms);
}

/**
 * No receipt scan of this person ever leaves the page: every page of the context gets a fetch
 * that answers POST .../api/receipts/scan itself (502 scan_failed, reason model) and counts it in
 * sessionStorage (e2e.scans), so nothing here reaches Workers AI. In the page, not page.route:
 * a request from a page a service worker controls goes past page.route in WebKit (2026-10-30,
 * two scans reached staging that way).
 */
async function keepScansInPage(ctx) {
  await ctx.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/api\/receipts\/scan(\?|$)/.test(url)) {
        sessionStorage.setItem('e2e.scans', String(Number(sessionStorage.getItem('e2e.scans') || '0') + 1));
        const body = JSON.stringify({ error: { code: 'scan_failed', message: 'The receipt could not be read', details: { reason: 'model' } } });
        return new Response(body, { status: 502, headers: { 'Content-Type': 'application/json' } });
      }
      return real(input, init);
    };
  });
}

/** How many scans this tab tried (keepScansInPage). */
async function scanCount(page) {
  return page.evaluate(() => Number(sessionStorage.getItem('e2e.scans') || '0'));
}

/** Focus lands on the element with this test id (within `timeout`). */
async function focusOn(page, id, timeout = 3000) {
  return page.waitForFunction(id => !!document.activeElement && document.activeElement.getAttribute('data-testid') === id, id, { timeout }).then(() => true, () => false);
}

/** The element with this test id has `attr` = `value` (within `timeout`). */
async function attrIs(page, id, attr, value, timeout = 3000) {
  return page.waitForFunction(({ id, attr, value }) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    return !!el && el.getAttribute(attr) === value;
  }, { id, attr, value }, { timeout }).then(() => true, () => false);
}

/** What has focus now, by test id. */
async function focusedId(page) {
  return page.evaluate(() => (document.activeElement ? document.activeElement.getAttribute('data-testid') : null));
}

async function pickCurrency(page, code) {
  const sheet = page.locator(tid('sheet')).last();
  await sheet.waitFor();
  const search = sheet.locator('input').first();
  await search.fill(code);
  await sheet.getByText(code, { exact: true }).first().click();
}

async function addExpense(page, { amount, description, currency }) {
  await page.locator(tid('group-add-expense')).first().click();
  await page.locator(tid('editor-amount')).waitFor();
  await page.locator(tid('editor-amount')).fill(String(amount));
  if (currency) {
    await page.locator(tid('editor-currency')).click();
    await pickCurrency(page, currency);
  }
  await page.locator(tid('editor-description')).fill(description);
  if (currency) await page.locator(tid('fx-rate')).waitFor({ timeout: 15000 });
  await page.locator(tid('editor-save')).click();
  await page.locator(tid('group-title')).waitFor({ timeout: 15000 });
}

(async () => {
  console.log('E2E against ' + BASE + ' (API ' + API + ')');
  const browser = await webkit.launch();
  const G = await newPerson(browser, 'Gino');
  await keepScansInPage(G.ctx);
  const A = await newPerson(browser, 'Abbie');
  const g = G.page;
  const a = A.page;
  const gEmail = `e2e-g-${RUN}@evenly.test`;
  try {
    // 1. Gino starts with his name and an email, confirmed with the code it gets.
    await g.goto(BASE, { waitUntil: 'networkidle' });
    await g.locator(tid('welcome-name')).waitFor({ timeout: 20000 });
    check('the welcome page asks for an email, and has no name-only start', (await g.locator(tid('welcome-email')).count()) === 1 && (await g.locator(tid('welcome-start')).count()) === 0);
    await shot(g, '01-welcome');
    await g.locator(tid('welcome-name')).fill('Gino');
    await g.locator(tid('welcome-email')).fill(gEmail.toUpperCase());
    await enterCode(g, async () => {
      await g.locator(tid('welcome-send')).click();
      await g.locator(tid('code-input')).waitFor({ timeout: 20000 });
      check('重新寄送 waits a minute after a code went out', await g.locator(tid('code-resend')).isDisabled());
      await shot(g, '01b-welcome-code');
    });
    await g.locator(tid('home-new-group')).first().waitFor({ timeout: 20000 });
    check('welcome -> code -> home', true);
    const fresh = await apiGet(g, '/api/me');
    check('the new account has the confirmed email', fresh.user && fresh.user.email === gEmail && fresh.user.emailVerified === true && fresh.user.hasPassword === false, JSON.stringify(fresh.user));
    check('no protect card once the email is confirmed', (await g.locator(tid('home-protect')).count()) === 0);
    await shot(g, '02-home-empty');
    // The tab bar draws the colored tab art (TabIcon): 30 px, the current tab at full color, the others faded.
    const tabArt = await g.evaluate(() => ['home', 'groups', 'friends', 'activity'].map(k => {
      const a = document.querySelector(`[data-testid="tab-${k}"]`);
      const svg = a && a.querySelector('svg[data-tab-icon]');
      return svg ? { k, icon: svg.getAttribute('data-tab-icon'), current: a.getAttribute('aria-current'), w: Math.round(svg.getBoundingClientRect().width), op: getComputedStyle(svg).opacity } : { k };
    }));
    check('the tab bar shows the tab art, 總覽 current and the others faded', tabArt.every(x => x.icon === x.k && x.w === 30 && (x.k === 'home' ? x.current === 'page' && x.op === '1' : x.current === null && x.op === '0.55')), JSON.stringify(tabArt));

    // 2. Create a JPY trip with two placeholders.
    await g.locator(tid('home-new-group')).first().click();
    await g.locator(tid('newgroup-name')).fill('Niseko 滑雪 ' + RUN);
    await g.locator(tid('newgroup-type-trip')).click().catch(() => undefined);
    await g.locator(tid('newgroup-currency')).click();
    await pickCurrency(g, 'JPY');
    for (const n of ['Abbie', 'Kevin']) {
      await g.locator(tid('newgroup-member-input')).fill(n);
      await g.locator(tid('newgroup-member-add')).click();
    }
    await shot(g, '03-new-group');
    await g.locator(tid('newgroup-submit')).click();
    await g.locator(tid('group-title')).waitFor({ timeout: 20000 });
    check('group created', (await g.locator(tid('group-title')).innerText()).includes('Niseko'));
    await shot(g, '04-group-empty');
    const gid = (g.url().match(/#\/g\/([^/?]+)/) || [])[1];
    check('group id in URL', !!gid, g.url());

    // 3. Expenses: JPY dinner, TWD airport transfer.
    await addExpense(g, { amount: 12600, description: '燒肉晚餐' });
    check('dinner saved and synced', await waitSynced(g, '燒肉晚餐'));
    await addExpense(g, { amount: 2400, description: '機場接送', currency: 'TWD' });
    check('TWD entry saved and synced', await waitSynced(g, '機場接送'));
    await shot(g, '05-group-expenses');
    const snap = await apiGet(g, '/api/groups/' + gid);
    const byName = Object.fromEntries(snap.members.map(m => [m.name, m.id]));
    const dinner = snap.expenses.find(e => e.description === '燒肉晚餐');
    check('dinner split equally among 3 (server)', dinner && dinner.shares.length === 3 && dinner.shares.reduce((s, x) => s + x.amount, 0) === 12600, JSON.stringify(dinner && dinner.shares));
    const airport = snap.expenses.find(e => e.description === '機場接送');
    check('airport entry has an exchange rate', airport && airport.currency === 'TWD' && airport.fxRate > 3 && airport.fxRate < 7, airport && airport.fxRate);

    // 3b. Receipt photos kept with an expense, up to three: one small JPEG (made in the page's
    //     canvas) with 附收據 goes up to PUT .../receipts/<version> after the save, and shows on the
    //     detail page and full screen; then three different JPEGs on another expense (a fourth is
    //     trimmed) go up in order, show as numbered tiles, page in the viewer, and 移除這張 takes
    //     one off. The Worker this runs against needs both photo route families and a RECEIPTS KV
    //     binding; this uses 4 of staging's 180 KV writes a day (60 before 2026-10-30).
    await g.locator(tid('group-add-expense')).first().click();
    await g.locator(tid('editor-amount')).fill('880');
    await g.locator(tid('editor-description')).fill('便利商店');
    // Four different 60 x 90 JPEGs: identical bytes would be one photo (its version is their hash).
    const jpegs = await g.evaluate(() => [0, 1, 2, 3].map(i => {
      const c = document.createElement('canvas');
      c.width = 60;
      c.height = 90;
      const x = c.getContext('2d');
      x.fillStyle = '#fffcf6';
      x.fillRect(0, 0, 60, 90);
      x.fillStyle = ['#3e3a39', '#2a6480', '#a63d2b', '#4a7a3a'][i];
      for (let y = 10 + i * 2; y < 80; y += 12 + i) x.fillRect(8, y, 44 - i * 6, 4);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    }));
    const jpegFile = (b64, i) => ({ name: `receipt-${i + 1}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
    check('附收據 is offered in the editor', (await g.locator(tid('editor-receipt-attach')).count()) === 1);
    await g.locator(tid('editor-receipt-file')).setInputFiles(jpegFile(jpegs[0], 0));
    await g.locator(tid('editor-receipt-thumb')).waitFor({ timeout: 10000 });
    check('the attached photo shows as a thumbnail with a remove control', (await g.locator(tid('editor-receipt-remove')).count()) === 1);
    await shot(g, '05b-editor-receipt');
    const receiptUp = g.waitForResponse(r => r.request().method() === 'PUT' && /\/receipts\/[0-9a-f]{16}\?w=60&h=90$/.test(r.url()), { timeout: 20000 });
    await g.locator(tid('editor-save')).click();
    await g.locator(tid('group-title')).waitFor({ timeout: 15000 });
    const up = await receiptUp;
    // The kept copy is re-encoded in the page, so its version is read off the request and checked against its bytes.
    const upVersion = (/\/receipts\/([0-9a-f]{16})\?/.exec(up.url()) || [])[1];
    const upBody = up.request().postDataBuffer();
    check('the photo went up as a JPEG after the save, to PUT .../receipts/<16 hex>?w=60&h=90', up.status() === 200 && up.request().headers()['content-type'] === 'image/jpeg', up.status() + ' ' + up.url());
    check("its version is the SHA-256 of the bytes sent (the Worker's rule)", !!upBody && crypto.createHash('sha256').update(upBody).digest('hex').slice(0, 16) === upVersion, upVersion);
    check('receipt entry synced', await waitSynced(g, '便利商店'));
    const withPhoto = (await apiGet(g, '/api/groups/' + gid)).expenses.find(e => e.description === '便利商店');
    check('the entry carries the receipt metadata', withPhoto && withPhoto.receipt && withPhoto.receipt.mime === 'image/jpeg' && withPhoto.receipt.width === 60 && withPhoto.receipt.height === 90, JSON.stringify(withPhoto && withPhoto.receipt));
    check('and receipts lists that one photo', withPhoto && Array.isArray(withPhoto.receipts) && withPhoto.receipts.length === 1 && withPhoto.receipts[0].version === withPhoto.receipt.version && withPhoto.receipt.version === upVersion, JSON.stringify(withPhoto && withPhoto.receipts));
    await g.locator(tid('expense-row'), { hasText: '便利商店' }).first().click();
    await g.locator(tid('detail-receipt')).waitFor({ timeout: 15000 });
    const img = g.locator(tid('detail-receipt-image'));
    await img.waitFor({ timeout: 15000 });
    await g.waitForFunction(el => el.complete && el.naturalWidth > 0, await img.elementHandle(), { timeout: 15000 }).catch(() => undefined);
    check('the detail page shows the photo (loaded with the token)', await img.evaluate(el => el.naturalWidth === 60 && el.naturalHeight === 90), await img.evaluate(el => el.naturalWidth + 'x' + el.naturalHeight));
    await shot(g, '05c-detail-receipt');
    await g.locator(tid('detail-receipt')).click();
    await g.locator(tid('receipt-viewer')).waitFor({ timeout: 10000 });
    check('tapping it opens the photo full screen', await g.locator(tid('receipt-viewer')).locator('img').isVisible());
    await shot(g, '05d-receipt-viewer');
    await g.locator(tid('receipt-viewer-close')).click();
    await g.locator(tid('receipt-viewer')).waitFor({ state: 'detached', timeout: 10000 });
    await g.goto(BASE + '#/g/' + gid, { waitUntil: 'networkidle' });
    await g.locator(tid('group-title')).waitFor();

    //     Three photos: four files picked at once, the fourth trimmed; the pill shows 3. Each takes
    //     1.5 s longer to prepare here (slowDigest), so 儲存 is tried meanwhile (review C20): it
    //     waits and says so, and each photo is in the form as soon as it is ready.
    await g.locator(tid('group-add-expense')).first().click();
    await g.locator(tid('editor-amount')).fill('2400');
    await g.locator(tid('editor-description')).fill('拉麵三張');
    await slowDigest(g, 1500);
    await g.locator(tid('editor-receipt-file')).setInputFiles(jpegs.map(jpegFile));
    await g.locator(tid('editor-receipt-remove')).waitFor({ timeout: 10000 });
    const firstIn = (await g.locator(tid('editor-receipt-count')).count()) === 0 && (await attrIs(g, 'editor-receipt-thumb', 'aria-busy', 'true', 500));
    const saveOff = await attrIs(g, 'editor-save', 'aria-disabled', 'true', 500);
    // force: Playwright waits for an aria-disabled button to be enabled; a finger does not.
    await g.locator(tid('editor-save')).click({ force: true });
    const waitToast = await g.locator(tid('toast'), { hasText: '照片還在準備中，請稍等一下' }).first().waitFor({ timeout: 3000 }).then(() => true, () => false);
    const stillOpen = (await g.locator(tid('editor-amount')).count()) === 1 && /\/add/.test(new URL(g.url()).hash);
    check('while photos are prepared: the first is in the form already, 儲存 is aria-disabled, and a tap on it waits and says so', firstIn && saveOff && waitToast && stillOpen, JSON.stringify({ firstIn, saveOff, waitToast, stillOpen }));
    await g.locator(tid('editor-receipt-count')).waitFor({ timeout: 15000 });
    await g.waitForFunction(() => document.querySelector('[data-testid="editor-receipt-thumb"]')?.getAttribute('aria-busy') === null, null, { timeout: 10000 }).catch(() => undefined);
    await slowDigest(g, 0);
    check('the pill shows 3 photos, with no remove control', (await g.locator(tid('editor-receipt-count')).innerText()).trim() === '3' && (await g.locator(tid('editor-receipt-remove')).count()) === 0);
    const trimmedToast = await g.locator(tid('toast'), { hasText: '一筆最多三張，多選的 1 張沒有加進來' }).first().isVisible().catch(() => false);
    check('the fourth file is trimmed, and the toast says so', trimmedToast);
    check('儲存 is not aria-disabled once they are ready', (await g.locator(tid('editor-save')).getAttribute('aria-disabled')) === null);
    await g.locator(tid('editor-receipt-thumb')).click();
    await g.locator(tid('editor-receipts-sheet')).waitFor({ timeout: 10000 });
    check('the 收據照片 sheet shows the three tiles, no add tile, and the scan button for 3', (await g.locator(tid('editor-receipt-photo-3')).count()) === 1 && (await g.locator(tid('editor-receipt-add')).count()) === 0 && (await g.locator(tid('editor-receipts-scan')).innerText()).includes('3 張一起掃描'));
    await shot(g, '05e-editor-receipts-sheet');
    // Focus around the viewer (review C14): the two sheets take each other's place, so each says
    // where focus goes: the viewer to the tile it showed, the sheet to the pill.
    await g.locator(tid('editor-receipt-photo-open-2')).click();
    await g.locator(tid('receipt-viewer')).waitFor({ timeout: 10000 });
    await g.locator(tid('receipt-viewer-close')).click();
    await g.locator(tid('receipt-viewer')).waitFor({ state: 'detached', timeout: 10000 });
    const onTile = await focusOn(g, 'editor-receipt-photo-open-2');
    const tileFocus = await focusedId(g);
    await g.locator(tid('editor-receipts-done')).click();
    await g.locator(tid('editor-receipts-sheet')).waitFor({ state: 'detached', timeout: 10000 });
    const onPill = await focusOn(g, 'editor-receipt-thumb');
    check('closing the viewer puts focus on the tile it showed, and closing the sheet on the pill', onTile && onPill, tileFocus + ' / ' + (await focusedId(g)));
    const photoPuts = [];
    const onPhotoPut = r => {
      const m = /\/receipts\/([0-9a-f]{16})\?w=60&h=90$/.exec(r.url());
      if (r.request().method() === 'PUT' && m) photoPuts.push({ version: m[1], status: r.status(), hash: crypto.createHash('sha256').update(r.request().postDataBuffer() || Buffer.alloc(0)).digest('hex').slice(0, 16) });
    };
    g.on('response', onPhotoPut);
    await g.locator(tid('editor-save')).click();
    await g.locator(tid('group-title')).waitFor({ timeout: 15000 });
    check('three-photo entry synced', await waitSynced(g, '拉麵三張', 40000));
    const t0 = Date.now();
    while (photoPuts.length < 3 && Date.now() - t0 < 20000) await g.waitForTimeout(300);
    g.off('response', onPhotoPut);
    check('儲存 sent three PUT .../receipts/<version>, each answered 200, each version the hash of its bytes', photoPuts.length === 3 && photoPuts.every(p => p.status === 200 && p.hash === p.version), JSON.stringify(photoPuts));
    const three = (await apiGet(g, '/api/groups/' + gid)).expenses.find(e => e.description === '拉麵三張');
    check('the snapshot lists the three photos in the order they went up, receipt = the first', three && Array.isArray(three.receipts) && three.receipts.map(r => r.version).join() === photoPuts.map(p => p.version).join() && three.receipt && three.receipt.version === three.receipts[0].version, JSON.stringify(three && three.receipts));
    const glyph = g.locator(tid('expense-row'), { hasText: '拉麵三張' }).first().locator(tid('expense-row-receipt'));
    check('its row shows the receipt glyph for 3 photos', (await glyph.getAttribute('data-photos').catch(() => null)) === '3');
    await g.locator(tid('expense-row'), { hasText: '拉麵三張' }).first().click();
    await g.locator(tid('detail-receipt-3')).waitFor({ timeout: 15000 });
    check('the detail page shows detail-receipt-1 to -3 and no single-photo section', (await g.locator(tid('detail-receipt-1')).count()) === 1 && (await g.locator(tid('detail-receipt-2')).count()) === 1 && (await g.locator(tid('detail-receipt')).count()) === 0);
    await shot(g, '05f-detail-receipts');
    await g.locator(tid('detail-receipt-1')).click();
    await g.locator(tid('receipt-viewer')).waitFor({ timeout: 10000 });
    const count1 = (await g.locator(tid('receipt-viewer-count')).innerText()).trim();
    await g.locator(tid('receipt-viewer-next')).click();
    await g.waitForFunction(() => (document.querySelector('[data-testid="receipt-viewer-count"]') || {}).textContent === '2/3', null, { timeout: 5000 }).catch(() => undefined);
    const count2 = (await g.locator(tid('receipt-viewer-count')).innerText()).trim();
    check('the viewer opens at 1/3 and next goes to 2/3', count1 === '1/3' && count2 === '2/3', count1 + ' -> ' + count2);
    await shot(g, '05g-receipt-viewer-2of3');
    const second = three.receipts[1].version;
    const removed = g.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith('/receipts/' + second), { timeout: 20000 });
    await g.locator(tid('receipt-viewer-remove')).click();
    await g.locator(tid('dialog-confirm')).click({ timeout: 5000 });
    const del = await removed;
    check('移除這張 on photo 2 sends DELETE .../receipts/<its version>', del.status() === 200, del.status());
    check('focus then goes to the tile now in its place (review C14)', await focusOn(g, 'detail-receipt-2'), await focusedId(g));
    await g.waitForTimeout(500);
    const two = (await apiGet(g, '/api/groups/' + gid)).expenses.find(e => e.description === '拉麵三張');
    check('the snapshot then has two photos, and receipt is the first', two && two.receipts.length === 2 && two.receipts.map(r => r.version).join() === [three.receipts[0].version, three.receipts[2].version].join() && two.receipt.version === three.receipts[0].version, JSON.stringify(two && two.receipts));
    // With the keyboard, the arrow pressed to reach the last photo goes away there: focus moves to the other one.
    await g.locator(tid('detail-receipt-1')).click();
    await g.locator(tid('receipt-viewer')).waitFor({ timeout: 10000 });
    await g.locator(tid('receipt-viewer-next')).focus();
    await g.keyboard.press('Enter');
    const toPrev = await focusOn(g, 'receipt-viewer-prev');
    const lastCount = (await g.locator(tid('receipt-viewer-count')).innerText()).trim();
    check('Enter on › to the last photo hands focus to ‹', toPrev && lastCount === '2/2', (await focusedId(g)) + ' ' + lastCount);
    await g.locator(tid('receipt-viewer-close')).click();
    await g.locator(tid('receipt-viewer')).waitFor({ state: 'detached', timeout: 10000 });
    await g.goto(BASE + '#/g/' + gid, { waitUntil: 'networkidle' });
    await g.locator(tid('group-title')).waitFor();

    // 3c. While picked photos are prepared (slowDigest again), with every scan request answered in
    //     the page (keepScansInPage, so no Workers AI): 掃描 with no photo shows 讀取中 at once,
    //     and leaving the editor then sends no scan, nor does a second tap on 讀取中 (review C6); the
    //     sheet's scan button waits for a photo still being prepared (C13); another group waits for
    //     it too, then takes the photo along (C15). Nothing here is saved: no KV writes.
    const scansBefore = await scanCount(g);
    await slowDigest(g, 1500);
    await g.locator(tid('group-add-expense')).first().click();
    await g.locator(tid('editor-amount')).waitFor();
    await g.locator(tid('editor-scan-file')).setInputFiles([jpegFile(jpegs[0], 0), jpegFile(jpegs[1], 1)]);
    const readingAtOnce = await attrIs(g, 'editor-scan', 'aria-busy', 'true', 1000);
    await g.locator(tid('editor-cancel')).click();
    const asked = await g.locator(tid('dialog-confirm')).click({ timeout: 3000 }).then(() => true, () => false);
    await g.locator(tid('group-title')).waitFor({ timeout: 15000 });
    await g.waitForTimeout(4000);
    let scans = (await scanCount(g)) - scansBefore;
    check('掃描 with no photo shows 讀取中 while they are prepared; 取消 then asks first, and no scan goes out after the editor left', readingAtOnce && asked && scans === 0, JSON.stringify({ readingAtOnce, asked, scans }));

    await g.locator(tid('group-add-expense')).first().click();
    await g.locator(tid('editor-amount')).fill('700');
    await g.locator(tid('editor-scan-file')).setInputFiles([jpegFile(jpegs[0], 0), jpegFile(jpegs[1], 1)]);
    await attrIs(g, 'editor-scan', 'aria-busy', 'true', 1000);
    await g.locator(tid('editor-scan')).click();
    const stoppedToast = await g.locator(tid('toast'), { hasText: '已停止讀取收據' }).first().waitFor({ timeout: 3000 }).then(() => true, () => false);
    await g.locator(tid('editor-receipt-count')).waitFor({ timeout: 15000 });
    await g.waitForTimeout(1000);
    const keptTwo = (await g.locator(tid('editor-receipt-count')).innerText()).trim();
    scans = (await scanCount(g)) - scansBefore;
    check('a second tap on 讀取中 stops it: both photos are attached, and no scan goes out', stoppedToast && keptTwo === '2' && scans === 0, JSON.stringify({ stoppedToast, keptTwo, scans }));

    await g.locator(tid('editor-receipt-thumb')).click();
    await g.locator(tid('editor-receipts-sheet')).waitFor({ timeout: 10000 });
    const chooser = await Promise.all([g.waitForEvent('filechooser', { timeout: 5000 }), g.locator(tid('editor-receipt-add')).click()]).then(([c]) => c, () => null);
    check('＋ 加一張 in the sheet opens the picker', !!chooser);
    if (chooser) {
      await chooser.setFiles(jpegFile(jpegs[2], 2));
      const sheetScanOff = await attrIs(g, 'editor-receipts-scan', 'aria-disabled', 'true', 1000);
      await g.locator(tid('editor-receipts-scan')).click({ force: true });
      await g.locator(tid('editor-receipt-photo-3')).waitFor({ timeout: 15000 });
      await g.waitForTimeout(500);
      const label = (await g.locator(tid('editor-receipts-scan')).innerText()).trim();
      scans = (await scanCount(g)) - scansBefore;
      check('the sheet\'s scan button waits while a photo is prepared, and a tap on it sends nothing', sheetScanOff && scans === 0 && label.includes('3 張一起掃描'), JSON.stringify({ sheetScanOff, scans, label }));
    }
    await g.locator(tid('editor-receipts-done')).click();
    await g.locator(tid('editor-receipts-sheet')).waitFor({ state: 'detached', timeout: 10000 });
    await g.locator(tid('editor-cancel')).click();
    await g.locator(tid('dialog-confirm')).click({ timeout: 3000 });
    await g.locator(tid('group-title')).waitFor({ timeout: 15000 });

    // Another group: one made here (the app reloads to list it).
    const g2 = await g.evaluate(async ({ api, run }) => {
      const r = await fetch(api + '/api/groups', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + localStorage.getItem('evenly.token'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '換群組 ' + run, type: 'other', currency: 'JPY' }),
      });
      const b = await r.json();
      return b && b.group ? b.group.id : null;
    }, { api: API, run: RUN });
    check('a second group for the switch', !!g2, g2);
    await g.goto(BASE + '#/g/' + gid, { waitUntil: 'networkidle' });
    await g.locator(tid('group-title')).waitFor();
    await slowDigest(g, 2500);
    await g.locator(tid('group-add-expense')).first().click();
    await g.locator(tid('editor-amount')).fill('700');
    await g.locator(tid('editor-receipt-file')).setInputFiles(jpegFile(jpegs[3], 3));
    const option = `${tid('editor-group-option')}[data-id="${g2}"]`;
    await g.locator(tid('editor-group')).click();
    await g.locator(option).click();
    const switchWaits = await g.locator(tid('toast'), { hasText: '照片還在準備中，請稍等一下' }).first().waitFor({ timeout: 3000 }).then(() => true, () => false);
    const stayed = g.url().includes('/g/' + gid + '/');
    await g.locator(tid('editor-receipt-remove')).waitFor({ timeout: 15000 });
    await slowDigest(g, 0);
    await g.locator(tid('editor-group')).click();
    await g.locator(option).click();
    const moved = await g.waitForFunction(id => location.hash.includes('/g/' + id + '/add'), g2, { timeout: 10000 }).then(() => true, () => false);
    const photoAlong = await g.locator(tid('editor-receipt-remove')).waitFor({ timeout: 10000 }).then(() => true, () => false);
    const amountAlong = await g.locator(tid('editor-amount')).inputValue().catch(() => '');
    check('another group waits for a photo being prepared, then takes it along with the draft', switchWaits && stayed && moved && photoAlong && amountAlong === '700', JSON.stringify({ switchWaits, stayed, moved, photoAlong, amountAlong }));
    await g.locator(tid('editor-cancel')).click();
    await g.locator(tid('dialog-confirm')).click({ timeout: 3000 });
    await g.locator(tid('group-title')).waitFor({ timeout: 15000 });
    scans = (await scanCount(g)) - scansBefore;
    check('no scan request went out in all of 3c', scans === 0, scans);
    await g.goto(BASE + '#/g/' + gid, { waitUntil: 'networkidle' });
    await g.locator(tid('group-title')).waitFor();

    // 3c2. With scanning already agreed to here (so nothing asks first), 取消 while the photos of
    //      掃描 are prepared asks 放棄這筆費用？, and the scan is held while that question is open,
    //      even once the photos are ready (fix check of C6): 放棄 sends nothing, 繼續編輯 sends it
    //      then (answered in the page). Nothing is saved: no KV writes.
    const meNow = await apiGet(g, '/api/me');
    await g.evaluate(id => localStorage.setItem('evenly.scanConsent.' + id, '1'), meNow.user.id);
    await slowDigest(g, 1500);
    const heldBase = await scanCount(g);
    const scanWithLeaveAsked = async () => {
      await g.locator(tid('group-add-expense')).first().click();
      await g.locator(tid('editor-amount')).waitFor();
      await g.locator(tid('editor-scan-file')).setInputFiles([jpegFile(jpegs[0], 0), jpegFile(jpegs[1], 1)]);
      await attrIs(g, 'editor-scan', 'aria-busy', 'true', 1000);
      await g.locator(tid('editor-cancel')).click();
      await g.locator(tid('dialog-confirm')).waitFor({ timeout: 3000 });
      // Both photos are ready (1.5 s each) while the question is still open.
      await g.waitForTimeout(4500);
      return (await scanCount(g)) - heldBase;
    };
    const heldOpen = await scanWithLeaveAsked();
    await g.locator(tid('dialog-confirm')).click();
    await g.locator(tid('group-title')).waitFor({ timeout: 15000 });
    await g.waitForTimeout(1500);
    const afterDiscard = (await scanCount(g)) - heldBase;
    check('取消 while the photos are prepared: no scan while 放棄這筆費用？ is open, even once they are ready, and none after 放棄', heldOpen === 0 && afterDiscard === 0, JSON.stringify({ heldOpen, afterDiscard }));
    const heldOpen2 = await scanWithLeaveAsked();
    await g.locator(tid('dialog-cancel')).click();
    let afterKeep = 0;
    for (let i = 0; i < 60 && afterKeep < 1; i++) {
      await g.waitForTimeout(100);
      afterKeep = (await scanCount(g)) - heldBase;
    }
    check('繼續編輯 sends the scan held while the question was open', heldOpen2 === 0 && afterKeep === 1, JSON.stringify({ heldOpen2, afterKeep }));
    await g.locator(tid('toast'), { hasText: '現在讀不了收據' }).first().waitFor({ timeout: 5000 }).catch(() => undefined);
    await slowDigest(g, 0);
    await g.locator(tid('editor-cancel')).click();
    await g.locator(tid('dialog-confirm')).click({ timeout: 3000 });
    await g.locator(tid('group-title')).waitFor({ timeout: 15000 });
    // 3d starts from an account that has not agreed yet.
    await g.evaluate(id => localStorage.removeItem('evenly.scanConsent.' + id), meNow.user.id);
    await g.goto(BASE + '#/g/' + gid, { waitUntil: 'networkidle' });
    await g.locator(tid('group-title')).waitFor();

    // 3d. The first scan of an account here asks first (App Review guideline 5.1.2(i)): the photos go
    //     to Cloudflare Workers AI, a third party, only once the person agrees. 取消 sends nothing;
    //     同意並掃描 sends it (answered in the page with a 502, keepScansInPage, so no Workers AI); the
    //     next scan does not ask; 我的's 收據掃描 resets it, and the next scan asks again. Nothing is
    //     saved: no KV writes.
    const consentBase = await scanCount(g);
    const consentScans = async () => (await scanCount(g)) - consentBase;
    const scansReach = async n => {
      let got = await consentScans();
      for (let i = 0; i < 60 && got < n; i++) {
        await g.waitForTimeout(100);
        got = await consentScans();
      }
      return got;
    };
    const newWithPhoto = async () => {
      await g.locator(tid('group-add-expense')).first().click();
      await g.locator(tid('editor-amount')).waitFor();
      await g.locator(tid('editor-receipt-file')).setInputFiles(jpegFile(jpegs[0], 0));
      await g.locator(tid('editor-receipt-remove')).waitFor({ timeout: 10000 });
    };
    const leaveEditor = async () => {
      await g.locator(tid('editor-cancel')).click();
      await g.locator(tid('dialog-confirm')).click({ timeout: 3000 });
      await g.locator(tid('group-title')).waitFor({ timeout: 15000 });
    };
    await newWithPhoto();
    await g.locator(tid('editor-scan')).click();
    const consentAsked = await g.locator(tid('dialog')).waitFor({ timeout: 5000 }).then(() => true, () => false);
    const askText = consentAsked ? await g.locator(tid('dialog')).innerText() : '';
    const askLink = await g.locator(tid('dialog-link')).getAttribute('href').catch(() => null);
    await g.waitForTimeout(400); // the card's entrance (0.3 s)
    await shot(g, '05h-scan-consent');
    await g.locator(tid('dialog-cancel')).click();
    await g.waitForTimeout(1000);
    const words = ['掃描會把收據照片傳給 AI', '第三方 AI 服務 Cloudflare Workers AI', '同意並掃描', '取消', '隱私權政策'];
    const afterCancel = await consentScans();
    check('the first scan asks first: the third party named, 同意並掃描 / 取消 and the privacy policy; 取消 sends nothing and keeps the photo', consentAsked && words.every(w => askText.includes(w)) && askLink === '/privacy/#zh-scan' && afterCancel === 0 && (await g.locator(tid('editor-receipt-remove')).count()) === 1, JSON.stringify({ consentAsked, askLink, afterCancel, askText: askText.slice(0, 200) }));
    await g.locator(tid('editor-scan')).click();
    await g.locator(tid('dialog-confirm')).click({ timeout: 5000 });
    const afterAgree = await scansReach(1);
    await g.locator(tid('toast'), { hasText: '現在讀不了收據' }).first().waitFor({ timeout: 5000 }).catch(() => undefined);
    await g.locator(tid('editor-scan')).click();
    const afterNext = await scansReach(2);
    const askedNext = (await g.locator(tid('dialog')).count()) > 0;
    check('同意並掃描 sends the scan, and the next scan does not ask', afterAgree === 1 && afterNext === 2 && !askedNext, JSON.stringify({ afterAgree, afterNext, askedNext }));
    await g.locator(tid('toast'), { hasText: '現在讀不了收據' }).first().waitFor({ timeout: 5000 }).catch(() => undefined);
    await leaveEditor();
    await g.goto(BASE + '#/account', { waitUntil: 'networkidle' });
    const agreedShown = await attrIs(g, 'account-scan-consent', 'data-agreed', 'true', 10000);
    await g.locator(tid('account-scan-consent')).scrollIntoViewIfNeeded().catch(() => undefined);
    await shot(g, '05i-account-scan-consent');
    await g.locator(tid('account-scan-consent-reset')).click();
    const resetToast = await g.locator(tid('toast'), { hasText: '下次掃描前會再問你' }).first().waitFor({ timeout: 3000 }).then(() => true, () => false);
    const resetShown = await attrIs(g, 'account-scan-consent', 'data-agreed', 'false', 3000);
    check('我的 says this account agreed here, and 下次掃描前再問我 resets it', agreedShown && resetToast && resetShown, JSON.stringify({ agreedShown, resetToast, resetShown }));
    await g.goto(BASE + '#/g/' + gid, { waitUntil: 'networkidle' });
    await g.locator(tid('group-title')).waitFor();
    await newWithPhoto();
    await g.locator(tid('editor-scan')).click();
    const askedAgain = await g.locator(tid('dialog')).waitFor({ timeout: 5000 }).then(() => true, () => false);
    await g.locator(tid('dialog-cancel')).click().catch(() => undefined);
    await g.waitForTimeout(800);
    const afterReset = await consentScans();
    check('after the reset, the next scan asks again (and 取消 still sends nothing)', askedAgain && afterReset === 2, JSON.stringify({ askedAgain, afterReset }));
    await leaveEditor();
    await g.goto(BASE + '#/g/' + gid, { waitUntil: 'networkidle' });
    await g.locator(tid('group-title')).waitFor();

    // 4. Lodging split by shares 2:1:1.
    await g.locator(tid('group-add-expense')).first().click();
    await g.locator(tid('editor-amount')).fill('40000');
    await g.locator(tid('editor-description')).fill('住宿');
    await g.locator(tid('editor-split')).click();
    await g.locator(tid('split-method-shares')).click();
    const meId = snap.me.memberId;
    await g.locator(tid('split-value-' + meId)).fill('2');
    await g.locator(tid('split-value-' + byName['Abbie'])).fill('1');
    await g.locator(tid('split-value-' + byName['Kevin'])).fill('1');
    await shot(g, '06-split-shares');
    await g.locator(tid('split-done')).click();
    await g.locator(tid('editor-save')).click();
    await g.locator(tid('group-title')).waitFor();
    check('shares entry synced', await waitSynced(g, '住宿'));
    const snap2 = await apiGet(g, '/api/groups/' + gid);
    const lodging = snap2.expenses.find(e => e.description === '住宿');
    const share = Object.fromEntries((lodging ? lodging.shares : []).map(s => [s.memberId, s.amount]));
    check('shares 20000/10000/10000', share[meId] === 20000 && share[byName['Abbie']] === 10000 && share[byName['Kevin']] === 10000, JSON.stringify(share));

    // 5. Balances and settle up.
    await g.locator(tid('group-tab-balances')).click();
    await g.locator(tid('transfer-row')).first().waitFor({ timeout: 10000 });
    const transfers = await g.locator(tid('transfer-row')).count();
    check('balances show transfers', transfers >= 1, transfers);
    await shot(g, '07-balances');
    await g.locator(tid('transfer-settle')).first().click();
    await g.locator(tid('settle-save')).waitFor();
    await shot(g, '08-settle');
    await g.locator(tid('settle-save')).click();
    await g.locator(tid('group-title')).waitFor();
    await g.waitForTimeout(2500);

    // 6. Invite link from settings.
    await g.locator(tid('group-tab-settings')).click();
    const invEl = g.locator(tid('settings-invite-link'));
    await invEl.waitFor();
    let invite = (await invEl.getAttribute('value')) || (await invEl.getAttribute('href')) || (await invEl.innerText());
    invite = (invite || '').trim();
    check('invite link shown', /#\/join\//.test(invite), invite);
    await shot(g, '09-settings');
    const inviteLocal = BASE + '#/join/' + invite.split('#/join/')[1];

    // 7. Abbie opens the invite and claims her name; signed out, an email code comes first.
    await a.goto(inviteLocal, { waitUntil: 'networkidle' });
    await a.locator(tid('join-member')).first().waitFor({ timeout: 20000 });
    await shot(a, '10-join');
    await a.locator(`${tid('join-member')}[data-id="${byName['Abbie']}"]`).click();
    await a.locator(tid('join-submit')).click();
    await a.locator(tid('signin-email')).waitFor({ timeout: 10000 });
    await a.locator(tid('signin-email')).fill(`e2e-a-${RUN}@evenly.test`);
    await shot(a, '10b-join-email');
    await enterCode(a, () => a.locator(tid('signin-send')).click());
    await a.locator(tid('group-title')).waitFor({ timeout: 20000 });
    check('Abbie joined and sees the group', (await a.locator(tid('group-title')).innerText()).includes('Niseko'));
    await shot(a, '11-abbie-group');
    const aSnap = await apiGet(a, '/api/groups/' + gid);
    check('Abbie is the Abbie member', aSnap.me && aSnap.me.memberId === byName['Abbie'], JSON.stringify(aSnap.me));
    const aMe = await apiGet(a, '/api/me');
    check("Abbie's account has her confirmed email and the member's name", aMe.user && aMe.user.name === 'Abbie' && aMe.user.emailVerified === true, JSON.stringify(aMe.user));

    // 8. Abbie adds ramen; Gino sees it.
    await addExpense(a, { amount: 4550, description: '拉麵' });
    check('Abbie ramen synced', await waitSynced(a, '拉麵'));
    await g.locator(tid('group-tab-expenses')).click();
    await g.reload({ waitUntil: 'networkidle' });
    await g.locator(tid('expense-row'), { hasText: '拉麵' }).first().waitFor({ timeout: 30000 }).then(() => check('Gino sees Abbie entry', true)).catch(() => check('Gino sees Abbie entry', false));

    // 9. Offline add, then sync.
    await G.ctx.setOffline(true);
    await addExpense(g, { amount: 5793, description: '藥妝' });
    const row = g.locator(tid('expense-row'), { hasText: '藥妝' }).first();
    await row.waitFor({ timeout: 10000 });
    check('offline entry pending', (await row.getAttribute('data-state')) === 'pending', await row.getAttribute('data-state'));
    check('offline banner', await g.locator(tid('offline-banner')).isVisible().catch(() => false));
    await shot(g, '12-offline');
    await G.ctx.setOffline(false);
    await g.evaluate(() => window.dispatchEvent(new Event('online')));
    check('offline entry synced after reconnect', await waitSynced(g, '藥妝', 40000));

    // 10. A password for the confirmed email; sign out, back in with it, out again, in with a code.
    await g.goto(BASE + '#/account', { waitUntil: 'networkidle' });
    await g.locator(tid('account-password')).waitFor({ timeout: 15000 });
    check('登入方式 shows 更換 Email for the confirmed email', (await g.locator(tid('change-email')).count()) === 1);
    await g.locator(tid('account-password')).fill('e2e password 1');
    await g.locator(tid('account-save-credentials')).click();
    await g.waitForTimeout(3000);
    const me = await apiGet(g, '/api/me');
    check('password saved', me.user && me.user.email === gEmail && me.user.hasPassword, JSON.stringify(me.user));
    await shot(g, '13-account');
    const signOut = async () => {
      // Right after a sign-in the app can still be landing on 總覽 and take us back there from
      // 我的 (2026-10-31: 登出 was found, then the page went home under the click), so try again.
      for (let i = 1; ; i++) {
        await g.goto(BASE + '#/account', { waitUntil: 'networkidle' });
        if (await g.locator(tid('account-logout')).click({ timeout: 5000 }).then(() => true, () => false)) break;
        if (i === 3) throw new Error('登出 took no click in 3 tries');
      }
      await g.locator(tid('dialog-confirm')).click({ timeout: 3000 }).catch(() => undefined);
      await g.locator(tid('welcome-login')).waitFor({ timeout: 15000 });
      await g.locator(tid('welcome-login')).click();
      await g.locator(tid('login-email')).waitFor({ timeout: 15000 });
    };
    await signOut();
    await g.locator(tid('login-password-toggle')).click();
    await g.locator(tid('login-email')).fill(gEmail);
    await g.locator(tid('login-password')).fill('e2e password 1');
    await shot(g, '13b-login-password');
    await g.locator(tid('login-submit')).click();
    await g.locator(tid('home-group-row')).first().waitFor({ timeout: 20000 });
    check('signed back in with the password and sees the group', true);
    await signOut();
    await g.locator(tid('login-email')).fill(gEmail);
    await enterCode(g, () => g.locator(tid('login-send')).click());
    await g.locator(tid('home-group-row')).first().waitFor({ timeout: 20000 });
    check('signed back in with a code and sees the group', true);
    await shot(g, '14-home-again');

    // 10b. The two-person quick splits say who owes whom, with the other person's name while it
    // fits the chip on one line at 320 px, else 對方 / They: up to 13 units in Chinese and 10 in
    // English (editorText.ts PRESET_NAME_MAX), and W is the widest letter.
    const W = n => 'W'.repeat(n);
    const pairGroups = await g.evaluate(async ({ api, run, names }) => {
      const out = {};
      for (const who of names) {
        const r = await fetch(api + '/api/groups', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + localStorage.getItem('evenly.token'), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '兩人 ' + who.length + ' ' + run, type: 'other', currency: 'JPY', members: [{ name: who }] }),
        });
        const b = await r.json();
        out[who.length] = b && b.group ? b.group.id : null;
      }
      return out;
    }, { api: API, run: RUN, names: [W(10), W(11), W(13), W(14)] });
    check('four two-person groups for the quick splits', [10, 11, 13, 14].every(n => !!pairGroups[n]), JSON.stringify(pairGroups));
    await g.reload({ waitUntil: 'networkidle' });
    const presetChips = async n => {
      // Through the group's page, so no chips of the last editor are still on screen.
      await g.goto(BASE + '#/g/' + pairGroups[n], { waitUntil: 'networkidle' });
      await g.locator(tid('group-title'), { hasText: '兩人 ' + n + ' ' }).waitFor({ timeout: 15000 });
      await g.goto(BASE + '#/g/' + pairGroups[n] + '/add', { waitUntil: 'networkidle' });
      await g.locator(tid('preset-i-full')).waitFor({ timeout: 15000 });
      await g.evaluate(() => document.fonts.ready.then(() => undefined));
      const read = () => g.evaluate(() => ['i-equal', 'i-full', 'they-equal', 'they-full'].map(k => {
        const chip = document.querySelector(`[data-testid="preset-${k}"]`);
        const label = chip.lastElementChild;
        const row = chip.parentElement.getBoundingClientRect();
        const box = chip.getBoundingClientRect();
        return { text: label.textContent, cut: label.scrollWidth > label.clientWidth + 0.5, inRow: box.width <= row.width, oneLine: box.height < 40 };
      }));
      const expense = await read();
      // 退款: the same chips, worded as the debt a refund leaves (Gino, 2026-10-31 09:39 PT).
      await g.locator(tid('editor-kind-refund')).click();
      await g.waitForFunction(was => document.querySelector('[data-testid="preset-i-equal"]').lastElementChild.textContent !== was, expense[0].text, { timeout: 5000 }).catch(() => undefined);
      const refund = await read();
      await g.locator(tid('editor-kind-expense')).click();
      await g.locator(tid('editor-cancel')).click();
      await g.locator(tid('dialog-confirm')).click({ timeout: 3000 }).catch(() => undefined);
      return { expense, refund };
    };
    const ok320 = chips => chips.every(c => !c.cut && c.inRow && c.oneLine);
    const texts = chips => chips.map(c => c.text).join();
    const wordsAt320 = async (lang, max, words, theyWords) => {
      await g.setViewportSize({ width: 320, height: 640 });
      const fits = await presetChips(max);
      await shot(g, '14b-quick-splits-320-' + lang);
      const over = await presetChips(max + 1);
      await g.setViewportSize(devices['iPhone 14'].viewport);
      const [a, b, c, d] = words(W(max));
      const [ta, tb, tc, td] = theyWords;
      check(`${lang} at 320 px: ${max} W's, the longest name, is on all four quick splits, none cut or wrapped`, texts(fits.expense) === [a, b, c, d].join() && ok320(fits.expense), JSON.stringify(fits.expense));
      check(`${lang} at 320 px: ${max + 1} W's say ${ta.slice(0, lang === 'zh' ? 2 : 4)}`, texts(over.expense) === theyWords.join() && ok320(over.expense), JSON.stringify(over.expense));
      check(`${lang} at 320 px: a refund's chips say the debt it leaves (I got it: I owe), in the same order, none cut`, texts(fits.refund) === [c, d, a, b].join() && ok320(fits.refund) && texts(over.refund) === [tc, td, ta, tb].join() && ok320(over.refund), JSON.stringify([fits.refund, over.refund]));
      await g.goto(BASE + '#/g/' + gid, { waitUntil: 'networkidle' });
      await g.locator(tid('group-title')).waitFor();
    };
    await wordsAt320('zh', 13, x => [`${x} 欠我一半`, `${x} 欠我全部`, `我欠 ${x} 一半`, `我欠 ${x} 全部`], ['對方欠我一半', '對方欠我全部', '我欠對方一半', '我欠對方全部']);

    // 11. English.
    await g.goto(BASE + '#/account', { waitUntil: 'networkidle' });
    await g.locator(tid('account-lang-en')).click();
    await g.waitForTimeout(800);
    const body = await g.locator('body').innerText();
    check('English UI', /Account|Sign out|Language/.test(body), body.slice(0, 200));
    await shot(g, '15-account-en');
    await wordsAt320('en', 10, x => [`${x} owes me half`, `${x} owes me all of it`, `I owe ${x} half`, `I owe ${x} all of it`], ['They owe me half', 'They owe me all of it', 'I owe them half', 'I owe them all of it']);
    await g.goto(BASE + '#/g/' + gid, { waitUntil: 'networkidle' });
    await g.locator(tid('group-title')).waitFor();
    await shot(g, '16-group-en');
  } catch (e) {
    check('flow completed without exceptions', false, e.stack || e.message);
    await shot(g, 'zz-gino-error').catch(() => undefined);
    await shot(a, 'zz-abbie-error').catch(() => undefined);
  }
  const errors = [...g.errors, ...a.errors];
  check('no page errors', errors.length === 0, errors.join('\n'));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed. Screenshots: ${OUT}`);
  if (fail) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
})();
