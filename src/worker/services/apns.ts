// Apple Push Notification service (APNs): the iPhone app's channel of the push sender
// (services/push.ts), beside Web Push (webpush.ts). The same events, words, prefs, hold and budget
// reach both; only the delivery differs. Token-based authentication: an ES256 JWT (header alg and
// kid APNS_KEY_ID, claims iss APNS_TEAM_ID and iat) signed with the APNs auth key, Apple's .p8 file
// (a PKCS #8 P-256 private key in PEM) in the APNS_AUTH_KEY secret. An isolate signs one token and
// uses it for 50 minutes: Apple refuses one older than an hour (ExpiredProviderToken) and one
// renewed more often than every 20 minutes (TooManyProviderTokenUpdates). One HTTP/2 POST per
// device to api.push.apple.com, or api.sandbox.push.apple.com for the tokens of development builds.
// WebCrypto only, no dependency; tests/worker/apns.test.ts.

import type { Env } from '../env';
import { b64url } from '../http';
import type { PushNotice } from './pushText';
import { PUSH_TTL_SECONDS } from './webpush';

const enc = new TextEncoder();

export const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;
export type ApnsEnvironment = keyof typeof APNS_HOSTS;

/** How long an isolate uses one provider token (Apple: at least hourly, at most every 20 minutes). */
export const APNS_JWT_REUSE_S = 50 * 60;
const SEND_TIMEOUT_MS = 10_000;
/** Apple's key ids and team ids: 10 characters, A to Z and 0 to 9. */
const APPLE_ID_RE = /^[A-Z0-9]{10}$/;
/** A device token as stored: lowercase hex, 32 bytes today (Apple says the length may change). */
export const APNS_TOKEN_RE = /^(?:[0-9a-f]{2}){32,100}$/;

export interface Apns {
  keyId: string;
  teamId: string;
  /** The app's bundle id (APNS_TOPIC): the only one PUT /api/push/apns stores. */
  topic: string;
  /** ECDSA P-256 private key from the APNS_AUTH_KEY secret. */
  key: CryptoKey;
}

let apnsMemo: { source: string; apns: Promise<Apns | null> } | null = null;

/**
 * The APNs settings from the env, the key imported once per isolate. Null when APNs is not set up:
 * a variable or the secret is missing, an id is not one of Apple's, or the secret is not a P-256
 * private key in PEM.
 */
export function loadApns(env: Pick<Env, 'APNS_KEY_ID' | 'APNS_TEAM_ID' | 'APNS_TOPIC' | 'APNS_AUTH_KEY'>): Promise<Apns | null> {
  const keyId = (env.APNS_KEY_ID ?? '').trim();
  const teamId = (env.APNS_TEAM_ID ?? '').trim();
  const topic = (env.APNS_TOPIC ?? '').trim();
  const pem = env.APNS_AUTH_KEY ?? '';
  if (!keyId || !teamId || !topic || !pem.trim()) return Promise.resolve(null);
  const source = [keyId, teamId, topic, pem].join('\n');
  if (apnsMemo?.source !== source) apnsMemo = { source, apns: importApns(keyId, teamId, topic, pem) };
  return apnsMemo.apns;
}

/** Logs a fixed message only: an error from atob or importKey could quote the secret. */
function unusable(why: string): null {
  console.error('push: the APNs key is not usable: ' + why);
  return null;
}

/**
 * The DER bytes of a PEM private key (Apple's .p8: "-----BEGIN PRIVATE KEY-----", base64 lines,
 * "-----END PRIVATE KEY-----"), or null. Also takes the base64 alone, and line breaks written as
 * the two characters \n (a secret pasted from JSON).
 */
export function pkcs8FromPem(pem: string): Uint8Array | null {
  const text = pem.replace(/\\n/g, '\n');
  const m = /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/.exec(text);
  const b64 = (m ? m[1] : text).replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function importApns(keyId: string, teamId: string, topic: string, pem: string): Promise<Apns | null> {
  if (!APPLE_ID_RE.test(keyId)) return unusable('APNS_KEY_ID is not an Apple key id');
  if (!APPLE_ID_RE.test(teamId)) return unusable('APNS_TEAM_ID is not an Apple team id');
  const der = pkcs8FromPem(pem);
  if (!der) return unusable('APNS_AUTH_KEY is not a PEM private key');
  try {
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { keyId, teamId, topic, key };
  } catch {
    return unusable('APNS_AUTH_KEY is not a P-256 private key');
  }
}

// ---------- the provider token ----------

/** The isolate's token: its key, iat (seconds) and the signed JWT (concurrent sends sign once). */
let jwtMemo: { key: CryptoKey; keyId: string; teamId: string; iat: number; token: Promise<string> } | null = null;

async function signJwt(apns: Apns, iat: number): Promise<string> {
  const input = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: apns.keyId }))) + '.' + b64url(enc.encode(JSON.stringify({ iss: apns.teamId, iat })));
  // WebCrypto's ECDSA signature is already r || s (64 bytes), the form JWS needs (RFC 7518 3.4).
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, apns.key, enc.encode(input));
  return input + '.' + b64url(new Uint8Array(sig));
}

/** The provider token for `apns`: the isolate's own while under 50 minutes old, else a new one. */
export function apnsJwt(apns: Apns, nowMs = Date.now()): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const hit = jwtMemo;
  if (hit && hit.key === apns.key && hit.keyId === apns.keyId && hit.teamId === apns.teamId && now >= hit.iat && now - hit.iat < APNS_JWT_REUSE_S) {
    return hit.token;
  }
  const fresh = { key: apns.key, keyId: apns.keyId, teamId: apns.teamId, iat: now, token: signJwt(apns, now) };
  fresh.token.catch(() => {
    if (jwtMemo === fresh) jwtMemo = null;
  });
  jwtMemo = fresh;
  return fresh.token;
}

