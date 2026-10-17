# Notes: one origin and the cookie session (agent A, plan section 1)

For folding into docs/SPEC.md (sections 3, 6, 8.1, 8.5) and docs/WORKER.md. Written 2026-10-17.
Everything here is implemented and covered by tests/worker/cookie-session.test.ts (36 cases) and
tests/e2e/cookie-flows.cjs (43 checks; run locally against `wrangler dev --local` over https,
not yet against staging). Review fixes of 2026-10-17 (page loads, paths with no file, the
service worker, prod-smoke, the privacy and support pages) are marked "Review fix".

## Worker

### Cookies

Set and cleared only by the Worker, with hono/cookie `prefix: 'host'` (Secure, Path=/, no Domain):

| Cookie | Value | Attributes |
|---|---|---|
| `__Host-evenly_session` | the same 43-character token `createSession` returns (sessions.id = SHA-256 of it) | HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000 |
| `__Host-evenly_user` | the account id (a marker the page reads at start) | Secure; SameSite=Lax; Path=/; Max-Age=31536000 (not HttpOnly) |

Helpers in `src/worker/auth.ts`: `sameOrigin(c)`, `setSessionCookies(c, token, userId)`,
`clearSessionCookies(c)`, `cookieSessionId(c)`, `bearerToken(c)`, `liveCookieSession(c)`,
`startSession(c, userId, label)`; constants `SESSION_COOKIE`, `USER_COOKIE` (names without the prefix).

`sameOrigin(c)`: `Sec-Fetch-Site` equals `same-origin` when the header is present; otherwise
`Origin` equals `new URL(c.req.url).origin`; neither header: not same-origin.

### Which session a request has (`resolveUser`, used by `requireUser` and `optionalUser`)

1. An `Authorization` header is present: the Bearer path exactly as before (`via: 'bearer'`). A
   malformed or dead token is signed out; the cookie is never read and never touched.
2. Otherwise the session cookie (`via: 'cookie'`):
   - no session cookie: signed out; a marker cookie without it is cleared;
   - malformed value, or a session that is missing or expired: both cookies are cleared on this
     response and the request is signed out;
   - a method other than GET, HEAD, OPTIONS that is not `sameOrigin(c)`: 403 `forbidden` (checked
     before the lookup; never 401, which signs the app out);
   - `X-Evenly-User` present and not the session's account: 401 `session_changed`; cookies kept.
3. Cookie requests also get both cookies again when the hourly touch slides `expires_at`, and
   when the marker in the request does not name the session's account (missing or edited): the
   page then boots as the account the session really holds.

`optionalUser` (only GET /api/join/:code) still never fails for a missing or dead session, but the
cookie checks apply (in practice `session_changed`, since it is a GET).

### Sign-ins (`startSession`)

Signup, login, link and reset create the session as before; when the request is `sameOrigin`,
they also set both cookies and delete the session the request's cookie held before (the device is
switching accounts or signing in again). A request from another origin (a sibling site with the
cookie, a script, an old app build) gets no cookies and deletes nothing, so another site can
neither plant a session (login CSRF) nor sign a browser out. `AuthRes.token` is returned to every
caller, unchanged.

### Endpoints

| Method | Path | Auth | Change |
|---|---|---|---|
| POST | /api/auth/signup | none | A live session cookie in the request: 409 `already_signed_in`, `details: { userId }`, nothing created; same-origin requests get both cookies again (the marker may be what went missing). Checked before the signup rate limit. Otherwise as before, plus cookies for same-origin. |
| POST | /api/auth/login, /link, /reset | none | Cookies for same-origin, previous cookie session deleted (see above). |
| POST | /api/auth/logout | user | Also clears both cookies when the request's cookie holds the session ended. |
| DELETE | /api/auth/sessions/:id | user | Also clears both cookies when `:id` is the session the request's cookie holds. |
| DELETE | /api/me | user | Also clears both cookies when the request's cookie holds the caller's session. |
| POST | /api/auth/cookie | user (Bearer) | New. Puts the presented Bearer session into both cookies, no new session row (tabs that race get the same cookie); `{ user: UserDTO }`. A cookie-only request: 400 `bad_request`. Not `sameOrigin`: 403 `forbidden`. Dead token: 401. |

