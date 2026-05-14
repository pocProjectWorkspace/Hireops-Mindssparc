/**
 * Hono middleware that binds each request to its JWT's tenant scope.
 *
 * After this middleware runs, downstream handlers can rely on:
 *   c.var.tenantId    — non-null UUID
 *   c.var.userId      — non-null UUID (Supabase auth.users.id)
 *   c.var.roles       — string[] (may be empty)
 *   c.var.claims      — full JWT payload
 *   c.var.db          — Drizzle transaction client bound to this request
 *
 * Handlers can run Drizzle queries directly on c.var.db, or raw SQL via
 * `c.var.db.execute(drizzleSql\`...\`)`. The transaction commits when the
 * handler returns successfully and rolls back if it throws. All queries
 * inside see consistent RLS scoping under the `authenticated` role.
 *
 * Request-level metadata captured for the DB-AUDIT trigger:
 *   - request_id  — x-request-id header if present, else a generated UUID
 *   - user_agent  — user-agent header
 *   - ip_address  — the first entry of x-forwarded-for if present, else
 *                   x-real-ip, else null. Behind Supabase's edge so the
 *                   originating IP is in x-forwarded-for; documented here
 *                   so future readers don't have to grep.
 *   - actor_user_id — claims.sub (the verified JWT subject)
 *   - source        — 'app' (the default; workers/scripts pass their own)
 *
 * actor_membership_id is NOT populated here — the JWT carries tid but not
 * membership_id, so we'd need a separate DB lookup per request. The audit
 * row stores NULL; consumers can JOIN (tenant_id, actor_user_id) →
 * tenant_user_memberships to reconstruct it.
 */

import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import { withTenantContext, type JwtClaims, type TenantBoundDb } from "@hireops/db";
import { verifyJwt, extractBearerToken } from "../lib/jwt";

export interface TenantContextVars {
  tenantId: string;
  userId: string;
  roles: string[];
  claims: JwtClaims;
  db: TenantBoundDb;
}

function firstForwardedFor(header: string | undefined): string | null {
  if (!header) return null;
  const first = header.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export const tenantContext: MiddlewareHandler<{
  Variables: TenantContextVars;
}> = async (c, next) => {
  const token = extractBearerToken(c.req.header("Authorization"));
  const result = await verifyJwt(token);

  if (!result.ok) {
    return c.json({ error: "unauthorized", reason: result.reason }, 401);
  }

  const { claims } = result;
  const tenantId = typeof claims.tid === "string" ? claims.tid : null;
  const userId = typeof claims.sub === "string" ? claims.sub : null;

  if (!tenantId || !userId) {
    return c.json({ error: "unauthorized", reason: "missing_tenant_claim" }, 401);
  }

  const requestId = c.req.header("x-request-id") ?? randomUUID();
  const userAgent = c.req.header("user-agent") ?? null;
  const ipAddress =
    firstForwardedFor(c.req.header("x-forwarded-for")) ?? c.req.header("x-real-ip") ?? null;

  // Run the rest of the request inside a tenant-scoped transaction. Hono's
  // next() runs the downstream chain inline; the handler sets the response
  // body via c.json() before the transaction commits. Errors thrown by the
  // handler propagate out and cause a rollback.
  await withTenantContext(
    claims,
    async ({ db, claims: c2 }) => {
      c.set("tenantId", tenantId);
      c.set("userId", userId);
      c.set("roles", Array.isArray(c2.roles) ? c2.roles : []);
      c.set("claims", c2);
      c.set("db", db);
      await next();
    },
    {
      actorUserId: userId,
      requestId,
      userAgent,
      ipAddress,
      source: "app",
    },
  );
};
