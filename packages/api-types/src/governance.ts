/**
 * Governance & Executive Audit (HRHEAD-03).
 *
 * Three concerns live here, all pure zod / pure TS so both the tRPC surface
 * (`apps/api`) and the resolver (`@hireops/ai-client`) validate against one
 * definition (the CONF-01 sibling-block discipline):
 *
 *   1. Two versioned settings blocks that live inside `tenants.settings` jsonb
 *      as SIBLINGS to `aiSettings` / `biasLexicon` / `scoringWeights`:
 *        - `screeningPrivacy` — per-field anonymisation during screening.
 *        - `feedbackSharing`  — what a candidate sees of submitted feedback.
 *      Both merge-with-defaults exactly like resolveAiSettings, so a tenant
 *      that never opens the Governance page behaves precisely as before.
 *
 *   2. The candidate-masking helper the triage list + candidate drawer reads
 *      consume server-side. A pure function (roles + stage + policy → mask
 *      decision) so the router and the tests share ONE source of truth.
 *
 *   3. The read shapes behind the Executive Audit page: the deterministic
 *      risk-flag feed and the compliance-score composite. NO schema, NO AI —
 *      every number is derived from live tables in the router.
 *
 * NOTHING here does demographic inference: we hold no photo / gender / age /
 * university, and the screening-privacy surface says so honestly rather than
 * shipping dead toggles.
 */

import { z } from "zod";
import { applicationStageSchema, type ApplicationStage } from "./enums";

// ─────────────────────────── screeningPrivacy (block 1) ───────────────────────────

/** Bumped only when the block's SHAPE changes in a breaking way. */
export const SCREENING_PRIVACY_VERSION = 1 as const;

/**
 * Per-field anonymisation during screening. Consumed FOR REAL by the triage
 * list (`listCandidates`) + candidate drawer (`getCandidateById`): while a
 * candidate sits BELOW the tech_interview stage, a masked-role caller (a
 * recruiter without an accountable role) sees the candidate as
 * "Candidate #SHORT-ID" and/or with contact fields nulled. Defaults OFF —
 * faithful pre-HRHEAD-03 behaviour.
 */
export const screeningPrivacySchema = z.object({
  version: z.literal(SCREENING_PRIVACY_VERSION).default(SCREENING_PRIVACY_VERSION),
  hideCandidateName: z.boolean().default(false),
  hideContactInfo: z.boolean().default(false),
});
export type ScreeningPrivacy = z.infer<typeof screeningPrivacySchema>;

export function defaultScreeningPrivacy(): ScreeningPrivacy {
  return screeningPrivacySchema.parse({});
}

/**
 * Merge a raw stored `screeningPrivacy` block (partial / unknown / absent)
 * with defaults. Malformed blocks fall back to defaults rather than throwing —
 * a masking read must never break because a settings blob went stale.
 */
export function resolveScreeningPrivacy(rawBlock: unknown): ScreeningPrivacy {
  const parsed = screeningPrivacySchema.safeParse(rawBlock ?? {});
  return parsed.success ? parsed.data : defaultScreeningPrivacy();
}

// ─────────────────────────── feedbackSharing (block 2) ───────────────────────────

export const FEEDBACK_SHARING_VERSION = 1 as const;

/**
 * What a candidate sees of submitted interview feedback in their own portal
 * (`candidateListMyInterviews`). When `shareInterviewSummary` is on, a
 * completed interview surfaces the panel's strengths summary; when
 * `shareRecommendation` is on, it surfaces the roll-up recommendation. Numeric
 * SCORES are NEVER shared regardless of these toggles — the read never selects
 * the scorecard. Defaults OFF — a candidate sees no feedback unless the tenant
 * opts in.
 */
export const feedbackSharingSchema = z.object({
  version: z.literal(FEEDBACK_SHARING_VERSION).default(FEEDBACK_SHARING_VERSION),
  shareInterviewSummary: z.boolean().default(false),
  shareRecommendation: z.boolean().default(false),
});
export type FeedbackSharing = z.infer<typeof feedbackSharingSchema>;

export function defaultFeedbackSharing(): FeedbackSharing {
  return feedbackSharingSchema.parse({});
}

export function resolveFeedbackSharing(rawBlock: unknown): FeedbackSharing {
  const parsed = feedbackSharingSchema.safeParse(rawBlock ?? {});
  return parsed.success ? parsed.data : defaultFeedbackSharing();
}

// ─────────────────────────── candidate masking helper ───────────────────────────

