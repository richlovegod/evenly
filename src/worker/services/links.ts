// Linking an Apple ID or a Google account to a signed-in account (我的 > 登入方式; docs/SPEC.md
// section 3, Linking from 我的). Two parts:
// - Pending links. A link that came back through a browser callback (the web's Apple and Google
//   link=1, the iPhone's Google ticket) does not link there: the callback keeps the provider
//   account it verified here, for the account and the session that started the link, and the
//   client asks the person to confirm it (GET, POST and DELETE /api/me/links/pending/<id>, in
//   routes/me.ts). A leaked consent URL plus one tap of the victim then links nothing the victim
//   did not see and accept. 10 minutes, once, keyed by the SHA-256 of the id the client gets.
// - linkProvider: the link itself, which may move the provider account off an empty account (one
//   Hide My Email made a moment ago, say) and delete that account, in one batch.

import { isUniqueViolation } from '../db';
import type { Env } from '../env';
import { nowISO, randomToken, sha256Hex } from '../http';
import { settleGrant } from './apple';

export type Provider = 'apple' | 'google';

/** How long a pending link waits for the person's answer. */
export const PENDING_LINK_TTL_SEC = 600;

/** A provider account a callback verified, waiting for the confirmation. */
export interface PendingLink {
  provider: Provider;
  sub: string;
  /** The provider account's email as the provider gave it (a relay address included), or null. */
  email: string | null;
  /** Apple: the client its grant was issued to, and the grant. */
  clientId: string | null;
  refreshToken: string | null;
}

export interface PendingLinkRow extends PendingLink {
  userId: string;
  expiresAt: string;
}

interface Row {
  user_id: string;
  provider: string;
  sub: string;
  email: string | null;
  client_id: string | null;
  refresh_token: string | null;
  expires_at: string;
}

function fromRow(r: Row): PendingLinkRow {
  return {
    userId: r.user_id,
    provider: r.provider === 'apple' ? 'apple' : 'google',
    sub: r.sub,
    email: r.email,
    clientId: r.client_id,
    refreshToken: r.refresh_token,
    expiresAt: r.expires_at,
  };
}

/** Keep a verified provider account for the account and session that started the link; the id goes to the client. */
export async function createPendingLink(db: D1Database, o: { userId: string; sessionId: string; link: PendingLink }): Promise<string> {
  const id = randomToken(32);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO pending_links (id, user_id, session_id, provider, sub, email, client_id, refresh_token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256Hex(id), o.userId, o.sessionId, o.link.provider, o.link.sub, o.link.email ? o.link.email.slice(0, 320) : null,
      o.link.clientId, o.link.refreshToken, new Date(now + PENDING_LINK_TTL_SEC * 1000).toISOString(), new Date(now).toISOString(),
    )
    .run();
  return id;
}

const ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** This session's pending link `id`, or null for one that is unknown, used, expired or another session's. */
export async function readPendingLink(db: D1Database, id: string, sessionId: string): Promise<PendingLinkRow | null> {
  if (!ID_RE.test(id)) return null;
  const row = await db
    .prepare('SELECT * FROM pending_links WHERE id = ? AND session_id = ? AND expires_at > ?')
    .bind(await sha256Hex(id), sessionId, nowISO())
    .first<Row>();
  return row ? fromRow(row) : null;
}

/** Take this session's pending link `id` (once), or null as readPendingLink. */
export async function takePendingLink(db: D1Database, id: string, sessionId: string): Promise<PendingLinkRow | null> {
  if (!ID_RE.test(id)) return null;
  const row = await db
    .prepare('DELETE FROM pending_links WHERE id = ? AND session_id = ? AND expires_at > ? RETURNING *')
    .bind(await sha256Hex(id), sessionId, nowISO())
    .first<Row>();
  return row ? fromRow(row) : null;
}

/** Expired Apple links settled a daily run at most (each a D1 read, maybe a write, and a request to Apple). */
export const PENDING_SETTLE_PER_RUN = 10;

/**
 * The daily job's part: expired pending Apple links whose grant no link took. Each grant is kept
 * for the account that has the Apple ID, if one does, else revoked (services/apple.ts settleGrant),
 * then its row goes. At most PENDING_SETTLE_PER_RUN a run; the rest wait for the next. Returns how
 * many it settled.
 */
export async function settleExpiredPendingLinks(env: Env, now: Date): Promise<number> {
  const rows = await env.DB
    .prepare('SELECT id, sub, client_id, refresh_token FROM pending_links WHERE expires_at < ? AND refresh_token IS NOT NULL LIMIT ?')
    .bind(now.toISOString(), PENDING_SETTLE_PER_RUN)
    .all<{ id: string; sub: string; client_id: string | null; refresh_token: string }>();
  let n = 0;
  for (const r of rows.results ?? []) {
    if (r.client_id) await settleGrant(env, { sub: r.sub, clientId: r.client_id, refreshToken: r.refresh_token });
    await env.DB.prepare('DELETE FROM pending_links WHERE id = ?').bind(r.id).run();
    n++;
  }
  return n;
}

