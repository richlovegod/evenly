-- Evenly schema v13: Sign in with Apple on the web and in the iPhone app, and Google in the iPhone
-- app (docs/SPEC.md sections 3, 5 and 6, Apple and Google on the iPhone). Additive: a column, an
-- index and two tables. Apply before deploying the code that reads them (scripts/deploy.sh
-- checks): every account query selects users.*, account inserts name apple_sub, and the Apple and
-- Google routes write the tables.

-- The Apple ID (the identity token's `sub`, Apple's stable user id for our team, the same in the
-- app and on the web because the Services ID is grouped with the App ID) this account signs in
-- with, NULL until a Sign in with Apple links one (routes/auth.ts). One account per Apple ID: a
-- unique index, as for google_sub, and NULLs never clash in it.
ALTER TABLE users ADD COLUMN apple_sub TEXT;
CREATE UNIQUE INDEX idx_users_apple_sub ON users(apple_sub);

-- Apple's refresh token for each client the account signed in or linked with (the app's bundle id,
-- or the web's Services ID), kept only to revoke the grant when the account is deleted: a token
-- can only be revoked with the client_id it was issued to. A later sign-in with the same client
-- replaces its row. The cascade takes the rows with the account, after DELETE /api/me revoked them.
CREATE TABLE apple_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,                 -- 'com.ginochang.evenly' or 'com.ginochang.evenly.web'
  refresh_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id)
);

-- One-time codes of the iPhone app's Google flows, valid 5 minutes, single use, kept as SHA-256
-- only. 'sign_in': what the Google callback hands the app (com.ginochang.evenly://auth/google?code=),
-- spent by POST /api/auth/google/exchange with the verifier whose challenge the start kept.
-- 'link': the ticket of POST /api/me/google/ticket, spent by the start it opens, for the account
-- and the session that asked. The daily cleanup deletes expired rows (services/cron.ts).
CREATE TABLE google_app_codes (
  id TEXT PRIMARY KEY,                     -- SHA-256 hex of the code
  kind TEXT NOT NULL,                      -- 'sign_in' or 'link'
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,                         -- link: the session that asked for the ticket
  challenge TEXT,                          -- sign_in: base64url SHA-256 of the app's verifier
  arrival TEXT,                            -- sign_in: 'new', 'linked' or 'back'
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
-- Lets the cascade from users find its rows without scanning the table.
CREATE INDEX idx_google_app_codes_user ON google_app_codes(user_id);
