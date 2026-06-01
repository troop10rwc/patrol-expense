# Patrol Expense

Troop 10 trip-expense tracker. A Cloudflare Worker (Hono) + React/Vite SPA on a
normalized D1 database, mounted as a same-origin tab at
**`troop10rwc.org/expenses`** and gated behind **Sign in with Slack**.

- Roster comes from the external **roster-db** D1 (read-only).
- Access is limited to Slack users linked to a roster member (`roster-db.user_member_associations`); admins are also allowed.
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

`.dev.vars` (gitignored) holds secrets. For local work set `DEV_AUTH_BYPASS=1`
to skip Slack (every request becomes a fixed "Dev User"). `wrangler login` is
required because the ROSTER binding reads the real roster-db (`remote: true`).

Click **Load 2026 Winter Lodge sample** (or `POST /expenses/api/seed`) to seed demo data.

## Slack app ("Sign in with Slack")

Reuse the troop's existing Slack app. In its settings:

- **OAuth & Permissions → Redirect URLs**, add:
  - `https://troop10rwc.org/expenses/auth/callback` (production)
  - `http://localhost:5173/expenses/auth/callback` (dev, if Slack allows http)
- Enable the **User Token Scopes**: `openid`, `profile`, `email`.
- Copy **Client ID** and **Client Secret** from *Basic Information*.

## Production deploy

1. **D1**: `wrangler d1 create patrol_expense`, then put the returned id into
   `wrangler.jsonc` (`d1_databases[0].database_id`).
2. **Migrations**: `npm run db:migrate:remote`.
3. **Secrets** (do NOT commit; `wrangler secret put NAME`):
   - `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
   - `SESSION_SECRET` — long random string (`openssl rand -hex 32`)
   - `GOOGLE_MAPS_API_KEY`
   - optional `SLACK_TEAM_ID` — restrict sign-in to one workspace
   - Do **not** set `DEV_AUTH_BYPASS` in production.
4. **Route**: `wrangler.jsonc` declares `troop10rwc.org/expenses*`. This requires
   troop10rwc.org to be a Cloudflare zone on the account (proxied DNS). All other
   paths fall through to the existing site.
5. `npm run deploy`.
6. On troop10rwc.org, add an **"Expenses"** link to the top nav pointing at
   `/expenses` (this lives in the main site, which is managed separately).

## Notes

- Cross-database joins aren't possible in D1, so roster members referenced by a
  trip are projected into a local `people` table (`source='roster'`); guests are
  `source='local'` and never written back to roster-db.
- Travel reimbursements are materialized as expenses so they flow into the paysheet.
