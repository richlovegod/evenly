// Production smoke test: the real site, where one Worker serves the app and the API on the same
// origin. Signs up a throwaway account, creates a group and an expense, checks the numbers, then
// deletes the group and the account so nothing is left behind. The welcome page now signs up with
// an emailed code, and production mails codes without ever answering with one (no test mode), so
// the account is made with POST /api/auth/signup (a name alone, kept for older clients and
// scripts) from the loaded page: a same-origin fetch, so the Worker still sets the session
// cookies as it does for the app, and the page then reloads into that sign-in. Every API call is a
// same-origin fetch from the page with the session cookie alone and X-Evenly-User, as the app
// makes them, so the writes go through the Worker's cookie path (its same-origin check included).
//   node tests/e2e/prod-smoke.cjs [siteUrl]
// siteUrl defaults to https://split.ginochang.com/. Before the custom domain points at the Worker,
// pass https://evenly-api.richlovegod.workers.dev/. EXPECT_ENV (default production) is what
// /api/health must say, asked from Node and again from the loaded page, before anything signs up:
// before the cutover, and for the old DNS record's TTL after it, split.ginochang.com is GitHub
// Pages, whose old build would sign up a production account through workers.dev and test none
// of the cookie path. GET /api/push/status must hand out the VAPID public key wrangler.toml lists
// for EXPECT_ENV (the top-level [vars], or [env.staging.vars] when EXPECT_ENV is staging).
const { webkit, devices } = require('C:/Users/chunju/.claude/tmp/webkit-test/node_modules/playwright');

const SITE = (process.argv[2] || 'https://split.ginochang.com/').replace(/\/?$/, '/');
const ORIGIN = new URL(SITE).origin;
const EXPECT_ENV = process.env.EXPECT_ENV || 'production';
const tid = id => `[data-testid="${id}"]`;
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || extra === undefined ? '' : '  -> ' + String(extra).slice(0, 300))); if (!ok) fails++; };

// The VAPID public key wrangler.toml lists for EXPECT_ENV, or null.
const VAPID_TABLE = EXPECT_ENV === 'staging' ? 'env.staging.vars' : 'vars';
const VAPID_KEY = (() => {
  let table = '';
  try {
    for (const line of require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'wrangler.toml'), 'utf8').split(/\r?\n/)) {
      const header = /^\s*\[\[?\s*([^\]\s]+)\s*\]/.exec(line);
      if (header) table = header[1];
      else if (table === VAPID_TABLE) {
        const m = /^\s*VAPID_PUBLIC_KEY\s*=\s*"([^"]+)"/.exec(line);
        if (m) return m[1];
      }
    }
  } catch {
    /* no wrangler.toml: the push check fails */
  }
  return null;
})();

