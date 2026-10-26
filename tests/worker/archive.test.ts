// 封存群組 (docs/SPEC.md section 4, Archive) on the worker.fetch harness with the real schema
// (tests/worker/d1-sqlite.ts): PUT /api/groups/:gid/archive writes only my member row (no activity,
// no push, no version bump), GET /api/me says `archived` for me alone while the group's money still
// counts in totals and friends, and the group comes back on its own when someone else adds an
// entry (an expense, a payment, a restore, an import, a recurring copy), but not for my own entries
// or anyone's edits and deletes. Rejoining after leaving brings it back too.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, todayUTC } from '../../src/shared/dates';
import type { GroupSnapshotDTO, MeDTO, UpsertExpenseReq } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import worker from '../../src/worker/index';
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
    id, name, email, 'zh-TW', 'JPY', '#2F6FB5', now, now,
  );
  tokens[id] = await createSession(db.d1, id, 'test');
}

let gid = '';
const mid: Record<string, string> = {};

const archivedAt = (user: string) =>
  db.rows<{ archived_at: string | null }>('SELECT archived_at FROM members WHERE group_id = ? AND user_id = ?', gid, user)[0]?.archived_at ?? null;
const version = () => db.rows<{ version: number }>('SELECT version FROM groups WHERE id = ?', gid)[0].version;
const activityCount = () => db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM activity WHERE group_id = ?', gid)[0].n;
const listed = async (user: string) => (await call<MeDTO>(user, 'GET', '/api/me')).data.groups.find(g => g.id === gid);

function expense(o: Partial<UpsertExpenseReq> = {}): UpsertExpenseReq {
  return {
    kind: 'expense',
    description: '晚餐',
    category: 'food.dining',
    amount: 9000,
    currency: 'JPY',
    fxRate: 1,
    date: todayUTC(),
    payers: [{ memberId: mid.abbie, amount: 9000 }],
    split: { method: 'equal', entries: [{ memberId: mid.gino }, { memberId: mid.abbie }, { memberId: mid.kai }] },
    ...o,
  };
}

const put = (user: string, eid: string, body: UpsertExpenseReq) => call(user, 'PUT', `/api/groups/${gid}/expenses/${eid}`, body);
const archive = (user: string, archived: boolean) => call(user, 'PUT', `/api/groups/${gid}/archive`, { archived });

beforeEach(async () => {
  db = new TestD1();
  env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test' };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await addUser('gino', 'Gino', 'gino@evenly.test');
  await addUser('abbie', 'Abbie', 'abbie@evenly.test');
  await addUser('kai', '佳穎', 'kai@evenly.test');
  await addUser('stranger', 'Stranger', 'stranger@evenly.test');
  const r = await call<GroupSnapshotDTO>('gino', 'POST', '/api/groups', {
    name: '北海道', type: 'trip', currency: 'JPY',
    members: [{ name: 'Abbie', email: 'abbie@evenly.test' }, { name: '佳穎', email: 'kai@evenly.test' }],
  });
  expect(r.status).toBe(200);
  gid = r.data.group.id;
  for (const m of r.data.members) mid[m.userId === 'gino' ? 'gino' : m.userId === 'abbie' ? 'abbie' : 'kai'] = m.id;
  // Abbie paid 9,000 for the three of them: Gino owes her 3,000.
  expect((await put('abbie', 'e-0001-dinner', expense())).status).toBe(200);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PUT /api/groups/:gid/archive', () => {
  it('archives for me only: my member row, no activity, no version bump, no push', async () => {
    const v = version();
    const n = activityCount();
    const r = await archive('gino', true);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ archived: true });
    expect(archivedAt('gino')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(archivedAt('abbie')).toBeNull();
    expect(version()).toBe(v);
    expect(activityCount()).toBe(n);
    expect((await listed('gino'))?.archived).toBe(true);
    expect((await listed('abbie'))?.archived).toBe(false);
  });

  it('keeps the first time when archived again, and 取消封存 clears it', async () => {
    await archive('gino', true);
    const first = archivedAt('gino');
    db.exec('UPDATE members SET archived_at = ? WHERE group_id = ? AND user_id = ?', '2026-01-02T03:04:05.000Z', gid, 'gino');
    expect((await archive('gino', true)).data).toEqual({ archived: true });
    expect(archivedAt('gino')).toBe('2026-01-02T03:04:05.000Z');
    expect(first).not.toBeNull();
    const r = await archive('gino', false);
    expect(r.data).toEqual({ archived: false });
    expect(archivedAt('gino')).toBeNull();
    expect((await listed('gino'))?.archived).toBe(false);
  });

  it('is 404 for someone who is not in the group, and 400 without a boolean', async () => {
    expect((await archive('stranger', true)).status).toBe(404);
    const bad = await call('gino', 'PUT', `/api/groups/${gid}/archive`, { archived: 'yes' });
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe('validation');
    expect((await call(null, 'PUT', `/api/groups/${gid}/archive`, { archived: true })).status).toBe(401);
  });

  it('never hides money: totals and friends still count the archived group', async () => {
    const before = (await call<MeDTO>('gino', 'GET', '/api/me')).data;
    await archive('gino', true);
    const after = (await call<MeDTO>('gino', 'GET', '/api/me')).data;
    expect(after.totals).toEqual(before.totals);
    expect(after.totals).toEqual([{ currency: 'JPY', owed: 0, owe: 3000 }]);
    expect(after.friends).toEqual(before.friends);
    const g = after.groups.find(x => x.id === gid)!;
    expect(g.myNet).toBe(-3000);
    expect(g.archived).toBe(true);
  });
});

