// /api/push (src/worker/routes/push.ts) end to end on the worker.fetch harness with the real schema
// (tests/worker/d1-sqlite.ts) and real sessions: status, prefs, storing a subscription (allowed
// push hosts only, key checks, the session it belongs to, moving between accounts, 10 per account),
// unsubscribing, the cascade from sessions and accounts, the test notification (fetch stubbed,
// decrypted like a browser would) with its hourly limit, and who may run the sender. The iPhone
// app's APNs tokens the same way (PUT and DELETE /api/push/apns), and migration 0012. Also the
// daily limit on adding people by email (routes/groups.ts), since each of them gets a notification.

import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSnapshotDTO, PushPayload } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import { b64url, sha256Hex } from '../../src/worker/http';
import worker from '../../src/worker/index';
import { MAX_LINKS_PER_DAY } from '../../src/worker/routes/groups';
import { endpointProblem, MAX_APNS_DEVICES, MAX_SUBSCRIPTIONS } from '../../src/worker/routes/push';
import { forgetApnsJwt } from '../../src/worker/services/apns';
import { TestD1 } from './d1-sqlite';

const subtle = crypto.subtle;
const utf8 = new TextEncoder();
const text = new TextDecoder();
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const OWNER = 'owner@evenly.test';

let vapidVars: Record<string, string>;
let db: TestD1;
let env: Record<string, unknown>;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  data: T;
  headers: Headers;
}

async function api<T = any>(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  const h: Record<string, string> = { ...headers };
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request('http://api.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const t = await res.text();
  return { status: res.status, data: t ? JSON.parse(t) : undefined, headers: res.headers };
}

async function addUser(id: string, name: string, email: string | null, locale: 'zh-TW' | 'en' = 'zh-TW'): Promise<void> {
  const now = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, locale, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name, email, locale, '#2F6FB5', now, now);
  tokens[id] = await createSession(db.d1, id, 'test');
}

interface Browser {
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  auth: Uint8Array;
  /** As PushSubscription.toJSON() gives it. */
  json: { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
}

const browsers = new Map<string, Browser>();

async function browser(endpoint: string): Promise<Browser> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const b = { privateKey: pair.privateKey, publicRaw, auth, json: { endpoint, expirationTime: null, keys: { p256dh: b64url(publicRaw), auth: b64url(auth) } } };
  browsers.set(endpoint, b);
  return b;
}

const subscribe = (user: string, sub: unknown, tz: string | null = 'Asia/Taipei') =>
  api(user, 'PUT', '/api/push/subscription', tz === null ? sub : { ...(sub as object), tz }, { 'User-Agent': IPHONE });

const subRows = (user?: string) =>
  db.rows<{ id: string; user_id: string; session_id: string; endpoint: string; p256dh: string; auth: string; tz: string; label: string; created_at: string; last_ok_at: string | null; failures: number }>(
    user ? 'SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at' : 'SELECT * FROM push_subscriptions ORDER BY created_at',
    ...(user ? [user] : []),
  );

const label = (s: string): Uint8Array => new Uint8Array([...utf8.encode(s), 0]);

async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, bits: number): Promise<ArrayBuffer> {
  return subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bits);
}

/** The browser's side of RFC 8291 (one record, no padding). */
async function decrypt(msg: Uint8Array, b: Browser): Promise<PushPayload> {
  const keyid = msg.slice(21, 86);
  const as = await subtle.importKey('raw', keyid, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = await subtle.deriveBits({ name: 'ECDH', public: as }, b.privateKey, 256);
  const ikm = await hkdf(b.auth, ecdh, new Uint8Array([...label('WebPush: info'), ...b.publicRaw, ...keyid]), 256);
  const salt = msg.slice(0, 16);
  const key = await subtle.importKey('raw', await hkdf(salt, ikm, label('Content-Encoding: aes128gcm'), 128), 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: await hkdf(salt, ikm, label('Content-Encoding: nonce'), 96) }, key, msg.slice(86)));
  return JSON.parse(text.decode(plain.slice(0, -1))) as PushPayload;
}

let pushed: { endpoint: string; payload: PushPayload }[];
let answer: (endpoint: string) => number;
/** APNs set up with an auth key made here; the iPhone blocks add it to env. */
let apnsVars: Record<string, string>;
let apnsPushed: { token: string; host: string; headers: Record<string, string>; body: unknown }[];
let apnsAnswer: (token: string) => { status: number; reason?: string };

beforeAll(async () => {
  const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
  const jwk = (await subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  vapidVars = {
    VAPID_PUBLIC_KEY: b64url(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))),
    VAPID_SUBJECT: 'mailto:gino@ginochang.com',
    VAPID_PRIVATE_JWK: JSON.stringify({ kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }),
  };
  const apnsKey = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
  const der = Buffer.from((await subtle.exportKey('pkcs8', apnsKey.privateKey)) as ArrayBuffer).toString('base64');
  apnsVars = {
    APNS_KEY_ID: 'U47HW6ZSNN',
    APNS_TEAM_ID: '7XHV5223X7',
    APNS_TOPIC: 'com.ginochang.evenly',
    APNS_AUTH_KEY: ['-----BEGIN PRIVATE KEY-----', ...(der.match(/.{1,64}/g) ?? []), '-----END PRIVATE KEY-----'].join('\n'),
  };
});