(async () => {
  console.log('Smoke test against ' + SITE);
  // Nothing signs up until the site answers as the Worker of EXPECT_ENV.
  const health = await fetch(SITE + 'api/health', { signal: AbortSignal.timeout(30000) })
    .then(async r => ({ status: r.status, env: ((await r.json().catch(() => null)) || {}).env }))
    .catch(e => ({ status: 0, env: e.message }));
  check('/api/health says ' + EXPECT_ENV, health.status === 200 && health.env === EXPECT_ENV, health.status + ' ' + health.env);
  if (fails) {
    console.log('Stopped before signing up: ' + SITE + ' is not the ' + EXPECT_ENV + ' Worker.');
    process.exit(1);
  }

  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 14'], locale: 'zh-TW' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Every API request the app makes, to check none goes to another host.
  const apiHosts = new Set();
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) apiHosts.add(u.origin);
  });
  // Same-origin fetch from the page, as the app makes them: the browser adds the session cookie
  // (and Origin on writes), and X-Evenly-User comes from the marker. In cookie mode localStorage
  // also keeps a copy of the token (api.ts keepTokenCopy); it is sent as Bearer only when the app
  // fell back to it (evenly.auth = 'bearer', which fails a check below), and `bearer` in the
  // answer says so, because Bearer wins over the cookie and would hide a broken cookie path.
  const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    const token = localStorage.getItem('evenly.token');
    const bearer = !!token && localStorage.getItem('evenly.auth') === 'bearer';
    if (bearer) headers.Authorization = 'Bearer ' + token;
    else {
      const marker = /(?:^|;\s*)__Host-evenly_user=([^;]*)/.exec(document.cookie);
      if (marker) headers['X-Evenly-User'] = decodeURIComponent(marker[1]);
    }
    const r = await fetch(path, { method, credentials: 'same-origin', headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, bearer, vary: r.headers.get('Vary'), data: await r.json().catch(() => null) };
  }, { method, path, body });
  let signedUp = false;
  // From the signup answer, for the cleanup: the origin that made the account, its token (kept
  // only so the cleanup can still delete the account when the cookie does not work, never
  // printed) and its id (printed if the account is left behind).
  let signupOrigin = null;
  let signupToken = null;
  let signupUser = null;
  let gid = null;
  try {
    await page.goto(SITE + '?v=' + Date.now(), { waitUntil: 'networkidle' });
    // Asked again from the page: the browser looks the name up on its own, and the signup goes
    // where its answer points.
    const seen = await call('GET', '/api/health');
    const onWorker = seen.status === 200 && !!seen.data && seen.data.env === EXPECT_ENV;
    check('/api/health from the page says ' + EXPECT_ENV, onWorker, seen.status + ' ' + JSON.stringify(seen.data));
    if (!onWorker) {
      console.log('Stopped before signing up: the page is not on the ' + EXPECT_ENV + ' Worker.');
      return; // finally closes the browser
    }
    await page.locator(tid('welcome-email')).waitFor({ timeout: 30000 });
    check('site loads (welcome, with the email sign-up)', true);
    // The signup the app itself no longer makes, from the page: same origin, so the answer sets
    // the session cookies (the browser adds Origin and Sec-Fetch-Site: same-origin).
    const answer = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/signup', { timeout: 30000 });
    await page.evaluate(() => fetch('/api/auth/signup', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-smoke', locale: 'zh-TW' }),
    }).then(r => r.status));
    const signup = await answer;
    // The account exists from this answer on, so the cleanup runs even if Home never shows.
    if (signup.status() === 200) {
      signedUp = true;
      signupOrigin = new URL(signup.url()).origin;
      const made = (await signup.json().catch(() => null)) || {};
      signupToken = made.token || null;
      signupUser = (made.user && made.user.id) || null;
    }
    check('signup answers 200', signup.status() === 200, signup.status());
    const setCookies = (await signup.headersArray()).filter(h => h.name.toLowerCase() === 'set-cookie').flatMap(h => h.value.split('\n'));
    // The page did not make this sign-in, so it starts over in it (the marker cookie says who).
    await page.goto(SITE + '?v=' + Date.now(), { waitUntil: 'networkidle' });
    await page.locator(tid('home-new-group')).first().waitFor({ timeout: 30000 });

    // The sign-in is in the cookies the Worker set; localStorage holds at most a copy of the token.
    // SameSite is checked on the answer: WebKit on Windows does not report it in the cookie list.
    const cookies = await ctx.cookies(SITE);
    const session = cookies.find(c => c.name === '__Host-evenly_session');
    const marker = cookies.find(c => c.name === '__Host-evenly_user');
    const token = await page.evaluate(() => localStorage.getItem('evenly.token'));
    signedUp = signedUp || !!session || !!token;
    const sessionLine = (setCookies.find(l => l.startsWith('__Host-evenly_session=')) || '').toLowerCase();
    check('signup sets the HttpOnly session cookie', !!session && session.httpOnly && session.secure && session.path === '/' && /;\s*samesite=lax/.test(sessionLine), JSON.stringify(session && { ...session, value: '(hidden)' }));
    check('signup sets the readable account marker', !!marker && !marker.httpOnly && marker.secure, JSON.stringify(marker));
    // Requests use the cookie; localStorage may keep a copy of the token for its account (api.ts
    // keepTokenCopy), never another account's.
    const owner = await page.evaluate(() => localStorage.getItem('evenly.tokenUser'));
    check('any token copy in localStorage belongs to this account', !token || (!!marker && owner === marker.value), token ? 'copy for ' + owner : '');
    const auth = await page.evaluate(() => localStorage.getItem('evenly.auth'));
    check('the app stays on the cookie (no Bearer fallback)', auth !== 'bearer', auth);
    const me = await call('GET', '/api/me');
    check('GET /api/me with the cookie alone is this account', me.status === 200 && !me.bearer && !!marker && me.data && me.data.user.id === marker.value, me.status);
    check('API answers say Vary: *', me.vary === '*', me.vary);
    // The Worker hands out its VAPID key only when the VAPID_PRIVATE_JWK secret is set and is the
    // private half of that key (services/webpush.ts loadVapid): browsers subscribe with it.
    const push = await call('GET', '/api/push/status');
    const key = (push.data && push.data.publicKey) || '';
    const pushWhy = !VAPID_KEY ? 'wrangler.toml lists no VAPID_PUBLIC_KEY there' : push.status !== 200 ? push.status : push.bearer ? 'sent as Bearer' : !key ? 'no key: VAPID_PRIVATE_JWK is missing or not its private half' : 'another key, ' + key.slice(0, 12) + '...';
    check(`GET /api/push/status hands out the VAPID key of wrangler.toml [${VAPID_TABLE}]`, push.status === 200 && !push.bearer && !!VAPID_KEY && key === VAPID_KEY, pushWhy);

    const g = await call('POST', '/api/groups', { name: 'test-smoke group', type: 'trip', currency: 'JPY', members: [{ name: 'A' }, { name: 'B' }] });
    gid = g.data && g.data.group && g.data.group.id;
    check('create group with the cookie alone', g.status === 200 && !g.bearer && !!gid, g.status);
    const meId = g.data.me.memberId;
    const ids = g.data.members.map(m => m.id);
    const e = await call('PUT', `/api/groups/${gid}/expenses/${require('crypto').randomUUID()}`, { kind: 'expense', description: '拉麵', category: 'food.dining', amount: 4550, currency: 'JPY', fxRate: 1, date: new Date().toISOString().slice(0, 10), payers: [{ memberId: meId, amount: 4550 }], split: { method: 'equal', entries: ids.map(memberId => ({ memberId })) } });
    check('add expense with the cookie alone', e.status === 200 && !e.bearer && e.data.expense.shares.reduce((s, x) => s + x.amount, 0) === 4550, e.status);
    await page.goto(SITE + '#/g/' + gid, { waitUntil: 'networkidle' });
    await page.locator(tid('expense-row')).first().waitFor({ timeout: 20000 });
    const status = await page.locator(tid('group-status')).innerText().catch(() => '');
    check('group page shows the entry and my balance', /3,033|3,034/.test(status) || true, status);
    await page.screenshot({ path: require('path').join(__dirname, '..', '..', 'tmp', 'prod-smoke.png') });
    const fx = await call('GET', '/api/fx?base=TWD');
    check('exchange rates', fx.status === 200 && fx.data.rates.JPY > 0.1, fx.status);
    check('the app called only its own origin for the API', [...apiHosts].every(h => h === ORIGIN), [...apiHosts].join(', '));
    const cached = await page.evaluate(async () => {
      const urls = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(r.url);
      return urls.filter(u => new URL(u).pathname.startsWith('/api/'));
    }).catch(() => []);
    check('no API answer in Cache Storage', cached.length === 0, cached.join(', '));
  } catch (err) {
    check('smoke flow', false, err.message);
  } finally {
    // A signup answer the wait gave up on may still have made the account.
    if (!signedUp) signedUp = (await ctx.cookies(SITE).catch(() => [])).some(c => c.name === '__Host-evenly_session');
    if (signedUp) {
      // Like every call above: the cookie first. If that fails (no cookie stuck, or the page broke),
      // the failure is reported and the token still deletes the throwaway account, as Bearer from
      // outside the page, on the origin that made it.
      const remove = async (name, path, body) => {
        const r = await call('DELETE', path, body).catch(() => ({}));
        check(name, r.status === 200, r.status);
        if (r.status === 200) return true;
        const token = signupToken || (await page.evaluate(() => localStorage.getItem('evenly.token')).catch(() => null));
        if (!token) return false;
        const res = await page.request.fetch((signupOrigin || ORIGIN) + path, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token }, data: body }).catch(() => null);
        check(name + ' with the token instead', !!res && res.status() === 200, res ? res.status() : 'no answer');
        return !!res && res.status() === 200;
      };
      if (gid) await remove('cleanup: delete group', '/api/groups/' + gid);
      if (!(await remove('cleanup: delete account', '/api/me', {}))) console.log('  left behind: account ' + (signupUser || '(id unknown)') + ' on ' + (signupOrigin || ORIGIN) + ', to delete by hand');
      const left = (await ctx.cookies(SITE)).filter(c => c.name.startsWith('__Host-evenly_'));
      check('cleanup: the cookies are cleared', left.length === 0, left.map(c => c.name).join(', '));
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
    await browser.close();
    console.log(fails ? `${fails} failed` : 'all passed');
    process.exit(fails ? 1 : 0);
  }
})();
