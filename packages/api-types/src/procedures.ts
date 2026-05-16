import { z } from "zod";
import { applicationStageSchema, applicationSourceSchema } from "./enums";

/**
 * Input + output schemas for the initial six tRPC procedures (API-01).
 *
 * Frontend imports these to validate before calling and to type result
 * shapes. AppRouter (the actual procedure registry) lives in apps/api
 * and is re-exported type-only — these schemas + types are the runtime
 * contract.
 */

// ─────────────── submitApplication ───────────────

export const submitApplicationApplicantSchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().min(3).max(40),
  locationCountry: z.string().length(2).optional(),
});

export const submitApplicationInputSchema = z.object({
  requisitionId: z.string().uuid(),
  resumeUploadKey: z.string().min(1).max(500),
  applicant: submitApplicationApplicantSchema,
  // Sources here are the ones a public apply form might realistically
  // produce. Partner channels submit via a separate authenticated path
  // (out of scope for API-01) so they're not in this union.
  source: z.enum(["career_site", "referral", "job_board", "whatsapp"]),
  consentVersion: z.string().min(1).max(40),
});

export const submitApplicationOutputSchema = z.object({
  applicationId: z.string().uuid(),
  candidateId: z.string().uuid(),
  status: z.enum(["received", "parse_failed"]),
});

export type SubmitApplicationInput = z.infer<typeof submitApplicationInputSchema>;
export type SubmitApplicationOutput = z.infer<typeof submitApplicationOutputSchema>;

// ─────────────── getCandidateById ───────────────

export const getCandidateByIdInputSchema = z.object({
  id: z.string().uuid(),
});

export const candidatePersonSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  locationCountry: z.string().nullable(),
});

export const candidateRowSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  personId: z.string().uuid(),
  source: applicationSourceSchema.nullable(),
  // parsed_skills is the canonical ParserOutput from AI-02 — typed as
  // unknown here to avoid cross-package dep churn; the recruiter detail
  // page narrows it via the parserOutputSchema from @hireops/ai-client.
  parsedSkills: z.unknown().nullable(),
  createdAt: z.string(),
});

export const getCandidateByIdOutputSchema = z.object({
  candidate: candidateRowSchema,
  person: candidatePersonSchema,
});

export type GetCandidateByIdInput = z.infer<typeof getCandidateByIdInputSchema>;
export type GetCandidateByIdOutput = z.infer<typeof getCandidateByIdOutputSchema>;

// ─────────────── listCandidates ───────────────

export const listCandidatesInputSchema = z.object({
  filters: z
    .object({
      requisitionId: z.string().uuid().optional(),
      stage: applicationStageSchema.optional(),
      source: applicationSourceSchema.optional(),
      minAiScore: z.number().min(0).max(100).optional(),
      slaBreachOnly: z.boolean().optional(),
    })
    .optional(),
  pagination: z.object({
    limit: z.number().int().min(1).max(100),
    cursor: z.string().optional(),
  }),
  sort: z.enum(["recent", "ai_score_desc", "sla_breach"]).default("recent"),
});

/**
 * Extended in Module 1b to carry what the triage cards render:
 * applicationId (target for advance/reject mutations), current stage,
 * stage_entered_at (for the SLA delta), AI score + the top-factors
 * jsonb slice for the chip rendering.
 *
 * Keeping the shape flat (vs nesting application under candidate)
 * because the triage card is application-centric — one row per
 * (candidate, application) pair, not per candidate. A candidate with
 * three applications shows as three rows.
 */
export const candidateSummarySchema = z.object({
  candidateId: z.string().uuid(),
  applicationId: z.string().uuid(),
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  source: applicationSourceSchema.nullable(),
  stage: applicationStageSchema,
  stageEnteredAt: z.string(),
  aiScore: z.number().nullable(),
  aiScoreExplanation: z.unknown().nullable(),
  createdAt: z.string(),
});

export const listCandidatesOutputSchema = z.object({
  rows: z.array(candidateSummarySchema),
  nextCursor: z.string().nullable(),
});

export type ListCandidatesInput = z.infer<typeof listCandidatesInputSchema>;
export type ListCandidatesOutput = z.infer<typeof listCandidatesOutputSchema>;

// ─────────────── getRequisitionById ───────────────

