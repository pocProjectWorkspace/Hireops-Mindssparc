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

// ─────────── #9 interview & scorecard health ───────────

/**
 * The interview funnel for the period, and how fast feedback follows it.
 *
 * PERIOD AXIS — every count here is windowed on `interviews.scheduled_start`
 * ("interviews that were due to happen in this window"), NOT on when they
 * were booked and NOT on when they completed. That is the only axis on which
 * "scheduled 40, completed 31, cancelled 6" reads as one coherent sentence.
 * The column is nullable, so an interview with no start time cannot be placed
 * on the axis and drops out of ANY windowed view; with no window set it is
 * counted.
 *
 * `completionRate` = completed / (completed + cancelled + noShow) — the share
 * of interviews that REACHED A CONCLUSION and concluded by happening. Still-
 * scheduled rounds are deliberately NOT in the denominator: a round booked for
 * next week has not failed, and counting it as a miss would make the rate a
 * function of how far ahead the tenant books. 1dp; null when nothing in the
 * window has resolved yet.
 *
 * `medianHoursToFeedback` = `interview_feedback.submitted_at` −
 * `interviews.completed_at`, in HOURS (2dp), over every SUBMITTED SCORECARD
 * whose interview has a completion stamp — so a three-panelist interview
 * contributes three observations, not one, and `feedbackPairs` is that
 * population. Clamped at zero. CAVEAT, stated on the surface too: the
 * `completed_at` column arrived with migration 0115, which BACKFILLED older
 * rows as `COALESCE(scheduled_end, updated_at)`. For interviews completed
 * before 0115 this number is therefore an approximation, and can be
 * meaningfully wrong where an interview sat un-actioned before someone
 * flipped its status.
 */
export const interviewHealthTotalsSchema = z.object({
  /** Still `scheduled` — booked, not yet resolved. */
  scheduled: z.number().int(),
  completed: z.number().int(),
  cancelled: z.number().int(),
  noShow: z.number().int(),
  /** Every interview in the window, whatever its status. */
  total: z.number().int(),
  /** completed / (completed + cancelled + noShow) × 100, 1dp; null over zero. */
  completionRate: z.number().nullable(),
  /** Median hours completed_at → scorecard submitted_at, 2dp; null with no pairs. */
  medianHoursToFeedback: z.number().nullable(),
  /** Submitted scorecards behind that median — the observation count, not interviews. */
  feedbackPairs: z.number().int(),
});

/**
 * One panelist who owes scorecards.
 *
 * DEFINITION — `outstanding` counts COMPLETED interviews in the window where
 * this membership is on the panel and has no `interview_feedback` row with a
 * `submitted_at`. A saved-but-unsubmitted draft counts as outstanding, which
 * is the point: the recruiter cannot read a draft.
 */
export const interviewHealthLaggardSchema = z.object({
  membershipId: z.string().uuid(),
  /** display_name → email-local-part → null, resolved off the RLS path. */
  panelistName: z.string().nullable(),
  outstanding: z.number().int(),
});

/**
 * Scorecard coverage over the COMPLETED interviews in the window.
 *
 * `expectedScorecards` is one per (completed interview × panelist) — the
 * panel roster is the expectation, so an interview completed with no panel
 * expects nothing and cannot drag the rate down. `submittedScorecards` counts
 * those slots with a `submitted_at`. The rate is 1dp, null when nothing was
 * expected.
 */
export const interviewHealthScorecardCompletionSchema = z.object({
  interviewsCompleted: z.number().int(),
  expectedScorecards: z.number().int(),
  submittedScorecards: z.number().int(),
  /** submitted / expected × 100, 1dp; null when nothing was expected. */
  completionRate: z.number().nullable(),
  /** Worst ten by outstanding count, then name-stable by membership id. */
  laggards: z.array(interviewHealthLaggardSchema),
});

/**
 * One interview round, by its `round_name` — the plan's own label ("Tech
 * screen", "HR round"). Free text on the interview, not an enum, so the rows
 * are whatever the tenant's plans call their rounds; busiest first.
 */
export const interviewHealthRoundRowSchema = z.object({
  roundName: z.string(),
  total: z.number().int(),
  scheduled: z.number().int(),
  completed: z.number().int(),
  cancelled: z.number().int(),
  noShow: z.number().int(),
  /** Same definition as the headline median, over this round's pairs only. */
  medianHoursToFeedback: z.number().nullable(),
});

