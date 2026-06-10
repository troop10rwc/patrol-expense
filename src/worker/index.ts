import { Hono } from "hono";
import type { Trip, TripBundle, SnapshotMeta, ImportPreview } from "../shared/types.ts";
import { diffBundles } from "../shared/diff.ts";
import { slugify } from "../shared/slug.ts";
import { loadTripBundle, regenerateTravelExpenses, resolveRef, normalizeTrip, scaffoldDefaultGroups, ensureLocalPerson } from "./db.ts";
import { fetchRoster } from "./roster.ts";
import { parseCsv, extractSheetId, csvExportUrl, xlsxExportUrl } from "./csv.ts";
import { parseXlsxTabs } from "./xlsx.ts";
import { buildPreview } from "./import.ts";
import { autocomplete, drivingMiles } from "./geo.ts";
import { seedWinterLodge } from "./seed.ts";
import { requireAuth, type AuthBindings, type Identity } from "./auth.ts";
import { BASE_PATH } from "../shared/constants.ts";

interface Bindings extends AuthBindings {
  ASSETS: Fetcher;
  GOOGLE_MAPS_API_KEY?: string;
  ENVIRONMENT?: string; // "development" in dev (.dev.vars); "production" otherwise
}

type Env = { Bindings: Bindings; Variables: { user: Identity } };
type TripRow = Omit<Trip, "roster_units"> & { roster_units: string };

// API routes (mounted at /api, with the /manage/expenses prefix stripped by the
// default fetch handler below).
const app = new Hono<Env>();
const api = new Hono<Env>();

// Authentication is handled by Cloudflare Access in front of the Worker; this
// just reads the verified identity (and is a safety net behind Access).
api.use("*", requireAuth);

// Who am I? (identity from the Cloudflare Access JWT.)
api.get("/me", (c) => {
  const u = c.get("user");
  return c.json({ email: u.email, name: u.name });
});

const bad = (msg: string) => ({ error: msg });

// Roster units a freshly-imported trip resolves people against (matches the
// seed). The new trip stores these so its roster picker keeps working.
const DEFAULT_UNITS = ["Troop 10 F", "Crew 10"];

async function bundleResponse(db: D1Database, tripId: number) {
  const bundle = await loadTripBundle(db, tripId);
  if (!bundle) return null;
  return bundle;
}

type SnapshotRow = { id: number; trip_id: number; label: string | null; created_by: string | null; created_at: string; bundle: string };

// Derive the lightweight list row from a stored snapshot, reading the headline
// numbers out of the frozen bundle so the list shows the bottom line without
// shipping the whole JSON blob.
function snapshotMeta(row: Omit<SnapshotRow, "bundle">, bundle: TripBundle): SnapshotMeta {
  return {
    id: row.id,
    trip_id: row.trip_id,
    label: row.label,
    created_by: row.created_by,
    created_at: row.created_at,
    totalExpenses: bundle.paysheet.totalExpenses,
    outstanding: bundle.paysheet.rows.reduce((s, r) => s + Math.max(0, r.outstanding), 0),
  };
}

// ---- trips ----
api.get("/trips", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM trips ORDER BY id DESC").all<TripRow>();
  return c.json(results.map(normalizeTrip));
});

// Per-trip rollups for the index page (total cost + reimbursement progress).
api.get("/summary", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id FROM trips ORDER BY id DESC").all<{ id: number }>();
  const out = [];
  for (const { id } of results) {
    const bundle = await loadTripBundle(c.env.DB, id);
    if (!bundle) continue;
    const settle = bundle.paysheet.rows.filter((r) => Math.abs(r.outstanding) > 0.005);
    out.push({
      trip: bundle.trip,
      totalCost: bundle.paysheet.totalExpenses,
      expenseCount: bundle.expenses.length,
      settleTotal: settle.length,
      settleDone: settle.filter((r) => r.status === "paid").length,
    });
  }
  return c.json(out);
});

