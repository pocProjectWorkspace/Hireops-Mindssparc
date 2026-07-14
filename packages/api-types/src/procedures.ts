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
  baseSalaryInrPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  variableTargetInrPaise: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  joiningBonusInrPaise: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
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
  // ROBUST-01 Fix 3: constrain to the application_stage enum labels
  // (source of truth: packages/db/src/schema/application-stage.ts, mirrored
  // by applicationStageSchema in ./enums). Previously an unconstrained
  // string, which let an agent watch a nonexistent stage (e.g. the old
  // hand-made 'tech_screen' agent that never fired).
  stage: applicationStageSchema,
  tone: z.enum(["formal", "friendly", "neutral"]),
  max_tokens: z.number().int().positive().max(2000).default(200),
});
export const createFollowUpAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
});
export type CreateFollowUpAgentInput = z.infer<typeof createFollowUpAgentInputSchema>;
export type CreateFollowUpAgentOutput = z.infer<typeof createFollowUpAgentOutputSchema>;

// ─────────────── Scheduling agent CRUD (AGENT-04b) ───────────────

/**
 * createSchedulingAgent — Scheduling-type analogue of
 * createFollowUpAgent. Curated default subset for the Scheduling agent
 * type (the DB does not constrain trigger/action types per agent_type;
 * curation lives here per AGENT-04a's locked decision):
 *
 *   Trigger:  stage_entered on `shortlisted` (recruiter-cleared,
 *             interview-ready). HR can override via input.stage.
 *   Action 1: propose_calendar_slots — queries the panel calendar
 *             integration for free slots within the window.
 *   Action 2: create_calendar_event — books a slot the recruiter
 *             approved + the candidate confirmed.
 *
 *   Approval rules:
 *     - propose_calendar_slots → human_optional, owning_recruiter.
 *       The AGENT-04b capability flip on propose_calendar_slots is
 *       what makes this gate attachable; without the flip the
 *       rule-attachment guard would reject the human_optional mode.
 *       The recruiter can review slots before the candidate sees
 *       them; auto-proceeds at TTL.
 *     - create_calendar_event → NO default rule. The worker treats
 *       missing-rule as auto-mode (drain's
 *       `rule?.approval_mode ?? "auto"`); the event books once the
 *       slots are settled. Deliberate omission, not oversight.
 */
export const createSchedulingAgentInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  stage: z.string().min(1).max(60).default("shortlisted"),
  panel_id: z.string().min(1).max(100),
  slot_count: z.number().int().positive().max(20).default(3),
  window_days: z.number().int().positive().max(60).default(7),
  duration_minutes: z.number().int().positive().max(480).default(45),
});
export const createSchedulingAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
});
export type CreateSchedulingAgentInput = z.infer<typeof createSchedulingAgentInputSchema>;
export type CreateSchedulingAgentOutput = z.infer<typeof createSchedulingAgentOutputSchema>;

/**
 * updateSchedulingAgent — versioned edit (retire + insert new row +
 * copy children) per AGENT-04a's locked model. Name is NOT editable
 * to preserve the name-anchored lineage proxy (HANDOVER #105). Every
 * other field is optional; omitted fields carry forward.
 */
export const updateSchedulingAgentInputSchema = z.object({
  agentId: z.string().uuid(),
  description: z.string().max(500).nullable().optional(),
  stage: z.string().min(1).max(60).optional(),
  panel_id: z.string().min(1).max(100).optional(),
  slot_count: z.number().int().positive().max(20).optional(),
  window_days: z.number().int().positive().max(60).optional(),
  duration_minutes: z.number().int().positive().max(480).optional(),
});
export const updateSchedulingAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
  previousAgentId: z.string().uuid(),
  version: z.number().int(),
});
export type UpdateSchedulingAgentInput = z.infer<typeof updateSchedulingAgentInputSchema>;
export type UpdateSchedulingAgentOutput = z.infer<typeof updateSchedulingAgentOutputSchema>;

export const retireSchedulingAgentInputSchema = z.object({
  agentId: z.string().uuid(),
});
export const retireSchedulingAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
  retiredAt: z.string(),
});
export type RetireSchedulingAgentInput = z.infer<typeof retireSchedulingAgentInputSchema>;
export type RetireSchedulingAgentOutput = z.infer<typeof retireSchedulingAgentOutputSchema>;

export const toggleSchedulingAgentInputSchema = z.object({
  agentId: z.string().uuid(),
  enabled: z.boolean(),
});
export const toggleSchedulingAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
  enabled: z.boolean(),
});
export type ToggleSchedulingAgentInput = z.infer<typeof toggleSchedulingAgentInputSchema>;
export type ToggleSchedulingAgentOutput = z.infer<typeof toggleSchedulingAgentOutputSchema>;

