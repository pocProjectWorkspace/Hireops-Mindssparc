import { sql as poolSql, type JwtClaims } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter, type HonoTRPCContext } from "@hireops/api/trpc";
import type { PartnerAuthSession } from "./auth";

/**
 * In-process tRPC caller for the partner portal's server components. Skips
 * the HTTP hop — appRouter.createCaller runs procedures as async functions.
 *
 * For partnerProcedure paths (the only ones the partner portal calls):
 * ctx.tenantId / claims are LEFT NULL/minimal on purpose. A partner-only
 * JWT has no `tid`, so partnerProcedure resolves the tenant + org + role from
 * partner_users itself (via ctx.sql, the service-role pool) and opens its own
 * withTenantContext tx with synthetic claims. We only need to hand it a
 * verified `userId` (the JWT sub) so its lookup key is set.
 *
 * Usage in a server component:
 *   const session = await requireAuth();
 *   const caller = createPartnerServerTRPCCaller(session);
 *   const me = await caller.partnerGetMe();   // throws FORBIDDEN if not a partner
 */

const serverLogger = createLogger({ base: { service: "partner-portal" } });

export type ServerTRPCCaller = ReturnType<typeof appRouter.createCaller>;

export function createPartnerServerTRPCCaller(session: PartnerAuthSession): ServerTRPCCaller {
  const ctx: HonoTRPCContext = {
    // No tenant on the context — partnerProcedure derives it from partner_users.
    tenantId: null,
    userId: session.userId,
    roles: [],
    claims: { sub: session.userId } as JwtClaims,
    db: undefined,
    sql: poolSql,
    log: serverLogger,
    requestId: makeRequestId(),
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

function makeRequestId(): string {
  return `ssr-partner-${
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  }`;
}
