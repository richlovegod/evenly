// Receipt photos kept with an expense (docs/SPEC.md section 6, Receipt photos): PUT, GET and
// DELETE /api/groups/:gid/expenses/:eid/receipt. The app makes the image (longest side at most
// 1600 px, JPEG at about 0.7, orientation applied, EXIF and GPS gone with the re-encoding), so the
// Worker only checks it: a JPEG or PNG whose bytes start the way its Content-Type says, at most
// RECEIPT_PHOTO_MAX_BYTES. The bytes live in Workers KV (binding RECEIPTS, free plan: 1 GB, 1,000
// writes and 100,000 reads a day), the `receipts` row in D1 says which object is current, and the
// group snapshot carries its metadata (ExpenseDTO.receipt), never the bytes.
//
// CPU: the body is the raw image (no JSON, no base64), read once into one buffer with the size
// checked as it arrives; the only work on it is the magic bytes and one SHA-256 (native). GET
// streams the object from KV to the client without reading it. Workers Free allows 10 ms.
//
// A change bumps the group's version (and carries its summary along: no balance moves), so
// cached snapshots and their ETags pick it up. No activity row and no push.

import { Hono } from 'hono';
import { todayUTC } from '../../shared/dates';
import type { ReceiptDeleteRes, ReceiptDTO, ReceiptRes } from '../../shared/types';
import { limitFrom, rateLimit, requireUser } from '../auth';
import { bumpVersionStmt, versionFromBatch } from '../db';
import type { AppEnv, Ctx } from '../env';
import { ApiError, fail, json, notFound, nowISO } from '../http';
import { secondsToNextUtcDay } from '../services/receipt';
import { receiptKey } from '../services/receiptPhotos';
import { carrySummaryStmt, ID_RE } from './expenses';
import { etagMatches } from './groups';

/** The largest photo stored, in bytes (index.ts lets it past the 256 KB body gate). */
export const RECEIPT_PHOTO_MAX_BYTES = 600_000;
/** Uploads per account in a UTC day (rate_limits, key receipt-photo:user:<uid>:<day>). */
export const RECEIPT_PHOTO_PER_DAY = 40;
/**
 * KV writes the whole app makes for receipt photos in a UTC day (key receipt-photo:kv:<day>), under
 * the free plan's 1,000, which the account's other Workers and staging share
 * (RECEIPT_KV_WRITES_PER_DAY overrides it). Past it: 503 receipts_quota until 00:00 UTC.
 */
export const RECEIPT_KV_WRITES_PER_DAY = 900;
/**
 * The bytes all stored photos may take (SUM(receipts.bytes)), under the free plan's 1 GB; the
 * 50 MB between is room for an old object whose delete failed (RECEIPT_STORE_MAX_BYTES overrides
 * it). A photo that would pass it: 503 receipts_full.
 */
export const RECEIPT_STORE_MAX_BYTES = 950_000_000;
/** The width and height the app may say (?w= and ?h=), in px. */
export const RECEIPT_MAX_SIDE = 4000;
/** GET /api/groups/:gid/expenses/:eid/receipt (index.ts keeps Vary: * off it, and lets PUT bodies past the gate). */
export const RECEIPT_PHOTO_PATH = /^\/api\/groups\/[^/]+\/expenses\/[^/]+\/receipt$/;