// ─────────────── Candidate Q&A agent CRUD (AGENT-04b) ───────────────

/**
 * createCandidateQaAgent — Candidate-Q&A-type analogue of
 * createFollowUpAgent + createSchedulingAgent. Curated default subset:
 *
 *   Trigger:  message_received with { channel: "email",
 *             from: "candidate" } — both fields are locked literals at
 *             AGENT-01a (no HR knobs on the trigger itself).
 *   Action 1: draft_message — LLM drafts a reply. HR knobs: tone +
 *             max_tokens (same convention as Follow-Up); curated
 *             template_prompt_id = "candidate_qa_v1".
 *   Action 2: send_message — emails the draft to the candidate.
 *             Curated defaults: channel="email",
 *             outbox_kind="candidate_qa_reply", requires_approval=true.
 *
 *   Approval rules:
 *     - draft_message → NO rule. Drafting is internal compute; the
 *       worker treats missing-rule as auto-mode. Pattern-symmetric
 *       with Scheduling's create_calendar_event omission.
 *     - send_message → human_required, owning_recruiter. An
 *       unreviewed auto-generated reply to a candidate is the
 *       highest-risk autonomous action in the surface (externally
 *       visible, unrecoverable). send_message is already capable=true
 *       (AGENT-03 flip); the create-path guard accepts this.
 *
 * No capability-map changes — both action types already have their
 * capabilities declared from earlier tickets.
 */
export const createCandidateQaAgentInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  tone: z.enum(["formal", "friendly", "neutral"]).default("friendly"),
  max_tokens: z.number().int().positive().max(2000).default(200),
});
export const createCandidateQaAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
});
export type CreateCandidateQaAgentInput = z.infer<typeof createCandidateQaAgentInputSchema>;
export type CreateCandidateQaAgentOutput = z.infer<typeof createCandidateQaAgentOutputSchema>;

/**
 * updateCandidateQaAgent — versioned edit (retire + insert new row +
 * copy children) per AGENT-04a's locked model. Name is NOT editable
 * to preserve the name-anchored lineage proxy (HANDOVER #105). Every
 * other field is optional; omitted fields carry forward.
 */
export const updateCandidateQaAgentInputSchema = z.object({
  agentId: z.string().uuid(),
  description: z.string().max(500).nullable().optional(),
  tone: z.enum(["formal", "friendly", "neutral"]).optional(),
  max_tokens: z.number().int().positive().max(2000).optional(),
});
export const updateCandidateQaAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
  previousAgentId: z.string().uuid(),
  version: z.number().int(),
});
export type UpdateCandidateQaAgentInput = z.infer<typeof updateCandidateQaAgentInputSchema>;
export type UpdateCandidateQaAgentOutput = z.infer<typeof updateCandidateQaAgentOutputSchema>;

export const retireCandidateQaAgentInputSchema = z.object({
  agentId: z.string().uuid(),
});
export const retireCandidateQaAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
  retiredAt: z.string(),
});
export type RetireCandidateQaAgentInput = z.infer<typeof retireCandidateQaAgentInputSchema>;
export type RetireCandidateQaAgentOutput = z.infer<typeof retireCandidateQaAgentOutputSchema>;

export const toggleCandidateQaAgentInputSchema = z.object({
  agentId: z.string().uuid(),
  enabled: z.boolean(),
});
export const toggleCandidateQaAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
  enabled: z.boolean(),
});
export type ToggleCandidateQaAgentInput = z.infer<typeof toggleCandidateQaAgentInputSchema>;
export type ToggleCandidateQaAgentOutput = z.infer<typeof toggleCandidateQaAgentOutputSchema>;

// ─────────────── update / retire / toggle (AGENT-04a) ───────────────

/**
 * updateFollowUpAgent — edits a Follow-Up Agent following the
 * retire-and-insert versioning model. The current row gets
 * `retired_at = now()` and a new row is inserted at `version + 1`
 * with the same name (the partial-unique active-name slot is freed by
 * the retire); all triggers / actions / approval-rules are copied to
 * the new row, with action_id rewiring on the rule copies.
 *
 * Name is intentionally NOT in the input — the name-anchored lineage
 * (open-questions HANDOVER note) assumes name stability across
 * versions. Making names editable is an AGENT-04b+ revisit.
 *
 * Every input field is optional; omitted fields carry forward from
 * the existing row / children.
 */
