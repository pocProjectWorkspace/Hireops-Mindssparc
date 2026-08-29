import { cache } from "react";
import { sql as poolSql } from "@hireops/db";
import { resolveBrandingSettings } from "@hireops/api-types";
import { getOptionalSession } from "./auth";

/**
 * BRAND-1 — the signed-in tenant's branding for the app chrome (the sidebar
 * wordmark). Post-login the tenant IS known, so the chrome shows the tenant's
 * own mark and name rather than the product's.
 *
 * WHERE THE DATA COMES FROM. Exactly the two homes packages/api-types'
 * branding.ts documents, read through the same lens the api's
 * `getTenantBranding` procedure uses:
 *   - `tenants.display_name` (a COLUMN) — the company name, the same value
 *     candidate-facing chrome reads as `tenantDisplayName`.
 *   - `tenants.settings.branding` (a jsonb key) — the cosmetic block, run
 *     through the shared `resolveBrandingSettings()` resolver so a stale or
 *     partial blob degrades to defaults instead of throwing.
 *
 * WHY NOT CALL `getTenantBranding` DIRECTLY. That procedure is admin-gated
 * (`requireAnyRole(ctx, USERS_ADMIN_ROLES, "Branding is admin-only")`) because
 * it backs the /admin/branding editor. Chrome has to render for every signed-in
 * role — a recruiter would get FORBIDDEN and see un-branded chrome, which is
 * the exact complaint this ticket is fixing. So this reads the same row
 * directly, using the same shared resolver, the same service-role pool, and
 * the same `WHERE id = <tenant from the JWT>` predicate that procedure uses.
 * (`tenants` is FORCE RLS with SELECT-only policies, hence the pool client.)
 * The clean follow-up is a non-admin `getTenantChrome` procedure in apps/api
 * that this loader would then call — out of scope for BRAND-1's file fence.
 *
 * SAFETY. Tenant isolation comes from the JWT's `tid`; no caller-supplied id
 * is ever used. Nothing here can throw: any failure resolves to `null`, which
 * renders today's HireOps chrome. `cache()` makes it one query per request no
 * matter how many components ask.
 */
export interface ChromeBranding {
  /** `tenants.display_name` — the tenant's company name. */
  displayName: string;
  /** `settings.branding.logoUrl`, or null when the tenant set no logo. */
  logoUrl: string | null;
}

export const loadChromeBranding = cache(async (): Promise<ChromeBranding | null> => {
  try {
    const session = await getOptionalSession();
    if (!session) return null;

    const rows = await poolSql<
      { display_name: string; settings: Record<string, unknown> | null }[]
    >`
      SELECT display_name, settings
      FROM public.tenants
      WHERE id = ${session.tenantId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;

    // "Branded" means the tenant has actually written a branding block (i.e.
    // someone configured Theme & branding). A tenant that never has resolves
    // to null here and keeps today's HireOps mark + wordmark, byte-identical.
    const block = (row.settings ?? {})["branding"];
    if (!block || typeof block !== "object" || Array.isArray(block)) return null;

    const branding = resolveBrandingSettings(block);
    return { displayName: row.display_name, logoUrl: branding.logoUrl };
  } catch (err) {
    // Next signals "this render cannot be static" by THROWING out of cookies()
    // (digest DYNAMIC_SERVER_USAGE), and redirect()/notFound() throw the same
    // way. Swallowing those would defeat the framework; only real failures
    // (DB down, malformed JWT) may fall through to the default chrome.
    if (typeof (err as { digest?: unknown } | null)?.digest === "string") throw err;
    console.warn("[tenant-branding] falling back to default chrome branding", err);
    return null;
  }
});
