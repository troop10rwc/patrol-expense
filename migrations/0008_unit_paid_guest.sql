-- Guests the unit pays for.
--
-- A visiting cub scout or a guest adult is sometimes hosted by the troop: they
-- attend and consume a share of the trip's cost, but no family gets billed for
-- it — the unit treasury absorbs it.
--
-- This is deliberately NOT the same as leaving them off the attendance list.
-- Dropping them would re-split their cost across the other attending families,
-- silently raising everyone else's per-share. With this flag the share is still
-- counted (so every family's per-share stays honest) and the guest's cut of the
-- group total is attributed to the unit instead of to a billable adult. The
-- engine reports it as GroupSummary.unitCovered / Paysheet.totalUnitCovered,
-- which is exactly the gap between "owed to people" and "owed by people" that
-- the troop covers.
--
-- Only meaningful for source='local' rows: roster members are real registered
-- families and are always billed.
ALTER TABLE people ADD COLUMN unit_paid INTEGER NOT NULL DEFAULT 0
  CHECK (unit_paid IN (0, 1));
