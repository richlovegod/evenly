// Payment details and photos of a member someone else linked by email (Gino's decision of
// 2026-11-21; reviews B2-03 and B4b-02; docs/SPEC.md section 4, Payment details and photos): until
// that member's person opens the group (members.accepted_at, migration 0018), nobody else gets
// their pay_info, Venmo, PayPal or photo in any answer: the snapshot, the add's own answer, GET
// /api/me's groups and friends, the export and the photo's address. Their own details they always
// see. Opening it (GET), any write in it, joining or claiming it by a link and a friend invite mark
// it; the dashboard, the feed, the export, archiving and leaving do not. Runs the real Worker
// against the real schema (d1-sqlite.ts), and the migration's backfill on rows made before it.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayUTC } from '../../src/shared/dates';
import type { FriendDTO, GroupSnapshotDTO, MeDTO, MemberDTO, MyInviteDTO } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { migrationFiles, TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';
const MIGRATIONS = new URL('../../migrations/', import.meta.url);

let db: TestD1;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  data: T;
  etag: string | null;
}

async function call<T = any>(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  const h: Record<string, string> = { 'cf-connecting-ip': '203.0.113.9', ...headers };
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request(SITE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  // RECEIPTS: the photo routes refuse without the binding; the one write here never reaches it.
  const env = { DB: db.d1, RECEIPTS: {}, ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const json = (res.headers.get('Content-Type') || '').includes('json');
  const text = json ? await res.text() : '';
  return { status: res.status, data: text ? JSON.parse(text) : undefined, etag: res.headers.get('ETag') };
}

const PHOTO = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4];

/** An account with payment details and a photo (its version is `v-<id>`, padded to 16). */
async function addUser(id: string, name: string, email: string | null): Promise<void> {
  const now = new Date().toISOString();
  db.exec(
    'INSERT INTO users (id, name, email, color, pay_info, venmo, paypal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, name, email, '#2F6FB5', `國泰世華 013 ${id}`, id + '-v', id + '-p', now, now,
  );
  const version = (id + '0000000000000000').slice(0, 16);
  await db.d1.prepare('INSERT INTO avatars (user_id, mime, data, version, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, 'image/jpeg', PHOTO, version, now).run();
  db.exec('UPDATE users SET avatar = ? WHERE id = ?', version, id);
  tokens[id] = await createSession(db.d1, id, 'test');
}

const photoVersion = (id: string): string => (id + '0000000000000000').slice(0, 16);
const photoOf = (userId: string, as: string) => call(as, 'GET', `/api/users/${userId}/avatar?v=${photoVersion(userId)}`);
const snapOf = (as: string, gid: string, etag?: string) =>
  call<GroupSnapshotDTO>(as, 'GET', '/api/groups/' + gid, undefined, etag ? { 'If-None-Match': etag } : {});
const memberIn = (snap: GroupSnapshotDTO, userId: string): MemberDTO => snap.members.find(m => m.userId === userId)!;
const friendOf = (me: MeDTO, userId: string): FriendDTO => me.friends.find(f => f.key === 'u:' + userId)!;
const acceptedAt = (gid: string, userId: string) =>
  db.rows<{ accepted_at: string | null }>('SELECT accepted_at FROM members WHERE group_id = ? AND user_id = ?', gid, userId)[0]?.accepted_at;
const versionOf = (gid: string) => db.rows<{ version: number }>('SELECT version FROM groups WHERE id = ?', gid)[0].version;

/** What nobody else may get of a member not opened yet. */
const HIDDEN = { payInfo: '', venmo: '', paypal: '', avatar: null, detailsHidden: true };
/** The account's own details as an opened member carries them. */
const shown = (id: string) => ({ payInfo: `國泰世華 013 ${id}`, venmo: id + '-v', paypal: id + '-p', avatar: photoVersion(id) });

let seq = 0;
function expense(payer: string, owers: string[], amount: number) {
  return {
    kind: 'expense', description: 'entry ' + ++seq, category: 'general', amount, currency: 'TWD', fxRate: 1, date: todayUTC(),
    payers: [{ memberId: payer, amount }], split: { method: 'equal', entries: owers.map(memberId => ({ memberId })) },
  };
}

/** Gino's trip, with Abbie (account name Abbie Lin) linked by the email he typed, and Kai by name only. */
async function tripWithAbbie(): Promise<GroupSnapshotDTO> {
  const r = await call<GroupSnapshotDTO>('gino', 'POST', '/api/groups', {
    name: 'Niseko', type: 'trip', currency: 'TWD', members: [{ name: 'Abbie', email: 'abbie@split.test' }, { name: 'Kai' }],
  });
  expect(r.status).toBe(200);
  return r.data;
}

beforeEach(async () => {
  db = new TestD1();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await addUser('gino', 'Gino', 'gino@split.test');
  await addUser('abbie', 'Abbie Lin', 'abbie@split.test');
  await addUser('leo', 'Leo', 'leo@split.test');
  await addUser('mia', 'Mia', 'mia@split.test');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- the migration ----------

describe('migration 0018', () => {
  it('marks every member already linked to an account as opened, so nothing changes in groups people have, and no placeholder', () => {
    const files = migrationFiles();
    const at = files.indexOf('0018_member_accepted.sql');
    expect(at).toBeGreaterThan(0);
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const f of files.slice(0, at)) sqlite.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    const t = '2026-11-01T00:00:00.000Z';
    sqlite.exec(`INSERT INTO users (id, name, color, created_at, updated_at) VALUES ('u1', 'A', '#000000', '${t}', '${t}'), ('u2', 'B', '#000000', '${t}', '${t}')`);
    sqlite.exec(`INSERT INTO groups (id, name, type, currency, invite_code, created_by, created_at, updated_at) VALUES ('g1', 'G', 'trip', 'TWD', 'code0001', 'u1', '${t}', '${t}')`);
    const add = sqlite.prepare('INSERT INTO members (id, group_id, user_id, name, color, created_at, claimed_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    add.run('m-linked', 'g1', 'u1', 'A', '#000000', t, '2026-11-02T00:00:00.000Z', 1);
    // An old linked row without claimed_at, and a left member: both count as opened too.
    add.run('m-old', 'g1', 'u2', 'B', '#000000', '2026-11-03T00:00:00.000Z', null, 0);
    add.run('m-name', 'g1', null, 'C', '#000000', t, null, 1);
    sqlite.exec(readFileSync(new URL(files[at], MIGRATIONS), 'utf8'));
    const rows = sqlite.prepare('SELECT id, accepted_at FROM members ORDER BY id').all();
    expect(rows.map(r => ({ ...r }))).toEqual([
      { id: 'm-linked', accepted_at: '2026-11-02T00:00:00.000Z' },
      { id: 'm-name', accepted_at: null },
      { id: 'm-old', accepted_at: '2026-11-03T00:00:00.000Z' },
    ]);
  });
});

// ---------- linked by email, then opened ----------

describe('a member linked by someone else\'s email', () => {
  it('shows nobody else its payment details or photo until its person opens the group, and the creator\'s own show at once', async () => {
    const made = await tripWithAbbie();
    // The answer to the create: Abbie held back, Gino's own details as his.
    expect(memberIn(made, 'abbie')).toMatchObject(HIDDEN);
    expect(memberIn(made, 'gino')).toMatchObject(shown('gino'));
    expect(memberIn(made, 'gino').detailsHidden).toBeUndefined();
    expect(made.members.find(m => m.name === 'Kai')!.detailsHidden).toBeUndefined();
    expect(acceptedAt(made.group.id, 'abbie')).toBeNull();
    expect(acceptedAt(made.group.id, 'gino')).not.toBeNull();

    const gid = made.group.id;
    const before = await snapOf('gino', gid);
    expect(memberIn(before.data, 'abbie')).toMatchObject(HIDDEN);
    expect((await photoOf('abbie', 'gino')).status).toBe(404);
    // The dashboard: no photo on the group's list item, and the friend by the name Gino typed,
    // with nothing of the account's.
    const dash = (await call<MeDTO>('gino', 'GET', '/api/me')).data;
    expect(dash.groups[0].members.find(m => m.userId === 'abbie')!.avatar).toBeNull();
    expect(friendOf(dash, 'abbie')).toMatchObject({ name: 'Abbie', payInfo: '', venmo: '', paypal: '', avatar: null, detailsHidden: true });

    // Abbie opens the group: she sees her own details and Gino's, and the version moves once.
    const v = versionOf(gid);
    const hers = await snapOf('abbie', gid);
    expect(hers.status).toBe(200);
    expect(memberIn(hers.data, 'abbie')).toMatchObject(shown('abbie'));
    expect(memberIn(hers.data, 'gino')).toMatchObject(shown('gino'));
    expect(versionOf(gid)).toBe(v + 1);
    expect(hers.data.group.version).toBe(v + 1);
    expect(acceptedAt(gid, 'abbie')).not.toBeNull();
    // A balance-neutral bump: a stored summary that was current stays current.
    const [g] = db.rows<{ version: number; summary: string | null }>('SELECT version, summary FROM groups WHERE id = ?', gid);
    if (g.summary) expect(JSON.parse(g.summary).forVersion).toBe(g.version);
    // Opening again writes nothing more.
    await snapOf('abbie', gid);
    expect(versionOf(gid)).toBe(v + 1);

    // Gino's device with the old ETag gets the new copy, with her details, as everything else does.
    const after = await snapOf('gino', gid, before.etag!);
    expect(after.status).toBe(200);
    expect(memberIn(after.data, 'abbie')).toMatchObject(shown('abbie'));
    expect(memberIn(after.data, 'abbie').detailsHidden).toBeUndefined();
    expect((await photoOf('abbie', 'gino')).status).toBe(200);
    const dash2 = (await call<MeDTO>('gino', 'GET', '/api/me')).data;
    expect(dash2.groups[0].members.find(m => m.userId === 'abbie')!.avatar).toBe(photoVersion('abbie'));
    expect(friendOf(dash2, 'abbie')).toMatchObject({ name: 'Abbie Lin', ...shown('abbie') });
    expect(friendOf(dash2, 'abbie').detailsHidden).toBeUndefined();
  });

  it('is not opened by the dashboard, the feed, the export, archiving or leaving; the person sees their own details there all along', async () => {
    const made = await tripWithAbbie();
    const gid = made.group.id;
    const v = versionOf(gid);
    const me = (await call<MeDTO>('abbie', 'GET', '/api/me')).data;
    expect(me.user).toMatchObject({ payInfo: '國泰世華 013 abbie', venmo: 'abbie-v', avatar: photoVersion('abbie') });
    expect(friendOf(me, 'gino')).toMatchObject(shown('gino'));
    expect((await call('abbie', 'GET', '/api/activity')).status).toBe(200);
    // Her export shows her own member with her details, and Gino's.
    const exp = await call<{ groups: GroupSnapshotDTO[] }>('abbie', 'GET', '/api/me/export');
    expect(memberIn(exp.data.groups[0], 'abbie')).toMatchObject(shown('abbie'));
    expect(memberIn(exp.data.groups[0], 'abbie').detailsHidden).toBeUndefined();
    expect(memberIn(exp.data.groups[0], 'gino')).toMatchObject(shown('gino'));
    expect((await call('abbie', 'PUT', `/api/groups/${gid}/archive`, { archived: true })).status).toBe(200);
    expect(acceptedAt(gid, 'abbie')).toBeNull();
    expect(versionOf(gid)).toBe(v);
    // Gino's export holds her back as his snapshots do.
    expect(memberIn((await call<{ groups: GroupSnapshotDTO[] }>('gino', 'GET', '/api/me/export')).data.groups[0], 'abbie')).toMatchObject(HIDDEN);

    // She leaves without ever opening it: still held back, now as a member who left.
    const mid = memberIn(made, 'abbie').id;
    expect((await call('abbie', 'DELETE', `/api/groups/${gid}/members/${mid}`)).status).toBe(200);
    expect(acceptedAt(gid, 'abbie')).toBeNull();
    const left = memberIn((await snapOf('gino', gid)).data, 'abbie');
    expect(left).toMatchObject({ active: false, ...HIDDEN });
    expect((await photoOf('abbie', 'gino')).status).toBe(404);
  });

  it('is opened by any write in the group: an expense through the entry routes, and a receipt photo write', async () => {
    const made = await tripWithAbbie();
    const gid = made.group.id;
    const gino = memberIn(made, 'gino').id;
    const abbie = memberIn(made, 'abbie').id;
    const put = await call('abbie', 'PUT', `/api/groups/${gid}/expenses/entry-s3-0001`, expense(abbie, [abbie, gino], 600));
    expect(put.status).toBe(200);
    expect(acceptedAt(gid, 'abbie')).not.toBeNull();
    expect(memberIn((await snapOf('gino', gid)).data, 'abbie')).toMatchObject(shown('abbie'));

    // Leo, added later by email, only takes a photo off that entry (one it does not have: nothing
    // to take off, and the answer is 200): a photo write is a write in the group too.
    const added = await call<{ member: MemberDTO }>('gino', 'POST', `/api/groups/${gid}/members`, { name: 'Leo', email: 'leo@split.test' });
    expect(added.status).toBe(200);
    expect(added.data.member).toMatchObject({ userId: 'leo', ...HIDDEN });
    const off = await call('leo', 'DELETE', `/api/groups/${gid}/expenses/entry-s3-0001/receipts/0123456789abcdef`);
    expect(off.status).toBe(200);
    expect(acceptedAt(gid, 'leo')).not.toBeNull();
    expect(memberIn((await snapOf('gino', gid)).data, 'leo')).toMatchObject(shown('leo'));
  });

  it('POST /api/friends holds the friend back in the 1:1 ledger and on the Friends list until they open it', async () => {
    const r = await call<{ groupId: string }>('gino', 'POST', '/api/friends', { name: 'Leo', email: 'leo@split.test' });
    expect(r.status).toBe(200);
    const gid = r.data.groupId;
    expect(memberIn((await snapOf('gino', gid)).data, 'leo')).toMatchObject(HIDDEN);
    expect(friendOf((await call<MeDTO>('gino', 'GET', '/api/me')).data, 'leo')).toMatchObject({ name: 'Leo', ...HIDDEN });
    expect((await photoOf('leo', 'gino')).status).toBe(404);
    // Leo sees Gino's at once: Gino made the ledger.
    expect(memberIn((await snapOf('leo', gid)).data, 'gino')).toMatchObject(shown('gino'));
    expect(memberIn((await snapOf('gino', gid)).data, 'leo')).toMatchObject(shown('leo'));
    expect((await photoOf('leo', 'gino')).status).toBe(200);
  });

  it('per group: a person who opened one group with me shows on the Friends list, and stays held back in the group they have not opened', async () => {
    const trip = await tripWithAbbie();
    await snapOf('abbie', trip.group.id);
    const home = await call<GroupSnapshotDTO>('gino', 'POST', '/api/groups', { name: 'Home', type: 'home', currency: 'TWD', members: [{ name: 'Abbie', email: 'abbie@split.test' }] });
    expect(memberIn(home.data, 'abbie')).toMatchObject(HIDDEN);
    const dash = (await call<MeDTO>('gino', 'GET', '/api/me')).data;
    expect(friendOf(dash, 'abbie')).toMatchObject(shown('abbie'));
    expect(dash.groups.find(g => g.id === home.data.group.id)!.members.find(m => m.userId === 'abbie')!.avatar).toBeNull();
    // The photo's address serves anyone she shares an opened group with.
    expect((await photoOf('abbie', 'gino')).status).toBe(200);
  });
});

// ---------- links ----------

describe('links and the account', () => {
  it('joining by the group invite link opens it for someone linked by email already, and a claim opens it at once', async () => {
    const made = await tripWithAbbie();
    const gid = made.group.id;
    const join = await call('abbie', 'POST', '/api/join/' + made.inviteCode, {});
    expect(join.status).toBe(200);
    expect(join.data.memberId).toBe(memberIn(made, 'abbie').id);
    expect(acceptedAt(gid, 'abbie')).not.toBeNull();
    expect(memberIn((await snapOf('gino', gid)).data, 'abbie')).toMatchObject(shown('abbie'));

    // Mia claims Kai with a personal link: Gino sees her details without her opening anything else.
    const kai = made.members.find(m => m.name === 'Kai')!.id;
    const link = await call<{ token: string }>('gino', 'POST', `/api/groups/${gid}/members/${kai}/claim-link`, {});
    expect((await call('mia', 'POST', '/api/claim/' + link.data.token, {})).status).toBe(200);
    expect(memberIn((await snapOf('gino', gid)).data, 'mia')).toMatchObject({ id: kai, ...shown('mia') });

    // Leo joins with a name of his own: opened too.
    expect((await call('leo', 'POST', '/api/join/' + made.inviteCode, { name: 'Leo' })).status).toBe(200);
    expect(memberIn((await snapOf('gino', gid)).data, 'leo')).toMatchObject(shown('leo'));
  });

  it('a friend invite link: both people see each other at once, in a new ledger and in one the other started by email', async () => {
    const code = (await call<MyInviteDTO>('abbie', 'GET', '/api/me/invite')).data.code;
    const r = await call<{ groupId: string; existed: boolean }>('leo', 'POST', '/api/invite/' + code, {});
    expect(r.data.existed).toBe(false);
    expect(memberIn((await snapOf('leo', r.data.groupId)).data, 'abbie')).toMatchObject(shown('abbie'));
    expect(memberIn((await snapOf('abbie', r.data.groupId)).data, 'leo')).toMatchObject(shown('leo'));

    // Gino started a ledger with Mia by her email; then Mia accepts Gino's link: the same ledger,
    // and the two now see each other.
    const pair = (await call<{ groupId: string }>('gino', 'POST', '/api/friends', { name: 'Mia', email: 'mia@split.test' })).data.groupId;
    const before = await snapOf('gino', pair);
    expect(memberIn(before.data, 'mia')).toMatchObject(HIDDEN);
    const ginoCode = (await call<MyInviteDTO>('gino', 'GET', '/api/me/invite')).data.code;
    const again = await call<{ groupId: string; existed: boolean }>('mia', 'POST', '/api/invite/' + ginoCode, {});
    expect(again.data).toEqual({ groupId: pair, existed: true });
    const after = await snapOf('gino', pair, before.etag!);
    expect(after.status).toBe(200);
    expect(memberIn(after.data, 'mia')).toMatchObject(shown('mia'));
  });

  it('unlinking and deleting the account clear the mark: whoever links that member next starts held back', async () => {
    const made = await tripWithAbbie();
    const gid = made.group.id;
    await snapOf('abbie', gid);
    const mid = memberIn(made, 'abbie').id;
    const un = await call<{ member: MemberDTO }>('gino', 'POST', `/api/groups/${gid}/members/${mid}/unlink`, {});
    expect(un.status).toBe(200);
    expect(un.data.member.detailsHidden).toBeUndefined();
    expect(db.rows('SELECT user_id, accepted_at FROM members WHERE id = ?', mid)).toEqual([{ user_id: null, accepted_at: null }]);

    // Back by email: a new member, held back again until she opens the group.
    const back = await call<{ member: MemberDTO }>('gino', 'POST', `/api/groups/${gid}/members`, { name: 'Abbie L', email: 'abbie@split.test' });
    expect(back.data.member).toMatchObject({ userId: 'abbie', ...HIDDEN });
    await snapOf('abbie', gid);
    expect(acceptedAt(gid, 'abbie')).not.toBeNull();
    expect((await call('abbie', 'DELETE', '/api/me', {})).status).toBe(200);
    expect(db.rows("SELECT COUNT(*) AS n FROM members WHERE group_id = ? AND accepted_at IS NOT NULL AND user_id IS NULL", gid)).toEqual([{ n: 0 }]);
  });
});
