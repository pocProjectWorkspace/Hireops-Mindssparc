/**
 * Recruiter persona surface contracts (RECR-01). Pure zod, no runtime deps.
 * Feeds the elevated recruiter dashboard (pipeline funnel, today's tasks, smart
 * follow-ups, AI insights, data completeness + risk flags) beyond the base
 * getMyDashboard KPI + action payload.
 *
 * EVERYTHING here is DETERMINISTIC — computed from real, tenant-scoped counts.
 * NO invented probabilities: the prototype's "AI Confidence 87%" aggregate is
 * deliberately absent (EU AI Act posture). "Smart follow-ups" surface stalled
 * candidates but never one-click send — the Ping action routes into the
 * existing agent-draft → human-approval flow. AI insights are computed
 * OBSERVATIONS that link to the real SkillWeightsEditor, never an auto-adjust
 * magic button.
 */

import { z } from "zod";

// ─────────────────────────── pipeline funnel ───────────────────────────

/**
 * One stage bar of the recruiter pipeline funnel. `pct` is the bar width
 * relative to the widest (first) stage — presentation only. `conversionPct`
 * is the stage-to-stage carry-through from the PREVIOUS stage (0–100, null for
 * the first stage), so the client can render the honest "−17%" drop deltas.
 */
export const recruiterFunnelStageSchema = z.object({
  stage: z.string(),
  label: z.string(),
  count: z.number().int(),
  pct: z.number(),
  conversionPct: z.number().nullable(),
});
export type RecruiterFunnelStage = z.infer<typeof recruiterFunnelStageSchema>;

export const recruiterFunnelSchema = z.object({
  stages: z.array(recruiterFunnelStageSchema),
  total: z.number().int(),
  bottleneck: z.string().nullable(),
});
export type RecruiterFunnel = z.infer<typeof recruiterFunnelSchema>;

// ─────────────────────────── today's tasks ───────────────────────────

export const recruiterTaskPrioritySchema = z.enum(["high", "medium", "low"]);
export type RecruiterTaskPriority = z.infer<typeof recruiterTaskPrioritySchema>;

/** A priority-tagged task DERIVED from real signals (SLA breaches, to-schedule,
 * ready-to-close, agent drafts, outstanding offers). Never a fabricated task. */
export const recruiterTaskSchema = z.object({
  key: z.string(),
  label: z.string(),
  priority: recruiterTaskPrioritySchema,
  href: z.string(),
});
export type RecruiterTask = z.infer<typeof recruiterTaskSchema>;

// ─────────────────────────── smart follow-ups ───────────────────────────

/**
 * A stalled candidate (real signal: an interview invite unconfirmed past a
 * threshold, or a triage-stage application aging past its SLA). The Ping action
 * on the client deep-links into the agent-draft → approval flow — it NEVER
 * sends. `href` points at the human-in-loop surface.
 */
export const recruiterFollowUpSchema = z.object({
  key: z.string(),
  candidateName: z.string(),
  reason: z.string(),
  applicationId: z.string().uuid(),
  candidateId: z.string().uuid(),
  href: z.string(),
});
export type RecruiterFollowUp = z.infer<typeof recruiterFollowUpSchema>;

// ─────────────────────────── AI insights (observations) ───────────────────

export const recruiterInsightSeveritySchema = z.enum(["info", "warning", "critical"]);
export type RecruiterInsightSeverity = z.infer<typeof recruiterInsightSeveritySchema>;

/**
 * A DETERMINISTIC observation over the recruiter's own pipeline data (e.g.
 * "Round-1 rejection 42% — skill weights may be miscalibrated"). No AI call is
 * made. `cta`, where present, links to a REAL surface (the SkillWeightsEditor
 * on a requisition, the triage queue) — never an auto-adjust magic button.
 */
export const recruiterInsightSchema = z.object({
  key: z.string(),
  severity: recruiterInsightSeveritySchema,
  title: z.string(),
  body: z.string(),
  cta: z
    .object({
      label: z.string(),
      href: z.string(),
    })
    .nullable(),
});
export type RecruiterInsight = z.infer<typeof recruiterInsightSchema>;

// ─────────────────────────── completeness + risk ───────────────────────────

export const recruiterDataCompletenessSchema = z.object({
  /** Share of in-flight applications carrying the fields recruiters rely on
   * (AI score, expected salary). 0–100, whole number. */
  pct: z.number().int(),
  needInfoCount: z.number().int(),
});
export type RecruiterDataCompleteness = z.infer<typeof recruiterDataCompletenessSchema>;

export const recruiterRiskFlagsSchema = z.object({
  total: z.number().int(),
  /** In-flight applications scored below the mismatch threshold. */
  skillMismatch: z.number().int(),
  /** In-flight applications whose expected salary exceeds the req budget max. */
  salaryGap: z.number().int(),
});
export type RecruiterRiskFlags = z.infer<typeof recruiterRiskFlagsSchema>;

// ─────────────────────────── the extras read ───────────────────────────

export const getRecruiterDashboardExtrasOutputSchema = z.object({
  funnel: recruiterFunnelSchema,
  tasks: z.array(recruiterTaskSchema),
  followUps: z.array(recruiterFollowUpSchema),
  insights: z.array(recruiterInsightSchema),
  dataCompleteness: recruiterDataCompletenessSchema,
  riskFlags: recruiterRiskFlagsSchema,
  /** Average AI match score across in-flight, scored applications (0–100).
   * null when nothing is scored yet — rendered honestly, never invented. */
  avgMatchScore: z.number().nullable(),
});
export type GetRecruiterDashboardExtrasOutput = z.infer<
  typeof getRecruiterDashboardExtrasOutputSchema
>;
