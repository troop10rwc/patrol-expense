import { regenerateTravelExpenses } from "./db.ts";

// Roster + expenses transcribed from the "Expense Worksheet - 2026 Winter Lodge"
// Google Sheet. Adults pay receipts and hold shares; scouts roll up to a parent.

const ADULTS: [name: string, code: string][] = [
  ["David Beck", "4704"], ["Hilary Beck", "0573"], ["Mike Beebe", "8854"],
  ["Ivan Bravo", "8585"], ["Linda Brobeck", "7108"], ["Jessica Campbell", "0509"],
  ["Noah Campbell", "8041"], ["Sophie Dessalle", "1459"], ["Tammy Doukas", "3789"],
  ["Rita Etscheid", "3071"], ["Pamela Fosnes", "8131"], ["Stefan Goebel", "8796"],
  ["Michelle Graham", "2807"], ["Justin Greene", "9462"], ["George Hasseltine", "9044"],
  ["Kurt Hemmingsen", "7665"], ["Michael Hendricksen", "5149"], ["Houston Howell", "0646"],
  ["Christina Hsu", "4637"], ["Christopher Johnson", "2189"], ["Christopher Johnson", "2989"],
  ["Jeannie Karl", "7581"], ["Surya Kommareddy", "0861"], ["Stacie Lambert", "5116"],
  ["Ann Marie Lavigne", "7883"], ["Frederick Livingston", "1776"], ["Katherine Machemer", "3311"],
  ["Angelica Machicado", "0069"], ["Ray Mazza", "7697"], ["William McAlexander", "6969"],
  ["Kerry McGuire", "4292"], ["Thomas Mullins", "4259"], ["Darren Ng", "4317"],
  ["Meghan OReilly Green", "3548"], ["Marisol Palafox", "9170"], ["Jeff Patheal", "2810"],
  ["Jeffrey Patheal", "3328"], ["Melissa Pelaez", "4457"], ["Joanne Penko", "7439"],
  ["Seth Perlman", "1393"], ["Talia Perlman", "6880"], ["John Robinson", "8247"],
  ["David Ruiz Fernandez", "9543"], ["Priya Shah", "8632"], ["Manish Singhal", "2974"],
  ["Leslye Smith", "7008"], ["Lydia Snape", "3628"], ["Betsy Snow", "0774"],
  ["Betsy Snow", "0778"], ["Paul Snow", "2576"], ["Andrew Sparks", "2894"],
  ["Kirk Stewart", "8274"], ["Diane Sweet", "3143"], ["Eric Sweet", "7343"],
  ["Emma Taylor", "8632"], ["Laura Tebbe", "1111"], ["Lisa Tyndall", "3374"],
  ["Deepa Vulupala", "3995"], ["Sheila Vyas", "5332"], ["Neil Winterbottom", "4238"],
  ["Rhea Yauch", "9057"], ["katherine black", "1223"], ["assia dolgasheva", "5167"],
];

