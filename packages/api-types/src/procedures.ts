import { z } from "zod";
import {
  applicationStageSchema,
  applicationSourceSchema,
  interviewModeSchema,
  interviewScorecardTemplateSchema,
  interviewStatusSchema,
  type InterviewScorecardTemplate,
} from "./enums";
import { jdBiasScanSchema, biasCategorySchema, biasSeveritySchema } from "./bias-lexicon";
import { skillsMatchResultSchema } from "./panel-prep";

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
  // POLISH-01 (Item A): the drawer is application-centric (it already carries
  // applicationId in the URL). When present we return THAT application's AI
  // score; when absent we fall back to the candidate's most recent application.
  // Optional so existing callers (`{ id }`) keep working unchanged.
  applicationId: z.string().uuid().optional(),
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

/**
 * POLISH-01 (Item A) — the drawer's AI-score hero. The score lives on the
 * application, not the candidate, so it rides in its own nullable facet
 * (null when the candidate has no application). `aiScore` is 0–100 or null
 * (unscored / skipped); `aiScoreExplanation` is the raw jsonb the drawer
 * narrows for top factors + scored_by + the CONF-03 emphasis note.
 */
export const candidateApplicationScoreSchema = z.object({
  id: z.string().uuid(),
  aiScore: z.number().nullable(),
  aiScoreExplanation: z.unknown().nullable(),
  aiScoredAt: z.string().nullable(),
});

export const getCandidateByIdOutputSchema = z.object({
  candidate: candidateRowSchema,
  person: candidatePersonSchema,
  application: candidateApplicationScoreSchema.nullable(),
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

// ─────────────── RECR-02: candidates grouped by requisition ───────────────

/**
 * The recruiter's "All candidates" surface — one accordion group per
 * requisition. Read-only over existing pipeline data (applications ×
 * candidates × persons × requisitions × jd_skills). No new tables.
 */
export const listCandidatesByRequisitionInputSchema = z.object({
  search: z.string().max(120).optional(),
  stage: applicationStageSchema.optional(),
  source: applicationSourceSchema.optional(),
});

/** Coarse pipeline phase for a requisition, rolled up DETERMINISTICALLY from
 * the stages of its in-flight applications (not a stored field). */
export const requisitionPhaseSchema = z.enum([
  "sourcing",
  "screening",
  "interviewing",
  "offer",
  "closed",
]);
export type RequisitionPhase = z.infer<typeof requisitionPhaseSchema>;

/**
 * Missing-info summary for one candidate — a DETERMINISTIC count + labels of
 * required profile fields that are absent. RECR-02 computes this inline (see
 * the router); RECR-03 owns a dedicated missing-info lib. When RECR-03 merges,
 * this shape is the seam: swap the inline computation for the lib, keep the
 * field. Labels are drawn only from fields we actually store — no fabricated
 * "work authorization" when there is no column for it.
 */
export const candidateMissingInfoSchema = z.object({
  count: z.number().int().min(0),
  fields: z.array(z.string()),
});

export const candidateByRequisitionRowSchema = z.object({
  candidateId: z.string().uuid(),
  applicationId: z.string().uuid(),
  /** Short display code derived from the candidate id (e.g. "C-4F2A1B"). */
  refCode: z.string(),
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  source: applicationSourceSchema.nullable(),
  stage: applicationStageSchema,
  stageEnteredAt: z.string(),
  aiScore: z.number().nullable(),
  aiScoreExplanation: z.unknown().nullable(),
  yearsOfExperience: z.number().nullable(),
  noticePeriodDays: z.number().nullable(),
  mustHavePct: z.number().nullable(),
  missingInfo: candidateMissingInfoSchema,
});

export const candidatesByRequisitionGroupSchema = z.object({
  requisitionId: z.string().uuid(),
  roleTitle: z.string(),
  phase: requisitionPhaseSchema,
  candidateCount: z.number().int().min(0),
  rows: z.array(candidateByRequisitionRowSchema),
});

export const listCandidatesByRequisitionOutputSchema = z.object({
  groups: z.array(candidatesByRequisitionGroupSchema),
  totalCandidates: z.number().int().min(0),
});

export type ListCandidatesByRequisitionInput = z.infer<
  typeof listCandidatesByRequisitionInputSchema
>;
export type ListCandidatesByRequisitionOutput = z.infer<
  typeof listCandidatesByRequisitionOutputSchema
>;

// ─────────────── RECR-02: AI shortlist ───────────────

export const matchTierSchema = z.enum(["excellent", "good", "partial", "below"]);
export type MatchTierValue = z.infer<typeof matchTierSchema>;

export const urgencyRankSchema = z.enum(["high", "medium", "low"]);
export const riskFlagSchema = z.enum(["skill_mismatch", "salary_gap"]);

export const listShortlistInputSchema = z.object({
  /** Minimum real ai_score to include in the table (0–100). Tier count cards
   * always summarise the full scored pool, independent of this. */
  threshold: z.number().min(0).max(100).default(75),
});

export const shortlistRowSchema = z.object({
  candidateId: z.string().uuid(),
  applicationId: z.string().uuid(),
  fullName: z.string().nullable(),
  source: applicationSourceSchema.nullable(),
  roleTitle: z.string(),
  aiScore: z.number(),
  aiScoreExplanation: z.unknown().nullable(),
  tier: matchTierSchema,
  mustHavePct: z.number().nullable(),
  noticePeriodDays: z.number().nullable(),
  stage: applicationStageSchema,
  /** DETERMINISTIC urgency index (0–100) + rank. NOT a probability. */
  urgencyIndex: z.number().int().min(0).max(100),
  urgencyRank: urgencyRankSchema,
  riskFlags: z.array(riskFlagSchema),
});

export const listShortlistOutputSchema = z.object({
  threshold: z.number(),
  tierCounts: z.object({
    excellent: z.number().int().min(0),
    good: z.number().int().min(0),
    partial: z.number().int().min(0),
  }),
  rows: z.array(shortlistRowSchema),
});

export type ListShortlistInput = z.infer<typeof listShortlistInputSchema>;
export type ListShortlistOutput = z.infer<typeof listShortlistOutputSchema>;
export type ShortlistRow = z.infer<typeof shortlistRowSchema>;

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

// ─────────────── listRequisitionSummaries (REQ-01) ───────────────
//
// The requirement-owner /requisitions surface. Richer than the thin
// listRequisitions read (which returns only id/positionId/jdVersionId and
// no join): this joins positions for the human title + location and carries
// openings, so the skeleton list can render title / status / location /
// openings / created without a second round-trip. Role-gated in the router
// to hiring_manager / recruiter / admin. Capped, no cursor — a skeleton
// surface, not a paginated feed (pagination arrives with REQ-02).

export const requisitionSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  status: z.string(),
  location: z.string().nullable(),
  openings: z.number().int(),
  createdAt: z.string(),
});

export const listRequisitionSummariesInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
});

export const listRequisitionSummariesOutputSchema = z.object({
  rows: z.array(requisitionSummarySchema),
});

export type RequisitionSummary = z.infer<typeof requisitionSummarySchema>;
export type ListRequisitionSummariesInput = z.infer<typeof listRequisitionSummariesInputSchema>;
export type ListRequisitionSummariesOutput = z.infer<typeof listRequisitionSummariesOutputSchema>;

// ─────────────── listRequisitionApprovals (REQ-01) ───────────────
//
// The HR-head /requisition-approvals surface. Reads approval_requests rows
// with subject_type='requisition' (the table is real but likely empty until
// REQ-02/03 wire submission). Role-gated in the router to hr_head / admin.
// A read-only skeleton: no decision fields yet (approve/send-back/reject
// arrive with REQ-03).

/**
 * CONF-02: a coded-language flag recorded on the requisition's JD at submit
 * time (enforcement `warn`/`block`). Distinct terms only. The HR head sees
 * these in the queue before deciding.
 */
export const requisitionApprovalBiasFlagSchema = z.object({
  term: z.string(),
  category: biasCategorySchema,
  severity: biasSeveritySchema,
  suggestion: z.string().nullable(),
});
export type RequisitionApprovalBiasFlag = z.infer<typeof requisitionApprovalBiasFlagSchema>;

/**
 * HRHEAD-01 priority derivation, shared by the dashboard approvals list and the
 * approvals page. Derived from the age of the pending request (nothing on the
 * row stores an explicit priority):
 *   age > 7d → high · age > 3d → medium · else → low.
 * FLAG: this is a heuristic, not a business field — see the router helper.
 */
export const requisitionApprovalPrioritySchema = z.enum(["high", "medium", "low"]);
export type RequisitionApprovalPriority = z.infer<typeof requisitionApprovalPrioritySchema>;

/**
 * HRHEAD-01 normalises the four terminal request states into a filter/label
 * vocabulary. `send_back` moves the request to `cancelled` (REQ-03), so the
 * queue surfaces it as "sent back" rather than the raw status.
 *   pending · approved · sent_back (← cancelled) · rejected · expired
 */
export const requisitionApprovalOutcomeSchema = z.enum([
  "pending",
  "approved",
  "sent_back",
  "rejected",
  "expired",
]);
export type RequisitionApprovalOutcome = z.infer<typeof requisitionApprovalOutcomeSchema>;

export const requisitionApprovalRowSchema = z.object({
  id: z.string().uuid(),
  subjectId: z.string().uuid(),
  // REQ-02 enriches the skeleton read with the requisition title via an
  // app-layer join (subject_id → requisitions → positions). Null when the
  // subject row can't be resolved (should not happen for requisition rows).
  title: z.string().nullable(),
  status: z.string(),
  currentStepIndex: z.number().int(),
  requestedAt: z.string(),
  createdAt: z.string(),
  /** CONF-02: coded-language flags recorded from the submit-time bias scan. */
  biasFlags: z.array(requisitionApprovalBiasFlagSchema),
  // ─── HRHEAD-01 enrichment (all additive; older consumers ignore them) ───
  /** Department (business_unit name) via subject_id → requisition → position. */
  department: z.string().nullable(),
  /** Human comp band, e.g. "18–24 LPA" or "120000–160000 USD"; null if unset. */
  budgetBand: z.string().nullable(),
  /** Display name of the requesting membership (service-role resolved); null if system-raised or nameless. */
  requestedByName: z.string().nullable(),
  /** Whole days since requested_at. */
  ageDays: z.number().int(),
  /** Age-derived priority (see requisitionApprovalPrioritySchema). */
  priority: requisitionApprovalPrioritySchema,
  /** Normalised outcome for the filter tabs + status chip. */
  outcome: requisitionApprovalOutcomeSchema,
});

export const listRequisitionApprovalsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
});

export const listRequisitionApprovalsOutputSchema = z.object({
  rows: z.array(requisitionApprovalRowSchema),
});

export type RequisitionApprovalRow = z.infer<typeof requisitionApprovalRowSchema>;
export type ListRequisitionApprovalsInput = z.infer<typeof listRequisitionApprovalsInputSchema>;
export type ListRequisitionApprovalsOutput = z.infer<typeof listRequisitionApprovalsOutputSchema>;

// ═══════════════ REQ-02: requisition creation (draft → JD → skills → submit) ═══════════════
//
// The requirement-owner creation flow. Five procedures gate-checked in the
// router to hiring_manager + admin (mutations) / REQUISITION_READ_ROLES
// (detail read). See docs/prototype-gap-audit.md Wave A / REQ-02.

/** The 4 requisition location types (mirrors the db location_type enum). */
export const requisitionLocationTypeSchema = z.enum(["remote", "hybrid", "onsite", "multi"]);
export type RequisitionLocationType = z.infer<typeof requisitionLocationTypeSchema>;

/**
 * Structured JD sections. Stored in jd_versions.ai_metadata.sections and
 * rendered down into the canonical jd_text blob. Kept deliberately simple —
 * summary + responsibilities + requirements is what the apply page and AI
 * scoring actually consume; no psychometrics, no section theatre.
 */
export const jdSectionsSchema = z.object({
  summary: z.string(),
  responsibilities: z.array(z.string()),
  /** "Required skills / qualifications" in the wizard v2 editor cards. */
  requirements: z.array(z.string()),
  // RO-02 (wizard v2): additive optional section arrays. The real AI JD
  // generator (jdGenerationResponseSchema) still returns only summary /
  // responsibilities / requirements, so these default to [] on generate and
  // on every pre-RO-02 stored jd_versions.ai_metadata.sections blob (parsed
  // with jdSectionsSchema.safeParse — the defaults keep old rows valid). The
  // requirement owner fills them by hand in the per-section editor cards.
  niceToHave: z.array(z.string()).default([]),
  toolsTech: z.array(z.string()).default([]),
  education: z.array(z.string()).default([]),
  softSkills: z.array(z.string()).default([]),
});
export type JdSections = z.infer<typeof jdSectionsSchema>;

/**
 * The wizard v2 JD editor's section keys, in display order, with labels. The
 * first three map to the real AI-generated fields; the rest are manual-only
 * (the AI path does not produce them — honest, no theatre). List-shaped
 * sections are arrays; `summary` is the one free-text block.
 */
export const JD_SECTION_META = [
  { key: "summary", label: "Role summary", kind: "text", aiBacked: true },
  { key: "responsibilities", label: "Responsibilities", kind: "list", aiBacked: true },
  { key: "requirements", label: "Required skills & qualifications", kind: "list", aiBacked: true },
  { key: "niceToHave", label: "Nice to have", kind: "list", aiBacked: false },
  { key: "toolsTech", label: "Tools & technology", kind: "list", aiBacked: false },
  { key: "education", label: "Education", kind: "list", aiBacked: false },
  { key: "softSkills", label: "Soft skills", kind: "list", aiBacked: false },
] as const;
export type JdSectionKey = (typeof JD_SECTION_META)[number]["key"];

/**
 * A JD skill row (name / weight / must-have). Maps to jd_skills
 * (skill_name / weight / is_required). Note: the prototype's "min years"
 * per skill has NO home in jd_skills (no such column) — a minimum-years
 * requirement is expressed as a numeric_min knockout on
 * total_years_experience instead, which is what the apply-flow evaluator
 * actually consumes. See REQ-02 design notes.
 */
export const requisitionSkillInputSchema = z.object({
  skillName: z.string().min(1).max(120),
  weight: z.number().min(0).max(10).default(1),
  isRequired: z.boolean().default(false),
  // RO-02 (migration 0080): additive per-skill metadata. All optional — old
  // callers (REQ-02) omit them and the columns stay NULL. `category` groups
  // skills under chips in the weighting editor; `minYears` is captured for
  // interviewers + future scoring (the current AI evaluator reads OVERALL
  // years via knockouts, not per-skill minimums); `notes` is advisory context.
  category: z.string().max(80).nullish(),
  minYears: z.number().int().min(0).max(50).nullish(),
  notes: z.string().max(500).nullish(),
});
export type RequisitionSkillInput = z.infer<typeof requisitionSkillInputSchema>;

/**
 * A knockout the recruiter defines on the requisition. Produces a
 * requisition_knockouts row whose threshold_value carries the `field_path`
 * the apply-flow evaluator (@hireops/ai-scoring evaluateKnockouts) walks into
 * the parsed CV, plus the type-specific threshold. Only source='parsed_cv' is
 * evaluated in Wave 1; the other sources persist but are skipped by the
 * evaluator (documented contract).
 */
export const requisitionKnockoutInputSchema = z.object({
  questionText: z.string().min(1).max(500),
  type: z.enum(["boolean", "numeric_min", "numeric_max", "enum"]),
  source: z.enum(["parsed_cv", "candidate_asserted", "partner_asserted"]).default("parsed_cv"),
  /** Dot-path into the parsed-CV shape, e.g. "total_years_experience". */
  fieldPath: z.string().min(1).max(200),
  /** For numeric_min. */
  min: z.number().optional(),
  /** For numeric_max. */
  max: z.number().optional(),
  /** For enum. */
  allowed: z.array(z.string().min(1)).optional(),
});
export type RequisitionKnockoutInput = z.infer<typeof requisitionKnockoutInputSchema>;

// ─────────────── createRequisitionDraft ───────────────

export const createRequisitionDraftInputSchema = z.object({
  title: z.string().min(2).max(200),
  /** Free-text department/BU name — resolved-or-created to a business_unit. */
  department: z.string().min(1).max(120),
  locationType: requisitionLocationTypeSchema,
  primaryLocation: z.string().max(200).optional(),
  seniority: z.string().max(120).optional(),
  employmentType: z.string().max(120).optional(),
  numberOfOpenings: z.number().int().min(1).max(999).default(1),
  /** ISO date (yyyy-mm-dd). */
  targetStartDate: z.string().optional(),
  compBandMin: z.number().nonnegative().optional(),
  compBandMax: z.number().nonnegative().optional(),
  compCurrency: z.string().length(3).optional(),
});
export const createRequisitionDraftOutputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export type CreateRequisitionDraftInput = z.infer<typeof createRequisitionDraftInputSchema>;
export type CreateRequisitionDraftOutput = z.infer<typeof createRequisitionDraftOutputSchema>;

