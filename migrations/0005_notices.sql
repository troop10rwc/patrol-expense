-- Reimbursement notices: the per-person email a treasurer sends from the
-- Reimbursement tab, the no-sign-in statement link that email points at, and the
-- corrections recipients report back.
--
-- A notice is always cut from a snapshot, never from live data: the email states
-- an amount, so the figures behind it must be frozen and re-readable later. The
-- link below is just a capability handle onto (snapshot, person) — every number
-- the shared page shows is re-derived from the snapshot's stored bundle, so a
-- link can never drift from the email that carried it.

-- How a member settles up. Per-trip (rates/payees change between events) and
-- copied forward from the most recent trip that has one, so it's set once.
ALTER TABLE trips ADD COLUMN payment_instructions TEXT;

-- Capability link emailed to one person for one snapshot. The token is an
-- opaque bearer secret (~144 bits): whoever holds it reads that person's
-- statement without signing in, which is the point — parents without an
-- identity account still need to see why they owe. Stored (not signed) so it
-- can be revoked and audited.
CREATE TABLE statement_links (
  token       TEXT PRIMARY KEY,
  trip_id     INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  -- Deleting the snapshot invalidates every link cut from it: the frozen
  -- figures are gone, so the page could no longer explain the amount.
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  -- No FK to people: this identifies a person INSIDE the frozen bundle, and the
  -- page reads them from there. Someone later removed from the live trip must
  -- still be able to open the statement they were emailed.
  person_id   INTEGER NOT NULL,
  created_by  TEXT,                                   -- member who prepared the notice
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT
);
-- One LIVE link per (snapshot, person): re-preparing the same notice reuses the
-- URL already sitting in someone's inbox instead of minting a second secret.
-- Partial on revoked_at so revoked rows stay for the audit trail without
-- blocking a fresh link — revoking then re-sending is a normal correction.
CREATE UNIQUE INDEX idx_statement_links_snap_person
  ON statement_links(snapshot_id, person_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_statement_links_trip ON statement_links(trip_id);

-- A correction reported from a shared statement page ("this receipt isn't
-- mine", "you're missing my gas"). Written by an unauthenticated holder of the
-- link, so it's inert data: it never touches expenses, it only queues a claim
-- for the treasurer to act on in the Reimbursement tab.
CREATE TABLE corrections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id       INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  person_id     INTEGER NOT NULL,                     -- snapshot-scoped, as above
  -- The snapshot the reporter was looking at. SET NULL (not CASCADE): an old
  -- snapshot may be pruned, but the claim it prompted still needs answering.
  snapshot_id   INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('missing_expense','wrong_amount','not_mine','other')),
  message       TEXT NOT NULL,
  amount        REAL,                                 -- optional: the disputed / missing dollar figure
  reporter_name TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT,
  resolved_by   TEXT
);
CREATE INDEX idx_corrections_trip ON corrections(trip_id, status);
