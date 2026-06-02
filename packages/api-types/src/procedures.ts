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
  // CRS-01 added linkedinUrl + sourceText so the public apply form's
  // optional fields have somewhere to land. linkedinUrl populates
  // persons.linkedin_url on first contact; sourceText is the verbatim
  // "How did you hear about us" string the procedure keeps in the dedup
  // attempt row when it doesn't map cleanly to the source enum.
  linkedinUrl: z.string().url().max(500).optional(),
  sourceText: z.string().max(200).optional(),
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

// ─────────────── resolvePublicRequisition (CRS-01) ───────────────

/**
 * Public query that turns the URL pair (tenantSlug, reqSlug) into the
 * data the candidate apply page needs to render — requisitionId for
 * submitApplication, plus the human-readable tenant + role labels.
 *
 * NOT_FOUND if either slug doesn't resolve OR the requisition is not in
 * a publishable state (status ∈ approved | posted). This is the only
 * 404 path on the public apply route.
 */
export const resolvePublicRequisitionInputSchema = z.object({
  tenantSlug: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9-]+$/),
  reqSlug: z
    .string()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9-]+$/),
});

export const resolvePublicRequisitionOutputSchema = z.object({
  tenantId: z.string().uuid(),
  tenantDisplayName: z.string(),
  requisitionId: z.string().uuid(),
  positionTitle: z.string(),
});

export type ResolvePublicRequisitionInput = z.infer<typeof resolvePublicRequisitionInputSchema>;
export type ResolvePublicRequisitionOutput = z.infer<typeof resolvePublicRequisitionOutputSchema>;

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

// ─────────────── Module 4: offers ───────────────

/**
 * Offer status — free text (same convention as ai_provider). The Wave 1
 * values are listed for autocomplete; future statuses can be added in a
 * follow-up without a Zod migration.
 */
export const offerStatusSchema = z.enum([
  "drafted",
  "extended",
  "accepted",
  "declined",
  "expired",
  "cancelled",
]);
export type OfferStatus = z.infer<typeof offerStatusSchema>;

export const draftOfferInputSchema = z.object({
  applicationId: z.string().uuid(),
  // Paise — bigint expressed as number in transport (JSON has no bigint;
  // we cap at Number.MAX_SAFE_INTEGER which is comfortably above any
  // realistic INR amount).
  baseSalaryInrPaise: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER),
  variableTargetInrPaise: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  joiningBonusInrPaise: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  joiningDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  location: z.string().min(1).max(200),
  termsHtml: z.string().max(50_000).optional(),
  expiryDays: z.number().int().min(1).max(60),
});

export const draftOfferOutputSchema = z.object({
  offerId: z.string().uuid(),
});

export type DraftOfferInput = z.infer<typeof draftOfferInputSchema>;
export type DraftOfferOutput = z.infer<typeof draftOfferOutputSchema>;

export const extendOfferInputSchema = z.object({ offerId: z.string().uuid() });
export const extendOfferOutputSchema = z.object({
  offerId: z.string().uuid(),
  signedLinkSentTo: z.string().email(),
});
export type ExtendOfferInput = z.infer<typeof extendOfferInputSchema>;
export type ExtendOfferOutput = z.infer<typeof extendOfferOutputSchema>;

export const cancelOfferInputSchema = z.object({
  offerId: z.string().uuid(),
  reason: z.string().min(1).max(500),
});
export const cancelOfferOutputSchema = z.object({ offerId: z.string().uuid() });
export type CancelOfferInput = z.infer<typeof cancelOfferInputSchema>;
export type CancelOfferOutput = z.infer<typeof cancelOfferOutputSchema>;

export const offerRowSchema = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  status: offerStatusSchema,
  baseSalaryInrPaise: z.number().int().positive(),
  variableTargetInrPaise: z.number().int().nonnegative().nullable(),
  joiningBonusInrPaise: z.number().int().nonnegative().nullable(),
  joiningDate: z.string(),
  location: z.string(),
  expiryAt: z.string(),
  extendedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  declinedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  declinedReason: z.string().nullable(),
  termsHtml: z.string().nullable(),
  createdAt: z.string(),
});
export type OfferRow = z.infer<typeof offerRowSchema>;

