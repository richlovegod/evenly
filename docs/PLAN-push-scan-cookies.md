# Plan: push notifications, receipt scan, and cookie sessions on one origin

Status (2026-10-17): built and reviewed. docs/SPEC.md (sections 1, 3 to 8 and 10) and
docs/WORKER.md now describe the system as built; where this plan and the code differ, the code is
right. These parts of the design changed during the build and the review:

- Cookies are renewed only on top-level page loads of `/` and `/index.html`, not in the hourly
  touch of API answers (1.1 step 5): WebKit caps a cookie that a fetch answer sets to 7 days when
  the connection went to another of the site's addresses. So `run_worker_first` is
  `["/api/*", "/", "/index.html"]`, and the service worker (now `evenly-v5`) installs without
  cookies.
- `not_found_handling = "none"` instead of the SPA fallback: a missing `/assets/` file is a 404,
  never index.html with the year-long immutable header. `scripts/deploy.sh` checks that, and the
  service worker stores only real asset files.
- The token is not deleted once the cookie holds the session (1.2): it stays in localStorage as a
  copy (`evenly.tokenUser` names its account) and is sent only when the cookies are gone.
- Logout in cookie mode treats 401 `session_changed` as an error, not as already signed out.
- Push sender: a group that does not fit the run's budget sends what fits and keeps the rest in
  `push_pending` (migration 0003) for the next runs, instead of giving its rows back (2.2 step 6).
  Groups nobody can hear are cleared without a claim, due groups take turns by the account that
  wrote them, and only members linked when the event happened hear about it. Linking accounts by
  email is limited to 30 a day per account (429 scope `links`).
- Push on the web: the start sync links or makes a subscription only for the account in
  `evenly.push.wanted` (2.3 said whenever permission is granted), the browser's subscription is
  dropped when the account leaves the device, and `pushsubscriptionchange` no longer calls the API.
- Receipts: `?model=` is the owner's only, in every environment; staging has
  `RECEIPT_GLOBAL_PER_DAY = "40"` instead of `RECEIPT_PER_DAY = "200"`; the Worker waits 55 s for
  the model and the app 60 s (3.2 said 45 s); the image comes before the text in the user message;
  the hint is the form's currency, not the group's; a second scan replaces what the first one
  filled; 復原 keeps the currency when numbers were typed after the scan.

Still to do: the production deploy (from a commit, migrations 0002 and 0003 first) and the cutover
of split.ginochang.com to the Worker (wrangler.toml has no route for it yet). The notes in
docs/notes/ keep the measurements and the open points; some of their lines predate the review.

Written 2026-10-17 for the four implementation agents. Gino asked for all three; this file is
the contract between them. When the work is merged, the API rows move into docs/SPEC.md and the
Worker notes into docs/WORKER.md, and this file stays as the design record.

Facts behind the design were checked in official docs (Cloudflare, WebKit, Apple, RFCs) on
2026-10-17. The ones the code depends on are quoted where they matter.

## 0. Ground rules for every agent

- Repo: `C:\Users\chunju\evenly`. React 19 + Vite SPA (hash routing) in `src/web`, Cloudflare
  Worker (Hono 4) + D1 in `src/worker`, shared TypeScript in `src/shared`, tests in `tests/`.
- Match the surrounding code: comment density, naming, idiom. UI text goes through
  `t(zh, en)`. Chinese is Traditional (zh-TW) only. No em dashes or en dashes anywhere (a hook
  rejects them). US spelling in English.
- The app's name is 吉諾分帳所 (zh) / Gino's Split Lab (en), from `src/web/lib/brand.ts`. The
  code name evenly stays in code, storage keys and the Worker name.
- Money is stored in integer minor units with the app's own decimals table
  (`src/shared/currencies.ts`; TWD and JPY have 0 decimals here).
- Workers Free plan limits apply to every invocation, cron and `ctx.waitUntil` work included:
  10 ms of CPU, 50 subrequests (each `fetch`, and each D1 call; a `db.batch` is one call),
  30 s of `waitUntil` after the response, 100,000 requests a day. Waiting on network or D1 does
  not count as CPU. Encryption and big string work does.
- Route modules mounted at `/api` attach `requireUser` per route, never `use('*', ...)` (see the
  comment at `src/worker/routes/expenses.ts:1004`).
