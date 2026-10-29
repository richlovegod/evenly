# 吉諾分帳所 Gino's Split Lab

A free, Splitwise-style app for recording shared costs on trips and while living together, and
working out who pays whom. Traditional Chinese and English. Works on phones (add it to the Home
Screen) and on a laptop, and keeps working offline. The code name is still Evenly (the repo, the
Worker and the storage keys).

**Use it:** https://split.ginochang.com/

## What it does

- **Groups** for trips, homes and couples, plus 1:1 friend ledgers. Add people by name now; they
  claim their name later from an invite link. Starting takes a name and an email, confirmed with
  a 6-digit code mailed to it, so a new phone or a cleared browser never loses the account.
- **Friend invite links**: everyone has one personal link (`/i/<code>`, with a QR code and three
  ready-made messages to send with it). Whoever opens it and signs in becomes a friend, with a 1:1
  ledger, and the link's preview in LINE or Messenger says who sent it.
- **Expenses** in any currency, with the exchange rate of the expense date (Frankfurter, editable),
  a calculator keypad, automatic categories from the description (中文 and English), multiple
  payers, and six ways to split: equally, exact amounts, percentages, shares, adjustment (plus or
  minus) and by item (tax, tip or service charge spread proportionally).
- **Balances and settling up**: fewest transfers, pairwise debts, or "everyone settles with one
  person"; record payments, see the other person's Venmo / PayPal / free-text payment info, share
  a plain-text summary to LINE or WhatsApp.
- **Receipts**: scan a receipt to fill in the form (Workers AI), and keep its photo with the
  expense for the group to see (Workers KV, shrunk on the phone first).
- **Everything else**: recurring expenses, comments, full history with undo and restore, stats by
  person, category and day, CSV export, Splitwise CSV import, sign-in with an email code (no
  password needed), with Google (the web app; the Worker runs the OAuth flow, no Google script on
  the pages) or a code from another device, an optional password, an owner page for password
  resets.

## How it is built

| Part | Tech | Where |
|---|---|---|
| Money math (shared) | TypeScript, integer minor units, BigInt allocation | `src/shared/` |
| API | Cloudflare Worker, Hono, zod, D1 (SQLite), Workers KV (receipt photos) | `src/worker/`, `migrations/`, `wrangler.toml` |
| Web app | React 19, Vite 7, CSS Modules, hash routing, service worker, IndexedDB outbox; served by the same Worker (Workers Static Assets) | `src/web/`, `public/` |
| Design | "Receipt" design system | `design/DESIGN.md`, `design/tokens.css` |
| Specs | product, API and module contracts | `docs/` |

Passwords never leave the device: the browser derives a key (PBKDF2, 210,000 iterations, salted
with the email) and the Worker stores a light hash of that key.

