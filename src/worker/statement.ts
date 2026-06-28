import type { Person, PersonStatement, StatementEvent, StatementHistoryPoint, TripBundle } from "../shared/types.ts";
import { loadTripBundle } from "./db.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 0.005;

/** Raw snapshot rows needed to reconstruct a person's per-event history. */
type SnapshotRow = { id: number; label: string | null; created_at: string; bundle: string };

/**
 * Build the signed-in member's consolidated statement across every event.
 *
 * The viewer is matched to a person within each trip by email — directly against
 * the projected `people.email`, or via the external roster (adult email ->
 * bsa_number -> people.bsa_number). Only that one person's figures are returned;
 * no other member's amounts are exposed.
 *
 * For local dev (DEV_AUTH_BYPASS) the bypass identity matches no real member, so
 * when `devMatchFallback` is set and nothing matched we pin to a single adult by
 * name across trips purely so the page renders against seed data.
 */
export async function buildStatement(
  db: D1Database,
  roster: D1Database,
  identity: { email: string | null; name: string },
  devMatchFallback = false,
): Promise<PersonStatement> {
  const email = identity.email?.trim().toLowerCase() || null;

  // Resolve any roster BSA numbers that share this email (adults only carry one).
  const bsaSet = new Set<string>();
  if (email) {
    try {
      const { results } = await roster
        .prepare("SELECT bsa_number FROM adult_members WHERE lower(email) = ?")
        .bind(email)
        .all<{ bsa_number: string }>();
      for (const r of results) bsaSet.add(r.bsa_number);
    } catch {
      // roster is best-effort here; fall back to email matching on people rows.
    }
  }

  // Load every trip's live bundle once (small N for a troop).
  const { results: tripRows } = await db
    .prepare("SELECT id FROM trips ORDER BY id DESC")
    .all<{ id: number }>();
  const bundles: TripBundle[] = [];
  for (const { id } of tripRows) {
    const b = await loadTripBundle(db, id);
    if (b) bundles.push(b);
  }

  // A person is "me" when they're an adult matched by email or roster bsa_number.
  let matches = (p: Person): boolean =>
    p.type === "adult" &&
    ((email != null && p.email != null && p.email.toLowerCase() === email) ||
      (p.bsa_number != null && bsaSet.has(p.bsa_number)));

  // Dev-only fallback so the page is testable behind DEV_AUTH_BYPASS.
  if (devMatchFallback && !bundles.some((b) => b.people.some(matches))) {
    const sample = bundles.flatMap((b) => b.people).find((p) => p.type === "adult");
    if (sample) {
      const name = sample.name;
      matches = (p: Person): boolean => p.type === "adult" && p.name === name;
    }
  }

  const events: StatementEvent[] = [];
  for (const bundle of bundles) {
    const me = bundle.people.find(matches);
    if (!me) continue;
    const row = bundle.paysheet.rows.find((r) => r.person_id === me.id);
    if (!row) continue;
    // Skip events where this adult has no financial activity at all.
    if (Math.abs(row.paid) < EPS && Math.abs(row.owed) < EPS && Math.abs(row.prepay) < EPS) continue;

    // Per-snapshot history: read this person's frozen outstanding from each
    // snapshot (person_id is stable within a trip), oldest -> newest.
    const { results: snaps } = await db
      .prepare("SELECT id, label, created_at, bundle FROM snapshots WHERE trip_id = ? ORDER BY id ASC")
      .bind(bundle.trip.id)
      .all<SnapshotRow>();

    const history: StatementHistoryPoint[] = [];
    let prev = 0;
    for (const s of snaps) {
      let outstanding = 0;
      try {
        const sb = JSON.parse(s.bundle) as TripBundle;
        const sr = sb.paysheet.rows.find((r) => r.person_id === me.id);
        outstanding = sr ? sr.outstanding : 0;
      } catch {
        outstanding = prev; // unreadable snapshot: treat as no change
      }
      history.push({
        snapshot_id: s.id,
        label: s.label,
        created_at: s.created_at,
        outstanding: round2(outstanding),
        delta: round2(outstanding - prev),
      });
      prev = outstanding;
    }

    const lastSnap = history.length ? history[history.length - 1].outstanding : null;
    const liveDelta = lastSnap === null ? round2(row.outstanding) : round2(row.outstanding - lastSnap);
    const projected = history.length === 0 ? true : Math.abs(liveDelta) > EPS;

    events.push({
      trip: {
        uuid: bundle.trip.uuid,
        slug: bundle.trip.slug,
        name: bundle.trip.name,
        trip_date: bundle.trip.trip_date,
      },
      person_id: me.id,
      paid: row.paid,
      owed: row.owed,
      prepay: row.prepay,
      outstanding: row.outstanding,
      status: row.status,
      projected,
      liveDelta,
      history,
    });
  }

  const totalOutstanding = round2(events.reduce((s, e) => s + e.outstanding, 0));
  return {
    person: { email: identity.email, name: identity.name, matched: events.length > 0 },
    events,
    totalOutstanding,
    projected: events.some((e) => e.projected),
  };
}