// ─────────────── generateJdDraft ───────────────

export const generateJdDraftInputSchema = z.object({
  requisitionId: z.string().uuid(),
  /** Optional free-text steer from the hiring manager. */
  extraContext: z.string().max(2000).optional(),
});
export const generateJdDraftOutputSchema = z.object({
  jdVersionId: z.string().uuid(),
  sections: jdSectionsSchema,
  promptVersion: z.string(),
  model: z.string(),
  /**
   * CONF-02: the bias scan of the freshly-composed JD, so the wizard can
   * highlight coded language the instant generation returns.
   */
  scan: jdBiasScanSchema,
});
export type GenerateJdDraftInput = z.infer<typeof generateJdDraftInputSchema>;
export type GenerateJdDraftOutput = z.infer<typeof generateJdDraftOutputSchema>;

// ─────────────── updateRequisitionDraft ───────────────
//
// Replace-set semantics while the req is draft: whichever of sections /
// skills / knockouts is supplied is fully replaced (skills + knockouts are
// delete-all-then-insert for the req's JD version). Omitted fields are left
// untouched. Rejects non-draft requisitions (edit-after-submit is out of
// scope — the req locks on submission).

export const updateRequisitionDraftInputSchema = z.object({
  requisitionId: z.string().uuid(),
  sections: jdSectionsSchema.optional(),
  skills: z.array(requisitionSkillInputSchema).max(50).optional(),
  knockouts: z.array(requisitionKnockoutInputSchema).max(30).optional(),
});
export const updateRequisitionDraftOutputSchema = z.object({
  ok: z.literal(true),
  skillCount: z.number().int(),
  knockoutCount: z.number().int(),
});
export type UpdateRequisitionDraftInput = z.infer<typeof updateRequisitionDraftInputSchema>;
export type UpdateRequisitionDraftOutput = z.infer<typeof updateRequisitionDraftOutputSchema>;

// ─────────────── submitRequisitionForApproval ───────────────

export const submitRequisitionForApprovalInputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export const submitRequisitionForApprovalOutputSchema = z.object({
  approvalRequestId: z.string().uuid(),
  status: z.string(),
  /** True when the req was already pending (idempotent re-submit). */
  alreadySubmitted: z.boolean(),
});
export type SubmitRequisitionForApprovalInput = z.infer<
  typeof submitRequisitionForApprovalInputSchema
>;
export type SubmitRequisitionForApprovalOutput = z.infer<
  typeof submitRequisitionForApprovalOutputSchema
>;

// ─────────────── getRequisitionDetail ───────────────

export const requisitionDetailSkillSchema = z.object({
  id: z.string().uuid(),
  skillName: z.string(),
  weight: z.number(),
  isRequired: z.boolean(),
  // RO-02 additive (migration 0080). Null on pre-RO-02 rows.
  category: z.string().nullable(),
  minYears: z.number().int().nullable(),
  notes: z.string().nullable(),
});

export const requisitionDetailKnockoutSchema = z.object({
  id: z.string().uuid(),
  questionText: z.string(),
  type: z.string(),
  source: z.string(),
  thresholdValue: z.unknown(),
  orderIndex: z.number().int(),
});

export const requisitionDetailApprovalSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  currentStepIndex: z.number().int(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
});

/**
 * The most recent decision recorded against ANY approval request for this
 * requisition (REQ-03). Surfaces the HR-head outcome + reason so the hiring
 * manager sees "Sent back by HR Head: <reason>" / "Rejected by HR Head:
 * <reason>". `kind` is the product-level decision derived from the schema
 * outcome: approved→approve, rejected→reject, abstained→send_back (REQ-03
 * only ever writes those three). Null until the first decision.
 */
export const requisitionLatestDecisionSchema = z.object({
  kind: z.enum(["approve", "send_back", "reject"]),
  outcome: z.string(),
  reason: z.string().nullable(),
  decidedAt: z.string(),
});
export type RequisitionLatestDecision = z.infer<typeof requisitionLatestDecisionSchema>;

export const getRequisitionDetailInputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export const getRequisitionDetailOutputSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  numberOfOpenings: z.number().int(),
  targetStartDate: z.string().nullable(),
  publicSlug: z.string().nullable(),
  /** Tenant slug — with publicSlug, forms the public apply URL
   *  `/t/<tenantSlug>/apply/<publicSlug>` shown once the req is posted. */
  tenantSlug: z.string(),
  createdAt: z.string(),
  // Position facet.
  positionId: z.string().uuid(),
  title: z.string(),
  department: z.string().nullable(),
  locationType: z.string(),
  primaryLocation: z.string().nullable(),
  seniority: z.string().nullable(),
  compBandMin: z.string().nullable(),
  compBandMax: z.string().nullable(),
  compCurrency: z.string().nullable(),
  // JD facet.
  jdVersionId: z.string().uuid(),
  jdText: z.string(),
  jdSummary: z.string().nullable(),
  jdSections: jdSectionsSchema.nullable(),
  jdStatus: z.string(),
  skills: z.array(requisitionDetailSkillSchema),
  knockouts: z.array(requisitionDetailKnockoutSchema),
  // Approval facet — the latest approval_request for this requisition.
  approval: requisitionDetailApprovalSchema.nullable(),
  // Latest HR-head decision across this requisition's approval requests (REQ-03).
  latestDecision: requisitionLatestDecisionSchema.nullable(),
  /** True when the caller may still edit + submit (status === 'draft'). */
  isDraft: z.boolean(),
});
export type GetRequisitionDetailInput = z.infer<typeof getRequisitionDetailInputSchema>;
export type GetRequisitionDetailOutput = z.infer<typeof getRequisitionDetailOutputSchema>;

// ─────────────── listRequisitionsForSkillWeighting (RO-02) ───────────────
//
// The standalone /skill-weighting picker. Lists the tenant's requisitions the
// caller may weight (hiring_manager / admin), each with a skill-coverage
// summary (skill count, must-have count, whether weights differ from the flat
// default) so the picker can show at a glance which reqs still need attention.
// Editable-only: draft + pending_approval (a posted/filled req's JD is locked).

export const skillWeightingReqSchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  status: z.string(),
  department: z.string().nullable(),
  jdVersionId: z.string().uuid(),
  skillCount: z.number().int(),
  mustHaveCount: z.number().int(),
  /** Sum of skill weights (rounded to 1dp) — the "weighting done" signal. */
  totalWeight: z.number(),
  /** True while the caller may still edit the weights (status === 'draft'). */
  editable: z.boolean(),
  createdAt: z.string(),
});
export type SkillWeightingReq = z.infer<typeof skillWeightingReqSchema>;

export const listRequisitionsForSkillWeightingInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
});
export const listRequisitionsForSkillWeightingOutputSchema = z.object({
  rows: z.array(skillWeightingReqSchema),
});
export type ListRequisitionsForSkillWeightingInput = z.infer<
  typeof listRequisitionsForSkillWeightingInputSchema
>;
export type ListRequisitionsForSkillWeightingOutput = z.infer<
  typeof listRequisitionsForSkillWeightingOutputSchema
>;

// ═══════════════ REQ-03: HR-head approval decisions + posting ═══════════════
//
// decideRequisitionApproval (hr_head + admin) records the HR-head verdict on a
// pending requisition approval and drives both the approval_request and the
// requisition state machine. postRequisition (hiring_manager + recruiter +
// admin) takes an approved requisition live with a human public_slug. See
// docs/prototype-gap-audit.md Wave A / REQ-03 — this makes real the "Submit
// Decision" button the prototype left dead.

// ─────────────── decideRequisitionApproval ───────────────

/** The three HR-head verdicts. Maps to the approval_decision_outcome enum:
 *  approve→approved, reject→rejected, send_back→abstained (the request is set
 *  aside so the hiring manager can revise + resubmit). */
export const requisitionDecisionSchema = z.enum(["approve", "send_back", "reject"]);
export type RequisitionDecision = z.infer<typeof requisitionDecisionSchema>;

export const decideRequisitionApprovalInputSchema = z.object({
  approvalRequestId: z.string().uuid(),
  decision: requisitionDecisionSchema,
  /** REQUIRED for send_back and reject (validated in the router — a clean
   *  400 without it); ignored/optional for approve. */
  reason: z.string().max(2000).optional(),
});
export const decideRequisitionApprovalOutputSchema = z.object({
  approvalRequestId: z.string().uuid(),
  requisitionId: z.string().uuid(),
  decision: requisitionDecisionSchema,
  /** New approval_request status (approved | rejected | cancelled). */
  requestStatus: z.string(),
  /** New requisition status (approved | draft | cancelled). */
  requisitionStatus: z.string(),
  decisionId: z.string().uuid(),
});
export type DecideRequisitionApprovalInput = z.infer<typeof decideRequisitionApprovalInputSchema>;
export type DecideRequisitionApprovalOutput = z.infer<typeof decideRequisitionApprovalOutputSchema>;

// ─────────────── postRequisition ───────────────

export const postRequisitionInputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export const postRequisitionOutputSchema = z.object({
  requisitionId: z.string().uuid(),
  status: z.string(),
  publicSlug: z.string(),
});
export type PostRequisitionInput = z.infer<typeof postRequisitionInputSchema>;
export type PostRequisitionOutput = z.infer<typeof postRequisitionOutputSchema>;

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
  // HROPS-02 additive offer terms (nullable/[] for pre-HROPS-02 rows).
  contractType: z.string().nullable(),
  probationMonths: z.number().int().nullable(),
  benefits: z.array(z.string()),
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

// ─────────────── getHrMetrics (METRICS-01) ───────────────

/**
 * The HR analytics aggregate read behind /metrics. ONE server-side read
 * powering the whole chart grid (client-side recharts, server-side
 * numbers). hr_head + admin only (recruiter/hiring_manager get FORBIDDEN).
 *
 * Windows (stated in the UI): the pipeline/source/offer/score panels are a
 * current tenant-state snapshot (all-time) — consistent with the sibling
 * /admin/reports and /admin/costs surfaces and demo-stable; AI spend is the
 * last 14 calendar days (matches the Costs surface). No date-range input:
 * the window is fixed by ticket scope.
 */

/** One pipeline-funnel row: applications currently at `stage`. All 11
 * application_stage labels emitted in enum order, zero-filled. */
export const hrMetricsFunnelStageSchema = z.object({
  stage: z.string(),
  count: z.number().int(),
});

/** Average days an application spends in `stage`, from consecutive
 * application_state_transitions pairs. All 11 stages, enum order; a stage
 * never left (terminal / no completed visit) carries avg_days = null. */
export const hrMetricsStageDurationSchema = z.object({
  stage: z.string(),
  avg_days: z.number().nullable(),
});

/** Applications per source channel. Present sources only, ordered by
 * applications desc then source asc; partner_empanelled surfaces as its own
 * slice when present. */
export const hrMetricsSourceSchema = z.object({
  source: z.string(),
  applications: z.number().int(),
});

/** Offer funnel counts. extended = offers that reached the extended state or
 * a post-extended terminal (accepted / declined / expired count toward it,
 * since those imply a prior extend); accepted / declined = their terminal
 * states. extended >= accepted + declined by construction. */
export const hrMetricsOfferFunnelSchema = z.object({
  extended: z.number().int(),
  accepted: z.number().int(),
  declined: z.number().int(),
});

/** One day of AI spend. cost_micros is USD micros (1 USD = 1,000,000),
 * crossed as a string like the Costs surface. Ascending, last 14 days. */
export const hrMetricsAiSpendDaySchema = z.object({
  day: z.string(),
  cost_micros: z.string(),
  calls: z.number().int(),
});

/** One ai_score histogram bucket (width 10; the top bucket is 90–100
 * inclusive). `tier` bands the bucket for DESIGN-05 tier-token shading:
 * platinum 90–100, gold 70–89, silver 50–69, neutral <50. All 10 buckets
 * emitted low→high, zero-filled. */
export const hrMetricsScoreBucketSchema = z.object({
  label: z.string(),
  min: z.number().int(),
  max: z.number().int(),
  count: z.number().int(),
  tier: z.enum(["platinum", "gold", "silver", "neutral"]),
});

/** KPI header figures. active = non-terminal stage; hired = offer_accepted;
 * offers_extended = offers that reached extended; avg_ai_score = mean over
 * scored applications (null when none scored). */
export const hrMetricsKpisSchema = z.object({
  applications: z.number().int(),
  active: z.number().int(),
  hired: z.number().int(),
  offers_extended: z.number().int(),
  avg_ai_score: z.number().nullable(),
});

export const getHrMetricsOutputSchema = z.object({
  kpis: hrMetricsKpisSchema,
  funnel: z.array(hrMetricsFunnelStageSchema),
  timeInStage: z.array(hrMetricsStageDurationSchema),
  sourceMix: z.array(hrMetricsSourceSchema),
  offerFunnel: hrMetricsOfferFunnelSchema,
  aiSpend: z.array(hrMetricsAiSpendDaySchema),
  scoreDistribution: z.array(hrMetricsScoreBucketSchema),
});

export type GetHrMetricsOutput = z.infer<typeof getHrMetricsOutputSchema>;
export type HrMetricsFunnelStage = z.infer<typeof hrMetricsFunnelStageSchema>;
export type HrMetricsStageDuration = z.infer<typeof hrMetricsStageDurationSchema>;
export type HrMetricsSource = z.infer<typeof hrMetricsSourceSchema>;
export type HrMetricsOfferFunnel = z.infer<typeof hrMetricsOfferFunnelSchema>;
export type HrMetricsAiSpendDay = z.infer<typeof hrMetricsAiSpendDaySchema>;
export type HrMetricsScoreBucket = z.infer<typeof hrMetricsScoreBucketSchema>;
export type HrMetricsKpis = z.infer<typeof hrMetricsKpisSchema>;

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
  // ONBOARD-05 review fields. verifiedByMembershipId / verifiedAt are the
  // reviewer + decision timestamp (stamped on both verify and reject — the
  // schema has no separate rejected_by column, so this doubles as the
  // decision-actor for a rejection). rejectionReason is set only on reject.
  // verifierName is resolved cheaply via the SAME service-role membership
  // lookup that resolves buddy/manager names (no extra join); null when the
  // document is still pending or the membership has no display name/email.
  verifiedByMembershipId: z.string().uuid().nullable(),
  verifiedAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  verifierName: z.string().nullable(),
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

// ─────────── onboarding documents (ONBOARD-05) ───────────

/**
 * REST (multipart) upload response for POST /api/onboarding-documents/upload.
 * Same shape as the resume upload (storageKey + metadata + sha256 checksum);
 * the storage KEY is opaque and only becomes a real document row once
 * attachOnboardingDocument references it — the two-step upload-then-reference
 * pattern the apply form uses.
 */
export const uploadOnboardingDocumentResponseSchema = z.object({
  storageKey: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string(),
  checksum: z.string().length(64), // sha256 hex
});
export type UploadOnboardingDocumentResponse = z.infer<
  typeof uploadOnboardingDocumentResponseSchema
>;

/**
 * attachOnboardingDocument — records an uploaded blob as a document row for a
 * (case, documentType), verification_status = 'pending', and nudges the
 * matching document_collection task pending → in_progress. Re-upload for the
 * same document type REPLACES the existing row (single current document per
 * type — the schema carries no version/superseded column, see the router
 * note), resetting it back to pending review.
 */
export const attachOnboardingDocumentInputSchema = z.object({
  caseId: z.string().uuid(),
  documentTypeId: z.string().uuid(),
  storageKey: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
});
export const attachOnboardingDocumentOutputSchema = z.object({
  documentId: z.string().uuid(),
  verificationStatus: z.string(),
  // Whether a new row was created (false = an existing document for this type
  // was replaced).
  created: z.boolean(),
  // The matched document_collection task, when one exists for this type.
  taskId: z.string().uuid().nullable(),
  taskStatus: onboardingTaskStatusSchema.nullable(),
});
export type AttachOnboardingDocumentInput = z.infer<typeof attachOnboardingDocumentInputSchema>;
export type AttachOnboardingDocumentOutput = z.infer<typeof attachOnboardingDocumentOutputSchema>;

/**
 * verifyOnboardingDocument — recruiter marks a pending/rejected document
 * verified; stamps verifier + verified_at and auto-completes the matching
 * document_collection task.
 */
export const verifyOnboardingDocumentInputSchema = z.object({
  documentId: z.string().uuid(),
});
export const verifyOnboardingDocumentOutputSchema = z.object({
  documentId: z.string().uuid(),
  verificationStatus: z.string(),
  taskId: z.string().uuid().nullable(),
  taskStatus: onboardingTaskStatusSchema.nullable(),
});
export type VerifyOnboardingDocumentInput = z.infer<typeof verifyOnboardingDocumentInputSchema>;
export type VerifyOnboardingDocumentOutput = z.infer<typeof verifyOnboardingDocumentOutputSchema>;

