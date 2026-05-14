/**
 * Runs the given callback inside a Drizzle transaction scoped to a JWT.
 *
 * - Reserves one pool connection for the lifetime of the callback.
 * - Sets request.jwt.claims (transaction-local) so auth.jwt() and
 *   current_tenant_id() resolve correctly.
 * - SET LOCAL ROLE authenticated so RLS policies fire. The pool's underlying
 *   role (postgres) bypasses RLS otherwise; the policies in 0003 target the
 *   `authenticated` role explicitly.
 * - SET LOCAL app.* request-level vars so the audit_record_change() trigger
 *   (DB-AUDIT) can stamp actor + request metadata onto each audit row. All
 *   of these are transaction-local — they don't leak across pooled
 *   connections.
 * - The transaction commits if the callback resolves, rolls back if it
 *   throws. Returns the callback's value.
 *
 * Used by:
 *   - apps/api middleware to bind each HTTP request to its JWT's tenant
 *   - apps/workers to bind background jobs to a tenant context
 *
 * The claims argument must be a verified JWT payload — this helper does NOT
 * verify signatures. Verification is the caller's responsibility.
 *
 * The metadata argument is optional. HTTP middleware passes request headers
 * + an ip_address; workers and scripts pass at minimum `source: 'system'`
 * (or `'integration'`, `'migration'`). When omitted, actor_user_id falls
 * back to claims.sub if a string and source defaults to 'app'.
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

export type TenantContextSource = "app" | "integration" | "system" | "migration";

export interface TenantContextMetadata {
  /** Override actor user id. Defaults to claims.sub when that's a string. */
  actorUserId?: string | null;
  /** tenant_user_memberships.id for the actor. Not in JWT claims, so the
   * caller (middleware / worker) must supply it if known. NULL is fine. */
  actorMembershipId?: string | null;
  /** Correlation id — `x-request-id` header for HTTP, job id for workers. */
  requestId?: string | null;
  userAgent?: string | null;
  /** Caller IP. inet-castable text (IPv4 or IPv6 literal). */
  ipAddress?: string | null;
  /** Where the change originated. Defaults to 'app'. */
  source?: TenantContextSource;
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
  metadata: TenantContextMetadata = {},
): Promise<T> {
  const claimsJson = JSON.stringify(claims);
  const actorUserId =
    metadata.actorUserId !== undefined
      ? metadata.actorUserId
      : typeof claims.sub === "string"
        ? claims.sub
        : null;
  const actorMembershipId = metadata.actorMembershipId ?? null;
  const requestId = metadata.requestId ?? null;
  const userAgent = metadata.userAgent ?? null;
  const ipAddress = metadata.ipAddress ?? null;
  const source: TenantContextSource = metadata.source ?? "app";

  return poolDb.transaction(async (tx) => {
    // set_config(key, value, is_local=true). We pass empty strings for
    // missing values because set_config can't store NULL; the trigger
    // function uses NULLIF(..., '') to map them back to NULL at read time.
    await tx.execute(drizzleSql`SELECT set_config('request.jwt.claims', ${claimsJson}, true)`);
    await tx.execute(
      drizzleSql`SELECT set_config('app.actor_user_id', ${actorUserId ?? ""}, true)`,
    );
    await tx.execute(
      drizzleSql`SELECT set_config('app.actor_membership_id', ${actorMembershipId ?? ""}, true)`,
    );
    await tx.execute(drizzleSql`SELECT set_config('app.request_id', ${requestId ?? ""}, true)`);
    await tx.execute(drizzleSql`SELECT set_config('app.user_agent', ${userAgent ?? ""}, true)`);
    await tx.execute(drizzleSql`SELECT set_config('app.ip_address', ${ipAddress ?? ""}, true)`);
    await tx.execute(drizzleSql`SELECT set_config('app.source', ${source}, true)`);
    await tx.execute(drizzleSql`SET LOCAL ROLE authenticated`);
    return callback({ db: tx, claims });
  });
}

// Re-exported so consumers can use db.execute(sql`...`) inside a tenant
// context without taking a direct drizzle-orm dependency.
export { sql as drizzleSql } from "drizzle-orm";