export const updateFollowUpAgentInputSchema = z.object({
  agentId: z.string().uuid(),
  description: z.string().max(500).nullable().optional(),
  days_threshold: z.number().int().positive().max(365).optional(),
  // ROBUST-01 Fix 3: same enum constraint as createFollowUpAgent (see note
  // there). Optional here — omitted carries the prior version's stage forward.
  stage: applicationStageSchema.optional(),
  tone: z.enum(["formal", "friendly", "neutral"]).optional(),
  max_tokens: z.number().int().positive().max(2000).optional(),
});
export const updateFollowUpAgentOutputSchema = z.object({
  /** Id of the NEW version row (now the active agent). */
  agentId: z.string().uuid(),
  /** Id of the retired previous version. */
  previousAgentId: z.string().uuid(),
  /** Version number of the new row (= previous + 1). */
  version: z.number().int(),
});
export type UpdateFollowUpAgentInput = z.infer<typeof updateFollowUpAgentInputSchema>;
export type UpdateFollowUpAgentOutput = z.infer<typeof updateFollowUpAgentOutputSchema>;

/**
 * retireFollowUpAgent — sets `retired_at = now()` on the active
 * version. Non-destructive. Frees the active-name slot for a fresh
 * agent with the same name. No new row created.
 */
export const retireFollowUpAgentInputSchema = z.object({
  agentId: z.string().uuid(),
});
export const retireFollowUpAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
  retiredAt: z.string(),
});
export type RetireFollowUpAgentInput = z.infer<typeof retireFollowUpAgentInputSchema>;
export type RetireFollowUpAgentOutput = z.infer<typeof retireFollowUpAgentOutputSchema>;

/**
 * toggleFollowUpAgent — flips the `enabled` boolean. Disabled agents
 * stay in listAgents (recruiter can see they're paused) but the
 * worker's trigger scan respects `enabled = true` so disabled agents
 * don't fire. No version row created — toggle is not a versioned edit.
 */
export const toggleFollowUpAgentInputSchema = z.object({
  agentId: z.string().uuid(),
  enabled: z.boolean(),
});
export const toggleFollowUpAgentOutputSchema = z.object({
  agentId: z.string().uuid(),
  enabled: z.boolean(),
});
export type ToggleFollowUpAgentInput = z.infer<typeof toggleFollowUpAgentInputSchema>;
export type ToggleFollowUpAgentOutput = z.infer<typeof toggleFollowUpAgentOutputSchema>;

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

// ─────────────── audit-events listing (ADMIN-02) ───────────────

/**
 * Admin audit-trail read over `audit_logs` — "every agent action, logged"
 * (demo Act 3, step 15). Newest-first, filterable, keyset-paginated on the
 * composite (created_at, id): audit rows written inside one transaction
 * share a created_at, so the id tiebreak keeps paging deterministic.
 *
 * `audit_logs` is the polymorphic row-change log written by the
 * audit_record_change() trigger — entity_type is the source table name,
 * action is the pgEnum insert/update/delete, before_data/after_data carry
 * the row diff and changed_columns names the touched columns. Reads never
 * audit, so the procedure carries no withAudit.
 */
export const listAuditEventsInputSchema = z.object({
  entityTypes: z.array(z.string().min(1).max(63)).max(20).optional(),
  action: z.enum(["insert", "update", "delete"]).optional(),
  entityId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().positive().max(100).default(50),
  cursor: z.string().optional(),
});
export const auditEventRowSchema = z.object({
  id: z.string().uuid(),
  entity_type: z.string(),
  entity_id: z.string().uuid(),
  action: z.enum(["insert", "update", "delete"]),
  actor_user_id: z.string().uuid().nullable(),
  actor_membership_id: z.string().uuid().nullable(),
  request_id: z.string().nullable(),
  source: z.string(),
  changed_columns: z.array(z.string()).nullable(),
  // jsonb row snapshots — arbitrary shape; passthrough as unknown.
  before_data: z.unknown().nullable(),
  after_data: z.unknown().nullable(),
  created_at: z.string(),
});
export const listAuditEventsOutputSchema = z.object({
  items: z.array(auditEventRowSchema),
  nextCursor: z.string().nullable(),
});
export type ListAuditEventsInput = z.infer<typeof listAuditEventsInputSchema>;
export type ListAuditEventsOutput = z.infer<typeof listAuditEventsOutputSchema>;
export type AuditEventRow = z.infer<typeof auditEventRowSchema>;

// ─────────────── AI cost dashboard (ADMIN-03) ───────────────

