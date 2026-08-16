/**
 * Catalog report #9 — INTERVIEW & SCORECARD HEALTH (R1.2).
 *
 * "Are we actually running the interviews we book, and do the panelists ever
 * write them up?" — the fourth sponsor question, and the one the platform
 * could not answer at all until migration 0115: `interviews.status` said WHAT
 * had happened and never WHEN, so every cycle time through the interview
 * stage was unmeasurable.
 *
 * THE DEFINITIONS THAT MATTER (each restated on the wire schema):
 *
 *   - THE PERIOD AXIS is `interviews.scheduled_start` — "interviews that were
 *     DUE to happen in this window". Not booked-at (which would put a round
 *     booked in March for April in the March column) and not completed-at
 *     (which would make "scheduled 40 / completed 31" two disjoint
 *     populations that cannot be read as one sentence). The column is
 *     nullable, so an interview with no start time cannot be placed on the
 *     axis at all: it drops out of ANY windowed view, and is counted only
 *     when no window is set. That is stated rather than papered over with a
 *     COALESCE onto created_at, which would invent a date.
 *
 *   - COMPLETION RATE is completed / (completed + cancelled + no_show) — the
 *     share of interviews that RESOLVED and resolved by happening. Rounds
 *     still at `scheduled` are deliberately outside the denominator, INCLUDING
 *     ones whose start time has passed. The tempting "past its end and still
 *     scheduled counts as a miss" reading was rejected: it would make the
 *     headline rate a function of how far ahead the tenant books and of how
 *     promptly recruiters close rounds out, i.e. of two things that are not
 *     the measure. What the honest version costs: a tenant that never marks
 *     anything complete shows a high rate over a tiny denominator, so the
 *     surface prints the counts next to the rate.
 *
 *   - MEDIAN HOURS TO FEEDBACK is `interview_feedback.submitted_at` −
 *     `interviews.completed_at`, over every SUBMITTED SCORECARD whose
 *     interview carries a completion stamp. One observation per scorecard,
 *     not per interview — a three-panelist round contributes three, which is
 *     right, because the thing being measured is a panelist's write-up
 *     latency. Clamped at zero (a scorecard submitted before the recruiter
 *     got round to flipping the status is a bookkeeping artefact, not
 *     negative time), and `feedbackPairs` publishes the population.
 *
 *     THE 0115 CAVEAT, said out loud here and on the surface: `completed_at`
 *     did not exist before migration 0115. That migration BACKFILLED older
 *     rows as `COALESCE(scheduled_end, updated_at)`, so for any interview
 *     completed before 0115 this figure is an approximation — and where a
 *     finished interview sat un-actioned for days before someone flipped its
 *     status, the approximation is wrong in a knowable direction (it reads
 *     the write-up as faster than it was, because updated_at is late).
 *     Interviews completed after 0115 carry a real stamp written by
 *     completeInterview.
 *
 *   - SCORECARD COMPLETION is expectation vs delivery over the COMPLETED
 *     interviews in the window: one expected scorecard per (interview ×
 *     panelist) from `interview_panelists`, met by an `interview_feedback`
 *     row with a `submitted_at`. A DRAFT does not count — the recruiter
 *     cannot read a draft, so from the report's point of view it is nothing.
 *     An interview completed with an empty panel expects nothing and cannot
 *     drag the rate down (completeInterview's force path allows exactly that
 *     case).
 *
 *   - LAGGARDS are the same slots, grouped by panelist and counted where
 *     nothing was submitted: "this person owes N write-ups". Worst ten.
 *     Membership DISPLAY NAMES are not resolved here — `public.users` is
 *     self-only under RLS, so a name join on the tenant-bound db would return
 *     the caller's own name and nulls for everyone else; the router attaches
 *     them through the service-role connection (resolveMembershipNames), the
 *     same way the aging and approval reports do.
 *
 *   - BY ROUND groups on `round_name`, which is FREE TEXT stamped from the
 *     interview plan, not an enum. So the rows are whatever the tenant's
 *     plans call their rounds, there is no canonical order to zero-fill
 *     against, and a plan rename produces two rows rather than merging
 *     history under the new label. Busiest first, then name A→Z.
 *
 * Filters: period · businessUnitId · requisitionId. Both dimensions resolve
 * through the interview's OWN `requisition_id` — denormalised onto the row
 * precisely so panel-side reads need no application join (see the schema
 * header) — then requisitions → positions for the business unit. So a BU
 * filter here means byte-identically what it means on the aging report.
 * recruiterMembershipId / source / stage are N/A and IGNORED rather than
 * half-applied: an interview has a panel, not a recruiter, and source/stage
 * are application attributes whose application may have moved on since the
 * round was booked — applying them would silently redefine the funnel.
 *
 * House conventions inherited from R0.1/R0.2 — do not diverge: raw SQL at
 * request time inside the protected procedure's tenant transaction, an
 * explicit `tenant_id` predicate on top of RLS, ISO strings with
 * `::timestamptz` casts (never a JS Date — postgres-js cannot serialize one
 * as a raw text parameter), percentiles in Postgres, ratios in JS.
 */

