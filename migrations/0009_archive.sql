-- Evenly schema v9: archiving a group for one person (docs/SPEC.md sections 4, 5 and 6, Archive).
-- Apply before deploying the code that reads it (scripts/deploy.sh checks): GET /api/me selects
-- members.archived_at, and every new entry by someone else writes it.

-- When this member's person archived the group, NULL while it is on their lists. Archiving hides
-- the group from that person's 總覽 and 群組 list only (it moves to 已封存 at the bottom of 群組);
-- nobody else sees a change, and the group's balances still count everywhere. A new entry that
-- someone else adds (an expense, a refund, a payment, a restore, an import, a recurring copy) sets
-- it back to NULL for everyone but its author, so a new debt is never hidden. Rows from before
-- this migration stay NULL: nothing is archived.
ALTER TABLE members ADD COLUMN archived_at TEXT;
