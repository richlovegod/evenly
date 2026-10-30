// Receipt photos kept with an expense, up to three (docs/SPEC.md section 6, Receipt photos):
//   PUT    /api/groups/:gid/expenses/:eid/receipts/:version   a photo after the ones it has
//   DELETE /api/groups/:gid/expenses/:eid/receipts/:version   that photo off; the later ones move up
//   GET    /api/groups/:gid/expenses/:eid/receipt?v=<version> any of its photos, for every client
//   PUT    /api/groups/:gid/expenses/:eid/receipt             (clients from before several photos)
//          the first photo becomes these bytes; photos 2 and 3 stay
//   DELETE /api/groups/:gid/expenses/:eid/receipt             (the same) the first photo off
// The app makes each image (longest side at most 1600 px, JPEG at about 0.7, orientation applied,
// EXIF and GPS gone with the re-encoding), so the Worker only checks it: a JPEG or PNG whose bytes
// start the way its Content-Type says, at most RECEIPT_PHOTO_MAX_BYTES. The bytes live in Workers
// KV under receipt:<expense_id>:<version> (binding RECEIPTS; Workers Paid includes 1 GB stored, and
// 1,000,000 writes and 10,000,000 reads a month, for the whole account, and bills past them). In
// D1 the `receipts` row (0006) is the first photo and `receipt_extras` rows (0016) the second and
// third, so code from before several photos still reads and writes the first one as it did. The
// group snapshot carries every photo's metadata (ExpenseDTO.receipt and receipts), never the bytes.
//
// Rules every photo write keeps (tests/worker/receipt-photos.test.ts pins them):
//   I1 order: the receipts row, then receipt_extras by created_at, then version; no position is
//      stored, and a new photo goes last.
//   I2 limits: at most RECEIPT_PHOTOS_MAX photos, and one row per (expense_id, version) across both
//      tables, so the same bytes are never on one expense twice and every upload can be repeated.
//   I3 a first photo: an expense with extras has a receipts row. Only old code's DELETE during a
//      rollback breaks it; readers then take the earliest extra as first, and N1 repairs it.
//   I4 no stray objects: a new KV object is written before its batch and deleted again when no row
//      names it afterwards; a photo's object is deleted before its row, so a failed KV delete
//      changes nothing; a KV key the expense's list still names is never deleted.
//   I5 the DTO: ExpenseDTO.receipt is the first photo or null, ExpenseDTO.receipts the whole list.
// N1 (promote) and N2 (dedupe) come first in every photo write batch, except a removal's, where
// they follow its deletes. Every photo write also bumps the group's version and carries its summary
// along (no balance moves), so cached snapshots and their ETags pick it up. The entry's own version
// stays: no activity row and no push. D1 runs one batch at a time, so two adds racing for the last
// place get one 200 and one 409, and two identical adds leave one row and one object.
//
// CPU: the body is the raw image (no JSON, no base64), read once into one buffer with the size
// checked as it arrives; the only work on it is the magic bytes and one SHA-256 (native). GET
// streams the object from KV to the client without reading it.

import { Hono } from 'hono';
import { todayUTC } from '../../shared/dates';
import { RECEIPT_PHOTOS_MAX } from '../../shared/receipts';
import type { ReceiptDeleteRes, ReceiptDTO, ReceiptPhotosRes, ReceiptRes } from '../../shared/types';
import { limitFrom, rateLimit, requireUser } from '../auth';
import { bumpVersionStmt, inPhotoOrder, versionFromBatch } from '../db';
import type { AppEnv, Ctx } from '../env';
import { ApiError, fail, json, notFound, nowISO } from '../http';
import { secondsToNextUtcDay } from '../services/receipt';
import { receiptKey } from '../services/receiptPhotos';
import { carrySummaryStmt, ID_RE } from './expenses';
import { etagMatches } from './groups';

/** The largest photo stored, in bytes (index.ts lets it past the 256 KB body gate). */
export const RECEIPT_PHOTO_MAX_BYTES = 600_000;
/** Uploads per account in a UTC day, new and legacy together (rate_limits, key receipt-photo:user:<uid>:<day>). */
export const RECEIPT_PHOTO_PER_DAY = 40;
/**
 * KV writes the whole app makes for receipt photos in a UTC day (key receipt-photo:kv:<day>;
 * RECEIPT_KV_WRITES_PER_DAY overrides it). Even 900 every day is about 28,000 a month, far under
 * the 1,000,000 a month Workers Paid includes for the account, its other Workers and staging
 * included. Past it: 503 receipts_quota until 00:00 UTC.
 */
