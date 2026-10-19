// Profile photos (routes/avatars.ts; docs/SPEC.md section 6, Profile photo): uploading (the
// checks, the size limit and the body gate, the daily limit, the cookie rule for writes), who may
// fetch a photo and how the answer is cached, removing it, account deletion and the export, and the
// `avatar` field in every DTO that names a person. Runs the real Worker against the real schema in
// SQLite (d1-sqlite.ts, which hands BLOBs back the way D1 does) with https://split.test as the
// app's origin.

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GroupSnapshotDTO, MeDTO, MemberDTO } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import { MAX_BODY_BYTES } from '../../src/worker/http';
import worker from '../../src/worker/index';
import { AVATAR_MAX_BODY, AVATAR_MAX_BYTES, AVATAR_PER_DAY } from '../../src/worker/routes/avatars';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';
/** A sibling site: same-site for SameSite=Lax, so the browser still sends the cookie from it. */
const SIBLING = 'https://award.split.test';

/** A real 4 x 4 JPEG (quality 85) and a real 2 x 2 PNG. */
const JPEG = Buffer.from(
  '/9j/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC8AGLE/9k=',
  'base64',
);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPQz9/6H4QZYAwATi4JSZ2rmMEAAAAASUVORK5CYII=', 'base64');

const dataUrl = (mime: string, bytes: Uint8Array): string => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const versionOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
/** `n` bytes that start like a JPEG. */
function jpegOf(n: number, fill = 0): Uint8Array {
  const b = new Uint8Array(n).fill(fill);
  b.set([0xff, 0xd8, 0xff]);
  return b;
}

let db: TestD1;
const tokens: Record<string, string> = {};

interface Call {
  /** Sign in with this account's Bearer token. */
  as?: string;
  /** Sign in with this Cookie header instead. */
  cookie?: string;
  /** Where a cookie request comes from: this app (default), a sibling site, or a script that sends neither header. */
  from?: 'app' | 'sibling' | 'script';
  body?: unknown;
  /** The body text as it is. */
  raw?: string;
  headers?: Record<string, string>;
}

interface Res<T = any> {
  status: number;
  data: T;
  bytes: Buffer;
  headers: Headers;
}

async function call<T = any>(method: string, path: string, o: Call = {}): Promise<Res<T>> {
  const h: Record<string, string> = {};
  if (o.as) h.Authorization = 'Bearer ' + tokens[o.as];
  if (o.cookie) {
    h.Cookie = o.cookie;
    const write = method !== 'GET' && method !== 'HEAD';
    if (o.from === 'sibling') Object.assign(h, { 'Sec-Fetch-Site': 'same-site', Origin: SIBLING });
    else if (o.from !== 'script') Object.assign(h, write ? { 'Sec-Fetch-Site': 'same-origin', Origin: SITE } : { 'Sec-Fetch-Site': 'same-origin' });
  }
  const text = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  if (text !== undefined) h['Content-Type'] = 'application/json';
  Object.assign(h, o.headers);
  const req = new Request(SITE + path, { method, headers: h, body: text });
  const env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const bytes = Buffer.from(await res.arrayBuffer());
  const isJson = (res.headers.get('Content-Type') || '').includes('json');
  return { status: res.status, data: isJson && bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined, bytes, headers: res.headers };
}

const put = (as: string, image: unknown) => call<{ avatar: string }>('PUT', '/api/me/avatar', { as, body: { image } });
const photoOf = (userId: string, as: string, v?: string, headers?: Record<string, string>) =>
  call('GET', `/api/users/${userId}/avatar` + (v === undefined ? '' : '?v=' + encodeURIComponent(v)), { as, headers });

/** The Cookie header a browser signed in as `id` on this site sends. */
const jar = (id: string): string => `__Host-evenly_session=${tokens[id]}; __Host-evenly_user=${id}`;

function addUser(id: string, name: string, email: string | null): void {
  const at = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, email, '#2F6FB5', at, at);
}

interface World {
  gid: string;
  /** Member ids in the trip. */
  gino: string;
  abbie: string;
  kai: string;
}