- A 401 makes the web client sign out. Never answer 401 for anything but "this session is not
  valid" (and `session_changed`, section 1). Use 403 for CSRF failures, 400 for wrong input.
- Do not deploy, do not run `wrangler deploy`, `wrangler secret`, or anything against remote
  D1, and do not push to git. Claude deploys, migrates and pushes after review. You may run
  `npx tsc -p tsconfig.json --noEmit`, `npx tsc -p tsconfig.worker.json --noEmit`,
  `npx vitest run`, `npx vite build` and local scripts.
- Never print, log or commit a token, a private key, a push endpoint in full, a receipt image
  or a receipt's text.
- One writer per file (section 4). If you need a change in a file you do not own, put it in your
  final report instead of editing it.
- Write your notes for docs (new endpoints, behavior, limits) into `docs/notes/<area>.md`
  (`sessions.md`, `push.md`, `receipts.md`); Claude folds them into SPEC.md and WORKER.md.

Already done by Claude before you start (read, do not rewrite):

- `wrangler.toml`: `[assets]` (directory `./dist`, binding `ASSETS`, SPA fallback,
  `run_worker_first = ["/api/*"]`), `[ai] binding = "AI"`, VAPID public keys and subject per
  environment, the minutely cron `* * * * *` next to the daily one (production only), staging
  `routes = []`, staging `APP_URL = https://evenly-api-staging.richlovegod.workers.dev/`,
  `PUSH_HOLD_SECONDS = "0"` and `RECEIPT_PER_DAY = "200"` on staging. The production custom
  domain route is added by Claude at cutover.
- Secrets `VAPID_PRIVATE_JWK` (staging and production) are set. Format:
  `{"kty":"EC","crv":"P-256","d":"...","x":"...","y":"..."}`.
- `src/worker/env.ts`: `ASSETS`, `AI`, `VAPID_*`, `PUSH_HOLD_SECONDS`, `RECEIPT_*`, and
  `AuthUser.via: 'bearer' | 'cookie'`.
- `src/shared/types.ts`: new `ApiErrorCode` values `session_changed`, `already_signed_in`,
  `scan_failed`; `PushPrefsDTO`, `PushSubscriptionReq`, `PushStatusRes`, `PushTestRes`,
  `PushPayload`, `ReceiptScanReq`, `ReceiptScanDTO`.
- `public/sw.js` (evenly-v4): `/api/` is never intercepted or cached; the old catch-all cache is
  now only icons and the manifest; push, notificationclick and pushsubscriptionchange handlers;
  a `{type: 'version'}` message answered with `{type: 'version', version: 'evenly-v4', push: true}`.
- `src/worker/index.ts`: mounts `pushRoutes` (`./routes/push`) and `receiptRoutes`
  (`./routes/receipts`), lets `/api/receipts/scan` bodies up to `RECEIPT_MAX_BYTES` (exported by
  `./routes/receipts`) past the 256 KB gate, and runs `runPushSender(env)` (from
  `./services/push`) for the `* * * * *` cron and `runDaily(env)` for the daily one.

## 1. One origin and a cookie session (agent A)

Why: Safari deletes all script-writable storage (localStorage, IndexedDB, service worker) of a
site that was not used for 7 days of browser use, so name-only accounts held by a token in
localStorage can vanish. A cookie the server sets in an HTTP response, on the same origin and
the same IP as the page, is not capped. So the Worker serves both the app (static assets) and
`/api` on `https://split.ginochang.com`, and the session moves into an HttpOnly cookie.

### 1.1 Worker

- Two cookies, both set and cleared only by the Worker, with hono/cookie and `prefix: 'host'`
  (forces `Secure`, `Path=/`, no `Domain`, so sibling `*.ginochang.com` sites cannot plant or
  overwrite them):
  - `__Host-evenly_session=<the same 43-character token createSession returns>`; HttpOnly;
    SameSite=Lax; Max-Age=31536000 (SESSION_DAYS; Hono refuses more than 400 days).
  - `__Host-evenly_user=<user id>`; not HttpOnly; same attributes. A marker the page reads
    synchronously at boot, so it knows who is signed in with no request and offline.
- `sameOrigin(c)`: `Sec-Fetch-Site` equals `same-origin` when the header is present; otherwise
  `Origin` equals `new URL(c.req.url).origin`. Neither header means not same-origin.
