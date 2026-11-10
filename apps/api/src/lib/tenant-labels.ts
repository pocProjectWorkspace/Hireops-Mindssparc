/**
 * CFG-LITE — server-side read of a tenant's display labels
 * (`tenants.settings.labels`). The resolution rules live in
 * `@hireops/api-types` (resolveTenantLabels / resolveStageLabel); this is only
 * the DB read, on the unscoped pool with an explicit id predicate — the same
 * read discipline as resolveTenantAiSettingsDb (`tenants` is FORCE RLS with
 * SELECT-only policies, and the partner + email paths run outside a staff tx).
 *
 * NEVER THROWS: a label read sits on notification and read paths that must not
 * fail because of display wording. Any failure resolves to "no overrides",
 * i.e. the platform default wording.
 */

import { eq } from "drizzle-orm";
import { db as poolDb, tenants } from "@hireops/db";
import { defaultTenantLabels, resolveTenantLabels, type TenantLabels } from "@hireops/api-types";

export async function resolveTenantLabelsDb(
  tenantId: string | null | undefined,
  client: typeof poolDb = poolDb,
): Promise<TenantLabels> {
  if (!tenantId) return defaultTenantLabels();
  try {
    const [row] = await client
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const settings = (row?.settings ?? {}) as Record<string, unknown>;
    return resolveTenantLabels(settings["labels"]);
  } catch {
    return defaultTenantLabels();
  }
}
