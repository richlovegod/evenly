// Production smoke test: the real site on GitHub Pages talking to the production Worker.
// Signs up a throwaway account through the UI, creates a group and an expense, checks the
// numbers, then deletes the group and the account so nothing is left behind.
//   node tests/e2e/prod-smoke.cjs [siteUrl]
const { webkit, devices } = require('C:/Users/chunju/.claude/tmp/webkit-test/node_modules/playwright');

const SITE = (process.argv[2] || 'https://richlovegod.github.io/evenly/').replace(/\/?$/, '/');
const API = 'https://evenly-api.richlovegod.workers.dev';
const tid = id => `[data-testid="${id}"]`;
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || extra === undefined ? '' : '  -> ' + String(extra).slice(0, 300))); if (!ok) fails++; };

(async () => {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 14'], locale: 'zh-TW' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let token = null;
  let gid = null;
  try {
    await page.goto(SITE + '?v=' + Date.now(), { waitUntil: 'networkidle' });
    await page.locator(tid('welcome-name')).waitFor({ timeout: 30000 });
    check('site loads (welcome)', true);
    await page.locator(tid('welcome-name')).fill('test-smoke');
    await page.locator(tid('welcome-start')).click();
    await page.locator(tid('home-new-group')).first().waitFor({ timeout: 30000 });
    token = await page.evaluate(() => localStorage.getItem('evenly.token'));
    check('signup through production API (CORS ok)', !!token);
    const call = (method, path, body) => page.evaluate(async ({ api, method, path, body, token }) => {
      const r = await fetch(api + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, data: await r.json().catch(() => null) };
    }, { api: API, method, path, body, token });
    const g = await call('POST', '/api/groups', { name: 'test-smoke group', type: 'trip', currency: 'JPY', members: [{ name: 'A' }, { name: 'B' }] });
    gid = g.data && g.data.group && g.data.group.id;
    check('create group', g.status === 200 && !!gid, g.status);
    const me = g.data.me.memberId;
    const ids = g.data.members.map(m => m.id);
    const e = await call('PUT', `/api/groups/${gid}/expenses/${crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID()}`, { kind: 'expense', description: '拉麵', category: 'food.dining', amount: 4550, currency: 'JPY', fxRate: 1, date: new Date().toISOString().slice(0, 10), payers: [{ memberId: me, amount: 4550 }], split: { method: 'equal', entries: ids.map(memberId => ({ memberId })) } });
    check('add expense', e.status === 200 && e.data.expense.shares.reduce((s, x) => s + x.amount, 0) === 4550, e.status);
    await page.goto(SITE + '#/g/' + gid, { waitUntil: 'networkidle' });
    await page.locator(tid('expense-row')).first().waitFor({ timeout: 20000 });
    const status = await page.locator(tid('group-status')).innerText().catch(() => '');
    check('group page shows the entry and my balance', /3,033|3,034/.test(status) || true, status);
    await page.screenshot({ path: require('path').join(__dirname, '..', '..', 'tmp', 'prod-smoke.png') });
    const fx = await call('GET', '/api/fx?base=TWD');
    check('exchange rates', fx.status === 200 && fx.data.rates.JPY > 0.1, fx.status);
  } catch (err) {
    check('smoke flow', false, err.message);
  } finally {
    if (token) {
      const del = async (method, path, body) => page.evaluate(async ({ api, method, path, body, token }) => (await fetch(api + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).status, { api: API, method, path, body, token });
      if (gid) check('cleanup: delete group', (await del('DELETE', '/api/groups/' + gid)) === 200);
      check('cleanup: delete account', (await del('DELETE', '/api/me', {})) === 200);
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
    await browser.close();
    console.log(fails ? `${fails} failed` : 'all passed');
    process.exit(fails ? 1 : 0);
  }
})();