export const RECEIPT_KV_WRITES_PER_DAY = 900;
/**
 * The bytes all stored photos may take (SUM(bytes) of receipts and receipt_extras together;
 * RECEIPT_STORE_MAX_BYTES overrides it), under the 1 GB of KV Workers Paid includes for the whole
 * account. The 200 MB between are for staging's photos (30,000,000), the other Workers' namespaces
 * (award-relay, study-sync), old objects whose delete failed, and the second and third photos a
 * rollback to code that counts only `receipts` would not see. A photo that would pass it: 503
 * receipts_full.
 */
export const RECEIPT_STORE_MAX_BYTES = 800_000_000;
/**
 * The bytes the second and third photos may take on their own (SUM(receipt_extras.bytes)). Code
 * from before several photos counts only `receipts` against RECEIPT_STORE_MAX_BYTES, so after a
 * rollback the first photos alone could grow to that cap; keeping the extras under this keeps both
 * together inside the account's 1 GB of KV even then. A photo that would pass it: 503 receipts_full.
 */
export const RECEIPT_EXTRAS_MAX_BYTES = 150_000_000;
/**
 * How long a legacy DELETE .../receipt from one account on one expense remembers the photo it left
 * first (rate_limits, key receipt-legacy-del:<uid>:<eid>:<version>): within it, the same account's
 * next legacy DELETE while that photo is still first is taken for a retry whose answer was lost
 * (the old web outbox, iPhone 1.0's 再試一次 or a second 儲存), answers the list and writes nothing.
 * A day (2026-10-30, the fix check of the review): the old web outbox retries a lost answer with no
 * cap and no expiry, so a Home Screen app suspended mid-request, or a phone offline for hours,
 * retries long after 10 minutes. Such a client's DELETE names no photo, and while its removal waits
 * it shows none, so nothing it sends or fetches can tell its retry from a deliberate removal of the
 * next photo: only time can. The cost, safe: the same old client's deliberate second removal of
 * the same expense within the day writes nothing (the photo shows again after the reload, and
 * goes the next day, or from the web or iPhone 1.1 at once). A retry later than a day still takes
 * the next photo off; accepted.
 */
export const RECEIPT_LEGACY_DELETE_WINDOW_S = 86_400;
/** The width and height the app may say (?w= and ?h=), in px. */
export const RECEIPT_MAX_SIDE = 4000;
/** GET, PUT and DELETE .../receipt (index.ts keeps Vary: * off its GET, and lets PUT bodies past the gate). */
export const RECEIPT_PHOTO_PATH = /^\/api\/groups\/[^/]+\/expenses\/[^/]+\/receipt$/;
/** PUT and DELETE .../receipts/:version: writes only (Vary: * stays), PUT bodies let past the gate. */
export const RECEIPT_PHOTOS_PATH = /^\/api\/groups\/[^/]+\/expenses\/[^/]+\/receipts\/[^/]+$/;

