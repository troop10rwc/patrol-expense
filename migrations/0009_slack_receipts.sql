-- Receipts tagged from Slack, waiting for a leader to review.
--
-- A parent posts a photo of a receipt in the trip's Slack channel and picks
-- "Attach to expense report" from the message's ⋮ menu. The modal asks which
-- expense report (trip) and which cost group (a patrol, or the unit) it belongs
-- to; submitting lands here.
--
-- This queue is deliberately INERT, exactly like `corrections`: nothing arriving
-- from Slack moves a number. Slack workspace membership is not the app's
-- identity — the session cookie is — so a Slack submission can never write to
-- `expenses` directly. A leader approves it on the Expenses tab, which is the
-- moment an expense row is created and the paysheet changes.
--
-- Approval hands the already-stored R2 objects over to `expense_attachments`
-- (same r2_key, no copy) and clears the rows here, so exactly one table owns
-- each object at any time. Rejection deletes the objects outright. As elsewhere,
-- D1 cannot reach into R2 — the Worker does those deletes explicitly.

PRAGMA foreign_keys = ON;

CREATE TABLE slack_receipts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id        INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  -- The patrol or unit group the submitter charged it to. A leader can change
  -- this at approval; this column records what Slack asked for.
  group_id       INTEGER NOT NULL REFERENCES cost_groups(id) ON DELETE CASCADE,

  -- Who submitted it. slack_user_id is the raw Slack member id from the signed
  -- interaction payload and is always present; submitter_email is the troop
  -- member it correlated to via the shared identity DB (users.slack_sub), and is
  -- NULL when that lookup missed — someone in the workspace who has never signed
  -- in to the troop apps. payer_id is that member projected onto THIS trip's
  -- people table, NULL when they aren't on the trip (or weren't matched); the
  -- leader picks the payer at approval in that case.
  slack_user_id  TEXT NOT NULL,
  slack_team_id  TEXT,
  slack_user_name TEXT NOT NULL,
  submitter_email TEXT,
  payer_id       INTEGER REFERENCES people(id) ON DELETE SET NULL,

  description    TEXT NOT NULL,
  amount         REAL NOT NULL,

  -- Provenance back to the Slack message, so a leader reviewing a photo can open
  -- the conversation it came from. Built from the payload (no API call): the
  -- archive URL is https://<team>.slack.com/archives/<channel>/p<ts sans dot>.
  slack_channel_id TEXT,
  slack_message_ts TEXT,
  slack_permalink  TEXT,

  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  -- The expense approval created. Kept after the fact as the audit link from a
  -- Slack message to the money it became.
  expense_id     INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  reviewed_by    TEXT,
  reviewed_at    TEXT,
  review_note    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_slack_receipts_trip ON slack_receipts(trip_id, status);
CREATE INDEX idx_slack_receipts_user ON slack_receipts(slack_user_id, status);

-- One row per file carried by the tagged message. The binary is already in the
-- RECEIPTS bucket under trip/<trip_id>/slack/<receipt_id>/... — these rows own
-- it until approval moves them to expense_attachments.
CREATE TABLE slack_receipt_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id   INTEGER NOT NULL REFERENCES slack_receipts(id) ON DELETE CASCADE,
  trip_id      INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  slack_file_id TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_slack_receipt_files_receipt ON slack_receipt_files(receipt_id);