export const getRequisitionByIdInputSchema = z.object({
  id: z.string().uuid(),
});

export const requisitionRowSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  positionId: z.string().uuid(),
  jdVersionId: z.string().uuid(),
  status: z.string(),
  publicSlug: z.string().nullable(),
  createdAt: z.string(),
});

export const getRequisitionByIdOutputSchema = requisitionRowSchema;

export type GetRequisitionByIdInput = z.infer<typeof getRequisitionByIdInputSchema>;
export type GetRequisitionByIdOutput = z.infer<typeof getRequisitionByIdOutputSchema>;

// ─────────────── listRequisitions ───────────────

export const listRequisitionsInputSchema = z.object({
  filters: z
    .object({
      // businessUnitId would need a join through positions; deferred.
      status: z.string().optional(),
      primaryRecruiterId: z.string().uuid().optional(),
    })
    .optional(),
  pagination: z.object({
    limit: z.number().int().min(1).max(100),
    cursor: z.string().optional(),
  }),
});

export const listRequisitionsOutputSchema = z.object({
  rows: z.array(requisitionRowSchema),
  nextCursor: z.string().nullable(),
});

export type ListRequisitionsInput = z.infer<typeof listRequisitionsInputSchema>;
export type ListRequisitionsOutput = z.infer<typeof listRequisitionsOutputSchema>;

// ─────────────── listApplications ───────────────

export const listApplicationsInputSchema = z.object({
  filters: z
    .object({
      requisitionId: z.string().uuid().optional(),
      candidateId: z.string().uuid().optional(),
      stage: applicationStageSchema.optional(),
    })
    .optional(),
  pagination: z.object({
    limit: z.number().int().min(1).max(100),
    cursor: z.string().optional(),
  }),
});

export const applicationRowSchema = z.object({
  id: z.string().uuid(),
  requisitionId: z.string().uuid(),
  candidateId: z.string().uuid(),
  stage: applicationStageSchema,
  source: applicationSourceSchema.nullable(),
  createdAt: z.string(),
});

export const listApplicationsOutputSchema = z.object({
  rows: z.array(applicationRowSchema),
  nextCursor: z.string().nullable(),
});

export type ListApplicationsInput = z.infer<typeof listApplicationsInputSchema>;
export type ListApplicationsOutput = z.infer<typeof listApplicationsOutputSchema>;

// ─────────────── advanceApplication ───────────────

export const advanceApplicationInputSchema = z.object({
  applicationId: z.string().uuid(),
  targetStage: applicationStageSchema,
  reason: z.string().max(500).optional(),
});

export const advanceApplicationOutputSchema = z.object({
  applicationId: z.string().uuid(),
  fromStage: applicationStageSchema,
  toStage: applicationStageSchema,
  transitionId: z.string().uuid(),
});

export type AdvanceApplicationInput = z.infer<typeof advanceApplicationInputSchema>;
export type AdvanceApplicationOutput = z.infer<typeof advanceApplicationOutputSchema>;

// ─────────────── rejectApplication ───────────────

export const rejectApplicationInputSchema = z.object({
  applicationId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

export const rejectApplicationOutputSchema = advanceApplicationOutputSchema;

export type RejectApplicationInput = z.infer<typeof rejectApplicationInputSchema>;
export type RejectApplicationOutput = z.infer<typeof rejectApplicationOutputSchema>;

// ─────────────── revertApplicationStage (undo) ───────────────

export const revertApplicationStageInputSchema = z.object({
  applicationId: z.string().uuid(),
  transitionId: z.string().uuid(),
});

export const revertApplicationStageOutputSchema = z.object({
  applicationId: z.string().uuid(),
  currentStage: applicationStageSchema,
  revertTransitionId: z.string().uuid(),
});

export type RevertApplicationStageInput = z.infer<typeof revertApplicationStageInputSchema>;
export type RevertApplicationStageOutput = z.infer<typeof revertApplicationStageOutputSchema>;

// ─────────────── upload response (REST, not tRPC) ───────────────

export const uploadResumeResponseSchema = z.object({
  storageKey: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string(),
  checksum: z.string().length(64), // sha256 hex
});

export type UploadResumeResponse = z.infer<typeof uploadResumeResponseSchema>;
