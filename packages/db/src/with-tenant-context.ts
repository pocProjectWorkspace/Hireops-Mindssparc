/**
 * Runs the given callback inside a Drizzle transaction scoped to a JWT.
 *
 * - Reserves one pool connection for the lifetime of the callback.
 * - Sets request.jwt.claims (transaction-local).
 * - SET LOCAL ROLE authenticated so RLS policies fire. The pool's underlying
 *   role (postgres) bypasses RLS otherwise; the policies in 0003 target the
 *   `authenticated` role explicitly.
 * - auth.jwt(), current_tenant_id(), has_role() all work inside the callback.
 * - The transaction commits if the callback resolves, rolls back if it throws.
 * - Returns the callback's value.
 *
 * Used by:
 *   - apps/api middleware to bind each HTTP request to its JWT's tenant
 *   - apps/workers to bind background jobs to a tenant context
 *
 * The claims argument must be a verified JWT payload — this helper does NOT
 * verify signatures. Verification is the caller's responsibility.
 */

import { sql as drizzleSql } from "drizzle-orm";
import { db as poolDb } from "./client";

export interface JwtClaims {
  sub?: string;
  tid?: string;
  tenant_slug?: string;
  roles?: string[];
  [key: string]: unknown;
}

// Drizzle's transaction callback receives a typed transaction client; we
// derive that type from the public transaction() API so consumers don't have
// to know the internal class name.
export type TenantBoundDb = Parameters<Parameters<typeof poolDb.transaction<unknown>>[0]>[0];

export interface TenantContext {
  db: TenantBoundDb;
  claims: JwtClaims;
}

export async function withTenantContext<T>(
  claims: JwtClaims,
  callback: (ctx: TenantContext) => Promise<T>,
): Promise<T> {
  const claimsJson = JSON.stringify(claims);

  return poolDb.transaction(async (tx) => {
    await tx.execute(drizzleSql`SELECT set_config('request.jwt.claims', ${claimsJson}, true)`);
    await tx.execute(drizzleSql`SET LOCAL ROLE authenticated`);
    return callback({ db: tx, claims });
  });
}

// Re-exported so consumers can use db.execute(sql`...`) inside a tenant
// context without taking a direct drizzle-orm dependency.
export { sql as drizzleSql } from "drizzle-orm";
