import { ensureLocalPerson, regenerateTravelExpenses } from "./db.ts";

// Seeds the 2026 Winter Lodge demo. The roster now lives in the external
// roster-db: registered people are projected in by bsa_number (their billable
// guardian is pulled automatically for youth). Only genuinely unregistered
// attendees (e.g. "Claire S. (guest)") are created as local people.
//
// All bsa_numbers below were verified against roster-db (unit "Troop 10 F").

// Registered adults referenced directly (payers / drivers).
const ADULTS = {
  sheila: "141755332", // Sheila Vyas
  eric: "131237343", // Eric Sweet
  george: "13909044", // George Hasseltine
  kerry: "140394292", // Kerry McGuire
};

// Registered youth who attended under Unit:Overall. Each projects its first
// guardian as the billable adult (matches the source sheet exactly).
const UNIT_YOUTH_BSA = [
  "14140576", // Amelia Beck      -> Hilary Beck
  "140838106", // Denali Beck      -> Hilary Beck
  "141549467", // Hazel Vyas-Greene-> Justin Greene
  "140445511", // Hanna Stewart    -> Kerry McGuire
  "140402170", // Kinsey Hasseltine-> George Hasseltine
  "140841823", // abigail machemer -> Katherine Machemer
  "140312949", // Hannah Perlman   -> Seth Perlman
  "141193146", // Dominic Sweet    -> Diane Sweet
  "141193225", // Adrian Sweet     -> Diane Sweet
  "141176502", // Eline van de Wyer-> Sophie Dessalle
  "12834062", // Trevor Snow      -> Paul Snow
  "13900664", // Boyte Howell     -> Houston Howell
  "14370880", // Amritha Singhal  -> Manish Singhal
];

// Registered adults who attended in their own right.
const UNIT_ADULT_BSA = [ADULTS.george, ADULTS.kerry, ADULTS.eric];

export async function seedWinterLodge(
  db: D1Database,
  roster: D1Database,
): Promise<{ tripId: number }> {
  // Wipe existing data (children first to respect FKs).
  for (const t of [
    "expenses", "travel_drivers", "group_members", "prepayments", "settlements",
    "cost_groups", "people", "trips",
  ]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }

  const TRIP_ID = 1;
  const RATE = 0.28;
  const TRIP_UUID = "d3e6f4a1-7b2c-4f8e-9a0d-2026d10a3aa1";

  await db
    .prepare(
      "INSERT INTO trips (id, uuid, slug, name, trip_date, planning_doc_url, mileage_rate, roster_units) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      TRIP_ID, TRIP_UUID, "2026-winter-lodge", "2026 Winter Lodge",
      "2026-02-26", "https://bsa-at-legionpost105.slack.com/docs/TN69FH34Y/F0A9JGLMVJR",
      RATE, JSON.stringify(["Troop 10 F", "Crew 10"]),
    )
    .run();

  // Cost groups: unit first (travel references it), then patrols, then travel.
  const groupId = new Map<string, number>();
  let g = 1;
  const UNIT = g++;
  await db
    .prepare("INSERT INTO cost_groups (id, trip_id, name, kind, sort_order) VALUES (?, ?, 'Unit:Overall', 'unit', 0)")
    .bind(UNIT, TRIP_ID)
    .run();
  groupId.set("Unit:Overall", UNIT);
  for (let i = 1; i <= 6; i++) {
    const id = g++;
    await db
      .prepare("INSERT INTO cost_groups (id, trip_id, name, kind, sort_order) VALUES (?, ?, ?, 'patrol', ?)")
      .bind(id, TRIP_ID, `Patrol:Patrol${i}`, i)
      .run();
    groupId.set(`Patrol:Patrol${i}`, id);
  }
  const TRAVEL_PRIMARY = g++;
  await db
    .prepare(
      "INSERT INTO cost_groups (id, trip_id, name, kind, sort_order, origin, destination, one_way_miles, round_trip_miles, tolls, cost_group_id) VALUES (?, ?, 'Travel:Primary', 'travel', 10, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      TRAVEL_PRIMARY, TRIP_ID,
      "651 El Camino Real, Redwood City, CA",
      "19940 Donner Pass Rd, Norden, CA 95724",
      200, 401, 8.5, UNIT,
    )
    .run();
  groupId.set("Travel:Primary", TRAVEL_PRIMARY);

  // Project the registered people we need (idempotent; youth pull guardians).
  const p = async (bsa: string) => ensureLocalPerson(db, roster, TRIP_ID, bsa);
  const sheila = await p(ADULTS.sheila);
  const eric = await p(ADULTS.eric);
  const george = await p(ADULTS.george);
  const kerry = await p(ADULTS.kerry);

  // Unregistered guest: Claire S., attending under Kerry McGuire (local only).
  await db
    .prepare(
      "INSERT INTO people (trip_id, name, code, type, parent_id, source) VALUES (?, 'Claire S.', 'guest', 'scout', ?, 'local')",
    )
    .bind(TRIP_ID, kerry)
    .run();
  const claire = (await db
    .prepare("SELECT id FROM people WHERE trip_id = ? AND name = 'Claire S.' AND source = 'local'")
    .bind(TRIP_ID)
    .first<{ id: number }>())!.id;

  // Unit:Overall membership = registered youth + Claire + 3 attending adults.
  const memberIds: number[] = [];
  for (const bsa of UNIT_YOUTH_BSA) memberIds.push(await p(bsa));
  memberIds.push(claire);
  for (const bsa of UNIT_ADULT_BSA) memberIds.push(await p(bsa));
  await db.batch(
    [...new Set(memberIds)].map((pid) =>
      db.prepare("INSERT INTO group_members (group_id, person_id) VALUES (?, ?)").bind(UNIT, pid),
    ),
  );

  // Direct receipts.
  const expenses: [desc: string, amount: number, payer: number][] = [
    ["Lodge Rental", 1131.59, sheila],
    ["Food - Safeway", 250.26, eric],
    ["Lodge Rental add'l", 253.05, sheila],
  ];
  await db.batch(
    expenses.map(([desc, amount, payer]) =>
      db
        .prepare("INSERT INTO expenses (trip_id, group_id, description, amount, payer_id) VALUES (?, ?, ?, ?, ?)")
        .bind(TRIP_ID, UNIT, desc, amount, payer),
    ),
  );

  // Travel drivers + prepayment.
  await db.batch(
    [george, eric, kerry].map((pid) =>
      db.prepare("INSERT INTO travel_drivers (group_id, person_id) VALUES (?, ?)").bind(TRAVEL_PRIMARY, pid),
    ),
  );
  await db
    .prepare("INSERT INTO prepayments (trip_id, person_id, amount, note) VALUES (?, ?, ?, ?)")
    .bind(TRIP_ID, sheila, 1131.59, "Pre-reimbursed lodge deposit")
    .run();

  // Materialize travel reimbursements as expenses charged to the Unit group.
  await regenerateTravelExpenses(db, TRAVEL_PRIMARY);

  return { tripId: TRIP_ID };
}