One Worker serves the app and `/api` on the same origin, so the sign-in lives in an HttpOnly
cookie the Worker sets (Safari's 7-day limit on site storage does not sign anyone out). Anywhere
else (vite dev, vite preview, tests that set `localStorage['evenly.api']`) the app calls the API
cross-origin with a Bearer token, as before. Details: `docs/PLAN-push-scan-cookies.md` section 1.

## Develop

```bash
npm install
npm test                 # unit tests (shared math, worker routes and helpers, web logic)
npm run typecheck
npm run dev              # web app on http://127.0.0.1:5173 against the staging API (Bearer)
```

Tests against the real staging Worker:

```bash
node tests/api/api-test.mjs https://evenly-api-staging.richlovegod.workers.dev   # API contract (Bearer)
node tests/e2e/cookie-flows.cjs                    # cookie sessions on the staging site (WebKit)
npx vite build && npx vite preview --port 4173 &
node tests/e2e/flows.cjs http://127.0.0.1:4173/    # UI flows; the page calls staging via evenly.api
node tests/e2e/invite-flows.cjs http://127.0.0.1:4173/   # friend invite links (also on the staging site itself)
node tests/e2e/keyboard-viewport.cjs http://127.0.0.1:4173/   # the iOS keyboard and the visual viewport
```

A plain `vite build` is a same-origin build: under vite preview it needs `localStorage['evenly.api']`
pointing at a Worker (flows.cjs sets it) or `VITE_API_BASE=<worker url>` at build time.

Signing up takes an email code. Staging runs in test mode (`EMAIL_DEV_ECHO = "1"` in
`[env.staging.vars]`): the email start routes also answer with the code (`devCode`), the code step
shows it as 測試模式, and the scripts above read it from the start answer, so staging works without
a mailbox and without `RESEND_API_KEY` (with the key, staging mails real addresses too; test
addresses on `evenly.test` are never mailed). Production never answers with a code, whatever the
flag says.

## Deploy

```bash
npm run deploy:staging   # https://evenly-api-staging.richlovegod.workers.dev/
npm run deploy           # production; commit first (ALLOW_DIRTY=1 overrides)
```

Both run `scripts/deploy.sh`: build the app into `dist/` (`scripts/build-web.sh`: same-origin,
with `dist/version.json`), stop when D1 has migrations that are not applied yet (`MIGRATE=1`
applies them first), `wrangler deploy`, then smoke checks on the deployed site (`/api/health`
says the environment, `/version.json` the commit, `/api/health` opened as a page is still JSON,
`/` is the app). Production checks split.ginochang.com and workers.dev. Never run a bare
`wrangler deploy`: `[assets]` uploads whatever `dist/` holds.
After a production deploy, `node tests/e2e/prod-smoke.cjs` signs up a throwaway account on
split.ginochang.com and deletes it again. Production mails its codes and never answers with one,
so the script makes the account with `POST /api/auth/signup` (a name alone) from the loaded page,
same origin, so the cookie path is still tested. It signs up nothing unless `/api/health`, asked
from Node and again from the loaded page, says `production` (`EXPECT_ENV`), and it checks that the
Worker hands out the VAPID key `wrangler.toml` lists.

### Secrets

Set with `npx wrangler secret put <NAME>` (add `--env staging` for staging); never in a file.

| Secret | What | Without it |
|---|---|---|
| `OWNER_EMAILS` | Comma-separated emails that get the owner page | Nobody is the owner |
| `VAPID_PRIVATE_JWK` | Web Push signing key (`node scripts/vapid-keys.mjs [staging]`) | Push is off (`publicKey` is '') |
| `APNS_AUTH_KEY` | The APNs auth key for the iPhone app's notifications: Apple's .p8 file as it is, loaded with `npx wrangler secret put APNS_AUTH_KEY [--env staging] < AuthKey_U47HW6ZSNN.p8` (never pasted or printed). Its key id, team id and bundle id are the `APNS_*` vars in `wrangler.toml` | iPhones get no notifications (`apns: false` in `GET /api/push/status`); browsers are not affected |
| `RESEND_API_KEY` | Resend key that mails the sign-in codes from `EMAIL_FROM` (`ginochang.com` verified in Resend, open and click tracking off) | Production: 503 `email_unavailable`, nobody can sign up or in by code. Staging: test mode only echoes the code |
| `GOOGLE_CLIENT_SECRET` | The secret of the Google OAuth client whose id is `GOOGLE_CLIENT_ID` in `wrangler.toml` (`[vars]` and `[env.staging.vars]`, "SET_ME" until the client exists; docs/WORKER.md, Sign in with Google, lists the Google Cloud console settings) | No 使用 Google 帳戶登入 button; `/api/auth/google/start` sends people to 登入 with `unavailable`. The same happens while the id is "SET_ME" |

The email codes need migration `0005_email_codes.sql`: deploy once with `MIGRATE=1` (staging, then
production).

Sign in with Google needs migration `0007_google_sign_in.sql` (`users.google_sub`; `MIGRATE=1`,
staging first), the real `GOOGLE_CLIENT_ID` in `wrangler.toml` and the `GOOGLE_CLIENT_SECRET`
secret in each environment. Until both are set the button stays hidden and nothing else changes.

The iPhone app's notifications (APNs) need migration `0012_apns.sql` (`MIGRATE=1`, staging first)
and the `APNS_AUTH_KEY` secret in each environment; until the secret is there, iPhones are left out
and nothing else changes.

Receipt photos need migration `0006_receipts.sql` (`MIGRATE=1` again, staging first) and the KV
binding `RECEIPTS`, listed in `wrangler.toml` for both environments (`[[kv_namespaces]]` and
`[[env.staging.kv_namespaces]]`; the namespaces exist already). Without the binding the photo
routes answer 503 and 404 and nothing else changes.

Since the cutover below (2026-10-17), split.ginochang.com is the Worker's custom domain. GitHub
Pages gets no new builds (`scripts/deploy-web.sh` is retired). Leave the `gh-pages` branch as it
is: its `CNAME` file keeps GitHub redirecting `richlovegod.github.io/evenly/` to
`split.ginochang.com`, and it is the way back.

### Cutover and rollback

"The move" below is the change that made the Worker serve the app (`[assets]`) and keep the
sign-in in a cookie (`docs/PLAN-push-scan-cookies.md`).

Cutover, a production change (only with Gino's OK):

1. Production runs the move's code on workers.dev first: `MIGRATE=1 npm run deploy` (migrations
   0002 and 0003), then `node tests/e2e/prod-smoke.cjs https://evenly-api.richlovegod.workers.dev/`.
   Write the `Current Version ID` wrangler printed into "Oldest rollback target" below.
2. Add the route at the top level of `wrangler.toml`, right after `preview_urls` (above
   `[assets]`: a key below a table header belongs to that table). `[env.staging]` keeps its
   `routes = []`, so staging does not inherit the domain.

   ```toml
   routes = [{ pattern = "split.ginochang.com", custom_domain = true }]
   ```

3. Commit and `npm run deploy`. The cutover has to be this deploy, not the dashboard or
   `wrangler triggers deploy`, so it makes a deployment of its own (see Rollback). Without a
   terminal (Claude's Bash tool, piped output) wrangler replaces the `split` CNAME with the
   Worker's record without asking; in a terminal it asks first. If it refuses because of the
   CNAME, delete that record in Cloudflare DNS and deploy again.
4. Wait out the old record's TTL (Auto, 5 minutes). Until then, resolvers that cached it still
   send people, and the checks, to GitHub Pages, which keeps serving the previous build.
5. Check both sites, then the whole flow on split.ginochang.com:

   ```bash
   SMOKE_URLS="https://split.ginochang.com/ https://evenly-api.richlovegod.workers.dev/" npm run deploy
   node tests/e2e/prod-smoke.cjs
   ```

   The first line deploys the same commit again and runs the smoke checks on both sites
   (`npm run deploy` now checks both by default). Also,
   `curl -sI https://split.ginochang.com/` says `server: cloudflare`, and
   `https://richlovegod.github.io/evenly/` still answers 301 to split.ginochang.com.

Rollback:

- Fix forward: revert the bad commit and `npm run deploy`.
- Or `npx wrangler rollback <version-id>`, only to a version that `scripts/deploy.sh` deployed,
  from the oldest rollback target on. Always name the version: without one, wrangler picks the
  deployment before the current one, which is code from before the move while the current one
  is the first with it (a cutover made in the dashboard leaves it so). The dashboard's rollback
  is the same command.
- Never roll back past the oldest rollback target, nor deploy an older commit, while
  split.ginochang.com is attached to the Worker. Those versions have no `[assets]`, so `/` is a
  JSON 404, which `sw.js` hands to every phone that is online. They read only Bearer, so every
  open cookie tab gets a 401 and signs out, deleting its token copy, and a name-only person who
  types their name again gets a second account and stays on Bearer. Their `scheduled()` runs
  `runDaily` for every cron event, and the minutely cron stays: triggers are not versioned.

Oldest rollback target (production): `a9893a42-b2c2-442b-8bfe-2e9de1a3d988` (2026-10-17, commit fc2614a, the first deploy of this design; never roll back past it while the custom domain is attached).

Back to GitHub Pages, only if code from before the move has to run on split.ginochang.com:

1. In `wrangler.toml`, delete the `routes` line and set the production `crons = ["0 9 * * *"]`;
   commit and `npm run deploy`. The cron change stops the push sender, whose messages GitHub's
   service worker (`evenly-v3`) cannot show (Safari would drop the subscriptions, Chrome would
   show its own "updated in the background" notice), and keeps older code from running
   `runDaily` every minute. Deleting the line does not detach the domain (wrangler only touches
   the custom domains `routes` lists), but left in, the next deploy would attach it again and
   replace the CNAME without asking.
2. Detach the custom domain: Workers & Pages > evenly-api > Settings > Domains & Routes, or the
   Workers Domains API (`GET /accounts/<account id>/workers/domains?hostname=split.ginochang.com`
   for its id, then `DELETE /accounts/<account id>/workers/domains/<id>`).
3. Right away, in Cloudflare DNS: `split` CNAME `richlovegod.github.io`, DNS only (delete any
   `split` record the Worker left first). Until the Worker's record expires from caches (5
   minutes), some visits fail.
4. Check GitHub's certificate for split.ginochang.com:
   `gh api repos/richlovegod/evenly/pages --jq .https_certificate` has to say `approved`, with
   `expires_at` still ahead (2027-01-14 when last read; it cannot renew while the name points at
   Cloudflare). If it expired, browsers fail until GitHub issues a new one: the Worker sent a
   year of HSTS, so they allow no http fallback.
5. Keep workers.dev running (`workers_dev = true`, `ALLOWED_ORIGINS`, Bearer): the GitHub build
   and the iOS app call it. A device that still holds the token copy (`evenly.token`) stays
   signed in on the GitHub build; one whose storage Safari cleared has only the cookie, which
   that build cannot use.
6. Only now may older code run: `npx wrangler rollback <version-id>`, or deploy the older
   commit.