/** The types taken, and how the bytes of each must start. */
const TYPES = [
  { mime: 'image/jpeg', name: 'JPEG', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', name: 'PNG', magic: [0x89, 0x50, 0x4e, 0x47] },
] as const;

/** A versioned address never changes its bytes: browsers keep it for a year. */
const IMMUTABLE = 'private, max-age=31536000, immutable';

const SIDE_RE = /^[1-9][0-9]{0,3}$/;

/**
 * The expense `?2` in the live group `?1`, for `?3` when they are an active member there (the rule
 * of the group snapshot), with its photo if it has one, the group's version and the bytes every
 * stored photo takes. Nothing otherwise.
 */
const ENTRY_SQL = `SELECT g.version AS group_version, e.deleted_at,
    r.kv_key, r.version, r.mime, r.width, r.height, r.bytes,
    (SELECT COALESCE(SUM(bytes), 0) FROM receipts) AS stored
  FROM groups g
  JOIN members m ON m.group_id = g.id AND m.user_id = ?3 AND m.active = 1
  JOIN expenses e ON e.id = ?2 AND e.group_id = g.id
  LEFT JOIN receipts r ON r.expense_id = e.id
  WHERE g.id = ?1 AND g.deleted_at IS NULL`;

interface EntryRow {
  group_version: number;
  deleted_at: string | null;
  kv_key: string | null;
  version: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  stored: number;
}

/** The photo of `?2` in the live group `?1`, for an active member `?3` there (as ENTRY_SQL). */
const VISIBLE_SQL = `SELECT r.kv_key, r.version, r.mime FROM receipts r
  JOIN groups g ON g.id = r.group_id AND g.deleted_at IS NULL
  JOIN members m ON m.group_id = g.id AND m.user_id = ?3 AND m.active = 1
  WHERE r.expense_id = ?2 AND r.group_id = ?1`;

export const receiptPhotoRoutes = new Hono<AppEnv>();

/** 400 bad_request about the request: which part is wrong. */
function badPhoto(field: 'body' | 'w' | 'h', message: string): never {
  fail(400, 'bad_request', message, { fields: [field] });
}

/** ?w= or ?h=: a whole number of px, 1 to RECEIPT_MAX_SIDE. */
function side(c: Ctx, name: 'w' | 'h'): number {
  const raw = c.req.query(name) ?? '';
  const n = SIDE_RE.test(raw) ? Number(raw) : 0;
  if (!(n >= 1 && n <= RECEIPT_MAX_SIDE)) badPhoto(name, `Send ${name} as the image's ${name === 'w' ? 'width' : 'height'} in px, 1 to ${RECEIPT_MAX_SIDE}`);
  return n;
}

/**
 * The raw body, at most RECEIPT_PHOTO_MAX_BYTES: refused on its Content-Length before a byte is
 * read, and again while it arrives (a chunked body has none), so no oversized body is ever held.
 */
async function readImage(c: Ctx): Promise<Uint8Array<ArrayBuffer>> {
  const len = c.req.header('content-length');
  if (len !== undefined && Number(len) > RECEIPT_PHOTO_MAX_BYTES) fail(413, 'payload_too_large', 'The photo is too large');
  const body = c.req.raw.body;
  if (!body) badPhoto('body', 'Send the photo as the request body');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RECEIPT_PHOTO_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail(413, 'payload_too_large', 'The photo is too large');
    }
    chunks.push(value);
  }
  if (chunks.length === 1 && chunks[0].buffer instanceof ArrayBuffer && chunks[0].byteOffset === 0 && chunks[0].byteLength === chunks[0].buffer.byteLength) {
    return chunks[0] as Uint8Array<ArrayBuffer>;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The first 16 hex characters of SHA-256(bytes). */
async function versionOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** One upload counted in today's window for `key`; over `limit`, `refuse` says what to answer. */
async function countToday(c: Ctx, key: string, limit: number, refuse: (retryAfter: number) => never): Promise<void> {
  try {
    await rateLimit(c.env.DB, key, limit, 86_400);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 429) throw err;
    refuse(secondsToNextUtcDay());
  }
}

function dtoOf(r: { version: string; mime: string; width: number; height: number; bytes: number }): ReceiptDTO {
  return { version: r.version, mime: r.mime, width: r.width, height: r.height, bytes: r.bytes };
}

/** The photo store, or 503 where this Worker has no RECEIPTS binding. */
function store(c: Ctx): KVNamespace {
  return c.env.RECEIPTS ?? fail(503, 'server_error', 'Receipt photos are not set up here');
}

