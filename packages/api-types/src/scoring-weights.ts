/**
 * Per-tenant scoring weight profile (CONF-03).
 *
 * A versioned `scoringWeights` sibling block inside `tenants.settings` jsonb
 * (a sibling to `aiSettings` + `biasLexicon` + `ai_provider` — never clobber
 * those). It parameterises the emphasis the REAL AI scoring prompt
 * (`@hireops/ai-scoring`'s `buildAIScoringPrompt`) puts on each grading
 * category. The four categories mirror the `top_factors` factor enum the
 * scoring response already reports (`skills_match` / `experience_level` /
 * `industry_relevance` / `education`), so the emphasis maps directly onto
 * what the model grades and reports back — no invented taxonomy.
 *
 * IMPORTANT — this is INSTRUCTION, NOT ARITHMETIC. The weights are rendered
 * into the prompt as grading guidance ("weight your judgement toward these
 * categories in roughly this proportion"). An LLM follows guidance; it does
 * NOT compute a weighted sum of sub-scores. The admin copy is explicit about
 * this so nobody mistakes the surface for a deterministic formula.
 *
 * Defaults reproduce the incumbent IMPLICIT emphasis stated as numbers: the
 * scoring prompt today leads with the JD's required skills (a weighted list),
 * then candidate experience (YoE + work history), then domain/industry
 * relevance, then education. Expressed as integers summing to 100 that is
 * skills 50 / experience 25 / industry 15 / education 10 (a judgement call,
 * flagged in the hand-back). Crucially the drain renders NOTHING new when the
 * profile equals these defaults, so a tenant that never opens this surface
 * gets a byte-identical prompt to pre-CONF-03 (the CONF-01 faithful-default
 * contract). Only a non-default profile adds the guidance block.
 *
 * Canonical schema lives here (pure zod, no runtime deps) so both the tRPC
 * surface (`apps/api`) and the resolver (`@hireops/ai-client`) validate
 * against one definition.
 */

import { z } from "zod";

/** Bumped only when the block's SHAPE changes in a breaking way. */
export const SCORING_WEIGHTS_VERSION = 1 as const;

/**
 * The grading categories, in canonical (default-emphasis-descending) order.
 * Keys match the `top_factors[].factor` enum in `@hireops/ai-scoring`'s
 * response schema (minus `other`, which is a catch-all the admin can't
 * meaningfully weight). `label` + `description` drive the admin card copy.
 */
export const SCORING_WEIGHT_CATEGORIES = [
  {
    key: "skills_match",
    label: "Skills match",
    description:
      "How well the candidate's skills cover the requisition's required and nice-to-have skills.",
  },
  {
    key: "experience_level",
    label: "Experience level",
    description: "Years of experience and seniority relative to the role.",
  },
  {
    key: "industry_relevance",
    label: "Industry / domain relevance",
    description: "How relevant the candidate's prior companies and domains are to this role.",
  },
  {
    key: "education",
    label: "Education",
    description: "Degree and field-of-study alignment with the role's expectations.",
  },
] as const;

export type ScoringWeightCategoryKey = (typeof SCORING_WEIGHT_CATEGORIES)[number]["key"];

/** The incumbent implicit emphasis, expressed as integers summing to 100. */
export const SCORING_WEIGHT_DEFAULTS: Record<ScoringWeightCategoryKey, number> = {
  skills_match: 50,
  experience_level: 25,
  industry_relevance: 15,
  education: 10,
};

export const SCORING_WEIGHTS_TOTAL = 100 as const;

const weightField = z.number().int().min(0).max(100);

/**
 * The scoring-weights block. Each category is an integer 0–100; the four
 * MUST sum to exactly 100 (a zod `.refine`). Every field carries a default
 * so a partial/absent stored block merges up to a complete, valid profile —
 * matching the aiSettings/biasLexicon merge discipline.
 */
export const scoringWeightsSchema = z
  .object({
    version: z.literal(SCORING_WEIGHTS_VERSION).default(SCORING_WEIGHTS_VERSION),
    skills_match: weightField.default(SCORING_WEIGHT_DEFAULTS.skills_match),
    experience_level: weightField.default(SCORING_WEIGHT_DEFAULTS.experience_level),
    industry_relevance: weightField.default(SCORING_WEIGHT_DEFAULTS.industry_relevance),
    education: weightField.default(SCORING_WEIGHT_DEFAULTS.education),
  })
  .refine(
    (w) =>
      w.skills_match + w.experience_level + w.industry_relevance + w.education ===
      SCORING_WEIGHTS_TOTAL,
    { message: `Category weights must sum to exactly ${SCORING_WEIGHTS_TOTAL}.` },
  );
export type ScoringWeights = z.infer<typeof scoringWeightsSchema>;

/** The effective profile when a tenant has never written the block. */
export function defaultScoringWeights(): ScoringWeights {
  return scoringWeightsSchema.parse({});
}

/**
 * Merge a raw stored `scoringWeights` block (partial / unknown / absent /
 * sum≠100) with defaults, returning a complete, validated profile. Malformed
 * blocks fall back to defaults rather than throwing — the scoring path must
 * never break because a settings blob went stale (matches resolveAiSettings).
 */
export function resolveScoringWeights(rawBlock: unknown): ScoringWeights {
  const parsed = scoringWeightsSchema.safeParse(rawBlock ?? {});
  return parsed.success ? parsed.data : defaultScoringWeights();
}

/** True when the profile equals the incumbent defaults on every category. */
export function isDefaultScoringWeights(w: ScoringWeights): boolean {
  return (
    w.skills_match === SCORING_WEIGHT_DEFAULTS.skills_match &&
    w.experience_level === SCORING_WEIGHT_DEFAULTS.experience_level &&
    w.industry_relevance === SCORING_WEIGHT_DEFAULTS.industry_relevance &&
    w.education === SCORING_WEIGHT_DEFAULTS.education
  );
}

export interface ScoringWeightEmphasisEntry {
  key: ScoringWeightCategoryKey;
  label: string;
  weight: number;
}

/**
 * Flatten a profile into {key,label,weight} entries in weight-descending
 * order (ties keep canonical order). This is the exact shape the prompt
 * builder renders and the score explanation carries — one source of truth
 * for both.
 */
export function scoringWeightsEmphasis(w: ScoringWeights): ScoringWeightEmphasisEntry[] {
  return SCORING_WEIGHT_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    weight: w[c.key],
  })).sort((a, b) => b.weight - a.weight);
}

// ─────────────── get / update procedure schemas (CONF-03) ───────────────

export const getScoringWeightsInputSchema = z.object({});
export const getScoringWeightsOutputSchema = scoringWeightsSchema;
export type GetScoringWeightsOutput = z.infer<typeof getScoringWeightsOutputSchema>;

/** The full block the admin surface writes. Lenient (defaults fill gaps). */
export const updateScoringWeightsInputSchema = scoringWeightsSchema;
export type UpdateScoringWeightsInput = z.infer<typeof updateScoringWeightsInputSchema>;
export const updateScoringWeightsOutputSchema = z.object({
  ok: z.literal(true),
  weights: scoringWeightsSchema,
});
export type UpdateScoringWeightsOutput = z.infer<typeof updateScoringWeightsOutputSchema>;
