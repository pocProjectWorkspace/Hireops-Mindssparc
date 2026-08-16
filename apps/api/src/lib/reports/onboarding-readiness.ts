/**
 * Catalog report #19 — ONBOARDING READINESS (R1.2).
 *
 * "Who starts soon, and what is still missing?" — the last of the sponsor
 * pack, and the only report in the catalog that looks PAST the hire. Every
 * other surface stops at offer_accepted; this one picks the person up there
 * and asks whether the organisation is actually ready for them on day one.
 *
 * It reads five tables around `onboarding_cases`: `onboarding_tasks` (the
 * checklist), `onboarding_documents` (what has been collected and verified),
 * `bgv_runs` (background verification) and `it_provisioning_requests`
 * (accounts and access). One row per ACTIVE case, plus the status mix and the
 * fortnight rollups a People Ops lead reads first.
 *
 * THE DEFINITIONS THAT MATTER (each restated on the wire schema):
 *
 *   - ACTIVE means status pre_boarding / day_zero / in_progress. Completed
 *     and cancelled cases still appear in `byStatus` — they are part of the
 *     mix, and hiding them would make the volume story wrong — but they are
 *     NOT in the row list or the rollups, which exist to answer "what needs
 *     doing", and a landed hire needs nothing.
 *
 *   - THE PERIOD AXIS is `expected_start_date`, not `created_at`. The
 *     question is "who lands this month", not "whose paperwork opened this
 *     month". It is a `date` column, so the ISO bounds are narrowed to UTC
 *     calendar days; a case with NO expected start date cannot be placed on
 *     that axis and drops out of any windowed view (it is counted when no
 *     window is set). Stated rather than defaulted onto created_at, which
 *     would invent a start date.
 *
 *   - `daysToStart` is `expected_start_date − CURRENT_DATE` in whole days, so
 *     it goes NEGATIVE for a start date that has already passed while the
 *     case is still open. That negative is the finding, not an error: it is a
 *     hire whose first day has arrived with the onboarding unfinished, and
 *     clamping it at zero would erase exactly the rows the report exists for.
 *
 *   - THE FOUR READINESS PAIRS, each with its denominator pinned, because a
 *     bare "3 / 5" means nothing:
 *       · TASKS — the denominator is tasks that are still WORK: everything
 *         except `cancelled` and `skipped`. A skipped task is not owed by
 *         anyone, so leaving it in would cap the case below 100% forever.
 *         `tasksDone` is status `completed`; `overdueTasks` counts unfinished
 *         tasks past their `due_at`, which is what tones the row.
 *       · DOCUMENTS — the denominator is EVERY upload on the case, and
 *         `docsVerified` only those at `verified`. A `rejected` or
 *         `resubmit_required` upload deliberately stays in the denominator:
 *         it is a document the case still needs. Note the honest limit — this
 *         counts what was UPLOADED, not what the geography's `document_types`
 *         say is REQUIRED, so a case that has uploaded nothing reads 0 / 0
 *         rather than 0 / 7. Wiring the requirement set in needs the
 *         per-geography policy resolution the onboarding surface owns, and is
 *         deliberately out of this report's scope.
 *       · BGV — `bgvStatus` is the LATEST `bgv_runs` row by `initiated_at`,
 *         or null when no check was ever raised. A case can have several runs
 *         (a re-run after a failure); the latest is the one that describes
 *         the case now, so a failed-then-rerun case reads as in flight.
 *       · IT — the denominator is provisioning requests except `cancelled`
 *         ones; `itProvisioned` is status `provisioned`.
 *
 *   - THE ROLLUPS are computed over the FULL filtered set of active cases,
 *     never over the (capped) row list — the same discipline the aging
 *     report's `byStatus` follows. `startingWithin14Days` is today → today+14
 *     INCLUSIVE and deliberately excludes a start date already in the past:
 *     that is not "starting soon", it is late, and it lands in `overdueStart`
 *     instead. Adding the two gives "everyone due by the end of the
 *     fortnight, plus everyone already due".
 *
 * ORDERING is soonest start first, undated cases last — the reading order of
 * a People Ops queue. Ties break on candidate name then case id so the list
 * is stable across refreshes.
 *
 * ROW CAP 200 (+ `truncated`). Onboarding is a narrower funnel than the
 * requisition list — a tenant has tens of live cases, not hundreds — so the
 * cap is lower than the aging report's 500 and exists for the same reason:
 * a runaway tenant must not stream a table into a browser.
 *
 * Filters: period, plus businessUnitId through the case's application →
 * requisition → position. `onboarding_cases.application_id` is NOT NULL
 * (a case is only ever opened from an accepted offer), so that chain always
 * resolves and no case is silently dropped by the join.
 * requisitionId / recruiterMembershipId / source / stage are N/A and IGNORED:
 * the hire has left the pipeline, so their stage and source now describe
 * history, and the recruiter who sourced them does not own their onboarding.
 *
 * CANDIDATE NAMES are resolved HERE, unlike the membership names on the
 * aging / approval / interview reports: `persons` is tenant-scoped under RLS
 * (not self-only like `public.users`), so the tenant-bound read can join it
 * directly and no service-role hop is needed.
 *
 * House conventions inherited from R0.1/R0.2 — do not diverge: raw SQL at
 * request time inside the protected procedure's tenant transaction, an
 * explicit `tenant_id` predicate on top of RLS, ISO strings with
 * `::timestamptz` casts (never a JS Date — postgres-js cannot serialize one
 * as a raw text parameter), and enum-keyed series zero-filled in JS.
 */

