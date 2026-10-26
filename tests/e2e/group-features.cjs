// The four features of 2026-10-26 end to end in WebKit with iPhone 14 emulation (390 px wide):
// 封存群組, 群組預設分法, 退款 and 旅行結算圖卡, against the built app talking to the staging Worker.
//   VITE_API_BASE=https://evenly-api-staging.richlovegod.workers.dev npx vite build && npx vite preview --port 4173 --strictPort --host 127.0.0.1
//   node tests/e2e/group-features.cjs [baseUrl] [--lang zh-TW|en|both] [--shots <dir>]
// baseUrl is the vite preview (http://127.0.0.1:4173/, Bearer to the staging API) or the staging
// site itself (https://evenly-api-staging.richlovegod.workers.dev/, where the saved token moves
// into the session cookie). Each language run makes its own device-only accounts (test-gf-*) and
// groups through the API from Node, and deletes the accounts at the end, also when a check fails.
// With --shots, the screens the features add are saved there as web-<screen>-<zh|en>.png, and the
// summary card as the PNG the app made. Requests to production hosts are refused.
//  A 封存群組: 設定 > 封存群組 on a group I owe in asks first (naming the balance), the group leaves
//    群組 and 總覽 for 已封存 (the totals still count it), comes back when someone else adds an
//    entry, and 取消封存 brings it back too.
//  B 群組預設分法: 設定 > 預設分法 sets 比例 60/40 with a default payer; a new expense starts from
//    it; the split sheet shows the box checked for the default, and saves a new one when ticked;
//    a member added later is named; 清除 clears it.
//  C 退款: 記一筆退款 on Gino's ¥30,000 deposit opens the editor as 退款 with 「退款：民宿押金」,
//    the deposit's split and Gino as who got the money back, 你要還 ¥22,500; saved, its row has the
//    退款 tag, 「你收到退款」 and 你要還; its page links back to the deposit, whose page lists it; the
//    server keeps kind refund with refundOf for this app and shows an old client the expense with
//    the same effect; the 費用 / 退款 switch on a new entry turns the sentence into 「退款給」.

const path = require('path');
const fs = require('fs');
const { webkit, devices } = require('C:/Users/chunju/.claude/tmp/webkit-test/node_modules/playwright');

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const BASE = (args.find((a, i) => !a.startsWith('--') && !['--lang', '--shots'].includes(args[i - 1])) || 'http://127.0.0.1:4173/').replace(/\/?$/, '/');
const API = (process.env.API || 'https://evenly-api-staging.richlovegod.workers.dev').replace(/\/+$/, '');
const LANG = flag('--lang') || 'both';
const SHOTS = flag('--shots');
const OUT = path.join(__dirname, '..', '..', 'tmp', 'e2e-group-features');
const PRODUCTION = ['split.ginochang.com', 'evenly-api.richlovegod.workers.dev'];
const RUN = Date.now().toString(36);
fs.mkdirSync(OUT, { recursive: true });
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
}

const tid = id => `[data-testid="${id}"]`;
const errors = [];
const today = () => new Date().toISOString().slice(0, 10);
const uuid = () => require('crypto').randomUUID();

/** `refunds`: send X-Evenly-Features: refunds as the web app does (without it: an old client's view). */
async function nodeApi(method, p, { token, body, refunds = true } = {}) {
  const headers = { 'User-Agent': 'evenly-group-features/1.0 (Node)' };
  if (refunds) headers['X-Evenly-Features'] = 'refunds';
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

async function must(method, p, opts) {
  const r = await nodeApi(method, p, opts);
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

async function newDevice(browser, label, token, lang) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'], locale: lang === 'en' ? 'en-US' : 'zh-TW', serviceWorkers: 'block' });
  await ctx.route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    if (PRODUCTION.includes(host)) return route.abort();
    return route.continue();
  });
  const crossOrigin = new URL(BASE).origin !== new URL(API).origin;
  await ctx.addInitScript(({ api, token, lang, crossOrigin }) => {
    try {
      if (crossOrigin) localStorage.setItem('evenly.api', api);
      if (!localStorage.getItem('evenly.started')) {
        localStorage.setItem('evenly.token', token);
        localStorage.setItem('evenly.started', '1');
      }
      localStorage.setItem('evenly.locale', lang);
      // No first-use hints over the screens being checked.
      localStorage.setItem('evenly.pushCard.hidden', '1');
    } catch (e) {}
  }, { api: API, token, lang, crossOrigin });
  const page = await ctx.newPage();
  // A request still out when the context closes fails in WebKit as an access control error: only
  // errors from before the cleanup count.
  const live = { closing: false };
  page.on('pageerror', e => {
    if (!live.closing) errors.push(label + ' pageerror: ' + e.message);
  });
  page.on('console', m => {
    if (!live.closing && m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(label + ' console: ' + m.text());
  });
  return { ctx, page, live };
}

