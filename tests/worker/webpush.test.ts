// Web Push crypto (src/worker/services/webpush.ts): the aes128gcm encryption against the example of
// RFC 8291 (section 5 and Appendix A, copied from https://www.rfc-editor.org/rfc/rfc8291.txt), a
// round trip that decrypts with the receiver's private key as a browser would (RFC 8188 / 8291,
// with HKDF written out in HMACs from node:crypto, independent of the code under test), the VAPID
// JWT (RFC 8292) and the request sendPush makes.

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { b64url, fromB64url } from '../../src/worker/http';
import { encryptPush, loadVapid, MAX_PLAINTEXT, sendPush, vapidAuthorization, type Vapid } from '../../src/worker/services/webpush';

const subtle = crypto.subtle;
const utf8 = new TextEncoder();
const text = new TextDecoder();

// ---------- RFC 8291 Appendix A (whitespace removed) ----------

const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  plaintextB64: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  keyInfo:
    'V2ViUHVzaDogaW5mbwAEJXGyvs3942BVGq8e0PTNNmwRzr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3' +
    'ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0EwbZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAvMBKiiujwa7t45ewP',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cekInfo: 'Q29udGVudC1FbmNvZGluZzogYWVzMTI4Z2NtAA',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonceInfo: 'Q29udGVudC1FbmNvZGluZzogbm9uY2UA',
  nonce: '4h_95klXJ5E_qnoN',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  paddedPlaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24C',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  // Section 5: the whole request body (header || ciphertext).
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const hmac = (key: Uint8Array, data: Uint8Array): Uint8Array => new Uint8Array(createHmac('sha256', key).update(data).digest());
const label = (s: string): Uint8Array => concat(utf8.encode(s), new Uint8Array([0]));

/** A P-256 ECDH private key from its raw scalar and public point. */
async function ecdhPrivate(d: string, publicRaw: Uint8Array): Promise<CryptoKey> {
  const jwk = { kty: 'EC', crv: 'P-256', d, x: b64url(publicRaw.slice(1, 33)), y: b64url(publicRaw.slice(33)) };
  return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

interface Decrypted {
  plaintext: Uint8Array;
  salt: Uint8Array;
  rs: number;
  keyid: Uint8Array;
  ecdh: Uint8Array;
  prkKey: Uint8Array;
  ikm: Uint8Array;
  prk: Uint8Array;
  cek: Uint8Array;
  nonce: Uint8Array;
}

/** What a browser does with a push message (RFC 8291 section 3.4, receiver side; one record). */
async function decryptPush(body: Uint8Array, uaPrivate: CryptoKey, uaPublic: Uint8Array, auth: Uint8Array): Promise<Decrypted> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const keyid = body.slice(21, 21 + idlen);
  const sealed = body.slice(21 + idlen);
  expect(sealed.length).toBeLessThanOrEqual(rs);
  const asPublic = await subtle.importKey('raw', keyid, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asPublic }, uaPrivate, 256));
  const prkKey = hmac(auth, ecdh);
  const ikm = hmac(prkKey, concat(label('WebPush: info'), uaPublic, keyid, new Uint8Array([1])));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, concat(label('Content-Encoding: aes128gcm'), new Uint8Array([1]))).slice(0, 16);
  const nonce = hmac(prk, concat(label('Content-Encoding: nonce'), new Uint8Array([1]))).slice(0, 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, sealed));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('the last record must end with the delimiter 0x02');
  return { plaintext: padded.slice(0, end), salt, rs, keyid, ecdh, prkKey, ikm, prk, cek, nonce };
}

async function rfcSender(): Promise<CryptoKeyPair> {
  const publicRaw = fromB64url(RFC.asPublic);
  return {
    privateKey: await ecdhPrivate(RFC.asPrivate, publicRaw),
    publicKey: await subtle.importKey('raw', publicRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
}

describe('encryptPush: RFC 8291 Appendix A', () => {
  it('reproduces the example message byte for byte with the example key pair and salt', async () => {
    const body = await encryptPush(utf8.encode(RFC.plaintext), { p256dh: fromB64url(RFC.uaPublic), auth: fromB64url(RFC.auth) }, {
      local: await rfcSender(),
      salt: fromB64url(RFC.salt),
    });
    expect(b64url(body.slice(0, 86))).toBe(RFC.header);
    expect(b64url(body.slice(86))).toBe(RFC.ciphertext);
    expect(b64url(body)).toBe(RFC.body);
    expect(body.length).toBe(86 + RFC.plaintext.length + 1 + 16);
  });

  it('decrypts the example with the receiver key, through every intermediate value of Appendix A', async () => {
    const uaPublic = fromB64url(RFC.uaPublic);
    const uaPrivate = await ecdhPrivate(RFC.uaPrivate, uaPublic);
    const d = await decryptPush(fromB64url(RFC.body), uaPrivate, uaPublic, fromB64url(RFC.auth));
    expect(b64url(d.salt)).toBe(RFC.salt);
    expect(d.rs).toBe(4096);
    expect(b64url(d.keyid)).toBe(RFC.asPublic);
    expect(b64url(d.ecdh)).toBe(RFC.ecdhSecret);
    expect(b64url(d.prkKey)).toBe(RFC.prkKey);
    expect(b64url(concat(label('WebPush: info'), uaPublic, d.keyid))).toBe(RFC.keyInfo);
    expect(b64url(d.ikm)).toBe(RFC.ikm);
    expect(b64url(d.prk)).toBe(RFC.prk);
    expect(b64url(label('Content-Encoding: aes128gcm'))).toBe(RFC.cekInfo);
    expect(b64url(d.cek)).toBe(RFC.cek);
    expect(b64url(label('Content-Encoding: nonce'))).toBe(RFC.nonceInfo);
    expect(b64url(d.nonce)).toBe(RFC.nonce);
    expect(b64url(concat(d.plaintext, new Uint8Array([2])))).toBe(RFC.paddedPlaintext);
    expect(b64url(d.plaintext)).toBe(RFC.plaintextB64);
    expect(text.decode(d.plaintext)).toBe(RFC.plaintext);
  });
});

/** A browser's subscription keys: a fresh P-256 pair and a random auth secret. */
async function receiver(): Promise<{ privateKey: CryptoKey; publicRaw: Uint8Array; auth: Uint8Array }> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicRaw: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)),
    auth: crypto.getRandomValues(new Uint8Array(16)),
  };
}