// [scout name, code, parent adult name]
const SCOUTS: [name: string, code: string, parent: string][] = [
  ["Amelia B.", "0576", "Hilary Beck"], ["Denali B.", "8106", "Hilary Beck"],
  ["Thomas B.", "8903", "Mike Beebe"], ["Darian B.", "9173", "Marisol Palafox"],
  ["Lincoln C.", "8040", "Noah Campbell"], ["Tori D.", "5168", "assia dolgasheva"],
  ["Anna E.", "3082", "Rita Etscheid"], ["Five G.", "6144", "katherine black"],
  ["Dash H.", "9060", "George Hasseltine"], ["Kinsey H.", "2170", "George Hasseltine"],
  ["Ava H.", "3700", "Michael Hendricksen"], ["Boyte H.", "0664", "Houston Howell"],
  ["Hudson H.", "4638", "Christina Hsu"], ["Kodiak J.", "2188", "Tammy Doukas"],
  ["Nidhi K.", "4025", "Deepa Vulupala"], ["Henry L.", "7920", "Ann Marie Lavigne"],
  ["Julia L.", "5409", "Frederick Livingston"], ["Zachary M.", "3317", "Katherine Machemer"],
  ["kiersten M.", "1034", "Katherine Machemer"], ["Zachary M.", "7710", "Ray Mazza"],
  ["Dylan N.", "5896", "Darren Ng"], ["Zack P.", "0070", "Angelica Machicado"],
  ["Reid P.", "3343", "Jeffrey Patheal"], ["Reid P.", "2812", "Jeff Patheal"],
  ["Natalie P.", "7184", "Lydia Snape"], ["Christine P.", "4458", "Melissa Pelaez"],
  ["Hannah P.", "2949", "Seth Perlman"], ["Isaac P.", "1395", "Seth Perlman"],
  ["Saoirse R.", "3549", "Meghan OReilly Green"], ["Iker R.", "9547", "David Ruiz Fernandez"],
  ["Armaan S.", "1139", "Priya Shah"], ["Tara S.", "3283", "Priya Shah"],
  ["Amritha S.", "0880", "Manish Singhal"], ["Lucy S.", "7009", "Leslye Smith"],
  ["Trevor S.", "4062", "Paul Snow"], ["Hanna S.", "5511", "Kerry McGuire"],
  ["Adrian S.", "3225", "Diane Sweet"], ["Dominic S.", "3146", "Diane Sweet"],
  ["Nathaniel T.", "7441", "Joanne Penko"], ["Juliet Y.", "8586", "Rhea Yauch"],
  ["abigail M.", "1823", "Katherine Machemer"], ["Eline V.", "6502", "Sophie Dessalle"],
  ["Hazel V.", "9467", "Justin Greene"], ["Claire S.", "guest", "Kerry McGuire"],
];

// Everyone who attended under Unit:Overall (the sheet's "Patrol Members" column):
// 14 youth + 3 adults = 17 members, which derive to the sheet's 17 shares.
const UNIT_MEMBERS: string[] = [
  // youth
  "Amelia B.", "Denali B.", "Hazel V.", "Hanna S.", "Kinsey H.", "abigail M.",
  "Hannah P.", "Dominic S.", "Adrian S.", "Eline V.", "Trevor S.", "Boyte H.",
  "Amritha S.", "Claire S.",
  // adults who attended
  "George Hasseltine", "Kerry McGuire", "Eric Sweet",
];

// Directly-entered receipts (travel reimbursements are generated separately).
const UNIT_EXPENSES: [desc: string, amount: number, payer: string][] = [
  ["Lodge Rental", 1131.59, "Sheila Vyas"],
  ["Food - Safeway", 250.26, "Eric Sweet"],
  ["Lodge Rental add'l", 253.05, "Sheila Vyas"],
];

const PREPAYMENTS: [adult: string, amount: number, note: string][] = [
  ["Sheila Vyas", 1131.59, "Pre-reimbursed lodge deposit"],
];

