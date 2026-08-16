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

// ─────────── #17 headcount vs plan ───────────

/**
 * One approved headcount envelope, against what hiring actually happened
 * inside it.
 *
 * The envelope model is deliberately THIN (business unit × period ×
 * planned headcount — no role families), so this report says exactly what
 * the data supports: how many requisitions were raised against the
 * envelope, how many openings they asked for, and how many of those turned
 * into hires.
 *
 * `utilisationPct` = openingsRequested / plannedHeadcount × 100, to one
 * decimal, and it can exceed 100 — an over-committed envelope is the point
 * of the report, not an error. It is null only when the envelope plans
 * zero headcount, which the DB's CHECK should prevent anyway.
 */
export const headcountEnvelopeRowSchema = z.object({
  envelopeId: z.string().uuid(),
  businessUnitId: z.string().uuid(),
  businessUnitName: z.string(),
  /** `date` columns — plain YYYY-MM-DD calendar days, not instants. */
  periodStart: z.string(),
  periodEnd: z.string(),
  plannedHeadcount: z.number().int(),
  /** headcount_envelopes.status — draft | approved | closed (text + CHECK). */
  status: z.string(),
  /** Requisitions pointing at this envelope, over the envelope's WHOLE life. */
  reqsRaised: z.number().int(),
  /** SUM(number_of_openings) over those requisitions. */
  openingsRequested: z.number().int(),
  /** Applications on those requisitions now at offer_accepted. */
  hires: z.number().int(),
  /** openingsRequested / plannedHeadcount × 100, 1dp; null when planned = 0. */
  utilisationPct: z.number().nullable(),
});

/** The same five measures summed across every envelope in range. */
export const headcountVsPlanTotalsSchema = z.object({
  envelopes: z.number().int(),
  plannedHeadcount: z.number().int(),
  reqsRaised: z.number().int(),
  openingsRequested: z.number().int(),
  hires: z.number().int(),
  utilisationPct: z.number().nullable(),
});

/**
 * Hiring that is NOT against any envelope — requisitions with a null
 * `headcount_envelope_id`. The honest counterpart to the table: a tenant
 * can look 60% utilised and still be hiring hard outside the plan.
 *
 * Deliberately count + openings only, with no row list: the interesting
 * fact is the size of the gap, and the requisitions themselves are already
 * listed in full on the aging report.
 */
export const headcountUnplannedSchema = z.object({
  reqsRaised: z.number().int(),
  openingsRequested: z.number().int(),
});

/**
 * Filters honoured: businessUnitId (the ENVELOPE's business unit) and
 * period. The period test is an OVERLAP, not containment: an envelope is
 * in range when `period_start <= to AND period_end >= from`, so a
 * quarter's envelope shows up for any window that touches it.
 *
 * The unplanned figure has no envelope period to overlap, so it uses the
 * requisition axis instead — requisitions RAISED in the window
 * (`requisitions.created_at`), in the same business unit. The two halves
 * therefore answer "which plans touch this window" and "what was raised
 * off-plan in this window"; that asymmetry is stated on the surface.
 *
 * requisitionId / recruiterMembershipId / source / stage are N/A — an
 * envelope is a budget line, not an application or a recruiter's work —
 * and are ignored rather than guessed at.
 */
export const getHeadcountVsPlanReportInputSchema = reportFiltersSchema;

export const getHeadcountVsPlanReportOutputSchema = z.object({
  /** Newest period first, then business unit A→Z. */
  envelopes: z.array(headcountEnvelopeRowSchema),
  totals: headcountVsPlanTotalsSchema,
  unplanned: headcountUnplannedSchema,
});

export type HeadcountEnvelopeRow = z.infer<typeof headcountEnvelopeRowSchema>;
export type HeadcountVsPlanTotals = z.infer<typeof headcountVsPlanTotalsSchema>;
export type HeadcountUnplanned = z.infer<typeof headcountUnplannedSchema>;
export type GetHeadcountVsPlanReportInput = z.infer<typeof getHeadcountVsPlanReportInputSchema>;
export type GetHeadcountVsPlanReportOutput = z.infer<typeof getHeadcountVsPlanReportOutputSchema>;

// ─────────── #18 approval cycle analytics ───────────