/**
 * Filters honoured: period (bounding `interviews.scheduled_start`),
 * businessUnitId and requisitionId — both resolved through the interview's
 * OWN `requisition_id` (denormalised on the row) → positions, so no
 * application join is needed and a BU filter means exactly what it means on
 * the aging report.
 *
 * recruiterMembershipId / source / stage are N/A and ignored: an interview
 * has a panel, not a recruiter; source and stage are application attributes,
 * and applying them here would silently redefine the funnel (an interview
 * belongs to the round it was booked for, not to wherever the application has
 * since moved).
 */
export const getInterviewHealthReportInputSchema = reportFiltersSchema;

export const getInterviewHealthReportOutputSchema = z.object({
  totals: interviewHealthTotalsSchema,
  scorecardCompletion: interviewHealthScorecardCompletionSchema,
  /** Busiest round first, then name A→Z. Uncapped — rounds are a small set. */
  byRound: z.array(interviewHealthRoundRowSchema),
});

export type InterviewHealthTotals = z.infer<typeof interviewHealthTotalsSchema>;
export type InterviewHealthLaggard = z.infer<typeof interviewHealthLaggardSchema>;
export type InterviewHealthScorecardCompletion = z.infer<
  typeof interviewHealthScorecardCompletionSchema
>;
export type InterviewHealthRoundRow = z.infer<typeof interviewHealthRoundRowSchema>;
export type GetInterviewHealthReportInput = z.infer<typeof getInterviewHealthReportInputSchema>;
export type GetInterviewHealthReportOutput = z.infer<typeof getInterviewHealthReportOutputSchema>;

// ─────────── #19 onboarding readiness ───────────

/**
 * One ACTIVE onboarding case — a hire the tenant has not yet landed.
 *
 * "Active" means status pre_boarding / day_zero / in_progress. A completed or
 * cancelled case still appears in `byStatus` (it is part of the mix) but not
 * in this list, which exists to answer "who starts soon and what is missing".
 *
 * `daysToStart` is `expected_start_date − CURRENT_DATE` in whole days, so it
 * is NEGATIVE for a start date that has already passed while the case is
 * still open — an overdue start, which is the finding. Null when the case has
 * no expected start date.
 *
 * The four readiness pairs, each stated because a "3 / 5" is meaningless
 * without its denominator:
 *   - TASKS — `tasksTotal` counts onboarding tasks that are still work
 *     (everything except cancelled and skipped); `tasksDone` counts
 *     `completed`. `overdueTasks` counts unfinished tasks past `due_at`.
 *   - DOCUMENTS — `docsTotal` is every upload on the case; `docsVerified`
 *     those at `verified`. A rejected or resubmit_required upload stays in
 *     the denominator: it is a document the case still needs.
 *   - BGV — `bgvStatus` is the LATEST `bgv_runs` row by `initiated_at`, or
 *     null when no check was ever raised. One case can have several runs (a
 *     re-run after a failure); the latest is the one that describes the case
 *     now.
 *   - IT — `itTotal` counts provisioning requests except cancelled ones;
 *     `itProvisioned` those at `provisioned`.
 */
export const onboardingReadinessRowSchema = z.object({
  caseId: z.string().uuid(),
  /** persons.full_name via the case's candidate; null when the person is unnamed. */
  candidateName: z.string().nullable(),
  /** onboarding_cases.status — text + CHECK, not an enum type. */
  status: z.string(),
  /** A `date` column — plain YYYY-MM-DD, not an instant. Null when unset. */
  expectedStartDate: z.string().nullable(),
  /** Whole days from today to the start date; NEGATIVE means already overdue. */
  daysToStart: z.number().int().nullable(),
  tasksDone: z.number().int(),
  tasksTotal: z.number().int(),
  /** Unfinished tasks past their due_at — the row's warning trigger. */
  overdueTasks: z.number().int(),
  docsVerified: z.number().int(),
  docsTotal: z.number().int(),
  /** Latest bgv_runs status for the case; null when no check was raised. */
  bgvStatus: z.string().nullable(),
  itProvisioned: z.number().int(),
  itTotal: z.number().int(),
});

/** Case counts by lifecycle status, zero-filled across the CHECK's five values. */
export const onboardingReadinessStatusCountSchema = z.object({
  status: z.string(),
  count: z.number().int(),
});