describe('the group comes back on its own', () => {
  it('when someone else adds an expense, for everyone but the author', async () => {
    await archive('gino', true);
    await archive('kai', true);
    await archive('abbie', true);
    expect((await put('abbie', 'e-0002-taxi', expense({ description: '計程車', amount: 3000, payers: [{ memberId: mid.abbie, amount: 3000 }] }))).status).toBe(200);
    expect(archivedAt('gino')).toBeNull();
    expect(archivedAt('kai')).toBeNull();
    // The author's own entry does not bring it back for her.
    expect(archivedAt('abbie')).not.toBeNull();
  });

  it('not for my own entries', async () => {
    await archive('gino', true);
    expect((await put('gino', 'e-0003-mine', expense({ payers: [{ memberId: mid.gino, amount: 9000 }] }))).status).toBe(200);
    expect(archivedAt('gino')).not.toBeNull();
  });

  it('when someone else records a payment', async () => {
    await archive('gino', true);
    const pay: UpsertExpenseReq = {
      kind: 'payment', description: '', category: 'payment', amount: 3000, currency: 'JPY', fxRate: 1, date: todayUTC(),
      payers: [{ memberId: mid.kai, amount: 3000 }], split: { method: 'exact', entries: [{ memberId: mid.abbie, value: 3000 }] },
    };
    expect((await put('kai', 'e-0004-pay', pay)).status).toBe(200);
    expect(archivedAt('gino')).toBeNull();
  });

  it('not for edits or deletes, but for a restore by someone else', async () => {
    await archive('gino', true);
    expect((await put('abbie', 'e-0001-dinner', { ...expense({ description: '晚餐（改）' }), baseVersion: 1 })).status).toBe(200);
    expect(archivedAt('gino')).not.toBeNull();
    expect((await call('abbie', 'DELETE', `/api/groups/${gid}/expenses/e-0001-dinner`)).status).toBe(200);
    expect(archivedAt('gino')).not.toBeNull();
    expect((await call('abbie', 'POST', `/api/groups/${gid}/expenses/e-0001-dinner/restore`)).status).toBe(200);
    expect(archivedAt('gino')).toBeNull();
    // My own restore leaves it archived.
    await archive('gino', true);
    await call('abbie', 'DELETE', `/api/groups/${gid}/expenses/e-0001-dinner`);
    await call('gino', 'POST', `/api/groups/${gid}/expenses/e-0001-dinner/restore`);
    expect(archivedAt('gino')).not.toBeNull();
  });

  it('when someone else imports entries', async () => {
    await archive('gino', true);
    const r = await call('abbie', 'POST', `/api/groups/${gid}/import`, { expenses: [{ id: 'e-0005-import', ...expense() }] });
    expect(r.status).toBe(200);
    expect(r.data.imported).toBe(1);
    expect(archivedAt('gino')).toBeNull();
  });

  it('when a recurring copy is made', async () => {
    const start = addDays(todayUTC(), -8);
    expect((await put('gino', 'e-0006-rent', expense({ description: '房租', date: start, repeat: 'weekly', payers: [{ memberId: mid.gino, amount: 9000 }] }))).status).toBe(200);
    await archive('gino', true);
    await archive('abbie', true);
    // Opening the group makes the copy that is due (the system writes it).
    expect((await call('kai', 'GET', `/api/groups/${gid}`)).status).toBe(200);
    expect(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE group_id = ? AND type = 'recurring.create'", gid)[0].n).toBe(1);
    expect(archivedAt('gino')).toBeNull();
    expect(archivedAt('abbie')).toBeNull();
  });

  it('when I come back after leaving', async () => {
    // Settle Gino first: he owes Abbie 3,000.
    const pay: UpsertExpenseReq = {
      kind: 'payment', description: '', category: 'payment', amount: 3000, currency: 'JPY', fxRate: 1, date: todayUTC(),
      payers: [{ memberId: mid.gino, amount: 3000 }], split: { method: 'exact', entries: [{ memberId: mid.abbie, value: 3000 }] },
    };
    expect((await put('gino', 'e-0007-settle', pay)).status).toBe(200);
    // The last admin cannot leave: Abbie becomes one first.
    expect((await call('gino', 'PATCH', `/api/groups/${gid}/members/${mid.abbie}`, { role: 'admin' })).status).toBe(200);
    await archive('gino', true);
    expect((await call('gino', 'DELETE', `/api/groups/${gid}/members/${mid.gino}`)).status).toBe(200);
    const code = db.rows<{ invite_code: string }>('SELECT invite_code FROM groups WHERE id = ?', gid)[0].invite_code;
    expect((await call('gino', 'POST', `/api/join/${code}`, {})).status).toBe(200);
    expect(archivedAt('gino')).toBeNull();
  });
});