beforeEach(async () => {
  db = new TestD1();
  env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'http://app.test/', ENVIRONMENT: 'test', OWNER_EMAILS: OWNER, ...vapidVars };
  browsers.clear();
  pushed = [];
  answer = () => 201;
  apnsPushed = [];
  apnsAnswer = () => ({ status: 200 });
  forgetApnsJwt();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === 'api.push.apple.com' || url.host === 'api.sandbox.push.apple.com') {
      const token = url.pathname.replace('/3/device/', '');
      apnsPushed.push({ token, host: url.host, headers: Object.fromEntries(req.headers), body: JSON.parse(await req.text()) });
      const a = apnsAnswer(token);
      return new Response(a.reason ? JSON.stringify({ reason: a.reason }) : null, { status: a.status });
    }
    const b = browsers.get(req.url);
    if (!b) throw new Error('push to an unknown endpoint');
    pushed.push({ endpoint: req.url, payload: await decrypt(new Uint8Array(await req.arrayBuffer()), b) });
    return new Response(null, { status: answer(req.url) });
  }));
  await addUser('owner', 'Gino', OWNER);
  await addUser('ann', 'Ann', 'ann@evenly.test', 'en');
  await addUser('bob', 'Bob', null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- endpoints ----------

describe('endpointProblem', () => {
  it('accepts the push services of Apple, Google, Mozilla and Microsoft over https', () => {
    for (const ok of [
      'https://web.push.apple.com/QGuQyavXutnMH6Kz4uOVwGq',
      'https://api.push.apple.com/x',
      'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91b',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://push.services.mozilla.com/x',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
      'https://FCM.googleapis.com/fcm/send/x',
    ]) {
      expect(endpointProblem(ok)).toBeNull();
    }
  });

  it('refuses everything else', () => {
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com:8443/fcm/send/x',
      'https://user:pw@fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://push.apple.com.evil.example/x',
      'https://evilpush.apple.com/x',
      'https://push.apple.com/x',
      'https://notify.windows.com/x',
      'https://evil.example/push',
      'https://127.0.0.1/x',
      'ftp://fcm.googleapis.com/x',
      'not a url',
      '',
    ]) {
      expect(endpointProblem(bad)).not.toBeNull();
    }
  });
});

// ---------- status and prefs ----------

describe('GET /api/push/status and PUT /api/push/prefs', () => {
  it('needs a session', async () => {
    const r = await api(null, 'GET', '/api/push/status');
    expect(r.status).toBe(401);
    expect(r.data.error.code).toBe('unauthorized');
  });

  it('answers the public key, the prefs (all on at first) and the device count, never cached', async () => {
    const r = await api('ann', 'GET', '/api/push/status');
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ publicKey: vapidVars.VAPID_PUBLIC_KEY, prefs: { expenses: true, payments: true, joins: true }, devices: 0, apns: false });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('answers no key when the server cannot sign (keys missing or not a pair)', async () => {
    env.VAPID_PRIVATE_JWK = undefined;
    expect((await api('ann', 'GET', '/api/push/status')).data.publicKey).toBe('');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    env.VAPID_PRIVATE_JWK = JSON.stringify({ kty: 'EC', crv: 'P-256', d: 'AAAA', x: 'AAAA', y: 'AAAA' });
    expect((await api('ann', 'GET', '/api/push/status')).data.publicKey).toBe('');
    expect(errors).toHaveBeenCalled();
  });

  it('changes only the prefs it is given and answers all three', async () => {
    expect((await api('ann', 'PUT', '/api/push/prefs', { payments: false })).data).toEqual({ expenses: true, payments: false, joins: true });
    expect((await api('ann', 'PUT', '/api/push/prefs', { joins: false, other: true })).data).toEqual({ expenses: true, payments: false, joins: false });
    expect((await api('ann', 'PUT', '/api/push/prefs', {})).data).toEqual({ expenses: true, payments: false, joins: false });
    expect((await api('ann', 'PUT', '/api/push/prefs', { payments: true })).data).toEqual({ expenses: true, payments: true, joins: false });
    expect((await api('ann', 'GET', '/api/push/status')).data.prefs).toEqual({ expenses: true, payments: true, joins: false });
    // Someone else's prefs are their own.
    expect((await api('bob', 'GET', '/api/push/status')).data.prefs).toEqual({ expenses: true, payments: true, joins: true });
  });

  it('refuses prefs that are not true or false, and recovers from a broken stored value', async () => {
    const r = await api('ann', 'PUT', '/api/push/prefs', { payments: 'no' });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('validation');
    db.exec("UPDATE users SET notify_prefs = 'oops' WHERE id = 'ann'");
    expect((await api('ann', 'GET', '/api/push/status')).data.prefs).toEqual({ expenses: true, payments: true, joins: true });
    expect((await api('ann', 'PUT', '/api/push/prefs', { expenses: false })).data).toEqual({ expenses: false, payments: true, joins: true });
  });
});

// ---------- subscriptions ----------

