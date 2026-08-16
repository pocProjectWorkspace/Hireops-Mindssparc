/**
 * Catalog report #23 — EXECUTIVE SUMMARY / BOARD PACK (R1.4).
 *
 * "One page: hires vs plan, time-to-fill trend, cost per hire, pipeline
 * health, diversity, AI governance — the slide the sponsor forwards
 * upward." It is the last report in the pack and the only one that is
 * PURE COMPOSITION: it issues almost no SQL of its own, because a board
 * pack that computes its own version of a number is a board pack that
 * eventually contradicts the page underneath it.
 *
 * WHERE EVERY NUMBER COMES FROM (the whole design in one table):
 *
 *   headline.applications / activePipeline / hires  measures.applicationTotals
 *   headline.medianTimeToFill                       measures.timeToFillStats
 *   headline.offerAcceptanceRate                    measures.offerFunnel
 *   headline.oldestOpenReqDays                      getRequisitionAgingReport (#1)
 *   hiresVsPlan                                     getHeadcountVsPlanReport (#17)
 *   timeToFillTrend                                 measures.timeToFillTrend
 *   agencyCost                                      partner-scorecard.agencyFeeRollup (#7)
 *   pipelineHealth.sla*                             pipeline-report.slaBreaches (#4)
 *   pipelineHealth.interview*                       interview-health.interviewFunnelTotals (#9)
 *   aiGovernance                                    the ai_usage_logs ledger (see below)
 *   diversity                                       nothing — it does not exist (see below)
 *
 * Nothing in that column is re-derived here. The SLA half of the pipeline
 * report is reached through its two exported pieces rather than by running
 * the whole report, and the interview completion rate through the funnel
 * statement rather than all four of interview health's — same definitions,
 * a third of the round trips. Even so this is the most expensive report in
 * the catalog (~13 statements), which is the price of it agreeing with
 * everything else; it is a once-per-filter-change read on a page that
 * already issues eight.
 *
 * THE TWO HONEST GAPS, both of which are the point rather than an omission:
 *
 *   - COST PER HIRE (plan #8) is NOT computable. `partner_fees` gives real
 *     agency spend, but there is no advertising / job-board spend anywhere
 *     in the schema and no internal recruiter cost model, so two of the
 *     three terms of a blended cost-per-hire are missing. This report
 *     publishes the term that exists, names it AGENCY cost, and the surface
 *     says in words what would be needed for the blended number. Both the
 *     spend and its divisor come from `partner_fees` itself so the ratio
 *     sits on one population and one clock — see `agencyFeeRollup`.
 *
 *   - DIVERSITY (plan #13/#14) has NO data at all: zero demographic fields,
 *     pending a legal/consent decision. It appears as a literal
 *     `{ available: false, reason: "not_captured" }` — a typed placeholder,
 *     so the wire contract already has the shape capture will fill, and the
 *     surface prints "not captured" rather than a fake zero or a silent
 *     hole where a board expects a line.
 *
 * AI GOVERNANCE IS ADMIN-ONLY, and the gate is passed in rather than read
 * here. `ai_usage_logs` surfaces behind USERS_ADMIN_ROLES everywhere else
 * (getAiUsageSummary, /admin/costs), while this report is readable by
 * hr_head and hr_ops. Widening that gate sideways through a composite would
 * be a privilege escalation by convenience, so the procedure computes
 * `isAdmin` from ctx.roles and this lib simply returns null when it is
 * false; the surface prints an admin-only note in the block's place. The
 * lib takes a boolean rather than the roles because the role SET is the
 * router's business, and a lib that reads roles is a lib that will
 * eventually disagree with the router about them.
 *
 * PERIOD SEMANTICS are inherited, not invented: each part reads the shared
 * window on the axis its own report reads it on (applications.created_at,
 * requisitions.created_at, the envelope's overlapping period, the hire
 * date, partner_fees.hired_at, interviews.scheduled_start,
 * ai_usage_logs.created_at). They are listed on the wire schema and
 * restated on the surface, because a sponsor reading one page deserves to
 * know that "this quarter" is answered on six different clocks.
 *
 * House conventions inherited from R0.1/R0.2 — do not diverge: raw SQL at
 * request time inside the protected procedure's tenant transaction, an
 * explicit `tenant_id` predicate on top of RLS, ISO strings with
 * `::timestamptz` casts (never a JS Date — postgres-js cannot serialize one
 * as a raw text parameter), bigint money as `::text`, ratios in JS.
 */

import { sql as dsql } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import type {
  ExecutiveSummaryAgencyCost,
  ExecutiveSummaryAiGovernance,
  ExecutiveSummaryHeadline,
  GetExecutiveSummaryReportOutput,
  ReportFilters,
} from "@hireops/api-types";

import { getHeadcountVsPlanReport } from "./headcount-vs-plan";
import { interviewFunnelTotals } from "./interview-health";
import {
  applicationTotals,
  offerFunnel,
  timeToFillStats,
  timeToFillTrend,
  type TimeToFillTrendPoint,
} from "./measures";
import { agencyFeeRollup } from "./partner-scorecard";
import { loadTenantSlaThresholds, slaBreaches } from "./pipeline-report";
import { getRequisitionAgingReport } from "./requisition-aging";

/** postgres-js returns `{rows: …}`; fall back to the array form (matches measures.ts). */
function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

/**
 * A count against a denominator as a 1dp percentage; null when there is
 * nothing to divide by. Same contract as the scorecard's `ratePct` and the
 * headcount report's `utilisationPct` — a rate over an empty set is
 * unknown, not zero.
 */