/**
 * Admin AI-cost rollup for /admin/costs — "every Anthropic call logged
 * with tokens and cost, per feature, per model; procurement gets a real
 * TCO number" (demo Act 3, step 16).
 *
 * Aggregates ai_usage_logs (the per-tenant LLM call ledger) into totals +
 * per-feature + per-model + per-day rollups. `from`/`to` bound the window on
 * created_at; both optional — omitted means all time. Reads only, so no
 * withAudit (ai_usage_logs carries no audit trigger and this only reads it).
 *
 * cost_micros is a bigint sum (USD micros, 1 USD = 1,000,000 micros — see
 * packages/ai-client/src/pricing.ts) and crosses the wire as a decimal
 * string: JSON can't carry a bigint, matching costMicrosSoFar in
 * pendingApprovalItemSchema. The client formats micros → USD for display.
 * byFeature / byModel are ordered by cost descending; byDay is the last 14
 * days within range, ascending.
 */
export const getAiUsageSummaryInputSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const aiUsageTotalsSchema = z.object({
  calls: z.number().int(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cost_micros: z.string(), // bigint-as-string — JSON can't carry bigint
  failures: z.number().int(),
  avg_latency_ms: z.number().int(),
});

export const aiUsageByFeatureSchema = z.object({
  feature: z.string(),
  calls: z.number().int(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cost_micros: z.string(),
  failures: z.number().int(),
});

export const aiUsageByModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  calls: z.number().int(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cost_micros: z.string(),
  failures: z.number().int(),
});

export const aiUsageByDaySchema = z.object({
  day: z.string(), // YYYY-MM-DD
  calls: z.number().int(),
  cost_micros: z.string(),
});

export const getAiUsageSummaryOutputSchema = z.object({
  totals: aiUsageTotalsSchema,
  byFeature: z.array(aiUsageByFeatureSchema),
  byModel: z.array(aiUsageByModelSchema),
  byDay: z.array(aiUsageByDaySchema),
});
export type GetAiUsageSummaryInput = z.infer<typeof getAiUsageSummaryInputSchema>;
export type GetAiUsageSummaryOutput = z.infer<typeof getAiUsageSummaryOutputSchema>;
export type AiUsageTotals = z.infer<typeof aiUsageTotalsSchema>;
export type AiUsageByFeature = z.infer<typeof aiUsageByFeatureSchema>;
export type AiUsageByModel = z.infer<typeof aiUsageByModelSchema>;
export type AiUsageByDay = z.infer<typeof aiUsageByDaySchema>;

// ─────────────── getRecruitmentReport (REPORT-01) ───────────────

/**
 * Input for the recruitment funnel + time + source report at
 * /admin/reports. from/to are optional ISO datetimes bounding
 * applications.created_at (omitted = all time). Reserved for a date-range
 * picker the UI does not yet expose — the API accepts them today so the
 * later filter lands without a contract change.
 */
export const getRecruitmentReportInputSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * One funnel row: the count of applications currently sitting at `stage`.
 * The procedure emits all 11 application_stage enum labels in enum order,
 * zero-filled, so the UI renders the full funnel even where a stage is
 * empty.
 */
export const recruitmentFunnelStageSchema = z.object({
  stage: z.string(),
  current_count: z.number().int(),
});

/**
 * Source-mix row. `applications` counts submissions on that channel;
 * `hires` counts those whose current_stage = 'offer_accepted'. Only
 * sources with at least one application appear (ordered by applications
 * desc, then source asc).
 */
export const recruitmentSourceMixSchema = z.object({
  source: z.string(),
  applications: z.number().int(),
  hires: z.number().int(),
});

/**
 * Time-to-hire summary. median_days / p90_days are days from
 * applications.created_at to the earliest offer_accepted transition,
 * across hired applications (current_stage = 'offer_accepted'). Both are
 * null when hires_count = 0 (percentile_cont over an empty set).
 */
export const recruitmentTimeToHireSchema = z.object({
  median_days: z.number().nullable(),
  p90_days: z.number().nullable(),
  hires_count: z.number().int(),
});

/**
 * One stage-duration row: the median days an application spends in
 * `stage`, from consecutive transition pairs (entered-then-left). All 11
 * stages are listed in enum order; a stage with no completed visits (incl.
 * terminal stages that are never left) carries median_days = null.
 */
export const recruitmentStageDurationSchema = z.object({
  stage: z.string(),
  median_days: z.number().nullable(),
});

/**
 * Headline totals. active = applications not in a terminal stage; hired =
 * offer_accepted; rejected_or_withdrawn = offer_declined + withdrawn +
 * recruiter_rejected. active + hired + rejected_or_withdrawn = applications.
 */
export const recruitmentTotalsSchema = z.object({
  applications: z.number().int(),
  active: z.number().int(),
  hired: z.number().int(),
  rejected_or_withdrawn: z.number().int(),
});

export const getRecruitmentReportOutputSchema = z.object({
  funnel: z.array(recruitmentFunnelStageSchema),
  sourceMix: z.array(recruitmentSourceMixSchema),
  timeToHire: recruitmentTimeToHireSchema,
  stageDurations: z.array(recruitmentStageDurationSchema),
  totals: recruitmentTotalsSchema,
});

export type GetRecruitmentReportInput = z.infer<typeof getRecruitmentReportInputSchema>;
export type GetRecruitmentReportOutput = z.infer<typeof getRecruitmentReportOutputSchema>;
export type RecruitmentFunnelStage = z.infer<typeof recruitmentFunnelStageSchema>;
export type RecruitmentSourceMix = z.infer<typeof recruitmentSourceMixSchema>;
export type RecruitmentTimeToHire = z.infer<typeof recruitmentTimeToHireSchema>;
export type RecruitmentStageDuration = z.infer<typeof recruitmentStageDurationSchema>;
export type RecruitmentTotals = z.infer<typeof recruitmentTotalsSchema>;

// ─────────────── approval-resolution (AGENT-03) ───────────────

/**
 * Approve a pending approval request without payload edits.
 *
 * Resume path: the resolution flips agent_run_actions.status='completed'
 * and re-queues the outbox (status='pending'). The next worker pass
 * picks it up, sees the completed action, skips re-execution, and
 * continues with the remaining actions.
 *
 * decisionNotes is optional — recruiters often approve silently. The
 * audit_record_change() trigger captures the full diff regardless.
 */
export const approveApprovalInputSchema = z.object({
  approvalRequestId: z.string().uuid(),
  decisionNotes: z.string().max(2000).optional(),
});
export const approveApprovalOutputSchema = z.object({
  status: z.literal("approved"),
  runId: z.string().uuid(),
});
export type ApproveApprovalInput = z.infer<typeof approveApprovalInputSchema>;
export type ApproveApprovalOutput = z.infer<typeof approveApprovalOutputSchema>;

/**
 * Approve with payload edits — recruiter tweaked the AI's draft before
 * sending. The edited payload replaces the agent_run_actions.output so
 * the worker uses the edited version on resume; the original
 * proposed_action_payload stays on the approval request for audit.
 *
 * editedPayload is loosely typed for AGENT-03 (any object). AGENT-04+
 * will tighten this per-action-type via discriminated union against
 * the corresponding executor's output schema.
 */
export const approveApprovalWithEditInputSchema = z.object({
  approvalRequestId: z.string().uuid(),
  editedPayload: z.record(z.string(), z.unknown()),
  decisionNotes: z.string().max(2000).optional(),
});
export const approveApprovalWithEditOutputSchema = z.object({
  status: z.literal("approved"),
  runId: z.string().uuid(),
});
export type ApproveApprovalWithEditInput = z.infer<typeof approveApprovalWithEditInputSchema>;
export type ApproveApprovalWithEditOutput = z.infer<typeof approveApprovalWithEditOutputSchema>;

/**
 * Reject — terminal for the run. The action_action transitions to
 * 'failed' with the rejection reason recorded, the run transitions to
 * 'rejected', and the outbox to 'failed'. decisionNotes is required
 * because a rejection without a stated reason is not a useful audit
 * record.
 */
export const rejectApprovalInputSchema = z.object({
  approvalRequestId: z.string().uuid(),
  decisionNotes: z.string().min(1).max(2000),
});
export const rejectApprovalOutputSchema = z.object({
  status: z.literal("rejected"),
  runId: z.string().uuid(),
});
export type RejectApprovalInput = z.infer<typeof rejectApprovalInputSchema>;
export type RejectApprovalOutput = z.infer<typeof rejectApprovalOutputSchema>;

/**
 * Snooze — defers the decision by 24h. Status stays 'pending'; only
 * ttl_at moves. For human_required mode the TTL is just a "show this
 * back to me later" affordance (the TTL scan clears it without auto-
 * approving); for human_optional the TTL scan auto-approves at expiry.
 */
export const snoozeApprovalInputSchema = z.object({
  approvalRequestId: z.string().uuid(),
});
export const snoozeApprovalOutputSchema = z.object({
  status: z.literal("pending"),
  snoozedUntil: z.string(),
});
export type SnoozeApprovalInput = z.infer<typeof snoozeApprovalInputSchema>;
export type SnoozeApprovalOutput = z.infer<typeof snoozeApprovalOutputSchema>;

// ─────────────── approval-queue listing (AGENT-03) ───────────────

/**
 * Pending-approval queue. Cursor-based pagination on proposed_at to
 * avoid OFFSET cost as the queue grows. Oldest-first so recruiters see
 * the longest-waiting requests at the top.
 */
export const listPendingApprovalsInputSchema = z.object({
  agentId: z.string().uuid().optional(),
  limit: z.number().int().positive().max(100).default(50),
  cursor: z.string().optional(),
});
export const pendingApprovalItemSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string(),
  agentType: z.string(),
  proposedAt: z.string(),
  proposedActionSummary: z.string(),
  proposedActionPayload: z.record(z.string(), z.unknown()),
  triggerContext: z.record(z.string(), z.unknown()),
  approverRole: z.string(),
  snoozedUntil: z.string().nullable(),
  costMicrosSoFar: z.string(), // bigint-as-string — JSON can't carry bigint
});
export const listPendingApprovalsOutputSchema = z.object({
  items: z.array(pendingApprovalItemSchema),
  nextCursor: z.string().nullable(),
});
export type ListPendingApprovalsInput = z.infer<typeof listPendingApprovalsInputSchema>;
export type ListPendingApprovalsOutput = z.infer<typeof listPendingApprovalsOutputSchema>;
export type PendingApprovalItem = z.infer<typeof pendingApprovalItemSchema>;