describe('encryptPush: round trip', () => {
  it('decrypts with the receiver private key to the same JSON, with a new key pair and salt every time', async () => {
    const ua = await receiver();
    const payload = utf8.encode(JSON.stringify({ title: '🍣 東京行', body: 'Abbie 新增了「燒肉晚餐」 ¥12,600\n你借入 ¥3,150', path: '/g/g1/e/e1', tag: 'g:g1' }));
    const keys = { p256dh: ua.publicRaw, auth: ua.auth };
    const a = await encryptPush(payload, keys);
    const b = await encryptPush(payload, keys);
    for (const body of [a, b]) {
      expect(body.length).toBe(86 + payload.length + 17);
      expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)).toBe(4096);
      expect(body[20]).toBe(65);
      expect(body[21]).toBe(4);
      const d = await decryptPush(body, ua.privateKey, ua.publicRaw, ua.auth);
      expect(JSON.parse(text.decode(d.plaintext))).toEqual(JSON.parse(text.decode(payload)));
    }
    expect(b64url(a.slice(0, 16))).not.toBe(b64url(b.slice(0, 16))); // salt
    expect(b64url(a.slice(21, 86))).not.toBe(b64url(b.slice(21, 86))); // sender key
  });

  it('fails to decrypt with another auth secret (the message is authenticated)', async () => {
    const ua = await receiver();
    const body = await encryptPush(utf8.encode('hello'), { p256dh: ua.publicRaw, auth: ua.auth });
    await expect(decryptPush(body, ua.privateKey, ua.publicRaw, crypto.getRandomValues(new Uint8Array(16)))).rejects.toThrow();
  });

  it('takes up to 3993 bytes, a full 4096-byte record, and refuses more', async () => {
    const ua = await receiver();
    const keys = { p256dh: ua.publicRaw, auth: ua.auth };
    const max = new Uint8Array(MAX_PLAINTEXT).fill(0x61);
    const body = await encryptPush(max, keys);
    expect(body.length).toBe(4096);
    expect((await decryptPush(body, ua.privateKey, ua.publicRaw, ua.auth)).plaintext.length).toBe(MAX_PLAINTEXT);
    await expect(encryptPush(new Uint8Array(MAX_PLAINTEXT + 1), keys)).rejects.toThrow(/too large/);
  });

  it('refuses a public key that is not a P-256 point', async () => {
    const bad = new Uint8Array(65).fill(7);
    bad[0] = 4;
    await expect(encryptPush(utf8.encode('x'), { p256dh: bad, auth: new Uint8Array(16) })).rejects.toThrow();
  });
});

// ---------- VAPID ----------

async function vapidEnv(subject = 'mailto:gino@ginochang.com') {
  const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const publicRaw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return {
    env: {
      VAPID_PUBLIC_KEY: b64url(publicRaw),
      VAPID_SUBJECT: subject,
      VAPID_PRIVATE_JWK: JSON.stringify({ kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }),
    },
    publicKey: pair.publicKey,
    d: jwk.d!,
  };
}

function decodeJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; input: string; sig: Uint8Array } {
  const [h, c, s] = token.split('.');
  return {
    header: JSON.parse(text.decode(fromB64url(h))),
    claims: JSON.parse(text.decode(fromB64url(c))),
    input: h + '.' + c,
    sig: fromB64url(s),
  };
}

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