/**
 * The "what needs attention this fortnight" numbers, computed over the FULL
 * filtered set of ACTIVE cases — so they stay correct when the row list is
 * capped.
 *
 * `startingWithin14Days` counts active cases whose expected start falls
 * between today and today + 14 days INCLUSIVE. A start date already in the
 * past is NOT counted here — it is not "starting soon", it is late, and
 * `overdueStart` is where it lands instead.
 *
 * `bgvInProgress` / `bgvFailed` count CASES by their LATEST run's status
 * (initiated + in_progress; failed), never runs — a case that failed and was
 * re-run is in flight, not failed.
 */
export const onboardingReadinessRollupsSchema = z.object({
  activeCases: z.number().int(),
  startingWithin14Days: z.number().int(),
  /** Active cases whose expected start date has already passed. */
  overdueStart: z.number().int(),
  casesWithOverdueTasks: z.number().int(),
  bgvInProgress: z.number().int(),
  bgvFailed: z.number().int(),
});

/**
 * Filters honoured: period, bounding `onboarding_cases.expected_start_date`
 * — the axis the question is actually asked on ("who lands this month"), not
 * when the case was opened. It is a `date` column, so the ISO bounds are
 * narrowed to UTC calendar days; a case with NO expected start date cannot be
 * placed on that axis and drops out of any windowed view.
 *
 * businessUnitId resolves through the case's application → requisition →
 * position. `onboarding_cases.application_id` is NOT NULL (every case is
 * opened from an accepted offer), so the chain always resolves and no case is
 * silently dropped by the join.
 *
 * requisitionId / recruiterMembershipId / source / stage are N/A and ignored:
 * the hire has left the pipeline, so its stage and source describe history,
 * and the recruiter who sourced them does not own their onboarding.
 */
export const getOnboardingReadinessReportInputSchema = reportFiltersSchema;

export const getOnboardingReadinessReportOutputSchema = z.object({
  /** Zero-filled across all five case statuses, in lifecycle order. */
  byStatus: z.array(onboardingReadinessStatusCountSchema),
  /** Active cases, soonest start first, undated last. Capped; see `truncated`. */
  rows: z.array(onboardingReadinessRowSchema),
  rollups: onboardingReadinessRollupsSchema,
  /** True when the row cap trimmed the list — the rollups are still complete. */
  truncated: z.boolean(),
});

export type OnboardingReadinessRow = z.infer<typeof onboardingReadinessRowSchema>;
export type OnboardingReadinessStatusCount = z.infer<typeof onboardingReadinessStatusCountSchema>;
export type OnboardingReadinessRollups = z.infer<typeof onboardingReadinessRollupsSchema>;
export type GetOnboardingReadinessReportInput = z.infer<
  typeof getOnboardingReadinessReportInputSchema
>;
export type GetOnboardingReadinessReportOutput = z.infer<
  typeof getOnboardingReadinessReportOutputSchema
>;

// ─────────── #23 executive summary / board pack ───────────
//
// The one page a sponsor forwards upward. It DEFINES NOTHING: every
// number below is produced by the report or measure that owns it
// (pipeline & speed, requisition aging, headcount vs plan, the partner
// scorecard, interview health) over the SAME filters, so the board pack
// and the detail sections underneath it cannot disagree. Where a number
// does not exist in the platform, this contract says so in the shape
// rather than shipping a zero — see `diversity` and `agencyCost`.

/**
 * The six numbers on the top row.
 *
 * Each is the OWNING report's number, unchanged:
 *   - `applications` / `activePipeline` / `hires` are the `applicationTotals`
 *     measure (every application in the window; those not in a terminal
 *     stage; those at `offer_accepted`).
 *   - `medianTimeToFill` is the pipeline report's median days to hire —
 *     per application, over applications RAISED in the window.
 *   - `offerAcceptanceRate` is accepted / extended × 100 from the offer
 *     funnel, 1dp; null when nothing was extended.
 *   - `oldestOpenReqDays` is the oldest NON-TERMINAL requisition on the
 *     aging report, over requisitions RAISED in the window; null when
 *     every requisition in range is closed.
 */
