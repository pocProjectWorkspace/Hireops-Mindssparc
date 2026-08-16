/**
 * Catalog report #2/#3/#4/#6/#10 — PIPELINE & SPEED (R0.3).
 *
 * "Where is the pipeline, and how fast is it moving?" — one report over
 * one filtered scope, composed almost entirely from the R0.1 semantic
 * layer: funnel (#2), time to fill (#3), time in stage (#4a), source mix
 * (#6) and the offer funnel (#10). Every number here is therefore the
 * SAME number the existing surfaces publish; this module deliberately
 * defines nothing that measures.ts already defines.
 *
 * The one genuinely new piece is `slaBreaches` — the other half of the
 * plan's "#4 stage velocity & SLA", which no measure covered:
 *
 *   DEFINITION — SLA breach: an application whose CURRENT stage has a
 *   threshold and whose time in that stage (now() − stage_entered_at)
 *   exceeds it. A live snapshot, not a history — an application that ran
 *   late and has since moved on is not a breach today. This is the same
 *   test the candidate list's slaBreachOnly filter and the governance
 *   breach KPI apply, so the catalog can't disagree with them.
 *
 * Thresholds come from `resolveSlaThresholds` (@hireops/sla-thresholds via
 * lib/sla-thresholds) over `tenants.settings.slaThresholds` — the one
 * resolver the api, the workers' imminent-SLA scan and the governance
 * engine all share. Read through the TENANT-BOUND client here (RLS-scoped
 * SELECT on tenants), mirroring governance.ts's loadTenantSlaThresholds,
 * because everything else in this module already runs on that client. An
 * unconfigured or corrupt tenant resolves to the code defaults.
 *
 * House conventions inherited from R0.1/R0.2 — do not diverge: raw SQL at
 * request time inside the protected procedure's tenant transaction, an
 * explicit tenant_id predicate on top of RLS, and enum-keyed series
 * zero-filled in JS.
 *
 * Filters: ALL of them, since every part is an application-axis measure
 * resolved through `buildApplicationScope`. Worth being clear about the
 * SLA rows: the period bounds `applications.created_at`, so it narrows
 * WHICH live breaches you see; the breach test itself is always against
 * now().
 */

import { sql as dsql } from "drizzle-orm";
import type { ApplicationStage, TenantBoundDb } from "@hireops/db";
import type {
  GetPipelineReportOutput,
  PipelineSlaBreachRow,
  ReportFilters,
} from "@hireops/api-types";

import { resolveSlaThresholds } from "../sla-thresholds";
import { buildApplicationScope } from "./dimensions";
import {
  CANONICAL_STAGE_ORDER,
  funnelByStage,
  offerFunnel,
  sourceMix,
  timeInStageMedians,
  timeToFillStats,
} from "./measures";

/** postgres-js returns `{rows: …}`; fall back to the array form (matches measures.ts). */
function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

interface SlaSqlRow {
  stage: ApplicationStage;
  total_in_stage: number;
  breached_count: number;
}

/**
 * The tenant's RESOLVED per-stage SLA map: stored overrides merged over
 * the code defaults by the shared resolver. Tenant-bound read, so RLS
 * scopes it; a tenant row that somehow isn't visible resolves to the
 * defaults rather than throwing.
 */
async function loadTenantSlaThresholds(
  db: TenantBoundDb,
  tenantId: string,
): Promise<Record<ApplicationStage, number | null>> {
  const res = await db.execute(dsql`
    SELECT settings FROM public.tenants WHERE id = ${tenantId}::uuid LIMIT 1
  `);
  const [row] = asRows<{ settings: unknown }>(res);
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  return resolveSlaThresholds(settings.slaThresholds);
}

