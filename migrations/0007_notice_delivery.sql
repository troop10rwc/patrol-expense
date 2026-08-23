-- Delivery state for reimbursement notices: what the app actually sent, what
-- the recipient's mail server did with it, and whether they read the statement.
--
-- Until now the app never sent mail — it rendered a notice and the treasurer
-- pasted it into their own client (see 0005_notices.sql). That left the app
-- blind after the copy: no record of who was written to, whether it arrived, or
-- whether it bounced. The tables here close that gap, and they're deliberately
-- split three ways:
--
--   notice_sends        one row per send ATTEMPT, carrying the current status
--   notice_send_events  the append-only lifecycle log those statuses derive from
--   statement_links.*   view counters, the only honest "did they read it" signal
--
-- Cloudflare Email Service reports delivered / deferred / bounced / failed /
-- rejected / complained, but has no open or click tracking. We don't fake it
-- with a pixel: Apple Mail Privacy Protection fetches images whether or not the
-- message was read, so a per-person "opened" flag would be noise wearing the
-- costume of a fact. A statement page view is a real human, so that's what the
-- Reimbursement tab shows.

PRAGMA foreign_keys = ON;

-- One attempt to email one person their notice. A resend is a NEW row, never an
-- update: "we wrote to them twice and the first one bounced" is exactly the
-- history a treasurer chasing a payment needs to see.
CREATE TABLE notice_sends (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The statement link this notice carried. Cascades with the link, which in
  -- turn dies with its snapshot — a send record whose figures are gone can no
  -- longer be explained, so it shouldn't outlive them.
  token        TEXT NOT NULL REFERENCES statement_links(token) ON DELETE CASCADE,
  trip_id      INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  -- Snapshot-scoped, like statement_links.person_id: no FK to people, because
  -- someone later removed from the trip must still appear in its send history.
  person_id    INTEGER NOT NULL,
  snapshot_id  INTEGER NOT NULL,
  to_email     TEXT NOT NULL,
  reply_to     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  -- The net this message quoted. Denormalized on purpose: a bounce report has to
  -- be readable ("Sarah's $42.50 notice bounced") without rehydrating a snapshot
  -- bundle just to render one line of a status column.
  amount       REAL NOT NULL,
  -- Cloudflare's id for the message. NULL until the send returns — a send that
  -- throws never gets one. This is the join key for every lifecycle event.
  message_id   TEXT,
  status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','sent','delivered','deferred',
                                   'bounced','failed','rejected','complained')),
  error_code   TEXT,                                 -- E_* from the send binding
  error_detail TEXT,
  sent_by      TEXT NOT NULL,                        -- member who clicked Send
  sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  status_at    TEXT                                  -- when `status` last moved
);
CREATE INDEX idx_notice_sends_trip ON notice_sends(trip_id, person_id);
CREATE INDEX idx_notice_sends_token ON notice_sends(token);
-- Partial: many rows legitimately have no message_id (sends that failed before
-- Cloudflare accepted them), and those must not collide with each other.
CREATE UNIQUE INDEX idx_notice_sends_message ON notice_sends(message_id)
  WHERE message_id IS NOT NULL;

-- Raw lifecycle events from the Cloudflare Email Sending event subscription,
-- delivered over a queue. Kept as a log rather than folded straight into
-- notice_sends.status because the queue makes no ordering promise: a `deferred`
-- can arrive after the `delivered` that superseded it, and the log is what lets
-- the consumer reason about that instead of trusting arrival order.
CREATE TABLE notice_send_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Resolved at write time when possible, but nullable: an event can beat its
  -- own send row to the database, and losing it would silently lose a bounce.
  -- message_id below is the durable key, so a late row is still attributable.
  send_id     INTEGER REFERENCES notice_sends(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,
  type        TEXT NOT NULL,                         -- cf.email.sending.message.*
  occurred_at TEXT NOT NULL,                         -- from the event, not arrival
  terminal    INTEGER NOT NULL DEFAULT 0,            -- no further events expected
  detail      TEXT,                                  -- raw event JSON, for triage
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Queues guarantee at-least-once delivery, so the same event can arrive twice.
-- INSERT OR IGNORE against this index makes the consumer idempotent.
CREATE UNIQUE INDEX idx_notice_send_events_dedup
  ON notice_send_events(message_id, type, occurred_at);
CREATE INDEX idx_notice_send_events_send ON notice_send_events(send_id);

-- Did they actually read it? Counted on the statement page's data fetch, which
-- only fires on a real page load — unlike an image in an email, nothing
-- prefetches this on the recipient's behalf.
ALTER TABLE statement_links ADD COLUMN first_viewed_at TEXT;
ALTER TABLE statement_links ADD COLUMN last_viewed_at TEXT;
ALTER TABLE statement_links ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;

-- Corrections can now also arrive as an email reply, not just the statement
-- form. Same queue, same review, same inertness — it never touches an expense.
-- Email replies file under the existing kind='other' rather than adding a new
-- kind: SQLite can't widen a CHECK constraint without rebuilding the table, and
-- `source` already carries the distinction the tab needs to display.
ALTER TABLE corrections ADD COLUMN source TEXT NOT NULL DEFAULT 'form';
ALTER TABLE corrections ADD COLUMN from_email TEXT;                 -- envelope sender
ALTER TABLE corrections ADD COLUMN email_subject TEXT;

-- Photos attached to an emailed correction — the notice copy asks for "a photo
-- of the receipt", so replies arrive carrying them. Mirrors
-- expense_attachments (0004): binary in R2, metadata here, and the Worker
-- deletes the R2 object explicitly since D1 can't cascade into the bucket.
--   r2_key: trip/<trip_id>/correction/<correction_id>/<n>-<safe_filename>
CREATE TABLE correction_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  correction_id INTEGER NOT NULL REFERENCES corrections(id) ON DELETE CASCADE,
  trip_id       INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  r2_key        TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_correction_attachments_correction
  ON correction_attachments(correction_id);
