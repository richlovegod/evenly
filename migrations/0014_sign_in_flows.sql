-- Evenly schema v14: what a Google or Apple flow started from this app is bound to, kept on the
-- server (docs/SPEC.md section 3, Linking from 我的, and Apple). Additive: one table. Apply before
-- deploying the code that reads it (scripts/deploy.sh checks): the starts that link or replace a
-- session write it, and their callbacks read it.

-- One row per started flow that is bound to an account: a link from 我的 (the account and the
-- session that started it; the callback links only while that session lives), or a web Sign in
-- with Apple started in a browser that was signed in (the session the new sign-in replaces: Apple
-- comes back with a cross-site POST, which carries no SameSite=Lax cookie). The flow cookie holds
-- only random values, so nobody can name another account or session in it. Keyed by the SHA-256
-- of the flow's state, taken once by the callback, 10 minutes, and the daily cleanup deletes
-- expired rows (services/cron.ts).
CREATE TABLE sign_in_flows (
  id TEXT PRIMARY KEY,                     -- SHA-256 hex of the flow's random state
  kind TEXT NOT NULL,                      -- 'link' or 'replace'
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,                -- sessions.id: the session that started it, or the one to replace
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Lets the cascade from users find its rows without scanning the table.
CREATE INDEX idx_sign_in_flows_user ON sign_in_flows(user_id);
