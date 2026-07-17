/**
 * AI-assisted JD inclusive-language review (CONF-02).
 *
 * The requisition wizard's optional "Review with AI" button sends the
 * composed JD text through the tenant's configured LLM (`@hireops/ai-client`
 * `completeStructured`, the same pluggable path JD generation + scoring use)
 * asking for inclusive-language OBSERVATIONS that go BEYOND the deterministic
 * lexicon scanner — tone, framing, hidden requirements, culture-fit pressure
 * a fixed word list can't catch.
 *
 * It is ADVISORY ONLY. The output is never a gate: it renders as labelled
 * "AI-assisted" cards the author can act on or ignore. The JD text carries no
 * candidate PII (it is built from position + skills + company), so PII
 * masking does not apply here — mirrors `generateJdDraft`.
 *
 * Pure builders (`buildJdBiasReviewPrompt`, `jdBiasReviewResponseSchema`) so
 * the conf-02 test can reconstruct the exact prompt + schema and hash them to
 * seed a LocalAIClient fixture (same technique as the REQ-02 JD test).
 */

import { z } from "zod";

export const JD_BIAS_REVIEW_PROMPT_VERSION = "conf-02-v1";

/** Structured-output tool name for the Anthropic forced-tool-use path. */
export const JD_BIAS_REVIEW_SCHEMA_NAME = "jd_bias_review";

/** The feature label recorded on every ai_usage_logs row this path writes. */
export const JD_BIAS_REVIEW_FEATURE = "jd_bias_review";

/** Keep the JD input bounded regardless of caller state. */
const JD_CHAR_CAP = 8000;

/**
 * The review the model must return. Bounded so a runaway generation can't
 * produce an unusable wall of cards. An empty `observations` array is a valid,
 * meaningful answer ("nothing flagged").
 */
export const jdBiasReviewResponseSchema = z.object({
  observations: z
    .array(
      z.object({
        excerpt: z.string().min(1).max(300),
        issue: z.string().min(1).max(400),
        suggestion: z.string().min(1).max(400),
      }),
    )
    .max(20),
});
export type JdBiasReviewResponse = z.infer<typeof jdBiasReviewResponseSchema>;

/** JSON-schema form handed to the AI client's structured-output call. */
export const jdBiasReviewResponseJsonSchema = z.toJSONSchema(jdBiasReviewResponseSchema, {
  target: "draft-2020-12",
});

export interface BuildJdBiasReviewPromptInput {
  positionTitle: string;
  jdText: string;
}

export interface BuiltJdBiasReviewPrompt {
  system: string;
  user: string;
}

/**
 * Build the system + user messages for the JD bias review call. Pure —
 * returns plain strings; the AI client wrapper owns the provider envelope.
 */
export function buildJdBiasReviewPrompt(
  input: BuildJdBiasReviewPromptInput,
): BuiltJdBiasReviewPrompt {
  const system =
    "You are an inclusive-hiring editor reviewing a job description for language that could " +
    "unintentionally discourage qualified people from applying — gender-coded wording, age- " +
    "coded phrasing, ableist or nativist requirements, culture-fit vagueness, and hype or " +
    "always-on pressure language. Only flag genuine issues; if the JD is clean, return an empty " +
    "list. Be specific and constructive: quote the exact phrase, say briefly why it may exclude, " +
    "and offer a concrete inclusive rewrite. Do NOT invent problems, do NOT comment on " +
    "compensation, and return a JSON object only — no prose outside the JSON.";

  const jd = input.jdText.slice(0, JD_CHAR_CAP);
  const user = [
    `Review this job description for the role "${input.positionTitle}":`,
    "",
    jd,
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "observations": [',
    '    { "excerpt": "<the exact phrase>", "issue": "<why it may exclude>", "suggestion": "<inclusive rewrite>" }',
    "  ]   // 0-20 items; empty if nothing to flag",
    "}",
  ].join("\n");

  return { system, user };
}
