// /api/push: this device's Web Push subscription, this iPhone's APNs token (the iPhone app), the
// account's notification prefs, a test notification, and running the sender now (owner, or anyone
// off production). Mounted by index.ts under /api; requireUser is attached per route, as in the
// other modules mounted there. docs/PLAN-push-scan-cookies.md section 2.1, docs/SPEC.md section 6.

import { Hono } from 'hono';
import { z } from 'zod';
import type { PushPrefsDTO, PushStatusRes, PushTestRes } from '../../shared/types';
import { rateLimit, requireUser } from '../auth';
import type { AppEnv } from '../env';
import { b64url, deviceLabel, fail, fromB64url, json, nowISO, readJson, sha256Hex } from '../http';
import { APNS_TOKEN_RE, loadApns } from '../services/apns';
import { canSend, channelOf, deliverPushes, deliveryFor, loadSenders, parsePrefs, runPushSender, type DeviceRow } from '../services/push';
import { testNotice } from '../services/pushText';
import { loadVapid } from '../services/webpush';

export const pushRoutes = new Hono<AppEnv>();

/** Subscriptions per account: a new one past this drops the device that worked longest ago. */
export const MAX_SUBSCRIPTIONS = 10;
/** iPhones per account, the same way. */
export const MAX_APNS_DEVICES = 10;
export const ENDPOINT_MAX = 1024;
export const APNS_LABEL_MAX = 60;
const TEST_PER_HOUR = 5;

/** Push services a subscription may point at. The Worker POSTs to the endpoint, so nothing else is accepted. */
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com'];
const PUSH_HOST_PATTERNS = [/^(?:[a-z0-9-]+\.)+push\.apple\.com$/, /^(?:[a-z0-9-]+\.)+notify\.windows\.com$/];

const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
/** An IANA zone name as browsers report it ('Asia/Taipei', 'America/Argentina/Buenos_Aires', 'Etc/GMT+8', 'UTC'). */
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}$/;

/** Why an endpoint is refused (https, no user, port or unknown host), or null when it may be stored. */
export function endpointProblem(endpoint: string): string | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return 'Not a URL';
  }
  if (u.protocol !== 'https:') return 'Push endpoints use https';
  if (u.username || u.password || u.port) return 'Not a push service address';
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_HOST_PATTERNS.some(re => re.test(host)) ? null : 'Not a known push service';
}

/** base64url (trailing = allowed) of exactly `bytes` bytes, or null. */
function keyBytes(s: string, bytes: number): Uint8Array | null {
  if (!B64URL_RE.test(s)) return null;
  try {
    const out = fromB64url(s.replace(/=+$/, ''));
    return out.length === bytes ? out : null;
  } catch {
    return null;
  }
}

