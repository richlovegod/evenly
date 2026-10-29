// Push notification API test against a deployed Worker (staging).
// Usage: node tests/api/push-test.mjs https://evenly-api-staging.richlovegod.workers.dev
// Signs up two throwaway accounts (names start with "test-"), checks GET /api/push/status, the
// prefs, the subscription checks (allowed push hosts only, P-256 key, 16-byte auth, time zone),
// storing, moving and deleting a subscription, POST /api/push/test and POST /api/push/run, then
// deletes both accounts. A real browser subscription cannot be made from Node, so the stored one
// uses a generated key pair and a made-up FCM address: the test notification to it reaches FCM,
// which refuses it (no such device), and the check only counts that it was tried. An iPhone with a
// made-up APNs sandbox token gets the test notification too: APNs answers BadDeviceToken, and the
// iPhone must be removed.
// Prints a pass/fail line per check. Exit code 1 when anything failed.

import { webcrypto } from 'node:crypto';

const BASE = (process.argv[2] || 'https://evenly-api-staging.richlovegod.workers.dev').replace(/\/+$/, '');
const RUN = Date.now().toString(36);
const UA = 'evenly-push-test/1.0 (Node)';

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

async function req(method, path, { token, body, headers = {} } = {}) {
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
  return { status: res.status, data, headers: res.headers };
}

const b64url = bytes => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

/** What PushSubscription.toJSON() gives, for a made-up device on an allowed push service. */
async function fakeSubscription(endpoint) {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  return { endpoint, expirationTime: null, keys: { p256dh: b64url(raw), auth: b64url(webcrypto.getRandomValues(new Uint8Array(16))) } };
}

const isValidation = (r, path) =>
  r.status === 400 && r.data?.error?.code === 'validation' && JSON.stringify(r.data.error.details?.[0]?.path) === JSON.stringify(path);

const ALL_ON = '{"expenses":true,"payments":true,"joins":true}';

