import { Hono } from "hono";
import type { Trip } from "../shared/types.ts";
import { slugify } from "../shared/slug.ts";
import { loadTripBundle, regenerateTravelExpenses } from "./db.ts";
import { seedWinterLodge } from "./seed.ts";

interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Bindings }>();
const api = new Hono<{ Bindings: Bindings }>();

const bad = (msg: string) => ({ error: msg });

async function bundleResponse(db: D1Database, tripId: number) {
  const bundle = await loadTripBundle(db, tripId);
  if (!bundle) return null;
  return bundle;
}

// ---- trips ----
api.get("/trips", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM trips ORDER BY id DESC").all<Trip>();
  return c.json(results);
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
  const current = await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first<Trip>();
  if (!current) return c.json(bad("trip not found"), 404);
  const merged: Trip = {
    ...current,
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.slug !== undefined ? { slug: b.slug } : {}),
    ...(b.trip_date !== undefined ? { trip_date: b.trip_date } : {}),
    ...(b.planning_doc_url !== undefined ? { planning_doc_url: b.planning_doc_url } : {}),
    ...(b.slack_url !== undefined ? { slack_url: b.slack_url } : {}),
    ...(b.mileage_rate !== undefined ? { mileage_rate: b.mileage_rate } : {}),
  };
  if (!merged.slug?.trim()) return c.json(bad("slug cannot be empty"), 400);
  await c.env.DB.prepare(
    "UPDATE trips SET name=?, slug=?, trip_date=?, planning_doc_url=?, slack_url=?, mileage_rate=? WHERE id=?",
  )
    .bind(merged.name, merged.slug, merged.trip_date, merged.planning_doc_url, merged.slack_url, merged.mileage_rate, id)
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

// ---- people ----
api.post("/trips/:id/people", async (c) => {
  const tripId = Number(c.req.param("id"));
  const b = await c.req.json<{ name: string; code?: string; email?: string; type: string; parent_id?: number }>();
  if (!b.name || !b.type) return c.json(bad("name and type are required"), 400);
  await c.env.DB.prepare(
    "INSERT INTO people (trip_id, name, code, email, type, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(tripId, b.name, b.code ?? null, b.email ?? null, b.type, b.parent_id ?? null)
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

// Replace a travel group's driver set.
api.put("/groups/:gid/drivers", async (c) => {
  const gid = Number(c.req.param("gid"));
  const b = await c.req.json<{ person_ids: number[] }>();
  const row = await c.env.DB.prepare("SELECT trip_id FROM cost_groups WHERE id = ?").bind(gid).first<{ trip_id: number }>();
  if (!row) return c.json(bad("group not found"), 404);
  await c.env.DB.prepare("DELETE FROM travel_drivers WHERE group_id = ?").bind(gid).run();
  const ids = b.person_ids ?? [];
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
  const b = await c.req.json<{ person_ids: number[] }>();
  const row = await c.env.DB.prepare("SELECT trip_id FROM cost_groups WHERE id = ?").bind(gid).first<{ trip_id: number }>();
  if (!row) return c.json(bad("group not found"), 404);
  await c.env.DB.prepare("DELETE FROM group_members WHERE group_id = ?").bind(gid).run();
  const ids = [...new Set(b.person_ids ?? [])];
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
  const b = await c.req.json<{ group_id: number; description: string; amount: number; payer_id: number }>();
  if (!b.group_id || !b.payer_id || b.amount == null || !b.description)
    return c.json(bad("group_id, payer_id, amount, description are required"), 400);
  await c.env.DB.prepare(
    "INSERT INTO expenses (trip_id, group_id, description, amount, payer_id) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(tripId, b.group_id, b.description, b.amount, b.payer_id)
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

// ---- seed (dev/demo convenience) ----
api.post("/seed", async (c) => {
  const { tripId } = await seedWinterLodge(c.env.DB);
  return c.json(await bundleResponse(c.env.DB, tripId), 201);
});

api.notFound((c) => c.json(bad("not found"), 404));

app.route("/api", api);

export default app;
