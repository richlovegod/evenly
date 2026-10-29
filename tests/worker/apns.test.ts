// APNs (src/worker/services/apns.ts): the auth key read from Apple's .p8 PEM, the provider token
// (header, claims, a signature that verifies, the 50-minute reuse), the request (host per
// environment, headers, body) and what each answer means for the device's row. Keys are made in
// the test; fetch is stubbed.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromB64url } from '../../src/worker/http';
import {
  APNS_JWT_REUSE_S, apnsBody, apnsJwt, apnsMessageFor, apnsOutcome, forgetApnsJwt, loadApns, pkcs8FromPem, sendApns, type Apns, type ApnsMessage,
} from '../../src/worker/services/apns';
import { pushNotice, tapTarget, testNotice, type PushGroup, type PushItem } from '../../src/worker/services/pushText';

const subtle = crypto.subtle;
const text = new TextDecoder();

let pair: CryptoKeyPair;
let pem: string;

/** Apple's .p8 layout: the PKCS #8 DER in base64, 64 characters a line, between the PEM lines. */
function toPem(der: ArrayBuffer, eol = '\n'): string {
  const b64 = Buffer.from(der).toString('base64');
  return ['-----BEGIN PRIVATE KEY-----', ...(b64.match(/.{1,64}/g) ?? []), '-----END PRIVATE KEY-----'].join(eol);
}

const vars = (over: Record<string, string | undefined> = {}) => ({
  APNS_KEY_ID: 'U47HW6ZSNN', APNS_TEAM_ID: '7XHV5223X7', APNS_TOPIC: 'com.ginochang.evenly', APNS_AUTH_KEY: pem, ...over,
});

const part = (jwt: string, i: number) => JSON.parse(text.decode(fromB64url(jwt.split('.')[i])));

beforeAll(async () => {
  pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  pem = toPem((await subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
});

beforeEach(() => forgetApnsJwt());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loadApns', () => {
  it('reads the key from the PEM (also with CRLF, \\n written out, or the base64 alone)', async () => {
    const apns = await loadApns(vars());
    expect(apns).toMatchObject({ keyId: 'U47HW6ZSNN', teamId: '7XHV5223X7', topic: 'com.ginochang.evenly' });
    const der = new Uint8Array((await subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
    expect(pkcs8FromPem(pem)).toEqual(der);
    expect(pkcs8FromPem(pem.replace(/\n/g, '\r\n') + '\r\n')).toEqual(der);
    expect(pkcs8FromPem(pem.replace(/\n/g, '\\n'))).toEqual(der);
    expect(pkcs8FromPem(Buffer.from(der).toString('base64'))).toEqual(der);
    expect(await loadApns(vars({ APNS_AUTH_KEY: pem.replace(/\n/g, '\r\n') }))).not.toBeNull();
  });

  it('is off without every setting, and refuses ids and keys that are not Apple\'s, logging no part of the key', async () => {
    for (const k of ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC', 'APNS_AUTH_KEY']) expect(await loadApns(vars({ [k]: undefined }))).toBeNull();
    expect(await loadApns(vars({ APNS_AUTH_KEY: '  ' }))).toBeNull();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ecdh = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, true, ['deriveBits'])) as CryptoKeyPair;
    const otherCurve = toPem((await subtle.exportKey('pkcs8', ecdh.privateKey)) as ArrayBuffer);
    for (const bad of [
      vars({ APNS_KEY_ID: 'u47hw6zsnn' }),
      vars({ APNS_TEAM_ID: '7XHV5223X' }),
      vars({ APNS_AUTH_KEY: '-----BEGIN PRIVATE KEY-----\nnot base64!\n-----END PRIVATE KEY-----' }),
      vars({ APNS_AUTH_KEY: pem.replace(/[A-Za-z]{8}/, 'AAAAAAAA') }),
      vars({ APNS_AUTH_KEY: otherCurve }),
    ]) {
      expect(await loadApns(bad)).toBeNull();
    }
    const logged = errors.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toContain('push: the APNs key is not usable');
    for (const line of pem.split('\n').slice(1, -1)) expect(logged).not.toContain(line.slice(0, 16));
  });
});

describe('apnsJwt', () => {
  it('ES256 with kid and iss, iat in seconds, and a signature the public key verifies', async () => {
    const apns = (await loadApns(vars()))!;
    const now = Date.parse('2026-10-29T22:00:00.000Z');
    const jwt = await apnsJwt(apns, now);
    const [h, c, s] = jwt.split('.');
    expect(part(jwt, 0)).toEqual({ alg: 'ES256', kid: 'U47HW6ZSNN' });
    expect(part(jwt, 1)).toEqual({ iss: '7XHV5223X7', iat: now / 1000 });
    expect(Object.keys(part(jwt, 0))).toEqual(['alg', 'kid']);
    const sig = fromB64url(s);
    expect(sig).toHaveLength(64);
    expect(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, new TextEncoder().encode(h + '.' + c))).toBe(true);
    expect(jwt).not.toMatch(/[+/=]/);
  });

  it('is reused for 50 minutes, then signed again; a forgotten one is signed again at once', async () => {
    const apns = (await loadApns(vars()))!;
    const t0 = Date.parse('2026-10-29T22:00:00.000Z');
    const first = await apnsJwt(apns, t0);
    const [a, b] = await Promise.all([apnsJwt(apns, t0 + 1000), apnsJwt(apns, t0 + 1000)]);
    expect([a, b]).toEqual([first, first]);
    expect(await apnsJwt(apns, t0 + (APNS_JWT_REUSE_S - 1) * 1000)).toBe(first);
    const second = await apnsJwt(apns, t0 + APNS_JWT_REUSE_S * 1000);
    expect(second).not.toBe(first);
    expect(part(second, 1).iat).toBe(t0 / 1000 + APNS_JWT_REUSE_S);
    // A clock that went back, or another key, never gets the stored one.
    expect(await apnsJwt(apns, t0)).not.toBe(second);
    forgetApnsJwt();
    expect(part(await apnsJwt(apns, t0 + 5000), 1).iat).toBe(t0 / 1000 + 5);
    const other = { ...apns, keyId: 'ABCDE12345' } as Apns;
    expect(part(await apnsJwt(other, t0 + 5000), 0).kid).toBe('ABCDE12345');
  });
});

