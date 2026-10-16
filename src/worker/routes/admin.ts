// /api/admin: owner tools (emails in the OWNER_EMAILS secret). Everyone else gets 404.

import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser } from '../auth';
import { getUserByEmail } from '../db';
import type { AppEnv } from '../env';
import { fail, json, nowISO, randomToken, readJson, sha256Hex } from '../http';

export const adminRoutes = new Hono<AppEnv>();

const RESET_MINUTES = 30;

adminRoutes.use('*', requireUser);
adminRoutes.use('*', async (c, next) => {
  if (!c.get('user').isOwner) fail(404, 'not_found', 'Not found');
  await next();
});

const resetLinkSchema = z.object({ email: z.string().trim().min(1).max(320) });

/** A one-time, 30-minute link that lets the person set a new password (no email is ever sent). */
adminRoutes.post('/reset-link', async c => {
  const db = c.env.DB;
  const { email } = await readJson(c, resetLinkSchema);
  const user = await getUserByEmail(db, email);
  if (!user) fail(404, 'not_found', 'No account uses this email');
  const token = randomToken(32);
  const now = nowISO();
  const expiresAt = new Date(Date.now() + RESET_MINUTES * 60_000).toISOString();
  await db.batch([
    // Only the newest link works.
    db.prepare("DELETE FROM login_codes WHERE user_id = ? AND kind = 'reset' AND used_at IS NULL").bind(user.id),
    db
      .prepare("INSERT INTO login_codes (id, user_id, kind, expires_at, used_at, created_at) VALUES (?, ?, 'reset', ?, NULL, ?)")
      .bind(await sha256Hex(token), user.id, expiresAt, now),
  ]);
  const appUrl = (c.env.APP_URL || '').replace(/\/*$/, '/');
  return json(c, { url: appUrl + '#/reset/' + token, expiresAt });
});

adminRoutes.get('/stats', async c => {
  const row = await c.env.DB
    .prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM groups WHERE deleted_at IS NULL) AS groups,
              (SELECT COUNT(*) FROM expenses WHERE deleted_at IS NULL) AS expenses`,
    )
    .first<{ users: number; groups: number; expenses: number }>();
  return json(c, { users: row?.users ?? 0, groups: row?.groups ?? 0, expenses: row?.expenses ?? 0 });
});
