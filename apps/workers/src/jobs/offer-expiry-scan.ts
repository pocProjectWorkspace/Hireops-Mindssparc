import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";

/**
 * C1-BUGS BUG-10 — expire overdue extended offers.
 *
 * The offers state machine (packages/db/src/schema/offers.ts) has always
 * documented `extended → expired (sweep job)`, but no sweep existed: an
 * overdue offer stayed `extended` forever and was only refused at accept time.
 * This is that sweep.
 *
 * One UPDATE across all tenants (service-role, the ownership-claim-sweep
 * posture), served by the partial index idx_offers_extended_expiry.
 * IDEMPOTENT: the predicate is `status = 'extended'`, so a row flips exactly
 * once and a re-run touches nothing. The `audit_offers` trigger
 * (audit_record_change) writes the audit row for every flip, as it does for
 * every other offer transition.
 *
 * Deliberately NOT done here:
 *   - no candidate notification — there is no offer-expired email template in
 *     the catalog, and inventing copy for a candidate-facing message is a
 *     product decision (add a template, then enqueue from here);
 *   - no application stage change — what happens to the application after an
 *     offer lapses (re-offer, reject) stays a recruiter decision.
 *
 * Reads do not wait for this job: effectiveOfferStatus (@hireops/api-types)
 * reports a past-expiry extended offer as expired immediately.
 */

type SqlHandle = typeof poolSql;

/**
 * Flip every past-expiry EXTENDED offer to 'expired'. Returns the flipped ids.
 * `tenantId` narrows the sweep to one tenant — the test suite uses it so it
 * never flips another tenant's offers on the shared database; the scheduled
 * job always runs cross-tenant.
 */
export async function expireOverdueOffers(
  sql: SqlHandle,
  opts: { tenantId?: string } = {},
): Promise<string[]> {
  const tenantFilter = opts.tenantId ? sql`AND tenant_id = ${opts.tenantId}` : sql``;
  const rows = await sql<{ id: string }[]>`
    UPDATE public.offers
       SET status = 'expired', updated_at = now()
     WHERE status = 'extended'
       AND expiry_at <= now()
       ${tenantFilter}
    RETURNING id
  `;
  return rows.map((r) => r.id);
}

/** ScheduledJob entrypoint. */
export async function offerExpiryScan(log: Logger): Promise<void> {
  const expired = await expireOverdueOffers(poolSql);
  log.info({ expired: expired.length }, "offer_expiry_scan.complete");
}
