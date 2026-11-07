// Review-1106, third pass, on the worker.fetch harness with the real schema (tests/worker/
// d1-sqlite.ts): a 1:1 ledger takes no group invite link (W3-correct-02); its last admin can
// always leave, and nobody takes a role away in it (W3-correct-03); an import counts only entries
// the group does not have against its room (B6b-02); and a retry of a save that went in with its
// answer lost is answered as done instead of a 409 against itself (W2-correct-01, opId).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { todayUTC } from '../../src/shared/dates';
import type { ActivityDTO, ExpenseDTO, GroupSnapshotDTO, UpsertExpenseReq } from '../../src/shared/types';
import { bodyOfExpense } from '../../src/web/features/expenses/editorLogic';
import { createSession } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { MAX_LIVE_ENTRIES } from '../../src/worker/routes/expenses';
import { TestD1 } from './d1-sqlite';

let db: TestD1;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  data: T;
}

async function api<T = any>(user: string | null, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const h: Record<string, string> = { 'cf-connecting-ip': '203.0.113.9' };
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request('http://api.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'http://app.test/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

async function addUser(id: string, name: string, email: string): Promise<void> {
  const now = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, email, '#2F6FB5', now, now);
  tokens[id] = await createSession(db.d1, id, 'test');
}

const membersOf = (gid: string) =>
  db.rows<{ id: string; user_id: string | null; name: string; role: string; active: number }>(
    'SELECT id, user_id, name, role, active FROM members WHERE group_id = ? ORDER BY sort',
    gid,
  );
const inviteCodeOf = (gid: string) => db.rows<{ invite_code: string }>('SELECT invite_code FROM groups WHERE id = ?', gid)[0].invite_code;

/** Ann's 1:1 ledger with Bea (both have accounts, both admins), or with a placeholder named 佳穎. */
async function pairWith(friend: 'bea' | 'placeholder'): Promise<string> {
  const r = await api<{ groupId: string }>('uA', 'POST', '/api/friends', friend === 'bea' ? { name: 'Bea', email: 'b@evenly.test' } : { name: '佳穎' });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data.groupId;
}

/** A trip of Ann (admin) and Bea (added by email, a member). */
async function trip(): Promise<GroupSnapshotDTO> {
  const r = await api<GroupSnapshotDTO>('uA', 'POST', '/api/groups', { name: 'trip', type: 'trip', currency: 'TWD', members: [{ name: 'Bea', email: 'b@evenly.test' }] });
  expect(r.status).toBe(200);
  return r.data;
}

beforeEach(async () => {
  db = new TestD1();
  await addUser('uA', 'Ann', 'a@evenly.test');
  await addUser('uB', 'Bea', 'b@evenly.test');
  await addUser('uC', 'Cid', 'c@evenly.test');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('a 1:1 ledger and its invite code (review W3-correct-02)', () => {
  it('neither join route opens it: GET and POST /api/join/<code> answer 404, as for a reset link', async () => {
    const pair = await pairWith('placeholder');
    const code = inviteCodeOf(pair);
    const placeholder = membersOf(pair).find(m => !m.user_id)!;
    const look = await api(null, 'GET', '/api/join/' + code);
    expect([look.status, look.data.error.code]).toEqual([404, 'not_found']);
    // A link the old web shared: whoever holds it can no longer claim the placeholder.
    const claim = await api('uC', 'POST', '/api/join/' + code, { memberId: placeholder.id });
    expect([claim.status, claim.data.error.code]).toEqual([404, 'not_found']);
    const asNew = await api('uC', 'POST', '/api/join/' + code, { name: 'Cid' });
    expect(asNew.status).toBe(404);
    expect(membersOf(pair).map(m => m.user_id)).toEqual(['uA', null]);
  });

  it('a group\'s invite link still works', async () => {
    const g = await trip();
    const code = inviteCodeOf(g.group.id);
    expect((await api(null, 'GET', '/api/join/' + code)).status).toBe(200);
    expect((await api('uC', 'POST', '/api/join/' + code, { name: 'Cid' })).status).toBe(200);
  });
});

describe('the admins of a 1:1 ledger (review W3-correct-03)', () => {
  it('its last admin leaves though an older web page demoted the friend: the friend becomes admin in the same write', async () => {
    const pair = await pairWith('bea');
    // As an older web build's 取消管理員 left it.
    db.exec("UPDATE members SET role = 'member' WHERE group_id = ? AND user_id = 'uB'", pair);
    const ann = membersOf(pair).find(m => m.user_id === 'uA')!;
    const r = await api('uA', 'DELETE', `/api/groups/${pair}/members/${ann.id}`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(membersOf(pair).map(m => [m.user_id, m.role, m.active])).toEqual([['uA', 'admin', 0], ['uB', 'admin', 1]]);
  });

  it('a group still asks for another admin first', async () => {
    const g = await trip();
    const r = await api('uA', 'DELETE', `/api/groups/${g.group.id}/members/${g.me.memberId}`);
    expect([r.status, r.data.error.code]).toEqual([409, 'last_admin']);
  });

  it('nobody takes an admin role away in it (403); making someone an admin again is fine', async () => {
    const pair = await pairWith('bea');
    const bea = membersOf(pair).find(m => m.user_id === 'uB')!;
    const down = await api('uA', 'PATCH', `/api/groups/${pair}/members/${bea.id}`, { role: 'member' });
    expect([down.status, down.data.error.code]).toEqual([403, 'forbidden']);
    expect(membersOf(pair).find(m => m.id === bea.id)!.role).toBe('admin');
    db.exec("UPDATE members SET role = 'member' WHERE id = ?", bea.id);
    const up = await api('uA', 'PATCH', `/api/groups/${pair}/members/${bea.id}`, { role: 'admin' });
    expect(up.status).toBe(200);
    expect(membersOf(pair).find(m => m.id === bea.id)!.role).toBe('admin');
  });
});

describe('an import near the group\'s limit (review B6b-02)', () => {
  function entry(g: GroupSnapshotDTO, id: string) {
    const A = g.me.memberId;
    return {
      id, kind: 'expense', description: 'x', category: 'general', amount: 100, currency: 'TWD', fxRate: 1, date: todayUTC(),
      payers: [{ memberId: A, amount: 100 }], split: { method: 'equal', entries: [{ memberId: A }] },
    };
  }
  /** `n` live rows straight into the group. */
  function fill(gid: string, memberId: string, n: number) {
    const now = new Date().toISOString();
    db.exec(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
       INSERT INTO expenses (id, group_id, kind, description, category, amount, currency, fx_rate, date, notes, payers, split, shares,
         repeat, created_by, created_at, updated_by, updated_at, deleted_at, version)
       SELECT 'fill-' || i, ?, 'expense', 'x', 'general', 100, 'TWD', 1, ?, '', ?, ?, ?, 'none', 'uA', ?, 'uA', ?, NULL, 1 FROM k`,
      n, gid, todayUTC(), JSON.stringify([{ memberId, amount: 100 }]), JSON.stringify({ method: 'equal', entries: [{ memberId }] }),
      JSON.stringify([{ memberId, amount: 100 }]), now, now,
    );
  }

  it('entries the group has already take none of the room: they come back as exists, and new ones still fit', async () => {
    const g = await trip();
    const gid = g.group.id;
    fill(gid, g.me.memberId, MAX_LIVE_ENTRIES - 2);
    expect((await api('uA', 'POST', `/api/groups/${gid}/import`, { expenses: [entry(g, 'imp-0001')] })).data).toMatchObject({ imported: 1, skipped: [] });
    // Room for one more: the same file again with one new entry.
    const again = await api('uA', 'POST', `/api/groups/${gid}/import`, { expenses: [entry(g, 'imp-0001'), entry(g, 'imp-0002')] });
    expect(again.data).toMatchObject({ imported: 1, skipped: [{ index: 0, code: 'exists', field: 'id' }] });
    // Full now: an entry it has is exists, not limit_reached; a new one is limit_reached.
    const full = await api('uA', 'POST', `/api/groups/${gid}/import`, { expenses: [entry(g, 'imp-0002'), entry(g, 'imp-0003')] });
    expect(full.data).toMatchObject({ imported: 0, skipped: [{ index: 0, code: 'exists', field: 'id' }, { index: 1, code: 'limit_reached' }] });
  });
});

describe('a retry of a save whose answer was lost (review W2-correct-01)', () => {
  async function world() {
    const g = await trip();
    const gid = g.group.id;
    const A = g.me.memberId;
    const B = g.members.find(m => m.name === 'Bea')!.id;
    const eid = 'entry-r3-0001';
    const v1 = {
      kind: 'expense', description: '燒肉晚餐', category: 'food.dining', amount: 1000, currency: 'TWD', fxRate: 1, date: '2026-11-01',
      payers: [{ memberId: A, amount: 1000 }], split: { method: 'equal', entries: [{ memberId: A }, { memberId: B }] },
    };
    expect((await api('uA', 'PUT', `/api/groups/${gid}/expenses/${eid}`, v1)).status).toBe(200);
    const stored = async (): Promise<ExpenseDTO> => (await api<GroupSnapshotDTO>('uA', 'GET', '/api/groups/' + gid)).data.expenses.find(e => e.id === eid)!;
    /** An edit from `from` (the copy its form showed), as the editor builds it. */
    const edit = (from: ExpenseDTO, change: Partial<UpsertExpenseReq>, opId?: string): UpsertExpenseReq => {
      const { baseVersion: _v, base: _b, ...was } = bodyOfExpense(from);
      return { ...was, ...change, baseVersion: from.version, base: was, rateBase: 'TWD', ...(opId ? { opId } : {}) };
    };
    const amount = (n: number) => ({ amount: n, payers: [{ memberId: A, amount: n }] });
    const put = (user: string, body: UpsertExpenseReq) => api<{ expense: ExpenseDTO; groupVersion: number }>(user, 'PUT', `/api/groups/${gid}/expenses/${eid}`, body);
    const activityRows = () => db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM activity WHERE expense_id = ?', eid)[0].n;
    return { gid, eid, stored, edit, amount, put, activityRows };
  }

  it('the save went in, Bea changed the same part since: the retry is answered as done and writes nothing', async () => {
    const w = await world();
    const opened = await w.stored();
    const save = w.edit(opened, w.amount(2000), '0b9e0b9e-0000-4000-8000-0000000000a1');
    expect((await w.put('uA', save)).status).toBe(200);
    // Bea saw NT$2,000 and sets NT$1,500.
    expect((await w.put('uB', w.edit(await w.stored(), w.amount(1500)))).status).toBe(200);
    const before = await w.stored();
    const rows = w.activityRows();
    const retry = await w.put('uA', save);
    expect(retry.status).toBe(200);
    expect(retry.data.expense).toMatchObject({ amount: 1500, version: before.version });
    expect(await w.stored()).toMatchObject({ amount: 1500, version: before.version });
    expect(w.activityRows()).toBe(rows);
  });

  it('a save that never went in still meets the clash (409), with or without an opId', async () => {
    const w = await world();
    const opened = await w.stored();
    expect((await w.put('uB', w.edit(opened, w.amount(1500)))).status).toBe(200);
    const never = await w.put('uA', w.edit(opened, w.amount(2000), '0b9e0b9e-0000-4000-8000-0000000000a2'));
    expect([never.status, never.data && (never.data as any).error.code]).toEqual([409, 'conflict']);
    const old = await w.put('uA', w.edit(opened, w.amount(2000)));
    expect(old.status).toBe(409);
    // Another account's save with the same id is not this one.
    const other = w.edit(opened, { description: 'Bea renamed it' }, '0b9e0b9e-0000-4000-8000-0000000000a3');
    expect((await w.put('uB', other)).status).toBe(200);
    expect((await w.put('uA', { ...w.edit(opened, w.amount(2500)), opId: '0b9e0b9e-0000-4000-8000-0000000000a3' })).status).toBe(409);
  });

  it('the history keeps the opId to itself', async () => {
    const w = await world();
    expect((await w.put('uA', w.edit(await w.stored(), w.amount(2000), '0b9e0b9e-0000-4000-8000-0000000000a4'))).status).toBe(200);
    const stored = db.rows<{ data: string }>("SELECT data FROM activity WHERE expense_id = ? AND type = 'expense.update'", w.eid);
    expect(JSON.parse(stored[0].data).opId).toBe('0b9e0b9e-0000-4000-8000-0000000000a4');
    const h = await api<{ items: ActivityDTO[] }>('uA', 'GET', `/api/groups/${w.gid}/expenses/${w.eid}/history`);
    expect(h.status).toBe(200);
    expect(h.data.items.length).toBeGreaterThan(0);
    for (const item of h.data.items) expect('opId' in item.data).toBe(false);
  });
});
