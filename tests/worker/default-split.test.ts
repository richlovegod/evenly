// A group's default split on the Worker (docs/SPEC.md section 4, Default split) on the worker.fetch
// harness with the real schema: PATCH /api/groups/:gid sets it (checked against the active members,
// setAt the time of the change) or clears it, any member may, the same one again writes nothing, a
// change leaves one 'group.update' activity row that sends no push; every snapshot carries it; a
// member who leaves is dropped from it (and from being its payer) in the same batch; a PATCH without
// the field (an app from before default splits) keeps it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayUTC } from '../../src/shared/dates';
import type { DefaultSplit, GroupSnapshotDTO, UpsertExpenseReq } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';

let db: TestD1;
let env: Record<string, unknown>;
const tokens: Record<string, string> = {};

async function call<T = any>(user: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const h: Record<string, string> = { 'cf-connecting-ip': '203.0.113.9' };
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request(SITE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

async function addUser(id: string, name: string): Promise<void> {
  const now = new Date().toISOString();
  db.exec(
    'INSERT INTO users (id, name, email, locale, currency, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, name, id + '@evenly.test', 'zh-TW', 'TWD', '#2F6FB5', now, now,
  );
  tokens[id] = await createSession(db.d1, id, 'test');
}

let gid = '';
const mid: Record<string, string> = {};
const stored = () => db.rows<{ default_split: string | null }>('SELECT default_split FROM groups WHERE id = ?', gid)[0].default_split;
const updates = () =>
  db.rows<{ data: string; push_at: string | null; user_id: string }>("SELECT data, push_at, user_id FROM activity WHERE group_id = ? AND type = 'group.update' ORDER BY rowid", gid);
const patch = (user: string, body: unknown) => call<GroupSnapshotDTO>(user, 'PATCH', `/api/groups/${gid}`, body);
const rent = () => ({ method: 'percent' as const, entries: [{ memberId: mid.gino, value: 60 }, { memberId: mid.abbie, value: 40 }] });

beforeEach(async () => {
  db = new TestD1();
  env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test' };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await addUser('gino', 'Gino');
  await addUser('abbie', 'Abbie');
  await addUser('kai', 'Kai');
  const r = await call<GroupSnapshotDTO>('gino', 'POST', '/api/groups', {
    name: '我們家', type: 'home', currency: 'TWD',
    members: [{ name: 'Abbie', email: 'abbie@evenly.test' }, { name: 'Kai', email: 'kai@evenly.test' }],
  });
  expect(r.status).toBe(200);
  gid = r.data.group.id;
  expect(r.data.group.defaultSplit).toBeNull();
  for (const m of r.data.members) mid[m.userId as string] = m.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PATCH /api/groups/:gid defaultSplit', () => {
  it('sets it for the whole group: stored with setAt, in every snapshot, one activity row and no push', async () => {
    const r = await patch('abbie', { defaultSplit: { ...rent(), payerId: mid.gino } });
    expect(r.status).toBe(200);
    const d = r.data.group.defaultSplit as DefaultSplit;
    expect(d).toMatchObject({ method: 'percent', entries: [{ memberId: mid.gino, value: 60 }, { memberId: mid.abbie, value: 40 }], payerId: mid.gino });
    expect(d.setAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(stored()!)).toEqual(d);
    // Everyone sees it, Kai too.
    expect((await call<GroupSnapshotDTO>('kai', 'GET', `/api/groups/${gid}`)).data.group.defaultSplit).toEqual(d);
    const rows = updates();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe('abbie');
    expect(rows[0].push_at).toBeNull();
    const data = JSON.parse(rows[0].data);
    expect(data.changes).toEqual([{ field: 'defaultSplit', from: '', to: 'Gino 60%, Abbie 40%' }]);
    expect(data.defaultSplit).toEqual({ method: 'percent', entries: d.entries, payerId: mid.gino });
  });

  it('writes nothing for the same one again, and a new row for a change', async () => {
    await patch('gino', { defaultSplit: rent() });
    const v = (await call<GroupSnapshotDTO>('gino', 'GET', `/api/groups/${gid}`)).data.group.version;
    const again = await patch('kai', { defaultSplit: rent() });
    expect(again.status).toBe(200);
    expect(again.data.group.version).toBe(v);
    expect(updates()).toHaveLength(1);
    const equal = await patch('kai', { defaultSplit: { method: 'equal', entries: [{ memberId: mid.gino }, { memberId: mid.kai }] } });
    expect(equal.data.group.defaultSplit).toMatchObject({ method: 'equal', entries: [{ memberId: mid.gino }, { memberId: mid.kai }], payerId: null });
    const rows = updates();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1].data).changes).toEqual([{ field: 'defaultSplit', from: 'Gino 60%, Abbie 40%', to: 'Gino, Kai' }]);
  });

  it('clears it with null (and null again changes nothing)', async () => {
    await patch('gino', { defaultSplit: rent() });
    const r = await patch('abbie', { defaultSplit: null });
    expect(r.data.group.defaultSplit).toBeNull();
    expect(stored()).toBeNull();
    const rows = updates();
    expect(rows).toHaveLength(2);
    const data = JSON.parse(rows[1].data);
    expect(data.changes).toEqual([{ field: 'defaultSplit', from: 'Gino 60%, Abbie 40%', to: '' }]);
    expect(data.defaultSplit).toBeNull();
    await patch('abbie', { defaultSplit: null });
    expect(updates()).toHaveLength(2);
  });

  it('refuses what cannot be a default, with the reason in details, and writes nothing', async () => {
    const cases: [unknown, string][] = [
      [{ method: 'percent', entries: [{ memberId: mid.gino, value: 60 }, { memberId: mid.abbie, value: 30 }] }, 'percent_mismatch'],
      [{ method: 'shares', entries: [{ memberId: mid.gino, value: 0 }] }, 'no_participants'],
      [{ method: 'equal', entries: [{ memberId: 'nobody' }] }, 'unknown_member'],
      [{ method: 'equal', entries: [{ memberId: mid.gino }, { memberId: mid.gino }] }, 'duplicate_member'],
      [{ method: 'equal', entries: [{ memberId: mid.gino }], payerId: 'nobody' }, 'unknown_payer'],
    ];
    for (const [defaultSplit, reason] of cases) {
      const r = await patch('gino', { defaultSplit });
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe('validation');
      expect(r.data.error.details).toMatchObject({ code: 'default_split', reason });
    }
    // Amounts, adjustments and items are per expense only: the schema refuses them.
    const exact = await patch('gino', { defaultSplit: { method: 'exact', entries: [{ memberId: mid.gino, value: 100 }] } });
    expect(exact.status).toBe(400);
    expect(stored()).toBeNull();
    expect(updates()).toHaveLength(0);
  });

  it('keeps it when an older app saves other settings without the field', async () => {
    await patch('gino', { defaultSplit: rent() });
    const r = await patch('kai', { name: '我們家（新）', notes: '房租每月 5 號' });
    expect(r.status).toBe(200);
    expect(r.data.group.defaultSplit).toMatchObject(rent());
  });

  it('is refused for someone who is not in the group', async () => {
    await addUser('stranger', 'Stranger');
    expect((await patch('stranger', { defaultSplit: rent() })).status).toBe(404);
  });
});

