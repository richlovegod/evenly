// Web Push on WebCrypto alone: the message encryption of RFC 8291 (the aes128gcm content coding of
// RFC 8188) and the VAPID signature of RFC 8292. RFC 8291 needs a new ECDH key pair for every
// message; the VAPID JWT is signed once per push service and reused for about 12 hours, so one
// message costs a key pair, one ECDH, a few HMACs and one AES-GCM. tests/worker/webpush.test.ts
// checks the encryption against the RFC 8291 Appendix A example.

import type { Env } from '../env';
import { b64url, fromB64url } from '../http';

const enc = new TextEncoder();

/** aes128gcm record size: every message is a single record (RFC 8291 section 4). */
const RECORD_SIZE = 4096;
/** The most plaintext one message carries: 4096 bytes less the 86-byte header, the delimiter and the tag. */
export const MAX_PLAINTEXT = 3993;
/** How long a push service keeps a message for a phone that is off or offline. */
export const PUSH_TTL_SECONDS = 86_400;
/** VAPID tokens live 12 hours (RFC 8292 allows at most 24) and are renewed when under an hour is left. */
const JWT_LIFETIME_S = 12 * 3600;
const JWT_RENEW_S = 3600;
const SEND_TIMEOUT_MS = 10_000;

/** An info string of RFC 8291 and RFC 8188: the ASCII text and a zero byte. */
function info(text: string): Uint8Array {
  const t = enc.encode(text);
  const out = new Uint8Array(t.length + 1);
  out.set(t);
  return out;
}

const KEY_INFO = info('WebPush: info');
const CEK_INFO = info('Content-Encoding: aes128gcm');
const NONCE_INFO = info('Content-Encoding: nonce');

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------- encryption (RFC 8291) ----------

export interface PushKeys {
  /** The browser's ECDH P-256 public key, uncompressed (65 bytes: 0x04, x, y). */
  p256dh: Uint8Array;
  /** The browser's 16-byte authentication secret. */
  auth: Uint8Array;
}

/** Fixed inputs for the RFC 8291 Appendix A example; real messages leave both out. */
export interface EncryptOptions {
  local?: CryptoKeyPair;
  salt?: Uint8Array;
}

/**
 * Encrypt one message for one subscription (RFC 8291 section 3.4). Returns the request body: the
 * 86-byte aes128gcm header (salt, record size, the sender's public key as keyid), then the one
 * record (the plaintext and the 0x02 delimiter, no padding) sealed with AES-128-GCM.
 */
export async function encryptPush(plaintext: Uint8Array, keys: PushKeys, opts: EncryptOptions = {}): Promise<Uint8Array> {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('push payload is too large');
  const subtle = crypto.subtle;
  const local = opts.local ?? ((await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const peer = await subtle.importKey('raw', keys.p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const [rawPublic, ecdh] = await Promise.all([
    subtle.exportKey('raw', local.publicKey) as Promise<ArrayBuffer>,
    // workers-types call this member `$public`; the runtime, like every WebCrypto, reads `public`.
    subtle.deriveBits({ name: 'ECDH', public: peer } as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256),
  ]);
  const asPublic = new Uint8Array(rawPublic);
  // IKM = HKDF(salt: auth secret, key: ECDH secret, info: "WebPush: info" 0x00 ua_public as_public), 32 bytes.
  const shared = await subtle.importKey('raw', ecdh, 'HKDF', false, ['deriveBits']);
  const ikm = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: keys.auth, info: concat(KEY_INFO, keys.p256dh, asPublic) },
    shared,
    256,
  );
  // CEK and NONCE from HKDF(salt: the message salt, key: IKM) as RFC 8188 section 2.2 and 2.3 do.
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const [cek, nonce] = await Promise.all([
    subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: CEK_INFO }, prk, 128),
    subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: NONCE_INFO }, prk, 96),
  ]);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = new Uint8Array(plaintext.length + 1);
  record.set(plaintext);
  record[plaintext.length] = 2; // delimiter of the last record
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, record));
  // Header (RFC 8188 section 2.1): salt (16) || rs (uint32) || idlen (1) || keyid (65).
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

// ---------- VAPID (RFC 8292) ----------

export interface Vapid {
  /** The application server key the browsers subscribed with (base64url): the k= parameter. */
  publicKey: string;
  /** How a push service reaches the sender (mailto: or https:), the JWT sub claim. */
  subject: string;
  /** ECDSA P-256 private key from the VAPID_PRIVATE_JWK secret. */
  key: CryptoKey;
}

let vapidMemo: { source: string; vapid: Promise<Vapid | null> } | null = null;

