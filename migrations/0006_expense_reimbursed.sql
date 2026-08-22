-- Mark an individual receipt as already paid back to the person who fronted it.
--
-- Two different things reduce what the troop still owes someone, and they stay
-- separate on purpose:
--   * prepayments  — a lump sum handed to a person, not tied to any receipt.
--   * this column  — "we already settled THIS receipt", recorded where the
--                    treasurer is looking at it (the Expenses tab).
-- Both are subtracted from the paysheet's net, so a receipt marked here stops
-- counting toward that payer's outstanding balance on the Reimbursement tab.
--
-- reimbursed_at is the mark itself (NULL => not reimbursed); reimbursed_by is
-- the member who set it, kept for the audit trail like snapshots.created_by.

ALTER TABLE expenses ADD COLUMN reimbursed_at TEXT;
ALTER TABLE expenses ADD COLUMN reimbursed_by TEXT;

-- The paysheet sums a payer's reimbursed receipts on every bundle load.
CREATE INDEX idx_expenses_reimbursed ON expenses(trip_id, reimbursed_at);