The clear-on-end rule is "the cookie holds that session", not "the request used the cookie": a
Bearer caller that ends some other session of the account leaves this browser's cookie alone.

### Headers (`src/worker/index.ts`)

- Every `/api` answer says `Vary: *`, except GET and HEAD /api/fx, which keep `Vary: Origin`
  (public, `max-age=3600`). The evenly-v3 service worker still on phones stores every same-origin
  GET, and Cache.put throws on `Vary: *`. The OPTIONS preflight keeps `Vary: Origin` (the CORS
  block is otherwise unchanged).
- CORS: unchanged for cross-origin Bearer callers, plus `X-Evenly-User` in Allow-Headers. Never
  `Access-Control-Allow-Credentials`.

### Page loads and paths with no file (`src/worker/index.ts`; review fix)

- `GET` and `HEAD` of `/` and `/index.html` renew both cookies (`renewPageCookies`) only on a
  top-level page load: `Sec-Fetch-Mode` absent (Safari before 16.4, curl), or `navigate` with
  `Sec-Fetch-Dest` absent or `document`. A fetch of `/` (the service worker's install, any
  script: `cors`, `no-cors`, `same-origin`) or a frame (`iframe`) gets the same page with no
  Set-Cookie, not even to clear a dead cookie: WebKit caps a cookie that such an answer sets to 7
  days when the connection went to another of the site's addresses, and that copy would replace
  the year-long one.
- A path with no route and no file reaches the Worker (wrangler.toml `not_found_handling =
  "none"`). `GET` or `HEAD` outside `/api` that opens a page (`Sec-Fetch-Mode: navigate`, or an
  `Accept` with `text/html`): 302 to `/` plus the query (the browser keeps the `#` route),
  `Cache-Control: no-store`. Everything else, a missing `/assets/` file included: the JSON 404
  `not_found` with `no-store`, never index.html (which the `/assets/*` rule in `_headers` and the
  service worker would keep as that file). `/` and `/index.html` never redirect to themselves
  (they only get there without an `ASSETS` binding).

### Error codes

- 401 `session_changed`: the cookie now belongs to another account than `X-Evenly-User`.
- 409 `already_signed_in`: signup over a live session cookie.

## Web client

### Mode (`src/web/config.ts`)

- `VITE_API_BASE` of `same-origin` or `/` means `API_BASE = ''`. Unset: dev builds (`vite`) keep
  the staging URL, production builds default to same origin. `localStorage['evenly.api']` still
  wins (the same two words mean same origin there too).
- `AUTH_MODE`: `cookie` when `API_BASE` is `''` or has this page's origin, else `bearer`.
- `src/web/lib/api.ts` `authMode()`: `AUTH_MODE`, except `bearer` on a device where
  `localStorage['evenly.auth'] = 'bearer'` (the browser kept no cookies; set by the store).

### Requests (`src/web/lib/api.ts`)