/**
 * The VAPID keys from the env, imported once per isolate. Null when push is not set up: a
 * variable is missing, the secret is not a P-256 private JWK, or it is not the private half of
 * VAPID_PUBLIC_KEY (every push would then fail, and failing subscriptions get deleted).
 */
export function loadVapid(env: Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_SUBJECT' | 'VAPID_PRIVATE_JWK'>): Promise<Vapid | null> {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? '').trim();
  const subject = (env.VAPID_SUBJECT ?? '').trim();
  const jwk = env.VAPID_PRIVATE_JWK ?? '';
  if (!publicKey || !subject || !jwk) return Promise.resolve(null);
  const source = publicKey + '\n' + subject + '\n' + jwk;
  if (vapidMemo?.source !== source) vapidMemo = { source, vapid: importVapid(publicKey, subject, jwk) };
  return vapidMemo.vapid;
}

/** Logs a fixed message only: an error from JSON.parse or importKey could quote the secret. */
function unusable(why: string): null {
  console.error('push: VAPID keys are not usable: ' + why);
  return null;
}

async function importVapid(publicKey: string, subject: string, jwkText: string): Promise<Vapid | null> {
  let jwk: Partial<JsonWebKey>;
  try {
    jwk = JSON.parse(jwkText) as Partial<JsonWebKey>;
  } catch {
    return unusable('VAPID_PRIVATE_JWK is not JSON');
  }
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    return unusable('VAPID_PRIVATE_JWK is not a P-256 private key');
  }
  try {
    const pub = fromB64url(publicKey);
    const matches = pub.length === 65 && pub[0] === 4 && sameBytes(fromB64url(jwk.x), pub.subarray(1, 33)) && sameBytes(fromB64url(jwk.y), pub.subarray(33));
    if (!matches) return unusable('VAPID_PRIVATE_JWK is not the private half of VAPID_PUBLIC_KEY');
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    return { publicKey, subject, key };
  } catch {
    return unusable('the key could not be imported');
  }
}

const JWT_HEADER = b64url(enc.encode('{"typ":"JWT","alg":"ES256"}'));
/** Signed JWTs per public key and audience (a push service origin), with their expiry in seconds. */
const jwtMemo = new Map<string, { exp: number; token: Promise<string> }>();

async function signJwt(vapid: Vapid, aud: string, exp: number): Promise<string> {
  const input = JWT_HEADER + '.' + b64url(enc.encode(JSON.stringify({ aud, exp, sub: vapid.subject })));
  // WebCrypto's ECDSA signature is already r || s (64 bytes), the form JWS needs (RFC 7518 3.4).
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.key, enc.encode(input));
  return input + '.' + b64url(new Uint8Array(sig));
}

/** `vapid t=<JWT>, k=<public key>` for the push service of `endpoint` (RFC 8292 section 3). */
export async function vapidAuthorization(vapid: Vapid, endpoint: string, nowMs = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const memoKey = vapid.publicKey + ' ' + aud;
  const now = Math.floor(nowMs / 1000);
  let hit = jwtMemo.get(memoKey);
  if (!hit || hit.exp - now < JWT_RENEW_S || hit.exp - now > JWT_LIFETIME_S) {
    const fresh = { exp: now + JWT_LIFETIME_S, token: signJwt(vapid, aud, now + JWT_LIFETIME_S) };
    fresh.token.catch(() => {
      if (jwtMemo.get(memoKey) === fresh) jwtMemo.delete(memoKey);
    });
    jwtMemo.set(memoKey, fresh);
    hit = fresh;
  }
  return `vapid t=${await hit.token}, k=${vapid.publicKey}`;
}

// ---------- sending (RFC 8030) ----------

/** One message for one subscription. */
export interface PushMessage {
  endpoint: string;
  keys: PushKeys;
  /** UTF-8 JSON for the service worker (PushPayload). */
  payload: Uint8Array;
  /** 'low' lets the push service wait for a good moment (the import summary). */
  urgency: 'normal' | 'low';
}

/**
 * POST one message to its push service. Returns the HTTP status (201 when accepted; 404 and 410
 * mean the subscription is gone), or 0 when no answer came (network error, timeout) or the
 * message could not be encrypted.
 */
export async function sendPush(vapid: Vapid, m: PushMessage, nowMs = Date.now()): Promise<number> {
  try {
    const [body, authorization] = await Promise.all([encryptPush(m.payload, m.keys), vapidAuthorization(vapid, m.endpoint, nowMs)]);
    const res = await fetch(m.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: m.urgency,
      },
      body,
      // A push service never redirects; following one could reach a host the allowlist refused.
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // Nothing in the answer is needed: let the connection go.
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return 0;
  }
}