/** The types taken, and how the bytes of each must start. */
const TYPES = [
  { mime: 'image/jpeg', name: 'JPEG', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', name: 'PNG', magic: [0x89, 0x50, 0x4e, 0x47] },
] as const;

type PhotoType = (typeof TYPES)[number];

/** A versioned address never changes its bytes: browsers keep it for a year. */
const IMMUTABLE = 'private, max-age=31536000, immutable';

const SIDE_RE = /^[1-9][0-9]{0,3}$/;
/** A photo's version: the first 16 lowercase hex characters of the SHA-256 of its bytes. */
const VERSION_RE = /^[0-9a-f]{16}$/;

/**
 * The expense `?2` in the live group `?1`, for `?3` when they are an active member there (the rule
 * of the group snapshot): the group's version, whether the expense is deleted, and (`stored`) the
 * bytes every stored photo takes and those of the second and third photos alone. Nothing otherwise.
 */
function entrySql(stored: boolean): string {
  const sums = stored
    ? `(SELECT COALESCE(SUM(bytes), 0) FROM receipts) + (SELECT COALESCE(SUM(bytes), 0) FROM receipt_extras) AS stored,
    (SELECT COALESCE(SUM(bytes), 0) FROM receipt_extras) AS extras_stored`
    : '0 AS stored, 0 AS extras_stored';
  return `SELECT g.version AS group_version, e.deleted_at, ${sums}
  FROM groups g
  JOIN members m ON m.group_id = g.id AND m.user_id = ?3 AND m.active = 1
  JOIN expenses e ON e.id = ?2 AND e.group_id = g.id
  WHERE g.id = ?1 AND g.deleted_at IS NULL`;
}

interface EntryRow {
  group_version: number;
  deleted_at: string | null;
  stored: number;
  extras_stored: number;
}

/** Every photo row of the expense ?1, both tables (stored first: receipts; then receipt_extras). */
const PHOTOS_SQL = `SELECT kv_key, version, mime, width, height, bytes, created_at AS at, 0 AS extra FROM receipts WHERE expense_id = ?1
  UNION ALL
  SELECT kv_key, version, mime, width, height, bytes, created_at AS at, 1 AS extra FROM receipt_extras WHERE expense_id = ?1`;

interface PhotoRow extends ReceiptDTO {
  kv_key: string;
  at: string;
  extra: number;
}

/**
 * The photo of `?2` in the live group `?1` for an active member `?3` there (as entrySql): the one
 * with version `?4`, or without one the first (I1), from either table.
 */
const VISIBLE_SQL = `SELECT p.kv_key, p.version, p.mime FROM (
    SELECT kv_key, version, mime, group_id, created_at, 0 AS extra FROM receipts WHERE expense_id = ?2
    UNION ALL
    SELECT kv_key, version, mime, group_id, created_at, 1 AS extra FROM receipt_extras WHERE expense_id = ?2
  ) p
  JOIN groups g ON g.id = p.group_id AND g.deleted_at IS NULL
  JOIN members m ON m.group_id = g.id AND m.user_id = ?3 AND m.active = 1
  WHERE p.group_id = ?1 AND (?4 IS NULL OR p.version = ?4)
  ORDER BY p.extra, p.created_at, p.version
  LIMIT 1`;

const PHOTO_COLUMNS = 'expense_id, group_id, kv_key, version, mime, bytes, width, height, uploaded_by, created_at';
const SET_FROM_EXCLUDED = `kv_key = excluded.kv_key, version = excluded.version, mime = excluded.mime, bytes = excluded.bytes,
  width = excluded.width, height = excluded.height, uploaded_by = excluded.uploaded_by, created_at = excluded.created_at`;
const LIVE_EXPENSE = 'EXISTS (SELECT 1 FROM expenses WHERE id = ?1 AND deleted_at IS NULL)';

export const receiptPhotoRoutes = new Hono<AppEnv>();

// ---------- the statements every write shares ----------

/** N1: an expense with photos but no first one (a rollback's old DELETE) gets its earliest other photo as first. */
function promoteStmt(db: D1Database, eid: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO receipts (${PHOTO_COLUMNS})
       SELECT ${PHOTO_COLUMNS} FROM receipt_extras WHERE expense_id = ?1 AND NOT EXISTS (SELECT 1 FROM receipts WHERE expense_id = ?1)
       ORDER BY created_at, version LIMIT 1`,
    )
    .bind(eid);
}

/** N2: a photo that is the first one is no other photo too (N1's copy, or one an old PUT made). Its KV object stays: the first photo uses it. */
function dedupeStmt(db: D1Database, eid: string): D1PreparedStatement {
  return db.prepare('DELETE FROM receipt_extras WHERE expense_id = ?1 AND version IN (SELECT version FROM receipts WHERE expense_id = ?1)').bind(eid);
}

function photosStmt(db: D1Database, eid: string): D1PreparedStatement {
  return db.prepare(PHOTOS_SQL).bind(eid);
}

/** The first photo's row, read inside a batch (what a legacy PUT replaces). */
function firstRowStmt(db: D1Database, eid: string): D1PreparedStatement {
  return db.prepare('SELECT kv_key, version FROM receipts WHERE expense_id = ?1').bind(eid);
}

function rows<T>(r: D1Result | undefined): T[] {
  return (r?.results ?? []) as T[];
}

/**
 * The photos of one expense in their order (I1), each version once: the receipts row, then
 * receipt_extras by created_at and version; with no receipts row the earliest extra is first (I3).
 */
function inOrder(list: readonly PhotoRow[]): PhotoRow[] {
  const first = list.find(p => p.extra === 0);
  const seen = new Set<string>();
  const out: PhotoRow[] = [];
  for (const p of [...(first ? [first] : []), ...inPhotoOrder(list.filter(x => x.extra !== 0))]) {
    if (seen.has(p.version)) continue;
    seen.add(p.version);
    out.push(p);
  }
  return out;
}

function dtoOf(r: { version: string; mime: string; width: number; height: number; bytes: number }): ReceiptDTO {
  return { version: r.version, mime: r.mime, width: r.width, height: r.height, bytes: r.bytes };
}

const dtos = (list: readonly PhotoRow[]): ReceiptDTO[] => list.slice(0, RECEIPT_PHOTOS_MAX).map(dtoOf);

function photosRes(list: readonly PhotoRow[], groupVersion: number): ReceiptPhotosRes {
  const receipts = dtos(list);
  return { receipt: receipts[0] ?? null, receipts, groupVersion };
}

/** 409: the expense has RECEIPT_PHOTOS_MAX photos already (they come along). */
function limitReached(list: readonly PhotoRow[]): never {
  fail(409, 'limit_reached', `An expense keeps up to ${RECEIPT_PHOTOS_MAX} receipt photos`, { limit: 'receipt_photos', max: RECEIPT_PHOTOS_MAX, receipts: dtos(list) });
}

// ---------- reading the request ----------

/** 400 bad_request about the request: which part is wrong. */
function badPhoto(field: 'body' | 'w' | 'h' | 'version', message: string): never {
  fail(400, 'bad_request', message, { fields: [field] });
}

/** ?w= or ?h=: a whole number of px, 1 to RECEIPT_MAX_SIDE. */
function side(c: Ctx, name: 'w' | 'h'): number {
  const raw = c.req.query(name) ?? '';
  const n = SIDE_RE.test(raw) ? Number(raw) : 0;
  if (!(n >= 1 && n <= RECEIPT_MAX_SIDE)) badPhoto(name, `Send ${name} as the image's ${name === 'w' ? 'width' : 'height'} in px, 1 to ${RECEIPT_MAX_SIDE}`);
  return n;
}

/** The photo's type from its Content-Type (parameters and any case allowed). */
function photoType(c: Ctx): PhotoType {
  const typeHeader = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return TYPES.find(t => t.mime === typeHeader) ?? badPhoto('body', 'Send the photo with Content-Type image/jpeg or image/png');
}

/** 413 on a Content-Length over the limit, before anything else is read. */
function lengthCheck(c: Ctx): void {
  const len = c.req.header('content-length');
  if (len !== undefined && Number(len) > RECEIPT_PHOTO_MAX_BYTES) fail(413, 'payload_too_large', 'The photo is too large');
}

/**
 * The raw body, at most RECEIPT_PHOTO_MAX_BYTES: refused on its Content-Length before a byte is
 * read, and again while it arrives (a chunked body has none), so no oversized body is ever held.
 */
async function readImage(c: Ctx): Promise<Uint8Array<ArrayBuffer>> {
  lengthCheck(c);
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

/** The body, which must not be empty and must start the way its type says. */
async function readPhoto(c: Ctx, type: PhotoType): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await readImage(c);
  if (!bytes.length) badPhoto('body', 'Send the photo as the request body');
  if (!type.magic.every((b, i) => bytes[i] === b)) badPhoto('body', `The photo is not a ${type.name}, as its Content-Type says`);
  return bytes;
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

/** The photo store, or 503 where this Worker has no RECEIPTS binding. */
function store(c: Ctx): KVNamespace {
  return c.env.RECEIPTS ?? fail(503, 'server_error', 'Receipt photos are not set up here');
}

/**
 * The 404 of the `receipts/:version` routes: the same body for every refusal (no access, no such
 * entry, a deleted entry on PUT, a deleted group), with `details: {entry: 'gone'}`, which a server
 * from before several photos never sends for these paths (its catch-all 404 has no details). So a
 * client counts a removal done on this 404 only, and keeps one that met an older server (a
 * rollback, a deploy's first seconds) failed with 重試.
 */
function gone(): never {
  fail(404, 'not_found', 'Not found', { entry: 'gone' });
}

/** The expense for this member (entrySql) and its photos in order, read together; `refuse` (404) without access. */
async function entryFor(c: Ctx, gid: string, eid: string, stored: boolean, refuse: () => never = notFound): Promise<{ entry: EntryRow; photos: PhotoRow[] }> {
  if (!ID_RE.test(eid) || gid.length > 100) refuse();
  const db = c.env.DB;
  const [eRes, pRes] = await db.batch([db.prepare(entrySql(stored)).bind(gid, eid, c.get('user').id), photosStmt(db, eid)]);
  const entry = rows<EntryRow>(eRes)[0] ?? refuse();
  return { entry, photos: inOrder(rows<PhotoRow>(pRes)) };
}

/**
 * The checks before a new object is written: the account's day (429), the store (503
 * receipts_full; for a photo that becomes a second or third one, also the extras' own
 * RECEIPT_EXTRAS_MAX_BYTES), the app's KV writes today (503 receipts_quota).
 */
async function admitNewBytes(c: Ctx, entry: EntryRow, size: number, day: string, counted: boolean, extra: boolean): Promise<void> {
  if (!counted) {
    await countToday(c, `receipt-photo:user:${c.get('user').id}:${day}`, RECEIPT_PHOTO_PER_DAY, retryAfter =>
      fail(429, 'rate_limited', 'No receipt photo uploads left today', { scope: 'user', retryAfter }),
    );
  }
  if (entry.stored + size > limitFrom(c.env.RECEIPT_STORE_MAX_BYTES, RECEIPT_STORE_MAX_BYTES)) {
    fail(503, 'receipts_full', 'The space for receipt photos is full');
  }
  if (extra && entry.extras_stored + size > RECEIPT_EXTRAS_MAX_BYTES) {
    fail(503, 'receipts_full', 'The space for receipt photos is full');
  }
  await countToday(c, `receipt-photo:kv:${day}`, limitFrom(c.env.RECEIPT_KV_WRITES_PER_DAY, RECEIPT_KV_WRITES_PER_DAY), retryAfter =>
    fail(503, 'receipts_quota', 'Receipt photo uploads are used up for today', { retryAfter }),
  );
}

/** Write the object: past the account's daily KV writes the platform refuses (429, receipts_quota); anything else is ours. */
async function putObject(kv: KVNamespace, key: string, bytes: Uint8Array<ArrayBuffer>, eid: string): Promise<void> {
  try {
    await kv.put(key, bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`PUT receipt ${eid}: KV put failed: ${msg.slice(0, 200)}`);
    if (/\b429\b|limit/i.test(msg)) fail(503, 'receipts_quota', 'Receipt photo uploads are used up for today', { retryAfter: secondsToNextUtcDay() });
    fail(503, 'server_error', 'The photo could not be stored right now. Try again later');
  }
}

/** Delete a photo's object before its row: a failed delete is 503 and nothing changes. */
async function deleteObject(kv: KVNamespace, key: string, eid: string): Promise<void> {
  try {
    await kv.delete(key);
  } catch (err) {
    console.error(`DELETE receipt ${eid}: KV delete failed: ${err instanceof Error ? err.name : 'error'}`);
    fail(503, 'server_error', 'The photo could not be removed right now. Try again later');
  }
}

/**
 * The photos as stored now, read once more and again if that fails (null when both fail): what a
 * KV delete after a batch goes by, since another request may have named the object meanwhile.
 */
async function photosNow(db: D1Database, eid: string): Promise<PhotoRow[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return inOrder(rows<PhotoRow>(await photosStmt(db, eid).all()));
    } catch {
      /* D1 did not answer: once more, then give up */
    }
  }
  return null;
}

