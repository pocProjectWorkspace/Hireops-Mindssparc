import { sql as poolSql } from "@hireops/db";
import { resolveRetentionPolicy } from "@hireops/api-types";
import type { Logger } from "@hireops/observability";

/**
 * C2-F7 / PP20 — CV / talent-pool retention scan. FLAGS, NEVER DELETES.
 *
 * Daily, per ACTIVE tenant: counts candidates whose last application activity
 * is older than the tenant's `retentionPolicy.talentPoolRetentionMonths`
 * (default 24, platform ceiling 60) and who were never hired, and logs the
 * count (`cv_retention.flagged`) so ops can see a tenant accumulating stale
 * CVs. The per-candidate list is the admin register
 * (listCvsPastRetention, /admin/retention-policy) — computed live from the
 * same definition (apps/api lib/cv-retention.ts), so the register and this
 * scan cannot disagree and no flag table / migration is needed.
 *
 * Deleting or anonymising those CVs is deliberately NOT done here: erasure is
 * a later, explicit product decision (DPDP grace, legal hold, re-consent).
 */

type SqlHandle = typeof poolSql;

export interface CvRetentionScanResult {
  tenantsScanned: number;
  tenantsWithFlags: number;
  flagged: number;
  perTenant: { tenantId: string; retentionMonths: number; flagged: number }[];
}

export async function scanCvRetention(sql: SqlHandle): Promise<CvRetentionScanResult> {
  const tenants = await sql<{ id: string; settings: unknown }[]>`
    SELECT id, settings FROM public.tenants WHERE status = 'active'
  `;
  const perTenant: CvRetentionScanResult["perTenant"] = [];
  for (const t of tenants) {
    const settings =
      t.settings && typeof t.settings === "object" ? (t.settings as Record<string, unknown>) : {};
    const months = resolveRetentionPolicy(settings.retentionPolicy).talentPoolRetentionMonths;
    const [row] = await sql<{ n: number }[]>`
      WITH activity AS (
        SELECT
          c.id,
          COALESCE(MAX(a.updated_at), c.created_at) AS last_activity_at,
          BOOL_OR(a.current_stage = 'offer_accepted') AS hired
        FROM public.candidates c
        LEFT JOIN public.applications a
          ON a.tenant_id = c.tenant_id AND a.candidate_id = c.id
        WHERE c.tenant_id = ${t.id}
        GROUP BY c.id, c.created_at
      )
      SELECT COUNT(*)::int AS n
      FROM activity
      WHERE COALESCE(hired, false) = false
        AND last_activity_at < now() - make_interval(months => ${months}::int)
    `;
    perTenant.push({ tenantId: t.id, retentionMonths: months, flagged: Number(row?.n ?? 0) });
  }
  const withFlags = perTenant.filter((p) => p.flagged > 0);
  return {
    tenantsScanned: tenants.length,
    tenantsWithFlags: withFlags.length,
    flagged: withFlags.reduce((a, p) => a + p.flagged, 0),
    perTenant,
  };
}

/** ScheduledJob entrypoint. */
export async function cvRetentionScan(log: Logger): Promise<void> {
  const r = await scanCvRetention(poolSql);
  for (const p of r.perTenant) {
    if (p.flagged > 0) {
      log.info(
        { tenant_id: p.tenantId, flagged: p.flagged, retention_months: p.retentionMonths },
        "cv_retention.flagged",
      );
    }
  }
  log.info(
    {
      tenants_scanned: r.tenantsScanned,
      tenants_with_flags: r.tenantsWithFlags,
      flagged: r.flagged,
    },
    "cv_retention_scan.complete",
  );
}
