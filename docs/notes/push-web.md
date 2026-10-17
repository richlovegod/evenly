# Push notifications: the web app (agent C)

Notes for docs/SPEC.md (section 8.5 PWA, a new 8.x 通知, the 我的 and 總覽 screens, and section 10,
where "push notifications" leaves the out-of-scope list). The Worker side is in docs/notes/push.md
(agent B). Design: docs/PLAN-push-scan-cookies.md section 2.

## Files

- `src/web/lib/push.ts`: the state, turning push on and off, the sync at start, and dropping the
  subscription when the account leaves the device.
- `src/web/lib/pwa.ts`: the worker's messages (`{type: 'open', path}` from a notification tap,
  `navigate(path)`), `swVersion()`, `updateApp()`, `isIosDevice()`.
- `src/web/main.tsx`: a `PushSync` component next to `<App />` that passes the session key
  (`useStore(st => st.token)`) and the account id (`st.me?.user.id`) to `setPushSession()`, and
  runs `startPushSync()` while someone is signed in (store.ts is not edited).
- `src/web/features/account/NotificationsCard.tsx` (+ `.module.css`): 通知 on 我的, right under
  加到主畫面.
- `src/web/features/home/PushCard.tsx` (+ `.module.css`): the offer on 總覽.
- `tests/web/push-client.test.ts`: 71 tests (Node, fakes for the browser, `api` mocked).

## States (`pushState()`, decided by `decidePushState(facts)` in this order)

| State | When | 我的 shows |
|---|---|---|
| `needs-install` | iPhone or iPad Safari outside the Home Screen app | iOS 16.4+ Home Screen only; 先加到主畫面 scrolls to the 加到主畫面 card and focuses its button |
| `unsupported` | no service worker, PushManager or Notification (other iOS browsers, in-app browsers, iOS before 16.4, private modes) | what would work instead |
| `waiting-worker` | the worker in control does not answer `{type: 'version'}` with `push: true` within 2 s (evenly-v3, or no controller yet) | 更新: a waiting worker takes over (`skipWaiting`), an uncontrolled page reloads, else an update check |
| `denied` | `Notification.permission` is `denied` | iPhone app: 設定 > 通知 > 吉諾分帳所 > 允許通知; other installed apps: the device's settings; browsers: the site settings, then reload |
| `off` | allowed or not asked, no subscription | 開啟通知 (yolk); disabled with a note when the server sends an empty key |
| `on` | allowed and subscribed | 記帳 / 還款 / 有人加入 switches (PUT /api/push/prefs, for the whole account), 收到通知的裝置 N 台, 傳送測試通知, 關閉這台裝置的通知 |

States other than `on` add 「你有 N 台其他裝置會收到通知」 when the account's other devices have push.
The card re-reads the state when the app comes back to the front, when another worker takes
control, and after push is turned on or off anywhere in the app.

## Turning it on (`enablePush()`, from the tap)

1. `Notification.requestPermission()` is the first call, before any await (Safari prompts only
   inside the tap). Checked in WebKit: `navigator.userActivation.isActive` is still true then.
2. The VAPID key comes from `GET /api/push/status`, fetched before the tap (when 我的 opens, or
   `preparePush()` while the 總覽 offer shows) and kept in memory. If it is missing, it is fetched
   after the prompt.
3. `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` with the key decoded
   from base64url (65 bytes, 0x04 first; anything else throws). A subscription made with another
   key is dropped first.
4. `PUT /api/push/subscription` with `{ ...subscription.toJSON(), tz }` (IANA zone from
   `Intl.DateTimeFormat().resolvedOptions().timeZone`). If the PUT fails, a subscription made in
   this call is unsubscribed again, so the device never says 已開啟 while the server does not know it.

## Turning it off (`disablePush()`)

`unsubscribe()` first (the push service then answers 410 for that endpoint), then
`DELETE /api/push/subscription` with `{ endpoint }`. A 404, or any failed DELETE, is ignored:
the server deletes the row on its next send. Only this device; the account's other devices keep theirs.

The button shows while the start sync may still be waiting on the network (the key, the PUT),
for example right after a tap on the test notification opened the app on 我的. A sync on its way
then stops before it saves or makes anything, and drops a subscription it made itself. If its PUT
was already out, it sends the DELETE again once the PUT is done, because the tap's DELETE may
have reached the server first. The sync never writes `evenly.push.wanted`; only the taps do.