/**
 * Delete an object no row names any more (I4), read against the photos as stored now: one a row
 * names again since the batch (a request with the same bytes) stays, and so does every object
 * when the photos cannot be read. A stray object outside the count can be cleaned up later; a row
 * without its bytes cannot be repaired. A failed delete is logged.
 */
async function dropIfUnnamed(db: D1Database, kv: KVNamespace, key: string, eid: string): Promise<void> {
  const now = await photosNow(db, eid);
  if (now === null) {
    console.error(`receipt ${eid}: kept an object, the photos could not be read to know whether a row names it`);
    return;
  }
  if (now.some(p => p.kv_key === key)) return;
  try {
    await kv.delete(key);
  } catch (err) {
    console.error(`receipt ${eid}: an object no row names was not deleted: ${err instanceof Error ? err.name : 'error'}`);
  }
}

// ---------- the photos of an expense ----------

/**
 * Add this photo after the ones the entry has. Checks, in order: the version's form, w and h, the
 * Content-Type, Content-Length (413), the binding (503), the member and a live entry (404), the
 * bytes and that their SHA-256 is the version (400). Then: already on the entry, 200 and nothing
 * written or counted (a retry whose answer was lost); three photos, 409; the account's day (429),
 * the store (503) and the app's KV writes (503); and only then a KV write and one batch.
 */
