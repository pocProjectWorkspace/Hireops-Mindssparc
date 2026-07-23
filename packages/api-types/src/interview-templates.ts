/**
 * Tenant interview ROUND templates + CUSTOM scorecard VALUES (T2.2 / G07) contracts.
 * Pure zod — the tRPC surface (`apps/api`), the admin `/admin/interview-templates`
 * page, and the seed all validate against these single definitions.
 *
 * TWO configs, one file:
 *
 * (A) Round templates — the org's DEFAULT interview loop (tenant_interview_round_
 *     template). An ordered set of rounds that `applyInterviewRoundTemplate` SEEDS
 *     into a new requisition's interview_plans (a real copy, not a stored knob). A
 *     tenant with no rounds falls back to building the plan from scratch as today.
 *
 * (B) Scorecard templates — a tenant's OWN scorecard rubrics (tenant_scorecard_
 *     template), each a key + label + ordered criteria. resolveScorecardCriteria
 *     consumes these; the resolved criteria are SNAPSHOT onto an interview at
 *     schedule time and drive the panel scorecard form. A round may name one of
 *     the 4 code-default scorecards OR one of these custom keys.
 *
 * HONESTY: the scorecard value set is tenant-EXTENSIBLE, not unbounded — a plan
 * round's scorecardTemplate must be one of {4 code defaults} ∪ {the tenant's
 * saved scorecard keys}, enforced server-side at write.
 */

import { z } from "zod";
import { interviewModeSchema } from "./enums";
import { scorecardTemplateKeySchema } from "./procedures";

// ─────────────────────── shared: scorecard criterion ───────────────────────

/** One rubric criterion — a snake_case key + a human label. Mirrors the code
 * ScorecardCriterion shape (key/label) so custom + default rubrics render the
 * same panel scorecard form. */
export const scorecardTemplateCriterionSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "criterion key must be lowercase snake_case"),
  label: z.string().min(1).max(80),
});
export type ScorecardTemplateCriterion = z.infer<typeof scorecardTemplateCriterionSchema>;

// ═══════════════════ (A) tenant interview ROUND templates ═══════════════════

/** One round in the tenant's default loop, as authored/read. `scorecardTemplateKey`
 * names a code default or a tenant custom scorecard key (validated at write). */
export const interviewRoundTemplateRowSchema = z.object({
  roundNumber: z.number().int().min(1).max(20),
  roundName: z.string().min(1).max(120),
  durationMinutes: z.number().int().min(15).max(480),
  mode: interviewModeSchema,
  scorecardTemplateKey: scorecardTemplateKeySchema,
  competencyFocus: z.array(z.string().min(1).max(80)).max(20).default([]),
});
export type InterviewRoundTemplateRow = z.infer<typeof interviewRoundTemplateRowSchema>;

export const listInterviewRoundTemplatesInputSchema = z.object({}).default({});
export const listInterviewRoundTemplatesOutputSchema = z.object({
  rounds: z.array(interviewRoundTemplateRowSchema),
});
export type ListInterviewRoundTemplatesOutput = z.infer<
  typeof listInterviewRoundTemplatesOutputSchema
>;

/** Replace-set the tenant's default loop (mirrors upsertInterviewPlan): the whole
 * ordered loop is sent every time; round_number must be unique; an empty array
 * clears the loop. Each round's scorecardTemplateKey is validated server-side
 * against {4 code defaults} ∪ {the tenant's saved scorecard keys}. */
export const upsertInterviewRoundTemplateInputSchema = z.object({
  rounds: z.array(interviewRoundTemplateRowSchema).max(20),
});
export type UpsertInterviewRoundTemplateInput = z.infer<
  typeof upsertInterviewRoundTemplateInputSchema
>;
export const upsertInterviewRoundTemplateOutputSchema = z.object({
  rounds: z.array(interviewRoundTemplateRowSchema),
  roundCount: z.number().int().nonnegative(),
});
export type UpsertInterviewRoundTemplateOutput = z.infer<
  typeof upsertInterviewRoundTemplateOutputSchema
>;

