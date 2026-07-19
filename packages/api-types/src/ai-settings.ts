/**
 * Per-tenant AI settings (CONF-01).
 *
 * A versioned `aiSettings` block that lives inside `tenants.settings` jsonb
 * (a sibling key to the existing `ai_provider` + cosmetic config — never
 * clobber those). Every control here is consumed by the real ai-client call
 * path: `ai_scoring` (worker score drain), `jd_generation` (REQ-02 wizard),
 * and `agent_drafts` (agent draft_message executor). No facade toggles.
 *
 * Canonical schema lives here (pure zod, no runtime deps) so both the tRPC
 * surface (`apps/api`) and the resolver (`@hireops/ai-client`) validate
 * against one definition. The resolver reads `tenants.settings.aiSettings`
 * and merges these defaults; the admin mutation writes a full block back.
 *
 * Defaults are chosen to reproduce today's hardcoded behaviour exactly:
 *   - model `claude-sonnet-4-6` — the ai-client's `DEFAULT_MODEL`.
 *   - maxTokens 4096 — the ai-client's `DEFAULT_MAX_TOKENS`.
 *   - temperature 1 — the ai-client sends no temperature today, so the
 *     provider default (Anthropic = 1.0) is what actually runs; 1 is the
 *     faithful reproduction.
 *   - every feature `enabled`, `piiMasking` off — a tenant that never opens
 *     this surface behaves precisely as it did before CONF-01.
 *
 * Model allowlist is deliberately Anthropic-only: the incumbent Sonnet the
 * ai-client runs today plus one cheaper Haiku-class option. We do NOT offer
 * OpenAI models here even though an OpenAI client exists — provider choice is
 * a separate concern (`tenants.settings.ai_provider`), and offering models we
 * can't attribute cost for would make this surface lie.
 */

import { z } from "zod";

/** Bumped only when the block's SHAPE changes in a breaking way. */
export const AI_SETTINGS_VERSION = 1 as const;

/**
 * The models an admin may pick per feature. The incumbent Sonnet (what the
 * ai-client's `DEFAULT_MODEL` is today) + one cheaper Haiku-class option.
 * Both carry a pricing row in `@hireops/ai-client`'s pricing table, so cost
 * attribution stays honest whichever is chosen.
 */
export const AI_MODEL_ALLOWLIST = ["claude-sonnet-4-6", "claude-haiku-4-5"] as const;
export const aiModelSchema = z.enum(AI_MODEL_ALLOWLIST);
export type AiModel = z.infer<typeof aiModelSchema>;

export const AI_DEFAULT_MODEL: AiModel = "claude-sonnet-4-6";
export const AI_DEFAULT_TEMPERATURE = 1;
export const AI_DEFAULT_MAX_TOKENS = 4096;
export const AI_MAX_TOKENS_MIN = 256;
export const AI_MAX_TOKENS_MAX = 8192;

/**
 * Per-feature config. Every field carries a default so a partially-written
 * stored block (e.g. `{ enabled: false }`) merges up to a complete config
 * when parsed.
 */
export const aiFeatureSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  model: aiModelSchema.default(AI_DEFAULT_MODEL),
  temperature: z.number().min(0).max(1).default(AI_DEFAULT_TEMPERATURE),
  maxTokens: z
    .number()
    .int()
    .min(AI_MAX_TOKENS_MIN)
    .max(AI_MAX_TOKENS_MAX)
    .default(AI_DEFAULT_MAX_TOKENS),
});
export type AiFeatureSettings = z.infer<typeof aiFeatureSettingsSchema>;

/**
 * A COMPLETE default object — used as the `.default()` for each feature key.
 * Zod's `.default()` returns its argument as-is when the field is absent
 * (it does not re-run the object schema), so the default must be fully
 * formed rather than `{}`. A factory avoids a shared mutable reference.
 */
function featureDefault(): AiFeatureSettings {
  return {
    enabled: true,
    model: AI_DEFAULT_MODEL,
    temperature: AI_DEFAULT_TEMPERATURE,
    maxTokens: AI_DEFAULT_MAX_TOKENS,
  };
}

/** The real consumers this surface governs (jd_bias_review added in CONF-02,
 * req_feasibility in HRHEAD-02, comp_recommendation in HROPS-02). */
export const AI_FEATURE_KEYS = [
  "ai_scoring",
  "jd_generation",
  "agent_drafts",
  "jd_bias_review",
  "req_feasibility",
  "comp_recommendation",
] as const;
export type AiFeatureKey = (typeof AI_FEATURE_KEYS)[number];

