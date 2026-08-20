import { sql as poolSql, db as poolDb } from "@hireops/db";
import { enqueueNotification } from "@hireops/notifications";
import {
  resolveReportDigests,
  digestPeriod,
  shouldSendDigest,
  reportDigestDedupKey,
  type ReportDigests,
  type DigestPeriod,
  type ReportDigestCadence,
} from "@hireops/api-types";
import { getExecutiveSummaryReport } from "@hireops/api/reports/executive-summary";
import type { Logger } from "@hireops/observability";

/**
 * R1.5a — scheduled report digest scan.
 *
 * For every tenant that opted in (Admin → Report digests), email the nominated
 * mailboxes the executive board pack's headline numbers for the period that
 * just CLOSED — last ISO week, or last calendar month.
 *
 * NO NEW TABLE, NO MIGRATION. The notification outbox's partial UNIQUE on
 * (tenant_id, dedup_key) IS the idempotency mechanism: the key names the closed
 * period (`report_digest:<tenantId>:<cadence>:<periodKey>`), not the tick that
 * noticed it, so the second attempt is a 23505 and a MISSED TICK SELF-HEALS —
 * the next tick recomputes the same period, builds the same key, and sends late
 * exactly once. Nothing records that a send was owed, because nothing needs to.
 * The full argument lives next to the config block in
 * packages/api-types/src/admin-ops.ts.
 *
 * WHY THE REPORT LIB RATHER THAN NEW SQL: the digest COMPOSES, it does not
 * compute. `getExecutiveSummaryReport` is the same function the /reports board
 * pack calls, so an emailed number can never drift from the number a sponsor
 * sees when they click through. That is worth the cross-app import (a narrow
 * `@hireops/api/reports/executive-summary` subpath export) far more than a
 * second, subtly-different implementation of "hires this month" would be.
 *
 * WHY A PLAIN TRANSACTION, NOT withTenantContext: `withTenantContext` needs JWT
 * claims to set `request.jwt.claims` + `SET LOCAL ROLE authenticated`, and a
 * worker has no JWT. What makes the service-role read safe here is that every
 * report lib carries an EXPLICIT `tenant_id` predicate and takes `tenantId` as a
 * parameter — RLS is belt to that braces, and the braces are still on. Same
 * discipline as the ai-budget scan's cross-tenant ledger read.
 *
 * Why the worker, not the api: the scan is batch + cross-tenant (service-role
 * poolSql over `tenants`); the api is request-scoped and tenant-scoped.
 * Registered at a 30-min cadence — see the note in index.ts. Returns void to
 * satisfy the ScheduledJob contract; the counts land in the completion log.
 */