/** Clear the tenant's whole default loop. Idempotent. */
export const deleteInterviewRoundTemplateInputSchema = z.object({}).default({});
export const deleteInterviewRoundTemplateOutputSchema = z.object({
  cleared: z.boolean(),
});
export type DeleteInterviewRoundTemplateOutput = z.infer<
  typeof deleteInterviewRoundTemplateOutputSchema
>;

/** Apply the tenant's default loop to a requisition — SEED its interview_plans
 * from the round templates. `applied:false` (roundCount 0) when the tenant has no
 * template rows: the honest fallback, the caller builds the plan from scratch. */
export const applyInterviewRoundTemplateInputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export type ApplyInterviewRoundTemplateInput = z.infer<
  typeof applyInterviewRoundTemplateInputSchema
>;
export const applyInterviewRoundTemplateOutputSchema = z.object({
  requisitionId: z.string().uuid(),
  applied: z.boolean(),
  roundCount: z.number().int().nonnegative(),
});
export type ApplyInterviewRoundTemplateOutput = z.infer<
  typeof applyInterviewRoundTemplateOutputSchema
>;

// ═══════════════════ (B) tenant CUSTOM scorecard templates ═══════════════════

/** A tenant's custom scorecard rubric, as authored/read. */
export const scorecardTemplateRowSchema = z.object({
  scorecardKey: scorecardTemplateKeySchema,
  label: z.string().min(1).max(80),
  criteria: z.array(scorecardTemplateCriterionSchema).min(1).max(10),
});
export type ScorecardTemplateRow = z.infer<typeof scorecardTemplateRowSchema>;

/** A scorecard as the plan-editor's picker sees it: a key + label + criteria, plus
 * whether it is a code default (`isCustom:false`) or a tenant custom rubric. */
export const scorecardTemplateOptionSchema = z.object({
  scorecardKey: z.string(),
  label: z.string(),
  criteria: z.array(scorecardTemplateCriterionSchema),
  isCustom: z.boolean(),
});
export type ScorecardTemplateOption = z.infer<typeof scorecardTemplateOptionSchema>;

export const listScorecardTemplatesInputSchema = z.object({}).default({});
export const listScorecardTemplatesOutputSchema = z.object({
  /** The tenant's saved custom rubrics. */
  custom: z.array(scorecardTemplateRowSchema),
  /** All selectable scorecards (4 code defaults + the tenant's custom rubrics) —
   * the plan-editor / round-template picker renders from this. */
  options: z.array(scorecardTemplateOptionSchema),
});
export type ListScorecardTemplatesOutput = z.infer<typeof listScorecardTemplatesOutputSchema>;

/** Upsert one custom rubric, keyed by (tenant, scorecardKey). scorecardKey must
 * NOT collide with a reserved code-default key ('technical'|'manager'|'hr'|
 * 'general') — rejected server-side. criteria: 1..10 distinct criterion keys. */
export const upsertScorecardTemplateInputSchema = z.object({
  scorecardKey: scorecardTemplateKeySchema,
  label: z.string().min(1).max(80),
  criteria: z.array(scorecardTemplateCriterionSchema).min(1).max(10),
});
export type UpsertScorecardTemplateInput = z.infer<typeof upsertScorecardTemplateInputSchema>;
export const upsertScorecardTemplateOutputSchema = z.object({
  row: scorecardTemplateRowSchema,
});
export type UpsertScorecardTemplateOutput = z.infer<typeof upsertScorecardTemplateOutputSchema>;

/** Delete one custom rubric by key. Rejected when a round template still
 * references the key (a dangling scorecard would break plan seeding). */
export const deleteScorecardTemplateInputSchema = z.object({
  scorecardKey: scorecardTemplateKeySchema,
});
export type DeleteScorecardTemplateInput = z.infer<typeof deleteScorecardTemplateInputSchema>;
export const deleteScorecardTemplateOutputSchema = z.object({
  deleted: z.boolean(),
});
export type DeleteScorecardTemplateOutput = z.infer<typeof deleteScorecardTemplateOutputSchema>;