export const executiveSummaryHeadlineSchema = z.object({
  hires: z.number().int(),
  /** Applications received — "submissions" in sponsor language. */
  applications: z.number().int(),
  /** Applications not in a terminal stage — live pipeline. */
  activePipeline: z.number().int(),
  /** accepted / extended × 100, 1dp; null when no offer was extended. */
  offerAcceptanceRate: z.number().nullable(),
  /** Median days application → hire, 2dp; null with no hires in range. */
  medianTimeToFill: z.number().nullable(),
  /** Age of the oldest still-open requisition, 2dp; null when none is open. */
  oldestOpenReqDays: z.number().nullable(),
});

/**
 * Hires against the approved plan — the headcount report's totals, reduced
 * to the four numbers a board slide carries. `unplannedReqs` is the
 * off-plan count (requisitions with no headcount envelope), which is the
 * number a sponsor reacts to; the full envelope table lives in the
 * headcount section below.
 */
export const executiveSummaryHiresVsPlanSchema = z.object({
  plannedHeadcount: z.number().int(),
  openingsRequested: z.number().int(),
  hires: z.number().int(),
  unplannedReqs: z.number().int(),
});

/**
 * One month of the hiring-speed trend.
 *
 * DEFINITION — the median days-to-hire of the hires that LANDED in that
 * calendar month (UTC), where a hire's clock runs from the application's
 * creation to its earliest `offer_accepted` transition. Zero-filled across
 * every month the window covers, so the line has no gaps; a month with no
 * hires reports `hires: 0` and a NULL median (unknown, not zero).
 *
 * THE AXIS IS THE HIRE, and that is deliberately NOT the axis of
 * `headline.medianTimeToFill`: the headline windows on when applications
 * were RAISED, this windows on when hires LANDED. An application raised in
 * March and hired in June is in the headline's March window and in this
 * series' June bucket, so the two are not expected to reconcile.
 */
export const timeToFillTrendPointSchema = z.object({
  /** UTC calendar month, `YYYY-MM`. */
  month: z.string(),
  /** Median days to hire for that month's hires, 2dp; null when there were none. */
  medianDays: z.number().nullable(),
  hires: z.number().int(),
});

/**
 * AGENCY cost — deliberately not "cost per hire".
 *
 * The platform captures partner fees (`partner_fees`) and nothing else
 * that costs money to hire someone: there is no job-board / advertising
 * spend anywhere in the schema, and no internal recruiter cost model. A
 * blended cost-per-hire would therefore be a number with two of its three
 * terms missing, so this contract publishes only the term that exists and
 * names it for what it is. The surface carries the same caveat in words.
 *
 * Both numbers come from ONE population on ONE clock: `partner_fees` rows
 * at status accrued / payable / paid (disputed excluded, matching the
 * commercials ledger and the partner scorecard), windowed on `hired_at`
 * because a fee belongs to the month of the hire. `agencyHires` is
 * therefore the number of FEE-BEARING hires, not every partner-sourced
 * hire — a partner hire with no MSA accrues no fee and is not in either
 * number, which keeps the division honest.
 */
export const executiveSummaryAgencyCostSchema = z.object({
  /** bigint minor units as a string — "0" when nothing accrued in range. */
  agencySpendMinor: z.string(),
  /** ISO currency of the accrued rows; null when there are none, "MIXED" if a tenant mixes them. */
  currency: z.string().nullable(),
  /** Fee-bearing partner hires in range — the divisor. */
  agencyHires: z.number().int(),
  /** spend / hires in minor units, floored, as a string; null when there are no fee-bearing hires. */
  costPerAgencyHireMinor: z.string().nullable(),
});

/**
 * Pipeline health in two sentences: how much is late, and whether the
 * interviews we book are happening.
 *
 * `totalSlaBreaches` / `breachedStages` are rolled up from the pipeline
 * report's SLA table — a breach is an application sitting in a thresholded
 * stage past the tenant's limit, RIGHT NOW (a live snapshot, not history).
 * `interviewCompletionRate` is the interview-health report's rate:
 * completed / (completed + cancelled + no-show) over interviews DUE in the
 * window; null when nothing in the window has resolved yet.
 */
export const executiveSummaryPipelineHealthSchema = z.object({
  totalSlaBreaches: z.number().int(),
  /** How many stages have at least one breach — the spread, not just the volume. */
  breachedStages: z.number().int(),
  interviewsCompleted: z.number().int(),
  /** completed / resolved × 100, 1dp; null when nothing resolved in the window. */
  interviewCompletionRate: z.number().nullable(),
});