- `resolveUser` (`src/worker/auth.ts:141`):
  1. An `Authorization` header is present: today's Bearer path, unchanged, `via: 'bearer'`.
     Never fall back to the cookie.
  2. Otherwise read the session cookie, check `/^[A-Za-z0-9_-]{20,200}$/`, same SHA-256 lookup,
     `via: 'cookie'`. A cookie naming a missing or expired session: clear both cookies on this
     response, and treat the request as signed out.
  3. Cookie requests with a method other than GET, HEAD and OPTIONS that are not
     `sameOrigin(c)`: 403 `forbidden`. (SameSite=Lax still sends the cookie from same-site
     siblings such as award.ginochang.com, and `readJson` parses text/plain bodies.)
  4. A cookie request with `X-Evenly-User` that differs from the session's user: 401
     `session_changed` (another tab switched accounts). Do not clear the cookies.
  5. In the hourly touch branch, re-send both cookies when `via` is cookie, so the browser
     expiry slides with `expires_at`.
- `startSession(c, userId, label)` = `createSession` plus both cookies when `sameOrigin(c)`.
  Use it in signup, login, link and reset (`src/worker/routes/auth.ts:122, 139, 229, 278`).
  `AuthRes.token` keeps the token for every caller (the client keeps Bearer only if cookies
  turn out to be blocked).
- Login, link and reset that arrive with a live session cookie delete that previous session row
  after creating the new one (the device is switching or signing in again).
- `POST /api/auth/signup` with a live session cookie: 409 `already_signed_in`,
  `details: { userId }`. The client adopts that session instead of making a second account
  over it (a lost name-only account cannot be recovered).
- `POST /api/auth/cookie` (new): requires a Bearer session and `sameOrigin(c)`; sets both
  cookies to the presented token without a new session row (safe when tabs race); returns
  `{ user: UserDTO }`. This adopts tokens that devices still hold in localStorage.
- Clear both cookies in: `POST /api/auth/logout`, `DELETE /api/auth/sessions/:id` when the id is
  the current session, `DELETE /api/me`, and any response that found a dead cookie.
- `src/worker/index.ts`: send `Vary: *` on every `/api` response except `GET /api/fx` (keep
  `Vary: Origin` there). The evenly-v3 service worker still installed on phones caches every
  same-origin GET; `Cache.put` throws on `Vary: *` (checked in WebKit), so it cannot store API
  answers during the handover. Keep the CORS block exactly as it is for old app builds that call
  `https://evenly-api.richlovegod.workers.dev` cross-origin with Bearer, add `X-Evenly-User` to
  the allowed headers, and never send `Access-Control-Allow-Credentials`.

### 1.2 Web client

- `src/web/config.ts`: `VITE_API_BASE` of `same-origin` or `/` means `API_BASE = ''`. Default:
  `import.meta.env.DEV` builds keep the staging URL; production builds default to same origin.
  `localStorage['evenly.api']` still wins (tests and dev). Export
  `AUTH_MODE: 'cookie' | 'bearer'`: cookie when `API_BASE` is `''` or its origin equals
  `location.origin`.
- `src/web/lib/api.ts`, cookie mode: `credentials: 'same-origin'`; `Authorization` only while a
  legacy token is still being adopted; `X-Evenly-User: <current user id>` on calls that are not
  anonymous; before such a call, if the marker cookie no longer names that user, do not send and
  call the session-changed handler. A 401 `session_changed` calls `onSessionChanged` (reload,
  with a sessionStorage counter against reload loops). Any other 401 while signed in calls
  `onUnauthorized` as today. Bearer mode is unchanged.
- `src/web/lib/store.ts`: keep the field name `State.token`, but in cookie mode it holds an
  opaque session key `cookie:<userId>:<n>` (so every `!!st.token` check and every
  compare-across-await keeps its meaning without touching other files). Boot, synchronous:
  1. The marker names user U: signed in as U, offline included. Keep cached `me` and groups
     only if they are U's; hold other accounts' outbox items (existing logic).
  2. No marker, but `evenly.token` exists: signed in with Bearer as today; adopt when online.
  3. Neither: signed out, Welcome, no probe.
  4. Standalone with `?install=CODE`: if 1 applies skip the code, else exchange it first.
