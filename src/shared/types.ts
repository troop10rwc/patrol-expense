export type PersonType = "adult" | "scout";
export type GroupKind = "unit" | "patrol" | "travel";
export type SettlementStatus = "none" | "requested" | "received" | "paid";
export type PersonSource = "roster" | "local";

export interface Trip {
  id: number;
  uuid: string;
  slug: string;
  name: string;
  trip_date: string | null;
  planning_doc_url: string | null;
  slack_url: string | null;
  mileage_rate: number;
  roster_units: string[];
  created_at: string;
}

export interface Person {
  id: number;
  trip_id: number;
  name: string;
  code: string | null;
  email: string | null;
  type: PersonType;
  parent_id: number | null;
  bsa_number: string | null;
  source: PersonSource;
  created_at: string;
}

/** A live member read from the external roster-db (not stored in the trip DB). */
export interface RosterMember {
  bsa_number: string;
  name: string;
  first_name: string;
  last_name: string;
  type: PersonType;
  email: string | null;
  units: string[];
  // youth only:
  patrol?: string | null;
  rank?: string | null;
  guardian?: { bsa_number: string; name: string } | null;
}

export interface CostGroup {
  id: number;
  trip_id: number;
  name: string;
  kind: GroupKind;
  sort_order: number;
  origin: string | null;
  destination: string | null;
  one_way_miles: number | null;
  round_trip_miles: number | null;
  tolls: number | null;
  rate_override: number | null;
  cost_group_id: number | null;
}

export interface Expense {
  id: number;
  trip_id: number;
  group_id: number;
  description: string;
  amount: number;
  payer_id: number;
  source_travel_group_id: number | null;
  created_at: string;
}

export interface Prepayment {
  id: number;
  trip_id: number;
  person_id: number;
  amount: number;
  note: string | null;
  created_at: string;
}

export interface GroupMember {
  group_id: number;
  person_id: number;
}

// Derived (not stored): shares attributed to an adult in a group.
export interface DerivedShare {
  person_id: number;
  share_count: number;
}

// ----- computed views -----

export interface GroupSummary {
  group: CostGroup;
  total: number; // total expenses charged to this group
  totalShares: number; // = number of attributable members
  perShare: number; // total / totalShares (0 when no members)
  memberIds: number[]; // everyone (adults + youth) attending this group
  shares: DerivedShare[]; // per-adult share counts derived from membership
  reimbursementPerDriver?: number; // travel groups only
  driverIds?: number[]; // travel groups only
}

export interface PaysheetRow {
  person_id: number;
  name: string;
  code: string | null;
  paid: number; // total receipts this person fronted
  owed: number; // sum of share_count * perShare across cost groups
  prepay: number; // already reimbursed
  balance: number; // paid - owed (positive => troop owes person)
  outstanding: number; // balance - prepay (positive => still owed to person)
  status: SettlementStatus;
}

export interface Paysheet {
  rows: PaysheetRow[];
  totalExpenses: number;
  totalPrepaid: number;
}

export interface TripBundle {
  trip: Trip;
  people: Person[];
  groups: CostGroup[];
  expenses: Expense[];
  members: GroupMember[];
  prepayments: Prepayment[];
  travelDrivers: { group_id: number; person_id: number }[];
  groupSummaries: GroupSummary[];
  paysheet: Paysheet;
}

/** Lightweight snapshot row for the history list (no full bundle payload). */
export interface SnapshotMeta {
  id: number;
  trip_id: number;
  label: string | null;
  created_by: string | null;
  created_at: string;
  totalExpenses: number; // pulled from the stored bundle's paysheet
  outstanding: number; // sum of |outstanding| still owed at snapshot time
}

/** A full, immutable snapshot: metadata plus the frozen TripBundle. */
export interface Snapshot extends SnapshotMeta {
  bundle: TripBundle;
}

// ----- Google Sheet import -----
// A two-step (preview -> commit) import of an expense-report Google Sheet into a
// new trip. The workbook's per-area tabs (UnitOverall, PatrolPatrolN, Travel*)
// carry the real receipts (with payer), attendance, and travel routes; we map
// those straight onto the app's model and cross-check the derived per-person
// owed against the Summary tab to flag missed-formula errors. All surfaced
// inline in the preview before any write.

export type ImportFlagKind =
  | "broken_formula" // a Summary "Total Owed" cell didn't parse as currency (e.g. "2408%")
  | "summary_mismatch" // Summary total != sum of the Summary's own line items
  | "unmatched_person" // no roster match -> will become a local guest
  | "ambiguous_person" // >1 roster member shares this last-4 BSA suffix
  | "payer_unknown"; // a receipt row had no payer

export type ImportFlagSeverity = "blocking" | "warning" | "info";

export interface ImportFlag {
  kind: ImportFlagKind;
  severity: ImportFlagSeverity;
  message: string;
  groupName?: string; // anchor: the cost group this flag is about
  personRef?: string; // anchor: ImportPerson.ref this flag is about
  expected?: number; // dollars we recomputed
  found?: number | null; // dollars the sheet showed (null if unparseable)
  rawValue?: string; // the raw cell text, e.g. "2408%"
}

