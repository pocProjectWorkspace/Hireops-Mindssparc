/**
 * Reporting semantic layer — the shared filter contract (R0.1).
 *
 * One filter set for every report, so "applications in period P, in BU B,
 * on requisition R" is the same question on every surface. The server-side
 * SQL builders live in `apps/api/src/lib/reports/dimensions.ts`; this is
 * the wire schema they mirror.
 *
 * Every field is optional — `{}` means "all time, whole tenant", which is
 * the default every report opens with.
 *
 * Deliberately absent: location (no locations table — free text on
 * `positions.primary_location`) and department (business unit IS the
 * department axis). See the reporting build plan §2.3.
 */

import { z } from "zod";

import { applicationSourceSchema, applicationStageSchema } from "./enums";

export const reportFiltersSchema = z.object({
  /** ISO datetime lower bound on applications.created_at (inclusive). */
  from: z.string().datetime().optional(),
  /** ISO datetime upper bound on applications.created_at (inclusive). */
  to: z.string().datetime().optional(),
  /** Business unit, resolved through requisitions → positions. */
  businessUnitId: z.string().uuid().optional(),
  /** A single requisition. */
  requisitionId: z.string().uuid().optional(),
  /** The application's assigned recruiter (tenant_user_memberships.id). */
  recruiterMembershipId: z.string().uuid().optional(),
  /** Acquisition channel. */
  source: applicationSourceSchema.optional(),
  /** Current pipeline stage. */
  stage: applicationStageSchema.optional(),
});

export type ReportFilters = z.infer<typeof reportFiltersSchema>;

// ═══════════════ catalog reports (R0.2) ═══════════════
//
// The /reports catalog surface. Every catalog report takes the SAME
// `reportFiltersSchema` input (that is the point of the catalog's one
// shared filter bar) and documents, per report, which dimensions it can
// honestly honour — a report is not free to reinterpret a filter.
//
// Report schemas live in THIS file rather than procedures.ts so the
// catalog's wire contract stays in one readable place next to the filter
// set it is built on.

// ─────────── #1 requisition status & aging ───────────

/**
 * One requisition on the aging report.
 *
 * `daysOpen` is the report's whole point: for a LIVE requisition it is
 * creation → now and keeps growing; for a terminal one (filled / closed /
 * cancelled) it stops at `closedAt`. There is no `closed_at` column on
 * `requisitions` — `closedAt` is derived from the FIRST
 * `requisition_state_transitions` row into the requisition's current
 * terminal status, and is null both for live requisitions and for the
 * (data-quality) case of a terminal requisition with no such transition
 * recorded, where the clock keeps running to now.
 */
export const requisitionAgingRowSchema = z.object({
  requisitionId: z.string().uuid(),
  /** The position's title — requisitions have no title of their own. */
  title: z.string(),
  /** requisitions.status (8 values; text + CHECK, not an enum type). */
  status: z.string(),
  /** True for filled / closed / cancelled — the server owns this definition. */
  isTerminal: z.boolean(),
  openings: z.number().int(),
  businessUnitId: z.string().uuid(),
  businessUnitName: z.string(),
  /** requisitions.primary_recruiter_id — the req's single owner. */
  recruiterMembershipId: z.string().uuid(),
  /** display_name → email-local-part → null, resolved off the RLS path. */
  recruiterName: z.string().nullable(),
  createdAt: z.string(),
  /** First transition into the current terminal status; null while live. */
  closedAt: z.string().nullable(),
  /** Days from creation to closedAt (terminal) or now (live), 2dp. */
  daysOpen: z.number(),
});

/**
 * Aging rolled up by status: how many requisitions sit in each status and
 * how old they are on average. Computed over the FULL filtered set (not
 * the possibly-capped row list) and zero-filled across all eight statuses
 * so the chip row is stable; `avgDaysOpen` is null for an empty status.
 */
export const requisitionAgingStatusRollupSchema = z.object({
  status: z.string(),
  count: z.number().int(),
  avgDaysOpen: z.number().nullable(),
});

