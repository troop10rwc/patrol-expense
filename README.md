# Patrol Expense

Troop 10 trip-expense tracker. A Cloudflare Worker (Hono) + React/Vite SPA on a
normalized D1 database, mounted as a same-origin tab at
**`troop10rwc.org/manage/expenses`**.

- **Authentication is self-hosted member sessions** (the `@troop10rwc/kit`
  model). The shared identity service at **`id.troop10rwc.org`** signs members in
  (Slack enrollment + passkeys) and sets the `__Secure-troop_session` cookie; the
  Worker validates it against the shared `troop10-id` D1. No app-level sign-in.
- Roster comes from the external **roster-db** D1 (read-only).
- Travel addresses use Google Maps (autocomplete + most-direct driving distance) via a server-side proxy.

## Layout

```
src/shared    types + constants (BASE_PATH=/manage/expenses, HOME_ADDRESS)
src/worker     Hono API, session auth (auth.ts), roster reader, geo proxy, seed
src/client     React SPA (App.tsx), API client
migrations     D1 schema (0001 init, 0002 roster-db integration)
```

The Worker owns the whole `/manage/expenses/*` subpath: it strips the prefix,
routes `/api` to Hono, and serves the SPA via the assets binding.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars      # then fill in values
npm run db:migrate:local            # apply migrations to local D1
npm run dev                         # http://localhost:5173/manage/expenses/
```

`.dev.vars` (gitignored) holds secrets. There's no identity service in front of
local dev, so set `DEV_AUTH_BYPASS=1` to skip auth (every request becomes a fixed
"Dev User"). `wrangler login` is required because the ROSTER and IDDB bindings
read the real `roster-db` / `troop10-id` D1s (`remote: true`).

Click **Load 2026 Winter Lodge sample** (or `POST /manage/expenses/api/seed`) to seed demo data.

## Authentication (member sessions)

Auth is **self-hosted member sessions**, shared across Troop 10 apps via
`@troop10rwc/kit`. The standalone identity service at **`id.troop10rwc.org`**
handles enrollment (Slack, workspace-locked) and the daily driver (passkeys),
mints the `__Secure-troop_session` cookie (`Domain=troop10rwc.org`), and writes
each session to the shared **`troop10-id`** D1. This Worker doesn't sign anyone
in — it reads the cookie and resolves it against `troop10-id` (bound read-only as
`IDDB`) with the kit's `d1SessionLookup` (`src/worker/auth.ts`). An API call with
no live session gets a `401` carrying `AUTH_ORIGIN`; the SPA then bounces the
browser to `${AUTH_ORIGIN}/login?redirect=…`, which returns here once signed in.

**Domain constraint.** The session cookie is scoped to `troop10rwc.org`, so the
app must be served under **`*.troop10rwc.org`** — a `*.workers.dev` host can never
receive it. That's why `workers_dev`/`preview_urls` are off: an authenticated
preview must be served from a `*.troop10rwc.org` route, not a workers.dev URL.

## Production deploy

1. **D1**: `wrangler d1 create patrol_expense`, then put the returned id into
   `wrangler.jsonc` (`d1_databases[0].database_id`).
2. **Migrations**: `npm run db:migrate:remote`.
3. **Secrets** (`wrangler secret put NAME`): `GOOGLE_MAPS_API_KEY`. Do **not** set
   `DEV_AUTH_BYPASS` in production.
4. **Auth**: `wrangler.jsonc` sets `AUTH_ORIGIN` (`https://id.troop10rwc.org`) and
   binds the shared `troop10-id` D1 read-only as `IDDB`. The identity service must
   already be deployed at that origin (repo: `troop10rwc/id`).
5. **Route**: `wrangler.jsonc` declares `troop10rwc.org/manage/expenses*` (the
   zone is on Cloudflare; all other paths fall through to the existing site).
6. `npm run deploy`.
7. On troop10rwc.org, add an **"Expenses"** link to the top nav pointing at
   `/manage/expenses` (the main site is managed separately).

## Notes

- Cross-database joins aren't possible in D1, so roster members referenced by a
  trip are projected into a local `people` table (`source='roster'`); guests are
  `source='local'` and never written back to roster-db.
- Travel reimbursements are materialized as expenses so they flow into the paysheet.
