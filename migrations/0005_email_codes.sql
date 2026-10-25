-- Evenly schema v5: email sign-in codes (docs/SPEC.md sections 3, 5 and 6, Email codes).
-- Apply before deploying the code that reads it (scripts/deploy.sh checks): every account query
-- reads users.email_verified_at, and the email routes write email_codes.

-- One 6-digit code sent by email (services/emailCodes.ts), valid 10 minutes, at most 5 tries.
-- 'sign_in' signs in the account that has the email, or creates one (POST /api/auth/email/*);
-- 'add_email' puts the email on the signed-in account (POST /api/me/email/*). A new code for the
-- same email and purpose replaces the older unused ones. Only a hash of the code is kept. The
-- daily cleanup deletes a row a day after it was made, used or not (services/cron.ts), and
-- deleting an account deletes its add_email rows. No index on user_id: the table holds about a
-- day of codes, so the cascade's scan stays small.
CREATE TABLE email_codes (
  id TEXT PRIMARY KEY,                     -- random (a UUID); also salts code_hash
  email TEXT NOT NULL,                     -- NFKC, trimmed, lowercase
  purpose TEXT NOT NULL,                   -- 'sign_in' or 'add_email'
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE, -- add_email only: the account adding it
  code_hash TEXT NOT NULL,                 -- SHA-256 hex of id + ':' + code
  attempts INTEGER NOT NULL DEFAULT 0,     -- tries so far; the code is dead at 5
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
-- Every lookup names the address and the purpose (the live code, the older ones a new code replaces).
CREATE INDEX idx_email_codes_email ON email_codes(email, purpose);

-- When the account's email was confirmed with a code. NULL until then: every account from before
-- this migration stays unconfirmed until its owner signs in with a code or confirms the email.
-- From here on an email comes only with a code (signup takes a name alone).
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