/** Human-legible labels + honest copy for the admin UI. */
export const AI_FEATURE_META: Record<
  AiFeatureKey,
  { label: string; usageFeatures: string[]; description: string }
> = {
  ai_scoring: {
    label: "Candidate scoring",
    usageFeatures: ["ai_scoring"],
    description:
      "Scores each applicant against the requisition. Disabling leaves new applicants unscored (the score drain skips them cleanly — no retries, no error).",
  },
  jd_generation: {
    label: "JD generation",
    usageFeatures: ["jd_generation"],
    description:
      "Drafts a job description in the requisition wizard. Disabling makes the wizard's Generate step return a clear 'disabled' message instead of calling the model.",
  },
  agent_drafts: {
    label: "Agent message drafts",
    usageFeatures: ["agent_draft_message"],
    description:
      "Drafts candidate follow-up messages for the approval queue. Disabling makes agent draft runs stop with a clear error rather than calling the model.",
  },
  jd_bias_review: {
    label: "JD bias review (AI-assisted)",
    usageFeatures: ["jd_bias_review"],
    description:
      "An optional, advisory inclusive-language review of a draft JD, run on demand from the wizard. Never blocks a submission — it only adds observations. Disabling hides the 'Review with AI' button and refuses the call.",
  },
  req_feasibility: {
    label: "Requisition feasibility assessment",
    usageFeatures: ["req_feasibility"],
    description:
      "Assesses a requisition's fillability against the tenant's curated market benchmarks — skills fit, experience-vs-comp fit, difficulty, and a salary-adjustment recommendation. Runs only on an explicit 'Generate/Refresh' click on the Feasibility page. Disabling makes that button refuse with a clear message instead of calling the model.",
  },
  comp_recommendation: {
    label: "Compensation rationale",
    usageFeatures: ["comp_recommendation"],
    description:
      "Writes a short prose rationale around the deterministic comp verdict on the Comp & offer desk — grounded ONLY in the candidate's expected salary, the role's comp band, and the curated benchmarks (never invented market claims). The verdict itself is always rule-computed and unaffected. Runs only on an explicit 'Generate rationale' click. Disabling makes that button refuse with a clear message instead of calling the model.",
  },
};

export const aiSettingsSchema = z.object({
  version: z.literal(AI_SETTINGS_VERSION).default(AI_SETTINGS_VERSION),
  ai_scoring: aiFeatureSettingsSchema.default(featureDefault),
  jd_generation: aiFeatureSettingsSchema.default(featureDefault),
  agent_drafts: aiFeatureSettingsSchema.default(featureDefault),
  jd_bias_review: aiFeatureSettingsSchema.default(featureDefault),
  req_feasibility: aiFeatureSettingsSchema.default(featureDefault),
  comp_recommendation: aiFeatureSettingsSchema.default(featureDefault),
  /**
   * Global deterministic PII redaction. When on, candidate-derived prompt
   * text going into scoring + agent-draft calls has emails / phone numbers /
   * URLs redacted before it leaves the process. JD generation carries no
   * candidate PII, so it is unaffected.
   */
  piiMasking: z.boolean().default(false),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

/**
 * The effective settings when a tenant has never written the block. Passing
 * `{}` (not `undefined`) makes the object schema run and fill every field.
 */
export function defaultAiSettings(): AiSettings {
  return aiSettingsSchema.parse({});
}

/**
 * Merge a raw stored `aiSettings` block (partial / unknown / absent) with
 * defaults, returning a complete, validated config. Malformed or
 * future-versioned blocks fall back to defaults rather than throwing — the
 * AI call path must never break because a settings blob went stale.
 */
export function resolveAiSettings(rawBlock: unknown): AiSettings {
  const parsed = aiSettingsSchema.safeParse(rawBlock ?? {});
  return parsed.success ? parsed.data : defaultAiSettings();
}

// ─────────────── getTenantAiSettings / updateTenantAiSettings (CONF-01) ───────────────

export const getTenantAiSettingsInputSchema = z.object({});
export const getTenantAiSettingsOutputSchema = aiSettingsSchema;
export type GetTenantAiSettingsOutput = z.infer<typeof getTenantAiSettingsOutputSchema>;

/** The full block the admin surface writes. Lenient (defaults fill gaps). */
export const updateTenantAiSettingsInputSchema = aiSettingsSchema;
export type UpdateTenantAiSettingsInput = z.infer<typeof updateTenantAiSettingsInputSchema>;
export const updateTenantAiSettingsOutputSchema = z.object({
  ok: z.literal(true),
  settings: aiSettingsSchema,
});
export type UpdateTenantAiSettingsOutput = z.infer<typeof updateTenantAiSettingsOutputSchema>;