/** Hide My Email's addresses, as stored (lowercase). */
const RELAY_LIKE = '%@privaterelay.appleid.com';

/**
 * The SQL test that the users row `users` is empty enough to give its provider account up, for a
 * link of `column` (?1 is the email the provider gives for that account): no password; no other
 * provider; an email that is none, a relay address or the provider's own; and no members rows at
 * all, so it was never in a group or a 1:1 ledger (no entries, comments or history anywhere).
 */
function emptyTest(column: 'google_sub' | 'apple_sub'): string {
  const other = column === 'apple_sub' ? 'google_sub' : 'apple_sub';
  return `users.pw_hash IS NULL AND users.${other} IS NULL
    AND (users.email IS NULL OR users.email LIKE '${RELAY_LIKE}' OR users.email = ?1)
    AND NOT EXISTS (SELECT 1 FROM members WHERE members.user_id = users.id)`;
}

/**
 * Link `sub` (`provider`) to `userId`, whatever its email; the email stays as it is. 'ok': it is
 * this account's now, or was already. 'moved': another account had it, an empty one (emptyTest),
 * so in one batch it gave the sub up (and, for Apple, its grants) and was deleted with its
 * sessions. 'taken': another account has it and is not empty. 'already_linked': this account has
 * a different one. 'gone': no such account. `providerEmail` is the email the provider gives for
 * the account being linked (normalized), or null.
 */
export async function linkProvider(
  db: D1Database,
  o: { userId: string; provider: Provider; sub: string; providerEmail: string | null },
): Promise<'ok' | 'moved' | 'taken' | 'already_linked' | 'gone'> {
  const column = o.provider === 'apple' ? 'apple_sub' : 'google_sub';
  const me = await db.prepare(`SELECT ${column} AS sub FROM users WHERE id = ?`).bind(o.userId).first<{ sub: string | null }>();
  if (!me) return 'gone';
  if (me.sub) return me.sub === o.sub ? 'ok' : 'already_linked';
  const holder = await db.prepare(`SELECT id FROM users WHERE ${column} = ?`).bind(o.sub).first<{ id: string }>();
  if (!holder) {
    try {
      const done = await db
        .prepare(`UPDATE users SET ${column} = ? WHERE id = ? AND ${column} IS NULL RETURNING id`)
        .bind(o.sub, o.userId)
        .first<{ id: string }>();
      return done ? 'ok' : 'already_linked';
    } catch (err) {
      // Another account took it a moment ago.
      if (isUniqueViolation(err, 'users.' + column)) return 'taken';
      throw err;
    }
  }
  if (holder.id === o.userId) return 'ok';
  // Another account has it. Moved only if that account is empty, checked inside the batch: the
  // first statement frees the sub only then (and only while this account still has none), so if
  // it does not, the second one breaks the unique index and the whole batch rolls back.
  const email = o.providerEmail ?? '';
  const mine = `EXISTS (SELECT 1 FROM users me WHERE me.id = ?3 AND me.${column} = ?2)`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE users SET ${column} = NULL WHERE users.id = ?4 AND users.${column} = ?2 AND ${emptyTest(column)}
         AND EXISTS (SELECT 1 FROM users me WHERE me.id = ?3 AND me.${column} IS NULL)`,
      )
      .bind(email, o.sub, o.userId, holder.id),
    db.prepare(`UPDATE users SET ${column} = ?1 WHERE id = ?2 AND ${column} IS NULL`).bind(o.sub, o.userId),
  ];
  if (o.provider === 'apple') {
    stmts.push(
      db
        .prepare(
          `INSERT INTO apple_grants (user_id, client_id, refresh_token, created_at)
           SELECT ?1, client_id, refresh_token, created_at FROM apple_grants
           WHERE user_id = ?2 AND EXISTS (SELECT 1 FROM users me WHERE me.id = ?1 AND me.apple_sub = ?3)
           ON CONFLICT(user_id, client_id) DO UPDATE SET refresh_token = excluded.refresh_token, created_at = excluded.created_at`,
        )
        .bind(o.userId, holder.id, o.sub),
    );
  }
  // The cascade takes the empty account's sessions, grants, codes, devices and photo with it.
  stmts.push(
    db
      .prepare(`DELETE FROM users WHERE users.id = ?4 AND users.${column} IS NULL AND ${emptyTest(column)} AND ${mine}`)
      .bind(email, o.sub, o.userId, holder.id),
  );
  try {
    const res = await db.batch(stmts);
    return (res[1]?.meta?.changes ?? 0) === 1 ? 'moved' : 'already_linked';
  } catch (err) {
    if (isUniqueViolation(err, 'users.' + column)) return 'taken';
    throw err;
  }
}