async function settle(page, ms = 150) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  if (ms) await page.waitForTimeout(ms);
}

/** A screenshot once no toast covers the screen; `deliver` also saves it to --shots. */
async function shot(page, name, lang, deliver = true) {
  const suffix = lang === 'en' ? 'en' : 'zh';
  await page.locator(tid('toast')).first().waitFor({ state: 'detached', timeout: 9000 }).catch(() => undefined);
  await settle(page, 200);
  await page.screenshot({ path: path.join(OUT, `${name}-${suffix}.png`) }).catch(() => undefined);
  if (SHOTS && deliver) await page.screenshot({ path: path.join(SHOTS, `web-${name}-${suffix}.png`) }).catch(() => undefined);
}

/** A toast with this text shows (toasts take turns: an earlier one may still be up). */
async function sawToast(page, text, timeout = 15000) {
  return page
    .locator(tid('toast'), { hasText: text })
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);
}

async function openGroup(page, gid, tab = '') {
  await page.goto(BASE + '#/g/' + gid + (tab ? '/' + tab : ''), { waitUntil: 'networkidle' });
  await page.locator(tid('group-title')).waitFor({ timeout: 30000 });
  await settle(page, 300);
}

async function waitFor(fn, timeout = 15000, step = 400) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return v;
    await new Promise(r => setTimeout(r, step));
  }
}

const expense = (o) => ({
  kind: 'expense', category: 'general', fxRate: 1, date: today(), ...o,
});

// ---------- one language ----------

