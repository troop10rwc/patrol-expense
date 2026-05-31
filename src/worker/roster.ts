import type { RosterMember } from "../shared/types.ts";

// Reads the external, externally-managed roster-db (read-only). People are
// keyed by bsa_number. Youth carry a `relationships` JSON array of guardians;
// the FIRST guardian is treated as the billable adult (verified to match the
// source spreadsheet's attribution).

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
      `SELECT DISTINCT y.bsa_number, y.first_name, y.last_name, y.rank, y.patrol, y.units, y.relationships
       FROM youth_members y
       JOIN unit_youth_members u ON u.bsa_number = y.bsa_number
       WHERE u.unit_name IN (${ph})`,
    )
    .bind(...units)
    .all<{
      bsa_number: string; first_name: string; last_name: string;
      rank: string | null; patrol: string | null; units: string; relationships: string;
    }>();

  const adults: RosterMember[] = adultsRes.results.map((a) => ({
    bsa_number: a.bsa_number,
    first_name: a.first_name,
    last_name: a.last_name,
    name: `${a.first_name} ${a.last_name}`.trim(),
    type: "adult",
    email: a.email,
    units: parseJsonArray<string>(a.units),
  }));

  const youth: RosterMember[] = youthRes.results.map((y) => ({
    bsa_number: y.bsa_number,
    first_name: y.first_name,
    last_name: y.last_name,
    name: `${y.first_name} ${y.last_name}`.trim(),
    type: "scout",
    email: null,
    units: parseJsonArray<string>(y.units),
    patrol: y.patrol,
    rank: y.rank,
    guardian: firstGuardian(y.relationships),
  }));

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
    .prepare("SELECT bsa_number, first_name, last_name, rank, patrol, units, relationships FROM youth_members WHERE bsa_number = ?")
    .bind(bsa)
    .first<{
      bsa_number: string; first_name: string; last_name: string;
      rank: string | null; patrol: string | null; units: string; relationships: string;
    }>();
  if (y) {
    return {
      bsa_number: y.bsa_number,
      first_name: y.first_name,
      last_name: y.last_name,
      name: `${y.first_name} ${y.last_name}`.trim(),
      type: "scout",
      email: null,
      units: parseJsonArray<string>(y.units),
      patrol: y.patrol,
      rank: y.rank,
      guardian: firstGuardian(y.relationships),
    };
  }
  return null;
}
