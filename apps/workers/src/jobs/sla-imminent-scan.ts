import { sql as poolSql, db as poolDb } from "@hireops/db";
import type { ApplicationStage } from "@hireops/db";
import { enqueueNotification } from "@hireops/notifications";
import { SLA_BREACH_STAGES, resolveSlaThresholds } from "@hireops/sla-thresholds";
import { resolveSystemSetup, type SystemSetup } from "@hireops/api-types";
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
 * Admin System Setup consumption (G25/D1): beyond the recruiter's own
 * alert, this scan honours the tenant's `tenants.settings.systemSetup`
 * config (resolveSystemSetup):
 *   - When email alerts are ENABLED and the `sla_breach` alert type is on,
 *     the configured recipients also receive an operational SLA alert
 *     (distinct template, honest ops copy) per recruiter-with-breaches.
 *   - Escalation rules drive a separate days-based sweep (slaEscalationSweep)
 *     that notifies each rule's recipient at its severity when stages have
 *     sat past the rule's day threshold.
 * When alerts are disabled or no recipients/rules are set, nothing extra
 * fires and the recruiter's own imminent alert is the only send — the
 * pre-config behaviour. The config is no longer inert.
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
  // T4.1 — the imminent window is composed PER TENANT off each tenant's
  // RESOLVED SLA thresholds (settings.slaThresholds merged over the code
  // defaults), so a tenant SLA override genuinely shifts which applications
  // page as imminent. An unconfigured (or corrupt) tenant resolves to the
  // default map, so its branch is byte-identical to the pre-config single
  // global CASE. Load every tenant's map once for the tick.
  const thresholdsByTenant = await loadSlaThresholdsByTenant();

  // Build the SQL CASE: one branch per (tenant, non-null stage). Tenant ids
  // come from the DB (uuid literals) and stage names from the code enum map —
  // the same injection profile as the pre-config unsafe interpolation.
  const thresholdCases: string[] = [];
  for (const [tenantId, thresholds] of thresholdsByTenant) {
    for (const [stage, hours] of Object.entries(thresholds) as [
      ApplicationStage,
      number | null,
    ][]) {
      if (hours === null) continue;
      // imminent = stage entered between (threshold - window) and threshold hours ago.
      thresholdCases.push(
        `WHEN a.tenant_id = '${tenantId}'::uuid AND a.current_stage = '${stage}' AND a.stage_entered_at < now() - interval '${hours - IMMINENT_WINDOW_HOURS} hours' AND a.stage_entered_at > now() - interval '${hours} hours' THEN true`,
      );
    }
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
  const triageUrl = `${portalBase}/triage`;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Per-tenant admin System Setup (email-alert recipients, alert-type
  // toggles, escalation rules). Loaded once for the whole tick and reused
  // by both the imminent loop and the escalation sweep. resolveSystemSetup
  // owns the default-merge — we never re-derive defaults here.
  const setupByTenant = await loadSystemSetupByTenant();

  let cfgRecipientAlerts = 0;

  for (const row of rows) {
    // (1) The owning primary recruiter is ALWAYS alerted about their own
    // imminent breaches. This predates the System Setup config and stays
    // unconditional — dropping it when an admin adds an ops mailbox would
    // be a regression. The template greets them by name.
    await tryEnqueue(log, "recruiter", {
      tenantId: row.tenant_id,
      recipientType: "recruiter",
      recipientEmail: row.recruiter_email,
      recipientMembershipId: row.recruiter_membership_id,
      templateKey: "recruiter.sla_breach_imminent",
      templateData: {
        recruiterName: row.recruiter_name,
        applicationCount: row.imminent_count,
        triageUrl,
      },
      priority: 3,
      dedupKey: `sla_imminent:${row.recruiter_membership_id}:${today}`,
    });

    // (2) Additionally alert the admin-configured operational recipients,
    // but ONLY when email alerts are enabled AND the sla_breach alert type
    // is switched on. These recipients get honest ops copy (a distinct
    // template) that names the owning recruiter and why they were paged.
    const setup = setupByTenant.get(row.tenant_id);
    const emailAlerts = setup?.emailAlerts;
    if (emailAlerts?.enabled && emailAlerts.alertTypes.includes("sla_breach")) {
      const noun = row.imminent_count === 1 ? "application" : "applications";
      for (const recipient of emailAlerts.recipients) {
        await tryEnqueue(log, "cfg_recipient", {
          tenantId: row.tenant_id,
          recipientType: "recruiter",
          recipientEmail: recipient,
          templateKey: "recruiter.sla_ops_alert",
          templateData: {
            headline: `${row.imminent_count} ${noun} near SLA breach`,
            bodyLine: `${row.recruiter_name} has ${row.imminent_count} ${noun} approaching the stage SLA threshold in ${row.tenant_slug}.`,
            actionUrl: triageUrl,
            actionLabel: "Open triage board",
            reason:
              "You're receiving this because you're a configured operational alert recipient (Admin → System Setup → Email Alerts) and SLA-breach alerts are enabled.",
          },
          priority: 3,
          dedupKey: `sla_imminent_cfg:${recipient}:${row.recruiter_membership_id}:${today}`,
        });
        cfgRecipientAlerts += 1;
      }
    }
  }
  log.info({ scanned: rows.length, cfgRecipientAlerts }, "sla_scan.complete");

  // Escalation rules — a separate, deterministic days-based sweep over
  // stages that have sat too long. Consumes the same per-tenant config.
  await slaEscalationSweep(log, setupByTenant, triageUrl, today);

  // AGENT-03 — TTL auto-approve scan piggybacked on the same tick.
  await agentApprovalTtlScan(log);
}

/**
 * Load every tenant's resolved System Setup config keyed by tenant id.
 * Cross-tenant (service-role poolSql), matching the scan's own reads.
 * resolveSystemSetup merges the stored jsonb over defaults, so malformed
 * or absent blocks degrade to the safe defaults (alerts off, no rules).
 */
async function loadSystemSetupByTenant(): Promise<Map<string, SystemSetup>> {
  const rows = await poolSql<{ tenant_id: string; settings: unknown }[]>`
    SELECT id::text AS tenant_id, settings FROM public.tenants
  `;
  const map = new Map<string, SystemSetup>();
  for (const r of rows) {
    const settings = (r.settings ?? {}) as Record<string, unknown>;
    map.set(r.tenant_id, resolveSystemSetup(settings.systemSetup));
  }
  return map;
}

/**
 * T4.1 — load every tenant's RESOLVED per-stage SLA thresholds keyed by tenant
 * id. Cross-tenant (service-role poolSql), matching loadSystemSetupByTenant.
 * resolveSlaThresholds merges the stored `settings.slaThresholds` jsonb over
 * SLA_THRESHOLDS_HOURS, so a tenant with no (or corrupt) override resolves to
 * the code defaults — making its imminent-window branch byte-identical to the
 * pre-config global CASE. This is the honest tenant-resolved map the imminent
 * scan pages off, so a tenant lowering a stage's hours genuinely alerts sooner.
 */
async function loadSlaThresholdsByTenant(): Promise<
  Map<string, Record<ApplicationStage, number | null>>
> {
  const rows = await poolSql<{ tenant_id: string; settings: unknown }[]>`
    SELECT id::text AS tenant_id, settings FROM public.tenants
  `;
  const map = new Map<string, Record<ApplicationStage, number | null>>();
  for (const r of rows) {
    const settings = (r.settings ?? {}) as Record<string, unknown>;
    map.set(r.tenant_id, resolveSlaThresholds(settings.slaThresholds));
  }
  return map;
}

/**
 * Escalation sweep — for each tenant whose System Setup has email alerts
 * ENABLED and one or more escalation rules, find applications whose stage
 * has been open at least `daysThreshold` days (restricted to breach-
 * eligible, non-terminal stages) and notify the rule's recipient at the
 * rule's severity. One alert per (rule recipient, threshold) per tenant
 * per UTC day (dedup_key).
 *
 * Gated by the same master `emailAlerts.enabled` switch as the alert
 * recipients: it is the single honest on/off for operational email from
 * this config surface. When off, this sweep sends nothing — the recruiter
 * imminent alert above is the only thing that still fires.
 */
async function slaEscalationSweep(
  log: Logger,
  setupByTenant: Map<string, SystemSetup>,
  triageUrl: string,
  today: string,
): Promise<void> {
  let escalationAlerts = 0;
  for (const [tenantId, setup] of setupByTenant) {
    if (!setup.emailAlerts.enabled || setup.escalationRules.length === 0) continue;
    for (const rule of setup.escalationRules) {
      let count: number;
      try {
        const [r] = await poolSql<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM public.applications a
          WHERE a.tenant_id = ${tenantId}::uuid
            AND a.current_stage::text = ANY(${SLA_BREACH_STAGES})
            AND a.stage_entered_at < now() - make_interval(days => ${rule.daysThreshold})
        `;
        count = r?.n ?? 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, tenant_id: tenantId }, "sla_escalation.query_error");
        continue;
      }
      if (count === 0) continue;
      const noun = count === 1 ? "application" : "applications";
      await tryEnqueue(log, "escalation", {
        tenantId,
        recipientType: "recruiter",
        recipientEmail: rule.recipient,
        templateKey: "recruiter.sla_ops_alert",
        templateData: {
          headline: `${count} ${noun} open ≥ ${rule.daysThreshold} days`,
          bodyLine: `${count} ${noun} have been sitting in an active stage for at least ${rule.daysThreshold} days without progressing.`,
          severity: rule.severity,
          actionUrl: triageUrl,
          actionLabel: "Review stalled applications",
          reason: `You're receiving this because an Admin → System Setup escalation rule notifies you after ${rule.daysThreshold} days at ${rule.severity} severity.`,
        },
        priority: 3,
        dedupKey: `sla_escalation:${rule.recipient}:${rule.daysThreshold}:${today}`,
      });
      escalationAlerts += 1;
    }
  }
  if (escalationAlerts > 0) log.info({ escalationAlerts }, "sla_escalation.complete");
}

/**
 * Enqueue one notification, swallowing the dedup 23505 (already sent this
 * window) and logging any other failure without breaking the scan.
 */
async function tryEnqueue(
  log: Logger,
  kind: string,
  args: Parameters<typeof enqueueNotification>[1],
): Promise<void> {
  try {
    await enqueueNotification(poolDb, args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("uniq_notification_outbox_dedup")) {
      log.debug({ kind, recipient: args.recipientEmail }, "sla_scan.dedup_skip");
    } else {
      log.error({ err: msg, kind, recipient: args.recipientEmail }, "sla_scan.enqueue_error");
    }
  }
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
