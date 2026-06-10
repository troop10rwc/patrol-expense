# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**patrol-expense** — a Troop 10 trip-expense tracker, served same-origin at
`troop10rwc.org/manage/expenses`. See **[STACK.md](./STACK.md)** for the full technology
stack and **[README.md](./README.md)** for setup and the production deploy runbook.

## Stack (summary)

TypeScript serverless app: React 19 + Vite SPA and a Hono API on **Cloudflare
Workers**, **D1** (SQLite) for data, **Cloudflare Access** (Slack SSO) for auth,
**Google Maps** for travel distances. Full details in [STACK.md](./STACK.md).

## Layout

```
src/shared    types + constants (BASE_PATH=/manage/expenses, HOME_ADDRESS)
src/worker    Hono API, Cloudflare Access auth, roster reader, geo proxy, seed, paysheet engine
src/client    React SPA (App.tsx), API client
migrations    D1 schema
```

## Common commands

```sh
npm run dev                 # local dev at http://localhost:5173/manage/expenses/
npm run typecheck           # tsc -b (run before committing)
npm run db:migrate:local    # apply migrations to local D1
npm run deploy              # build + wrangler deploy (production)
```

## Conventions & gotchas

- App is mounted under **`/manage/expenses`** (`BASE_PATH`). Asset serving differs
  dev vs prod — the Worker branches on `env.ENVIRONMENT`.
- **Auth is Cloudflare Access**, not app-level. The Worker verifies the Access
  JWT; don't reintroduce a custom sign-in. Local dev uses `DEV_AUTH_BYPASS=1`
  in `.dev.vars` (there's no Access in front locally).
- **roster-db is read-only** (external, `remote` binding). D1 has no
  cross-database joins, so roster members used by a trip are projected into a
  local `people` table; guests are `source='local'`.
- Secrets live in `.dev.vars` (gitignored) / `wrangler secret` — never commit them.
- Run `npm run typecheck` before committing.

## Shared stack: @troop10rwc/kit

This app is built on the shared Troop 10 RWC stack (Vite + React 19 + Hono +
Cloudflare Workers + D1, behind Cloudflare Access). **Reuse the kit — don't
reinvent UI, types, or Worker auth.**

- `@troop10rwc/ui` — back-office components + `--t10-*` design tokens. Building
  any back-office page? Follow the design contract at
  `node_modules/@troop10rwc/ui/STYLE.md` (the five interaction models; one primary
  action per view; preview any write the user didn't type field-by-field). To use
  it, import `@troop10rwc/ui/fonts.css` then `@troop10rwc/ui/theme.css` in
  `src/client/main.tsx` (order matters) — not wired yet; add when you adopt the UI.
- `@troop10rwc/shared` — shared types (`Role`, `Position`, `Changeset`). Import
  contracts from here; don't redefine them. (This repo still has a local
  `src/shared` — migrating it onto the kit is a separate change.)
- `@troop10rwc/worker-kit` — Access JWT verify, roster role, Hono middleware
  (`withAuth`, `requireLeader`). This repo's `src/worker/auth.ts` + `roster.ts` are
  the local versions worker-kit is meant to absorb — migrate deliberately.

Install/auth uses GitHub Packages — see `.npmrc` (`NPM_TOKEN` = `GITHUB_TOKEN` in
CI, a PAT locally). Canonical docs: https://github.com/troop10rwc/kit/blob/main/STACK.md

Agents: the kit ships a Claude Code plugin (auto-loaded via `.claude/settings.json`)
with skills `consume-kit` (repo prep) and `backoffice-style` (the design contract).
