-- Evenly schema v11: refunds (docs/SPEC.md sections 2, 5 and 6, Refunds).
-- Apply before deploying the code that reads it (scripts/deploy.sh checks): every write of an entry
-- sets expenses.refund_of, and every entry a client gets maps it into ExpenseDTO.refundOf.

-- A refund (expenses.kind 'refund', a new value of the existing TEXT column) is money coming back,
-- exactly a negative expense: its payers are who got the money back, its split whose money it is.
-- refund_of is the id of the expense of the same group it refunds when it was started from that
-- expense (記一筆退款), NULL for every other entry; it only links the two pages, no math reads it.
-- A client without X-Evenly-Features: refunds sees refunds as expenses (src/worker/compat.ts).
-- Rows from before this migration stay NULL.
ALTER TABLE expenses ADD COLUMN refund_of TEXT;
