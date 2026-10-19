# Worker module contract (src/worker)

Already written (use, do not rewrite): `env.ts` (Env with the DB, ASSETS and AI bindings and the
vars, AppEnv, AuthUser with `via: 'bearer' | 'cookie'`, Ctx), `http.ts` (ApiError, fail, notFound,
forbidden, MAX_BODY_BYTES, readJson, json, nowISO, newId, randomToken, randomCode,
randomInviteCode, sha256Hex, uuidFrom, b64url, fromB64url, clientIp, deviceLabel), `db.ts` (row
types, mappers toUserDTO / toGroupDTO / toMemberDTO / toExpenseDTO / toLedgerEntry, getUser,
getUserByEmail, getGroupRow, getMembers, getMyMember, requireMember, getExpenseRows,
getExpenseRow, getCommentCounts, loadSnapshot, bumpVersionStmt, versionFromBatch, isOwnerEmail,
parseJSON). Shared math in `src/shared`. Hono 4 (`import { Hono } from 'hono'`), zod 3
(`import { z } from 'zod'`). D1: `c.env.DB`. Responses via `json(c, data, status?)`.

Each module below exports exactly these names (other files import them).

## index.ts (owner: W1; page loads and headers: A)
- `const app = new Hono<AppEnv>()`; CORS middleware for `/api/*` per SPEC section 6 (preflight
  204 with `Vary: Origin`; `X-Evenly-User` among the allowed headers; never
  `Access-Control-Allow-Credentials`). After the handler: `Vary: *` on every `/api` answer except
  GET and HEAD `/api/fx` and `/api/users/:userId/avatar` (`AVATAR_PATH`; `Vary: Origin`), and
  `Cache-Control: no-store` unless the route set one.
- Body gate: a `Content-Length` over `MAX_BODY_BYTES` (256 KB) is 413 `payload_too_large`;
  `/api/receipts/scan` allows `RECEIPT_MAX_BYTES` and `/api/me/avatar` `AVATAR_MAX_BODY`, and both
  check their body themselves.
- `app.onError`: ApiError -> `{error:{code,message,details}}` with its status (a 429 with a numeric
  `details.retryAfter` also gets `Retry-After`); ZodError -> 400 `validation`; anything else -> 500
  `server_error` (log with console.error, generic message).
- `app.notFound`, for a path with no route and no file (wrangler.toml
  `not_found_handling = "none"`): a GET or HEAD outside `/api` that opens a page
  (`Sec-Fetch-Mode: navigate`, or an `Accept` with `text/html`) -> 302 to `/` with its query,
  `no-store`; anything else, a missing `/assets/` file included -> 404 `not_found` (JSON,
  `no-store`).
