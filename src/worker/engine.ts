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
  DerivedShare,
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

/**
 * FNV-1a plus murmur3's finalizer, used only to scatter penny tiebreaks. Not a
 * checksum; not security. The finalizer is not optional: raw FNV-1a leaves the
 * last byte barely mixed, so keys differing only in a trailing person id sort
 * into nearly the same order under every seed — which is the exact bias this is
 * here to remove.
 */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Split `total` across shareholders so the rounded cents add back up to `total`
 * exactly. Rounding each adult's `share_count * perShare` on its own drops or
 * invents pennies, and across a whole trip that's what makes "owed to people"
 * and "owed by people" disagree by a cent while nobody's individual number
 * looks wrong. Largest remainder instead: floor everyone to the cent, then hand
 * the leftover pennies to the biggest fractional remainders — whoever was
 * closest to rounding up anyway. Nobody takes more than one extra penny here.
 *
 * When every member carries one share the remainders all tie, and someone still
 * has to take the cent. Picking by lowest person id would hand it to whoever was
 * added to the trip first, which is the same person every trip if a leader
 * pastes the same sorted roster. So the last tiebreak is `seed` (the trip uuid
 * and group id) hashed with the person id: a different member each trip and each
 * group, but still a pure function of the bundle, so a recomputed or replayed
 * trip always allocates exactly the way its snapshot did.
 */
function allocate(total: number, counts: Map<number, number>, seed: string): DerivedShare[] {
  const entries = [...counts.entries()];
  const totalShares = entries.reduce((s, [, c]) => s + c, 0);
  if (totalShares === 0) {
    return entries.map(([person_id, share_count]) => ({ person_id, share_count, amount: 0 }));
  }
  const totalCents = Math.round(total * 100);
  // exact - floor is always in [0, 1), so `leftover` is a whole number of
  // pennies in [0, n) even when the group total is negative (a refund).
  const exact = entries.map(([, c]) => (totalCents * c) / totalShares);
  const cents = exact.map((c) => Math.floor(c));
  const leftover = totalCents - cents.reduce((a, b) => a + b, 0);
  const order = entries
    .map(([person_id, share_count], i) => ({
      i,
      person_id,
      share_count,
      rem: exact[i] - cents[i],
      tiebreak: hash32(`${seed}:${person_id}`),
    }))
    // person_id last so a hash collision still resolves to a stable order.
    .sort(
      (a, b) =>
        b.rem - a.rem ||
        b.share_count - a.share_count ||
        a.tiebreak - b.tiebreak ||
        a.person_id - b.person_id,
    );
  for (let k = 0; k < leftover; k++) cents[order[k].i] += 1;
  return entries.map(([person_id, share_count], i) => ({
    person_id,
    share_count,
    amount: cents[i] / 100,
  }));
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
    const shares = allocate(total, shareCounts, `${trip.uuid}:${group.id}`);
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
      owedByAdult.set(sh.person_id, (owedByAdult.get(sh.person_id) ?? 0) + sh.amount);
    }
  }

  const statusByPerson = new Map<number, SettlementStatus>();
  for (const s of settlements) statusByPerson.set(s.person_id, s.status);

  const rows: PaysheetRow[] = adults.map((p) => {
    const mine = expenses.filter((e) => e.payer_id === p.id);
    const paid = round2(mine.reduce((s, e) => s + e.amount, 0));
    const owed = round2(owedByAdult.get(p.id) ?? 0);
    const prepay = round2(
      prepayments.filter((pp) => pp.person_id === p.id).reduce((s, pp) => s + pp.amount, 0),
    );
    // Receipts already handed back to this payer. They stay in `paid` (the
    // trip's cost is unchanged and the receipt is still theirs) but no longer
    // count toward what the troop still owes, exactly like a prepayment.
    const reimbursed = round2(
      mine.filter((e) => e.reimbursed_at != null).reduce((s, e) => s + e.amount, 0),
    );
    const balance = round2(paid - owed);
    const outstanding = round2(balance - prepay - reimbursed);
    return {
      person_id: p.id,
      name: p.name,
      code: p.code,
      paid,
      owed,
      prepay,
      reimbursed,
      balance,
      outstanding,
      status: statusByPerson.get(p.id) ?? "none",
    };
  });

  const totalExpenses = round2(expenses.reduce((s, e) => s + e.amount, 0));
  const totalPrepaid = round2(prepayments.reduce((s, p) => s + p.amount, 0));
  const totalReimbursed = round2(
    expenses.filter((e) => e.reimbursed_at != null).reduce((s, e) => s + e.amount, 0),
  );
  return { rows, totalExpenses, totalPrepaid, totalReimbursed };
}
