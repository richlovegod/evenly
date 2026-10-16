// Owner tools: the user list (GET /api/admin/users) and one account's detail
// (GET /api/admin/users/:id). The pure helpers on their own, then the routes end to end against
// the real schema in SQLite (tests/worker/d1-sqlite.ts) with real sessions.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/worker/services/fx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/worker/services/fx')>();
  return { ...actual, getUsdRates: vi.fn(async (_db: unknown, date: string) => ({ date, rates: { USD: 1, TWD: 32.3, JPY: 150.2 }, source: 'test' })) };
});

import { todayUTC } from '../../src/shared/dates';
import type { AdminUserRes, AdminUsersRes, GroupSnapshotDTO } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import { sha256Hex } from '../../src/worker/http';
import worker from '../../src/worker/index';
import {
  cleanQuery, devicesByUser, DEVICES_MAX, likePattern, parsePaging, toAdminStats, toAdminUserGroup, toAdminUserRow, userFilter,
  type AdminUserSqlRow,
} from '../../src/worker/routes/admin';
import { TestD1 } from './d1-sqlite';

// ---------- helpers ----------

describe('parsePaging', () => {
  it('defaults to 50 from the start', () => {
    expect(parsePaging(undefined, undefined)).toEqual({ limit: 50, offset: 0 });
    expect(parsePaging('', '')).toEqual({ limit: 50, offset: 0 });
    expect(parsePaging('lots', 'x')).toEqual({ limit: 50, offset: 0 });
  });
  it('keeps limit within 1 to 100 and offset at 0 or more', () => {
    expect(parsePaging('0', '-3')).toEqual({ limit: 1, offset: 0 });
    expect(parsePaging('500', '20')).toEqual({ limit: 100, offset: 20 });
    expect(parsePaging('7', '0')).toEqual({ limit: 7, offset: 0 });
    expect(parsePaging('100', '99999999999')).toEqual({ limit: 100, offset: 1_000_000 });
  });
});