describe('PUT /api/push/subscription', () => {
  it('stores the subscription for this account and session, with the device label and time zone', async () => {
    const b = await browser('https://web.push.apple.com/QGuQyavXutnMH6Kz4uOVwGq');
    const r = await subscribe('ann', b.json);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, devices: 1 });
    const [row] = subRows('ann');
    expect(row).toMatchObject({
      id: await sha256Hex(b.json.endpoint),
      user_id: 'ann',
      session_id: await sha256Hex(tokens.ann),
      endpoint: b.json.endpoint,
      p256dh: b.json.keys.p256dh,
      auth: b.json.keys.auth,
      tz: 'Asia/Taipei',
      label: 'iPhone Safari',
      last_ok_at: null,
      failures: 0,
    });
    expect((await api('ann', 'GET', '/api/push/status')).data.devices).toBe(1);
  });

  it('takes every allowed push service and keys with base64 padding, stored without it', async () => {
    const hosts = ['https://fcm.googleapis.com/fcm/send/a1', 'https://updates.push.services.mozilla.com/wpush/v2/a2', 'https://wns2-par02p.notify.windows.com/w/?token=a3'];
    for (const [i, endpoint] of hosts.entries()) {
      const b = await browser(endpoint);
      const padded = { ...b.json, keys: { p256dh: b.json.keys.p256dh + '=', auth: b.json.keys.auth + '==' } };
      const r = await subscribe('ann', padded, null);
      expect(r.status).toBe(200);
      expect(r.data.devices).toBe(i + 1);
    }
    for (const row of subRows('ann')) {
      expect(row.p256dh).not.toContain('=');
      expect(row.auth).not.toContain('=');
      expect(row.tz).toBe('');
    }
  });

  it('refuses an endpoint off the allowlist, and keys that are not a P-256 point and a 16-byte secret', async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/ok');
    const point = new Uint8Array(65).fill(9);
    point[0] = 4;
    const cases: [unknown, (string | number)[]][] = [
      [{ ...b.json, endpoint: 'https://evil.example/push/1' }, ['endpoint']],
      [{ ...b.json, endpoint: 'http://fcm.googleapis.com/fcm/send/x' }, ['endpoint']],
      [{ ...b.json, endpoint: 'https://fcm.googleapis.com.evil.example/x' }, ['endpoint']],
      [{ ...b.json, endpoint: 'not a url' }, ['endpoint']],
      [{ ...b.json, keys: { ...b.json.keys, p256dh: b64url(b.publicRaw.slice(0, 64)) } }, ['keys', 'p256dh']],
      [{ ...b.json, keys: { ...b.json.keys, p256dh: b64url(new Uint8Array([3, ...b.publicRaw.slice(1)])) } }, ['keys', 'p256dh']],
      [{ ...b.json, keys: { ...b.json.keys, p256dh: b64url(point) } }, ['keys', 'p256dh']],
      [{ ...b.json, keys: { ...b.json.keys, p256dh: 'not base64!' } }, ['keys', 'p256dh']],
      [{ ...b.json, keys: { ...b.json.keys, auth: b64url(new Uint8Array(15)) } }, ['keys', 'auth']],
      [{ ...b.json, keys: { ...b.json.keys, auth: b64url(new Uint8Array(17)) } }, ['keys', 'auth']],
      [{ ...b.json, tz: 'Asia/Taipei; DROP TABLE' }, ['tz']],
    ];
    for (const [sub, path] of cases) {
      const r = await subscribe('ann', sub, null);
      expect(r.status, JSON.stringify(sub)).toBe(400);
      expect(r.data.error.code).toBe('validation');
      expect(r.data.error.details[0].path).toEqual(path);
    }
    for (const sub of [{ endpoint: b.json.endpoint }, { ...b.json, endpoint: 'https://fcm.googleapis.com/' + 'x'.repeat(1100) }, {}]) {
      const r = await subscribe('ann', sub, null);
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe('validation');
    }
    expect(subRows()).toEqual([]);
  });

  it('updates the same endpoint in place: new keys and session, time zone kept when not sent, failures reset', async () => {
    const b = await browser('https://web.push.apple.com/same');
    await subscribe('ann', b.json);
    const first = subRows('ann')[0];
    db.exec('UPDATE push_subscriptions SET failures = 3, last_ok_at = ? WHERE id = ?', '2026-10-01T00:00:00.000Z', first.id);
    tokens.ann = await createSession(db.d1, 'ann', 'second sign-in');
    const again = await browser('https://web.push.apple.com/same');
    const r = await subscribe('ann', again.json, null);
    expect(r.data).toEqual({ ok: true, devices: 1 });
    const row = subRows('ann')[0];
    expect(row).toMatchObject({
      p256dh: again.json.keys.p256dh, auth: again.json.keys.auth, session_id: await sha256Hex(tokens.ann), tz: 'Asia/Taipei',
      created_at: first.created_at, last_ok_at: '2026-10-01T00:00:00.000Z', failures: 0,
    });
  });

  it('moves an endpoint that belongs to another account (the device changed account)', async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/shared');
    await subscribe('ann', b.json);
    db.exec("UPDATE push_subscriptions SET last_ok_at = '2026-10-01T00:00:00.000Z', created_at = '2026-09-01T00:00:00.000Z'");
    const r = await subscribe('bob', b.json, 'Europe/Paris');
    expect(r.data).toEqual({ ok: true, devices: 1 });
    expect((await api('ann', 'GET', '/api/push/status')).data.devices).toBe(0);
    const [row] = subRows();
    expect(row).toMatchObject({ user_id: 'bob', session_id: await sha256Hex(tokens.bob), tz: 'Europe/Paris', last_ok_at: null });
    expect(row.created_at > '2026-09-01T00:00:00.000Z').toBe(true);
  });

  it(`keeps at most ${MAX_SUBSCRIPTIONS} per account, dropping the device that worked longest ago, never this one`, async () => {
    const day = 86_400_000;
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
      const b = await browser('https://web.push.apple.com/dev-' + i);
      await subscribe('ann', b.json);
      // dev-0 subscribed first and stopped working; dev-1 subscribed long ago but got a push yesterday.
      db.exec('UPDATE push_subscriptions SET created_at = ?, last_ok_at = ? WHERE endpoint = ?', new Date(Date.now() - (20 - i) * day).toISOString(), i === 1 ? new Date(Date.now() - day).toISOString() : null, b.json.endpoint);
    }
    const extra = await browser('https://web.push.apple.com/dev-new');
    expect((await subscribe('ann', extra.json)).data).toEqual({ ok: true, devices: MAX_SUBSCRIPTIONS });
    const left = subRows('ann').map(r => r.endpoint);
    expect(left).not.toContain('https://web.push.apple.com/dev-0');
    expect(left).toContain('https://web.push.apple.com/dev-1');
    expect(left).toContain('https://web.push.apple.com/dev-new');
    // The app re-sends its subscription at every start: the oldest one sending again stays.
    const dev2 = browsers.get('https://web.push.apple.com/dev-2')!;
    expect((await subscribe('ann', dev2.json)).data.devices).toBe(MAX_SUBSCRIPTIONS);
    expect(subRows('ann').map(r => r.endpoint)).toContain(dev2.json.endpoint);
    // A device that comes back after it was dropped counts as new and drops the next oldest.
    const back = await browser('https://web.push.apple.com/dev-0');
    expect((await subscribe('ann', back.json)).data.devices).toBe(MAX_SUBSCRIPTIONS);
    const now = subRows('ann').map(r => r.endpoint);
    expect(now).toContain(back.json.endpoint);
    expect(now).not.toContain(dev2.json.endpoint);
  });
});

