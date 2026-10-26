-- Evenly schema v8: friend invite links (docs/SPEC.md sections 4, 5 and 6, Friend invites).
-- Apply before deploying the code that reads it (scripts/deploy.sh checks): every account query
-- selects users.*, and GET /api/me/invite, /api/invite/:code and the /i/<code> page read
-- users.invite_code.

-- The account's personal friend invite code: 16 random characters from [A-Za-z0-9] (about 95
-- bits), NULL until GET /api/me/invite first asks for one. One link for everyone it is sent to,
-- with no expiry: whoever opens https://<site>/i/<code> sees the account's name, color and photo,
-- and signing in there makes the two of them friends (routes/invites.ts). POST
-- /api/me/invite/reset puts a new code in its place, so the old link stops working at once, and
-- deleting the account deletes it with the row. One account per code: a unique index, since SQLite
-- cannot add a UNIQUE column, and NULLs never clash in it.
ALTER TABLE users ADD COLUMN invite_code TEXT;
CREATE UNIQUE INDEX idx_users_invite_code ON users(invite_code);