/**
 * The stage a candidate must REACH before the screening mask lifts. Below it,
 * a masked-role caller sees an anonymised candidate; at or beyond it, the name
 * + contact are always visible (the accountable interview conversation needs
 * the real person). Ordinal comes from the canonical application_stage order.
 */
export const CANDIDATE_MASK_STAGE_GATE: ApplicationStage = "tech_interview";

/**
 * Roles that ALWAYS see through the mask — the accountable leadership roles.
 * A caller holding any of these is never masked. Everyone else is masked ONLY
 * if they hold the `recruiter` role (the screening role the policy targets);
 * other roles (hiring_manager, panel_member, hr_ops, …) are out of the
 * policy's scope and see unmasked — a deliberately narrow reading of the
 * ticket's "for recruiter-role users", easily widened later.
 */
export const MASK_SEE_THROUGH_ROLES = ["admin", "hr_head"] as const;
export const MASK_SUBJECT_ROLE = "recruiter" as const;

/** Canonical forward order of the application stages (mirror of the pgEnum). */
const STAGE_ORDER: ApplicationStage[] = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
];

/** Ordinal of a stage in the canonical forward order (-1 if unknown). */
export function stageRank(stage: ApplicationStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/** True once the candidate has reached (or passed) the mask stage gate. */
export function isPastMaskGate(stage: ApplicationStage): boolean {
  return stageRank(stage) >= stageRank(CANDIDATE_MASK_STAGE_GATE);
}

export interface CandidateMaskDecision {
  maskName: boolean;
  maskContact: boolean;
}

/**
 * Decide whether THIS caller sees a masked name / contact for a candidate at
 * a given stage, under a given policy. Pure — the router and the tests share
 * this one definition.
 *
 * A field is masked iff: the policy toggle is on AND the candidate is still
 * below the stage gate AND the caller is a masked-role user (holds
 * `recruiter`, holds none of the see-through roles).
 */
export function resolveCandidateMasking(params: {
  roles: string[];
  stage: ApplicationStage;
  privacy: ScreeningPrivacy;
}): CandidateMaskDecision {
  const { roles, stage, privacy } = params;
  const seesThrough = roles.some((r) => (MASK_SEE_THROUGH_ROLES as readonly string[]).includes(r));
  const isSubject = roles.includes(MASK_SUBJECT_ROLE);
  const callerMasked = isSubject && !seesThrough;
  const beforeGate = !isPastMaskGate(stage);
  const active = callerMasked && beforeGate;
  return {
    maskName: active && privacy.hideCandidateName,
    maskContact: active && privacy.hideContactInfo,
  };
}

/** The anonymised display label — "Candidate #A1B2C3D4" from the candidate id. */
export function candidateMaskLabel(candidateId: string): string {
  const short = candidateId.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `Candidate #${short}`;
}

// ─────────────────────────── screeningPrivacy get/update ───────────────────────────

export const getScreeningPrivacyInputSchema = z.object({});
export const getScreeningPrivacyOutputSchema = screeningPrivacySchema;
export type GetScreeningPrivacyOutput = z.infer<typeof getScreeningPrivacyOutputSchema>;

export const updateScreeningPrivacyInputSchema = screeningPrivacySchema;
export type UpdateScreeningPrivacyInput = z.infer<typeof updateScreeningPrivacyInputSchema>;
export const updateScreeningPrivacyOutputSchema = z.object({
  ok: z.literal(true),
  screeningPrivacy: screeningPrivacySchema,
});
export type UpdateScreeningPrivacyOutput = z.infer<typeof updateScreeningPrivacyOutputSchema>;

// ─────────────────────────── feedbackSharing get/update ───────────────────────────

export const getFeedbackSharingInputSchema = z.object({});
export const getFeedbackSharingOutputSchema = feedbackSharingSchema;
export type GetFeedbackSharingOutput = z.infer<typeof getFeedbackSharingOutputSchema>;

export const updateFeedbackSharingInputSchema = feedbackSharingSchema;
export type UpdateFeedbackSharingInput = z.infer<typeof updateFeedbackSharingInputSchema>;
export const updateFeedbackSharingOutputSchema = z.object({
  ok: z.literal(true),
  feedbackSharing: feedbackSharingSchema,
});
export type UpdateFeedbackSharingOutput = z.infer<typeof updateFeedbackSharingOutputSchema>;

// ─────────────────────────── risk-flag feed (getGovernanceRiskFlags) ───────────────────────────

export const RISK_SEVERITIES = ["high", "medium", "low"] as const;
export const riskSeveritySchema = z.enum(RISK_SEVERITIES);
export type RiskSeverity = z.infer<typeof riskSeveritySchema>;

/** Stable rule identifiers — one per deterministic derivation. */
export const RISK_RULE_KEYS = [
  "budget_below_benchmark",
  "requisition_approval_overdue",
  "unrealistic_must_haves",
  "offer_above_band",
  "feedback_overdue",
] as const;
export const riskRuleKeySchema = z.enum(RISK_RULE_KEYS);
export type RiskRuleKey = z.infer<typeof riskRuleKeySchema>;

/**
 * One fired risk flag. `entityType` + `entityId` identify the offending row;
 * `deepLink` is a best-effort portal path; `consequence` is a one-line
 * plain-English statement of why it matters.
 */
export const governanceRiskFlagSchema = z.object({
  id: z.string(),
  rule: riskRuleKeySchema,
  severity: riskSeveritySchema,
  title: z.string(),
  detail: z.string(),
  consequence: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  deepLink: z.string().nullable(),
});
export type GovernanceRiskFlag = z.infer<typeof governanceRiskFlagSchema>;

export const getGovernanceRiskFlagsOutputSchema = z.object({
  flags: z.array(governanceRiskFlagSchema),
  /** Rules that could not run (e.g. the market_benchmarks table is absent). */
  skippedRules: z.array(z.object({ rule: riskRuleKeySchema, reason: z.string() })),
  counts: z.object({
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
    total: z.number().int(),
  }),
});
export type GetGovernanceRiskFlagsOutput = z.infer<typeof getGovernanceRiskFlagsOutputSchema>;

// ─────────────────────────── compliance score + SLA table (getExecutiveAudit) ───────────────────────────

/**
 * The four real ratios the compliance score composites. `value` is 0..1 (an
 * empty sample counts as 1.0 — "no activity, no breaches", stated in the UI);
 * `weightPct` is the documented weighting; `sampleSize` is the denominator so
 * the UI can flag thin data honestly.
 */
export const complianceComponentSchema = z.object({
  key: z.enum([
    "approvals_within_sla",
    "feedback_within_48h",
    "onboarding_docs_verified",
    "offers_within_band",
  ]),
  label: z.string(),
  value: z.number().min(0).max(1),
  weightPct: z.number().int(),
  sampleSize: z.number().int(),
});
export type ComplianceComponent = z.infer<typeof complianceComponentSchema>;

/** One per-stage SLA row: real median hours vs a declared target. */
export const slaComplianceRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  targetHours: z.number(),
  medianHours: z.number().nullable(),
  withinTargetPct: z.number().min(0).max(1).nullable(),
  sampleSize: z.number().int(),
});
export type SlaComplianceRow = z.infer<typeof slaComplianceRowSchema>;

