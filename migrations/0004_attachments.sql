-- File attachments (receipts) for expenses. The binary lives in R2 (bound as
-- RECEIPTS); this table is the metadata index so a TripBundle can list an
-- expense's files without touching the object store.
--
-- r2_key is the object key in the RECEIPTS bucket:
--   trip/<trip_id>/expense/<expense_id>/<attachment_id>-<safe_filename>
--
-- Lifecycle: deleting an expense (or attachment) cascades this row away, but D1
-- cannot reach into R2 — the Worker deletes the R2 object explicitly on those
-- paths (see index.ts). Snapshots freeze attachment metadata in their bundle
-- JSON; if the live expense is later deleted the frozen link may 404, which is
-- acceptable — the snapshot's financial record is unaffected.

PRAGMA foreign_keys = ON;

CREATE TABLE expense_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id   INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  trip_id      INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_attachments_expense ON expense_attachments(expense_id);
CREATE INDEX idx_attachments_trip ON expense_attachments(trip_id);