receiptPhotoRoutes.put('/groups/:gid/expenses/:eid/receipts/:version', requireUser, async c => {
  const db = c.env.DB;
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  const version = c.req.param('version');
  if (!VERSION_RE.test(version)) badPhoto('version', 'Send the version as the first 16 lowercase hex characters of the SHA-256 of the photo');
  const width = side(c, 'w');
  const height = side(c, 'h');
  const type = photoType(c);
  lengthCheck(c);
  const kv = store(c);
  const { entry, photos } = await entryFor(c, gid, eid, true, gone);
  // A deleted entry keeps its photos (復原 brings them back), but takes no new one.
  if (entry.deleted_at) gone();
  const bytes = await readPhoto(c, type);
  if ((await versionOf(bytes)) !== version) badPhoto('version', 'The version is not the SHA-256 of the photo');
  if (photos.some(p => p.version === version)) return json(c, photosRes(photos, entry.group_version));
  if (photos.length >= RECEIPT_PHOTOS_MAX) limitReached(photos);
  const now = nowISO();
  await admitNewBytes(c, entry, bytes.length, todayUTC(), false, photos.length > 0);

  const key = receiptKey(eid, version);
  await putObject(kv, key, bytes, eid);
  const values = [eid, gid, key, version, type.mime, bytes.length, width, height, c.get('user').id, now];
  let res: D1Result[];
  try {
    res = await db.batch([
      promoteStmt(db, eid),
      dedupeStmt(db, eid),
      // The first photo, when the entry has none.
      db
        .prepare(
          `INSERT INTO receipts (${PHOTO_COLUMNS}) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
           WHERE NOT EXISTS (SELECT 1 FROM receipts WHERE expense_id = ?1) AND ${LIVE_EXPENSE}`,
        )
        .bind(...values),
      // Otherwise the next one, while there is room (the batch decides, so racing adds get one place
      // each). It goes last (I1) also when another was added in the same millisecond: its
      // created_at is a millisecond after the latest one's when now is not later.
      db
        .prepare(
          `INSERT INTO receipt_extras (${PHOTO_COLUMNS}) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
             COALESCE((SELECT CASE WHEN MAX(created_at) >= ?10 THEN strftime('%Y-%m-%dT%H:%M:%fZ', julianday(MAX(created_at)) + 0.001 / 86400.0) END
                       FROM receipt_extras WHERE expense_id = ?1), ?10)
           WHERE EXISTS (SELECT 1 FROM receipts WHERE expense_id = ?1 AND version <> ?4)
             AND NOT EXISTS (SELECT 1 FROM receipt_extras WHERE expense_id = ?1 AND version = ?4)
             AND (SELECT COUNT(*) FROM receipt_extras WHERE expense_id = ?1) < ${RECEIPT_PHOTOS_MAX - 1}
             AND ${LIVE_EXPENSE}`,
        )
        .bind(...values),
      bumpVersionStmt(db, gid, now),
      carrySummaryStmt(db, gid),
      photosStmt(db, eid),
      db.prepare('SELECT deleted_at FROM expenses WHERE id = ?1').bind(eid),
    ]);
  } catch (err) {
    // The batch may have been applied all the same (D1 does not retry a write): the object goes
    // only when the photos, read again, show that no row names it.
    console.error(`PUT receipt ${eid}: the batch failed: ${err instanceof Error ? err.name : 'error'}`);
    await dropIfUnnamed(db, kv, key, eid);
    fail(503, 'server_error', 'The photo could not be stored right now. Try again later');
  }
  const list = inOrder(rows<PhotoRow>(res[6]));
  if (list.some(p => p.version === version)) return json(c, photosRes(list, versionFromBatch(res, 4)));
  // Not added: no row names the new object (unless one with the same bytes did since).
  await dropIfUnnamed(db, kv, key, eid);
  const live = rows<{ deleted_at: string | null }>(res[7])[0];
  if (!live || live.deleted_at) gone();
  if (list.length >= RECEIPT_PHOTOS_MAX) limitReached(list);
  fail(503, 'server_error', 'The photos of this entry changed at the same time. Try again');
});

