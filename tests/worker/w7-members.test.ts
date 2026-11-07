// Review-1106 unit W7, member and group routes on the worker.fetch harness with the real schema
// (tests/worker/d1-sqlite.ts): leaving needs the settle-up plan clear of me too, not only a zero net
// (B2-01); rejoining by the invite link claims the placeholder picked (B2-02); a deleted group's
// group.delete row reaches the people who were in it (B2-04); limit_reached says which limit
// (B2-10); the system's rows carry no Chinese actor name (B2-11).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayUTC } from '../../src/shared/dates';
import type { ActivityDTO, GroupSnapshotDTO, JoinInfoDTO, MeDTO } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { MAX_ACTIVE_MEMBERS, MAX_GROUPS_PER_USER } from '../../src/worker/routes/groups';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';

let db: TestD1;
let env: Record<string, unknown>;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  data: T;
}

async function call<T = any>(user: string | null, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const h: Record<string, string> = { 'cf-connecting-ip': '203.0.113.9' };
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request(SITE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

async function addUser(id: string, name: string, email: string): Promise<void> {
  const now = new Date().toISOString();
  db.exec(
    'INSERT INTO users (id, name, email, locale, currency, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, name, email, 'zh-TW', 'TWD', '#2F6FB5', now, now,
  );
  tokens[id] = await createSession(db.d1, id, 'test');
}

let seq = 0;
/** One expense: `payer` paid `amount` for `owers` (equal split among them). */
function expense(payer: string, owers: string[], amount: number) {
  return {
    kind: 'expense', description: 'entry ' + ++seq, category: 'general', amount, currency: 'TWD', fxRate: 1, date: todayUTC(),
    payers: [{ memberId: payer, amount }], split: { method: 'equal', entries: owers.map(memberId => ({ memberId })) },
  };
}

async function newGroup(by: string, members: { name: string; email?: string }[], simplify = true): Promise<GroupSnapshotDTO> {
  const r = await call<GroupSnapshotDTO>(by, 'POST', '/api/groups', { name: '室友', type: 'home', currency: 'TWD', simplify, members });
  expect(r.status).toBe(200);
  return r.data;
}

const memberOf = (snap: GroupSnapshotDTO, userId: string) => snap.members.find(m => m.userId === userId)!.id;

beforeEach(async () => {
  db = new TestD1();
  env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test' };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await addUser('gino', 'Gino', 'gino@evenly.test');
  await addUser('abbie', 'Abbie', 'abbie@evenly.test');
  await addUser('kai', '佳穎', 'kai@evenly.test');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- B2-01 ----------

describe('leaving or removing a member (B2-01)', () => {
  /** Abbie paid 100 for 佳穎, 佳穎 paid 100 for Gino: 佳穎's net is 0, but the pair-by-pair plan names her twice. */
  async function chain(simplify: boolean) {
    const snap = await newGroup('gino', [{ name: 'Abbie', email: 'abbie@evenly.test' }, { name: '佳穎', email: 'kai@evenly.test' }], simplify);
    const g = { gid: snap.group.id, gino: memberOf(snap, 'gino'), abbie: memberOf(snap, 'abbie'), kai: memberOf(snap, 'kai') };
    expect((await call('abbie', 'PUT', `/api/groups/${g.gid}/expenses/chain-0001`, expense(g.abbie, [g.kai], 100))).status).toBe(200);
    expect((await call('kai', 'PUT', `/api/groups/${g.gid}/expenses/chain-0002`, expense(g.kai, [g.gino], 100))).status).toBe(200);
    return g;
  }
  const active = (mid: string) => db.rows<{ active: number }>('SELECT active FROM members WHERE id = ?', mid)[0].active;

  it('with 簡化債務 off, refuses a member at net 0 whom the plan still names, for leaving and for removing', async () => {
    const g = await chain(false);
    const me = (await call<MeDTO>('kai', 'GET', '/api/me')).data.groups.find(x => x.id === g.gid)!;
    expect(me.myNet).toBe(0);
    expect(me.myTransfers).toHaveLength(2);

    const leave = await call('kai', 'DELETE', `/api/groups/${g.gid}/members/${g.kai}`);
    expect(leave.status).toBe(409);
    expect(leave.data.error.code).toBe('balance_not_zero');
    expect(leave.data.error.details).toEqual({ net: 0, currency: 'TWD', transfers: 2 });
    const remove = await call('gino', 'DELETE', `/api/groups/${g.gid}/members/${g.kai}`);
    expect(remove.status).toBe(409);
    expect(remove.data.error.details).toEqual({ net: 0, currency: 'TWD', transfers: 2 });
    expect(active(g.kai)).toBe(1);
  });

  it('lets her go once 簡化債務 is on (the fewest payments never pass through a net of 0)', async () => {
    const g = await chain(false);
    expect((await call('gino', 'PATCH', '/api/groups/' + g.gid, { simplify: true })).status).toBe(200);
    const r = await call('kai', 'DELETE', `/api/groups/${g.gid}/members/${g.kai}`);
    expect(r.status).toBe(200);
    expect(active(g.kai)).toBe(0);
  });

  it('with 簡化債務 on, a net of 0 is enough, as before', async () => {
    const g = await chain(true);
    expect((await call('kai', 'DELETE', `/api/groups/${g.gid}/members/${g.kai}`)).status).toBe(200);
  });

  it('still says the net when there is one', async () => {
    const g = await chain(false);
    const r = await call('abbie', 'DELETE', `/api/groups/${g.gid}/members/${g.abbie}`);
    expect(r.status).toBe(409);
    expect(r.data.error.details).toEqual({ net: 100, currency: 'TWD', transfers: 1 });
  });

  it('a member the plan does not name leaves with 簡化債務 off too', async () => {
    const snap = await newGroup('gino', [{ name: 'Abbie', email: 'abbie@evenly.test' }, { name: '佳穎', email: 'kai@evenly.test' }], false);
    const gid = snap.group.id;
    expect((await call('gino', 'PUT', `/api/groups/${gid}/expenses/solo-0001`, expense(memberOf(snap, 'gino'), [memberOf(snap, 'abbie')], 100))).status).toBe(200);
    expect((await call('kai', 'DELETE', `/api/groups/${gid}/members/${memberOf(snap, 'kai')}`)).status).toBe(200);
  });
});

// ---------- B2-02 ----------

describe('rejoining by the invite link (B2-02)', () => {
  /** Abbie left at net 0; Gino then added 「Abbie」 again by name and put the rent on that placeholder. */
  async function leftAndReadded() {
    const snap = await newGroup('gino', [{ name: 'Abbie', email: 'abbie@evenly.test' }]);
    const gid = snap.group.id;
    const old = memberOf(snap, 'abbie');
    expect((await call('abbie', 'DELETE', `/api/groups/${gid}/members/${old}`)).status).toBe(200);
    const add = await call('gino', 'POST', `/api/groups/${gid}/members`, { name: 'Abbie' });
    expect(add.status).toBe(200);
    const fresh: string = add.data.member.id;
    expect((await call('gino', 'PUT', `/api/groups/${gid}/expenses/rent-0001`, expense(memberOf(snap, 'gino'), [memberOf(snap, 'gino'), fresh], 24000))).status).toBe(200);
    return { gid, code: snap.inviteCode, old, fresh };
  }
  const row = (id: string) => db.rows<{ user_id: string | null; active: number }>('SELECT user_id, active FROM members WHERE id = ?', id)[0];

  it('claims the placeholder she picked; her old member stays as an unlinked placeholder', async () => {
    const s = await leftAndReadded();
    const info = await call<JoinInfoDTO>('abbie', 'GET', '/api/join/' + s.code);
    expect(info.data.myMemberId).toBeNull();
    expect(info.data.members.map(m => m.id)).toContain(s.fresh);
    expect(info.data.members.map(m => m.id)).not.toContain(s.old);

    const r = await call('abbie', 'POST', '/api/join/' + s.code, { memberId: s.fresh });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ groupId: s.gid, memberId: s.fresh });
    expect(row(s.fresh)).toEqual({ user_id: 'abbie', active: 1 });
    expect(row(s.old)).toEqual({ user_id: null, active: 0 });

    // The rent is hers now: 總覽 shows it.
    const mine = (await call<MeDTO>('abbie', 'GET', '/api/me')).data.groups.find(g => g.id === s.gid)!;
    expect(mine.myMemberId).toBe(s.fresh);
    expect(mine.myNet).toBe(-12000);
    // A second tap lands on the same member.
    expect((await call('abbie', 'POST', '/api/join/' + s.code, { memberId: s.fresh })).data).toEqual({ groupId: s.gid, memberId: s.fresh });
    const claims = db.rows("SELECT 1 FROM activity WHERE group_id = ? AND type = 'member.claim'", s.gid);
    expect(claims).toHaveLength(1);
  });

  it('a typed name still brings back her old member, with its history', async () => {
    const s = await leftAndReadded();
    const r = await call('abbie', 'POST', '/api/join/' + s.code, { name: 'Abbie Lin' });
    expect(r.status).toBe(200);
    expect(r.data.memberId).toBe(s.old);
    expect(row(s.old)).toEqual({ user_id: 'abbie', active: 1 });
    expect(row(s.fresh)).toEqual({ user_id: null, active: 1 });
  });

  it('a placeholder someone else already claimed is refused, and her old member stays as it was', async () => {
    const s = await leftAndReadded();
    db.exec('UPDATE members SET user_id = ?, claimed_at = ? WHERE id = ?', 'kai', new Date().toISOString(), s.fresh);
    const r = await call('abbie', 'POST', '/api/join/' + s.code, { memberId: s.fresh });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('member_claimed');
    expect(row(s.old)).toEqual({ user_id: 'abbie', active: 0 });
  });
});

// ---------- B2-04 ----------

describe('deleting a group (B2-04)', () => {
  const feed = async (user: string) => (await call<{ items: ActivityDTO[] }>(user, 'GET', '/api/activity')).data.items;
  const unread = async (user: string) => (await call<MeDTO>(user, 'GET', '/api/me')).data.unread;

  it("reaches everyone who was in it: one feed line and the unread count, but none of the group's other rows", async () => {
    const snap = await newGroup('gino', [{ name: 'Abbie', email: 'abbie@evenly.test' }, { name: '佳穎', email: 'kai@evenly.test' }]);
    const gid = snap.group.id;
    // 佳穎 left before the delete: she hears nothing.
    expect((await call('kai', 'DELETE', `/api/groups/${gid}/members/${memberOf(snap, 'kai')}`)).status).toBe(200);
    expect((await call('abbie', 'PUT', `/api/groups/${gid}/expenses/del-0001`, expense(memberOf(snap, 'abbie'), [memberOf(snap, 'gino')], 3000))).status).toBe(200);
    expect((await call('abbie', 'POST', '/api/activity/seen')).status).toBe(200);
    expect(await unread('abbie')).toBe(0);

    expect((await call('gino', 'DELETE', '/api/groups/' + gid)).status).toBe(200);

    const items = (await feed('abbie')).filter(a => a.groupId === gid);
    expect(items.map(a => a.type)).toEqual(['group.delete']);
    expect(items[0]).toMatchObject({ actorName: 'Gino', userId: 'gino', groupName: '室友' });
    expect(await unread('abbie')).toBe(1);
    // The one who deleted it sees it too, and it is not unread for him.
    expect((await feed('gino')).filter(a => a.groupId === gid).map(a => a.type)).toEqual(['group.delete']);
    expect((await feed('kai')).filter(a => a.groupId === gid)).toEqual([]);
    // Exactly one row, written with the delete.
    expect(db.rows("SELECT 1 FROM activity WHERE group_id = ? AND type = 'group.delete'", gid)).toHaveLength(1);
  });
});

// ---------- B2-10 ----------

describe('limit_reached says which limit (B2-10)', () => {
  it('a 1:1 ledger: two people', async () => {
    const r = await call('gino', 'POST', '/api/friends', { name: 'Leo' });
    expect(r.status).toBe(200);
    const add = await call('gino', 'POST', `/api/groups/${r.data.groupId}/members`, { name: 'Third' });
    expect(add.status).toBe(409);
    expect(add.data.error).toMatchObject({ code: 'limit_reached', details: { limit: 'pair_members', max: 2 } });
  });

  it('a group: 50 active members, on create and on add', async () => {
    const names = Array.from({ length: MAX_ACTIVE_MEMBERS }, (_, i) => ({ name: 'M' + i }));
    const tooMany = await call('gino', 'POST', '/api/groups', { name: '大家', type: 'other', currency: 'TWD', members: names });
    expect(tooMany.status).toBe(409);
    expect(tooMany.data.error.details).toEqual({ limit: 'members', max: MAX_ACTIVE_MEMBERS });
    const full = await newGroup('gino', names.slice(1));
    const add = await call('gino', 'POST', `/api/groups/${full.group.id}/members`, { name: 'One more' });
    expect(add.status).toBe(409);
    expect(add.data.error.details).toEqual({ limit: 'members', max: MAX_ACTIVE_MEMBERS });
  });

  it("200 groups: mine (self) or someone else's (their name)", async () => {
    const snap = await newGroup('gino', []);
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_GROUPS_PER_USER; i++) {
      db.exec(
        `INSERT INTO groups (id, name, type, currency, emoji, color, simplify, notes, invite_code, created_by, created_at, updated_at, version)
         VALUES (?, 'g', 'other', 'TWD', '', '#2F6FB5', 1, '', ?, 'abbie', ?, ?, 1)`,
        'full-' + i, 'invitefull' + i, now, now,
      );
      db.exec(`INSERT INTO members (id, group_id, user_id, name, color, role, active, sort, created_at) VALUES (?, ?, 'abbie', 'Abbie', '#2F6FB5', 'admin', 1, 0, ?)`, 'mfull-' + i, 'full-' + i, now);
    }
    const mine = await call('abbie', 'POST', '/api/groups', { name: 'one more', type: 'other', currency: 'TWD' });
    expect(mine.status).toBe(409);
    expect(mine.data.error.details).toEqual({ limit: 'groups', max: MAX_GROUPS_PER_USER, self: true });
    const theirs = await call('gino', 'POST', `/api/groups/${snap.group.id}/members`, { name: 'Abbie W.', email: 'abbie@evenly.test' });
    expect(theirs.status).toBe(409);
    expect(theirs.data.error.details).toEqual({ limit: 'groups', max: MAX_GROUPS_PER_USER, name: 'Abbie W.' });
  });
});

// ---------- B2-11 ----------

describe("the system's rows (B2-11)", () => {
  it('the admin role handed on at an account deletion has no actor name: clients word it', async () => {
    const snap = await newGroup('gino', [{ name: 'Abbie', email: 'abbie@evenly.test' }]);
    expect((await call('gino', 'DELETE', '/api/me', {})).status).toBe(200);
    const items = (await call<{ items: ActivityDTO[] }>('abbie', 'GET', '/api/activity')).data.items;
    const heir = items.find(a => a.groupId === snap.group.id && a.type === 'member.update')!;
    expect(heir).toMatchObject({ userId: null, memberId: null, actorName: '' });
    expect(heir.data.changes).toEqual([{ field: 'role', from: 'member', to: 'admin' }]);
  });
});