describe('DELETE /api/push/subscription and the cascades', () => {
  it('deletes this account\'s own subscription only', async () => {
    const a = await browser('https://web.push.apple.com/ann-phone');
    const b = await browser('https://web.push.apple.com/bob-phone');
    await subscribe('ann', a.json);
    await subscribe('bob', b.json);
    expect((await api('ann', 'DELETE', '/api/push/subscription', { endpoint: b.json.endpoint })).data).toEqual({ ok: true });
    expect(subRows('bob')).toHaveLength(1);
    expect((await api('ann', 'DELETE', '/api/push/subscription', { endpoint: a.json.endpoint })).data).toEqual({ ok: true });
    expect(subRows('ann')).toHaveLength(0);
    expect((await api('ann', 'DELETE', '/api/push/subscription', {})).status).toBe(400);
  });

  it('goes with the session: signing out, a revoked or expired session, and a deleted account', async () => {
    const a = await browser('https://web.push.apple.com/ann-phone');
    await subscribe('ann', a.json);
    expect((await api('ann', 'POST', '/api/auth/logout')).status).toBe(200);
    expect(subRows('ann')).toEqual([]);

    const b = await browser('https://web.push.apple.com/bob-phone');
    await subscribe('bob', b.json);
    db.exec('DELETE FROM sessions WHERE id = ?', await sha256Hex(tokens.bob));
    expect(subRows('bob')).toEqual([]);

    tokens.bob = await createSession(db.d1, 'bob', 'again');
    await subscribe('bob', (await browser('https://web.push.apple.com/bob-2')).json);
    expect(subRows('bob')).toHaveLength(1);
    expect((await api('bob', 'DELETE', '/api/me', {})).status).toBe(200);
    expect(subRows()).toEqual([]);
  });
});

// ---------- test notification ----------

describe('POST /api/push/test', () => {
  it('sends the test notification to every device of the account, in its language', async () => {
    await subscribe('ann', (await browser('https://web.push.apple.com/ann-phone')).json);
    await subscribe('ann', (await browser('https://fcm.googleapis.com/fcm/send/ann-laptop')).json);
    await subscribe('bob', (await browser('https://web.push.apple.com/bob-phone')).json);
    const r = await api('ann', 'POST', '/api/push/test');
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ sent: 2, removed: 0, failed: 0 });
    expect(pushed.map(p => p.endpoint).sort()).toEqual(['https://fcm.googleapis.com/fcm/send/ann-laptop', 'https://web.push.apple.com/ann-phone']);
    expect(pushed[0].payload).toEqual({ title: "Gino's Split Lab", body: 'Test notification: if you can see this, notifications work on this device.', path: '/account', tag: 'test' });
    expect(subRows('ann').every(s => s.last_ok_at)).toBe(true);
    pushed = [];
    expect((await api('bob', 'POST', '/api/push/test')).data).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(pushed[0].payload.body).toBe('測試通知：看得到這則，就表示這台裝置收得到通知。');
  });

  it('reports devices the push service says are gone (and deletes them) and other failures', async () => {
    await subscribe('ann', (await browser('https://web.push.apple.com/gone')).json);
    await subscribe('ann', (await browser('https://web.push.apple.com/flaky')).json);
    answer = e => (e.endsWith('/gone') ? 410 : 503);
    expect((await api('ann', 'POST', '/api/push/test')).data).toEqual({ sent: 0, removed: 1, failed: 1 });
    expect(subRows('ann').map(s => [s.endpoint, s.failures])).toEqual([['https://web.push.apple.com/flaky', 1]]);
  });

  it('allows 5 an hour, answers zeros without devices, and 503 when push is not set up', async () => {
    for (let i = 0; i < 5; i++) expect((await api('ann', 'POST', '/api/push/test')).data).toEqual({ sent: 0, removed: 0, failed: 0 });
    const r = await api('ann', 'POST', '/api/push/test');
    expect(r.status).toBe(429);
    expect(r.data.error.code).toBe('rate_limited');
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    env.VAPID_PRIVATE_JWK = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const off = await api('bob', 'POST', '/api/push/test');
    expect(off.status).toBe(503);
    expect(off.data.error.code).toBe('server_error');
  });
});

// ---------- running the sender ----------

