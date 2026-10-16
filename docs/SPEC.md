# Evenly: product and engineering spec (v1)

Evenly (「Evenly 分帳」) is a free Splitwise-style web app for recording shared costs on trips and
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
- `src/worker/` Cloudflare Worker (Hono 4 router, zod 3 validation, D1). Deployed as `evenly-api`
  (production) and `evenly-api-staging`. Config in `wrangler.toml`, schema in `migrations/`.
- `src/web/` React 19 single-page app, built by Vite 7, hash routing (`#/g/<id>`), served by GitHub
  Pages at https://richlovegod.github.io/evenly/ (later a ginochang.com subdomain). PWA with a
  hand-written service worker (`public/sw.js`) and IndexedDB cache + outbox for offline use.
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
- Shares come from `split.computeShares(total, split, priority)`. `priority` = payer member ids, so
  the payer absorbs rounding leftovers. The server recomputes shares and never trusts the client.
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
  or password and returns a bearer token (a "device-only" account). The UI then nudges (not forces)
  them to add an email + password ("換手機或清除瀏覽器資料後也能登入"), because Safari can wipe a
  site's storage after 7 days without a visit unless the app is on the Home Screen.
- Email + password: optional at signup, can be added later (`POST /api/me/credentials`). Email is a
  login identifier only (no emails are sent; we have no mail sender). Passwords >= 8 characters,
  PBKDF2-SHA256 100,000 iterations (the Workers maximum), 16-byte salt.
- Sessions: 32 random bytes, base64url, sent as `Authorization: Bearer <token>`; the DB stores only
  SHA-256(token). 365-day expiry, `last_used_at` refreshed at most once per hour. Stored in the
  browser in `localStorage['evenly.token']`.
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
- Limits: 50 active members per group, 5,000 entries per group, 200 groups per user.

## 5. Database

See `migrations/0001_init.sql`. JSON columns: `expenses.payers`, `expenses.split`,
`expenses.shares`, `groups.summary`, `activity.data`, `fx_cache.rates`. Booleans are 0/1 integers.

## 6. HTTP API

Base URL: production `https://evenly-api.richlovegod.workers.dev`, staging
`https://evenly-api-staging.richlovegod.workers.dev`. All paths start with `/api`. JSON in and out.
Errors: HTTP status + `ApiErrorBody` (`{error: {code, message, details?}}`, codes in
`shared/types.ts`). 400 `validation` carries zod issues in `details`. Auth: `Authorization: Bearer`.
"member" below means: signed in AND an active member of the group, else 404 `not_found` (do not
reveal that the group exists). Bodies over 256 KB get 413.

### Auth
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| POST | /api/auth/signup | none | SignupReq -> AuthRes. If email given, password required (`password_required`), `email_taken` when used. Rate limit 10/hour/IP. |
| POST | /api/auth/login | none | LoginReq -> AuthRes. `invalid_credentials` (generic). Limits: 10 per 15 min per email, 30 per 15 min per IP. |
| POST | /api/auth/logout | user | {} -> {ok: true}; revokes this session. |
| GET | /api/auth/sessions | user | -> {sessions: SessionDTO[]} |
| DELETE | /api/auth/sessions/:id | user | -> {ok: true} (own sessions only) |
| POST | /api/auth/link-code | user | {} -> LinkCodeRes |
| POST | /api/auth/link | none | {code} -> AuthRes; `code_invalid`. Limit 10 per 15 min per IP. |
| POST | /api/auth/reset | none | {token, password} -> AuthRes; revokes other sessions. |

### Me
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| GET | /api/me | user | -> MeDTO (dashboard: groups with my net and my transfers, friends aggregated, totals per currency, unread activity count). |
| PATCH | /api/me | user | UpdateMeReq -> {user: UserDTO} |
| POST | /api/me/credentials | user | CredentialsReq -> {user: UserDTO}; needs currentPassword if a password exists (`invalid_credentials`). |
| DELETE | /api/me | user | {password?} -> {ok: true}; password required if the account has one. |
| GET | /api/me/export | user | -> {user, groups: GroupSnapshotDTO[]} (everything I can see). |
| GET | /api/activity?before=<iso>&limit=30 | user | -> {items: ActivityDTO[], next: string or null}, newest first, across my groups. |
| POST | /api/activity/seen | user | {} -> {ok: true}; sets activity_seen_at = now. |

