-- Evenly schema v7: Sign in with Google on the web app (docs/SPEC.md sections 3, 5 and 6, Google).
-- Apply before deploying the code that reads it (scripts/deploy.sh checks): every account query
-- selects users.* and the DTO reads google_sub, and the Google callback writes it.

-- The Google account (the id_token's `sub`, Google's stable account id, never its email) this
-- account signs in with, NULL until a Google sign-in links it (routes/auth.ts). One account per
-- Google account: a unique index, since SQLite cannot add a UNIQUE column, and NULLs never clash
-- in it. Deleting the account deletes it with the row; the export says only whether one is
-- linked, never the id.
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub);
