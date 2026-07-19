/**
 * AI requisition-revision suggestions contracts (RO-01). Pure zod, no runtime
 * deps — the tRPC surface (`apps/api`), the req-revision prompt builder, and the
 * requirement-owner portal pages all validate against these single definitions.
 *
 * This is the real-AI leg for the requirement-owner persona, built on the SAME
 * honest pattern as req_feasibility / comp_recommendation: a REJECTED
 * requisition gets 3–5 concrete revision suggestions, generated ONLY from the
 * rejection reason text, the req's own fields (budget, skills, level, location),
 * and curated market_benchmarks rows. The prompt FORBIDS invented market claims
 * and any demographic reference. Nothing auto-applies — the suggestions are
 * advisory; the human reviews them and resubmits through the normal REQ-02/03
 * edit path.
 *
 * The suggestions are cached per requisition in `req_revision_suggestions`
 * (ONE row per req, regenerate REPLACES) so the card renders instantly and one
 * real AI call happens per explicit "Generate" click.
 */

import { z } from "zod";

/**
 * One concrete revision suggestion. `area` is a coarse, closed tag so the UI
 * can chip it; `title` is a one-liner; `detail` is the actionable body. The
 * model is instructed to ground every suggestion in the given inputs.
 */
export const REVISION_AREAS = [
  "budget",
  "skills",
  "seniority",
  "location",
  "scope",
  "other",
] as const;
export type RevisionArea = (typeof REVISION_AREAS)[number];
export const revisionAreaSchema = z.enum(REVISION_AREAS);

export const REVISION_AREA_LABELS: Record<RevisionArea, string> = {
  budget: "Budget",
  skills: "Skills",
  seniority: "Seniority",
  location: "Location",
  scope: "Scope",
  other: "Other",
};

export const reqRevisionItemSchema = z.object({
  area: revisionAreaSchema,
  title: z.string().min(1).max(140),
  detail: z.string().min(1).max(600),
});
export type ReqRevisionItem = z.infer<typeof reqRevisionItemSchema>;

/** The structured shape the model returns — 3–5 grounded suggestions. */
export const reqRevisionAiSchema = z.object({
  suggestions: z.array(reqRevisionItemSchema).min(1).max(5),
});
export type ReqRevisionAi = z.infer<typeof reqRevisionAiSchema>;

/** The cached row (req_revision_suggestions), wire shape. */
export const reqRevisionSuggestionsSchema = z.object({
  requisitionId: z.string().uuid(),
  suggestions: z.array(reqRevisionItemSchema),
  /** The rejection reason the suggestions were generated against (provenance). */
  rejectionReason: z.string().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  generatedAt: z.string().nullable(),
});
export type ReqRevisionSuggestions = z.infer<typeof reqRevisionSuggestionsSchema>;

// ─────────────────────────── get (cached read) ───────────────────────────

export const getReqRevisionSuggestionsInputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export const getReqRevisionSuggestionsOutputSchema = z.object({
  /** null when nothing has been generated yet. */
  suggestions: reqRevisionSuggestionsSchema.nullable(),
  /** Whether this req is in a rejected state (the only state suggestions apply to). */
  eligible: z.boolean(),
  /** Whether the AI feature is enabled for the tenant (kill-switch honest state). */
  featureEnabled: z.boolean(),
});
export type GetReqRevisionSuggestionsOutput = z.infer<typeof getReqRevisionSuggestionsOutputSchema>;

// ─────────────────────────── generate (real AI) ───────────────────────────

export const generateReqRevisionSuggestionsInputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export const generateReqRevisionSuggestionsOutputSchema = z.object({
  suggestions: reqRevisionSuggestionsSchema,
  usedBenchmark: z.boolean(),
});
export type GenerateReqRevisionSuggestionsOutput = z.infer<
  typeof generateReqRevisionSuggestionsOutputSchema
>;
