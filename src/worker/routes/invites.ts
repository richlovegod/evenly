// Friend invite links (docs/SPEC.md sections 4 and 6, Friend invites): every account's personal
// link, <APP_URL>i/<code>, made the first time it is asked for, good for anyone and never expiring
// until it is reset. Opening it shows who sent it, without signing in; signing in there makes the
// two friends: the 1:1 ledger they are both active in, else a new one by POST /friends's rules
// (groups.ts createPairGroup, both admins; assertGroupRoom; limitLinks, since the link's owner gets
// a notification), with a friend.join activity row that the push sender takes to the owner. The
// page the link opens is index.ts's, with the preview tags of services/invitePage.ts
// (invitePageHtml below). The placeholders the inviter already has are never guessed at: the
// per-member claim link covers that.

import { Hono } from 'hono';
import { INVITE_CODE_RE, inviteTemplates, inviteUrl } from '../../shared/invites';
import type { InviteAcceptRes, InviteInfoDTO, Locale, MyInviteDTO } from '../../shared/types';
import { ipKey, limitFrom, optionalUser, rateLimit, requireUser } from '../auth';
import { getUser, type UserRow } from '../db';
import type { AppEnv, AuthUser, Ctx, Env } from '../env';
import { ApiError, clientIp, fail, json, notFound, randomInviteCode } from '../http';
import { inviteTags, withTags } from '../services/invitePage';
import { blobBytes } from './avatars';
import { assertGroupRoom, createPairGroup, etagMatches, limitLinks, pairGroupOf } from './groups';

export const inviteRoutes = new Hono<AppEnv>();

/** Default of INVITE_IP_PER_15M: looks at an invite without signing in, per IP in 15 minutes. */
export const INVITE_IP_PER_15M = 30;
/** The invite's page (/i/<code>), per IP in 15 minutes; past it the page keeps the app's own tags. */
export const INVITE_PAGE_PER_15M = 120;
/** GET /api/invite/:code/avatar (index.ts keeps Vary: * off it, so browsers can keep the photo). */
export const INVITE_AVATAR_PATH = /^\/api\/invite\/[^/]+\/avatar$/;

/** A versioned photo address never changes its bytes: browsers keep it for a year. */
const IMMUTABLE = 'private, max-age=31536000, immutable';

function codeInvalid(): never {
  fail(400, 'code_invalid', 'This invite link does not work: it may have been reset');
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

/** The account a code belongs to now, or null (a code of the wrong shape is never looked up). */
export async function inviterByCode(db: D1Database, code: string): Promise<UserRow | null> {
  if (!INVITE_CODE_RE.test(code)) return null;
  return db.prepare('SELECT * FROM users WHERE invite_code = ?').bind(code).first<UserRow>();
}

/** ?locale=zh-TW|en for the messages, else the account's language. */
function localeOf(raw: string | undefined, user: UserRow): Locale {
  if (raw === 'en' || raw === 'zh-TW') return raw;
  return user.locale === 'en' ? 'en' : 'zh-TW';
}

function myInvite(env: Env, code: string, locale: Locale): MyInviteDTO {
  return { code, url: inviteUrl(env.APP_URL, code), templates: inviteTemplates(locale) };
}

async function currentUser(db: D1Database, id: string): Promise<UserRow> {
  return (await getUser(db, id)) ?? fail(401, 'unauthorized', 'Sign in first');
}

/**
 * Write a new random code for the account and return it: only when it has none (`onlyIfNone`, the
 * first GET; two first calls at once then get the same code), or in place of the old one (a reset).
 * A clash with another account's code (about 2^-95) draws again.
 */
async function writeCode(db: D1Database, userId: string, onlyIfNone: boolean): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const row = await db
        .prepare(`UPDATE users SET invite_code = ? WHERE id = ?${onlyIfNone ? ' AND invite_code IS NULL' : ''} RETURNING invite_code`)
        .bind(randomInviteCode(), userId)
        .first<{ invite_code: string }>();
      if (row?.invite_code) return row.invite_code;
      // Another request made the first one a moment ago, or the account is gone.
      const now = await db.prepare('SELECT invite_code FROM users WHERE id = ?').bind(userId).first<{ invite_code: string | null }>();
      if (now?.invite_code) return now.invite_code;
      fail(401, 'unauthorized', 'Sign in first');
    } catch (err) {
      if (err instanceof ApiError || !isUniqueViolation(err) || attempt >= 3) throw err;
    }
  }
}

// ---------- the inviter: my link ----------

/** My code (made now on the first call), the link to share and the messages in ?locale=. */
inviteRoutes.get('/me/invite', requireUser, async c => {
  const db = c.env.DB;
  const user = await currentUser(db, c.get('user').id);
  const code = user.invite_code ?? (await writeCode(db, user.id, true));
  return json(c, myInvite(c.env, code, localeOf(c.req.query('locale'), user)));
});