describe('POST /api/push/run', () => {
  it('in production only the owner may run it; anyone else gets 404', async () => {
    env.ENVIRONMENT = 'production';
    const r = await api('ann', 'POST', '/api/push/run');
    expect(r.status).toBe(404);
    expect(r.data.error.code).toBe('not_found');
    const o = await api('owner', 'POST', '/api/push/run');
    expect(o.status).toBe(200);
    expect(o.data).toEqual({ groups: 0, sent: 0, removed: 0, failed: 0 });
    expect((await api(null, 'POST', '/api/push/run')).status).toBe(401);
  });

  it('off production anyone signed in runs it, and it sends what is due', async () => {
    env.ENVIRONMENT = 'staging';
    env.PUSH_HOLD_SECONDS = '0';
    await subscribe('ann', (await browser('https://web.push.apple.com/ann-phone')).json);
    const g = await api<GroupSnapshotDTO>('owner', 'POST', '/api/groups', { name: 'test-Trip', type: 'trip', currency: 'TWD', emoji: '🧳', members: [{ name: 'Ann', email: 'ann@evenly.test' }] });
    expect(g.status).toBe(200);
    const r = await api('bob', 'POST', '/api/push/run');
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ groups: 1, sent: 1, removed: 0, failed: 0 });
    expect(pushed.map(p => p.payload)).toEqual([{ title: '🧳 test-Trip', body: 'Gino created the group and added you', path: `/g/${g.data.group.id}`, tag: `g:${g.data.group.id}` }]);
  });
});

// ---------- iPhones (APNs) ----------

const TOKEN = 'ab'.repeat(32);
const iphone = (over: Record<string, unknown> = {}) => ({ token: TOKEN, environment: 'production', bundleId: 'com.ginochang.evenly', tz: 'Asia/Taipei', label: 'iPhone', ...over });
const putIphone = (user: string, body: unknown, ua = 'Evenly/1.1 CFNetwork/1568 Darwin/24.0.0') => api(user, 'PUT', '/api/push/apns', body, { 'User-Agent': ua });
const iphoneRows = (user?: string) =>
  db.rows<{ token: string; user_id: string; session_id: string; environment: string; bundle_id: string; tz: string; label: string; created_at: string; last_ok_at: string | null; failures: number }>(
    user ? 'SELECT * FROM apns_devices WHERE user_id = ? ORDER BY created_at, token' : 'SELECT * FROM apns_devices ORDER BY created_at, token',
    ...(user ? [user] : []),
  );

describe('PUT /api/push/apns', () => {
  beforeEach(() => Object.assign(env, apnsVars));

  it('stores the iPhone for this account and session: the token in lowercase, its environment, bundle id, time zone and label', async () => {
    const r = await putIphone('ann', iphone({ token: TOKEN.toUpperCase() }));
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, devices: 1 });
    expect(iphoneRows('ann')).toEqual([
      expect.objectContaining({
        token: TOKEN, user_id: 'ann', session_id: await sha256Hex(tokens.ann), environment: 'production', bundle_id: 'com.ginochang.evenly',
        tz: 'Asia/Taipei', label: 'iPhone', last_ok_at: null, failures: 0,
      }),
    ]);
    // GET /api/push/status says the server can send to iPhones, and counts browsers and iPhones.
    expect((await api('ann', 'GET', '/api/push/status')).data).toEqual({
      publicKey: vapidVars.VAPID_PUBLIC_KEY, prefs: { expenses: true, payments: true, joins: true }, devices: 1, apns: true,
    });
    const b = await browser('https://web.push.apple.com/ann-mac');
    expect((await subscribe('ann', b.json)).data).toEqual({ ok: true, devices: 2 });
    expect((await putIphone('ann', iphone({ token: 'cd'.repeat(32), environment: 'sandbox' }))).data).toEqual({ ok: true, devices: 3 });
    expect((await api('ann', 'GET', '/api/push/status')).data.devices).toBe(3);
  });

  it('refuses what is not an iPhone token of this app, and stores nothing', async () => {
    const cases: [Record<string, unknown>, (string | number)[]][] = [
      [iphone({ token: 'ab'.repeat(31) }), ['token']],
      [iphone({ token: TOKEN + 'a' }), ['token']],
      [iphone({ token: 'zz'.repeat(32) }), ['token']],
      [iphone({ token: 'ab'.repeat(101) }), ['token']],
      [iphone({ token: '<' + TOKEN + '>' }), ['token']],
      [iphone({ token: 5 }), ['token']],
      [iphone({ environment: 'development' }), ['environment']],
      [iphone({ environment: undefined }), ['environment']],
      [iphone({ bundleId: 'com.ginochang.evenly.widgets' }), ['bundleId']],
      [iphone({ bundleId: 'com.example.app' }), ['bundleId']],
      [iphone({ tz: 'Asia/Taipei; DROP TABLE' }), ['tz']],
      [iphone({ label: 'x'.repeat(61) }), ['label']],
    ];
    for (const [body, path] of cases) {
      const r = await putIphone('ann', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.data.error.code).toBe('validation');
      expect(r.data.error.details[0].path).toEqual(path);
    }
    expect((await putIphone('ann', {})).status).toBe(400);
    expect((await api(null, 'PUT', '/api/push/apns', iphone())).status).toBe(401);
    // Without APNS_TOPIC no bundle id is this app's.
    env.APNS_TOPIC = undefined;
    expect((await putIphone('ann', iphone())).data.error.details[0].path).toEqual(['bundleId']);
    expect(iphoneRows()).toEqual([]);
  });

  it('takes no tz and no label: the time zone stays as stored, the label is the User-Agent\'s device kind', async () => {
    expect((await putIphone('ann', iphone({ tz: undefined, label: undefined }), IPHONE)).status).toBe(200);
    expect(iphoneRows('ann')[0]).toMatchObject({ tz: '', label: 'iPhone Safari' });
    expect((await putIphone('ann', iphone({ tz: 'Europe/Paris', label: '  my\n iPhone ' }))).status).toBe(200);
    expect((await putIphone('ann', iphone({ tz: null, label: null }))).status).toBe(200);
    expect(iphoneRows('ann')[0]).toMatchObject({ tz: 'Europe/Paris', label: '' });
    expect((await putIphone('ann', iphone({ tz: undefined, label: '  my\n iPhone ' }))).status).toBe(200);
    expect(iphoneRows('ann')[0]).toMatchObject({ tz: 'Europe/Paris', label: 'my iPhone' });
  });

  it('the same token again updates it in place: the new session, environment, failures reset; another account takes it over', async () => {
    await putIphone('ann', iphone());
    db.exec("UPDATE apns_devices SET failures = 3, last_ok_at = '2026-10-01T00:00:00.000Z', created_at = '2026-09-01T00:00:00.000Z'");
    tokens.ann = await createSession(db.d1, 'ann', 'signed in again');
    expect((await putIphone('ann', iphone({ environment: 'sandbox' }))).data).toEqual({ ok: true, devices: 1 });
    expect(iphoneRows('ann')[0]).toMatchObject({
      session_id: await sha256Hex(tokens.ann), environment: 'sandbox', failures: 0, last_ok_at: '2026-10-01T00:00:00.000Z', created_at: '2026-09-01T00:00:00.000Z',
    });
    // Bob signs in on that iPhone: it is his now, as a new device.
    expect((await putIphone('bob', iphone({ tz: undefined }))).data).toEqual({ ok: true, devices: 1 });
    expect((await api('ann', 'GET', '/api/push/status')).data.devices).toBe(0);
    const [row] = iphoneRows();
    expect(row).toMatchObject({ user_id: 'bob', session_id: await sha256Hex(tokens.bob), tz: 'Asia/Taipei', last_ok_at: null, failures: 0 });
    expect(row.created_at > '2026-09-01T00:00:00.000Z').toBe(true);
  });

  it(`keeps at most ${MAX_APNS_DEVICES} per account, dropping the iPhone that got a notification longest ago, never this one`, async () => {
    const day = 86_400_000;
    const tok = (i: number) => i.toString(16).padStart(2, '0').repeat(32);
    for (let i = 0; i < MAX_APNS_DEVICES; i++) {
      await putIphone('ann', iphone({ token: tok(i) }));
      db.exec('UPDATE apns_devices SET created_at = ?, last_ok_at = ? WHERE token = ?', new Date(Date.now() - (20 - i) * day).toISOString(), i === 1 ? new Date(Date.now() - day).toISOString() : null, tok(i));
    }
    expect((await putIphone('ann', iphone({ token: tok(99) }))).data).toEqual({ ok: true, devices: MAX_APNS_DEVICES });
    const left = iphoneRows('ann').map(r => r.token);
    expect(left).not.toContain(tok(0));
    expect(left).toContain(tok(1));
    expect(left).toContain(tok(99));
    // Browsers have their own ten.
    for (let i = 0; i < 3; i++) await subscribe('ann', (await browser('https://web.push.apple.com/ann-' + i)).json);
    expect(iphoneRows('ann')).toHaveLength(MAX_APNS_DEVICES);
  });
});