// Live roster (adults + youth) for the trip's configured units, read from
// the external roster-db. Feeds the picker and the Settings roster view.
api.get("/trips/:id/roster", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first<TripRow>();
  if (!row) return c.json(bad("trip not found"), 404);
  const trip = normalizeTrip(row);
  const members = await fetchRoster(c.env.ROSTER, trip.roster_units);
  return c.json(members);
});

api.post("/trips", async (c) => {
  const b = await c.req.json<Partial<Trip>>();
  if (!b.name) return c.json(bad("name is required"), 400);
  const uuid = b.uuid ?? crypto.randomUUID();
  const slug = (b.slug && b.slug.trim()) || slugify(b.name);
  const res = await c.env.DB.prepare(
    "INSERT INTO trips (uuid, slug, name, trip_date, planning_doc_url, slack_url, mileage_rate) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(uuid, slug, b.name, b.trip_date ?? null, b.planning_doc_url ?? null, b.slack_url ?? null, b.mileage_rate ?? 0.28)
    .run();
  await scaffoldDefaultGroups(c.env.DB, res.meta.last_row_id);
  return c.json(await bundleResponse(c.env.DB, res.meta.last_row_id), 201);
});

// Lookup by external UUID (the URL identifier).
api.get("/by-uuid/:uuid", async (c) => {
  const uuid = c.req.param("uuid");
  const row = await c.env.DB.prepare("SELECT id FROM trips WHERE uuid = ?").bind(uuid).first<{ id: number }>();
  if (!row) return c.json(bad("trip not found"), 404);
  return c.json(await bundleResponse(c.env.DB, row.id));
});

api.get("/trips/:id", async (c) => {
  const bundle = await bundleResponse(c.env.DB, Number(c.req.param("id")));
  return bundle ? c.json(bundle) : c.json(bad("trip not found"), 404);
});

// Read-merge-write patch so a missing field doesn't null a column. The URL
// (uuid) is never changed; slug is editable.
api.patch("/trips/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<Partial<Trip>>();
  const row = await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first<TripRow>();
  if (!row) return c.json(bad("trip not found"), 404);
  const current = normalizeTrip(row);
  const merged: Trip = {
    ...current,
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.slug !== undefined ? { slug: b.slug } : {}),
    ...(b.trip_date !== undefined ? { trip_date: b.trip_date } : {}),
    ...(b.planning_doc_url !== undefined ? { planning_doc_url: b.planning_doc_url } : {}),
    ...(b.slack_url !== undefined ? { slack_url: b.slack_url } : {}),
    ...(b.mileage_rate !== undefined ? { mileage_rate: b.mileage_rate } : {}),
    ...(Array.isArray(b.roster_units) ? { roster_units: b.roster_units } : {}),
  };
  if (!merged.slug?.trim()) return c.json(bad("slug cannot be empty"), 400);
  await c.env.DB.prepare(
    "UPDATE trips SET name=?, slug=?, trip_date=?, planning_doc_url=?, slack_url=?, mileage_rate=?, roster_units=? WHERE id=?",
  )
    .bind(
      merged.name, merged.slug, merged.trip_date, merged.planning_doc_url,
      merged.slack_url, merged.mileage_rate, JSON.stringify(merged.roster_units), id,
    )
    .run();
  if (merged.mileage_rate !== current.mileage_rate) {
    const travel = await c.env.DB.prepare(
      "SELECT id FROM cost_groups WHERE trip_id = ? AND kind = 'travel'",
    )
      .bind(id)
      .all<{ id: number }>();
    for (const t of travel.results) await regenerateTravelExpenses(c.env.DB, t.id);
  }
  return c.json(await bundleResponse(c.env.DB, id));
});