/**
 * rejectOnboardingDocument — recruiter rejects a document with a required
 * reason (the procedure 400s without one); the matching document_collection
 * task drops back to pending so the candidate can re-submit.
 */
export const rejectOnboardingDocumentInputSchema = z.object({
  documentId: z.string().uuid(),
  rejectionReason: z.string().min(1).max(1000),
});
export const rejectOnboardingDocumentOutputSchema = z.object({
  documentId: z.string().uuid(),
  verificationStatus: z.string(),
  rejectionReason: z.string().nullable(),
  taskId: z.string().uuid().nullable(),
  taskStatus: onboardingTaskStatusSchema.nullable(),
});
export type RejectOnboardingDocumentInput = z.infer<typeof rejectOnboardingDocumentInputSchema>;
export type RejectOnboardingDocumentOutput = z.infer<typeof rejectOnboardingDocumentOutputSchema>;

// ─────────────── offboarding lifecycle (OFFBOARD-02) ───────────────

/**
 * offboarding_cases.status / offboarding_tasks.{status,task_type} /
 * initiation_type / asset_returns.status / final_settlements.status — text +
 * CHECK in the DB (OFFBOARD-01, HANDOVER reality #114), mirrored here as zod
 * enums for the tRPC surface. Wave-1 values; additive to grow.
 */
export const offboardingCaseStatusSchema = z.enum([
  "initiated",
  "notice_period",
  "clearance",
  "completed",
  "cancelled",
]);
export type OffboardingCaseStatus = z.infer<typeof offboardingCaseStatusSchema>;

export const offboardingInitiationTypeSchema = z.enum([
  "resignation",
  "termination",
  "end_of_contract",
]);
export type OffboardingInitiationType = z.infer<typeof offboardingInitiationTypeSchema>;

// Note: NO 'cancelled' member — the offboarding_tasks CHECK (OFFBOARD-01)
// omits it (a task is skipped, not cancelled).
export const offboardingTaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "skipped",
]);
export type OffboardingTaskStatus = z.infer<typeof offboardingTaskStatusSchema>;

export const offboardingTaskTypeSchema = z.enum([
  "knowledge_transfer",
  "asset_return",
  "access_revocation",
  "final_settlement",
  "exit_interview",
  "manager_signoff",
  "hr_clearance",
]);
export type OffboardingTaskType = z.infer<typeof offboardingTaskTypeSchema>;

export const assetReturnStatusSchema = z.enum(["pending", "returned", "written_off", "lost"]);
export type AssetReturnStatus = z.infer<typeof assetReturnStatusSchema>;

export const finalSettlementStatusSchema = z.enum(["pending", "calculated", "approved", "paid"]);
export type FinalSettlementStatus = z.infer<typeof finalSettlementStatusSchema>;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// ─────────── row shapes ───────────

export const offboardingCaseListRowSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  applicationId: z.string().uuid().nullable(),
  onboardingCaseId: z.string().uuid().nullable(),
  initiationType: offboardingInitiationTypeSchema,
  status: offboardingCaseStatusSchema,
  noticeStartDate: z.string().nullable(),
  lastWorkingDay: z.string().nullable(),
  reason: z.string().nullable(),
  initiatedByMembershipId: z.string().uuid(),
  managerMembershipId: z.string().uuid().nullable(),
  candidateName: z.string().nullable(),
  totalTasks: z.number().int(),
  completedTasks: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OffboardingCaseListRow = z.infer<typeof offboardingCaseListRowSchema>;

export const offboardingTaskRowSchema = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  taskType: offboardingTaskTypeSchema,
  status: offboardingTaskStatusSchema,
  title: z.string(),
  assigneeMembershipId: z.string().uuid().nullable(),
  dueAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  blockedReason: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OffboardingTaskRow = z.infer<typeof offboardingTaskRowSchema>;

export const assetReturnRowSchema = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  assetType: z.string(),
  assetTag: z.string().nullable(),
  status: assetReturnStatusSchema,
  returnedAt: z.string().nullable(),
  receivedByMembershipId: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssetReturnRow = z.infer<typeof assetReturnRowSchema>;

export const exitInterviewRowSchema = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  scheduledAt: z.string().nullable(),
  conductedByMembershipId: z.string().uuid().nullable(),
  structuredResponses: z.unknown().nullable(),
  freeText: z.string().nullable(),
  submittedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExitInterviewRow = z.infer<typeof exitInterviewRowSchema>;

export const finalSettlementRowSchema = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  status: finalSettlementStatusSchema,
  // Net settlement in minor units (paise/cents). Serialised as a number — the
  // demo amounts (single-digit-crore paise) sit well within Number.MAX_SAFE.
  amountMinor: z.number().nullable(),
  currency: z.string().nullable(),
  breakdown: z.unknown().nullable(),
  approvedByMembershipId: z.string().uuid().nullable(),
  paidAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FinalSettlementRow = z.infer<typeof finalSettlementRowSchema>;

// ─────────── initiateOffboarding ───────────

/**
 * initiateOffboarding — open a departure case for a HIRED candidate and
 * generate the standard 7-task clearance checklist. `created` is false when a
 * live case already exists (the procedure 409s on that path — see the router),
 * so in practice callers only see created:true.
 */
export const initiateOffboardingInputSchema = z.object({
  candidateId: z.string().uuid(),
  initiationType: offboardingInitiationTypeSchema,
  noticeStartDate: z.string().regex(DATE_ONLY, "Expected YYYY-MM-DD").optional(),
  lastWorkingDay: z.string().regex(DATE_ONLY, "Expected YYYY-MM-DD").optional(),
  reason: z.string().min(1).max(2000).optional(),
  managerMembershipId: z.string().uuid().optional(),
});
export const initiateOffboardingOutputSchema = z.object({
  caseId: z.string().uuid(),
  created: z.boolean(),
  status: offboardingCaseStatusSchema,
  tasksCreated: z.number().int(),
});
export type InitiateOffboardingInput = z.infer<typeof initiateOffboardingInputSchema>;
export type InitiateOffboardingOutput = z.infer<typeof initiateOffboardingOutputSchema>;

// ─────────── updateOffboardingTaskStatus ───────────

export const updateOffboardingTaskStatusInputSchema = z.object({
  taskId: z.string().uuid(),
  status: offboardingTaskStatusSchema,
  blockedReason: z.string().min(1).max(1000).optional(),
});
export const updateOffboardingTaskStatusOutputSchema = z.object({
  taskId: z.string().uuid(),
  status: offboardingTaskStatusSchema,
  completedAt: z.string().nullable(),
  blockedReason: z.string().nullable(),
});
export type UpdateOffboardingTaskStatusInput = z.infer<
  typeof updateOffboardingTaskStatusInputSchema
>;
export type UpdateOffboardingTaskStatusOutput = z.infer<
  typeof updateOffboardingTaskStatusOutputSchema
>;

// ─────────── advanceOffboardingCase ───────────

/**
 * advanceOffboardingCase — forward-only lifecycle walk (initiated →
 * notice_period → clearance → completed) plus cancel-from-any-non-terminal.
 * Transition gates enforced in the router: → clearance requires
 * last_working_day; → completed requires the clearance gates (access_revocation
 * + asset_return tasks completed AND settlement approved|paid); → cancelled
 * requires a reason.
 */
export const advanceOffboardingCaseInputSchema = z.object({
  caseId: z.string().uuid(),
  targetStatus: offboardingCaseStatusSchema,
  // Required when targetStatus = 'cancelled'; the notice/LWD may also be
  // stamped on the → notice_period / → clearance steps.
  reason: z.string().min(1).max(2000).optional(),
  noticeStartDate: z.string().regex(DATE_ONLY, "Expected YYYY-MM-DD").optional(),
  lastWorkingDay: z.string().regex(DATE_ONLY, "Expected YYYY-MM-DD").optional(),
});
export const advanceOffboardingCaseOutputSchema = z.object({
  caseId: z.string().uuid(),
  status: offboardingCaseStatusSchema,
  // True when this advance enqueued the Workday terminate_employee event
  // (only on the → completed transition, and idempotent).
  terminateEnqueued: z.boolean(),
});
export type AdvanceOffboardingCaseInput = z.infer<typeof advanceOffboardingCaseInputSchema>;
export type AdvanceOffboardingCaseOutput = z.infer<typeof advanceOffboardingCaseOutputSchema>;

// ─────────── recordAssetReturn / updateAssetReturn ───────────

export const recordAssetReturnInputSchema = z.object({
  caseId: z.string().uuid(),
  assetType: z.string().min(1).max(120),
  assetTag: z.string().min(1).max(120).optional(),
  status: assetReturnStatusSchema.default("pending"),
  notes: z.string().max(2000).optional(),
});
export const assetReturnMutationOutputSchema = z.object({
  assetReturnId: z.string().uuid(),
  status: assetReturnStatusSchema,
  // True when this write flipped the asset_return checklist task to completed
  // (all rows returned/written_off).
  taskAutoCompleted: z.boolean(),
});
export type RecordAssetReturnInput = z.infer<typeof recordAssetReturnInputSchema>;
export type AssetReturnMutationOutput = z.infer<typeof assetReturnMutationOutputSchema>;

export const updateAssetReturnInputSchema = z
  .object({
    assetReturnId: z.string().uuid(),
    status: assetReturnStatusSchema.optional(),
    notes: z.string().max(2000).nullable().optional(),
    // The IT/HR membership signing off the return; stamped alongside a
    // → returned transition.
    receivedByMembershipId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (v) =>
      v.status !== undefined || v.notes !== undefined || v.receivedByMembershipId !== undefined,
    { message: "At least one field to update is required" },
  );
export type UpdateAssetReturnInput = z.infer<typeof updateAssetReturnInputSchema>;

// ─────────── recordExitInterview ───────────

/**
 * recordExitInterview — upsert the one-per-case exit interview. Before
 * submit it is a mutable draft (schedule + responses + free text); passing
 * submit:true stamps submitted_at ONCE, auto-completes the exit_interview
 * task, and freezes the row (further writes 409 — scorecard-immutability
 * discipline).
 */
export const recordExitInterviewInputSchema = z.object({
  caseId: z.string().uuid(),
  scheduledAt: z.string().datetime().optional(),
  conductedByMembershipId: z.string().uuid().nullable().optional(),
  structuredResponses: z.record(z.string(), z.unknown()).optional(),
  freeText: z.string().max(10000).nullable().optional(),
  submit: z.boolean().default(false),
});
export const recordExitInterviewOutputSchema = z.object({
  exitInterviewId: z.string().uuid(),
  submittedAt: z.string().nullable(),
  taskAutoCompleted: z.boolean(),
});
export type RecordExitInterviewInput = z.infer<typeof recordExitInterviewInputSchema>;
export type RecordExitInterviewOutput = z.infer<typeof recordExitInterviewOutputSchema>;

// ─────────── updateFinalSettlement ───────────

/**
 * updateFinalSettlement — walk the F&F record pending → calculated →
 * approved → paid (upsert-creates a pending row on first touch). → approved
 * requires the access_revocation task completed (requirements §8.3: IT
 * confirms access is cut before settlement is released). → paid stamps
 * paid_at and auto-completes the final_settlement task.
 */
export const updateFinalSettlementInputSchema = z.object({
  caseId: z.string().uuid(),
  status: finalSettlementStatusSchema,
  amountMinor: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  breakdown: z.record(z.string(), z.unknown()).optional(),
});
export const updateFinalSettlementOutputSchema = z.object({
  settlementId: z.string().uuid(),
  status: finalSettlementStatusSchema,
  paidAt: z.string().nullable(),
  taskAutoCompleted: z.boolean(),
});
export type UpdateFinalSettlementInput = z.infer<typeof updateFinalSettlementInputSchema>;
export type UpdateFinalSettlementOutput = z.infer<typeof updateFinalSettlementOutputSchema>;

// ─────────── getOffboardingCaseDetail / listOffboardingCases ───────────

export const offboardingCaseDetailSchema = offboardingCaseListRowSchema
  .omit({ totalTasks: true, completedTasks: true })
  .extend({
    managerName: z.string().nullable(),
    managerEmail: z.string().nullable(),
    initiatedByName: z.string().nullable(),
  });
export type OffboardingCaseDetail = z.infer<typeof offboardingCaseDetailSchema>;

export const getOffboardingCaseDetailInputSchema = z.object({
  caseId: z.string().uuid(),
});
export const getOffboardingCaseDetailOutputSchema = z.object({
  case: offboardingCaseDetailSchema,
  tasks: z.array(offboardingTaskRowSchema),
  assetReturns: z.array(assetReturnRowSchema),
  exitInterview: exitInterviewRowSchema.nullable(),
  settlement: finalSettlementRowSchema.nullable(),
});
export type GetOffboardingCaseDetailInput = z.infer<typeof getOffboardingCaseDetailInputSchema>;
export type GetOffboardingCaseDetailOutput = z.infer<typeof getOffboardingCaseDetailOutputSchema>;

export const listOffboardingCasesInputSchema = z.object({
  status: offboardingCaseStatusSchema.optional(),
  limit: z.number().int().positive().max(100).default(50),
  cursor: z.string().optional(),
});
export const listOffboardingCasesOutputSchema = z.object({
  items: z.array(offboardingCaseListRowSchema),
  nextCursor: z.string().nullable(),
});
export type ListOffboardingCasesInput = z.infer<typeof listOffboardingCasesInputSchema>;
export type ListOffboardingCasesOutput = z.infer<typeof listOffboardingCasesOutputSchema>;

// ─────────── listHiredCandidates (OFFBOARD-03) ───────────

/**
 * The hired-candidate picker for the initiate-offboarding flow. HireOps has no
 * employees table (OFFBOARD-01 header), so "hired" is the SAME predicate the
 * offboarding lib uses (resolveHireContext): a candidate has an accepted offer
 * OR an onboarding case. Each row carries whether the person already has a live
 * (non-cancelled) offboarding case, so the picker can disable them — initiating
 * a second live case would 409 on the partial-unique guard.
 */
export const hiredCandidateRowSchema = z.object({
  candidateId: z.string().uuid(),
  personName: z.string().nullable(),
  email: z.string().nullable(),
  // Latest onboarding case status when one exists — context in the picker.
  onboardingStatus: z.string().nullable(),
  hasActiveOffboardingCase: z.boolean(),
});
export type HiredCandidateRow = z.infer<typeof hiredCandidateRowSchema>;

export const listHiredCandidatesInputSchema = z.object({
  limit: z.number().int().positive().max(200).default(100),
});
export const listHiredCandidatesOutputSchema = z.object({
  items: z.array(hiredCandidateRowSchema),
});
export type ListHiredCandidatesInput = z.infer<typeof listHiredCandidatesInputSchema>;
export type ListHiredCandidatesOutput = z.infer<typeof listHiredCandidatesOutputSchema>;

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

// ─────────── CONF-03 — users & roles admin + retention ───────────

/**
 * The internal tenant roles an admin may assign on /admin/users. This is
 * TENANT_ROLES (mirror of the DB enum in @hireops/db) MINUS the identity
 * tiers that have their OWN lifecycles and must never be granted from this
 * surface: partner_admin / partner_user (partner org membership), candidate
 * (candidate account activation), employee (post-hire, provisioned by
 * onboarding). Re-declared here rather than imported from @hireops/db so the
 * frontend doesn't pull drizzle in — kept in sync with roles.ts by the
 * CONF-03 test (exclusion asserted). Flagged in the hand-back.
 */
export const INTERNAL_TENANT_ROLES = [
  "admin",
  "recruiter",
  "hiring_manager",
  "panel_member",
  "hr_ops",
  "people_ops",
  "it_admin",
  "hr_head",
] as const;
export const internalTenantRoleSchema = z.enum(INTERNAL_TENANT_ROLES);
export type InternalTenantRole = z.infer<typeof internalTenantRoleSchema>;

/** Membership statuses the admin surface may set (deactivate/reactivate). */
export const MEMBERSHIP_ADMIN_STATUSES = ["active", "suspended"] as const;
export const membershipAdminStatusSchema = z.enum(MEMBERSHIP_ADMIN_STATUSES);
export type MembershipAdminStatus = z.infer<typeof membershipAdminStatusSchema>;

/**
 * One membership row for the users & roles admin table. Richer than
 * TenantMembershipRow (the assignment picker): carries status + createdAt
 * and includes non-active memberships, and flags the row that is the
 * caller's own membership so the client can render the self-guard affordances.
 */
export const tenantUserAdminRowSchema = z.object({
  membershipId: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  roles: z.array(z.string()),
  status: z.string(),
  createdAt: z.string(),
  isSelf: z.boolean(),
});
export type TenantUserAdminRow = z.infer<typeof tenantUserAdminRowSchema>;

export const listTenantUsersAdminInputSchema = z.object({}).optional();
export const listTenantUsersAdminOutputSchema = z.object({
  items: z.array(tenantUserAdminRowSchema),
});
export type ListTenantUsersAdminOutput = z.infer<typeof listTenantUsersAdminOutputSchema>;

export const inviteTenantUserInputSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().trim().min(1).max(200).optional(),
  roles: z.array(internalTenantRoleSchema).min(1).max(INTERNAL_TENANT_ROLES.length),
});
export type InviteTenantUserInput = z.infer<typeof inviteTenantUserInputSchema>;
export const inviteTenantUserOutputSchema = z.object({
  membershipId: z.string().uuid(),
  userId: z.string().uuid(),
  email: z.string(),
  /** The temporary password, shown ONCE. No email is sent this ticket. */
  tempPassword: z.string(),
  /** True when the email already had an auth identity (password was reset). */
  alreadyExisted: z.boolean(),
  /** True when an active membership already existed and was updated in place. */
  membershipReused: z.boolean(),
});
export type InviteTenantUserOutput = z.infer<typeof inviteTenantUserOutputSchema>;

