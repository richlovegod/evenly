// End-to-end UI flows in WebKit (Safari's engine) with iPhone emulation, against the built app
// (vite preview on :4173) talking to the staging Worker.
//   npm run build (with VITE_API_BASE=staging) && npx vite preview --port 4173
//   node tests/e2e/flows.cjs [baseUrl] [outDir]
// Two people (Gino and Abbie) in separate browser contexts: create a group, add expenses in two
// currencies, split by shares, settle up, invite and join, offline add and sync, set a password,
// sign out and back in, switch language. Screenshots go to outDir.

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
  try {
    // 1. Gino starts with just a name.
    await g.goto(BASE, { waitUntil: 'networkidle' });
    await g.locator(tid('welcome-name')).waitFor({ timeout: 20000 });
    await shot(g, '01-welcome');
    await g.locator(tid('welcome-name')).fill('Gino');
    await g.locator(tid('welcome-start')).click();
    await g.locator(tid('home-new-group')).first().waitFor({ timeout: 20000 });
    check('welcome -> home', true);
    await shot(g, '02-home-empty');

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

    // 7. Abbie opens the invite and claims her name.
    await a.goto(inviteLocal, { waitUntil: 'networkidle' });
    await a.locator(tid('join-member')).first().waitFor({ timeout: 20000 });
    await shot(a, '10-join');
    await a.locator(`${tid('join-member')}[data-id="${byName['Abbie']}"]`).click();
    await a.locator(tid('join-submit')).click();
    await a.locator(tid('group-title')).waitFor({ timeout: 20000 });
    check('Abbie joined and sees the group', (await a.locator(tid('group-title')).innerText()).includes('Niseko'));
    await shot(a, '11-abbie-group');
    const aSnap = await apiGet(a, '/api/groups/' + gid);
    check('Abbie is the Abbie member', aSnap.me && aSnap.me.memberId === byName['Abbie'], JSON.stringify(aSnap.me));

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

    // 10. Set email and password, sign out, sign in.
    const email = `e2e-${RUN}@evenly.test`;
    await g.goto(BASE + '#/account', { waitUntil: 'networkidle' });
    await g.locator(tid('account-email')).waitFor({ timeout: 15000 });
    await g.locator(tid('account-email')).fill(email);
    await g.locator(tid('account-password')).fill('e2e password 1');
    await g.locator(tid('account-save-credentials')).click();
    await g.waitForTimeout(3000);
    const me = await apiGet(g, '/api/me');
    check('credentials saved', me.user && me.user.email === email && me.user.hasPassword, JSON.stringify(me.user));
    await shot(g, '13-account');
    await g.locator(tid('account-logout')).click();
    await g.locator(tid('dialog-confirm')).click({ timeout: 3000 }).catch(() => undefined);
    await g.locator(tid('welcome-login')).waitFor({ timeout: 15000 });
    await g.locator(tid('welcome-login')).click();
    await g.locator(tid('login-email')).fill(email);
    await g.locator(tid('login-password')).fill('e2e password 1');
    await g.locator(tid('login-submit')).click();
    await g.locator(tid('home-group-row')).first().waitFor({ timeout: 20000 });
    check('signed back in and sees the group', true);
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