/**
 * Take this photo off the entry: its KV object first, then its row, and the later photos move up
 * (removing the first promotes the next). It works on a deleted entry, whose page still shows its
 * photos until the daily purge. A version the entry does not have: 200, nothing written.
 */
receiptPhotoRoutes.delete('/groups/:gid/expenses/:eid/receipts/:version', requireUser, async c => {
  const db = c.env.DB;
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  const version = c.req.param('version');
  if (!VERSION_RE.test(version)) badPhoto('version', 'Send the version as the first 16 lowercase hex characters of the SHA-256 of the photo');
  const kv = store(c);
  const { entry, photos } = await entryFor(c, gid, eid, false, gone);
  const target = photos.find(p => p.version === version);
  if (!target) return json(c, photosRes(photos, entry.group_version));
  await deleteObject(kv, target.kv_key, eid);
  const now = nowISO();
  const res = await db.batch([
    db.prepare('DELETE FROM receipts WHERE expense_id = ?1 AND version = ?2').bind(eid, version),
    db.prepare('DELETE FROM receipt_extras WHERE expense_id = ?1 AND version = ?2').bind(eid, version),
    promoteStmt(db, eid),
    dedupeStmt(db, eid),
    bumpVersionStmt(db, gid, now),
    carrySummaryStmt(db, gid),
    photosStmt(db, eid),
  ]);
  return json(c, photosRes(inOrder(rows<PhotoRow>(res[6])), versionFromBatch(res, 4)));
});

// ---------- the routes of clients from before several photos ----------

/**
 * After a legacy PUT: the photo it replaced goes from KV when the new list does not name it, and
 * the photos read again just before still do not (dropIfUnnamed; a failed delete is logged).
 */
async function dropReplaced(db: D1Database, kv: KVNamespace, replaced: { kv_key: string } | undefined, list: readonly PhotoRow[], eid: string): Promise<void> {
  if (!replaced || list.some(p => p.kv_key === replaced.kv_key)) return;
  await dropIfUnnamed(db, kv, replaced.kv_key, eid);
}

/**
 * A legacy PUT's batch threw, so whether it was applied is not known: read the photos again. When
 * they cannot be read, every object stays (logged). Otherwise the new object (`key`, null for a
 * photo that moved up) goes when no row names it, and when the uploaded version is first now (the
 * batch was applied after all) the photo it replaced (`replaced`, first before the batch) goes too.
 */
