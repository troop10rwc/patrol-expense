# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**patrol-expense** — a Troop 10 trip-expense tracker, served same-origin at
`troop10rwc.org/expenses`. See **[STACK.md](./STACK.md)** for the full technology
stack and **[README.md](./README.md)** for setup and the production deploy runbook.

## Stack (summary)

TypeScript serverless app: React 19 + Vite SPA and a Hono API on **Cloudflare
Workers**, **D1** (SQLite) for data, **Cloudflare Access** (Slack SSO) for auth,
**Google Maps** for travel distances. Full details in [STACK.md](./STACK.md).

## Layout

```
src/shared    types + constants (BASE_PATH=/expenses, HOME_ADDRESS)
src/worker    Hono API, Cloudflare Access auth, roster reader, geo proxy, seed, paysheet engine
src/client    React SPA (App.tsx), API client
migrations    D1 schema
```

## Common commands

```sh
npm run dev                 # local dev at http://localhost:5173/expenses/
npm run typecheck           # tsc -b (run before committing)
npm run db:migrate:local    # apply migrations to local D1
npm run deploy              # build + wrangler deploy (production)
```

## Conventions & gotchas

- App is mounted under **`/expenses`** (`BASE_PATH`). Asset serving differs
  dev vs prod — the Worker branches on `env.ENVIRONMENT`.
- **Auth is Cloudflare Access**, not app-level. The Worker verifies the Access
  JWT; don't reintroduce a custom sign-in. Local dev uses `DEV_AUTH_BYPASS=1`
  in `.dev.vars` (there's no Access in front locally).
- **roster-db is read-only** (external, `remote` binding). D1 has no
  cross-database joins, so roster members used by a trip are projected into a
  local `people` table; guests are `source='local'`.
- Secrets live in `.dev.vars` (gitignored) / `wrangler secret` — never commit them.
- Run `npm run typecheck` before committing.