describe('DELETE /api/push/apns and the cascades', () => {
  beforeEach(() => Object.assign(env, apnsVars));

  it("deletes this account's own iPhone only; an unknown token is ok; no token is 400", async () => {
    await putIphone('ann', iphone());
    await putIphone('bob', iphone({ token: 'cd'.repeat(32) }));
    expect((await api('ann', 'DELETE', '/api/push/apns', { token: 'cd'.repeat(32) })).data).toEqual({ ok: true });
    expect(iphoneRows('bob')).toHaveLength(1);
    expect((await api('ann', 'DELETE', '/api/push/apns', { token: TOKEN.toUpperCase() })).data).toEqual({ ok: true });
    expect(iphoneRows('ann')).toEqual([]);
    expect((await api('ann', 'DELETE', '/api/push/apns', { token: 'ef'.repeat(32) })).data).toEqual({ ok: true });
    expect((await api('ann', 'DELETE', '/api/push/apns', {})).status).toBe(400);
    expect((await api(null, 'DELETE', '/api/push/apns', { token: TOKEN })).status).toBe(401);
  });

  it('goes with the session: signing out, a revoked session, a deleted account; and its kept messages with it', async () => {
    await putIphone('ann', iphone());
    db.exec("INSERT INTO apns_pending (token, user_id, rank, payload, urgency, collapse_id, created_at) VALUES (?, 'ann', 0, '{}', 'normal', 'g:x', ?)", TOKEN, new Date().toISOString());
    expect((await api('ann', 'POST', '/api/auth/logout')).status).toBe(200);
    expect(iphoneRows()).toEqual([]);
    expect(db.rows('SELECT 1 FROM apns_pending')).toEqual([]);

    await putIphone('bob', iphone());
    db.exec('DELETE FROM sessions WHERE id = ?', await sha256Hex(tokens.bob));
    expect(iphoneRows()).toEqual([]);

    tokens.bob = await createSession(db.d1, 'bob', 'again');
    await putIphone('bob', iphone());
    expect((await api('bob', 'DELETE', '/api/me', {})).status).toBe(200);
    expect(iphoneRows()).toEqual([]);
  });
});

