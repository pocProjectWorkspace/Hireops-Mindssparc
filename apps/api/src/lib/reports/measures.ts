/**
 * Reporting semantic layer — MEASURES (R0.1).
 *
 * One implementation per measure, shared by every report. The doc comment
 * above each function is the SEMANTIC CONTRACT: it states the definition
 * in one sentence, and that sentence is the thing reports must not
 * silently re-invent. Changing a definition here changes it everywhere,
 * on purpose.
 *
 * Every measure takes the tenant-bound db (inside the protected
 * procedure's tenant transaction), the tenantId (emitted explicitly on top
 * of RLS), and the standard `ReportFilters`; dimension handling is
 * delegated wholesale to `buildApplicationScope`. Percentiles/averages are
 * Postgres-native (`percentile_cont`, `AVG`); enum-keyed series are
 * zero-filled in JS so the UI always renders every band.
 *
 * Provenance: `funnelByStage`, `timeToFillStats`, `timeInStageMedians` and
 * `sourceMix` are lifted verbatim from getRecruitmentReport (REPORT-01);
 * `timeInStageAvgs` and `offerFunnel` are lifted verbatim from
 * getHrMetrics (METRICS-01) so those procedures can migrate later without
 * a single number moving.
 */

import { sql as dsql, type SQL } from "drizzle-orm";
import {
  applicationSourceEnum,
  applicationStageEnum,
  type ApplicationSource,
  type ApplicationStage,
  type TenantBoundDb,
} from "@hireops/db";

import { buildApplicationScope, type ReportFilters } from "./dimensions";

/**
 * The canonical stage order for every funnel, time-in-stage table and
 * stage picker: the `application_stage` enum's own declaration order
 * (application_received → … → recruiter_rejected, terminals last). Both
 * getRecruitmentReport and getHrMetrics already emit this order; it is
 * centralised here so a future report cannot invent a different one.
 */
export const CANONICAL_STAGE_ORDER: readonly ApplicationStage[] = applicationStageEnum.enumValues;

/** The canonical source order: the `application_source` enum's own order. */
export const CANONICAL_SOURCE_ORDER: readonly ApplicationSource[] =
  applicationSourceEnum.enumValues;

/**
 * Drizzle's db.execute returns a `{rows: …}` shape under postgres-js;
 * fall back to the array form defensively (matches getRecruitmentReport /
 * getAiUsageSummary).
 */
function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

// ─────────────────────────────── funnel ───────────────────────────────

/** One funnel band: how many applications currently sit at `stage`. */
export interface FunnelBand {
  stage: ApplicationStage;
  count: number;
}

/**
 * DEFINITION — funnel: the number of applications whose CURRENT stage is
 * `stage` (a point-in-time snapshot of where the pipeline stands, not a
 * cumulative "ever reached" count), zero-filled across all 11 stages in
 * CANONICAL_STAGE_ORDER.
 */
