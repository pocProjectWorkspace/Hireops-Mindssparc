/**
 * RECR-03 — recruiter AI Brief + Missing Info Tracker shared contracts.
 *
 * Two honest concerns share this file (server computes / validates, the
 * recruiter surfaces render):
 *
 *  1. The recruiter AI Brief drawer. The DETERMINISTIC parts — the candidate
 *     snapshot, the resume-vs-JD skills match (reuses `computeSkillsMatch` /
 *     `skillsMatchResultSchema` from panel-prep), the gaps/missing-info list,
 *     and the parsed resume highlights — carry NO AI claim. The three grounded
 *     AI prompts (`recruiter_brief` feature) are cached per (application, kind):
 *       - `strengths_risks`     : top 3 strengths + 2 risks vs the JD
 *       - `screen_script`       : a ~10-minute structured phone-screen script
 *       - `availability_draft`  : a DRAFT notice-period / availability message
 *     The availability draft is a DRAFT ONLY — it is never auto-sent; sending
 *     routes through the human/agent-approval path.
 *
 *  2. The Missing Info Tracker. "Required vs Optional" and "Blocks Advance to
 *     <stage>" are DETERMINISTIC (field requiredness + the real stage/knockout
 *     gate the field blocks). There is deliberately NO "score impact / capped
 *     at X%" column — the prototype's fiction is refused here; a hard gate is a
 *     deterministic knockout, never a magic score cap. The four-state lifecycle
 *     (pending → requested → received → verified) maps onto the existing doc
 *     request→verify states; "Request" uses the REAL candidate-notification
 *     flow.
 */

import { z } from "zod";
import { skillsMatchResultSchema } from "./panel-prep";

// ─────────────────────────── missing info (deterministic) ───────────────────────────

/**
 * The four-state lifecycle. `pending` is DERIVED (a required-or-tracked field is
 * absent and no request row exists yet); the other three are stored on the
 * missing_info_requests row and map onto the doc request→verify states
 * (requested → uploaded/received → verified). `dismissed` is the explicit
 * "N/A" a recruiter sets when a field does not apply to this candidate.
 */
export const MISSING_INFO_STATUSES = [
  "pending",
  "requested",
  "received",
  "verified",
  "dismissed",
] as const;
export const missingInfoStatusSchema = z.enum(MISSING_INFO_STATUSES);
export type MissingInfoStatus = z.infer<typeof missingInfoStatusSchema>;

/** The three lifecycle states a request row can be moved into after creation. */
export const missingInfoResolveActionSchema = z.enum(["received", "verified", "dismissed"]);
export type MissingInfoResolveAction = z.infer<typeof missingInfoResolveActionSchema>;

export const missingInfoRequirednessSchema = z.enum(["required", "optional"]);
export type MissingInfoRequiredness = z.infer<typeof missingInfoRequirednessSchema>;

/** One row of the tracker table — one (application, field) pair. */
export const missingInfoRowSchema = z.object({
  applicationId: z.string().uuid(),
  candidateId: z.string().uuid(),
  candidateName: z.string(),
  /** Short candidate reference (e.g. "RC001") for the table's sub-label. */
  candidateRef: z.string().nullable(),
  roleTitle: z.string(),
  fieldKey: z.string(),
  fieldLabel: z.string(),
  requiredness: missingInfoRequirednessSchema,
  status: missingInfoStatusSchema,
  /** ISO timestamp of the last candidate contact (request/notify). Null = never. */
  lastContactAt: z.string().nullable(),
  /**
   * The pipeline stage this missing field DETERMINISTICALLY blocks advance to,
   * or null when it blocks nothing (e.g. an optional field). Honest replacement
   * for the prototype's fabricated "Score Impact: Capped at 50" column.
   */
  blocksAdvanceStage: z.string().nullable(),
  /** Pre-rendered "Blocks advance to <stage>" label, or null. */
  blocksAdvanceLabel: z.string().nullable(),
  /** The missing_info_requests row id, when one exists (status !== pending). */
  requestId: z.string().uuid().nullable(),
});
export type MissingInfoRow = z.infer<typeof missingInfoRowSchema>;

export const missingInfoStatsSchema = z.object({
  pending: z.number().int(),
  requested: z.number().int(),
  received: z.number().int(),
  verified: z.number().int(),
});
export type MissingInfoStats = z.infer<typeof missingInfoStatsSchema>;

export const listMissingInfoInputSchema = z.object({
  status: missingInfoStatusSchema.optional(),
  fieldKey: z.string().optional(),
  search: z.string().optional(),
});
export type ListMissingInfoInput = z.infer<typeof listMissingInfoInputSchema>;

export const listMissingInfoOutputSchema = z.object({
  stats: missingInfoStatsSchema,
  rows: z.array(missingInfoRowSchema),
});
export type ListMissingInfoOutput = z.infer<typeof listMissingInfoOutputSchema>;

export const requestMissingInfoInputSchema = z.object({
  applicationId: z.string().uuid(),
  fieldKey: z.string(),
});
export type RequestMissingInfoInput = z.infer<typeof requestMissingInfoInputSchema>;

export const requestMissingInfoOutputSchema = z.object({
  requestId: z.string().uuid(),
  status: missingInfoStatusSchema,
  /** true when a real candidate notification was enqueued for this request. */
  notified: z.boolean(),
});
export type RequestMissingInfoOutput = z.infer<typeof requestMissingInfoOutputSchema>;