import { sql as dsql, type SQL } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import type {
  InterviewHealthLaggard,
  InterviewHealthRoundRow,
  InterviewHealthTotals,
  ReportFilters,
} from "@hireops/api-types";

/**
 * The four `interviews.status` values (text + CHECK, not a pgEnum). Kept as a
 * named constant because three separate FILTER lists below have to agree with
 * it — and with the DB constraint.
 */
export const INTERVIEW_STATUSES: readonly string[] = [
  "scheduled",
  "completed",
  "cancelled",
  "no_show",
];

/** How many owing panelists the report names. Mirrors BOTTLENECK_APPROVER_LIMIT. */
export const SCORECARD_LAGGARD_LIMIT = 10;

/** The laggard row minus the display name the router attaches. */
export type InterviewHealthLaggardBase = Omit<InterviewHealthLaggard, "panelistName">;

export interface InterviewHealthScorecardCompletionBase {
  interviewsCompleted: number;
  expectedScorecards: number;
  submittedScorecards: number;
  completionRate: number | null;
  laggards: InterviewHealthLaggardBase[];
}

export interface InterviewHealthReport {
  totals: InterviewHealthTotals;
  scorecardCompletion: InterviewHealthScorecardCompletionBase;
  byRound: InterviewHealthRoundRow[];
}

/** postgres-js returns `{rows: …}`; fall back to the array form (matches measures.ts). */
function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

/**
 * A count against a denominator as a 1dp percentage; null when there is
 * nothing to divide by. Same contract as the scorecard's `ratePct` — a rate
 * over an empty set is unknown, not zero.
 */
function ratePct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

interface TotalsSqlRow {
  scheduled: number;
  completed: number;
  cancelled: number;
  no_show: number;
  total: number;
  median_hours_to_feedback: number | null;
  feedback_pairs: number;
}
interface ScorecardSqlRow {
  interviews_completed: number;
  expected_scorecards: number;
  submitted_scorecards: number;
}
interface LaggardSqlRow {
  membership_id: string;
  outstanding: number;
}
interface RoundSqlRow {
  round_name: string;
  total: number;
  scheduled: number;
  completed: number;
  cancelled: number;
  no_show: number;
  median_hours_to_feedback: number | null;
}

/**
 * The interviews in scope — the one predicate every part of this report hangs
 * off, emitted as a leading `WITH scoped AS (…)` so each statement below
 * starts from exactly the same population.
 *
 * The requisition → position join is CONDITIONAL on the BU filter: it is the
 * only dimension that needs the extra hops, and an interview already carries
 * its own `requisition_id`, so the requisitionId filter costs no join at all.
 */
