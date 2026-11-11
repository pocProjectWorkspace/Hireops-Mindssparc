/**
 * C1-F10 — platform-console procedures (Plan A §14 / F10).
 *
 * Every procedure here except accountAccessStatus runs behind
 * platformProcedure (operator resolved server-side from the auth user id).
 * They read and change tenant METADATA only — see lib/platform/platform-ops.ts.
 * Every operator action (reads included) appends a platform_audit_log row;
 * platformWhoami is the exception (it is the console's own identity check).
 *
 * Flat names (platform*) spread into appRouter, the same pattern as
 * ./scheduling-procedures.ts.
 */

import { TRPCError } from "@trpc/server";
import {
  accountAccessStatusInputSchema,
  accountAccessStatusOutputSchema,
  isTenantActive,
  platformGetHealthOutputSchema,
  platformGetTenantInputSchema,
  platformGetTenantOutputSchema,
  platformListTenantsOutputSchema,
  platformSetTenantModulesInputSchema,
  platformSetTenantModulesOutputSchema,
  platformSetTenantStatusInputSchema,
  platformSetTenantStatusOutputSchema,
  platformWhoamiOutputSchema,
  tenantInactiveMessage,
  type AccountAccessStatusOutput,
} from "@hireops/api-types";
import {
  publicProcedure,
  platformProcedure,
  platformWriteProcedure,
  type PlatformOperatorContext,
} from "./trpc-core";
import {
  getAccountAccess,
  getPlatformHealth,
  getTenantForPlatform,
  listTenantsForPlatform,
  setTenantModules,
  setTenantStatus,
  writePlatformAudit,
  type PlatformActor,
} from "../lib/platform/platform-ops";
import { invalidateTenantAccessCache } from "../lib/platform/tenant-access";

function actorOf(op: PlatformOperatorContext, requestId: string): PlatformActor {
  return { operatorId: op.operatorId, email: op.email, requestId };
}

export const platformProcedures = {
  /** The console's identity check. FORBIDDEN for anyone who is not an active operator. */
  platformWhoami: platformProcedure.output(platformWhoamiOutputSchema).query(({ ctx }) => ({
    operatorId: ctx.platformOperator.operatorId,
    email: ctx.platformOperator.email,
    role: ctx.platformOperator.role,
    canWrite: ctx.platformOperator.canWrite,
  })),

  platformListTenants: platformProcedure
    .output(platformListTenantsOutputSchema)
    .query(async ({ ctx }) => {
      const items = await listTenantsForPlatform(ctx.sql);
      await writePlatformAudit(
        ctx.sql,
        actorOf(ctx.platformOperator, ctx.requestId),
        "tenants.list",
        null,
        { count: items.length },
      );
      return { items };
    }),

  platformGetTenant: platformProcedure
    .input(platformGetTenantInputSchema)
    .output(platformGetTenantOutputSchema)
    .query(async ({ ctx, input }) => {
      const out = await getTenantForPlatform(ctx.sql, input.tenantId);
      if (!out) throw new TRPCError({ code: "NOT_FOUND", message: "tenant_not_found" });
      await writePlatformAudit(
        ctx.sql,
        actorOf(ctx.platformOperator, ctx.requestId),
        "tenant.view",
        input.tenantId,
        {},
      );
      return out;
    }),

  platformSetTenantStatus: platformWriteProcedure
    .input(platformSetTenantStatusInputSchema)
    .output(platformSetTenantStatusOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const res = await setTenantStatus(
        ctx.sql,
        actorOf(ctx.platformOperator, ctx.requestId),
        input.tenantId,
        input.status,
        input.reason,
      );
      if (!res.ok) throw new TRPCError({ code: "NOT_FOUND", message: "tenant_not_found" });
      invalidateTenantAccessCache(input.tenantId);
      ctx.log.info(
        { tenant_id: input.tenantId, from: res.previousStatus, to: input.status },
        "platform.tenant_status_changed",
      );
      return { tenantId: input.tenantId, previousStatus: res.previousStatus, status: input.status };
    }),

  platformSetTenantModules: platformWriteProcedure
    .input(platformSetTenantModulesInputSchema)
    .output(platformSetTenantModulesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const res = await setTenantModules(
        ctx.sql,
        actorOf(ctx.platformOperator, ctx.requestId),
        input.tenantId,
        input.modules,
        input.reason,
      );
      if (!res.ok) throw new TRPCError({ code: "NOT_FOUND", message: "tenant_not_found" });
      invalidateTenantAccessCache(input.tenantId);
      return { tenantId: input.tenantId, changed: res.changed };
    }),

  platformGetHealth: platformProcedure
    .output(platformGetHealthOutputSchema)
    .query(async ({ ctx }) => {
      const out = await getPlatformHealth(ctx.sql);
      await writePlatformAudit(
        ctx.sql,
        actorOf(ctx.platformOperator, ctx.requestId),
        "health.view",
        null,
        {},
      );
      return out;
    }),

  /**
   * The sign-in doors' lifecycle check (D3). Any authenticated identity may ask
   * about ITSELF: is it a platform operator, and is its organisation active for
   * the given audience? Used right after signInWithPassword so a member of a
   * suspended tenant gets a clear "access suspended" message instead of the
   * generic wrong-door one.
   */
  accountAccessStatus: publicProcedure
    .input(accountAccessStatusInputSchema)
    .output(accountAccessStatusOutputSchema)
    .query(async ({ ctx, input }): Promise<AccountAccessStatusOutput> => {
      if (!ctx.userId) throw new TRPCError({ code: "UNAUTHORIZED" });
      const { platformOperator, statuses } = await getAccountAccess(
        ctx.sql,
        ctx.userId,
        input.audience,
      );
      if (statuses.length === 0) {
        return { platformOperator, access: "no_account", tenantStatus: null, message: null };
      }
      if (statuses.some(isTenantActive)) {
        return { platformOperator, access: "ok", tenantStatus: "active", message: null };
      }
      const tenantStatus = statuses[0] ?? null;
      return {
        platformOperator,
        access: "tenant_inactive",
        tenantStatus,
        message: tenantInactiveMessage(tenantStatus),
      };
    }),
};