export async function reportDigestScan(log: Logger): Promise<void> {
  // One cross-tenant pass loads every tenant's settings. resolveReportDigests
  // owns the default-merge, so a malformed or absent block degrades to safe
  // defaults (digests off) — nothing fires for an unconfigured tenant.
  const rows = await poolSql<
    { tenant_id: string; slug: string; display_name: string; settings: unknown }[]
  >`
    SELECT id::text AS tenant_id, slug, display_name, settings FROM public.tenants
  `;

  const portalBase = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002";
  const reportsUrl = `${portalBase}/reports`;
  const now = new Date();

  let digestsEnqueued = 0;

  for (const row of rows) {
    const settings = (row.settings ?? {}) as Record<string, unknown>;
    const cfg: ReportDigests = resolveReportDigests(settings.reportDigests);

    // Gate: digests on, at least one recipient, and the send hour for the
    // just-closed period has arrived. All three must hold — the same honest
    // on/off discipline as the AI-budget and SLA ops-cc scans.
    if (
      !cfg.enabled ||
      cfg.recipients.length === 0 ||
      !shouldSendDigest(cfg.cadence, now, cfg.sendHourUtc)
    ) {
      continue;
    }

    const period = digestPeriod(cfg.cadence, now);

    // The report reads the closed window on the same inclusive bounds the
    // /reports filter bar uses. ISO strings, never a JS Date — postgres-js
    // cannot serialize a Date as a raw text parameter (reality #113).
    const filters = { from: period.from.toISOString(), to: period.to.toISOString() };

    let headline: Awaited<ReturnType<typeof getExecutiveSummaryReport>>["headline"];
    try {
      const report = await poolDb.transaction(async (tx) =>
        // `isAdmin: false` is MANDATORY, not a default: it suppresses the AI
        // spend / governance block, which is admin-only everywhere else in the
        // product. Digest recipients are arbitrary mailboxes an admin typed
        // into a settings form, so widening that gate here would leak AI cost
        // data to whoever is on the list.
        getExecutiveSummaryReport(tx, row.tenant_id, filters, { isAdmin: false }),
      );
      headline = report.headline;
    } catch (err) {
      // One tenant's bad data must not kill the scan for everyone else — same
      // continue-on-error path as the budget scan's query error branch.
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, tenant_id: row.tenant_id, period: period.periodKey },
        "report_digest_scan.report_error",
      );
      continue;
    }

    const periodLabel = formatPeriodLabel(cfg.cadence, period);

    for (const recipient of cfg.recipients) {
      const enqueued = await tryEnqueue(log, {
        tenantId: row.tenant_id,
        recipientType: "recruiter",
        recipientEmail: recipient,
        templateKey: "recruiter.report_digest",
        templateData: {
          companyName: row.display_name || row.slug,
          periodLabel,
          cadenceLabel: cfg.cadence,
          hires: headline.hires,
          applications: headline.applications,
          activePipeline: headline.activePipeline,
          offerAcceptanceRatePct: headline.offerAcceptanceRate,
          medianTimeToFillDays: headline.medianTimeToFill,
          oldestOpenReqDays: headline.oldestOpenReqDays,
          actionUrl: reportsUrl,
          reason:
            "You're receiving this because your address is configured to receive scheduled report digests (Admin → Report digests). These are the same figures the executive summary report shows for this period.",
        },
        // 6 = just below the default 5, per the enqueue contract's "6..9 for
        // non-urgent batches". A digest about a closed period is never urgent.
        priority: 6,
        // The whole idempotency story, in one field: at most one digest per
        // (tenant, recipient, cadence, closed period). The recipient leg is
        // what makes the fan-out actually fan out — see reportDigestDedupKey.
        dedupKey: reportDigestDedupKey(row.tenant_id, recipient, cfg.cadence, period.periodKey),
      });
      // Count real enqueues only. Counting attempts would make the completion
      // log claim a fan-out that a re-tick (every row deduped) never performed.
      if (enqueued) digestsEnqueued += 1;
    }
  }

  log.info({ tenantsScanned: rows.length, digestsEnqueued }, "report_digest_scan.complete");
}

/**
 * Human period label for the email. Weekly reads as a date range because "week
 * 33" means nothing to a sponsor; monthly reads as the month name. UTC
 * throughout, matching the window the numbers were computed over — a label on a
 * different clock from its own figures is how a digest starts arguing with
 * itself.
 */
function formatPeriodLabel(cadence: ReportDigestCadence, period: DigestPeriod): string {
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(d);
  if (cadence === "monthly") {
    return fmt(period.from, { month: "long", year: "numeric" });
  }
  const sameMonth = period.from.getUTCMonth() === period.to.getUTCMonth();
  const fromPart = sameMonth
    ? fmt(period.from, { day: "numeric" })
    : fmt(period.from, { day: "numeric", month: "long" });
  return `${fromPart}–${fmt(period.to, { day: "numeric", month: "long", year: "numeric" })}`;
}

/**
 * Enqueue one notification, swallowing the dedup 23505 (this recipient's digest
 * for this period is already in the outbox) and logging any other failure
 * without breaking the scan. Same discipline as ai-budget-scan's tryEnqueue.
 *
 * Returns true only when a row was actually inserted, so the caller's completion
 * count reflects real sends rather than attempts — on a re-tick every recipient
 * dedups and the honest answer is zero.
 */
async function tryEnqueue(
  log: Logger,
  args: Parameters<typeof enqueueNotification>[1],
): Promise<boolean> {
  try {
    await enqueueNotification(poolDb, args);
    return true;
  } catch (err) {
    // Code-based 23505 detection (P0.6): drizzle wraps the driver error in
    // "Failed query: …" so the constraint NAME never appears in message —
    // a substring check misclassifies every expected dedup as an
    // enqueue_error. The driver error survives as `cause`.
    const e = err as { code?: string; cause?: { code?: string } };
    const msg = err instanceof Error ? err.message : String(err);
    if (e?.code === "23505" || e?.cause?.code === "23505") {
      log.debug({ recipient: args.recipientEmail }, "report_digest_scan.dedup_skip");
    } else {
      log.error({ err: msg, recipient: args.recipientEmail }, "report_digest_scan.enqueue_error");
    }
    return false;
  }
}
