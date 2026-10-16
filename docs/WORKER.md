# Worker module contract (src/worker)

Already written (use, do not rewrite): `env.ts` (Env, AppEnv, AuthUser, Ctx), `http.ts` (ApiError,
fail, notFound, forbidden, readJson, json, nowISO, newId, randomToken, randomCode,
randomInviteCode, sha256Hex, uuidFrom, b64url, fromB64url, clientIp, deviceLabel), `db.ts` (row
types, mappers toUserDTO / toGroupDTO / toMemberDTO / toExpenseDTO / toLedgerEntry, getUser,
getUserByEmail, getGroupRow, getMembers, getMyMember, requireMember, getExpenseRows,
getExpenseRow, getCommentCounts, loadSnapshot, bumpVersionStmt, versionFromBatch, isOwnerEmail,
parseJSON). Shared math in `src/shared`. Hono 4 (`import { Hono } from 'hono'`), zod 3
(`import { z } from 'zod'`). D1: `c.env.DB`. Responses via `json(c, data, status?)`.

Each module below exports exactly these names (other files import them).

## index.ts (owner: W1)
- `const app = new Hono<AppEnv>()`; CORS middleware for `/api/*` per SPEC section 6 (preflight
  204; `Vary: Origin`); `app.onError`: ApiError -> `{error:{code,message,details}}` with its status;
  anything else -> 500 `server_error` (log with console.error, generic message).
  `app.notFound` -> 404 `not_found`.
- Mounts: `app.route('/api/auth', authRoutes)`, `app.route('/api', meRoutes)`,
  `app.route('/api', groupRoutes)`, `app.route('/api', expenseRoutes)`, `app.route('/api', fxRoutes)`,
  `app.route('/api/admin', adminRoutes)`, `GET /api/health`.
- `export default { fetch: app.fetch, scheduled: (event, env, ctx) => ctx.waitUntil(runDaily(env)) }`.

## auth.ts (owner: W1)
- `hashPassword(pw: string): Promise<string>` -> `pbkdf2-sha256$100000$<salt>$<hash>`.
- `verifyPassword(pw: string, stored: string): Promise<boolean>` (constant-time compare).
- `createSession(db: D1Database, userId: string, label: string): Promise<string>` returns the token.
- `requireUser`: Hono middleware; reads `Authorization: Bearer`, looks up `sessions` by SHA-256,
  checks expiry, refreshes `last_used_at` at most hourly, sets `c.set('user', AuthUser)`; 401
  `unauthorized` otherwise. `optionalUser`: same but never fails.
- `rateLimit(db: D1Database, key: string, limit: number, windowSec: number): Promise<void>` throws
  429 `rate_limited` when over (`rate_limits` table, upsert with RETURNING).
- `validPassword(pw: string): boolean` (>= 8 chars, <= 200).

## routes/auth.ts (owner: W1) exports `authRoutes`
signup, login, logout, sessions (list, revoke), link-code, link, reset. See SPEC section 6.

## routes/admin.ts (owner: W1) exports `adminRoutes`
`requireUser` + owner check (`isOwnerEmail(env, user.email)`, else 404). reset-link, stats.

## services/fx.ts (owner: W1)
- `getUsdRates(db: D1Database, date: string): Promise<{ date: string; rates: Record<string, number>; source: string }>`
  rates[C] = units of C per 1 USD. Cache per day in `fx_cache`; a date in the future or today
  uses the latest available; fetch from the provider in docs/RESEARCH.md with a fallback; if every
  provider fails use the newest cached day; if nothing at all, throw 503 `fx_unavailable`.
- `rateToBase(usd: Record<string, number>, currency: string, base: string): number | null`
  = value of 1 `currency` in `base` = usd[base] / usd[currency] (1 when equal).

## routes/fx.ts (owner: W1) exports `fxRoutes`
`GET /fx?base=&date=` -> FxRes (rates for every currency the provider has, into `base`),
`Cache-Control: public, max-age=3600`.

## services/summary.ts (owner: W2)
- `refreshSummary(db: D1Database, groupId: string): Promise<GroupSummary | null>`: reads the group,
  members and entries, computes `shared/summary.computeGroupSummary`, stores it with
  `UPDATE groups SET summary = ? WHERE id = ? AND version = ?` (the version it read).
- `ensureSummary(db: D1Database, group: GroupRow): Promise<GroupSummary>`: returns the stored
  summary if `v === SUMMARY_VERSION && forVersion === group.version`, else refreshes.

## services/activity.ts (owner: W2)
- `activityStmt(db: D1Database, a: { groupId: string; userId: string | null; memberId: string | null; type: ActivityType; expenseId?: string | null; data: ActivityData; now: string }): D1PreparedStatement`
- `entryActivityData(e: { kind; description; amount; currency; fxRate; payers; shares }, groupCurrency: string): ActivityData`
  (description, amount, currency, kind, nets from `shared/balances.entryNet`, groupCurrency).
- `toActivityDTO(row: ActivityRow & { group_name: string; group_emoji: string; group_type: string; actor_name: string | null }): ActivityDTO`

## routes/groups.ts (owner: W2) exports `groupRoutes`
POST /groups, GET/PATCH/DELETE /groups/:gid, members (add, patch, delete, unlink, claim-link),
invite reset, GET/POST /join/:code, GET/POST /claim/:token, POST /friends. GET /groups/:gid calls
`materializeDue(db, { groupId, today: todayUTC() })` first, then `loadSnapshot`, ETag = `"<version>"`.
Currency change: `getUsdRates(db, todayUTC())` + `rateToBase` to re-base every entry: new fxRate =
old fxRate x rate(oldBase -> newBase) (1 when the entry currency equals the new base), in one batch.

## routes/me.ts (owner: W2) exports `meRoutes`
GET/PATCH/DELETE /me, POST /me/credentials, GET /me/export, GET /activity, POST /activity/seen.
GET /me builds MeDTO from `ensureSummary` of each of my groups (one query for my memberships,
one for all members of those groups, one for the groups).

## services/recurring.ts (owner: W3)
- `materializeDue(db: D1Database, opts: { groupId?: string; today: string }): Promise<number>`
  (returns how many copies were created; see SPEC section 7).

## routes/expenses.ts (owner: W3) exports `expenseRoutes`
PUT/DELETE /groups/:gid/expenses/:eid, POST .../restore, GET .../history, GET/POST .../comments,
DELETE /groups/:gid/comments/:cid, POST /groups/:gid/import. Uses `requireMember`,
`activityStmt`, `entryActivityData`, `bumpVersionStmt`, `refreshSummary`.

## services/cron.ts (owner: W3)
- `runDaily(env: Env): Promise<void>`: `materializeDue(db, { today })` for all groups,
  `getUsdRates(db, today)` to warm the cache, delete expired sessions, login codes, claim tokens
  and rate_limits rows older than a day.
