-- Evenly schema v18: a member's payment details and profile photo reach the other members only once
-- its person opened the group (Gino's decision, 2026-11-21; reviews B2-03 and B4b-02; docs/SPEC.md
-- sections 4 and 6, Payment details and photos). Additive. Apply before deploying the code that
-- reads it (scripts/deploy.sh checks): every group route's membership check and every snapshot,
-- dashboard and photo query name the column.

-- When this member's person first opened the group (GET /api/groups/:gid), wrote anything in it,
-- joined or claimed it by a link, accepted a friend invite into it, or created it; NULL until then,
-- and for a placeholder. While it is NULL, nobody else gets the account's payment details (pay_info,
-- venmo, paypal) or photo for this member: a member linked by someone else's email (POST
-- /api/groups with emails, POST /api/groups/:gid/members, POST /api/friends) starts NULL. Unlinking
-- the member, deleting the account and a claim that lets an old row go set it back to NULL.
ALTER TABLE members ADD COLUMN accepted_at TEXT;

-- Every member already linked to an account counts as opened, so nothing changes in the groups
-- people have today: only members linked by email from now on start without it. claimed_at is when
-- the account was linked (created_at for the rare row without one). Rows that code from before this
-- migration writes (between `migrations apply` and `wrangler deploy`, or after a rollback) have NULL,
-- their own creator's and joiner's included: theirs show again the next time their person opens or
-- writes in the group.
UPDATE members SET accepted_at = COALESCE(claimed_at, created_at) WHERE user_id IS NOT NULL;