async function main() {
  console.log('Push API test against ' + BASE + ' run ' + RUN);
  const tokens = [];
  try {
    const h = await req('GET', '/api/health');
    check('health 200', h.status === 200 && h.data?.ok === true, h.data);
    const a = await req('POST', '/api/auth/signup', { body: { name: 'test-push-a-' + RUN, locale: 'en' } });
    const b = await req('POST', '/api/auth/signup', { body: { name: 'test-push-b-' + RUN, locale: 'zh-TW' } });
    const tokA = a.data?.token;
    const tokB = b.data?.token;
    if (tokA) tokens.push(tokA);
    if (tokB) tokens.push(tokB);
    check('two throwaway accounts', a.status === 200 && b.status === 200 && !!tokA && !!tokB, [a.status, b.status]);
    if (tokA && tokB) await checks(tokA, tokB);
  } finally {
    // ---------- clean up ----------
    for (const token of tokens) {
      const del = await req('DELETE', '/api/me', { token, body: {} });
      check('delete throwaway account', del.status === 200, del.data);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('Failed:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

async function checks(tokA, tokB) {
  // ---------- status and prefs ----------
  {
    const no = await req('GET', '/api/push/status');
    check('status without a session -> 401', no.status === 401 && no.data?.error?.code === 'unauthorized', no.data);
    const s = await req('GET', '/api/push/status', { token: tokA });
    const key = typeof s.data?.publicKey === 'string' ? fromB64url(s.data.publicKey) : new Uint8Array();
    check('status 200', s.status === 200, s.data);
    check('status public key is a P-256 point (VAPID set up)', key.length === 65 && key[0] === 4, s.data?.publicKey);
    check('status prefs all on, no devices', JSON.stringify(s.data?.prefs) === ALL_ON && s.data?.devices === 0, s.data);
    check('status no-store', (s.headers.get('cache-control') || '').includes('no-store'), s.headers.get('cache-control'));

    const p = await req('PUT', '/api/push/prefs', { token: tokA, body: { payments: false } });
    check('prefs: change one', p.status === 200 && JSON.stringify(p.data) === '{"expenses":true,"payments":false,"joins":true}', p.data);
    const p2 = await req('PUT', '/api/push/prefs', { token: tokA, body: { joins: false } });
    check('prefs: the others keep their value', JSON.stringify(p2.data) === '{"expenses":true,"payments":false,"joins":false}', p2.data);
    const s2 = await req('GET', '/api/push/status', { token: tokA });
    check('status shows the prefs', JSON.stringify(s2.data?.prefs) === '{"expenses":true,"payments":false,"joins":false}', s2.data?.prefs);
    const bad = await req('PUT', '/api/push/prefs', { token: tokA, body: { payments: 'no' } });
    check('prefs: not a boolean -> 400 validation', bad.status === 400 && bad.data?.error?.code === 'validation', bad.data);
    const other = await req('GET', '/api/push/status', { token: tokB });
    check('prefs belong to one account', JSON.stringify(other.data?.prefs) === ALL_ON, other.data?.prefs);
    const back = await req('PUT', '/api/push/prefs', { token: tokA, body: { payments: true, joins: true } });
    check('prefs: back on', JSON.stringify(back.data) === ALL_ON, back.data);
  }

  // ---------- subscription checks ----------
  const endpoint = `https://fcm.googleapis.com/fcm/send/test-${RUN}-not-a-real-device`;
  const sub = await fakeSubscription(endpoint);
  {
    const put = body => req('PUT', '/api/push/subscription', { token: tokA, body });
    const notPoint = new Uint8Array(65).fill(9);
    notPoint[0] = 4;
    check('subscription: unknown host -> 400', isValidation(await put({ ...sub, endpoint: 'https://evil.example/push/' + RUN }), ['endpoint']));
    check('subscription: http -> 400', isValidation(await put({ ...sub, endpoint: 'http://fcm.googleapis.com/fcm/send/x' }), ['endpoint']));
    check('subscription: look-alike host -> 400', isValidation(await put({ ...sub, endpoint: 'https://fcm.googleapis.com.evil.example/x' }), ['endpoint']));
    check('subscription: port -> 400', isValidation(await put({ ...sub, endpoint: 'https://fcm.googleapis.com:8443/fcm/send/x' }), ['endpoint']));
    check('subscription: p256dh of 64 bytes -> 400', isValidation(await put({ ...sub, keys: { ...sub.keys, p256dh: b64url(fromB64url(sub.keys.p256dh).slice(0, 64)) } }), ['keys', 'p256dh']));
    check('subscription: p256dh not on P-256 -> 400', isValidation(await put({ ...sub, keys: { ...sub.keys, p256dh: b64url(notPoint) } }), ['keys', 'p256dh']));
    check('subscription: auth of 15 bytes -> 400', isValidation(await put({ ...sub, keys: { ...sub.keys, auth: b64url(new Uint8Array(15)) } }), ['keys', 'auth']));
    check('subscription: bad time zone -> 400', isValidation(await put({ ...sub, tz: 'Asia/Taipei; x' }), ['tz']));
    const none = await put({ endpoint });
    check('subscription: no keys -> 400', none.status === 400 && none.data?.error?.code === 'validation', none.data);
    const s = await req('GET', '/api/push/status', { token: tokA });
    check('nothing stored by refused subscriptions', s.data?.devices === 0, s.data);
  }

  // ---------- store, move, delete, test notification ----------
  {
    const r1 = await req('PUT', '/api/push/subscription', { token: tokA, body: { ...sub, tz: 'Asia/Taipei' } });
    check('subscription stored', r1.status === 200 && r1.data?.ok === true && r1.data?.devices === 1, r1.data);
    const r2 = await req('PUT', '/api/push/subscription', { token: tokA, body: sub });
    check('same endpoint again: still one device', r2.status === 200 && r2.data?.devices === 1, r2.data);
    const moved = await req('PUT', '/api/push/subscription', { token: tokB, body: sub });
    const left = await req('GET', '/api/push/status', { token: tokA });
    check('another account takes the endpoint over', moved.data?.devices === 1 && left.data?.devices === 0, [moved.data, left.data]);
    const d1 = await req('DELETE', '/api/push/subscription', { token: tokA, body: { endpoint } });
    const still = await req('GET', '/api/push/status', { token: tokB });
    check("cannot delete another account's subscription", d1.status === 200 && still.data?.devices === 1, [d1.data, still.data]);
    const empty = await req('POST', '/api/push/test', { token: tokA });
    check('test notification without devices sends nothing', empty.status === 200 && JSON.stringify(empty.data) === '{"sent":0,"removed":0,"failed":0}', empty.data);
    // The one push of this test: to the made-up FCM address, which FCM refuses.
    const t = await req('POST', '/api/push/test', { token: tokB });
    const n = (t.data?.sent ?? 0) + (t.data?.removed ?? 0) + (t.data?.failed ?? 0);
    check('test notification is tried on the device', t.status === 200 && n === 1, t.data);
    const how = t.data?.removed ? 'removed (the push service says the device is gone)' : t.data?.failed ? 'failed (the Worker log has the status)' : 'sent';
    console.log('       FCM answer counted as ' + how);
    const d2 = await req('DELETE', '/api/push/subscription', { token: tokB, body: { endpoint } });
    const after = await req('GET', '/api/push/status', { token: tokB });
    check('delete own subscription', d2.status === 200 && after.data?.devices === 0, [d2.data, after.data]);
  }

  // ---------- an iPhone: the APNs sandbox, for real ----------
  {
    // A made-up token: APNs answers BadDeviceToken, which removes the iPhone (it proves the
    // provider token and the HTTP/2 path too, since APNs checks those first).
    const hex = Array.from(webcrypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
    const s = await req('GET', '/api/push/status', { token: tokA });
    check('status says APNs is set up', s.data?.apns === true, s.data);
    const put = await req('PUT', '/api/push/apns', { token: tokA, body: { token: hex, environment: 'sandbox', bundleId: 'com.ginochang.evenly', tz: 'Asia/Taipei', label: 'iPhone' } });
    check('iPhone stored', put.status === 200 && put.data?.ok === true && put.data?.devices === 1, put.data);
    const t = await req('POST', '/api/push/test', { token: tokA });
    check('test notification to a made-up iPhone: APNs refuses the token, the iPhone is removed', t.status === 200 && JSON.stringify(t.data) === '{"sent":0,"removed":1,"failed":0}', t.data);
    const after = await req('GET', '/api/push/status', { token: tokA });
    check('the removed iPhone is gone', after.data?.devices === 0, after.data);
  }

  // ---------- the sender ----------
  {
    const no = await req('POST', '/api/push/run');
    check('run without a session -> 401', no.status === 401, no.status);
    const r = await req('POST', '/api/push/run', { token: tokA });
    const keys = ['groups', 'sent', 'removed', 'failed'];
    check('run the sender (staging: anyone signed in)', r.status === 200 && keys.every(k => Number.isInteger(r.data?.[k]) && r.data[k] >= 0), r.data);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(2);
});
