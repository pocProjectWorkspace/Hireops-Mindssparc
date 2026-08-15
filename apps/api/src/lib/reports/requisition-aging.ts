/**
 * Catalog report #1 — REQUISITION STATUS & AGING (R0.2).
 *
 * "Which requisitions are open, and how long have they been open?" — the
 * first of the two genuinely-new P0 reports (the build plan §2.2 rates the
 * rest of the catalog as re-homing work over surfaces that already exist).
 *
 * THE DEFINITION THAT MATTERS — daysOpen:
 *   creation → now for a LIVE requisition (it keeps growing), and
 *   creation → the FIRST transition into its current terminal status for a
 *   filled / closed / cancelled one (the clock stops).
 * There is deliberately no `closed_at` / `filled_at` column on
 * `requisitions` (build plan §2.3 pinned this); the stop time comes from
 * `requisition_state_transitions`, the append-only status history. A
 * terminal requisition with NO such transition recorded — possible for
 * rows written before the history existed, or by a direct UPDATE — has a
 * null `closedAt` and keeps ageing to now, which reads as "we can't
 * evidence when this closed" rather than silently inventing a date.
 *
 * House conventions (inherited from the R0.1 semantic layer, do not
 * diverge): raw SQL at request time inside the protected procedure's
 * tenant transaction, an explicit `tenant_id` predicate on top of RLS,
 * ISO strings with `::timestamptz` casts (never a JS Date — postgres-js
 * cannot serialize one as a raw text parameter), and enum-keyed series
 * zero-filled in JS.
 *
 * Filters: period / BU / primary recruiter, all via
 * `buildRequisitionScope`. requisitionId, source and stage are
 * application-axis dimensions with no requisition meaning and are ignored
 * — see that builder's contract.
 *
 * Recruiter DISPLAY NAMES are not resolved here. `public.users` is
 * self-only under RLS, so a name join on the tenant-bound db would return
 * the caller's own name and nulls for everyone else; the router attaches
 * names through the service-role connection (resolveMembershipNames).
 */

import { sql as dsql } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import type {
  ReportFilters,
  RequisitionAgingRow,
  RequisitionAgingStatusRollup,
} from "@hireops/api-types";

import { buildRequisitionScope } from "./dimensions";

/**
 * The eight `requisitions.status` values in the order the CHECK
 * constraint declares them (draft → … → closed): lifecycle order, with
 * the terminals last. The rollup is zero-filled across this so the
 * surface's chip row never reflows as data changes.
 */
export const CANONICAL_REQUISITION_STATUS_ORDER: readonly string[] = [
  "draft",
  "pending_approval",
  "approved",
  "on_hold",
  "posted",
  "filled",
  "cancelled",
  "closed",
];

/**
 * The statuses whose aging clock has STOPPED. `closed` and `cancelled`
 * are self-evident; `filled` counts as terminal because the opening it
 * represents is gone even though the hire's onboarding continues.
 */
export const TERMINAL_REQUISITION_STATUSES: ReadonlySet<string> = new Set([
  "filled",
  "cancelled",
  "closed",
]);

/**
 * Row cap on the detail list. At POC scale a tenant has tens of
 * requisitions; the cap exists so a runaway tenant can't stream thousands
 * of rows into a browser table. The `byStatus` rollup is computed over
 * the FULL filtered set, so the headline numbers stay correct even when
 * the list is trimmed (`truncated: true`).
 */
export const REQUISITION_AGING_ROW_CAP = 500;

/** The report row minus the display name the router attaches. */
export type RequisitionAgingRowBase = Omit<RequisitionAgingRow, "recruiterName">;

export interface RequisitionAgingReport {
  rows: RequisitionAgingRowBase[];
  byStatus: RequisitionAgingStatusRollup[];
  truncated: boolean;
}

/** postgres-js returns `{rows: …}`; fall back to the array form (matches measures.ts). */
function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

/** timestamptz arrives as a JS Date under postgres-js; emit ISO on the wire. */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface AgingSqlRow {
  requisition_id: string;
  title: string;
  status: string;
  openings: number;
  business_unit_id: string;
  business_unit_name: string;
  primary_recruiter_id: string;
  created_at: Date | string;
  closed_at: Date | string | null;
  days_open: number;
}

interface RollupSqlRow {
  status: string;
  count: number;
  avg_days_open: number | null;
}

