-- Patrol Expense: normalized schema for trip cost splitting.
-- One D1 database; each former worksheet maps to a concept here:
--   Summary        -> trips
--   Paysheet       -> computed from expenses + members + prepayments + settlements
--   Unit:Overall   -> cost_groups(kind='unit') + expenses + group_members
--   Patrol:PatrolN -> cost_groups(kind='patrol')
--   Travel:*       -> cost_groups(kind='travel') + travel_drivers
--   Roster         -> people (adults + scouts via parent_id)

PRAGMA foreign_keys = ON;

CREATE TABLE trips (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid             TEXT NOT NULL UNIQUE,
  slug             TEXT NOT NULL,
  name             TEXT NOT NULL,
  trip_date        TEXT,
  planning_doc_url TEXT,
  slack_url        TEXT,
  mileage_rate     REAL NOT NULL DEFAULT 0.28,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Adults and scouts. A scout's responsible adult is parent_id.
CREATE TABLE people (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  code       TEXT,
  email      TEXT,
  type       TEXT NOT NULL CHECK (type IN ('adult','scout')),
  parent_id  INTEGER REFERENCES people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_people_trip ON people(trip_id);
CREATE INDEX idx_people_parent ON people(parent_id);

-- Cost centers an expense can be charged to.
-- Travel groups also hold the mileage calculator inputs and charge their
-- computed reimbursements to cost_group_id (e.g. the Unit group).
CREATE TABLE cost_groups (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id          INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('unit','patrol','travel')),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  -- travel-only columns:
  origin           TEXT,
  destination      TEXT,
  one_way_miles    REAL,
  round_trip_miles REAL,
  tolls            REAL DEFAULT 0,
  rate_override    REAL,
  cost_group_id    INTEGER REFERENCES cost_groups(id) ON DELETE SET NULL
);
CREATE INDEX idx_groups_trip ON cost_groups(trip_id);

-- Drivers reimbursed by a travel group.
CREATE TABLE travel_drivers (
  group_id  INTEGER NOT NULL REFERENCES cost_groups(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, person_id)
);

-- Who attended / belongs to a cost center (adults AND youth).
-- Shares are derived, not stored: every member counts as one share, attributed
-- to the responsible adult — a youth's share goes to their parent adult, and an
-- adult who attended gets a share for themselves.
CREATE TABLE group_members (
  group_id  INTEGER NOT NULL REFERENCES cost_groups(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, person_id)
);

-- Receipts. Travel-generated rows carry source_travel_group_id.
CREATE TABLE expenses (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id                INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  group_id               INTEGER NOT NULL REFERENCES cost_groups(id) ON DELETE CASCADE,
  description            TEXT NOT NULL,
  amount                 REAL NOT NULL,
  payer_id               INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  source_travel_group_id INTEGER REFERENCES cost_groups(id) ON DELETE CASCADE,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_expenses_trip ON expenses(trip_id);
CREATE INDEX idx_expenses_group ON expenses(group_id);
CREATE INDEX idx_expenses_payer ON expenses(payer_id);

-- Money already paid out to a person before settlement.
CREATE TABLE prepayments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  amount     REAL NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_prepay_trip ON prepayments(trip_id);

-- Settlement workflow status per person.
CREATE TABLE settlements (
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'none' CHECK (status IN ('none','requested','received','paid')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trip_id, person_id)
);