## At start and after every sign-in (`startPushSync()` / `syncPush()`)

Never prompts, never throws. Only for the account that `localStorage['evenly.push.wanted']`
names: for anyone else signed in on this device it does nothing beyond the blocked case below.

- Allowed and subscribed: `GET /api/push/status` (the key) then `PUT` again, so the subscription
  follows the current session (a sign-in, a password reset, a legacy token moved into the cookie).
  A subscription made with an older server key is replaced. If the status cannot be read, the PUT
  still goes out.
- Allowed and no subscription: subscribe again quietly (only while a worker with push handlers is
  in control), then PUT.
- Blocked: drop the subscription (unsubscribe and DELETE), keep `wanted`.
- It runs again when the app comes back to the front with a different permission than when it
  left (allowed or blocked in Settings meanwhile).
- One run at a time (StrictMode runs effects twice). A run asked for before 關閉 was tapped or
  the account changed stops at its next step, and the run asked for since follows it, so a quick
  sign-out and sign-in still links the new session.

`evenly.push.wanted` is set by the tap on 開啟通知 (also when the prompt is blocked or saving
fails) and removed by 關閉這台裝置的通知. This differs from the plan, which said "granted and
none, subscribe again quietly": without the flag, turning push off on this device would come back
on by itself at the next start, because the permission stays granted. With it, a blocked prompt
followed by 允許通知 in Settings turns push on when the person returns, and a failed save is
retried at the next start.

## When the account leaves this device (`setPushSession()`)

The session key going null (signing out, the session ending on its own, the first half of a
sign-in that replaces the session) or the account id turning into another one counts as leaving.
`me` being null for a moment while the session stays (it loads after a Bearer sign-in and at
start) does not, and neither does a new session key for the same account (a legacy token moved
into the cookie).

On leaving, the browser's subscription is dropped at once with `unsubscribe()` and no request,
so it also works offline. This matters where the server still has the old session, which happens
on the Bearer path: a sign-out that never reached the server (offline, a timeout, a 5xx), or a
sign-in with a code or reset link while another account is signed in (with no session cookie,
the Worker does not end the old session). The push service answers 404 or 410 for the dropped
endpoint, and the sender deletes the row on its next send. `evenly.push.wanted` stays, so the same
account's next sign-in here subscribes again quietly with a new endpoint. The next sync, and a
tap on 開啟通知, wait until the drop is done.

## 總覽 offer (`PushCard`)

Shown when the state is `off`, the account is in at least one group (pair ledgers count), and
`localStorage['evenly.pushCard.hidden']` is not `1` (the close button sets it). Its button calls
`enablePush()` directly: 已開啟通知 on success; a blocked prompt hides the card and shows a toast
with 怎麼打開 (opens 我的). It never shows together with the compact 加到主畫面 card: iPhone Safari
is `needs-install`, and the Home Screen app has no install card.

## Notification taps

`public/sw.js` posts `{type: 'open', path}` to an open window; `registerServiceWorker()` listens
on `navigator.serviceWorker` (and calls `startMessages()`) and calls `navigate(path)` for app
paths only (`/...`, never `//...`), so the app keeps its state. With no window open the worker
opens `<scope>#<path>`.

## Test ids

`account-push` (with `data-state`), `push-enable`, `push-disable`, `push-test`,
`push-pref-expenses`, `push-pref-payments`, `push-pref-joins`, `push-update`,
`push-show-install`, `home-push-card`, `home-push-enable`, `home-push-hide`.

## Limits and open points

- `POST /api/push/test` is 5 an hour; a 429 says so (「測試通知一小時最多傳 5 次」).
- `vite dev` registers no service worker, so the card shows `waiting-worker` there. Push can only
  be tried on a build served over https or localhost (staging), on a real iPhone Home Screen app
  for iOS.
- Signing out drops the browser's subscription (see "When the account leaves this device"), and
  someone else who signs in on that device starts with notifications off until they turn them on.
  That differs from the plan, which said the sync "re-links it ... after a new sign-in": that now
  holds only for the account that turned them on here.
- The same account signing out and in again gets a new endpoint each time. iOS has to allow a
  quiet `subscribe()` with the permission already granted for that to work. If it does not, the
  card shows 開啟通知 again, and one tap brings them back.
