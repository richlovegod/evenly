# Gino's Split Lab (code name Evenly): product and engineering spec (v1)

吉諾分帳所 / Gino's Split Lab (code name Evenly, its name until 2026-10-16) is a free Splitwise-style web app for recording shared costs on trips and
while living together, and working out who pays whom. Owner: Gino Chang. Users: Gino and his
friends (Taiwanese and international), mostly on iPhones (Safari, often added to the Home
Screen), sometimes on a laptop.

Primary jobs, in order:
1. Record an expense in under 10 seconds on a phone.
2. See at a glance who owes whom and how much, per group and overall, per currency.
3. Settle up: record a payment and see the other person's Venmo / Zelle / LINE Pay / bank info.

Writing rules for every file in this repo: never use the em dash or en dash characters (a hook
rejects them; use commas, colons, parentheses, 「」); US spelling in English.

## 1. Architecture

- `src/shared/` pure TypeScript used by both sides (no DOM, no Workers APIs). DONE and tested:
  `currencies.ts`, `money.ts`, `alloc.ts`, `split.ts`, `balances.ts`, `settle.ts`, `summary.ts`,
  `dates.ts`, `categories.ts`, `types.ts` (the API contract). Read them before writing code; do not
  change their exported signatures without telling the integrator.
- `src/worker/` Cloudflare Worker (Hono 4 router, zod 3 validation, D1, Workers AI for receipt
  photos, Web Push). Deployed as `evenly-api` (production) and `evenly-api-staging`, each together
  with the built web app (section 8.8). Config in `wrangler.toml`, schema in `migrations/`. Crons,
  production only: daily `0 9 * * *` and the push sender every minute (`* * * * *`).
- `src/web/` React 19 single-page app, built by Vite 7, hash routing (`#/g/<id>`). PWA with a
  hand-written service worker (`public/sw.js`) and IndexedDB cache + outbox for offline use.
- One origin: the Worker serves the app (Workers Static Assets, `wrangler.toml [assets]`, directory
  `./dist`) and `/api` on https://split.ginochang.com, so the session can live in an HttpOnly
  cookie (section 3). `run_worker_first = ["/api/*", "/", "/index.html"]`: the API and page loads
  of the app itself run the Worker (it renews the session cookies on the page's own answer); every
  other path is a file. `not_found_handling = "none"`: a path with no file reaches the Worker,
  which sends a page load to `/` (302, query kept) and answers anything else, a missing `/assets/`
  file included, with a JSON 404 (never index.html, which a cache would keep under that file's
  name). Staging serves its own app the same way on
  https://evenly-api-staging.richlovegod.workers.dev/. The custom domain moves to the Worker at the
  cutover (wrangler.toml has no route for it yet; until then GitHub Pages serves the previous build
  there).
- https://evenly-api.richlovegod.workers.dev stays on (`workers_dev = true`) for app builds from
  before the move, still open on phones, which call it cross-origin with a Bearer token.
- GitHub Pages gets no new builds (`scripts/deploy-web.sh` is retired) and only redirects: the
  `gh-pages` branch stays as it is, since its `CNAME` file keeps GitHub answering
  https://richlovegod.github.io/evenly/<path> with a 301 to https://split.ginochang.com/<path>.
- Imports between folders are relative (`../../shared/split`), no path aliases.
- Tests: Vitest for `src/shared` and pure web/worker helpers (`tests/`), Node scripts for API tests
  against staging, Playwright WebKit (iPhone 14) for UI flows.

## 2. Money rules (implemented in src/shared)

- Every amount is an integer in the currency's minor units (`currencies.ts` decimals; TWD, JPY,
  KRW, VND, IDR, HUF use 0). Never store floats for money.
- An expense has its own `currency` and an `fxRate` (1 major unit of expense currency = fxRate major
  units of the group currency, 1 when equal). Balances are always computed in the group currency
  with `balances.toBase()`, which converts the total once and then allocates it back over payers
  and sharers, so every expense nets to exactly 0.
- Shares come from `split.computeSharesFor(expenseId, total, split)`: rounding leftovers follow a
  fair, stable order hashed from the expense id (`alloc.fairOrder`), so re-saving never moves a
  unit and leftovers do not always land on the payer (Splitwise dropped "the payer absorbs it" as
  unfair to people who pay often). The server recomputes shares and never trusts the client.
- Payers: `split.checkPayers(total, payers)` (positive amounts that sum to the total).
- A payment (settle up) is an entry with `kind: 'payment'`, `payers = [{sender, amount}]`,
  `split = {method: 'exact', entries: [{memberId: recipient, value: amount}]}`, category `payment`,
  description `''` (the UI renders "A 付給 B").
- Settle-up plan: `settle.settlementPlan()`: simplified (group.simplify, default on) or pairwise.
- Group summary for dashboards: `summary.computeGroupSummary()`; the Worker stores it in
  `groups.summary` after every change, tagged with the group version (`forVersion`) and
  `SUMMARY_VERSION`; a stale summary is recomputed on read.

## 3. Accounts and identity

- Anyone can start with only a name: `POST /api/auth/signup {name}` creates an account with no email
  or password and starts a session (a "device-only" account). The UI then nudges (not forces)
  them to add an email + password ("換手機或清除瀏覽器資料後也能登入"), because a new phone or cleared
  browser data would lose a device-only account for good.
- Email + password: optional at signup, can be added later (`POST /api/me/credentials`). Email is a
  login identifier only (no emails are sent; we have no mail sender). Passwords >= 8 characters.
  The typed password never leaves the device: the browser sends a key derived with PBKDF2-SHA256,
  210,000 iterations, salted with the email (`src/web/lib/crypto.ts`), and the Worker stores
  PBKDF2-SHA256 of that key, 4,000 iterations, 16-byte salt (a stored hash keeps its own count, up
  to the Workers maximum of 100,000).
- Sessions: 32 random bytes, base64url (43 characters); the DB stores only SHA-256(token), which is
  the session id. A session lasts 365 days after its last use (`last_used_at` and `expires_at` are
  written at most once an hour). How a request carries it depends on where the API is
  (`config.ts` AUTH_MODE, section 8.1).