import { sql as dsql, type SQL } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import type {
  GetOnboardingReadinessReportOutput,
  OnboardingReadinessRollups,
  OnboardingReadinessRow,
  OnboardingReadinessStatusCount,
  ReportFilters,
} from "@hireops/api-types";

/**
 * The five `onboarding_cases.status` values in the order the CHECK constraint
 * declares them (lifecycle order, terminals last). Text + CHECK, not a
 * pgEnum — HANDOVER reality #114. `byStatus` is zero-filled across this so
 * the surface's chip row never reflows as data changes.
 */
export const CANONICAL_ONBOARDING_CASE_STATUS_ORDER: readonly string[] = [
  "pre_boarding",
  "day_zero",
  "in_progress",
  "completed",
  "cancelled",
];

/** The statuses whose onboarding is still someone's job — see the header. */
export const ACTIVE_ONBOARDING_CASE_STATUSES: readonly string[] = [
  "pre_boarding",
  "day_zero",
  "in_progress",
];

/** Row cap on the active-case list. The rollups are computed over the full set. */
export const ONBOARDING_READINESS_ROW_CAP = 200;

/** The fortnight the "starting soon" tile looks ahead over. */
export const STARTING_SOON_DAYS = 14;

/** postgres-js returns `{rows: …}`; fall back to the array form (matches measures.ts). */
function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

interface StatusSqlRow {
  status: string;
  count: number;
}
interface RowSqlRow {
  case_id: string;
  candidate_name: string | null;
  status: string;
  expected_start_date: string | null;
  days_to_start: number | null;
  tasks_done: number;
  tasks_total: number;
  overdue_tasks: number;
  docs_verified: number;
  docs_total: number;
  bgv_status: string | null;
  it_provisioned: number;
  it_total: number;
}
interface RollupSqlRow {
  active_cases: number;
  starting_within_14_days: number;
  overdue_start: number;
  cases_with_overdue_tasks: number;
  bgv_in_progress: number;
  bgv_failed: number;
}

/**
 * The cases in scope — emitted as a leading `WITH scoped AS (…)` so every
 * statement below starts from exactly the same population.
 *
 * The application → requisition → position join is CONDITIONAL on the BU
 * filter: it is the only dimension that needs those hops, and paying for
 * three joins on every read of an unfiltered page would be waste.
 */
function scopedCasesCte(tenantId: string, filters: ReportFilters): SQL {
  const clauses: SQL[] = [dsql`oc.tenant_id = ${tenantId}::uuid`];

  // The period axis is a `date` column, so the ISO instants are narrowed to
  // UTC calendar days — the same UTC convention the filter bar sends.
  if (filters.from) {
    clauses.push(
      dsql`oc.expected_start_date >= (${filters.from}::timestamptz AT TIME ZONE 'UTC')::date`,
    );
  }
  if (filters.to) {
    clauses.push(
      dsql`oc.expected_start_date <= (${filters.to}::timestamptz AT TIME ZONE 'UTC')::date`,
    );
  }

  let join: SQL = dsql``;
  if (filters.businessUnitId) {
    join = dsql`
      JOIN public.applications a
        ON a.tenant_id = oc.tenant_id AND a.id = oc.application_id
      JOIN public.requisitions r
        ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
      JOIN public.positions p
        ON p.tenant_id = r.tenant_id AND p.id = r.position_id
    `;
    clauses.push(dsql`p.business_unit_id = ${filters.businessUnitId}::uuid`);
  }

  return dsql`
    WITH scoped AS (
      SELECT
        oc.id AS id,
        oc.status AS status,
        oc.candidate_id AS candidate_id,
        oc.expected_start_date AS expected_start_date
      FROM public.onboarding_cases oc
      ${join}
      WHERE ${dsql.join(clauses, dsql` AND `)}
    ),
    active AS (
      SELECT * FROM scoped
      WHERE status IN ('pre_boarding', 'day_zero', 'in_progress')
    )
  `;
}

