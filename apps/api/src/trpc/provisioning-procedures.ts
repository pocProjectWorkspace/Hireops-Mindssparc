/**
 * C1-F11 — tenant provisioning, starter packs, the setup wizard and config
 * export / import (Plan A §13, §14.3, §15 P7).
 *
 * Platform side (platformProcedure / platformWriteProcedure — operator
 * resolved server-side; `support` is read-only):
 *   platformListStarterPacks, platformCreateTenant, platformGetProvisioningStatus,
 *   platformRetryProvisioning, platformExportTenantConfig.
 * Tenant side (protectedProcedure + the tenant `admin` role):
 *   exportTenantConfig, previewTenantConfigImport, applyTenantConfigImport,
 *   getTenantSetup, setTenantSetupStep, setTenantSetupApprovalSkip,
 *   updateTenantSenderName, tenantGoLive.
 *
 * The tenant id always comes from the verified JWT (tenant side) or the
 * console's input after the operator gate (platform side) — never from an
 * uploaded document. Flat names spread into appRouter (scheduling precedent).
 */

import { TRPCError } from "@trpc/server";
import {
  STARTER_PACKS,
  TENANT_CONFIG_MAX_BYTES,
  applyTenantConfigImportInputSchema,
  applyTenantConfigImportOutputSchema,
  configDiffIsEmpty,
  configFingerprint,
  diffTenantConfig,
  exportTenantConfigInputSchema,
  exportTenantConfigOutputSchema,
  getTenantSetupInputSchema,
  getTenantSetupOutputSchema,
  parseTenantConfigDocument,
  platformCreateTenantInputSchema,
  platformCreateTenantOutputSchema,
  platformExportTenantConfigInputSchema,
  platformGetProvisioningStatusInputSchema,
  platformGetProvisioningStatusOutputSchema,
  platformListStarterPacksOutputSchema,
  platformRetryProvisioningInputSchema,
  platformRetryProvisioningOutputSchema,
  previewTenantConfigImportInputSchema,
  previewTenantConfigImportOutputSchema,
  setTenantSetupApprovalSkipInputSchema,
  setTenantSetupStepInputSchema,
  tenantGoLiveInputSchema,
  tenantSetupMutationOutputSchema,
  updateTenantSenderNameInputSchema,
  type ProvisioningStatus,
  type TenantConfigSectionKey,
} from "@hireops/api-types";
import {
  platformProcedure,
  platformWriteProcedure,
  protectedProcedure,
  type HonoTRPCContext,
  type PlatformOperatorContext,
} from "./trpc-core";
import { withAudit } from "./with-audit";
import { writePlatformAudit } from "../lib/platform/platform-ops";
import { getAuthAdminPort } from "../lib/platform/auth-admin-port";
import {
  ProvisioningError,
  createTenantAndProvision,
  getProvisioningStatus,
  runProvisioning,
  type ProvisioningDeps,
} from "../lib/platform/provisioning";
import {
  applyTenantConfig,
  exportTenantConfigDocument,
  readTenantConfig,
  withConfigTx,
} from "../lib/tenant-config/config-io";
import {
  getTenantSetup,
  goLive,
  setApprovalRoutingSkipped,
  setTenantSenderName,
  setTenantSetupStep,
} from "../lib/tenant-setup";

/** Tenant configuration is the tenant admin's (export, import, setup wizard). */
export const TENANT_CONFIG_ADMIN_ROLES = new Set(["admin"]);

function requireTenantAdmin(ctx: HonoTRPCContext, message: string): string {
  if (!ctx.roles.some((r) => TENANT_CONFIG_ADMIN_ROLES.has(r))) {
    throw new TRPCError({ code: "FORBIDDEN", message });
  }
  if (!ctx.tenantId)
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
  return ctx.tenantId;
}

function deps(
  ctx: HonoTRPCContext & { platformOperator: PlatformOperatorContext },
): ProvisioningDeps {
  return {
    sql: ctx.sql,
    authAdmin: getAuthAdminPort(),
    actor: {
      operatorId: ctx.platformOperator.operatorId,
      email: ctx.platformOperator.email,
      requestId: ctx.requestId,
      userId: ctx.userId,
    },
  };
}