function scopedInterviewsCte(tenantId: string, filters: ReportFilters): SQL {
  const clauses: SQL[] = [dsql`i.tenant_id = ${tenantId}::uuid`];

  // The period axis — see the header for why it is scheduled_start.
  if (filters.from) clauses.push(dsql`i.scheduled_start >= ${filters.from}::timestamptz`);
  if (filters.to) clauses.push(dsql`i.scheduled_start <= ${filters.to}::timestamptz`);
  if (filters.requisitionId) clauses.push(dsql`i.requisition_id = ${filters.requisitionId}::uuid`);

  let join: SQL = dsql``;
  if (filters.businessUnitId) {
    join = dsql`
      JOIN public.requisitions r
        ON r.tenant_id = i.tenant_id AND r.id = i.requisition_id
      JOIN public.positions p
        ON p.tenant_id = r.tenant_id AND p.id = r.position_id
    `;
    clauses.push(dsql`p.business_unit_id = ${filters.businessUnitId}::uuid`);
  }

  return dsql`
    WITH scoped AS (
      SELECT
        i.id AS id,
        i.status AS status,
        i.round_name AS round_name,
        i.completed_at AS completed_at
      FROM public.interviews i
      ${join}
      WHERE ${dsql.join(clauses, dsql` AND `)}
    )
  `;
}

/**
 * The feedback-latency pairs: one row per SUBMITTED scorecard whose interview
 * carries a completion stamp. Emitted as a CTE fragment because both the
 * headline median and the per-round medians are taken over it.
 */
function feedbackPairsCte(tenantId: string): SQL {
  return dsql`
    pairs AS (
      SELECT
        s.round_name AS round_name,
        GREATEST(
          EXTRACT(EPOCH FROM (f.submitted_at - s.completed_at)) / 3600.0,
          0
        ) AS hours
      FROM public.interview_feedback f
      JOIN scoped s ON s.id = f.interview_id
      WHERE f.tenant_id = ${tenantId}::uuid
        AND f.submitted_at IS NOT NULL
        AND s.completed_at IS NOT NULL
    )
  `;
}

/**
 * The scorecard SLOTS: one row per (completed interview × panelist), flagged
 * with whether that panelist actually submitted. Both the coverage totals and
 * the laggard list are grouped off this — computing them from one definition
 * is what stops the table and the list disagreeing.
 */
function scorecardSlotsCte(tenantId: string): SQL {
  return dsql`
    completed_ivs AS (
      SELECT id FROM scoped WHERE status = 'completed'
    ),
    slots AS (
      SELECT
        pl.membership_id AS membership_id,
        (f.submitted_at IS NOT NULL) AS submitted
      FROM public.interview_panelists pl
      JOIN completed_ivs c ON c.id = pl.interview_id
      LEFT JOIN public.interview_feedback f
        ON f.tenant_id = pl.tenant_id
       AND f.interview_id = pl.interview_id
       AND f.membership_id = pl.membership_id
      WHERE pl.tenant_id = ${tenantId}::uuid
    )
  `;
}

/**
 * DEFINITION — interview & scorecard health: the interview funnel for the
 * period (scheduled / completed / cancelled / no-show and the completion
 * rate), how long panelists take to write an interview up, how much of the
 * expected scorecard coverage actually arrived and who is holding it up, and
 * the same picture broken out per interview round.
 */