/**
 * Requisitions in scope, each with its derived close time and age.
 *
 * `terminal` joins the status history only for requisitions whose CURRENT
 * status is terminal, and takes MIN(transitioned_at) into exactly that
 * status — the first time the req reached where it now rests. A req that
 * was closed, reopened and closed again therefore ages from creation to
 * the FIRST close, which matches "how long did this opening take to
 * resolve" and mirrors the earliest-transition rule timeToFillStats uses.
 */
function agedCte(tenantId: string, filters: ReportFilters) {
  const scope = buildRequisitionScope(tenantId, filters);
  return dsql`
    WITH scoped AS (
      SELECT
        r.id AS requisition_id,
        p.title AS title,
        r.status AS status,
        r.number_of_openings::int AS openings,
        p.business_unit_id AS business_unit_id,
        b.name AS business_unit_name,
        r.primary_recruiter_id AS primary_recruiter_id,
        r.created_at AS created_at
      FROM public.requisitions r
      ${scope.join}
      JOIN public.business_units b
        ON b.tenant_id = p.tenant_id AND b.id = p.business_unit_id
      WHERE ${scope.where}
    ),
    terminal AS (
      SELECT s.requisition_id AS requisition_id, MIN(t.transitioned_at) AS closed_at
      FROM scoped s
      JOIN public.requisition_state_transitions t
        ON t.tenant_id = ${tenantId}::uuid
       AND t.requisition_id = s.requisition_id
       AND t.to_status = s.status
      WHERE s.status IN ('filled', 'cancelled', 'closed')
      GROUP BY s.requisition_id
    ),
    aged AS (
      SELECT
        s.*,
        t.closed_at AS closed_at,
        ROUND(
          (EXTRACT(EPOCH FROM (COALESCE(t.closed_at, now()) - s.created_at)) / 86400.0)::numeric,
          2
        )::float8 AS days_open
      FROM scoped s
      LEFT JOIN terminal t ON t.requisition_id = s.requisition_id
    )
  `;
}

/**
 * DEFINITION — requisition aging: every requisition raised in the window,
 * with its age (see `daysOpen` above) and a per-status rollup of counts +
 * average age. Rows are OLDEST FIRST, which is the order the surface
 * wants: the top of the table is the thing to chase.
 */
export async function getRequisitionAgingReport(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<RequisitionAgingReport> {
  const base = agedCte(tenantId, filters);

  const rowRes = await db.execute(dsql`
    ${base}
    SELECT
      requisition_id::text AS requisition_id,
      title,
      status,
      openings,
      business_unit_id::text AS business_unit_id,
      business_unit_name,
      primary_recruiter_id::text AS primary_recruiter_id,
      created_at,
      closed_at,
      days_open
    FROM aged
    ORDER BY days_open DESC, created_at ASC
    LIMIT ${REQUISITION_AGING_ROW_CAP + 1}
  `);
  const raw = asRows<AgingSqlRow>(rowRes);
  const truncated = raw.length > REQUISITION_AGING_ROW_CAP;

  const rows: RequisitionAgingRowBase[] = raw.slice(0, REQUISITION_AGING_ROW_CAP).map((r) => ({
    requisitionId: r.requisition_id,
    title: r.title,
    status: r.status,
    isTerminal: TERMINAL_REQUISITION_STATUSES.has(r.status),
    openings: r.openings,
    businessUnitId: r.business_unit_id,
    businessUnitName: r.business_unit_name,
    recruiterMembershipId: r.primary_recruiter_id,
    createdAt: toIso(r.created_at) ?? new Date().toISOString(),
    closedAt: toIso(r.closed_at),
    daysOpen: r.days_open,
  }));

  // Rolled up in SQL over `aged` (not in JS over `rows`) so the numbers
  // stay whole when the row cap trims the list.
  const rollupRes = await db.execute(dsql`
    ${base}
    SELECT
      status,
      COUNT(*)::int AS count,
      ROUND(AVG(days_open)::numeric, 2)::float8 AS avg_days_open
    FROM aged
    GROUP BY status
  `);
  const byStatusMap = new Map(asRows<RollupSqlRow>(rollupRes).map((r) => [r.status, r]));
  const byStatus: RequisitionAgingStatusRollup[] = CANONICAL_REQUISITION_STATUS_ORDER.map(
    (status) => {
      const hit = byStatusMap.get(status);
      return {
        status,
        count: hit?.count ?? 0,
        avgDaysOpen: hit?.avg_days_open ?? null,
      };
    },
  );

  return { rows, byStatus, truncated };
}