// ---------- the request ----------

describe('sendApns', () => {
  const msg = (over: Partial<ApnsMessage> = {}): ApnsMessage => ({
    token: 'ab'.repeat(32), environment: 'production', topic: 'com.ginochang.evenly', body: '{"aps":{}}', priority: 10, collapseId: 'g:g1', ...over,
  });
  let seen: Request[];
  let answer: () => Response | Promise<Response>;
  beforeEach(() => {
    seen = [];
    answer = () => new Response(null, { status: 200, headers: { 'apns-id': 'x' } });
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      seen.push(new Request(input, init));
      return answer();
    }));
  });

  it('POSTs to the production or the sandbox host with the provider token, topic, push type, priority, collapse id and a day to live', async () => {
    const apns = (await loadApns(vars()))!;
    const now = Date.parse('2026-10-29T22:00:00.000Z');
    expect(await sendApns(apns, msg(), now)).toEqual({ status: 200, reason: '' });
    expect(await sendApns(apns, msg({ environment: 'sandbox', priority: 5, collapseId: null }), now)).toEqual({ status: 200, reason: '' });
    expect(seen.map(r => [r.method, r.url, r.redirect])).toEqual([
      ['POST', 'https://api.push.apple.com/3/device/' + 'ab'.repeat(32), 'manual'],
      ['POST', 'https://api.sandbox.push.apple.com/3/device/' + 'ab'.repeat(32), 'manual'],
    ]);
    const h = Object.fromEntries(seen[0].headers);
    expect(h).toEqual({
      authorization: 'bearer ' + (await apnsJwt(apns, now)),
      'apns-topic': 'com.ginochang.evenly',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': 'g:g1',
      'apns-expiration': String(now / 1000 + 86_400),
      'content-type': 'application/json',
    });
    expect(part(h.authorization.slice('bearer '.length), 1)).toEqual({ iss: '7XHV5223X7', iat: now / 1000 });
    expect(await seen[0].text()).toBe('{"aps":{}}');
    const s = Object.fromEntries(seen[1].headers);
    expect(s['apns-priority']).toBe('5');
    expect('apns-collapse-id' in s).toBe(false);
  });

  it("reads APNs's reason, letters only, and answers 0 when nothing comes back", async () => {
    const apns = (await loadApns(vars()))!;
    answer = () => new Response('{"reason":"BadDeviceToken"}', { status: 400 });
    expect(await sendApns(apns, msg())).toEqual({ status: 400, reason: 'BadDeviceToken' });
    answer = () => new Response('{"reason":"Unregistered","timestamp":1793313540000}', { status: 410 });
    expect(await sendApns(apns, msg())).toEqual({ status: 410, reason: 'Unregistered' });
    answer = () => new Response('{"reason":"Bad <script>"}', { status: 400 });
    expect(await sendApns(apns, msg())).toEqual({ status: 400, reason: '' });
    answer = () => new Response('Service Unavailable', { status: 503 });
    expect(await sendApns(apns, msg())).toEqual({ status: 503, reason: '' });
    answer = () => Promise.reject(new TypeError('Network connection lost.'));
    expect(await sendApns(apns, msg())).toEqual({ status: 0, reason: '' });
  });
});

