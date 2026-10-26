// End-to-end UI flows in WebKit (Safari's engine) with iPhone emulation, against the built app
// (vite preview on :4173) talking to the staging Worker.
//   npm run build (with VITE_API_BASE=staging) && npx vite preview --port 4173
//   node tests/e2e/flows.cjs [baseUrl] [outDir]
// Two people (Gino and Abbie) in separate browser contexts: sign up with an email code, create a
// group, add expenses in two currencies, keep a receipt photo with one and see it on its detail
// page, split by shares, settle up, invite and join (the invite
// asks for an email code too), offline add and sync, set a password, sign out and back in with it
// and with a code, switch language. Every code comes from the start answer's devCode, read off the
// network: staging's test mode (EMAIL_DEV_ECHO), so the Worker this runs against must have the
// email routes. Addresses are on evenly.test, which is never mailed. Screenshots go to outDir.

const path = require('path');
const fs = require('fs');
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

    // 3b. A receipt photo kept with an expense: attach a small JPEG (made in the page's canvas) with
    //     附收據, save, and see it on the detail page and full screen. The Worker this runs against
    //     needs the receipt photo routes and a RECEIPTS KV binding.
    await g.locator(tid('group-add-expense')).first().click();
    await g.locator(tid('editor-amount')).fill('880');
    await g.locator(tid('editor-description')).fill('便利商店');
    const jpeg = await g.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 60;
      c.height = 90;
      const x = c.getContext('2d');
      x.fillStyle = '#fffcf6';
      x.fillRect(0, 0, 60, 90);
      x.fillStyle = '#3e3a39';
      for (let y = 10; y < 80; y += 12) x.fillRect(8, y, 44, 4);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
    check('附收據 is offered in the editor', (await g.locator(tid('editor-receipt-attach')).count()) === 1);
    await g.locator(tid('editor-receipt-file')).setInputFiles({ name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') });
    await g.locator(tid('editor-receipt-thumb')).waitFor({ timeout: 10000 });
    check('the attached photo shows as a thumbnail with a remove control', (await g.locator(tid('editor-receipt-remove')).count()) === 1);
    await shot(g, '05b-editor-receipt');
    const receiptUp = g.waitForResponse(r => r.request().method() === 'PUT' && /\/receipt\?/.test(r.url()), { timeout: 20000 });
    await g.locator(tid('editor-save')).click();
    await g.locator(tid('group-title')).waitFor({ timeout: 15000 });
    const up = await receiptUp;
    check('the photo went up as a JPEG after the save', up.status() === 200 && up.request().headers()['content-type'] === 'image/jpeg', up.status());
    check('receipt entry synced', await waitSynced(g, '便利商店'));
    const withPhoto = (await apiGet(g, '/api/groups/' + gid)).expenses.find(e => e.description === '便利商店');
    check('the entry carries the receipt metadata', withPhoto && withPhoto.receipt && withPhoto.receipt.mime === 'image/jpeg' && withPhoto.receipt.width === 60 && withPhoto.receipt.height === 90, JSON.stringify(withPhoto && withPhoto.receipt));
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
      await g.goto(BASE + '#/account', { waitUntil: 'networkidle' });
      await g.locator(tid('account-logout')).click({ timeout: 15000 });
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

    // 11. English.
    await g.goto(BASE + '#/account', { waitUntil: 'networkidle' });
    await g.locator(tid('account-lang-en')).click();
    await g.waitForTimeout(800);
    const body = await g.locator('body').innerText();
    check('English UI', /Account|Sign out|Language/.test(body), body.slice(0, 200));
    await shot(g, '15-account-en');
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
