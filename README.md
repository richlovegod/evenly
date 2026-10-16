# 吉諾分帳所 Gino's Split Lab

A free, Splitwise-style app for recording shared costs on trips and while living together, and
working out who pays whom. Traditional Chinese and English. Works on phones (add it to the Home
Screen) and on a laptop, and keeps working offline. The code name is still Evenly (the repo, the
Worker and the storage keys).

**Use it:** https://split.ginochang.com/

## What it does

- **Groups** for trips, homes and couples, plus 1:1 friend ledgers. Add people by name now; they
  claim their name later from an invite link (no sign-up needed to start: a name is enough).
- **Expenses** in any currency, with the exchange rate of the expense date (Frankfurter, editable),
  a calculator keypad, automatic categories from the description (中文 and English), multiple
  payers, and six ways to split: equally, exact amounts, percentages, shares, adjustment (plus or
  minus) and by item (tax, tip or service charge spread proportionally).
- **Balances and settling up**: fewest transfers, pairwise debts, or "everyone settles with one
  person"; record payments, see the other person's Venmo / PayPal / free-text payment info, share
  a plain-text summary to LINE or WhatsApp.
- **Everything else**: recurring expenses, comments, full history with undo and restore, stats by
  person, category and day, CSV export, Splitwise CSV import, device sign-in codes, optional email
  and password, an owner page for password resets.

## How it is built

| Part | Tech | Where |
|---|---|---|
| Money math (shared) | TypeScript, integer minor units, BigInt allocation | `src/shared/` |
| API | Cloudflare Worker, Hono, zod, D1 (SQLite) | `src/worker/`, `migrations/`, `wrangler.toml` |
| Web app | React 19, Vite 7, CSS Modules, hash routing, service worker, IndexedDB outbox | `src/web/`, `public/` |
| Design | "Receipt" design system | `design/DESIGN.md`, `design/tokens.css` |
| Specs | product, API and module contracts | `docs/` |

Passwords never leave the device: the browser derives a key (PBKDF2, 210,000 iterations, salted
with the email) and the Worker stores a light hash of that key.

## Develop

```bash
npm install
npm test                 # unit tests (shared math, worker helpers, web logic)
npm run typecheck
npm run dev              # web app on http://127.0.0.1:5173 against the staging API
```

Tests against the real staging Worker:

```bash
node tests/api/api-test.mjs https://evenly-api-staging.richlovegod.workers.dev
npx vite build && npx vite preview --port 4173 &
node tests/e2e/flows.cjs http://127.0.0.1:4173/
```

## Deploy

```bash
npx wrangler d1 migrations apply evenly-db --remote   # when migrations change
npx wrangler deploy                                     # API
bash scripts/deploy-web.sh                              # web app to GitHub Pages (gh-pages branch)
```

Staging: `--env staging` on the wrangler commands (`evenly-api-staging`, `evenly-db-staging`).
