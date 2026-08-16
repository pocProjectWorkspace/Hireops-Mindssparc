/**
 * Catalog report #17 — HEADCOUNT VS PLAN (R1.1).
 *
 * "We approved a budget. What did we actually raise against it?" — the
 * sponsor's first question, and the one the platform could not answer
 * before this report existed.
 *
 * THE DEFINITIONS THAT MATTER:
 *   - The plan is `headcount_envelopes`: business unit × period ×
 *     planned_headcount. The model is deliberately THIN (no role
 *     families, no "remaining" column — the schema says remaining is
 *     computed, not stored), so this report reports exactly what exists
 *     rather than inventing a richer plan.
 *   - `reqsRaised` / `openingsRequested` count the requisitions whose
 *     `headcount_envelope_id` points at the envelope, over the envelope's
 *     WHOLE life — NOT over the report's period. The envelope's own
 *     period is the window that matters for a budget line; filtering its
 *     requisitions by the report window as well would make an envelope
 *     look under-used purely because you asked about one month of it.
 *   - `hires` is the platform-wide definition (applications now at
 *     `offer_accepted`) on those same requisitions, so it reconciles with
 *     the aging, productivity and pipeline reports.
 *   - `utilisationPct` = openingsRequested / plannedHeadcount × 100, 1dp.
 *     It can exceed 100; over-commitment is the finding, not a bug.
 *
 * THE MOST INTERESTING NUMBER is `unplanned`: requisitions with a NULL
 * `headcount_envelope_id`. Requirements §5.1 says headcount must be
 * approved BEFORE requisitions are raised against it; the platform does
 * not hard-enforce that, so the honest report shows the leak. It is a
 * count + openings only — the requisitions themselves are already listed
 * in full on the aging report, and duplicating them here would just be a
 * second requisition table.
 *
 * PERIOD SEMANTICS — the one asymmetry, stated out loud both here and on
 * the surface:
 *   - an ENVELOPE is in range when its period OVERLAPS the window
 *     (`period_start <= to AND period_end >= from`), so a quarterly plan
 *     appears for any window that touches it;
 *   - an UNPLANNED requisition has no envelope period to overlap, so it
 *     is in range when it was RAISED in the window
 *     (`requisitions.created_at`, via `buildRequisitionScope`).
 *
 * Filters: businessUnitId (the ENVELOPE's business unit, and the
 * position's BU on the unplanned side) and period. requisitionId /
 * recruiterMembershipId / source / stage are N/A — an envelope is a
 * budget line, not an application or a recruiter's work — and are
 * ignored, matching the contract the wire schema publishes.
 *
 * House conventions inherited from R0.1/R0.2 — do not diverge: raw SQL at
 * request time inside the protected procedure's tenant transaction, an
 * explicit `tenant_id` predicate on top of RLS, ISO strings with
 * `::timestamptz` casts (never a JS Date — postgres-js cannot serialize
 * one as a raw text parameter), aggregation in Postgres and assembly in
 * JS.
 *
 * There is no row cap: an envelope is one row per business unit per
 * period, so a tenant has tens of them at the outside — unlike the
 * requisition list, this cannot run away.
 */

import { sql as dsql, type SQL } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import type {
  GetHeadcountVsPlanReportOutput,
  HeadcountEnvelopeRow,
  HeadcountUnplanned,
  ReportFilters,
} from "@hireops/api-types";

import { buildRequisitionScope } from "./dimensions";

/** postgres-js returns `{rows: …}`; fall back to the array form (matches measures.ts). */
function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

interface EnvelopeSqlRow {
  envelope_id: string;
  business_unit_id: string;
  business_unit_name: string;
  period_start: string;
  period_end: string;
  planned_headcount: number;
  status: string;
  reqs_raised: number;
  openings_requested: number;
  hires: number;
}

interface UnplannedSqlRow {
  reqs_raised: number;
  openings_requested: number;
}

/**
 * openings against plan, as a 1dp percentage. Null when the envelope
 * plans nothing (the DB's `envelope_planned_check` should make that
 * impossible, but a report must not divide by zero on trust).
 */
export function utilisationPct(openingsRequested: number, plannedHeadcount: number): number | null {
  if (plannedHeadcount <= 0) return null;
  return Math.round((openingsRequested / plannedHeadcount) * 1000) / 10;
}

/**
 * The envelope scope. Note the OVERLAP test rather than containment, and
 * that the bounds are compared against `date` columns — Postgres widens
 * the date to midnight, which is the right reading for a calendar period.
 */
function envelopeWhere(tenantId: string, filters: ReportFilters): SQL {
  const clauses: SQL[] = [dsql`e.tenant_id = ${tenantId}::uuid`];
  if (filters.from) clauses.push(dsql`e.period_end >= ${filters.from}::timestamptz`);
  if (filters.to) clauses.push(dsql`e.period_start <= ${filters.to}::timestamptz`);
  if (filters.businessUnitId) {
    clauses.push(dsql`e.business_unit_id = ${filters.businessUnitId}::uuid`);
  }
  return dsql.join(clauses, dsql` AND `);
}

