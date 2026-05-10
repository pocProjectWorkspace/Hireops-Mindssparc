# @hireops/db

Drizzle ORM bindings for the Supabase Postgres database, plus migration runner and Custom Access Token hook diagnostics.

## Dual-connection pattern

Two connection strings, both copied from the Supabase dashboard → **Connect** (top bar). Both pooler hosts are dual-stack IPv4+IPv6.

| Env var        | Mode               | Port | Used by                                       | `prepare`        |
| -------------- | ------------------ | ---- | --------------------------------------------- | ---------------- |
| `DATABASE_URL` | Transaction pooler | 6543 | Runtime queries (`src/client.ts`)             | `false`          |
| `DIRECT_URL`   | Session pooler     | 5432 | Migrations, long-running workers, drizzle-kit | `true` (default) |

### Why two connections

- **Transaction-mode pooler (`DATABASE_URL`)** multiplexes Postgres connections across many incoming clients, which gives serverless and short-lived workloads excellent throughput. The trade-off is that prepared statements are not supported across the pool, so `client.ts` constructs `postgres()` with `prepare: false`.
- **Session-mode pooler (`DIRECT_URL`)** assigns a Postgres connection to a client for the duration of the session. It behaves like a direct connection for our purposes — it queues, supports prepared statements, and is safe for migrations and long-running workers.

### Why session pooler instead of the legacy direct host

Supabase used to recommend the legacy direct host (`db.<project>.supabase.co:5432`) for migrations. On the free tier that host is **IPv6-only**, which fails on IPv4-only networks (many home/office WiFi, corporate egress, some CI runners). The session pooler (`aws-N-<region>.pooler.supabase.com:5432`) is dual-stack and is now the official Supabase recommendation for IPv4-required long-lived sessions.

References:

- [Supabase: Connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase: IPv4 add-on / IPv6 caveats](https://supabase.com/docs/guides/platform/ipv4-address)

### Username caveat

The pooler username is `postgres.<PROJECT_REF>` — note the **dot**, not a hyphen. This is required by Supavisor (the pooler) to route to the correct project. The legacy direct host used a plain `postgres` username, which is why old `.env` files copied from older docs do not work against the pooler.

## Scripts

These scripts live in this package only (the root `package.json` doesn't proxy them). Run them with a workspace filter from the repo root, or `cd` into this package:

```bash
pnpm --filter @hireops/db db:migrate
# or
cd packages/db && pnpm db:migrate
```

| Script           | What it does                                                      |
| ---------------- | ----------------------------------------------------------------- |
| `db:generate`    | Generate a new Drizzle migration from schema changes              |
| `db:migrate`     | Apply pending migrations against `DIRECT_URL`                     |
| `db:seed`        | Run the seed script                                               |
| `db:studio`      | Open Drizzle Studio against `DIRECT_URL`                          |
| `db:test:verify` | End-to-end verification of the Custom Access Token hook (FND-15b) |

## Layout

```
src/
  client.ts            Drizzle client over DATABASE_URL (transaction pooler)
  migrate.ts           Migration runner over DIRECT_URL (session pooler)
  diagnose-hook.ts     Custom Access Token hook claim debugger (DIRECT_URL)
  schema/              Drizzle schema definitions
  test-fixtures/       Verification scripts for hooks/claims
drizzle/
  migrations/          Drizzle-generated SQL + _journal.json
```

## Conventions

- Scripts that load `.env` use `fileURLToPath(import.meta.url)` to resolve the workspace root. Do not refactor to plain `__dirname` or `process.cwd()`.
- Seed/verify scripts use `await import('./client')` after `dotenv.config()`. Static imports hoist before dotenv runs — this is intentional, not a code smell.
- Hand-written SQL migrations require a corresponding `_journal.json` entry with the next sequence number.
- Use `gen_random_uuid()` directly. Do not enable `uuid-ossp` or `pgcrypto`.