export const updateMembershipRolesInputSchema = z.object({
  membershipId: z.string().uuid(),
  roles: z.array(internalTenantRoleSchema).min(1).max(INTERNAL_TENANT_ROLES.length),
});
export type UpdateMembershipRolesInput = z.infer<typeof updateMembershipRolesInputSchema>;
export const updateMembershipRolesOutputSchema = z.object({
  ok: z.literal(true),
  membershipId: z.string().uuid(),
  roles: z.array(z.string()),
});
export type UpdateMembershipRolesOutput = z.infer<typeof updateMembershipRolesOutputSchema>;

export const setMembershipStatusInputSchema = z.object({
  membershipId: z.string().uuid(),
  status: membershipAdminStatusSchema,
});
export type SetMembershipStatusInput = z.infer<typeof setMembershipStatusInputSchema>;
export const setMembershipStatusOutputSchema = z.object({
  ok: z.literal(true),
  membershipId: z.string().uuid(),
  status: z.string(),
});
export type SetMembershipStatusOutput = z.infer<typeof setMembershipStatusOutputSchema>;

/**
 * Read-only data-retention reference (CONF-03). Surfaces the ONBOARD-01
 * document_types reference rows (retention years per geography). READ-ONLY —
 * enforcement automation is a future work package.
 */
export const documentRetentionRowSchema = z.object({
  code: z.string(),
  name: z.string(),
  geographyCode: z.string().nullable(),
  requiredForLifecycleStage: z.string().nullable(),
  retentionYears: z.number().int().nullable(),
});
export type DocumentRetentionRow = z.infer<typeof documentRetentionRowSchema>;
export const getDocumentRetentionInputSchema = z.object({}).optional();
export const getDocumentRetentionOutputSchema = z.object({
  items: z.array(documentRetentionRowSchema),
});
export type GetDocumentRetentionOutput = z.infer<typeof getDocumentRetentionOutputSchema>;

// ─────────── INT-02 — interview scheduling ───────────

/**
 * One round in an interview plan (the blueprint). `defaultPanelMembershipIds`
 * are advisory: memberships that typically staff this round, pre-filling the
 * scheduling modal's panel picker. Validated server-side as real active
 * memberships on upsert.
 */
export const interviewPlanRoundSchema = z.object({
  roundNumber: z.number().int().min(1).max(20),
  roundName: z.string().min(1).max(120),
  durationMinutes: z.number().int().min(15).max(480),
  mode: interviewModeSchema,
  scorecardTemplate: interviewScorecardTemplateSchema,
  competencyFocus: z.array(z.string().min(1).max(80)).max(20).default([]),
  defaultPanelMembershipIds: z.array(z.string().uuid()).max(20).default([]),
});
export type InterviewPlanRound = z.infer<typeof interviewPlanRoundSchema>;

/**
 * Replace-set the plan rounds for a requisition. The whole ordered loop is
 * sent every time; the server deletes the requisition's existing plan rows
 * and re-inserts these (round_number must be unique within the array). An
 * empty array clears the plan.
 */
export const upsertInterviewPlanInputSchema = z.object({
  requisitionId: z.string().uuid(),
  rounds: z.array(interviewPlanRoundSchema).max(20),
});
export const upsertInterviewPlanOutputSchema = z.object({
  requisitionId: z.string().uuid(),
  roundCount: z.number().int().nonnegative(),
});
export type UpsertInterviewPlanInput = z.infer<typeof upsertInterviewPlanInputSchema>;
export type UpsertInterviewPlanOutput = z.infer<typeof upsertInterviewPlanOutputSchema>;

/**
 * Read the plan for a requisition — by requisitionId directly, or by an
 * applicationId (the scheduling modal in the triage drawer only knows the
 * application; the server resolves its requisition). Exactly one is required.
 */
export const getInterviewPlanInputSchema = z
  .object({
    requisitionId: z.string().uuid().optional(),
    applicationId: z.string().uuid().optional(),
  })
  .refine((v) => Boolean(v.requisitionId) !== Boolean(v.applicationId), {
    message: "Provide exactly one of requisitionId or applicationId",
  });
export const getInterviewPlanOutputSchema = z.object({
  requisitionId: z.string().uuid(),
  rounds: z.array(
    interviewPlanRoundSchema.extend({
      id: z.string().uuid(),
    }),
  ),
});
export type GetInterviewPlanInput = z.infer<typeof getInterviewPlanInputSchema>;
export type GetInterviewPlanOutput = z.infer<typeof getInterviewPlanOutputSchema>;

const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "Expected an ISO date-time"));

/**
 * Schedule one round for an application. `roundNumber` selects the plan
 * round; mode / duration / panel default from that round but each can be
 * overridden. `panelMembershipIds` (≥1) is the concrete panel; `leadMembershipId`
 * (optional) must be one of them. A meeting URL is optional (video rounds).
 */
export const scheduleInterviewInputSchema = z
  .object({
    applicationId: z.string().uuid(),
    roundNumber: z.number().int().min(1).max(20),
    scheduledStart: isoDateTimeSchema,
    scheduledEnd: isoDateTimeSchema.optional(),
    durationMinutes: z.number().int().min(15).max(480).optional(),
    mode: interviewModeSchema.optional(),
    meetingUrl: z.string().url().max(2000).optional(),
    panelMembershipIds: z.array(z.string().uuid()).min(1).max(20),
    leadMembershipId: z.string().uuid().optional(),
  })
  .refine((v) => !v.leadMembershipId || v.panelMembershipIds.includes(v.leadMembershipId), {
    message: "leadMembershipId must be one of panelMembershipIds",
    path: ["leadMembershipId"],
  });
export const scheduleInterviewOutputSchema = z.object({
  interviewId: z.string().uuid(),
  roundNumber: z.number().int(),
  invitationSentTo: z.string().email().nullable(),
});
export type ScheduleInterviewInput = z.infer<typeof scheduleInterviewInputSchema>;
export type ScheduleInterviewOutput = z.infer<typeof scheduleInterviewOutputSchema>;

/**
 * Reschedule: cancel the existing (non-cancelled) round for this application +
 * round_number and create a replacement in one transaction (new signed link,
 * new invitation email). Same override surface as scheduleInterview.
 */
export const rescheduleInterviewInputSchema = scheduleInterviewInputSchema;
export const rescheduleInterviewOutputSchema = z.object({
  interviewId: z.string().uuid(),
  cancelledInterviewId: z.string().uuid().nullable(),
  roundNumber: z.number().int(),
  invitationSentTo: z.string().email().nullable(),
});
export type RescheduleInterviewInput = z.infer<typeof rescheduleInterviewInputSchema>;
export type RescheduleInterviewOutput = z.infer<typeof rescheduleInterviewOutputSchema>;

export const cancelInterviewInputSchema = z.object({
  interviewId: z.string().uuid(),
  reason: z.string().min(1).max(500),
});
export const cancelInterviewOutputSchema = z.object({ interviewId: z.string().uuid() });
export type CancelInterviewInput = z.infer<typeof cancelInterviewInputSchema>;
export type CancelInterviewOutput = z.infer<typeof cancelInterviewOutputSchema>;

/**
 * Per-panelist feedback state (INT-03). `none` = no interview_feedback row;
 * `draft` = row exists, submitted_at NULL; `submitted` = submitted_at stamped.
 * This is the single vocabulary the recruiter chips and the panel "my
 * feedback" badge both read.
 */
export const feedbackStateSchema = z.enum(["none", "draft", "submitted"]);
export type FeedbackState = z.infer<typeof feedbackStateSchema>;

/** One panelist on an interview (name for display, lead flag, feedback state).
 * `feedbackState` (INT-03) surfaces each panelist's scorecard progress on the
 * recruiter interview rows — 'none' until INT-03 reads populate it. */
export const interviewPanelistViewSchema = z.object({
  membershipId: z.string().uuid(),
  name: z.string().nullable(),
  isLead: z.boolean(),
  feedbackState: feedbackStateSchema,
});
export type InterviewPanelistView = z.infer<typeof interviewPanelistViewSchema>;

export const interviewRowSchema = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  candidateId: z.string().uuid(),
  requisitionId: z.string().uuid(),
  roundNumber: z.number().int(),
  roundName: z.string(),
  status: interviewStatusSchema,
  scheduledStart: z.string().nullable(),
  scheduledEnd: z.string().nullable(),
  durationMinutes: z.number().int(),
  mode: interviewModeSchema,
  meetingUrl: z.string().nullable(),
  candidateConfirmedAt: z.string().nullable(),
  candidateName: z.string().nullable(),
  positionTitle: z.string(),
  panel: z.array(interviewPanelistViewSchema),
  createdAt: z.string(),
  /** A13 honest slice (RECR-01): when the candidate interview-invitation
   * notification (with the generated .ics attachment) was enqueued for this
   * interview — reflects a REAL notification_outbox row. null when no invite
   * has been sent (e.g. no candidate email on file). Drives the "invite sent
   * (.ics)" badge — deliberately NOT "calendar synced". */
  invitationSentAt: z.string().nullable(),
});
export type InterviewRow = z.infer<typeof interviewRowSchema>;

/** Rounds already scheduled for a single application (triage drawer). */
export const listInterviewsByApplicationInputSchema = z.object({
  applicationId: z.string().uuid(),
});
export const listInterviewsByApplicationOutputSchema = z.object({
  requisitionId: z.string().uuid(),
  rows: z.array(interviewRowSchema),
});
export type ListInterviewsByApplicationInput = z.infer<
  typeof listInterviewsByApplicationInputSchema
>;
export type ListInterviewsByApplicationOutput = z.infer<
  typeof listInterviewsByApplicationOutputSchema
>;

/** Recruiter upcoming-interviews list (the /interviews page). Keyset on
 * (scheduled_start, id); status filter defaults to scheduled. */