export const getApprovalRequestInputSchema = z.object({
  approvalRequestId: z.string().uuid(),
});
export const approvalRequestDetailSchema = pendingApprovalItemSchema.extend({
  agentDescription: z.string().nullable(),
  triggerType: z.string(),
  triggerConfig: z.record(z.string(), z.unknown()),
  actionType: z.string(),
  actionConfig: z.record(z.string(), z.unknown()),
  approvalMode: z.enum(["auto", "human_required", "human_optional"]),
  previousActions: z.array(
    z.object({
      actionOrder: z.number().int(),
      actionType: z.string(),
      status: z.string(),
      output: z.record(z.string(), z.unknown()).nullable(),
      completedAt: z.string().nullable(),
    }),
  ),
});
export const getApprovalRequestOutputSchema = approvalRequestDetailSchema;
export type GetApprovalRequestInput = z.infer<typeof getApprovalRequestInputSchema>;
export type GetApprovalRequestOutput = z.infer<typeof getApprovalRequestOutputSchema>;

// ─────────────── getAgentDetail (ADMIN-01) ───────────────

/**
 * getAgentDetail — the admin drill-in read behind /admin/workflows.
 *
 * listAgents carries the per-agent roll-up (counts + last run) for the
 * list view; this carries the full definition HR configured plus a
 * bounded run history for one agent:
 *   - agent:         the automation_agents row header fields.
 *   - triggers:      what fires the agent (trigger_config is jsonb,
 *                    passed through verbatim — shape is discriminated by
 *                    trigger_type and rendered client-side).
 *   - actions:       the ordered action pipeline (action_order asc).
 *   - approvalRules: the per-action gate (mode + approver), keyed back
 *                    to actions via action_id.
 *   - recentRuns:    the last 20 agent_runs, triggered_at desc.
 *
 * Retired agents ARE returned (retired_at is surfaced, not filtered) —
 * the detail view can be reached for a just-retired row. NOT_FOUND fires
 * only when no agent matches the id within the caller's tenant, which is
 * also the cross-tenant isolation contract (another tenant's agent reads
 * as absent, never leaked).
 *
 * jsonb columns (trigger_config, action_config, conditions) are typed as
 * `unknown` passthroughs — the same convention candidateRowSchema uses
 * for parsed_skills — so the read contract doesn't couple to each
 * action/trigger type's config shape.
 */