/**
 * The latest BGV run per active case. `DISTINCT ON` ordered by
 * `initiated_at DESC` is the "one row per case" idiom; `id` breaks a tie so
 * two runs initiated in the same instant still resolve deterministically.
 */
function latestBgvCte(tenantId: string): SQL {
  return dsql`
    latest_bgv AS (
      SELECT DISTINCT ON (b.case_id)
        b.case_id AS case_id,
        b.status AS status
      FROM public.bgv_runs b
      JOIN active a ON a.id = b.case_id
      WHERE b.tenant_id = ${tenantId}::uuid
      ORDER BY b.case_id, b.initiated_at DESC, b.id DESC
    )
  `;
}

/**
 * DEFINITION — onboarding readiness: the case mix by lifecycle status, one
 * row per active case showing who starts when and how much of their tasks,
 * documents, background check and IT provisioning is done, and the rollups
 * that say what needs attention this fortnight.
 */
export async function getOnboardingReadinessReport(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<GetOnboardingReadinessReportOutput> {
  const base = scopedCasesCte(tenantId, filters);
  const bgv = latestBgvCte(tenantId);

  // 1. Case mix — over EVERY case in range, terminal ones included.
  const statusRes = await db.execute(dsql`
    ${base}
    SELECT status::text AS status, COUNT(*)::int AS count
    FROM scoped
    GROUP BY status
  `);
  const statusMap = new Map(asRows<StatusSqlRow>(statusRes).map((r) => [r.status, r.count]));
  const byStatus: OnboardingReadinessStatusCount[] = CANONICAL_ONBOARDING_CASE_STATUS_ORDER.map(
    (status) => ({ status, count: statusMap.get(status) ?? 0 }),
  );

  // 2. The active-case list. Four LEFT-JOINed aggregate CTEs rather than four
  // correlated subqueries, so each child table is scanned once; COALESCE
  // turns "no rows at all" into an honest 0 / 0 rather than a null pair.
  const rowsRes = await db.execute(dsql`
    ${base},
    tasks AS (
      SELECT
        t.case_id AS case_id,
        COUNT(*) FILTER (WHERE t.status NOT IN ('cancelled', 'skipped'))::int AS total,
        COUNT(*) FILTER (WHERE t.status = 'completed')::int AS done,
        COUNT(*) FILTER (
          WHERE t.due_at IS NOT NULL
            AND t.due_at < now()
            AND t.status NOT IN ('completed', 'cancelled', 'skipped')
        )::int AS overdue
      FROM public.onboarding_tasks t
      JOIN active a ON a.id = t.case_id
      WHERE t.tenant_id = ${tenantId}::uuid
      GROUP BY t.case_id
    ),
    docs AS (
      SELECT
        d.case_id AS case_id,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE d.verification_status = 'verified')::int AS verified
      FROM public.onboarding_documents d
      JOIN active a ON a.id = d.case_id
      WHERE d.tenant_id = ${tenantId}::uuid
      GROUP BY d.case_id
    ),
    it AS (
      SELECT
        ip.case_id AS case_id,
        COUNT(*) FILTER (WHERE ip.status <> 'cancelled')::int AS total,
        COUNT(*) FILTER (WHERE ip.status = 'provisioned')::int AS provisioned
      FROM public.it_provisioning_requests ip
      JOIN active a ON a.id = ip.case_id
      WHERE ip.tenant_id = ${tenantId}::uuid
      GROUP BY ip.case_id
    ),
    ${bgv}
    SELECT
      act.id::text AS case_id,
      pe.full_name AS candidate_name,
      act.status::text AS status,
      act.expected_start_date::text AS expected_start_date,
      (act.expected_start_date - CURRENT_DATE)::int AS days_to_start,
      COALESCE(tasks.done, 0)::int AS tasks_done,
      COALESCE(tasks.total, 0)::int AS tasks_total,
      COALESCE(tasks.overdue, 0)::int AS overdue_tasks,
      COALESCE(docs.verified, 0)::int AS docs_verified,
      COALESCE(docs.total, 0)::int AS docs_total,
      latest_bgv.status::text AS bgv_status,
      COALESCE(it.provisioned, 0)::int AS it_provisioned,
      COALESCE(it.total, 0)::int AS it_total
    FROM active act
    JOIN public.candidates cnd
      ON cnd.tenant_id = ${tenantId}::uuid AND cnd.id = act.candidate_id
    JOIN public.persons pe
      ON pe.tenant_id = ${tenantId}::uuid AND pe.id = cnd.person_id
    LEFT JOIN tasks ON tasks.case_id = act.id
    LEFT JOIN docs ON docs.case_id = act.id
    LEFT JOIN it ON it.case_id = act.id
    LEFT JOIN latest_bgv ON latest_bgv.case_id = act.id
    ORDER BY
      act.expected_start_date ASC NULLS LAST,
      pe.full_name ASC NULLS LAST,
      act.id ASC
    LIMIT ${ONBOARDING_READINESS_ROW_CAP + 1}
  `);
  const rawRows = asRows<RowSqlRow>(rowsRes);
  const truncated = rawRows.length > ONBOARDING_READINESS_ROW_CAP;
  const rows: OnboardingReadinessRow[] = rawRows
    .slice(0, ONBOARDING_READINESS_ROW_CAP)
    .map((r) => ({
      caseId: r.case_id,
      candidateName: r.candidate_name,
      status: r.status,
      expectedStartDate: r.expected_start_date,
      daysToStart: r.days_to_start,
      tasksDone: r.tasks_done,
      tasksTotal: r.tasks_total,
      overdueTasks: r.overdue_tasks,
      docsVerified: r.docs_verified,
      docsTotal: r.docs_total,
      bgvStatus: r.bgv_status,
      itProvisioned: r.it_provisioned,
      itTotal: r.it_total,
    }));

  // 3. The fortnight rollups, over the FULL active set — so a capped list
  // never makes the tiles wrong.
  const rollupRes = await db.execute(dsql`
    ${base},
    overdue_task_cases AS (
      SELECT DISTINCT t.case_id AS case_id
      FROM public.onboarding_tasks t
      JOIN active a ON a.id = t.case_id
      WHERE t.tenant_id = ${tenantId}::uuid
        AND t.due_at IS NOT NULL
        AND t.due_at < now()
        AND t.status NOT IN ('completed', 'cancelled', 'skipped')
    ),
    ${bgv}
    SELECT
      (SELECT COUNT(*) FROM active)::int AS active_cases,
      (SELECT COUNT(*) FROM active
         WHERE expected_start_date IS NOT NULL
           AND expected_start_date >= CURRENT_DATE
           AND expected_start_date <= CURRENT_DATE + ${STARTING_SOON_DAYS}::int
      )::int AS starting_within_14_days,
      (SELECT COUNT(*) FROM active
         WHERE expected_start_date IS NOT NULL AND expected_start_date < CURRENT_DATE
      )::int AS overdue_start,
      (SELECT COUNT(*) FROM overdue_task_cases)::int AS cases_with_overdue_tasks,
      (SELECT COUNT(*) FROM latest_bgv WHERE status IN ('initiated', 'in_progress'))::int
        AS bgv_in_progress,
      (SELECT COUNT(*) FROM latest_bgv WHERE status = 'failed')::int AS bgv_failed
  `);
  const ru = asRows<RollupSqlRow>(rollupRes)[0];
  const rollups: OnboardingReadinessRollups = {
    activeCases: ru?.active_cases ?? 0,
    startingWithin14Days: ru?.starting_within_14_days ?? 0,
    overdueStart: ru?.overdue_start ?? 0,
    casesWithOverdueTasks: ru?.cases_with_overdue_tasks ?? 0,
    bgvInProgress: ru?.bgv_in_progress ?? 0,
    bgvFailed: ru?.bgv_failed ?? 0,
  };

  return { byStatus, rows, rollups, truncated };
}