describe('POST /api/push/test and the iPhones', () => {
  beforeEach(() => Object.assign(env, apnsVars));

  it("reaches the account's browsers and iPhones, in its language; a tap on the iPhone opens 我的", async () => {
    await subscribe('ann', (await browser('https://web.push.apple.com/ann-mac')).json);
    await putIphone('ann', iphone());
    await putIphone('ann', iphone({ token: 'cd'.repeat(32), environment: 'sandbox' }));
    await putIphone('bob', iphone({ token: 'ef'.repeat(32) }));
    expect((await api('ann', 'POST', '/api/push/test')).data).toEqual({ sent: 3, removed: 0, failed: 0 });
    expect(pushed.map(p => p.payload.path)).toEqual(['/account']);
    expect(apnsPushed.map(p => [p.token, p.host]).sort()).toEqual([[TOKEN, 'api.push.apple.com'], ['cd'.repeat(32), 'api.sandbox.push.apple.com']]);
    expect(apnsPushed[0].body).toEqual({
      aps: { alert: { title: "Gino's Split Lab", body: 'Test notification: if you can see this, notifications work on this device.' }, sound: 'default' },
      route: 'account',
    });
    expect(apnsPushed.map(p => [p.headers['apns-collapse-id'], p.headers['apns-priority'], p.headers['apns-topic']])).toEqual(new Array(2).fill(['test', '10', 'com.ginochang.evenly']));
    expect(iphoneRows('ann').every(r => r.last_ok_at)).toBe(true);
  });

  it('removes an iPhone APNs says is gone; works with only one channel set up, and is 503 with neither', async () => {
    await putIphone('ann', iphone());
    await putIphone('ann', iphone({ token: 'cd'.repeat(32) }));
    apnsAnswer = t => (t === TOKEN ? { status: 410, reason: 'Unregistered' } : { status: 503, reason: 'ServiceUnavailable' });
    expect((await api('ann', 'POST', '/api/push/test')).data).toEqual({ sent: 0, removed: 1, failed: 1 });
    expect(iphoneRows('ann').map(r => [r.token, r.failures])).toEqual([['cd'.repeat(32), 1]]);
    apnsAnswer = () => ({ status: 200 });
    env.VAPID_PRIVATE_JWK = undefined;
    expect((await api('ann', 'GET', '/api/push/status')).data).toMatchObject({ publicKey: '', apns: true });
    expect((await api('ann', 'POST', '/api/push/test')).data).toEqual({ sent: 1, removed: 0, failed: 0 });
    env.APNS_AUTH_KEY = undefined;
    expect((await api('ann', 'GET', '/api/push/status')).data).toMatchObject({ publicKey: '', apns: false });
    const off = await api('ann', 'POST', '/api/push/test');
    expect(off.status).toBe(503);
    expect(off.data.error.code).toBe('server_error');
  });
});