describe('apnsOutcome: what each answer does to the iPhone', () => {
  it("gone for a token that is no good, failed for what may pass, refused for what is the server's own fault", () => {
    const cases: [number, string, string][] = [
      [200, '', 'ok'],
      [410, 'Unregistered', 'gone'],
      [410, 'ExpiredToken', 'gone'],
      [400, 'BadDeviceToken', 'gone'],
      [400, 'DeviceTokenNotForTopic', 'gone'],
      [500, 'InternalServerError', 'failed'],
      [503, 'ServiceUnavailable', 'failed'],
      [429, 'TooManyRequests', 'failed'],
      [0, '', 'failed'],
      [403, 'InvalidProviderToken', 'refused'],
      [403, 'ExpiredProviderToken', 'refused'],
      [403, 'MissingProviderToken', 'refused'],
      [429, 'TooManyProviderTokenUpdates', 'refused'],
      [400, 'BadTopic', 'refused'],
      [400, 'TopicDisallowed', 'refused'],
      [400, 'BadCollapseId', 'refused'],
      [400, 'BadPriority', 'refused'],
      [400, '', 'refused'],
      [404, 'BadPath', 'refused'],
      [405, 'MethodNotAllowed', 'refused'],
      [413, 'PayloadTooLarge', 'refused'],
    ];
    for (const [status, reason, outcome] of cases) expect([status, reason, apnsOutcome({ status, reason })]).toEqual([status, reason, outcome]);
  });
});

// ---------- the payload ----------

const G: PushGroup = { id: 'g1', name: 'test-東京行', emoji: '🍣', type: 'trip' };
const PAIR: PushGroup = { id: 'g2', name: 'Gino & Abbie', emoji: '', type: 'pair' };
const abbie = { id: 'mA', name: 'Abbie' };
const gino = { id: 'mG', name: 'Gino' };
const leo = { id: 'mL', name: 'Leo' };
const expense = (over: Partial<Extract<PushItem, { kind: 'expense' }>> = {}): PushItem => ({
  kind: 'expense', actor: abbie, expenseId: 'e1', description: '燒肉晚餐', amount: 12600, currency: 'JPY', nets: { mA: 9450, mL: -3150 }, groupCurrency: 'JPY', ...over,
});
const zh = { memberId: 'mL', locale: 'zh-TW' as const };
const en = { memberId: 'mL', locale: 'en' as const };
/** The APNs body for one recipient, parsed. */
const apnsOf = (group: PushGroup, items: PushItem[], me: { memberId: string; locale: 'zh-TW' | 'en' } = zh) => JSON.parse(apnsBody(pushNotice(group, items, me)!));

