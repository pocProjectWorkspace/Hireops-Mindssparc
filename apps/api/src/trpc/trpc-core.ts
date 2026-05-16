/**
 * tRPC initialisation, error formatter, and the two procedure builders
 * downstream routers compose with.
 *
 * Context shape (HonoTRPCContext):
 *   - tenantId / userId / claims / roles — null when caller is
 *     unauthenticated (public procedures).
 *   - db — TenantBoundDb when inside a protected procedure (the protected
 *     middleware opens withTenantContext per-call); undefined otherwise.
 *   - sql — service-role poolSql, always available for public procedures
 *     that need to touch the DB (e.g. submitApplication).
 *   - log / requestId — always set (optionalAuth middleware).
 *
 * Error shape:
 *   - Zod validation failures produce TRPC BAD_REQUEST with a flattened
 *     zodError payload on data.zodError. Frontend reads
 *     err.data.zodError.fieldErrors to render per-field messages.
 *   - Other errors flow through tRPC's default formatter unchanged.
 *
 * protectedProcedure middleware: rejects unauthenticated callers up
 * front, then opens a fresh withTenantContext({...claims}) so any DB
 * work inside the procedure runs as the `authenticated` role with the
 * right session vars (request_id, actor_user_id) for the DB-AUDIT
 * trigger. Returns next({ctx: { ...ctx, db: txDb }}).
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { ZodError } from "zod";
import { withTenantContext, sql as poolSql, type JwtClaims, type TenantBoundDb } from "@hireops/db";
import type { Logger } from "@hireops/observability";

export interface HonoTRPCContext {
  tenantId: string | null;
  userId: string | null;
  roles: string[];
  claims: JwtClaims | null;
  db: TenantBoundDb | undefined;
  sql: typeof poolSql;
  log: Logger;
  requestId: string;
  userAgent: string | null;
  ipAddress: string | null;
}

const t = initTRPC.context<HonoTRPCContext>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.code === "BAD_REQUEST" && error.cause instanceof ZodError
            ? error.cause.flatten()
            : null,
      },
    };
  },
});

export const router = t.router;

/**
 * publicProcedure — no auth check. Use for endpoints that must work
 * pre-login (apply form, public requisition view). Reaches the DB via
 * ctx.sql (service role, RLS-bypassing) and is responsible for setting
 * tenant_id correctly on every insert.
 */
export const publicProcedure = t.procedure;

/**
 * protectedProcedure — requires JWT-resolved tenantId + userId, opens a
 * withTenantContext transaction so the handler can use ctx.db with RLS
 * scoping live. tx commits when the handler resolves, rolls back on throw.
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.tenantId || !ctx.userId || !ctx.claims) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const result = await withTenantContext(
    ctx.claims,
    async ({ db }) => {
      // Re-bind ctx with the tx-scoped db. The original ctx.sql remains
      // available for the rare procedure that needs service-role access.
      return next({ ctx: { ...ctx, db } });
    },
    {
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      userAgent: ctx.userAgent,
      ipAddress: ctx.ipAddress,
      source: "app",
    },
  );
  return result;
});