describe('migration 0012', () => {
  const columns = (table: string) => db.rows<{ name: string; type: string; notnull: number; pk: number }>(`PRAGMA table_info(${table})`).map(c => [c.name, c.type, c.notnull, c.pk]);
  const keys = (table: string) => db.rows<{ table: string; from: string; to: string; on_delete: string }>(`PRAGMA foreign_key_list(${table})`).map(k => [k.from, k.table, k.to, k.on_delete]);
  const indexes = (table: string) => db.rows<{ name: string }>(`PRAGMA index_list(${table})`).map(i => i.name).filter(n => !n.startsWith('sqlite_')).sort();

  it('adds apns_devices and apns_pending, with their keys, indexes and cascades, and changes nothing else', () => {
    expect(columns('apns_devices')).toEqual([
      ['token', 'TEXT', 0, 1], ['user_id', 'TEXT', 1, 0], ['session_id', 'TEXT', 1, 0], ['environment', 'TEXT', 1, 0], ['bundle_id', 'TEXT', 1, 0],
      ['tz', 'TEXT', 1, 0], ['label', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0], ['last_ok_at', 'TEXT', 0, 0], ['failures', 'INTEGER', 1, 0],
    ]);
    expect(keys('apns_devices').sort()).toEqual([['session_id', 'sessions', 'id', 'CASCADE'], ['user_id', 'users', 'id', 'CASCADE']]);
    expect(indexes('apns_devices')).toEqual(['idx_apns_session', 'idx_apns_user']);
    expect(columns('apns_pending')).toEqual([
      ['id', 'INTEGER', 0, 1], ['token', 'TEXT', 1, 0], ['user_id', 'TEXT', 1, 0], ['rank', 'INTEGER', 1, 0], ['payload', 'TEXT', 1, 0],
      ['urgency', 'TEXT', 1, 0], ['collapse_id', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0], ['taken', 'INTEGER', 1, 0],
    ]);
    expect(keys('apns_pending')).toEqual([['token', 'apns_devices', 'token', 'CASCADE']]);
    expect(indexes('apns_pending')).toEqual(['idx_apns_pending_token']);
    // Additive: only CREATE statements, and the web tables as 0002 and 0003 made them.
    const sql = readFileSync(new URL('../../migrations/0012_apns.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
    expect(sql.match(/\b(CREATE TABLE|CREATE INDEX)\b/g)).toHaveLength(5);
    expect(sql).not.toMatch(/^\s*(ALTER|DROP|UPDATE|DELETE|INSERT|REPLACE)\b/im);
    expect(columns('push_pending').map(c => c[0])).toEqual(['id', 'sub_id', 'user_id', 'rank', 'payload', 'urgency', 'created_at']);
    expect(columns('push_subscriptions').map(c => c[0])).toEqual(['id', 'user_id', 'session_id', 'endpoint', 'p256dh', 'auth', 'tz', 'label', 'created_at', 'last_ok_at', 'failures']);
  });

  it('a kept message cannot name an iPhone that is not stored, and goes when its iPhone does', async () => {
    const now = new Date().toISOString();
    expect(() => db.exec("INSERT INTO apns_pending (token, user_id, rank, payload, urgency, created_at) VALUES ('nope', 'ann', 0, '{}', 'normal', ?)", now)).toThrow(/FOREIGN KEY/);
    db.exec("INSERT INTO apns_devices (token, user_id, session_id, environment, bundle_id, created_at) VALUES (?, 'ann', ?, 'production', 'com.ginochang.evenly', ?)", TOKEN, await sha256Hex(tokens.ann), now);
    db.exec("INSERT INTO apns_pending (token, user_id, rank, payload, urgency, created_at) VALUES (?, 'ann', 0, '{}', 'normal', ?)", TOKEN, now);
    expect(db.rows<{ taken: number; collapse_id: string | null }>('SELECT taken, collapse_id FROM apns_pending')).toEqual([{ taken: 0, collapse_id: null }]);
    db.exec('DELETE FROM apns_devices WHERE token = ?', TOKEN);
    expect(db.rows('SELECT 1 FROM apns_pending')).toEqual([]);
  });
});

// ---------- adding people by email ----------

describe('adding people by email (each of them gets a notification)', () => {
  /** Accounts p0, p1... that others can add by their email. */
  function people(n: number): void {
    const now = new Date().toISOString();
    for (let i = 0; i < n; i++) {
      db.exec('INSERT INTO users (id, name, email, locale, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'p' + i, 'P' + i, `p${i}@evenly.test`, 'en', '#2F6FB5', now, now);
    }
  }
  const person = (i: number) => ({ name: 'P' + i, email: `p${i}@evenly.test` });
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k);

  it(`allows ${MAX_LINKS_PER_DAY} a day per account, counting every account linked, on all three routes`, async () => {
    expect(MAX_LINKS_PER_DAY).toBe(30);
    people(40);
    // A new group with ten accounts and a placeholder: 10.
    const g = await api<GroupSnapshotDTO>('ann', 'POST', '/api/groups', { name: 'test-Big', type: 'trip', currency: 'TWD', members: [...range(0, 10).map(person), { name: 'Cy' }] });
    expect(g.status).toBe(200);
    const gid = g.data.group.id;
    // Names only and placeholders never count.
    expect((await api('ann', 'POST', '/api/groups', { name: 'test-Names', type: 'trip', currency: 'TWD', members: [{ name: 'Kai' }] })).status).toBe(200);
    expect((await api('ann', 'POST', `/api/groups/${gid}/members`, { name: 'Mo' })).status).toBe(200);
    expect((await api('ann', 'POST', '/api/friends', { name: 'Zoe' })).status).toBe(200);
    // Ten more one at a time: 20. Ten 1:1 ledgers: 30.
    for (const i of range(10, 20)) expect((await api('ann', 'POST', `/api/groups/${gid}/members`, person(i))).status).toBe(200);
    for (const i of range(20, 30)) expect((await api('ann', 'POST', '/api/friends', person(i))).status).toBe(200);
    // The ledger that is already there is no new link.
    expect((await api('ann', 'POST', '/api/friends', person(20))).status).toBe(200);
    // The next one is refused on every route, for the rest of the day, and nothing is written.
    const refused = [
      await api('ann', 'POST', '/api/groups', { name: 'test-More', type: 'trip', currency: 'TWD', members: [person(30)] }),
      await api('ann', 'POST', `/api/groups/${gid}/members`, person(31)),
      await api('ann', 'POST', '/api/friends', person(32)),
    ];
    for (const r of refused) {
      expect(r.status).toBe(429);
      expect(r.data.error.code).toBe('rate_limited');
      expect(r.data.error.details.scope).toBe('links');
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(23 * 3600);
    }
    expect(db.rows("SELECT id FROM groups WHERE name = 'test-More'")).toEqual([]);
    expect(db.rows("SELECT id FROM members WHERE user_id IN ('p30', 'p31', 'p32')")).toEqual([]);
    // Placeholders still go in, other accounts have their own count, and the next day starts over.
    expect((await api('ann', 'POST', `/api/groups/${gid}/members`, { name: 'Nobody' })).status).toBe(200);
    expect((await api('bob', 'POST', '/api/friends', person(33))).status).toBe(200);
    db.exec("UPDATE rate_limits SET reset_at = ? WHERE key = 'link-account:ann'", Date.now() - 1);
    expect((await api('ann', 'POST', '/api/friends', person(34))).status).toBe(200);
  });

  it('adding back someone who left counts too; one request cannot link more than a day allows', async () => {
    people(MAX_LINKS_PER_DAY + 1);
    const g = await api<GroupSnapshotDTO>('ann', 'POST', '/api/groups', { name: 'test-Trip', type: 'trip', currency: 'TWD', members: [person(0)] });
    const p0 = g.data.members.find(m => m.name === 'P0')!.id;
    tokens.p0 = await createSession(db.d1, 'p0', 'test');
    expect((await api('p0', 'DELETE', `/api/groups/${g.data.group.id}/members/${p0}`)).status).toBe(200);
    expect((await api('ann', 'POST', `/api/groups/${g.data.group.id}/members`, person(0))).status).toBe(200);
    expect(db.rows<{ count: number }>("SELECT count FROM rate_limits WHERE key = 'link-account:ann'")).toEqual([{ count: 2 }]);
    const r = await api('bob', 'POST', '/api/groups', { name: 'test-Huge', type: 'trip', currency: 'TWD', members: range(0, MAX_LINKS_PER_DAY + 1).map(person) });
    expect(r.status).toBe(429);
    expect(db.rows("SELECT id FROM groups WHERE name = 'test-Huge'")).toEqual([]);
  });
});