api.delete("/trips/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM trips WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---- people (local, unregistered additions only) ----
// Registered members come from roster-db and are projected automatically; this
// endpoint creates app-local people (e.g. a guest cub scout). A scout's parent
// may be given as parent_id (local) or parent_ref ("id:"/"bsa:", projected).
api.post("/trips/:id/people", async (c) => {
  const tripId = Number(c.req.param("id"));
  const b = await c.req.json<{ name: string; code?: string; email?: string; type: string; parent_id?: number; parent_ref?: string }>();
  if (!b.name || !b.type) return c.json(bad("name and type are required"), 400);
  const parentId = b.parent_ref
    ? await resolveRef(c.env.DB, c.env.ROSTER, tripId, b.parent_ref)
    : b.parent_id ?? null;
  await c.env.DB.prepare(
    "INSERT INTO people (trip_id, name, code, email, type, parent_id, source) VALUES (?, ?, ?, ?, ?, ?, 'local')",
  )
    .bind(tripId, b.name, b.code ?? null, b.email ?? null, b.type, parentId)
    .run();
  return c.json(await bundleResponse(c.env.DB, tripId), 201);
});

api.patch("/people/:pid", async (c) => {
  const pid = Number(c.req.param("pid"));
  const b = await c.req.json<{ name?: string; code?: string; email?: string; type?: string; parent_id?: number | null }>();
  const row = await c.env.DB.prepare("SELECT trip_id FROM people WHERE id = ?").bind(pid).first<{ trip_id: number }>();
  if (!row) return c.json(bad("person not found"), 404);
  await c.env.DB.prepare(
    "UPDATE people SET name = COALESCE(?, name), code = ?, email = ?, type = COALESCE(?, type), parent_id = ? WHERE id = ?",
  )
    .bind(b.name ?? null, b.code ?? null, b.email ?? null, b.type ?? null, b.parent_id ?? null, pid)
    .run();
  return c.json(await bundleResponse(c.env.DB, row.trip_id));
});

api.delete("/people/:pid", async (c) => {
  const pid = Number(c.req.param("pid"));
  const row = await c.env.DB.prepare("SELECT trip_id FROM people WHERE id = ?").bind(pid).first<{ trip_id: number }>();
  if (!row) return c.json(bad("person not found"), 404);
  await c.env.DB.prepare("DELETE FROM people WHERE id = ?").bind(pid).run();
  return c.json(await bundleResponse(c.env.DB, row.trip_id));
});

// ---- cost groups ----
api.post("/trips/:id/groups", async (c) => {
  const tripId = Number(c.req.param("id"));
  const b = await c.req.json<any>();
  if (!b.name || !b.kind) return c.json(bad("name and kind are required"), 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO cost_groups (trip_id, name, kind, sort_order, origin, destination, one_way_miles, round_trip_miles, tolls, rate_override, cost_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      tripId, b.name, b.kind, b.sort_order ?? 0,
      b.origin ?? null, b.destination ?? null, b.one_way_miles ?? null,
      b.round_trip_miles ?? null, b.tolls ?? 0, b.rate_override ?? null, b.cost_group_id ?? null,
    )
    .run();
  if (b.kind === "travel") await regenerateTravelExpenses(c.env.DB, res.meta.last_row_id);
  return c.json(await bundleResponse(c.env.DB, tripId), 201);
});

api.patch("/groups/:gid", async (c) => {
  const gid = Number(c.req.param("gid"));
  const b = await c.req.json<any>();
  const row = await c.env.DB.prepare("SELECT trip_id, kind FROM cost_groups WHERE id = ?").bind(gid).first<{ trip_id: number; kind: string }>();
  if (!row) return c.json(bad("group not found"), 404);
  await c.env.DB.prepare(
    `UPDATE cost_groups SET
       name = COALESCE(?, name),
       sort_order = COALESCE(?, sort_order),
       origin = ?, destination = ?, one_way_miles = ?, round_trip_miles = ?,
       tolls = COALESCE(?, tolls), rate_override = ?, cost_group_id = ?
     WHERE id = ?`,
  )
    .bind(
      b.name ?? null, b.sort_order ?? null, b.origin ?? null, b.destination ?? null,
      b.one_way_miles ?? null, b.round_trip_miles ?? null, b.tolls ?? null,
      b.rate_override ?? null, b.cost_group_id ?? null, gid,
    )
    .run();
  if (row.kind === "travel") await regenerateTravelExpenses(c.env.DB, gid);
  return c.json(await bundleResponse(c.env.DB, row.trip_id));
});

api.delete("/groups/:gid", async (c) => {
  const gid = Number(c.req.param("gid"));
  const row = await c.env.DB.prepare("SELECT trip_id FROM cost_groups WHERE id = ?").bind(gid).first<{ trip_id: number }>();
  if (!row) return c.json(bad("group not found"), 404);
  await c.env.DB.prepare("DELETE FROM cost_groups WHERE id = ?").bind(gid).run();
  return c.json(await bundleResponse(c.env.DB, row.trip_id));
});

// Resolve a body's person references to local ids. Accepts `refs` ("id:N" /
// "bsa:NNN") and/or legacy `person_ids`, projecting roster members as needed.
async function resolvePeople(
  c: { env: Bindings },
  tripId: number,
  body: { refs?: string[]; person_ids?: number[] },
): Promise<number[]> {
  const ids: number[] = [...(body.person_ids ?? [])];
  for (const ref of body.refs ?? []) {
    ids.push(await resolveRef(c.env.DB, c.env.ROSTER, tripId, ref));
  }
  return [...new Set(ids)];
}

// Replace a travel group's driver set.
api.put("/groups/:gid/drivers", async (c) => {
  const gid = Number(c.req.param("gid"));
  const b = await c.req.json<{ refs?: string[]; person_ids?: number[] }>();
  const row = await c.env.DB.prepare("SELECT trip_id FROM cost_groups WHERE id = ?").bind(gid).first<{ trip_id: number }>();
  if (!row) return c.json(bad("group not found"), 404);
  const ids = await resolvePeople(c, row.trip_id, b);
  await c.env.DB.prepare("DELETE FROM travel_drivers WHERE group_id = ?").bind(gid).run();
  if (ids.length) {
    await c.env.DB.batch(
      ids.map((pid) =>
        c.env.DB.prepare("INSERT INTO travel_drivers (group_id, person_id) VALUES (?, ?)").bind(gid, pid),
      ),
    );
  }
  await regenerateTravelExpenses(c.env.DB, gid);
  return c.json(await bundleResponse(c.env.DB, row.trip_id));
});

// Replace a cost group's membership (adults + youth who attended). Shares are
// derived from this.
api.put("/groups/:gid/members", async (c) => {
  const gid = Number(c.req.param("gid"));
  const b = await c.req.json<{ refs?: string[]; person_ids?: number[] }>();
  const row = await c.env.DB.prepare("SELECT trip_id FROM cost_groups WHERE id = ?").bind(gid).first<{ trip_id: number }>();
  if (!row) return c.json(bad("group not found"), 404);
  const ids = await resolvePeople(c, row.trip_id, b);
  await c.env.DB.prepare("DELETE FROM group_members WHERE group_id = ?").bind(gid).run();
  if (ids.length) {
    await c.env.DB.batch(
      ids.map((pid) =>
        c.env.DB
          .prepare("INSERT INTO group_members (group_id, person_id) VALUES (?, ?)")
          .bind(gid, pid),
      ),
    );
  }
  return c.json(await bundleResponse(c.env.DB, row.trip_id));
});

// ---- expenses ----
api.post("/trips/:id/expenses", async (c) => {
  const tripId = Number(c.req.param("id"));
  const b = await c.req.json<{ group_id: number; description: string; amount: number; payer_id?: number; payer_ref?: string }>();
  if (!b.group_id || b.amount == null || !b.description || (!b.payer_id && !b.payer_ref))
    return c.json(bad("group_id, payer (id or ref), amount, description are required"), 400);
  const payerId = b.payer_ref
    ? await resolveRef(c.env.DB, c.env.ROSTER, tripId, b.payer_ref)
    : b.payer_id!;
  await c.env.DB.prepare(
    "INSERT INTO expenses (trip_id, group_id, description, amount, payer_id) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(tripId, b.group_id, b.description, b.amount, payerId)
    .run();
  return c.json(await bundleResponse(c.env.DB, tripId), 201);
});

api.patch("/expenses/:eid", async (c) => {
  const eid = Number(c.req.param("eid"));
  const b = await c.req.json<{ group_id?: number; description?: string; amount?: number; payer_id?: number }>();
  const row = await c.env.DB.prepare("SELECT trip_id FROM expenses WHERE id = ?").bind(eid).first<{ trip_id: number }>();
  if (!row) return c.json(bad("expense not found"), 404);
  await c.env.DB.prepare(
    "UPDATE expenses SET group_id = COALESCE(?, group_id), description = COALESCE(?, description), amount = COALESCE(?, amount), payer_id = COALESCE(?, payer_id) WHERE id = ?",
  )
    .bind(b.group_id ?? null, b.description ?? null, b.amount ?? null, b.payer_id ?? null, eid)
    .run();
  return c.json(await bundleResponse(c.env.DB, row.trip_id));
});

api.delete("/expenses/:eid", async (c) => {
  const eid = Number(c.req.param("eid"));
  const row = await c.env.DB.prepare("SELECT trip_id FROM expenses WHERE id = ?").bind(eid).first<{ trip_id: number }>();
  if (!row) return c.json(bad("expense not found"), 404);
  await c.env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(eid).run();
  return c.json(await bundleResponse(c.env.DB, row.trip_id));
});

// ---- prepayments ----
api.post("/trips/:id/prepayments", async (c) => {
  const tripId = Number(c.req.param("id"));
  const b = await c.req.json<{ person_id: number; amount: number; note?: string }>();
  if (!b.person_id || b.amount == null) return c.json(bad("person_id and amount are required"), 400);
  await c.env.DB.prepare(
    "INSERT INTO prepayments (trip_id, person_id, amount, note) VALUES (?, ?, ?, ?)",
  )
    .bind(tripId, b.person_id, b.amount, b.note ?? null)
    .run();
  return c.json(await bundleResponse(c.env.DB, tripId), 201);
});

api.delete("/prepayments/:ppid", async (c) => {
  const ppid = Number(c.req.param("ppid"));
  const row = await c.env.DB.prepare("SELECT trip_id FROM prepayments WHERE id = ?").bind(ppid).first<{ trip_id: number }>();
  if (!row) return c.json(bad("prepayment not found"), 404);
  await c.env.DB.prepare("DELETE FROM prepayments WHERE id = ?").bind(ppid).run();
  return c.json(await bundleResponse(c.env.DB, row.trip_id));
});

// ---- settlement status ----
api.put("/trips/:id/settlements/:pid", async (c) => {
  const tripId = Number(c.req.param("id"));
  const pid = Number(c.req.param("pid"));
  const b = await c.req.json<{ status: string }>();
  await c.env.DB.prepare(
    `INSERT INTO settlements (trip_id, person_id, status, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(trip_id, person_id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`,
  )
    .bind(tripId, pid, b.status)
    .run();
  return c.json(await bundleResponse(c.env.DB, tripId));
});

// ---- snapshots (immutable point-in-time records of the full bundle) ----
api.post("/trips/:id/snapshots", async (c) => {
  const tripId = Number(c.req.param("id"));
  const b = await c.req.json<{ label?: string }>().catch(() => ({ label: undefined }));
  const bundle = await loadTripBundle(c.env.DB, tripId);
  if (!bundle) return c.json(bad("trip not found"), 404);
  const label = b.label?.trim() || null;
  const createdBy = c.get("user").email;
  const res = await c.env.DB.prepare(
    "INSERT INTO snapshots (trip_id, label, created_by, bundle) VALUES (?, ?, ?, ?)",
  )
    .bind(tripId, label, createdBy, JSON.stringify(bundle))
    .run();
  const row = await c.env.DB.prepare("SELECT id, trip_id, label, created_by, created_at FROM snapshots WHERE id = ?")
    .bind(res.meta.last_row_id)
    .first<Omit<SnapshotRow, "bundle">>();
  return c.json(snapshotMeta(row!, bundle), 201);
});

api.get("/trips/:id/snapshots", async (c) => {
  const tripId = Number(c.req.param("id"));
  const { results } = await c.env.DB.prepare(
    "SELECT id, trip_id, label, created_by, created_at, bundle FROM snapshots WHERE trip_id = ? ORDER BY id DESC",
  )
    .bind(tripId)
    .all<SnapshotRow>();
  return c.json(results.map((r) => snapshotMeta(r, JSON.parse(r.bundle) as TripBundle)));
});

api.get("/snapshots/:sid", async (c) => {
  const sid = Number(c.req.param("sid"));
  const row = await c.env.DB.prepare("SELECT * FROM snapshots WHERE id = ?").bind(sid).first<SnapshotRow>();
  if (!row) return c.json(bad("snapshot not found"), 404);
  const bundle = JSON.parse(row.bundle) as TripBundle;
  return c.json({ ...snapshotMeta(row, bundle), bundle });
});

api.delete("/snapshots/:sid", async (c) => {
  await c.env.DB.prepare("DELETE FROM snapshots WHERE id = ?").bind(Number(c.req.param("sid"))).run();
  return c.json({ ok: true });
});

// What changed since the most recent snapshot (null when none exists yet).
api.get("/trips/:id/changes", async (c) => {
  const tripId = Number(c.req.param("id"));
  const current = await loadTripBundle(c.env.DB, tripId);
  if (!current) return c.json(bad("trip not found"), 404);
  const row = await c.env.DB.prepare(
    "SELECT id, trip_id, label, created_by, created_at, bundle FROM snapshots WHERE trip_id = ? ORDER BY id DESC LIMIT 1",
  )
    .bind(tripId)
    .first<SnapshotRow>();
  if (!row) return c.json({ since: null, diff: null });
  const prev = JSON.parse(row.bundle) as TripBundle;
  return c.json({ since: snapshotMeta(row, prev), diff: diffBundles(prev, current) });
});

// ---- geo (Google Maps proxy; key stays server-side) ----
api.get("/geo/autocomplete", async (c) => {
  const key = c.env.GOOGLE_MAPS_API_KEY;
  if (!key) return c.json(bad("maps not configured"), 503);
  const q = c.req.query("q") ?? "";
  try {
    return c.json(await autocomplete(key, q));
  } catch (e) {
    return c.json(bad(String(e)), 502);
  }
});

api.get("/geo/distance", async (c) => {
  const key = c.env.GOOGLE_MAPS_API_KEY;
  if (!key) return c.json(bad("maps not configured"), 503);
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!to) return c.json(bad("'to' is required"), 400);
  try {
    const oneWay = await drivingMiles(key, from, to);
    return c.json({ one_way_miles: oneWay, round_trip_miles: Math.round(oneWay * 2 * 10) / 10 });
  } catch (e) {
    return c.json(bad(String(e)), 502);
  }
});

// ---- import a Google Sheet expense report ----
// Step 1: fetch + parse the whole workbook and return a preview with inline
// flags. No writes. The sheet must be shared "Anyone with the link" (we use the
// public xlsx + csv exports). The per-area tabs hold the real receipts/members/
// travel; the Summary CSV (formatted) drives the missed-formula cross-check.
api.post("/import/preview", async (c) => {
  const b = await c.req.json<{ sheetUrl?: string }>().catch(() => ({ sheetUrl: undefined }));
  if (!b.sheetUrl) return c.json(bad("sheetUrl is required"), 400);
  const id = extractSheetId(b.sheetUrl);
  if (!id) return c.json(bad("couldn't find a Google Sheet id in that URL"), 400);

  let tabs: { name: string; rows: string[][] }[];
  let summaryCsv: string[][] | null = null;
  try {
    const res = await fetch(xlsxExportUrl(id), { redirect: "follow" });
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || ct.includes("text/html")) {
      return c.json(bad("sheet isn't publicly accessible — set sharing to 'Anyone with the link'"), 502);
    }
    tabs = await parseXlsxTabs(await res.arrayBuffer());
  } catch (e) {
    return c.json(bad(`failed to read the sheet: ${String(e)}`), 502);
  }
  // Formatted first-tab CSV reveals broken-display cells (e.g. "2408%").
  try {
    const csvRes = await fetch(csvExportUrl(id), { redirect: "follow" });
    if (csvRes.ok && !(csvRes.headers.get("content-type") ?? "").includes("text/html")) {
      summaryCsv = parseCsv(await csvRes.text());
    }
  } catch { /* cross-check is best-effort */ }

  const roster = await fetchRoster(c.env.ROSTER, DEFAULT_UNITS);
  try {
    return c.json(buildPreview(tabs, summaryCsv, roster, b.sheetUrl, id, DEFAULT_UNITS));
  } catch (e) {
    return c.json(bad(`couldn't parse the sheet: ${String(e)}`), 400);
  }
});

// Step 2: commit the (leader-edited) preview to a brand-new trip, then take an
// "Import baseline" snapshot. Trusts the edited preview but re-checks blocking
// flags server-side.
api.post("/import/commit", async (c) => {
  const b = await c.req.json<{ preview?: ImportPreview }>().catch(() => ({ preview: undefined }));
  const preview = b.preview;
  if (!preview) return c.json(bad("preview is required"), 400);

  const noPayer = preview.expenseGroups.flatMap((g) =>
    g.receipts.filter((r) => r.amount > 0 && !r.payerRef).map((r) => `${g.name}: ${r.description}`));
  if (noPayer.length) {
    return c.json({ error: "choose a payer for every receipt before importing", receipts: noPayer }, 409);
  }

  const uuid = crypto.randomUUID();
  const name = preview.trip.name?.trim() || "Imported trip";
  const slug = slugify(name);
  const tripRes = await c.env.DB.prepare(
    "INSERT INTO trips (uuid, slug, name, trip_date, planning_doc_url, mileage_rate, roster_units) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(uuid, slug, name, preview.trip.trip_date ?? null, preview.trip.planning_doc_url ?? null, preview.trip.mileage_rate ?? 0.28, JSON.stringify(preview.trip.rosterUnits ?? DEFAULT_UNITS))
    .run();
  const tripId = tripRes.meta.last_row_id;

  try {
    // People first: roster members are projected (with guardians); guests local.
    const personId = new Map<string, number>();
    for (const p of preview.people) {
      if (p.resolution.kind === "roster") {
        personId.set(p.ref, await ensureLocalPerson(c.env.DB, c.env.ROSTER, tripId, p.resolution.bsa_number));
      } else {
        const r = await c.env.DB.prepare(
          "INSERT INTO people (trip_id, name, code, type, source) VALUES (?, ?, ?, ?, 'local')",
        ).bind(tripId, p.displayName || p.rawName, p.code ?? "guest", p.type).run();
        personId.set(p.ref, r.meta.last_row_id);
      }
    }

    // Expense groups (unit first so travel can reference it), then their
    // members and real receipts.
    const groupId = new Map<string, number>();
    const ordered = [...preview.expenseGroups].sort((a, b) => Number(b.kind === "unit") - Number(a.kind === "unit"));
    let sort = 0;
    for (const g of ordered) {
      const r = await c.env.DB.prepare(
        "INSERT INTO cost_groups (trip_id, name, kind, sort_order) VALUES (?, ?, ?, ?)",
      ).bind(tripId, g.name, g.kind, sort++).run();
      const gid = r.meta.last_row_id;
      groupId.set(g.name, gid);
      const memberIds = [...new Set(g.memberRefs.map((ref) => personId.get(ref)).filter((x): x is number => x != null))];
      if (memberIds.length) {
        await c.env.DB.batch(memberIds.map((pid) =>
          c.env.DB.prepare("INSERT INTO group_members (group_id, person_id) VALUES (?, ?)").bind(gid, pid)));
      }
      for (const rc of g.receipts) {
        if (rc.amount <= 0) continue;
        const payer = personId.get(rc.payerRef!);
        if (payer == null) throw new Error(`payer for ${g.name}/${rc.description} not resolved`);
        await c.env.DB.prepare(
          "INSERT INTO expenses (trip_id, group_id, description, amount, payer_id) VALUES (?, ?, ?, ?, ?)",
        ).bind(tripId, gid, rc.description, rc.amount, payer).run();
      }
    }

    // Travel groups: route + rate (charged to the unit group), drivers, then
    // materialize the per-driver reimbursements via the engine.
    let travelSort = 100;
    for (const t of preview.travelGroups) {
      const chargeTo = t.chargesTo ? groupId.get(t.chargesTo) ?? null : null;
      const r = await c.env.DB.prepare(
        "INSERT INTO cost_groups (trip_id, name, kind, sort_order, origin, destination, one_way_miles, round_trip_miles, tolls, rate_override, cost_group_id) VALUES (?, ?, 'travel', ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(tripId, t.name, travelSort++, t.origin, t.destination, t.oneWayMiles, t.roundTripMiles, t.tolls, t.rateOverride, chargeTo).run();
      const gid = r.meta.last_row_id;
      const driverIds = [...new Set(t.driverRefs.map((ref) => personId.get(ref)).filter((x): x is number => x != null))];
      if (driverIds.length) {
        await c.env.DB.batch(driverIds.map((pid) =>
          c.env.DB.prepare("INSERT INTO travel_drivers (group_id, person_id) VALUES (?, ?)").bind(gid, pid)));
      }
      await regenerateTravelExpenses(c.env.DB, gid);
    }

    // Prepayments.
    for (const pp of preview.prepayments) {
      const pid = personId.get(pp.personRef);
      if (pid == null || pp.amount <= 0) continue;
      await c.env.DB.prepare(
        "INSERT INTO prepayments (trip_id, person_id, amount, note) VALUES (?, ?, ?, ?)",
      ).bind(tripId, pid, pp.amount, pp.note || "Pre-Reimbursed (imported)").run();
    }

    // Baseline snapshot: future edits diff against the as-imported state.
    const bundle = await loadTripBundle(c.env.DB, tripId);
    if (!bundle) throw new Error("failed to load the imported trip");
    const snap = await c.env.DB.prepare(
      "INSERT INTO snapshots (trip_id, label, created_by, bundle) VALUES (?, ?, ?, ?)",
    ).bind(tripId, "Import baseline", c.get("user").email, JSON.stringify(bundle)).run();

    return c.json({ tripId, snapshotId: snap.meta.last_row_id, bundle }, 201);
  } catch (e) {
    // Roll back the half-built trip (children cascade) before reporting.
    await c.env.DB.prepare("DELETE FROM trips WHERE id = ?").bind(tripId).run();
    return c.json(bad(`import failed: ${String(e)}`), 500);
  }
});

// ---- seed (dev/demo convenience) ----
api.post("/seed", async (c) => {
  const { tripId } = await seedWinterLodge(c.env.DB, c.env.ROSTER);
  return c.json(await bundleResponse(c.env.DB, tripId), 201);
});

api.notFound((c) => c.json(bad("not found"), 404));

app.route("/api", api);

// The app is mounted under /manage/expenses. This handler owns the whole
// subpath: strip the prefix, then route /api to Hono and everything else to the
// static assets (SPA). Assets are built with Vite base "/manage/expenses/" but
// stored at their root paths, so the prefix must be stripped before serving.
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(BASE_PATH)) {
      return new Response("Not found", { status: 404 });
    }
    const rel = url.pathname.slice(BASE_PATH.length) || "/";

    if (rel === "/api" || rel.startsWith("/api/")) {
      const inner = new URL(url);
      inner.pathname = rel;
      return app.fetch(new Request(inner.toString(), request), env, ctx);
    }

    // Assets/SPA. In dev the Vite dev server expects the "/manage/expenses"-
    // prefixed path; in prod the built files live at root, so it's stripped.
    if (env.ENVIRONMENT === "development") {
      return env.ASSETS.fetch(request);
    }
    const assetUrl = new URL(url);
    assetUrl.pathname = rel;
    return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  },
};