- Adopting a legacy token: under `navigator.locks` `evenly-session`, `POST /api/auth/cookie`
  with Bearer; then a cookie-only `GET /api/me` (anonymous, so a 401 does not sign out). Both
  200: delete `evenly.token`, switch the session key, announce `{type: 'session'}` on the bus.
  Adopt 401: the token was dead (handleUnauthorized). Cookie check fails: cookies are blocked,
  keep Bearer on this device and set `localStorage['evenly.auth'] = 'bearer'`.
- After signup, login, link or reset in cookie mode, do the same cookie check before dropping
  the token from memory; fall back to Bearer (persisted) when cookies are blocked.
- Signup answered 409 `already_signed_in`: adopt the cookie session (load `me`), `restoreHeld`,
  continue as that user (Welcome goes Home; Join and Claim proceed).
- Logout in cookie mode must reach the server: rethrow offline, 5xx and 429; a 401 means
  already signed out. `AccountActions.tsx` shows that signing out needs a connection.
- Tabs: announce `{type: 'session'}` after sign-in, sign-out and adopt; on that message and on
  `visibilitychange`, reload when the marker user differs from this tab's user.
- `InstallCard.tsx` copy no longer promises that Safari keeps the sign-in (it now does anyway).
  New promise: it opens like an app, keeps working offline, and can show notifications:
  「加到主畫面後，就像 App 一樣打開，離線也能用，還能收到通知」 /
  "On your Home Screen it opens like an app, works offline, and can send you notifications."
  Adjust the other lines of that card to match.

### 1.3 Build and deploy

- `scripts/build-web.sh`: same-origin build (`BASE_PATH=/`, `VITE_API_BASE=same-origin`) into
  `dist/` with `--emptyOutDir`; fail if `dist/index.html`, `dist/sw.js` or `dist/_headers` is
  missing, or if `dist/assets/*.js` contains `workers.dev` or `127.0.0.1`; write
  `dist/version.json` `{commit, dirty, builtAt}`.
- `scripts/deploy.sh staging|production`: build; stop when `wrangler d1 migrations list`
  shows pending migrations unless `MIGRATE=1` (then apply them); `wrangler deploy [--env
  staging]`; smoke checks: `/api/health` answers the environment, `/version.json` the commit,
  `/api/health` with `Sec-Fetch-Mode: navigate` is JSON, `/` contains `id="root"`. Keep
  `MSYS_NO_PATHCONV=1` for Git Bash.
- `package.json`: `deploy` and `deploy:staging` run that script; drop `api:deploy*` (a bare
  `wrangler deploy` would upload a stale `dist/`).
