# Worker module contract (src/worker)

Already written (use, do not rewrite): `env.ts` (Env with the DB, ASSETS, AI and RECEIPTS bindings and the
vars, AppEnv, AuthUser with `via: 'bearer' | 'cookie'`, Ctx), `http.ts` (ApiError, fail, notFound,
forbidden, MAX_BODY_BYTES, readJson, json, nowISO, newId, randomToken, randomCode,
randomInviteCode, sha256Hex, uuidFrom, b64url, fromB64url, clientIp, deviceLabel), `db.ts` (row
types, mappers toUserDTO / toGroupDTO / toMemberDTO / toExpenseDTO / toReceiptDTO / toLedgerEntry,
`RECEIPT_COLUMNS` and `receiptColumnsStmt` (an expense's receipt photo metadata), getUser,
getUserByEmail, getUserByGoogleSub, getGroupRow, getMembers, getMyMember, requireMember, getExpenseRows,
getExpenseRow, getCommentCounts, loadSnapshot (takes `refunds`: the caller's client knows them,
else each refund comes in the legacy view), bumpVersionStmt, unarchiveStmt (in the batch of
every new entry: the group back on the lists of everyone who archived it but the author),
versionFromBatch, isOwnerEmail, parseJSON). Shared math in `src/shared`. Hono 4 (`import { Hono } from 'hono'`), zod 3
(`import { z } from 'zod'`). D1: `c.env.DB`. Responses via `json(c, data, status?)`.

Refunds (SPEC sections 2 and 6, Refunds and Compatibility) add `compat.ts`: `FEATURES_HEADER`
(`X-Evenly-Features`), `clientFeatures(header)`, `knowsRefunds(c)` (the header lists `refunds`),
`legacyRoles(refund)` and `legacyExpense(e)` (a refund as the expense with the same effect),
`expenseView(e, refunds)`, `snapshotView(s, refunds)`, `activityView(a, refunds)` and
`snapshotETag(version, refunds)` (`"12"` or `"12-legacy"`). Every answer that carries an entry or an
activity row goes through them: the snapshot answers, PUT, DELETE and restore, the 409 details, an
entry's history, `/api/activity` and the admin account detail; the export does not. Migration
`0011_refunds.sql` (`expenses.refund_of`), and `SUMMARY_VERSION` 2.

Email codes (SPEC section 3, Email codes) add these to `Env`: the vars `EMAIL_FROM` (production
and staging: "吉諾分帳所 <login@ginochang.com>"), `EMAIL_DEV_ECHO` (staging only, "1": test mode,
never honored in production), `EMAIL_IP_PER_HOUR` and `EMAIL_GLOBAL_PER_DAY` (overrides; staging
sets 1000 and 10), and the secret `RESEND_API_KEY` (`npx wrangler secret put RESEND_API_KEY`, with
`--env staging` for staging; production answers 503 `email_unavailable` without it, staging then
only echoes).

Receipt photos (SPEC section 6, Receipt photos) add the Workers KV binding `RECEIPTS`
(`[[kv_namespaces]]`: production `ec4c328ffc384a7998352105b332f46d`, staging
`aa5d755e73a6461e9e7119438c3af2c4` under `[[env.staging.kv_namespaces]]`, not inherited) and the
vars `RECEIPT_KV_WRITES_PER_DAY` and `RECEIPT_STORE_MAX_BYTES` (overrides of 900 and 800,000,000;
production sets 500 writes, staging 60 and 30,000,000, since the KV that Workers Paid includes,
1 GB stored and 1,000,000 writes a month, is the whole account's, and more is billed).
Without the binding the photo routes answer 503 (writes) and 404 (reads), and the cleanup does
nothing. Tests use an in-memory stand-in (tests/worker/receipt-photos.test.ts).

Sign in with Google (SPEC section 3, Google) adds to `Env`: the var `GOOGLE_CLIENT_ID` (production
and staging; "SET_ME" in `wrangler.toml` until the Google Cloud console has made the client, and
"SET_ME" counts as missing), the secret `GOOGLE_CLIENT_SECRET` (`npx wrangler secret put
GOOGLE_CLIENT_SECRET`, with `--env staging` for staging), and the override `GOOGLE_IP_PER_15M`
(starts and callbacks per IP in 15 minutes, default 20 each). Without the id or the secret,
`GET /api/auth/providers` says `google: false` and start and callback redirect to
`/?google_error=unavailable#/login`; nothing else changes. Migration `0007_google_sign_in.sql`
(`users.google_sub`). Tests stub fetch as Google's token endpoint and keys, with id_tokens signed
by a key pair made in the test (tests/worker/google-sign-in.test.ts).

The Google Cloud console (one project; staging may share production's client or have its own):
- Google Auth Platform > Branding (the OAuth consent screen): app name 吉諾分帳所 Gino's Split Lab,
  user support email gino@ginochang.com, the app logo (optional; a logo needs Google's brand
  verification), application home page https://split.ginochang.com/, privacy policy
  https://split.ginochang.com/privacy/, terms or support https://split.ginochang.com/support/,
  authorized domain `ginochang.com`, developer contact gino@ginochang.com. Audience: External,
  then Publish (Testing allows only the listed test users). Data access (scopes): `openid`,
  `.../auth/userinfo.email`, `.../auth/userinfo.profile`, all non-sensitive, so no verification
  review beyond the brand check.
- Clients > Create client, type Web application. Authorized JavaScript origins: none (the Worker
  runs the flow; no Google script on the page). Authorized redirect URIs, exactly:
  `https://split.ginochang.com/api/auth/google/callback`,
  `https://evenly-api-staging.richlovegod.workers.dev/api/auth/google/callback`, and, only for
  local wrangler dev, `http://127.0.0.1:8787/api/auth/google/callback`. Not
  `https://evenly-api.richlovegod.workers.dev/...`: the button is hidden there (only `APP_URL`'s
  origin offers it). The client id goes in `wrangler.toml` (`GOOGLE_CLIENT_ID` in `[vars]` and
  `[env.staging.vars]`), the secret in each environment's `GOOGLE_CLIENT_SECRET`.

Sign in with Apple (SPEC section 3, Apple) adds to `Env`: the vars `APPLE_SIGNIN_KEY_ID`,
`APPLE_TEAM_ID`, `APPLE_APP_ID` (the iPhone app's bundle id) and `APPLE_SERVICES_ID` (the web's
Services ID), all in `[vars]` and `[env.staging.vars]`, the secret `APPLE_SIGNIN_KEY` (the .p8), and
the override `APPLE_IP_PER_15M` (default 20). Without the key, `GET /api/auth/providers` says
`apple: false`, the web's start redirects to `/?apple_error=unavailable#/login` and `POST
/api/auth/apple` answers 503 `apple_unavailable`; nothing else changes. Migration
`0013_apple_sign_in.sql` (`users.apple_sub`, `apple_grants`, and `google_app_codes` for the iPhone
app's Google flow). Tests send Apple's endpoints to stand-ins (`setAppleEndpoints`) and stub fetch,
with identity tokens signed by an RSA pair and the Sign in with Apple key a P-256 pair, both made in
the test (tests/worker/apple-sign-in.test.ts).

Apple's portal (team 7XHV5223X7):
- The App ID `com.ginochang.evenly` has Sign In with Apple, as the primary App ID.
- The Services ID `com.ginochang.evenly.web` has Sign In with Apple, grouped with that App ID (so a
  person's `sub` is the same in the app and on the web), with the domains `split.ginochang.com` and
  `evenly-api-staging.richlovegod.workers.dev` and the return URLs, exactly,
  `https://split.ginochang.com/api/auth/apple/callback` and
  `https://evenly-api-staging.richlovegod.workers.dev/api/auth/apple/callback`.
- The key (Sign in with Apple only, primary App ID com.ginochang.evenly) is `APPLE_SIGNIN_KEY_ID`;
  its .p8 the `APPLE_SIGNIN_KEY` secret.
- Sign in with Apple for Email Communication lists `login@ginochang.com` and `ginochang.com` (the
  sender of `EMAIL_FROM`), so code emails reach Hide My Email addresses.

Friend invite links (SPEC sections 4 and 6, Friend invites) add the override `INVITE_IP_PER_15M`
to `Env` (looks at an invite without signing in, per IP in 15 minutes, default 30; staging sets
1000), migration `0008_friend_invites.sql` (`users.invite_code`), `"/i/*"` in `run_worker_first`
of both `[assets]` tables, and `public/og-image.png` (the 1200 x 630 link preview, made by
`scripts/make-icons.cjs`). Tests: tests/worker/friend-invites.test.ts (the routes, the page and its
tags on the real index.html, the limits) and the friend.join cases in push-sender.test.ts.

The iPhone app's notifications (SPEC sections 5 to 7, APNs) add to `Env` the vars `APNS_KEY_ID`
(`U47HW6ZSNN`), `APNS_TEAM_ID` (`7XHV5223X7`) and `APNS_TOPIC` (`com.ginochang.evenly`), the same in
`[vars]` and `[env.staging.vars]`, and the secret `APNS_AUTH_KEY`, Apple's .p8 file as it is
(`npx wrangler secret put APNS_AUTH_KEY [--env staging] < AuthKey_U47HW6ZSNN.p8`; one key, team
scoped, serves the sandbox and production). Without all four, `GET /api/push/status` says
`apns: false`, `PUT /api/push/apns` still stores tokens (for a bundle id equal to `APNS_TOPIC`),
and the sender leaves iPhones out. Migration `0012_apns.sql` (`apns_devices`, `apns_pending`).
Tests: tests/worker/apns.test.ts (the key, the provider token, the request, the answers, the
payload of each kind of notification), the iPhone cases in push-sender.test.ts and
push-routes.test.ts (the routes and the migration), with keys made in the tests and fetch stubbed.

Each module below exports exactly these names (other files import them).

## index.ts (owner: W1; page loads and headers: A)
- `const app = new Hono<AppEnv>()`; CORS middleware for `/api/*` per SPEC section 6 (preflight
  204 with `Vary: Origin`; `X-Evenly-User` among the allowed headers; never
  `Access-Control-Allow-Credentials`). After the handler: `Vary: *` on every `/api` answer except
  GET and HEAD `/api/fx`, `/api/users/:userId/avatar` (`AVATAR_PATH`),
  `/api/groups/:gid/expenses/:eid/receipt` (`RECEIPT_PHOTO_PATH`) and `/api/invite/:code/avatar`
  (`INVITE_AVATAR_PATH`) (`Vary: Origin`), and `Cache-Control: no-store` unless the route set one.
- Body gate: a `Content-Length` over `MAX_BODY_BYTES` (256 KB) is 413 `payload_too_large`;
  `/api/receipts/scan` allows `RECEIPT_MAX_BYTES`, `/api/me/avatar` `AVATAR_MAX_BODY` and
  `RECEIPT_PHOTO_PATH` `RECEIPT_PHOTO_MAX_BYTES` (600,000), and each checks its body itself.
- `app.onError`: ApiError -> `{error:{code,message,details}}` with its status (a 429 or 503 with a
  numeric `details.retryAfter` also gets `Retry-After`: `email_quota`, `receipts_quota`); ZodError -> 400 `validation`; anything else -> 500
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
  `X-Frame-Options: DENY`, HSTS on https, and the Set-Cookie lines (`appPage(c, rewrite?)`).
- Friend invite pages (`run_worker_first`: `"/i/*"`): GET and HEAD of `/i/:code` and `/i/:code/`,
  the same `appPage` with index.html itself fetched plainly from `ASSETS` (`/`, no conditional
  headers: the answer is another page, so it has no ETag) and, for a GET,
  `invitePageHtml(c, html, code)` (routes/invites.ts) writing the invite's preview tags in;
  `Content-Type: text/html; charset=utf-8`.
- Mounts, in this order: `GET /api/health`, the page loads, the friend invite pages,
  `app.route('/api/auth', authRoutes)`, `app.route('/api/admin', adminRoutes)`,
  `app.route('/api', fxRoutes)`, `app.route('/api', groupRoutes)`, `app.route('/api', inviteRoutes)`,
  `app.route('/api', meRoutes)`,
  `app.route('/api', expenseRoutes)`, `app.route('/api', pushRoutes)`,
  `app.route('/api', receiptRoutes)`, `app.route('/api', avatarRoutes)`,
  `app.route('/api', receiptPhotoRoutes)`. Modules mounted at `/api`
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
  reset), `startCookieSession(c, userId, label)` (that same-origin half on its own, for the
  Google callback, a cross-site page load whose flow cookie stands in for the check),
  `renewPageCookies(c)` (page loads only: both cookies for a fresh year and the session
  slid; a dead or malformed cookie, or a marker alone, is cleared).
- `rateLimit(db: D1Database, key: string, limit: number, windowSec: number): Promise<void>` throws
  429 `rate_limited` (`details.retryAfter`) when over (`rate_limits` table, upsert with RETURNING).
  For limits on failures only (wrong email codes): `checkLimit(db, key, limit)` refuses (429) once
  the key holds `limit` in a window that has not ended, without counting, and
  `countFailure(db, key, windowSec)` counts one. For limits on an amount (the receipt scans'
  neurons): `takeAmount(db, key, amount, limit, windowSec)` adds `amount` only when the window's
  count stays at most `limit`, in one upsert (`ON CONFLICT ... DO UPDATE ... WHERE`), and returns
  false with nothing written otherwise; `addToCount(db, key, amount)` corrects the count by any
  amount, negative included. Also `limitFrom(raw, fallback)` (env overrides),
  `ipKey(ip)` (IPv6 by /64), `normalizeEmail`.
- `validPassword(pw: string): boolean` (8 to 200 characters, not only spaces).

## routes/auth.ts (owner: W1) exports `authRoutes`
signup, login, `POST /email/start` and `POST /email/verify` (an email code: sign in to the account
that has the address, or make one with a name; services/emailCodes.ts), logout, sessions (list,
revoke), link-code, link, reset (GET for the link's email, POST), and `POST /cookie` (puts a Bearer
session into the cookies, no new row). Sign-ins go through `startSession`; signup checks
`liveCookieSession` first (409 `already_signed_in`, before the rate limit), an email code does not
(it is a sign-in); logout and revoking a session clear the cookies when they hold the session that
ended (`cookieSessionId`). Signup takes a name only: an `email` or a `password` that holds anything
(missing, null and blank text do not) is 400 `email_requires_code` after the rate limit, and
nothing is written, so no account ever gets an email nobody confirmed. Signup and an email code
make the account with the same `newUserRow` and `insertUser` (locale and currency from the
request, leniently). See SPEC sections 3 and 6.

Sign in with Google (services/google.ts): `GET /providers` (`{google: googleAvailable(c)}`), and
two page-load routes wrapped by `googlePage`, which turns every failure into a 302 to
`/?google_error=<GoogleErrorCode>#/login` (a `GoogleError` keeps its code and logs its detail with
console.warn; a 429 from `rateLimit` is `rate_limited`; anything else is `server`, logged by error
name only). `GET /google/start`: `googleAvailable`, `startedHere` (Sec-Fetch-Site same-origin, or
without it a same-origin Referer), the per-IP limit (`google-start:ip:<ipKey>`), then the flow
cookie (`FLOW_COOKIE` with `prefix: 'host'`, HttpOnly, Lax, `FLOW_TTL_SEC`) and a 302 to
`authUrl`. `GET /google/callback`: reads and deletes the flow cookie first, sets
`Referrer-Policy: no-referrer`, the per-IP limit (`google-callback:ip:<ipKey>`), Google's `error`,
the state (constantTimeEqual), `exchangeCode`, `verifyIdToken`, `codeEmail` of its email, then
`googleAccount` (by `getUserByGoogleSub`, else `getUserByEmail` and `linkGoogle`, an `UPDATE ...
WHERE google_sub IS NULL RETURNING *` that also sets a NULL `email_verified_at`, else
`newUserRow` with `googleSub` and `insertUser`; a UNIQUE race on `users.google_sub` or
`users.email` looks again, up to 3 times; an email account linked to another `sub` is
`linked_other`), `startCookieSession`, and a 302 to `/?google=<arrival>#<returnTo>`.

## services/google.ts exports `googleClientId`, `googleConfigured`, `googleAvailable`, `callbackUrl`, `safeReturn`, `encodeFlow`, `decodeFlow`, `pkceChallenge`, `authUrl`, `exchangeCode`, `verifyIdToken`, `keepFor`, `forgetGoogleKeys`, `googleName`, `GoogleError` and the constants
- `googleClientId(env)` (trimmed, null when missing or "SET_ME"), `googleConfigured(env)` (id and
  secret), `googleAvailable(c)` (configured, and the request's origin is `APP_URL`'s, or the host
  is 127.0.0.1 or localhost), `callbackUrl(c)` (`<request origin>/api/auth/google/callback`).
- `safeReturn(raw)`: an app hash route (`/` then path and query characters), at most 300, not
  `//`, not `/welcome` or `/login`; anything else `/`.
- `encodeFlow` / `decodeFlow`: the flow `{state, nonce, verifier, returnTo, locale}` as base64url
  JSON; decode checks each random value (43 base64url characters), runs `safeReturn` again and
  falls back to zh-TW, or null.
- `pkceChallenge(verifier)` (base64url SHA-256), `authUrl({clientId, redirectUri, flow})`.
- `exchangeCode(env, {code, redirectUri, verifier})`: POST `GOOGLE_TOKEN_URL`, form-encoded,
  `GOOGLE_TIMEOUT_MS` (10 s), `redirect: 'manual'`; the id_token, or `GoogleError('failed')` with
  the status and Google's error name in its detail.
- `verifyIdToken(token, {clientId, nonce, now?})`: header RS256 with a `kid`; the key from
  `GOOGLE_JWKS_URL`, kept in module memory (per Worker instance) for `keepFor(Cache-Control, Age)`
  seconds (0 for no-store or no-cache, at most a day), fetched again when expired or when the
  `kid` is not in it; `crypto.subtle.verify('RSASSA-PKCS1-v1_5')`; then `iss`, `aud` (and `azp`
  for a list), `exp` and `iat` (60 s skew), `nonce`, `sub`, and `email_verified` with an `email`
  (`unverified`); returns `{sub, email, givenName, name}`.
- `googleName({givenName, name, email})`: the first that is not blank, trimmed and cut to 60
  UTF-16 units without splitting a character; the email's local part as the last resort.


## routes/admin.ts (owner: W1) exports `adminRoutes`
`requireUser` + owner check (`isOwnerEmail(env, user.email)`, else 404). reset-link, stats, users,
users/:id. Rows carry `emailVerified`; the stats count `withEmail`, `withPassword` and
`deviceOnly` (no email: an email signs in anywhere with a code).

## services/email.ts (Resend) exports `sendEmail`, `codeMessage`, `canSend`, `canEcho`, `undeliverable`, `EmailError`
- `sendEmail(env, {to, subject, text, html}): Promise<void>`: `POST https://api.resend.com/emails`
  (`RESEND_URL`) with `Authorization: Bearer <RESEND_API_KEY>` and JSON `{from: EMAIL_FROM, to,
  reply_to: 'gino@ginochang.com', subject, text, html}`, nothing else (no tags, no headers), a 10 s
  timeout (`EMAIL_TIMEOUT_MS`), `redirect: 'manual'`. Throws `EmailError` with `reason`:
  `not_configured` (no key or no sender), `quota` (429 `daily_quota_exceeded` or
  `monthly_quota_exceeded`), `rejected` (any other 4xx), `unavailable` (no answer, a timeout, 5xx,
  429 `rate_limit_exceeded`). Logs only the status and Resend's error name: never the code, the key
  or the address (Resend's error message can quote it).
- `codeMessage(locale, code)`: `{subject, text, html}`: subject 「吉諾分帳所驗證碼：123456」 /
  "Gino's Split Lab code: 123456"; fixed words and the code only, one link (`EMAIL_APP_LINK`,
  https://split.ginochang.com/), no image; the HTML in paper `#FFFCF6` and ink `#3E3A39`.
- `canSend(env)` (key and sender set), `canEcho(env)` (`EMAIL_DEV_ECHO` is "1" and `ENVIRONMENT`
  is set and not production), `undeliverable(email)` (.test, .example, .invalid, .localhost,
  example.com, .net, .org: never mailed).

## services/emailCodes.ts (both route modules) exports `countStart`, `sendCode`, `checkCode`, `consumeCode`, `codeEmail`, `cleanCode`, `codeMatches`, `codeHash`, `randomDigits`, `invalidEmail`, `codeInvalid` and the limits
- `codeEmail(raw)`: NFKC, trimmed, lowercase, at most 120 characters and the email pattern, or
  null; `cleanCode(raw)`: six digits once full width, spaces and a hyphen are taken out, or null.
- `countStart(c, email)`: per IP (`email-code:ip:<ipKey>`, `EMAIL_IP_PER_HOUR`, default 10, an
  hour) and per address (`email-code:15m:<h>` 3 in 900 s, `email-code:day:<h>` 10 in 86,400 s);
  `<h>` is the first 32 hex characters of SHA-256 of the address.
- `sendCode(c, {email, purpose, userId, locale})`: 503 `email_unavailable` without Resend outside
  test mode, before anything is written; when the message will go out, the whole app's day
  (`email-send:<YYYY-MM-DD>`, `EMAIL_GLOBAL_PER_DAY`, default 90): past it 503 `email_quota` with
  `retryAfter` to 00:00 UTC; then one batch deletes the address's older unused codes of the purpose
  and inserts the new row (`randomDigits`, `codeHash(id, code)`, 10 minutes); mails it unless
  `undeliverable`; a message that fails takes its row with it (503 `email_unavailable`, or
  `email_quota` for Resend's quota). Answers `{ok: true, expiresInSec: 600}` plus `devCode` when
  `canEcho`.
- `checkCode(c, {email, purpose, userId, code})`: malformed is 400 `code_invalid` at once; then
  `checkLimit` on `email-verify:ip:<ipKey>` (30) and `email-verify:<h>` (10, both 15 minutes); one
  `UPDATE ... SET attempts = attempts + 1 WHERE id = (the newest live code) RETURNING` takes the
  try; `codeMatches` (SHA-256 and `constantTimeEqual`, against a dummy without a row); a miss
  counts a failure for both keys and is 400 `code_invalid`. Returns the row unspent;
  `consumeCode(db, id)` spends it (`used_at IS NULL` in the WHERE), false when another request
  did first.

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
  notify, SPEC section 5, `friend.join` among them; else null), so no call site and no batch changes.
- `entryActivityData(e: { kind; description; amount; currency; fxRate; payers; shares }, groupCurrency: string): ActivityData`
  (description, amount, currency, kind, nets from `shared/balances.entryNet`, groupCurrency).
- `toActivityDTO(row: ActivityRow & { group_name: string; group_emoji: string; group_type: string; actor_name: string | null }): ActivityDTO`

## routes/groups.ts (owner: W2) exports `groupRoutes`
POST /groups, GET/PATCH/DELETE /groups/:gid (PATCH also sets or clears `defaultSplit`, checked
with `shared/defaultSplit.ts` checkDefaultSplit against the active members, with its activity line
and `data.defaultSplit`), PUT /groups/:gid/archive (my member row's
`archived_at` only: no activity, no push, no version bump; SPEC section 4, Archive), members (add,
patch, delete (a leave also drops the member from the default split, `dropFromDefaultStmts`, in
the same batch), unlink, claim-link),
invite reset, GET/POST /join/:code, GET/POST /claim/:token, POST /friends. GET /groups/:gid calls
`materializeDue(db, { groupId, today: todayUTC() })` first, then `loadSnapshot`, ETag =
`snapshotETag(version, knowsRefunds(c))` (`"<version>"`, or `"<version>-legacy"` for a client
without refunds).
Currency change: `getUsdRates(db, todayUTC())` + `rateToBase` to re-base every entry: new fxRate =
old fxRate x rate(oldBase -> newBase) (1 when the entry currency equals the new base), in one batch.
Also exports `etagMatches(header, etag)` (If-None-Match, also used by routes/avatars.ts and
routes/invites.ts), `MAX_ACTIVE_MEMBERS`, `MAX_GROUPS_PER_USER` and `MAX_LINKS_PER_DAY` (30), which
`limitLinks(db, userId, n)` applies: it counts the accounts linked by email in POST /groups, POST
/groups/:gid/members and POST /friends, and a friend invite accepted into a new 1:1 ledger (key
`link-account:<uid>`, fixed daily window), and refuses past the limit with 429 `rate_limited`,
`details.scope: 'links'` (SPEC section 6). The 1:1 ledger rules both POST /friends and
routes/invites.ts use: `assertGroupRoom(db, people)` (409 `limit_reached` at 200 groups),
`pairGroupOf(db, userA, userB)` (the pair group both are active in, the most recently changed, or
null) and `createPairGroup(db, {first, second, currency, createdBy, activity})` (one batch: the
group named "first & second", both members admins, first at sort 0 in their own color, second in
theirs unless first has it, one activity row written by `activity.by`, naming `activity.about`'s
member in data.memberId and memberName when given; then its summary), with the type `PairSide`.

## routes/invites.ts exports `inviteRoutes`, `INVITE_IP_PER_15M`, `INVITE_PAGE_PER_15M`, `INVITE_AVATAR_PATH`, `inviterByCode`, `invitePageHtml`
GET /me/invite and POST /me/invite/reset (`requireUser`), GET /invite/:code (`optionalUser`), GET
/invite/:code/avatar (no sign-in) and POST /invite/:code (`requireUser`), as SPEC section 6, Friend
invites. The code: `randomInviteCode()` (16 of `[A-Za-z0-9]`), written by
`UPDATE users SET invite_code = ? WHERE id = ? [AND invite_code IS NULL] RETURNING invite_code`
(the first GET writes only when there is none, so two first calls get one code; a reset always
writes; a UNIQUE clash draws again, twice at most). `inviterByCode(db, code)`: the account, or null
for a code that does not match `INVITE_CODE_RE` (shared/invites.ts, never looked up) or that nobody
has. The anonymous GET counts `invite:ip:<ipKey>` first (`limitFrom(env.INVITE_IP_PER_15M, 30)`,
900 s). POST checks, in order: the code (400 `code_invalid`), the caller's own (400 `own_invite`),
`pairGroupOf` (existed, nothing counted or written), `assertGroupRoom` for both, `limitLinks` for
the caller, then `createPairGroup` with the owner first, in the owner's currency, `createdBy` the
caller, activity `{by: 'second', type: 'friend.join', about: 'first'}`. The avatar route reads
`avatars` joined to `users` by the code in one query and answers like `GET /users/:userId/avatar`.
`invitePageHtml(c, html, code)`: counts `invite-page:ip:<ipKey>` (`INVITE_PAGE_PER_15M`, 120 in
900 s) and returns `withTags(html, inviteTags(...))` for a code that works, else `html` as it is;
a 429 or any failure also returns `html` (the page always loads).

## services/invitePage.ts exports `inviteTags`, `withTags`, `escapeHtml`, `OG_IMAGE_PATH`, `PageTags`
Pure. `inviteTags({appUrl, url, name, locale})`: the title (「<name> 邀請你一起用吉諾分帳所分帳」, zhJoin
spacing, or "<name> invited you to split costs on Gino's Split Lab" for an `en` inviter), a
description, `og:url` the share URL, the image `<appUrl>og-image.png`, `og:locale`; the name made
one line (control and line separator characters become spaces). `withTags(html, tags)` replaces
`<title>`, the description, og:title, og:description, og:url, og:image, og:locale and its alternate,
and twitter:title, twitter:description and twitter:image (a tag the page lacks is added before
`</head>`), every value through `escapeHtml`.

## routes/me.ts (owner: W2) exports `meRoutes`
GET/PATCH/DELETE /me, POST /me/credentials, POST /me/email/start and /me/email/verify, GET
/me/export, GET /activity, POST /activity/seen.
GET /me builds MeDTO from `ensureSummary` of each of my groups (one query for my memberships,
one for all members of those groups, one for the groups). POST /me/credentials sets the password
only: the body's email must be the account's own, confirmed unless the account had a password
(else 400 `email_unconfirmed`, nothing written). POST /me/email/start counts `countStart`, refuses
an address another account has (409 `email_taken`) and `sendCode`s an `add_email` code in the
account's language; /verify `checkCode`s it for this account, checks the address is still free,
spends it, and writes `email`, `email_verified_at` and, when the email changed on an account with
a password, `pw_hash = NULL` (`passwordCleared`). No group is touched: no snapshot shows an email.
DELETE /me deletes the profile photo and the `add_email` codes with the account and clears both
session cookies when the request's cookie holds the caller's session. GET /me/export adds
`user.avatarImage`, the photo as a data URL (`avatarDataUrl` from routes/avatars.ts), or null,
and says nothing about codes.

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

CPU, measured on staging (2026-10-18, `tmp/avatar-cpu.mjs`, `cpuTime` from `wrangler tail`, 5
rounds): PUT 2 to 6 ms for a 7 or 17 KB photo, 5 to 9 ms for 50 KB (plain noise, the largest a
256 x 256 JPEG at 0.85 gets, so the most the apps send), and 13 to 14 ms at 149 KB; GET 1 to 3 ms
up to 50 KB and 4 to 7 ms at 149 KB. Most of it grows with the bytes (D1 passes a BLOB as an array
of numbers). Only a hand-made client sends a photo near the cap, and only its own upload passes
the 10 ms of Workers Free. Measure again before raising `AVATAR_MAX_BYTES`.

## routes/receiptPhotos.ts exports `receiptPhotoRoutes`, `RECEIPT_PHOTO_MAX_BYTES`, `RECEIPT_PHOTO_PER_DAY`, `RECEIPT_KV_WRITES_PER_DAY`, `RECEIPT_STORE_MAX_BYTES`, `RECEIPT_MAX_SIDE`, `RECEIPT_PHOTO_PATH`
PUT, GET and DELETE /groups/:gid/expenses/:eid/receipt, each with `requireUser` on the route (SPEC
section 6, Receipt photos).
- PUT: `?w=` and `?h=` (`/^[1-9][0-9]{0,3}$/`, at most `RECEIPT_MAX_SIDE` 4000), the Content-Type
  (`image/jpeg` or `image/png`, parameters ignored), `Content-Length` at most
  `RECEIPT_PHOTO_MAX_BYTES` (600,000), then one query (`ENTRY_SQL`): the expense in the live group
  for an active member, with its photo row, the group version and `SUM(bytes)` over all photos.
  The body is read from the stream into one buffer, refused (413) the moment it passes the limit,
  so no larger body is ever held. Magic bytes (`FF D8 FF`, `89 50 4E 47`); every refusal of the
  request is 400 `bad_request` with `details.fields` (`['w']`, `['h']`, `['body']`). Then
  `rateLimit` on `receipt-photo:user:<uid>:<day>` (40; 429 `scope: 'user'`, `retryAfter` to
  00:00 UTC), the same version as stored answers without writing, `stored + bytes >
  RECEIPT_STORE_MAX_BYTES` is 503 `receipts_full`, `rateLimit` on `receipt-photo:kv:<day>` (RECEIPT_KV_WRITES_PER_DAY: 900 by default, 500 in production, 60 on staging)
  is 503 `receipts_quota`, then `RECEIPTS.put('receipt:<eid>:<version>', bytes)` (a KV error
  naming 429 or a limit is `receipts_quota`, anything else 503 `server_error`), one batch (the
  `receipts` upsert, `bumpVersionStmt`, `carrySummaryStmt` from routes/expenses.ts: a photo moves
  no balance), and the old object's delete (logged when it fails). If the batch fails, the new
  object is deleted again.
- GET: one query (`VISIBLE_SQL`, the snapshot's rule) and one 404 for every refusal; the ETag
  check comes before the KV read, so a 304 costs no read; the object is streamed
  (`get(key, 'stream')`) with `Content-Type`, `ETag`, nosniff and `Cross-Origin-Resource-Policy:
  same-origin`, `private, max-age=31536000, immutable` with `?v=`, else `private, no-cache`.
- DELETE: the KV object first (503 `server_error` when that fails, the row stays), then one batch
  (the row, the version bump, the summary carried). No photo: `{groupVersion}` and nothing written.

CPU: the photo is a raw body (no JSON, no base64 to decode, as the avatar has); the work on it is
one buffer copy when it arrived in several chunks, the magic bytes and one SHA-256 (native); GET
never reads the bytes into the Worker. Measured on staging (2026-10-25, `tmp/receipt-cpu.mjs`,
`cpuTime` from `wrangler tail`, a 252 KB 1200 x 1600 JPEG, 4 rounds): PUT 3 to 4 ms (7 ms on a
cold start), GET 1 to 2 ms, well inside Workers Free's 10 ms. Measure again before raising
`RECEIPT_PHOTO_MAX_BYTES`.
Subrequests: PUT makes at most 6 (the entry query, two limit rows, the put, the batch, the old
delete), GET 2, DELETE 3.

## services/receiptPhotos.ts exports `receiptKey`, `cleanupReceiptPhotos`, `RECEIPT_UNDO_MS`, `RECEIPT_CLEANUP_PER_RUN`
- `receiptKey(expenseId, version)`: `receipt:<expenseId>:<version>`.
- `cleanupReceiptPhotos(env, now)`: the photos of expenses deleted before `now` minus
  `RECEIPT_UNDO_MS` (24 hours) and of deleted groups, oldest deletion first, at most
  `RECEIPT_CLEANUP_PER_RUN` (25): one D1 read, the KV deletes at once, then one batch deleting the
  rows of the objects that went (`kv_key` in the WHERE). A failed KV delete keeps its row for the
  next run, so no object is left without a row. Returns `{deleted, failed}`.

## services/recurring.ts (owner: W3)
- `materializeDue(db: D1Database, opts: { groupId?: string; today: string }): Promise<number>`
  (returns how many copies were created; see SPEC section 7).

## routes/expenses.ts (owner: W3) exports `expenseRoutes`
PUT/DELETE /groups/:gid/expenses/:eid, POST .../restore, GET .../history, GET/POST .../comments,
DELETE /groups/:gid/comments/:cid, POST /groups/:gid/import. Uses `requireMember`,
`activityStmt`, `entryActivityData`, `bumpVersionStmt`, `refreshSummary`. Also exports `ID_RE` and
`carrySummaryStmt` (a change that moves no balance keeps the summary current; routes/receiptPhotos.ts
uses both). Every expense it answers with carries its receipt photo's metadata (the entry is read
with `LEFT JOIN receipts`; a save, delete or restore never changes the photo). Refunds: the pure
`sameMoney`, `legacyFields`, `savedInLegacyView`, `backToRefund` (a save made in the legacy view,
merged there and stored as the refund again) and `refundOfFor` (the `refund_of` to store; an id
that names another expense of the group, else null; a save without the field keeps it).

## services/cron.ts (owner: W3)
- `runDaily(env: Env): Promise<void>`: after the cleanup batch, `cleanupReceiptPhotos` (step
  `receipts`, right after it: at most 27 subrequests, so the photos the privacy page promises gone
  go first), then `materializeDue(db, { today })` for all groups,
  `getUsdRates(db, today)` to warm the cache, delete expired sessions, login codes, claim tokens,
  rate_limits rows older than a day, kept push messages a day old (`push_pending` and
  `apns_pending`; the log counts both as kept pushes), and email codes that have
  expired (used or not: run once a day, that keeps every record under about a day, as the privacy
  page says). Deleting a session also deletes its push subscriptions and iPhones and their kept
  messages (cascade).

## routes/push.ts (owner: B) exports `pushRoutes`
GET /push/status, PUT and DELETE /push/subscription, PUT and DELETE /push/apns (the iPhone app's
token), PUT /push/prefs, POST /push/test and POST /push/run (SPEC section 6), each with
`requireUser` on the route. Also `MAX_SUBSCRIPTIONS` (10), `MAX_APNS_DEVICES` (10, iPhones per
account, counted apart from browsers), `ENDPOINT_MAX` (1024), `APNS_LABEL_MAX` (60), and the
subscription checks `endpointProblem(endpoint)` and `publicKeyBytes(s)` (for tests). Status, both
PUTs and the count after them answer `devices` over both tables; status adds `apns` (a usable
APNs key). /push/test sends to browsers and iPhones through `deliveryFor` and `deliverPushes`
(rate limit key `push-test:<uid>`, 5 an hour; 503 only when neither channel is set up); /push/run
calls `runPushSender`.

## services/push.ts (owner: B)
- `runPushSender(env: Env, now?: Date): Promise<PushRunResult>`
  (`{groups, sent, removed, failed}`), for the minutely cron and POST /api/push/run. Never throws
  (it runs inside `ctx.waitUntil`); its log line has counts only. Two kinds of device go through
  every step together: browsers (`push_subscriptions`, Web Push) and iPhones (`apns_devices`,
  APNs, services/apns.ts), each a `DeviceRow` with its channel `ch` (`'web'` or `'apns'`). One run:
  1. One `db.batch` to start: clear the due rows of groups nobody can hear (no device of either
     kind); delete the kept messages that can no longer go (a day old, or their device moved to
     another account or lost its session; one statement per table), so they never use the budget;
     take the next kept messages out of `push_pending` and `apns_pending` together (`takeKept`:
     rank, browsers before iPhones, then arrival; the whole budget, or `ceil(budget / 2)` when a
     group is due; the devices are read first, then the iPhone rows are marked `taken = 1`, the
     browser rows deleted with `RETURNING`, and the marked rows deleted, so every statement sees the
     same next rows and two runs never send one twice); and read up to 20 due groups, taking turns
     by the account that wrote each group's oldest pending row, each with the number of devices,
     of both kinds, that can hear it (counted up to `budget + 1`).
  2. `claimGroup(db, gid, holdCutoff, nowIso)` per due group, at most `min(10, 50 - 6 - budget)`,
     one `db.batch` each: the stored payers and shares of the pending creates (from
     `idx_activity_push`, then each entry by its key), the claim
     (`UPDATE activity SET push_at = NULL ... RETURNING`, rows older than the hold), the group, its
     members with `users.locale` and `notify_prefs`, and their browsers and iPhones on live
     sessions in one `UNION ALL`, each person's device in use first (its session's
     `last_used_at`). While the take left kept messages, a group that more devices can hear than
     the budget is passed over without a claim.
  3. `groupMessages(claimed, nowMs): Outgoing[]` (pure): merge per entry, recipients, prefs, one
     `pushNotice` per person, one message per device (the PushPayload for a browser, encrypted when
     sent; `apnsBody` for an iPhone, made once per person), sorted by device rank. A channel
     without its key gets no devices here (`canSend`).
  4. A group that does not fit in what is left: when the take left nothing kept, what fits goes,
     the rest is written to `push_pending` and `apns_pending` (one statement per person and table,
     before the sends) and the run claims nothing more; otherwise the group waits whole and the
     next groups may still go. A run whose take left kept messages ends, before the sends, with one
     `db.batch` that gives those groups' rows their `push_at` back (it is always `created_at`) and
     takes more kept messages for the room left. So the two tables hold the rest of one group at
     most.
  5. `deliverPushes(db, senders, list, nowMs?)`: every send at once, each on its channel, then one
     batch for the answers on both tables. Web Push: 2xx sets `last_ok_at` and `failures = 0`, 404
     or 410 deletes the subscription, anything else (a timeout or no answer included) adds a
     failure and deletes the row at `FAILURES_MAX` (5). APNs, by `apnsOutcome`: 200 as 2xx;
     `gone` deletes the iPhone; `failed` counts as above; `refused` changes no row, logs
     `push: APNs refused the request (<status> <reason>): check ...` once a run, and after a 403
     drops the isolate's provider token so the next send signs a new one.
  Without either key a run only clears rows older than a day.
- Also `loadSenders(env)` (`{vapid, apns}`, either null), `canSend(senders, ch)`, `channelOf(d)`,
  `deliveryFor(device, notice)` (one device's message, for POST /api/push/test),
  `parsePrefs(raw)` (anything but an explicit false is on), `pushMessageFor(sub, payload,
  urgency)`, `holdSeconds(raw)` (`PUSH_HOLD_SECONDS`: default 30, 0 to 3600), `budgetOf(raw)`
  (`PUSH_MAX_PER_RUN`: default 12, 1 to 40), and the types `ClaimedRow`, `PushMemberRow`,
  `SubscriptionRow`, `ApnsDeviceRow`, `DeviceRow`, `Channel`, `ClaimedGroup` (`devices`),
  `Delivery`, `Outgoing`, `Senders`.
- Free-plan budgets, per invocation, the cron's included: 10 ms of CPU, 50 subrequests (every
  fetch and every D1 call; a batch is one call), 30 s of `waitUntil`. A run makes
  one D1 call to start, one per claimed group, at most one to keep the rest of a group or to end a
  run whose take left kept messages (never both: only a run whose take left nothing kept keeps a
  rest), and one delivery batch, plus one fetch per message, browser or iPhone (10 s timeout each,
  all at once). So it sends at most `PUSH_MAX_PER_RUN` messages and claims at most
  `min(10, 50 - 6 - budget)` groups (6 kept for the start, keeping or ending, delivery and POST
  /api/push/run's own sign-in, with one to spare): at most 50 subrequests at any budget. A browser
  message costs a new ECDH key pair, a few HMACs and one AES-GCM; an iPhone message only its JSON
  (the isolate signs one provider token every 50 minutes); measure CPU on staging (Workers Logs)
  before raising the budget.

## services/pushText.ts (owner: B)
- `pushNotice(group: PushGroup, items: readonly PushItem[], me: { memberId: string; locale: Locale }): PushNotice | null`
  (`{payload: PushPayload, urgency}`): the title is the group's emoji and name (兩人帳本 / Friend
  ledger for pair groups, the app name for a group without one; at most 100 characters); the body
  is one item's sentence and, for money, its effect line (你借入 ¥X / You borrowed ¥X, 你收到 / You
  received, ...), or a summary for several (「Abbie 新增了 3 筆費用」, joins listed by name, else
  the first item and 「還有 N 筆新動態」), each line at most 240 characters; the path is the entry for
  one expense or payment, else the group; tag `g:<gid>`; urgency `low` when every item is an import.
  Also `route`, the same place for the iPhone app (`group/<gid>/expense/<eid>`, `group/<gid>`), and
  `groupId` (the APNs thread-id).
  Sentences and spacing as the feed writes them (`src/web/features/activity/activityText.ts`),
  amounts with `formatMoney` in the recipient's locale.
- `tapTarget(gid, expenseId?)`: `{path, route}`, where a tap goes in the web app's spelling and the
  iPhone app's.
- `testNotice(locale)`: POST /api/push/test's notification (path `/account`, route `account`, tag
  `test`, no group).
- `zhJoin(name, rest)`: the space after a Latin name before Chinese words (also the invite page's title).
- Types `PushItem` (expense, payment, join, add, create, import, and invite: a `friend.join` row,
  「Abbie 透過你的邀請連結加入」 with 「你們現在是朋友了」 / "You're friends now" as its second line, to
  the link's owner only), `PushPerson`, `PushGroup`, `PushNotice`. An expense item with `refund`
  (a row whose data.kind is 'refund') reads 「Gino 新增了退款「押金」 ¥30,000」 / `Gino added the
  refund "Deposit" (¥30,000)` with 你可以拿回 / 你要還 as its effect line; a summary with a refund in
  it gives no total.

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

## services/apns.ts (owner: B)
WebCrypto only, no dependency. Workers reach APNs's HTTP/2 through `fetch` (proved from staging on
2026-10-29: a made-up token got 400 BadDeviceToken).
- `loadApns(env): Promise<Apns | null>`: `APNS_KEY_ID` and `APNS_TEAM_ID` (Apple's 10-character
  ids), `APNS_TOPIC` and the `APNS_AUTH_KEY` secret read by `pkcs8FromPem` (Apple's .p8 PEM; CRLF,
  `\n` written out, or the base64 alone also work) and imported as an ECDSA P-256 key, once per
  isolate; null when one is missing or unusable (logs fixed messages only, never the key).
- `apnsJwt(apns, nowMs?)`: the provider token, header `{alg: 'ES256', kid}`, claims `{iss, iat}`,
  WebCrypto's raw r || s signature; one per isolate, reused while under `APNS_JWT_REUSE_S` (50
  minutes) old, concurrent sends sign once. `forgetApnsJwt()` drops it (after a 403).
- `apnsBody(notice)`: `{"aps": {"alert": {title, body}, "sound": "default", "thread-id": gid},
  "route": ...}` (no thread-id without a group, never a badge). `apnsMessageFor(device, body,
  urgency, collapseId)`: `ApnsMessage` `{token, environment, topic, body, priority, collapseId}`
  (priority 5 for `low`), or null for a row it cannot use (a token not matching `APNS_TOKEN_RE`,
  an unknown environment).
- `apnsHeaders(apns, message, nowMs?)`: `authorization: bearer <jwt>`, `apns-topic`,
  `apns-push-type: alert`, `apns-priority`, `apns-expiration` (now plus `PUSH_TTL_SECONDS`),
  `content-type: application/json`, and `apns-collapse-id` when there is one. `apnsUrl(environment,
  token)`: `https://api.push.apple.com/3/device/<token>`, `api.sandbox.push.apple.com` for
  `sandbox`.
- `sendApns(apns, message, nowMs?): Promise<ApnsAnswer>`: POST, `redirect: 'manual'`, a 10 s
  timeout; `{status, reason}` (APNs's reason, letters only), status 0 for no answer.
- `apnsOutcome(answer)`: `ok` (200); `gone` (410, 400 BadDeviceToken or DeviceTokenNotForTopic);
  `failed` (no answer, 5xx, 429 TooManyRequests); `refused` (403, 429 TooManyProviderTokenUpdates,
  any other 4xx: the server's own request, the same for every iPhone).
- Constants `APNS_HOSTS`, `APNS_TOKEN_RE` (lowercase hex, 64 to 200 characters in pairs),
  `APNS_JWT_REUSE_S`; types `Apns`, `ApnsEnvironment`, `ApnsMessage`, `ApnsAnswer`, `ApnsOutcome`.

## routes/receipts.ts (owner: D) exports `receiptRoutes`, `RECEIPT_MAX_BYTES`, `RECEIPT_NEURONS_PER_DAY`, `neuronBudget`
`POST /receipts/scan` with `requireUser` on the route. Reads the body itself (Content-Length and
text length at most `RECEIPT_MAX_BYTES`, 3 MiB), `JSON.parse` once, zod for types and lengths; the
image prefix is checked with `startsWith`, never a regex over the base64. `?model=` is the owner's
only, in every environment (403 `forbidden` for anyone else, never a silent swap to the default).
Limit keys `receipt:user:<uid>:<YYYY-MM-DD>` and `receipt:app:<YYYY-MM-DD>` (86,400 s windows;
`RECEIPT_PER_DAY` default 30, `RECEIPT_GLOBAL_PER_DAY` default 300). Then the day's Workers AI
neurons, key `receipt:neurons:<YYYY-MM-DD>` in `rate_limits`, in whole neurons:
`neuronBudget(env)` is the `RECEIPT_NEURONS_PER_DAY` var, else the constant of that name, 8,000
when `ENVIRONMENT` is production and 500 anywhere else, of the account's free 10,000 a day that
both environments share and that Workers Paid bills past. `takeAmount` sets the scan's
`receiptWorstCase(model)` aside; when it does not fit, 429 `rate_limited` with `scope: 'ai'` and
`retryAfter` to 00:00 UTC, before the model is called. Then `runReceiptModel`, and the count is
corrected to `receiptNeuronsSpent` with `addToCount` (a failed write is logged and keeps the
worst case); a call that throws keeps its worst case, since it may have run. Setting it aside
first means scans at the same time, or one whose client went away mid-call, cannot take the day
past the budget. Then `normalizeReceipt`; a scan that read nothing (no total, no items, no store
name) is 502 `scan_failed` with `reason: 'unreadable'`, its neurons counted.

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
  allocation") is 429 `rate_limited` with `scope: 'ai'` (only the Free plan answers it; Workers Paid
  bills instead, and the route's budget stops first); any other failure, the timeout or an answer
  without a JSON object is 502 `scan_failed` (`reason` `model` or `timeout`). The log names only the
  Workers AI code or the error name.
- The neuron budget's figures: `RECEIPT_INPUT_TOKENS_MAX` (8,000: the input tokens a scan is
  counted at before its call; measured per request in the account's analytics, Gemma 4 took 1,620
  to 1,626 at any photo size, Llama 4 Scout 3,587, Qwen 3.8 about 1,350 plus one per 1,000 pixels,
  about 3,850 for the app's largest photo), `receiptWorstCase(model)` (that input and
  `RECEIPT_MAX_TOKENS` out at the model's rates, rounded up: 114 for Gemma 4, 313 for Llama 4
  Scout, 764 for Qwen 3.8) and `receiptNeuronsSpent(model, promptTokens, completionTokens)`
  (`neuronsFor` rounded up, or the worst case for a model without known rates or an answer that
  left out a token count). A model `NEURON_RATES` lacks is priced at the dearest known rates, never 0.
- `readAnswer(raw)`: `choices[0].message.content` (string or text parts), `response` (string or
  object), the REST `result` wrapper; JSON as is, inside code fences, or the outermost `{...}`.
- `normalizeReceipt(raw, {hint, locale, today})` (pure): SPEC section 7.
- Also exported for tests: `minorUnits`, `receiptDate`, `receiptCurrency`, `receiptCategory`,
  `lineKind`, `parseJsonText`, `aiFailure`, `neuronsFor` (the `usage` neurons from the token counts
  at each model's rates; Cloudflare's own count was the same, or lower for a cached prompt),
  `secondsToNextUtcDay`; types `AiRunner`, `ModelAnswer`,
  `ReceiptPromptContext`, `NormalizeContext`.
