/**
 * Optional-auth middleware. Same JWT plumbing as tenantContext but
 * doesn't 401 on missing / invalid tokens — instead it sets the
 * caller-facing variables to null and lets downstream handlers decide.
 *
 * Used by the tRPC mount. tRPC's publicProcedure runs regardless;
 * protectedProcedure inspects ctx.userId and throws UNAUTHORIZED itself.
 * Keeping the auth signal at the procedure layer (not the middleware)
 * lets the apply form (public) and admin endpoints (protected) coexist
 * behind the same /trpc/* mount.
 *
 * IMPORTANT: this middleware does NOT open a withTenantContext
 * transaction. Procedures that need RLS-scoped DB access open their own
 * via the protected-procedure tRPC middleware (apps/api/src/trpc/trpc-core.ts).
 * Reason: tRPC supports batched requests, so opening a tx in the Hono
 * layer would share one connection across multiple procedures — usually
 * fine, but surprising when one procedure rolls back the whole batch.
 * Per-procedure tx is the more predictable shape.
 */

import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "@hireops/observability";
import type { JwtClaims } from "@hireops/db";
import { baseLog, sentry } from "../lib/observability";
import { extractBearerToken, verifyJwt } from "../lib/jwt";

export interface OptionalAuthVars {
  // null when no/invalid JWT
  tenantId: string | null;
  userId: string | null;
  roles: string[];
  claims: JwtClaims | null;
  // always set
  log: Logger;
  requestId: string;
}

export const optionalAuth: MiddlewareHandler<{ Variables: OptionalAuthVars }> = async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.header("x-request-id", requestId);

  const token = extractBearerToken(c.req.header("Authorization"));
  let tenantId: string | null = null;
  let userId: string | null = null;
  let roles: string[] = [];
  let claims: JwtClaims | null = null;

  if (token) {
    const result = await verifyJwt(token);
    if (result.ok) {
      const c2 = result.claims;
      tenantId = typeof c2.tid === "string" ? c2.tid : null;
      userId = typeof c2.sub === "string" ? c2.sub : null;
      roles = Array.isArray(c2.roles) ? (c2.roles as string[]) : [];
      claims = c2;
    } else {
      baseLog.warn(
        { request_id: requestId, reason: result.reason },
        "optionalAuth: jwt rejected (continuing as unauthenticated)",
      );
    }
  }

  const log = baseLog.child({
    request_id: requestId,
    tenant_id: tenantId,
    actor_user_id: userId,
  });

  if (userId) sentry.setUser({ id: userId });
  if (tenantId) sentry.setTag("tenant_id", tenantId);
  sentry.setTag("request_id", requestId);

  c.set("tenantId", tenantId);
  c.set("userId", userId);
  c.set("roles", roles);
  c.set("claims", claims);
  c.set("log", log);
  c.set("requestId", requestId);

  try {
    await next();
  } finally {
    sentry.setUser(null);
  }
};