- Page loads (wrangler.toml `run_worker_first`): GET and HEAD of `/` and `/index.html`. Plain http
  -> 301 to https (127.0.0.1 and localhost excepted). A top-level load (`Sec-Fetch-Mode` absent, or
  `navigate` with `Sec-Fetch-Dest` absent or `document`) runs `renewPageCookies` (a failure is
  logged and the page still loads); a fetch of `/` or a frame does not. Then `env.ASSETS.fetch` with
  `Cache-Control: private, no-cache`, nosniff, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY`, HSTS on https, and the Set-Cookie lines.
- Mounts, in this order: `GET /api/health`, the page loads, `app.route('/api/auth', authRoutes)`,
  `app.route('/api/admin', adminRoutes)`, `app.route('/api', fxRoutes)`,
  `app.route('/api', groupRoutes)`, `app.route('/api', meRoutes)`,
  `app.route('/api', expenseRoutes)`, `app.route('/api', pushRoutes)`,
  `app.route('/api', receiptRoutes)`, `app.route('/api', avatarRoutes)`. Modules mounted at `/api`
  attach `requireUser` per route, never with `use('*', ...)`.
- `export default { fetch: app.fetch, scheduled }`: `scheduled(controller, env, ctx)` runs
  `ctx.waitUntil(runPushSender(env))` when `controller.cron` is `* * * * *` (every minute,
  production only) and `ctx.waitUntil(runDaily(env))` otherwise (`0 9 * * *`). Staging has no
  cron; its tests run the sender with POST /api/push/run.

## auth.ts (owner: W1; session cookies: A)
- `hashPassword(pw: string): Promise<string>` -> `pbkdf2-sha256$4000$<salt>$<hash>` (`pw` is the
  key the browser derived with 210,000 iterations; `PBKDF2_ITERATIONS` stays light for the 10 ms
  CPU limit).
- `verifyPassword(pw: string, stored: string): Promise<boolean>` (constant-time compare; the
  iteration count comes from the stored hash, at most `PBKDF2_MAX_ITERATIONS`, 100,000).
- `createSession(db: D1Database, userId: string, label: string): Promise<string>` returns the token.
- `requireUser`: Hono middleware. An `Authorization` header is the only thing read when present
  (`via: 'bearer'`); otherwise the session cookie (`via: 'cookie'`): a malformed or dead one clears
  both cookies and counts as signed out, a method other than GET, HEAD and OPTIONS that is not
  `sameOrigin` is 403 `forbidden`, and an `X-Evenly-User` naming another account is 401
  `session_changed`. Looks up `sessions` by SHA-256, checks expiry, slides `last_used_at` and
  `expires_at` at most hourly (after the response, `waitUntil`), re-sends both cookies only when the
  marker does not name the session's account, sets `c.set('user', AuthUser)`; 401 `unauthorized`
  otherwise. `optionalUser`: same, but a missing or dead session is not an error (the cookie checks
  still apply).
- Session cookies (SPEC section 3): `SESSION_COOKIE` and `USER_COOKIE` (`evenly_session`,
  `evenly_user`; hono/cookie adds `__Host-` with `prefix: 'host'`), `sameOrigin(c)`
  (`Sec-Fetch-Site: same-origin`, else `Origin` equal to the request URL's origin),
  `setSessionCookies(c, token, userId)`, `clearSessionCookies(c)`, `cookieSessionId(c)` (SHA-256 of
  the cookie's token, live or not), `bearerToken(c)`, `liveCookieSession(c)` (signup's 409 check),
  `startSession(c, userId, label)` (createSession, plus, for a same-origin request, both cookies
  and deleting the session the browser's cookie held before; used by signup, login, link and
  reset), `renewPageCookies(c)` (page loads only: both cookies for a fresh year and the session
  slid; a dead or malformed cookie, or a marker alone, is cleared).
- `rateLimit(db: D1Database, key: string, limit: number, windowSec: number): Promise<void>` throws
  429 `rate_limited` (`details.retryAfter`) when over (`rate_limits` table, upsert with RETURNING).
  Also `limitFrom(raw, fallback)` (env overrides), `ipKey(ip)` (IPv6 by /64), `normalizeEmail`.
- `validPassword(pw: string): boolean` (8 to 200 characters, not only spaces).

## routes/auth.ts (owner: W1) exports `authRoutes`
signup, login, logout, sessions (list, revoke), link-code, link, reset (GET for the link's email,
POST), and `POST /cookie` (puts a Bearer session into the cookies, no new row). Sign-ins go
through `startSession`; signup checks `liveCookieSession` first (409 `already_signed_in`, before
the rate limit); logout and revoking a session clear the cookies when they hold the session that
ended (`cookieSessionId`). See SPEC sections 3 and 6.

## routes/admin.ts (owner: W1) exports `adminRoutes`
`requireUser` + owner check (`isOwnerEmail(env, user.email)`, else 404). reset-link, stats, users,
users/:id.

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

## services/activity.ts (owner: W2; push_at: B)
- `activityStmt(db: D1Database, a: { groupId: string; userId: string | null; memberId: string | null; type: ActivityType; expenseId?: string | null; data: ActivityData; now: string }): D1PreparedStatement`
  (and `activityStmtWhere(db, a, condition, params)`, the same INSERT guarded by a condition). Both
  write `push_at` from `pushAtFor(type, data, now): string | null` (`now` for the types that may
  notify, SPEC section 5; else null), so no call site and no batch changes.
- `entryActivityData(e: { kind; description; amount; currency; fxRate; payers; shares }, groupCurrency: string): ActivityData`
  (description, amount, currency, kind, nets from `shared/balances.entryNet`, groupCurrency).
- `toActivityDTO(row: ActivityRow & { group_name: string; group_emoji: string; group_type: string; actor_name: string | null }): ActivityDTO`

## routes/groups.ts (owner: W2) exports `groupRoutes`
POST /groups, GET/PATCH/DELETE /groups/:gid, members (add, patch, delete, unlink, claim-link),
invite reset, GET/POST /join/:code, GET/POST /claim/:token, POST /friends. GET /groups/:gid calls
`materializeDue(db, { groupId, today: todayUTC() })` first, then `loadSnapshot`, ETag = `"<version>"`.
Currency change: `getUsdRates(db, todayUTC())` + `rateToBase` to re-base every entry: new fxRate =
old fxRate x rate(oldBase -> newBase) (1 when the entry currency equals the new base), in one batch.
Also exports `etagMatches(header, etag)` (If-None-Match, also used by routes/avatars.ts),
`MAX_ACTIVE_MEMBERS`, `MAX_GROUPS_PER_USER` and `MAX_LINKS_PER_DAY` (30), which the
module's own `limitLinks(db, userId, n)` applies: it counts the accounts linked by email in POST
/groups, POST /groups/:gid/members and POST /friends (key `link-account:<uid>`, fixed daily window)
and refuses past the limit with 429 `rate_limited`, `details.scope: 'links'` (SPEC section 6).

## routes/me.ts (owner: W2) exports `meRoutes`
GET/PATCH/DELETE /me, POST /me/credentials, GET /me/export, GET /activity, POST /activity/seen.
GET /me builds MeDTO from `ensureSummary` of each of my groups (one query for my memberships,
one for all members of those groups, one for the groups). DELETE /me deletes the profile photo
with the account and clears both session cookies when the request's cookie holds the caller's
session. GET /me/export adds `user.avatarImage`, the photo as a data URL (`avatarDataUrl` from
routes/avatars.ts), or null.

## routes/avatars.ts exports `avatarRoutes`, `AVATAR_MAX_BYTES`, `AVATAR_MAX_BODY`, `AVATAR_PER_DAY`, `AVATAR_PATH`
PUT and DELETE /me/avatar and GET /users/:userId/avatar, each with `requireUser` on the route
(SPEC section 6, Profile photo). PUT reads the body itself (Content-Length and text length at most
`AVATAR_MAX_BODY`, 401,024), `JSON.parse` once, the type by `startsWith` on the data URL and the
magic bytes on the decoded image, at most `AVATAR_MAX_BYTES` (150,000); every refusal is 400
`bad_request` with `details: {fields: ['image']}`. Then the limit (`avatar:<uid>`, 30 in a fixed
24-hour window) and, when the version changed, one batch: the `avatars` upsert, `users.avatar`
and `updated_at`, and `touchUserGroupsStmt` (as PATCH /me does for a name). DELETE does the same
with the row deleted and `users.avatar` NULL, only when there was a photo. GET is one query: the
photo when the requester is the person or an active member of a live group in which the person
has a member row; anything else, a stale `?v=` included, is one 404. Also `blobBytes(v)` (a D1
BLOB, an array of byte values, as bytes) and `avatarDataUrl(mime, data)`.

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
  and rate_limits rows older than a day. Deleting a session also deletes its push subscriptions and
  their kept messages (cascade).

## routes/push.ts (owner: B) exports `pushRoutes`
GET /push/status, PUT and DELETE /push/subscription, PUT /push/prefs, POST /push/test and POST
/push/run (SPEC section 6), each with `requireUser` on the route. Also `MAX_SUBSCRIPTIONS` (10),
`ENDPOINT_MAX` (1024), and the subscription checks `endpointProblem(endpoint)` and
`publicKeyBytes(s)` (for tests). /push/test sends through `pushMessageFor` and `deliverPushes`
(rate limit key `push-test:<uid>`, 5 an hour); /push/run calls `runPushSender`.

## services/push.ts (owner: B)
- `runPushSender(env: Env, now?: Date): Promise<PushRunResult>`
  (`{groups, sent, removed, failed}`), for the minutely cron and POST /api/push/run. Never throws
  (it runs inside `ctx.waitUntil`); its log line has counts only. One run:
  1. One `db.batch` to start: clear the due rows of groups nobody can hear; delete the kept
     messages that can no longer go (a day old, or their device moved to another account or lost
     its session), so they never use the budget; take the next kept messages out of `push_pending`
     (rank, then arrival; the whole budget, or `ceil(budget / 2)` when a group is due; `DELETE ...
     RETURNING` in the same transaction that reads their devices, so two runs never send one
     twice); and read up to 20 due groups, taking turns by the account that wrote each group's
     oldest pending row, each with the number of devices that can hear it (counted up to
     `budget + 1`).
  2. `claimGroup(db, gid, holdCutoff, nowIso)` per due group, at most `min(10, 50 - 6 - budget)`,
     one `db.batch` each: the stored payers and shares of the pending creates (from
     `idx_activity_push`, then each entry by its key), the claim
     (`UPDATE activity SET push_at = NULL ... RETURNING`, rows older than the hold), the group, its
     members with `users.locale` and `notify_prefs`, and their subscriptions on live sessions, each
     person's device in use first (its session's `last_used_at`). While the take left kept
     messages in `push_pending`, a group that more devices can hear than the budget is passed over
     without a claim.
  3. `groupMessages(claimed, nowMs): Outgoing[]` (pure): merge per entry, recipients, prefs, one
     `pushNotice` per person, one message per device, sorted by device rank.
  4. A group that does not fit in what is left: when the take emptied `push_pending`, what fits
     goes, the rest is written to `push_pending` (one statement per person, before the sends) and
     the run claims nothing more; otherwise the group waits whole and the next groups may still
     go. A run whose take left kept messages ends, before the sends, with one `db.batch` that gives
     those groups' rows their `push_at` back (it is always `created_at`) and takes more kept
     messages for the room left. So `push_pending` holds the rest of one group at most.
  5. `deliverPushes(db, vapid, list, nowMs?)`: every send at once, then one batch for the answers:
     2xx sets `last_ok_at` and `failures = 0`, 404 or 410 deletes the subscription, anything else
     (a timeout or no answer included) adds a failure and deletes the row at `FAILURES_MAX` (5).
  Without usable VAPID keys a run only clears rows older than a day.
- Also `parsePrefs(raw)` (anything but an explicit false is on),
  `pushMessageFor(sub, payload, urgency)`, `holdSeconds(raw)` (`PUSH_HOLD_SECONDS`: default 30, 0
  to 3600), `budgetOf(raw)` (`PUSH_MAX_PER_RUN`: default 12, 1 to 40), and the types `ClaimedRow`,
  `PushMemberRow`, `SubscriptionRow`, `ClaimedGroup`, `Outgoing`.
- Free-plan budgets, per invocation, the cron's included: 10 ms of CPU, 50 subrequests (every
  fetch and every D1 call; a batch is one call), 30 s of `waitUntil`. A run makes
  one D1 call to start, one per claimed group, at most one to keep the rest of a group or to end a
  run whose take left kept messages (never both: only a run whose take emptied `push_pending`
  keeps a rest), and one delivery batch, plus one fetch per message (10 s timeout each, all at
  once). So it sends at most `PUSH_MAX_PER_RUN` messages and claims at most
  `min(10, 50 - 6 - budget)` groups (6 kept for the start, keeping or ending, delivery and POST
  /api/push/run's own sign-in, with one to spare): at most 50 subrequests at any budget. Each
  message costs a new ECDH key pair, a few HMACs and one AES-GCM; measure CPU on staging (Workers
  Logs) before raising the budget.

## services/pushText.ts (owner: B)
- `pushNotice(group: PushGroup, items: readonly PushItem[], me: { memberId: string; locale: Locale }): PushNotice | null`
  (`{payload: PushPayload, urgency}`): the title is the group's emoji and name (兩人帳本 / Friend
  ledger for pair groups, the app name for a group without one; at most 100 characters); the body
  is one item's sentence and, for money, its effect line (你借入 ¥X / You borrowed ¥X, 你收到 / You
  received, ...), or a summary for several (「Abbie 新增了 3 筆費用」, joins listed by name, else
  the first item and 「還有 N 筆新動態」), each line at most 240 characters; the path is the entry for
  one expense or payment, else the group; tag `g:<gid>`; urgency `low` when every item is an import.
  Sentences and spacing as the feed writes them (`src/web/features/activity/activityText.ts`),
  amounts with `formatMoney` in the recipient's locale.
- `testNotice(locale)`: POST /api/push/test's notification (path `/account`, tag `test`).
- Types `PushItem` (expense, payment, join, add, create, import), `PushPerson`, `PushGroup`,
  `PushNotice`.

## services/webpush.ts (owner: B)
WebCrypto only, no dependency; tested against the RFC 8291 Appendix A example.
- `encryptPush(plaintext, keys, opts?): Promise<Uint8Array>`: RFC 8291 aes128gcm, one record (rs
  4096, no padding), a new ECDH P-256 key pair and 16-byte salt per message; the plaintext at most
  `MAX_PLAINTEXT` (3993 bytes).
- `loadVapid(env): Promise<Vapid | null>`: `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` and the
  `VAPID_PRIVATE_JWK` secret, imported once per isolate; null when one is missing or the JWK is not
  the public key's private half (logs fixed messages only: a parse error could quote the secret).
- `vapidAuthorization(vapid, endpoint, nowMs?)`: `vapid t=<ES256 JWT>, k=<public key>`; the JWT
  (aud the push service origin, exp 12 hours, sub `VAPID_SUBJECT`) is cached per key and audience
  and renewed when under an hour is left.
- `sendPush(vapid, message, nowMs?): Promise<number>`: POST with `Content-Encoding: aes128gcm`,
  `TTL: 86400` (`PUSH_TTL_SECONDS`), `Urgency: normal` or `low`, `redirect: 'manual'`, a 10 s
  timeout; returns the HTTP status, 0 for no answer.
- Types `PushKeys`, `PushMessage`, `Vapid`, `EncryptOptions`.

## routes/receipts.ts (owner: D) exports `receiptRoutes`, `RECEIPT_MAX_BYTES`
`POST /receipts/scan` with `requireUser` on the route. Reads the body itself (Content-Length and
text length at most `RECEIPT_MAX_BYTES`, 3 MiB), `JSON.parse` once, zod for types and lengths; the
image prefix is checked with `startsWith`, never a regex over the base64. `?model=` is the owner's
only, in every environment (403 `forbidden` for anyone else, never a silent swap to the default).
Limit keys `receipt:user:<uid>:<YYYY-MM-DD>` and `receipt:app:<YYYY-MM-DD>` (86,400 s windows;
`RECEIPT_PER_DAY` default 30, `RECEIPT_GLOBAL_PER_DAY` default 300). Then `runReceiptModel` and
`normalizeReceipt`; a scan that read nothing (no total, no items, no store name) is 502
`scan_failed` with `reason: 'unreadable'`.

## services/receipt.ts (owner: D)
- `DEFAULT_RECEIPT_MODEL` (`@cf/google/gemma-4-26b-a4b-it`), `RECEIPT_MODELS` (also
  `@cf/qwen/qwen3.8-27b`, `@cf/meta/llama-4-scout-17b-16e-instruct`), `RECEIPT_MAX_TOKENS` (1500),
  `RECEIPT_TIMEOUT_MS` (55 s; the app gives up at 60 s), `RECEIPT_SCHEMA`, `RECEIPT_SYSTEM_PROMPT`,
  `receiptUserText(ctx)`.
- `receiptRequest(model, image, {today, hint})`: Gemma 4 and Qwen 3.8 get
  `response_format: {type: 'json_schema', json_schema: {name: 'receipt', schema, strict: true}}`
  and `chat_template_kwargs: {enable_thinking: false}` (Qwen also `reasoning_effort: 'low'`);
  Llama 4 Scout gets `json_schema` set to the schema itself. Messages: the system prompt, then a
  user message with the image (data URL) first and then the text
  `Today is <date>. Currency hint: <code>.`; `temperature: 0`.
- `runReceiptModel(ai, model, image, ctx, timeoutMs?)`: one call. Error 3036 (or "daily free
  allocation") is 429 `rate_limited` with `scope: 'ai'`; any other failure, the timeout or an answer
  without a JSON object is 502 `scan_failed` (`reason` `model` or `timeout`). The log names only the
  Workers AI code or the error name.
- `readAnswer(raw)`: `choices[0].message.content` (string or text parts), `response` (string or
  object), the REST `result` wrapper; JSON as is, inside code fences, or the outermost `{...}`.
- `normalizeReceipt(raw, {hint, locale, today})` (pure): SPEC section 7.
- Also exported for tests: `minorUnits`, `receiptDate`, `receiptCurrency`, `receiptCategory`,
  `lineKind`, `parseJsonText`, `aiFailure`, `neuronsFor` (the `usage` neurons from the token counts
  at each model's rates), `secondsToNextUtcDay`; types `AiRunner`, `ModelAnswer`,
  `ReceiptPromptContext`, `NormalizeContext`.