/**
 * Filters honoured: period (bounding `requisitions.created_at`, NOT
 * applications), businessUnitId, recruiterMembershipId (the req's primary
 * recruiter). requisitionId / source / stage are application-axis
 * dimensions with no meaning here and are ignored.
 */
export const getRequisitionAgingReportInputSchema = reportFiltersSchema;

export const getRequisitionAgingReportOutputSchema = z.object({
  /** Oldest first (daysOpen desc). Capped; see `truncated`. */
  rows: z.array(requisitionAgingRowSchema),
  byStatus: z.array(requisitionAgingStatusRollupSchema),
  /** True when the row cap trimmed the list — the rollup is still complete. */
  truncated: z.boolean(),
});

export type RequisitionAgingRow = z.infer<typeof requisitionAgingRowSchema>;
export type RequisitionAgingStatusRollup = z.infer<typeof requisitionAgingStatusRollupSchema>;
export type GetRequisitionAgingReportInput = z.infer<typeof getRequisitionAgingReportInputSchema>;
export type GetRequisitionAgingReportOutput = z.infer<typeof getRequisitionAgingReportOutputSchema>;

// ─────────── #5 recruiter productivity ───────────

/**
 * One recruiter's output. TWO attribution rules, deliberately different
 * and deliberately documented on the wire:
 *   - `reqsOwned` counts requisitions whose PRIMARY RECRUITER is this
 *     membership, over the REQUISITION-created window.
 *   - the four activity counts are attributed through
 *     `applications.assigned_recruiter_membership_id`, over the
 *     APPLICATION-created window.
 * So a recruiter can show activity in a period without owning a req
 * created in it, and vice versa.
 */
export const recruiterProductivityRowSchema = z.object({
  recruiterMembershipId: z.string().uuid(),
  recruiterName: z.string().nullable(),
  /** Requisitions where this membership is primary_recruiter_id. */
  reqsOwned: z.number().int(),
  /** Applications assigned to this recruiter. */
  applications: z.number().int(),
  /** Interviews booked on those applications (any status). */
  interviewsScheduled: z.number().int(),
  /** Offers on those applications with extended_at stamped. */
  offersExtended: z.number().int(),
  /** Those applications now at stage offer_accepted — the platform's "hire". */
  hires: z.number().int(),
});

/**
 * Filters honoured: period (see the row schema's two-window note),
 * businessUnitId (both axes), source + stage + requisitionId (activity
 * counts only — they are application attributes), recruiterMembershipId
 * (narrows to one recruiter on both axes).
 */
export const getRecruiterProductivityReportInputSchema = reportFiltersSchema;

export const getRecruiterProductivityReportOutputSchema = z.object({
  /** Busiest first (applications desc). */
  rows: z.array(recruiterProductivityRowSchema),
});

export type RecruiterProductivityRow = z.infer<typeof recruiterProductivityRowSchema>;
export type GetRecruiterProductivityReportInput = z.infer<
  typeof getRecruiterProductivityReportInputSchema
>;
export type GetRecruiterProductivityReportOutput = z.infer<
  typeof getRecruiterProductivityReportOutputSchema
>;

// ─────────── #2/#3/#4/#6/#10 pipeline & speed ───────────
//
// ONE report over the R0.1 measures: the funnel (#2), time to fill (#3),
// time in stage (#4a), source mix (#6) and the offer funnel (#10) — plus
// SLA breaches (#4b), the half of "stage velocity & SLA" that no measure
// covered. They ship as one procedure because they answer one question
// ("where is the pipeline, and how fast is it moving?") over one filtered
// scope, and splitting them would mean five round trips per filter change.
//
// Field names are camelCase here, matching the rest of the catalog — the
// snake_case on getRecruitmentReport / getHrMetrics is legacy those
// surfaces keep; nothing on /reports inherits it.

/** One funnel band — applications whose CURRENT stage is `stage`. */
export const pipelineFunnelBandSchema = z.object({
  stage: applicationStageSchema,
  count: z.number().int(),
});

