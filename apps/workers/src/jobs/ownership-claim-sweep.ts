import { sql as poolSql, db as poolDb } from "@hireops/db";
import { enqueueNotification } from "@hireops/notifications";
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
 *
 * P0.4 added the WARNING half (warnExpiringOwnershipClaims, below) to this same
 * job rather than a new schedule: it reads the same table on the same cadence
 * and the two halves are the same fact seven days apart. The state machine
 * still emails nothing — every send in this file is the warning.
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

/** How far ahead of expiry the partner is warned. */
const CLAIM_EXPIRY_WARNING_DAYS = 7;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Postgres unique-violation detector (SQLSTATE 23505), driver-tolerant.
 *
 * Reads the CODE, not the message: drizzle wraps the driver error in its own
 * "Failed query: insert into …" Error, so the constraint name never appears in
 * `err.message` and a message-substring test silently never matches (which is
 * how a "swallow the dedup" branch turns into a job that throws on its second
 * run). The driver error survives as `cause`. Mirrors the api's isUniqueViolation.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

/** "20 August 2026" — date-only, UTC, matching the other partner emails. */
function formatPartnerEmailDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}`;
}

interface ExpiringClaimRow {
  claim_id: string;
  tenant_id: string;
  expires_at: Date;
  partner_email: string;
  partner_full_name: string;
  candidate_name: string | null;
  company_name: string;
}

/**
 * P0.4 — warn the claiming partner that their exclusivity window is about to
 * close.
 *
 * Without this the lapse is silent: the sweep above flips the status and the
 * partner finds out only when a resubmission comes back "duplicate blocked",
 * by which point another agency may already own the candidate. Seven days is
 * enough notice to act (push the candidate, or talk to the client).
 *
 * Scoped to claims that are still ACTIVE and expire within the window — the
 * upper bound is exclusive of already-past rows because those are the sweep's
 * business, not the warning's; warning about a window that closed yesterday
 * would be noise.
 *
 * Only claims whose claiming partner USER is known and still active get a mail:
 * a deactivated partner user has had their access revoked, so mailing them
 * candidate names would undo that. Claims with no claimed_via_partner_user_id
 * (seeded / migrated rows) have nobody to write to — org-wide fan-out would
 * mean naming a candidate to people who never handled them.
 *
 * dedupKey is `claim_expiry_warn:<claimId>`, so the warning fires ONCE per
 * claim for all time regardless of how often the 15-minute job re-runs inside
 * the seven-day window. Cross-tenant + service-role for the same reason the
 * sweep is (documented worker posture). Returns the number of warnings newly
 * enqueued.
 *
 * PRIVACY (requirements.md §6.3): candidate name + expiry date only.
 */
export async function warnExpiringOwnershipClaims(sql: SqlHandle): Promise<number> {
  const rows = await sql<ExpiringClaimRow[]>`
    SELECT c.id            AS claim_id,
           c.tenant_id::text AS tenant_id,
           c.expires_at,
           pu.email        AS partner_email,
           pu.full_name    AS partner_full_name,
           p.full_name     AS candidate_name,
           t.display_name  AS company_name
      FROM public.candidate_ownership_claims c
      JOIN public.partner_users pu
        ON pu.id = c.claimed_via_partner_user_id
       AND pu.tenant_id = c.tenant_id
       AND pu.active = true
      JOIN public.persons p
        ON p.id = c.person_id
       AND p.tenant_id = c.tenant_id
      JOIN public.tenants t
        ON t.id = c.tenant_id
     WHERE c.status = 'active'
       AND c.expires_at > now()
       AND c.expires_at <= now() + make_interval(days => ${CLAIM_EXPIRY_WARNING_DAYS})
  `;

  let warned = 0;
  for (const row of rows) {
    try {
      await enqueueNotification(poolDb, {
        tenantId: row.tenant_id,
        recipientType: "partner",
        recipientEmail: row.partner_email,
        templateKey: "partner.claim_expiry_warning",
        templateData: {
          partnerContactName: row.partner_full_name,
          candidateName: row.candidate_name ?? "your candidate",
          companyName: row.company_name,
          expiresAtFormatted: formatPartnerEmailDate(new Date(row.expires_at)),
        },
        dedupKey: `claim_expiry_warn:${row.claim_id}`,
      });
      warned += 1;
    } catch (err) {
      // The partial unique on (tenant_id, dedup_key) IS the once-ever
      // guarantee: a 23505 here means this claim was already warned about, so
      // it is the expected steady state, not a failure — swallow it and move
      // on (the ai-budget-scan / sla-imminent-scan tryEnqueue discipline).
      // Anything else is a real fault and propagates to the scheduled-job
      // runner, which logs the failed run rather than reporting a false count.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return warned;
}

/** ScheduledJob entrypoint — returns void, the counts land in the log line. */
export async function ownershipClaimSweep(log: Logger): Promise<void> {
  const expired = await sweepExpiredOwnershipClaims(poolSql);
  // Order matters: expiring the past-due rows first means the warning pass can
  // never mail about a claim that this very run has already retired.
  const warned = await warnExpiringOwnershipClaims(poolSql);
  log.info({ expired, warned }, "ownership_claim_sweep.complete");
}