export const getAgentDetailInputSchema = z.object({
  agentId: z.string().uuid(),
});

export const agentDetailAgentSchema = z.object({
  id: z.string().uuid(),
  agent_type: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  version: z.number().int(),
  created_at: z.string(),
  retired_at: z.string().nullable(),
});
export type AgentDetailAgent = z.infer<typeof agentDetailAgentSchema>;

export const agentDetailTriggerSchema = z.object({
  id: z.string().uuid(),
  trigger_type: z.string(),
  trigger_config: z.unknown(),
});
export type AgentDetailTrigger = z.infer<typeof agentDetailTriggerSchema>;

export const agentDetailActionSchema = z.object({
  id: z.string().uuid(),
  action_order: z.number().int(),
  action_type: z.string(),
  action_config: z.unknown(),
});
export type AgentDetailAction = z.infer<typeof agentDetailActionSchema>;

export const agentDetailApprovalRuleSchema = z.object({
  id: z.string().uuid(),
  action_id: z.string().uuid(),
  approval_mode: z.string(),
  approver_role: z.string().nullable(),
  approver_user_id: z.string().uuid().nullable(),
  conditions: z.unknown(),
});
export type AgentDetailApprovalRule = z.infer<typeof agentDetailApprovalRuleSchema>;

export const agentDetailRunSchema = z.object({
  id: z.string().uuid(),
  triggered_by: z.string(),
  triggered_at: z.string(),
  status: z.string(),
  completed_at: z.string().nullable(),
  error: z.string().nullable(),
});
export type AgentDetailRun = z.infer<typeof agentDetailRunSchema>;