export const listUpcomingInterviewsInputSchema = z.object({
  status: interviewStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export const listUpcomingInterviewsOutputSchema = z.object({
  rows: z.array(interviewRowSchema),
  nextCursor: z.string().nullable(),
});
export type ListUpcomingInterviewsInput = z.infer<typeof listUpcomingInterviewsInputSchema>;
export type ListUpcomingInterviewsOutput = z.infer<typeof listUpcomingInterviewsOutputSchema>;

// ─── Public interview-confirm route (REST, mirrors offer accept) ───

export const interviewConfirmPreviewResponseSchema = z.object({
  ok: z.literal(true),
  interviewId: z.string().uuid(),
  status: interviewStatusSchema,
  candidateName: z.string(),
  companyName: z.string(),
  positionTitle: z.string(),
  roundName: z.string(),
  scheduledStart: z.string().nullable(),
  durationMinutes: z.number().int(),
  mode: interviewModeSchema,
  meetingUrl: z.string().nullable(),
  alreadyConfirmedAt: z.string().nullable(),
});
export type InterviewConfirmPreviewResponse = z.infer<typeof interviewConfirmPreviewResponseSchema>;

export const interviewConfirmResponseSchema = z.object({
  ok: z.literal(true),
  interviewId: z.string().uuid(),
  confirmedAt: z.string(),
});
export type InterviewConfirmResponse = z.infer<typeof interviewConfirmResponseSchema>;

// ─────────── INT-03 — the panel persona (scorecards) ───────────

/**
 * THE scorecard rubric (INT-03). One fixed criteria set per scorecard_template
 * — 5 criteria each, every score an integer 1..5. The gap audit (§5) rejected
 * the prototype's three conflicting point-splits: one rubric system,
 * parameterised by template. These keys are the contract between the API
 * validator and the panel scorecard form; changing a key is a breaking change
 * to any stored scorecard, so treat this as append-mostly.
 *
 * Recommendation is separate (strong_yes|yes|hold|no) and required only on
 * submit — see saveInterviewFeedbackInputSchema.
 */
export interface ScorecardCriterion {
  key: string;
  label: string;
}
export const SCORECARD_CRITERIA: Record<InterviewScorecardTemplate, readonly ScorecardCriterion[]> =
  {
    technical: [
      { key: "problem_solving", label: "Problem solving" },
      { key: "technical_depth", label: "Technical depth" },
      { key: "code_quality", label: "Code quality & craft" },
      { key: "system_design", label: "System design" },
      { key: "communication", label: "Communication" },
    ],
    manager: [
      { key: "ownership", label: "Ownership & drive" },
      { key: "stakeholder_management", label: "Stakeholder management" },
      { key: "delivery_track_record", label: "Delivery track record" },
      { key: "strategic_thinking", label: "Strategic thinking" },
      { key: "communication", label: "Communication" },
    ],
    hr: [
      { key: "culture_alignment", label: "Culture alignment" },
      { key: "motivation", label: "Motivation & intent" },
      { key: "communication", label: "Communication" },
      { key: "integrity", label: "Integrity & professionalism" },
      { key: "growth_mindset", label: "Growth mindset" },
    ],
    general: [
      { key: "role_competence", label: "Role competence" },
      { key: "problem_solving", label: "Problem solving" },
      { key: "communication", label: "Communication" },
      { key: "collaboration", label: "Collaboration" },
      { key: "motivation", label: "Motivation" },
    ],
  };

/** Criteria set for a template, defaulting to `general` for an unknown/missing
 * template (e.g. the interview's plan round was removed after scheduling). */
export function scorecardCriteriaFor(
  template: string | null | undefined,
): readonly ScorecardCriterion[] {
  if (template && template in SCORECARD_CRITERIA) {
    return SCORECARD_CRITERIA[template as InterviewScorecardTemplate] ?? SCORECARD_CRITERIA.general;
  }
  return SCORECARD_CRITERIA.general;
}

export const interviewRecommendationSchema = z.enum(["strong_yes", "yes", "hold", "no"]);
export type InterviewRecommendation = z.infer<typeof interviewRecommendationSchema>;

/**
 * "My interviews" — the interviews the caller is a panelist on. Reuses the
 * interviewRow shape (candidate name, role, round, when, mode, meeting URL,
 * panel) and adds `myFeedbackState` so the list can badge each row. Split into
 * upcoming/past client-side by scheduledStart.
 */
export const panelInterviewRowSchema = interviewRowSchema.extend({
  myFeedbackState: feedbackStateSchema,
});
export type PanelInterviewRow = z.infer<typeof panelInterviewRowSchema>;

export const listMyPanelInterviewsInputSchema = z
  .object({
    status: interviewStatusSchema.optional(),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .default({ limit: 100 });
export const listMyPanelInterviewsOutputSchema = z.object({
  rows: z.array(panelInterviewRowSchema),
});
export type ListMyPanelInterviewsInput = z.infer<typeof listMyPanelInterviewsInputSchema>;
export type ListMyPanelInterviewsOutput = z.infer<typeof listMyPanelInterviewsOutputSchema>;

/** A criterion presented to the panelist for THIS interview's template, with
 * the score they've saved so far (null = unscored). */
export const panelScorecardCriterionSchema = z.object({
  key: z.string(),
  label: z.string(),
  score: z.number().int().min(1).max(5).nullable(),
});
export type PanelScorecardCriterion = z.infer<typeof panelScorecardCriterionSchema>;

/** A prior-round feedback summary shown on the brief. DELIBERATE partial
 * disclosure (gap-audit): recommendation + strengths + concerns only — NO
 * per-criterion scores, so a later panelist isn't anchored on numbers. */
export const priorRoundFeedbackSchema = z.object({
  interviewId: z.string().uuid(),
  roundNumber: z.number().int(),
  roundName: z.string(),
  panelistName: z.string().nullable(),
  recommendation: interviewRecommendationSchema.nullable(),
  strengths: z.string().nullable(),
  concerns: z.string().nullable(),
  submittedAt: z.string().nullable(),
});
export type PriorRoundFeedback = z.infer<typeof priorRoundFeedbackSchema>;

export const getPanelInterviewBriefInputSchema = z.object({
  interviewId: z.string().uuid(),
});
export const getPanelInterviewBriefOutputSchema = z.object({
  interview: z.object({
    id: z.string().uuid(),
    applicationId: z.string().uuid(),
    roundNumber: z.number().int(),
    roundName: z.string(),
    status: interviewStatusSchema,
    mode: interviewModeSchema,
    scheduledStart: z.string().nullable(),
    scheduledEnd: z.string().nullable(),
    durationMinutes: z.number().int(),
    meetingUrl: z.string().nullable(),
    candidateConfirmedAt: z.string().nullable(),
    positionTitle: z.string(),
  }),
  candidate: z.object({
    candidateId: z.string().uuid(),
    name: z.string().nullable(),
    currentStage: applicationStageSchema,
    locationCountry: z.string().nullable(),
    // resume-derived summary — the parsed skills already read for the drawer;
    // no new PII join beyond what getCandidateById exposes.
    parsedSkills: z.array(z.string()),
    // PANEL-02: parsed years-of-experience for the experience summary card.
    // Rendered only when present (honest empty state otherwise).
    yearsOfExperience: z.number().nullable(),
  }),
  round: z.object({
    scorecardTemplate: interviewScorecardTemplateSchema,
    competencyFocus: z.array(z.string()),
  }),
  // PANEL-02: deterministic Resume-vs-JD skills overlap (no AI). Computed
  // server-side from candidate.parsedSkills vs the requisition's jd_skills.
  skillsMatch: skillsMatchResultSchema,
  coPanelists: z.array(
    z.object({
      membershipId: z.string().uuid(),
      name: z.string().nullable(),
      isLead: z.boolean(),
      isMe: z.boolean(),
    }),
  ),
  priorRoundFeedback: z.array(priorRoundFeedbackSchema),
  myFeedback: z.object({
    state: feedbackStateSchema,
    criteria: z.array(panelScorecardCriterionSchema),
    strengths: z.string().nullable(),
    concerns: z.string().nullable(),
    notes: z.string().nullable(),
    recommendation: interviewRecommendationSchema.nullable(),
    submittedAt: z.string().nullable(),
  }),
});
export type GetPanelInterviewBriefInput = z.infer<typeof getPanelInterviewBriefInputSchema>;
export type GetPanelInterviewBriefOutput = z.infer<typeof getPanelInterviewBriefOutputSchema>;

/**
 * Save MY scorecard for an interview I'm on. `scorecard` is a
 * criterion-key → 1..5 map; keys are validated against the round template's
 * criteria set and values must be integers 1..5 (extra/unknown keys rejected).
 * `action` 'draft' leaves submitted_at NULL (partial allowed); 'submit' stamps
 * submitted_at, REQUIRES recommendation, and freezes the row (further saves →
 * CONFLICT).
 */
export const saveInterviewFeedbackInputSchema = z.object({
  interviewId: z.string().uuid(),
  scorecard: z.record(z.string(), z.number().int().min(1).max(5)).default({}),
  strengths: z.string().max(4000).nullish(),
  concerns: z.string().max(4000).nullish(),
  notes: z.string().max(4000).nullish(),
  recommendation: interviewRecommendationSchema.nullish(),
  action: z.enum(["draft", "submit"]),
});
export const saveInterviewFeedbackOutputSchema = z.object({
  interviewId: z.string().uuid(),
  state: feedbackStateSchema,
  submittedAt: z.string().nullable(),
});
export type SaveInterviewFeedbackInput = z.infer<typeof saveInterviewFeedbackInputSchema>;
export type SaveInterviewFeedbackOutput = z.infer<typeof saveInterviewFeedbackOutputSchema>;

// ─────────── INT-04 — completion + stage transitions ───────────

/**
 * Complete an interview. Recruiter / hiring_manager / admin surface.
 *
 * Default policy: allowed only when EVERY panelist on the interview has
 * SUBMITTED their scorecard. `force: true` (with a required `reason`) is the
 * honest escape hatch for no-show panelists — it records WHY the loop is being
 * closed early into the audited input. There is no silent auto-advance: the
 * mutation returns `suggestedNextStage` and the UI offers the advance as an
 * explicit, human-in-the-loop action (consistent with the product's approval
 * philosophy). CONFLICT if the interview isn't `scheduled` (already
 * completed / cancelled / no_show).
 */
export const completeInterviewInputSchema = z.object({
  interviewId: z.string().uuid(),
  force: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});
export const completeInterviewOutputSchema = z.object({
  interviewId: z.string().uuid(),
  status: z.literal("completed"),
  forced: z.boolean(),
  panelistCount: z.number().int(),
  submittedCount: z.number().int(),
  // The stage this interview belongs to (derived from its scorecard template)
  // and the natural next stage the recruiter is invited to advance to. Null
  // suggestion when the interview's stage has no defined forward step.
  belongsToStage: applicationStageSchema,
  suggestedNextStage: applicationStageSchema.nullable(),
});
export type CompleteInterviewInput = z.infer<typeof completeInterviewInputSchema>;
export type CompleteInterviewOutput = z.infer<typeof completeInterviewOutputSchema>;

/** Mark a scheduled interview as no-show (candidate didn't attend). Reason
 * optional. CONFLICT if the interview isn't `scheduled`. */
export const markInterviewNoShowInputSchema = z.object({
  interviewId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});
export const markInterviewNoShowOutputSchema = z.object({
  interviewId: z.string().uuid(),
  status: z.literal("no_show"),
});
export type MarkInterviewNoShowInput = z.infer<typeof markInterviewNoShowInputSchema>;
export type MarkInterviewNoShowOutput = z.infer<typeof markInterviewNoShowOutputSchema>;

/**
 * Advance the application after a completed interview. Recruiter /
 * hiring_manager / admin. Guarded: the interview must be `completed`, and the
 * application's current_stage must equal the stage the interview belongs to
 * (only advance FROM the interview's own stage — never skip or double-advance).
 * The round's recommendation roll-up is written into the transition metadata.
 * Reuses the existing stage-transition discipline (transitionApplicationStage),
 * so the append-only transition row + candidate-facing email fire exactly as a
 * manual triage advance does.
 */
export const advanceApplicationAfterInterviewInputSchema = z.object({
  interviewId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});
export const advanceApplicationAfterInterviewOutputSchema = z.object({
  applicationId: z.string().uuid(),
  fromStage: applicationStageSchema,
  toStage: applicationStageSchema,
  transitionId: z.string().uuid(),
});
export type AdvanceApplicationAfterInterviewInput = z.infer<
  typeof advanceApplicationAfterInterviewInputSchema
>;
export type AdvanceApplicationAfterInterviewOutput = z.infer<
  typeof advanceApplicationAfterInterviewOutputSchema
>;

/**
 * Recruiter-side decision summary for one interview (getInterviewDecisionSummary
 * — recruiter / hiring_manager / admin, NOT the panel). This is the read the
 * panel brief deliberately HIDES: per-panelist FULL scorecards (every criterion
 * score), recommendations, lead flags, plus an honest computed roll-up (counts
 * per recommendation + the lead's recommendation surfaced as the headline). No
 * AI, no weighting — counts + lead, labelled plainly.
 */
export const decisionPanelistSchema = z.object({
  membershipId: z.string().uuid(),
  name: z.string().nullable(),
  isLead: z.boolean(),
  feedbackState: feedbackStateSchema,
  recommendation: interviewRecommendationSchema.nullable(),
  // FULL per-criterion scores — the panel brief never exposes these across
  // rounds; the recruiter decision view does.
  scorecard: z.array(panelScorecardCriterionSchema),
  strengths: z.string().nullable(),
  concerns: z.string().nullable(),
  notes: z.string().nullable(),
  submittedAt: z.string().nullable(),
});
export type DecisionPanelist = z.infer<typeof decisionPanelistSchema>;

export const decisionRollupSchema = z.object({
  panelistCount: z.number().int(),
  submittedCount: z.number().int(),
  counts: z.object({
    strong_yes: z.number().int(),
    yes: z.number().int(),
    hold: z.number().int(),
    no: z.number().int(),
  }),
  // The lead panelist's recommendation — the honest headline. Null when the
  // lead hasn't submitted (or there is no lead).
  leadRecommendation: interviewRecommendationSchema.nullable(),
});
export type DecisionRollup = z.infer<typeof decisionRollupSchema>;

export const getInterviewDecisionSummaryInputSchema = z.object({
  interviewId: z.string().uuid(),
});
export const getInterviewDecisionSummaryOutputSchema = z.object({
  interviewId: z.string().uuid(),
  roundNumber: z.number().int(),
  roundName: z.string(),
  status: interviewStatusSchema,
  scorecardTemplate: interviewScorecardTemplateSchema,
  panelists: z.array(decisionPanelistSchema),
  rollup: decisionRollupSchema,
});
export type GetInterviewDecisionSummaryInput = z.infer<
  typeof getInterviewDecisionSummaryInputSchema
>;
export type GetInterviewDecisionSummaryOutput = z.infer<
  typeof getInterviewDecisionSummaryOutputSchema
>;

/**
 * POLISH-01 (Item C) — reopen a submitted panelist scorecard. Recruiter /
 * hiring_manager / admin only (NOT the panelist themselves); an explicit
 * reason is required for the audit trail. Clearing `submitted_at` returns the
 * feedback to `draft`, so the panelist's read-only scorecard becomes editable
 * again and they can resubmit. CONFLICT if the interview is already completed —
 * reopening after completion would corrupt the decision basis.
 */
export const reopenInterviewFeedbackInputSchema = z.object({
  interviewId: z.string().uuid(),
  membershipId: z.string().uuid(),
  reason: z.string().min(1).max(500),
});
export const reopenInterviewFeedbackOutputSchema = z.object({
  interviewId: z.string().uuid(),
  membershipId: z.string().uuid(),
  state: feedbackStateSchema,
});
export type ReopenInterviewFeedbackInput = z.infer<typeof reopenInterviewFeedbackInputSchema>;
export type ReopenInterviewFeedbackOutput = z.infer<typeof reopenInterviewFeedbackOutputSchema>;

// ─────────── PARTNER-01 — partner-portal procedures ───────────

/**
 * Partner identity + org for the shell. Resolved from the partner_users
 * row (via the api's partnerProcedure) — never from tenant_user_memberships.
 * `role` is the partner-side RBAC role ('partner_admin' | 'partner_user').
 */
export const partnerGetMeOutputSchema = z.object({
  partnerUserId: z.string().uuid(),
  partnerOrgId: z.string().uuid(),
  tenantId: z.string().uuid(),
  orgName: z.string(),
  displayName: z.string(),
  email: z.string(),
  role: z.enum(["partner_admin", "partner_user"]),
});
export type PartnerGetMeOutput = z.infer<typeof partnerGetMeOutputSchema>;

/**
 * One assigned-req card. Columns the dashboard needs — title + location +
 * status + dates + openings. Assignment scoping (partner_org_id) is applied
 * server-side; the partner never sees other orgs' assignments or the full
 * candidate pipeline count.
 */
export const partnerAssignedRequisitionRowSchema = z.object({
  requisitionId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  title: z.string(),
  location: z.string().nullable(),
  requisitionStatus: z.string(),
  numberOfOpenings: z.number().int(),
  postedAt: z.string().nullable(),
  targetStartDate: z.string().nullable(),
  assignedAt: z.string(),
});
export type PartnerAssignedRequisitionRow = z.infer<typeof partnerAssignedRequisitionRowSchema>;

export const partnerListAssignedRequisitionsInputSchema = z
  .object({ limit: z.number().int().min(1).max(200).optional() })
  .optional();
export const partnerListAssignedRequisitionsOutputSchema = z.object({
  items: z.array(partnerAssignedRequisitionRowSchema),
  capped: z.boolean(),
});
export type PartnerListAssignedRequisitionsInput = z.infer<
  typeof partnerListAssignedRequisitionsInputSchema
>;
export type PartnerListAssignedRequisitionsOutput = z.infer<
  typeof partnerListAssignedRequisitionsOutputSchema
>;

/**
 * One submission row, read from candidate_ownership_claims (the honest
 * Wave-1 submission model per partner-data-model.md — `submissions` is an
 * alias for applications+ownership claims). The partner sees stage/status +
 * date only, never internal scoring or feedback (partner-wireflows §3.7/3.8).
 * At POC scale nothing seeds partner claims yet, so this returns [] and the
 * shell renders an explicit empty state.
 */
export const partnerSubmissionRowSchema = z.object({
  claimId: z.string().uuid(),
  candidateName: z.string().nullable(),
  requisitionTitle: z.string().nullable(),
  status: z.string(),
  claimedAt: z.string(),
  expiresAt: z.string(),
  // PARTNER-02 — the submission's live pipeline stage, read through the
  // claiming application. The partner sees the stage label only (never the
  // internal AI score or feedback); wireflows §3.7/3.8.
  applicationId: z.string().uuid().nullable(),
  requisitionId: z.string().uuid().nullable(),
  stage: z.string().nullable(),
});
export type PartnerSubmissionRow = z.infer<typeof partnerSubmissionRowSchema>;

// ─────────── PARTNER-02 — partner candidate submission ───────────

/**
 * Candidate fields a partner submits. Shape mirrors the public apply form's
 * applicant (submitApplicationApplicantSchema) so partner-sourced candidates
 * land in the SAME pipeline, plus the partner-only optional context columns
 * (current company/title) and the note-to-recruiter the wireflows' step-2
 * form collects (partner-wireflows §3.5).
 */
export const partnerSubmitCandidateFieldsSchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().min(3).max(40),
  locationCountry: z.string().length(2).optional(),
  linkedinUrl: z.string().url().max(500).optional(),
  currentCompany: z.string().max(200).optional(),
  currentTitle: z.string().max(200).optional(),
  noteToRecruiter: z.string().max(500).optional(),
});

/**
 * partnerSubmitCandidate input. `consentAttested` collapses the wireflows'
 * three DPDPA/accuracy checkboxes; `ownershipAcknowledged` is the ownership-
 * claim attestation ("By submitting, you claim ownership … the 90-day
 * exclusivity window starts now"). Both are z.literal(true) so a submission
 * that didn't tick them fails validation server-side, not just in the UI.
 */
export const partnerSubmitCandidateInputSchema = z.object({
  requisitionId: z.string().uuid(),
  resumeUploadKey: z.string().min(1).max(500),
  candidate: partnerSubmitCandidateFieldsSchema,
  consentAttested: z.literal(true),
  ownershipAcknowledged: z.literal(true),
  consentVersion: z.string().min(1).max(40),
});
export type PartnerSubmitCandidateInput = z.infer<typeof partnerSubmitCandidateInputSchema>;

/**
 * Discriminated outcome of a partner submission — the three branches of the
 * wireflows' dedup decision tree (§3.5). The UI renders faithful copy per
 * outcome; the data each branch carries is exactly what that copy needs.
 *
 *  - created:          no active claim → new candidate + application + claim.
 *  - duplicate_blocked: an active claim owned by ANOTHER partner → rejected.
 *                       Carries only `blockedDaysAgo` — never the owning
 *                       partner's identity (requirements.md §6.4 non-disclosure).
 *  - added_to_existing: an active claim owned by THIS partner on another req →
 *                       a second application is added under the same claim.
 *                       `alreadyOnThisReq` is true when the candidate was
 *                       already submitted for THIS req (idempotent re-submit).
 */
const partnerSubmitCreatedSchema = z.object({
  outcome: z.literal("created"),
  applicationId: z.string().uuid(),
  candidateId: z.string().uuid(),
  claimId: z.string().uuid(),
  personId: z.string().uuid(),
  parseStatus: z.enum(["received", "parse_failed"]),
  claimExpiresAt: z.string(),
});
const partnerSubmitDuplicateBlockedSchema = z.object({
  outcome: z.literal("duplicate_blocked"),
  blockedDaysAgo: z.number().int().nonnegative(),
});
const partnerSubmitAddedToExistingSchema = z.object({
  outcome: z.literal("added_to_existing"),
  applicationId: z.string().uuid(),
  candidateId: z.string().uuid(),
  claimId: z.string().uuid(),
  alreadyOnThisReq: z.boolean(),
  priorRequisitionTitle: z.string().nullable(),
  priorClaimedAt: z.string(),
  parseStatus: z.enum(["received", "parse_failed"]),
});
export const partnerSubmitCandidateOutputSchema = z.discriminatedUnion("outcome", [
  partnerSubmitCreatedSchema,
  partnerSubmitDuplicateBlockedSchema,
  partnerSubmitAddedToExistingSchema,
]);
export type PartnerSubmitCandidateOutput = z.infer<typeof partnerSubmitCandidateOutputSchema>;

export const partnerListMySubmissionsInputSchema = z
  .object({ limit: z.number().int().min(1).max(200).optional() })
  .optional();
export const partnerListMySubmissionsOutputSchema = z.object({
  items: z.array(partnerSubmissionRowSchema),
  capped: z.boolean(),
});
export type PartnerListMySubmissionsInput = z.infer<typeof partnerListMySubmissionsInputSchema>;
export type PartnerListMySubmissionsOutput = z.infer<typeof partnerListMySubmissionsOutputSchema>;

// ═══════════════════ CAND-01 — candidate accounts ═══════════════════

/**
 * Candidate-visible stage stepper. A strict SUBSET of the real
 * application_stage enum, in the enum's own forward order — no invented
 * stages (prototype-gap-audit §5). Terminal/back-office stages
 * (ai_screening, offer_declined, withdrawn, recruiter_rejected) are NOT
 * steps: a candidate sees the forward journey, and a terminal current_stage
 * is surfaced as a status note, not a step. `offer_accepted` is the final
 * step (the happy path); the actual offer surface arrives in CAND-02.
 */
export const CANDIDATE_STAGE_STEPS = [
  "application_received",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
] as const;
export type CandidateStageStep = (typeof CANDIDATE_STAGE_STEPS)[number];

// ─────────────── requestCandidateActivation (public) ───────────────

export const requestCandidateActivationInputSchema = z.object({
  email: z.string().email(),
  // Which tenant to activate against. The candidate login page carries this
  // (single-tenant POC defaults to kyndryl-poc); a tenant-scoped path or a
  // slug keeps the endpoint from having to enumerate tenants.
  tenantSlug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
});
export type RequestCandidateActivationInput = z.infer<typeof requestCandidateActivationInputSchema>;

/**
 * ALWAYS the same response, whether or not a person with that email exists —
 * no account enumeration (requirements.md §9.2). The UI shows "if the email
 * exists, we've sent a link" unconditionally.
 */
export const requestCandidateActivationOutputSchema = z.object({ ok: z.literal(true) });
export type RequestCandidateActivationOutput = z.infer<
  typeof requestCandidateActivationOutputSchema
>;

// ─────────────── completeCandidateActivation (public) ───────────────

export const completeCandidateActivationInputSchema = z.object({
  token: z.string().min(1).max(2000),
  password: z.string().min(8).max(200),
});
export type CompleteCandidateActivationInput = z.infer<
  typeof completeCandidateActivationInputSchema
>;

export const completeCandidateActivationOutputSchema = z.object({
  ok: z.literal(true),
  // The email the candidate now signs in with (echoed for the login prefill).
  email: z.string().email(),
});
export type CompleteCandidateActivationOutput = z.infer<
  typeof completeCandidateActivationOutputSchema
>;

// ─────────────── candidateGetMe ───────────────

export const candidateGetMeOutputSchema = z.object({
  candidateAccountId: z.string().uuid(),
  personId: z.string().uuid(),
  tenantId: z.string().uuid(),
  tenantDisplayName: z.string(),
  fullName: z.string(),
  email: z.string(),
});
export type CandidateGetMeOutput = z.infer<typeof candidateGetMeOutputSchema>;

// ─────────────── candidateListMyApplications ───────────────

export const candidateApplicationRowSchema = z.object({
  applicationId: z.string().uuid(),
  requisitionId: z.string().uuid(),
  positionTitle: z.string(),
  location: z.string().nullable(),
  currentStage: applicationStageSchema,
  // The ordered stepper vocabulary (same for every application) so the UI
  // renders one consistent stepper; currentStage marks where they are.
  stageSteps: z.array(z.string()),
  appliedAt: z.string(),
});
export type CandidateApplicationRow = z.infer<typeof candidateApplicationRowSchema>;

export const candidateListMyApplicationsOutputSchema = z.object({
  items: z.array(candidateApplicationRowSchema),
});
export type CandidateListMyApplicationsOutput = z.infer<
  typeof candidateListMyApplicationsOutputSchema
>;

// ─────────────── candidateListMyInterviews ───────────────

export const candidateInterviewRowSchema = z.object({
  interviewId: z.string().uuid(),
  positionTitle: z.string(),
  roundName: z.string(),
  status: interviewStatusSchema,
  mode: interviewModeSchema,
  scheduledStart: z.string().nullable(),
  durationMinutes: z.number().int(),
  meetingUrl: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  // Derived: scheduledStart in the future and not cancelled/completed.
  isUpcoming: z.boolean(),
  // HRHEAD-03 feedbackSharing: populated ONLY for completed interviews when
  // the tenant's feedbackSharing policy opts in. `sharedSummary` is the
  // panel's strengths roll-up (shareInterviewSummary); `sharedRecommendation`
  // is the roll-up recommendation (shareRecommendation). Numeric scores are
  // NEVER shared — the read does not select the scorecard. Null when the
  // policy is off, the interview isn't completed, or no feedback was submitted.
  sharedSummary: z.string().nullable(),
  sharedRecommendation: z.string().nullable(),
});
export type CandidateInterviewRow = z.infer<typeof candidateInterviewRowSchema>;

export const candidateListMyInterviewsOutputSchema = z.object({
  items: z.array(candidateInterviewRowSchema),
});
export type CandidateListMyInterviewsOutput = z.infer<typeof candidateListMyInterviewsOutputSchema>;

// ─────────────── candidateConfirmInterview ───────────────

export const candidateConfirmInterviewInputSchema = z.object({
  interviewId: z.string().uuid(),
});
export type CandidateConfirmInterviewInput = z.infer<typeof candidateConfirmInterviewInputSchema>;

export const candidateConfirmInterviewOutputSchema = z.object({
  ok: z.literal(true),
  interviewId: z.string().uuid(),
  confirmedAt: z.string(),
});
export type CandidateConfirmInterviewOutput = z.infer<typeof candidateConfirmInterviewOutputSchema>;

// ═══════════════════ CAND-02 — candidate documents + in-portal offer ═══════════════════

// ─────────────── candidateGetMyOffer ───────────────

/**
 * The candidate's in-portal offer view. Discloses NO MORE than the public
 * signed-link offer page (routes/offers.ts `GET /preview/:token`): company,
 * position, compensation (integer paise), joining date, location, expiry,
 * terms, status. Paise are numbers (mirrors the preview's Number() coercion).
 */
export const candidateOfferSchema = z.object({
  offerId: z.string().uuid(),
  applicationId: z.string().uuid(),
  // extended | accepted (the only statuses surfaced to the candidate).
  status: z.string(),
  companyName: z.string(),
  positionTitle: z.string(),
  baseSalaryInrPaise: z.number().int(),
  variableTargetInrPaise: z.number().int().nullable(),
  joiningBonusInrPaise: z.number().int().nullable(),
  joiningDate: z.string(),
  location: z.string(),
  expiryAt: z.string(),
  termsHtml: z.string().nullable(),
  // C10 — real offer-terms enrichment (fields already on the offers row from
  // the recruiter era). Optional/nullable: older offers may not carry them, and
  // the candidate view only renders a term when it is present. `benefits` is a
  // list of curated benefit KEYS (see comp.ts BENEFIT_META for labels).
  contractType: z.string().nullable(),
  probationMonths: z.number().int().nullable(),
  benefits: z.array(z.string()),
});
export type CandidateOffer = z.infer<typeof candidateOfferSchema>;

export const candidateGetMyOfferOutputSchema = z.object({
  offer: candidateOfferSchema.nullable(),
});
export type CandidateGetMyOfferOutput = z.infer<typeof candidateGetMyOfferOutputSchema>;

// ─────────────── candidateAcceptOffer ───────────────

export const candidateAcceptOfferInputSchema = z.object({
  offerId: z.string().uuid(),
});
export type CandidateAcceptOfferInput = z.infer<typeof candidateAcceptOfferInputSchema>;

export const candidateAcceptOfferOutputSchema = z.object({
  ok: z.literal(true),
  offerId: z.string().uuid(),
  applicationId: z.string().uuid(),
  status: z.literal("accepted"),
});
export type CandidateAcceptOfferOutput = z.infer<typeof candidateAcceptOfferOutputSchema>;

// ─────────────── candidateGetMyOnboarding ───────────────

/**
 * One row per document-collection slot: the document type, the checklist
 * task's status, and the current uploaded document (single-current per type)
 * with its recruiter verification status + any rejection reason. `document` is
 * null before the candidate uploads anything for the type.
 */
export const candidateDocumentSlotSchema = z.object({
  documentTypeId: z.string().uuid(),
  documentTypeName: z.string().nullable(),
  taskStatus: z.string(),
  document: z
    .object({
      documentId: z.string().uuid(),
      // pending | verified | rejected.
      verificationStatus: z.string(),
      fileName: z.string().nullable(),
      rejectionReason: z.string().nullable(),
      uploadedAt: z.string().nullable(),
    })
    .nullable(),
});
export type CandidateDocumentSlot = z.infer<typeof candidateDocumentSlotSchema>;

export const candidateOnboardingCaseSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  positionTitle: z.string().nullable(),
  expectedStartDate: z.string().nullable(),
});
export type CandidateOnboardingCase = z.infer<typeof candidateOnboardingCaseSchema>;

