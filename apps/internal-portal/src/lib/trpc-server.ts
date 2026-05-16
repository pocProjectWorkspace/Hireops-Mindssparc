import { sql as poolSql, type JwtClaims } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter, type HonoTRPCContext } from "@hireops/api/trpc";
import type { AuthSession } from "./auth";

/**
 * In-process tRPC caller for server components. Skips the HTTP +
 * serialisation hop entirely — we hand a HonoTRPCContext to
 * appRouter.createCaller and procedures run as plain async functions.
 *
 * For protectedProcedure paths: ctx.db is left undefined here because
 * the protectedProcedure middleware (apps/api/src/trpc/trpc-core.ts)
 * opens its own withTenantContext tx per call. That tx commits when
 * the procedure resolves. We just need to populate tenantId / userId /
 * claims so the middleware's auth gate passes.
 *
 * For publicProcedure paths: ctx.sql (the unscoped poolDb client) is
 * what those procedures use. We pass that through verbatim.
 *
 * Usage in a server component:
 *   const session = await requireAuth();
 *   const caller = createServerTRPCCaller(session);
 *   const candidates = await caller.listCandidates({ ... });
 *
 * Multiple caller.* invocations from the same server-component render
 * each open their own tx (per the protectedProcedure middleware), so
 * they don't share read isolation. That's fine for a page that issues
 * one-shot reads; tickets needing transactional consistency across
 * multiple reads should pull them into a single procedure on the
 * server.
 */

const serverLogger = createLogger({ base: { service: "internal-portal" } });

export type ServerTRPCCaller = ReturnType<typeof appRouter.createCaller>;

export function createServerTRPCCaller(session: AuthSession): ServerTRPCCaller {
  const ctx: HonoTRPCContext = {
    tenantId: session.tenantId,
    userId: session.userId,
    roles: session.roles,
    claims: {
      sub: session.userId,
      tid: session.tenantId,
      roles: session.roles,
    } as JwtClaims,
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
  return `ssr-${
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  }`;
}
