import { z } from "zod";
import { applicationSourceSchema, applicationStageSchema, type ApplicationStage } from "./enums";

/**
 * PC-5 — triage at volume. Shared paging / fact-filter / sort / bulk-move
 * contracts for the recruiter's candidate lists (listCandidatesByRequisition,
 * listCandidates) and the checkbox bulk mutation (bulkMoveApplications).
 *
 * A Solenis role gets 400+ CVs; every filter here is evaluated in SQL so a page
 * of 50 never needs the whole pipeline in memory.
 */

/** Default and maximum page sizes for the paged candidate lists. */
export const CANDIDATE_LIST_PAGE_DEFAULT = 50;
export const CANDIDATE_LIST_PAGE_MAX = 200;

/** Hard cap on one bulk stage move (ids mode AND "all N matching" mode). */
export const BULK_MOVE_MAX = 500;

/** Offset paging — "Showing 51–100 of 412" needs a stable offset + total. */
export const candidateListPageSchema = z.object({
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(CANDIDATE_LIST_PAGE_MAX).default(CANDIDATE_LIST_PAGE_DEFAULT),
});
export type CandidateListPage = z.infer<typeof candidateListPageSchema>;

/**
 * Sort keys for the candidates-by-role list.
 *   - ai_score: applications.ai_score DESC NULLS LAST, then newest (the
 *     existing score ordering).
 *   - newest:   applications.created_at DESC.
 *
 * PC-6 HOOK: the evidence-screening ticket adds its ordering key here (e.g.
 * "evidence") AND a matching entry in CANDIDATE_LIST_SORT_ORDER
 * (apps/api/src/lib/candidate-list-filters.ts). Nothing else needs touching.
 */
export const candidateListSortSchema = z.enum(["ai_score", "newest"]);
export type CandidateListSort = z.infer<typeof candidateListSortSchema>;

/** Knockout verdict filter: applications.knockout_passed true / false / null. */
export const knockoutFilterSchema = z.enum(["pass", "fail", "unknown"]);
export type KnockoutFilter = z.infer<typeof knockoutFilterSchema>;

/**
 * Fact filters over PC-7's screening answers (+ partner attribution).
 *   - maxNoticeDays: the application's stated notice, else the parsed CV's.
 *     A candidate with NO known notice is excluded (unknown is not "≤ N").
 *   - maxExpectedSalaryInrPaise: expected CTC (paise, like the column). Only
 *     honoured for callers who can see pay (SCREENING_COMP_READ_ROLES); for
 *     anyone else it is ignored silently so it can't be used as an oracle.
 *   - locationContains: case-insensitive substring of the application's
 *     current location, else the person's city / country.
 *   - hasPartner: partner-attributed (source_partner_id or a partner source).
 */
export const applicationFactFiltersSchema = z.object({
  knockout: knockoutFilterSchema.optional(),
  maxNoticeDays: z.number().int().min(0).max(365).optional(),
  maxExpectedSalaryInrPaise: z.number().int().min(0).max(1e13).optional(),
  locationContains: z.string().trim().min(1).max(120).optional(),
  hasPartner: z.boolean().optional(),
});
export type ApplicationFactFilters = z.infer<typeof applicationFactFiltersSchema>;

/**
 * The full filter set of the candidates-by-role list. The bulk mutation's
 * "select all N matching" mode re-uses this exact shape so the server resolves
 * the same set the recruiter is looking at.
 */
export const candidateListFilterSchema = applicationFactFiltersSchema.extend({
  search: z.string().max(120).optional(),
  stage: applicationStageSchema.optional(),
  source: applicationSourceSchema.optional(),
  requisitionId: z.string().uuid().optional(),
});
export type CandidateListFilter = z.infer<typeof candidateListFilterSchema>;

/** Paging metadata echoed by a paged list. `total` = every matching row. */
export const candidateListPageInfoSchema = z.object({
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
  total: z.number().int().min(0),
});
export type CandidateListPageInfo = z.infer<typeof candidateListPageInfoSchema>;

// ─────────────────────────── stage helpers ───────────────────────────

/**
 * The next legal pipeline stage for "Advance" (row action + bulk). Terminal and
 * end-of-pipeline stages have no entry.
 */