- Cookie mode (the app on the Worker's own origin, production and staging): the Worker sets and
  clears two cookies, never page script, both `__Host-` (Secure, `Path=/`, no `Domain`, so sibling
  `*.ginochang.com` sites cannot set or overwrite them), SameSite=Lax, Max-Age one year:
  `__Host-evenly_session=<token>` (HttpOnly) and `__Host-evenly_user=<user id>`, a readable marker
  that tells the page at start who is signed in, with no request and offline. Safari's 7-day limit
  on storage a script can write does not touch them. Requests carry no token; they name the
  account the tab expects in `X-Evenly-User`.
- Renewal on page loads only: a top-level load of `/` or `/index.html` (`Sec-Fetch-Mode: navigate`
  with `Sec-Fetch-Dest` `document` or absent, or no `Sec-Fetch-Mode` at all, as from Safari before
  16.4) gets both cookies again for a full year and slides the session. API answers, a fetch of
  `/` (the service worker's install) and frames never renew them: WebKit caps a cookie that such an
  answer sets to 7 days when the connection went to another of the site's addresses (its
  third-party IP defense), and that copy would replace the year-long one. Apart from sign-ins and
  `POST /api/auth/cookie`, an API answer sends them only to put right a marker that does not name
  the session's account.
- Token copy: the app also keeps the token in `localStorage['evenly.token']` (its account in
  `evenly.tokenUser`) but never sends it while the marker names that account. It is used only when
  the cookies are gone and localStorage is not (a Home Screen app whose capped cookie ran out): the
  app then starts on it as Bearer and puts it back into the cookies with `POST /api/auth/cookie`,
  as it does with a token an older build left. A copy recorded for another account than the
  marker's is dropped once GET /api/me with the cookie names the marker's account (until then the
  page only hides another account's copy, cached data and queued changes: a marker alone never
  deletes anything). The page reads the marker by its exact name, trimming only spaces and tabs, and
  treats two such pairs as no marker (a sibling site could plant a look-alike). A browser that keeps no cookies for the site (after a sign-in, a
  request with the cookie alone finds none, even after one `POST /api/auth/cookie`) stays on Bearer
  for good (`localStorage['evenly.auth'] = 'bearer'`).
- Bearer mode (the API on another origin: vite dev, vite preview, tests that set
  `localStorage['evenly.api']`), and old app builds and scripts: `Authorization: Bearer <token>`,
  the token in `localStorage['evenly.token']`. An `Authorization` header wins over a cookie and is
  the only thing the Worker reads; a bad token is signed out, never a fall back to the cookie.
- CSRF: a cookie request with a method other than GET, HEAD or OPTIONS must come from this origin
  (`Sec-Fetch-Site: same-origin`; without that header, an `Origin` equal to the Worker's own), else
  403 `forbidden`, never 401 (a 401 signs the app out). SameSite=Lax still sends the cookie from
  sibling sites such as award.ginochang.com, and `readJson` takes a text/plain body.
- `session_changed`: a cookie request whose `X-Evenly-User` names another account than the cookie's
  session is 401 `session_changed` (another tab switched accounts); the cookies stay. The app also
  checks the marker before each such request and sends nothing when it changed. Either way the tab
  reloads into the browser's sign-in, as other tabs do on the `{type: 'session'}` message that a
  sign-in, sign-out or token move sends, and when they come to the front; a fourth such reload
  within a minute signs the tab out instead.
- A cookie naming a missing, expired or malformed session (or a marker without its session cookie)
  is cleared, both cookies, on that answer, and the request counts as signed out.
- Signup, login, link and reset from a same-origin request set both cookies and delete the session
  the browser's cookie held before (the device is switching accounts or signing in again); from
  another origin they set no cookies and end nothing. Every caller gets the token in `AuthRes`.
  Signup over a live session cookie is 409 `already_signed_in` (`details.userId`) and creates
  nothing; the app carries on as that account (a lost device-only account never comes back).
- Logout, revoking the current device and `DELETE /api/me` clear both cookies when the cookie holds
  the session that ended. In cookie mode signing out needs a connection, since only the Worker can
  end an HttpOnly session: a failed call (offline, 5xx, 429) is shown on 我的 and nothing is
  cleared; a 401 means it had ended already, except 401 `session_changed`, after which the tab
  reloads.
- Sign in another device: a signed-in device asks `POST /api/auth/link-code` -> 8-character code
  (alphabet without 0/O/1/I/L, shown `XXXX-XXXX`) valid 10 minutes, one use, plus a QR of
  `<APP_URL>#/link/<code>`. The new device opens the link or types the code (`POST /api/auth/link`).
- Password reset: no email, so the owner (emails in the `OWNER_EMAILS` secret) can make a 30-minute
  reset link on the admin page (`#/admin`); the person opens `#/reset/<token>` and sets a new
  password (all other sessions are revoked).
- Account deletion (`DELETE /api/me`): the user row is deleted; their members become placeholders
  (FK `ON DELETE SET NULL`), so groups keep their history.

## 4. Groups, members, friends

- A group has a currency, a type (`trip`, `home`, `couple`, `other`, or `pair` for a 1:1 friend
  ledger), an emoji and color, notes, `simplify`, and an `invite_code` (16 random characters).
- Members belong to one group. A member is either linked to an account (`user_id`) or a
  placeholder (someone added by name). Balances belong to members, so a placeholder can be
  claimed later without losing anything.
- Creating a group makes the creator an `admin` member (named after their account). Anyone in the
  group can add placeholders, add/edit/delete/restore any expense, edit group name, emoji, color,
  type, notes, currency and simplify. Admins additionally can promote/demote, remove members,
  unlink a member's account, reset the invite link and delete the group. The last admin cannot
  leave or be demoted while other active linked members exist (promote someone first).
- Invite link: `<APP_URL>#/join/<invite_code>`. Opening it (no sign-in needed to look) shows the
  group and its members; the person picks the placeholder that is them, or "我不在名單上" and types
  a name. If not signed in, the join page creates a device-only account inline (name prefilled).
- Claim link: any member can make a one-time link for one specific placeholder
  (`#/claim/<token>`, 7 days), e.g. to send privately to Abbie. Admins can unlink a member's account
  (turning it back into a placeholder) to recover someone who lost their device.
- Removing or leaving requires that member's net balance to be 0 (`balance_not_zero`). Removed
  members stay in the table with `active = 0` so old expenses still show them; they are hidden in
  pickers for new expenses.
- Friends: `POST /api/friends {name, email?}` creates (or returns the existing) `pair` group between
  me and a placeholder (or the account with that email). The Friends page aggregates balances per
  person across every group I am in: people with accounts are matched by user id, placeholders are
  listed per group. A friend's page shows the total per currency, the breakdown per group, the pair
  group's expenses, and "新增費用" / "結清" acting on the pair group.
- Limits: 50 active members per group, 5,000 entries per group, 200 groups per user, 30 accounts
  linked by email per person a day (section 6).

## 5. Database

See `migrations/`, applied in order (`scripts/deploy.sh` stops while one is pending). JSON columns:
`expenses.payers`, `expenses.split`, `expenses.shares`, `groups.summary`, `activity.data`,
`fx_cache.rates`, `users.notify_prefs`, `push_pending.payload`. Booleans are 0/1 integers.

- `0001_init.sql`: the v1 schema.
- `0002_push.sql` (apply before the code that writes `push_at`: every activity INSERT names it):
  - `activity.push_at TEXT`: the row's own time while it may still send a push; NULL for every
    other row and once the sender claimed it, and for rows from before the migration (nothing old
    is ever sent). Written in the same INSERT (`services/activity.ts` pushAtFor) for
    expense.create, expense.update, expense.delete, expense.restore, member.join, member.claim,
    member.add, group.create and the Splitwise import row (group.update whose `changes[0].field` is
    `import`). Partial index `idx_activity_push (group_id, push_at) WHERE push_at IS NOT NULL`.
  - `push_subscriptions`: one row per browser that turned notifications on. `id` (SHA-256 hex of the
    endpoint), `user_id` (cascade), `session_id` (sessions, cascade: signing out, revoking the
    device, a password reset, the expiry cleanup and deleting the account stop that device's
    pushes), `endpoint`, `p256dh` and `auth` (base64url), `tz` (IANA zone or ''), `label`
    (deviceLabel of the User-Agent), `created_at`, `last_ok_at`, `failures` (failed pushes in a
    row; the row is deleted at 5). Indexes on `user_id` and `session_id`.
  - `users.notify_prefs TEXT NOT NULL DEFAULT '{}'`: PushPrefsDTO as JSON; a missing key means on.
- `0003_push_pending.sql`: `push_pending`, the messages a sender run could not fit, which the next
  runs send first (section 7). `id` (INTEGER PRIMARY KEY, arrival order), `sub_id`
  (push_subscriptions, cascade), `user_id` (the account it was written for), `rank` (0 for the
  person's newest device, 1 for the next...), `payload` (PushPayload JSON, encrypted when sent),
  `urgency` (`normal`, or `low` for the import summary), `created_at`. Index on `sub_id`.

## 6. HTTP API

Base URL: the app's own origin (`/api` on https://split.ginochang.com, and on
https://evenly-api-staging.richlovegod.workers.dev for staging); old app builds and scripts call
`https://evenly-api.richlovegod.workers.dev`. All paths start with `/api`. JSON in and out.
Errors: HTTP status + `ApiErrorBody` (`{error: {code, message, details?}}`, codes in
`shared/types.ts`). 400 `validation` carries zod issues in `details`. 429 `rate_limited` carries
`details.retryAfter` (seconds, also sent as `Retry-After`) and, where the limits differ,
`details.scope`. Codes added with the cookie session and the receipt scan: 401 `session_changed`,
409 `already_signed_in`, 502 `scan_failed`. Auth ("user" below): the session cookie or
`Authorization: Bearer` (section 3); a cookie write from another origin is 403 `forbidden`.
"member" below means: signed in AND an active member of the group, else 404 `not_found` (do not
reveal that the group exists). Bodies over 256 KB get 413 (`/api/receipts/scan` takes up to 3 MiB).

### Auth
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| POST | /api/auth/signup | none | SignupReq -> AuthRes. If email given, password required (`password_required`), `email_taken` when used. Rate limit 10/hour/IP. A live session cookie in the request: 409 `already_signed_in`, `details: {userId}`, nothing created (checked before the rate limit; a same-origin request gets both cookies again, since the marker may be what went missing). |
| POST | /api/auth/login | none | LoginReq -> AuthRes. `invalid_credentials` (generic). Limits: 10 per 15 min per email, 30 per 15 min per IP. |
| POST | /api/auth/logout | user | {} -> {ok: true}; revokes this session; clears both cookies when the request's cookie holds it. |
| POST | /api/auth/cookie | user (Bearer, same origin) | {} -> {user: UserDTO}; puts the presented Bearer session into both cookies, with no new session row (tabs that race get the same cookie). A cookie-only request: 400 `bad_request`; another origin: 403 `forbidden`; a dead token: 401. |
| GET | /api/auth/sessions | user | -> {sessions: SessionDTO[]} |
| DELETE | /api/auth/sessions/:id | user | -> {ok: true} (own sessions only); clears both cookies when `:id` is the session the request's cookie holds. |
| POST | /api/auth/link-code | user | {} -> LinkCodeRes |
| POST | /api/auth/link | none | {code} -> AuthRes; `code_invalid`. Limit 10 per 15 min per IP. |
| GET | /api/auth/reset/:token | none | -> {email, expiresAt} for a live reset link (the reset page salts the password key with the email); `code_invalid` otherwise. Limit 10 per 15 min per IP, shared with POST. |
| POST | /api/auth/reset | none | {token, password} -> AuthRes; revokes other sessions. |

Signup, login, link and reset from a same-origin request also set both session cookies and delete
the session the browser's cookie held before (section 3). The clear-on-end rule is "the cookie holds
that session", not "the request used the cookie": a Bearer caller that ends some other session of
the account leaves the browser's cookie alone.

### Me
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| GET | /api/me | user | -> MeDTO (dashboard: groups with my net and my transfers, friends aggregated, totals per currency, unread activity count). |
| PATCH | /api/me | user | UpdateMeReq -> {user: UserDTO} |
| POST | /api/me/credentials | user | CredentialsReq -> {user: UserDTO}; needs currentPassword if a password exists (`invalid_credentials`). |
| DELETE | /api/me | user | {password?} -> {ok: true}; password required if the account has one. Clears both cookies when the request's cookie holds the caller's session. |
| GET | /api/me/export | user | -> {user, groups: GroupSnapshotDTO[]} (everything I can see). |
| GET | /api/activity?before=<iso>&limit=30 | user | -> {items: ActivityDTO[], next: string or null}, newest first, across my groups. |
| POST | /api/activity/seen | user | {} -> {ok: true}; sets activity_seen_at = now. |

### Groups and members
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| POST | /api/groups | user | CreateGroupReq -> GroupSnapshotDTO. Each member email that finds another account counts toward the email-link limit (below). |
| GET | /api/groups/:gid | member | -> GroupSnapshotDTO. Sends `ETag: "<version>"`; honors `If-None-Match` with 304. Materializes due recurring entries first. |
| PATCH | /api/groups/:gid | member | UpdateGroupReq -> GroupSnapshotDTO. Currency change: every entry's fxRate is re-based through today's rate old->new (entries already in the new currency get 1). |
| DELETE | /api/groups/:gid | admin | -> {ok: true} (soft delete) |
| POST | /api/groups/:gid/members | member | AddMemberReq -> {member: MemberDTO, groupVersion}. An email that finds an account (also one coming back after leaving) counts toward the email-link limit. |
| PATCH | /api/groups/:gid/members/:mid | member (role: admin) | UpdateMemberReq -> {member, groupVersion} |
| DELETE | /api/groups/:gid/members/:mid | admin, or self (= leave) | -> {ok: true, groupVersion}; `balance_not_zero`, `last_admin` |
| POST | /api/groups/:gid/members/:mid/unlink | admin | -> {member, groupVersion} |
| POST | /api/groups/:gid/members/:mid/claim-link | member | -> {token, url, expiresAt} (placeholders only, else `member_claimed`) |
| POST | /api/groups/:gid/invite/reset | admin | -> {inviteCode} |
| GET | /api/join/:code | optional | -> JoinInfoDTO (404 when the code is unknown) |
| POST | /api/join/:code | user | JoinReq -> {groupId, memberId}; `member_claimed`, `already_member` returns the existing ids with 200. |
| GET | /api/claim/:token | none | -> ClaimInfoDTO |
| POST | /api/claim/:token | user | {} -> {groupId, memberId}; if the user is already a member of that group: `already_member`. |
| POST | /api/friends | user | {name, email?} -> {groupId} (pair group, created or existing). A new ledger with an account found by email counts toward the email-link limit. |

Email-link limit: linking needs only the other person's email, and every linked account gets a push
notification titled with a group name the sender chose, so each account may link at most 30
accounts by email a day (`MAX_LINKS_PER_DAY`; a fixed window in `rate_limits`, key
`link-account:<uid>`, counted per account linked, refused attempts included). Names without an
email, emails without an account, and joining by invite or claim link do not count. Past it: 429
`rate_limited`, `details: {retryAfter, scope: 'links'}`, nothing written.

### Expenses, comments, history
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| PUT | /api/groups/:gid/expenses/:eid | member | UpsertExpenseReq -> UpsertExpenseRes. Creates or updates (idempotent; the client makes the UUID). Server validates members (any member of the group, active or not), recomputes shares, checks payers, writes activity, bumps group version, refreshes summary. `rateBase` = the group currency the rate was chosen against (converted if the group currency changed since). Edits send `baseVersion` and `base` (the entry as the form opened): the server merges only the parts this save changed; a part someone else also changed returns 409 `conflict` (details code `edited_elsewhere`). |
| DELETE | /api/groups/:gid/expenses/:eid | member | -> {expense, groupVersion} (soft delete) |
| POST | /api/groups/:gid/expenses/:eid/restore | member | -> {expense, groupVersion} |
| GET | /api/groups/:gid/expenses/:eid/history | member | -> {items: ActivityDTO[]} |
| GET | /api/groups/:gid/expenses/:eid/comments | member | -> {comments: CommentDTO[]} |
| POST | /api/groups/:gid/expenses/:eid/comments | member | {id?, body} -> {comment, groupVersion} (1 to 1000 chars) |
| DELETE | /api/groups/:gid/comments/:cid | member (author only) | -> {ok: true, groupVersion} |
| POST | /api/groups/:gid/import | member | BatchImportReq (max 500) -> {imported: number, groupVersion} |

### Push notifications
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| GET | /api/push/status | user | -> PushStatusRes `{publicKey, prefs, devices}`. `publicKey` is '' when the server cannot sign pushes (a VAPID variable missing, or the secret is not the private half of `VAPID_PUBLIC_KEY`). |
| PUT | /api/push/subscription | user | PushSubscriptionReq (`PushSubscription.toJSON()` plus `tz`; other keys are dropped) -> {ok: true, devices}. Stored for this account and this session. The same endpoint again updates keys, session, label and tz and resets `failures`; an endpoint stored for another account moves to this one (the device changed account). At most 10 per account: a new one past that deletes the devices that worked (`last_ok_at`, else `created_at`) longest ago. |
| DELETE | /api/push/subscription | user | {endpoint} -> {ok: true}; only this account's own row; an unknown endpoint is ok too. |
| PUT | /api/push/prefs | user | `Partial<PushPrefsDTO>` -> PushPrefsDTO (all three); keys not sent keep their value. |
| POST | /api/push/test | user | {} -> PushTestRes `{sent, removed, failed}`: a test notification to every device of the account, now, in its language (a tap opens `/account`). 5 an hour, else 429; 503 `server_error` when push is not set up. |
| POST | /api/push/run | owner; any user when ENVIRONMENT is not production | {} -> {groups, sent, removed, failed}: runs the sender now (staging has no cron). Others get 404 `not_found` in production. |

Subscription checks (400 `validation`, `details: [{path, message}]`): `endpoint` at most 1024
characters, `https:` with no user, password or port, on `fcm.googleapis.com`,
`updates.push.services.mozilla.com`, `push.services.mozilla.com`, or a subdomain of
`push.apple.com` or `notify.windows.com` (the Worker POSTs to it, and never follows a redirect);
`keys.p256dh` base64url of a 65-byte P-256 point (0x04 first); `keys.auth` 16 bytes; `tz`
optional, an IANA zone name (not sent: the stored one is kept).

### Receipt scan
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| POST | /api/receipts/scan | user | ReceiptScanReq `{image, currency?, locale?}` -> ReceiptScanDTO. `image`: a `data:image/jpeg`, `png` or `webp` base64 data URL; the route reads the body itself, up to 3 MiB (`RECEIPT_MAX_BYTES`). `currency`: the hint, the form's currency when the scan starts (a receipt that shows no currency is read in the hint's decimals). `locale` (default zh-TW): the language of `warnings`. Money in the answer is in major units as plain numbers, checked against the currency's decimals. `?model=` (the owner only, in every environment) picks one of `@cf/google/gemma-4-26b-a4b-it` (the default, `RECEIPT_MODEL`), `@cf/qwen/qwen3.8-27b` and `@cf/meta/llama-4-scout-17b-16e-instruct`; from anyone else 403 `forbidden`, another name 400 `validation`. |

The photo is read once and dropped: nothing is stored, and neither the photo nor its text is
logged. Limits: `RECEIPT_PER_DAY` scans per account (default 30) and `RECEIPT_GLOBAL_PER_DAY` for
the whole app (default 300; staging 40), in fixed UTC days. Past one of them, or when the Workers
AI daily allowance is used up (error 3036): 429 `rate_limited` with `details.scope` `user`, `app`
or `ai` and `retryAfter` to 00:00 UTC. That allowance belongs to the Cloudflare account, shared by
staging and production, while our limits count per environment: hence the small staging limit and
the owner-only `?model=` (the other models cost 5 to 10 times as much). 502 `scan_failed` with
`details.reason`: `model` (the model failed or gave no JSON, or the AI binding is missing),
`timeout` (55 s), or `unreadable` (no total, no items and no store name). Only an attempt that
passes the body, field, `?model=` and binding checks counts toward the limits; from there every
attempt counts, a failed model call included.

### Other
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| GET | /api/fx?base=TWD&date=YYYY-MM-DD | none | -> FxRes (cached per day in D1; falls back to the latest earlier day) |
| GET | /api/health | none | -> {ok: true, env} |
| POST | /api/admin/reset-link | owner | {email} -> {url, expiresAt} |
| GET | /api/admin/stats | owner | -> {users, groups, expenses} counts |
| GET | /api/admin/users?q=&limit=&offset= | owner | -> {total, users: AdminUserRow[], stats: {users, newLast7, activeLast7, withPassword, deviceOnly, groups, entries}}; q matches name or email; newest first |
| GET | /api/admin/users/:id | owner | -> {user (row + payInfo, venmo, paypal), groups, sessions (label, createdAt, lastUsedAt, expiresAt), activity (latest 20)}; never hashes, session ids or tokens |

Validation limits: name 1 to 60 chars (trimmed), group name 1 to 80, description 0 to 120
(an expense needs a description; payments may be empty), notes 0 to 2000, payInfo 0 to 300,
venmo/paypal 0 to 50 `[A-Za-z0-9_.-]`, emoji 0 to 16 chars, color `#RRGGBB`, currency 3 uppercase
letters, category must be a known key (`categories.ts`) else `general`, date valid ISO date between
2000-01-01 and today + 1 year, amount 1 to MAX_AMOUNT, fxRate > 0 and < 1e9 (exactly 1 when the
currency equals the group currency), entries/items <= 50, item names <= 60.

CORS, for cross-origin Bearer callers only (old app builds, vite dev, tests; the app on the Worker's
own origin needs none): allow origins from `ALLOWED_ORIGINS` (comma separated), methods GET POST PUT
PATCH DELETE OPTIONS, headers `Authorization, Content-Type, If-None-Match, X-Evenly-User`, expose
`ETag`, max-age 86400, and never `Access-Control-Allow-Credentials` (no other origin may read an
answer made with the cookie). Every `/api` answer says `Vary: *`, which no cache stores (the
evenly-v3 service worker still on some phones caches every same-origin GET, and its `Cache.put`
throws on `Vary: *`), except GET and HEAD `/api/fx`, which say `Vary: Origin` (public,
`max-age=3600`); the OPTIONS preflight says `Vary: Origin`. Answers without their own
`Cache-Control` get `no-store`.

## 7. Worker internals

- `src/worker/index.ts`: Hono app, CORS and the `Vary` and `Cache-Control` headers of section 6, the
  body-size gate, JSON error handler (ApiError -> body; ZodError -> 400 `validation`; anything else
  -> 500 `server_error` with the message logged, never leaked), page loads of `/` and `/index.html`
  (the built page with the session cookies renewed, section 3) and paths with no file (section 1),
  mounts route modules, and `scheduled()`, which runs the push sender for the `* * * * *` cron and
  `runDaily` for the daily one.
- `src/worker/env.ts`: `Env` bindings (D1, ASSETS, AI) and vars, Hono `AppEnv` type, `AuthUser`
  (with `via: 'bearer' | 'cookie'`).
- `src/worker/http.ts`: `ApiError`, `fail(status, code, message, details?)`, `readJson(c, schema)`,
  `nowISO()`, `newId()`, `randomToken(bytes)`, `sha256Hex(s)`.
- `src/worker/db.ts`: row types, row -> DTO mappers, common queries (`getGroupForMember`, ...).
- `src/worker/auth.ts`: password hash/verify, sessions from the Bearer header or the session
  cookies (section 3), `requireUser` / `optionalUser` middleware, `startSession` for sign-ins, the
  cookie helpers, `rateLimit(db, key, limit, windowSec)`.
- `src/worker/routes/*.ts`: one module per area (auth, me, groups, expenses, fx, admin, push,
  receipts).
- `src/worker/services/summary.ts`: `refreshSummary(db, groupId)` reads members + entries, computes
  with `shared/summary.ts`, writes `UPDATE groups SET summary=? WHERE id=? AND version=?`.
- `src/worker/services/activity.ts`: builds activity rows (nets per member in group currency via
  `shared/balances.entryNet`), with `push_at` (`pushAtFor`, section 5) in the same INSERT, so the
  push intent commits or rolls back with the change.
- `src/worker/services/push.ts`: `runPushSender(env, now?)`, run every minute by the cron in
  production and by POST /api/push/run. Who hears about what: a new expense reaches the members in
  its nets (payers and people with a share), a payment its sender and recipient, a join or claim
  everyone else, an add the added person, a new group or 1:1 ledger the other members, a Splitwise
  import everyone else (one summary). Only active members whose account was linked when it
  happened (`members.claimed_at`), never anyone who wrote one of the rows, and then each person's
  prefs (`expenses` covers expenses and the import, `payments` payments, `joins` joins, adds and
  new groups). Edits, deletes and restores only merge with a create in the same run: created then
  deleted sends nothing (an undo), created then edited sends one "added" with the last values, and
  rows without a create send nothing.
- How a run goes: a group is due when its newest pending row is older than `PUSH_HOLD_SECONDS`
  (default 30, staging 0) or its oldest has waited 4 minutes. Groups nobody can hear (deleted, or no
  active member besides the one account that wrote all their rows has a device on a live session)
  are cleared without a claim, and due groups take turns by the account that wrote each one's
  oldest row. A claim (`UPDATE ... SET push_at = NULL ... RETURNING`) never sends a row twice. One
  notification per person per group per run (`services/pushText.ts`, in the person's language and
  with the feed's sentences: one item gets its sentence and, for money, the effect line; several get
  a summary), one message per device, `{title, body, path, tag: 'g:<gid>'}`. At most
  `PUSH_MAX_PER_RUN` messages a run (default 12, at most 40; production sets 8): when a group does not fit, what fits
  goes now, every person's device in use before anyone's second, and the rest waits in
  `push_pending`. Later runs send it with half their budget while other groups are due (all of it
  when none is), so a big group's rest never holds up small groups for long. 404 or 410 from the push
  service deletes the subscription; 5 other failures in a row do too. Rows and kept messages a day
  old are dropped. Budgets: docs/WORKER.md.
- `src/worker/services/webpush.ts`: RFC 8291 encryption (aes128gcm) and RFC 8292 VAPID (ES256 JWT,
  reused per push service for about 12 hours) on WebCrypto alone, no dependency.
- `src/worker/services/receipt.ts`: the receipt prompt and JSON schema, one Workers AI call per scan
  (given up after 55 s), reading every answer shape the models give, and `normalizeReceipt` (pure):
  Western-calendar dates (令和, 平成 and 民國 years converted), known currency codes (signs mapped),
  amounts checked against the currency's decimals (a fraction of a yen is refused), subtotal, tax,
  tip, payment and change lines kept out of the items, discount lines settled, at most 50 items of
  60 characters, a total from the items only when no amount was refused, and `warnings` in the
  request's language.
- `src/worker/services/recurring.ts`: `materializeDue(db, groupId | null, todayUTC)`: for each live
  entry with `repeat != 'none'` whose next occurrence (from `repeat_start`, `shared/dates`) is
  <= today, insert copies with deterministic ids (UUID-formatted SHA-256 of `series:date`,
  `INSERT OR IGNORE`), move the repeat flag to the newest copy, log `recurring.create`. Called on
  group GET and by the daily cron.
- `src/worker/services/fx.ts`: daily USD-based table fetched from the provider chosen in
  `docs/RESEARCH.md` (with a fallback provider), cached in `fx_cache`; cross rates computed as
  `rates[C] in base = usd[base] / usd[C]`.
- Writes that change a group run in one `db.batch([...])` (entry + activity +
  `UPDATE groups SET version = version + 1, updated_at = ? WHERE id = ? RETURNING version`), then
  `refreshSummary` runs guarded by that version.

## 8. Web app

### 8.1 Foundation (src/web/lib, written first; pages use these, do not re-implement)
- `config.ts`: `API_BASE` from `import.meta.env.VITE_API_BASE` (`same-origin` or `/` mean this
  page's origin, `''`); unset, `vite` dev builds call staging and production builds call `/api` on
  their own origin; `localStorage['evenly.api']` still wins (tests and dev). `AUTH_MODE`: `cookie`
  when `API_BASE` is `''` or has this page's origin, else `bearer` (section 3). `APP_URL`
  (location origin + base path).
- `api.ts`: `api<T>(method, path, body?, opts?)` (options include `timeoutMs` and `signal`), JSON,
  `ApiError` class (`status`, `code`, `message`, `details`), network failures throw `ApiError` with
  code `offline`. Cookie mode: `credentials: 'same-origin'` and `X-Evenly-User` on calls made for
  this tab's account; a Bearer token only while one is not yet backed by the cookie (a new
  sign-in's until a cookie-only request confirms it, a saved token until it is put back into the
  cookie); a marker that no longer names this tab's account stops the call before it is sent (401
  `session_changed`). `authMode()` turns to `bearer` for good where the browser keeps no cookies.
  Bearer mode: the token from `localStorage['evenly.token']`. `anonymous` calls send neither (and a
  401 does not sign out); `ignore401` is for logout. A 401 `session_changed` reloads the tab,
  another 401 while signed in signs it out, both only for the credential the request was sent with.
- `store.ts`: global state (`useStore(selector)`) and `actions` (all server calls go through
  actions; optimistic updates and the outbox live here). Offline-capable actions: upsert, delete,
  restore expense, add comment. Others need a connection and throw `offline`. `State.token` is the
  session key: the token in Bearer mode, an opaque `cookie:<userId>:<n>` in cookie mode, so every
  "signed in?" and "still the same session?" check keeps its meaning.
- `push.ts`: Web Push on this device (section 8.6). `pwa.ts`: service worker registration, the
  update toast, the worker's messages (a notification tap, `swVersion()`), Home Screen helpers.
- `idb.ts`: tiny IndexedDB key-value wrapper used by the store.
- `router.ts`: hash router: `useRoute()`, `navigate(path, {replace})`, `back(fallback)`, `href(path)`.
- `i18n.ts`: `useT()` returns `{t, locale, money, date, relative}`; `t('中文', 'English', params?)`
  with `{name}` placeholders. zh-TW is the default for Chinese browsers, else English; the choice
  is stored on the account and in localStorage. Money and date formatting live here too (`money`
  wraps `shared/money.formatMoney`).

### 8.2 Routes
| Hash | Page |
|---|---|
| `#/` | Home (signed in) or Welcome |
| `#/welcome`, `#/login`, `#/link`, `#/link/:code`, `#/reset/:token` | Auth |
| `#/groups` | Groups list (active first; settled and archived collapsible) |
| `#/new-group` | Create group |
| `#/g/:gid` (+ `/balances`, `/stats`, `/settings`) | Group page with tabs |
| `#/g/:gid/add`, `#/g/:gid/e/:eid/edit` | Expense editor (full-screen sheet) |
| `#/g/:gid/e/:eid` | Expense detail (breakdown, comments, history) |
| `#/g/:gid/settle?from=&to=&amount=` | Settle up |
| `#/friends`, `#/f/:key` | Friends and friend detail |
| `#/add-friend` | Add friend |
| `#/activity` | Activity feed |
| `#/account` | Account and settings |
| `#/admin` | Owner tools |
| `#/join/:code`, `#/claim/:token` | Join flows |

### 8.3 Screens (behavior)
- **Home**: totals per currency (別人欠你 / 你欠別人, approximate total in my home currency from
  `/api/fx`), friends with non-zero balances (欠你 / 你欠), groups with my status (你可以拿回 /
  你要付 / 已結清), protect-your-account card for device-only accounts, the offer to turn on
  notifications (section 8.6), Add to Home Screen hint on iOS Safari (once, dismissible). Primary
  action: 新增費用 (asks which group or friend first).
- **Group page**: header (emoji, name, member avatars, currency, my status). Tabs:
  費用 (search box; month sections; rows show date, category icon, description, who paid what,
  my effect: 你借出 / 你借入 / 沒有參與 / payments as 「A 付給 B」; converted entries show the
  original amount and ≈ group-currency amount; pending-sync and failed states; recurring icon;
  comment count), 結算 (each member's net, the settle-up plan with 記錄還款 buttons and the
  receiver's payment info, simplify toggle with a one-line explanation, 分享結算 text via the Web
  Share API or clipboard, e.g. for LINE), 統計 (total spent, per person paid vs share, by category,
  by day for trips), 設定 (name, emoji, color, type, currency, simplify, notes, members, invite link
  with QR and share, claim links, export CSV, import Splitwise CSV, leave, delete).
- **Expense editor**: big amount input (calculator expressions allowed, shows the result), currency
  chip (group currency first, then recent, then all with search), description with automatic
  category (`detectCategory`) unless picked by hand, payer chip (default me; or one member; or
  多人付款 with amounts), split chip (default 平均分給全部 N 人) opening the split editor with
  methods 平均 / 金額 / 比例 / 份數 / 加減 / 品項 (live per-person preview, clear remaining or over
  messages), quick presets in 2-person groups (我付，平分 / 我付，對方全付 / 對方付，平分 / 對方付，我全付),
  date (今天 / 昨天 / pick), exchange-rate row when the currency differs from the group's (auto
  from `/api/fx` for that date, editable, shows the converted total), notes, repeat. Save works
  offline (outbox). After save: toast with 復原 (undo = delete). Editing an existing entry
  prefills everything. When adding an expense, 掃描 in the header fills the form from a receipt
  photo (section 8.7).