- `public/_headers`: `/assets/*` `Cache-Control: public, max-age=31536000, immutable`; `/sw.js`
  `Cache-Control: no-cache`; for `/*`: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`. Rules must not
  set the same header twice for one path.
- `scripts/deploy-web.sh`: retire it (print why and exit 1). gh-pages must stay as it is: its
  CNAME file keeps GitHub's 301 from `richlovegod.github.io/evenly/*` to the new address.
- README deploy and test sections.

### 1.4 Tests

- `tests/worker/cookie-session.test.ts` on the `worker.fetch` harness (see
  `tests/worker/admin-users.test.ts:131`) with `https://split.test` URLs: same-origin signup sets
  both cookies; cross-origin signup sets none and returns the token; cookie POST from another
  origin or `Sec-Fetch-Site: same-site` is 403; Bearer wins over a cookie; `session_changed`;
  signup over a live cookie is 409; logout, revoke-current and `DELETE /me` clear both cookies;
  a dead cookie is cleared; the hourly touch re-sends the cookies; `POST /api/auth/cookie`.
- `tests/e2e/cookie-flows.cjs` (WebKit, iPhone 14) against the staging site
  `https://evenly-api-staging.richlovegod.workers.dev/` (Claude runs it after deploying):
  signup sets the HttpOnly session cookie and the marker, and localStorage has no `evenly.token`;
  delete localStorage, IndexedDB, Cache Storage and the service worker, reload, still Home;
  a seeded legacy `evenly.token` is adopted and removed; sign-out clears the cookies; a second
  tab signing in as someone else makes the first tab reload; no `/api/` URL in any cache.
- `tests/e2e/prod-smoke.cjs`: same-origin page fetches with the cookie for its checks and its
  cleanup; assert no `evenly.token` in localStorage.
- `tests/api/api-test.mjs` and `tests/e2e/flows.cjs` must keep passing unchanged (Bearer,
  cross-origin through `evenly.api`).

## 2. Push notifications (agent B: Worker, agent C: web)

What notifies (Gino's list): a friend adds an expense you are part of; a payment to or from
you; someone joins a group you are in or adds you to one. Never the person who made the change,
never members without an account or who left.

### 2.1 Contract

| Method and path | Who | Body | Answer |
|---|---|---|---|
| GET /api/push/status | user | | `PushStatusRes` |
| PUT /api/push/subscription | user | `PushSubscriptionReq` | `{ ok: true, devices }` |
| DELETE /api/push/subscription | user | `{ endpoint }` | `{ ok: true }` |
| PUT /api/push/prefs | user | `Partial<PushPrefsDTO>` | `PushPrefsDTO` |
| POST /api/push/test | user, 5 an hour | | `PushTestRes` (sends now) |
| POST /api/push/run | owner, or any user when ENVIRONMENT is not production | | `{ groups, sent, removed, failed }` (runs the sender now) |

The service worker (already written) expects the decrypted payload to be `PushPayload`
`{ title, body, path, tag }`. `path` is a hash route (`/g/<gid>/e/<eid>`, `/g/<gid>`). On a tap
it posts `{ type: 'open', path }` to an open window of the app, or opens `<scope>#<path>`.

### 2.2 Worker (agent B)

- `migrations/0002_push.sql`:
  - `ALTER TABLE activity ADD COLUMN push_at TEXT;` (the event time for rows that may push, NULL
    otherwise and after sending) and a partial index on it.
  - `push_subscriptions`: id (SHA-256 hex of the endpoint), user_id (users, cascade),
    session_id (sessions, cascade: sign-out, revoking a device, a password reset and session
    expiry stop that device's pushes), endpoint, p256dh, auth, tz, label (deviceLabel of the
    User-Agent), created_at, last_ok_at, failures. Index on user_id.
  - `ALTER TABLE users ADD COLUMN notify_prefs TEXT NOT NULL DEFAULT '{}';` (missing keys mean
    true).
  - Load every migration in order in `tests/worker/d1-sqlite.ts`.
- `src/worker/services/activity.ts`: write `push_at` from a policy function of type and data
  in `activityValues` (the one funnel of all 18 activity inserts, so the push intent commits or
  rolls back with the change and no batch gets an extra statement). `push_at = now` for
  expense.create, expense.update, expense.delete, expense.restore (the last three only so the
  sender can merge or cancel), member.join, member.claim, member.add, group.create, and the
  import row (group.update whose `changes[0].field` is `import`). NULL for everything else,
  including recurring.create and comments in this version.
- `src/worker/services/webpush.ts`: RFC 8291 aes128gcm encryption and RFC 8292 VAPID (ES256 JWT,
  `Authorization: vapid t=<jwt>, k=<public key>`, exp at most 24 h; cache the JWT per push
  service origin for about 12 h). WebCrypto only, no new dependency. Test it against the
  RFC 8291 Appendix A example (fetch the RFC; copy the vector exactly) and with a round trip
  that decrypts with the receiver's private key. Headers: `Content-Encoding: aes128gcm`,
  `TTL: 86400`, `Urgency: normal` (`low` for the import summary). Keep payloads well under
  4 KB.
- `src/worker/services/push.ts`: `runPushSender(env, now?)`, used by the cron and
  `/api/push/run`.
  1. Due groups: rows with `push_at` older than the hold (`PUSH_HOLD_SECONDS`, default 30) when
     the group's newest pending row is that old, or when its oldest is 4 minutes old.
  2. Claim a group's rows with `UPDATE ... SET push_at = NULL ... RETURNING` so no row is sent
     twice, then load members, users (locale, notify_prefs) and subscriptions in one `db.batch`.
  3. Merge by expense_id: create then delete (an undo) sends nothing; create then edits sends one
     "added" with the last values; rows without a create in the set send nothing in this version.
  4. Recipients: active members with an account, not the actor. Expenses: members in
     `data.nets` (payers and people with a share). Payments: the sender and the recipient (read
     them from the expense row when nets are zero). member.join and member.claim: everyone else.
     member.add: the added account only. group.create: the linked others. Import: one summary per
     member. Respect prefs (`expenses` covers expenses and the import summary, `payments`
     payments, `joins` joins, adds and new groups).
  5. One notification per recipient per group per run: one item gets its sentence, several get
     a summary (「Abbie 新增了 3 筆費用」 / "Abbie added 3 entries"). Title: the group's emoji and
     name, 兩人帳本 / Friend ledger for pair groups. Body: the feed's sentence and, for expenses and
     payments, the effect line. Wording and spacing follow `src/web/features/activity/activityText.ts`
     and `src/web/components/Money.tsx` (examples in section 2.4), written on the server in the
     recipient's locale with `formatMoney` from `src/shared/money.ts`. `tag: 'g:<gid>'`, `path`
     as in 2.1.
  6. Budget: at most `PUSH_MAX_PER_RUN` messages (default 12, tune after measuring CPU on
     staging) and stay well inside 50 subrequests and 50 D1 calls. When a group does not fit,
     give its rows their `push_at` back and stop.
  7. 404 or 410 from the push service: delete the subscription. Other failures: count them,
     delete after 5 in a row. Success: `last_ok_at`.
- `src/worker/routes/push.ts` (exports `pushRoutes`): the endpoints in 2.1. Endpoint hosts
  allowed: `*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`,
  `push.services.mozilla.com`, `*.notify.windows.com`; https only. Keys: p256dh decodes to 65
  bytes starting 0x04, auth to 16 bytes. At most 10 subscriptions per account (drop the oldest).
  Upserting an endpoint that belongs to another account moves it (the device changed account).
  `session_id` is the caller's session.
- Tests: `tests/worker/webpush.test.ts`, `tests/worker/push-sender.test.ts` (policy, merge rules,
  recipients, prefs, text in both languages, budget, 410 cleanup; stub `fetch`),
  `tests/worker/push-routes.test.ts`. Add `tests/api/push-test.mjs` for staging (subscribe with
  a generated key pair to an allowed host is not possible without a real browser, so test
  validation, prefs, status and the run endpoint; Claude runs it).

### 2.3 Web (agent C)

- `src/web/lib/push.ts`: `pushState()` one of `needs-install` (iPhone or iPad Safari, not the
  Home Screen app), `unsupported`, `waiting-worker` (the active worker does not answer the
  version ping with `push: true`), `denied`, `off`, `on`. `enablePush()` must run inside the tap:
  fetch `GET /api/push/status` before the tap (the public key), then in the tap call
  `Notification.requestPermission()` first, then `pushManager.subscribe({ userVisibleOnly: true,
  applicationServerKey })`, then `PUT /api/push/subscription` with the device's time zone.
  `disablePush()` unsubscribes and sends DELETE. `syncPush()` at start when signed in: permission
  granted and a subscription exists, PUT it (re-links it to this session after a password reset
  or a new sign-in); granted and none, subscribe again quietly if the browser allows it.
- `src/web/lib/pwa.ts`: listen for `{ type: 'open', path }` from the worker and `navigate(path)`;
  export a `swVersion()` ping (MessageChannel, short timeout).
- `src/web/main.tsx`: start `syncPush` once signed in.
- 我的: a 通知 card (`features/account/NotificationsCard.tsx`) in `AccountPage.tsx`: the state
  above with what to do (iPhone: add to the Home Screen first, with a link to that card; denied:
  where to turn it back on in Settings); on: toggles for 記帳 / 還款 / 有人加入 (prefs),
  「傳送測試通知」, 「關閉這台裝置的通知」, and how many devices get notifications.
- 總覽: a small dismissible card that offers notifications when the state is `off`, the person has
  a group, and the card was not dismissed (`evenly.pushCard.hidden`); its button calls
  `enablePush()` directly.
- Picture-book style (`design/PICTUREBOOK.md`), existing components, `t(zh, en)`.
- Tests: `tests/web/push-client.test.ts` for the pure parts (key decoding, state decisions).

### 2.4 Wording (from the events map; Gino may adjust)

- New expense, you are part of it: 「Abbie 新增了「燒肉晚餐」 ¥12,600」 then 「你借入 ¥3,150」 (or
  你借出 ¥X, 剛好平衡). English: `Abbie added "Korean BBQ dinner" (¥12,600)` then
  `You borrowed ¥3,150` (or `You lent ¥X`, `Even`).
- Payment, sender recorded it: 「Leo 記錄了付給你的還款」 / 「你收到 NT$500」; English `Leo recorded a
  payment to you` / `You received NT$500`. Recipient recorded it: 「Leo 記錄了你的還款」 /
  「你付出 NT$500」. A third person: 「Kevin 記錄了還款：Leo 付給你」.
- Joined: 「Abbie 加入了群組」. Added you: 「Gino 把你加進了群組」. New group: 「Gino 建立了群組，也把
  你加了進去」. Pair ledger: 「Gino 開始了跟你的兩人帳本」.
- Several: 「Abbie 新增了 3 筆費用」; import: 「Gino 匯入了 500 筆費用」.

## 3. Receipt scan (agent D)

Only reading for now: the photo is sent once, read, and dropped. Nothing is stored (no R2).

### 3.1 Worker

- `src/worker/routes/receipts.ts` exports `receiptRoutes` and `RECEIPT_MAX_BYTES` (3 MiB).
  `POST /api/receipts/scan` (user): body `ReceiptScanReq` read with its own size check (not
  `readJson`, which stops at 256 KB). `image` must start with `data:image/jpeg;base64,`,
  `data:image/png;base64,` or `data:image/webp;base64,`. Do not run a regex over the whole
  base64 string (CPU).
- Limits: `RECEIPT_PER_DAY` per account (default 30) and `RECEIPT_GLOBAL_PER_DAY` for the whole
  app (default 300), with `rateLimit` (fixed daily windows).
- Model: `RECEIPT_MODEL`, default `@cf/google/gemma-4-26b-a4b-it` (Cloudflare lists multilingual
  OCR for it; it stays on the Free plan). The owner, or anyone on staging, may pass `?model=`
  to compare `@cf/qwen/qwen3.8-27b` and `@cf/meta/llama-4-scout-17b-16e-instruct`.
- Call (Gemma 4 and Qwen 3.8, OpenAI style): `messages` with a system prompt and a user message
  whose content is `[{type: 'text', text}, {type: 'image_url', image_url: {url: dataUrl}}]`;
  `response_format: {type: 'json_schema', json_schema: {name: 'receipt', schema, strict: true}}`;
  `chat_template_kwargs: {enable_thinking: false}` (Qwen also `reasoning_effort: 'low'`);
  `max_tokens` about 1500; `temperature: 0`. Llama 4 Scout takes `response_format` with
  `json_schema` set to the schema itself. Accept `{choices: [{message: {content}}]}` and
  `{response: string | object}` answers. "JSON Mode couldn't be met" is a `scan_failed`.
- The prompt asks for: the store name; the date converted to the Gregorian calendar (民國 115 年 =
  2026, 令和 8 年 = 2026); the ISO currency (NT$ or a Taiwan invoice is TWD, ¥ on a Japanese
  receipt is JPY, use the hint when only a symbol is printed); the final amount paid (合計,
  ご請求額, 總計, 應付金額, Total) with tax, service and tip included; line items as printed after
  per-line discounts, without subtotal, tax, change, cash tendered or card lines; tax and tip or
  service charge separately; plain numbers in major units with no grouping; a category key from
  the list in `src/shared/categories.ts` (never `payment`).
- `src/worker/services/receipt.ts` (pure, tested): normalize the model's answer to
  `ReceiptScanDTO` (trim and clip text, validate the date and the currency against
  `src/shared/currencies.ts`, refuse a fraction for 0-decimal currencies, drop subtotal or total
  lines that slipped into items, cap 50 items and 60-character names), and add `warnings` in the
  request's locale (items do not add up to the total, the date looks wrong, the currency was a
  guess).
- `usage`: neurons from the token counts with the per-model rates (Gemma 4: 9,091 per million
  input and 27,273 per million output tokens; Qwen 3.8: 40,909 and 290,909; Llama 4 Scout:
  24,545 and 77,273).
- Errors: our limits and the AI daily limit (Workers AI code 3036) are 429 `rate_limited` with
  `details.scope` `user`, `app` or `ai`; anything else from the model is 502 `scan_failed`.
- Tests: `tests/worker/receipt.test.ts` with a fake `env.AI` (canned answers in every shape,
  failures, limits) and the normalizer cases.

### 3.2 Web

Follow the editor map (summarized here; details in `src/web/features/expenses/editorLogic.ts`
and `ExpenseEditorPage.tsx`):

- A 「掃描」 / "Scan" pill with the camera icon in the empty right cell of the editor's header
  (`ExpenseEditorPage.tsx:836`), only when adding an expense (not editing, not payments).
  Icon only under 360 px. It adds no height, so the 390 x 664 fit stays.
- A hidden `<input type="file" accept="image/*">` without `capture` (iPhone then offers camera and
  photo library), opened synchronously in the tap. Add `file` to the input types that do not
  count as typing (`ExpenseEditorPage.tsx:490`).
- Shrink in the browser: `createImageBitmap` (EXIF orientation applied), canvas, JPEG 0.85, long
  side at most 1600 px. Re-encoding drops EXIF and GPS. Never keep the image in the draft, the
  stash, IndexedDB or logs.
- `api('POST', '/api/receipts/scan', body, { timeoutMs: 45000, signal })`; tapping again or
  leaving the editor aborts. Offline: the pill is aria-disabled and a tap explains why.
- Pure helpers in `editorLogic.ts` (no React, tested in Node): `receiptMinor` (via
  `toFixed(decimals + 2)` and `parseAmount`, never `String(v)` or `Math.round(v * 100)`),
  `applyScan` and `revertScan`. Apply in one `setDraft`, after closing an open sheet, and skip
  fields the person changed while the scan ran. Currency first (same rules as `setCurrency`),
  then the amount from the printed total, the date only within the last 90 days (plus 1),
  the merchant only if the description is untouched, the category through `withSuggestion`,
  and the items into `draft.split.items` without switching the split method (if it already is
  品項, open the split sheet). Confirm before replacing 品項 lines the person typed.
- A toast says what was filled, with 復原 (`revertScan` restores only fields still as the scan left
  them), the warnings, and once: 「照片只用來辨識，不會存起來」 / "The photo is only read, never
  stored."
- Wording in `editorText.ts`; map `scan_failed` and the 429 scopes to messages there.
- Tests in `tests/web/editor-logic.test.ts`.

## 4. Who writes which file

| Files | Owner |
|---|---|
| `wrangler.toml`, `src/worker/env.ts`, `src/shared/types.ts`, `public/sw.js`, `docs/SPEC.md`, `docs/WORKER.md`, this plan | Claude (read only for agents) |
| `src/worker/index.ts` (keep Claude's wiring), `src/worker/auth.ts`, `src/worker/http.ts`, `src/worker/routes/auth.ts`, `src/worker/routes/me.ts` | A |
| `src/web/config.ts`, `src/web/lib/api.ts`, `src/web/lib/store.ts`, `src/web/lib/errors.ts`, `src/web/App.tsx`, `src/web/features/auth/**`, `src/web/features/join/**`, `src/web/features/account/{InstallCard,AccountActions,DevicesSection,linkCode}.*`, `src/web/components/OfflineBanner.tsx`, `src/web/features/home/freshness.ts` | A |
| `scripts/build-web.sh`, `scripts/deploy.sh`, `scripts/deploy-web.sh`, `package.json`, `public/_headers`, `README.md`, `tests/e2e/prod-smoke.cjs`, `tests/e2e/cookie-flows.cjs`, `tests/worker/cookie-session.test.ts`, `docs/notes/sessions.md` | A |
| `migrations/0002_push.sql`, `src/worker/services/{activity,webpush,push}.ts` (and any `pushText.ts`), `src/worker/routes/push.ts`, `tests/worker/d1-sqlite.ts`, `tests/worker/{webpush,push-sender,push-routes}.test.ts`, `tests/api/push-test.mjs`, `docs/notes/push.md` | B |
| `src/web/lib/push.ts`, `src/web/lib/pwa.ts`, `src/web/main.tsx`, `src/web/features/account/NotificationsCard.*`, `src/web/features/account/AccountPage.tsx`, `src/web/features/home/HomePage.tsx` and a new card file there, `tests/web/push-client.test.ts` | C |
| `src/worker/routes/receipts.ts`, `src/worker/services/receipt.ts`, `tests/worker/receipt.test.ts`, `src/web/features/expenses/**`, `tests/web/editor-logic.test.ts`, `docs/notes/receipts.md` | D |

Shared expectations between owners:

- C reads `useStore(st => st.token)` for signed-in state; D reads `useStore(s => s.online)`.
  Neither edits `store.ts`.
- C and D call `api()` from `src/web/lib/api.ts` as it is; A keeps its signature
  (`api(method, path, body?, opts?)` with `timeoutMs` and `signal`).
- B's pushes depend on sessions (cascade). A must not change session ids (SHA-256 of the token).
- D's route is behind A's CSRF check automatically (cookie POST from the app's own origin).
