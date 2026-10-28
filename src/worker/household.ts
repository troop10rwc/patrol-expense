import type {
  FamilyEvent,
  FamilyStatement,
  Household,
  HouseholdAdult,
  HouseholdSummary,
  HouseholdYouth,
  TripBundle,
} from "../shared/types.ts";
import { fetchYouthWithGuardians } from "./roster.ts";
import { eventFigures, loadAllBundles } from "./statement.ts";
import { unitStatement } from "./unit.ts";

// Households for family statements. Nothing here is stored except the payer
// designation (migrations/0011_household_payers.sql): membership is read live
// from roster-db relationships, so the roster stays the source of truth.
//
// A household is a connected group of youth and guardians: each youth is linked
// to every guardian the roster lists for them, so siblings who share a parent
// land together, and so do both parents of the same youth.
//
// A family statement only READS the trip paysheets. A youth's share is still
// billed to their first guardian exactly as before; the statement sums the
// paysheet rows of the household's guardians on each trip.

const round2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 0.005;

/** The roster units households are drawn from: every unit any trip reads. */
async function householdUnits(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT DISTINCT roster_units FROM trips").all<{ roster_units: string }>();
  const units = new Set<string>();
  for (const r of results) {
    try {
      const v = JSON.parse(r.roster_units);
      if (Array.isArray(v)) for (const u of v) if (typeof u === "string") units.add(u);
    } catch {
      // malformed column: contributes nothing
    }
  }
  return [...units];
}

