import { cache } from "react";
import { sql as poolSql } from "@hireops/db";
import {
  resolveAiSettings,
  resolveLandingHref,
  resolveSystemSetup,
  resolveTenantLabels,
  resolveTenantModules,
  type PlatformModuleKey,
  type ScreeningScoreBands,
  type TenantLabels,
} from "@hireops/api-types";
import { getOptionalSession } from "./auth";

/**
 * Display settings the whole portal needs on every request, read the same way
 * lib/tenant-branding.ts reads branding: service-role pool, tenant from the
 * JWT, shared resolver, one cached query per request, never throws.
 *
 * `screeningScoreVisible` comes from `tenants.settings.aiSettings` (admin:
 * AI settings). Signed-out visitors and any failure resolve to the platform
 * default (visible), so a broken read never changes what a tenant sees.
 */
export const loadScreeningScoreVisible = cache(async (): Promise<boolean> => {
  try {
    const session = await getOptionalSession();
    if (!session) return true;

    const rows = await poolSql<{ settings: Record<string, unknown> | null }[]>`
      SELECT settings
      FROM public.tenants
      WHERE id = ${session.tenantId}
      LIMIT 1
    `;
    const block = (rows[0]?.settings ?? {})["aiSettings"];
    return resolveAiSettings(block).screeningScoreVisible;
  } catch (err) {
    if (typeof (err as { digest?: unknown } | null)?.digest === "string") throw err;
    console.warn("[tenant-ui-settings] falling back to default display settings", err);
    return true;
  }
});

/**
 * CFG-LITE / BUG-11 — the tenant's ONE set of AI screening-score cut-offs
 * (`aiSettings.screeningScoreBands`: strong / good / partial floors) that
 * every score-tier chip reads. Signed-out visitors and any failure resolve to
 * the platform default (90 / 75 / 60).
 */
export const loadScreeningScoreBands = cache(async (): Promise<ScreeningScoreBands> => {
  try {
    const session = await getOptionalSession();
    if (!session) return resolveAiSettings(undefined).screeningScoreBands;

    const rows = await poolSql<{ settings: Record<string, unknown> | null }[]>`
      SELECT settings
      FROM public.tenants
      WHERE id = ${session.tenantId}
      LIMIT 1
    `;
    return resolveAiSettings((rows[0]?.settings ?? {})["aiSettings"]).screeningScoreBands;
  } catch (err) {
    if (typeof (err as { digest?: unknown } | null)?.digest === "string") throw err;
    console.warn("[tenant-ui-settings] falling back to default score cut-offs", err);
    return resolveAiSettings(undefined).screeningScoreBands;
  }
});

/**
 * Where the signed-in user lands after sign-in: the tenant's per-role choice in
 * `tenants.settings.systemSetup.landingPages` (admin: System setup), else the
 * dashboard. Same read discipline as above; any failure lands on the dashboard.
 */
export async function loadLandingHref(): Promise<string | null> {
  try {
    const session = await getOptionalSession();
    if (!session) return null;

    const rows = await poolSql<{ settings: Record<string, unknown> | null }[]>`
      SELECT settings
      FROM public.tenants
      WHERE id = ${session.tenantId}
      LIMIT 1
    `;
    const setup = resolveSystemSetup((rows[0]?.settings ?? {})["systemSetup"]);
    return resolveLandingHref(setup, session.roles);
  } catch (err) {
    if (typeof (err as { digest?: unknown } | null)?.digest === "string") throw err;
    console.warn("[tenant-ui-settings] falling back to the dashboard landing page", err);
    return "/dashboard";
  }
}

/**
 * CFG-LITE — the tenant's display labels (`tenants.settings.labels`: stage
 * wording per audience + interview recommendation wording), normalised by the
 * shared resolver. Signed-out visitors and any failure resolve to null, which
 * every label helper treats as "platform default wording".
 */
export const loadTenantLabels = cache(async (): Promise<TenantLabels | null> => {
  try {
    const session = await getOptionalSession();
    if (!session) return null;

    const rows = await poolSql<{ settings: Record<string, unknown> | null }[]>`
      SELECT settings
      FROM public.tenants
      WHERE id = ${session.tenantId}
      LIMIT 1
    `;
    return resolveTenantLabels((rows[0]?.settings ?? {})["labels"]);
  } catch (err) {
    if (typeof (err as { digest?: unknown } | null)?.digest === "string") throw err;
    console.warn("[tenant-ui-settings] falling back to default display labels", err);
    return null;
  }
});

/**
 * C1-F10 (D4) — the signed-in tenant's module entitlements (tenant_modules;
 * a missing row means enabled), so the nav can hide modules the tenant does
 * not have. Display-only: every module's procedures enforce the same map
 * server-side. Signed-out visitors and any failure resolve to null, which the
 * nav treats as "everything enabled" (the pre-F10 behaviour).
 */
export const loadTenantModules = cache(
  async (): Promise<Record<PlatformModuleKey, boolean> | null> => {
    try {
      const session = await getOptionalSession();
      if (!session) return null;
      const rows = await poolSql<{ module_key: string; enabled: boolean }[]>`
        SELECT module_key, enabled FROM public.tenant_modules
        WHERE tenant_id = ${session.tenantId}
      `;
      return resolveTenantModules(
        rows.map((r) => ({ moduleKey: r.module_key, enabled: r.enabled })),
      );
    } catch (err) {
      if (typeof (err as { digest?: unknown } | null)?.digest === "string") throw err;
      console.warn("[tenant-ui-settings] falling back to all modules enabled", err);
      return null;
    }
  },
);
