// Profile photos (docs/SPEC.md section 6, Profile photo): PUT and DELETE /api/me/avatar, and GET
// /api/users/:userId/avatar for the person and anyone who can see their name. The app makes the
// image (a center-cropped square, 256 x 256, JPEG at about 0.85: 15 to 40 KB), so the Worker only
// checks it: a JPEG or PNG data URL whose bytes start the way its type says, at most
// AVATAR_MAX_BYTES. The bytes live in the avatars table (D1, no R2) and users.avatar holds their
// version, the first 16 hex characters of their SHA-256, so the DTO queries need no join on the
// bytes. A change writes no activity row and sends no push.

import { Hono } from 'hono';
import type { AvatarRes } from '../../shared/types';
import { rateLimit, requireUser } from '../auth';
import type { AppEnv, Ctx } from '../env';
import { fail, json, notFound, nowISO } from '../http';
import { touchUserGroupsStmt } from '../services/summary';
import { etagMatches } from './groups';

/** The largest photo stored, in bytes (decoded). */
export const AVATAR_MAX_BYTES = 150_000;
/** Uploads per account in a day (a fixed window in rate_limits, key avatar:<uid>). */
export const AVATAR_PER_DAY = 30;
/**
 * The largest PUT body taken (index.ts lets it past the 256 KB gate, and the route checks the text
 * again): the base64 of AVATAR_MAX_BYTES with each "/" written as "\/" (Apple's JSON encoders do
 * that by default), plus the data URL's type and the JSON around it.
 */
export const AVATAR_MAX_BODY = 2 * Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 1024;
/** GET /api/users/:userId/avatar (index.ts keeps Vary: * off it, so browsers can keep the photo). */
export const AVATAR_PATH = /^\/api\/users\/[^/]+\/avatar$/;

/** The data URLs taken, and how the bytes of each must start. */
const TYPES = [
  { prefix: 'data:image/jpeg;base64,', mime: 'image/jpeg', name: 'JPEG', magic: [0xff, 0xd8, 0xff] },
  { prefix: 'data:image/png;base64,', mime: 'image/png', name: 'PNG', magic: [0x89, 0x50, 0x4e, 0x47] },
] as const;

/** A versioned address never changes its bytes: browsers keep it for a year. */
const IMMUTABLE = 'private, max-age=31536000, immutable';

/**
 * The photo of `?1` with its type and version, when the requester `?2` is that person or an
 * active member of a live group in which `?1` has a member row (active or not: people who left
 * still show in old entries). Otherwise nothing, the same as when there is no photo.
 */
const VISIBLE_PHOTO = `SELECT a.mime, a.data, a.version FROM avatars a
  WHERE a.user_id = ?1 AND (?1 = ?2 OR EXISTS (
    SELECT 1 FROM members mine
    JOIN groups g ON g.id = mine.group_id AND g.deleted_at IS NULL
    JOIN members theirs ON theirs.group_id = mine.group_id AND theirs.user_id = ?1
    WHERE mine.user_id = ?2 AND mine.active = 1))`;

export const avatarRoutes = new Hono<AppEnv>();

/** 400 bad_request about the body: `image` is its only field. */
function badImage(message: string): never {
  fail(400, 'bad_request', message, { fields: ['image'] });
}

/** Standard base64 to bytes (atob throws on anything else). */
function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A BLOB column as bytes: D1 gives it back as an array of byte values (node:sqlite as a Uint8Array). */
export function blobBytes(v: unknown): Uint8Array<ArrayBuffer> {
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return new Uint8Array(v);
  return Uint8Array.from(Array.isArray(v) ? (v as number[]) : []);
}