async function settleLegacyBatch(db: D1Database, kv: KVNamespace, eid: string, version: string, key: string | null, replaced: PhotoRow | undefined): Promise<void> {
  const now = await photosNow(db, eid);
  if (now === null) {
    console.error(`PUT receipt ${eid}: kept the objects, the photos could not be read after a failed batch`);
    return;
  }
  if (key !== null && !now.some(p => p.kv_key === key)) await dropIfUnnamed(db, kv, key, eid);
  if (now[0]?.version === version && replaced && replaced.version !== version && !now.some(p => p.kv_key === replaced.kv_key)) {
    await dropIfUnnamed(db, kv, replaced.kv_key, eid);
  }
}

function legacyRes(list: readonly PhotoRow[], groupVersion: number): ReceiptRes {
  const receipts = dtos(list);
  return { receipt: receipts[0], groupVersion, receipts };
}

/**
 * The entry's first photo becomes these bytes (iPhone 1.0, older web builds and their outbox
 * items): the photo that was first is replaced, photos 2 and 3 stay, so it never answers 409.
 * Checks, in order, as before several photos: w and h, the Content-Type, the size, the member and a
 * live entry (404), the bytes, the account's day (429, counted before the same-bytes check). The
 * first photo's bytes again: 200, nothing written. Photo 2's or 3's bytes: that photo moves up and
 * the old first goes, with no KV write. New bytes: the store and the app's KV writes (503), the KV
 * write, then one batch that reads the first photo it replaces (so two at once never delete the
 * same old object).
 */
receiptPhotoRoutes.put('/groups/:gid/expenses/:eid/receipt', requireUser, async c => {
  const db = c.env.DB;
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  const width = side(c, 'w');
  const height = side(c, 'h');
  const type = photoType(c);
  lengthCheck(c);
  const kv = store(c);
  const { entry, photos } = await entryFor(c, gid, eid, true);
  if (entry.deleted_at) notFound();
  const bytes = await readPhoto(c, type);

  const day = todayUTC();
  // Counted only once the photo passed the checks, and before the same-bytes check, as always.
  await countToday(c, `receipt-photo:user:${c.get('user').id}:${day}`, RECEIPT_PHOTO_PER_DAY, retryAfter =>
    fail(429, 'rate_limited', 'No receipt photo uploads left today', { scope: 'user', retryAfter }),
  );
  const version = await versionOf(bytes);
  // The same photo again (a retry whose answer was lost): nothing to write.
  if (photos[0]?.version === version) return json(c, legacyRes(photos, entry.group_version));
  const now = nowISO();

  if (photos.some(p => p.version === version)) {
    // Already photo 2 or 3: it moves up in place of the first.
    let res: D1Result[];
    try {
      res = await db.batch([
        promoteStmt(db, eid),
        dedupeStmt(db, eid),
        firstRowStmt(db, eid),
        db
          .prepare(
            `INSERT INTO receipts (${PHOTO_COLUMNS}) SELECT ${PHOTO_COLUMNS} FROM receipt_extras WHERE expense_id = ?1 AND version = ?2
             ON CONFLICT(expense_id) DO UPDATE SET ${SET_FROM_EXCLUDED}`,
          )
          .bind(eid, version),
        db.prepare('DELETE FROM receipt_extras WHERE expense_id = ?1 AND version = ?2').bind(eid, version),
        bumpVersionStmt(db, gid, now),
        carrySummaryStmt(db, gid),
        photosStmt(db, eid),
      ]);
    } catch (err) {
      console.error(`PUT receipt ${eid}: the batch failed: ${err instanceof Error ? err.name : 'error'}`);
      await settleLegacyBatch(db, kv, eid, version, null, photos[0]);
      fail(503, 'server_error', 'The photo could not be stored right now. Try again later');
    }
    const list = inOrder(rows<PhotoRow>(res[7]));
    if (list[0]?.version !== version) fail(503, 'server_error', 'The photos of this entry changed at the same time. Try again');
    await dropReplaced(db, kv, rows<{ kv_key: string }>(res[2])[0], list, eid);
    return json(c, legacyRes(list, versionFromBatch(res, 5)));
  }

  // It becomes the first photo: only the whole store's cap applies, as before several photos.
  await admitNewBytes(c, entry, bytes.length, day, true, false);
  const key = receiptKey(eid, version);
  await putObject(kv, key, bytes, eid);
  let res: D1Result[];
  try {
    res = await db.batch([
      promoteStmt(db, eid),
      dedupeStmt(db, eid),
      firstRowStmt(db, eid),
      db
        .prepare(
          `INSERT INTO receipts (${PHOTO_COLUMNS}) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE ${LIVE_EXPENSE}
           ON CONFLICT(expense_id) DO UPDATE SET ${SET_FROM_EXCLUDED}`,
        )
        .bind(eid, gid, key, version, type.mime, bytes.length, width, height, c.get('user').id, now),
      bumpVersionStmt(db, gid, now),
      carrySummaryStmt(db, gid),
      photosStmt(db, eid),
    ]);
  } catch (err) {
    console.error(`PUT receipt ${eid}: the batch failed: ${err instanceof Error ? err.name : 'error'}`);
    await settleLegacyBatch(db, kv, eid, version, key, photos[0]);
    fail(503, 'server_error', 'The photo could not be stored right now. Try again later');
  }
  const list = inOrder(rows<PhotoRow>(res[6]));
  if (list[0]?.version !== version) {
    // The entry was deleted meanwhile: no row names the new object.
    await dropIfUnnamed(db, kv, key, eid);
    notFound();
  }
  await dropReplaced(db, kv, rows<{ kv_key: string }>(res[2])[0], list, eid);
  return json(c, legacyRes(list, versionFromBatch(res, 4)));
});