/**
 * DEFINITION — headcount vs plan: every approved (or draft, or closed)
 * envelope whose period touches the window, with the hiring raised
 * against it, the rollup of all of them, and the off-plan requisitions
 * that no envelope covers. Newest period first, then business unit A→Z.
 */
export async function getHeadcountVsPlanReport(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<GetHeadcountVsPlanReportOutput> {
  const envelopeRes = await db.execute(dsql`
    WITH env AS (
      SELECT
        e.id AS id,
        e.business_unit_id AS business_unit_id,
        b.name AS business_unit_name,
        e.period_start AS period_start,
        e.period_end AS period_end,
        e.planned_headcount AS planned_headcount,
        e.status AS status
      FROM public.headcount_envelopes e
      JOIN public.business_units b
        ON b.tenant_id = e.tenant_id AND b.id = e.business_unit_id
      WHERE ${envelopeWhere(tenantId, filters)}
    ),
    reqs AS (
      SELECT
        r.headcount_envelope_id AS envelope_id,
        COUNT(*)::int AS reqs_raised,
        COALESCE(SUM(r.number_of_openings), 0)::int AS openings_requested
      FROM public.requisitions r
      JOIN env ON env.id = r.headcount_envelope_id
      WHERE r.tenant_id = ${tenantId}::uuid
      GROUP BY r.headcount_envelope_id
    ),
    hires AS (
      SELECT r.headcount_envelope_id AS envelope_id, COUNT(*)::int AS hires
      FROM public.applications a
      JOIN public.requisitions r
        ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
      JOIN env ON env.id = r.headcount_envelope_id
      WHERE a.tenant_id = ${tenantId}::uuid
        AND a.current_stage = 'offer_accepted'
      GROUP BY r.headcount_envelope_id
    )
    SELECT
      env.id::text AS envelope_id,
      env.business_unit_id::text AS business_unit_id,
      env.business_unit_name AS business_unit_name,
      env.period_start::text AS period_start,
      env.period_end::text AS period_end,
      env.planned_headcount::int AS planned_headcount,
      env.status AS status,
      COALESCE(reqs.reqs_raised, 0)::int AS reqs_raised,
      COALESCE(reqs.openings_requested, 0)::int AS openings_requested,
      COALESCE(hires.hires, 0)::int AS hires
    FROM env
    LEFT JOIN reqs ON reqs.envelope_id = env.id
    LEFT JOIN hires ON hires.envelope_id = env.id
    ORDER BY env.period_start DESC, env.business_unit_name ASC
  `);

  const envelopes: HeadcountEnvelopeRow[] = asRows<EnvelopeSqlRow>(envelopeRes).map((r) => ({
    envelopeId: r.envelope_id,
    businessUnitId: r.business_unit_id,
    businessUnitName: r.business_unit_name,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    plannedHeadcount: r.planned_headcount,
    status: r.status,
    reqsRaised: r.reqs_raised,
    openingsRequested: r.openings_requested,
    hires: r.hires,
    utilisationPct: utilisationPct(r.openings_requested, r.planned_headcount),
  }));

  // Off-plan hiring. The recruiter / source / stage dimensions are
  // dropped from the filter set BEFORE it reaches the requisition scope
  // builder — this report ignores them by contract, and letting the
  // builder's recruiter predicate through would narrow this half of the
  // page while leaving the envelope table untouched.
  const unplannedScope = buildRequisitionScope(tenantId, {
    from: filters.from,
    to: filters.to,
    businessUnitId: filters.businessUnitId,
  });
  const unplannedRes = await db.execute(dsql`
    SELECT
      COUNT(*)::int AS reqs_raised,
      COALESCE(SUM(r.number_of_openings), 0)::int AS openings_requested
    FROM public.requisitions r
    ${unplannedScope.join}
    WHERE ${unplannedScope.where}
      AND r.headcount_envelope_id IS NULL
  `);
  const unplannedRow = asRows<UnplannedSqlRow>(unplannedRes)[0];
  const unplanned: HeadcountUnplanned = {
    reqsRaised: unplannedRow?.reqs_raised ?? 0,
    openingsRequested: unplannedRow?.openings_requested ?? 0,
  };

  // Rolled up in JS over the full (uncapped) row set — see the header for
  // why there is no cap to invalidate it.
  const plannedHeadcount = envelopes.reduce((sum, e) => sum + e.plannedHeadcount, 0);
  const openingsRequested = envelopes.reduce((sum, e) => sum + e.openingsRequested, 0);

  return {
    envelopes,
    totals: {
      envelopes: envelopes.length,
      plannedHeadcount,
      reqsRaised: envelopes.reduce((sum, e) => sum + e.reqsRaised, 0),
      openingsRequested,
      hires: envelopes.reduce((sum, e) => sum + e.hires, 0),
      utilisationPct: utilisationPct(openingsRequested, plannedHeadcount),
    },
    unplanned,
  };
}