/** Drop the isolate's token, so the next send signs a new one (after ExpiredProviderToken). */
export function forgetApnsJwt(): void {
  jwtMemo = null;
}

// ---------- the message ----------

/** One notification for one iPhone. */
export interface ApnsMessage {
  /** The device token, lowercase hex. */
  token: string;
  environment: ApnsEnvironment;
  /** apns-topic: the bundle id the device registered with. */
  topic: string;
  /** The JSON body (apnsBody): aps.alert, sound and thread-id, and the app's route. */
  body: string;
  /** apns-priority: 10 at once, 5 when it suits the device (the import summary: web push's low urgency). */
  priority: 10 | 5;
  /** apns-collapse-id, web push's tag: a newer notification replaces the device's older one. */
  collapseId: string | null;
}

/**
 * The APNs body of a notification: the web push words as aps.alert, the default sound, the group as
 * the thread-id (Notification Center groups by it; the test notification has none), and the route
 * a tap opens. No badge: the server cannot count unread activity cheaply.
 */
export function apnsBody(n: Pick<PushNotice, 'payload' | 'route' | 'groupId'>): string {
  const aps: Record<string, unknown> = { alert: { title: n.payload.title, body: n.payload.body }, sound: 'default' };
  if (n.groupId) aps['thread-id'] = n.groupId;
  return JSON.stringify({ aps, route: n.route });
}

/** A stored iPhone (apns_devices) as a message to send, or null when its row cannot be used. */
export function apnsMessageFor(
  d: { id: string; environment: string | null; bundle_id: string | null },
  body: string,
  urgency: 'normal' | 'low',
  collapseId: string | null,
): ApnsMessage | null {
  const environment = d.environment === 'production' || d.environment === 'sandbox' ? d.environment : null;
  if (!environment || !APNS_TOKEN_RE.test(d.id) || !d.bundle_id) return null;
  return { token: d.id, environment, topic: d.bundle_id, body, priority: urgency === 'low' ? 5 : 10, collapseId };
}

export function apnsUrl(environment: ApnsEnvironment, token: string): string {
  return `https://${APNS_HOSTS[environment]}/3/device/${token}`;
}

/** The request headers for one message: the provider token, the topic, the push type and priority, and a day to live (web push's TTL). */
export async function apnsHeaders(apns: Apns, m: ApnsMessage, nowMs = Date.now()): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    authorization: 'bearer ' + (await apnsJwt(apns, nowMs)),
    'apns-topic': m.topic,
    'apns-push-type': 'alert',
    'apns-priority': String(m.priority),
    'apns-expiration': String(Math.floor(nowMs / 1000) + PUSH_TTL_SECONDS),
    'content-type': 'application/json',
  };
  if (m.collapseId) headers['apns-collapse-id'] = m.collapseId;
  return headers;
}

// ---------- sending ----------

/** APNs's answer to one message. */
export interface ApnsAnswer {
  /** The HTTP status, 0 when no answer came (network error, timeout). */
  status: number;
  /** Why APNs refused it ({"reason": "BadDeviceToken"}), '' for none. */
  reason: string;
}

/** APNs's reason, letters only and at most 64 of them (it goes into logs), or ''. */
function reasonOf(text: string): string {
  try {
    const r = (JSON.parse(text) as { reason?: unknown } | null)?.reason;
    return typeof r === 'string' && /^[A-Za-z]{1,64}$/.test(r) ? r : '';
  } catch {
    return '';
  }
}

/** POST one message to APNs. Never throws: no answer is status 0. */
export async function sendApns(apns: Apns, m: ApnsMessage, nowMs = Date.now()): Promise<ApnsAnswer> {
  try {
    const res = await fetch(apnsUrl(m.environment, m.token), {
      method: 'POST',
      headers: await apnsHeaders(apns, m, nowMs),
      body: m.body,
      // APNs never redirects; following one could take the provider token somewhere else.
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.status === 200) {
      await res.body?.cancel().catch(() => undefined);
      return { status: 200, reason: '' };
    }
    return { status: res.status, reason: reasonOf(await res.text().catch(() => '')) };
  } catch {
    return { status: 0, reason: '' };
  }
}

/** What an answer means for the device's row (deliverPushes in services/push.ts). */
export type ApnsOutcome =
  /** Accepted: last_ok_at, and failures back to 0. */
  | 'ok'
  /** The token is no good: 410 (Unregistered, ExpiredToken), 400 BadDeviceToken or DeviceTokenNotForTopic. The row is deleted. */
  | 'gone'
  /** No answer, 5xx, 429 TooManyRequests: counts on the device, deleted at 5 in a row, as for web push. */
  | 'failed'
  /**
   * APNs refused this server's request, not the device: 403 (the provider token or the key), 429
   * TooManyProviderTokenUpdates, and any other 4xx (the request itself: topic, headers, payload).
   * Every device would get the same answer, so the rows are left as they are.
   */
  | 'refused';

export function apnsOutcome(a: ApnsAnswer): ApnsOutcome {
  if (a.status === 200) return 'ok';
  if (a.status === 410) return 'gone';
  if (a.status === 400 && (a.reason === 'BadDeviceToken' || a.reason === 'DeviceTokenNotForTopic')) return 'gone';
  if (a.status === 429) return a.reason === 'TooManyProviderTokenUpdates' ? 'refused' : 'failed';
  if (a.status >= 400 && a.status < 500) return 'refused';
  return 'failed';
}
