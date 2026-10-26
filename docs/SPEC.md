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
- `src/worker/` Cloudflare Worker (Hono 4 router, zod 3 validation, D1, Workers AI to read receipt
  photos, Workers KV to keep them with their expenses, Web Push). Deployed as `evenly-api` (production) and `evenly-api-staging`, each together
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
- Refunds (退款, since 2026-10-26): `kind: 'refund'`, money coming back (a deposit returned, an item
  sent back, a booking cancelled), exactly a negative expense. Stored like an expense with positive
  amounts: `payers` are who got the money back (default me), the split whose money it is (default
  everyone equally), any split method, a category, a description (required, like an expense's).
  `balances.toBase()` gives it with every amount negated, so nets, plans and spending take it off
  with no case of their own; `memberEffect()` negates `paid` and `owed` the same way;
  `spendTotals()` skips payments only, so a refund subtracts from `spent`, from its category, and
  from the receivers' `paid` and everyone's `share`. Example: Gino got back a ¥30,000 deposit that
  four people paid equally: Gino -22,500, each of the other three +7,500, and the plan is three
  transfers of ¥7,500 from Gino. A refund in another currency uses the expense rules (one
  conversion, then allocated back). It never repeats (the Worker stores `repeat: 'none'`).
  `refundOf` links a refund started from an expense (記一筆退款) to that expense; no math reads it.
  The words: rows 「Gino 收到退款 ¥30,000」 / "Gino got back ¥30,000" with a 退款 tag; my effect
  你可以拿回 / "You get back" (above zero) and 你要還 / "You owe" (below zero), not 你借出 / 你借入
  (nobody lent or borrowed anything); the feed and notifications 「Gino 新增了退款「押金」 ¥30,000」 /
  `Gino added the refund "Deposit" (¥30,000)`, the description without its 「退款：」 prefix
  (`shared/refunds.ts`). Clients from before refunds see each one as the expense with the same
  effect (section 6, Compatibility).
- Settle-up plan: `settle.settlementPlan()`: simplified (group.simplify, default on) or pairwise.
- Group summary for dashboards: `summary.computeGroupSummary()`; the Worker stores it in
  `groups.summary` after every change, tagged with the group version (`forVersion`) and
  `SUMMARY_VERSION`; a stale summary is recomputed on read.

## 3. Accounts and identity

- A new account needs an email, confirmed with a 6-digit code sent to it (since 2026-10-25;
  "Email codes" below), because device-only accounts were lost with the device. The welcome page
  takes a name and an email and mails a code (`POST /api/auth/email/start`); the code
  (`POST /api/auth/email/verify`) makes the account with that email confirmed, or, when an
  account has the email already, signs in to it (the app says 歡迎回來，{name}). Signing in on
  another device is the same code, no password. The invite and claim pages ask for the email the
  same way when nobody is signed in (a sheet, 用 Email 加入), then join.
- Sign in with Google (web app, since 2026-10-25; "Google" below): 使用 Google 帳戶登入 on the
  welcome page and 登入 signs in to the account linked to that Google account, or links the
  account that has its email, or makes one with Google's name and the email confirmed. Email
  codes and passwords stay. The native iOS app gets it later, together with Sign in with Apple
  (App Review requires Apple's once Google's is offered).
- `POST /api/auth/signup {name}` makes an account from a name alone (a "device-only" account)
  and nothing else: an email or a password in the body is 400 `email_requires_code` and makes
  nothing. An email nobody confirmed would let someone make an account with another person's
  address and a password of their own, which that person's first code sign-in would then land in.
  Signup stays for older clients, the native iOS app until it moves to email codes (it sends a name
  only), and every test script; the web app no longer calls it. Accounts from before keep
  working, and the app nudges (not forces) the ones without a confirmed email to add or confirm
  one ("換手機或清除瀏覽器資料後，用它收驗證碼就能登入").
- Email: the sign-in identifier (NFKC, trimmed, lowercase, at most 120 characters; one account
  each). `users.email_verified_at` says when a code confirmed it (UserDTO `emailVerified`); a code
  sign-in also confirms an email set before email codes (signup and `POST /api/me/credentials`
  took one without a code then). An email is added or changed only with a code
  (`POST /api/me/email/start` and `/verify`); `POST /api/me/credentials` sets or changes the
  password and never the email. The only email the service sends is the code.
- Password: optional, for an account with a confirmed email, and kept by accounts that had one
  (the App Review demo account, appreview@ginochang.com, signs in with it). `POST /api/auth/login`
  is unchanged. A forgotten password needs no reset email: the password form offers 忘記密碼？用驗證碼登入.
  Passwords >= 8 characters.
  The typed password never leaves the device: the browser sends a key derived with PBKDF2-SHA256,
  210,000 iterations, salted with the email (`src/web/lib/crypto.ts`), and the Worker stores
  PBKDF2-SHA256 of that key, 4,000 iterations, 16-byte salt (a stored hash keeps its own count, up
  to the Workers maximum of 100,000). Since the key is salted with the email, a new email removes
  the password (`passwordCleared`; the app warns first).
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
- Signup, login, an email code, link and reset from a same-origin request set both cookies and
  delete the session the browser's cookie held before (the device is switching accounts or
  signing in again); from another origin they set no cookies and end nothing. Every caller gets
  the token in `AuthRes`. Signup over a live session cookie is 409 `already_signed_in`
  (`details.userId`) and creates nothing (a lost device-only account never comes back); an email
  code is a sign-in, so it replaces the cookie's session like login does.
- Logout, revoking the current device and `DELETE /api/me` clear both cookies when the cookie holds
  the session that ended. In cookie mode signing out needs a connection, since only the Worker can
  end an HttpOnly session: a failed call (offline, 5xx, 429) is shown on 我的 and nothing is
  cleared; a 401 means it had ended already, except 401 `session_changed`, after which the tab
  reloads.
- Sign in another device: a signed-in device asks `POST /api/auth/link-code` -> 8-character code
  (alphabet without 0/O/1/I/L, shown `XXXX-XXXX`) valid 10 minutes, one use, plus a QR of
  `<APP_URL>#/link/<code>`. The new device opens the link or types the code (`POST /api/auth/link`).
- Password reset links (unchanged; an email code needs none): the owner (emails in the
  `OWNER_EMAILS` secret) can make a 30-minute reset link on the admin page (`#/admin`), never
  emailed; the person opens `#/reset/<token>` and sets a new password (all other sessions are
  revoked).
- Account deletion (`DELETE /api/me`): the user row is deleted, with its profile photo, its
  Google link (`users.google_sub` goes with the row) and the codes it asked for to add an email; their members become placeholders (FK `ON DELETE SET
  NULL`), so groups keep their history. Receipt photos the account uploaded stay with their
  expenses: they are the group's, like the expenses themselves.
- Profile photo (optional): a square photo on the account, so every device signed in to it shows
  it (section 6, Profile photo). The person and anyone who can already see their name see it.
  The first letter of the name on the member's color stays the fallback everywhere: placeholders,
  people without a photo, and a photo that does not load.