describe('cleanQuery and likePattern', () => {
  it('trims, makes runs of spaces one, and stops at 100 characters', () => {
    expect(cleanQuery(undefined)).toBe('');
    expect(cleanQuery('  Ann   Lee \n')).toBe('Ann Lee');
    expect(cleanQuery('佳'.repeat(150))).toBe('佳'.repeat(100));
  });
  it('takes %, _ and the backslash literally', () => {
    expect(likePattern('ann')).toBe('%ann%');
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
  it('filters by name or email only when there is a query', () => {
    expect(userFilter('')).toEqual({ where: '1 = 1', params: [] });
    const f = userFilter('a_b');
    expect(f.params).toEqual(['%a\\_b%', '%a\\_b%']);
    expect(f.where).toContain('u.name LIKE ?');
    expect(f.where).toContain('u.email LIKE ?');
  });
});

describe('devicesByUser', () => {
  it('keeps distinct labels, newest use first, at most five, without empty ones', () => {
    const rows = [
      { user_id: 'u1', label: 'iPhone Safari', last_used: '2026-10-10T00:00:00.000Z' },
      { user_id: 'u1', label: 'Mac Chrome', last_used: '2026-10-12T00:00:00.000Z' },
      { user_id: 'u1', label: 'iPhone Safari', last_used: '2026-10-13T00:00:00.000Z' },
      { user_id: 'u1', label: '', last_used: '2026-10-14T00:00:00.000Z' },
      { user_id: 'u1', label: '  ', last_used: '2026-10-14T00:00:00.000Z' },
      { user_id: 'u1', label: 'Windows Edge', last_used: '2026-10-01T00:00:00.000Z' },
      { user_id: 'u1', label: 'Android Chrome', last_used: '2026-10-02T00:00:00.000Z' },
      { user_id: 'u1', label: 'iPad Safari', last_used: '2026-10-03T00:00:00.000Z' },
      { user_id: 'u1', label: 'Linux Firefox', last_used: '2026-09-01T00:00:00.000Z' },
      { user_id: 'u2', label: 'iPhone LINE', last_used: null },
    ];
    const out = devicesByUser(rows);
    expect(out.get('u1')).toEqual(['iPhone Safari', 'Mac Chrome', 'iPad Safari', 'Android Chrome', 'Windows Edge']);
    expect(out.get('u1')).toHaveLength(DEVICES_MAX);
    expect(out.get('u2')).toEqual(['iPhone LINE']);
    expect(out.get('u3')).toBeUndefined();
  });
});

describe('row mappers', () => {
  const row: AdminUserSqlRow = {
    id: 'u1', name: 'Ann', email: 'a@evenly.test', has_pw: 1, locale: 'fr', currency: 'TWD', color: '#2F6FB5',
    created_at: '2026-10-01T00:00:00.000Z', pay_info: 'bank', venmo: 'ann', paypal: '', last_active: null,
    live_sessions: null, group_count: 3, entry_count: 12, last_entry: '2026-10-02T00:00:00.000Z',
  };

  it('turns a users row into an AdminUserRow without the payment details', () => {
    const r = toAdminUserRow(row, ['a', 'b', 'c', 'd', 'e', 'f'], false);
    expect(r).toEqual({
      id: 'u1', name: 'Ann', email: 'a@evenly.test', hasPassword: true, locale: 'zh-TW', currency: 'TWD', color: '#2F6FB5',
      createdAt: '2026-10-01T00:00:00.000Z', lastActiveAt: null, sessions: 0, devices: ['a', 'b', 'c', 'd', 'e'], groups: 3,
      entries: 12, lastEntryAt: '2026-10-02T00:00:00.000Z', isOwner: false,
    });
    expect(toAdminUserRow({ ...row, locale: 'en', has_pw: 0, email: null }, [], true)).toMatchObject({ locale: 'en', hasPassword: false, email: null, isOwner: true });
  });

  it('counts the device-only accounts as the ones without email and password', () => {
    expect(toAdminStats({ users: 10, new_last7: 2, active_last7: 4, with_password: 3, groups: 5, entries: 40 })).toEqual({
      users: 10, newLast7: 2, activeLast7: 4, withPassword: 3, deviceOnly: 7, groups: 5, entries: 40,
    });
    expect(toAdminStats(undefined)).toEqual({ users: 0, newLast7: 0, activeLast7: 0, withPassword: 0, deviceOnly: 0, groups: 0, entries: 0 });
  });

  it('turns a membership row into a group with a known type', () => {
    const g = toAdminUserGroup({
      id: 'g1', name: 'Trip', type: 'boat', currency: 'JPY', emoji: '', color: '#123456', deleted_at: '2026-10-05T00:00:00.000Z',
      role: 'owner', active: 0, member_count: 4, entry_count: null, last_date: null,
    });
    expect(g).toEqual({
      id: 'g1', name: 'Trip', type: 'other', currency: 'JPY', emoji: '', color: '#123456', memberCount: 4, role: 'member',
      active: false, entries: 0, lastDate: null, deleted: true,
    });
  });
});

// ---------- routes ----------

const OWNER = 'owner@evenly.test';
const TODAY = todayUTC();
const DAY = 86_400_000;

let db: TestD1;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  data: T;
  text: string;
}

async function api<T = any>(user: string | null, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const h: Record<string, string> = {};
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request('http://api.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'http://app.test/', ENVIRONMENT: 'test', OWNER_EMAILS: ' Someone@else.test , ' + OWNER.toUpperCase() };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined, text };
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function addUser(id: string, name: string, email: string | null, createdAgoMs: number, pw = true): void {
  const at = iso(createdAgoMs);
  db.exec(
    'INSERT INTO users (id, name, email, pw_hash, color, venmo, pay_info, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, name, email, email && pw ? 'pbkdf2-sha256$4000$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA' : null, '#2F6FB5',
    id === 'ann' ? 'ann-v' : '', id === 'ann' ? '國泰 013' : '', at, at,
  );
}

async function signIn(id: string, label: string, key = id): Promise<string> {
  const token = await createSession(db.d1, id, label);
  tokens[key] = token;
  return token;
}

function expense(memberId: string, amount: number, description: string): Record<string, unknown> {
  return {
    kind: 'expense', description, category: 'food.dining', amount, currency: 'TWD', fxRate: 1, date: TODAY,
    payers: [{ memberId, amount }], split: { method: 'equal', entries: [{ memberId }] },
  };
}

interface World {
  live: GroupSnapshotDTO;
  gone: GroupSnapshotDTO;
  annMember: string;
}

/** owner, Ann (2 devices, one expired session), Bob (device only, left a group), Cy (signed up 10 days ago, no sessions). */
async function world(): Promise<World> {
  addUser('owner', 'Gino', OWNER, 2 * DAY);
  addUser('ann', 'Ann Lee', 'a@evenly.test', 1 * DAY);
  addUser('bob', 'Bob 50%_off', null, 3 * DAY);
  addUser('cy', 'Cy', 'cy@evenly.test', 10 * DAY);
  await signIn('owner', 'Mac Safari');
  await signIn('ann', 'iPhone Safari');
  await signIn('ann', 'Windows Chrome', 'ann2');
  await signIn('ann', 'Android Chrome', 'annOld');
  await signIn('bob', '');
  // Ann's Android session expired a while ago; Windows was used 3 days ago.
  db.exec('UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE id = ?', iso(DAY), iso(40 * DAY), await sha256Hex(tokens.annOld));
  db.exec('UPDATE sessions SET last_used_at = ? WHERE id = ?', iso(3 * DAY), await sha256Hex(tokens.ann2));
  // Bob's only session was last used 9 days ago, so he is not active this week.
  db.exec('UPDATE sessions SET last_used_at = ? WHERE user_id = ?', iso(9 * DAY), 'bob');

  const live = (await api<GroupSnapshotDTO>('ann', 'POST', '/api/groups', { name: 'test-Niseko', type: 'trip', currency: 'TWD', emoji: '⛷️', members: [{ name: 'Bob' }, { name: 'Kai' }] })).data;
  const annMember = live.me.memberId;
  expect((await api('ann', 'PUT', `/api/groups/${live.group.id}/expenses/exp-0001`, expense(annMember, 300, 'dinner'))).status).toBe(200);
  expect((await api('ann', 'PUT', `/api/groups/${live.group.id}/expenses/exp-0002`, expense(annMember, 500, 'taxi'))).status).toBe(200);
  expect((await api('ann', 'PUT', `/api/groups/${live.group.id}/expenses/exp-0003`, expense(annMember, 700, 'oops'))).status).toBe(200);
  expect((await api('ann', 'DELETE', `/api/groups/${live.group.id}/expenses/exp-0003`)).status).toBe(200);

  const gone = (await api<GroupSnapshotDTO>('ann', 'POST', '/api/groups', { name: 'test-Old', type: 'home', currency: 'TWD' })).data;
  expect((await api('ann', 'PUT', `/api/groups/${gone.group.id}/expenses/exp-0004`, expense(gone.me.memberId, 900, 'rent'))).status).toBe(200);
  expect((await api('ann', 'DELETE', '/api/groups/' + gone.group.id)).status).toBe(200);

  // Bob was the placeholder "Bob" and left the trip.
  const bobMember = live.members.find(m => m.name === 'Bob')!.id;
  db.exec('UPDATE members SET user_id = ?, active = 0 WHERE id = ?', 'bob', bobMember);
  return { live, gone, annMember };
}

beforeEach(() => {
  db = new TestD1();
  for (const k of Object.keys(tokens)) delete tokens[k];
});

describe('GET /api/admin/users', () => {
  it('is only there for the owner', async () => {
    await world();
    expect((await api(null, 'GET', '/api/admin/users')).status).toBe(401);
    const ann = await api('ann', 'GET', '/api/admin/users');
    expect(ann.status).toBe(404);
    expect(ann.data.error.code).toBe('not_found');
    expect((await api('ann', 'GET', '/api/admin/users/ann')).status).toBe(404);
    expect((await api('owner', 'GET', '/api/admin/users')).status).toBe(200);
  });

  it('lists everyone newest first with their counts', async () => {
    await world();
    const r = await api<AdminUsersRes>('owner', 'GET', '/api/admin/users');
    expect(r.status).toBe(200);
    expect(r.data.total).toBe(4);
    expect(r.data.users.map(u => u.id)).toEqual(['ann', 'owner', 'bob', 'cy']);

    const [ann, owner, bob, cy] = r.data.users;
    expect(ann).toMatchObject({
      name: 'Ann Lee', email: 'a@evenly.test', hasPassword: true, locale: 'zh-TW', currency: 'TWD', color: '#2F6FB5',
      sessions: 2, devices: ['iPhone Safari', 'Windows Chrome'], groups: 1, entries: 2, isOwner: false,
    });
    expect(Date.parse(ann.lastActiveAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(ann.lastEntryAt).not.toBeNull();
    expect(owner).toMatchObject({ isOwner: true, sessions: 1, devices: ['Mac Safari'], groups: 0, entries: 0, lastEntryAt: null });
    // Left the trip: no active membership. The unlabeled session counts, but shows no device.
    expect(bob).toMatchObject({ email: null, hasPassword: false, sessions: 1, devices: [], groups: 0, entries: 0 });
    expect(cy).toMatchObject({ sessions: 0, devices: [], lastActiveAt: null });

    expect(r.data.stats).toEqual({ users: 4, newLast7: 3, activeLast7: 2, withPassword: 3, deviceOnly: 1, groups: 1, entries: 2 });
  });

  it('searches names and emails in any case, and takes % and _ literally', async () => {
    await world();
    const byName = await api<AdminUsersRes>('owner', 'GET', '/api/admin/users?q=' + encodeURIComponent('  ANN  '));
    expect(byName.data.users.map(u => u.id)).toEqual(['ann']);
    expect(byName.data.total).toBe(1);
    expect(byName.data.stats.users).toBe(4);
    const byEmail = await api<AdminUsersRes>('owner', 'GET', '/api/admin/users?q=cy%40EVENLY');
    expect(byEmail.data.users.map(u => u.id)).toEqual(['cy']);
    const literal = await api<AdminUsersRes>('owner', 'GET', '/api/admin/users?q=' + encodeURIComponent('50%_o'));
    expect(literal.data.users.map(u => u.id)).toEqual(['bob']);
    const wild = await api<AdminUsersRes>('owner', 'GET', '/api/admin/users?q=' + encodeURIComponent('n%e'));
    expect(wild.data.total).toBe(0);
    expect(wild.data.users).toEqual([]);
  });

  it('pages with limit and offset', async () => {
    await world();
    const p1 = await api<AdminUsersRes>('owner', 'GET', '/api/admin/users?limit=2');
    const p2 = await api<AdminUsersRes>('owner', 'GET', '/api/admin/users?limit=2&offset=2');
    const p3 = await api<AdminUsersRes>('owner', 'GET', '/api/admin/users?limit=2&offset=4');
    expect(p1.data.users.map(u => u.id)).toEqual(['ann', 'owner']);
    expect(p2.data.users.map(u => u.id)).toEqual(['bob', 'cy']);
    expect(p3.data.users).toEqual([]);
    expect([p1, p2, p3].map(p => p.data.total)).toEqual([4, 4, 4]);
    // Counts belong to each row, also on later pages.
    expect(p2.data.users[0]).toMatchObject({ id: 'bob', sessions: 1 });
    expect((await api<AdminUsersRes>('owner', 'GET', '/api/admin/users?limit=0')).data.users).toHaveLength(1);
    expect((await api<AdminUsersRes>('owner', 'GET', '/api/admin/users?limit=9999')).data.users).toHaveLength(4);
  });

  it('never sends password hashes, session ids or tokens', async () => {
    await world();
    const list = await api('owner', 'GET', '/api/admin/users');
    const detail = await api('owner', 'GET', '/api/admin/users/ann');
    for (const r of [list, detail]) {
      expect(r.text).not.toMatch(/pbkdf2|pw_hash|pwHash|token/i);
      for (const tok of Object.values(tokens)) {
        expect(r.text).not.toContain(tok);
        expect(r.text).not.toContain(await sha256Hex(tok));
      }
    }
  });
});

describe('GET /api/admin/users/:id', () => {
  it('shows the profile, payment details, groups, live sessions and recent activity', async () => {
    const w = await world();
    const r = await api<AdminUserRes>('owner', 'GET', '/api/admin/users/ann');
    expect(r.status).toBe(200);
    expect(r.data.user).toMatchObject({ id: 'ann', name: 'Ann Lee', venmo: 'ann-v', payInfo: '國泰 013', paypal: '', groups: 1, entries: 2, sessions: 2 });
    expect(r.data.user.devices).toEqual(['iPhone Safari', 'Windows Chrome']);

    expect(r.data.groups).toEqual([
      {
        id: w.live.group.id, name: 'test-Niseko', type: 'trip', currency: 'TWD', emoji: w.live.group.emoji, color: w.live.group.color,
        memberCount: 2, role: 'admin', active: true, entries: 2, lastDate: TODAY, deleted: false,
      },
      {
        id: w.gone.group.id, name: 'test-Old', type: 'home', currency: 'TWD', emoji: w.gone.group.emoji, color: w.gone.group.color,
        memberCount: 1, role: 'admin', active: true, entries: 1, lastDate: TODAY, deleted: true,
      },
    ]);

    expect(r.data.sessions.map(s => s.label)).toEqual(['iPhone Safari', 'Windows Chrome']);
    for (const s of r.data.sessions) expect(Object.keys(s).sort()).toEqual(['createdAt', 'expiresAt', 'label', 'lastUsedAt']);

    const types = r.data.activity.map(a => a.type);
    expect(types).toContain('group.create');
    expect(types).toContain('expense.create');
    expect(types).toContain('expense.delete');
    expect(types).toContain('group.delete');
    expect(r.data.activity.every(a => a.userId === 'ann')).toBe(true);
    const times = r.data.activity.map(a => a.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(r.data.activity.find(a => a.type === 'expense.create')).toMatchObject({ groupName: expect.any(String), actorName: 'Ann Lee' });
  });

  it('keeps groups the account left, marked inactive', async () => {
    const w = await world();
    const r = await api<AdminUserRes>('owner', 'GET', '/api/admin/users/bob');
    expect(r.data.user).toMatchObject({ email: null, hasPassword: false, groups: 0, devices: [] });
    expect(r.data.groups).toEqual([expect.objectContaining({ id: w.live.group.id, active: false, role: 'member', memberCount: 2 })]);
    expect(r.data.sessions).toEqual([expect.objectContaining({ label: '' })]);
  });

  it('returns at most the 20 newest activity rows', async () => {
    const w = await world();
    for (let i = 0; i < 25; i++) {
      db.exec(
        "INSERT INTO activity (id, group_id, user_id, member_id, type, expense_id, data, created_at) VALUES (?, ?, 'ann', ?, 'comment.add', 'exp-0001', '{}', ?)",
        'act-' + i, w.live.group.id, w.annMember, new Date(Date.now() + (i + 1) * 1000).toISOString(),
      );
    }
    const r = await api<AdminUserRes>('owner', 'GET', '/api/admin/users/ann');
    expect(r.data.activity).toHaveLength(20);
    expect(r.data.activity[0].id).toBe('act-24');
    expect(r.data.activity[19].id).toBe('act-5');
  });

  it('is a 404 for an unknown account', async () => {
    await world();
    expect((await api('owner', 'GET', '/api/admin/users/nobody')).status).toBe(404);
    expect((await api('owner', 'GET', '/api/admin/users/' + 'x'.repeat(150))).status).toBe(404);
  });
});

describe('the existing owner tools', () => {
  it('still count and make reset links', async () => {
    await world();
    const st = await api('owner', 'GET', '/api/admin/stats');
    expect(st.data).toEqual({ users: 4, groups: 1, expenses: 3 });
    const rl = await api('owner', 'POST', '/api/admin/reset-link', { email: 'a@evenly.test' });
    expect(rl.status).toBe(200);
    expect(rl.data.url).toMatch(/^http:\/\/app\.test\/#\/reset\/[A-Za-z0-9_-]+$/);
  });
});
