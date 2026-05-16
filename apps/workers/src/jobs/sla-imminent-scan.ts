import { sql as poolSql, db as poolDb } from "@hireops/db";
import { enqueueNotification } from "@hireops/notifications";
import { SLA_THRESHOLDS_HOURS } from "./sla-thresholds";
import type { Logger } from "@hireops/observability";

/**
 * Scan every tenant for applications approaching the per-stage SLA
 * threshold within IMMINENT_WINDOW_HOURS, group by primary_recruiter,
 * enqueue one sla-breach-imminent notification per recruiter.
 *
 * Dedup: dedup_key encodes (tenant_id, recruiter_id, date) — at most
 * one alert per recruiter per UTC day. The next day's scan emits a
 * fresh one if the same recruiter still has imminent breaches.
 *
 * Why the worker, not the api: scans are batch + recruiter-centric
 * (cross-tenant in production with multiple tenants); the api is
 * request-scoped + tenant-scoped via RLS.
 *
 * Uses poolSql (service_role) for the cross-tenant join; uses poolDb
 * for the enqueue insert. enqueueNotification doesn't require a
 * tenant-bound tx — the row's tenant_id column is the source of truth.
 */

const IMMINENT_WINDOW_HOURS = 4;

interface RawRow {
  tenant_id: string;
  recruiter_membership_id: string;
  recruiter_email: string;
  recruiter_name: string;
  imminent_count: number;
  tenant_slug: string;
}

export async function slaImminentScan(log: Logger): Promise<void> {
  // Build the SQL CASE for breach window per stage.
  const thresholdCases: string[] = [];
  for (const [stage, hours] of Object.entries(SLA_THRESHOLDS_HOURS)) {
    if (hours === null) continue;
    // imminent = stage entered between (threshold - window) and threshold hours ago.
    thresholdCases.push(
      `WHEN a.current_stage = '${stage}' AND a.stage_entered_at < now() - interval '${hours - IMMINENT_WINDOW_HOURS} hours' AND a.stage_entered_at > now() - interval '${hours} hours' THEN true`,
    );
  }
  if (thresholdCases.length === 0) {
    log.warn("sla_scan.no_thresholds_configured");
    return;
  }
  const imminentExpr = `CASE ${thresholdCases.join(" ")} ELSE false END`;

  const rows = await poolSql.unsafe<RawRow[]>(`
    SELECT
      r.tenant_id AS tenant_id,
      r.primary_recruiter_id AS recruiter_membership_id,
      au.email AS recruiter_email,
      COALESCE(u.display_name, au.email) AS recruiter_name,
      COUNT(a.id)::int AS imminent_count,
      t.slug AS tenant_slug
    FROM public.applications a
    JOIN public.requisitions r ON r.id = a.requisition_id AND r.tenant_id = a.tenant_id
    JOIN public.tenant_user_memberships tum
      ON tum.id = r.primary_recruiter_id AND tum.tenant_id = r.tenant_id
    JOIN public.tenants t ON t.id = r.tenant_id
    LEFT JOIN public.users u ON u.id = tum.user_id
    JOIN auth.users au ON au.id = tum.user_id
    WHERE ${imminentExpr}
    GROUP BY r.tenant_id, r.primary_recruiter_id, au.email, u.display_name, t.slug
    HAVING COUNT(a.id) > 0
  `);

  if (rows.length === 0) {
    log.info("sla_scan.no_imminent_breaches");
    return;
  }

  const portalBase = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002";
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  for (const row of rows) {
    try {
      await enqueueNotification(poolDb, {
        tenantId: row.tenant_id,
        recipientType: "recruiter",
        recipientEmail: row.recruiter_email,
        recipientMembershipId: row.recruiter_membership_id,
        templateKey: "recruiter.sla_breach_imminent",
        templateData: {
          recruiterName: row.recruiter_name,
          applicationCount: row.imminent_count,
          triageUrl: `${portalBase}/triage`,
        },
        priority: 3,
        dedupKey: `sla_imminent:${row.recruiter_membership_id}:${today}`,
      });
    } catch (err) {
      // Most likely 23505 from the dedup_key unique — already alerted today.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("uniq_notification_outbox_dedup")) {
        log.debug({ recruiter: row.recruiter_membership_id }, "sla_scan.dedup_skip");
      } else {
        log.error(
          { err: msg, recruiter: row.recruiter_membership_id },
          "sla_scan.enqueue_error",
        );
      }
    }
  }
  log.info({ scanned: rows.length }, "sla_scan.complete");
}
