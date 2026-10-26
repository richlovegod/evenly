// Friend invite links (src/worker/routes/invites.ts, docs/SPEC.md sections 4 and 6) on the
// worker.fetch harness with the real schema (tests/worker/d1-sqlite.ts): the code made on the first
// GET /api/me/invite and replaced by a reset (the old one then fails at once), the templates in both
// languages, who sent a link (GET /api/invite/:code, signed out and in, its per-IP limit), the error
// codes code_invalid and own_invite, accepting (an existing 1:1 ledger comes back with existed; a new
// one has both people as admins, the owner first, and a friend.join row for the owner), the room
// and email link limits, the inviter's photo behind the code, and the page the link opens
// (/i/<code>): the real index.html with the invite's preview tags, its boot script, and its limit.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVITE_TEMPLATES, inviteTemplates } from '../../src/shared/invites';
import type { InviteAcceptRes, InviteInfoDTO, MeDTO, MyInviteDTO } from '../../src/shared/types';
import { createSession } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { MAX_GROUPS_PER_USER, MAX_LINKS_PER_DAY } from '../../src/worker/routes/groups';
import { INVITE_IP_PER_15M, INVITE_PAGE_PER_15M } from '../../src/worker/routes/invites';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';
const INDEX_HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const FACEBOOK = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const LINE = 'Mozilla/5.0 (compatible; Linespider/1.1; +https://lin.ee/4dwXkTH)';

let db: TestD1;
let env: Record<string, unknown>;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  data: T;
  text: string;
  headers: Headers;
}

/** The built app as Workers Static Assets serves it: the real index.html for "/". */
const assets = {
  fetch: async (req: Request) =>
    new Response(req.method === 'HEAD' ? null : INDEX_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"build-1"' },
    }),
};

