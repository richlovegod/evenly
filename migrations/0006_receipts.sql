-- Evenly schema v6: receipt photos kept with their expense (docs/SPEC.md sections 5 and 6, Receipt photos).
-- Apply before deploying the code that reads it (scripts/deploy.sh checks): every group snapshot
-- and the export join receipts, so the old schema would refuse them.

-- The photo attached to an expense: the bytes live in Workers KV (binding RECEIPTS, key
-- receipt:<expense_id>:<version>), this row says which object is current and what the DTO shows.
-- One photo per expense; a new one replaces the row, and its old object is deleted. The app makes
-- the image (longest side at most 1600 px, JPEG at about 0.7: 150 to 400 KB); the Worker keeps at
-- most 600,000 bytes (routes/receiptPhotos.ts checks them). Soft-deleting the expense keeps the
-- row, so 復原 brings the photo back; the daily job deletes the object and the row a day after the
-- expense was deleted, and when the group is deleted (services/receiptPhotos.ts). Deleting an
-- account keeps them: they are the group's, like its expenses (uploaded_by has no foreign key).
CREATE TABLE receipts (
  expense_id TEXT PRIMARY KEY REFERENCES expenses(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,                  -- the expense's group: who may see it, the cleanup
  kv_key TEXT NOT NULL,                    -- receipt:<expense_id>:<version>, the object in KV
  version TEXT NOT NULL,                   -- the first 16 hex characters of SHA-256 of the bytes
  mime TEXT NOT NULL,                      -- 'image/jpeg' or 'image/png', as the bytes start
  bytes INTEGER NOT NULL,                  -- the object's size; SUM(bytes) is the storage cap
  width INTEGER NOT NULL,                  -- as the app measured it (1 to 4000), for the layout
  height INTEGER NOT NULL,
  uploaded_by TEXT,                        -- the account that uploaded it (no foreign key)
  created_at TEXT NOT NULL
);
-- The group snapshot reads a group's receipts, and the cleanup finds those of deleted groups.
CREATE INDEX idx_receipts_group ON receipts(group_id);