describe('the APNs payload of each kind of notification', () => {
  it('is exactly aps.alert, the default sound and the thread-id, and the route: no badge', () => {
    const json = apnsBody(pushNotice(G, [expense()], zh)!);
    expect(json.startsWith('{"aps":{"alert":{"title":"🍣 test-東京行","body":"Abbie 新增了「燒肉晚餐」 ¥12,600')).toBe(true);
    expect(json.endsWith('"},"sound":"default","thread-id":"g1"},"route":"group/g1/expense/e1"}')).toBe(true);
    expect(JSON.parse(json).aps.alert.body).toBe('Abbie 新增了「燒肉晚餐」 ¥12,600\n你借入 ¥3,150');
    expect(apnsOf(G, [expense()], en)).toEqual({
      aps: { alert: { title: '🍣 test-東京行', body: 'Abbie added "燒肉晚餐" (¥12,600)\nYou borrowed ¥3,150' }, sound: 'default', 'thread-id': 'g1' },
      route: 'group/g1/expense/e1',
    });
  });

  it('one entry opens it; everything else opens the group', () => {
    const cases: [string, PushGroup, PushItem[], string, string, string][] = [
      ['an expense', G, [expense()], '🍣 test-東京行', 'Abbie 新增了「燒肉晚餐」 ¥12,600\n你借入 ¥3,150', 'group/g1/expense/e1'],
      [
        'a refund', G, [expense({ actor: gino, expenseId: 'r1', description: '退款：押金', amount: 30000, refund: true, nets: { mG: -22500, mL: 7500 } })],
        '🍣 test-東京行', 'Gino 新增了退款「押金」 ¥30,000\n你可以拿回 ¥7,500', 'group/g1/expense/r1',
      ],
      [
        'a payment', G, [{ kind: 'payment', actor: abbie, expenseId: 'p1', from: leo, to: abbie, amount: 500, currency: 'TWD' }],
        '🍣 test-東京行', 'Abbie 記錄了你的還款\n你付出 NT$500', 'group/g1/expense/p1',
      ],
      ['a join', G, [{ kind: 'join', name: 'Abbie' }], '🍣 test-東京行', 'Abbie 加入了群組', 'group/g1'],
      ['being added', G, [{ kind: 'add', actor: gino }], '🍣 test-東京行', 'Gino 把你加進了群組', 'group/g1'],
      ['a new group', G, [{ kind: 'create', actor: gino }], '🍣 test-東京行', 'Gino 建立了群組，也把你加了進去', 'group/g1'],
      ['a new 1:1 ledger', PAIR, [{ kind: 'create', actor: gino }], '兩人帳本', 'Gino 開始了跟你的兩人帳本', 'group/g2'],
      ['a Splitwise import', G, [{ kind: 'import', actor: gino, count: 500 }], '🍣 test-東京行', 'Gino 匯入了 500 筆費用', 'group/g1'],
      ['a friend invite accepted', PAIR, [{ kind: 'invite', actor: abbie }], '兩人帳本', 'Abbie 透過你的邀請連結加入\n你們現在是朋友了', 'group/g2'],
      ['several entries', G, [expense(), expense({ expenseId: 'e2', nets: { mL: -1000 } })], '🍣 test-東京行', 'Abbie 新增了 2 筆費用\n你借入 ¥4,150', 'group/g1'],
      ['several things', G, [{ kind: 'create', actor: gino }, expense({ actor: gino })], '🍣 test-東京行', 'Gino 建立了群組，也把你加了進去\n還有 1 筆新動態', 'group/g1'],
    ];
    for (const [name, group, items, title, body, route] of cases) {
      expect([name, apnsOf(group, items)]).toEqual([name, { aps: { alert: { title, body }, sound: 'default', 'thread-id': group.id }, route }]);
    }
  });

  it('the test notification opens 我的 and belongs to no group', () => {
    expect(JSON.parse(apnsBody(testNotice('zh-TW')))).toEqual({
      aps: { alert: { title: '吉諾分帳所', body: '測試通知：看得到這則，就表示這台裝置收得到通知。' }, sound: 'default' },
      route: 'account',
    });
    expect(JSON.parse(apnsBody(testNotice('en'))).aps.alert.title).toBe("Gino's Split Lab");
  });

  it('the route and the web path name the same place', () => {
    expect(tapTarget('g1')).toEqual({ path: '/g/g1', route: 'group/g1' });
    expect(tapTarget('6f1c2d1e-0000-4000-8000-000000000001', 'exp-0001')).toEqual({
      path: '/g/6f1c2d1e-0000-4000-8000-000000000001/e/exp-0001',
      route: 'group/6f1c2d1e-0000-4000-8000-000000000001/expense/exp-0001',
    });
    for (const items of [[expense()], [{ kind: 'join', name: 'Abbie' }] as PushItem[], [expense(), expense({ expenseId: 'e2' })]]) {
      const n = pushNotice(G, items, zh)!;
      expect(n.route).toBe(n.payload.path.replace(/^\/g\//, 'group/').replace('/e/', '/expense/'));
      expect(n.groupId).toBe('g1');
    }
  });
});

describe('apnsMessageFor', () => {
  it('a stored iPhone as a message: the import summary at priority 5, a row it cannot use as null', () => {
    const d = { id: 'ab'.repeat(32), environment: 'sandbox', bundle_id: 'com.ginochang.evenly' };
    expect(apnsMessageFor(d, '{}', 'normal', 'g:g1')).toEqual({ token: d.id, environment: 'sandbox', topic: 'com.ginochang.evenly', body: '{}', priority: 10, collapseId: 'g:g1' });
    expect(apnsMessageFor(d, '{}', 'low', null)?.priority).toBe(5);
    expect(apnsMessageFor({ ...d, environment: 'development' }, '{}', 'normal', null)).toBeNull();
    expect(apnsMessageFor({ ...d, id: 'AB'.repeat(32) }, '{}', 'normal', null)).toBeNull();
    expect(apnsMessageFor({ ...d, id: 'ab'.repeat(31) + 'a' }, '{}', 'normal', null)).toBeNull();
    expect(apnsMessageFor({ ...d, id: 'ab'.repeat(31) }, '{}', 'normal', null)).toBeNull();
    expect(apnsMessageFor({ ...d, bundle_id: '' }, '{}', 'normal', null)).toBeNull();
  });
});