### Groups and members
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| POST | /api/groups | user | CreateGroupReq -> GroupSnapshotDTO |
| GET | /api/groups/:gid | member | -> GroupSnapshotDTO. Sends `ETag: "<version>"`; honors `If-None-Match` with 304. Materializes due recurring entries first. |
| PATCH | /api/groups/:gid | member | UpdateGroupReq -> GroupSnapshotDTO. Currency change: every entry's fxRate is re-based through today's rate old->new (entries already in the new currency get 1). |
| DELETE | /api/groups/:gid | admin | -> {ok: true} (soft delete) |
| POST | /api/groups/:gid/members | member | AddMemberReq -> {member: MemberDTO, groupVersion} |
| PATCH | /api/groups/:gid/members/:mid | member (role: admin) | UpdateMemberReq -> {member, groupVersion} |
| DELETE | /api/groups/:gid/members/:mid | admin, or self (= leave) | -> {ok: true, groupVersion}; `balance_not_zero`, `last_admin` |
| POST | /api/groups/:gid/members/:mid/unlink | admin | -> {member, groupVersion} |
| POST | /api/groups/:gid/members/:mid/claim-link | member | -> {token, url, expiresAt} (placeholders only, else `member_claimed`) |
| POST | /api/groups/:gid/invite/reset | admin | -> {inviteCode} |
| GET | /api/join/:code | optional | -> JoinInfoDTO (404 when the code is unknown) |
| POST | /api/join/:code | user | JoinReq -> {groupId, memberId}; `member_claimed`, `already_member` returns the existing ids with 200. |
| GET | /api/claim/:token | none | -> ClaimInfoDTO |
| POST | /api/claim/:token | user | {} -> {groupId, memberId}; if the user is already a member of that group: `already_member`. |
| POST | /api/friends | user | {name, email?} -> {groupId} (pair group, created or existing) |

### Expenses, comments, history
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| PUT | /api/groups/:gid/expenses/:eid | member | UpsertExpenseReq -> UpsertExpenseRes. Creates or updates (idempotent; the client makes the UUID). Server validates members (any member of the group, active or not), recomputes shares, checks payers, writes activity, bumps group version, refreshes summary. |
| DELETE | /api/groups/:gid/expenses/:eid | member | -> {expense, groupVersion} (soft delete) |
| POST | /api/groups/:gid/expenses/:eid/restore | member | -> {expense, groupVersion} |
| GET | /api/groups/:gid/expenses/:eid/history | member | -> {items: ActivityDTO[]} |
| GET | /api/groups/:gid/expenses/:eid/comments | member | -> {comments: CommentDTO[]} |
| POST | /api/groups/:gid/expenses/:eid/comments | member | {id?, body} -> {comment, groupVersion} (1 to 1000 chars) |
| DELETE | /api/groups/:gid/comments/:cid | member (author only) | -> {ok: true, groupVersion} |
| POST | /api/groups/:gid/import | member | BatchImportReq (max 500) -> {imported: number, groupVersion} |

### Other
| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| GET | /api/fx?base=TWD&date=YYYY-MM-DD | none | -> FxRes (cached per day in D1; falls back to the latest earlier day) |
| GET | /api/health | none | -> {ok: true, env} |
| POST | /api/admin/reset-link | owner | {email} -> {url, expiresAt} |
| GET | /api/admin/stats | owner | -> {users, groups, expenses} counts |

Validation limits: name 1 to 60 chars (trimmed), group name 1 to 80, description 0 to 120
(an expense needs a description; payments may be empty), notes 0 to 2000, payInfo 0 to 300,
venmo/paypal 0 to 50 `[A-Za-z0-9_.-]`, emoji 0 to 16 chars, color `#RRGGBB`, currency 3 uppercase
letters, category must be a known key (`categories.ts`) else `general`, date valid ISO date between
2000-01-01 and today + 1 year, amount 1 to MAX_AMOUNT, fxRate > 0 and < 1e9 (exactly 1 when the
currency equals the group currency), entries/items <= 50, item names <= 60.