- Cookie mode: `credentials: 'same-origin'`. A Bearer token is sent only while this tab holds one
  that is not yet backed by the cookie (a token an older build saved, until it is moved; a new
  sign-in's, until the cookie is confirmed). Otherwise calls that are not `anonymous` send
  `X-Evenly-User: <this tab's account>`; before sending, if the marker no longer names that
  account the call is not sent: the session-changed handler runs and the call fails with 401
  `session_changed`.
- `anonymous`: no Bearer and no X-Evenly-User, and a 401 does not sign out (same-origin calls
  still carry the cookies). New option `ignore401` (logout).
- A 401 `session_changed` calls `onSessionChanged`; another 401 while signed in calls
  `onUnauthorized` as before. Both only when the credential is still the one the request was sent
  with (an epoch counter), so a late 401 for an old session never ends a new one.
- Bearer mode: unchanged (`api(method, path, body?, opts?)` with `timeoutMs` and `signal` kept).
- Exports added: `markerUser()`, `authMode()`, `fallBackToBearer()`, `getCookieUser()`,
  `setCookieUser()`, `setSessionChangedHandler()`; `setToken(t, save = true)`.

### State and start (`src/web/lib/store.ts`)

- `State.token` keeps its name and meaning (signed in, and the key that compare-across-await
  checks use). Cookie mode: `cookie:<userId>:<n>`, or, until it is moved, a token an older build saved.
- Start, synchronous: the marker names U: signed in as U, offline included; cached `me` and group
  snapshots of another account are dropped (also from IndexedDB; a snapshot's account is its "me"
  member's), other accounts' outbox items are held as before. No marker but `evenly.token`: signed
  in with Bearer as before, moved into the cookie when online. Neither: signed out, no probe.
  Standalone `?install=CODE`: skipped when signed in, as before.
- Moving a saved token (`adoptLegacyToken`, at start and on `online`, Web Lock `evenly-session`):
  POST /api/auth/cookie with Bearer, then GET /api/me with the cookie alone (anonymous). Both 200:
  the token is deleted, the session key switched, `{type: 'session'}` announced. 401 on the first:
  the token was dead (handleUnauthorized). The second finds no cookie: `evenly.auth = 'bearer'`,
  the token stays. No answer: try again later.
- After signup, login, link or reset in cookie mode: the token is held in memory only, then GET
  /api/me with the cookie alone. 200: token dropped. No cookie: POST /api/auth/cookie once and
  check again (a late reply to a request from before the sign-in can clear the new cookie); still
  none: the token is saved and `evenly.auth = 'bearer'`. No answer: the token is saved and moved
  later (a device-only account must survive a reload).
- Signup answered 409 `already_signed_in`: GET /api/me with the cookie, become that account,
  `restoreHeld`, carry on (Welcome goes Home; Join and Claim proceed as that account).
- Logout in cookie mode must reach the Worker: offline, 5xx, 429 and other failures are thrown
  (AccountActions shows 「登出需要網路連線，連上網路後再試一次。」 and an offline hint); a 401 means it
  had ended already. Bearer mode: as before.
- Tabs: `{type: 'session'}` is announced after sign-in, sign-out and moving a token; on it, and when
  a tab comes to the front, a tab whose marker user differs from its own reloads (signed out tabs
  reload when a marker appears). Reloads are skipped while this tab's own sign-in runs. More than
  3 such reloads within a minute (sessionStorage `evenly.sessionReloads`) sign the tab out instead.
  The `evenly.token` storage event still reloads tabs that are not on the cookie.

New keys: localStorage `evenly.auth`, sessionStorage `evenly.sessionReloads`, Web Lock
`evenly-session`, bus message `{type: 'session'}`.

### Copy

- InstallCard: 「加到主畫面後，就像 App 一樣打開，離線也能用，還能收到通知」 / "On your Home Screen it
  opens like an app, works offline, and can send you notifications."; the join and claim toast:
  「加到主畫面，就像 App 一樣打開，還能收到通知」.
- errors.ts: `session_changed` 「另一個分頁換了登入的帳號，正在重新載入。」, `already_signed_in`
  「這個瀏覽器已經登入了，請重新整理頁面。」.

## Build and deploy

- `scripts/build-web.sh`: `BASE_PATH=/ VITE_API_BASE=same-origin vite build --outDir dist
  --emptyOutDir`; fails without `dist/index.html`, `dist/sw.js`, `dist/_headers`,
  `dist/privacy/index.html`, `dist/support/index.html`, or when `dist/assets/*.js` contains
  `workers.dev` or `127.0.0.1`; writes `dist/version.json` `{commit, dirty, builtAt}`.
  `npm run build:site`.
- `public/privacy/index.html` and `public/support/index.html` (review fix): the pages the iPhone
  app and its App Store listing link to (`https://split.ginochang.com/privacy/` and `/support/`),
  copied from `evenly-ios/docs/site/` (plain HTML, inline CSS, no script, nothing loaded from
  elsewhere). Support is unchanged. Privacy also lists the session cookies and the token copy,
  notifications (subscription, keys, device label and time zone, the three choices; text
  encrypted to the device), receipt scanning (shrunk on the device, read once by Workers AI,
  neither stored nor logged; Cloudflare's [Data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
  page, updated 2026-10-16: standard requests keep no inputs or outputs and nothing trains
  models), the push services, the scan and test-notification counts (windows now up to a day),
  and that the Worker, not GitHub Pages, serves the app and the page (GitHub only forwards the
  old address).
- `public/sw.js` (review fix, now `evenly-v5` so activate drops the v4 caches): the install
  fetches the shell with `credentials: 'omit'` (its answer never sets the cookies) and each asset
  itself with `cache: 'no-cache'`, failing unless every answer is ok and not `text/html` (all or
  nothing, as `cache.addAll` was); the `/assets/` handler stores only such answers.
  `pushsubscriptionchange` subscribes again with the old key but sends nothing to the API: the
  worker cannot tell which account wanted notifications, and the page's start sync links the
  subscription for that account.
- `scripts/deploy.sh staging|production` (`npm run deploy:staging`, `npm run deploy`): production
  refuses uncommitted changes unless `ALLOW_DIRTY=1`; build; `wrangler d1 migrations list <db>
  --remote` stops on pending migrations unless `MIGRATE=1` (then `migrations apply`); `wrangler
  deploy [--env staging]`; smoke checks with 5 tries each: `/api/health` env, `/version.json`
  commit, `/api/health` with `Sec-Fetch-Mode: navigate` is JSON, `/` contains `id="root"`.
  Default sites: staging workers.dev; production `https://evenly-api.richlovegod.workers.dev/`
  (`SMOKE_URLS="..."` adds split.ginochang.com after the cutover). `MSYS_NO_PATHCONV=1` kept.
- `package.json`: `api:deploy*` removed (a bare `wrangler deploy` would upload a stale `dist/`).
- `scripts/deploy-web.sh`: retired (prints why, exits 1). gh-pages stays as it is (its CNAME keeps
  the github.io 301).
- `public/_headers`: `/assets/*` immutable for a year, `/sw.js` no-cache, `/*` nosniff,
  `strict-origin-when-cross-origin`, `X-Frame-Options: DENY`; no header set twice for one path.

## Tests

- `tests/worker/cookie-session.test.ts`: worker.fetch on `https://split.test`, including the
  page-load and no-file cases above.
- `tests/e2e/cookie-flows.cjs`: staging site, WebKit iPhone 14; refuses a site whose /api/health
  is not `staging` unless `ALLOW_ANY_ENV=1`; deletes every account it makes. Covers the plan's
  list plus offline sign-out, signup over a live cookie, and a browser that keeps no cookies.
  WebKit on Windows reports every cookie as SameSite=None, so SameSite is checked on the
  `Set-Cookie` lines of the signup answer.
- `tests/e2e/prod-smoke.cjs` (review fix): same-origin page fetches with the session cookie alone
  and `X-Evenly-User` from the marker, as the app makes them; `Authorization` only when the
  device fell back to Bearer (`evenly.auth = 'bearer'`), which a check reports. So GET /api/me,
  POST /api/groups and the expense PUT are checked on the cookie path (Bearer would win and hide
  it). Checks that any `evenly.token` copy belongs to this account (cookie mode keeps one, so not
  that there is none), `Vary: *`, no API host but the site, nothing from /api in Cache Storage.
  The cleanup is armed as soon as signup answers 200 (or a session cookie exists), tries the
  cookie first, and when that fails reports it and deletes with the signup answer's token as
  Bearer (`page.request`, outside the page). Run against `wrangler dev` over https with the real
  `[assets]` settings: all 19 checks pass; with every GET /api/me failing after signup, the run
  fails at Home and the account is still deleted (the old order left it behind).
- Unchanged and passing against the new Worker (locally): `tests/api/api-test.mjs` (121) and
  `tests/e2e/flows.cjs` (22).

## Open points

- Not checked on a real iPhone: that Safari shows a cookie set by a fetch answer in
  `document.cookie` at once, and whether a Home Screen app starts with Safari's cookies. If it
  does, the app skips `?install=CODE`, and the InstallCard's new-session watcher never fires (the
  card keeps its steps until the code expires).
- `POST /api/me/credentials` (password change) still revokes no other session (as before).
- `src/web/features/account/CredentialsForm.tsx` (no owner) still says Safari can clear the
  site's data and lose this account; on the cookie origin only a new phone or cleared browser
  data does.
- `scripts/deploy.sh` does not yet check after a deploy that a missing `/assets/` file answers
  404 (not 200 with index.html), or that `/privacy/` and `/support/` answer 200.
- The privacy page now exists twice: `evenly-ios/docs/site/privacy/index.html` is the older
  copy and lacks this round's additions; one of them should become the only source.