function ratePct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Spend per fee-bearing agency hire, in minor units, as a string.
 *
 * BigInt division, so a paise-level total never loses precision on its way
 * through a float; it truncates, which for non-negative money is a floor.
 * Null when nothing was hired under a fee — "we spent nothing on nobody" is
 * not a cost per hire of zero.
 */
export function costPerAgencyHireMinor(spendMinor: string, hires: number): string | null {
  if (hires <= 0) return null;
  return (BigInt(spendMinor) / BigInt(hires)).toString();
}

/**
 * The AI ledger's three governance numbers over the report window: how many
 * model calls the tenant made, what they cost, and how many failed.
 *
 * These are the same three aggregates `getAiUsageSummary`'s totals block
 * computes (it is not callable from here — its SQL is inline in the
 * procedure — so the shape is mirrored deliberately rather than shared).
 * The window bounds `created_at`; `cost_micros` is a bigint and crosses the
 * wire as a decimal string, the house idiom for money.
 */
async function aiGovernance(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters,
): Promise<ExecutiveSummaryAiGovernance> {
  const fromClause = filters.from ? dsql`AND created_at >= ${filters.from}::timestamptz` : dsql``;
  const toClause = filters.to ? dsql`AND created_at <= ${filters.to}::timestamptz` : dsql``;
  const res = await db.execute(dsql`
    SELECT
      COUNT(*)::int AS calls,
      COALESCE(SUM(cost_micros), 0)::text AS cost_micros,
      COUNT(*) FILTER (WHERE NOT succeeded)::int AS failures
    FROM public.ai_usage_logs
    WHERE tenant_id = ${tenantId}::uuid ${fromClause} ${toClause}
  `);
  const row = asRows<{ calls: number; cost_micros: string; failures: number }>(res)[0];
  return {
    calls: row?.calls ?? 0,
    costMicros: row?.cost_micros ?? "0",
    failures: row?.failures ?? 0,
  };
}

/**
 * DEFINITION — executive summary: the six headline numbers, hiring against
 * the approved plan, the month-by-month hiring-speed trend, what the
 * agencies cost, what is late and whether interviews are happening, the AI
 * spend under governance (admin only), and an explicit statement that
 * diversity is not captured. Every figure is the owning report's own
 * figure over the same filters.
 *
 * Reads are issued in sequence, not with Promise.all: they share the single
 * connection the procedure's tenant transaction holds, and pipelining
 * independent statements down one transaction buys nothing but risk (the
 * same rule the pipeline report follows).
 */
export async function getExecutiveSummaryReport(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
  opts: { isAdmin: boolean },
): Promise<GetExecutiveSummaryReportOutput> {
  // ── headline ────────────────────────────────────────────────────────
  const totals = await applicationTotals(db, tenantId, filters);
  const ttf = await timeToFillStats(db, tenantId, filters);
  const offers = await offerFunnel(db, tenantId, filters);

  // The oldest OPEN requisition, taken from the aging report rather than
  // from a bespoke query: its rows are ordered oldest first, so the first
  // non-terminal row is the answer, and taking it from anywhere else is
  // how a board pack starts disagreeing with the table below it. (Terminal
  // requisitions can sort above it — they stop ageing at their close, but
  // an old closed req still out-ages a young open one.)
  const aging = await getRequisitionAgingReport(db, tenantId, filters);
  const oldestOpenReqDays = aging.rows.find((r) => !r.isTerminal)?.daysOpen ?? null;

  const headline: ExecutiveSummaryHeadline = {
    hires: totals.hired,
    applications: totals.applications,
    activePipeline: totals.active,
    offerAcceptanceRate: ratePct(offers.accepted, offers.extended),
    medianTimeToFill: ttf.median_days,
    oldestOpenReqDays,
  };

  // ── hires vs plan (#17, whole report, reduced to four numbers) ───────
  const headcount = await getHeadcountVsPlanReport(db, tenantId, filters);

  // ── the trend (the one new measure this ticket added) ────────────────
  const trend: TimeToFillTrendPoint[] = await timeToFillTrend(db, tenantId, filters);

  // ── agency cost — the honest subset of plan #8 ───────────────────────
  const fees = await agencyFeeRollup(db, tenantId, filters);
  const agencyCost: ExecutiveSummaryAgencyCost = {
    agencySpendMinor: fees.agencySpendMinor,
    currency: fees.currency,
    agencyHires: fees.agencyHires,
    costPerAgencyHireMinor: costPerAgencyHireMinor(fees.agencySpendMinor, fees.agencyHires),
  };

  // ── pipeline health: what is late, and are interviews happening ──────
  const thresholds = await loadTenantSlaThresholds(db, tenantId);
  const sla = await slaBreaches(db, tenantId, filters, thresholds);
  const interviews = await interviewFunnelTotals(db, tenantId, filters);

  // ── governance + the placeholder ─────────────────────────────────────
  const governance = opts.isAdmin ? await aiGovernance(db, tenantId, filters) : null;

  return {
    headline,
    hiresVsPlan: {
      plannedHeadcount: headcount.totals.plannedHeadcount,
      openingsRequested: headcount.totals.openingsRequested,
      hires: headcount.totals.hires,
      unplannedReqs: headcount.unplanned.reqsRaised,
    },
    timeToFillTrend: trend,
    agencyCost,
    pipelineHealth: {
      totalSlaBreaches: sla.reduce((sum, s) => sum + s.breachedCount, 0),
      breachedStages: sla.filter((s) => s.breachedCount > 0).length,
      interviewsCompleted: interviews.completed,
      interviewCompletionRate: interviews.completionRate,
    },
    aiGovernance: governance,
    // Not a TODO and not an oversight: there is nothing to report, and the
    // board pack says so out loud. See the header.
    diversity: { available: false, reason: "not_captured" },
  };
}