CORS: allow origins from `ALLOWED_ORIGINS` (comma separated), methods GET POST PUT PATCH DELETE
OPTIONS, headers `Authorization, Content-Type, If-None-Match`, expose `ETag`, max-age 86400.
Responses with user data: `Cache-Control: no-store`.

## 7. Worker internals

- `src/worker/index.ts`: Hono app, CORS, JSON error handler (ApiError -> body; ZodError -> 400
  `validation`; anything else -> 500 `server_error` with the message logged, never leaked), mounts
  route modules, `scheduled()` for the cron.
- `src/worker/env.ts`: `Env` bindings and Hono `AppEnv` type.
- `src/worker/http.ts`: `ApiError`, `fail(status, code, message, details?)`, `readJson(c, schema)`,
  `nowISO()`, `newId()`, `randomToken(bytes)`, `sha256Hex(s)`.
- `src/worker/db.ts`: row types, row -> DTO mappers, common queries (`getGroupForMember`, ...).
- `src/worker/auth.ts`: password hash/verify, sessions, `requireUser` / `optionalUser` middleware,
  `rateLimit(db, key, limit, windowSec)`.
- `src/worker/routes/*.ts`: one module per area (auth, me, groups, expenses, fx, admin).
- `src/worker/services/summary.ts`: `refreshSummary(db, groupId)` reads members + entries, computes
  with `shared/summary.ts`, writes `UPDATE groups SET summary=? WHERE id=? AND version=?`.
- `src/worker/services/activity.ts`: builds activity rows (nets per member in group currency via
  `shared/balances.entryNet`).
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
- `config.ts`: `API_BASE` (from `import.meta.env.VITE_API_BASE`, overridable by
  `localStorage['evenly.api']` for tests), `APP_URL` (location origin + base path).
- `api.ts`: `api<T>(method, path, body?, opts?)` with bearer token, JSON, `ApiError` class
  (`status`, `code`, `message`, `details`), network failures throw `ApiError` with code `offline`.
- `store.ts`: global state (`useStore(selector)`) and `actions` (all server calls go through
  actions; optimistic updates and the outbox live here). Offline-capable actions: upsert, delete,
  restore expense, add comment. Others need a connection and throw `offline`.
- `idb.ts`: tiny IndexedDB key-value wrapper used by the store.
- `router.ts`: hash router: `useRoute()`, `navigate(path, {replace})`, `back(fallback)`, `href(path)`.
- `i18n.ts`: `useT()` returns `{t, locale, money, date, relative}`; `t('中文', 'English', params?)`
  with `{name}` placeholders. zh-TW is the default for Chinese browsers, else English; the choice
  is stored on the account and in localStorage.
- `format.ts`: money and date formatting (wraps `shared/money.formatMoney`).

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
  你要付 / 已結清), protect-your-account card for device-only accounts, Add to Home Screen hint on
  iOS Safari (once, dismissible). Primary action: 新增費用 (asks which group or friend first).
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
  prefills everything.
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
- **Account**: name, color, language (中文 / English), home currency, payment info (Venmo, PayPal.me,
  free text), sign-in (add or change email and password), devices (sessions list with revoke;
  "在其他裝置登入" shows the link code and QR), export my data (JSON download), sign out,
  delete account, about.
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
`public/manifest.webmanifest` (name "Evenly 分帳", short_name "Evenly", display standalone,
scope "./", theme color from the design; deliberately NO start_url, so the Home Screen app opens
the page URL it was added from, which carries the one-time `?install=CODE` sign-in code made by
the account page: the installed app does not share Safari's storage), icons 192/512/maskable + apple-touch-icon
180, `public/sw.js`: network-first for navigations (fallback to cached index.html), cache-first for
`assets/`, never caches API calls. Registered in `main.tsx` with an update toast.

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
Receipt photos and OCR, email or push notifications, passkeys, real-time sockets, non-group
expenses with several friends at once (use a group), native apps.