- **Expense detail**: amount, description, category, date, who added and when, payers, each
  member's share, conversion details, notes, repeat, comments (add, delete own), history
  (activity entries for this expense), 編輯 / 刪除 (with undo) / 復原 for deleted ones.
- **Settle up**: from and to pickers (default from the plan), amount (default the plan amount),
  currency (group currency default), date, note, the receiver's payInfo, and buttons that open
  Venmo (`https://venmo.com/<user>?txn=pay&amount=<x>`) or PayPal.me
  (`https://paypal.me/<user>/<x><CUR>`) when set.
- **Friends**: list with totals; friend page as in section 4.
- **Activity**: newest first, unread marked, each item says who did what and my effect
  ("你借出 ¥10,500"), tap opens the expense or group; loads more on scroll.
- **Account**: Add to Home Screen (iPhone) and right under it 通知 (section 8.6), name, color,
  language (中文 / English), home currency, payment info (Venmo, PayPal.me, free text), sign-in
  (add or change email and password), devices (sessions list with revoke; "在其他裝置登入" shows
  the link code and QR), export my data (JSON download), sign out (in cookie mode it needs a
  connection and says so offline, section 3), delete account, about.
- **Join / Claim**: as in section 4; after joining, open the group.

### 8.4 Offline and sync
- On start, render immediately from IndexedDB (me, groups, outbox), then refresh from the server.
- Outbox items (upsert, delete, restore, comment) are applied optimistically to the cached group,
  flushed in order when online (on `online`, on focus, every 15 s while pending), retried with
  backoff on network errors or 5xx or 429, marked failed on other 4xx (row shows 同步失敗 with
  重試 / 放棄).
