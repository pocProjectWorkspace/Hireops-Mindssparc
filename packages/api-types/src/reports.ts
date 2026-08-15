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
