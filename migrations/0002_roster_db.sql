-- Integrate the external roster-db. The trip DB keeps a lightweight local
-- projection of people referenced by the trip:
--   * source='roster' rows mirror a roster-db member, keyed by bsa_number.
--   * source='local'  rows are app-only additions (e.g. unregistered cub
--     scouts / guests) that must NOT be written back to roster-db.
-- D1 has no cross-database FKs, so all of the app's people FKs continue to
-- reference this local table; roster members are lazily projected in.

ALTER TABLE people ADD COLUMN bsa_number TEXT;
ALTER TABLE people ADD COLUMN source TEXT NOT NULL DEFAULT 'local'
  CHECK (source IN ('roster', 'local'));

-- One projection per roster member per trip.
CREATE UNIQUE INDEX idx_people_trip_bsa
  ON people(trip_id, bsa_number) WHERE bsa_number IS NOT NULL;

-- Which roster-db units feed this trip's picker (JSON array of unit names).
ALTER TABLE trips ADD COLUMN roster_units TEXT NOT NULL
  DEFAULT '["Troop 10 F","Crew 10"]';
