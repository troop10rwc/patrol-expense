-- Unit expenses: money the troop owes one member for something that isn't a
-- trip — a box of first-aid supplies, a campsite deposit, printer toner. One
-- person fronted it, one person gets it back. There are no shares to split and
-- no cost groups, which is why this is its own table rather than a fake "trip".
--
-- Lifecycle:  pending -> approved -> paid      (or pending -> rejected)
--
-- `pending` is what a Slack submission lands as, and like `slack_receipts` it
-- is INERT: it counts toward nothing — not the member's statement, not the
-- unit total. Slack workspace membership isn't this app's identity, so a signed
-- Slack payload can queue a request but never move a number. A signed-in leader
-- approving it (or adding one directly in the app) is what makes it money.
--
-- `approved` is "the troop owes this person"; it rolls up into their My
-- statement total. `paid` is settled, and stays on the statement as history.

PRAGMA foreign_keys = ON;

CREATE TABLE unit_expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Who gets reimbursed. Keyed by email because that's how a member's
  -- statement finds them (the same key /me/statement matches trips on). NULL
  -- only while pending: a Slack sender who isn't linked to a troop member has
  -- no email yet, and the leader picks the payee before approving.
  payee_email     TEXT,
  payee_name      TEXT NOT NULL,

  description     TEXT NOT NULL,
  amount          REAL NOT NULL CHECK (amount > 0),
  -- When the money was spent, as the submitter tells it (YYYY-MM-DD). Optional.
  spent_on        TEXT,

  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','paid')),
  source          TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','slack')),
  created_by      TEXT,                               -- member who added it in the app
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  -- Provenance back to Slack, mirroring slack_receipts. slack_user_id is who ran
  -- the shortcut; the payee is usually the message's author, which may differ
  -- (a treasurer filing someone else's receipt).
  slack_user_id   TEXT,
  slack_team_id   TEXT,
  slack_user_name TEXT,
  -- The Slack member picked as payee, kept so an unmatched payee can still be
  -- named in the thread (<@U…>) and re-resolved once they link their account.
  payee_slack_id  TEXT,
  slack_channel_id TEXT,
  slack_message_ts TEXT,
  slack_permalink  TEXT,

  reviewed_by     TEXT,
  reviewed_at     TEXT,
  review_note     TEXT,                               -- why it was rejected

  paid_by         TEXT,
  paid_at         TEXT,
  paid_note       TEXT                                -- e.g. "check #1042", "Venmo"
);
CREATE INDEX idx_unit_expenses_status ON unit_expenses(status, id);
CREATE INDEX idx_unit_expenses_payee ON unit_expenses(payee_email, status);
CREATE INDEX idx_unit_expenses_slack_user ON unit_expenses(slack_user_id, status);

-- Receipt files. Binary in R2 (RECEIPTS) under unit/<unit_expense_id>/...;
-- the Worker deletes the objects explicitly since D1 can't cascade into R2.
CREATE TABLE unit_expense_files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_expense_id INTEGER NOT NULL REFERENCES unit_expenses(id) ON DELETE CASCADE,
  r2_key          TEXT NOT NULL,
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  size            INTEGER NOT NULL,
  slack_file_id   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_unit_expense_files_expense ON unit_expense_files(unit_expense_id);

-- One row per email ATTEMPT about a unit expense, same shape and semantics as
-- notice_sends (0007): a resend is a new row, the row is written before the
-- send so a throw still leaves a record, and the Email Sending event queue
-- folds delivered/bounced/... into `status` by message_id.
--
-- `kind` is which news the message carried: that it was approved (the troop
-- owes you $X) or that it's been paid.
CREATE TABLE unit_expense_sends (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_expense_id INTEGER NOT NULL REFERENCES unit_expenses(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('approved','paid')),
  to_email        TEXT NOT NULL,
  reply_to        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  amount          REAL NOT NULL,
  message_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sent','delivered','deferred',
                                      'bounced','failed','rejected','complained')),
  error_code      TEXT,
  error_detail    TEXT,
  sent_by         TEXT NOT NULL,
  sent_at         TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at    TEXT,
  status_at       TEXT
);
CREATE INDEX idx_unit_expense_sends_expense ON unit_expense_sends(unit_expense_id);
CREATE UNIQUE INDEX idx_unit_expense_sends_message ON unit_expense_sends(message_id)
  WHERE message_id IS NOT NULL;
