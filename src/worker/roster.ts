import type { RosterMember } from "../shared/types.ts";

// Reads the external, externally-managed roster-db (read-only). People are
// keyed by bsa_number. Youth carry a `relationships` JSON array of guardians;
// the FIRST guardian is treated as the billable adult (verified to match the
// source spreadsheet's attribution).
//
// Exception — adult-age youth: a youth who is 18+ and has NO registered
// guardian (e.g. an adult-age Crew member) has no one to roll their share up
// to, so we classify them as an `adult` here. That makes them a self-paying
// payer everywhere downstream (paysheet rows, share attribution, statements)
// instead of being silently dropped for lack of a responsible adult. A youth
// under 18, or one who still has a guardian on file, is unaffected.

interface RelationshipJson {
  bsaNumber?: string;
  firstName?: string;
  lastName?: string;
  relationshipType?: string;
  isGuardian?: boolean;
  email?: string;
}

function parseJsonArray<T = unknown>(s: string | null | undefined): T[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function firstGuardian(relationshipsJson: string | null): RosterMember["guardian"] {
  const rels = parseJsonArray<RelationshipJson>(relationshipsJson);
  const g = rels.find((r) => r.isGuardian) ?? rels[0];
  if (!g?.bsaNumber) return null;
  return {
    bsa_number: g.bsaNumber,
    name: `${g.firstName ?? ""} ${g.lastName ?? ""}`.trim(),
  };
}

/** Every guardian on a youth's relationships, in roster order but with the
 *  billable adult ({@link firstGuardian}) always first. Entries without a
 *  bsaNumber can't be matched to anyone and are dropped. */
function guardiansOf(relationshipsJson: string | null): RelationshipJson[] {
  const rels = parseJsonArray<RelationshipJson>(relationshipsJson);
  const first = rels.find((r) => r.isGuardian) ?? rels[0];
  const out = first?.bsaNumber ? [first] : [];
  for (const r of rels) {
    if (r.isGuardian && r.bsaNumber && !out.some((o) => o.bsaNumber === r.bsaNumber)) out.push(r);
  }
  return out;
}

/** True when `dob` (an ISO `YYYY-MM-DD`) is on/before the 18th-birthday cutoff
 *  relative to `asOf` — i.e. the person is at least 18. Bad/missing dates are
 *  treated as not-adult (the safe default: keep normal youth handling). */
function isAdultAge(dob: string | null | undefined, asOf: Date): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob ?? "");
  if (!m) return false;
  const eighteenth = Date.UTC(Number(m[1]) + 18, Number(m[2]) - 1, Number(m[3]));
  return eighteenth <= asOf.getTime();
}

interface YouthRow {
  bsa_number: string;
  first_name: string;
  last_name: string;
  rank: string | null;
  patrol: string | null;
  units: string;
  relationships: string;
  date_of_birth: string | null;
}

/** Build a RosterMember from a youth_members row, applying the adult-age
 *  exception: an 18+ youth with no registered guardian becomes an `adult`. */