describe('members leaving', () => {
  it('drops the member from it and as its payer, in the same batch; a 比例 default then no longer adds up', async () => {
    await patch('gino', { defaultSplit: { method: 'percent', entries: [{ memberId: mid.gino, value: 50 }, { memberId: mid.kai, value: 50 }], payerId: mid.kai } });
    const before = JSON.parse(stored()!);
    const left = await call('kai', 'DELETE', `/api/groups/${gid}/members/${mid.kai}`);
    expect(left.status).toBe(200);
    const after = JSON.parse(stored()!);
    expect(after).toEqual({ ...before, entries: [{ memberId: mid.gino, value: 50 }], payerId: null });
    // Leaving writes no extra activity row about the default.
    expect(updates()).toHaveLength(1);
  });

  it('clears it when nobody in it is left, and leaves it alone for someone not in it', async () => {
    await patch('gino', { defaultSplit: { method: 'equal', entries: [{ memberId: mid.kai }] } });
    const untouched = stored();
    // Abbie is not in it: removing her changes nothing.
    expect((await call('gino', 'DELETE', `/api/groups/${gid}/members/${mid.abbie}`)).status).toBe(200);
    expect(stored()).toBe(untouched);
    expect((await call('gino', 'DELETE', `/api/groups/${gid}/members/${mid.kai}`)).status).toBe(200);
    expect(stored()).toBeNull();
  });

  it('leaves a member who joined later out of it until someone edits it', async () => {
    await patch('gino', { defaultSplit: rent() });
    // Times are kept to the millisecond: join a moment later.
    await new Promise(r => setTimeout(r, 5));
    const added = await call('gino', 'POST', `/api/groups/${gid}/members`, { name: 'Lily' });
    expect(added.status).toBe(200);
    const snap = (await call<GroupSnapshotDTO>('gino', 'GET', `/api/groups/${gid}`)).data;
    expect(snap.group.defaultSplit?.entries.map(e => e.memberId)).toEqual([mid.gino, mid.abbie]);
    const lily = snap.members.find(m => m.name === 'Lily')!;
    expect(lily.createdAt > (snap.group.defaultSplit as DefaultSplit).setAt).toBe(true);
    // An expense still saves with its own split, the default untouched.
    const body: UpsertExpenseReq = {
      kind: 'expense', description: '房租', category: 'home.rent', amount: 30000, currency: 'TWD', fxRate: 1, date: todayUTC(),
      payers: [{ memberId: mid.gino, amount: 30000 }], split: { method: 'percent', entries: rent().entries },
    };
    expect((await call('gino', 'PUT', `/api/groups/${gid}/expenses/e-rent-0001`, body)).status).toBe(200);
  });
});