export const resolveMissingInfoInputSchema = z.object({
  applicationId: z.string().uuid(),
  fieldKey: z.string(),
  action: missingInfoResolveActionSchema,
});
export type ResolveMissingInfoInput = z.infer<typeof resolveMissingInfoInputSchema>;

export const resolveMissingInfoOutputSchema = z.object({
  requestId: z.string().uuid(),
  status: missingInfoStatusSchema,
});
export type ResolveMissingInfoOutput = z.infer<typeof resolveMissingInfoOutputSchema>;

// ─────────────────────────── recruiter AI brief (real AI) ───────────────────────────

export const RECRUITER_BRIEF_KINDS = [
  "strengths_risks",
  "screen_script",
  "availability_draft",
] as const;
export const recruiterBriefKindSchema = z.enum(RECRUITER_BRIEF_KINDS);
export type RecruiterBriefKind = z.infer<typeof recruiterBriefKindSchema>;

/** (a) Summarize top 3 strengths + 2 risks vs the JD. */
export const strengthsRisksAiSchema = z.object({
  strengths: z.array(z.string().min(1).max(400)).min(1).max(3),
  risks: z.array(z.string().min(1).max(400)).min(1).max(2),
});
export type StrengthsRisksAi = z.infer<typeof strengthsRisksAiSchema>;

/** (b) A ~10-minute structured phone-screen script — timed sections. */
export const screenScriptSectionSchema = z.object({
  title: z.string().min(1).max(120),
  minutes: z.number().int().min(1).max(15),
  prompts: z.array(z.string().min(1).max(400)).min(1).max(6),
});
export const screenScriptAiSchema = z.object({
  sections: z.array(screenScriptSectionSchema).min(1).max(6),
});
export type ScreenScriptAi = z.infer<typeof screenScriptAiSchema>;

/** (c) A DRAFT notice-period / availability confirmation message (never auto-sent). */
export const availabilityDraftAiSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(3000),
});
export type AvailabilityDraftAi = z.infer<typeof availabilityDraftAiSchema>;

/** The stored/cached content is one of the three shapes, tagged by kind. */
export const recruiterBriefContentSchema = z.union([
  strengthsRisksAiSchema,
  screenScriptAiSchema,
  availabilityDraftAiSchema,
]);
export type RecruiterBriefContent = z.infer<typeof recruiterBriefContentSchema>;

/** One cached AI card the brief renders (recruiter_brief row, wire shape). */
export const recruiterBriefCardSchema = z.object({
  kind: recruiterBriefKindSchema,
  content: recruiterBriefContentSchema,
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  generatedAt: z.string().nullable(),
});
export type RecruiterBriefCard = z.infer<typeof recruiterBriefCardSchema>;

/** Parsed resume highlights (deterministic — pulled from parsed_skills jsonb). */
export const resumeHighlightsSchema = z.object({
  keyProjects: z.array(z.string()),
  achievements: z.array(z.string()),
});
export type ResumeHighlights = z.infer<typeof resumeHighlightsSchema>;

/** The candidate snapshot header (deterministic). */
export const recruiterBriefSnapshotSchema = z.object({
  candidateId: z.string().uuid(),
  applicationId: z.string().uuid(),
  name: z.string(),
  roleTitle: z.string(),
  /** e.g. "Round 1 · Interview" or the current stage label. */
  contextLabel: z.string(),
  /** The application's real AI fit score (0–100), or null when unscored. */
  aiScore: z.number().nullable(),
  /** Deterministic must-have coverage % (required JD skills only). */
  mustHavePct: z.number().int().nullable(),
  source: z.string().nullable(),
});
export type RecruiterBriefSnapshot = z.infer<typeof recruiterBriefSnapshotSchema>;

/** A gap the brief surfaces — a missing field with its lifecycle status. */
export const recruiterBriefGapSchema = z.object({
  fieldKey: z.string(),
  fieldLabel: z.string(),
  requiredness: missingInfoRequirednessSchema,
  status: missingInfoStatusSchema,
  blocksAdvanceLabel: z.string().nullable(),
});
export type RecruiterBriefGap = z.infer<typeof recruiterBriefGapSchema>;

export const getRecruiterBriefInputSchema = z.object({ applicationId: z.string().uuid() });
export type GetRecruiterBriefInput = z.infer<typeof getRecruiterBriefInputSchema>;

export const getRecruiterBriefOutputSchema = z.object({
  snapshot: recruiterBriefSnapshotSchema,
  skillsMatch: skillsMatchResultSchema,
  gaps: z.array(recruiterBriefGapSchema),
  resumeHighlights: resumeHighlightsSchema,
  /** Cached AI cards keyed by kind (absent kinds have not been generated). */
  briefs: z.array(recruiterBriefCardSchema),
  /** false → the recruiter_brief kill-switch is off; the UI hides Generate + says so. */
  aiEnabled: z.boolean(),
});
export type GetRecruiterBriefOutput = z.infer<typeof getRecruiterBriefOutputSchema>;

export const generateRecruiterBriefInputSchema = z.object({
  applicationId: z.string().uuid(),
  kind: recruiterBriefKindSchema,
});
export type GenerateRecruiterBriefInput = z.infer<typeof generateRecruiterBriefInputSchema>;

export const generateRecruiterBriefOutputSchema = z.object({ brief: recruiterBriefCardSchema });
export type GenerateRecruiterBriefOutput = z.infer<typeof generateRecruiterBriefOutputSchema>;