/** The expense for this member (ENTRY_SQL), or 404. */
async function entryFor(c: Ctx, gid: string, eid: string): Promise<EntryRow> {
  const row = ID_RE.test(eid) && gid.length <= 100 ? await c.env.DB.prepare(ENTRY_SQL).bind(gid, eid, c.get('user').id).first<EntryRow>() : null;
  return row ?? notFound();
}

/**
 * A new photo for the entry (any earlier one is replaced). Checks, in order: the size and the
 * sides, the member and the entry (404, also for a deleted entry), the bytes, the account's day
 * (429), then the two whole-app caps (503) and only then a KV write.
 */
receiptPhotoRoutes.put('/groups/:gid/expenses/:eid/receipt', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  const width = side(c, 'w');
  const height = side(c, 'h');
  const typeHeader = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const type = TYPES.find(t => t.mime === typeHeader) ?? badPhoto('body', 'Send the photo with Content-Type image/jpeg or image/png');
  const len = c.req.header('content-length');
  if (len !== undefined && Number(len) > RECEIPT_PHOTO_MAX_BYTES) fail(413, 'payload_too_large', 'The photo is too large');
  const kv = store(c);
  const entry = await entryFor(c, gid, eid);
  // A deleted entry keeps the photo it had (復原 brings it back), but takes no new one.
  if (entry.deleted_at) notFound();

  const bytes = await readImage(c);
  if (!bytes.length) badPhoto('body', 'Send the photo as the request body');
  if (!type.magic.every((b, i) => bytes[i] === b)) badPhoto('body', `The photo is not a ${type.name}, as its Content-Type says`);

  const now = Date.now();
  const day = todayUTC(new Date(now));
  // Counted only once the photo passed the checks.
  await countToday(c, `receipt-photo:user:${au.id}:${day}`, RECEIPT_PHOTO_PER_DAY, retryAfter =>
    fail(429, 'rate_limited', 'No receipt photo uploads left today', { scope: 'user', retryAfter }),
  );
  const version = await versionOf(bytes);
  const receipt: ReceiptDTO = { version, mime: type.mime, width, height, bytes: bytes.length };
  // The same photo again (a retry whose answer was lost): nothing to write.
  if (entry.version === version && entry.kv_key) {
    const res: ReceiptRes = { receipt: dtoOf({ version, mime: entry.mime ?? type.mime, width: entry.width ?? width, height: entry.height ?? height, bytes: entry.bytes ?? bytes.length }), groupVersion: entry.group_version };
    return json(c, res);
  }
  if (entry.stored + bytes.length > limitFrom(c.env.RECEIPT_STORE_MAX_BYTES, RECEIPT_STORE_MAX_BYTES)) {
    fail(503, 'receipts_full', 'The space for receipt photos is full');
  }
  await countToday(c, `receipt-photo:kv:${day}`, limitFrom(c.env.RECEIPT_KV_WRITES_PER_DAY, RECEIPT_KV_WRITES_PER_DAY), retryAfter =>
    fail(503, 'receipts_quota', 'Receipt photo uploads are used up for today', { retryAfter }),
  );

  const key = receiptKey(eid, version);
  try {
    await kv.put(key, bytes);
  } catch (err) {
    // Past the account's daily KV writes the platform refuses (429); anything else is ours.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`PUT receipt ${eid}: KV put failed: ${msg.slice(0, 200)}`);
    if (/\b429\b|limit/i.test(msg)) fail(503, 'receipts_quota', 'Receipt photo uploads are used up for today', { retryAfter: secondsToNextUtcDay() });
    fail(503, 'server_error', 'The photo could not be stored right now. Try again later');
  }
  let groupVersion: number;
  try {
    const res = await db.batch([
      db
        .prepare(
          `INSERT INTO receipts (expense_id, group_id, kv_key, version, mime, bytes, width, height, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(expense_id) DO UPDATE SET kv_key = excluded.kv_key, version = excluded.version, mime = excluded.mime,
             bytes = excluded.bytes, width = excluded.width, height = excluded.height, uploaded_by = excluded.uploaded_by,
             created_at = excluded.created_at`,
        )
        .bind(eid, gid, key, version, type.mime, bytes.length, width, height, au.id, nowISO()),
      bumpVersionStmt(db, gid, nowISO()),
      carrySummaryStmt(db, gid),
    ]);
    groupVersion = versionFromBatch(res, 1);
  } catch (err) {
    // No row points at the new object: take it out again, so KV holds nothing D1 does not count.
    if (key !== entry.kv_key) await kv.delete(key).catch(() => undefined);
    throw err;
  }
  // The old object goes once the new one is stored and named. A delete that fails leaves it behind
  // (logged; RECEIPT_STORE_MAX_BYTES keeps room for that).
  if (entry.kv_key && entry.kv_key !== key) {
    try {
      await kv.delete(entry.kv_key);
    } catch (err) {
      console.error(`PUT receipt ${eid}: the old object was not deleted: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
  const res: ReceiptRes = { receipt, groupVersion };
  return json(c, res);
});

/**
 * The photo's bytes for whoever can see the group's entries (an active member of the live group,
 * as the snapshot). With ?v= (how clients build the address) the answer never changes, so browsers
 * keep it a year; without, it is the current photo, checked every time. One 404 for every refusal
 * (no photo, not allowed, an old ?v=), so the answer says nothing about which it was.
 */
receiptPhotoRoutes.get('/groups/:gid/expenses/:eid/receipt', requireUser, async c => {
  const kv = c.env.RECEIPTS;
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  const v = c.req.query('v');
  const row = kv && ID_RE.test(eid) && gid.length <= 100
    ? await c.env.DB.prepare(VISIBLE_SQL).bind(gid, eid, c.get('user').id).first<{ kv_key: string; version: string; mime: string }>()
    : null;
  if (!row || (v !== undefined && v !== row.version)) notFound();
  const photo = row!;
  const etag = `"${photo.version}"`;
  // Checked before KV is read: a browser that has the photo costs no KV read.
  if (etagMatches(c.req.header('If-None-Match'), etag)) {
    c.header('ETag', etag);
    c.header('Cache-Control', v === undefined ? 'private, no-cache' : IMMUTABLE);
    return c.body(null, 304);
  }
  // Streamed through: the Worker never holds the image.
  const body = await kv!.get(photo.kv_key, 'stream');
  if (!body) notFound();
  c.header('ETag', etag);
  c.header('Cache-Control', v === undefined ? 'private, no-cache' : IMMUTABLE);
  c.header('Content-Type', photo.mime);
  c.header('X-Content-Type-Options', 'nosniff');
  // An <img> on another site, a sibling *.ginochang.com one included (SameSite=Lax sends it the
  // cookie), gets nothing; the app's own pages, CORS fetches and the iOS app are not affected.
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  return c.body(body!);
});

/** Take the photo off the entry now: the KV object first, then the row (a failed KV delete keeps both). */
receiptPhotoRoutes.delete('/groups/:gid/expenses/:eid/receipt', requireUser, async c => {
  const db = c.env.DB;
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  const kv = store(c);
  const entry = await entryFor(c, gid, eid);
  if (!entry.kv_key) {
    const none: ReceiptDeleteRes = { groupVersion: entry.group_version };
    return json(c, none);
  }
  try {
    await kv.delete(entry.kv_key);
  } catch (err) {
    console.error(`DELETE receipt ${eid}: KV delete failed: ${err instanceof Error ? err.name : 'error'}`);
    fail(503, 'server_error', 'The photo could not be removed right now. Try again later');
  }
  const now = nowISO();
  const res = await db.batch([
    db.prepare('DELETE FROM receipts WHERE expense_id = ? AND kv_key = ?').bind(eid, entry.kv_key),
    bumpVersionStmt(db, gid, now),
    carrySummaryStmt(db, gid),
  ]);
  const out: ReceiptDeleteRes = { groupVersion: versionFromBatch(res, 1) };
  return json(c, out);
});