/** A new code in place of the old one, which stops working at once. Friends made with it stay friends. */
inviteRoutes.post('/me/invite/reset', requireUser, async c => {
  const db = c.env.DB;
  const user = await currentUser(db, c.get('user').id);
  const code = await writeCode(db, user.id, false);
  return json(c, myInvite(c.env, code, localeOf(c.req.query('locale'), user)));
});

// ---------- the person the link was sent to ----------

/**
 * Who sent the link, for the page it opens: the name, the color and the photo's version. Signed in,
 * also whether it is the caller's own link and their 1:1 ledger with its owner, if they have one.
 * Looks without a sign-in are counted per IP.
 */
inviteRoutes.get('/invite/:code', optionalUser, async c => {
  const db = c.env.DB;
  const viewer = c.get('user') as AuthUser | undefined;
  if (!viewer) await rateLimit(db, 'invite:ip:' + ipKey(clientIp(c)), limitFrom(c.env.INVITE_IP_PER_15M, INVITE_IP_PER_15M), 900);
  const inviter = (await inviterByCode(db, c.req.param('code'))) ?? codeInvalid();
  const self = !!viewer && viewer.id === inviter.id;
  const info: InviteInfoDTO = {
    inviter: { name: inviter.name, color: inviter.color, avatar: inviter.avatar ?? null },
    self,
    groupId: viewer && !self ? await pairGroupOf(db, viewer.id, inviter.id) : null,
  };
  return json(c, info);
});

/**
 * The inviter's photo for anyone holding the code (the page shows it before anyone signs in), as
 * GET /users/:userId/avatar answers it: with ?v= kept a year, without it the current photo. One
 * 404 for every refusal (no photo, a code that does not work, an old ?v=).
 */
inviteRoutes.get('/invite/:code/avatar', async c => {
  const code = c.req.param('code');
  const v = c.req.query('v');
  const row = INVITE_CODE_RE.test(code)
    ? await c.env.DB.prepare('SELECT a.mime, a.data, a.version FROM users u JOIN avatars a ON a.user_id = u.id WHERE u.invite_code = ?')
        .bind(code)
        .first<{ mime: string; data: unknown; version: string }>()
    : null;
  if (!row || (v !== undefined && v !== row.version)) notFound();
  const photo = row!;
  const etag = `"${photo.version}"`;
  c.header('ETag', etag);
  c.header('Cache-Control', v === undefined ? 'private, no-cache' : IMMUTABLE);
  if (etagMatches(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
  c.header('Content-Type', photo.mime);
  c.header('X-Content-Type-Options', 'nosniff');
  // Only the app's own pages (and the iOS app, which is no browser) show it, never another site's.
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  return c.body(blobBytes(photo.data));
});

/**
 * Accept: the 1:1 ledger the two are both active in (existed, nothing written), else a new one
 * with both as admins, its friend.join row naming the owner's member (their notification), after
 * the checks of POST /friends: room in both people's 200 groups, and the caller's daily email link
 * limit (the owner gets a notification, as an account linked by email does).
 */
inviteRoutes.post('/invite/:code', requireUser, async c => {
  const db = c.env.DB;
  const au = c.get('user');
  const inviter = (await inviterByCode(db, c.req.param('code'))) ?? codeInvalid();
  if (inviter.id === au.id) fail(400, 'own_invite', 'This is your own invite link');
  const existing = await pairGroupOf(db, au.id, inviter.id);
  if (existing) {
    const res: InviteAcceptRes = { groupId: existing, existed: true };
    return json(c, res);
  }
  const me = await currentUser(db, au.id);
  await assertGroupRoom(db, [{ id: me.id, label: 'You' }, { id: inviter.id, label: inviter.name }]);
  await limitLinks(db, me.id, 1);
  const groupId = await createPairGroup(db, {
    // The link's owner first: it is their ledger with a new friend, in their currency.
    first: { userId: inviter.id, name: inviter.name, color: inviter.color },
    second: { userId: me.id, name: me.name, color: me.color },
    currency: inviter.currency,
    createdBy: me.id,
    activity: { by: 'second', type: 'friend.join', about: 'first' },
  });
  const res: InviteAcceptRes = { groupId, existed: false };
  return json(c, res);
});

// ---------- the page the link opens ----------

/**
 * index.html for GET /i/<code> (index.ts): with the invite's preview tags when the code works,
 * else as it is (the app then says the link does not work). Counted per IP; past the limit, or if
 * the lookup fails, the page still loads with the app's own tags.
 */
export async function invitePageHtml(c: Ctx, html: string, code: string): Promise<string> {
  try {
    const db = c.env.DB;
    await rateLimit(db, 'invite-page:ip:' + ipKey(clientIp(c)), INVITE_PAGE_PER_15M, 900);
    const inviter = await inviterByCode(db, code);
    if (!inviter?.invite_code) return html;
    return withTags(html, inviteTags({ appUrl: c.env.APP_URL, url: inviteUrl(c.env.APP_URL, inviter.invite_code), name: inviter.name, locale: inviter.locale }));
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 429)) console.error('invite page: the preview tags failed', err);
    return html;
  }
}