/**
 * AI governance — ADMIN ONLY, hence nullable.
 *
 * The underlying ledger (`ai_usage_logs`) is admin-gated everywhere else it
 * surfaces (`getAiUsageSummary` → USERS_ADMIN_ROLES, /admin/costs), and the
 * board pack is readable by hr_head and hr_ops. Rather than widen that gate
 * sideways through a composite report, the block is NULL for a non-admin
 * caller and the surface prints an admin-only note in its place.
 *
 * `costMicros` is micro-USD as a string (bigint; JSON cannot carry one),
 * the same idiom `getAiUsageSummary` uses. The window bounds
 * `ai_usage_logs.created_at`.
 */
export const executiveSummaryAiGovernanceSchema = z.object({
  calls: z.number().int(),
  /** Micro-USD (1 USD = 1,000,000) as a decimal string. */
  costMicros: z.string(),
  failures: z.number().int(),
});

/**
 * Diversity — a TYPED PLACEHOLDER, on the wire on purpose.
 *
 * There are zero demographic fields on `persons` / `candidates`: capture is
 * a legal/consent decision (DPDPA vs EEOC framing differ) that has not been
 * taken, so the platform cannot report a diversity funnel and must not
 * imply otherwise. A silent omission would read as "we forgot" and a zero
 * would be a lie, so the board pack carries an explicit "not captured"
 * line and this contract already has the shape the real block will slot
 * into when capture lands.
 */
export const executiveSummaryDiversitySchema = z.object({
  available: z.literal(false),
  reason: z.literal("not_captured"),
});

/**
 * Filters honoured: the whole bar, each part on ITS OWN report's terms —
 * the board pack cannot honour a filter more or less than the section it
 * summarises, or the two would disagree. So:
 *   - the headline and pipeline-health SLA numbers take everything, on the
 *     application axis (period bounds `applications.created_at`);
 *   - `oldestOpenReqDays` takes period + BU + recruiter on the REQUISITION
 *     axis (period bounds `requisitions.created_at`);
 *   - `hiresVsPlan` takes period + BU, and its period is an OVERLAP test on
 *     the envelope's own period;
 *   - `timeToFillTrend` redirects the period onto the HIRE date;
 *   - `agencyCost` windows on `partner_fees.hired_at` and takes BU +
 *     requisition;
 *   - the interview completion rate windows on `interviews.scheduled_start`;
 *   - `aiGovernance` takes the period only (there is no BU on an LLM call).
 * Each of those asymmetries is documented on the report that owns it; this
 * report inherits them rather than re-deciding them.
 */
export const getExecutiveSummaryReportInputSchema = reportFiltersSchema;

export const getExecutiveSummaryReportOutputSchema = z.object({
  headline: executiveSummaryHeadlineSchema,
  hiresVsPlan: executiveSummaryHiresVsPlanSchema,
  /** Oldest month first, zero-filled, at most the most recent 36 months. */
  timeToFillTrend: z.array(timeToFillTrendPointSchema),
  agencyCost: executiveSummaryAgencyCostSchema,
  pipelineHealth: executiveSummaryPipelineHealthSchema,
  /** Null for a non-admin caller — see the block's own note. */
  aiGovernance: executiveSummaryAiGovernanceSchema.nullable(),
  /** Always `{ available: false, reason: "not_captured" }` today. */
  diversity: executiveSummaryDiversitySchema,
});

export type ExecutiveSummaryHeadline = z.infer<typeof executiveSummaryHeadlineSchema>;
export type ExecutiveSummaryHiresVsPlan = z.infer<typeof executiveSummaryHiresVsPlanSchema>;
export type TimeToFillTrendPoint = z.infer<typeof timeToFillTrendPointSchema>;
export type ExecutiveSummaryAgencyCost = z.infer<typeof executiveSummaryAgencyCostSchema>;
export type ExecutiveSummaryPipelineHealth = z.infer<typeof executiveSummaryPipelineHealthSchema>;
export type ExecutiveSummaryAiGovernance = z.infer<typeof executiveSummaryAiGovernanceSchema>;
export type ExecutiveSummaryDiversity = z.infer<typeof executiveSummaryDiversitySchema>;
export type GetExecutiveSummaryReportInput = z.infer<typeof getExecutiveSummaryReportInputSchema>;
export type GetExecutiveSummaryReportOutput = z.infer<typeof getExecutiveSummaryReportOutputSchema>;
