import { cache } from "react";
import { sql as poolSql } from "@hireops/db";
import { resolveAiSettings } from "@hireops/api-types";
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
