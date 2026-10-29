-- Evenly schema v12: the iPhone app's notifications through Apple Push Notification service
-- (services/apns.ts), the second delivery channel of the push sender (services/push.ts), beside
-- Web Push. Additive: two new tables, nothing else changes. Apply before deploying the code that
-- reads them (scripts/deploy.sh checks): every sender run and GET /api/push/status read both.

-- One row per iPhone that turned notifications on (PUT /api/push/apns), tied to the session that
-- registered it, as push_subscriptions is: signing out, revoking the device, a password reset,
-- session expiry or deleting the account deletes the session or the account, and with it the row.
CREATE TABLE apns_devices (
  token TEXT PRIMARY KEY,                  -- the APNs device token, lowercase hex
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,               -- 'sandbox' (builds run from Xcode) or 'production'
  bundle_id TEXT NOT NULL,                 -- the app's bundle id, sent as the apns-topic
  tz TEXT NOT NULL DEFAULT '',             -- IANA time zone of the device, '' when unknown
  label TEXT NOT NULL DEFAULT '',          -- the app's name for the device, e.g. 'iPhone'
  created_at TEXT NOT NULL,
  last_ok_at TEXT,                         -- the last notification APNs accepted
  failures INTEGER NOT NULL DEFAULT 0      -- failed sends in a row; the row is deleted at 5
);
CREATE INDEX idx_apns_user ON apns_devices(user_id);
-- Lets the cascade from sessions find its rows without scanning the table.
CREATE INDEX idx_apns_session ON apns_devices(session_id);

-- Messages for iPhones that a sender run could not fit: push_pending's twin (its sub_id can only
-- name a push_subscriptions row). A run takes kept messages from both tables together, every
-- person's device in use before anyone's second (rank), and deletes them in the same transaction
-- that reads them, so none goes out twice. A row is dropped instead of sent when it is a day old,
-- when its iPhone moved to another account, or when the iPhone's session has ended; deleting the
-- iPhone's row (signing out, APNs saying the token is no good) deletes its kept messages.
CREATE TABLE apns_pending (
  id INTEGER PRIMARY KEY,                  -- the order the rows came in
  token TEXT NOT NULL REFERENCES apns_devices(token) ON DELETE CASCADE,
  user_id TEXT NOT NULL,                   -- the account the message was written for
  rank INTEGER NOT NULL,                   -- 0 for the person's device in use, 1 for the next...
  payload TEXT NOT NULL,                   -- the APNs JSON body, sent as it is
  urgency TEXT NOT NULL,                   -- 'normal', or 'low' for the import summary (priority 5)
  collapse_id TEXT,                        -- the apns-collapse-id (web push's tag)
  created_at TEXT NOT NULL,                -- when the run kept it
  taken INTEGER NOT NULL DEFAULT 0         -- 1 only inside the batch that takes the row
);
-- Lets the cascade from apns_devices find its rows without scanning the table.
CREATE INDEX idx_apns_pending_token ON apns_pending(token);
