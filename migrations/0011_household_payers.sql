-- Households: a youth and their roster guardians, joined with siblings who
-- share a guardian. They are DERIVED, not stored — read live from roster-db's
-- `relationships` on every request (src/worker/household.ts) — so a family
-- that changes in the roster re-forms here on its own.
--
-- The one thing the roster can't say is which adult settles up for the family:
-- who pays the troop and who the troop pays back. Absent a choice that's the
-- guardian most of the household's youth list first (the same adult the
-- paysheet already bills a youth's share to). A leader can designate someone
-- else; this table holds those designations.
--
-- Keyed by the adult, not by the household, because a household has no stable
-- identity of its own: it's whoever the roster currently links together. A
-- household's payer is whichever of its guardians appears here most recently;
-- designating one clears the household's others in the same batch.
--
-- Informational only for now: it decides whose name heads a family statement.
-- It does not move any trip's paysheet attribution.

CREATE TABLE household_payers (
  bsa_number     TEXT PRIMARY KEY,
  designated_by  TEXT,
  designated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
