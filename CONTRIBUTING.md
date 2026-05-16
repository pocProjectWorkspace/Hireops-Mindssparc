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

| Command                                      | What it does                                                  |
| -------------------------------------------- | ------------------------------------------------------------- |
| `pnpm typecheck`                             | Repo-wide TypeScript check (turbo-cached)                     |
| `pnpm lint`                                  | ESLint everywhere                                             |
| `pnpm format` / `pnpm format:check`          | Prettier write / verify                                       |
| `pnpm build`                                 | Per-package builds                                            |
| `pnpm api:test`                              | Vitest integration suite for `apps/api` (~5 min, hits dev DB) |
| `pnpm db:generate`                           | Drizzle schema → migration SQL                                |
| `pnpm db:migrate`                            | Apply pending migrations to the DB pointed at by `DIRECT_URL` |
| `pnpm db:lint:rls`                           | Verify every public-schema table has the right RLS shape      |
| `pnpm db:seed:test-users`                    | Idempotently provision 3 test users in the kyndryl-poc tenant |
| `pnpm dev`                                   | turbo --parallel: starts apps/api + apps/internal-portal      |
| `pnpm portal:dev`                            | Internal portal only (`next dev`, port 3000)                  |
| `pnpm e2e`                                   | Playwright golden-path test (boots dev servers via webServer) |
| `pnpm -F @hireops/ui storybook`              | Storybook on `:6006` (UI primitives)                          |
| `pnpm -F @hireops/internal-portal storybook` | Storybook on `:6006` (portal screens)                         |

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

## Supabase Storage: the `candidate-uploads` bucket

API-01's `/api/upload/resume` route writes uploaded CVs to a Supabase
Storage bucket called `candidate-uploads`. The bucket lives outside
Drizzle — Storage is not in our migration chain — and needs one-time
provisioning per Supabase project (dev, staging, prod).

**Create it via the Supabase dashboard** (or CLI):

1. Project → Storage → New bucket → name: `candidate-uploads`
2. Public bucket: **off** (we proxy reads through the API)
3. File size limit: 5 MB (matches the route's runtime check)
4. Allowed MIME types: `application/pdf`,
   `application/vnd.openxmlformats-officedocument.wordprocessingml.document`

**Apply these RLS policies on `storage.objects` for the bucket**
(Storage → Policies → New policy):

```sql
-- Service-role bypasses RLS so /api/upload/resume can write. No policy
-- grants anonymous INSERT — uploads MUST go through the API.

-- Authenticated users may SELECT objects in this bucket. The application
-- layer is responsible for narrowing visibility further (we don't
-- expose direct storage URLs to candidates, only via API endpoints).
CREATE POLICY "authenticated read candidate-uploads" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'candidate-uploads');

-- service_role-only DELETE — recruiter/manual removal goes through the
-- API which proxies as service_role. Don't grant authenticated DELETE.
```

In CI + local dev the API uses `LocalStorageClient` (in-memory map) so
no bucket is required there — `NODE_ENV=test` and `STORAGE_PROVIDER=local`
both trigger the local path. In production set `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` (already in CI secrets) and the storage
client switches automatically.

## Local dev workflow

1. `cp .env.example .env` (or pull from 1Password), fill in Supabase URLs + keys
2. `pnpm install`
3. `pnpm db:migrate` — applies pending migrations
4. `pnpm db:seed:test-users` — once per dev DB; creates `recruiter1@kyndryl-poc.test` / `hr_ops1@kyndryl-poc.test` / `admin1@kyndryl-poc.test` with password `TestPassword123!`
5. `pnpm dev` — boots apps/api on :3001 and apps/internal-portal on :3000 in parallel

### E2E

`pnpm e2e` runs Playwright. The config boots `pnpm dev` automatically via the
`webServer` block (180s timeout), then runs the golden-path test at
`e2e/golden-path.spec.ts` (login → /triage → axe assertion). Set
`E2E_NO_WEBSERVER=1` to use an externally-started dev server (useful in CI).

First Playwright run on a new machine: `pnpm e2e:install` (downloads Chromium).

## Logging and Sentry

`packages/observability` exports `createLogger()` (pino) and `getSentryClient()` (Local in dev, Real when `SENTRY_DSN` is set). In `apps/api` request handlers, use `c.var.log` — it's a child logger pre-bound with `request_id`, `tenant_id`, `actor_user_id`. Pino's idiom is `log.error({ err, ...context }, 'message')`, not template strings. See `docs/HANDOVER.md` §4.5 codebase realities entries for the convention details.

TBD: expand this file when a second engineer joins (CI failure runbook, secret rotation steps, branch / PR conventions).