export async function seedWinterLodge(db: D1Database): Promise<{ tripId: number }> {
  // Wipe existing data (children first to respect FKs).
  for (const t of [
    "expenses", "travel_drivers", "group_members", "prepayments", "settlements",
    "cost_groups", "people", "trips",
  ]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }

  const TRIP_ID = 1;
  const RATE = 0.28;
  // Fixed UUID so the demo URL is stable across reseeds.
  const TRIP_UUID = "d3e6f4a1-7b2c-4f8e-9a0d-2026d10a3aa1";

  const stmts: D1PreparedStatement[] = [];
  stmts.push(
    db
      .prepare(
        "INSERT INTO trips (id, uuid, slug, name, trip_date, planning_doc_url, mileage_rate) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        TRIP_ID,
        TRIP_UUID,
        "2026-winter-lodge",
        "2026 Winter Lodge",
        "2026-02-26",
        "https://bsa-at-legionpost105.slack.com/docs/TN69FH34Y/F0A9JGLMVJR",
        RATE,
      ),
  );

  // People: assign explicit ids so we can wire FKs without round-trips.
  const personId = new Map<string, number>(); // keyed by name (referenced names are unique)
  let nextId = 1;
  for (const [name, code] of ADULTS) {
    const id = nextId++;
    personId.set(name, id);
    stmts.push(
      db
        .prepare("INSERT INTO people (id, trip_id, name, code, type) VALUES (?, ?, ?, ?, 'adult')")
        .bind(id, TRIP_ID, name, code),
    );
  }
  for (const [name, code, parent] of SCOUTS) {
    const id = nextId++;
    personId.set(name, id); // referenced youth names are unique
    stmts.push(
      db
        .prepare(
          "INSERT INTO people (id, trip_id, name, code, type, parent_id) VALUES (?, ?, ?, ?, 'scout', ?)",
        )
        .bind(id, TRIP_ID, name, code, personId.get(parent) ?? null),
    );
  }

  // Cost groups: unit first (travel groups reference it), then patrols, then travel.
  const groupId = new Map<string, number>();
  let g = 1;
  const UNIT = g++;
  groupId.set("Unit:Overall", UNIT);
  stmts.push(
    db
      .prepare("INSERT INTO cost_groups (id, trip_id, name, kind, sort_order) VALUES (?, ?, 'Unit:Overall', 'unit', 0)")
      .bind(UNIT, TRIP_ID),
  );
  for (let i = 1; i <= 6; i++) {
    const id = g++;
    groupId.set(`Patrol:Patrol${i}`, id);
    stmts.push(
      db
        .prepare("INSERT INTO cost_groups (id, trip_id, name, kind, sort_order) VALUES (?, ?, ?, 'patrol', ?)")
        .bind(id, TRIP_ID, `Patrol:Patrol${i}`, i),
    );
  }
  const TRAVEL_PRIMARY = g++;
  groupId.set("Travel:Primary", TRAVEL_PRIMARY);
  stmts.push(
    db
      .prepare(
        "INSERT INTO cost_groups (id, trip_id, name, kind, sort_order, origin, destination, one_way_miles, round_trip_miles, tolls, cost_group_id) VALUES (?, ?, 'Travel:Primary', 'travel', 10, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        TRAVEL_PRIMARY, TRIP_ID,
        "651 El Camino Real, Redwood City, CA",
        "19940 Donner Pass Rd, Norden, CA 95724",
        200, 401, 8.5, UNIT,
      ),
  );
  // Unit membership, direct expenses, travel drivers, prepayments.
  for (const member of UNIT_MEMBERS) {
    stmts.push(
      db
        .prepare("INSERT INTO group_members (group_id, person_id) VALUES (?, ?)")
        .bind(UNIT, personId.get(member)!),
    );
  }
  for (const [desc, amount, payer] of UNIT_EXPENSES) {
    stmts.push(
      db
        .prepare("INSERT INTO expenses (trip_id, group_id, description, amount, payer_id) VALUES (?, ?, ?, ?, ?)")
        .bind(TRIP_ID, UNIT, desc, amount, personId.get(payer)!),
    );
  }
  for (const driver of ["George Hasseltine", "Eric Sweet", "Kerry McGuire"]) {
    stmts.push(
      db
        .prepare("INSERT INTO travel_drivers (group_id, person_id) VALUES (?, ?)")
        .bind(TRAVEL_PRIMARY, personId.get(driver)!),
    );
  }
  for (const [adult, amount, note] of PREPAYMENTS) {
    stmts.push(
      db
        .prepare("INSERT INTO prepayments (trip_id, person_id, amount, note) VALUES (?, ?, ?, ?)")
        .bind(TRIP_ID, personId.get(adult)!, amount, note),
    );
  }

  await db.batch(stmts);

  // Materialize travel reimbursements as expenses charged to the Unit group.
  await regenerateTravelExpenses(db, TRAVEL_PRIMARY);

  return { tripId: TRIP_ID };
}