/** The browser's ECDH key: 65 bytes, 0x04, x, y, and a point on P-256 (RFC 8291 section 7). */
export async function publicKeyBytes(s: string): Promise<Uint8Array | null> {
  const key = keyBytes(s, 65);
  if (!key || key[0] !== 4) return null;
  try {
    await crypto.subtle.importKey('raw', key, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return key;
  } catch {
    return null;
  }
}

function invalid(path: (string | number)[], message: string): never {
  fail(400, 'validation', 'Some fields are not valid', [{ path, message }]);
}

function count(r: D1Result | undefined): number {
  return Number((r?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
}

/** PushSubscription.toJSON() (expirationTime and other extra keys are dropped) plus the time zone. */
const SubscriptionSchema = z.object({
  endpoint: z.string().max(ENDPOINT_MAX),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  tz: z.string().max(64).nullish(),
});

const UnsubscribeSchema = z.object({ endpoint: z.string().min(1).max(ENDPOINT_MAX) });

/** ApnsDeviceReq from the iPhone app; the token and the bundle id are checked below. */
const ApnsDeviceSchema = z.object({
  token: z.string().max(400),
  environment: z.enum(['sandbox', 'production']),
  bundleId: z.string().max(200),
  tz: z.string().max(64).nullish(),
  label: z.string().max(APNS_LABEL_MAX).nullish(),
});

const ApnsDeleteSchema = z.object({ token: z.string().min(1).max(400) });

const PrefsSchema = z.object({
  expenses: z.boolean().optional(),
  payments: z.boolean().optional(),
  joins: z.boolean().optional(),
});

/** How many devices of the account get notifications: its browsers and its iPhones. */
function deviceCountStmt(db: D1Database, userId: string): D1PreparedStatement {
  return db
    .prepare('SELECT (SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?1) + (SELECT COUNT(*) FROM apns_devices WHERE user_id = ?1) AS n')
    .bind(userId);
}

pushRoutes.get('/push/status', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const [uRes, nRes] = await db.batch([db.prepare('SELECT notify_prefs FROM users WHERE id = ?').bind(user.id), deviceCountStmt(db, user.id)]);
  // No key when the server cannot sign (not set up, or the two halves do not match): nothing to
  // subscribe to. The same for iPhones: apns is false without a usable APNs key.
  const [vapid, apns] = await Promise.all([loadVapid(c.env), loadApns(c.env)]);
  const out: PushStatusRes = {
    publicKey: vapid?.publicKey ?? '',
    prefs: parsePrefs((uRes.results?.[0] as { notify_prefs?: string } | undefined)?.notify_prefs),
    devices: count(nRes),
    apns: !!apns,
  };
  return json(c, out);
});

/**
 * Store this device's subscription for this account and session. The same endpoint again updates
 * it (keys, session, time zone); one that belongs to another account moves here (the device
 * changed account).
 */
pushRoutes.put('/push/subscription', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const body = await readJson(c, SubscriptionSchema);
  const problem = endpointProblem(body.endpoint);
  if (problem) invalid(['endpoint'], problem);
  const p256dh = (await publicKeyBytes(body.keys.p256dh)) ?? invalid(['keys', 'p256dh'], 'Not a P-256 public key');
  const auth = keyBytes(body.keys.auth, 16) ?? invalid(['keys', 'auth'], 'Not a 16-byte secret');
  const tz = body.tz ? body.tz.trim() : null;
  if (tz && !TZ_RE.test(tz)) invalid(['tz'], 'Not a time zone name');

  const id = await sha256Hex(body.endpoint);
  const now = nowISO();
  const res = await db.batch([
    db
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, tz, label, created_at, last_ok_at, failures)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, ''), ?8, ?9, NULL, 0)
         ON CONFLICT(id) DO UPDATE SET
           created_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.created_at ELSE excluded.created_at END,
           last_ok_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.last_ok_at ELSE NULL END,
           user_id = excluded.user_id,
           session_id = excluded.session_id,
           endpoint = excluded.endpoint,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           tz = COALESCE(?7, push_subscriptions.tz),
           label = excluded.label,
           failures = 0`,
      )
      .bind(id, user.id, user.sessionId, body.endpoint, b64url(p256dh), b64url(auth), tz, deviceLabel(c.req.header('User-Agent')).slice(0, 60), now),
    // Past the limit, drop the devices that worked (or subscribed) longest ago; never this one.
    db
      .prepare(
        `DELETE FROM push_subscriptions WHERE user_id = ?1 AND id <> ?2 AND id NOT IN (
           SELECT id FROM push_subscriptions WHERE user_id = ?1 AND id <> ?2
           ORDER BY COALESCE(last_ok_at, created_at) DESC, created_at DESC LIMIT ?3)`,
      )
      .bind(user.id, id, MAX_SUBSCRIPTIONS - 1),
    deviceCountStmt(db, user.id),
  ]);
  return json(c, { ok: true, devices: count(res[2]) });
});

/** Turn notifications off for this device (only this account's own subscription). */
pushRoutes.delete('/push/subscription', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const body = await readJson(c, UnsubscribeSchema);
  await db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').bind(await sha256Hex(body.endpoint), user.id).run();
  return json(c, { ok: true });
});

/**
 * Store this iPhone's APNs device token for this account and session (the iPhone app sends it once
 * a launch while its account wants notifications there, after a sign-in, and when the token
 * changes). The same token again updates it (session, environment, label, time zone) and resets
 * `failures`; one that belongs to another account moves here (the iPhone changed account).
 */
pushRoutes.put('/push/apns', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const body = await readJson(c, ApnsDeviceSchema);
  const token = body.token.trim().toLowerCase();
  if (!APNS_TOKEN_RE.test(token)) invalid(['token'], 'Not an APNs device token (64 to 200 hex characters)');
  // Sent as the apns-topic: only this app's own bundle id (a token of another app would never work).
  const topic = (c.env.APNS_TOPIC ?? '').trim();
  if (!topic || body.bundleId.trim() !== topic) invalid(['bundleId'], 'Not this app');
  const tz = body.tz ? body.tz.trim() : null;
  if (tz && !TZ_RE.test(tz)) invalid(['tz'], 'Not a time zone name');
  const label = (body.label ?? '').replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim() || deviceLabel(c.req.header('User-Agent')).slice(0, APNS_LABEL_MAX);
  const now = nowISO();
  const res = await db.batch([
    db
      .prepare(
        `INSERT INTO apns_devices (token, user_id, session_id, environment, bundle_id, tz, label, created_at, last_ok_at, failures)
         VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, ''), ?7, ?8, NULL, 0)
         ON CONFLICT(token) DO UPDATE SET
           created_at = CASE WHEN apns_devices.user_id = excluded.user_id THEN apns_devices.created_at ELSE excluded.created_at END,
           last_ok_at = CASE WHEN apns_devices.user_id = excluded.user_id THEN apns_devices.last_ok_at ELSE NULL END,
           user_id = excluded.user_id,
           session_id = excluded.session_id,
           environment = excluded.environment,
           bundle_id = excluded.bundle_id,
           tz = COALESCE(?6, apns_devices.tz),
           label = excluded.label,
           failures = 0`,
      )
      .bind(token, user.id, user.sessionId, body.environment, topic, tz, label, now),
    // Past the limit, drop the iPhones that worked (or registered) longest ago; never this one.
    db
      .prepare(
        `DELETE FROM apns_devices WHERE user_id = ?1 AND token <> ?2 AND token NOT IN (
           SELECT token FROM apns_devices WHERE user_id = ?1 AND token <> ?2
           ORDER BY COALESCE(last_ok_at, created_at) DESC, created_at DESC LIMIT ?3)`,
      )
      .bind(user.id, token, MAX_APNS_DEVICES - 1),
    deviceCountStmt(db, user.id),
  ]);
  return json(c, { ok: true, devices: count(res[2]) });
});

/** Turn notifications off for this iPhone (only this account's own row; an unknown token is ok too). */
pushRoutes.delete('/push/apns', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const body = await readJson(c, ApnsDeleteSchema);
  await db.prepare('DELETE FROM apns_devices WHERE token = ? AND user_id = ?').bind(body.token.trim().toLowerCase(), user.id).run();
  return json(c, { ok: true });
});

/** Change some prefs; the others keep their value. Answers all three. */
pushRoutes.put('/push/prefs', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const patch = await readJson(c, PrefsSchema);
  const row = await db
    .prepare(
      `UPDATE users SET notify_prefs = json_patch(CASE WHEN json_valid(notify_prefs) THEN notify_prefs ELSE '{}' END, ?)
       WHERE id = ? RETURNING notify_prefs`,
    )
    .bind(JSON.stringify(patch), user.id)
    .first<{ notify_prefs: string }>();
  const out: PushPrefsDTO = parsePrefs(row?.notify_prefs);
  return json(c, out);
});

/** A test notification to every device of this account, browsers and iPhones, sent now (5 an hour). */
pushRoutes.post('/push/test', requireUser, async c => {
  const db = c.env.DB;
  const user = c.get('user');
  const senders = await loadSenders(c.env);
  if (!senders.vapid && !senders.apns) fail(503, 'server_error', 'Notifications are not set up on this server');
  await rateLimit(db, 'push-test:' + user.id, TEST_PER_HOUR, 3600);
  const [uRes, sRes, aRes] = await db.batch([
    db.prepare('SELECT locale FROM users WHERE id = ?').bind(user.id),
    db.prepare("SELECT 'web' AS ch, id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").bind(user.id),
    db.prepare("SELECT 'apns' AS ch, token AS id, user_id, environment, bundle_id FROM apns_devices WHERE user_id = ?").bind(user.id),
  ]);
  const locale = (uRes.results?.[0] as { locale?: string } | undefined)?.locale === 'en' ? 'en' : 'zh-TW';
  const notice = testNotice(locale);
  const list = [...(sRes.results ?? []), ...(aRes.results ?? [])]
    .map(d => d as DeviceRow)
    .filter(d => canSend(senders, channelOf(d)))
    .map(d => deliveryFor(d, notice))
    .filter(d => d !== null);
  const out: PushTestRes = list.length ? await deliverPushes(db, senders, list) : { sent: 0, removed: 0, failed: 0 };
  return json(c, out);
});

/** Run the sender now: the owner anywhere, anyone signed in on staging (which has no cron). */
pushRoutes.post('/push/run', requireUser, async c => {
  if (c.env.ENVIRONMENT === 'production' && !c.get('user').isOwner) fail(404, 'not_found', 'Not found');
  return json(c, await runPushSender(c.env));
});