export const getAgentDetailOutputSchema = z.object({
  agent: agentDetailAgentSchema,
  triggers: z.array(agentDetailTriggerSchema),
  actions: z.array(agentDetailActionSchema),
  approvalRules: z.array(agentDetailApprovalRuleSchema),
  recentRuns: z.array(agentDetailRunSchema),
});
export type GetAgentDetailInput = z.infer<typeof getAgentDetailInputSchema>;
export type GetAgentDetailOutput = z.infer<typeof getAgentDetailOutputSchema>;

// ─────────────── onboarding cases + tasks (ONBOARD-02) ───────────────

/**
 * onboarding_cases.status / onboarding_tasks.status / task_type — text +
 * CHECK in the DB (ONBOARD-01, HANDOVER reality #114), mirrored here as
 * zod enums for the tRPC surface. Wave-1 values; additive to grow.
 */
export const onboardingCaseStatusSchema = z.enum([
  "pre_boarding",
  "day_zero",
  "in_progress",
  "completed",
  "cancelled",
]);
export type OnboardingCaseStatus = z.infer<typeof onboardingCaseStatusSchema>;

export const onboardingTaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
  "skipped",
]);
export type OnboardingTaskStatus = z.infer<typeof onboardingTaskStatusSchema>;

// ─────────── listOnboardingCases ───────────

export const onboardingCaseListRowSchema = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  candidateId: z.string().uuid(),
  status: onboardingCaseStatusSchema,
  geographyCode: z.string(),
  expectedStartDate: z.string().nullable(),
  actualStartDate: z.string().nullable(),
  probationDays: z.number().int(),
  probationEndsAt: z.string().nullable(),
  buddyMembershipId: z.string().uuid().nullable(),
  managerMembershipId: z.string().uuid().nullable(),
  workdayWorkerId: z.string().nullable(),
  candidateName: z.string().nullable(),
  positionTitle: z.string().nullable(),
  totalTasks: z.number().int(),
  completedTasks: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OnboardingCaseListRow = z.infer<typeof onboardingCaseListRowSchema>;

export const listOnboardingCasesInputSchema = z.object({
  status: onboardingCaseStatusSchema.optional(),
  limit: z.number().int().positive().max(100).default(50),
  cursor: z.string().optional(),
});
export const listOnboardingCasesOutputSchema = z.object({
  items: z.array(onboardingCaseListRowSchema),
  nextCursor: z.string().nullable(),
});
export type ListOnboardingCasesInput = z.infer<typeof listOnboardingCasesInputSchema>;
export type ListOnboardingCasesOutput = z.infer<typeof listOnboardingCasesOutputSchema>;

// ─────────── getOnboardingCaseDetail ───────────

export const onboardingTaskRowSchema = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  taskType: z.string(),
  status: onboardingTaskStatusSchema,
  title: z.string(),
  description: z.string().nullable(),
  assigneeMembershipId: z.string().uuid().nullable(),
  dueAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  blockedReason: z.string().nullable(),
  // jsonb payload (checkInDay, documentTypeId, …) — passthrough as unknown.
  metadata: z.unknown().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OnboardingTaskRow = z.infer<typeof onboardingTaskRowSchema>;

export const onboardingDocumentRowSchema = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  documentTypeId: z.string().uuid(),
  // Human-readable document_types.name resolved via the reference join
  // (ONBOARD-04). Nullable defensively — a document_type row is never
  // groomed, so in practice this is always present.
  documentTypeName: z.string().nullable(),
  verificationStatus: z.string(),
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  uploadedAt: z.string(),
  createdAt: z.string(),
});
export type OnboardingDocumentRow = z.infer<typeof onboardingDocumentRowSchema>;

/**
 * Case detail carries the resolved buddy/manager display name + email
 * (ONBOARD-04) on top of the list-row fields. Resolution goes through the
 * service-role client (tenant_user_memberships → public.users → auth.users)
 * because RLS on public.users is self-only — a plain RLS-scoped join would
 * reveal only the caller's own name. Every field is nullable: an
 * unassigned buddy/manager, or a membership with no display_name, yields
 * null and the UI shows "Not yet assigned".
 */
export const onboardingCaseDetailSchema = onboardingCaseListRowSchema
  .omit({
    totalTasks: true,
    completedTasks: true,
  })
  .extend({
    buddyName: z.string().nullable(),
    buddyEmail: z.string().nullable(),
    managerName: z.string().nullable(),
    managerEmail: z.string().nullable(),
  });
