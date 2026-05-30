export type PersonType = "adult" | "scout";
export type GroupKind = "unit" | "patrol" | "travel";
export type SettlementStatus = "none" | "requested" | "received" | "paid";

export interface Trip {
  id: number;
  uuid: string;
  slug: string;
  name: string;
  trip_date: string | null;
  planning_doc_url: string | null;
  slack_url: string | null;
  mileage_rate: number;
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
  created_at: string;
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
