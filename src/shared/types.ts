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
// A two-step (preview -> commit) import of an ad-hoc expense Google Sheet into a
// new trip. The sheet is in "owed-space" (what each person owes); we reconstruct
// receipts + attendance and flag whatever doesn't reconcile, surfaced inline in
// the preview before any write.

export type ImportFlagKind =
  | "broken_formula" // a summary cell didn't parse as currency (e.g. "2408%")
  | "summary_mismatch" // recomputed total != the sheet's summary value
  | "unmatched_person" // no roster match -> will become a local guest
  | "ambiguous_person" // >1 roster member shares this last-4 BSA suffix
  | "payer_unknown" // a reconstructed group receipt has no inferable payer
  | "group_unreconciled" // per-person amounts don't divide into equal shares
  | "uneven_shares"; // a person owes an integer multiple of the base share (multi-dependent)

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
  rawName: string; // the sheet cell text, e.g. "Jane Doe (1234)"
  displayName: string; // "Jane Doe"
  code: string | null; // "1234" (last-4 of BSA), or null
  type: PersonType; // best guess; roster people get the real type at commit
  resolution: ImportPersonResolution;
  rosterCandidates?: { bsa_number: string; name: string }[]; // for the ambiguous case
}

export interface ImportLineItem {
  personRef: string;
  owed: number; // this person's owed amount for the group (0 if unparseable)
}

export interface ImportReceipt {
  description: string;
  amount: number; // = sum of the group's line items
  payerRef: string | null; // null => payer_unknown (blocking until the leader picks)
}

export interface ImportExpenseGroup {
  name: string; // "Unit:Overall", "Patrol:Patrol1", …
  kind: GroupKind;
  lineItems: ImportLineItem[];
  total: number;
  receipt: ImportReceipt;
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
  recomputed: number; // sum of this person's owed line items across groups
}

export interface ImportTripMeta {
  name: string;
  trip_date: string | null; // raw text (e.g. "Apr 24-26"); not parsed to ISO
  planning_doc_url: string | null;
  rosterUnits: string[]; // units the people were resolved against
  mileage_rate: number; // default 0.28 (sheet carries no mileage data)
}

export interface ImportPreview {
  sheetId: string;
  sheetUrl: string;
  trip: ImportTripMeta;
  people: ImportPerson[];
  groups: ImportExpenseGroup[];
  prepayments: ImportPrepayment[];
  summary: ImportSummaryRow[];
  flags: ImportFlag[];
}

/** Lightweight per-trip rollup for the index page. */
export interface TripSummary {
  trip: Trip;
  totalCost: number; // sum of all expenses
  expenseCount: number; // number of receipts entered
  settleTotal: number; // people with a nonzero net balance
  settleDone: number; // of those, how many are marked 'paid' (reimbursement complete)
}