/** A stored photo as a data URL (the export's user.avatarImage). */
export function avatarDataUrl(mime: string, data: unknown): string {
  const bytes = blobBytes(data);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

/** The first 16 hex characters of SHA-256(bytes). */
async function versionOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The photo in the PUT body, read with this route's own size limit (readJson stops at 256 KB) and
 * parsed once: a JPEG or PNG data URL of at most AVATAR_MAX_BYTES whose bytes start the way its type
 * says. Anything else is 400 bad_request with `fields: ['image']`.
 */
async function readPhoto(c: Ctx): Promise<{ mime: string; bytes: Uint8Array<ArrayBuffer> }> {
  const len = Number(c.req.header('content-length') || '0');
  if (len > AVATAR_MAX_BODY) fail(413, 'payload_too_large', 'The photo is too large');
  const text = await c.req.text();
  if (text.length > AVATAR_MAX_BODY) fail(413, 'payload_too_large', 'The photo is too large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    badImage('Body is not valid JSON');
  }
  const image = (raw as { image?: unknown } | null)?.image;
  if (typeof image !== 'string') badImage('Send the photo in image, as a JPEG or PNG base64 data URL');
  // startsWith, never a regex over the base64.
  const type = TYPES.find(t => image.startsWith(t.prefix));
  if (!type) badImage('Send the photo as a JPEG or PNG base64 data URL');
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(image.slice(type.prefix.length));
  } catch {
    badImage('The photo is not valid base64');
  }
  if (bytes.length > AVATAR_MAX_BYTES) badImage(`The photo is larger than ${AVATAR_MAX_BYTES} bytes`);
  if (!type.magic.every((b, i) => bytes[i] === b)) badImage(`The photo is not a ${type.name}, as its data URL says`);
  return { mime: type.mime, bytes };
}

/** The account's photo version now (users.avatar). */
async function currentVersion(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare('SELECT avatar FROM users WHERE id = ?').bind(userId).first<{ avatar: string | null }>();
  return row?.avatar ?? null;
}

// Group snapshots carry the version on my members, and devices keep a snapshot until its group's
// version moves (the ETag). As PATCH /api/me does for a name or payment details, a change bumps
// every group I have a member row in (touchUserGroupsStmt), in the same batch; nothing changed,
// nothing is written.

avatarRoutes.put('/me/avatar', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const { mime, bytes } = await readPhoto(c);
  // Counted only once the photo passed the checks.
  await rateLimit(db, 'avatar:' + au.id, AVATAR_PER_DAY, 86_400);
  const version = await versionOf(bytes);
  if ((await currentVersion(db, au.id)) !== version) {
    const now = nowISO();
    await db.batch([
      db
        .prepare(
          `INSERT INTO avatars (user_id, mime, data, version, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`,
        )
        .bind(au.id, mime, bytes, version, now),
      db.prepare('UPDATE users SET avatar = ?, updated_at = ? WHERE id = ?').bind(version, now, au.id),
      touchUserGroupsStmt(db, au.id),
    ]);
  }
  const res: AvatarRes = { avatar: version };
  return json(c, res);
});

avatarRoutes.delete('/me/avatar', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  if ((await currentVersion(db, au.id)) !== null) {
    const now = nowISO();
    await db.batch([
      db.prepare('DELETE FROM avatars WHERE user_id = ?').bind(au.id),
      db.prepare('UPDATE users SET avatar = NULL, updated_at = ? WHERE id = ?').bind(now, au.id),
      touchUserGroupsStmt(db, au.id),
    ]);
  }
  const res: AvatarRes = { avatar: null };
  return json(c, res);
});

/**
 * The photo's bytes for the person and anyone who can see their name. With ?v= (how clients build
 * the address) the answer never changes, so browsers keep it a year; without, it is the current
 * photo, checked every time. One 404 for every refusal (no photo, not allowed, an old ?v=), so the
 * answer says nothing about who has a photo.
 */
avatarRoutes.get('/users/:userId/avatar', requireUser, async c => {
  const au = c.get('user');
  const userId = c.req.param('userId');
  const v = c.req.query('v');
  const row = userId.length <= 100
    ? await c.env.DB.prepare(VISIBLE_PHOTO).bind(userId, au.id).first<{ mime: string; data: unknown; version: string }>()
    : null;
  if (!row || (v !== undefined && v !== row.version)) notFound();
  const photo = row!;
  const etag = `"${photo.version}"`;
  c.header('ETag', etag);
  c.header('Cache-Control', v === undefined ? 'private, no-cache' : IMMUTABLE);
  if (etagMatches(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
  c.header('Content-Type', photo.mime);
  c.header('X-Content-Type-Options', 'nosniff');
  // An <img> on another site, a sibling *.ginochang.com one included (SameSite=Lax sends it the
  // cookie), gets nothing; the app's own pages, CORS fetches and the iOS app are not affected.
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  return c.body(blobBytes(photo.data));
});
