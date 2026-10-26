-- Evenly schema v10: a group's default split (docs/SPEC.md sections 4, 5 and 6, Default split).
-- Apply before deploying the code that reads it (scripts/deploy.sh checks): every group snapshot
-- maps groups.default_split into GroupDTO.defaultSplit, and PATCH /api/groups/:gid writes it.

-- The split new expenses in the group start from, as JSON (src/shared/defaultSplit.ts DefaultSplit:
-- method 'equal', 'percent' or 'shares', the members it lists with their values, the default payer
-- or null for whoever adds the expense, and setAt), NULL for none: then a new expense splits
-- equally among everyone, as before. One per group, shared by its members; any member may set or
-- clear it (a 'group.update' activity row says so). A member who leaves is dropped from it in the
-- same batch as the leave; one who joins later is not in it until someone edits it.
ALTER TABLE groups ADD COLUMN default_split TEXT;