/**
 * The candidate's onboarding surface. `case` is null before an offer is
 * accepted (no case exists yet — the quiet empty state); `documents` is the
 * document-collection checklist for the case.
 */
export const candidateGetMyOnboardingOutputSchema = z.object({
  case: candidateOnboardingCaseSchema.nullable(),
  documents: z.array(candidateDocumentSlotSchema),
});
export type CandidateGetMyOnboardingOutput = z.infer<typeof candidateGetMyOnboardingOutputSchema>;

// ─────────── DASH-01 — persona landing dashboards ───────────

/**
 * `tone` mirrors the StatTile tones the internal portal already ships
 * (packages ui/StatTile) so a KPI's tint is data-driven from the server.
 * `urgency` colours a recommended-action row: normal (calm), attention
 * (worth doing soon), urgent (overdue / blocking).
 */
export const dashboardToneSchema = z.enum([
  "neutral",
  "accent",
  "positive",
  "warning",
  "error",
  "info",
]);
export type DashboardTone = z.infer<typeof dashboardToneSchema>;

export const dashboardUrgencySchema = z.enum(["normal", "attention", "urgent"]);
export type DashboardUrgency = z.infer<typeof dashboardUrgencySchema>;

/** One KPI tile. `value` is pre-formatted server-side (a count, or a string
 * like "$0.42"); `href` deep-links the whole tile to an existing surface. */
export const dashboardKpiSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.union([z.number(), z.string()]),
  hint: z.string().nullable(),
  tone: dashboardToneSchema,
  href: z.string(),
});
export type DashboardKpi = z.infer<typeof dashboardKpiSchema>;

/** One recommended-action row — a single thing the persona should do next,
 * deep-linked to the surface that does it. */
export const dashboardActionSchema = z.object({
  key: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  href: z.string(),
  urgency: dashboardUrgencySchema,
});
export type DashboardAction = z.infer<typeof dashboardActionSchema>;

/** One recent-activity row (optional strip — cut first under time pressure). */
export const dashboardActivitySchema = z.object({
  key: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  href: z.string().nullable(),
  at: z.string(),
});
export type DashboardActivity = z.infer<typeof dashboardActivitySchema>;

/**
 * getMyDashboard — one aggregate read per internal persona. The server
 * switches on the caller's roles and returns the KPI + recommended-action
 * payload for that persona (admin = condensed superset). `variants` names the
 * persona sections that were composed, so multi-role internal users get a
 * merged view and tests can assert recruiter ≠ hr_head.
 */
export const getMyDashboardOutputSchema = z.object({
  variants: z.array(z.string()),
  kpis: z.array(dashboardKpiSchema),
  actions: z.array(dashboardActionSchema),
  activity: z.array(dashboardActivitySchema).optional(),
});
export type GetMyDashboardOutput = z.infer<typeof getMyDashboardOutputSchema>;

// ═══════════════ HRHEAD-01: HR-head dashboard extras ═══════════════
//
// A bespoke, richer read for the HR-head landing surface — separate from
// getMyDashboard because its shapes (a hero KPI with a period-over-period
// delta, a labelled stage funnel with a bottleneck callout, a decide-inline
// approvals list, a risk/compliance panel) don't fit getMyDashboard's flat
// {kpis, actions} contract. getMyDashboard's hr_head payload stays as-is and
// feeds the "Tasks due today" strip; DASH-01 is untouched.

/** Direction of a KPI delta arrow. `flat` renders no arrow. */
export const hrHeadKpiDeltaDirectionSchema = z.enum(["up", "down", "flat"]);
export type HrHeadKpiDeltaDirection = z.infer<typeof hrHeadKpiDeltaDirectionSchema>;

/** Semantic read of the delta — decoupled from direction (a falling
 *  time-to-hire is `good` and points `down`; a rising queue is `bad` up). */
export const hrHeadKpiDeltaToneSchema = z.enum(["good", "bad", "neutral"]);
export type HrHeadKpiDeltaTone = z.infer<typeof hrHeadKpiDeltaToneSchema>;

export const hrHeadKpiDeltaSchema = z.object({
  /** Pre-formatted magnitude, e.g. "1.2d faster" or "+3". */
  label: z.string(),
  direction: hrHeadKpiDeltaDirectionSchema,
  tone: hrHeadKpiDeltaToneSchema,
  /** The comparison window caption, e.g. "vs prior 90 days". */
  caption: z.string(),
});
export type HrHeadKpiDelta = z.infer<typeof hrHeadKpiDeltaSchema>;

/** One HR-head KPI. `value` is pre-formatted server-side. `hero` marks the
 *  single accent-filled card; the rest render white. */
export const hrHeadKpiSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  caption: z.string().nullable(),
  delta: hrHeadKpiDeltaSchema.nullable(),
  hero: z.boolean(),
  href: z.string(),
});
export type HrHeadKpi = z.infer<typeof hrHeadKpiSchema>;

/** One labelled funnel stage — count sits IN the bar; `pct` sizes the bar
 *  relative to the busiest stage. */
export const hrHeadFunnelStageSchema = z.object({
  stage: z.string(),
  label: z.string(),
  count: z.number().int(),
  pct: z.number(),
});
export type HrHeadFunnelStage = z.infer<typeof hrHeadFunnelStageSchema>;

export const hrHeadFunnelSchema = z.object({
  stages: z.array(hrHeadFunnelStageSchema),
  /** Bottleneck callout line, e.g. "Bottleneck at Tech Interview — 62% drop-off". Null if no meaningful drop. */
  bottleneck: z.string().nullable(),
});
export type HrHeadFunnel = z.infer<typeof hrHeadFunnelSchema>;

/** One pending approval, decidable inline via the ActionTriad. Reuses the
 *  same enrichment (dept, budget band, requester, priority, age) as the
 *  approvals-page rows. */
