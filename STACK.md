# Technology Stack

**patrol-expense** — a Troop 10 trip-expense tracker. One-liner: a TypeScript
serverless app — React/Vite SPA + Hono on Cloudflare Workers, D1 (SQLite) for
data, Cloudflare Access (Slack SSO) for auth, Google Maps for travel distances.
Served same-origin at `troop10rwc.org/manage/expenses`.

## Runtime & hosting
- **Cloudflare Workers** — the whole app (API + static assets) runs at the edge,
  deployed via **Wrangler**, served at `troop10rwc.org/manage/expenses*` (Worker
  route).
- **Cloudflare Workers Static Assets** (`ASSETS` binding, single-page-application
  fallback) serves the built frontend. The Worker owns the whole
  `/manage/expenses/*` subpath: strips the base prefix, routes `/api/*` to Hono,
  else serves assets.

## Backend
- **Hono** (TypeScript) — HTTP framework for the Worker; REST API under `/api/*`.
- **Cloudflare D1** (serverless SQLite) — two databases:
  - `patrol_expense` — the app's normalized schema (trips, people, cost_groups,
    expenses, group_members, prepayments, settlements). Managed with **Wrangler
    D1 migrations** (`migrations/`).
  - `roster-db` — the existing external BSA roster, attached **read-only** via a
    `remote: true` binding.
- Pure-TS **paysheet engine** (`src/worker/engine.ts`); no ORM — hand-written SQL
  via the D1 client.

## Frontend
- **React 19** + **Vite 6** SPA, TypeScript, hand-written CSS (no UI framework).
- **`@cloudflare/vite-plugin`** — runs the Worker in the Workers runtime during
  `vite dev` and produces the deploy bundle. Vite `base: "/manage/expenses/"`.
- Client routing/auth gating done manually (no router library).

## Auth
- **Cloudflare Access** (Zero Trust) with **Slack** as the identity provider —
  authenticates at the edge for the whole domain. The Worker **verifies the
  Access JWT** (RS256 via the team JWKS, **WebCrypto**) and reads identity
  (`src/worker/auth.ts`). No app-level login. `DEV_AUTH_BYPASS=1` for local dev.

## External integrations
- **Google Maps Platform** — Places API (New) for address autocomplete + Routes
  API for most-direct driving distance, proxied server-side through the Worker
  (`src/worker/geo.ts`; key kept as a `wrangler secret`).

## Tooling & language
- **TypeScript** end-to-end with shared types (`src/shared/`) between client and
  worker. Split `tsconfig` project references for DOM/client vs. Workers/worker
  environments; `tsc -b` for type-checking.
- **npm**; **git** → GitHub (`troop10rwc/patrol-expense`).

See `README.md` for setup and the production deploy runbook.