describe('VAPID (RFC 8292)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('signs an ES256 JWT for the push service origin, valid 12 hours, and sends the public key as k', async () => {
    const v = await vapidEnv();
    const vapid = (await loadVapid(v.env))!;
    expect(vapid).not.toBeNull();
    const header = await vapidAuthorization(vapid, 'https://web.push.apple.com/QGuQyavXutnMH6Kz4uOV?x=1', NOW);
    const m = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(header);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(v.env.VAPID_PUBLIC_KEY);
    const jwt = decodeJwt(m![1]);
    expect(jwt.header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(jwt.claims).toEqual({ aud: 'https://web.push.apple.com', exp: NOW / 1000 + 12 * 3600, sub: 'mailto:gino@ginochang.com' });
    expect(Number(jwt.claims.exp) - NOW / 1000).toBeLessThanOrEqual(24 * 3600);
    // JWS ES256 is the raw r || s pair, which is what WebCrypto verifies.
    expect(jwt.sig.length).toBe(64);
    expect(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, v.publicKey, jwt.sig, utf8.encode(jwt.input))).toBe(true);
  });

  it('reuses the JWT per audience and signs a new one when under an hour is left', async () => {
    const vapid = (await loadVapid((await vapidEnv()).env))!;
    const sign = vi.spyOn(crypto.subtle, 'sign');
    const a1 = await vapidAuthorization(vapid, 'https://fcm.googleapis.com/fcm/send/abc', NOW);
    const a2 = await vapidAuthorization(vapid, 'https://fcm.googleapis.com/fcm/send/def', NOW + 60_000);
    expect(a2).toBe(a1);
    const other = await vapidAuthorization(vapid, 'https://updates.push.services.mozilla.com/wpush/v2/x', NOW);
    expect(other).not.toBe(a1);
    expect(decodeJwt(other.slice(8, other.indexOf(','))).claims.aud).toBe('https://updates.push.services.mozilla.com');
    const later = await vapidAuthorization(vapid, 'https://fcm.googleapis.com/fcm/send/abc', NOW + 11.5 * 3600_000);
    expect(later).not.toBe(a1);
    expect(sign).toHaveBeenCalledTimes(3);
    // Signing at the same time for many messages to one service still signs once.
    sign.mockClear();
    const many = await Promise.all([1, 2, 3, 4].map(i => vapidAuthorization(vapid, 'https://web.push.apple.com/' + i, NOW)));
    expect(new Set(many).size).toBe(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('is off when a variable is missing, the JWK is not one, or the halves do not match, and never logs the key', async () => {
    const v = await vapidEnv();
    const other = await vapidEnv();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await loadVapid({ ...v.env, VAPID_PRIVATE_JWK: undefined })).toBeNull();
    expect(await loadVapid({ ...v.env, VAPID_PUBLIC_KEY: '' })).toBeNull();
    expect(await loadVapid({ ...v.env, VAPID_SUBJECT: undefined })).toBeNull();
    expect(await loadVapid({ ...v.env, VAPID_PRIVATE_JWK: 'not json ' + v.d })).toBeNull();
    expect(await loadVapid({ ...v.env, VAPID_PRIVATE_JWK: JSON.stringify({ kty: 'RSA', d: v.d }) })).toBeNull();
    expect(await loadVapid({ ...v.env, VAPID_PRIVATE_JWK: other.env.VAPID_PRIVATE_JWK })).toBeNull();
    expect(errors).toHaveBeenCalledTimes(3);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain(v.d);
    expect(logged).not.toContain(other.d);
    expect(await loadVapid(v.env)).not.toBeNull();
  });
});

// ---------- sendPush ----------

describe('sendPush', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the encrypted message with the Web Push headers and returns the status', async () => {
    const vapid = (await loadVapid((await vapidEnv()).env)) as Vapid;
    const ua = await receiver();
    const seen: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(null, { status: 201 });
    }));
    const payload = utf8.encode(JSON.stringify({ title: 't', body: 'b', path: '/', tag: 'g:1' }));
    const endpoint = 'https://web.push.apple.com/QGuQyavXutnMH6Kz4uOV';
    const status = await sendPush(vapid, { endpoint, keys: { p256dh: ua.publicRaw, auth: ua.auth }, payload, urgency: 'low' }, NOW);
    expect(status).toBe(201);
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe(endpoint);
    expect(req.headers.get('content-encoding')).toBe('aes128gcm');
    expect(req.headers.get('content-type')).toBe('application/octet-stream');
    expect(req.headers.get('ttl')).toBe('86400');
    expect(req.headers.get('urgency')).toBe('low');
    expect(req.headers.get('authorization')).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const d = await decryptPush(new Uint8Array(await req.arrayBuffer()), ua.privateKey, ua.publicRaw, ua.auth);
    expect(text.decode(d.plaintext)).toBe(text.decode(payload));
  });

  it('returns the push service status, and 0 when the request fails', async () => {
    const vapid = (await loadVapid((await vapidEnv()).env)) as Vapid;
    const ua = await receiver();
    const m = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: ua.publicRaw, auth: ua.auth }, payload: utf8.encode('{}'), urgency: 'normal' as const };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 410 })));
    expect(await sendPush(vapid, m, NOW)).toBe(410);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down');
    }));
    expect(await sendPush(vapid, m, NOW)).toBe(0);
    expect(await sendPush(vapid, { ...m, keys: { p256dh: new Uint8Array(65), auth: ua.auth } }, NOW)).toBe(0);
  });
});
