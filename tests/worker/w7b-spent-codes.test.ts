// Spent one-time codes and links are deleted, not marked used (review B4a-03): the privacy page
// says sign-in codes and links are deleted once used, and by the daily cleanup once they expire.
// A code to sign in another device (POST /api/auth/link), a password reset link (POST
// /api/auth/reset, with the account's other reset links) and a member claim link (POST
// /api/claim/:token); the iPhone app's Google codes and link tickets are in apple-sign-in.test.ts.
// Each still works once, a failed try spends nothing, and a row that code from before this change
// marked used is never spent again (the daily cleanup deletes it once it expires). Runs the real
// Worker against the real schema in SQLite (d1-sqlite.ts), as a script calls it (Bearer).

import { beforeEach, describe, expect, it } from 'vitest';
import type { GroupSnapshotDTO } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import { sha256Hex } from '../../src/worker/http';
import worker from '../../src/worker/index';
import { cleanupStmts } from '../../src/worker/services/cron';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';

let db: TestD1;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  data: T;
}

async function api<T = any>(user: string | null, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const h: Record<string, string> = { 'cf-connecting-ip': '203.0.113.11' };
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request(SITE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

async function addUser(id: string, name: string): Promise<void> {
  const at = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, `${id}@split.test`, '#2F6FB5', at, at);
  tokens[id] = await createSession(db.d1, id, 'test');
}

const codes = (kind: string) => db.rows<{ id: string; used_at: string | null }>('SELECT id, used_at FROM login_codes WHERE kind = ? ORDER BY created_at', kind);
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/** A reset link as the admin page makes it (routes/admin.ts), or as older code left a used one. */
async function resetLink(token: string, o: { usedAt?: string; createdAt?: string } = {}): Promise<void> {
  db.exec(
    "INSERT INTO login_codes (id, user_id, kind, expires_at, used_at, created_at) VALUES (?, 'gino', 'reset', ?, ?, ?)",
    await sha256Hex(token), inMinutes(30), o.usedAt ?? null, o.createdAt ?? new Date().toISOString(),
  );
}

beforeEach(async () => {
  db = new TestD1();
  for (const k of Object.keys(tokens)) delete tokens[k];
  await addUser('gino', 'Gino');
  await addUser('abbie', 'Abbie');
});

describe('spent codes and links are deleted (review B4a-03)', () => {
  it('a code to sign in another device: the sign-in deletes it, and it works once', async () => {
    const made = await api<{ code: string }>('gino', 'POST', '/api/auth/link-code', {});
    expect(made.status).toBe(200);
    expect(codes('device')).toHaveLength(1);
    // A wrong code spends nothing.
    expect((await api(null, 'POST', '/api/auth/link', { code: 'ZZZZZZZZ' })).data.error.code).toBe('code_invalid');
    expect(codes('device')).toHaveLength(1);
    const r = await api(null, 'POST', '/api/auth/link', { code: made.data.code });
    expect(r.status).toBe(200);
    expect(r.data.user.id).toBe('gino');
    expect(codes('device')).toEqual([]);
    expect((await api(null, 'POST', '/api/auth/link', { code: made.data.code })).data.error.code).toBe('code_invalid');
  });

  it('a device code that code from before this change marked used is never spent again, and the daily cleanup deletes it once it expires', async () => {
    const code = 'ABCD2345';
    db.exec(
      "INSERT INTO login_codes (id, user_id, kind, expires_at, used_at, created_at) VALUES (?, 'gino', 'device', ?, ?, ?)",
      await sha256Hex(code), inMinutes(10), new Date().toISOString(), new Date().toISOString(),
    );
    const r = await api(null, 'POST', '/api/auth/link', { code });
    expect([r.status, r.data.error.code]).toEqual([400, 'code_invalid']);
    expect(codes('device')).toHaveLength(1);
    await db.d1.batch(cleanupStmts(db.d1, new Date(Date.now() + 11 * 60_000)));
    expect(codes('device')).toEqual([]);
  });

  it('a password reset link: setting the password deletes it with the account\'s other reset links; a weak password spends nothing', async () => {
    await resetLink('older-reset-token-0123456789', { createdAt: new Date(Date.now() - 60_000).toISOString() });
    await resetLink('newer-reset-token-0123456789');
    expect((await api(null, 'GET', '/api/auth/reset/newer-reset-token-0123456789')).data).toMatchObject({ email: 'gino@split.test' });
    const weak = await api(null, 'POST', '/api/auth/reset', { token: 'newer-reset-token-0123456789', password: 'short' });
    expect([weak.status, weak.data.error.code]).toEqual([400, 'weak_password']);
    expect(codes('reset')).toHaveLength(2);
    const r = await api(null, 'POST', '/api/auth/reset', { token: 'newer-reset-token-0123456789', password: 'a new password 1' });
    expect(r.status).toBe(200);
    expect(codes('reset')).toEqual([]);
    for (const token of ['newer-reset-token-0123456789', 'older-reset-token-0123456789']) {
      expect((await api(null, 'GET', '/api/auth/reset/' + token)).data.error.code).toBe('code_invalid');
      expect((await api(null, 'POST', '/api/auth/reset', { token, password: 'another password 2' })).data.error.code).toBe('code_invalid');
    }
  });

  it('a reset link that code from before this change marked used stays unusable', async () => {
    await resetLink('used-reset-token-0123456789', { usedAt: new Date().toISOString() });
    expect((await api(null, 'GET', '/api/auth/reset/used-reset-token-0123456789')).data.error.code).toBe('code_invalid');
    expect((await api(null, 'POST', '/api/auth/reset', { token: 'used-reset-token-0123456789', password: 'a new password 1' })).data.error.code).toBe('code_invalid');
    expect(codes('reset')).toHaveLength(1);
  });

  it('a member claim link: the claim deletes it, and it works once', async () => {
    const trip = (await api<GroupSnapshotDTO>('gino', 'POST', '/api/groups', { name: 'Niseko', type: 'trip', currency: 'TWD', members: [{ name: 'Abbie' }, { name: 'Kai' }] })).data;
    const gid = trip.group.id;
    const placeholder = (name: string) => trip.members.find(m => m.name === name)!.id;
    const link = await api<{ token: string }>('gino', 'POST', `/api/groups/${gid}/members/${placeholder('Abbie')}/claim-link`, {});
    expect(link.status).toBe(200);
    const claims = () => db.rows<{ used_at: string | null }>('SELECT used_at FROM claim_tokens WHERE group_id = ?', gid);
    expect(claims()).toEqual([{ used_at: null }]);
    expect((await api(null, 'GET', '/api/claim/' + link.data.token)).data.member.name).toBe('Abbie');
    const r = await api('abbie', 'POST', '/api/claim/' + link.data.token, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.memberId).toBe(placeholder('Abbie'));
    expect(claims()).toEqual([]);
    expect((await api(null, 'GET', '/api/claim/' + link.data.token)).data.error.code).toBe('code_invalid');
    // Another link for the other placeholder is untouched by that claim.
    const other = await api<{ token: string }>('gino', 'POST', `/api/groups/${gid}/members/${placeholder('Kai')}/claim-link`, {});
    expect(claims()).toEqual([{ used_at: null }]);
    expect((await api(null, 'GET', '/api/claim/' + other.data.token)).data.member.name).toBe('Kai');
  });
});
