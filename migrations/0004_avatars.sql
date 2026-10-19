-- Evenly schema v4: profile photos (docs/SPEC.md sections 5 and 6, Profile photo).
-- Apply before deploying the code that reads it (scripts/deploy.sh checks): the account, group and
-- dashboard queries read users.avatar, so the old schema would refuse them.

-- The photo an account chose as its avatar: the square image the app made (256 x 256, about 15 to
-- 40 KB as JPEG, at most 150,000 bytes; routes/avatars.ts checks it). One row per account, read
-- only by GET /api/users/:userId/avatar and the export; deleting the account deletes it.
CREATE TABLE avatars (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,                      -- 'image/jpeg' or 'image/png', as the bytes start
  data BLOB NOT NULL,                      -- the image as uploaded
  version TEXT NOT NULL,                   -- the first 16 hex characters of SHA-256(data)
  updated_at TEXT NOT NULL
);

-- The current photo's version (avatars.version), NULL without one. The DTOs carry it with no join
-- on the bytes, and clients build the photo's address from it (?v=<version>).
ALTER TABLE users ADD COLUMN avatar TEXT;