/** Every household, sorted by name, with payer designations applied. */
export async function loadHouseholds(db: D1Database, roster: D1Database): Promise<Household[]> {
  const youth = await fetchYouthWithGuardians(roster, await householdUnits(db));

  // Union-find over "y:<bsa>" / "a:<bsa>" nodes.
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const add = (k: string) => { if (!parent.has(k)) parent.set(k, k); };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  const adultsByBsa = new Map<string, HouseholdAdult>();
  for (const y of youth) {
    add(`y:${y.bsa_number}`);
    for (const g of y.guardians) {
      add(`a:${g.bsa_number}`);
      union(`y:${y.bsa_number}`, `a:${g.bsa_number}`);
      if (!adultsByBsa.has(g.bsa_number)) adultsByBsa.set(g.bsa_number, g);
    }
  }

  const groups = new Map<string, { youth: typeof youth; adults: Set<string> }>();
  for (const y of youth) {
    const root = find(`y:${y.bsa_number}`);
    const g = groups.get(root) ?? { youth: [], adults: new Set<string>() };
    g.youth.push(y);
    for (const a of y.guardians) g.adults.add(a.bsa_number);
    groups.set(root, g);
  }

  const { results: designations } = await db
    .prepare("SELECT bsa_number, designated_at FROM household_payers")
    .all<{ bsa_number: string; designated_at: string }>();
  const designatedAt = new Map(designations.map((d) => [d.bsa_number, d.designated_at]));

  const households: Household[] = [];
  for (const g of groups.values()) {
    const hy: HouseholdYouth[] = g.youth
      .map((y) => ({ bsa_number: y.bsa_number, name: y.name, patrol: y.patrol, guardians: y.guardians.map((a) => a.bsa_number) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const adults = [...g.adults].map((b) => adultsByBsa.get(b)!).sort((a, b) => a.name.localeCompare(b.name));

    // Designated: the household guardian designated most recently. Default: the
    // guardian the most youth list first (whom the paysheet already bills),
    // ties broken by name.
    let payer: HouseholdAdult | null = null;
    let payerSource: Household["payerSource"] = "default";
    const designated = adults
      .filter((a) => designatedAt.has(a.bsa_number))
      .sort((a, b) => designatedAt.get(b.bsa_number)!.localeCompare(designatedAt.get(a.bsa_number)!));
    if (designated.length) {
      payer = designated[0];
      payerSource = "designated";
    } else {
      const firstCount = new Map<string, number>();
      for (const y of hy) if (y.guardians[0]) firstCount.set(y.guardians[0], (firstCount.get(y.guardians[0]) ?? 0) + 1);
      payer = [...adults].sort((a, b) =>
        (firstCount.get(b.bsa_number) ?? 0) - (firstCount.get(a.bsa_number) ?? 0) || a.name.localeCompare(b.name),
      )[0] ?? null;
    }

    const lastNames = [...new Set(g.youth.map((y) => y.last_name).filter(Boolean))].sort();
    households.push({
      id: hy.map((y) => y.bsa_number).sort()[0],
      name: `${lastNames.join(" / ") || hy[0].name} household`,
      adults,
      youth: hy,
      payer,
      payerSource,
    });
  }
  return households.sort((a, b) => a.name.localeCompare(b.name));
}

/** The household containing this youth bsa_number (a household's id, or any of its youth). */
export async function findHousehold(db: D1Database, roster: D1Database, id: string): Promise<Household | null> {
  const all = await loadHouseholds(db, roster);
  return all.find((h) => h.youth.some((y) => y.bsa_number === id)) ?? null;
}

/** People on a trip who belong to the household, split into guardians and youth. */
function onTrip(bundle: TripBundle, h: Household) {
  const adultBsas = new Set(h.adults.map((a) => a.bsa_number));
  const youthBsas = new Set(h.youth.map((y) => y.bsa_number));
  const adults = bundle.people.filter((p) => p.type === "adult" && p.bsa_number != null && adultBsas.has(p.bsa_number));
  const youth = bundle.people.filter((p) => p.type === "scout" && p.bsa_number != null && youthBsas.has(p.bsa_number));
  return { adults, youth };
}

/** Approved-unit-expense figures for every household adult with an email. */
async function householdUnitExpenses(db: D1Database, h: Household) {
  const items: FamilyStatement["unitExpenses"] = [];
  let outstanding = 0;
  for (const a of h.adults) {
    if (!a.email) continue;
    const u = await unitStatement(db, a.email);
    items.push(...u.items.map((i) => ({ ...i, payee: a.name })));
    outstanding += u.outstanding;
  }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { items, outstanding: round2(outstanding) };
}

/** The Family statements index: every household with its live net. */
export async function listHouseholdSummaries(db: D1Database, roster: D1Database): Promise<HouseholdSummary[]> {
  const [households, bundles] = await Promise.all([loadHouseholds(db, roster), loadAllBundles(db)]);
  const out: HouseholdSummary[] = [];
  for (const h of households) {
    let trips = 0;
    let outstanding = 0;
    for (const b of bundles) {
      const ids = new Set(onTrip(b, h).adults.map((p) => p.id));
      const rows = b.paysheet.rows.filter((r) => ids.has(r.person_id));
      if (!rows.some((r) => Math.abs(r.paid) > EPS || Math.abs(r.owed) > EPS || Math.abs(r.prepay) > EPS)) continue;
      trips++;
      outstanding += rows.reduce((s, r) => s + r.outstanding, 0);
    }
    outstanding += (await householdUnitExpenses(db, h)).outstanding;
    out.push({ household: h, trips, outstanding: round2(outstanding) });
  }
  return out;
}

/** One household's statement across every trip, with snapshot history. */
export async function buildFamilyStatement(db: D1Database, h: Household): Promise<FamilyStatement> {
  const bundles = await loadAllBundles(db);
  const events: FamilyEvent[] = [];
  for (const b of bundles) {
    const { adults, youth } = onTrip(b, h);
    if (adults.length === 0 && youth.length === 0) continue;
    const ev = await eventFigures(db, b, adults.map((p) => p.id));
    if (!ev && youth.length === 0) continue;

    const adultIds = new Set(adults.map((p) => p.id));
    const nameOf = new Map(b.people.map((p) => [p.id, p.name]));
    const members = b.paysheet.rows
      .filter((r) => adultIds.has(r.person_id))
      .map((r) => ({ person_id: r.person_id, name: r.name, paid: r.paid, owed: r.owed, outstanding: r.outstanding, status: r.status }));
    const youthRows = youth.map((y) => ({
      name: y.name,
      billedTo: y.parent_id != null ? nameOf.get(y.parent_id) ?? null : null,
      outsideHousehold: y.parent_id == null || !adultIds.has(y.parent_id),
    }));

    // A youth attended but no household guardian is on the trip's paysheet (their
    // share went to someone else): still worth showing, with zeroed figures.
    events.push({
      ...(ev ?? {
        trip: { uuid: b.trip.uuid, slug: b.trip.slug, name: b.trip.name, trip_date: b.trip.trip_date },
        paid: 0, owed: 0, prepay: 0, reimbursed: 0, outstanding: 0,
        status: "none" as const, projected: false, liveDelta: 0, history: [],
      }),
      members,
      youth: youthRows,
    });
  }

  const unit = await householdUnitExpenses(db, h);
  return {
    household: h,
    events,
    unitExpenses: unit.items,
    unitOutstanding: unit.outstanding,
    totalOutstanding: round2(events.reduce((s, e) => s + e.outstanding, 0) + unit.outstanding),
    projected: events.some((e) => e.projected),
  };
}

/**
 * Designate `bsa` as the household's payer (or, with null, go back to the
 * default). Clears the household's other designations in the same batch so
 * exactly one — or none — stands.
 */
export async function setHouseholdPayer(
  db: D1Database,
  h: Household,
  bsa: string | null,
  by: string | null,
): Promise<void> {
  const adults = h.adults.map((a) => a.bsa_number);
  if (adults.length === 0) return;
  const stmts = [
    db.prepare(`DELETE FROM household_payers WHERE bsa_number IN (${adults.map(() => "?").join(", ")})`).bind(...adults),
  ];
  if (bsa) {
    stmts.push(db.prepare("INSERT INTO household_payers (bsa_number, designated_by) VALUES (?, ?)").bind(bsa, by));
  }
  await db.batch(stmts);
}
