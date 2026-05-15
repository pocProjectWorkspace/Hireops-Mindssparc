# Contributing to HireOps

Stub. Expand as the team grows past one engineer.

## Prerequisites

- Node 22 (use `nvm use` from repo root once a `.nvmrc` lands)
- pnpm 11 (the `packageManager` field in root `package.json` pins the exact version)
- Access to the dev Supabase project
- A copy of `.env.example` filled in as `.env` at the repo root

## Setup

```sh
git clone <repo>
cd hireops
pnpm install
cp .env.example .env
# fill in DATABASE_URL, DIRECT_URL, SUPABASE_*, SUPABASE_KEK_SECRET from
# the dev Supabase project (Connect / API tabs, plus a 64-hex-char KEK
# generated locally per the .env.example notes)
pnpm db:migrate
```

## Common commands

| Command                             | What it does                                                  |
| ----------------------------------- | ------------------------------------------------------------- |
| `pnpm typecheck`                    | Repo-wide TypeScript check (turbo-cached)                     |
| `pnpm lint`                         | ESLint everywhere                                             |
| `pnpm format` / `pnpm format:check` | Prettier write / verify                                       |
| `pnpm build`                        | Per-package builds                                            |
| `pnpm api:test`                     | Vitest integration suite for `apps/api` (~5 min, hits dev DB) |
| `pnpm db:generate`                  | Drizzle schema → migration SQL                                |
| `pnpm db:migrate`                   | Apply pending migrations to the DB pointed at by `DIRECT_URL` |
| `pnpm db:lint:rls`                  | Verify every public-schema table has the right RLS shape      |
| `pnpm -F @hireops/ui storybook`     | Storybook on `:6006`                                          |

## CI overview

`.github/workflows/ci.yml` runs on every push and on PRs to `main`:

- **Parallel (no DB)**: `typecheck`, `lint`, `format`, `build`
- **Serial (DB)**: `api:test`, `db:lint:rls` — both share `concurrency: { group: ci-db, cancel-in-progress: false }` so two pushes in quick succession queue rather than collide on shared fixtures.

DB-touching jobs need these repo secrets set in the GitHub repo Settings → Secrets and variables → Actions:

- `DATABASE_URL`, `DIRECT_URL` (Supabase pooler URIs)
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_KEK_SECRET` (64 hex chars, see `.env.example`)

These point at the same dev Supabase project that local development uses; rotation is manual today (Supabase dashboard → Settings → API → reset → update repo secret). TBD: separate CI Supabase project before a second engineer joins.

CI does not gate merges yet — runs as a status check only. Branch protection is a multi-engineer concern, deferred.

## Where to read first

- `docs/HANDOVER.md` — current state, conventions, "codebase realities"
- `docs/architecture.md` — the build-time design doc
- `docs/requirements.md` — what we're building and why
- `docs/design-system.md` — DS spec the `packages/ui` primitives implement against

## Logging and Sentry

`packages/observability` exports `createLogger()` (pino) and `getSentryClient()` (Local in dev, Real when `SENTRY_DSN` is set). In `apps/api` request handlers, use `c.var.log` — it's a child logger pre-bound with `request_id`, `tenant_id`, `actor_user_id`. Pino's idiom is `log.error({ err, ...context }, 'message')`, not template strings. See `docs/HANDOVER.md` §4.5 codebase realities entries for the convention details.

TBD: expand this file when a second engineer joins (CI failure runbook, secret rotation steps, branch / PR conventions).
