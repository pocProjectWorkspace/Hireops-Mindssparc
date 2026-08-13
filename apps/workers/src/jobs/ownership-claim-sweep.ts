import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";

/**
 * P0.3 — candidate-ownership-claim expiry sweep.
 *
 * THE sweep the candidate_ownership_claims schema header calls load-bearing.
 * The one-active-claim-per-person guarantee is a PARTIAL UNIQUE index whose
 * predicate is `status = 'active'` and nothing more, because Postgres rejects
 * non-IMMUTABLE functions like now() in a partial-index predicate. So a row
 * that is past its expires_at but still says status='active' keeps holding the
 * slot: partnerSubmitCandidate reads status='active', answers
 * duplicate_blocked, and the candidate can never be re-submitted by anyone.
 * Until this job existed, nothing ever flipped that status — an expired claim
 * blocked the person forever (apps/api/test/db-partner-a.test.ts Test 5
 * documents exactly that). Flipping the status here is what makes the 90-day
 * window actually end.
 *
 * One UPDATE, no per-tenant loop: the predicate is (status, expires_at) only,
 * both tenant-agnostic columns, and idx_claims_active_expiry is the partial
 * index that serves it. Deliberately service-role (poolSql) and cross-tenant —
 * the documented worker posture (see ai-budget-scan / sla-imminent-scan): a
 * scan is batch and tenant-independent, whereas the api is request-scoped and
 * RLS-bound. The audit trigger on the table records each flip, so the status
 * change stays visible for partner-attribution disputes.
 *
 * Deliberately narrow: only active → expired. Released and superseded rows are
 * terminal states somebody chose, and re-stamping them would rewrite history.
 * Nothing is emailed from here — the "your claim expires soon" warning is its
 * own ticket (P0.4); this job is the state machine only.
 *
 * Cadence: 15 minutes, matching the sla / stage-stale scans. Expiry boundaries
 * don't need to-the-second accuracy (the schema header says daily would do),
 * but a tighter tick costs one indexed UPDATE that usually touches no rows,
 * and it keeps the "resubmit after expiry" demo path responsive.
 */

/**
 * The service-role postgres handle. Taken as a parameter (rather than closing
 * over poolSql) so the api test suite can drive the sweep against its own
 * handle — the same run-vs-helper split the other jobs use.
 */
type SqlHandle = typeof poolSql;

/**
 * Flip every past-expiry ACTIVE claim to 'expired', across all tenants.
 * Returns the number of rows flipped.
 */
export async function sweepExpiredOwnershipClaims(sql: SqlHandle): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE public.candidate_ownership_claims
       SET status = 'expired'
     WHERE status = 'active'
       AND expires_at <= now()
    RETURNING id
  `;
  return rows.length;
}

/** ScheduledJob entrypoint — returns void, the count lands in the log line. */
export async function ownershipClaimSweep(log: Logger): Promise<void> {
  const expired = await sweepExpiredOwnershipClaims(poolSql);
  log.info({ expired }, "ownership_claim_sweep.complete");
}