/** Requests by lifecycle status, zero-filled across the enum. */
export const approvalStatusCountSchema = z.object({
  status: z.string(),
  count: z.number().int(),
});

/**
 * How long approvals take, end to end.
 *
 * DEFINITION — a request is DECIDED when `decided_at` is stamped, whatever
 * terminal status it landed in (approved, rejected, cancelled, expired);
 * turnaround is requested_at → decided_at in HOURS. Both percentiles are
 * null when nothing in range has been decided.
 *
 * `oldestPendingHours` is measured against now(), so it keeps growing —
 * it is the "what is stuck right now" number, not a historical one.
 */
export const approvalTurnaroundSchema = z.object({
  medianHours: z.number().nullable(),
  p90Hours: z.number().nullable(),
  decidedCount: z.number().int(),
  pendingCount: z.number().int(),
  oldestPendingHours: z.number().nullable(),
});

/**
 * One approver's typical response time.
 *
 * DEFINITION — a decision's clock starts at the END OF THE PREVIOUS STEP,
 * not at the request: the step's start is the previous decision on the
 * same request (ordered by step_index, then decided_at) and, for the first
 * decision, the request's `requested_at`. That is the chain's own
 * semantics — an approver at step 2 is not accountable for step 1's wait.
 * Durations are clamped at zero so an out-of-order history cannot produce
 * a negative.
 *
 * External approvers (`approver_external_ref`, no membership) have no
 * membership to attribute or name, and are excluded.
 */
export const approvalApproverRowSchema = z.object({
  approverMembershipId: z.string().uuid(),
  /** display_name → email-local-part → null, resolved off the RLS path. */
  approverName: z.string().nullable(),
  decisions: z.number().int(),
  medianHours: z.number(),
});

/** Request volume + end-to-end median per subject type, zero-filled. */
export const approvalSubjectTypeRowSchema = z.object({
  subjectType: z.string(),
  requests: z.number().int(),
  /** Median requested→decided hours; null when nothing here is decided. */
  medianHours: z.number().nullable(),
});

/**
 * Filters honoured: period ONLY, bounding `approval_requests.requested_at`
 * (inclusive both ends). businessUnitId is N/A — a request points at an
 * opaque `subject_id` with no business-unit join that holds across all
 * four subject types — as are requisitionId / recruiterMembershipId /
 * source / stage. All are ignored rather than half-applied.
 */
export const getApprovalAnalyticsReportInputSchema = reportFiltersSchema;

export const getApprovalAnalyticsReportOutputSchema = z.object({
  /** Zero-filled across all five statuses, in lifecycle order. */
  byStatus: z.array(approvalStatusCountSchema),
  turnaround: approvalTurnaroundSchema,
  /** Slowest first; at most ten rows. */
  bottleneckApprovers: z.array(approvalApproverRowSchema),
  /** Zero-filled across all four subject types, in enum order. */
  bySubjectType: z.array(approvalSubjectTypeRowSchema),
});

export type ApprovalStatusCount = z.infer<typeof approvalStatusCountSchema>;
export type ApprovalTurnaround = z.infer<typeof approvalTurnaroundSchema>;
export type ApprovalApproverRow = z.infer<typeof approvalApproverRowSchema>;
export type ApprovalSubjectTypeRow = z.infer<typeof approvalSubjectTypeRowSchema>;
export type GetApprovalAnalyticsReportInput = z.infer<typeof getApprovalAnalyticsReportInputSchema>;
export type GetApprovalAnalyticsReportOutput = z.infer<
  typeof getApprovalAnalyticsReportOutputSchema
>;

// ─────────── #7 partner / agency scorecard ───────────

