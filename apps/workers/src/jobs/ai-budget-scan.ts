import { sql as poolSql, db as poolDb } from "@hireops/db";
import { enqueueNotification } from "@hireops/notifications";
import {
  resolveAiBudget,
  resolveSystemSetup,
  crossedAiBudgetThresholds,
  aiBudgetAlertDedupKey,
  type AiBudget,
  type SystemSetup,
} from "@hireops/api-types";
import type { Logger } from "@hireops/observability";

/**
 * T5.1 / G24 — AI-budget alert scan.
 *
 * For every tenant, sum the current calendar month's AI spend off the real
 * ai_usage_logs ledger and, when the tenant has configured a monthly AI budget
 * AND opted into email alerts for the `ai_budget` type, email each configured
 * recipient once per crossed budget-threshold percent.
 *
 * Consumes TWO honest config blocks (both resolve-over-defaults, never throw):
 *   - tenants.settings.aiBudget      — the money + threshold percents (T5.1).
 *   - tenants.settings.systemSetup   — who/enabled + the `ai_budget` alert type
 *     (reuses the SAME emailAlerts machinery the SLA ops-cc uses).
 * When any part is unconfigured/off, nothing fires — the pre-config behaviour.
 *
 * SCOPE (T5.1 vs T5.1b): this scan ALERTS only. It never blocks or throttles an
 * AI call — a hard spend cap that refuses calls at 100% budget is the
 * destructive/irreversible automation, deferred as T5.1b (see admin-ops.ts),
 * exactly like T4.3 deferred the retention-erasure worker.
 *
 * Dedup: dedupKey encodes (tenant_id, YYYY-MM, pct) — at most one alert per
 * threshold per tenant per calendar month. Mirrors the sla-imminent scan's
 * dedup-key discipline. A fresh month re-arms every threshold.
 *
 * Why the worker, not the api: the scan is batch + cross-tenant (service-role
 * poolSql for the join); the api is request-scoped + tenant-scoped via RLS.
 * Registered at a 60-min cadence — AI spend accrues slowly, so a tighter tick
 * would only re-scan the same month-to-date totals. Returns void to satisfy the
 * ScheduledJob contract; the scan count + alert count land in the completion log.
 */
export async function aiBudgetScan(log: Logger): Promise<void> {
  // One cross-tenant pass loads every tenant's settings. resolveAiBudget /
  // resolveSystemSetup own the default-merge, so a malformed or absent block
  // degrades to safe defaults (alerting off) — nothing fires for an
  // unconfigured tenant.
  const rows = await poolSql<{ tenant_id: string; slug: string; settings: unknown }[]>`
    SELECT id::text AS tenant_id, slug, settings FROM public.tenants
  `;

  const portalBase = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002";
  const costsUrl = `${portalBase}/admin/costs`;
  const yearMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

  let alertsEnqueued = 0;

  for (const row of rows) {
    const settings = (row.settings ?? {}) as Record<string, unknown>;
    const budget: AiBudget = resolveAiBudget(settings.aiBudget);
    const setup: SystemSetup = resolveSystemSetup(settings.systemSetup);

    // Gate: budget alerting on, a real budget set, email alerts on, the
    // `ai_budget` alert type selected, and at least one recipient. All must
    // hold — the same honest on/off discipline as the SLA ops-alert cc.
    if (
      !budget.enabled ||
      budget.monthlyBudgetUsd <= 0 ||
      !setup.emailAlerts.enabled ||
      !setup.emailAlerts.alertTypes.includes("ai_budget") ||
      setup.emailAlerts.recipients.length === 0
    ) {
      continue;
    }

    // Month-to-date spend off the real ledger (service-role; the explicit
    // tenant_id filter makes RLS irrelevant here).
    let mtdMicros: bigint;
    try {
      const [r] = await poolSql<{ mtd: string }[]>`
        SELECT COALESCE(SUM(cost_micros), 0)::text AS mtd
        FROM public.ai_usage_logs
        WHERE tenant_id = ${row.tenant_id}::uuid
          AND created_at >= date_trunc('month', now())
      `;
      mtdMicros = BigInt(r?.mtd ?? "0");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, tenant_id: row.tenant_id }, "ai_budget_scan.query_error");
      continue;
    }

    const crossed = crossedAiBudgetThresholds(
      mtdMicros,
      budget.monthlyBudgetUsd,
      budget.alertThresholdPercents,
    );
    if (crossed.length === 0) continue;

    const mtdUsd = (Number(mtdMicros) / 1_000_000).toFixed(2);
    const budgetUsd = budget.monthlyBudgetUsd.toFixed(2);

    for (const pct of crossed) {
      for (const recipient of setup.emailAlerts.recipients) {
        await tryEnqueue(log, {
          tenantId: row.tenant_id,
          recipientType: "recruiter",
          recipientEmail: recipient,
          // Reuses the worker-composed ops-alert template (headline/body/reason
          // are composed here, so the "recruiter." key is cosmetic — the copy is
          // honest for an ops mailbox). Avoids a new render case for one email.
          templateKey: "recruiter.sla_ops_alert",
          templateData: {
            headline: `AI spend at ${pct}% of the $${budgetUsd} monthly budget`,
            bodyLine: `${row.slug}'s month-to-date AI spend is $${mtdUsd}, which has reached the ${pct}% alert mark of the $${budgetUsd} monthly AI budget.`,
            actionUrl: costsUrl,
            actionLabel: "Open AI cost dashboard",
            reason:
              "You're receiving this because you're a configured operational alert recipient (Admin → System Setup → Email Alerts) and AI-budget alerts are enabled. This is an alert only — AI features are not blocked.",
          },
          priority: 3,
          dedupKey: aiBudgetAlertDedupKey(row.tenant_id, yearMonth, pct),
        });
        alertsEnqueued += 1;
      }
    }
  }

  log.info({ tenantsScanned: rows.length, alertsEnqueued }, "ai_budget_scan.complete");
}

/**
 * Enqueue one notification, swallowing the dedup 23505 (already sent this
 * month) and logging any other failure without breaking the scan. Same
 * discipline as sla-imminent-scan's tryEnqueue.
 */
async function tryEnqueue(
  log: Logger,
  args: Parameters<typeof enqueueNotification>[1],
): Promise<void> {
  try {
    await enqueueNotification(poolDb, args);
  } catch (err) {
    // Code-based 23505 detection (P0.6): drizzle wraps the driver error in
    // "Failed query: …" so the constraint NAME never appears in message —
    // the old substring check misclassified every expected dedup as an
    // enqueue_error. The driver error survives as `cause`.
    const e = err as { code?: string; cause?: { code?: string } };
    const msg = err instanceof Error ? err.message : String(err);
    if (e?.code === "23505" || e?.cause?.code === "23505") {
      log.debug({ recipient: args.recipientEmail }, "ai_budget_scan.dedup_skip");
    } else {
      log.error({ err: msg, recipient: args.recipientEmail }, "ai_budget_scan.enqueue_error");
    }
  }
}