export async function funnelByStage(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<FunnelBand[]> {
  const scope = buildApplicationScope(tenantId, filters);
  const res = await db.execute(dsql`
    SELECT a.current_stage AS stage, COUNT(*)::int AS count
    FROM public.applications a
    ${scope.join}
    WHERE ${scope.where}
    GROUP BY a.current_stage
  `);
  const byStage = new Map(
    asRows<{ stage: ApplicationStage; count: number }>(res).map((r) => [r.stage, r.count]),
  );
  return CANONICAL_STAGE_ORDER.map((stage) => ({ stage, count: byStage.get(stage) ?? 0 }));
}

// ──────────────────────────── time to fill ────────────────────────────

/** Median/P90 days to hire plus the hire count the percentiles are over. */
export interface TimeToFillStats {
  median_days: number | null;
  p90_days: number | null;
  hires_count: number;
}

/**
 * DEFINITION — time to fill: for every application that is currently at
 * `offer_accepted`, the days from `applications.created_at` to its
 * EARLIEST `offer_accepted` transition; reported as the median and P90
 * (Postgres `percentile_cont`, 2dp) over that set, with `hires_count` =
 * the size of the set. Both percentiles are null when there are no hires
 * (percentile_cont over an empty set yields NULL).
 *
 * Note this is time-to-fill measured per APPLICATION, not per requisition
 * — the same definition getRecruitmentReport has always used, lifted
 * verbatim so published numbers do not shift.
 *
 * POINT vs TREND — the difference against `timeToFillTrend`, stated on
 * both measures because reading one for the other is the easy mistake:
 * this measure buckets NOTHING (one median over the whole scope) and its
 * period bounds `applications.created_at`, i.e. "of the applications
 * raised in this window, how long did the ones that got hired take". The
 * trend buckets by the MONTH OF THE HIRE and windows on the hire event
 * instead. The two therefore answer different questions and will not
 * generally agree: an application raised in March and hired in June is in
 * this measure's March window and in the trend's June bucket.
 */
export async function timeToFillStats(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<TimeToFillStats> {
  const scope = buildApplicationScope(tenantId, filters);
  const res = await db.execute(dsql`
    WITH hired AS (
      SELECT
        a.id,
        EXTRACT(EPOCH FROM (MIN(t.transitioned_at) - a.created_at)) / 86400.0 AS days_to_hire
      FROM public.applications a
      JOIN public.application_state_transitions t
        ON t.tenant_id = a.tenant_id
       AND t.application_id = a.id
       AND t.to_stage = 'offer_accepted'
      ${scope.join}
      WHERE ${scope.where}
        AND a.current_stage = 'offer_accepted'
      GROUP BY a.id, a.created_at
    )
    SELECT
      COUNT(*)::int AS hires_count,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_to_hire)::numeric, 2)::float8
        AS median_days,
      ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY days_to_hire)::numeric, 2)::float8
        AS p90_days
    FROM hired
  `);
  return asRows<TimeToFillStats>(res)[0] ?? { hires_count: 0, median_days: null, p90_days: null };
}

// ──────────────────────── time to fill (trend) ────────────────────────

/** One month on the hiring-speed trend line. */
export interface TimeToFillTrendPoint {
  /** The hire's calendar month in UTC, `YYYY-MM`. */
  month: string;
  /** Median days from application to hire for that month's hires; null when there were none. */
  medianDays: number | null;
  hires: number;
}

/** Months the trend covers when the filter window leaves the axis open. */
export const TIME_TO_FILL_TREND_DEFAULT_MONTHS = 12;

/**
 * The longest series this measure will emit. A five-year window is a
 * legitimate ask, 240 sparkline bars is not; the series keeps the MOST
 * RECENT months and the surface says so.
 */
export const TIME_TO_FILL_TREND_MAX_MONTHS = 36;

/** First instant of `d`'s month, in UTC. */
function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** `d`'s month shifted by `n` months, in UTC (JS normalises the overflow). */
function addMonthsUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** A UTC instant as the `YYYY-MM` bucket key the SQL's to_char emits. */
function monthKeyUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The window this measure actually reads, resolved from the filter set.
 * Exported for the report that renders the series so the surface can label
 * the axis with the same bounds the numbers came from.
 */
export interface TimeToFillTrendWindow {
  /** ISO lower bound on the HIRE timestamp. */
  from: string;
  /** ISO upper bound on the HIRE timestamp. */
  to: string;
  /** Every `YYYY-MM` bucket in range, oldest first — the zero-fill key set. */
  months: string[];
  /** True when TIME_TO_FILL_TREND_MAX_MONTHS trimmed the front of the series. */
  clamped: boolean;
}

/**
 * Resolves the trend's window: `to` defaults to now, `from` defaults to the
 * first of the month TIME_TO_FILL_TREND_DEFAULT_MONTHS − 1 months before
 * it, and the whole span is clamped to the most recent
 * TIME_TO_FILL_TREND_MAX_MONTHS months.
 *
 * The bounds are used VERBATIM as the SQL predicate, so a window that opens
 * or closes mid-month produces a partial first/last bucket rather than a
 * silently widened one.
 */
export function resolveTimeToFillTrendWindow(
  filters: ReportFilters,
  opts: { months?: number } = {},
): TimeToFillTrendWindow {
  const months = opts.months ?? TIME_TO_FILL_TREND_DEFAULT_MONTHS;
  const to = filters.to ? new Date(filters.to) : new Date();
  const defaultFrom = addMonthsUtc(to, -(months - 1));
  let from = filters.from ? new Date(filters.from) : defaultFrom;

  // Clamp: keep at most MAX months, counted back from `to`'s month.
  const oldestAllowed = addMonthsUtc(to, -(TIME_TO_FILL_TREND_MAX_MONTHS - 1));
  const clamped = from.getTime() < oldestAllowed.getTime();
  if (clamped) from = oldestAllowed;

  const keys: string[] = [];
  let cursor = startOfMonthUtc(from);
  const last = startOfMonthUtc(to);
  while (cursor.getTime() <= last.getTime()) {
    keys.push(monthKeyUtc(cursor));
    cursor = addMonthsUtc(cursor, 1);
  }

  return { from: from.toISOString(), to: to.toISOString(), months: keys, clamped };
}

/**
 * DEFINITION — time to fill (TREND): the same per-application days-to-hire
 * as `timeToFillStats` (application created_at → its EARLIEST
 * `offer_accepted` transition, for applications currently at
 * `offer_accepted`), medianed WITHIN THE CALENDAR MONTH OF THE HIRE and
 * zero-filled across every month the window covers, so the sparkline has no
 * gaps. A month with no hires reports `hires: 0` and a NULL median — unknown,
 * not zero.
 *
 * THE AXIS IS THE HIRE, NOT THE APPLICATION — the one thing that separates
 * this from `timeToFillStats`, said out loud on both:
 *   - `timeToFillStats` buckets nothing and its period bounds
 *     `applications.created_at`;
 *   - this measure buckets on, AND windows on, the hire event
 *     (`application_state_transitions.transitioned_at` into
 *     `offer_accepted`). "March" here means "the hires that landed in
 *     March", which is the only reading under which a trend line is a
 *     trend rather than a cohort study.
 * So the two do not agree by construction, and neither is wrong.
 *
 * Consequences of that choice, stated rather than hidden:
 *   - `filters.from` / `filters.to` are REDIRECTED onto the hire timestamp
 *     and dropped before `buildApplicationScope` sees them. Every other
 *     dimension (BU, requisition, recruiter, source, stage) goes through
 *     the shared scope unchanged, so "this BU" means what it means
 *     everywhere else.
 *   - months are UTC calendar months (`date_trunc(… AT TIME ZONE 'UTC')`),
 *     matching the UTC day bounds the catalog's date filters already send.
 *   - a window that opens or closes mid-month yields a partial bucket at
 *     that end; the bucket is real, its denominator is just smaller.
 */
export async function timeToFillTrend(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters,
  opts: { months?: number } = {},
): Promise<TimeToFillTrendPoint[]> {
  const window = resolveTimeToFillTrendWindow(filters, opts);
  // The period is honoured on the HIRE axis below, so it must not also
  // narrow the application axis — see the header.
  const scope = buildApplicationScope(tenantId, { ...filters, from: undefined, to: undefined });

  const res = await db.execute(dsql`
    WITH hired AS (
      SELECT
        a.id,
        MIN(t.transitioned_at) AS hired_at,
        EXTRACT(EPOCH FROM (MIN(t.transitioned_at) - a.created_at)) / 86400.0 AS days_to_hire
      FROM public.applications a
      JOIN public.application_state_transitions t
        ON t.tenant_id = a.tenant_id
       AND t.application_id = a.id
       AND t.to_stage = 'offer_accepted'
      ${scope.join}
      WHERE ${scope.where}
        AND a.current_stage = 'offer_accepted'
      GROUP BY a.id, a.created_at
    )
    SELECT
      to_char(date_trunc('month', hired_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
      COUNT(*)::int AS hires,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_to_hire)::numeric, 2)::float8
        AS median_days
    FROM hired
    WHERE hired_at >= ${window.from}::timestamptz
      AND hired_at <= ${window.to}::timestamptz
    GROUP BY date_trunc('month', hired_at AT TIME ZONE 'UTC')
  `);

  const byMonth = new Map(
    asRows<{ month: string; hires: number; median_days: number | null }>(res).map((r) => [
      r.month,
      r,
    ]),
  );
  return window.months.map((month) => {
    const hit = byMonth.get(month);
    return {
      month,
      medianDays: hit?.median_days ?? null,
      hires: hit?.hires ?? 0,
    };
  });
}

// ─────────────────────────── time in stage ───────────────────────────

/** Days spent in a stage, under whichever aggregate the caller asked for. */
export interface StageDuration {
  stage: ApplicationStage;
  days: number | null;
}

/**
 * The canonical stage-duration CTE. LEAD over
 * (application ORDER BY transitioned_at) gives the timestamp at which the
 * application LEFT the stage it entered; the last transition per
 * application has a NULL LEAD (it is still sitting there) and is excluded,
 * which is why terminal stages always report null.
 *
 * `aggregate` is the aggregate expression over the `days` column — the one
 * axis on which getRecruitmentReport (median) and getHrMetrics (avg)
 * legitimately differ.
 */
async function stageDurations(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters,
  aggregate: SQL,
): Promise<StageDuration[]> {
  const scope = buildApplicationScope(tenantId, filters);
  const res = await db.execute(dsql`
    WITH ordered AS (
      SELECT
        t.to_stage AS stage,
        t.transitioned_at AS entered_at,
        LEAD(t.transitioned_at) OVER (
          PARTITION BY t.application_id ORDER BY t.transitioned_at
        ) AS left_at
      FROM public.application_state_transitions t
      JOIN public.applications a
        ON a.tenant_id = t.tenant_id
       AND a.id = t.application_id
      ${scope.join}
      WHERE t.tenant_id = ${tenantId}::uuid
        AND ${scope.where}
    ),
    durations AS (
      SELECT stage, EXTRACT(EPOCH FROM (left_at - entered_at)) / 86400.0 AS days
      FROM ordered
      WHERE left_at IS NOT NULL
    )
    SELECT stage, ${aggregate} AS days
    FROM durations
    GROUP BY stage
  `);
  const byStage = new Map(
    asRows<{ stage: ApplicationStage; days: number | null }>(res).map((r) => [r.stage, r.days]),
  );
  return CANONICAL_STAGE_ORDER.map((stage) => ({ stage, days: byStage.get(stage) ?? null }));
}

/**
 * DEFINITION — time in stage (median): the median number of days an
 * application spends in `stage` between entering it and leaving it,
 * counted from consecutive `application_state_transitions` pairs; stages
 * with no COMPLETED visit (including terminals, which are never left)
 * report null. Zero-filled across CANONICAL_STAGE_ORDER.
 */
export function timeInStageMedians(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<StageDuration[]> {
  return stageDurations(
    db,
    tenantId,
    filters,
    dsql`ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::numeric, 2)::float8`,
  );
}

/**
 * DEFINITION — time in stage (average): the same completed-visit
 * durations as `timeInStageMedians`, averaged instead of medianed (2dp).
 * This is the shape /metrics renders; kept alongside the median so both
 * surfaces share one CTE and one exclusion rule.
 */
export function timeInStageAvgs(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<StageDuration[]> {
  return stageDurations(db, tenantId, filters, dsql`ROUND(AVG(days)::numeric, 2)::float8`);
}

// ───────────────────────────── source mix ─────────────────────────────

/** One channel's volume and its hire conversion. */
export interface SourceMixRow {
  source: string;
  applications: number;
  hires: number;
}

/**
 * DEFINITION — source mix: applications per acquisition channel
 * (`applications.source`), with `hires` = those whose current stage is
 * `offer_accepted`, ordered by applications desc then source asc.
 *
 * Zero-fill is OPT-IN (`zeroFill: true` pads to CANONICAL_SOURCE_ORDER)
 * because both existing surfaces render present channels only — a source
 * table listing eight always-empty channels is noise, unlike the funnel
 * where the empty band is the point. New reports may opt in.
 */
export async function sourceMix(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
  opts: { zeroFill?: boolean } = {},
): Promise<SourceMixRow[]> {
  const scope = buildApplicationScope(tenantId, filters);
  const res = await db.execute(dsql`
    SELECT
      a.source AS source,
      COUNT(*)::int AS applications,
      COUNT(*) FILTER (WHERE a.current_stage = 'offer_accepted')::int AS hires
    FROM public.applications a
    ${scope.join}
    WHERE ${scope.where}
    GROUP BY a.source
    ORDER BY COUNT(*) DESC, a.source ASC
  `);
  const rows = asRows<SourceMixRow>(res).map((r) => ({
    source: r.source,
    applications: r.applications,
    hires: r.hires,
  }));
  if (!opts.zeroFill) return rows;

  const present = new Map(rows.map((r) => [r.source, r]));
  return [
    ...rows,
    ...CANONICAL_SOURCE_ORDER.filter((s) => !present.has(s)).map((source) => ({
      source: source as string,
      applications: 0,
      hires: 0,
    })),
  ];
}

// ──────────────────────────── offer funnel ────────────────────────────

/** Offer lifecycle counts. */
export interface OfferFunnel {
  drafted: number;
  extended: number;
  accepted: number;
  declined: number;
}

/**
 * DEFINITION — offer funnel: `drafted` = every offer raised (all offers
 * pass through the drafted state); `extended` = offers that reached
 * `extended` or beyond (extended_at stamped OR status in
 * extended/accepted/declined/expired, so the funnel invariant
 * extended >= accepted + declined holds even where extended_at was never
 * stamped); `accepted` / `declined` = current status. Scoped through the
 * offer's application, so the standard filters apply.
 */
export async function offerFunnel(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<OfferFunnel> {
  const scope = buildApplicationScope(tenantId, filters);
  const res = await db.execute(dsql`
    SELECT
      COUNT(*)::int AS drafted,
      COUNT(*) FILTER (
        WHERE o.extended_at IS NOT NULL
           OR o.status IN ('extended', 'accepted', 'declined', 'expired')
      )::int AS extended,
      COUNT(*) FILTER (WHERE o.status = 'accepted')::int AS accepted,
      COUNT(*) FILTER (WHERE o.status = 'declined')::int AS declined
    FROM public.offers o
    JOIN public.applications a
      ON a.tenant_id = o.tenant_id
     AND a.id = o.application_id
    ${scope.join}
    WHERE o.tenant_id = ${tenantId}::uuid
      AND ${scope.where}
  `);
  return asRows<OfferFunnel>(res)[0] ?? { drafted: 0, extended: 0, accepted: 0, declined: 0 };
}

// ─────────────────────────── headline totals ──────────────────────────

/** Headline application totals; active + hired + rejectedOrWithdrawn = applications. */
export interface ApplicationTotals {
  applications: number;
  active: number;
  hired: number;
  rejected_or_withdrawn: number;
}

/**
 * DEFINITION — totals: `applications` = every application in scope;
 * `active` = those NOT in a terminal stage; `hired` = offer_accepted;
 * `rejected_or_withdrawn` = offer_declined + withdrawn +
 * recruiter_rejected. The three partitions sum to `applications`.
 */
export async function applicationTotals(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<ApplicationTotals> {
  const scope = buildApplicationScope(tenantId, filters);
  const res = await db.execute(dsql`
    SELECT
      COUNT(*)::int AS applications,
      COUNT(*) FILTER (
        WHERE a.current_stage NOT IN
          ('offer_accepted', 'offer_declined', 'withdrawn', 'recruiter_rejected')
      )::int AS active,
      COUNT(*) FILTER (WHERE a.current_stage = 'offer_accepted')::int AS hired,
      COUNT(*) FILTER (
        WHERE a.current_stage IN ('offer_declined', 'withdrawn', 'recruiter_rejected')
      )::int AS rejected_or_withdrawn
    FROM public.applications a
    ${scope.join}
    WHERE ${scope.where}
  `);
  return (
    asRows<ApplicationTotals>(res)[0] ?? {
      applications: 0,
      active: 0,
      hired: 0,
      rejected_or_withdrawn: 0,
    }
  );
}