/** One top-drop-off reason (terminal-stage tally over applications). */
export const dropOffReasonSchema = z.object({
  stage: applicationStageSchema,
  label: z.string(),
  count: z.number().int(),
});
export type DropOffReason = z.infer<typeof dropOffReasonSchema>;

export const executiveAuditKpisSchema = z.object({
  complianceScore: z.number().min(0).max(100),
  slaBreaches: z.number().int(),
  openFlags: z.number().int(),
  offerAcceptRatePct: z.number().min(0).max(100).nullable(),
});
export type ExecutiveAuditKpis = z.infer<typeof executiveAuditKpisSchema>;

export const getExecutiveAuditOutputSchema = z.object({
  kpis: executiveAuditKpisSchema,
  components: z.array(complianceComponentSchema),
  slaTable: z.array(slaComplianceRowSchema),
  dropOff: z.array(dropOffReasonSchema),
  flags: z.array(governanceRiskFlagSchema),
  flagCounts: z.object({
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
    total: z.number().int(),
  }),
});
export type GetExecutiveAuditOutput = z.infer<typeof getExecutiveAuditOutputSchema>;

// ─────────────────────────── shared governance constants ───────────────────────────

/** Requisition-approval SLA in days (rule b + the approvals compliance ratio). */
export const REQUISITION_APPROVAL_SLA_DAYS = 2 as const;

/** Interview-feedback SLA in hours (rule e + the feedback compliance ratio). */
export const FEEDBACK_SLA_HOURS = 48 as const;

/** Must-haves above this on an open req read as "unrealistic" (rule c). */
export const UNREALISTIC_MUST_HAVE_THRESHOLD = 5 as const;

/**
 * The documented compliance-score weights (sum 100). A judgement call, stated
 * in the UI copy so nobody mistakes the surface for a regulated formula.
 */
export const COMPLIANCE_WEIGHTS = {
  approvals_within_sla: 30,
  feedback_within_48h: 25,
  onboarding_docs_verified: 25,
  offers_within_band: 20,
} as const;
