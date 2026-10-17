-- Evenly schema v2: Web Push notifications (docs/PLAN-push-scan-cookies.md section 2).
-- Apply before deploying the code that writes activity.push_at (scripts/deploy.sh checks).

-- The event time of an activity row that may notify people (services/activity.ts pushAtFor):
-- NULL for every other row, and again NULL once the sender (services/push.ts) has claimed it.
-- Rows written before this migration stay NULL, so turning push on never sends anything old.
ALTER TABLE activity ADD COLUMN push_at TEXT;
CREATE INDEX idx_activity_push ON activity(group_id, push_at) WHERE push_at IS NOT NULL;

-- One row per browser that turned notifications on (its PushSubscription), tied to the session
-- that subscribed: signing out, revoking the device, a password reset or session expiry deletes
-- the session and with it this device's notifications.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,                     -- SHA-256 hex of the endpoint
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,                  -- https URL on an allowed push service (routes/push.ts)
  p256dh TEXT NOT NULL,                    -- the browser's P-256 public key, base64url (65 bytes)
  auth TEXT NOT NULL,                      -- the browser's auth secret, base64url (16 bytes)
  tz TEXT NOT NULL DEFAULT '',             -- IANA time zone of the device, '' when unknown
  label TEXT NOT NULL DEFAULT '',          -- deviceLabel(User-Agent), e.g. 'iPhone Safari'
  created_at TEXT NOT NULL,
  last_ok_at TEXT,                         -- the last push the push service accepted
  failures INTEGER NOT NULL DEFAULT 0      -- failed pushes in a row; the row is deleted at 5
);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
-- Lets the cascade from sessions find its rows without scanning the table.
CREATE INDEX idx_push_session ON push_subscriptions(session_id);

-- Which kinds of change notify the account (PushPrefsDTO as JSON); a missing key means on.
ALTER TABLE users ADD COLUMN notify_prefs TEXT NOT NULL DEFAULT '{}';