/** Median / P90 days to hire, and the hire count they are computed over. */
export const pipelineTimeToFillSchema = z.object({
  medianDays: z.number().nullable(),
  p90Days: z.number().nullable(),
  /** Applications currently at offer_accepted — the percentile population. */
  hires: z.number().int(),
});

/**
 * Median days spent in a stage, over COMPLETED visits only. Null for a
 * stage nobody has finished passing through — including every terminal
 * stage, which is never left.
 */
export const pipelineStageDurationSchema = z.object({
  stage: applicationStageSchema,
  medianDays: z.number().nullable(),
});

/** One acquisition channel's volume and its hire conversion. */
export const pipelineSourceMixRowSchema = z.object({
  source: z.string(),
  applications: z.number().int(),
  hires: z.number().int(),
});

/** Offer lifecycle counts; the invariant extended >= accepted + declined holds. */
export const pipelineOfferFunnelSchema = z.object({
  drafted: z.number().int(),
  extended: z.number().int(),
  accepted: z.number().int(),
  declined: z.number().int(),
});

/**
 * One stage's SLA standing, RIGHT NOW.
 *
 * DEFINITION — an SLA breach is an application whose CURRENT stage has a
 * threshold and which has been sitting in it (`stage_entered_at`) longer
 * than that threshold's hours. It is a live snapshot, not a history: an
 * application that ran late through recruiter_review and has since moved
 * on does not appear. Thresholds are the tenant's RESOLVED map
 * (`tenants.settings.slaThresholds` over the code defaults), so a tenant
 * override genuinely moves these numbers.
 *
 * A row is emitted for every stage that HAS a threshold, breached or not
 * (so the table doesn't reflow as data moves); stages with no threshold —
 * the four terminals, plus any stage the tenant has disabled — produce no
 * row at all.
 */
export const pipelineSlaBreachRowSchema = z.object({
  stage: applicationStageSchema,
  /** The tenant's resolved threshold for this stage, in hours. */
  thresholdHours: z.number(),
  /** In-stage applications past the threshold. */
  breachedCount: z.number().int(),
  /** In-stage applications in total — the breach's denominator. */
  totalInStage: z.number().int(),
});

/**
 * Filters honoured: ALL of them — every part of this report is an
 * application-axis measure resolved through `buildApplicationScope`
 * (period bounds `applications.created_at`). Note what that means for the
 * SLA rows: the breach test is against `now()`, but the population is
 * still "applications CREATED in the window", so a narrow period narrows
 * which live breaches you are looking at rather than back-dating them.
 */
export const getPipelineReportInputSchema = reportFiltersSchema;

export const getPipelineReportOutputSchema = z.object({
  /** Zero-filled across all 11 stages, in canonical enum order. */
  funnel: z.array(pipelineFunnelBandSchema),
  timeToFill: pipelineTimeToFillSchema,
  /** Zero-filled across all 11 stages, in canonical enum order. */
  timeInStage: z.array(pipelineStageDurationSchema),
  /** PRESENT channels only (matching /admin/reports), busiest first. */
  sourceMix: z.array(pipelineSourceMixRowSchema),
  offers: pipelineOfferFunnelSchema,
  /** Thresholded stages only, in canonical stage order. */
  slaBreaches: z.array(pipelineSlaBreachRowSchema),
});

export type PipelineFunnelBand = z.infer<typeof pipelineFunnelBandSchema>;
export type PipelineTimeToFill = z.infer<typeof pipelineTimeToFillSchema>;
export type PipelineStageDuration = z.infer<typeof pipelineStageDurationSchema>;
export type PipelineSourceMixRow = z.infer<typeof pipelineSourceMixRowSchema>;
export type PipelineOfferFunnel = z.infer<typeof pipelineOfferFunnelSchema>;
export type PipelineSlaBreachRow = z.infer<typeof pipelineSlaBreachRowSchema>;
export type GetPipelineReportInput = z.infer<typeof getPipelineReportInputSchema>;
export type GetPipelineReportOutput = z.infer<typeof getPipelineReportOutputSchema>;
