/**
 * Reporting semantic layer — DIMENSIONS (R0.1).
 *
 * The standard filter set every report accepts, and the one place that
 * turns it into SQL. Five analytics surfaces (getHrMetrics,
 * getRequisitionInsights, getHrAnalytics, getRecruitmentReport,
 * getExecutiveAudit) each hand-rolled their own WHERE clauses over
 * `applications`; this module exists so "applications in period P, in BU
 * B, on requisition R" means exactly one thing platform-wide.
 *
 * House query conventions this module follows (copied from the existing
 * procedures — do not diverge):
 *   - Raw SQL at request time via `db.execute(dsql`…`)` inside the tenant
 *     transaction; an explicit `tenant_id = …::uuid` predicate on top of
 *     the tenant_isolation RLS the protected procedure already applies.
 *   - Date bounds are ISO strings interpolated with an explicit
 *     `::timestamptz` cast — NEVER a JS Date, which postgres-js cannot
 *     serialize as a raw text parameter.
 *   - Applications are aliased `a` everywhere so one fragment slots into
 *     the single-table and joined queries alike.
 *
 * Dimensions deliberately NOT modelled (the data does not support them
 * honestly today):
 *   - location: no locations table — free text on positions
 *     (`positions.primary_location`), deliberately not a dimension
 *     (plan §2.3).
 *   - department: `business_units` IS the department axis; there is no
 *     second level below it.
 */

import { sql as dsql, type SQL } from "drizzle-orm";
import type { ReportFilters } from "@hireops/api-types";

/**
 * The standard report filter set: period · BU · requisition · recruiter ·
 * source · stage. The single definition is `reportFiltersSchema` in
 * `@hireops/api-types` (the wire contract); it is re-exported here so the
 * SQL builders and their callers cannot drift apart. Every field is
 * optional; `{}` means "all time, whole tenant".
 *
 * `from`/`to` are ISO-8601 datetime strings bounding
 * `applications.created_at` (inclusive at both ends, matching the
 * original getRecruitmentReport semantics).
 */
export type { ReportFilters };

/**
 * A composable application scope: the JOIN fragment a predicate needs and
 * the predicate itself, always handed out together.
 *
 * `join` is empty unless a dimension requires extra tables (today only
 * BU, which needs requisitions → positions). Callers MUST splice `join`
 * into the FROM list before using `where` — that pairing is the whole
 * reason this is one object rather than two functions.
 *
 * `where` is a complete boolean expression starting with the explicit
 * tenant predicate, so callers write `WHERE ${scope.where}`.
 */
export interface ApplicationScope {
  /** JOIN clauses required by the active filters (may be empty). */
  join: SQL;
  /** Full WHERE expression, tenant predicate first. */
  where: SQL;
}

/**
 * The BU join path: `applications a → requisitions r → positions p`.
 * BU lives on positions, not on requisitions, so both hops are required
 * (plan §2.3). Tenant-paired join keys match the composite FKs and keep
 * RLS happy.
 */
const BU_JOIN = dsql`
  JOIN public.requisitions r
    ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
  JOIN public.positions p
    ON p.tenant_id = r.tenant_id AND p.id = r.position_id
`;

/**
 * Builds the WHERE expression + required JOINs for `applications a` from
 * the standard filter set.
 *
 * Semantics (the contract every report inherits):
 *   - period: `a.created_at BETWEEN from AND to`, each bound optional and
 *     inclusive. The period always bounds APPLICATION CREATION, never the
 *     event being measured — so "hires in May" means "applications
 *     created in May that went on to be hired", which is what the
 *     original getRecruitmentReport measured.
 *   - businessUnitId: equality on `p.business_unit_id` via the requisition
 *     → position path (adds `join`).
 *   - requisitionId / recruiterMembershipId / source / stage: plain
 *     equality on the applications row.
 *
 * @param tenantId  the request's tenant — always emitted explicitly on top of RLS.
 */
export function buildApplicationScope(tenantId: string, filters: ReportFilters): ApplicationScope {
  const clauses: SQL[] = [dsql`a.tenant_id = ${tenantId}::uuid`];

  if (filters.from) clauses.push(dsql`a.created_at >= ${filters.from}::timestamptz`);
  if (filters.to) clauses.push(dsql`a.created_at <= ${filters.to}::timestamptz`);
  if (filters.requisitionId) clauses.push(dsql`a.requisition_id = ${filters.requisitionId}::uuid`);
  if (filters.recruiterMembershipId) {
    clauses.push(dsql`a.assigned_recruiter_membership_id = ${filters.recruiterMembershipId}::uuid`);
  }
  if (filters.source) clauses.push(dsql`a.source = ${filters.source}::application_source`);
  if (filters.stage) clauses.push(dsql`a.current_stage = ${filters.stage}::application_stage`);

  // BU is the only dimension that needs extra tables — predicate and join
  // are produced together so one cannot be applied without the other.
  let join: SQL = dsql``;
  if (filters.businessUnitId) {
    join = BU_JOIN;
    clauses.push(dsql`p.business_unit_id = ${filters.businessUnitId}::uuid`);
  }

  return { join, where: dsql.join(clauses, dsql` AND `) };
}
