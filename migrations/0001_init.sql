-- Evenly schema v1. Amounts are integer minor units; dates 'YYYY-MM-DD'; times ISO 8601 UTC.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,                       -- lowercase sign-in email, NULL until set
  pw_hash TEXT,                            -- 'pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>'
  locale TEXT NOT NULL DEFAULT 'zh-TW',
  currency TEXT NOT NULL DEFAULT 'TWD',
  color TEXT NOT NULL,
  pay_info TEXT NOT NULL DEFAULT '',
  venmo TEXT NOT NULL DEFAULT '',
  paypal TEXT NOT NULL DEFAULT '',
  activity_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                     -- SHA-256 hex of the bearer token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- One-time codes: 'device' (sign in another device, 10 min) and 'reset' (admin-made password reset link, 30 min).
CREATE TABLE login_codes (
  id TEXT PRIMARY KEY,                     -- SHA-256 hex of the code
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_login_codes_user ON login_codes(user_id);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                      -- trip | home | couple | other | pair
  currency TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  simplify INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  invite_code TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  summary TEXT                             -- JSON GroupSummary (src/shared/summary.ts), cache
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',     -- admin | member
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  claimed_at TEXT
);
CREATE INDEX idx_members_group ON members(group_id);
CREATE INDEX idx_members_user ON members(user_id);
CREATE UNIQUE INDEX uq_members_group_user ON members(group_id, user_id) WHERE user_id IS NOT NULL;

-- One-time links that let a specific person take over a specific member (7 days).
CREATE TABLE claim_tokens (
  id TEXT PRIMARY KEY,                     -- SHA-256 hex of the token
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_claim_tokens_member ON claim_tokens(member_id);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,                     -- client-generated UUID
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                      -- expense | payment
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fx_rate REAL NOT NULL DEFAULT 1,
  date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  payers TEXT NOT NULL,                    -- JSON Portion[]
  split TEXT NOT NULL,                     -- JSON SplitInput
  shares TEXT NOT NULL,                    -- JSON Portion[] computed by the server
  repeat TEXT NOT NULL DEFAULT 'none',
  repeat_series TEXT,
  repeat_start TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_expenses_group ON expenses(group_id, date);
CREATE INDEX idx_expenses_repeat ON expenses(repeat, deleted_at);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  expense_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  member_id TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_comments_expense ON comments(expense_id);
CREATE INDEX idx_comments_group ON comments(group_id);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT,                            -- actor; NULL for the system (recurring)
  member_id TEXT,
  type TEXT NOT NULL,
  expense_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_group ON activity(group_id, created_at);
CREATE INDEX idx_activity_expense ON activity(expense_id);

-- Exchange rates per day, all against USD: rates[C] = units of C per 1 USD.
CREATE TABLE fx_cache (
  day TEXT PRIMARY KEY,
  rates TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL                -- epoch milliseconds
);