/** Gino's trip with Abbie (joined by the invite link) and Kai (a placeholder). Leo shares no group with anyone. */
async function world(): Promise<World> {
  const people: [string, string, string | null][] = [
    ['gino', 'Gino', 'gino@split.test'],
    ['abbie', 'Abbie', 'abbie@split.test'],
    ['leo', 'Leo', 'leo@split.test'],
  ];
  for (const [id, name, email] of people) {
    addUser(id, name, email);
    tokens[id] = await createSession(db.d1, id, 'test');
  }
  const trip = (await call<GroupSnapshotDTO>('POST', '/api/groups', { as: 'gino', body: { name: 'Niseko', type: 'trip', currency: 'JPY', members: [{ name: 'Kai' }] } })).data;
  const join = await call('POST', '/api/join/' + trip.inviteCode, { as: 'abbie', body: { name: 'Abbie' } });
  expect(join.status).toBe(200);
  return { gid: trip.group.id, gino: trip.me.memberId, abbie: join.data.memberId, kai: trip.members.find(m => m.name === 'Kai')!.id };
}

const groupVersion = (gid: string): number => db.rows<{ version: number }>('SELECT version FROM groups WHERE id = ?', gid)[0].version;
const storedAvatar = (id: string): string | null => db.rows<{ avatar: string | null }>('SELECT avatar FROM users WHERE id = ?', id)[0].avatar;
const avatarRows = (id: string) => db.rows<{ mime: string; data: Uint8Array; version: string }>('SELECT mime, data, version FROM avatars WHERE user_id = ?', id);
const NOT_FOUND = { error: { code: 'not_found', message: 'Not found' } };

beforeEach(() => {
  db = new TestD1();
});

// ---------- uploading ----------

