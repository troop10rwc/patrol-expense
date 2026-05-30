import type {
  Trip,
  Person,
  CostGroup,
  Expense,
  Prepayment,
  GroupMember,
  GroupSummary,
  Paysheet,
  PaysheetRow,
  SettlementStatus,
} from "../shared/types.ts";

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Mileage reimbursement a travel group pays each of its drivers. */
export function travelReimbursement(trip: Trip, g: CostGroup): number {
  if (g.kind !== "travel") return 0;
  const roundTrip = g.round_trip_miles ?? (g.one_way_miles != null ? g.one_way_miles * 2 : 0);
  const rate = g.rate_override ?? trip.mileage_rate;
  return round2(roundTrip * rate + (g.tolls ?? 0));
}

export interface EngineInput {
  trip: Trip;
  people: Person[];
  groups: CostGroup[];
  expenses: Expense[];
  members: GroupMember[];
  prepayments: Prepayment[];
  travelDrivers: { group_id: number; person_id: number }[];
  settlements: { person_id: number; status: SettlementStatus }[];
}

/**
 * Attribute each member of a group to a billable adult: a youth's share goes to
 * their parent adult; an adult's share goes to themselves. Returns a map of
 * adultId -> share_count for the group. Members whose share can't be attributed
 * to an adult (e.g. a youth with no parent) are dropped so the split balances.
 */
function deriveShares(
  memberIds: number[],
  personById: Map<number, Person>,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const pid of memberIds) {
    const p = personById.get(pid);
    if (!p) continue;
    const adultId = p.type === "adult" ? p.id : p.parent_id;
    if (adultId == null) continue; // youth with no responsible adult
    const adult = personById.get(adultId);
    if (!adult || adult.type !== "adult") continue;
    counts.set(adultId, (counts.get(adultId) ?? 0) + 1);
  }
  return counts;
}

export function computeGroupSummaries(input: EngineInput): GroupSummary[] {
  const { trip, people, groups, expenses, members, travelDrivers } = input;
  const personById = new Map<number, Person>(people.map((p) => [p.id, p]));

  return groups.map((group) => {
    const total = round2(
      expenses.filter((e) => e.group_id === group.id).reduce((s, e) => s + e.amount, 0),
    );
    const memberIds = members.filter((m) => m.group_id === group.id).map((m) => m.person_id);
    const shareCounts = deriveShares(memberIds, personById);
    const shares = [...shareCounts.entries()].map(([person_id, share_count]) => ({
      person_id,
      share_count,
    }));
    const totalShares = shares.reduce((s, r) => s + r.share_count, 0);
    const perShare = totalShares > 0 ? total / totalShares : 0;
    const summary: GroupSummary = { group, total, totalShares, perShare, memberIds, shares };
    if (group.kind === "travel") {
      summary.reimbursementPerDriver = travelReimbursement(trip, group);
      summary.driverIds = travelDrivers
        .filter((d) => d.group_id === group.id)
        .map((d) => d.person_id);
    }
    return summary;
  });
}

export function computePaysheet(input: EngineInput, summaries: GroupSummary[]): Paysheet {
  const { people, expenses, prepayments, settlements } = input;
  const adults = people.filter((p) => p.type === "adult");

  // adultId -> total owed across all cost groups.
  const owedByAdult = new Map<number, number>();
  for (const s of summaries) {
    for (const sh of s.shares) {
      owedByAdult.set(sh.person_id, (owedByAdult.get(sh.person_id) ?? 0) + sh.share_count * s.perShare);
    }
  }

  const statusByPerson = new Map<number, SettlementStatus>();
  for (const s of settlements) statusByPerson.set(s.person_id, s.status);

  const rows: PaysheetRow[] = adults.map((p) => {
    const paid = round2(
      expenses.filter((e) => e.payer_id === p.id).reduce((s, e) => s + e.amount, 0),
    );
    const owed = round2(owedByAdult.get(p.id) ?? 0);
    const prepay = round2(
      prepayments.filter((pp) => pp.person_id === p.id).reduce((s, pp) => s + pp.amount, 0),
    );
    const balance = round2(paid - owed);
    const outstanding = round2(balance - prepay);
    return {
      person_id: p.id,
      name: p.name,
      code: p.code,
      paid,
      owed,
      prepay,
      balance,
      outstanding,
      status: statusByPerson.get(p.id) ?? "none",
    };
  });

  const totalExpenses = round2(expenses.reduce((s, e) => s + e.amount, 0));
  const totalPrepaid = round2(prepayments.reduce((s, p) => s + p.amount, 0));
  return { rows, totalExpenses, totalPrepaid };
}