async function statusOrThrow(
  sql: HonoTRPCContext["sql"],
  tenantId: string,
): Promise<ProvisioningStatus> {
  const s = await getProvisioningStatus(sql, tenantId);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "provisioning_job_not_found" });
  return s;
}

function parseOrThrow(raw: unknown) {
  const size = JSON.stringify(raw ?? null).length;
  if (size > TENANT_CONFIG_MAX_BYTES) {
    return { ok: false as const, error: "The configuration file is too large." };
  }
  return parseTenantConfigDocument(raw);
}

export const provisioningProcedures = {
  // ───────────────────────── platform ─────────────────────────

  platformListStarterPacks: platformProcedure
    .output(platformListStarterPacksOutputSchema)
    .query(() => ({
      packs: STARTER_PACKS.map((p) => ({
        key: p.key,
        version: p.version,
        label: p.label,
        description: p.description,
        defaultRegion: p.defaultRegion,
        modules: p.modules as Record<string, boolean>,
        contents: Object.fromEntries(
          Object.entries(p.config).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0,
          ]),
        ),
      })),
    })),

  platformCreateTenant: platformWriteProcedure
    .input(platformCreateTenantInputSchema)
    .output(platformCreateTenantOutputSchema)
    .mutation(async ({ ctx, input }) => {
      let tenantId: string;
      try {
        tenantId = await createTenantAndProvision(deps(ctx), input);
      } catch (err) {
        if (err instanceof ProvisioningError) {
          throw new TRPCError({
            code: err.code === "slug_taken" ? "CONFLICT" : "BAD_REQUEST",
            message: err.code,
          });
        }
        throw err;
      }
      const status = await statusOrThrow(ctx.sql, tenantId);
      ctx.log.info(
        { tenant_id: tenantId, job_status: status.jobStatus },
        "platform.tenant_provisioned",
      );
      return status;
    }),

  platformGetProvisioningStatus: platformProcedure
    .input(platformGetProvisioningStatusInputSchema)
    .output(platformGetProvisioningStatusOutputSchema)
    .query(async ({ ctx, input }) => ({
      status: await getProvisioningStatus(ctx.sql, input.tenantId),
    })),

  platformRetryProvisioning: platformWriteProcedure
    .input(platformRetryProvisioningInputSchema)
    .output(platformRetryProvisioningOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await statusOrThrow(ctx.sql, input.tenantId);
      await writePlatformAudit(
        ctx.sql,
        deps(ctx).actor,
        "tenant.provision.retry",
        input.tenantId,
        {},
      );
      await runProvisioning(deps(ctx), input.tenantId);
      return statusOrThrow(ctx.sql, input.tenantId);
    }),

  /**
   * Operator export of a tenant's CONFIGURATION (no people / candidate data,
   * no secrets). A write-role action (owner / operator, not support) because
   * it reads tenant configuration rather than registry metadata. Audited.
   */
  platformExportTenantConfig: platformWriteProcedure
    .input(platformExportTenantConfigInputSchema)
    .output(exportTenantConfigOutputSchema)
    .query(async ({ ctx, input }) => {
      const [t] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM public.tenants WHERE id = ${input.tenantId}
      `;
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "tenant_not_found" });
      const out = await exportTenantConfigDocument(ctx.sql, input.tenantId);
      await writePlatformAudit(ctx.sql, deps(ctx).actor, "tenant.config_export", input.tenantId, {
        sections: Object.keys(out.document.sections).length,
      });
      return out;
    }),

  // ───────────────────────── tenant: export / import ─────────────────────────

  exportTenantConfig: protectedProcedure
    .input(exportTenantConfigInputSchema)
    .output(exportTenantConfigOutputSchema)
    .query(async ({ ctx }) => {
      const tenantId = requireTenantAdmin(ctx, "Exporting the configuration is admin-only");
      return withAudit("export_tenant_config", ctx, {}, () =>
        exportTenantConfigDocument(ctx.sql, tenantId),
      );
    }),

  previewTenantConfigImport: protectedProcedure
    .input(previewTenantConfigImportInputSchema)
    .output(previewTenantConfigImportOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const tenantId = requireTenantAdmin(ctx, "Importing a configuration is admin-only");
      const parsed = parseOrThrow(input.document);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error, diff: [], empty: true, fingerprint: null };
      }
      const current = await readTenantConfig(ctx.sql, tenantId);
      const diff = diffTenantConfig(current.sections, parsed.document.sections, "replace");
      return {
        ok: true,
        error: null,
        diff,
        empty: configDiffIsEmpty(diff),
        fingerprint: configFingerprint(input.document),
      };
    }),

  applyTenantConfigImport: protectedProcedure
    .input(applyTenantConfigImportInputSchema)
    .output(applyTenantConfigImportOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const tenantId = requireTenantAdmin(ctx, "Importing a configuration is admin-only");
      const parsed = parseOrThrow(input.document);
      if (!parsed.ok) throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error });
      if (configFingerprint(input.document) !== input.fingerprint) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This is not the file that was previewed. Run the dry run again.",
        });
      }
      const doc = parsed.document;
      return withAudit(
        "apply_tenant_config_import",
        ctx,
        { fingerprint: input.fingerprint, sections: Object.keys(doc.sections) },
        async () => {
          const res = await withConfigTx(
            ctx.sql,
            { userId: ctx.userId, requestId: ctx.requestId, source: "app" },
            (tx) => applyTenantConfig(tx, tenantId, doc.sections, "replace"),
          );
          const sections = res.diff.map((d) => d.section as TenantConfigSectionKey);
          ctx.log.info({ tenant_id: tenantId, sections }, "tenant.config_imported");
          return { applied: res.diff, skipped: res.skipped };
        },
      );
    }),

  // ───────────────────────── tenant: setup wizard ─────────────────────────

  getTenantSetup: protectedProcedure
    .input(getTenantSetupInputSchema)
    .output(getTenantSetupOutputSchema)
    .query(async ({ ctx }) => {
      const tenantId = requireTenantAdmin(ctx, "Tenant setup is admin-only");
      return getTenantSetup(ctx.sql, tenantId);
    }),

  setTenantSetupStep: protectedProcedure
    .input(setTenantSetupStepInputSchema)
    .output(tenantSetupMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const tenantId = requireTenantAdmin(ctx, "Tenant setup is admin-only");
      return withAudit("set_tenant_setup_step", ctx, input, async () => {
        await setTenantSetupStep(ctx.sql, tenantId, input.step, input.complete);
        return getTenantSetup(ctx.sql, tenantId);
      });
    }),

  setTenantSetupApprovalSkip: protectedProcedure
    .input(setTenantSetupApprovalSkipInputSchema)
    .output(tenantSetupMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const tenantId = requireTenantAdmin(ctx, "Tenant setup is admin-only");
      return withAudit("set_tenant_setup_approval_skip", ctx, input, async () => {
        await setApprovalRoutingSkipped(ctx.sql, tenantId, input.skipped);
        return getTenantSetup(ctx.sql, tenantId);
      });
    }),

  updateTenantSenderName: protectedProcedure
    .input(updateTenantSenderNameInputSchema)
    .output(tenantSetupMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const tenantId = requireTenantAdmin(ctx, "Tenant setup is admin-only");
      return withAudit("update_tenant_sender_name", ctx, input, async () => {
        await setTenantSenderName(ctx.sql, tenantId, input.senderName);
        return getTenantSetup(ctx.sql, tenantId);
      });
    }),

  tenantGoLive: protectedProcedure
    .input(tenantGoLiveInputSchema)
    .output(tenantSetupMutationOutputSchema)
    .mutation(async ({ ctx }) => {
      const tenantId = requireTenantAdmin(ctx, "Tenant setup is admin-only");
      return withAudit("tenant_go_live", ctx, {}, async () => {
        const res = await goLive(ctx.sql, tenantId);
        if (!res.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `go_live_blocked: ${res.failing.map((c) => c.key).join(", ")}`,
          });
        }
        return getTenantSetup(ctx.sql, tenantId);
      });
    }),
};
