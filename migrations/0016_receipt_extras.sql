-- Evenly schema v16: up to three receipt photos per expense (docs/SPEC.md sections 5 and 6,
-- Receipt photos). Additive. `receipts` (0006) keeps one row per expense, its first photo, as it
-- is, so code from before this migration (between `migrations apply` and `wrangler deploy`, and
-- after a rollback) still upserts it with ON CONFLICT(expense_id), joins it once per expense and
-- shows that photo. The second and third photos are rows here, which that code never reads or
-- writes. The bytes stay in Workers KV under receipt:<expense_id>:<version>. An expense's photos,
-- in order: its receipts row, then these by created_at, then version. Soft-deleting the expense
-- keeps them (復原 brings every photo back); the daily job deletes them with the first one.
CREATE TABLE receipt_extras (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  version TEXT NOT NULL,                   -- the first 16 hex characters of SHA-256 of the bytes
  group_id TEXT NOT NULL,                  -- the expense's group: who may see it, the cleanup
  kv_key TEXT NOT NULL,                    -- receipt:<expense_id>:<version>
  mime TEXT NOT NULL,                      -- 'image/jpeg' or 'image/png'
  bytes INTEGER NOT NULL,                  -- counted in the storage cap with SUM(receipts.bytes)
  width INTEGER NOT NULL,                  -- as the app measured it (1 to 4000)
  height INTEGER NOT NULL,
  uploaded_by TEXT,                        -- no foreign key, as in receipts
  created_at TEXT NOT NULL,                -- when it was added: its place after the first photo
  PRIMARY KEY (expense_id, version)
);
CREATE INDEX idx_receipt_extras_group ON receipt_extras(group_id);
