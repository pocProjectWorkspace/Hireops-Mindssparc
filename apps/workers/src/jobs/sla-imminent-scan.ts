import { sql as poolSql, db as poolDb } from "@hireops/db";
import { enqueueNotification } from "@hireops/notifications";
import { SLA_THRESHOLDS_HOURS } from "@hireops/sla-thresholds";
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
 *
 * AGENT-03 piggyback: a second scan in the same 15-min tick handles
 * agent_approval_requests with expired ttl_at. We piggyback rather
 * than registering a 7th worker per open-questions #26 (worker
 * registry refactor pending). Mode dispatch:
 *   - human_optional → auto-approve, resume run
 *   - human_required → clear ttl_at, status stays 'pending' (the TTL
 *     was a "show this back to me" snooze, not an auto-decide)
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
        log.error({ err: msg, recruiter: row.recruiter_membership_id }, "sla_scan.enqueue_error");
      }
    }
  }
  log.info({ scanned: rows.length }, "sla_scan.complete");

  // AGENT-03 — TTL auto-approve scan piggybacked on the same tick.
  await agentApprovalTtlScan(log);
}

/**
 * AGENT-03 TTL scan — find pending approval requests whose ttl_at has
 * passed, dispatch by the configured approval_mode.
 *
 * Cross-tenant by design (service-role poolSql); each request's
 * tenant_id stays on every write so RLS is irrelevant here. Exported
 * for direct invocation from tests so the scan can be exercised
 * without sitting on the 15-min cadence.
 */
export async function agentApprovalTtlScan(
  log: Logger,
): Promise<{ autoApproved: number; snoozeExpired: number }> {
  // One query gathers everything dispatch needs — joining to
  // agent_approval_rules through the run_action gives us the
  // approval_mode that determines the branch.
  interface ExpiredApprovalRow {
    id: string;
    tenant_id: string;
    agent_id: string;
    run_id: string;
    run_action_id: string;
    approval_mode: string | null;
    action_order: number;
  }
  const rows = await poolSql<ExpiredApprovalRow[]>`
    SELECT
      ar.id::text AS id,
      ar.tenant_id::text AS tenant_id,
      ar.agent_id::text AS agent_id,
      ar.run_id::text AS run_id,
      ar.run_action_id::text AS run_action_id,
      rule.approval_mode AS approval_mode,
      run_act.action_order::int AS action_order
    FROM public.agent_approval_requests ar
    JOIN public.agent_run_actions run_act
      ON run_act.id = ar.run_action_id AND run_act.tenant_id = ar.tenant_id
    LEFT JOIN public.agent_approval_rules rule
      ON rule.action_id = run_act.action_id AND rule.tenant_id = ar.tenant_id
    WHERE ar.status = 'pending'
      AND ar.ttl_at IS NOT NULL
      AND ar.ttl_at <= now()
  `;

  if (rows.length === 0) {
    log.info("agent_ttl_scan.no_expired");
    return { autoApproved: 0, snoozeExpired: 0 };
  }

  let autoApproved = 0;
  let snoozeExpired = 0;

  for (const row of rows) {
    try {
      if (row.approval_mode === "human_optional") {
        // Auto-approve: same writes as approveApproval, but
        // decided_by_user_id is NULL (system) and status is
        // 'auto_approved' to distinguish from explicit human approval.
        await poolSql.begin(async (tx) => {
          await tx`
            UPDATE public.agent_approval_requests
            SET status = 'auto_approved',
                decided_at = now(),
                decided_by_user_id = NULL,
                decision_notes = 'Auto-approved at TTL expiry'
            WHERE id = ${row.id}::uuid
          `;
          await tx`
            UPDATE public.agent_run_actions
            SET status = 'completed', completed_at = now()
            WHERE id = ${row.run_action_id}::uuid
          `;
          await tx`
            UPDATE public.agent_runs
            SET status = 'running'
            WHERE id = ${row.run_id}::uuid
          `;
          // Re-queue the outbox row for the worker. We don't have the
          // outbox_id directly but can match on (tenant_id, agent_id,
          // status='awaiting_approval') — one in-flight outbox per
          // (tenant, agent) is enforced de-facto by the run-resume
          // probe in agent-run-drain.
          await tx`
            UPDATE public.agent_run_outbox
            SET status = 'pending', locked_until = NULL
            WHERE tenant_id = ${row.tenant_id}::uuid
              AND agent_id = ${row.agent_id}::uuid
              AND status = 'awaiting_approval'
          `;
        });
        autoApproved += 1;
        log.info(
          { approval_request_id: row.id, run_id: row.run_id, tenant_id: row.tenant_id },
          "agent_ttl_scan.auto_approved",
        );
      } else {
        // human_required (or unknown — defensive) → TTL was a snooze.
        // Clear ttl_at, leave status='pending' so it sits in the queue
        // until a human acts.
        await poolSql`
          UPDATE public.agent_approval_requests
          SET ttl_at = NULL
          WHERE id = ${row.id}::uuid
        `;
        snoozeExpired += 1;
        log.info(
          { approval_request_id: row.id, tenant_id: row.tenant_id },
          "agent_ttl_scan.snooze_expired",
        );
      }
    } catch (err) {
      // Don't let one bad row break the scan. Log and continue — the
      // next tick re-tries because the WHERE clause stays true.
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, approval_request_id: row.id, tenant_id: row.tenant_id },
        "agent_ttl_scan.row_error",
      );
    }
  }

  log.info({ autoApproved, snoozeExpired, scanned: rows.length }, "agent_ttl_scan.complete");
  return { autoApproved, snoozeExpired };
}
