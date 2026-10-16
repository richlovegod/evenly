// End-to-end API contract test against a deployed Worker (staging).
// Usage: node tests/api/api-test.mjs https://evenly-api-staging.richlovegod.workers.dev [ownerEmail ownerPassword]
// Creates throwaway accounts (names start with "test-"), checks every endpoint in docs/SPEC.md,
// and prints a pass/fail line per check. Exit code 1 when anything failed.

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

  // ---------- signup ----------
  const emailA = `test-a-${RUN}@evenly.test`;
  const pwA = 'correct horse ' + RUN;
  const a = await req('POST', '/api/auth/signup', { body: { name: 'test-Gino', email: emailA, password: pwA, locale: 'zh-TW' } });
  check('signup with email 200', a.status === 200 && a.data?.token && a.data?.user?.email === emailA, a.data);
  check('signup default currency TWD for zh-TW', a.data?.user?.currency === 'TWD', a.data?.user);
  const tokA = a.data?.token;
  const userA = a.data?.user;

  const b = await req('POST', '/api/auth/signup', { body: { name: 'test-Abbie', locale: 'en' } });
  check('device-only signup 200', b.status === 200 && b.data?.token && b.data?.user?.email === null && b.data?.user?.hasPassword === false, b.data);
  check('signup default currency USD for en', b.data?.user?.currency === 'USD', b.data?.user);
  const tokB = b.data?.token;

  const c = await req('POST', '/api/auth/signup', { body: { name: 'test-Stranger' } });
  const tokC = c.data?.token;
  check('third account', c.status === 200 && !!tokC);

  {
    const r = await req('POST', '/api/auth/signup', { body: { name: 'x', email: emailA, password: 'another password' } });
    check('duplicate email -> email_taken', r.status === 409 && r.data?.error?.code === 'email_taken', r.data);
    const r2 = await req('POST', '/api/auth/signup', { body: { name: 'x', email: `test-x-${RUN}@evenly.test` } });
    check('email without password -> password_required', r2.status === 400 && r2.data?.error?.code === 'password_required', r2.data);
    const r3 = await req('POST', '/api/auth/signup', { body: { name: 'x', email: `test-y-${RUN}@evenly.test`, password: 'short' } });
    check('short password -> weak_password', r3.status === 400 && r3.data?.error?.code === 'weak_password', r3.data);
    const r4 = await req('POST', '/api/auth/signup', { body: { name: '' } });
    check('empty name -> validation', r4.status === 400 && r4.data?.error?.code === 'validation', r4.data);
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

  // ---------- credentials for the device-only account ----------
  const emailB = `test-b-${RUN}@evenly.test`;
  {
    const r = await req('POST', '/api/me/credentials', { token: tokB, body: { email: emailB, password: 'abbie password 1' } });
    check('add email+password to device-only account', r.status === 200 && r.data?.user?.hasPassword === true && r.data?.user?.email === emailB, r.data);
    const r2 = await req('POST', '/api/me/credentials', { token: tokB, body: { email: emailB, password: 'abbie password 2' } });
    check('change password needs currentPassword', r2.status === 401 || r2.status === 400, r2.data);
    const r3 = await req('POST', '/api/me/credentials', { token: tokB, body: { email: emailB, password: 'abbie password 2', currentPassword: 'abbie password 1' } });
    check('change password with currentPassword', r3.status === 200, r3.data);
    const r4 = await req('POST', '/api/me/credentials', { token: tokC, body: { email: emailA, password: 'stranger password' } });
    check('cannot take an existing email', r4.status === 409 && r4.data?.error?.code === 'email_taken', r4.data);
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
    await req('POST', '/api/auth/signup', { body: { name: 'test-Owner', email: OWNER_EMAIL, password: OWNER_PW } });
    const o = await req('POST', '/api/auth/login', { body: { email: OWNER_EMAIL, password: OWNER_PW } });
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
  } else {
    const nonOwner = await req('GET', '/api/admin/stats', { token: tokA });
    check('non-owner admin -> 404', nonOwner.status === 404, nonOwner.status);
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
