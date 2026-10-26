// End-to-end API contract test against a deployed Worker (staging).
// Usage: node tests/api/api-test.mjs https://evenly-api-staging.richlovegod.workers.dev [ownerEmail ownerPassword]
// Creates throwaway accounts (names start with "test-"), checks every endpoint in docs/SPEC.md,
// and prints a pass/fail line per check. Exit code 1 when anything failed. The email code checks
// read the code from the start answer (devCode): staging's test mode, EMAIL_DEV_ECHO.

const BASE = (process.argv[2] || 'https://evenly-api-staging.richlovegod.workers.dev').replace(/\/+$/, '');
const OWNER_EMAIL = process.argv[3] || '';
const OWNER_PW = process.argv[4] || '';
const RUN = Date.now().toString(36);
const UA = 'evenly-api-test/1.0 (Node)';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    failures.push(name);
    console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 400) : ''));
  }
}

async function req(method, path, { token, body, headers = {}, raw = false } = {}) {
  const h = { 'User-Agent': UA, Origin: 'http://127.0.0.1:4173', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return raw ? { res, data, text } : { status: res.status, data, headers: res.headers };
}

const uuid = () => crypto.randomUUID();
const today = new Date().toISOString().slice(0, 10);
function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log('API test against ' + BASE + ' run ' + RUN);

  // ---------- health and CORS ----------
  {
    const r = await req('GET', '/api/health');
    check('health 200', r.status === 200 && r.data && r.data.ok === true, r.data);
    const pre = await fetch(BASE + '/api/me', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:4173', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization', 'User-Agent': UA } });
    check('CORS preflight allowed origin', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'http://127.0.0.1:4173', pre.status);
    const bad = await fetch(BASE + '/api/health', { headers: { Origin: 'https://evil.example', 'User-Agent': UA } });
    check('CORS does not echo unknown origin', bad.headers.get('access-control-allow-origin') !== 'https://evil.example');
  }

  // ---------- an account with an email (a code), and signup (a name only) ----------
  const emailA = `test-a-${RUN}@evenly.test`;
  const pwA = 'correct horse ' + RUN;
  // An email comes only with a code: staging's test mode answers the start with it (devCode).
  const startA = await req('POST', '/api/auth/email/start', { body: { email: emailA, locale: 'zh-TW' } });
  const a = await req('POST', '/api/auth/email/verify', { body: { email: emailA, code: startA.data?.devCode, name: 'test-Gino', locale: 'zh-TW' } });
  check('an account made with an email code 200', a.status === 200 && a.data?.token && a.data?.created === true && a.data?.user?.email === emailA && a.data?.user?.emailVerified === true, a.data);
  check('default currency TWD for zh-TW', a.data?.user?.currency === 'TWD', a.data?.user);
  const tokA = a.data?.token;
  const userA = a.data?.user;
  const pa = await req('POST', '/api/me/credentials', { token: tokA, body: { email: emailA, password: pwA } });
  check('a password for the confirmed email', pa.status === 200 && pa.data?.user?.hasPassword === true, pa.data);

  const b = await req('POST', '/api/auth/signup', { body: { name: 'test-Abbie', locale: 'en' } });
  check('device-only signup 200', b.status === 200 && b.data?.token && b.data?.user?.email === null && b.data?.user?.hasPassword === false, b.data);
  check('signup default currency USD for en', b.data?.user?.currency === 'USD', b.data?.user);
  const tokB = b.data?.token;

  const c = await req('POST', '/api/auth/signup', { body: { name: 'test-Stranger' } });
  const tokC = c.data?.token;
  check('third account', c.status === 200 && !!tokC);

  {
    const r = await req('POST', '/api/auth/signup', { body: { name: 'x', email: emailA, password: 'another password' } });
    check('signup with an email and a password -> 400 email_requires_code', r.status === 400 && r.data?.error?.code === 'email_requires_code', r.data);
    const r2 = await req('POST', '/api/auth/signup', { body: { name: 'x', email: `test-x-${RUN}@evenly.test` } });
    check('signup with an email alone -> email_requires_code', r2.status === 400 && r2.data?.error?.code === 'email_requires_code', r2.data);
    const r3 = await req('POST', '/api/auth/signup', { body: { name: 'x', password: 'some password 1' } });
    check('signup with a password alone -> email_requires_code', r3.status === 400 && r3.data?.error?.code === 'email_requires_code', r3.data);
    const r4 = await req('POST', '/api/auth/signup', { body: { name: '' } });
    check('empty name -> validation', r4.status === 400 && r4.data?.error?.code === 'validation', r4.data);
    const r5 = await req('POST', '/api/me/credentials', { token: tokA, body: { email: emailA, password: 'short', currentPassword: pwA } });
    check('short password -> weak_password', r5.status === 400 && r5.data?.error?.code === 'weak_password', r5.data);
  }

  // ---------- login, me, sessions ----------
  {
    const r = await req('POST', '/api/auth/login', { body: { email: emailA.toUpperCase(), password: pwA } });
    check('login (case-insensitive email) 200', r.status === 200 && r.data?.token, r.data);
    const bad = await req('POST', '/api/auth/login', { body: { email: emailA, password: 'wrong password!' } });
    check('wrong password -> 401 invalid_credentials', bad.status === 401 && bad.data?.error?.code === 'invalid_credentials', bad.data);
    const nobody = await req('POST', '/api/auth/login', { body: { email: `nobody-${RUN}@evenly.test`, password: 'whatever123' } });
    check('unknown email -> same error', nobody.status === 401 && nobody.data?.error?.code === 'invalid_credentials', nobody.data);
    const me = await req('GET', '/api/me', { token: tokA });
    check('GET /me', me.status === 200 && me.data?.user?.id === userA.id && Array.isArray(me.data?.groups) && Array.isArray(me.data?.friends), me.data);
    check('GET /me no-store', (me.headers.get('cache-control') || '').includes('no-store'), me.headers.get('cache-control'));
    const noauth = await req('GET', '/api/me');
    check('GET /me without token -> 401', noauth.status === 401 && noauth.data?.error?.code === 'unauthorized', noauth.data);
    const garbage = await req('GET', '/api/me', { token: 'garbage-token' });
    check('GET /me with bad token -> 401', garbage.status === 401);
    const s = await req('GET', '/api/auth/sessions', { token: tokA });
    check('sessions list', s.status === 200 && s.data?.sessions?.length >= 2 && s.data.sessions.some(x => x.current), s.data);
    const other = s.data?.sessions?.find(x => !x.current);
    if (other) {
      const del = await req('DELETE', '/api/auth/sessions/' + other.id, { token: tokA });
      check('revoke other session', del.status === 200, del.data);
      const tokLogin = r.data?.token;
      const after = await req('GET', '/api/me', { token: tokLogin });
      check('revoked session no longer works', after.status === 401, after.status);
    }
    const p = await req('PATCH', '/api/me', { token: tokA, body: { name: 'test-Gino C', payInfo: '國泰 013-123456', venmo: 'gino-c', paypal: 'ginoc', currency: 'USD', locale: 'en' } });
    check('PATCH /me', p.status === 200 && p.data?.user?.venmo === 'gino-c' && p.data?.user?.currency === 'USD' && p.data?.user?.locale === 'en', p.data);
    const pbad = await req('PATCH', '/api/me', { token: tokA, body: { venmo: 'bad name with spaces' } });
    check('PATCH /me invalid venmo -> validation', pbad.status === 400, pbad.data);
    await req('PATCH', '/api/me', { token: tokA, body: { name: 'test-Gino', locale: 'zh-TW', currency: 'TWD' } });
  }

  // ---------- email codes (staging's test mode answers with the code: devCode) ----------
  {
    const fresh = `test-new-${RUN}@evenly.test`;
    const s1 = await req('POST', '/api/auth/email/start', { body: { email: fresh, locale: 'en' } });
    check('email start (test mode: devCode)', s1.status === 200 && s1.data?.ok === true && s1.data?.expiresInSec === 600 && /^[0-9]{6}$/.test(s1.data?.devCode || ''), s1.data);
    const s2 = await req('POST', '/api/auth/email/start', { body: { email: emailA } });
    check('email start answers the same for an address with an account', s2.status === 200 && Object.keys(s2.data || {}).sort().join() === Object.keys(s1.data || {}).sort().join(), s2.data);
    const wrongCode = String((Number(s1.data?.devCode || 0) + 1) % 1000000).padStart(6, '0');
    const bad = await req('POST', '/api/auth/email/verify', { body: { email: fresh, code: wrongCode, name: 'test-New' } });
    check('wrong code -> 400 code_invalid', bad.status === 400 && bad.data?.error?.code === 'code_invalid', bad.data);
    const noName = await req('POST', '/api/auth/email/verify', { body: { email: fresh, code: s1.data?.devCode } });
    check('a new address without a name -> 400 name_required', noName.status === 400 && noName.data?.error?.code === 'name_required', noName.data);
    const made = await req('POST', '/api/auth/email/verify', { body: { email: fresh, code: s1.data?.devCode, name: 'test-New', locale: 'en' } });
    check('the same code with a name makes the account', made.status === 200 && made.data?.created === true && made.data?.user?.email === fresh && made.data?.user?.emailVerified === true && !!made.data?.token, made.data);
    const back = await req('POST', '/api/auth/email/verify', { body: { email: emailA, code: s2.data?.devCode } });
    check('a code signs in the account that has the address', back.status === 200 && back.data?.created === false && back.data?.user?.id === userA?.id && back.data?.user?.emailVerified === true, back.data);
    if (made.data?.token) await req('DELETE', '/api/me', { token: made.data.token, body: {} });
  }

  // ---------- an email (code) and a password for the device-only account ----------
  const emailB = `test-b-${RUN}@evenly.test`;
  {
    const r0 = await req('POST', '/api/me/credentials', { token: tokB, body: { email: emailB, password: 'abbie password 1' } });
    check('credentials no longer set an unconfirmed email', r0.status === 400 && r0.data?.error?.code === 'email_unconfirmed', r0.data);
    const st = await req('POST', '/api/me/email/start', { token: tokB, body: { email: emailB } });
    check('add-email start (test mode: devCode)', st.status === 200 && /^[0-9]{6}$/.test(st.data?.devCode || ''), st.data);
    const v = await req('POST', '/api/me/email/verify', { token: tokB, body: { email: emailB, code: st.data?.devCode } });
    check('add-email verify confirms the email', v.status === 200 && v.data?.user?.email === emailB && v.data?.user?.emailVerified === true && v.data?.passwordCleared === false, v.data);
    const r = await req('POST', '/api/me/credentials', { token: tokB, body: { email: emailB, password: 'abbie password 1' } });
    check('a password for the confirmed email', r.status === 200 && r.data?.user?.hasPassword === true && r.data?.user?.email === emailB, r.data);
    const r2 = await req('POST', '/api/me/credentials', { token: tokB, body: { email: emailB, password: 'abbie password 2' } });
    check('change password needs currentPassword', r2.status === 401 || r2.status === 400, r2.data);
    const r3 = await req('POST', '/api/me/credentials', { token: tokB, body: { email: emailB, password: 'abbie password 2', currentPassword: 'abbie password 1' } });
    check('change password with currentPassword', r3.status === 200, r3.data);
    const r4 = await req('POST', '/api/me/email/start', { token: tokC, body: { email: emailA } });
    check('cannot take an existing email', r4.status === 409 && r4.data?.error?.code === 'email_taken', r4.data);
    const r5 = await req('POST', '/api/me/credentials', { token: tokC, body: { email: emailA, password: 'stranger password' } });
    check('nor through credentials', r5.status === 400 && r5.data?.error?.code === 'email_unconfirmed', r5.data);
    const l = await req('POST', '/api/auth/login', { body: { email: emailB, password: 'abbie password 2' } });
    check('login with new password', l.status === 200, l.data);
  }

  // ---------- device link code ----------
  {
    const lc = await req('POST', '/api/auth/link-code', { token: tokB, body: {} });
    check('link-code', lc.status === 200 && /^[2-9A-HJ-NP-Z]{8}$/.test(lc.data?.code || ''), lc.data);
    const code = lc.data?.code || '';
    const fmt = code.slice(0, 4).toLowerCase() + '-' + code.slice(4).toLowerCase();
    const use = await req('POST', '/api/auth/link', { body: { code: fmt } });
    check('link with formatted lowercase code', use.status === 200 && use.data?.user?.email === emailB, use.data);
    const again = await req('POST', '/api/auth/link', { body: { code } });
    check('link code is single use', again.status === 400 && again.data?.error?.code === 'code_invalid', again.data);
  }

  // ---------- groups ----------
  const gid = uuid();
  let snap;
  {
    const r = await req('POST', '/api/groups', { token: tokA, body: { id: gid, name: 'test-Niseko 滑雪 2026', type: 'trip', currency: 'JPY', emoji: '⛷️', members: [{ name: 'Kevin' }, { name: 'Tiffany' }, { name: 'test-Abbie', email: emailB }] } });
    check('create group', r.status === 200 && r.data?.group?.id === gid && r.data?.members?.length === 4, r.data);
    snap = r.data;
    const meM = snap?.members?.find(m => m.userId === userA.id);
    check('creator is admin member', meM?.role === 'admin' && snap?.me?.memberId === meM?.id, snap?.me);
    const linked = snap?.members?.find(m => m.name === 'test-Abbie');
    check('email of existing account links the member', !!linked?.userId, linked);
    check('invite code present', typeof snap?.inviteCode === 'string' && snap.inviteCode.length >= 12, snap?.inviteCode);
  }
  const M = Object.fromEntries((snap?.members || []).map(m => [m.name, m.id]));
  const meA = snap?.me?.memberId;
  const mAbbie = M['test-Abbie'];
  const mKevin = M['Kevin'];
  const mTiffany = M['Tiffany'];

  {
    const r = await req('GET', '/api/groups/' + gid, { token: tokC });
    check('non-member gets 404', r.status === 404 && r.data?.error?.code === 'not_found', r.data);
    const r2 = await req('GET', '/api/groups/' + gid, { token: tokB });
    check('linked member (Abbie) can read', r2.status === 200, r2.status);
    const etag = r2.headers.get('etag');
    check('ETag header', !!etag, etag);
    const r3 = await req('GET', '/api/groups/' + gid, { token: tokB, headers: { 'If-None-Match': etag } });
    check('If-None-Match -> 304', r3.status === 304, r3.status);
  }

  // ---------- expenses ----------
  const e1 = uuid();
  {
    const body = { kind: 'expense', description: '燒肉晚餐', category: 'food.dining', amount: 12600, currency: 'JPY', fxRate: 1, date: today, payers: [{ memberId: meA, amount: 12600 }], split: { method: 'equal', entries: [meA, mAbbie, mKevin, mTiffany].map(memberId => ({ memberId })) } };
    const r = await req('PUT', `/api/groups/${gid}/expenses/${e1}`, { token: tokA, body });
    check('create expense', r.status === 200 && r.data?.expense?.id === e1, r.data);
    check('server computed equal shares', JSON.stringify(r.data?.expense?.shares?.map(s => s.amount)) === JSON.stringify([3150, 3150, 3150, 3150]), r.data?.expense?.shares);
    const again = await req('PUT', `/api/groups/${gid}/expenses/${e1}`, { token: tokA, body });
    check('upsert is idempotent (same id updates)', again.status === 200 && again.data?.expense?.version === 2, again.data?.expense?.version);
    const forged = await req('PUT', `/api/groups/${gid}/expenses/${uuid()}`, { token: tokA, body: { ...body, split: { method: 'exact', entries: [{ memberId: meA, value: 1 }] } } });
    check('exact split not summing -> validation', forged.status === 400 && forged.data?.error?.code === 'validation', forged.data);
    const badPayer = await req('PUT', `/api/groups/${gid}/expenses/${uuid()}`, { token: tokA, body: { ...body, payers: [{ memberId: meA, amount: 100 }] } });
    check('payers not summing -> validation', badPayer.status === 400, badPayer.data);
    const foreignMember = await req('PUT', `/api/groups/${gid}/expenses/${uuid()}`, { token: tokA, body: { ...body, payers: [{ memberId: uuid(), amount: 12600 }] } });
    check('unknown member id -> validation', foreignMember.status === 400, foreignMember.data);
    const fx = await req('PUT', `/api/groups/${gid}/expenses/${uuid()}`, { token: tokA, body: { ...body, fxRate: 2 } });
    check('fxRate forced to 1 for group currency', fx.status === 200 && fx.data?.expense?.fxRate === 1, fx.data?.expense?.fxRate);
    const stranger = await req('PUT', `/api/groups/${gid}/expenses/${uuid()}`, { token: tokC, body });
    check('non-member cannot write', stranger.status === 404, stranger.status);
    const noDesc = await req('PUT', `/api/groups/${gid}/expenses/${uuid()}`, { token: tokA, body: { ...body, description: '   ' } });
    check('expense needs a description', noDesc.status === 400, noDesc.data);
    const badDate = await req('PUT', `/api/groups/${gid}/expenses/${uuid()}`, { token: tokA, body: { ...body, date: '2026-02-30' } });
    check('invalid date -> validation', badDate.status === 400, badDate.data);
    if (fx.data?.expense?.id) await req('DELETE', `/api/groups/${gid}/expenses/${fx.data.expense.id}`, { token: tokA });
  }

  // foreign currency entry: TWD 2400 at 4.75 JPY per TWD
  const e2 = uuid();
  {
    const r = await req('PUT', `/api/groups/${gid}/expenses/${e2}`, { token: tokB, body: { kind: 'expense', description: '機場接送', category: 'transport.car', amount: 2400, currency: 'TWD', fxRate: 4.75, date: today, payers: [{ memberId: mAbbie, amount: 2400 }], split: { method: 'shares', entries: [{ memberId: meA, value: 1 }, { memberId: mAbbie, value: 2 }, { memberId: mKevin, value: 1 }] } } });
    check('foreign-currency expense by another member', r.status === 200 && r.data?.expense?.fxRate === 4.75, r.data);
    check('shares split 600/1200/600', JSON.stringify(r.data?.expense?.shares?.map(s => s.amount)) === JSON.stringify([600, 1200, 600]), r.data?.expense?.shares);
  }

  // items split with tax: 2 items + 10% service
  const e3 = uuid();
  {
    const r = await req('PUT', `/api/groups/${gid}/expenses/${e3}`, { token: tokA, body: { kind: 'expense', description: '居酒屋', category: 'food.dining', amount: 11000, currency: 'JPY', fxRate: 1, date: today, payers: [{ memberId: mKevin, amount: 11000 }], split: { method: 'items', entries: [], items: [{ id: 'i1', name: '生啤', amount: 4000, memberIds: [meA, mKevin] }, { id: 'i2', name: '串燒', amount: 6000, memberIds: [meA, mKevin, mTiffany] }] } } });
    check('items split', r.status === 200, r.data);
    const sh = Object.fromEntries((r.data?.expense?.shares || []).map(s => [s.memberId, s.amount]));
    check('items shares sum and service spread', sh[meA] + sh[mKevin] + sh[mTiffany] === 11000 && sh[mTiffany] === 2200, sh);
  }

  // payment
  const p1 = uuid();
  {
    const r = await req('PUT', `/api/groups/${gid}/expenses/${p1}`, { token: tokA, body: { kind: 'payment', description: '', category: 'payment', amount: 3150, currency: 'JPY', fxRate: 1, date: today, payers: [{ memberId: mTiffany, amount: 3150 }], split: { method: 'exact', entries: [{ memberId: meA, value: 3150 }] } } });
    check('payment', r.status === 200 && r.data?.expense?.kind === 'payment', r.data);
    const self = await req('PUT', `/api/groups/${gid}/expenses/${uuid()}`, { token: tokA, body: { kind: 'payment', description: '', category: 'payment', amount: 100, currency: 'JPY', fxRate: 1, date: today, payers: [{ memberId: meA, amount: 100 }], split: { method: 'exact', entries: [{ memberId: meA, value: 100 }] } } });
    check('payment to self rejected', self.status === 400, self.data);
  }

  // balances via /me
  {
    const r = await req('GET', '/api/me', { token: tokA });
    const g = r.data?.groups?.find(x => x.id === gid);
    // A: paid 12600, owes 3150 + 2400TWD*4.75*(1/4)=2850 + items share; received 3150 from Tiffany.
    check('group in /me with myNet', !!g && typeof g.myNet === 'number', g);
    const snapR = await req('GET', '/api/groups/' + gid, { token: tokA });
    check('snapshot has 4 entries', snapR.data?.expenses?.filter(e => !e.deletedAt).length === 4, snapR.data?.expenses?.length);
    const friendsOk = (r.data?.friends || []).some(f => f.userId && f.name.includes('Abbie'));
    check('friends include Abbie by account', friendsOk, r.data?.friends);
    const tot = r.data?.totals || [];
    check('totals per currency present', Array.isArray(tot) && tot.every(t => typeof t.currency === 'string' && t.owed >= 0 && t.owe >= 0), tot);
  }

  // edit, delete, restore, history
  {
    const r = await req('PUT', `/api/groups/${gid}/expenses/${e1}`, { token: tokB, body: { kind: 'expense', description: '燒肉晚餐（含飲料）', category: 'food.dining', amount: 14000, currency: 'JPY', fxRate: 1, date: today, payers: [{ memberId: meA, amount: 14000 }], split: { method: 'equal', entries: [meA, mAbbie, mKevin, mTiffany].map(memberId => ({ memberId })) } } });
    check('another member edits', r.status === 200 && r.data?.expense?.amount === 14000, r.data);
    const d = await req('DELETE', `/api/groups/${gid}/expenses/${e1}`, { token: tokA });
    check('soft delete', d.status === 200 && !!d.data?.expense?.deletedAt, d.data);
    const d2 = await req('DELETE', `/api/groups/${gid}/expenses/${e1}`, { token: tokA });
    check('delete is idempotent', d2.status === 200, d2.status);
    const rs = await req('POST', `/api/groups/${gid}/expenses/${e1}/restore`, { token: tokA, body: {} });
    check('restore', rs.status === 200 && rs.data?.expense?.deletedAt === null, rs.data);
    const h = await req('GET', `/api/groups/${gid}/expenses/${e1}/history`, { token: tokA });
    const types = (h.data?.items || []).map(i => i.type);
    check('history shows create, update, delete, restore', ['expense.create', 'expense.update', 'expense.delete', 'expense.restore'].every(tp => types.includes(tp)), types);
  }

  // comments
  {
    const cid = uuid();
    const r = await req('POST', `/api/groups/${gid}/expenses/${e1}/comments`, { token: tokB, body: { id: cid, body: '我晚點轉給你 🙏' } });
    check('add comment', r.status === 200 && r.data?.comment?.id === cid, r.data);
    const r2 = await req('POST', `/api/groups/${gid}/expenses/${e1}/comments`, { token: tokB, body: { id: cid, body: '我晚點轉給你 🙏' } });
    check('comment is idempotent by id', r2.status === 200, r2.data);
    const l = await req('GET', `/api/groups/${gid}/expenses/${e1}/comments`, { token: tokA });
    check('list comments (one)', l.status === 200 && l.data?.comments?.length === 1 && l.data.comments[0].authorName, l.data);
    const del = await req('DELETE', `/api/groups/${gid}/comments/${cid}`, { token: tokA });
    check('only the author deletes a comment', del.status === 403, del.status);
    const del2 = await req('DELETE', `/api/groups/${gid}/comments/${cid}`, { token: tokB });
    check('author deletes comment', del2.status === 200, del2.data);
    const snapR = await req('GET', '/api/groups/' + gid, { token: tokA });
    check('commentCount back to 0', snapR.data?.expenses?.find(e => e.id === e1)?.commentCount === 0, snapR.data?.expenses?.find(e => e.id === e1)?.commentCount);
  }

  // recurring: weekly starting 15 days ago -> copies for -8 and -1 days
  {
    const rid = uuid();
    const r = await req('PUT', `/api/groups/${gid}/expenses/${rid}`, { token: tokA, body: { kind: 'expense', description: '每週清潔費', category: 'utilities.cleaning', amount: 4000, currency: 'JPY', fxRate: 1, date: daysAgo(15), repeat: 'weekly', payers: [{ memberId: meA, amount: 4000 }], split: { method: 'equal', entries: [{ memberId: meA }, { memberId: mAbbie }] } } });
    check('recurring expense created', r.status === 200 && r.data?.expense?.repeat === 'weekly', r.data);
    const s = await req('GET', '/api/groups/' + gid, { token: tokA });
    const copies = (s.data?.expenses || []).filter(e => e.description === '每週清潔費' && !e.deletedAt);
    check('recurring copies materialized (3 in total)', copies.length === 3, copies.map(x => x.date));
    check('only the newest carries the repeat flag', copies.filter(x => x.repeat === 'weekly').length === 1 && copies.find(x => x.repeat === 'weekly')?.date === daysAgo(1), copies.map(x => [x.date, x.repeat]));
    const s2 = await req('GET', '/api/groups/' + gid, { token: tokB });
    const copies2 = (s2.data?.expenses || []).filter(e => e.description === '每週清潔費' && !e.deletedAt);
    check('no duplicate copies on a second read', copies2.length === 3, copies2.length);
  }

  // ---------- members, invite, join, claim ----------
  {
    const add = await req('POST', `/api/groups/${gid}/members`, { token: tokB, body: { name: 'Leo' } });
    check('member adds a placeholder', add.status === 200 && add.data?.member?.name === 'Leo', add.data);
    const mLeo = add.data?.member?.id;
    const role = await req('PATCH', `/api/groups/${gid}/members/${mLeo}`, { token: tokB, body: { role: 'admin' } });
    check('non-admin cannot change roles', role.status === 403, role.status);
    const info = await req('GET', '/api/join/' + snap.inviteCode);
    check('join info without sign-in', info.status === 200 && info.data?.group?.id === gid && info.data?.members?.some(m => m.name === 'Leo' && !m.claimed), info.data);
    const badInfo = await req('GET', '/api/join/notarealcode123');
    check('unknown invite -> 404', badInfo.status === 404, badInfo.status);
    const join = await req('POST', '/api/join/' + snap.inviteCode, { token: tokC, body: { memberId: mLeo } });
    check('stranger joins by claiming Leo', join.status === 200 && join.data?.memberId === mLeo, join.data);
    const again = await req('POST', '/api/join/' + snap.inviteCode, { token: tokC, body: { name: 'dup' } });
    check('joining again returns the same member', again.status === 200 && again.data?.memberId === mLeo, again.data);
    const steal = await req('POST', '/api/join/' + snap.inviteCode, { token: tokB, body: { memberId: mLeo } });
    check('cannot claim an already claimed member', steal.status === 200 ? steal.data?.memberId === mAbbie : steal.status === 409, steal.data);
    const cl = await req('POST', `/api/groups/${gid}/members/${mTiffany}/claim-link`, { token: tokB, body: {} });
    check('claim link for a placeholder', cl.status === 200 && cl.data?.token && cl.data?.url?.includes('#/claim/'), cl.data);
    const ci = await req('GET', '/api/claim/' + cl.data?.token);
    check('claim info', ci.status === 200 && ci.data?.member?.id === mTiffany, ci.data);
    const t = await req('POST', '/api/auth/signup', { body: { name: 'test-Tiffany' } });
    const tokT = t.data?.token;
    const claim = await req('POST', '/api/claim/' + cl.data?.token, { token: tokT, body: {} });
    check('claim Tiffany', claim.status === 200 && claim.data?.memberId === mTiffany, claim.data);
    const reuse = await req('GET', '/api/claim/' + cl.data?.token);
    check('claim link single use', reuse.status === 400, reuse.status);
    const tiffSnap = await req('GET', '/api/groups/' + gid, { token: tokT });
    check('Tiffany now reads the group', tiffSnap.status === 200 && tiffSnap.data?.me?.memberId === mTiffany, tiffSnap.data?.me);
    const leaveBad = await req('DELETE', `/api/groups/${gid}/members/${mTiffany}`, { token: tokT });
    check('cannot leave with a balance', leaveBad.status === 409 || leaveBad.status === 400, leaveBad.data);
    check('balance_not_zero code', leaveBad.data?.error?.code === 'balance_not_zero', leaveBad.data);
    const reset = await req('POST', `/api/groups/${gid}/invite/reset`, { token: tokB, body: {} });
    check('only admins reset the invite', reset.status === 403, reset.status);
    const reset2 = await req('POST', `/api/groups/${gid}/invite/reset`, { token: tokA, body: {} });
    check('admin resets invite', reset2.status === 200 && reset2.data?.inviteCode && reset2.data.inviteCode !== snap.inviteCode, reset2.data);
    const oldInfo = await req('GET', '/api/join/' + snap.inviteCode);
    check('old invite stops working', oldInfo.status === 404, oldInfo.status);
  }

  // ---------- group settings ----------
  {
    const r = await req('PATCH', '/api/groups/' + gid, { token: tokB, body: { name: 'test-Niseko 2026', simplify: false, notes: '住宿：Niseko Landmark View' } });
    check('member edits name, simplify, notes', r.status === 200 && r.data?.group?.simplify === false && r.data?.group?.name === 'test-Niseko 2026', r.data?.group);
    const me = await req('GET', '/api/me', { token: tokA });
    const g = me.data?.groups?.find(x => x.id === gid);
    check('pairwise transfers when simplify is off', Array.isArray(g?.myTransfers), g?.myTransfers);
    const cur = await req('PATCH', '/api/groups/' + gid, { token: tokA, body: { currency: 'TWD' } });
    check('change group currency to TWD', cur.status === 200 && cur.data?.group?.currency === 'TWD', cur.data?.error || cur.data?.group);
    const airport = cur.data?.expenses?.find(e => e.id === e2);
    check('TWD entry fxRate becomes 1', airport?.fxRate === 1, airport?.fxRate);
    const dinner = cur.data?.expenses?.find(e => e.id === e1);
    check('JPY entry got a JPY->TWD rate', dinner && dinner.fxRate > 0.1 && dinner.fxRate < 0.5, dinner?.fxRate);
  }

  // ---------- default split (群組預設分法) ----------
  {
    const rent = { method: 'percent', entries: [{ memberId: meA, value: 60 }, { memberId: mAbbie, value: 40 }], payerId: mAbbie };
    const r = await req('PATCH', '/api/groups/' + gid, { token: tokB, body: { defaultSplit: rent } });
    const d = r.data?.group?.defaultSplit;
    check('any member sets the default split (setAt added)', r.status === 200 && d?.method === 'percent' && d?.entries?.length === 2 && d?.payerId === mAbbie && typeof d?.setAt === 'string', r.data?.error || d);
    const seen = await req('GET', '/api/groups/' + gid, { token: tokA });
    check('everyone sees it in the snapshot', JSON.stringify(seen.data?.group?.defaultSplit) === JSON.stringify(d), seen.data?.group?.defaultSplit);
    const short = await req('PATCH', '/api/groups/' + gid, { token: tokA, body: { defaultSplit: { method: 'percent', entries: [{ memberId: meA, value: 60 }] } } });
    check('a default that does not add up -> 400 default_split percent_mismatch', short.status === 400 && short.data?.error?.details?.code === 'default_split' && short.data?.error?.details?.reason === 'percent_mismatch', short.data);
    const exact = await req('PATCH', '/api/groups/' + gid, { token: tokA, body: { defaultSplit: { method: 'exact', entries: [{ memberId: meA, value: 100 }] } } });
    check('amounts cannot be a default -> 400', exact.status === 400, exact.data);
    const other = await req('PATCH', '/api/groups/' + gid, { token: tokA, body: { notes: '住宿：Niseko Landmark View（含早餐）' } });
    check('saving other settings keeps it (older apps send no defaultSplit)', JSON.stringify(other.data?.group?.defaultSplit) === JSON.stringify(d), other.data?.group?.defaultSplit);
    const hist = await req('GET', '/api/activity?limit=10', { token: tokA });
    const row = (hist.data?.items || []).find(i => i.type === 'group.update' && (i.data?.changes || []).some(c => c.field === 'defaultSplit'));
    check('the change is in the feed with the new default', !!row && row.data?.defaultSplit?.method === 'percent' && row.data.changes[0].to === 'test-Gino 60%, test-Abbie 40%', row);
    const clr = await req('PATCH', '/api/groups/' + gid, { token: tokA, body: { defaultSplit: null } });
    check('null clears it', clr.status === 200 && clr.data?.group?.defaultSplit === null, clr.data?.group?.defaultSplit);
  }

  // ---------- friends ----------
  {
    const f = await req('POST', '/api/friends', { token: tokA, body: { name: 'test-Abbie', email: emailB } });
    check('add friend by email -> pair group', f.status === 200 && f.data?.groupId, f.data);
    const f2 = await req('POST', '/api/friends', { token: tokA, body: { name: 'test-Abbie', email: emailB } });
    check('adding the same friend reuses the pair group', f2.data?.groupId === f.data?.groupId, [f.data, f2.data]);
    const pair = await req('GET', '/api/groups/' + f.data?.groupId, { token: tokB });
    check('friend sees the pair group', pair.status === 200 && pair.data?.group?.type === 'pair', pair.data?.group);
    const f3 = await req('POST', '/api/friends', { token: tokA, body: { name: 'Placeholder Pal' } });
    check('add friend without account', f3.status === 200, f3.data);
    const me = await req('GET', '/api/me', { token: tokA });
    const friend = me.data?.friends?.find(x => x.userId === b.data?.user?.id);
    check('friend has pairGroupId', friend?.pairGroupId === f.data?.groupId, friend);
  }

  // ---------- archive (封存群組; the group is in TWD since the settings check) ----------
  {
    const listed = async tok => (await req('GET', '/api/me', { token: tok })).data;
    const before = await listed(tokA);
    check('a group starts on my lists (archived false)', before?.groups?.find(x => x.id === gid)?.archived === false, before?.groups?.find(x => x.id === gid));
    const v0 = (await req('GET', '/api/groups/' + gid, { token: tokA })).data?.group?.version;
    const r = await req('PUT', `/api/groups/${gid}/archive`, { token: tokA, body: { archived: true } });
    check('PUT archive -> {archived: true}', r.status === 200 && r.data?.archived === true, r.data);
    const after = await listed(tokA);
    check('GET /me says archived for me, and the totals still count it', after?.groups?.find(x => x.id === gid)?.archived === true && JSON.stringify(after?.totals) === JSON.stringify(before?.totals), [after?.totals, before?.totals]);
    check('the others see no change', (await listed(tokB))?.groups?.find(x => x.id === gid)?.archived === false);
    const v1 = (await req('GET', '/api/groups/' + gid, { token: tokA })).data?.group?.version;
    check('archiving bumps no group version', typeof v0 === 'number' && v1 === v0, [v0, v1]);
    const body = payer => ({ kind: 'expense', description: 'test-archive', category: 'general', amount: 300, currency: 'TWD', fxRate: 1, date: today, payers: [{ memberId: payer, amount: 300 }], split: { method: 'equal', entries: [{ memberId: meA }, { memberId: mAbbie }] } });
    const mine = uuid();
    await req('PUT', `/api/groups/${gid}/expenses/${mine}`, { token: tokA, body: body(meA) });
    check('my own entry leaves it archived', (await listed(tokA))?.groups?.find(x => x.id === gid)?.archived === true);
    const theirs = uuid();
    const add = await req('PUT', `/api/groups/${gid}/expenses/${theirs}`, { token: tokB, body: body(mAbbie) });
    check("someone else's new entry brings it back", add.status === 200 && (await listed(tokA))?.groups?.find(x => x.id === gid)?.archived === false, add.data);
    await req('PUT', `/api/groups/${gid}/archive`, { token: tokA, body: { archived: true } });
    const un = await req('PUT', `/api/groups/${gid}/archive`, { token: tokA, body: { archived: false } });
    check('取消封存 -> {archived: false}', un.status === 200 && un.data?.archived === false && (await listed(tokA))?.groups?.find(x => x.id === gid)?.archived === false, un.data);
    const bad = await req('PUT', `/api/groups/${gid}/archive`, { token: tokA, body: { archived: 'yes' } });
    check('archive without a boolean -> 400 validation', bad.status === 400 && bad.data?.error?.code === 'validation', bad.data);
    for (const id of [mine, theirs]) await req('DELETE', `/api/groups/${gid}/expenses/${id}`, { token: tokA });
  }

  // ---------- activity ----------
  {
    const r = await req('GET', '/api/activity', { token: tokA });
    check('activity feed', r.status === 200 && r.data?.items?.length > 5, r.data?.items?.length);
    const first = r.data?.items?.[0];
    check('activity item shape', !!first?.groupName && !!first?.type && !!first?.actorName, first);
    const paged = await req('GET', '/api/activity?limit=2', { token: tokA });
    check('activity paging', paged.data?.items?.length === 2 && !!paged.data?.next, paged.data);
    const next = await req('GET', '/api/activity?limit=2&before=' + encodeURIComponent(paged.data?.next || ''), { token: tokA });
    check('activity next page differs', next.data?.items?.[0]?.id !== paged.data?.items?.[0]?.id, next.data);
    const meBefore = await req('GET', '/api/me', { token: tokB });
    check('unread count for Abbie', meBefore.data?.unread > 0, meBefore.data?.unread);
    await req('POST', '/api/activity/seen', { token: tokB, body: {} });
    const meAfter = await req('GET', '/api/me', { token: tokB });
    check('seen clears unread', meAfter.data?.unread === 0, meAfter.data?.unread);
    const others = await req('GET', '/api/activity', { token: tokC });
    check('activity only from my groups', (others.data?.items || []).every(i => i.groupId === gid), (others.data?.items || []).map(i => i.groupId));
  }

  // ---------- friend invite links ----------
  {
    const inv = await req('GET', '/api/me/invite', { token: tokA });
    const code = inv.data?.code;
    check('my invite link: a code made on the first ask, the share URL, three messages', inv.status === 200 && /^[A-Za-z0-9]{16}$/.test(code || '') && inv.data?.url === `${BASE}/i/${code}?openExternalBrowser=1` && inv.data?.templates?.map(t => t.key).join() === 'everyday,trip,roommates' && inv.data.templates[0].label === '日常', inv.data);
    const again = await req('GET', '/api/me/invite?locale=en', { token: tokA });
    check('the same code again, the messages in ?locale=en', again.data?.code === code && again.data?.templates?.[0]?.label === 'Everyday', again.data);
    const anon = await req('GET', '/api/invite/' + code);
    check('anyone sees who sent it: name, color, photo version, no email', anon.status === 200 && anon.data?.inviter?.name === 'test-Gino' && typeof anon.data.inviter.color === 'string' && anon.data.inviter.avatar === null && anon.data.self === false && anon.data.groupId === null && !JSON.stringify(anon.data).includes(emailA), anon.data);
    const self = await req('GET', '/api/invite/' + code, { token: tokA });
    check('my own link says self', self.data?.self === true && self.data?.groupId === null, self.data);
    const own = await req('POST', '/api/invite/' + code, { token: tokA, body: {} });
    check('accepting my own link -> 400 own_invite', own.status === 400 && own.data?.error?.code === 'own_invite', own.data);
    const pairAB = (await req('GET', '/api/me', { token: tokA })).data?.friends?.find(x => x.userId === b.data?.user?.id)?.pairGroupId;
    const seenB = await req('GET', '/api/invite/' + code, { token: tokB });
    check('a friend sees our 1:1 ledger', seenB.data?.self === false && !!pairAB && seenB.data?.groupId === pairAB, [seenB.data, pairAB]);
    const accB = await req('POST', '/api/invite/' + code, { token: tokB, body: {} });
    check('already friends: existed, the same ledger', accB.status === 200 && accB.data?.existed === true && accB.data?.groupId === pairAB, accB.data);
    const d = await req('POST', '/api/auth/signup', { body: { name: 'test-Kai', locale: 'zh-TW' } });
    const tokD = d.data?.token;
    const accD = await req('POST', '/api/invite/' + code, { token: tokD, body: {} });
    check('a new friend: a new 1:1 ledger', accD.status === 200 && accD.data?.existed === false && !!accD.data?.groupId && accD.data.groupId !== pairAB, accD.data);
    const pairD = await req('GET', '/api/groups/' + accD.data?.groupId, { token: tokD });
    check('the ledger has both people, both admins, the inviter first', pairD.data?.group?.type === 'pair' && pairD.data?.members?.map(m => `${m.name}:${m.role}:${!!m.userId}`).join() === 'test-Gino:admin:true,test-Kai:admin:true', pairD.data?.members);
    const accD2 = await req('POST', '/api/invite/' + code, { token: tokD, body: {} });
    check('accepting again: existed', accD2.data?.existed === true && accD2.data?.groupId === accD.data?.groupId, accD2.data);
    const feed = await req('GET', '/api/activity', { token: tokA });
    const joined = (feed.data?.items || []).find(i => i.type === 'friend.join' && i.groupId === accD.data?.groupId);
    check("the inviter's activity: test-Kai joined through the link", joined?.actorName === 'test-Kai' && joined?.data?.memberName === 'test-Gino', joined);
    const page = await fetch(inv.data?.url, { headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' } });
    const html = await page.text();
    check('the link\'s page carries the invite\'s preview for crawlers', page.status === 200 && html.includes('<meta property="og:title" content="test-Gino 邀請你一起用吉諾分帳所分帳" />') && html.includes(`<meta property="og:url" content="${inv.data?.url}" />`) && html.includes(`<meta property="og:image" content="${BASE}/og-image.png" />`) && html.includes('id="root"') && !html.includes(emailA), page.status);
    const photo = await req('GET', `/api/invite/${code}/avatar`);
    check('no photo: the invite photo is 404', photo.status === 404, photo.status);
    const bad = await req('GET', '/api/invite/NoSuchCode123456');
    check('a code nobody has -> 400 code_invalid', bad.status === 400 && bad.data?.error?.code === 'code_invalid', bad.data);
    const reset = await req('POST', '/api/me/invite/reset', { token: tokA, body: {} });
    const old = await req('GET', '/api/invite/' + code);
    const oldPost = await req('POST', '/api/invite/' + code, { token: tokC, body: {} });
    check('a reset: a new code, and the old one fails at once', reset.status === 200 && /^[A-Za-z0-9]{16}$/.test(reset.data?.code || '') && reset.data.code !== code && old.status === 400 && old.data?.error?.code === 'code_invalid' && oldPost.data?.error?.code === 'code_invalid', [reset.data?.code, old.data, oldPost.data]);
    const fresh = await req('GET', '/api/invite/' + reset.data?.code, { token: tokD });
    check('the new code works, and friends stay friends', fresh.status === 200 && fresh.data?.groupId === accD.data?.groupId, fresh.data);
    await req('DELETE', '/api/groups/' + accD.data?.groupId, { token: tokD });
    await req('DELETE', '/api/me', { token: tokD, body: {} });
  }

  // ---------- fx ----------
  {
    const r = await req('GET', '/api/fx?base=TWD&date=' + today);
    check('fx TWD base', r.status === 200 && r.data?.base === 'TWD' && r.data?.rates?.TWD === 1 && r.data?.rates?.USD > 20 && r.data?.rates?.JPY > 0.1, r.data && { date: r.data.date, USD: r.data.rates?.USD, JPY: r.data.rates?.JPY, src: r.data.source });
    const old = await req('GET', '/api/fx?base=USD&date=2024-03-15');
    check('fx historical date', old.status === 200 && old.data?.rates?.EUR > 1 && old.data?.rates?.EUR < 1.3, old.data && { date: old.data.date, EUR: old.data.rates?.EUR });
    const bad = await req('GET', '/api/fx?base=usd');
    check('fx bad base -> 400', bad.status === 400, bad.status);
  }

  // ---------- import ----------
  {
    const list = Array.from({ length: 3 }, (_, i) => ({ id: uuid(), kind: 'expense', description: 'import ' + i, category: 'general', amount: 1000 + i, currency: 'TWD', fxRate: 1, date: daysAgo(30 + i), payers: [{ memberId: meA, amount: 1000 + i }], split: { method: 'equal', entries: [{ memberId: meA }, { memberId: mAbbie }] } }));
    list.push({ ...list[0], id: uuid(), amount: -5 });
    const r = await req('POST', `/api/groups/${gid}/import`, { token: tokA, body: { expenses: list } });
    check('import 3 valid, skip 1', r.status === 200 && r.data?.imported === 3 && r.data?.skipped?.length === 1, r.data);
  }

  // ---------- owner tools ----------
  if (OWNER_EMAIL && OWNER_PW) {
    // The owner account: its password from an earlier run, else made now with a code (test mode)
    // and given that password.
    let o = await req('POST', '/api/auth/login', { body: { email: OWNER_EMAIL, password: OWNER_PW } });
    if (o.status !== 200) {
      const so = await req('POST', '/api/auth/email/start', { body: { email: OWNER_EMAIL } });
      const vo = await req('POST', '/api/auth/email/verify', { body: { email: OWNER_EMAIL, code: so.data?.devCode, name: 'test-Owner' } });
      if (vo.data?.token) await req('POST', '/api/me/credentials', { token: vo.data.token, body: { email: OWNER_EMAIL, password: OWNER_PW } });
      o = await req('POST', '/api/auth/login', { body: { email: OWNER_EMAIL, password: OWNER_PW } });
    }
    const tokO = o.data?.token;
    check('owner login', o.status === 200 && o.data?.user?.isAdmin === true, o.data?.user);
    const st = await req('GET', '/api/admin/stats', { token: tokO });
    check('admin stats', st.status === 200 && st.data?.users > 0, st.data);
    const rl = await req('POST', '/api/admin/reset-link', { token: tokO, body: { email: emailB } });
    check('admin reset link', rl.status === 200 && rl.data?.url?.includes('#/reset/'), rl.data);
    const token = (rl.data?.url || '').split('#/reset/')[1];
    const rs = await req('POST', '/api/auth/reset', { body: { token, password: 'abbie password 3' } });
    check('reset password with link', rs.status === 200 && rs.data?.token, rs.data);
    const oldTok = await req('GET', '/api/me', { token: tokB });
    check('reset revokes old sessions', oldTok.status === 401, oldTok.status);
    const nonOwner = await req('GET', '/api/admin/stats', { token: tokA });
    check('non-owner admin -> 404', nonOwner.status === 404, nonOwner.status);

    // who signed up: the list, search, paging and one account's detail
    const list = await req('GET', '/api/admin/users', { token: tokO });
    const st2 = list.data?.stats;
    const statKeys = ['users', 'newLast7', 'activeLast7', 'withEmail', 'withPassword', 'deviceOnly', 'groups', 'entries'];
    check('admin users list', list.status === 200 && Array.isArray(list.data?.users) && typeof list.data?.total === 'number' && list.data.users.length <= 50, list.data && { total: list.data.total, n: list.data.users?.length });
    check('admin users stats', !!st2 && statKeys.every(k => Number.isInteger(st2[k]) && st2[k] >= 0) && st2.withEmail + st2.deviceOnly === st2.users && st2.withPassword <= st2.withEmail && st2.users === list.data.total && st2.newLast7 >= 3, st2);
    const created = (list.data?.users || []).map(u => u.createdAt);
    check('admin users newest first', created.every((t, i) => i === 0 || created[i - 1] >= t), created.slice(0, 5));
    const rowKeys = ['id', 'name', 'email', 'emailVerified', 'hasPassword', 'locale', 'currency', 'color', 'createdAt', 'lastActiveAt', 'sessions', 'devices', 'groups', 'entries', 'lastEntryAt', 'isOwner'];
    check('admin users row shape', !!list.data?.users?.[0] && rowKeys.every(k => k in list.data.users[0]) && Array.isArray(list.data.users[0].devices), list.data?.users?.[0]);
    const ownerFound = await req('GET', '/api/admin/users?q=' + encodeURIComponent(OWNER_EMAIL), { token: tokO });
    const ownerRow = (ownerFound.data?.users || []).find(u => u.email === OWNER_EMAIL.toLowerCase());
    check('admin users marks the owner', ownerRow?.isOwner === true && ownerRow?.hasPassword === true, ownerRow);
    const found = await req('GET', '/api/admin/users?q=' + encodeURIComponent(emailA.toUpperCase()), { token: tokO });
    const rowA = found.data?.users?.[0];
    check('admin users search by email, any case', found.status === 200 && found.data?.total === 1 && rowA?.id === userA.id && found.data?.stats?.users === st2?.users, found.data && { total: found.data.total, ids: found.data.users?.map(u => u.id) });
    check('admin users row counts', rowA?.hasPassword === true && rowA?.groups >= 1 && rowA?.entries >= 3 && rowA?.sessions >= 1 && !!rowA?.lastActiveAt && !!rowA?.lastEntryAt && rowA?.isOwner === false, rowA);
    const byName = await req('GET', '/api/admin/users?q=' + encodeURIComponent('TEST-GINO') + '&limit=100', { token: tokO });
    check('admin users search by name', byName.status === 200 && byName.data?.users?.some(u => u.id === userA.id), byName.data?.total);
    const none = await req('GET', '/api/admin/users?q=' + encodeURIComponent('%_no such person ' + RUN), { token: tokO });
    check('admin users search takes % and _ literally', none.status === 200 && none.data?.total === 0 && none.data?.users?.length === 0, none.data?.total);
    const p1 = await req('GET', '/api/admin/users?limit=1', { token: tokO });
    const p2 = await req('GET', '/api/admin/users?limit=1&offset=1', { token: tokO });
    check('admin users paging', p1.data?.users?.length === 1 && p2.data?.users?.length === 1 && p1.data.users[0].id !== p2.data.users[0].id, [p1.data?.users?.[0]?.id, p2.data?.users?.[0]?.id]);
    const capped = await req('GET', '/api/admin/users?limit=1000', { token: tokO });
    check('admin users limit capped at 100', capped.status === 200 && capped.data?.users?.length <= 100, capped.data?.users?.length);
    const det = await req('GET', '/api/admin/users/' + encodeURIComponent(userA.id), { token: tokO });
    const dg = (det.data?.groups || []).find(g => g.id === gid);
    check('admin user detail', det.status === 200 && det.data?.user?.id === userA.id && det.data.user.email === emailA && typeof det.data.user.venmo === 'string' && typeof det.data.user.payInfo === 'string', det.data?.user);
    check('admin user detail groups', !!dg && dg.role === 'admin' && dg.active === true && dg.deleted === false && dg.memberCount >= 4 && dg.entries >= 3 && !!dg.lastDate, dg);
    check('admin user detail sessions', Array.isArray(det.data?.sessions) && det.data.sessions.length >= 1 && det.data.sessions.every(s => Object.keys(s).sort().join() === 'createdAt,expiresAt,label,lastUsedAt'), det.data?.sessions?.[0]);
    const acts = det.data?.activity || [];
    check('admin user detail activity', acts.length >= 1 && acts.length <= 20 && acts.every(x => x.userId === userA.id && !!x.type && !!x.groupName), acts.length);
    const leaked = JSON.stringify([list.data, found.data, det.data]);
    check('admin users never send hashes or tokens', !/pbkdf2|pw_hash|pwHash/i.test(leaked) && !leaked.includes(tokA) && !leaked.includes(tokO), leaked.length);
    const missing = await req('GET', '/api/admin/users/' + uuid(), { token: tokO });
    check('admin user detail unknown -> 404', missing.status === 404, missing.status);
    const nonOwnerList = await req('GET', '/api/admin/users', { token: tokA });
    const nonOwnerDetail = await req('GET', '/api/admin/users/' + encodeURIComponent(userA.id), { token: tokA });
    check('non-owner admin users -> 404', nonOwnerList.status === 404 && nonOwnerDetail.status === 404, [nonOwnerList.status, nonOwnerDetail.status]);
  } else {
    const nonOwner = await req('GET', '/api/admin/stats', { token: tokA });
    check('non-owner admin -> 404', nonOwner.status === 404, nonOwner.status);
    const nonOwnerList = await req('GET', '/api/admin/users', { token: tokA });
    check('non-owner admin users -> 404', nonOwnerList.status === 404, nonOwnerList.status);
    console.log('  (owner checks skipped: pass owner email and password to run them)');
  }

  // ---------- misc ----------
  {
    const big = await req('PUT', `/api/groups/${gid}/expenses/${uuid()}`, { token: tokA, body: { kind: 'expense', description: 'x'.repeat(300000), category: 'general', amount: 1, currency: 'TWD', fxRate: 1, date: today, payers: [{ memberId: meA, amount: 1 }], split: { method: 'equal', entries: [{ memberId: meA }] } } });
    check('oversized body -> 413', big.status === 413, big.status);
    const nf = await req('GET', '/api/nope', { token: tokA });
    check('unknown route -> 404 json', nf.status === 404 && nf.data?.error?.code === 'not_found', nf.data);
    const exp = await req('GET', '/api/me/export', { token: tokA });
    check('export my data', exp.status === 200 && Array.isArray(exp.data?.groups) && exp.data.groups.length >= 1, exp.status);
  }

  // ---------- delete account ----------
  {
    const del = await req('DELETE', '/api/me', { token: tokC, body: {} });
    check('delete device-only account', del.status === 200, del.data);
    const after = await req('GET', '/api/me', { token: tokC });
    check('deleted account token invalid', after.status === 401, after.status);
    const s = await req('GET', '/api/groups/' + gid, { token: tokA });
    const leo = s.data?.members?.find(m => m.name === 'Leo');
    check('their member becomes a placeholder', leo && leo.userId === null, leo);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('Failed:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(2);
});
