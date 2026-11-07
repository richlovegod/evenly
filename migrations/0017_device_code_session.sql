-- Evenly schema v17: a code to sign in another device belongs to the session that asked for it
-- (docs/SPEC.md section 3, Sign in another device; review W6-correct-03). Additive. POST
-- /api/auth/link-code stores the asking session here, and the code goes when that session ends
-- (logout, signing that device out from 我的, a reset link, expiry): the cascade below, the same one
-- push_subscriptions and apns_devices use. Ending any other session of the account no longer
-- cancels it, so signing an old device out on the 裝置 page leaves the code shown beside it working.
-- POST /api/auth/link takes a code only while its session is live. Rows from before (and from code
-- deployed before this migration, between `migrations apply` and `wrangler deploy` or after a
-- rollback) have NULL here: the account's ending sessions cancel those as before, and they expire
-- within 10 minutes anyway.
ALTER TABLE login_codes ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
-- Lets the cascade from sessions find its rows without scanning the table.
CREATE INDEX idx_login_codes_session ON login_codes(session_id);