async function run(browser, lang) {
  const zh = lang !== 'en';
  const L = (zhText, enText) => (zh ? zhText : enText);
  console.log(`\n== ${lang} ==`);
  const tokens = [];
  const pages = [];
  try {
    const g = await must('POST', '/api/auth/signup', { body: { name: 'Gino', locale: lang } });
    const a = await must('POST', '/api/auth/signup', { body: { name: 'Abbie', locale: lang } });
    tokens.push(g.token, a.token);

    // Group A: a ski trip in yen with four people; Abbie joins as her placeholder.
    const tripName = L('北海道滑雪 ', 'Hokkaido ski ') + RUN.slice(-4);
    const trip = await must('POST', '/api/groups', { token: g.token, body: { name: tripName, type: 'trip', currency: 'JPY', emoji: '⛷️', members: [{ name: 'Abbie' }, { name: 'Kevin' }, { name: 'Tiffany' }] } });
    const tm = Object.fromEntries(trip.members.map(m => [m.name, m.id]));
    await must('POST', '/api/join/' + trip.inviteCode, { token: a.token, body: { memberId: tm.Abbie } });
    const everyone = ['Gino', 'Abbie', 'Kevin', 'Tiffany'].map(n => ({ memberId: tm[n] }));
    // Abbie paid a 9,000 dinner for the four: Gino owes her 2,250.
    await must('PUT', `/api/groups/${trip.group.id}/expenses/${uuid()}`, { token: a.token, body: expense({ description: L('燒肉晚餐', 'BBQ dinner'), category: 'food.dining', amount: 9000, currency: 'JPY', payers: [{ memberId: tm.Abbie, amount: 9000 }], split: { method: 'equal', entries: everyone } }) });

    // Group B: a home in TWD, Gino and Abbie.
    const homeName = L('我們家 ', 'Our place ') + RUN.slice(-4);
    const home = await must('POST', '/api/groups', { token: g.token, body: { name: homeName, type: 'home', currency: 'TWD', emoji: '🏠', members: [{ name: 'Abbie' }] } });
    const hm = Object.fromEntries(home.members.map(m => [m.name, m.id]));
    await must('POST', '/api/join/' + home.inviteCode, { token: a.token, body: { memberId: hm.Abbie } });

    const G = await newDevice(browser, 'Gino ' + lang, g.token, lang);
    pages.push(G);
    const page = G.page;

    // ---------- A. 封存群組 ----------
    console.log('A 封存群組');
    await openGroup(page, trip.group.id, 'settings');
    const archiveBtn = page.locator(tid('settings-archive'));
    await archiveBtn.scrollIntoViewIfNeeded();
    check('A 設定 offers 封存群組', (await archiveBtn.getAttribute('data-archived')) === 'false');
    await archiveBtn.click();
    const dialog = page.locator(tid('dialog'));
    await dialog.waitFor({ timeout: 10000 });
    const dialogText = await dialog.innerText();
    check('A an unsettled group asks first, naming the balance and its direction', dialogText.includes('2,250') && dialogText.includes(L('你欠', 'you owe')), dialogText);
    await settle(page, 400);
    await shot(page, 'archive-confirm', lang);
    await page.locator(tid('dialog-confirm')).click();
    check('A the toast says where it went', await sawToast(page, L('已封存', 'Archived')));
    await waitFor(async () => (await archiveBtn.getAttribute('data-archived')) === 'true');
    check('A 設定 now offers 取消封存', (await archiveBtn.getAttribute('data-archived')) === 'true');

    await page.locator(tid('tabbar')).locator(tid('tab-groups')).click();
    await page.locator(tid('groups-show-archived')).waitFor({ timeout: 15000 });
    check('A it is off the 群組 list', (await page.locator(`${tid('group-row')}[data-id="${trip.group.id}"]`).count()) === 0);
    check('A 已封存（1）', (await page.locator(tid('groups-show-archived')).innerText()).includes('1'));
    await page.locator(tid('groups-show-archived')).click();
    await page.locator(`${tid('group-row-archived')}[data-id="${trip.group.id}"]`).waitFor({ timeout: 5000 });
    check('A 已封存 lists it with its balance and 取消封存', (await page.locator(tid('group-unarchive')).count()) === 1);
    await page.locator(tid('groups-show-archived')).scrollIntoViewIfNeeded();
    await settle(page, 300);
    await shot(page, 'archived-section', lang);

    await page.locator(tid('tabbar')).locator(tid('tab-home')).click();
    await page.locator(tid('home-totals')).waitFor({ timeout: 15000 });
    await settle(page, 300);
    check('A 總覽 does not list it', (await page.locator(`${tid('home-group-row')}[data-id="${trip.group.id}"]`).count()) === 0);
    check('A the totals still count it (you owe 2,250)', (await page.locator(tid('home-totals')).innerText()).includes('2,250'), await page.locator(tid('home-totals')).innerText());

    // Abbie adds an entry: the group comes back.
    await must('PUT', `/api/groups/${trip.group.id}/expenses/${uuid()}`, { token: a.token, body: expense({ description: L('纜車票', 'Lift tickets'), amount: 4000, currency: 'JPY', payers: [{ memberId: tm.Abbie, amount: 4000 }], split: { method: 'equal', entries: everyone } }) });
    await page.locator(tid('tabbar')).locator(tid('tab-groups')).click();
    const back = await waitFor(async () => {
      await page.reload({ waitUntil: 'networkidle' });
      return (await page.locator(`${tid('group-row')}[data-id="${trip.group.id}"]`).count()) === 1;
    }, 20000, 1000);
    check("A someone else's new entry brings it back to 群組", back);
    check('A and 已封存 is gone', (await page.locator(tid('groups-show-archived')).count()) === 0);
    // Archive it again from the API, and bring it back with 取消封存 on 群組.
    await must('PUT', `/api/groups/${trip.group.id}/archive`, { token: g.token, body: { archived: true } });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator(tid('groups-show-archived')).click({ timeout: 15000 });
    await page.locator(tid('group-unarchive')).click();
    check('A 取消封存 says so', await sawToast(page, L('已取消封存', 'Unarchived')));
    const me = await must('GET', '/api/me', { token: g.token });
    check('A 取消封存 cleared it on the server', me.groups.find(x => x.id === trip.group.id)?.archived === false);

    // ---------- B. 群組預設分法 ----------
    console.log('B 群組預設分法');
    await openGroup(page, home.group.id, 'settings');
    const row = page.locator(tid('settings-default-split'));
    await row.scrollIntoViewIfNeeded();
    check('B 設定 shows no default yet', (await page.locator(tid('settings-default-split-text')).innerText()).includes(L('沒有設定', 'None')));
    await row.click();
    await page.locator(tid('split-method-percent')).click({ timeout: 10000 });
    check('B the sheet offers 平均 / 比例 / 份數 only', (await page.locator('[data-testid^="split-method-"]').count()) === 3);
    await page.locator(tid('split-value-' + hm.Gino)).fill('60');
    await page.locator(tid('split-value-' + hm.Abbie)).fill('40');
    await page.locator(tid('default-payer-' + hm.Abbie)).click();
    await shot(page, 'default-sheet', lang, false);
    await page.locator(tid('split-done')).click();
    check('B 儲存 says so', await sawToast(page, L('已儲存預設分法', 'Default split saved')));
    await page.locator(tid('sheet')).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
    const rowText = await waitFor(async () => {
      const x = await page.locator(tid('settings-default-split-text')).innerText();
      return x.includes('60%') ? x : null;
    });
    check('B the 設定 row shows it in words', rowText === L('比例：你 60%、Abbie 40%', 'Percent: you 60%, Abbie 40%'), rowText);
    check('B and who pays', (await row.innerText()).includes(L('Abbie 付款', 'Abbie pays')), await row.innerText());
    const srv = (await must('GET', '/api/groups/' + home.group.id, { token: a.token })).group.defaultSplit;
    check('B the server keeps it for the group', srv && srv.method === 'percent' && srv.payerId === hm.Abbie && srv.entries.length === 2, JSON.stringify(srv));
    await row.scrollIntoViewIfNeeded();
    await settle(page, 300);
    await shot(page, 'default-row', lang);

    // A new expense starts from it.
    await page.locator(tid('group-add-expense')).first().click();
    await page.locator(tid('editor-split')).waitFor({ timeout: 15000 });
    const payerChip = await page.locator(tid('editor-payer')).innerText();
    check('B a new expense starts with the default payer', payerChip.includes('Abbie'), payerChip);
    check('B and the default split', (await page.locator(tid('editor-split')).innerText()).includes(L('依比例', 'by percent')), await page.locator(tid('editor-split')).innerText());
    await page.locator(tid('editor-split')).click();
    const box = page.locator(tid('split-set-default'));
    await box.waitFor({ timeout: 10000 });
    check('B the box is checked and disabled for the default itself', (await box.isChecked()) && (await box.isDisabled()));
    check('B with its note', (await page.locator(tid('split-default-note')).innerText()).includes(L('這就是這個群組的預設分法', "This is the group's default split")));
    await page.locator(tid('split-method-shares')).click();
    await page.locator(tid('split-value-' + hm.Gino)).fill('2');
    await page.locator(tid('split-value-' + hm.Abbie)).fill('1');
    await box.check();
    await page.locator(tid('split-default-box')).scrollIntoViewIfNeeded();
    await settle(page, 300);
    await shot(page, 'default-checkbox', lang);
    await page.locator(tid('split-done')).click();
    check('B ticked, 完成 saves it as the default', await sawToast(page, L('已設為這個群組的預設分法', "Saved as the group's default split")));
    const srv2 = await waitFor(async () => {
      const d = (await must('GET', '/api/groups/' + home.group.id, { token: g.token })).group.defaultSplit;
      return d && d.method === 'shares' ? d : null;
    });
    check('B the new default is 份數 2:1 and keeps its payer', srv2 && JSON.stringify(srv2.entries) === JSON.stringify([{ memberId: hm.Gino, value: 2 }, { memberId: hm.Abbie, value: 1 }]) && srv2.payerId === hm.Abbie, JSON.stringify(srv2));
    await page.locator(tid('editor-cancel')).click();
    await page.locator(tid('dialog-confirm')).click({ timeout: 3000 }).catch(() => undefined);

    // Someone who joins later is named.
    await must('POST', `/api/groups/${home.group.id}/members`, { token: a.token, body: { name: 'Lily' } });
    await page.goto(BASE + '#/g/' + home.group.id + '/add', { waitUntil: 'networkidle' });
    const note = page.locator(tid('editor-default-note'));
    await note.waitFor({ timeout: 15000 });
    check('B a member added later is named', (await note.innerText()).includes('Lily') && (await note.innerText()).includes(L('新成員不在預設分法裡', 'not in the default split')), await note.innerText());
    await page.locator(tid('editor-cancel')).click();
    await page.locator(tid('dialog-confirm')).click({ timeout: 3000 }).catch(() => undefined);

    // 清除.
    await openGroup(page, home.group.id, 'settings');
    await page.locator(tid('settings-default-split-clear')).click();
    check('B 清除 says so', await sawToast(page, L('已清除預設分法', 'Default split cleared')));
    const cleared = await waitFor(async () => (await must('GET', '/api/groups/' + home.group.id, { token: g.token })).group.defaultSplit === null);
    check('B and the server has none', cleared);

    // ---------- C. 退款 ----------
    console.log('C 退款');
    // Gino paid the ¥30,000 lodge deposit for the four of them.
    const abbieNet = async () => (await must('GET', '/api/me', { token: a.token })).groups.find(x => x.id === trip.group.id)?.myNet;
    const abbieBefore = await abbieNet();
    const depId = uuid();
    const depName = L('民宿押金', 'Lodge deposit');
    await must('PUT', `/api/groups/${trip.group.id}/expenses/${depId}`, { token: g.token, body: expense({ description: depName, category: 'travel.hotel', amount: 30000, currency: 'JPY', payers: [{ memberId: tm.Gino, amount: 30000 }], split: { method: 'equal', entries: everyone } }) });
    await page.goto(BASE + '#/g/' + trip.group.id + '/e/' + depId, { waitUntil: 'networkidle' });
    await page.locator(tid('detail-refund')).click({ timeout: 30000 });
    await page.locator(tid('editor-split')).waitFor({ timeout: 15000 });
    check('C 記一筆退款 opens the editor as 退款', (await page.locator(tid('editor-kind-refund')).getAttribute('aria-checked')) === 'true');
    const refundDesc = L('退款：', 'Refund: ') + depName;
    check('C with the description 「退款：<the expense>」', (await page.locator(tid('editor-description')).inputValue()) === refundDesc, await page.locator(tid('editor-description')).inputValue());
    check('C the full amount', (await page.locator(tid('editor-amount')).first().inputValue()) === '30000', await page.locator(tid('editor-amount')).first().inputValue());
    const who = await page.locator(tid('editor-payer')).locator('xpath=..').innerText();
    check('C the sentence says who got the money back, and the expense split', who.includes(L('退款給', 'Refunded to')) && who.includes(L('平均分給 4 人', 'split equally, 4 people')), who);
    const lead = await page.locator('main').innerText();
    check('C the effect for the receiver is 你要還 ¥22,500', lead.includes(L('你要還', 'You owe')) && lead.includes('22,500'), lead.slice(0, 600));
    await settle(page, 300);
    await shot(page, 'refund-editor', lang);
    await page.locator(tid('editor-save')).first().click();
    check('C 儲存 says so', await sawToast(page, L('已儲存', 'Saved')));
    const refundRow = page.locator(`${tid('expense-row')}`, { hasText: refundDesc }).first();
    await refundRow.waitFor({ timeout: 20000 });
    const refundText = await refundRow.innerText();
    check('C the row has the 退款 tag', (await refundRow.locator(tid('expense-row-refund')).count()) === 1);
    check('C and says 「你收到退款」 with 你要還 ¥22,500', new RegExp(L('你\\s*收到退款', 'You\\s+got\\s+back')).test(refundText) && refundText.includes(L('你要還', 'You owe')) && refundText.includes('22,500'), refundText);
    await waitFor(async () => (await refundRow.getAttribute('data-state')) === 'synced', 20000);
    await refundRow.scrollIntoViewIfNeeded();
    await settle(page, 300);
    await shot(page, 'refund-row', lang);
    const refId = await refundRow.getAttribute('data-id');
    const srvSnap = await must('GET', '/api/groups/' + trip.group.id, { token: a.token });
    const srvRefund = srvSnap.expenses.find(e => e.id === refId);
    check('C the server keeps kind refund with refundOf for this app', srvRefund && srvRefund.kind === 'refund' && srvRefund.refundOf === depId && srvRefund.repeat === 'none', JSON.stringify(srvRefund));
    const oldSnap = await must('GET', '/api/groups/' + trip.group.id, { token: a.token, refunds: false });
    const oldRefund = oldSnap.expenses.find(e => e.id === refId);
    check('C an old client gets the expense with the same effect', oldRefund && oldRefund.kind === 'expense' && oldRefund.split.method === 'exact' && oldRefund.payers.length === 4, JSON.stringify(oldRefund));
    // Abbie's ¥7,500 of the deposit comes back to her: the deposit and its refund cancel out.
    const abbieAfter = await abbieNet();
    check('C balances: the deposit and its refund cancel out for Abbie', typeof abbieBefore === 'number' && abbieAfter === abbieBefore, [abbieBefore, abbieAfter]);
    // The refund's page links to the deposit; the deposit's page lists the refund.
    await refundRow.click();
    await page.locator(tid('detail-refund-of')).waitFor({ timeout: 15000 });
    check('C the refund page says 退款 and links to the deposit', (await page.locator(tid('detail-refund-tag')).count()) === 1 && (await page.locator(tid('detail-refund-of')).innerText()).includes(depName));
    await page.locator(tid('detail-refund-of')).locator('a').click();
    await page.locator(tid('detail-refunds')).waitFor({ timeout: 15000 });
    check('C the deposit page lists its refund', (await page.locator(tid('detail-refund-item')).count()) === 1);
    // The switch on a new entry.
    await page.goto(BASE + '#/g/' + trip.group.id + '/add', { waitUntil: 'networkidle' });
    await page.locator(tid('editor-kind-refund')).click({ timeout: 15000 });
    const sw = await page.locator(tid('editor-payer')).locator('xpath=..').innerText();
    check('C 費用 / 退款 turns the sentence into 「退款給」', sw.includes(L('退款給', 'Refunded to')), sw);
    check('C and a refund has no 重複', (await page.locator(tid('editor-repeat')).count()) === 0);
    await page.locator(tid('editor-kind-expense')).click();
    check('C back to 費用: 「由 … 付款」', (await page.locator(tid('editor-payer')).locator('xpath=..').innerText()).includes(L('付款', 'Paid by')));
    await page.locator(tid('editor-cancel')).click();
    await page.locator(tid('dialog-confirm')).click({ timeout: 3000 }).catch(() => undefined);
  } catch (e) {
    check(`${lang}: the flow ran to the end`, false, e.stack || e.message);
    for (const p of pages) await p.page.screenshot({ path: path.join(OUT, `zz-error-${lang}.png`) }).catch(() => undefined);
  } finally {
    for (const p of pages) p.live.closing = true;
    for (const p of pages) await p.ctx.close().catch(() => undefined);
    for (const tok of tokens) await nodeApi('DELETE', '/api/me', { token: tok, body: {} }).catch(() => undefined);
  }
}

(async () => {
  console.log(`Group features against ${BASE} (API ${API})`);
  if (PRODUCTION.includes(new URL(API).hostname) || PRODUCTION.includes(new URL(BASE).hostname)) {
    console.log('Refusing to run against production.');
    process.exit(2);
  }
  const health = await nodeApi('GET', '/api/health').catch(() => ({ status: 0, data: null }));
  if (!(health.status === 200 && health.data && health.data.env === 'staging')) {
    console.log('The API does not say staging: ' + JSON.stringify(health));
    process.exit(2);
  }
  const browser = await webkit.launch();
  for (const lang of LANG === 'both' ? ['zh-TW', 'en'] : [LANG]) await run(browser, lang);
  await browser.close();
  check('no page errors', errors.length === 0, errors.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed. Screenshots: ${OUT}${SHOTS ? ' and ' + SHOTS : ''}`);
  if (fail) {
    console.log('Failed:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})();
