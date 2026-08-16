/**
 * Catalog report #18 — APPROVAL CYCLE ANALYTICS (R1.1).
 *
 * "How long do our approvals take, and who is the hold-up?" — the second
 * sponsor question. Every number comes from `approval_requests` (the
 * request and its lifecycle) and `approval_decisions` (the append-only
 * record of each step's outcome).
 *
 * THE DEFINITIONS THAT MATTER:
 *
 *   - DECIDED means `decided_at` is stamped, whatever terminal status the
 *     request landed in (approved / rejected / cancelled / expired). A
 *     rejection is still an approval cycle that completed, and excluding
 *     it would flatter the median.
 *
 *   - TURNAROUND is requested_at → decided_at, in HOURS. Approvals are a
 *     hours-scale process (the SLA conversation is "same day?"), unlike
 *     time-to-fill which the platform reports in days. Median and P90 are
 *     Postgres-native `percentile_cont`, 2dp, null over an empty set.
 *
 *   - `oldestPendingHours` is measured against now(), so it grows while
 *     you watch it — the "what is stuck right now" number.
 *
 *   - APPROVER ATTRIBUTION (the definition this report lives or dies on):
 *     a decision's clock starts at the END OF THE PREVIOUS STEP — the
 *     previous decision on the same request, ordered by (step_index,
 *     decided_at) — and, for the first decision on a request, at the
 *     request's `requested_at`. That is the chain's own semantics: an
 *     approver at step 2 cannot be blamed for step 1's wait. Two
 *     consequences worth stating rather than hiding:
 *       · where a step has SEVERAL decisions (a multi-approver step), the
 *         window is still taken from the immediately preceding decision,
 *         so genuinely parallel approvers are attributed sequentially and
 *         the second one looks fast. Fixing that needs per-step
 *         dispatch times the schema does not record.
 *       · durations are clamped at zero (`GREATEST(…, 0)`), so an
 *         out-of-order history cannot produce negative hours.
 *     External approvers (`approver_external_ref` with no membership) are
 *     excluded — there is no membership to attribute or to name.
 *
 * Filters: period ONLY, bounding `approval_requests.requested_at`
 * (inclusive both ends), which also bounds the decisions considered
 * (a decision is in scope when its REQUEST is). businessUnitId is N/A: a
 * request points at an opaque `subject_id` that is deliberately not a FK
 * and spans four subject types, so there is no business-unit join that
 * holds for all of them — it is ignored rather than half-applied, as are
 * requisitionId / recruiterMembershipId / source / stage.
 *
 * House conventions inherited from R0.1/R0.2 — do not diverge: raw SQL at
 * request time inside the protected procedure's tenant transaction, an
 * explicit `tenant_id` predicate on top of RLS, ISO strings with
 * `::timestamptz` casts, percentiles in Postgres, enum-keyed series
 * zero-filled in JS.
 *
 * Approver DISPLAY NAMES are not resolved here. `public.users` is
 * self-only under RLS, so a name join on the tenant-bound db would return
 * the caller's own name and nulls for everyone else; the router attaches
 * names through the service-role connection (resolveMembershipNames).
 */

import { sql as dsql, type SQL } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import type {
  ApprovalApproverRow,
  ApprovalStatusCount,
  ApprovalSubjectTypeRow,
  ApprovalTurnaround,
  ReportFilters,
} from "@hireops/api-types";

/**
 * The five `approval_request_status` values in lifecycle order (the enum's
 * own declaration order): the only non-terminal state first, then the
 * terminals. The chip row is zero-filled across this so it never reflows.
 */
export const CANONICAL_APPROVAL_STATUS_ORDER: readonly string[] = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "expired",
];

/** The four `approval_subject_type` values, in enum-declaration order. */
export const CANONICAL_APPROVAL_SUBJECT_TYPE_ORDER: readonly string[] = [
  "headcount_envelope",
  "requisition",
  "jd_version",
  "offer",
];

/** How many slow approvers the report names. */
export const BOTTLENECK_APPROVER_LIMIT = 10;

/** The approver row minus the display name the router attaches. */
export type ApprovalApproverRowBase = Omit<ApprovalApproverRow, "approverName">;

export interface ApprovalAnalyticsReport {
  byStatus: ApprovalStatusCount[];
  turnaround: ApprovalTurnaround;
  bottleneckApprovers: ApprovalApproverRowBase[];
  bySubjectType: ApprovalSubjectTypeRow[];
}

/** postgres-js returns `{rows: …}`; fall back to the array form (matches measures.ts). */
function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

interface StatusSqlRow {
  status: string;
  count: number;
}
interface TurnaroundSqlRow {
  decided_count: number;
  median_hours: number | null;
  p90_hours: number | null;
  pending_count: number;
  oldest_pending_hours: number | null;
}
interface ApproverSqlRow {
  approver_membership_id: string;
  decisions: number;
  median_hours: number;
}
interface SubjectTypeSqlRow {
  subject_type: string;
  requests: number;
  median_hours: number | null;
}

/**
 * The requests in scope — the one predicate every part of this report
 * hangs off. Period bounds `requested_at`; nothing else applies (see the
 * header).
 */