- Polling: the open group every 20 s while visible (ETag, cheap 304), `/api/me` on focus and every
  60 s while visible.
- Offline banner: 「離線中，新增的費用會在連線後自動同步」.

### 8.5 PWA
`public/manifest.webmanifest` (name "吉諾分帳所 Gino's Split Lab", short_name "吉諾分帳所", display
standalone, scope "./", theme color from the design; deliberately NO start_url, so the Home Screen
app opens the page URL it was added from, which carries the one-time `?install=CODE` sign-in code
made by the account page: the installed app does not share Safari's storage or cookies), icons
192/512/maskable + apple-touch-icon 180. `public/sw.js` (`evenly-v5`), registered in `main.tsx`
with an update toast:
- Install: the shell (`/`) is fetched with `credentials: 'omit'`, so its answer never sets the
  session cookies, and each `assets/` file it references with `cache: 'no-cache'`; the install
  fails unless every answer is ok and not `text/html` (all or nothing), so a worker never goes live
  with a shell whose JS or CSS is missing. Icons, the manifest and the web fonts are cached too,
  without failing the install. Activate deletes every older cache (with it any API answer the
  evenly-v3 worker stored).
- Navigations: network first, the cached shell offline. A newer build's shell becomes the offline
  shell only once all its assets are cached; then the older assets are deleted.
- `assets/`: cache first, storing only the file itself (never an error or an HTML page in its
  place). Icons and manifest: stale while revalidate. Google Fonts: the stylesheet network first,
  the font files cache first.
- `/api/` (and any other origin): never intercepted or cached.
- Push: every push shows a notification (iOS requires one per push) from the payload, with its
  `tag` (one per group, renotify). A tap posts `{type: 'open', path}` to an open window of the app,
  which calls `navigate(path)` (app paths only) and keeps its state; with none open it opens
  `<scope>#<path>`. `pushsubscriptionchange` subscribes again with the old key but tells the API
  nothing (the worker cannot know which account wanted notifications here; the page's start sync
  links the subscription). `{type: 'version'}` is answered with
  `{type: 'version', version: 'evenly-v5', push: true}`, so the page offers notifications only once
  a worker with these handlers is in control.

### 8.6 Notifications (Web Push)
- `push.ts` `pushState()`: `needs-install` (iPhone or iPad Safari outside the Home Screen app: iOS
  gives Web Push only to the Home Screen app, 16.4 and later), `unsupported` (no service worker,
  PushManager or Notification: other iOS browsers, in-app browsers, older iOS, some private
  modes), `waiting-worker` (the worker in control does not answer the version ping with
  `push: true` within 2 s: evenly-v3, or none yet), `denied`, `off`, `on` (allowed, subscribed and
  wanted by this account).
- 開啟通知 (`enablePush()`, called straight from the tap): `Notification.requestPermission()`
  before anything awaits (Safari prompts only inside the tap); the VAPID key from
  `GET /api/push/status`, fetched before the tap;
  `pushManager.subscribe({userVisibleOnly: true, applicationServerKey})` (a subscription made with
  another key is dropped first); then `PUT /api/push/subscription` with the device's IANA time
  zone. If the PUT fails, a subscription made in that call is dropped again. 關閉這台裝置的通知
  (`disablePush()`): `unsubscribe()`, then `DELETE /api/push/subscription`, for this device only.
- One account per device: `localStorage['evenly.push.wanted']` holds the id of the account that
  tapped 開啟通知 here (set by the tap, also when the prompt is blocked or saving fails; removed by
  關閉這台裝置的通知). Only for that account does the device count as `on`, and only for it does the
  start sync link or make a subscription; someone else who signs in here starts with notifications
  off.
- Start sync (`startPushSync()` from `main.tsx` while signed in, and again when the app comes to the
  front with another permission than it left with): never prompts, never throws. Allowed and
  subscribed: PUT again, so the subscription follows the current session (a sign-in, a password
  reset, a token moved into the cookie); one made with an older server key is replaced. Allowed and
  none: subscribe again quietly (only while a worker with push handlers is in control). Blocked in
  Settings since: drop the subscription and keep the wish. A tap on 關閉 or a change of account
  during a sync stops it before it saves or makes anything.
- Leaving the device: when the session key goes null (signing out, the session ending) or another
  account signs in, the browser's subscription is dropped at once with `unsubscribe()` and no
  request. That works offline and also covers a session the server still holds (a Bearer sign-out
  that never reached it): the push service answers 404 or 410 and the sender deletes the row. The
  wish stays, so that account's next sign-in here subscribes again quietly.
- 我的 > 通知 (`features/account/NotificationsCard.tsx`, right under 加到主畫面) shows the state with
  what to do: iPhone Safari, 先加到主畫面 (scrolls to the 加到主畫面 card); blocked, where to allow it
  again (Settings > 通知 > 吉諾分帳所 in the Home Screen app, else the device or site settings);
  waiting-worker, 更新; off, 開啟通知 (disabled when the server sends an empty key); on, the
  switches 記帳 / 還款 / 有人加入 (`PUT /api/push/prefs`, for the whole account), 收到通知的裝置 N 台,
  傳送測試通知 (5 an hour) and 關閉這台裝置的通知. Other states add 「你有 N 台其他裝置會收到通知」 when
  the account's other devices have push.
- 總覽 offer (`features/home/PushCard.tsx`): shown while the state is `off`, the account is in a
  group (pair ledgers count), and `localStorage['evenly.pushCard.hidden']` is not `1` (its close
  button sets it). Its button calls `enablePush()` directly; a blocked prompt shows a toast with
  怎麼打開 (opens 我的). It never shows together with the compact 加到主畫面 card (iPhone Safari is
  `needs-install`, and the Home Screen app has no install card).

### 8.7 Receipt scan (掃描)
Reading only: the photo is sent once, read by Workers AI and dropped (section 6).
- 掃描 / Scan (camera icon) sits in the expense editor header's empty right cell, only when adding
  an expense (not editing, not payments); icon only under 360 px; no new row. Offline it is
  aria-disabled and a tap says 「離線中不能掃描收據，連線後再試」.
- A tap opens a hidden `<input type="file" accept="image/*">` without `capture` (iPhone offers the
  camera and the photo library). The photo is shrunk in the browser (`createImageBitmap` with the
  EXIF orientation, canvas, JPEG 0.85, long side at most 1600 px, which also drops EXIF and GPS)
  and never put in the draft, the stash, IndexedDB or a log. Then `POST /api/receipts/scan` with
  the form's currency as the hint and a 60 s timeout. While it reads: a spinner and 讀取中; tapping
  again or leaving the editor stops it.
- The answer is applied in one step (`editorLogic.applyScan`, one exchange-rate fetch): an open
  sheet is closed first, and fields the person changed while it was reading are kept. The currency
  comes first (the currency picker's rules), then the printed total, the date if it is within the
  last 90 days (or tomorrow), the store name into an untouched description with its category (a
  category picked by hand stays), and the lines into `split.items` without changing the split
  method (when it already is 品項, the split sheet opens so people say who had each line). A dialog
  asks before it replaces 品項 lines someone typed (換掉 / 保留我的). If the person picked another
  currency while it was reading, the amounts are left out. A second scan replaces what the earlier
  one filled (lines, store name, category) while the form still shows it.
- A toast says what was filled in and where the lines went, what to check (the editor's notes and
  the Worker's `warnings`) and, the first time on a device, 「照片只用來辨識，不會存起來」. Its 復原
  (`revertScan`) puts back only the fields that still show the scan; anything typed since the scan
  (an amount, a 品項 line, a payer's or a person's amount, a rate) was typed in the scan's currency,
  so then the currency and the scan's amounts stay, and a second toast says why.
- Errors (`editorText.scanErrorText`): each 429 scope (`user`, `app`, `ai`), each `scan_failed`
  reason, offline, timeout, a photo that cannot be opened, too large, not a photo.

### 8.8 Build and deploy
- `npm run deploy:staging` and `npm run deploy` run `scripts/deploy.sh staging|production`.
  Production refuses uncommitted changes unless `ALLOW_DIRTY=1`. Never run a bare
  `wrangler deploy`: `[assets]` uploads whatever `dist/` holds.
- Build (`scripts/build-web.sh`, also `npm run build:site`): a same-origin app (`BASE_PATH=/`,
  `VITE_API_BASE=same-origin`) in an emptied `dist/`, plus `dist/version.json`
  `{commit, dirty, builtAt}`. It fails without `index.html`, `sw.js`, `_headers`,
  `privacy/index.html` and `support/index.html` (the privacy and support pages, plain HTML in
  `public/`), or when a bundle names `workers.dev` or `127.0.0.1`.
- Pending D1 migrations stop the deploy unless `MIGRATE=1` (then they are applied first); then
  `wrangler deploy [--env staging]` uploads the Worker together with `dist/`.
- Smoke checks on the deployed site, 5 tries each: `/api/health` names the environment,
  `/version.json` the commit, `/api/health` opened as a page is still JSON, `/` is the app, a
  missing `/assets/` file is 404, `/privacy/` and `/support/` are pages. Production checks
  https://evenly-api.richlovegod.workers.dev/ unless `SMOKE_URLS` names other sites.
- `public/_headers`: `/assets/*` immutable for a year, `/sw.js` no-cache, every file nosniff,
  `strict-origin-when-cross-origin` and `X-Frame-Options: DENY`. The Worker's own answer for `/`
  sets the same three plus `Cache-Control: private, no-cache` and, on https, HSTS.
- After a production deploy, `node tests/e2e/prod-smoke.cjs [site]` signs up a throwaway account
  and deletes it again. It signs up nothing unless `/api/health`, from Node and from the loaded
  page, says `EXPECT_ENV` (default `production`), sends a Bearer cleanup to the origin that
  answered the signup, and checks that `GET /api/push/status` hands out the `VAPID_PUBLIC_KEY`
  that `wrangler.toml` lists for that environment.
- Cutover and rollback (the steps: README, "Cutover and rollback"). The cutover is a deploy.sh
  run with the top-level `routes = [{ pattern = "split.ginochang.com", custom_domain = true }]`
  (staging keeps `routes = []`); without a terminal, wrangler replaces the DNS-only `split` CNAME
  without asking. After the old record's TTL (5 minutes), production deploys pass
  `SMOKE_URLS="https://split.ginochang.com/ https://evenly-api.richlovegod.workers.dev/"`, then
  prod-smoke runs on split.ginochang.com.
- Roll forward, or `wrangler rollback <version-id>` only to versions deploy.sh deployed from the
  first one with `[assets]` on (README records its id). Never roll back past it while the custom
  domain is attached: older versions have no `[assets]` (`/` is a JSON 404), read only Bearer
  (open cookie tabs sign out), and run `runDaily` on every cron event, the minutely one
  included, which a rollback keeps (triggers are not versioned).
- Back to GitHub Pages: deploy without the `routes` line and with `crons = ["0 9 * * *"]` (stops
  the push sender; removing the line does not detach the domain, but left in, the next deploy
  would attach it again), detach the domain (Workers & Pages > evenly-api > Settings > Domains &
  Routes, or the Workers Domains API), recreate the CNAME `split` -> `richlovegod.github.io`
  (DNS only), check GitHub's certificate for split.ginochang.com, and keep workers.dev on for the
  iOS app and older builds.

## 9. Vocabulary (use consistently)
| zh-TW | English |
|---|---|
| 總覽 | Home |
| 群組 | Groups |
| 朋友 | Friends |
| 動態 | Activity |
| 我的 | Account |
| 新增費用 | Add expense |
| 結清 / 記錄還款 | Settle up / Record a payment |
| 你借出 ¥X | you lent ¥X |
| 你借入 ¥X | you borrowed ¥X |
| 沒有參與 | not involved |
| A 付給 B ¥X | A paid B ¥X |
| 欠你 ¥X | owes you ¥X |
| 你欠 ¥X | you owe ¥X |
| 你可以拿回 ¥X | you get back ¥X |
| 你要付 ¥X | you owe ¥X |
| 已結清 | settled up |
| 付款人 | Paid by |
| 分法 | Split |
| 平均 / 金額 / 比例 / 份數 / 加減 / 品項 | Equally / Exact amounts / Percentages / Shares / Adjustment / By item |
| 簡化債務 | Simplify debts |
| 匯率 | Exchange rate |
| 重複：不重複 / 每週 / 每兩週 / 每月 / 每年 | Repeat: never / weekly / every 2 weeks / monthly / yearly |
| 邀請連結 | Invite link |
| 收款方式 | How to pay me |
| 等待同步 / 同步失敗 | Waiting to sync / Sync failed |

## 10. Out of scope for v1
Email notifications; push notifications for edits, deletes and restores of entries already
announced, for comments and for recurring copies; quiet hours (the device's time zone is stored for
them); a per-group mute (the three kinds switch off for every group at once); storing receipt
photos (no R2: a scan reads the photo once and drops it); passkeys, real-time sockets, non-group
expenses with several friends at once (use a group). A native iOS app is built in its own repo
(evenly-ios) on the Bearer API; it links to `public/privacy/` and `public/support/` here, the only
copy of those pages.