/**
 * One partner organisation's standing: what it holds, what it delivered,
 * how fast, what it cost, and how much of its volume was refused.
 *
 * Every measure's definition, stated once here because the numbers are
 * meaningless without them:
 *
 *   - `submissions` — applications carrying this org's `source_partner_id`,
 *     over the shared application scope (period bounds
 *     `applications.created_at`).
 *   - `shortlistRate` — the share of those submissions that EVER reached
 *     shortlisted / tech_interview / hr_round / offer_drafted /
 *     offer_accepted, read from `application_state_transitions` and NOT
 *     from the current stage: a candidate shortlisted and later rejected
 *     still counts, because the measure asks whether the partner sent
 *     someone worth talking to. 1dp; null when there were no submissions.
 *   - `hires` — those submissions now at `offer_accepted`, the platform's
 *     one definition of a hire; `hireRate` is hires / submissions, 1dp,
 *     null over zero submissions.
 *   - `duplicateBlocked` — `candidate_dedup_attempts` by this org's portal
 *     users decided `block_active_claim` or `block_in_pipeline`, windowed
 *     on `attempted_at`. The quality signal: volume alongside blocks is a
 *     partner farming the pipeline rather than sourcing for it.
 *   - `activeAssignments` / `activeClaims` — CURRENT state, no window.
 *   - `feesAccruedMinor` — SUM of `partner_fees.fee_minor` at status
 *     accrued / payable / paid, windowed on `hired_at` (a fee belongs to
 *     the month of the HIRE). `disputed` is excluded, exactly as the
 *     commercials rollups exclude it. Minor units, as a STRING (bigint,
 *     the `cost_micros` idiom); "0" when nothing accrued, with a null
 *     `feesCurrency`.
 *   - `medianDaysToSubmit` — per (org, requisition), the days from the
 *     org's earliest assignment on that requisition to its first
 *     submission on it, medianed across pairs (2dp, clamped at zero). Null
 *     when the org has no assignment-and-submission pair in range.
 */
export const partnerScorecardRowSchema = z.object({
  partnerOrgId: z.string().uuid(),
  orgName: z.string(),
  /** partner_orgs.tier — `empanelled` | `ad_hoc`. */
  tier: z.string(),
  /** partner_orgs.active. Inactive orgs appear only when they have activity in range. */
  active: z.boolean(),
  activeAssignments: z.number().int(),
  submissions: z.number().int(),
  /** % of submissions that ever reached shortlisted or beyond, 1dp; null over zero. */
  shortlistRate: z.number().nullable(),
  hires: z.number().int(),
  /** hires / submissions × 100, 1dp; null over zero submissions. */
  hireRate: z.number().nullable(),
  duplicateBlocked: z.number().int(),
  activeClaims: z.number().int(),
  /** bigint minor units as a string — "0" when nothing accrued in range. */
  feesAccruedMinor: z.string(),
  /** ISO currency of the accrued rows; null when there are none. */
  feesCurrency: z.string().nullable(),
  /** Median days assignment → first submission, 2dp; null with no pairs. */
  medianDaysToSubmit: z.number().nullable(),
});

/**
 * Filters honoured: period, businessUnitId and requisitionId — each on the
 * measures that can honestly carry them.
 *
 * The period is ONE window read against THREE date columns, because the
 * measures genuinely live on different clocks: `applications.created_at`
 * for submissions, both rates and the time-to-submit pairs;
 * `partner_fees.hired_at` for fees (a fee belongs to the month of the
 * hire); `candidate_dedup_attempts.attempted_at` for blocks.
 * `activeAssignments` and `activeClaims` are current-state and take no
 * window at all.
 *
 * businessUnitId narrows every requisition-anchored measure (assignments,
 * submissions, rates, the median pairs, fees) through requisition →
 * position. requisitionId narrows those too, plus duplicate blocks via the
 * `submission_metadata->>'requisitionId'` pointer the submission writers
 * record. `activeClaims` honours neither: a claim is org↔person and
 * attributes across requisitions by design, so narrowing it would report a
 * number that does not mean what the column says.
 *
 * recruiterMembershipId / source / stage are N/A and ignored — a partner is
 * not a recruiter, the source is already pinned by `source_partner_id`, and
 * a stage filter would silently redefine both rates.
 */
export const getPartnerScorecardReportInputSchema = reportFiltersSchema;

export const getPartnerScorecardReportOutputSchema = z.object({
  /**
   * Busiest first (submissions desc), then name A→Z. Uncapped — a tenant
   * empanels tens of agencies. ACTIVE orgs always appear, at zeros if that
   * is the truth; inactive orgs only when they have activity in range.
   */
  rows: z.array(partnerScorecardRowSchema),
});

export type PartnerScorecardRow = z.infer<typeof partnerScorecardRowSchema>;
export type GetPartnerScorecardReportInput = z.infer<typeof getPartnerScorecardReportInputSchema>;
export type GetPartnerScorecardReportOutput = z.infer<typeof getPartnerScorecardReportOutputSchema>;