### Email codes
`src/worker/services/emailCodes.ts` (the rules) and `services/email.ts` (the message and Resend).
- A code is 6 digits from crypto random (a draw that would bias the result is drawn again), valid
  10 minutes, at most 5 tries (right or wrong), once. Two purposes: `sign_in` (POST
  /api/auth/email/*, for an address) and `add_email` (POST /api/me/email/*, for an address and the
  signed-in account). A new code for the same address and purpose replaces the older unused ones.
  The table keeps `SHA-256(id + ':' + code)` only (`email_codes`, section 5); the code itself is in
  the email and nowhere else (never logged).
- A try: the address is normalized (NFKC, trimmed, lowercase); the code may be typed in full
  width or with a space or hyphen. One statement takes the try on the newest live code (unused,
  unexpired, with tries left, and for `add_email` made for this account), so parallel guesses
  never pass 5; then SHA-256 and a constant-time comparison, against a dummy when no code waits
  (the same work either way). Wrong, expired, used or dead: 400 `code_invalid`, one failure. A
  right code is spent once the route's own checks pass: verify without an account for the address
  and without a name is 400 `name_required` and leaves the code unspent, so the app asks for a
  name and sends the same code again.
- Limits (`rate_limits`; an address is keyed by the first 32 hex characters of its SHA-256, never
  stored as text): asking for codes, per IP `EMAIL_IP_PER_HOUR` an hour (default 10; staging 1000
  for tests) and per address 3 in 15 minutes and 10 a day, the same pools for both start routes;
  wrong tries, 10 per address and 30 per IP in 15 minutes, counted on failures only and checked
  before the code is looked at (429 `rate_limited`, `retryAfter`). The whole app sends at most
  `EMAIL_GLOBAL_PER_DAY` a UTC day (default 90, under Resend's 100 a day; staging 10, since the
  quota is the Resend account's), counting only messages that go to Resend (a code that is only
  echoed, or never mailed, uses none): past it, and when Resend says its own daily or monthly quota
  is used up, 503 `email_quota` with `details.retryAfter` (and `Retry-After`) to 00:00 UTC.
- Delivery: Resend's REST API (`POST https://api.resend.com/emails`, the `RESEND_API_KEY`
  secret), from `EMAIL_FROM` ("吉諾分帳所 <login@ginochang.com>"), `reply_to` gino@ginochang.com,
  subject 「吉諾分帳所驗證碼：123456」 or "Gino's Split Lab code: 123456" in the person's language
  (the start's `locale`; for `add_email` the account's). Plain text and a small HTML version in the
  picture-book colors with the code large, 10 分鐘內有效 / valid for 10 minutes, and
  不是你本人操作的話，忽略這封信就好 / If this was not you, ignore this email; one link
  (https://split.ginochang.com/), no image, no tags, and nothing a person typed (anyone can make
  the Worker mail any address).
  Resend's open and click tracking are settings of the sending domain and stay off. A 10 s
  timeout; a message that does not go out takes its code with it and is 503 `email_unavailable`.
  Addresses on domains that never get mail (.test, .example, .invalid, .localhost, example.com,
  .net and .org) are given codes but never mailed (only bounces would come of it).
- Test mode: `EMAIL_DEV_ECHO = "1"` (staging vars only) adds the code to the start answer as
  `devCode`, which the UI tests read off the network and the code step shows as 測試模式. Never
  where `ENVIRONMENT` is production (or missing), whatever the flag says. Staging mails through
  Resend as well when it has `RESEND_API_KEY`; without it, staging only echoes. Production without
  the key answers 503 `email_unavailable`, before anything is written.
- Cleanup: the daily job deletes codes that have expired, used or not, so no record lasts much
  past a day; deleting an account deletes its `add_email` codes (and the cascade would).

### Google
`src/worker/services/google.ts` (the protocol) and the `/api/auth/google/*` routes in
`routes/auth.ts`; in the app `features/auth/GoogleButton.tsx` and `googleSignIn.ts`. OAuth 2.0's
authorization code flow with PKCE, run by the Worker: no Google script on our pages, and only the
web app on the Worker's own origin (cookie mode). Bearer clients and the iOS app are untouched.
- Offered when `GOOGLE_CLIENT_ID` (a var; "SET_ME" counts as missing) and the
  `GOOGLE_CLIENT_SECRET` secret are set and the request came to `APP_URL`'s origin, whose callback
  is the one registered at Google (production also answers on workers.dev); local wrangler dev on
  127.0.0.1 or localhost counts too. `GET /api/auth/providers` says so (`{google}`); the app hides
  the button otherwise, in Bearer mode, and inside LINE, Facebook, Instagram and other apps' web
  views, which Google refuses (`disallowed_useragent`; the in-app hint shows there instead).
- Start, `GET /api/auth/google/start?return=<hash route>&locale=`: a link the button opens as a
  page. Only from a page of this app (`Sec-Fetch-Site: same-origin`; without it, a Referer on this
  origin), else 登入 with `start`. 20 per IP in 15 minutes (`GOOGLE_IP_PER_15M`). It keeps the
  flow, a random state, nonce and PKCE verifier (32 bytes each, base64url), the page to come back
  to (an app hash route of at most 300 path and query characters, else `/`; `/welcome` and `/login`
  become `/`; never a URL) and the language (`locale`, else Accept-Language), in
  `__Host-evenly_google` (HttpOnly, Secure, `Path=/`, SameSite=Lax, Max-Age 600; a new start
  replaces it), and answers 302 to `https://accounts.google.com/o/oauth2/v2/auth` with
  `response_type=code`, `client_id`, `redirect_uri=<origin>/api/auth/google/callback`, `scope=openid
  email profile`, `state`, `nonce`, `code_challenge` (S256), `code_challenge_method=S256` and
  `prompt=select_account`.
- Callback, `GET /api/auth/google/callback?code&state` (or `?error=` when the person said no):
  the flow cookie is cleared on this answer whatever happens (one use). 20 per IP in 15 minutes.
  Google's `error` is `denied` (`access_denied`) or `failed`; then the state must equal the
  cookie's (constant time; no cookie or another state: `state`). The code goes to
  `https://oauth2.googleapis.com/token` with the client secret, the same redirect_uri and the
  PKCE verifier (10 s, no redirects); the id_token must be RS256 with a key from
  `https://www.googleapis.com/oauth2/v3/certs` (kept in memory as long as its Cache-Control
  says, at most a day; fetched again for a key id it does not hold), `iss` `accounts.google.com`
  or `https://accounts.google.com`, `aud` our client id (a list must hold it, with `azp` ours),
  `exp` not passed (60 s of clock skew), `iat` not in the future, the flow's `nonce`, and
  `email_verified` true with an email (else `unverified`). Any other failure is `failed`.
- The account: the one whose `users.google_sub` is the token's `sub`, whatever its email is now
  (`back`); else the one that has the email (NFKC, lowercase), confirmed or not, which gets the
  link, and `email_verified_at` if it was NULL (`linked`; a password stays, as after a code); else
  a new account (`new`) named with Google's given name, else its full name (trimmed, cut to 60
  characters without splitting one; else the email's part before @), the email confirmed, the
  start's language and that language's default currency, as at signup. An account with the email
  that is linked to another Google account is refused (`linked_other`): its owner signs in with a
  code. A race with another request (the same `sub` or email taken a moment ago) looks again.
- Then a session in both cookies, and the session the browser's cookie held before deleted, as
  every sign-in (`startCookieSession`; the callback is a cross-site page load, so the flow cookie,
  which only a same-origin start can set, stands in for the same-origin check). The answer is 302
  to `/?google=<new|back|linked>#<return path>` with `Referrer-Policy: no-referrer`; every
  failure is 302 to `/?google_error=<code>#/login` (`GoogleErrorCode`: `unavailable`, `start`,
  `denied`, `state`, `failed`, `unverified`, `linked_other`, `rate_limited`, `server`).
- The app takes the flag out of the address at start (`history.replaceState`). A sign-in waits
  for the store, which ends it as an in-app sign-in ends (`actions.googleArrived`: the account's
  language, the changes held for it on this device, the other tabs told), drops the remembered
  return path (the callback opened it), and toasts 歡迎回來，{name} for `back` and
  歡迎回來，{name}。這個帳號之後也可以用 Google 登入 for `linked` (none for a new account, as after a
  code). An error shows on 登入 above the button, in both languages.
- Kept: the Google account id in `users.google_sub` (never sent to a client: UserDTO says
  `googleLinked`, and so does the export), the email, and the name only as a new account's
  starting name. Nothing else from Google (no picture, no contacts, no Drive, no access or refresh
  token). Nothing logged holds the code, a token, the verifier or an address: failures log their
  name, the token endpoint its status and Google's error name.
- No unlink in v1 (section 10); 我的 > 登入方式 shows 已連結 Google. Changing the email keeps the
  link (it is the Google account, not the address).

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
  a name. If not signed in, 加入群組 first asks for an email and its code (a sheet): the code signs
  in to the account that has the email, or makes one named after the pick; then it joins. The
  claim page does the same with its name field.
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
- Friend invite link (Gino's decisions, 2026-10-25): one personal link per account,
  `<APP_URL>i/<code>?openExternalBrowser=1`, made the first time 邀請朋友 asks for it (`code`: 16
  random characters of `[A-Za-z0-9]`, in `users.invite_code`). It works for anyone, any number of
  times, never expires, and 重設連結 replaces the code, so the old link stops working at once. The
  server builds the link; the apps never do. Opening it shows who sent it (name, color, photo),
  with no sign-in needed; signing up or signing in there makes the two friends automatically, no
  question asked on the other side: the `pair` group they are both active in, else a new one by
  the rules of `POST /api/friends` (room for both in their 200 groups, the caller's email link
  limit, both admins), the link's owner first and in their currency, with a `friend.join` activity
  row that notifies the owner. Already friends: the same ledger, nothing written. The owner's
  existing placeholders are never guessed at (the per-member claim link covers that). The three
  ready-made messages to send with the link (日常, 旅行, 室友; no AI) live in `src/shared/invites.ts`
  and reach both apps from the API, in the language asked for.
- Archive (封存群組, since 2026-10-26; Gino picked it, the details are the contract's defaults):
  per person, never per group. Archiving takes a group off my 總覽 and my 群組 list into a collapsed
  「已封存（N）」 section at the bottom of 群組, where 取消封存 brings it back; nobody else sees a
  change. The group page still opens from links, from 動態 and from 朋友, and its money is never
  hidden: 總覽's totals, friend balances and the activity feed still count it. Archiving a group I
  have not settled up asks first, naming my balance and its direction. A new entry that someone
  else adds (an expense, a refund, a payment, a restore of a deleted entry, a Splitwise import, a
  recurring copy) puts it back on everyone's lists but its author's, so a new debt is never
  hidden; my own entries, and anyone's edits and deletes, do not. Rejoining after leaving puts it
  back too. No activity row, no push, no group version bump (only my member row changes: GET
  /api/me carries the flag, the group snapshot does not). 1:1 ledgers are under 朋友, not on the
  群組 list, so the app offers no 封存 for them (the server allows it). Stored in
  `members.archived_at`.
- Default split (群組預設分法, since 2026-10-26): one per group, shared by its members, e.g. 「我們家」
  always splits rent 60/40 (`groups.default_split`, `shared/defaultSplit.ts`). Any member may set
  or clear it (`PATCH /api/groups/:gid` `defaultSplit`); a change writes a `group.update` activity
  row (「Gino 把預設分法改成「比例：你 60%、Abbie 40%」」, 「Gino 清除了預設分法」) and sends no push.
  Methods: 平均 over the members it lists, 比例 (percent, adding up to 100) and 份數 (shares); amounts,
  adjustments and items are per expense only. It may hold a default payer: a member, or null for
  whoever adds the expense. A new expense in the group starts from it (split and payer); a refund
  started from an expense uses the original's split instead, and the 2-person quick presets still
  override it. It lists members by id: one who joins later is not in it until someone edits it (the
  editor and 設定 say 「新成員不在預設分法裡：Lily」), and one who leaves is dropped from it and as its
  payer, in the same batch as the leave. If what remains no longer adds up (a 比例 member left), it
  is not applied (the new expense splits equally) and the editor and 設定 say why. 1:1 ledgers
  work the same way. Set from the split editor's 「設為這個群組的預設分法」 (平均 / 比例 / 份數 that
  add up; it keeps the group's default payer) or from 設定 > 預設分法 (the split sheet with those
  three methods, no amount, and who pays), with 清除 beside it. Both need a connection.
- Limits: 50 active members per group, 5,000 entries per group, 200 groups per user, 30 accounts
  linked by email per person a day (section 6).

## 5. Database

See `migrations/`, applied in order (`scripts/deploy.sh` stops while one is pending). JSON columns:
`expenses.payers`, `expenses.split`, `expenses.shares`, `groups.summary`, `activity.data`,
`fx_cache.rates`, `users.notify_prefs`, `push_pending.payload`. Booleans are 0/1 integers. One
BLOB column, `avatars.data` (D1 hands a BLOB back as an array of byte values).

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
- `0004_avatars.sql` (apply before the code that reads `users.avatar`: the account, group and
  dashboard queries name it): `avatars`, one row per account with a profile photo: `user_id`
  (PRIMARY KEY, users, cascade), `mime` (`image/jpeg` or `image/png`), `data` (BLOB, the bytes as
  uploaded, at most 150,000), `version` (the first 16 hex characters of SHA-256 of `data`),
  `updated_at`. And `users.avatar TEXT` (nullable): the current version, so the DTO queries need
  no join on the blob table. No R2: a 256 x 256 JPEG is about 15 to 40 KB.
- `0005_email_codes.sql` (apply before the code that reads `users.email_verified_at`: every
  account query selects it, and the email routes write `email_codes`): `email_codes`, one row per
  code (section 3, Email codes): `id` (TEXT PRIMARY KEY, a random UUID that also salts the hash),
  `email` (NFKC, trimmed, lowercase), `purpose` (`sign_in` or `add_email`), `user_id` (users,
  cascade; `add_email` only), `code_hash` (SHA-256 hex of `id + ':' + code`), `attempts` (tries so
  far; dead at 5), `expires_at`, `used_at`, `created_at`; index on `(email, purpose)`. And
  `users.email_verified_at TEXT`: NULL until a code confirms the email (every row from before
  stays NULL).
- `0006_receipts.sql` (apply before the code that reads it: every group snapshot and the export
  join `receipts`): `receipts`, one row per expense with a kept photo (section 6, Receipt photos):
  `expense_id` (PRIMARY KEY, expenses, cascade), `group_id`, `kv_key` (`receipt:<expenseId>:<version>`,
  the object in Workers KV), `version` (the first 16 hex characters of SHA-256 of the bytes),
  `mime` (`image/jpeg` or `image/png`), `bytes`, `width` and `height` (px, as the app measured
  them), `uploaded_by` (the account, no foreign key: deleting it keeps the photo), `created_at`;
  index on `group_id`. The bytes are in KV (binding `RECEIPTS`), not in D1.
- `0007_google_sign_in.sql` (apply before the code that reads it: every account query selects
  `users.*`, account inserts name `google_sub`, and the Google callback writes it):
  `users.google_sub TEXT`, the linked Google account's `sub`, NULL until a Google sign-in links
  one (section 3, Google), with the unique index `idx_users_google_sub` (SQLite cannot add a
  UNIQUE column; NULLs never clash). It goes with the row when the account is deleted.
- `0008_friend_invites.sql` (apply before the code that reads it: every account query selects
  `users.*`, and the invite routes and the `/i/<code>` page read the column):
  `users.invite_code TEXT`, the account's friend invite code (section 4), NULL until
  `GET /api/me/invite` first makes one, with the unique index `idx_users_invite_code`. A reset
  overwrites it; it goes with the row when the account is deleted. No DTO carries it but the
  owner's own `MyInviteDTO`. `friend.join` activity rows get `push_at` like the other types that
  may notify (section 7).
- `0009_archive.sql` (apply before the code that reads it: GET /api/me selects
  `members.archived_at`, and every new entry by someone else writes it): `members.archived_at
  TEXT`, when this member's person archived the group (section 4, Archive), NULL while it is on
  their lists. Set by `PUT /api/groups/:gid/archive` (an archive again keeps the first time),
  cleared by 取消封存, by rejoining, and, in the same batch as the write, for every member but the
  author when someone else adds an entry (`db.ts` unarchiveStmt: a create, a restore, an import,
  and recurring copies, whose author is the system).
- `0010_default_split.sql` (apply before the code that reads it: every group snapshot maps
  `groups.default_split`, and PATCH writes it): `groups.default_split TEXT`, the group's default
  split as JSON (`shared/defaultSplit.ts` DefaultSplit: `method` equal, percent or shares,
  `entries` [{memberId, value?}], `payerId` or null, `setAt`), NULL for none (section 4, Default
  split). A member who leaves is dropped from it in the leave's batch (guarded by the stored value);
  when nobody is left in it, it goes back to NULL.
- `0011_refunds.sql` (apply before the code that reads it: every entry write sets
  `expenses.refund_of`): `expenses.refund_of TEXT`, the id of the expense of the same group a
  refund was started from (section 2, Refunds), NULL for everything else. A refund is the new
  `kind` value `'refund'` of the existing TEXT column. `SUMMARY_VERSION` is 2 since: every stored
  summary is recomputed once on read.

## 6. HTTP API

Base URL: the app's own origin (`/api` on https://split.ginochang.com, and on
https://evenly-api-staging.richlovegod.workers.dev for staging); old app builds and scripts call
`https://evenly-api.richlovegod.workers.dev`. All paths start with `/api`. JSON in and out.
Errors: HTTP status + `ApiErrorBody` (`{error: {code, message, details?}}`, codes in
`shared/types.ts`). 400 `validation` carries zod issues in `details`. 429 `rate_limited` carries
`details.retryAfter` (seconds, also sent as `Retry-After`) and, where the limits differ,
`details.scope`. Codes added with the cookie session and the receipt scan: 401 `session_changed`,
409 `already_signed_in`, 502 `scan_failed`; with email codes: 400 `name_required`, 400
`email_unconfirmed`, 400 `email_requires_code` (signup with an email or a password), 503
`email_quota` (with `details.retryAfter`, also as `Retry-After`) and 503 `email_unavailable`; with
receipt photos: 503 `receipts_quota` (with `details.retryAfter` and `Retry-After`) and 503
`receipts_full`; with friend invite links: 400 `own_invite` (and 400 `code_invalid` for a code
nobody has). Auth
("user" below): the session cookie or
`Authorization: Bearer` (section 3); a cookie write from another origin is 403 `forbidden`.
"member" below means: signed in AND an active member of the group, else 404 `not_found` (do not
reveal that the group exists). Bodies over 256 KB get 413 (`/api/receipts/scan` takes up to 3 MiB,
`PUT /api/me/avatar` up to 401,024 bytes, `PUT /api/groups/:gid/expenses/:eid/receipt` up to
600,000).

### Auth
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| POST | /api/auth/signup | none | SignupReq `{name, locale?, currency?}` -> AuthRes: a name only, for older clients, the iOS app and test scripts; the web app makes accounts with an email code. An email or a password in the body (anything but missing, null or blank) is 400 `email_requires_code` ("Add an email with a code: POST /api/auth/email/start") and makes nothing, whether or not an account has that email. Rate limit 10/hour/IP. A live session cookie in the request: 409 `already_signed_in`, `details: {userId}`, nothing created (checked before the rate limit; a same-origin request gets both cookies again, since the marker may be what went missing). |
| POST | /api/auth/login | none | LoginReq -> AuthRes. `invalid_credentials` (generic). Limits: 10 per 15 min per email, 30 per 15 min per IP. |
| POST | /api/auth/email/start | none | EmailStartReq `{email, locale?}` -> EmailStartRes `{ok: true, expiresInSec: 600, devCode?}`, the same whether or not the email has an account (`devCode` in test mode only). A code to the address (section 3, Email codes); its limits are 429 `rate_limited`; 503 `email_quota`, `email_unavailable`. |
| POST | /api/auth/email/verify | none | EmailVerifyReq `{email, code, name?, locale?, currency?}` -> EmailVerifyRes (AuthRes plus `created`): the account with the email signs in (`created: false`; the email counts as confirmed from then on), or with `name` (signup's rule, 1 to 60) a new one is made with the email confirmed, locale and currency as at signup (`created: true`). 400 `code_invalid`; 400 `name_required` without an account and a name (the code stays unspent); 429 past the failed-try limits. Cookies as login (no 409 over a live cookie). |
| POST | /api/auth/logout | user | {} -> {ok: true}; revokes this session; clears both cookies when the request's cookie holds it. |
| POST | /api/auth/cookie | user (Bearer, same origin) | {} -> {user: UserDTO}; puts the presented Bearer session into both cookies, with no new session row (tabs that race get the same cookie). A cookie-only request: 400 `bad_request`; another origin: 403 `forbidden`; a dead token: 401. |
| GET | /api/auth/sessions | user | -> {sessions: SessionDTO[]} |
| DELETE | /api/auth/sessions/:id | user | -> {ok: true} (own sessions only); clears both cookies when `:id` is the session the request's cookie holds. |
| POST | /api/auth/link-code | user | {} -> LinkCodeRes |
| POST | /api/auth/link | none | {code} -> AuthRes; `code_invalid`. Limit 10 per 15 min per IP. |
| GET | /api/auth/reset/:token | none | -> {email, expiresAt} for a live reset link (the reset page salts the password key with the email); `code_invalid` otherwise. Limit 10 per 15 min per IP, shared with POST. |
| POST | /api/auth/reset | none | {token, password} -> AuthRes; revokes other sessions. |
| GET | /api/auth/providers | none | -> ProvidersRes `{google: boolean}`: whether the sign-in pages may offer Google here (section 3, Google). |
| GET | /api/auth/google/start?return=&locale= | none (a page load from this app) | -> 302 to Google's consent page with the flow cookie `__Host-evenly_google`; failures 302 to `/?google_error=<code>#/login`. 20 per 15 min per IP. |
| GET | /api/auth/google/callback?code&state | none (Google's redirect, with the flow cookie) | -> 302 to `/?google=<new\|back\|linked>#<return path>` with both session cookies; failures 302 to `/?google_error=<code>#/login`, no cookies. 20 per 15 min per IP. |

Signup, login, an email code (`/email/verify`), link and reset from a same-origin request also set
both session cookies and delete the session the browser's cookie held before (section 3); so does
the Google callback, whose flow cookie stands in for the same-origin check. The two Google routes
answer page loads, never JSON: their errors are `GoogleErrorCode` in the redirect, not
`ApiErrorBody`. The clear-on-end rule is "the cookie holds
that session", not "the request used the cookie": a Bearer caller that ends some other session of
the account leaves the browser's cookie alone.

### Me
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| GET | /api/me | user | -> MeDTO (dashboard: groups with my net and my transfers, friends aggregated, totals per currency, unread activity count). Each group's list item says `archived` (mine, section 4, Archive); archived groups still count in `totals` and `friends`. |
| PATCH | /api/me | user | UpdateMeReq -> {user: UserDTO} |
| POST | /api/me/credentials | user | CredentialsReq -> {user: UserDTO}: sets or changes the password only. `email` must be the account's own, and confirmed unless the account had a password already (accounts from before email codes); anything else is 400 `email_unconfirmed` and writes nothing. Needs currentPassword if a password exists (`invalid_credentials`). |
| POST | /api/me/email/start | user | AddEmailStartReq `{email}` -> EmailStartRes: a code to the address the account wants as its sign-in email, in the account's language, from the same limits and pools as `/api/auth/email/start`. 409 `email_taken` when another account has it. |
| POST | /api/me/email/verify | user | AddEmailVerifyReq `{email, code}` -> AddEmailVerifyRes `{user, passwordCleared}`: `users.email` is the address and `email_verified_at` now. A password goes when the email changes (its key was salted with the old one): `passwordCleared: true`; confirming the same email keeps it. `code_invalid`, 409 `email_taken`. No group is touched: nothing another member sees shows an email. |
| PUT | /api/me/avatar | user | AvatarReq -> AvatarRes; the profile photo (below). |
| DELETE | /api/me/avatar | user | -> {avatar: null}; removes the profile photo (below). |
| DELETE | /api/me | user | {password?} -> {ok: true}; password required if the account has one. Deletes the profile photo and the account's `add_email` codes too. Clears both cookies when the request's cookie holds the caller's session. |
| GET | /api/me/export | user | -> {user, groups: GroupSnapshotDTO[]} (everything I can see); `user.avatarImage` is the profile photo as a data URL, or null; `user.googleLinked` says whether a Google account is linked (never its id); each group also says `archived` (mine). |
| GET | /api/activity?before=<iso>&limit=30 | user | -> {items: ActivityDTO[], next: string or null}, newest first, across my groups. |
| POST | /api/activity/seen | user | {} -> {ok: true}; sets activity_seen_at = now. |

### Groups and members
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| POST | /api/groups | user | CreateGroupReq -> GroupSnapshotDTO. Each member email that finds another account counts toward the email-link limit (below). |
| GET | /api/groups/:gid | member | -> GroupSnapshotDTO. Sends `ETag: "<version>"` (`"<version>-legacy"` to a client without `X-Evenly-Features: refunds`, section 6, Compatibility); honors `If-None-Match` with 304. Materializes due recurring entries first. |
| PATCH | /api/groups/:gid | member | UpdateGroupReq -> GroupSnapshotDTO. Currency change: every entry's fxRate is re-based through today's rate old->new (entries already in the new currency get 1). `defaultSplit`: a DefaultSplitInput `{method: 'equal'\|'percent'\|'shares', entries: [{memberId, value?}], payerId?}` sets the group's default split (setAt now; checked against the active members by `checkDefaultSplit`: else 400 `validation` with `details: {code: 'default_split', reason, memberId?, diff?}`, reason one of `unknown_member`, `unknown_payer`, `duplicate_member`, `invalid_value`, `percent_mismatch`, `zero_weights`, `no_participants`), `null` clears it, the same one again changes nothing. The snapshot's `group.defaultSplit` is the DefaultSplit or null. |
| DELETE | /api/groups/:gid | admin | -> {ok: true} (soft delete) |
| PUT | /api/groups/:gid/archive | member | ArchiveReq `{archived: boolean}` -> ArchiveRes `{archived}`. My own lists only (section 4, Archive): writes my member row, no activity, no push, no version bump. GET /api/me then says `archived` on the group's list item. 400 `validation` without a boolean. |
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
email, emails without an account, and joining by invite or claim link do not count; accepting a
friend invite link that makes a new 1:1 ledger does (its owner gets a notification). Past it: 429
`rate_limited`, `details: {retryAfter, scope: 'links'}`, nothing written.

### Friend invites
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| GET | /api/me/invite?locale=zh-TW\|en | user | -> MyInviteDTO `{code, url, templates: [{key, label, text}]}`: my code (made on the first call), the link to share (`<APP_URL>i/<code>?openExternalBrowser=1`), and the messages `everyday`, `trip`, `roommates` in `locale` (else the account's language). `text` has no link: clients put the link after it on its own line. |
| POST | /api/me/invite/reset?locale= | user | {} -> MyInviteDTO with a new code; the old one is `code_invalid` from then on. Friends made with it stay friends. |
| GET | /api/invite/:code | optional | -> InviteInfoDTO `{inviter: {name, color, avatar}, self, groupId}`: `avatar` is the photo's version or null; `self` is true when the code is the caller's own; `groupId` is the 1:1 ledger the signed-in caller and the inviter are both active in, else null. Never an email. 400 `code_invalid` for a code nobody has (reset, or never made) or of the wrong shape. Without a sign-in, 30 per 15 minutes per IP (`INVITE_IP_PER_15M`; staging 1000). |
| GET | /api/invite/:code/avatar?v=<version> | none | -> the inviter's photo for anyone holding the code (the invite page shows it before anyone signs in), answered as `GET /api/users/:userId/avatar` is: with `v`, `private, max-age=31536000, immutable`; without, the current photo with `no-cache`; `Cross-Origin-Resource-Policy: same-origin`; `Vary: Origin`. One 404 for no photo, a code that does not work and an old `v`. |
| POST | /api/invite/:code | user | {} -> InviteAcceptRes `{groupId, existed}`: the 1:1 ledger the two are both active in (`existed: true`, nothing written), else a new `pair` group (section 4) with a `friend.join` row. 400 `own_invite` for the caller's own code, 400 `code_invalid`, 409 `limit_reached` (either person in 200 groups), 429 `rate_limited` with `scope: 'links'` (the email-link limit above). |

The page the link opens, `GET /i/<code>` (and `/i/<code>/`), is not JSON: the Worker serves the
built `index.html` with the invite's preview tags (Open Graph, the Twitter card, the description and
the title): 「<name> 邀請你一起用吉諾分帳所分帳」 or "<name> invited you to split costs on Gino's Split
Lab" in the inviter's language, a line on what joining means, `og:url` the share URL, and the
mascot (`/og-image.png`, 1200 x 630) as the image; no email and no photo. A code that does not
work, a HEAD, more than 120 page loads per IP in 15 minutes, or a failed lookup get the page with
the app's own preview tags. In a browser, `index.html`'s first script moves the address to
`/?openExternalBrowser=1#/i/<code>` before anything else loads, and the app starts there. Every
other page of the app carries the generic preview (the app's name, a one-line description, the
same image). The answer is a page load like `/`: the session cookies renewed, `private, no-cache`,
`X-Frame-Options: DENY`.

### Expenses, comments, history
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| PUT | /api/groups/:gid/expenses/:eid | member | UpsertExpenseReq -> UpsertExpenseRes. Creates or updates (idempotent; the client makes the UUID). Server validates members (any member of the group, active or not), recomputes shares, checks payers, writes activity, bumps group version, refreshes summary. `rateBase` = the group currency the rate was chosen against (converted if the group currency changed since). Edits send `baseVersion` and `base` (the entry as the form opened): the server merges only the parts this save changed; a part someone else also changed returns 409 `conflict` (details code `edited_elsewhere`). `kind` is `expense`, `payment` or `refund` (section 2, Refunds; a refund's `repeat` is stored as `none`). `refundOf` (refunds only): an id kept when it names another expense of this group, else stored as null, never refused; a save without the field keeps the stored link; any other kind stores null. A save of a stored refund made in the legacy view (section 6, Compatibility) is merged in that view and stored as the refund again. |
| DELETE | /api/groups/:gid/expenses/:eid | member | -> {expense, groupVersion} (soft delete; a receipt photo stays a day, so 復原 brings it back, section 6, Receipt photos) |
| POST | /api/groups/:gid/expenses/:eid/restore | member | -> {expense, groupVersion} |
| GET | /api/groups/:gid/expenses/:eid/history | member | -> {items: ActivityDTO[]} |
| GET | /api/groups/:gid/expenses/:eid/comments | member | -> {comments: CommentDTO[]} |
| POST | /api/groups/:gid/expenses/:eid/comments | member | {id?, body} -> {comment, groupVersion} (1 to 1000 chars) |
| DELETE | /api/groups/:gid/comments/:cid | member (author only) | -> {ok: true, groupVersion} |
| POST | /api/groups/:gid/import | member | BatchImportReq (max 500) -> {imported: number, groupVersion}. Refunds are imported like expenses, with `refundOf` null. |

### Compatibility (X-Evenly-Features)

A client lists the newer parts of the API it understands in the `X-Evenly-Features` request
header, comma separated (`src/worker/compat.ts`); today the only one is `refunds`. The web app
sends `X-Evenly-Features: refunds` on every call (`lib/api.ts` CLIENT_FEATURES), and the iPhone app
must too once it knows refunds. The iPhone app released before refunds decodes `kind` as expense or
payment only (also in an activity row's data), so a client without the header gets every refund in
the legacy view: `kind: 'expense'`, `payers` = the refund's shares (whose money it is), `split` =
`{method: 'exact', entries: [the refund's payers with their amounts as values]}`, `shares` = the
refund's payers; everything else (id, description, refundOf, receipt...) as it is. Every net, plan
and total is the same; only that app's own spending stats count the refund as spent. Where:
`GET /api/groups/:gid` and every other snapshot answer (POST and PATCH /groups), the PUT, DELETE and
restore answers, the 409 `conflict` details, an entry's history, `/api/activity` and the admin
account detail (`data.kind` 'refund' reads 'expense'; a change of kind that then reads expense to
expense is left out). The snapshot's ETag is `"<version>-legacy"` for that view, so neither view
is ever kept for the other on a 304. `GET /api/me` has no kinds, and `GET /api/me/export` keeps
refunds as they are for every client (a file to keep; the old app reads it as plain JSON).

A PUT of a stored refund is read in the legacy view when the client has no `refunds` (unless it
sends a refund itself), and when a client with it sends an expense whose `base` (or, without one,
the body itself) has the legacy view's money: an edit queued in the old app's outbox before an
update goes out later with the new header. Such a save is merged against the legacy view of the
stored refund (the 3-way merge as usual, 409 on a clash), then stored as a refund again: money as
the legacy view shows it keeps the refund's own (its split as made); changed money is read back
the other way round (the split's people got the money back, with their shares; the payers are
whose money it was, an exact split).

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

The photo sent here is read once and dropped: the scan stores nothing, and neither the photo nor
its text is logged. (The app keeps a smaller copy with the expense only through the receipt photo
routes below.) Limits: `RECEIPT_PER_DAY` scans per account (default 30) and `RECEIPT_GLOBAL_PER_DAY` for
the whole app (default 300; staging 40), in fixed UTC days. Past one of them, or when the Workers
AI daily allowance is used up (error 3036): 429 `rate_limited` with `details.scope` `user`, `app`
or `ai` and `retryAfter` to 00:00 UTC. That allowance belongs to the Cloudflare account, shared by
staging and production, while our limits count per environment: hence the small staging limit and
the owner-only `?model=` (the other models cost 5 to 10 times as much). 502 `scan_failed` with
`details.reason`: `model` (the model failed or gave no JSON, or the AI binding is missing),
`timeout` (55 s), or `unreadable` (no total, no items and no store name). Only an attempt that
passes the body, field, `?model=` and binding checks counts toward the limits; from there every
attempt counts, a failed model call included.

### Profile photo
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| PUT | /api/me/avatar | user | AvatarReq `{image}`, a `data:image/jpeg;base64,` or `data:image/png;base64,` data URL -> AvatarRes `{avatar: "<version>"}`. The route reads the body itself, up to 401,024 bytes (`AVATAR_MAX_BODY`: 150,000 bytes as base64 with every `/` escaped as `\/`, which Apple's JSON encoders do). |
| DELETE | /api/me/avatar | user | -> `{avatar: null}`, also when there was none. |
| GET | /api/users/:userId/avatar?v=<version> | user | -> the bytes, `Content-Type` the stored type, `ETag: "<version>"`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin` (no other site, a sibling `*.ginochang.com` one included, can show it with the viewer's cookie; CORS fetches and the iOS app are not affected); with `v`, `Cache-Control: private, max-age=31536000, immutable`, without, the current photo with `private, no-cache`. `If-None-Match` with the version: 304. |

The app makes the image (center-cropped square, 256 x 256, JPEG quality 0.85; section 8.3). The
Worker keeps at most 150,000 decoded bytes (`AVATAR_MAX_BYTES`) whose start matches the data URL's
type (JPEG `FF D8 FF`, PNG `89 50 4E 47`); anything else, a body that is not JSON included, is 400
`bad_request` with `details: {fields: ['image']}`. At most 30 uploads per account a day
(`AVATAR_PER_DAY`; a fixed window in `rate_limits`, key `avatar:<uid>`, counted once the checks
pass): past it 429 `rate_limited` with `retryAfter`. The version is the first 16 hex characters of
SHA-256 of the bytes, kept in `avatars.version` and `users.avatar`. A change (a new version, or a
removal) bumps the version of every group the account has a member row in, in the same batch, as
PATCH /api/me does for a name (`touchUserGroupsStmt`: `groups.updated_at` stays), so cached
snapshots and their ETags pick it up; the same photo again writes nothing. No activity row and no
push. A cookie write needs this origin like every other one (403 `forbidden`).

Who sees a photo: the person, and an active member of a live group in which the person has a
member row linked to their account (`members.user_id`), active or not (people who left still show
in old entries). Placeholders never have one. GET answers 404 `not_found`, the same body every
time, when there is no photo, the requester may not see it, or `v` is given and is not the current
version. It says `Vary: Origin`, not `Vary: *` (below): the answer is private and its `?v=` address
never changes its bytes, so a shared cache never stores it and the browser keeps it for a year.

The DTOs carry the version as `avatar` (string or null): UserDTO, MemberDTO (null for
placeholders), `GroupListItemDTO.members[]` and FriendDTO (null for `m:` friends). Older clients
ignore it; the app treats a missing field as null. A client builds the photo's address as
`<API base>/api/users/<userId>/avatar?v=<avatar>`.

### Receipt photos
A photo of the receipt kept with its expense (since 2026-10-25), on the free plan of Workers KV
(binding `RECEIPTS`: 1 GB stored, 1,000 writes and 100,000 reads a day, for the whole Cloudflare
account). Group members see it. Scanning (above) stays as it was.

| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| PUT | /api/groups/:gid/expenses/:eid/receipt?w=<px>&h=<px> | member | The body is the image itself, `Content-Type: image/jpeg` or `image/png` (no JSON, no base64), at most 600,000 bytes (`RECEIPT_PHOTO_MAX_BYTES`; 413 above, checked on `Content-Length` and again while the body arrives) -> ReceiptRes `{receipt, groupVersion}`. Replaces any earlier photo of the entry. |
| GET | /api/groups/:gid/expenses/:eid/receipt?v=<version> | member | -> the bytes with their `Content-Type`, `ETag: "<version>"`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`; with `v`, `Cache-Control: private, max-age=31536000, immutable`, without, the current photo with `private, no-cache`. `If-None-Match` with the version: 304 (KV is not read). |
| DELETE | /api/groups/:gid/expenses/:eid/receipt | member | -> ReceiptDeleteRes `{groupVersion}`; removes the row and the KV object now. No photo: the same answer, nothing changes. |

- Checks on PUT, in order: `w` and `h` whole px from 1 to 4000 (`RECEIPT_MAX_SIDE`; else 400
  `bad_request` with `details: {fields: ['w']}` or `['h']`); the Content-Type (400, `fields:
  ['body']`); the size (413); an active member of the live group whose expense this is and is not
  deleted (404 `not_found`); a body whose start matches its type (JPEG `FF D8 FF`, PNG
  `89 50 4E 47`; else 400 `fields: ['body']`). Then the limits: 40 uploads per account a UTC day
  (`RECEIPT_PHOTO_PER_DAY`, key `receipt-photo:user:<uid>:<day>`; 429 `rate_limited`, `scope:
  'user'`, `retryAfter` to 00:00 UTC), counted once the photo passed the checks; the same photo
  again (same version) writes nothing and answers what is stored; the stored total
  (`SUM(receipts.bytes)`) plus the new photo past 950,000,000 bytes (`RECEIPT_STORE_MAX_BYTES`) is
  503 `receipts_full`; past RECEIPT_KV_WRITES_PER_DAY KV writes for the whole app in a UTC day (900 by default; production sets 500, staging 60)
  (`RECEIPT_KV_WRITES_PER_DAY`, key `receipt-photo:kv:<day>`) is 503 `receipts_quota` with
  `retryAfter` to 00:00 UTC (also when KV itself refuses with its daily limit). Staging sets 60
  writes and 40,000,000 bytes (`[env.staging.vars]`): the KV allowance is the account's, shared
  with production.
- A PUT stores the object as `receipt:<eid>:<version>`, then one batch upserts the row, bumps the
  group version as an expense edit does and carries its summary along (no balance moves), then
  deletes the old object (a failed delete is logged and leaves it; the 50 MB under the 1 GB is room
  for that). A DELETE deletes the KV object first, then the row (a failed KV delete is 503
  `server_error` and keeps both). Both: no activity row and no push.
- Who sees it: an active member of the live group, the rule of the group snapshot; GET answers one
  404 `not_found` (the same body) for every refusal: no photo, not allowed, an old `v`. Works with
  the cookie (an `<img>`) and Bearer. `Vary: Origin`, not `Vary: *` (below).
- Deleting the expense (a soft delete) keeps the photo, so 復原 brings it back. The daily job
  deletes the photos (KV object, then row) of expenses deleted more than 24 hours ago and of
  deleted groups, at most 25 a run (`RECEIPT_CLEANUP_PER_RUN`, for the subrequest budget); since it
  runs once a day, a photo goes one to two days after its expense was deleted, and within a day
  after its group was. Deleting an account keeps the photos it uploaded (group content).
- ExpenseDTO carries `receipt`: `{version, mime, width, height, bytes}` or null, in every answer
  with an expense (snapshots, saves, deletes, restores, the 409 conflict's copy) and in the export,
  which has the metadata only, never the bytes. A client builds the address as
  `<API base>/api/groups/<gid>/expenses/<eid>/receipt?v=<receipt.version>`. Older clients ignore
  the field; the app treats a missing one as null. Recurring copies start without a photo.

### Other
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| GET | /api/fx?base=TWD&date=YYYY-MM-DD | none | -> FxRes (cached per day in D1; falls back to the latest earlier day) |
| GET | /api/health | none | -> {ok: true, env} |
| POST | /api/admin/reset-link | owner | {email} -> {url, expiresAt} |
| GET | /api/admin/stats | owner | -> {users, groups, expenses} counts |
| GET | /api/admin/users?q=&limit=&offset= | owner | -> {total, users: AdminUserRow[] (with `emailVerified`), stats: {users, newLast7, activeLast7, withEmail, withPassword, deviceOnly, groups, entries}}; `deviceOnly` = no email (an email signs in anywhere with a code); q matches name or email; newest first |
| GET | /api/admin/users/:id | owner | -> {user (row + payInfo, venmo, paypal), groups, sessions (label, createdAt, lastUsedAt, expiresAt), activity (latest 20)}; never hashes, session ids or tokens |

Validation limits: name 1 to 60 chars (trimmed), group name 1 to 80, description 0 to 120
(an expense or a refund needs a description; payments may be empty), notes 0 to 2000, payInfo 0 to 300,
venmo/paypal 0 to 50 `[A-Za-z0-9_.-]`, emoji 0 to 16 chars, color `#RRGGBB`, currency 3 uppercase
letters, category must be a known key (`categories.ts`) else `general`, date valid ISO date between
2000-01-01 and today + 1 year, amount 1 to MAX_AMOUNT, fxRate > 0 and < 1e9 (exactly 1 when the
currency equals the group currency), entries/items <= 50, item names <= 60.

CORS, for cross-origin Bearer callers only (old app builds, vite dev, tests; the app on the Worker's
own origin needs none): allow origins from `ALLOWED_ORIGINS` (comma separated), methods GET POST PUT
PATCH DELETE OPTIONS, headers `Authorization, Content-Type, If-None-Match, X-Evenly-User,
X-Evenly-Features`, expose
`ETag`, max-age 86400, and never `Access-Control-Allow-Credentials` (no other origin may read an
answer made with the cookie). Every `/api` answer says `Vary: *`, which no cache stores (the
evenly-v3 service worker still on some phones caches every same-origin GET, and its `Cache.put`
throws on `Vary: *`), except GET and HEAD `/api/fx`, which say `Vary: Origin` (public,
`max-age=3600`), and GET and HEAD `/api/users/:userId/avatar` and
`/api/groups/:gid/expenses/:eid/receipt`, which say `Vary: Origin` too (private and versioned; the
evenly-v3 worker keeps only ok answers, by URL, and a `?v=` address never changes its bytes); the
OPTIONS preflight says `Vary: Origin`. Answers without their own
`Cache-Control` get `no-store`.

## 7. Worker internals

- `src/worker/index.ts`: Hono app, CORS and the `Vary` and `Cache-Control` headers of section 6, the
  body-size gate, JSON error handler (ApiError -> body; ZodError -> 400 `validation`; anything else
  -> 500 `server_error` with the message logged, never leaked), page loads of `/` and `/index.html`
  (the built page with the session cookies renewed, section 3), friend invite pages `/i/<code>`
  (the same page with the invite's preview tags, section 6, Friend invites) and paths with no file
  (section 1), mounts route modules, and `scheduled()`, which runs the push sender for the
  `* * * * *` cron and `runDaily` for the daily one.
- `src/worker/env.ts`: `Env` bindings (D1, ASSETS, AI, RECEIPTS) and vars, Hono `AppEnv` type, `AuthUser`
  (with `via: 'bearer' | 'cookie'`).
- `src/worker/http.ts`: `ApiError`, `fail(status, code, message, details?)`, `readJson(c, schema)`,
  `nowISO()`, `newId()`, `randomToken(bytes)`, `sha256Hex(s)`.
- `src/worker/db.ts`: row types, row -> DTO mappers, common queries (`getGroupForMember`, ...).
- `src/worker/auth.ts`: password hash/verify, sessions from the Bearer header or the session
  cookies (section 3), `requireUser` / `optionalUser` middleware, `startSession` for sign-ins, the
  cookie helpers, `rateLimit(db, key, limit, windowSec)`.
- `src/worker/routes/*.ts`: one module per area (auth, me, groups, invites, expenses, fx, admin,
  push, receipts, avatars, receiptPhotos).
- `src/worker/routes/invites.ts` and `services/invitePage.ts`: friend invite links (section 4 and
  section 6, Friend invites): the code, the routes on the 1:1 ledger rules of `routes/groups.ts`
  (`pairGroupOf`, `createPairGroup`, `assertGroupRoom`, `limitLinks`), and the preview tags written
  into `index.html` for `/i/<code>`.
- `src/worker/routes/receiptPhotos.ts` and `services/receiptPhotos.ts`: the receipt photos of
  section 6 (the three routes; the KV key and the daily cleanup).
- `src/worker/routes/avatars.ts`: the profile photo (section 6, Profile photo): PUT and DELETE
  /api/me/avatar, GET /api/users/:userId/avatar with the visibility rule in one query, and the
  helpers the export uses (`avatarDataUrl`, `blobBytes`).
- `src/worker/services/emailCodes.ts`: the email codes of section 3 for both route modules
  (`countStart` the start limits, `sendCode` makes, stores and mails or echoes a code, `checkCode`
  takes one try, `consumeCode` spends it), and `services/email.ts`: `sendEmail` (Resend, 10 s,
  typed `EmailError`), the code message (`codeMessage`), `canSend`, `canEcho` and `undeliverable`.
- `src/worker/services/google.ts`: Sign in with Google of section 3 (configuration, the flow
  cookie, the return path, PKCE and the consent URL, the code exchange, Google's keys and
  `verifyIdToken`, the new account's name), typed `GoogleError`; the routes are in `routes/auth.ts`.
- `src/worker/services/summary.ts`: `refreshSummary(db, groupId)` reads members + entries, computes
  with `shared/summary.ts`, writes `UPDATE groups SET summary=? WHERE id=? AND version=?`.
- `src/worker/services/activity.ts`: builds activity rows (nets per member in group currency via
  `shared/balances.entryNet`), with `push_at` (`pushAtFor`, section 5) in the same INSERT, so the
  push intent commits or rolls back with the change.
- `src/worker/services/push.ts`: `runPushSender(env, now?)`, run every minute by the cron in
  production and by POST /api/push/run. Who hears about what: a new expense reaches the members in
  its nets (payers and people with a share), a payment its sender and recipient, a join or claim
  everyone else, an add the added person, a new group or 1:1 ledger the other members, a Splitwise
  import everyone else (one summary), a friend invite accepted (`friend.join`) the link's owner
  (「Abbie 透過你的邀請連結加入」, then 「你們現在是朋友了」). Only active members whose account was
  linked when it happened (`members.claimed_at`), never anyone who wrote one of the rows, and then
  each person's prefs (`expenses` covers expenses and the import, `payments` payments, `joins`
  joins, adds, new groups and accepted friend invites). Edits, deletes and restores only merge with a create in the same run: created then
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
- `src/worker/services/receipt.ts` (the scan): the receipt prompt and JSON schema, one Workers AI call per scan
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
- `avatars.ts`: profile photos for `Avatar` and the account button (`useAvatarPhoto(userId,
  version)`). Cookie mode: an `<img>` loads `<API base>/api/users/<id>/avatar?v=<version>` with the
  cookie, and the browser keeps it a year. Bearer mode: an `<img>` cannot send the token, so the
  photo is fetched with it and shown from an object URL. A photo that does not load shows the
  initial in the same size and outline, and is not asked for again until the browser is back
  online. `photo.ts`: decoding a picked photo with its orientation and encoding a canvas as JPEG,
  for the receipt scan, the receipt photo kept with an expense (`receiptPhoto`: longest side at
  most 1600 px, JPEG 0.7, then 0.55 and 0.4 and smaller sizes until it fits 600,000 bytes) and the
  profile photo. `receipts.ts`: a receipt photo's address and `useReceiptImage`, loaded like a
  profile photo (an `<img>` with the cookie, or fetched with the token in Bearer mode).
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
| `#/invite-friends` | 邀請朋友: my friend invite link (in the shell, under 朋友) |
| `#/activity` | Activity feed |
| `#/account` | Account and settings |
| `#/admin` | Owner tools |
| `#/join/:code`, `#/claim/:token` | Join flows |
| `#/i/:code` | A friend invite (full screen, works signed out; `https://<site>/i/<code>` lands here) |

### 8.3 Screens (behavior)
- **Home**: totals per currency (別人欠你 / 你欠別人, approximate total in my home currency from
  `/api/fx`), friends with non-zero balances (欠你 / 你欠), groups with my status (你可以拿回 /
  你要付 / 已結清), the protect-your-account card for accounts without a confirmed email
  (保護你的帳號 with 加上 Email, or 確認你的 Email for one typed before codes; it opens 我的 and goes
  once the email is confirmed), the offer to turn on notifications (section 8.6), Add to Home
  Screen hint on iOS Safari (once, dismissible). Primary action: 新增費用 (asks which group or
  friend first). Groups I archived are not in its 群組 section (nor in the desktop sidebar's recent
  groups or the 新增費用 group pickers), but their money is in the totals; when every group is
  archived, the section says so and links to 群組.
- **Groups** (群組, `features/groups/GroupsPage.tsx`, lists from `groupLists.ts`): groups with
  something to settle or recent first, then 已結清的群組 (folded), then 「已封存（N）」 (folded, at
  the bottom): each archived group's row with its balance and a 取消封存 button under it, and a
  line saying their money still counts and that a group comes back when someone else adds an
  entry. 取消封存 needs a connection.
- **Welcome** (開始使用): 你的名字 and Email, 寄驗證碼, then the code step: one field for the 6
  digits (number pad, `autocomplete="one-time-code"`), checked as soon as all 6 are in, 重新寄送
  after 60 s, 換一個 Email. A new email makes the account; one with an account signs in to it
  (toast 歡迎回來，{name}). Then the app starts as before: the page remembered before the sign-in
  gate opens (`goToReturn`), and the Home Screen app's `?install=` code still signs in on top of
  this page. No name-only start. Where Google can work (section 3, Google), 使用 Google 帳戶登入
  and a small 或 top the card; it comes back to the remembered page, so a pending invite or claim
  goes on.
- **Login** (登入): 使用 Google 帳戶登入 and 或 where Google can work (a Google sign-in that came
  back here says why above it), Email and 寄驗證碼, then the code step (an email without an account asks for a
  name there and makes one); 用密碼登入 shows the email and password form, whose 忘記密碼？用驗證碼登入
  goes back to the code with the email kept; 用其他裝置的登入碼 (LinkPage) stays.
- **Group page**: header (emoji, name, member avatars, currency, my status). Tabs:
  費用 (search box; month sections; rows show date, category icon, description, who paid what,
  my effect: 你借出 / 你借入 / 沒有參與 / payments as 「A 付給 B」; a refund has a 退款 tag before its
  title, 「Gino 收到退款 ¥30,000」 under it and 你可以拿回 / 你要還 on the right; converted entries
  show the original amount and ≈ group-currency amount; pending-sync and failed states; recurring
  icon; comment count), 結算 (each member's net, the settle-up plan with 記錄還款 buttons and the
  receiver's payment info, simplify toggle with a one-line explanation, 分享結算 text via the Web
  Share API or clipboard, e.g. for LINE, and 分享結算圖卡 beside it: 結算圖卡, below), 統計 (total spent, per person paid vs share, by category,
  by day for trips; refunds come off the total, their category, day and month, and the note says
  how many refunds are in it), 設定 (name, emoji, color, type, currency, simplify, notes, members, invite link
  with QR and share, claim links, 預設分法 (a row with the default in words, 「比例：你 60%、Abbie
  40%」 over 「新增的人付款」, or 沒有設定; it opens the split sheet with 平均 / 比例 / 份數, no amount,
  and 誰付款 (新增的人, or a member), whose 儲存 sets it; 清除 beside the row, with 復原 in the toast; a
  note under it when someone is new or it no longer adds up), export CSV (類型 says 退款 for a
  refund, whose two amounts are negative, as a Splitwise export writes money coming back), import
  Splitwise CSV (a row with a negative Cost that one person got back becomes a refund of the whole
  Cost; with several people getting money back it is unclear who got how much, so it is rebuilt from
  the balances as an expense with the same effect, as before; the preview counts refunds), 你的列表 > 封存群組 / 取消封存
  (not for 1:1 ledgers; an unsettled group asks first: 「確定要封存嗎？」 「你在這個群組還有 ¥22,500
  沒結清（你欠）。封存只會把它從你的總覽和群組列表收起來，…」; a settled one goes at once with 復原
  in the toast), leave, delete).
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
  photo (section 8.7). 附收據 (after 備註 and 重複) keeps a receipt photo with the entry: a small
  thumbnail with × once attached (a scan's photo stays attached the same way); editing shows the
  entry's photo with replace (tap it) and ×. In a group with a default split (section 4), a new
  expense starts from it and from its payer; while the split is still that one, a note says who
  is not in it (「新成員不在預設分法裡：Lily」) or why it was not used (「預設分法的比例加起來不是
  100%（有人離開了），這筆先平均分」). The split sheet ends with 「設為這個群組的預設分法」 (a checkbox
  on a sky card, `split-set-default`): ticked, 完成 also saves the split as the group's default
  (keeping its default payer), with a toast; checked and disabled when the split already is the
  default; disabled with a reason for 金額 / 加減 / 品項, a split that does not add up, and offline.
  Refunds (section 2): 費用 / 退款 in the header where the title was (`editor-kind`; payments keep
  their title); a refund reads 「退款給 [你]，[平均分給 4 人]」 / "Refunded to [you], [split
  equally, 4 people]" (the payer sheet becomes 誰收到退款, 多人收到), my effect 你可以拿回 / 你要還, the
  2-person presets 我收到，平分 / 我收到，全是對方的 / 對方收到，平分 / 對方收到，全是我的, and no 重複 and
  no 掃描. `#/g/:gid/add?refundOf=<eid>` (記一筆退款) opens a refund of that expense: its split and
  values, its payers as who got the money back (with their amounts), the full amount in its
  currency, its category, 「退款：<description>」, and refundOf; an expense that is not there starts a
  plain refund.
- **Expense detail**: amount, description, category, date, who added and when, the receipt photo
  (a thumbnail in its own shape; a tap opens it full screen; 移除收據), payers, each member's
  share, conversion details, notes, repeat, comments (add, delete own), history (activity entries
  for this expense), 編輯 / 刪除 (with undo) / 復原 for deleted ones. An expense has 記一筆退款 and,
  when it has refunds, a 退款（N 筆） section linking each; a refund has the 退款 tag, 退款金額, 收到退款的人,
  and a 退的是 row linking to its expense (or saying it is gone).
- **結算圖卡** (since 2026-10-26, `features/groups/settleCard.ts`, `settleCardDraw.ts`,
  `SettleCardSheet.tsx`): one picture of where a group stands, made on the device only (no server
  call; only what every member can already see), the same card the iPhone app makes. 1080 x 1350
  PNG drawn on a canvas once the app's fonts are loaded for exactly its text (`document.fonts.load`
  for Huninn and M PLUS Rounded 1c 800, then `document.fonts.ready`; after 10 s it is drawn
  anyway). On it: the group's emoji tile and name and the days its expenses and refunds span
  (payments do not stretch it), the total spent (expenses less refunds), each person's 付了 / 分到
  by name (never 你, never photos: initials in their colors), the top 3 categories, and the plan 結算
  shows (or 大家都結清了！), with the mascot on the summary card and 「吉諾分帳所 split.ginochang.com」 on
  the grass. More than 8 people show 7 and 「還有 N 人」 (their amounts added up); more than 6
  payments show 5 and 「還有 N 筆」. In the app's language. The sheet (結算圖卡) shows the PNG; 分享
  hands the file to the share sheet where `navigator.canShare({files})` allows it, with 下載 beside
  it; elsewhere 下載圖片 saves it (「<group> 結算圖卡.png」).
- **Settle up**: from and to pickers (default from the plan), amount (default the plan amount),
  currency (group currency default), date, note, the receiver's payInfo, and buttons that open
  Venmo (`https://venmo.com/<user>?txn=pay&amount=<x>`) or PayPal.me
  (`https://paypal.me/<user>/<x><CUR>`) when set.
- **Friends**: list with totals; friend page as in section 4. 邀請朋友 sits next to 新增朋友 in
  the band, under the list, and in the empty state (there as the primary button); 我的 has a row
  for it too.
- **邀請朋友** (`#/invite-friends`, `features/invite/InviteFriendsPage.tsx`): my link from
  `GET /api/me/invite` in the app's language, as the group invite's boarding pass with its QR code
  to scan across the table and the link under it; the three messages as chips (日常, 旅行, 室友)
  over a text box that starts with the chosen one's words (the last pick is remembered on the
  device, `localStorage['evenly.inviteTemplate']`; edits are not, and a chip replaces them); 分享
  (the share sheet on phones: the text, then the link on its own line, `shareMessage`), 複製文案
  (the same to the clipboard), 複製連結; and 重設連結 behind a confirmation that the old link and
  QR code stop working at once (friends already made stay). Nothing focuses the text box from
  script; the app-wide focus release covers it (DESIGN.md 9.5).
- **Friend invite** (`#/i/:code`, `features/invite/InvitePage.tsx`): the inviter's face and
  「<name> 邀請你一起分帳」 on a sky card. Signed out: 加為朋友 opens 用 Email 加入 (the address, the
  code, and a name when the address has no account), and 使用 Google 帳戶登入 and 已有帳號？登入 go
  and come back here; any sign-in started here accepts as soon as it is back (a mark in
  `sessionStorage` for that code, 30 minutes), since opening the link and signing in is the yes.
  Signed in: one 加為朋友, then the 1:1 ledger opens with 「你和 Gino 現在是朋友了」. Already friends:
  「你和 Gino 已經是朋友了」 and 打開你們的帳本. My own link: 「這是你自己的邀請連結」 with 邀請朋友. A code
  that does not work: 「這個邀請連結已經失效」 and how to get a new one. The 群組 page's 用邀請連結加入
  takes a pasted friend invite link of either form (`/i/<code>` or `#/i/<code>`) too, and opens it.
- **Activity**: newest first, unread marked, each item says who did what and my effect
  ("你借出 ¥10,500"), tap opens the expense or group; loads more on scroll.
- **Account**: Add to Home Screen (iPhone) and right under it 通知 (section 8.6), name, profile
  photo (頭像照片: 上傳照片, then 換照片 and 移除照片; a hidden `<input type="file"
  accept="image/*">`; the picked photo is center-cropped to a square and drawn at 256 x 256 in a
  canvas, JPEG 0.85, and saved at once rather than with 儲存; then the dashboard and the groups
  kept on the device update, so every avatar shows it), color,
  language (中文 / English), home currency, payment info (Venmo, PayPal.me, free text), sign-in
  (an account without a confirmed email gets the yolk card at the top: 加上 Email, or 確認你的
  Email prefilled, an email then its code; with a confirmed email, 登入方式 shows it with 更換
  Email, an email then its code, warning first when a password would go, 已連結 Google when a
  Google account is linked (no unlink yet), and an optional
  password, set or changed with the current one), devices (sessions list with revoke;
  "在其他裝置登入" shows the link code and QR), export my data (JSON download), sign out (in cookie
  mode it needs a connection and says so offline, section 3; it warns when the account has no
  email), delete account, about.
- **Join / Claim**: as in section 4 (signed out, 用 Email 加入 comes first); after joining, open the
  group.

### 8.4 Offline and sync
- On start, render immediately from IndexedDB (me, groups, outbox), then refresh from the server.
- Outbox items (upsert, delete, restore, comment, receipt) are applied optimistically to the cached group,
  flushed in order when online (on `online`, on focus, every 15 s while pending), retried with
  backoff on network errors or 5xx or 429, marked failed on other 4xx (row shows 同步失敗 with
  重試 / 放棄). A receipt item (a photo as a data URL, or a removal) is queued right after its
  entry's save, so it goes up once the entry exists; a newer photo change of the entry replaces
  one not sent yet; a day's limit (429, 503 `receipts_quota`) waits for its `retryAfter`, and 503
  `receipts_full` fails for good.
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

### 8.7 Receipt scan (掃描) and receipt photos (附收據)
The scan reads: the photo is sent once, read by Workers AI and dropped (section 6). A smaller copy
of the same photo stays attached to the expense (below) and is kept with it once saved (section 6,
Receipt photos).
- 掃描 / Scan (camera icon) sits in the expense editor header's empty right cell, only when adding
  an expense (not editing, not payments); icon only under 360 px; no new row. Offline it is
  aria-disabled and a tap says 「離線中不能掃描收據，連線後再試」.
- A tap opens a hidden `<input type="file" accept="image/*">` without `capture` (iPhone offers the
  camera and the photo library). The photo is shrunk in the browser (`createImageBitmap` with the
  EXIF orientation, canvas, JPEG 0.85, long side at most 1600 px, which also drops EXIF and GPS)
  and never put in the draft, the stash, IndexedDB or a log. The same drawing gives the copy that
  stays attached (`photo.ts` receiptPhoto, JPEG 0.7), which waits in the editor until 儲存. Then `POST /api/receipts/scan` with
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
  the Worker's `warnings`) and, the first time on a device, 「照片會附在這筆費用上，群組的人看得到，
  不想留的話按 × 移除」 (「照片只用來辨識，不會存起來」 when no copy could be attached). Its 復原
  (`revertScan`) puts back only the fields that still show the scan; anything typed since the scan
  (an amount, a 品項 line, a payer's or a person's amount, a rate) was typed in the scan's currency,
  so then the currency and the scan's amounts stay, and a second toast says why.
- Errors (`editorText.scanErrorText`): each 429 scope (`user`, `app`, `ai`), each `scan_failed`
  reason, offline, timeout, a photo that cannot be opened, too large, not a photo.
- 附收據 / Attach receipt (`editor-receipt-attach`) opens a hidden `<input type="file"
  accept="image/*">` without `capture` (camera or library). The photo is shrunk on the device
  (longest side at most 1600 px, orientation applied, JPEG about 0.7, smaller until it fits
  600,000 bytes; re-encoding drops EXIF and GPS) and shows as a thumbnail in a yolk pill with ×
  (`editor-receipt-thumb`, `editor-receipt-remove`). Offline works: nothing goes out yet. 儲存
  queues the save, then the photo (`actions.attachReceipt`), so a new expense's photo goes up
  right after its save; offline or on failure it waits in the outbox and retries like the save.
  The photo is never in the draft or the stash (hundreds of KB): leaving the editor unsaved drops
  it. Editing an entry shows its photo; tapping it replaces it, × removes it on 儲存
  (`actions.removeReceipt`).
- The detail page shows the photo (aspect ratio from `width` and `height`, the versioned GET; a
  photo still in the outbox from its data URL, with 「收據照片等待上傳」 or why it waits), opens it
  in a full-height sheet on a tap (the browser's pinch zoom), and 移除收據 asks first, then removes
  it through the outbox. Expense rows show a receipt glyph after the title.
- Their errors (`editorText.receiptStatusText`): the day's uploads used up (`receipts_quota`, and
  429 for the account's 40), the store full (`receipts_full`), too large, the entry gone, offline;
  a photo that cannot be opened (`receiptPhotoErrorText`).

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
  and deletes it again. Production mails codes and never answers with one, so the account comes
  from `POST /api/auth/signup` (a name alone) fetched by the loaded page: same origin, so the
  cookie path is still the one tested, and the page then reloads into the sign-in. It signs up
  nothing unless `/api/health`, from Node and from the loaded page, says `EXPECT_ENV` (default
  `production`), sends a Bearer cleanup to the origin that answered the signup, and checks that
  `GET /api/push/status` hands out the `VAPID_PUBLIC_KEY` that `wrangler.toml` lists for that
  environment. The UI tests on staging (`flows.cjs`, `cookie-flows.cjs`) sign up with email codes
  and read each code from the start answer (`devCode`, staging's test mode).
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
| 邀請朋友 / 加為朋友 / 重設連結 | Invite friends / Add as a friend / Reset link |
| 日常 / 旅行 / 室友 (the invite messages) | Everyday / Trip / Roommates |
| 收款方式 | How to pay me |
| 等待同步 / 同步失敗 | Waiting to sync / Sync failed |

## 10. Out of scope for v1
Email notifications (the only email is the sign-in code); push notifications for edits, deletes and restores of entries already
announced, for comments and for recurring copies; quiet hours (the device's time zone is stored for
them); a per-group mute (the three kinds switch off for every group at once); more than one receipt
photo per expense, and receipt photos in the export (it has their metadata); unlinking a Google
account (later: 取消連結 on 我的, for an account that keeps another way in; until then the owner
clears `users.google_sub` on request), Sign in with Google and with Apple in the iOS app (later,
together); passkeys, real-time sockets, non-group
expenses with several friends at once (use a group). A native iOS app is built in its own repo
(evenly-ios) on the Bearer API; it links to `public/privacy/` and `public/support/` here, the only
copy of those pages.
