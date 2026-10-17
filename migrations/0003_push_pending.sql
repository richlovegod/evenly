-- Evenly schema v3: push messages a sender run could not fit (docs/notes/push.md, step 7).
-- Apply before deploying the code that reads it (scripts/deploy.sh checks).

-- A run sends at most PUSH_MAX_PER_RUN messages. When the group it is working on has more, the
-- rest waits here, and the next runs send it (with half their budget while other groups are due):
-- every person's newest
-- device before anyone's second (rank), then in the order the rows came. A run deletes the rows it
-- takes in the same transaction that reads them, so none goes out twice. A row is dropped instead
-- of sent when it is a day old, when its device moved to another account, or when the device's
-- session has ended; deleting the subscription (signing out, a revoked device, a 404 or 410 from
-- the push service) deletes its rows.
CREATE TABLE push_pending (
  id INTEGER PRIMARY KEY,                  -- the order the rows came in
  sub_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,                   -- the account the message was written for
  rank INTEGER NOT NULL,                   -- 0 for the person's newest device, 1 for the next...
  payload TEXT NOT NULL,                   -- PushPayload JSON, encrypted when it is sent
  urgency TEXT NOT NULL,                   -- 'normal', or 'low' for the import summary
  created_at TEXT NOT NULL                 -- when the run kept it
);
-- Lets the cascade from push_subscriptions find its rows without scanning the table.
CREATE INDEX idx_push_pending_sub ON push_pending(sub_id);
