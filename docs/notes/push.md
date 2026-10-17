# Push notifications: the Worker (agent B)

Notes for docs/SPEC.md (section 5 Database, section 6 HTTP API, section 10, where push leaves the
out-of-scope list) and docs/WORKER.md. The web side is in docs/notes/push-web.md (agent C).
Design: docs/PLAN-push-scan-cookies.md sections 2.1, 2.2 and 2.4.

## Files

- `migrations/0002_push.sql`: `activity.push_at` with a partial index, the `push_subscriptions`
  table, `users.notify_prefs`. Apply it before deploying this code: every activity INSERT now
  names `push_at`, so the old schema would refuse all writes (scripts/deploy.sh stops on pending
  migrations).
- `migrations/0003_push_pending.sql`: the `push_pending` table (messages a run could not fit).
  Staging already has 0002, so this is a migration of its own. Apply it before deploying: every
  sender run reads it, and without it no push goes out (the run logs the error and sends nothing).
- `src/worker/services/activity.ts`: `pushAtFor(type, data, now)` and `push_at` in `activityValues`
  (both `activityStmt` and `activityStmtWhere`). No call site changed; no batch got a statement.
- `src/worker/services/webpush.ts`: RFC 8291 encryption, RFC 8292 VAPID, `sendPush`. WebCrypto only.
- `src/worker/services/pushText.ts`: the notification words in zh-TW and English.
- `src/worker/services/push.ts`: `runPushSender(env, now?)`, also `deliverPushes`, `parsePrefs`.
- `src/worker/routes/push.ts`: `pushRoutes` (requireUser per route).
- `src/worker/routes/groups.ts`: the daily limit on adding people by email (`limitLinks`, see
  "Adding people by email" below).
- Tests: `tests/worker/webpush.test.ts` (11), `tests/worker/push-sender.test.ts` (78),
  `tests/worker/push-routes.test.ts` (22); `tests/worker/d1-sqlite.ts` applies every
  `migrations/*.sql` in name order. Staging: `node tests/api/push-test.mjs <staging URL>`.

## Database (migration 0002)

- `activity.push_at TEXT`: the row's own time (`created_at`) while a push may still go out, NULL
  for every other row and once the sender claimed it. Rows from before the migration are NULL and
  never send. Index `idx_activity_push ON activity(group_id, push_at) WHERE push_at IS NOT NULL`
  (only pending rows are in it).
- `push_subscriptions`: `id` (SHA-256 hex of the endpoint), `user_id` (users, cascade),
  `session_id` (sessions, cascade, NOT NULL), `endpoint`, `p256dh`, `auth` (base64url, no padding),
  `tz` (IANA zone or ''), `label` (deviceLabel of the User-Agent), `created_at`, `last_ok_at`,
  `failures`. Indexes on `user_id` and `session_id` (the cascade from sessions uses the second).
  Signing out, revoking a device, a password reset, the expiry cleanup and deleting the account all
  delete the session or the user, and with it the device's pushes.
- `users.notify_prefs TEXT NOT NULL DEFAULT '{}'`: PushPrefsDTO as JSON; a missing key means on.

## Database (migration 0003)

- `push_pending`: one row per message a run could not fit (sender step 7). `id` (INTEGER PRIMARY
  KEY, arrival order), `sub_id` (push_subscriptions, cascade), `user_id` (the account it was
  written for), `rank` (0 for the person's newest device, 1 for the next...), `payload` (the
  PushPayload JSON, encrypted when sent), `urgency` (`normal` or `low`), `created_at` (when it was
  kept). Index on `sub_id` for the cascade. Signing out, a revoked device, a 404 or 410 and deleting
  the account delete the subscription and with it its kept messages.

## HTTP API

| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| GET | /api/push/status | user | -> PushStatusRes `{publicKey, prefs, devices}`. `publicKey` is '' when the server cannot sign (VAPID vars missing, or the private JWK is not the pair of VAPID_PUBLIC_KEY). |
| PUT | /api/push/subscription | user | PushSubscriptionReq (`PushSubscription.toJSON()` plus `tz`; extra keys such as `expirationTime` are dropped) -> `{ok: true, devices}`. Stored for this account and this session. |
| DELETE | /api/push/subscription | user | `{endpoint}` -> `{ok: true}`; only this account's own row; unknown endpoints also answer ok. |
| PUT | /api/push/prefs | user | `Partial<PushPrefsDTO>` -> PushPrefsDTO (all three). Keys not sent keep their value; non-booleans are 400 `validation`. |
| POST | /api/push/test | user | {} -> PushTestRes `{sent, removed, failed}`: a test notification to every device of the account, now, in the account's language. 5 an hour (`push-test:<uid>`), else 429 `rate_limited`. 503 `server_error` when push is not set up. |
| POST | /api/push/run | owner; any user when ENVIRONMENT is not production | {} -> `{groups, sent, removed, failed}`: runs the sender now (staging has no cron). Others get 404 `not_found` in production. |