export type OnboardingCaseDetail = z.infer<typeof onboardingCaseDetailSchema>;

export const getOnboardingCaseDetailInputSchema = z.object({
  caseId: z.string().uuid(),
});
export const getOnboardingCaseDetailOutputSchema = z.object({
  case: onboardingCaseDetailSchema,
  tasks: z.array(onboardingTaskRowSchema),
  documents: z.array(onboardingDocumentRowSchema),
});
export type GetOnboardingCaseDetailInput = z.infer<typeof getOnboardingCaseDetailInputSchema>;
export type GetOnboardingCaseDetailOutput = z.infer<typeof getOnboardingCaseDetailOutputSchema>;

// ─────────── updateOnboardingTaskStatus ───────────

export const updateOnboardingTaskStatusInputSchema = z.object({
  taskId: z.string().uuid(),
  status: onboardingTaskStatusSchema,
  // Required when status = 'blocked'; ignored (cleared) otherwise. Enforced
  // in the procedure so the message can name the offending field.
  blockedReason: z.string().min(1).max(1000).optional(),
});
export const updateOnboardingTaskStatusOutputSchema = z.object({
  taskId: z.string().uuid(),
  status: onboardingTaskStatusSchema,
  completedAt: z.string().nullable(),
  blockedReason: z.string().nullable(),
});
export type UpdateOnboardingTaskStatusInput = z.infer<typeof updateOnboardingTaskStatusInputSchema>;
export type UpdateOnboardingTaskStatusOutput = z.infer<
  typeof updateOnboardingTaskStatusOutputSchema
>;

// ─────────── updateOnboardingCase ───────────

export const updateOnboardingCaseInputSchema = z
  .object({
    caseId: z.string().uuid(),
    geographyCode: z
      .string()
      .length(2)
      .regex(/^[A-Za-z]{2}$/, "Expected a 2-letter ISO country code")
      .optional(),
    expectedStartDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
      .optional(),
    buddyMembershipId: z.string().uuid().nullable().optional(),
    managerMembershipId: z.string().uuid().nullable().optional(),
    status: onboardingCaseStatusSchema.optional(),
  })
  .refine(
    (v) =>
      v.geographyCode !== undefined ||
      v.expectedStartDate !== undefined ||
      v.buddyMembershipId !== undefined ||
      v.managerMembershipId !== undefined ||
      v.status !== undefined,
    { message: "At least one field to update is required" },
  );
export const updateOnboardingCaseOutputSchema = z.object({
  caseId: z.string().uuid(),
  status: onboardingCaseStatusSchema,
  geographyCode: z.string(),
  // How many document_collection tasks were soft-added by a geography change.
  documentTasksAdded: z.number().int(),
});
export type UpdateOnboardingCaseInput = z.infer<typeof updateOnboardingCaseInputSchema>;
export type UpdateOnboardingCaseOutput = z.infer<typeof updateOnboardingCaseOutputSchema>;

// ─────────── createOnboardingCaseForApplication (manual / backfill) ───────────

export const createOnboardingCaseForApplicationInputSchema = z.object({
  applicationId: z.string().uuid(),
});
export const createOnboardingCaseForApplicationOutputSchema = z.object({
  caseId: z.string().uuid(),
  created: z.boolean(),
  geographyCode: z.string(),
});
export type CreateOnboardingCaseForApplicationInput = z.infer<
  typeof createOnboardingCaseForApplicationInputSchema
>;
export type CreateOnboardingCaseForApplicationOutput = z.infer<
  typeof createOnboardingCaseForApplicationOutputSchema
>;

// ─────────── listTenantMemberships (ONBOARD-04) ───────────

/**
 * A tenant member for the assignment pickers (buddy / manager). Minimal by
 * design — id + display name + email + roles — and tenant-scoped. No
 * pagination: at POC scale a tenant has a handful of members; the procedure
 * caps the result and flags if the cap is hit.
 */
export const tenantMembershipRowSchema = z.object({
  membershipId: z.string().uuid(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  roles: z.array(z.string()),
});
export type TenantMembershipRow = z.infer<typeof tenantMembershipRowSchema>;

export const listTenantMembershipsInputSchema = z.object({}).optional();
export const listTenantMembershipsOutputSchema = z.object({
  items: z.array(tenantMembershipRowSchema),
});
export type ListTenantMembershipsInput = z.infer<typeof listTenantMembershipsInputSchema>;
export type ListTenantMembershipsOutput = z.infer<typeof listTenantMembershipsOutputSchema>;