async function call<T = any>(user: string | null, method: string, path: string, o: { body?: unknown; ip?: string; headers?: Record<string, string> } = {}): Promise<Res<T>> {
  const h: Record<string, string> = { 'cf-connecting-ip': o.ip ?? '203.0.113.7', ...o.headers };
  if (user) h.Authorization = 'Bearer ' + tokens[user];
  if (o.body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request(SITE + path, { method, headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  const json = (res.headers.get('Content-Type') || '').includes('json');
  return { status: res.status, data: text && json ? JSON.parse(text) : undefined, text, headers: res.headers };
}

async function addUser(id: string, name: string, o: { email?: string | null; locale?: 'zh-TW' | 'en'; currency?: string; color?: string } = {}): Promise<void> {
  const now = new Date().toISOString();
  db.exec(
    'INSERT INTO users (id, name, email, locale, currency, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, name, o.email ?? null, o.locale ?? 'zh-TW', o.currency ?? 'TWD', o.color ?? '#2F6FB5', now, now,
  );
  tokens[id] = await createSession(db.d1, id, 'test');
}

const myInvite = async (user: string, query = ''): Promise<MyInviteDTO> => {
  const r = await call<MyInviteDTO>(user, 'GET', '/api/me/invite' + query);
  expect(r.status).toBe(200);
  return r.data;
};

const pairGroups = () => db.rows<{ id: string; name: string; currency: string; created_by: string }>("SELECT id, name, currency, created_by FROM groups WHERE type = 'pair' AND deleted_at IS NULL ORDER BY created_at, rowid");
const membersOf = (gid: string) =>
  db.rows<{ id: string; user_id: string | null; name: string; color: string; role: string; active: number; sort: number; claimed_at: string | null }>(
    'SELECT id, user_id, name, color, role, active, sort, claimed_at FROM members WHERE group_id = ? ORDER BY sort',
    gid,
  );
const activityOf = (gid: string) =>
  db.rows<{ type: string; user_id: string | null; member_id: string | null; data: string; created_at: string; push_at: string | null }>(
    'SELECT type, user_id, member_id, data, created_at, push_at FROM activity WHERE group_id = ? ORDER BY rowid',
    gid,
  );

/** The content of `<meta attr="key" content="...">` in a page. */
function meta(html: string, attr: 'name' | 'property', key: string): string | null {
  const m = new RegExp(`<meta\\s+${attr}="${key.replace(/[.:]/g, '\\$&')}"\\s+content="([^"]*)"`).exec(html);
  return m ? m[1] : null;
}

beforeEach(async () => {
  db = new TestD1();
  env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: SITE + '/', ENVIRONMENT: 'test', ASSETS: assets };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await addUser('gino', 'Gino', { email: 'gino@evenly.test', currency: 'TWD', color: '#C2410C' });
  await addUser('abbie', 'Abbie', { email: 'abbie@evenly.test', locale: 'en', currency: 'USD', color: '#15803D' });
  await addUser('kai', '佳穎', { email: null, currency: 'JPY', color: '#C2410C' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- the inviter's link ----------

describe('GET /api/me/invite', () => {
  it('makes the code on the first call and gives the same one back after that', async () => {
    expect(db.rows<{ invite_code: string | null }>('SELECT invite_code FROM users WHERE id = ?', 'gino')[0].invite_code).toBeNull();
    const first = await myInvite('gino');
    expect(first.code).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(first.url).toBe(`${SITE}/i/${first.code}?openExternalBrowser=1`);
    expect(db.rows<{ invite_code: string }>('SELECT invite_code FROM users WHERE id = ?', 'gino')[0].invite_code).toBe(first.code);
    const again = await myInvite('gino');
    expect(again.code).toBe(first.code);
    expect(again.url).toBe(first.url);
    // Everyone gets a code of their own.
    expect((await myInvite('abbie')).code).not.toBe(first.code);
  });

  it('sends the three messages in the account\'s language, or in ?locale=', async () => {
    const zh = await myInvite('gino');
    expect(zh.templates).toEqual(inviteTemplates('zh-TW'));
    expect(zh.templates.map(t => [t.key, t.label])).toEqual([['everyday', '日常'], ['trip', '旅行'], ['roommates', '室友']]);
    expect(zh.templates[0].text).toBe('我最近都用吉諾分帳所記分帳，誰付了多少、誰欠誰一目了然。點連結加入，我們就是朋友了，不用下載 App：');
    const en = await myInvite('abbie');
    expect(en.templates.map(t => t.label)).toEqual(['Everyday', 'Trip', 'Roommates']);
    expect(en.templates[2].text).toBe("Rent, utilities, groceries: let's log them all in Gino's Split Lab and skip the monthly reckoning. Open the link to join me:");
    expect((await myInvite('gino', '?locale=en')).templates).toEqual(inviteTemplates('en'));
    expect((await myInvite('abbie', '?locale=zh-TW')).templates).toEqual(inviteTemplates('zh-TW'));
    // Something else: the account's own language.
    expect((await myInvite('abbie', '?locale=fr')).templates).toEqual(inviteTemplates('en'));
  });

  it('keeps every message free of the link (the apps put it on its own line) and of dashes', () => {
    const dashes = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
    for (const t of INVITE_TEMPLATES) {
      for (const lang of ['zh', 'en'] as const) {
        expect(t[lang].text).not.toMatch(/https?:|\n/);
        expect(t[lang].text).not.toMatch(dashes);
      }
    }
  });

  it('needs a sign-in', async () => {
    expect((await call(null, 'GET', '/api/me/invite')).status).toBe(401);
    expect((await call(null, 'POST', '/api/me/invite/reset')).status).toBe(401);
  });
});

describe('POST /api/me/invite/reset', () => {
  it('puts a new code in place of the old one, which stops working at once', async () => {
    const old = await myInvite('gino');
    const reset = await call<MyInviteDTO>('gino', 'POST', '/api/me/invite/reset');
    expect(reset.status).toBe(200);
    expect(reset.data.code).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(reset.data.code).not.toBe(old.code);
    expect(reset.data.url).toBe(`${SITE}/i/${reset.data.code}?openExternalBrowser=1`);
    expect(reset.data.templates).toEqual(inviteTemplates('zh-TW'));
    expect((await myInvite('gino')).code).toBe(reset.data.code);

    for (const r of [await call(null, 'GET', '/api/invite/' + old.code), await call('abbie', 'GET', '/api/invite/' + old.code), await call('abbie', 'POST', '/api/invite/' + old.code)]) {
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe('code_invalid');
    }
    expect(pairGroups()).toEqual([]);
    expect((await call<InviteInfoDTO>(null, 'GET', '/api/invite/' + reset.data.code)).status).toBe(200);
  });

  it('works before the first GET too, and friends made with the old link stay friends', async () => {
    const old = await myInvite('gino');
    const accepted = await call<InviteAcceptRes>('abbie', 'POST', '/api/invite/' + old.code);
    expect(accepted.data.existed).toBe(false);
    const fresh = (await call<MyInviteDTO>('gino', 'POST', '/api/me/invite/reset?locale=en')).data;
    expect(fresh.templates).toEqual(inviteTemplates('en'));
    const seen = await call<InviteInfoDTO>('abbie', 'GET', '/api/invite/' + fresh.code);
    expect(seen.data.groupId).toBe(accepted.data.groupId);
    // An account that never asked for a link can reset straight away.
    const k = await call<MyInviteDTO>('kai', 'POST', '/api/me/invite/reset');
    expect(k.status).toBe(200);
    expect((await myInvite('kai')).code).toBe(k.data.code);
  });
});

// ---------- the person the link was sent to ----------

describe('GET /api/invite/:code', () => {
  it('shows anyone who sent it, without signing in: the name, color and photo version, never an email', async () => {
    const { code } = await myInvite('gino');
    const r = await call<InviteInfoDTO>(null, 'GET', '/api/invite/' + code);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ inviter: { name: 'Gino', color: '#C2410C', avatar: null }, self: false, groupId: null });
    expect(r.text).not.toContain('gino@evenly.test');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });

  it('signed in: self for my own link, and the 1:1 ledger once we are friends', async () => {
    const { code } = await myInvite('gino');
    expect((await call<InviteInfoDTO>('gino', 'GET', '/api/invite/' + code)).data).toMatchObject({ self: true, groupId: null });
    expect((await call<InviteInfoDTO>('abbie', 'GET', '/api/invite/' + code)).data).toMatchObject({ self: false, groupId: null });
    const accepted = (await call<InviteAcceptRes>('abbie', 'POST', '/api/invite/' + code)).data;
    expect((await call<InviteInfoDTO>('abbie', 'GET', '/api/invite/' + code)).data).toMatchObject({ self: false, groupId: accepted.groupId });
    // Someone else is still no friend of Gino's.
    expect((await call<InviteInfoDTO>('kai', 'GET', '/api/invite/' + code)).data.groupId).toBeNull();
  });

  it('code_invalid for a code nobody has, a reset one and one of the wrong shape', async () => {
    for (const code of ['AbCdEfGh12345678', 'short', 'has-a-dash-in-it', 'x'.repeat(65)]) {
      const r = await call(null, 'GET', '/api/invite/' + code);
      expect(r.status, code).toBe(400);
      expect(r.data.error.code, code).toBe('code_invalid');
    }
  });

  it('counts looks without a sign-in per IP (INVITE_IP_PER_15M, 30 by default); signed-in looks are not counted', async () => {
    const { code } = await myInvite('gino');
    expect(INVITE_IP_PER_15M).toBe(30);
    for (let i = 0; i < INVITE_IP_PER_15M; i++) expect((await call(null, 'GET', '/api/invite/' + code, { ip: '198.51.100.1' })).status).toBe(200);
    const over = await call(null, 'GET', '/api/invite/' + code, { ip: '198.51.100.1' });
    expect(over.status).toBe(429);
    expect(over.data.error.code).toBe('rate_limited');
    expect(Number(over.headers.get('Retry-After'))).toBeGreaterThan(0);
    // A code that does not work counts too (the limit comes first).
    expect((await call(null, 'GET', '/api/invite/AbCdEfGh12345678', { ip: '198.51.100.1' })).status).toBe(429);
    expect((await call(null, 'GET', '/api/invite/' + code, { ip: '198.51.100.2' })).status).toBe(200);
    expect((await call('abbie', 'GET', '/api/invite/' + code, { ip: '198.51.100.1' })).status).toBe(200);
    // The override, as staging sets it.
    env.INVITE_IP_PER_15M = '2';
    for (const s of [200, 200, 429]) expect((await call(null, 'GET', '/api/invite/' + code, { ip: '198.51.100.3' })).status).toBe(s);
  });
});

describe('POST /api/invite/:code', () => {
  it('own_invite for my own link, and nothing is written', async () => {
    const { code } = await myInvite('gino');
    const r = await call('gino', 'POST', '/api/invite/' + code);
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('own_invite');
    expect(pairGroups()).toEqual([]);
  });

  it('makes a 1:1 ledger with both people as admins, the link\'s owner first and in their currency', async () => {
    const { code } = await myInvite('gino');
    const r = await call<InviteAcceptRes>('abbie', 'POST', '/api/invite/' + code);
    expect(r.status).toBe(200);
    expect(r.data.existed).toBe(false);
    expect(pairGroups()).toEqual([{ id: r.data.groupId, name: 'Gino & Abbie', currency: 'TWD', created_by: 'abbie' }]);
    const members = membersOf(r.data.groupId);
    expect(members.map(m => [m.user_id, m.name, m.role, m.active, m.sort])).toEqual([
      ['gino', 'Gino', 'admin', 1, 0],
      ['abbie', 'Abbie', 'admin', 1, 1],
    ]);
    expect(members.every(m => !!m.claimed_at)).toBe(true);
    // Each keeps their own color unless the other has it.
    expect(members.map(m => m.color)).toEqual(['#C2410C', '#15803D']);
    // Both see it, as a friend with a ledger.
    const snap = await call('abbie', 'GET', '/api/groups/' + r.data.groupId);
    expect(snap.status).toBe(200);
    expect(snap.data.group.type).toBe('pair');
    expect(snap.data.me.role).toBe('admin');
    const me = (await call<MeDTO>('gino', 'GET', '/api/me')).data;
    expect(me.friends.find(f => f.userId === 'abbie')).toMatchObject({ name: 'Abbie', pairGroupId: r.data.groupId });
  });

  it('gives the second person another color when the owner has theirs', async () => {
    const { code } = await myInvite('gino');
    const r = await call<InviteAcceptRes>('kai', 'POST', '/api/invite/' + code);
    const [owner, joiner] = membersOf(r.data.groupId);
    expect(owner.color).toBe('#C2410C');
    expect(joiner.color).not.toBe('#C2410C');
    expect(joiner.color).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('already friends: existed, the same ledger, and nothing new is written', async () => {
    const { code } = await myInvite('gino');
    const first = (await call<InviteAcceptRes>('abbie', 'POST', '/api/invite/' + code)).data;
    const rows = activityOf(first.groupId).length;
    const again = await call<InviteAcceptRes>('abbie', 'POST', '/api/invite/' + code);
    expect(again.status).toBe(200);
    expect(again.data).toEqual({ groupId: first.groupId, existed: true });
    expect(pairGroups()).toHaveLength(1);
    expect(activityOf(first.groupId)).toHaveLength(rows);
  });

  it('reuses the 1:1 ledger made by POST /api/friends, and makes a new one when one of them left the old', async () => {
    const f = await call<{ groupId: string }>('abbie', 'POST', '/api/friends', { body: { name: 'Gino', email: 'gino@evenly.test' } });
    expect(f.status).toBe(200);
    const { code } = await myInvite('gino');
    expect((await call<InviteAcceptRes>('abbie', 'POST', '/api/invite/' + code)).data).toEqual({ groupId: f.data.groupId, existed: true });
    db.exec('UPDATE members SET active = 0 WHERE group_id = ? AND user_id = ?', f.data.groupId, 'abbie');
    const fresh = (await call<InviteAcceptRes>('abbie', 'POST', '/api/invite/' + code)).data;
    expect(fresh.existed).toBe(false);
    expect(fresh.groupId).not.toBe(f.data.groupId);
  });

  it('writes the owner\'s activity entry: friend.join by the one who joined, naming the owner\'s member, ready to notify', async () => {
    const { code } = await myInvite('gino');
    const r = (await call<InviteAcceptRes>('abbie', 'POST', '/api/invite/' + code)).data;
    const [owner, joiner] = membersOf(r.groupId);
    const rows = activityOf(r.groupId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'friend.join', user_id: 'abbie', member_id: joiner.id });
    expect(JSON.parse(rows[0].data)).toEqual({ groupName: 'Gino & Abbie', memberId: owner.id, memberName: 'Gino' });
    // The push sender takes it (services/push.ts): the owner hears who joined.
    expect(rows[0].push_at).toBe(rows[0].created_at);
    const feed = await call<{ items: { type: string; actorName: string; groupId: string; data: { memberId?: string } }[] }>('gino', 'GET', '/api/activity');
    expect(feed.data.items[0]).toMatchObject({ type: 'friend.join', actorName: 'Abbie', groupId: r.groupId, data: { memberId: owner.id } });
    expect((await call<MeDTO>('gino', 'GET', '/api/me')).data.unread).toBe(1);
  });

  it('counts toward the daily email link limit: past it 429 links and nothing written; being friends already is not counted', async () => {
    const { code } = await myInvite('gino');
    db.exec('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)', 'link-account:abbie', MAX_LINKS_PER_DAY, Date.now() + 86_400_000);
    const r = await call('abbie', 'POST', '/api/invite/' + code);
    expect(r.status).toBe(429);
    expect(r.data.error).toMatchObject({ code: 'rate_limited', details: { scope: 'links' } });
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(pairGroups()).toEqual([]);
    // Kai is under the limit: accepted, one link counted.
    expect((await call<InviteAcceptRes>('kai', 'POST', '/api/invite/' + code)).data.existed).toBe(false);
    expect(db.rows<{ count: number }>('SELECT count FROM rate_limits WHERE key = ?', 'link-account:kai')[0].count).toBe(1);
    db.exec('UPDATE rate_limits SET count = ? WHERE key = ?', MAX_LINKS_PER_DAY, 'link-account:kai');
    expect((await call<InviteAcceptRes>('kai', 'POST', '/api/invite/' + code)).data.existed).toBe(true);
  });

  it('409 limit_reached when either person is in the most groups one can be in', async () => {
    const { code } = await myInvite('gino');
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_GROUPS_PER_USER; i++) {
      db.exec("INSERT INTO groups (id, name, type, currency, invite_code, created_by, created_at, updated_at) VALUES (?, ?, 'trip', 'TWD', ?, 'gino', ?, ?)", 'g' + i, 'G' + i, 'inv' + i, now, now);
      db.exec("INSERT INTO members (id, group_id, user_id, name, color, created_at) VALUES (?, ?, 'gino', 'Gino', '#2F6FB5', ?)", 'm' + i, 'g' + i, now);
    }
    const r = await call('abbie', 'POST', '/api/invite/' + code);
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('limit_reached');
    expect(pairGroups()).toEqual([]);
  });

  it('needs a sign-in, and a code that works', async () => {
    const { code } = await myInvite('gino');
    expect((await call(null, 'POST', '/api/invite/' + code)).status).toBe(401);
    const bad = await call('abbie', 'POST', '/api/invite/NoSuchCode123456');
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe('code_invalid');
  });
});

describe('GET /api/invite/:code/avatar', () => {
  const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4];
  const VERSION = '0123456789abcdef';

  /** Gino's photo, stored as PUT /api/me/avatar stores it (the bytes as a BLOB, through the D1 stand-in). */
  async function withPhoto(): Promise<string> {
    await db.d1
      .prepare('INSERT INTO avatars (user_id, mime, data, version, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('gino', 'image/jpeg', JPEG, VERSION, new Date().toISOString())
      .run();
    db.exec('UPDATE users SET avatar = ? WHERE id = ?', VERSION, 'gino');
    return (await myInvite('gino')).code;
  }

  it('shows the inviter\'s photo to anyone holding the code, kept a year at its ?v= address', async () => {
    const code = await withPhoto();
    expect((await call<InviteInfoDTO>(null, 'GET', '/api/invite/' + code)).data.inviter.avatar).toBe(VERSION);
    const req = new Request(`${SITE}/api/invite/${code}/avatar?v=${VERSION}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const res = await worker.fetch(req, env as never, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(JPEG);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('ETag')).toBe(`"${VERSION}"`);
  });

  it('one 404 for an old version, a code that does not work, and no photo; 304 for the version the browser has', async () => {
    const code = await withPhoto();
    expect((await call(null, 'GET', `/api/invite/${code}/avatar?v=ffffffffffffffff`)).status).toBe(404);
    expect((await call(null, 'GET', `/api/invite/NoSuchCode123456/avatar?v=${VERSION}`)).status).toBe(404);
    const theirs = (await myInvite('abbie')).code;
    expect((await call(null, 'GET', `/api/invite/${theirs}/avatar`)).status).toBe(404);
    const current = await call(null, 'GET', `/api/invite/${code}/avatar`);
    expect(current.status).toBe(200);
    expect(current.headers.get('Cache-Control')).toBe('private, no-cache');
    expect((await call(null, 'GET', `/api/invite/${code}/avatar?v=${VERSION}`, { headers: { 'If-None-Match': `"${VERSION}"` } })).status).toBe(304);
  });
});

// ---------- the page the link opens ----------

describe('the page a friend invite link opens, /i/<code>', () => {
  const crawler = (path: string, ua = FACEBOOK, ip?: string) => call(null, 'GET', path, { ip, headers: { 'User-Agent': ua, Accept: 'text/html' } });

  it('is the app\'s page with the invite\'s preview tags, for LINE and Facebook alike', async () => {
    const { code, url } = await myInvite('gino');
    for (const ua of [FACEBOOK, LINE]) {
      const r = await crawler(`/i/${code}?openExternalBrowser=1`, ua);
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      const html = r.text;
      expect(meta(html, 'property', 'og:title')).toBe('Gino 邀請你一起用吉諾分帳所分帳');
      expect(meta(html, 'name', 'twitter:title')).toBe('Gino 邀請你一起用吉諾分帳所分帳');
      expect(html).toContain('<title>Gino 邀請你一起用吉諾分帳所分帳</title>');
      expect(meta(html, 'property', 'og:description')).toBe('打開連結加入，你們就是朋友了：一起記帳，算好誰該付誰，不用下載 App。');
      expect(meta(html, 'property', 'og:url')).toBe(url);
      expect(meta(html, 'property', 'og:image')).toBe(SITE + '/og-image.png');
      expect(meta(html, 'name', 'twitter:image')).toBe(SITE + '/og-image.png');
      expect(meta(html, 'name', 'twitter:card')).toBe('summary_large_image');
      expect(meta(html, 'property', 'og:locale')).toBe('zh_TW');
      // Nothing personal but the name.
      expect(html).not.toContain('gino@evenly.test');
      // The app itself, with the script that moves the address to #/i/<code>.
      expect(html).toContain('id="root"');
      expect(html).toContain("'#/i/' + m[2]");
    }
  });

  it('answers as the app\'s own page does: no shared cache, no frames, https only', async () => {
    const { code } = await myInvite('gino');
    const r = await crawler('/i/' + code);
    expect(r.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(r.headers.get('X-Frame-Options')).toBe('DENY');
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(r.headers.get('ETag')).toBeNull();
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const plain = await worker.fetch(new Request(`http://split.test/i/${code}?openExternalBrowser=1`), env as never, ctx);
    expect(plain.status).toBe(301);
    expect(plain.headers.get('Location')).toBe(`https://split.test/i/${code}?openExternalBrowser=1`);
  });

  it('speaks the inviter\'s language and escapes the name', async () => {
    db.exec('UPDATE users SET name = ? WHERE id = ?', 'Abbie <b>"&\'', 'abbie');
    const { code } = await myInvite('abbie');
    const html = (await crawler('/i/' + code)).text;
    expect(meta(html, 'property', 'og:title')).toBe('Abbie &lt;b&gt;&quot;&amp;&#39; invited you to split costs on Gino&#39;s Split Lab');
    expect(meta(html, 'property', 'og:locale')).toBe('en_US');
    expect(meta(html, 'property', 'og:locale:alternate')).toBe('zh_TW');
    expect(html).not.toContain('<b>"&');
    // A Chinese name takes no space before the Chinese words.
    const kai = (await myInvite('kai')).code;
    expect(meta((await crawler('/i/' + kai)).text, 'property', 'og:title')).toBe('佳穎邀請你一起用吉諾分帳所分帳');
  });

  it('a code that does not work keeps the app\'s own preview, and the app says so', async () => {
    const r = await crawler('/i/NoSuchCode123456?openExternalBrowser=1');
    expect(r.status).toBe(200);
    expect(meta(r.text, 'property', 'og:title')).toBe("吉諾分帳所 Gino's Split Lab");
    expect(meta(r.text, 'property', 'og:url')).toBe('https://split.ginochang.com/');
    expect(r.text).toBe(INDEX_HTML);
  });

  it('takes a trailing slash, and HEAD answers without a body', async () => {
    const { code } = await myInvite('gino');
    expect(meta((await crawler(`/i/${code}/`)).text, 'property', 'og:title')).toBe('Gino 邀請你一起用吉諾分帳所分帳');
    const head = await call(null, 'HEAD', '/i/' + code);
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(head.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('renews the session cookies on a page load, as "/" does', async () => {
    const { code } = await myInvite('gino');
    const token = await createSession(db.d1, 'abbie', 'test');
    const r = await call(null, 'GET', '/i/' + code, { headers: { Cookie: `__Host-evenly_session=${token}; __Host-evenly_user=abbie` } });
    expect(r.status).toBe(200);
    const cookies = r.headers.getSetCookie();
    expect(cookies.some(c => c.startsWith('__Host-evenly_session=' + token) && /Max-Age=31536000/i.test(c))).toBe(true);
  });

  it('is counted per IP: past the limit the page still loads, with the app\'s own preview', async () => {
    const { code } = await myInvite('gino');
    for (let i = 0; i < INVITE_PAGE_PER_15M; i++) {
      expect(meta((await crawler('/i/' + code, FACEBOOK, '192.0.2.50')).text, 'property', 'og:title')).toBe('Gino 邀請你一起用吉諾分帳所分帳');
    }
    const over = await crawler('/i/' + code, FACEBOOK, '192.0.2.50');
    expect(over.status).toBe(200);
    expect(meta(over.text, 'property', 'og:title')).toBe("吉諾分帳所 Gino's Split Lab");
    expect(meta((await crawler('/i/' + code, FACEBOOK, '192.0.2.51')).text, 'property', 'og:title')).toBe('Gino 邀請你一起用吉諾分帳所分帳');
  });

  it('carries the generic preview on every other page of the app, with absolute URLs', async () => {
    const r = await call(null, 'GET', '/', { headers: { 'User-Agent': FACEBOOK } });
    expect(r.status).toBe(200);
    for (const key of ['og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt', 'og:site_name']) expect(meta(r.text, 'property', key), key).toBeTruthy();
    expect(meta(r.text, 'property', 'og:image')).toMatch(/^https:\/\/split\.ginochang\.com\/og-image\.png$/);
    expect(meta(r.text, 'name', 'twitter:card')).toBe('summary_large_image');
  });
});

// ---------- index.html's first script ----------

describe('index.html\'s first script', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(INDEX_HTML)![1];

  /** Run it as the browser would at this address; the address it moves to, or null. */
  function land(pathname: string, search = ''): string | null {
    let moved: string | null = null;
    const history = { replaceState: (_s: unknown, _t: string, url: string) => (moved = url) };
    new Function('location', 'history', script)({ pathname, search }, history);
    return moved;
  }

  it('comes before anything that names an address', () => {
    expect(INDEX_HTML.indexOf('<script>')).toBeLessThan(INDEX_HTML.indexOf('<link'));
    expect(INDEX_HTML.indexOf('<script>')).toBeLessThan(INDEX_HTML.indexOf('<meta name="viewport"'));
  });

  it('moves /i/<code> to #/i/<code> at the app\'s base, keeping the query', () => {
    expect(land('/i/AbCdEfGh12345678', '?openExternalBrowser=1')).toBe('/?openExternalBrowser=1#/i/AbCdEfGh12345678');
    expect(land('/i/AbCdEfGh12345678/')).toBe('/#/i/AbCdEfGh12345678');
    expect(land('/evenly/i/AbCdEfGh12345678')).toBe('/evenly/#/i/AbCdEfGh12345678');
  });

  it('leaves every other address alone', () => {
    for (const p of ['/', '/index.html', '/i/', '/i/abc/def', '/join/AbC123', '/privacy/', '/iX/AbCdEfGh12345678']) expect(land(p), p).toBeNull();
  });
});