/**
 * Per-stage SLA standing right now: how many in-stage applications are
 * past the stage's threshold, and how many are in the stage at all.
 *
 * One grouped pass over `applications`, restricted to the thresholded
 * stages — the shape `idx_applications_sla`
 * (tenant_id, current_stage, stage_entered_at) exists for. The breach test
 * is a CASE over the resolved map, composed exactly as the candidate-list
 * filter and governance's countSlaBreaches compose theirs, so all three
 * agree by construction.
 *
 * Rows are emitted for every thresholded stage (zero-filled, canonical
 * order) so the table is stable; stages with no threshold — the four
 * terminals, and any stage the tenant has switched off — produce no row.
 */
export async function slaBreaches(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters,
  thresholds: Record<ApplicationStage, number | null>,
): Promise<PipelineSlaBreachRow[]> {
  const thresholded = (Object.entries(thresholds) as [ApplicationStage, number | null][]).filter(
    (entry): entry is [ApplicationStage, number] => entry[1] !== null,
  );
  // A tenant that has disabled every stage's SLA has nothing to report —
  // and an empty CASE / IN list is not valid SQL.
  if (thresholded.length === 0) return [];

  const scope = buildApplicationScope(tenantId, filters);
  const breachExpr = dsql`(CASE ${dsql.join(
    thresholded.map(
      ([stage, hours]) =>
        dsql`WHEN a.current_stage = ${stage} THEN EXTRACT(EPOCH FROM (now() - a.stage_entered_at)) / 3600.0 > ${hours}`,
    ),
    dsql.raw(" "),
  )} ELSE false END)`;
  const stageList = dsql.join(
    thresholded.map(([stage]) => dsql`${stage}::application_stage`),
    dsql`, `,
  );

  const res = await db.execute(dsql`
    SELECT
      a.current_stage AS stage,
      COUNT(*)::int AS total_in_stage,
      COUNT(*) FILTER (WHERE ${breachExpr})::int AS breached_count
    FROM public.applications a
    ${scope.join}
    WHERE ${scope.where}
      AND a.current_stage IN (${stageList})
    GROUP BY a.current_stage
  `);
  const byStage = new Map(asRows<SlaSqlRow>(res).map((r) => [r.stage, r]));
  const hoursByStage = new Map(thresholded);

  return CANONICAL_STAGE_ORDER.filter((stage) => hoursByStage.has(stage)).map((stage) => {
    const hit = byStage.get(stage);
    return {
      stage,
      thresholdHours: hoursByStage.get(stage) ?? 0,
      breachedCount: hit?.breached_count ?? 0,
      totalInStage: hit?.total_in_stage ?? 0,
    };
  });
}

/**
 * The pipeline & speed report: the five R0.1 measures plus the live SLA
 * standing, all over the same filtered scope.
 *
 * Source mix is requested WITHOUT zero-fill, matching getRecruitmentReport
 * — a table of eight always-empty channels is noise, unlike the funnel
 * where the empty band is the point (see the measure's contract).
 *
 * The reads are issued in sequence, not with Promise.all: they share the
 * single connection the procedure's tenant transaction holds, and
 * pipelining independent statements down one transaction buys nothing but
 * risk. The threshold read must be first regardless — the SLA query is
 * built from its result.
 */
export async function getPipelineReport(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<GetPipelineReportOutput> {
  const thresholds = await loadTenantSlaThresholds(db, tenantId);

  const funnel = await funnelByStage(db, tenantId, filters);
  const ttf = await timeToFillStats(db, tenantId, filters);
  const stageDurations = await timeInStageMedians(db, tenantId, filters);
  const sources = await sourceMix(db, tenantId, filters, { zeroFill: false });
  const offers = await offerFunnel(db, tenantId, filters);
  const sla = await slaBreaches(db, tenantId, filters, thresholds);

  return {
    funnel: funnel.map((f) => ({ stage: f.stage, count: f.count })),
    timeToFill: {
      medianDays: ttf.median_days,
      p90Days: ttf.p90_days,
      hires: ttf.hires_count,
    },
    timeInStage: stageDurations.map((s) => ({ stage: s.stage, medianDays: s.days })),
    sourceMix: sources,
    offers,
    slaBreaches: sla,
  };
}