export const hrHeadApprovalItemSchema = z.object({
  approvalRequestId: z.string().uuid(),
  requisitionId: z.string().uuid(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  budgetBand: z.string().nullable(),
  requestedByName: z.string().nullable(),
  priority: requisitionApprovalPrioritySchema,
  ageDays: z.number().int(),
  biasFlags: z.array(requisitionApprovalBiasFlagSchema),
});
export type HrHeadApprovalItem = z.infer<typeof hrHeadApprovalItemSchema>;

/** Right-rail risk & compliance panel. `belowBenchmark` is null until the
 *  HRHEAD-02 benchmark table exists (defensive — the row renders only when
 *  the data is present). */
export const hrHeadRiskSchema = z.object({
  biasGateEnforcement: z.enum(["off", "warn", "block"]),
  staleApprovals: z.number().int(),
  belowBenchmark: z.number().int().nullable(),
});
export type HrHeadRisk = z.infer<typeof hrHeadRiskSchema>;

export const getHrHeadDashboardExtrasOutputSchema = z.object({
  kpis: z.array(hrHeadKpiSchema),
  funnel: hrHeadFunnelSchema,
  approvals: z.array(hrHeadApprovalItemSchema),
  risk: hrHeadRiskSchema,
});
export type GetHrHeadDashboardExtrasOutput = z.infer<typeof getHrHeadDashboardExtrasOutputSchema>;

/**
 * partnerGetDashboardStats — the partner-portal analogue: the org's own
 * submissions bucketed by live pipeline stage. Kept separate from the internal
 * read because the partner tier resolves a different context (partnerProcedure)
 * and sees only its org's claims.
 */
export const partnerStageCountSchema = z.object({
  stage: z.string(),
  label: z.string(),
  count: z.number().int(),
});
export type PartnerStageCount = z.infer<typeof partnerStageCountSchema>;

export const partnerGetDashboardStatsOutputSchema = z.object({
  totalSubmissions: z.number().int(),
  activeSubmissions: z.number().int(),
  placed: z.number().int(),
  byStage: z.array(partnerStageCountSchema),
});
export type PartnerGetDashboardStatsOutput = z.infer<typeof partnerGetDashboardStatsOutputSchema>;

// ═══════════════════════════════════════════════════════════════════════
// HROPS-01 — HR Ops cases workspace + HR round
// ═══════════════════════════════════════════════════════════════════════

/**
 * The HR-Ops "case window" — an application is an HR case while it sits in one
 * of these stages (post-technical-rounds, offer-desk territory). Mirrors the
 * canonical application_stage enum values; a subset, not a new vocabulary.
 */
export const hrCaseStageSchema = z.enum([
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
]);
export type HrCaseStage = z.infer<typeof hrCaseStageSchema>;

/** The HR-round assessment recommendation — the deterministic advance gate. */
export const hrRoundRecommendationSchema = z.enum(["proceed", "hold", "reject"]);
export type HrRoundRecommendation = z.infer<typeof hrRoundRecommendationSchema>;

/**
 * One interview round's result as an HR-facing chip — round title + the
 * submitted recommendation only (NO scores; anti-anchoring convention, same
 * rule the panel brief uses across rounds). `recommendation` is null when the
 * round has no submitted feedback yet.
 */
export const hrRoundResultSchema = z.object({
  interviewId: z.string().uuid(),
  roundNumber: z.number().int(),
  roundName: z.string(),
  scorecardTemplate: z.string().nullable(),
  status: z.string(),
  recommendation: interviewRecommendationSchema.nullable(),
});
export type HrRoundResult = z.infer<typeof hrRoundResultSchema>;

// ─────────── listHrCases ───────────

export const hrCaseListRowSchema = z.object({
  applicationId: z.string().uuid(),
  candidateId: z.string().uuid(),
  candidateName: z.string().nullable(),
  roleTitle: z.string().nullable(),
  stage: hrCaseStageSchema,
  aiScore: z.number().nullable(),
  roundResults: z.array(hrRoundResultSchema),
  salaryBand: z.string().nullable(),
  assignedRecruiterName: z.string().nullable(),
  lastActivityAt: z.string(),
  // hr_round stage AND no saved assessment yet — the "HR round pending" bucket.
  hrRoundPending: z.boolean(),
  hasAssessment: z.boolean(),
  assessmentRecommendation: hrRoundRecommendationSchema.nullable(),
  assessmentRating: z.number().int().nullable(),
});
export type HrCaseListRow = z.infer<typeof hrCaseListRowSchema>;

export const hrCaseStatsSchema = z.object({
  total: z.number().int(),
  hrRoundPending: z.number().int(),
  offerStage: z.number().int(),
  accepted: z.number().int(),
});
export type HrCaseStats = z.infer<typeof hrCaseStatsSchema>;

export const listHrCasesInputSchema = z.object({
  search: z.string().max(200).optional(),
  stage: hrCaseStageSchema.optional(),
});
export const listHrCasesOutputSchema = z.object({
  rows: z.array(hrCaseListRowSchema),
  stats: hrCaseStatsSchema,
});
export type ListHrCasesInput = z.infer<typeof listHrCasesInputSchema>;
export type ListHrCasesOutput = z.infer<typeof listHrCasesOutputSchema>;

// ─────────── the assessment record ───────────

export const hrRoundAssessmentSchema = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  motivationDiscussed: z.boolean(),
  salaryExpectationDiscussed: z.boolean(),
  cultureFitAssessed: z.boolean(),
  workAuthorizationVerified: z.boolean(),
  noticePeriodConfirmed: z.boolean(),
  relocationWillingness: z.boolean(),
  notes: z.string().nullable(),
  rating: z.number().int(),
  recommendation: hrRoundRecommendationSchema,
  completedByMembershipId: z.string().uuid().nullable(),
  completedByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HrRoundAssessment = z.infer<typeof hrRoundAssessmentSchema>;

// ─────────── getHrCaseDetail ───────────

/** Prior-round feedback card — recommendation + qualitative summary, NO scores. */
export const hrCaseFeedbackCardSchema = z.object({
  interviewId: z.string().uuid(),
  roundNumber: z.number().int(),
  roundName: z.string(),
  panelistName: z.string().nullable(),
  recommendation: interviewRecommendationSchema.nullable(),
  strengths: z.string().nullable(),
  concerns: z.string().nullable(),
  notes: z.string().nullable(),
  submittedAt: z.string().nullable(),
});
export type HrCaseFeedbackCard = z.infer<typeof hrCaseFeedbackCardSchema>;

export const hrCaseCandidateSchema = z.object({
  candidateId: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  locationCity: z.string().nullable(),
  locationCountry: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  yearsOfExperience: z.number().nullable(),
  parsedSkills: z.array(z.string()),
});
export type HrCaseCandidate = z.infer<typeof hrCaseCandidateSchema>;

export const hrCasePipelineSchema = z.object({
  stage: hrCaseStageSchema,
  aiScore: z.number().nullable(),
  roleTitle: z.string().nullable(),
  department: z.string().nullable(),
  salaryBand: z.string().nullable(),
  assignedRecruiterName: z.string().nullable(),
  roundResults: z.array(hrRoundResultSchema),
  stageEnteredAt: z.string(),
});
export type HrCasePipeline = z.infer<typeof hrCasePipelineSchema>;

export const getHrCaseDetailInputSchema = z.object({
  applicationId: z.string().uuid(),
});
export const getHrCaseDetailOutputSchema = z.object({
  candidate: hrCaseCandidateSchema,
  pipeline: hrCasePipelineSchema,
  interviewFeedback: z.array(hrCaseFeedbackCardSchema),
  assessment: hrRoundAssessmentSchema.nullable(),
  // Whether a saved proceed-assessment is required before the offer-stage
  // advance is allowed (true while the case sits at hr_round).
  advanceRequiresAssessment: z.boolean(),
});
export type GetHrCaseDetailOutput = z.infer<typeof getHrCaseDetailOutputSchema>;

// ─────────── saveHrRoundAssessment ───────────

export const saveHrRoundAssessmentInputSchema = z.object({
  applicationId: z.string().uuid(),
  motivationDiscussed: z.boolean(),
  salaryExpectationDiscussed: z.boolean(),
  cultureFitAssessed: z.boolean(),
  workAuthorizationVerified: z.boolean(),
  noticePeriodConfirmed: z.boolean(),
  relocationWillingness: z.boolean(),
  notes: z.string().max(4000).nullish(),
  rating: z.number().int().min(1).max(5),
  recommendation: hrRoundRecommendationSchema,
});
export const saveHrRoundAssessmentOutputSchema = z.object({
  assessment: hrRoundAssessmentSchema,
});
export type SaveHrRoundAssessmentInput = z.infer<typeof saveHrRoundAssessmentInputSchema>;
export type SaveHrRoundAssessmentOutput = z.infer<typeof saveHrRoundAssessmentOutputSchema>;

// ─────────── listHrRounds ───────────

/** The HR-round scheduler view — one row per HR-round interview (scorecard
 *  template 'hr'), plus HR-stage cases with no HR interview yet (Pending). */
export const hrRoundRowSchema = z.object({
  // interviewId is null for a "pending" row (hr_round case, no HR interview).
  interviewId: z.string().uuid().nullable(),
  applicationId: z.string().uuid(),
  candidateName: z.string().nullable(),
  roleTitle: z.string().nullable(),
  scheduledStart: z.string().nullable(),
  mode: z.string().nullable(),
  ownerName: z.string().nullable(),
  // scheduled | completed | cancelled | no_show | pending (synthetic)
  status: z.string(),
  rating: z.number().int().nullable(),
  hasAssessment: z.boolean(),
  assessmentRecommendation: hrRoundRecommendationSchema.nullable(),
});
export type HrRoundRow = z.infer<typeof hrRoundRowSchema>;

export const hrRoundStatsSchema = z.object({
  total: z.number().int(),
  scheduled: z.number().int(),
  completed: z.number().int(),
  pending: z.number().int(),
});
export type HrRoundStats = z.infer<typeof hrRoundStatsSchema>;

export const listHrRoundsInputSchema = z.object({}).optional();
export const listHrRoundsOutputSchema = z.object({
  rows: z.array(hrRoundRowSchema),
  stats: hrRoundStatsSchema,
});
export type ListHrRoundsOutput = z.infer<typeof listHrRoundsOutputSchema>;

// ═══════════════════════ HROPS-03 — documents & verification, ═══════════════════════
// ═══════════════════════ case audit trail, templates & policies ═════════════════════

/**
 * application_documents lifecycle (HROPS-03): pre-offer document verification.
 * requested (hr_ops asked for it, no blob yet) → uploaded (candidate uploaded)
 * → verified | rejected (hr_ops decision; rejected returns to uploaded on a
 * re-upload). Mirrors the DB CHECK constraint.
 */
export const applicationDocumentStatusSchema = z.enum([
  "requested",
  "uploaded",
  "verified",
  "rejected",
]);
export type ApplicationDocumentStatus = z.infer<typeof applicationDocumentStatusSchema>;

/**
 * Overall per-candidate document rollup. none = no docs requested; all_verified
 * = every requested doc verified; rejected = at least one rejected; partial =
 * some uploaded/verified but not all verified.
 */
export const applicationDocumentOverallSchema = z.enum([
  "none",
  "partial",
  "all_verified",
  "rejected",
]);
export type ApplicationDocumentOverall = z.infer<typeof applicationDocumentOverallSchema>;

/** One requested/uploaded document for an application. */
export const applicationDocumentRowSchema = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  documentTypeId: z.string().uuid(),
  documentTypeName: z.string().nullable(),
  status: applicationDocumentStatusSchema,
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  requestedAt: z.string(),
  uploadedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  verifierName: z.string().nullable(),
});
export type ApplicationDocumentRow = z.infer<typeof applicationDocumentRowSchema>;

/** One candidate row on /hr-documents — application + its requested docs. */
export const applicationDocumentCandidateRowSchema = z.object({
  applicationId: z.string().uuid(),
  candidateId: z.string().uuid(),
  candidateName: z.string().nullable(),
  roleTitle: z.string().nullable(),
  stage: applicationStageSchema,
  documents: z.array(applicationDocumentRowSchema),
  overall: applicationDocumentOverallSchema,
});
export type ApplicationDocumentCandidateRow = z.infer<typeof applicationDocumentCandidateRowSchema>;

export const listApplicationDocumentCandidatesInputSchema = z.object({
  search: z.string().max(200).optional(),
  status: applicationDocumentStatusSchema.optional(),
  limit: z.number().int().positive().max(200).default(100),
});
export const listApplicationDocumentCandidatesOutputSchema = z.object({
  items: z.array(applicationDocumentCandidateRowSchema),
  stats: z.object({
    candidates: z.number().int(),
    verifiedDocs: z.number().int(),
    pendingDocs: z.number().int(),
    totalDocs: z.number().int(),
  }),
});
export type ListApplicationDocumentCandidatesInput = z.infer<
  typeof listApplicationDocumentCandidatesInputSchema
>;
export type ListApplicationDocumentCandidatesOutput = z.infer<
  typeof listApplicationDocumentCandidatesOutputSchema
>;

/** Requestable document types (from the tenant-agnostic document_types table). */
export const requestableDocumentTypeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  geographyCode: z.string().nullable(),
});
export type RequestableDocumentType = z.infer<typeof requestableDocumentTypeSchema>;
export const listRequestableDocumentTypesOutputSchema = z.object({
  items: z.array(requestableDocumentTypeSchema),
});
export type ListRequestableDocumentTypesOutput = z.infer<
  typeof listRequestableDocumentTypesOutputSchema
>;

export const requestApplicationDocumentsInputSchema = z.object({
  applicationId: z.string().uuid(),
  documentTypeIds: z.array(z.string().uuid()).min(1).max(20),
});
export const requestApplicationDocumentsOutputSchema = z.object({
  applicationId: z.string().uuid(),
  requested: z.number().int(),
  skipped: z.number().int(),
});
export type RequestApplicationDocumentsInput = z.infer<
  typeof requestApplicationDocumentsInputSchema
>;
export type RequestApplicationDocumentsOutput = z.infer<
  typeof requestApplicationDocumentsOutputSchema
>;

export const verifyApplicationDocumentInputSchema = z.object({
  documentId: z.string().uuid(),
});
export const verifyApplicationDocumentOutputSchema = z.object({
  documentId: z.string().uuid(),
  status: applicationDocumentStatusSchema,
});
export type VerifyApplicationDocumentInput = z.infer<typeof verifyApplicationDocumentInputSchema>;
export type VerifyApplicationDocumentOutput = z.infer<typeof verifyApplicationDocumentOutputSchema>;

export const rejectApplicationDocumentInputSchema = z.object({
  documentId: z.string().uuid(),
  rejectionReason: z.string().min(1).max(1000),
});
export const rejectApplicationDocumentOutputSchema = z.object({
  documentId: z.string().uuid(),
  status: applicationDocumentStatusSchema,
  rejectionReason: z.string().nullable(),
});
export type RejectApplicationDocumentInput = z.infer<typeof rejectApplicationDocumentInputSchema>;
export type RejectApplicationDocumentOutput = z.infer<typeof rejectApplicationDocumentOutputSchema>;

// ─────────── candidate side: pre-offer documents ───────────

/** A candidate's view of one requested pre-offer document. */
export const candidateApplicationDocumentSlotSchema = z.object({
  documentId: z.string().uuid(),
  documentTypeId: z.string().uuid(),
  documentTypeName: z.string().nullable(),
  status: applicationDocumentStatusSchema,
  fileName: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  uploadedAt: z.string().nullable(),
});
export type CandidateApplicationDocumentSlot = z.infer<
  typeof candidateApplicationDocumentSlotSchema
>;
export const candidateApplicationDocumentGroupSchema = z.object({
  applicationId: z.string().uuid(),
  roleTitle: z.string().nullable(),
  documents: z.array(candidateApplicationDocumentSlotSchema),
});
export type CandidateApplicationDocumentGroup = z.infer<
  typeof candidateApplicationDocumentGroupSchema
>;
export const candidateListMyApplicationDocumentsOutputSchema = z.object({
  groups: z.array(candidateApplicationDocumentGroupSchema),
});
export type CandidateListMyApplicationDocumentsOutput = z.infer<
  typeof candidateListMyApplicationDocumentsOutputSchema
>;

export const candidateAttachApplicationDocumentInputSchema = z.object({
  documentId: z.string().uuid(),
  storageKey: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
});
export const candidateAttachApplicationDocumentOutputSchema = z.object({
  documentId: z.string().uuid(),
  status: applicationDocumentStatusSchema,
});
export type CandidateAttachApplicationDocumentInput = z.infer<
  typeof candidateAttachApplicationDocumentInputSchema
>;
export type CandidateAttachApplicationDocumentOutput = z.infer<
  typeof candidateAttachApplicationDocumentOutputSchema
>;

// ═══════════════════ CAND-02 — candidate self-service profile ═══════════════════

// ─────────────── candidateGetProfile ───────────────

/**
 * The candidate's own editable profile (person + candidate scoped). Read of
 * the exact columns the Profile page edits — nothing internal (no AI score, no
 * scorecard). `email` and `fullName` are read-only on the page (identity, not
 * self-editable here). Salary is INR paise; `expectedSalaryInrPaise` reflects
 * the most-recent application's captured expectation (null when none set).
 */
export const candidateProfileSchema = z.object({
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  locationCity: z.string().nullable(),
  // ISO-3166-1 alpha-2 (matches persons.location_country), or null.
  locationCountry: z.string().nullable(),
  experienceSummary: z.string().nullable(),
  educationSummary: z.string().nullable(),
  skills: z.array(z.string()),
  noticePeriodDays: z.number().int().nonnegative().nullable(),
  expectedSalaryInrPaise: z.number().int().nonnegative().nullable(),
});
export type CandidateProfile = z.infer<typeof candidateProfileSchema>;

export const candidateGetProfileOutputSchema = z.object({
  profile: candidateProfileSchema,
});
export type CandidateGetProfileOutput = z.infer<typeof candidateGetProfileOutputSchema>;

// ─────────────── candidateUpdateProfile ───────────────

/**
 * The candidate's own profile edit. Every field OPTIONAL — the client sends
 * only what changed. Persistence targets the canonical sources (honest loop
 * closure with the recruiter Missing-Info tracker):
 *   phone/location → persons; skills/noticePeriodDays → candidates.parsed_skills;
 *   experience/education → candidates.*_summary;
 *   expectedSalaryInrPaise → the caller's LIVE (non-terminal) applications.
 * `null` explicitly clears a field; omitted leaves it unchanged.
 */
export const candidateUpdateProfileInputSchema = z
  .object({
    phone: z.string().trim().max(40).nullable().optional(),
    locationCity: z.string().trim().max(120).nullable().optional(),
    locationCountry: z
      .string()
      .trim()
      .length(2)
      .regex(/^[A-Za-z]{2}$/, "location must be a 2-letter country code")
      .nullable()
      .optional(),
    experienceSummary: z.string().trim().max(4000).nullable().optional(),
    educationSummary: z.string().trim().max(1000).nullable().optional(),
    skills: z.array(z.string().trim().min(1).max(80)).max(60).optional(),
    noticePeriodDays: z.number().int().min(0).max(365).nullable().optional(),
    expectedSalaryInrPaise: z.number().int().min(0).max(1_000_000_000_00).nullable().optional(),
  })
  .strict();
export type CandidateUpdateProfileInput = z.infer<typeof candidateUpdateProfileInputSchema>;

/** Echoes the freshly-persisted profile so the client re-syncs without a refetch. */
export const candidateUpdateProfileOutputSchema = z.object({
  ok: z.literal(true),
  profile: candidateProfileSchema,
});
export type CandidateUpdateProfileOutput = z.infer<typeof candidateUpdateProfileOutputSchema>;