function memberFromYouthRow(y: YouthRow, asOf: Date): RosterMember {
  const guardian = firstGuardian(y.relationships);
  const base = {
    bsa_number: y.bsa_number,
    first_name: y.first_name,
    last_name: y.last_name,
    name: `${y.first_name} ${y.last_name}`.trim(),
    units: parseJsonArray<string>(y.units),
  };
  if (guardian == null && isAdultAge(y.date_of_birth, asOf)) {
    return { ...base, type: "adult", email: null };
  }
  return { ...base, type: "scout", email: null, patrol: y.patrol, rank: y.rank, guardian };
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** Every unit name roster-db knows about (from either membership table), sorted. */
export async function fetchUnitNames(roster: D1Database): Promise<string[]> {
  const res = await roster
    .prepare(
      `SELECT unit_name FROM unit_adult_members
       UNION SELECT unit_name FROM unit_youth_members
       ORDER BY unit_name`,
    )
    .all<{ unit_name: string }>();
  return res.results.map((r) => r.unit_name).filter(Boolean);
}

/** All adults + youth belonging to any of the given units, de-duplicated. */
export async function fetchRoster(roster: D1Database, units: string[]): Promise<RosterMember[]> {
  if (units.length === 0) return [];
  const ph = placeholders(units.length);

  const adultsRes = await roster
    .prepare(
      `SELECT DISTINCT a.bsa_number, a.first_name, a.last_name, a.email, a.units
       FROM adult_members a
       JOIN unit_adult_members u ON u.bsa_number = a.bsa_number
       WHERE u.unit_name IN (${ph})`,
    )
    .bind(...units)
    .all<{ bsa_number: string; first_name: string; last_name: string; email: string | null; units: string }>();

  const youthRes = await roster
    .prepare(
      `SELECT DISTINCT y.bsa_number, y.first_name, y.last_name, y.rank, y.patrol, y.units, y.relationships, y.date_of_birth
       FROM youth_members y
       JOIN unit_youth_members u ON u.bsa_number = y.bsa_number
       WHERE u.unit_name IN (${ph})`,
    )
    .bind(...units)
    .all<YouthRow>();

  const adults: RosterMember[] = adultsRes.results.map((a) => ({
    bsa_number: a.bsa_number,
    first_name: a.first_name,
    last_name: a.last_name,
    name: `${a.first_name} ${a.last_name}`.trim(),
    type: "adult",
    email: a.email,
    units: parseJsonArray<string>(a.units),
  }));

  const now = new Date();
  const youth: RosterMember[] = youthRes.results.map((y) => memberFromYouthRow(y, now));

  return [...adults, ...youth].sort((a, b) => a.name.localeCompare(b.name));
}

/** A single member by bsa_number (adult or youth), or null if absent. */
export async function fetchRosterMember(roster: D1Database, bsa: string): Promise<RosterMember | null> {
  const a = await roster
    .prepare("SELECT bsa_number, first_name, last_name, email, units FROM adult_members WHERE bsa_number = ?")
    .bind(bsa)
    .first<{ bsa_number: string; first_name: string; last_name: string; email: string | null; units: string }>();
  if (a) {
    return {
      bsa_number: a.bsa_number,
      first_name: a.first_name,
      last_name: a.last_name,
      name: `${a.first_name} ${a.last_name}`.trim(),
      type: "adult",
      email: a.email,
      units: parseJsonArray<string>(a.units),
    };
  }
  const y = await roster
    .prepare("SELECT bsa_number, first_name, last_name, rank, patrol, units, relationships, date_of_birth FROM youth_members WHERE bsa_number = ?")
    .bind(bsa)
    .first<YouthRow>();
  if (y) {
    return memberFromYouthRow(y, new Date());
  }
  return null;
}

/** A youth with every guardian the roster lists for them (billable adult first). */
export interface YouthWithGuardians {
  bsa_number: string;
  name: string;
  last_name: string;
  patrol: string | null;
  guardians: { bsa_number: string; name: string; email: string | null; registered: boolean }[];
}

/**
 * Youth in the given units with their guardians, for grouping into households.
 * Guardian names/emails come from adult_members when the guardian is a
 * registered adult (any unit), else from the relationship entry itself.
 * Adult-age youth with no guardian are left out — {@link memberFromYouthRow}
 * already treats them as self-paying adults, not as anyone's child.
 */
export async function fetchYouthWithGuardians(roster: D1Database, units: string[]): Promise<YouthWithGuardians[]> {
  if (units.length === 0) return [];
  const youthRes = await roster
    .prepare(
      `SELECT DISTINCT y.bsa_number, y.first_name, y.last_name, y.rank, y.patrol, y.units, y.relationships, y.date_of_birth
       FROM youth_members y
       JOIN unit_youth_members u ON u.bsa_number = y.bsa_number
       WHERE u.unit_name IN (${placeholders(units.length)})`,
    )
    .bind(...units)
    .all<YouthRow>();

  const now = new Date();
  const youth = youthRes.results
    .filter((y) => memberFromYouthRow(y, now).type === "scout")
    .map((y) => ({ row: y, guardians: guardiansOf(y.relationships) }));

  // Registered-adult details for every guardian, in chunks under D1's bind limit.
  const bsas = [...new Set(youth.flatMap((y) => y.guardians.map((g) => g.bsaNumber!)))];
  const adults = new Map<string, { name: string; email: string | null }>();
  for (let i = 0; i < bsas.length; i += 90) {
    const chunk = bsas.slice(i, i + 90);
    const res = await roster
      .prepare(`SELECT bsa_number, first_name, last_name, email FROM adult_members WHERE bsa_number IN (${placeholders(chunk.length)})`)
      .bind(...chunk)
      .all<{ bsa_number: string; first_name: string; last_name: string; email: string | null }>();
    for (const a of res.results) {
      adults.set(a.bsa_number, { name: `${a.first_name} ${a.last_name}`.trim(), email: a.email });
    }
  }

  return youth.map(({ row: y, guardians }) => ({
    bsa_number: y.bsa_number,
    name: `${y.first_name} ${y.last_name}`.trim(),
    last_name: y.last_name,
    patrol: y.patrol,
    guardians: guardians.map((g) => {
      const a = adults.get(g.bsaNumber!);
      return {
        bsa_number: g.bsaNumber!,
        name: a?.name || `${g.firstName ?? ""} ${g.lastName ?? ""}`.trim(),
        email: a?.email ?? g.email ?? null,
        registered: a != null,
      };
    }),
  }));
}
