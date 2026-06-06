# Patrol Expense

Troop 10 trip-expense tracker. A Cloudflare Worker (Hono) + React/Vite SPA on a
normalized D1 database, mounted as a same-origin tab at
**`troop10rwc.org/expenses`**.

- **Authentication is handled by Cloudflare Access** (Zero Trust, Slack IdP) in
  front of the whole domain. The Worker verifies the Access JWT and reads the
  user's identity — there is no app-level sign-in. Who may access is controlled
  by the Cloudflare Access policy.
- Roster comes from the external **roster-db** D1 (read-only).
- Travel addresses use Google Maps (autocomplete + most-direct driving distance) via a server-side proxy.

## Layout

```
src/shared    types + constants (BASE_PATH=/expenses, HOME_ADDRESS)
src/worker     Hono API, Slack OAuth (auth.ts), roster reader, geo proxy, seed
src/client     React SPA (App.tsx), API client
migrations     D1 schema (0001 init, 0002 roster-db integration)
```

The Worker owns the whole `/expenses/*` subpath: it strips the prefix, routes
`/api` and `/auth` to Hono, and serves the SPA via the assets binding.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars      # then fill in values
npm run db:migrate:local            # apply migrations to local D1
npm run dev                         # http://localhost:5173/expenses/
```

`.dev.vars` (gitignored) holds secrets. There's no Cloudflare Access locally, so
set `DEV_AUTH_BYPASS=1` to skip auth (every request becomes a fixed "Dev User").
`wrangler login` is required because the ROSTER binding reads the real roster-db
(`remote: true`).

Click **Load 2026 Winter Lodge sample** (or `POST /expenses/api/seed`) to seed demo data.

## Authentication (Cloudflare Access)

troop10rwc.org is protected by **Cloudflare Access** (Zero Trust) with Slack as
the identity provider. Access authenticates at the edge and injects a signed JWT;
the Worker verifies it (JWKS + AUD) and reads the user's email/name. No app-level
login. `wrangler.jsonc` vars set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (the
Access application's AUD tag).

**Who can access `/expenses`** is governed by the Cloudflare Access policy. To
restrict it more tightly than the rest of the site, add a dedicated Access
application for `troop10rwc.org/expenses*` with the desired policy (e.g. a group
or email list of roster members).

## Production deploy

1. **D1**: `wrangler d1 create patrol_expense`, then put the returned id into
   `wrangler.jsonc` (`d1_databases[0].database_id`).
2. **Migrations**: `npm run db:migrate:remote`.
3. **Secrets** (`wrangler secret put NAME`): `GOOGLE_MAPS_API_KEY`. Do **not** set
   `DEV_AUTH_BYPASS` in production.
4. **Access vars** in `wrangler.jsonc`: `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`.
5. **Route**: `wrangler.jsonc` declares `troop10rwc.org/expenses*` (the zone is on
   Cloudflare; all other paths fall through to the existing site).
6. `npm run deploy`.
7. On troop10rwc.org, add an **"Expenses"** link to the top nav pointing at
   `/expenses` (the main site is managed separately).

## Notes

- Cross-database joins aren't possible in D1, so roster members referenced by a
  trip are projected into a local `people` table (`source='roster'`); guests are
  `source='local'` and never written back to roster-db.
- Travel reimbursements are materialized as expenses so they flow into the paysheet.