describe('PUT /api/me/avatar', () => {
  it('stores a JPEG, sets users.avatar to its version, and answers the version', async () => {
    await world();
    const r = await put('gino', dataUrl('image/jpeg', JPEG));
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ avatar: versionOf(JPEG) });
    expect(r.data.avatar).toMatch(/^[0-9a-f]{16}$/);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.headers.get('Vary')).toBe('*');
    const [row] = avatarRows('gino');
    expect(row.mime).toBe('image/jpeg');
    expect(Buffer.from(row.data).equals(JPEG)).toBe(true);
    expect(row.version).toBe(versionOf(JPEG));
    expect(storedAvatar('gino')).toBe(versionOf(JPEG));
  });

  it('stores a PNG, and a new photo replaces the old one', async () => {
    await world();
    await put('gino', dataUrl('image/jpeg', JPEG));
    const r = await put('gino', dataUrl('image/png', PNG));
    expect(r.status).toBe(200);
    expect(r.data.avatar).toBe(versionOf(PNG));
    const rows = avatarRows('gino');
    expect(rows).toHaveLength(1);
    expect(rows[0].mime).toBe('image/png');
    expect(Buffer.from(rows[0].data).equals(PNG)).toBe(true);
    expect(storedAvatar('gino')).toBe(versionOf(PNG));
  });

  it('refuses anything but a JPEG or PNG data URL whose bytes start like one: 400 bad_request, fields image, nothing kept or counted', async () => {
    await world();
    const cases: [string, Call][] = [
      ['PNG bytes called a JPEG', { body: { image: dataUrl('image/jpeg', PNG) } }],
      ['JPEG bytes called a PNG', { body: { image: dataUrl('image/png', JPEG) } }],
      ['a page in a JPEG data URL', { body: { image: dataUrl('image/jpeg', Buffer.from('<svg onload="alert(1)"></svg>')) } }],
      ['a GIF', { body: { image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' } }],
      ['a WebP', { body: { image: dataUrl('image/webp', Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')) } }],
      ['not base64', { body: { image: 'data:image/jpeg;base64,/9j/4AAQ!!' } }],
      ['no bytes', { body: { image: 'data:image/jpeg;base64,' } }],
      ['bare base64', { body: { image: JPEG.toString('base64') } }],
      ['no image', { body: {} }],
      ['image is not a string', { body: { image: 42 } }],
      ['not JSON', { raw: '{"image":' }],
      ['null', { raw: 'null' }],
      ['an empty body', { raw: '' }],
    ];
    for (const [what, o] of cases) {
      const r = await call('PUT', '/api/me/avatar', { as: 'gino', ...o });
      expect([what, r.status, r.data?.error?.code, r.data?.error?.details]).toEqual([what, 400, 'bad_request', { fields: ['image'] }]);
    }
    expect(db.rows('SELECT user_id FROM avatars')).toEqual([]);
    expect(storedAvatar('gino')).toBeNull();
    expect(db.rows("SELECT key FROM rate_limits WHERE key LIKE 'avatar:%'")).toEqual([]);
  });

  it('takes up to 150,000 bytes and refuses one more with 400', async () => {
    await world();
    const most = jpegOf(AVATAR_MAX_BYTES);
    const ok = await put('gino', dataUrl('image/jpeg', most));
    expect(ok.status).toBe(200);
    expect(avatarRows('gino')[0].data.length).toBe(AVATAR_MAX_BYTES);
    const over = await put('gino', dataUrl('image/jpeg', jpegOf(AVATAR_MAX_BYTES + 1)));
    expect(over.status).toBe(400);
    expect(over.data.error).toMatchObject({ code: 'bad_request', details: { fields: ['image'] } });
    expect(storedAvatar('gino')).toBe(versionOf(most));
  });

  it('lets the largest photo past the 256 KB gate, also with every "/" escaped, and no body past AVATAR_MAX_BODY', async () => {
    await world();
    // 0xFF bytes are "////" in base64, and Apple's JSON encoders write each "/" as "\/".
    const slashes = jpegOf(AVATAR_MAX_BYTES, 0xff);
    const text = JSON.stringify({ image: dataUrl('image/jpeg', slashes) }).replace(/\//g, '\\/');
    expect(text.length).toBeGreaterThan(MAX_BODY_BYTES);
    expect(text.length).toBeLessThanOrEqual(AVATAR_MAX_BODY);
    const r = await call('PUT', '/api/me/avatar', { as: 'gino', raw: text });
    expect(r.status).toBe(200);
    expect(r.data.avatar).toBe(versionOf(slashes));

    const huge = await call('PUT', '/api/me/avatar', { as: 'gino', raw: JSON.stringify({ image: 'data:image/jpeg;base64,' + 'A'.repeat(AVATAR_MAX_BODY) }) });
    expect(huge.status).toBe(413);
    expect(huge.data.error.code).toBe('payload_too_large');
    // The other routes keep the 256 KB gate.
    const other = await call('PATCH', '/api/me', { as: 'gino', raw: JSON.stringify({ name: 'x', pad: 'A'.repeat(MAX_BODY_BYTES) }) });
    expect(other.status).toBe(413);
  });

  it('needs a session', async () => {
    await world();
    const r = await call('PUT', '/api/me/avatar', { body: { image: dataUrl('image/jpeg', JPEG) } });
    expect(r.status).toBe(401);
    expect(r.data.error.code).toBe('unauthorized');
    expect((await call('DELETE', '/api/me/avatar')).status).toBe(401);
    expect(db.rows('SELECT user_id FROM avatars')).toEqual([]);
  });

  it('with the cookie, only this site may change the photo (403 forbidden from another site, never 401)', async () => {
    await world();
    const image = dataUrl('image/jpeg', JPEG);
    for (const from of ['sibling', 'script'] as const) {
      const r = await call('PUT', '/api/me/avatar', { cookie: jar('gino'), from, body: { image } });
      expect([from, r.status, r.data.error.code]).toEqual([from, 403, 'forbidden']);
    }
    expect(db.rows('SELECT user_id FROM avatars')).toEqual([]);
    const ok = await call('PUT', '/api/me/avatar', { cookie: jar('gino'), body: { image } });
    expect(ok.status).toBe(200);
    for (const from of ['sibling', 'script'] as const) {
      const r = await call('DELETE', '/api/me/avatar', { cookie: jar('gino'), from });
      expect([from, r.status]).toEqual([from, 403]);
    }
    expect(storedAvatar('gino')).toBe(ok.data.avatar);
    // An <img> on the app's page: a GET with the cookie and no Origin.
    const img = await call('GET', `/api/users/gino/avatar?v=${ok.data.avatar}`, { cookie: jar('gino'), from: 'script' });
    expect(img.status).toBe(200);
    expect(img.bytes.equals(JPEG)).toBe(true);
  });

  it('takes 30 uploads per account per day, then 429', async () => {
    await world();
    const image = dataUrl('image/png', PNG);
    for (let i = 0; i < AVATAR_PER_DAY; i++) expect((await put('gino', image)).status).toBe(200);
    const r = await put('gino', image);
    expect(r.status).toBe(429);
    expect(r.data.error.code).toBe('rate_limited');
    expect(r.data.error.details.retryAfter).toBeGreaterThan(0);
    expect(r.data.error.details.retryAfter).toBeLessThanOrEqual(86_400);
    expect(Number(r.headers.get('Retry-After'))).toBe(r.data.error.details.retryAfter);
    // Removing is not counted, and other accounts have their own count.
    expect((await call('DELETE', '/api/me/avatar', { as: 'gino' })).status).toBe(200);
    expect((await put('abbie', image)).status).toBe(200);
  });

  it('changes the ETag of every group the account has a member row in, so cached snapshots pick up the photo, and writes no activity', async () => {
    const w = await world();
    // A second group that Abbie joined and left: her member row stays there, inactive.
    const home = (await call<GroupSnapshotDTO>('POST', '/api/groups', { as: 'gino', body: { name: 'Home', type: 'home', currency: 'TWD' } })).data;
    const joined = await call('POST', '/api/join/' + home.inviteCode, { as: 'abbie', body: { name: 'Abbie' } });
    expect((await call('DELETE', `/api/groups/${home.group.id}/members/${joined.data.memberId}`, { as: 'abbie' })).status).toBe(200);
    // Somebody else's group stays as it is.
    const leos = (await call<GroupSnapshotDTO>('POST', '/api/groups', { as: 'leo', body: { name: 'Leo', type: 'other', currency: 'USD' } })).data;
    const groups = [w.gid, home.group.id];

    /** Gino's device: the snapshot again when its ETag changed since `etag`, else 304. */
    const fetchSnap = (gid: string, etag?: string) =>
      call<GroupSnapshotDTO>('GET', '/api/groups/' + gid, { as: 'gino', headers: etag ? { 'If-None-Match': etag } : {} });
    const abbieIn = (snap: GroupSnapshotDTO) => snap.members.find(m => m.userId === 'abbie')!;

    const etags: Record<string, string> = {};
    for (const gid of groups) etags[gid] = (await fetchSnap(gid)).headers.get('ETag')!;
    const leoEtag = (await call('GET', '/api/groups/' + leos.group.id, { as: 'leo' })).headers.get('ETag');
    const updatedAt = db.rows('SELECT id, updated_at FROM groups ORDER BY id');
    const activity = db.rows('SELECT id FROM activity').length;

    const v = (await put('abbie', dataUrl('image/jpeg', JPEG))).data.avatar;
    for (const gid of groups) {
      const r = await fetchSnap(gid, etags[gid]);
      expect([gid, r.status]).toEqual([gid, 200]);
      expect(r.headers.get('ETag')).not.toBe(etags[gid]);
      expect(abbieIn(r.data).avatar).toBe(v);
      etags[gid] = r.headers.get('ETag')!;
    }
    expect((await call('GET', '/api/groups/' + leos.group.id, { as: 'leo' })).headers.get('ETag')).toBe(leoEtag);
    // Only the versions move, as for a new name: the groups keep their place in the lists, and no
    // activity row (so no push) is written.
    expect(db.rows('SELECT id, updated_at FROM groups ORDER BY id')).toEqual(updatedAt);
    expect(db.rows('SELECT id FROM activity')).toHaveLength(activity);

    // The same photo again changes nothing.
    expect((await put('abbie', dataUrl('image/jpeg', JPEG))).data.avatar).toBe(v);
    for (const gid of groups) expect((await fetchSnap(gid, etags[gid])).status).toBe(304);

    // Removing it changes the ETags again.
    expect((await call('DELETE', '/api/me/avatar', { as: 'abbie' })).status).toBe(200);
    for (const gid of groups) {
      const r = await fetchSnap(gid, etags[gid]);
      expect([gid, r.status]).toEqual([gid, 200]);
      expect(abbieIn(r.data).avatar).toBeNull();
    }
  });
});

// ---------- fetching ----------

describe('GET /api/users/:userId/avatar', () => {
  it('gives the person and a group mate the bytes, kept a year at the ?v= address', async () => {
    await world();
    const v = (await put('gino', dataUrl('image/jpeg', JPEG))).data.avatar;
    for (const who of ['gino', 'abbie']) {
      const r = await photoOf('gino', who, v);
      expect([who, r.status]).toEqual([who, 200]);
      expect(r.bytes.equals(JPEG)).toBe(true);
      expect(r.headers.get('Content-Type')).toBe('image/jpeg');
      expect(r.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
      expect(r.headers.get('ETag')).toBe(`"${v}"`);
      // Not Vary: *, which would keep the browser from storing it.
      expect(r.headers.get('Vary')).toBe('Origin');
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
      // No other site may show it in an <img> with the viewer's cookie.
      expect(r.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    }
    const png = (await put('abbie', dataUrl('image/png', PNG))).data.avatar;
    const r = await photoOf('abbie', 'gino', png);
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('image/png');
    expect(r.bytes.equals(PNG)).toBe(true);
  });

  it('answers one 404 for a stranger, no photo, no account and a placeholder', async () => {
    const w = await world();
    const v = (await put('gino', dataUrl('image/jpeg', JPEG))).data.avatar;
    const refusals: [string, Res][] = [
      ['a stranger', await photoOf('gino', 'leo', v)],
      ['a stranger without v', await photoOf('gino', 'leo')],
      ['a group mate without a photo', await photoOf('abbie', 'gino')],
      ['no such account', await photoOf('nobody', 'gino')],
      ['a placeholder (no account)', await photoOf(w.kai, 'gino')],
    ];
    for (const [what, r] of refusals) {
      expect([what, r.status, r.data]).toEqual([what, 404, NOT_FOUND]);
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
    // The placeholder's member says so too.
    const snap = (await call<GroupSnapshotDTO>('GET', '/api/groups/' + w.gid, { as: 'gino' })).data;
    expect(snap.members.find(m => m.id === w.kai)!.avatar).toBeNull();
  });

  it('a stale v is a 404; without v it is the current photo, checked every time; If-None-Match gets a 304', async () => {
    await world();
    const v1 = (await put('gino', dataUrl('image/jpeg', JPEG))).data.avatar;
    const v2 = (await put('gino', dataUrl('image/png', PNG))).data.avatar;
    expect(await photoOf('gino', 'abbie', v1)).toMatchObject({ status: 404, data: NOT_FOUND });
    expect((await photoOf('gino', 'abbie', '')).status).toBe(404);
    const now = await photoOf('gino', 'abbie');
    expect(now.status).toBe(200);
    expect(now.bytes.equals(PNG)).toBe(true);
    expect(now.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(now.headers.get('ETag')).toBe(`"${v2}"`);
    const same = await photoOf('gino', 'abbie', undefined, { 'If-None-Match': `"${v2}"` });
    expect(same.status).toBe(304);
    expect(same.bytes.length).toBe(0);
    expect(same.headers.get('ETag')).toBe(`"${v2}"`);
    expect((await photoOf('gino', 'abbie', v2, { 'If-None-Match': `"${v2}"` })).status).toBe(304);
    expect((await photoOf('gino', 'abbie', undefined, { 'If-None-Match': `"${v1}"` })).status).toBe(200);
  });

  it('needs a session', async () => {
    await world();
    const v = (await put('gino', dataUrl('image/jpeg', JPEG))).data.avatar;
    const r = await call('GET', `/api/users/gino/avatar?v=${v}`);
    expect(r.status).toBe(401);
    expect(r.data.error.code).toBe('unauthorized');
  });

  it('people who left still show in the group; someone who left sees nobody there', async () => {
    const w = await world();
    const abbie = (await put('abbie', dataUrl('image/png', PNG))).data.avatar;
    const gino = (await put('gino', dataUrl('image/jpeg', JPEG))).data.avatar;
    expect((await call('DELETE', `/api/groups/${w.gid}/members/${w.abbie}`, { as: 'abbie' })).status).toBe(200);
    expect((await photoOf('abbie', 'gino', abbie)).status).toBe(200);
    const snap = (await call<GroupSnapshotDTO>('GET', '/api/groups/' + w.gid, { as: 'gino' })).data;
    expect(snap.members.find(m => m.id === w.abbie)).toMatchObject({ active: false, avatar: abbie });
    expect((await photoOf('gino', 'abbie', gino)).status).toBe(404);
  });

  it('a deleted group and an unlinked member show no photo', async () => {
    const w = await world();
    const abbie = (await put('abbie', dataUrl('image/png', PNG))).data.avatar;
    // Unlinked: Abbie's member is a placeholder again, and she shares no other group with Gino.
    const unlink = await call<{ member: MemberDTO }>('POST', `/api/groups/${w.gid}/members/${w.abbie}/unlink`, { as: 'gino', body: {} });
    expect(unlink.data.member).toMatchObject({ userId: null, avatar: null });
    expect((await photoOf('abbie', 'gino', abbie)).status).toBe(404);

    // Together again in another group, until Gino deletes it.
    const home = (await call<GroupSnapshotDTO>('POST', '/api/groups', { as: 'gino', body: { name: 'Home', type: 'home', currency: 'TWD' } })).data;
    expect((await call('POST', '/api/join/' + home.inviteCode, { as: 'abbie', body: { name: 'Abbie' } })).status).toBe(200);
    expect((await photoOf('abbie', 'gino', abbie)).status).toBe(200);
    expect((await call('DELETE', '/api/groups/' + home.group.id, { as: 'gino' })).status).toBe(200);
    expect((await photoOf('abbie', 'gino', abbie)).status).toBe(404);
  });
});

// ---------- removing, deleting the account, the export ----------

describe('DELETE /api/me/avatar', () => {
  it('removes the photo and answers avatar null, also when there is none', async () => {
    const w = await world();
    const v = (await put('gino', dataUrl('image/jpeg', JPEG))).data.avatar;
    const before = groupVersion(w.gid);
    const r = await call('DELETE', '/api/me/avatar', { as: 'gino' });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ avatar: null });
    expect(avatarRows('gino')).toEqual([]);
    expect(storedAvatar('gino')).toBeNull();
    expect(groupVersion(w.gid)).toBe(before + 1);
    expect((await photoOf('gino', 'gino', v)).status).toBe(404);
    expect((await photoOf('gino', 'abbie')).status).toBe(404);
    // Nothing left to remove: the same answer, and the groups stay as they are.
    const again = await call('DELETE', '/api/me/avatar', { as: 'gino' });
    expect(again.status).toBe(200);
    expect(again.data).toEqual({ avatar: null });
    expect(groupVersion(w.gid)).toBe(before + 1);
  });
});

describe('the photo and the rest of the account', () => {
  it('deleting the account deletes the photo', async () => {
    const w = await world();
    const v = (await put('abbie', dataUrl('image/png', PNG))).data.avatar;
    const r = await call('DELETE', '/api/me', { as: 'abbie', body: {} });
    expect(r.status).toBe(200);
    expect(avatarRows('abbie')).toEqual([]);
    expect(db.rows('SELECT id FROM users WHERE id = ?', 'abbie')).toEqual([]);
    expect((await photoOf('abbie', 'gino', v)).status).toBe(404);
    const snap = (await call<GroupSnapshotDTO>('GET', '/api/groups/' + w.gid, { as: 'gino' })).data;
    expect(snap.members.find(m => m.id === w.abbie)).toMatchObject({ userId: null, avatar: null });
  });

  it('the export has the photo as user.avatarImage, a data URL, or null', async () => {
    await world();
    const none = await call('GET', '/api/me/export', { as: 'gino' });
    expect(none.status).toBe(200);
    expect(none.data.user).toMatchObject({ id: 'gino', avatar: null, avatarImage: null });
    const v = (await put('gino', dataUrl('image/jpeg', JPEG))).data.avatar;
    const e = await call('GET', '/api/me/export', { as: 'gino' });
    expect(e.data.user.avatar).toBe(v);
    expect(e.data.user.avatarImage).toBe(dataUrl('image/jpeg', JPEG));
    const mine = (e.data.groups as GroupSnapshotDTO[])[0].members.find(m => m.userId === 'gino')!;
    expect(mine.avatar).toBe(v);
    // The largest photo comes back whole.
    const most = jpegOf(AVATAR_MAX_BYTES, 0x5a);
    await put('gino', dataUrl('image/jpeg', most));
    expect((await call('GET', '/api/me/export', { as: 'gino' })).data.user.avatarImage).toBe(dataUrl('image/jpeg', most));
  });
});

// ---------- the DTOs ----------

describe('avatar in the DTOs', () => {
  it('UserDTO, MemberDTO, GroupListItemDTO.members and FriendDTO carry the version, or null', async () => {
    const w = await world();
    // A 1:1 ledger with Abbie's account (a u: friend), next to Kai (an m: friend).
    expect((await call('POST', '/api/friends', { as: 'gino', body: { name: 'Abbie', email: 'abbie@split.test' } })).status).toBe(200);
    const v = (await put('abbie', dataUrl('image/png', PNG))).data.avatar;

    const me = (await call<MeDTO>('GET', '/api/me', { as: 'gino' })).data;
    expect(me.user.avatar).toBeNull();
    const trip = me.groups.find(g => g.id === w.gid)!;
    expect(trip.members.find(m => m.userId === 'abbie')!.avatar).toBe(v);
    expect(trip.members.find(m => m.userId === 'gino')!.avatar).toBeNull();
    expect(trip.members.find(m => m.id === w.kai)!.avatar).toBeNull();
    expect(me.friends.find(f => f.key === 'u:abbie')!.avatar).toBe(v);
    expect(me.friends.find(f => f.key === 'm:' + w.kai)!.avatar).toBeNull();

    const snap = (await call<GroupSnapshotDTO>('GET', '/api/groups/' + w.gid, { as: 'gino' })).data;
    expect(snap.members.find(m => m.userId === 'abbie')!.avatar).toBe(v);
    expect(snap.members.find(m => m.id === w.kai)!.avatar).toBeNull();

    // Her own account, also after a profile change.
    expect((await call<MeDTO>('GET', '/api/me', { as: 'abbie' })).data.user.avatar).toBe(v);
    expect((await call('PATCH', '/api/me', { as: 'abbie', body: { name: 'Abbie L' } })).data.user.avatar).toBe(v);

    // Someone added by email comes with their photo.
    const leo = (await put('leo', dataUrl('image/jpeg', JPEG))).data.avatar;
    const added = await call<{ member: MemberDTO }>('POST', `/api/groups/${w.gid}/members`, { as: 'gino', body: { name: 'Leo', email: 'leo@split.test' } });
    expect(added.status).toBe(200);
    expect(added.data.member.avatar).toBe(leo);

    // A new account has none.
    const signup = await call('POST', '/api/auth/signup', { body: { name: 'New' } });
    expect(signup.status).toBe(200);
    expect(signup.data.user.avatar).toBeNull();
  });
});