function scopedRequestsCte(tenantId: string, filters: ReportFilters): SQL {
  const clauses: SQL[] = [dsql`ar.tenant_id = ${tenantId}::uuid`];
  if (filters.from) clauses.push(dsql`ar.requested_at >= ${filters.from}::timestamptz`);
  if (filters.to) clauses.push(dsql`ar.requested_at <= ${filters.to}::timestamptz`);
  return dsql`
    WITH scoped AS (
      SELECT
        ar.id AS id,
        ar.status AS status,
        ar.subject_type AS subject_type,
        ar.requested_at AS requested_at,
        ar.decided_at AS decided_at
      FROM public.approval_requests ar
      WHERE ${dsql.join(clauses, dsql` AND `)}
    )
  `;
}

/**
 * DEFINITION — approval cycle analytics: the request mix by status and by
 * subject type, end-to-end turnaround (median / P90 hours) over decided
 * requests, what is still pending and for how long, and the ten slowest
 * approvers by median per-step decision time.
 */
export async function getApprovalAnalyticsReport(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<ApprovalAnalyticsReport> {
  const base = scopedRequestsCte(tenantId, filters);

  // 1. Volume by lifecycle status.
  const statusRes = await db.execute(dsql`
    ${base}
    SELECT status::text AS status, COUNT(*)::int AS count
    FROM scoped
    GROUP BY status
  `);
  const statusMap = new Map(asRows<StatusSqlRow>(statusRes).map((r) => [r.status, r.count]));
  const byStatus: ApprovalStatusCount[] = CANONICAL_APPROVAL_STATUS_ORDER.map((status) => ({
    status,
    count: statusMap.get(status) ?? 0,
  }));

  // 2. Turnaround. One statement, five scalar sub-selects over the same
  // CTE — the percentiles need the decided set, the pending numbers need
  // the whole set, and a single round trip keeps them consistent.
  const turnaroundRes = await db.execute(dsql`
    ${base},
    decided AS (
      SELECT (EXTRACT(EPOCH FROM (decided_at - requested_at)) / 3600.0) AS hours
      FROM scoped
      WHERE decided_at IS NOT NULL
    )
    SELECT
      (SELECT COUNT(*)::int FROM decided) AS decided_count,
      (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 2)::float8
         FROM decided) AS median_hours,
      (SELECT ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY hours)::numeric, 2)::float8
         FROM decided) AS p90_hours,
      (SELECT COUNT(*)::int FROM scoped WHERE status = 'pending') AS pending_count,
      (SELECT ROUND((EXTRACT(EPOCH FROM (now() - MIN(requested_at))) / 3600.0)::numeric, 2)::float8
         FROM scoped WHERE status = 'pending') AS oldest_pending_hours
  `);
  const t = asRows<TurnaroundSqlRow>(turnaroundRes)[0];
  const turnaround: ApprovalTurnaround = {
    medianHours: t?.median_hours ?? null,
    p90Hours: t?.p90_hours ?? null,
    decidedCount: t?.decided_count ?? 0,
    pendingCount: t?.pending_count ?? 0,
    oldestPendingHours: t?.oldest_pending_hours ?? null,
  };

  // 3. Bottleneck approvers. `LAG` over the request's decisions is the
  // whole attribution rule (see the header): each decision is timed from
  // the previous step's decision, or from the request itself at step 0.
  const approverRes = await db.execute(dsql`
    ${base},
    steps AS (
      SELECT
        d.approver_membership_id AS approver_membership_id,
        GREATEST(
          EXTRACT(EPOCH FROM (
            d.decided_at
            - COALESCE(
                LAG(d.decided_at) OVER (
                  PARTITION BY d.request_id ORDER BY d.step_index, d.decided_at
                ),
                s.requested_at
              )
          )) / 3600.0,
          0
        ) AS hours
      FROM public.approval_decisions d
      JOIN scoped s ON s.id = d.request_id
      WHERE d.tenant_id = ${tenantId}::uuid
        AND d.approver_membership_id IS NOT NULL
    )
    SELECT
      approver_membership_id::text AS approver_membership_id,
      COUNT(*)::int AS decisions,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 2)::float8
        AS median_hours
    FROM steps
    GROUP BY approver_membership_id
    ORDER BY median_hours DESC, decisions DESC, approver_membership_id ASC
    LIMIT ${BOTTLENECK_APPROVER_LIMIT}
  `);
  const bottleneckApprovers: ApprovalApproverRowBase[] = asRows<ApproverSqlRow>(approverRes).map(
    (r) => ({
      approverMembershipId: r.approver_membership_id,
      decisions: r.decisions,
      medianHours: r.median_hours,
    }),
  );

  // 4. Volume + end-to-end median per subject type. The FILTER is
  // explicit rather than trusting percentile_cont's null handling.
  const subjectRes = await db.execute(dsql`
    ${base}
    SELECT
      subject_type::text AS subject_type,
      COUNT(*)::int AS requests,
      ROUND(
        (percentile_cont(0.5) WITHIN GROUP (
          ORDER BY (EXTRACT(EPOCH FROM (decided_at - requested_at)) / 3600.0)
        ) FILTER (WHERE decided_at IS NOT NULL))::numeric,
        2
      )::float8 AS median_hours
    FROM scoped
    GROUP BY subject_type
  `);
  const subjectMap = new Map(asRows<SubjectTypeSqlRow>(subjectRes).map((r) => [r.subject_type, r]));
  const bySubjectType: ApprovalSubjectTypeRow[] = CANONICAL_APPROVAL_SUBJECT_TYPE_ORDER.map(
    (subjectType) => {
      const hit = subjectMap.get(subjectType);
      return {
        subjectType,
        requests: hit?.requests ?? 0,
        medianHours: hit?.median_hours ?? null,
      };
    },
  );

  return { byStatus, turnaround, bottleneckApprovers, bySubjectType };
}