export const listOffersByApplicationInputSchema = z.object({
  applicationId: z.string().uuid(),
});
export const listOffersByApplicationOutputSchema = z.object({
  rows: z.array(offerRowSchema),
  // Surfaced so the drafting UI can gate buttons without a second query.
  applicationCurrentStage: applicationStageSchema,
});
export type ListOffersByApplicationInput = z.infer<typeof listOffersByApplicationInputSchema>;
export type ListOffersByApplicationOutput = z.infer<typeof listOffersByApplicationOutputSchema>;

// ─────────────── Module 4: public offer accept/decline (REST) ───────────────

export const offerAcceptRequestSchema = z.object({
  fullName: z.string().min(1).max(200),
});
export const offerAcceptResponseSchema = z.object({
  ok: z.literal(true),
  offerId: z.string().uuid(),
  applicationId: z.string().uuid(),
});
export type OfferAcceptRequest = z.infer<typeof offerAcceptRequestSchema>;
export type OfferAcceptResponse = z.infer<typeof offerAcceptResponseSchema>;

export const offerDeclineRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});
export const offerDeclineResponseSchema = z.object({
  ok: z.literal(true),
  offerId: z.string().uuid(),
  applicationId: z.string().uuid(),
});
export type OfferDeclineRequest = z.infer<typeof offerDeclineRequestSchema>;
export type OfferDeclineResponse = z.infer<typeof offerDeclineResponseSchema>;

// ─────────────── Module 4: integration health (admin) ───────────────

export const workdaySyncRowSchema = z.object({
  id: z.string().uuid(),
  eventType: z.string(),
  businessKey: z.string(),
  status: z.string(),
  subjectApplicationId: z.string().uuid().nullable(),
  attemptCount: z.number().int(),
  lastError: z.string().nullable(),
  simulatedAt: z.string().nullable(),
  createdAt: z.string(),
  payload: z.unknown(),
  simulatedResponse: z.unknown().nullable(),
});
export type WorkdaySyncRow = z.infer<typeof workdaySyncRowSchema>;

export const listWorkdaySyncsInputSchema = z.object({
  filters: z
    .object({
      status: z.string().optional(),
      eventType: z.string().optional(),
    })
    .optional(),
  pagination: z.object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  }),
});
export const listWorkdaySyncsOutputSchema = z.object({
  rows: z.array(workdaySyncRowSchema),
  nextCursor: z.string().nullable(),
});
export type ListWorkdaySyncsInput = z.infer<typeof listWorkdaySyncsInputSchema>;
export type ListWorkdaySyncsOutput = z.infer<typeof listWorkdaySyncsOutputSchema>;

// ─────────────── agents (AGENT-02) ───────────────

/**
 * Follow-Up Agent curated-defaults form.
 *
 * AGENT-02 ships Follow-Up only — Scheduling and Candidate-Q&A land in
 * AGENT-04+ via their own procedures. The HR-exposed fields are:
 *   - name, description
 *   - days_threshold (trigger): when an application has sat in the
 *     monitored stage for this many days, the run fires
 *   - stage (trigger): which application stage to monitor
 *   - tone (draft_message): LLM tone modifier
 *   - max_tokens (draft_message): per-draft cap; default 200
 *
 * The remaining knobs (template_prompt_id, channel, outbox_kind,
 * approver_role on send_message) are platform-curated defaults applied
 * inside the procedure; HR doesn't see them.
 */
export const createFollowUpAgentInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  days_threshold: z.number().int().positive().max(365),
  stage: z.string().min(1).max(60),
  tone: z.enum(["formal", "friendly", "neutral"]),
  max_tokens: z.number().int().positive().max(2000).default(200),
});
export const createFollowUpAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
});
export type CreateFollowUpAgentInput = z.infer<typeof createFollowUpAgentInputSchema>;
export type CreateFollowUpAgentOutput = z.infer<typeof createFollowUpAgentOutputSchema>;

export const listAgentsInputSchema = z.object({}).optional();
export const agentListRowSchema = z.object({
  id: z.string().uuid(),
  agent_type: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  version: z.number().int(),
  created_at: z.string(),
  retired_at: z.string().nullable(),
  pending_approval_count: z.number().int(),
  total_runs: z.number().int(),
  last_run_at: z.string().nullable(),
});
export type AgentListRow = z.infer<typeof agentListRowSchema>;
export const listAgentsOutputSchema = z.object({
  agents: z.array(agentListRowSchema),
});
export type ListAgentsInput = z.infer<typeof listAgentsInputSchema>;
export type ListAgentsOutput = z.infer<typeof listAgentsOutputSchema>;
