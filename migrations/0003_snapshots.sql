-- Point-in-time snapshots of a trip's full financial state.
-- Each row freezes the entire computed TripBundle (expenses, people, groups,
-- membership/shares, prepayments, travel drivers, group summaries, paysheet) as
-- JSON. Storing the computed bundle (not raw rows) makes a snapshot immutable
-- and self-contained: it survives later deletion of people, roster-db changes,
-- or engine tweaks. "Changes since last snapshot" diffs the latest snapshot's
-- stored bundle against the current live bundle.

CREATE TABLE snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  label      TEXT,                                   -- optional user note
  created_by TEXT,                                   -- Cloudflare Access identity email
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  bundle     TEXT NOT NULL                           -- JSON of TripBundle at capture time
);
CREATE INDEX idx_snapshots_trip ON snapshots(trip_id);
