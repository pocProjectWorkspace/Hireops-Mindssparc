/**
 * AI fit-scoring prompt + response schema (AI-03).
 *
 * Single user-message prompt to the tenant's configured AI provider
 * (currently Anthropic; OpenAI follows the same shape). Structured
 * output via `completeStructured` from `@hireops/ai-client` — strict
 * JSON schema, no free-form text.
 *
 * Prompt version is recorded on every successful score in
 * `applications.ai_score_explanation.prompt_version` so prompt
 * evolutions can be tracked across the historical scoring corpus
 * without re-running everything. Bump `AI_SCORING_PROMPT_VERSION`
 * whenever the prompt text or response shape changes meaningfully.
 */

import { z } from "zod";
import type { ParserOutput } from "@hireops/ai-client";

// ai-03-v2 (CONF-03): the builder can now render an optional grading-emphasis
// block driven by the per-tenant scoring weight profile. When no weights are
// passed (a tenant at the incumbent defaults), the prompt is byte-identical to
// ai-03-v1 — the emphasis block is opt-in, so default-profile scores are
// unchanged.
export const AI_SCORING_PROMPT_VERSION = "ai-03-v2";

/** Caps applied to the prompt to keep inputs bounded. */
const SKILL_CAP = 50;
const WORK_HISTORY_CAP = 3;
const JD_DESCRIPTION_CHAR_CAP = 500;

export const aiScoringResponseSchema = z.object({
  score: z.number().min(0).max(100),
  top_factors: z
    .array(
      z.object({
        factor: z.enum([
          "skills_match",
          "experience_level",
          "education",
          "industry_relevance",
          "other",
        ]),
        score: z.number().min(0).max(1),
        note: z.string().min(1).max(500),
      }),
    )
    .min(2)
    .max(4),
  caveats: z.array(z.string().min(1).max(500)).max(3),
});

export type AIScoringResponse = z.infer<typeof aiScoringResponseSchema>;

export interface JdSkillInput {
  skillName: string;
  weight: number;
  isRequired: boolean;
}

/**
 * One grading-emphasis category (CONF-03). `weight` is an integer 0–100; the
 * caller (the scoring drain) passes the resolved per-tenant profile ONLY when
 * it is non-default. Shape kept as a plain object rather than importing the
 * canonical type from `@hireops/api-types` so this package stays dependency-
 * light; the drain owns the api-types round-trip.
 */
export interface ScoringEmphasisInput {
  key: string;
  label: string;
  weight: number;
}

export interface BuildAIScoringPromptInput {
  positionTitle: string;
  jdDescription: string | null;
  jdSkills: JdSkillInput[];
  parsedCv: ParserOutput;
  /**
   * Optional grading-emphasis guidance. When present and non-empty the prompt
   * renders an explicit "weight your judgement toward these categories"
   * block; when omitted the prompt is byte-identical to ai-03-v1. The drain
   * passes this only for a NON-default weight profile, so default-profile
   * tenants score exactly as before CONF-03.
   */
  scoringWeights?: ScoringEmphasisInput[];
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

/**
 * Build the system + user messages for the AI scoring call. Returns
 * plain strings — the AI client wrapper handles provider-specific
 * envelope shape. Caller passes `aiScoringResponseSchema` as the
 * structured-output schema.
 */
export function buildAIScoringPrompt(input: BuildAIScoringPromptInput): BuiltPrompt {
  const system =
    "You are an experienced technical recruiter evaluating a candidate's fit for a specific role. " +
    "Read the job context and the candidate's parsed CV, then return a JSON object only — no prose, no explanation outside the JSON.";

  const jdSummary = input.jdDescription
    ? input.jdDescription.slice(0, JD_DESCRIPTION_CHAR_CAP).trim()
    : "(no JD body provided)";

  const skillBullets = input.jdSkills
    .map(
      (s) =>
        `  - ${s.skillName} (weight: ${s.weight}, ${s.isRequired ? "required" : "nice-to-have"})`,
    )
    .join("\n");
  const skillsBlock = input.jdSkills.length > 0 ? skillBullets : "  (no required skills listed)";

  const p = input.parsedCv;
  const candidateSkills = p.skills.technical.slice(0, SKILL_CAP).join(", ") || "(none extracted)";
  const yoe = p.total_years_experience !== null ? `${p.total_years_experience}` : "(unknown)";
  const currentRoleLine = p.current_role
    ? `${p.current_role.title} at ${p.current_role.company}`
    : "(between roles)";
  const topEdu = p.education[0];
  const eduLine = topEdu
    ? `${topEdu.degree} — ${topEdu.institution}${topEdu.field_of_study ? ` (${topEdu.field_of_study})` : ""}`
    : "(none extracted)";
  const workLines = p.work_history
    .slice(0, WORK_HISTORY_CAP)
    .map(
      (w, i) =>
        `  ${i + 1}. ${w.title} at ${w.company} (${w.start_date} → ${w.end_date ?? "present"})`,
    )
    .join("\n");
  const workBlock = workLines || "  (none extracted)";

  // CONF-03: optional grading-emphasis guidance. Rendered only when the caller
  // passes a non-default weight profile. This is INSTRUCTION, not arithmetic —
  // the model is asked to lean its holistic judgement toward these categories
  // in roughly this proportion; it does not compute a weighted sum.
  const weights = input.scoringWeights?.filter((w) => Number.isFinite(w.weight)) ?? [];
  const emphasisLines: string[] =
    weights.length > 0
      ? [
          "",
          "Grading emphasis (guidance, not a formula): this team weights fit toward the",
          "following categories in roughly this proportion. Lean your overall judgement",
          "accordingly — you are an evaluator applying emphasis, NOT a calculator summing",
          "sub-scores:",
          ...weights.map((w) => `  - ${w.label}: ${w.weight}%`),
        ]
      : [];

  const user = [
    "Job context:",
    `- Title: ${input.positionTitle}`,
    "- Required skills (with weights):",
    skillsBlock,
    `- JD summary: ${jdSummary}`,
    "",
    "Candidate parsed CV:",
    `- Years of experience: ${yoe}`,
    `- Current role: ${currentRoleLine}`,
    `- Skills: ${candidateSkills}`,
    `- Education: ${eduLine}`,
    "- Work history (most recent):",
    workBlock,
    ...emphasisLines,
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "score": <number 0-100>,',
    '  "top_factors": [',
    '    { "factor": "skills_match" | "experience_level" | "education" | "industry_relevance" | "other",',
    '      "score": <0-1>,',
    '      "note": "<one sentence>" }',
    "  ],   // 2-4 factors",
    '  "caveats": [<short note>, ...]  // 0-3 items',
    "}",
  ].join("\n");

  return { system, user };
}
