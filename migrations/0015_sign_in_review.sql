-- Evenly schema v15: the fixes from the security review of Sign in with Apple and Google
-- (docs/SPEC.md section 3). Additive: one column and two tables. Apply before deploying the code
-- that reads them (scripts/deploy.sh checks): the starts and callbacks of Google and Apple, the
-- pending links of 我的, and the iPhone's Google exchange use them.

-- A flow's binding is found by the SHA-256 of a secret that only the flow cookie holds (it is
-- never sent to Apple or Google), and the row keeps the SHA-256 of the flow's state to compare
-- with the state that comes back. A leaked authorize URL (it carries the state and the nonce)
-- therefore names no binding. Rows from before this column have it NULL and are never found.
ALTER TABLE sign_in_flows ADD COLUMN state_hash TEXT;

-- A link from a browser callback (the web's Apple and Google link=1, the iPhone's Google ticket)
-- waits here for the client's confirmation (GET, POST and DELETE /api/me/links/pending/<id>):
-- the provider account the callback verified, for the account and the session that started it,
-- 10 minutes, once. For Apple, the grant the code exchange gave, kept for the account if it is
-- confirmed, else revoked when no account keeps it. Keyed by the SHA-256 of the id in the URL.
CREATE TABLE pending_links (
  id TEXT PRIMARY KEY,                     -- SHA-256 hex of the id
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,                -- only this session may see, confirm or drop it
  provider TEXT NOT NULL,                  -- 'apple' or 'google'
  sub TEXT NOT NULL,                       -- the provider's account id
  email TEXT,                              -- the provider account's email (a relay address included), NULL without one
  client_id TEXT,                          -- apple: the client the grant was issued to
  refresh_token TEXT,                      -- apple: the grant
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Lets the cascade from users find its rows without scanning the table.
CREATE INDEX idx_pending_links_user ON pending_links(user_id);

-- The iPhone's Google sign-in code now carries the verified Google identity; the account is found
-- or made only when the app exchanges the code with its verifier (POST /api/auth/google/exchange),
-- so a code nobody exchanges changes no account. SHA-256 of the code only, 5 minutes, once.
CREATE TABLE google_sign_in_codes (
  id TEXT PRIMARY KEY,                     -- SHA-256 hex of the code
  challenge TEXT NOT NULL,                 -- base64url SHA-256 of the app's verifier
  identity TEXT NOT NULL,                  -- JSON: sub, email, givenName, name, locale, currency
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
