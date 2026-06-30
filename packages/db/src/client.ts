import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// TEST-INFRA-01: when NODE_ENV=test, prefer TEST_DATABASE_URL if set.
// The hook is the seam for two consumers, both gated on NODE_ENV=test
// so production / dev / workers always use DATABASE_URL:
//   - CI: a CI workflow can set TEST_DATABASE_URL to point the api
//     test suite at a CI-specific database (currently not used —
//     test-full / test-gate jobs both run against DATABASE_URL — but
//     wired for future use without re-editing this file).
//   - TEST-INFRA-02 (future): a vitest globalSetup spins up a local
//     supabase/postgres container and writes the container's
//     connection URL into TEST_DATABASE_URL for the suite to consume.
// When TEST_DATABASE_URL is unset the chain falls through to
// DATABASE_URL — the common-case codepath. The hook adds no runtime
// cost outside the test environment.
const databaseUrl =
  (process.env.NODE_ENV === "test" && process.env.TEST_DATABASE_URL) ||
  process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. Add it to your .env file.");
}

// Runtime client: pooled connection (transaction mode, port 6543).
// `prepare: false` is required because transaction-mode pooling does not support prepared statements.
// Exported as `sql` so withTenantContext can use sql.begin() to bind one request
// to one connection for the lifetime of a transaction.
//
// TEST-INFRA-01: `max` is configurable via DB_POOL_MAX (env). Prod
// leaves it unset → postgres-js uses its default of 10, behaviour
// unchanged. The vitest run sets DB_POOL_MAX=3 so 19 forks × 3
// connections stays under the Supavisor project-level connection cap
// (~60), avoiding the saturation cascade that surfaced in AGENT-04b's
// full-suite run. Set via the apps/api test script, not via
// .env — so other consumers (worker, dev server, scripts) keep the
// prod default unless they explicitly opt in.
const poolMaxEnv = process.env.DB_POOL_MAX;
const poolMax = poolMaxEnv ? Number.parseInt(poolMaxEnv, 10) : undefined;
export const sql = postgres(databaseUrl, {
  prepare: false,
  ...(poolMax !== undefined && !Number.isNaN(poolMax) ? { max: poolMax } : {}),
});
export const db = drizzle(sql, { schema });

export type Database = typeof db;