Subscription checks (400 `validation`, `details: [{path, message}]`):
- `endpoint` (at most 1024 characters): `https:`, no user, password or port, and the host is
  `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `push.services.mozilla.com`, or a
  subdomain of `push.apple.com` or `notify.windows.com` (path `['endpoint']`). The Worker POSTs to
  this URL, so nothing else is accepted, and `sendPush` does not follow redirects.
- `keys.p256dh`: base64url (trailing `=` allowed) of 65 bytes starting 0x04 that WebCrypto imports
  as a P-256 point (RFC 8291 section 7) (path `['keys', 'p256dh']`).
- `keys.auth`: 16 bytes (path `['keys', 'auth']`).
- `tz` (optional): an IANA zone name like `Asia/Taipei` or `Etc/GMT+8` (path `['tz']`). Not sent:
  the stored one is kept (the service worker's `pushsubscriptionchange` sends none).

Upsert rules: the same endpoint again updates keys, session, label and tz and resets `failures`.
An endpoint stored for another account moves to this one (the device changed account) with a new
`created_at` and no `last_ok_at`. At most 10 per account: a new one past that deletes the devices
that worked (`last_ok_at`, else `created_at`) longest ago, never the one being saved.

## What notifies whom (docs/PLAN 2.2)

`pushAtFor` sets `push_at` for expense.create, expense.update, expense.delete, expense.restore,
member.join, member.claim, member.add, group.create, and group.update rows whose
`changes[0].field` is `import`. Everything else (recurring.create, comment.add, settings, removals,
the system member.update of DELETE /me) stays NULL.

The sender (`runPushSender`, minutely cron in production, POST /api/push/run anywhere):
1. Start (one `db.batch`): clear the groups nobody can hear (step 2); delete the kept messages
   that can no longer go (a day old, or on a device that now belongs to another account or whose
   session has ended) in a statement of their own, so they never use the budget; take the next
   kept messages out of `push_pending` (rank, then arrival order; a `DELETE ... RETURNING` in the
   same transaction that reads their devices, so two runs never send one twice): all of
   `PUSH_MAX_PER_RUN` when no group is due, else half of it rounded up (6 of 12), so due groups
   share the run (step 7); and read the due groups.
2. Due groups: newest pending row older than the hold (`PUSH_HOLD_SECONDS`, default 30, 0 on
   staging) or oldest pending row 4 minutes old. Before that, one UPDATE clears the due rows of
   groups nobody can hear: deleted groups, and groups where no active member with an account has a
   device on a live session besides the one account that wrote every pending row of the group. It
   decides per group, not per row: someone else's delete of a new entry keeps the group (the create
   and the delete merge into an undo). The rest take turns by the account that wrote each group's
   oldest pending row (everyone's longest waiting group, then everyone's second...): a run reads
   the first 20, each with how many devices can hear it (counted up to the budget plus one, for
   step 7), and claims at most `min(10, 44 - budget)`. So one account's backlog of groups gets one
   claim per turn, like everyone else, and solo groups never use a claim.
3. One `db.batch` per group: read the stored payers and shares of the pending creates (before the
   claim, from the pending rows through `idx_activity_push`, then each entry by its primary key; the
   group's own index would walk all its entries, since D1 keeps no table statistics), claim with
   `UPDATE activity SET push_at = NULL ... RETURNING rowid AS seq, ...` (only rows older than the
   hold; in the 4-minute case newer rows wait), then the group, its members with `users.locale` and
   `notify_prefs`, and the members' subscriptions whose session has not expired, each person's
   device in use first (its session's `last_used_at`, then `last_ok_at` or `created_at`, then
   `created_at`). A run gives every device it reaches the same `last_ok_at`, so that alone would
   leave the order to the endpoint hash.
4. Merge by expense_id: a create later deleted sends nothing (an undo, also after delete and
   restore it sends "added"); a create with edits sends one "added" with the last row's values;
   rows without a create in the set send nothing. Joins and claims merge per member, adds per added
   member, imports per importer (the counts add up).
5. Recipients: active members whose account was linked to the member when the event happened
   (`members.claimed_at` at or before the row's time; NULL counts as always), never anyone who
   wrote one of the merged rows. So someone who joins by invite a few seconds after the group was
   made does not hear "created the group and added you", and a later joiner does not hear about
   an earlier join. Expense: the members in `data.nets` (if a rate failed and nets is empty: the
   stored payers and shares). Payment: the sender and the recipient (from the stored entry when both nets are 0).
   Join and claim: everyone else. Add: the added member, when linked to an account. New group or
   1:1 ledger: the other linked members. Import: everyone else. Prefs: `expenses` covers expenses
   and the import summary, `payments` payments, `joins` joins, adds and new groups.
6. One notification per person per group per run (pushText.ts), one message per device:
   `{title, body, path, tag: 'g:<gid>'}`. Title: emoji and group name, 兩人帳本 / Friend ledger for
   pair groups, the app name if the group has no name. Body: one item gives its sentence and, for
   money, a second line; several give a summary. Path: the entry (`/g/<gid>/e/<eid>`) for one
   expense or payment, else the group (`/g/<gid>`). Urgency `low` when every item is an import.
7. Budget `PUSH_MAX_PER_RUN` messages (default 12, at most 40), kept messages included. When a
   group does not fit in what is left and the run's take emptied `push_pending`, what fits goes
   now (every person's newest device before anyone's second), the rest goes into `push_pending`
   (written before the sends, one statement per person), and the run claims nothing more. The
   next runs send it first (step 1), so nothing is dropped: a join in a 20-person group reaches 12
   people now and the other 7 a minute later. While `push_pending` still holds such a rest, kept
   messages take half the budget and the due groups the other half, in turn order, so a friend's
   notification goes out the run after a big group's instead of after all of its rest. A group
   that does not fit in the room left then waits whole, for a run with room for it or one whose
   take empties `push_pending`, and its rows merge with what comes next: a group that more
   devices can hear than the budget is not even claimed (a big busy group costs no reads or writes
   while its own rest goes out), and a smaller one that does not fit gets its rows' `push_at` back
   (always their `created_at`). So only a run whose take emptied `push_pending` keeps a rest, and
   `push_pending` holds the rest of one group at most. The room the groups leave goes to more kept
   messages, in the same call that gives rows back (such a run never keeps a rest, so this call
   takes the keeping call's place in the subrequest count). The group that is cut starts going
   out at once instead of waiting for a run with room for all of it; the plan's give-back
   (section 2.2 step 6) is kept only for the groups behind a rest. Claims per run are
   `min(10, 44 - budget)`, so D1 calls plus fetches stay under 50 subrequests (tests count them
   over five runs at budgets 12 and 40, checking that each of 108 messages goes out once, and over
   the runs at budget 40 after one that gives four groups back and fills its room from
   `push_pending`: 7 D1 calls and 40 fetches, then every one of 170 messages once).

   Measured with the real sender and schema (tests/worker/d1-sqlite.ts, fetch stubbed), before
   and after the change to step 7 (2026-10-17):

   | Case | Before | After |
   |---|---|---|
   | A join in a trip of 30 with 2 devices each (58 messages); a friend's notification due 40 s later | out at 271 s | out at 91 s |
   | 20 accounts with 5 devices each, writing again after every claim; ten friend groups | out after runs 8 and 9 | all out by run 3 |
   | A 20-person trip, 3 devices each, writing every minute for 30 minutes; ten friend pairs | friends up to 9 runs late; at most 58 kept rows | at most 1 run late; at most 53 kept rows; 7.0 messages per device, as before |
   | 200 kept messages that can no longer go, and a friend's join | out in run 17 | run 1 |

   A run through every new statement (the stale delete, the half take, the device counts, a group
   given back, the room filled from `push_pending`, a cut) also passed on workerd's local D1
   (wrangler's getPlatformProxy, nothing remote).
8. Answers: 2xx sets `last_ok_at` and `failures = 0`; 404 or 410 deletes the subscription
   (`removed`); anything else, a timeout (10 s) or no answer adds 1 to `failures` and deletes the
   row at 5 (`failed`). Logs carry the push service host and status only.

Also: rows older than a day are dropped instead of sent, and so are kept messages a day after they
were kept. Without usable VAPID keys nothing is claimed or taken, but rows older than a day are
cleared, so the pending list cannot grow without end; kept messages wait, and the first run once
the keys work deletes those a day old before it takes any. `runPushSender` never throws (it runs
in `ctx.waitUntil`). Its log line has counts only: `push: <groups> groups, <sent> sent, <removed>
removed, <failed> failed, <n> kept for later, <m> kept ones dropped, <w> groups waiting` (`w`:
groups passed over or given back because a rest was kept).

## Adding people by email (routes/groups.ts)

Linking needs only the other person's email, and the linked account gets a notification titled
with the group name the sender chose ("created the group and added you", "added you to the
group", a new 1:1 ledger). So each account may link at most `MAX_LINKS_PER_DAY` = 30 accounts by
email a day, counted per account linked: POST /api/groups (each email that finds an account, me
excluded), POST /api/groups/:gid/members (an account, also one coming back after leaving) and POST
/api/friends (an account, when a new ledger is made; the existing one is not a new link). Names
without an email, emails without an account and joining by invite or claim link do not count.
Past the limit: 429 `rate_limited`, message "You can add at most 30 people by email a day",
`details: { retryAfter, scope: 'links' }` and `Retry-After`, nothing written. Fixed daily window in
`rate_limits` (key `link-account:<uid>`), as `rateLimit` (auth.ts) but counted in steps of the
number linked, so one request cannot link more than 30. Who gets notified did not change.

## Wording (pushText.ts; spacing as activityText.ts: a space only next to a Latin name)

| Event | zh-TW | English |
|---|---|---|
| New expense | Abbie 新增了「燒肉晚餐」 ¥12,600 / 你借入 ¥3,150 (你借出 ¥X, 剛好平衡) | Abbie added "燒肉晚餐" (¥12,600) / You borrowed ¥3,150 (You lent ¥X, Even) |
| Payment, sender recorded | Leo 記錄了付給你的還款 / 你收到 NT$500 | Leo recorded a payment to you / You received NT$500 |
| Payment, recipient recorded | Leo 記錄了你的還款 / 你付出 NT$500 | Leo recorded a payment from you / You sent NT$500 |
| Payment, someone else | Kevin 記錄了還款：Leo 付給你 | Kevin recorded a payment: Leo paid you |
| Join or claim | Abbie 加入了群組 | Abbie joined the group |
| Several joins | Abbie、Leo 加入了群組 (4 or more: Abbie 等 4 人加入了群組) | Abbie and Leo joined the group (Abbie, Leo, and Kai...; Abbie and 3 others...) |
| Added you | Gino 把你加進了群組 | Gino added you to the group |
| New group | Gino 建立了群組，也把你加了進去 | Gino created the group and added you |
| 1:1 ledger | Gino 開始了跟你的兩人帳本 | Gino started a ledger with you |
| Import | Gino 匯入了 500 筆費用 | Gino imported 500 entries (1 entry) |
| Several entries, one person | Abbie 新增了 3 筆費用 / 你借入 ¥X (the total, expenses only); payments only: Abbie 記錄了 2 筆還款 | Abbie added 3 entries / You borrowed ¥X; Abbie recorded 2 payments |
| Anything else mixed | the first item's sentence / 還有 2 筆新動態 | ... / and 2 more updates |
| POST /api/push/test | 吉諾分帳所 / 測試通知：看得到這則，就表示這台裝置收得到通知。 (path `/account`) | Gino's Split Lab / Test notification: if you can see this, notifications work on this device. |

Amounts: `formatMoney` in the recipient's `users.locale`; the expense line 1 amount as entered,
line 2 the recipient's net in the group currency; payments the amount as entered. Lines are cut
at 240 characters and titles at 100, so payloads stay far under the 3993-byte limit.
tests/worker/push-sender.test.ts compares the sentences the feed also writes with
`describeActivity` itself, in both languages. One difference on purpose: English says
"imported 1 entry" where the feed says "1 entries".

## Crypto (webpush.ts)

- `encryptPush`: a new ECDH P-256 key pair and 16-byte salt per message; IKM = HKDF(auth secret,
  ECDH secret, "WebPush: info" 0x00 ua_public as_public, 32); CEK and NONCE from HKDF(salt, IKM,
  "Content-Encoding: aes128gcm" 0x00 / "Content-Encoding: nonce" 0x00); one record (plaintext,
  0x02, no padding), AES-128-GCM; header salt, rs 4096, idlen 65, keyid. Matches RFC 8291
  Appendix A byte for byte; a round trip decrypts with HMAC-based HKDF from node:crypto.
- VAPID: ES256 JWT `{aud: endpoint origin, exp: now + 12 h, sub: VAPID_SUBJECT}`, header
  `{typ: JWT, alg: ES256}`, WebCrypto's raw r || s signature; cached per public key and audience in
  module memory, renewed when under an hour is left; concurrent sends to one service sign once.
  `Authorization: vapid t=<jwt>, k=<VAPID_PUBLIC_KEY>`.
- Request: POST, `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`,
  `TTL: 86400`, `Urgency: normal|low`, redirect manual, 10 s timeout.
- `loadVapid` imports VAPID_PRIVATE_JWK once per isolate and checks that its x and y are the
  public key's; it logs fixed messages only (a JSON.parse error could quote the secret).

## Limits and cost

- Free plan per invocation: 10 ms CPU, 50 subrequests, 50 D1 calls. A run: 1 D1 call to start
  (step 1), 1 per claimed group, at most 1 to keep the rest of a group or to end a run whose take
  left kept messages (step 7; never both), 1 delivery batch; 1 fetch per message.
- CPU, measured in Node 24 on this laptop (not workerd): the per-message work itself (key pair,
  ECDH, three HKDFs, AES-GCM) costs 0.125 ms with Node's synchronous OpenSSL calls; through Node's
  WebCrypto, which hands every call to a thread pool, the whole sendPush costs about 0.9 ms.
  workerd runs WebCrypto inline (BoringSSL, no thread pool), so expect closer to the first number,
  about 2 to 4 ms for 12 messages.
- CPU, measured on staging (2026-10-17, `tmp/push-run-cpu.mjs`: POST /api/push/run for one expense
  to an account with N devices on made-up FCM endpoints: every message is built and sent, and the
  404 or 410 answers delete the devices; `cpuTime` from `wrangler tail`): 7 ms for 1 message, 9 ms for 5, 9 and 11 ms for
  10 (two runs); with the budget at 8, 12 ms for 8 sent and 2 kept for later. The messages add
  about 0.3 ms each, as estimated above; the rest of a run takes 6 to 10 ms and changes from run
  to run. Idle cron runs in production take 3 to 5 ms. Workers Free allows 10 ms and stops a
  Worker that goes over it often (it lets an occasional run through), so wrangler.toml sets
  `PUSH_MAX_PER_RUN` to 8 in production and on staging, about 1 ms off a full run. Most of a run
  does not depend on the budget: if production runs end in `exceededCpu` (wrangler tail), a lower
  budget helps little, and Workers Paid (30 s of CPU) is the fix. Measure again before raising it.
- D1: an idle run reads 19 rows on workerd's local D1 (the six statements of the start batch on
  empty indexes and tables; 16 before the statement that deletes kept messages that can no longer
  go), about 27,000 a day of the Free plan's 5 million. Each flagged row costs one extra index
  write and the claim one row write. A backlog of 300 rows in groups nobody can hear is read once
  (about 1,200 rows) and cleared. A kept message costs a row and an index entry to write and the
  same to delete; `push_pending` holds the rest of one group at most. Counting a due group's
  devices stops at the budget plus one. A group given back costs its claim's row writes twice
  (the claim, then `push_at` again); only groups that at most `PUSH_MAX_PER_RUN` devices can hear
  are tried that way, so a big busy group is never claimed and given back over and over.
- The claim's entries read was checked on workerd's local D1 too: 2 rows read for one pending
  entry. The old read walked every entry of the group (the review measured 5,001 rows read for a
  group of 5,000 entries).

## Configuration

- `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` ([vars]) and the `VAPID_PRIVATE_JWK` secret (scripts/vapid-keys.mjs).
- `PUSH_HOLD_SECONDS` (default 30; staging 0), `PUSH_MAX_PER_RUN` (default 12, at most 40; wrangler.toml
  sets 8, see Limits and cost).
- Cron `* * * * *` runs `runPushSender(env)` (index.ts).

## Not in this version

- Edits, deletes and restores of entries that already went out, comments, recurring copies and
  quiet hours (the device `tz` is stored for them). An edit that takes someone off a split cannot
  tell them: the row has only the new nets (a `prevNets` field would be needed).
- In the 4-minute case a create older than the hold can go out while its undo is still newer than
  the hold; the delete then arrives alone and sends nothing.
- No badge count in the payload.
- While the rest of a big group goes out, a group whose notification is more than half of
  `PUSH_MAX_PER_RUN` messages (7 or more at the default 12) waits for that rest: a minute per
  `PUSH_MAX_PER_RUN` kept messages, about 40 minutes behind 49 people with 10 devices each at the
  default budget. Smaller groups share the other half of each run, so they go a run or so after
  the big group's first messages. Raising the budget shortens both (measure CPU first).
- Throwaway accounts can still hold everyone up without anything kept: 40 accounts that each keep
  a group with 12 devices busy delay a friend's notification by about 40 runs (a probe, after the
  change above), since turns per account do not help against many accounts. Only limits per
  account or per address (signups, subscriptions) would stop that.
- A kept message keeps the words and prefs of the minute it was made: a pref turned off in between
  does not stop it.
- No per-group mute and no way to block one sender: someone who keeps adding you by email (30 a
  day at most) can only be stopped with the joins switch, which mutes every group.