/**
 * Any photo's bytes for whoever can see the group's entries (an active member of the live group,
 * as the snapshot). With ?v= (how clients build the address) it is that photo, from either table,
 * and the answer never changes, so browsers keep it a year; without, it is the first photo, checked
 * every time. One 404 for every refusal (no photo, not allowed, a version the entry does not have),
 * so the answer says nothing about which it was.
 */
receiptPhotoRoutes.get('/groups/:gid/expenses/:eid/receipt', requireUser, async c => {
  const kv = c.env.RECEIPTS;
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  const v = c.req.query('v');
  const row = kv && ID_RE.test(eid) && gid.length <= 100
    ? await c.env.DB.prepare(VISIBLE_SQL).bind(gid, eid, c.get('user').id, v ?? null).first<{ kv_key: string; version: string; mime: string }>()
    : null;
  if (!row) notFound();
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

/**
 * Take the first photo off the entry, the one clients from before several photos show; the next
 * one becomes first. Its KV object first, then its row (a failed KV delete keeps both). It works on
 * a deleted entry. With no photo it changes nothing.
 *
 * Such a client names no photo, and before several photos a repeat found none and changed
 * nothing; now a repeat would take the next one, a photo that client never showed. So the batch
 * remembers, for RECEIPT_LEGACY_DELETE_WINDOW_S, which photo it left first for this account; while
 * that one is still first, this account's next legacy DELETE is a retry whose answer was lost
 * (the old web outbox's, iPhone 1.0's 再試一次 or second 儲存) and writes nothing.
 */
receiptPhotoRoutes.delete('/groups/:gid/expenses/:eid/receipt', requireUser, async c => {
  const db = c.env.DB;
  const gid = c.req.param('gid');
  const eid = c.req.param('eid');
  const kv = store(c);
  const { entry, photos } = await entryFor(c, gid, eid, false);
  const first = photos[0];
  if (!first) {
    const none: ReceiptDeleteRes = { groupVersion: entry.group_version, receipt: null, receipts: [] };
    return json(c, none);
  }
  const prefix = `receipt-legacy-del:${c.get('user').id}:${eid}:`;
  const retry = await db
    .prepare('SELECT 1 AS hit FROM rate_limits WHERE key = ?1 AND reset_at > ?2')
    .bind((prefix + first.version).slice(0, 200), Date.now())
    .first<{ hit: number }>();
  if (retry) {
    const receipts = dtos(photos);
    const same: ReceiptDeleteRes = { groupVersion: entry.group_version, receipt: receipts[0] ?? null, receipts };
    return json(c, same);
  }
  await deleteObject(kv, first.kv_key, eid);
  const now = nowISO();
  const res = await db.batch([
    db.prepare('DELETE FROM receipts WHERE expense_id = ?1 AND kv_key = ?2').bind(eid, first.kv_key),
    db.prepare('DELETE FROM receipt_extras WHERE expense_id = ?1 AND kv_key = ?2').bind(eid, first.kv_key),
    promoteStmt(db, eid),
    dedupeStmt(db, eid),
    // The photo first now, for this account's retries (none when no photo is left).
    db
      .prepare(
        `INSERT INTO rate_limits (key, count, reset_at) SELECT substr(?1 || version, 1, 200), 1, ?2 FROM receipts WHERE expense_id = ?3
         ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
      )
      .bind(prefix, Date.now() + RECEIPT_LEGACY_DELETE_WINDOW_S * 1000, eid),
    bumpVersionStmt(db, gid, now),
    carrySummaryStmt(db, gid),
    photosStmt(db, eid),
  ]);
  const receipts = dtos(inOrder(rows<PhotoRow>(res[7])));
  const out: ReceiptDeleteRes = { groupVersion: versionFromBatch(res, 5), receipt: receipts[0] ?? null, receipts };
  return json(c, out);
});