export type ImportPersonResolution =
  | { kind: "roster"; bsa_number: string } // matched a roster member
  | { kind: "guest" }; // create a local guest

export interface ImportPerson {
  ref: string; // stable key within this preview (e.g. "p0")
  rawName: string; // the sheet cell text, e.g. "Diane Sweet (3143)"
  displayName: string; // "Diane Sweet"
  code: string | null; // "3143" (last-4 of BSA), or null
  type: PersonType; // best guess; roster people get the real type at commit
  resolution: ImportPersonResolution;
  rosterCandidates?: { bsa_number: string; name: string }[]; // for the ambiguous case
}

export interface ImportReceipt {
  description: string; // e.g. "Safeway"
  amount: number;
  payerRef: string | null; // null => payer_unknown (blocking until the leader picks)
}

export interface ImportExpenseGroup {
  name: string; // "Unit:Overall", "Patrol:Patrol1", …
  kind: "unit" | "patrol";
  receipts: ImportReceipt[]; // real receipts read from the tab (payer included)
  memberRefs: string[]; // attendance (Patrol Members column)
  total: number; // sum of receipts
}

export interface ImportTravelGroup {
  name: string; // "Travel:Primary"
  origin: string | null;
  destination: string | null;
  oneWayMiles: number | null;
  roundTripMiles: number | null;
  tolls: number;
  rateOverride: number | null; // null when the tab's rate equals the trip rate
  driverRefs: string[];
  chargesTo: string | null; // name of the unit group the reimbursements charge to
  reimbursementPerDriver: number; // informational (from the tab)
}

export interface ImportPrepayment {
  personRef: string;
  amount: number;
  note: string;
}

export interface ImportSummaryRow {
  personRef: string;
  rawValue: string; // sheet cell text, e.g. "2408%" or "$236.36"
  parsedValue: number | null; // best-effort currency parse; null if broken
  recomputed: number; // sum of this person's owed line items on the Summary tab
}

export interface ImportTripMeta {
  name: string;
  trip_date: string | null; // raw text (e.g. "Apr 24-26"); not parsed to ISO
  planning_doc_url: string | null;
  rosterUnits: string[]; // units the people were resolved against
  mileage_rate: number; // from the Travel tabs' rate (default 0.28)
}

export interface ImportPreview {
  sheetId: string;
  sheetUrl: string;
  trip: ImportTripMeta;
  people: ImportPerson[];
  expenseGroups: ImportExpenseGroup[];
  travelGroups: ImportTravelGroup[];
  prepayments: ImportPrepayment[];
  summary: ImportSummaryRow[];
  flags: ImportFlag[];
}

// ----- per-person statement (consolidated across events) -----
// A single member's own expense summary across every trip they took part in.
// Built server-side: the live paysheet gives the current owed/due, and each
// snapshot's frozen paysheet gives a historical point so corrections that moved
// the number after a snapshot read as explicit deltas.

/** One historical point in a person's per-event balance, read from a snapshot. */
export interface StatementHistoryPoint {
  snapshot_id: number;
  label: string | null;
  created_at: string;
  outstanding: number; // this person's outstanding frozen in the snapshot
  delta: number; // change vs the previous point (first point's delta == its outstanding)
}

/** One event (trip) on a person's consolidated statement. */
export interface StatementEvent {
  trip: { uuid: string; slug: string; name: string; trip_date: string | null };
  person_id: number; // the matched person within this trip
  paid: number; // receipts they fronted (live)
  owed: number; // their derived share (live)
  prepay: number; // already reimbursed (live)
  outstanding: number; // live net (positive => troop owes them)
  status: SettlementStatus;
  projected: boolean; // no snapshot yet, or live differs from the latest snapshot
  liveDelta: number; // live outstanding minus the latest snapshot's (uncaptured movement)
  history: StatementHistoryPoint[]; // oldest -> newest
}

/** A person's consolidated expense statement across the events they appear in. */
export interface PersonStatement {
  person: { email: string | null; name: string; matched: boolean };
  events: StatementEvent[];
  totalOutstanding: number; // sum of live outstanding across events (positive => owed to them)
  projected: boolean; // true when any event is still projected (not fully snapshotted)
}

/** One trip where the troop still owes a member money. Returned by the read-only
 *  service-binding RPC `getOutstandingForMember` (consumed by the dashboard's
 *  "What's Next" card). A compact projection of {@link StatementEvent}. */
export interface OutstandingExpense {
  tripName: string;
  outstanding: number; // dollars still owed to the member (positive)
  status: SettlementStatus;
}

/** Lightweight per-trip rollup for the index page. */
export interface TripSummary {
  trip: Trip;
  totalCost: number; // sum of all expenses
  expenseCount: number; // number of receipts entered
  settleTotal: number; // people with a nonzero net balance
  settleDone: number; // of those, how many are marked 'paid' (reimbursement complete)
}