export async function getInterviewHealthReport(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<InterviewHealthReport> {
  const base = scopedInterviewsCte(tenantId, filters);
  const pairs = feedbackPairsCte(tenantId);
  const slots = scorecardSlotsCte(tenantId);

  // 1. The funnel + the headline feedback median. One statement over the two
  // CTEs so the counts and the median cannot describe different populations.
  const totalsRes = await db.execute(dsql`
    ${base},
    ${pairs}
    SELECT
      (SELECT COUNT(*) FILTER (WHERE status = 'scheduled') FROM scoped)::int AS scheduled,
      (SELECT COUNT(*) FILTER (WHERE status = 'completed') FROM scoped)::int AS completed,
      (SELECT COUNT(*) FILTER (WHERE status = 'cancelled') FROM scoped)::int AS cancelled,
      (SELECT COUNT(*) FILTER (WHERE status = 'no_show') FROM scoped)::int AS no_show,
      (SELECT COUNT(*) FROM scoped)::int AS total,
      (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 2)::float8
         FROM pairs) AS median_hours_to_feedback,
      (SELECT COUNT(*) FROM pairs)::int AS feedback_pairs
  `);
  const t = asRows<TotalsSqlRow>(totalsRes)[0];
  const completed = t?.completed ?? 0;
  const cancelled = t?.cancelled ?? 0;
  const noShow = t?.no_show ?? 0;
  const totals: InterviewHealthTotals = {
    scheduled: t?.scheduled ?? 0,
    completed,
    cancelled,
    noShow,
    total: t?.total ?? 0,
    // Resolved interviews only — see the header for why `scheduled` is out.
    completionRate: ratePct(completed, completed + cancelled + noShow),
    medianHoursToFeedback: t?.median_hours_to_feedback ?? null,
    feedbackPairs: t?.feedback_pairs ?? 0,
  };

  // 2. Scorecard coverage over the completed interviews.
  const coverageRes = await db.execute(dsql`
    ${base},
    ${slots}
    SELECT
      (SELECT COUNT(*) FROM completed_ivs)::int AS interviews_completed,
      (SELECT COUNT(*) FROM slots)::int AS expected_scorecards,
      (SELECT COUNT(*) FILTER (WHERE submitted) FROM slots)::int AS submitted_scorecards
  `);
  const c = asRows<ScorecardSqlRow>(coverageRes)[0];
  const expectedScorecards = c?.expected_scorecards ?? 0;
  const submittedScorecards = c?.submitted_scorecards ?? 0;

  // 3. Who owes what. Same `slots` definition, grouped by panelist; only
  // people with something outstanding appear.
  const laggardRes = await db.execute(dsql`
    ${base},
    ${slots}
    SELECT
      membership_id::text AS membership_id,
      COUNT(*) FILTER (WHERE NOT submitted)::int AS outstanding
    FROM slots
    GROUP BY membership_id
    HAVING COUNT(*) FILTER (WHERE NOT submitted) > 0
    ORDER BY outstanding DESC, membership_id ASC
    LIMIT ${SCORECARD_LAGGARD_LIMIT}
  `);
  const laggards: InterviewHealthLaggardBase[] = asRows<LaggardSqlRow>(laggardRes).map((r) => ({
    membershipId: r.membership_id,
    outstanding: r.outstanding,
  }));

  // 4. The same funnel per round. `round_name` is free text, so there is no
  // canonical order to zero-fill against — only rounds that exist get a row.
  const roundRes = await db.execute(dsql`
    ${base},
    ${pairs},
    round_speed AS (
      SELECT
        round_name,
        ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 2)::float8
          AS median_hours
      FROM pairs
      GROUP BY round_name
    )
    SELECT
      s.round_name AS round_name,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE s.status = 'scheduled')::int AS scheduled,
      COUNT(*) FILTER (WHERE s.status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled,
      COUNT(*) FILTER (WHERE s.status = 'no_show')::int AS no_show,
      rs.median_hours AS median_hours_to_feedback
    FROM scoped s
    LEFT JOIN round_speed rs ON rs.round_name = s.round_name
    GROUP BY s.round_name, rs.median_hours
    ORDER BY COUNT(*) DESC, s.round_name ASC
  `);
  const byRound: InterviewHealthRoundRow[] = asRows<RoundSqlRow>(roundRes).map((r) => ({
    roundName: r.round_name,
    total: r.total,
    scheduled: r.scheduled,
    completed: r.completed,
    cancelled: r.cancelled,
    noShow: r.no_show,
    medianHoursToFeedback: r.median_hours_to_feedback ?? null,
  }));

  return {
    totals,
    scorecardCompletion: {
      interviewsCompleted: c?.interviews_completed ?? 0,
      expectedScorecards,
      submittedScorecards,
      completionRate: ratePct(submittedScorecards, expectedScorecards),
      laggards,
    },
    byRound,
  };
}