export const NEXT_PIPELINE_STAGE: Partial<Record<ApplicationStage, ApplicationStage>> = {
  application_received: "recruiter_review",
  ai_screening: "recruiter_review",
  recruiter_review: "shortlisted",
  shortlisted: "tech_interview",
  tech_interview: "hr_round",
  hr_round: "offer_drafted",
  offer_drafted: "offer_accepted",
};

/** Closed applications — nothing to advance or reject. */
export const CLOSED_APPLICATION_STAGES: ReadonlySet<ApplicationStage> = new Set<ApplicationStage>([
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
]);

// ─────────────────────────── bulk move ───────────────────────────

export const bulkMoveActionSchema = z.enum(["advance_next", "reject", "move_to_stage"]);
export type BulkMoveAction = z.infer<typeof bulkMoveActionSchema>;

export const bulkMoveSelectionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("ids"),
    applicationIds: z.array(z.string().uuid()).min(1).max(BULK_MOVE_MAX),
  }),
  z.object({
    /** "Select all N matching" — the server re-resolves the filter. */
    mode: z.literal("filter"),
    filter: candidateListFilterSchema,
  }),
]);
export type BulkMoveSelection = z.infer<typeof bulkMoveSelectionSchema>;

export const bulkMoveApplicationsInputSchema = z
  .object({
    action: bulkMoveActionSchema,
    /** Required for move_to_stage; ignored otherwise. */
    targetStage: applicationStageSchema.optional(),
    reason: z.string().trim().max(500).optional(),
    selection: bulkMoveSelectionSchema,
  })
  .refine((v) => v.action !== "move_to_stage" || v.targetStage !== undefined, {
    message: "targetStage is required for move_to_stage",
    path: ["targetStage"],
  });
export type BulkMoveApplicationsInput = z.infer<typeof bulkMoveApplicationsInputSchema>;

/**
 * Why a row was not moved.
 *   - not_found: not visible to the caller (other tenant / deleted).
 *   - closed: already rejected / withdrawn / declined.
 *   - no_next_stage: "advance" on a row with no next stage.
 *   - already_at_stage: already at the target.
 *   - gate_blocked: a deterministic stage gate refused it (HR-round assessment,
 *     tenant candidate-field policy) — `message` carries the gate's text.
 *   - error: unexpected failure for this row (the batch continued).
 */
export const bulkMoveSkipReasonSchema = z.enum([
  "not_found",
  "closed",
  "no_next_stage",
  "already_at_stage",
  "gate_blocked",
  "error",
]);
export type BulkMoveSkipReason = z.infer<typeof bulkMoveSkipReasonSchema>;

export const bulkMoveRowResultSchema = z.object({
  applicationId: z.string().uuid(),
  status: z.enum(["moved", "skipped"]),
  fromStage: applicationStageSchema.nullable(),
  toStage: applicationStageSchema.nullable(),
  transitionId: z.string().uuid().nullable(),
  skipReason: bulkMoveSkipReasonSchema.nullable(),
  message: z.string().nullable(),
});
export type BulkMoveRowResult = z.infer<typeof bulkMoveRowResultSchema>;

export const bulkMoveApplicationsOutputSchema = z.object({
  requested: z.number().int().min(0),
  moved: z.number().int().min(0),
  skipped: z.number().int().min(0),
  results: z.array(bulkMoveRowResultSchema),
});
export type BulkMoveApplicationsOutput = z.infer<typeof bulkMoveApplicationsOutputSchema>;

// ─────────────────────────── reject email preview ───────────────────────────

export const previewApplicationClosedEmailInputSchema = z.object({
  /** Render with this role's title; omitted → a neutral placeholder. */
  requisitionId: z.string().uuid().optional(),
});
export type PreviewApplicationClosedEmailInput = z.infer<
  typeof previewApplicationClosedEmailInputSchema
>;

export const previewApplicationClosedEmailOutputSchema = z.object({
  subject: z.string(),
  html: z.string(),
  /**
   * Always false today: the reject path (transitionApplicationStage) always
   * enqueues the closing email for a candidate with an email on file, and has
   * no suppression switch. The UI shows the preview, not a toggle.
   */
  suppressionSupported: z.boolean(),
});
export type PreviewApplicationClosedEmailOutput = z.infer<
  typeof previewApplicationClosedEmailOutputSchema
>;
