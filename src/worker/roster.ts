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