// ─────────────── candidateListMyNotifications ───────────────

/**
 * One candidate-directed notification, projected from a REAL notification_outbox
 * row (recipient_type = 'candidate', scoped to the caller). `category` drives
 * the icon/tint deterministically (interview / application / offer / document /
 * account / general); `title` is a human label mapped from the template key;
 * `body` is the row's real subject line (or a mapped fallback). Nothing is
 * fabricated — an empty feed renders an empty state.
 */
export const candidateNotificationCategorySchema = z.enum([
  "interview",
  "application",
  "offer",
  "document",
  "account",
  "general",
]);
export type CandidateNotificationCategory = z.infer<typeof candidateNotificationCategorySchema>;

export const candidateNotificationRowSchema = z.object({
  id: z.string().uuid(),
  category: candidateNotificationCategorySchema,
  title: z.string(),
  body: z.string().nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});
export type CandidateNotificationRow = z.infer<typeof candidateNotificationRowSchema>;

export const candidateListMyNotificationsOutputSchema = z.object({
  items: z.array(candidateNotificationRowSchema),
  unreadCount: z.number().int().nonnegative(),
});
export type CandidateListMyNotificationsOutput = z.infer<
  typeof candidateListMyNotificationsOutputSchema
>;

// ─────────────── candidateMarkNotificationsRead ───────────────

/** Mark all (or a specific set of) the caller's unread notifications read. */
export const candidateMarkNotificationsReadInputSchema = z
  .object({
    // Omitted / empty → mark ALL of the caller's unread rows read.
    ids: z.array(z.string().uuid()).max(500).optional(),
  })
  .strict();
export type CandidateMarkNotificationsReadInput = z.infer<
  typeof candidateMarkNotificationsReadInputSchema
>;

export const candidateMarkNotificationsReadOutputSchema = z.object({
  ok: z.literal(true),
  markedCount: z.number().int().nonnegative(),
});
export type CandidateMarkNotificationsReadOutput = z.infer<
  typeof candidateMarkNotificationsReadOutputSchema
>;

// ─────────── case audit trail (/case-audit) ───────────

/**
 * One case-audit timeline event, projected from an audit_logs row. `kind`
 * classifies the event for styling (stage / offer / document / note / other);
 * `isNote` flags the hr_case_notes rows the surface renders distinctly.
 */
export const caseAuditEventSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["stage", "offer", "document", "note", "other"]),
  title: z.string(),
  description: z.string().nullable(),
  actorName: z.string().nullable(),
  isNote: z.boolean(),
  timestamp: z.string(),
});
export type CaseAuditEvent = z.infer<typeof caseAuditEventSchema>;

export const caseAuditCaseRowSchema = z.object({
  applicationId: z.string().uuid(),
  caseRef: z.string(),
  candidateName: z.string().nullable(),
  roleTitle: z.string().nullable(),
  stage: applicationStageSchema,
  eventCount: z.number().int(),
  lastActivityAt: z.string().nullable(),
});
export type CaseAuditCaseRow = z.infer<typeof caseAuditCaseRowSchema>;

export const listCaseAuditCasesInputSchema = z.object({
  search: z.string().max(200).optional(),
  limit: z.number().int().positive().max(200).default(100),
});
export const listCaseAuditCasesOutputSchema = z.object({
  items: z.array(caseAuditCaseRowSchema),
  stats: z.object({
    cases: z.number().int(),
    events: z.number().int(),
    notes: z.number().int(),
  }),
});
export type ListCaseAuditCasesInput = z.infer<typeof listCaseAuditCasesInputSchema>;
export type ListCaseAuditCasesOutput = z.infer<typeof listCaseAuditCasesOutputSchema>;

export const getCaseAuditTimelineInputSchema = z.object({
  applicationId: z.string().uuid(),
});
export const getCaseAuditTimelineOutputSchema = z.object({
  applicationId: z.string().uuid(),
  candidateName: z.string().nullable(),
  roleTitle: z.string().nullable(),
  stage: applicationStageSchema,
  events: z.array(caseAuditEventSchema),
});
export type GetCaseAuditTimelineInput = z.infer<typeof getCaseAuditTimelineInputSchema>;
export type GetCaseAuditTimelineOutput = z.infer<typeof getCaseAuditTimelineOutputSchema>;

export const addCaseAuditNoteInputSchema = z.object({
  applicationId: z.string().uuid(),
  note: z.string().min(1).max(2000),
});
export const addCaseAuditNoteOutputSchema = z.object({
  noteId: z.string().uuid(),
  createdAt: z.string(),
});
export type AddCaseAuditNoteInput = z.infer<typeof addCaseAuditNoteInputSchema>;
export type AddCaseAuditNoteOutput = z.infer<typeof addCaseAuditNoteOutputSchema>;

// ─────────── templates & policies (/hr-policies) ───────────

export const hrPolicyCategorySchema = z.enum(["offers", "benefits", "policies"]);
export type HrPolicyCategory = z.infer<typeof hrPolicyCategorySchema>;

export const hrPolicyDocumentRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  category: hrPolicyCategorySchema,
  summary: z.string(),
  bodyMd: z.string(),
  updatedAt: z.string(),
});
export type HrPolicyDocumentRow = z.infer<typeof hrPolicyDocumentRowSchema>;

export const listHrPoliciesOutputSchema = z.object({
  items: z.array(hrPolicyDocumentRowSchema),
});
export type ListHrPoliciesOutput = z.infer<typeof listHrPoliciesOutputSchema>;

// ═══════════════════════ PANEL-01 — panel-member workboard ═══════════════════════
//
// The panel persona's landing experience + feedback loop. Reuses the INT-03
// interview_feedback machinery (per-criterion scorecard jsonb, recommendation,
// draft→submitted lifecycle) and the interviewRow shape; adds three reads that
// aggregate "my" work honestly (mine only, RLS/tenant scoped): the dashboard
// stat strip + pending/submitted lists (getPanelDashboard), and the
// "Summarise my notes" AI assist (summarizeMyFeedbackNotes). No new tables.

/** The hero stat strip on the panel dashboard. Every number is server-computed
 * from the caller's own interviews + submitted scorecards. `avgScoreGiven` is
 * null when the panellist has submitted no scored criteria yet. `inWindowNow`
 * is honest ("in window", not "live"): a scheduled interview whose
 * [scheduledStart, scheduledEnd] window contains now. */
export const panelDashboardStatsSchema = z.object({
  todayInterviews: z.number().int().nonnegative(),
  pendingFeedback: z.number().int().nonnegative(),
  avgScoreGiven: z.number().nullable(),
  completedToday: z.number().int().nonnegative(),
  inWindowNow: z.number().int().nonnegative(),
});
export type PanelDashboardStats = z.infer<typeof panelDashboardStatsSchema>;

/** One interview awaiting MY scorecard: completed (or past its window) with no
 * submitted feedback of mine. `completedAt` is the window end (fallback start);
 * `overdue` is true when that instant is > 24h ago (drives the nudge). */
export const panelPendingFeedbackItemSchema = z.object({
  interviewId: z.string().uuid(),
  candidateName: z.string().nullable(),
  roleTitle: z.string(),
  roundNumber: z.number().int(),
  roundName: z.string(),
  mode: interviewModeSchema,
  scheduledStart: z.string().nullable(),
  completedAt: z.string().nullable(),
  overdue: z.boolean(),
});
export type PanelPendingFeedbackItem = z.infer<typeof panelPendingFeedbackItemSchema>;

/** One interview whose scorecard I've submitted — for the queue's Submitted
 * section + the history table. `avgScore` is the mean of MY per-criterion
 * scores on that scorecard (null when I recorded none). */
export const panelSubmittedFeedbackItemSchema = z.object({
  interviewId: z.string().uuid(),
  candidateName: z.string().nullable(),
  roleTitle: z.string(),
  roundNumber: z.number().int(),
  roundName: z.string(),
  submittedAt: z.string().nullable(),
  recommendation: interviewRecommendationSchema.nullable(),
  avgScore: z.number().nullable(),
});
export type PanelSubmittedFeedbackItem = z.infer<typeof panelSubmittedFeedbackItemSchema>;

/** getPanelDashboard — one aggregate read powering the panel dashboard (stats +
 * urgent banner + overdue nudge), the /panel/feedback queue, and the
 * /panel/history table. panel_member + admin; RLS + membership scoped to "me". */
export const getPanelDashboardOutputSchema = z.object({
  stats: panelDashboardStatsSchema,
  pending: z.array(panelPendingFeedbackItemSchema),
  submitted: z.array(panelSubmittedFeedbackItemSchema),
});
export type GetPanelDashboardOutput = z.infer<typeof getPanelDashboardOutputSchema>;

/**
 * summarizeMyFeedbackNotes (feature `feedback_summary`) — the "Summarise my
 * notes" AI assist. Sends the panellist's OWN draft text (strengths / concerns
 * / notes) to the tenant's configured model and returns tightened prose INTO
 * the same three editable fields. Nothing is persisted or submitted — the
 * panellist reviews and edits before saving. Kill-switchable + cost-logged.
 * At least one of the three fields must carry text.
 */
export const summarizeMyFeedbackNotesInputSchema = z
  .object({
    interviewId: z.string().uuid(),
    strengths: z.string().max(4000).nullish(),
    concerns: z.string().max(4000).nullish(),
    notes: z.string().max(4000).nullish(),
  })
  .refine((v) => Boolean(v.strengths?.trim() || v.concerns?.trim() || v.notes?.trim()), {
    message: "Write some notes first — there is nothing to summarise yet.",
  });
export const feedbackSummarySchema = z.object({
  strengths: z.string(),
  concerns: z.string(),
  notes: z.string(),
});
export type FeedbackSummary = z.infer<typeof feedbackSummarySchema>;
export const summarizeMyFeedbackNotesOutputSchema = z.object({
  summary: feedbackSummarySchema,
});
export type SummarizeMyFeedbackNotesInput = z.infer<typeof summarizeMyFeedbackNotesInputSchema>;
export type SummarizeMyFeedbackNotesOutput = z.infer<typeof summarizeMyFeedbackNotesOutputSchema>;

// ─────────────────────────── RO-03 — JD library, panel setup, insights ───────────────────────────
//
// The hiring-manager persona surfaces. Everything is scoped to MY requisitions
// (requisitions.hiring_manager_id = the caller's membership) — except admin,
// the super-role, which sees every requisition in the tenant. Real data only:
// keyword chips derive from jd_skills / aiMetadata keywords, JD status from the
// jd_versions.status vocabulary (draft | approved | archived), analytics from
// live pipeline / scorecards / curated benchmarks. No demographic anything, no
// psychometric radar, no offer-acceptance probability, no AI-recommendation
// block — those are deliberate refusals documented in the ticket charter.

// --- /jd-library ---

export const listJdLibraryInputSchema = z.object({
  limit: z.number().int().min(1).max(200).default(100),
});
export const jdLibraryRowSchema = z.object({
  requisitionId: z.string().uuid(),
  positionId: z.string().uuid(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  reqStatus: z.string(),
  // jd_versions.status vocabulary — draft | approved | archived.
  jdStatus: z.string(),
  keywords: z.array(z.string()),
  createdAt: z.string(),
});
export type JdLibraryRow = z.infer<typeof jdLibraryRowSchema>;
export const listJdLibraryOutputSchema = z.object({
  rows: z.array(jdLibraryRowSchema),
});
export type ListJdLibraryOutput = z.infer<typeof listJdLibraryOutputSchema>;

export const getJdVersionHistoryInputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export const jdVersionHistoryItemSchema = z.object({
  id: z.string().uuid(),
  versionNumber: z.number().int(),
  status: z.string(),
  summary: z.string().nullable(),
  jdText: z.string(),
  isCurrent: z.boolean(),
  createdAt: z.string(),
});
export type JdVersionHistoryItem = z.infer<typeof jdVersionHistoryItemSchema>;
export const getJdVersionHistoryOutputSchema = z.object({
  requisitionId: z.string().uuid(),
  title: z.string().nullable(),
  versions: z.array(jdVersionHistoryItemSchema),
});
export type GetJdVersionHistoryOutput = z.infer<typeof getJdVersionHistoryOutputSchema>;

// --- /panel-setup ---

export const listPanelSetupRequisitionsInputSchema = z.object({
  limit: z.number().int().min(1).max(200).default(100),
});
export const panelSetupRequisitionRowSchema = z.object({
  requisitionId: z.string().uuid(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  status: z.string(),
  roundCount: z.number().int(),
  totalDurationMinutes: z.number().int(),
  templatesUsed: z.array(z.string()),
});
export type PanelSetupRequisitionRow = z.infer<typeof panelSetupRequisitionRowSchema>;
export const listPanelSetupRequisitionsOutputSchema = z.object({
  rows: z.array(panelSetupRequisitionRowSchema),
});
export type ListPanelSetupRequisitionsOutput = z.infer<
  typeof listPanelSetupRequisitionsOutputSchema
>;

export const getPanelSetupInputSchema = z.object({ requisitionId: z.string().uuid() });
export const panelSetupRoundSchema = z.object({
  roundNumber: z.number().int(),
  roundName: z.string(),
  durationMinutes: z.number().int(),
  mode: interviewModeSchema,
  scorecardTemplate: interviewScorecardTemplateSchema,
  // Read-only default panellists carried by the plan (resolved display names).
  // Actual per-round panel assignment happens at scheduling (/interviews).
  defaultPanelists: z.array(z.string()),
});
export type PanelSetupRound = z.infer<typeof panelSetupRoundSchema>;
export const getPanelSetupOutputSchema = z.object({
  requisitionId: z.string().uuid(),
  title: z.string().nullable(),
  status: z.string(),
  rounds: z.array(panelSetupRoundSchema),
  totalDurationMinutes: z.number().int(),
});
export type GetPanelSetupOutput = z.infer<typeof getPanelSetupOutputSchema>;

// --- /insights ---

export const getRequisitionInsightsInputSchema = z.object({
  // null / omitted → the "all my reqs" rollup; a uuid → single-req analytics.
  requisitionId: z.string().uuid().nullish(),
});
export const insightsReqOptionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
});
export const insightsScoreBucketSchema = z.object({
  key: z.enum(["excellent", "good", "partial", "low"]),
  label: z.string(),
  range: z.string(),
  count: z.number().int(),
});
export const insightsFunnelStageSchema = z.object({
  stage: applicationStageSchema,
  count: z.number().int(),
  // % lost relative to the previous stage's count; null for the first stage
  // and where the previous stage was empty.
  dropOffPct: z.number().nullable(),
});
export const insightsSkillGapSchema = z.object({
  skillName: z.string(),
  isRequired: z.boolean(),
  gapPct: z.number(),
  candidatesMissing: z.number().int(),
  totalCandidates: z.number().int(),
});
export const insightsSalaryBandSchema = z
  .object({
    currency: z.string(),
    budgetMin: z.number().nullable(),
    budgetMax: z.number().nullable(),
    // Curated benchmark (market_benchmarks) — median only exists in the data;
    // there is no synthetic band. Labelled "Curated benchmarks" in the UI.
    benchmarkMedian: z.number().nullable(),
    benchmarkTtfDays: z.number().int().nullable(),
    sourceNote: z.string().nullable(),
  })
  .nullable();
export const insightsSlaTileSchema = z.object({
  stage: applicationStageSchema,
  avgAgeHours: z.number().nullable(),
  targetHours: z.number().nullable(),
  breach: z.boolean(),
  count: z.number().int(),
});
export const insightsPanelTrendSchema = z.object({
  roundNumber: z.number().int(),
  roundName: z.string(),
  avgScore: z.number().nullable(),
  passRate: z.number().nullable(),
  submittedCount: z.number().int(),
});
export const getRequisitionInsightsOutputSchema = z.object({
  scope: z.enum(["single", "all"]),
  selectedRequisitionId: z.string().uuid().nullable(),
  reqOptions: z.array(insightsReqOptionSchema),
  kpis: z.object({
    // Labelled "historical average" in the UI — never a prediction.
    avgTimeToHireDays: z.number().nullable(),
    fillRate: z.object({ hires: z.number().int(), openings: z.number().int() }),
    activeCandidates: z.number().int(),
    offerAcceptRate: z.object({ accepted: z.number().int(), extended: z.number().int() }),
  }),
  funnel: z.array(insightsFunnelStageSchema),
  scoreDistribution: z.array(insightsScoreBucketSchema),
  // Single-req only (empty for the rollup — a gap needs one JD to compare to).
  skillGap: z.array(insightsSkillGapSchema),
  // Single-req only (null for the rollup).
  salaryBand: insightsSalaryBandSchema,
  slaTiles: z.array(insightsSlaTileSchema),
  bottleneckNote: z.string().nullable(),
  panelFeedbackTrends: z.array(insightsPanelTrendSchema),
});
export type GetRequisitionInsightsOutput = z.infer<typeof getRequisitionInsightsOutputSchema>;
