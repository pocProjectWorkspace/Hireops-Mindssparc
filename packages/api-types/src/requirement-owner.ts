/**
 * Requirement-owner (hiring_manager) surface contracts (RO-01). Pure zod, no
 * runtime deps. Feeds the rebuilt requirement-owner dashboard, My Requisitions
 * v2, and the Approval Tracker. Health + difficulty are computed server-side by
 * the deterministic rule engine (apps/api/src/lib/req-health.ts) and transported
 * as plain data — the client only renders.
 *
 * NO demographic anything, NO psychometrics, NO offer-acceptance probability.
 * Market insights carry ONLY historical averages from OUR own application
 * transitions (labelled "historical average") and curated-benchmark difficulty
 * — never invented market claims.
 */

import { z } from "zod";

// ─────────────────────────── health + difficulty ───────────────────────────

export const reqHealthComponentSchema = z.object({
  key: z.string(),
  label: z.string(),
  earned: z.number(),
  max: z.number(),
});
export type ReqHealthComponentWire = z.infer<typeof reqHealthComponentSchema>;

export const reqHealthSchema = z.object({
  score: z.number().int().min(0).max(100),
  components: z.array(reqHealthComponentSchema),
});
export type ReqHealthWire = z.infer<typeof reqHealthSchema>;

export const reqDifficultySchema = z.enum(["low", "medium", "high"]);
export type ReqDifficultyWire = z.infer<typeof reqDifficultySchema>;

// ─────────────────────────── My Requisitions v2 ───────────────────────────

/** A weighted skill chip for the recruiter card-grid ("React (9)"). Weight is
 * the jd_skills weight (0–10); required flags a must-have. */
export const requisitionSkillChipSchema = z.object({
  name: z.string(),
  weight: z.number().int(),
  required: z.boolean(),
});
export type RequisitionSkillChip = z.infer<typeof requisitionSkillChipSchema>;

export const requirementOwnerReqRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  status: z.string(),
  health: reqHealthSchema,
  difficulty: reqDifficultySchema,
  budgetBand: z.string().nullable(),
  openings: z.number().int(),
  createdAt: z.string(),
  /** Draft is complete enough to submit for approval (health gate). */
  canSubmit: z.boolean(),
  // ─── RECR-01 card-grid facets (additive; the RO table ignores them) ───
  /** Weighted skill chips, highest-weight first (top 4 for the card). */
  skills: z.array(requisitionSkillChipSchema),
  /** Live (non-terminal) candidates on this requisition. */
  candidateCount: z.number().int(),
  /** Configured interview-plan rounds. */
  interviewRounds: z.number().int(),
  /** Budget band formatted as INR with Indian grouping (₹65,00,000 – ₹85,00,000)
   * when the currency is INR; falls back to the plain band otherwise. null when
   * no band is set. */
  salaryInr: z.string().nullable(),
});
export type RequirementOwnerReqRow = z.infer<typeof requirementOwnerReqRowSchema>;

export const listMyRequisitionsV2InputSchema = z.object({
  limit: z.number().int().min(1).max(200).default(100),
});
export const listMyRequisitionsV2OutputSchema = z.object({
  rows: z.array(requirementOwnerReqRowSchema),
});
export type ListMyRequisitionsV2Output = z.infer<typeof listMyRequisitionsV2OutputSchema>;

// ─────────────────────────── dashboard ───────────────────────────

export const roDashboardStatSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number().int(),
  /** Optional deep-link (status filter on the list). */
  href: z.string().nullable(),
});
export type RoDashboardStat = z.infer<typeof roDashboardStatSchema>;

/** A compact per-req health row for the dashboard's health card. */
export const roHealthRowSchema = z.object({
  requisitionId: z.string().uuid(),
  title: z.string().nullable(),
  status: z.string(),
  score: z.number().int(),
  difficulty: reqDifficultySchema,
});
export type RoHealthRow = z.infer<typeof roHealthRowSchema>;

/** A pending approval with real waiting-time vs the requisition-approval SLA. */
export const roApprovalSlaItemSchema = z.object({
  requisitionId: z.string().uuid(),
  approvalRequestId: z.string().uuid(),
  title: z.string().nullable(),
  submittedAt: z.string(),
  hoursWaiting: z.number().int(),
  slaHours: z.number().int(),
  breach: z.boolean(),
});
export type RoApprovalSlaItem = z.infer<typeof roApprovalSlaItemSchema>;

/** Deterministic action-required rule kinds. */
export const RO_ACTION_KINDS = [
  "panel_not_configured",
  "skills_not_weighted",
  "budget_missing",
  "jd_not_generated",
  "stalled_approval",
  "rejected_with_reason",
  "ready_to_submit",
] as const;
export type RoActionKind = (typeof RO_ACTION_KINDS)[number];

export const roActionItemSchema = z.object({
  key: z.string(),
  kind: z.enum(RO_ACTION_KINDS),
  requisitionId: z.string().uuid(),
  title: z.string(),
  detail: z.string(),
  href: z.string(),
  severity: z.enum(["urgent", "attention", "info"]),
});
export type RoActionItem = z.infer<typeof roActionItemSchema>;

/** Per-role difficulty + honest historical time-to-hire from OUR data. */
export const roMarketInsightSchema = z.object({
  roleTitle: z.string(),
  difficulty: reqDifficultySchema,
  /** Historical average days from first application to offer_accepted, our data. */
  historicalAvgTimeToHireDays: z.number().nullable(),
  /** How many hires the average is drawn from (0 → honest empty state). */
  sampleSize: z.number().int(),
  /** Curated-benchmark typical time-to-fill (reference), null when unmatched. */
  benchmarkTtfDays: z.number().int().nullable(),
});
export type RoMarketInsight = z.infer<typeof roMarketInsightSchema>;

export const getRequirementOwnerDashboardOutputSchema = z.object({
  stats: z.array(roDashboardStatSchema),
  healthRows: z.array(roHealthRowSchema),
  approvalSla: z.array(roApprovalSlaItemSchema),
  actions: z.array(roActionItemSchema),
  marketInsights: z.array(roMarketInsightSchema),
});
export type GetRequirementOwnerDashboardOutput = z.infer<
  typeof getRequirementOwnerDashboardOutputSchema
>;

// ─────────────────────────── Approval Tracker ───────────────────────────

export const approvalTrackerStatsSchema = z.object({
  pending: z.number().int(),
  approved: z.number().int(),
  rejected: z.number().int(),
});
export type ApprovalTrackerStats = z.infer<typeof approvalTrackerStatsSchema>;

export const approvalTrackerHistoryRowSchema = z.object({
  requisitionId: z.string().uuid(),
  approvalRequestId: z.string().uuid(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  /** approved | rejected | sent_back | pending | cancelled | expired */
  outcome: z.string(),
  submittedAt: z.string(),
  decidedAt: z.string().nullable(),
  /** Hours elapsed submitted→decided (or submitted→now when pending). */
  slaElapsedHours: z.number().int().nullable(),
  breach: z.boolean(),
  decisionReason: z.string().nullable(),
});
export type ApprovalTrackerHistoryRow = z.infer<typeof approvalTrackerHistoryRowSchema>;

export const getApprovalTrackerOutputSchema = z.object({
  stats: approvalTrackerStatsSchema,
  pending: z.array(roApprovalSlaItemSchema),
  history: z.array(approvalTrackerHistoryRowSchema),
});
export type GetApprovalTrackerOutput = z.infer<typeof getApprovalTrackerOutputSchema>;
