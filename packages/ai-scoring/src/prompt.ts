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

export const AI_SCORING_PROMPT_VERSION = "ai-03-v1";

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

export interface BuildAIScoringPromptInput {
  positionTitle: string;
  jdDescription: string | null;
  jdSkills: JdSkillInput[];
  parsedCv: ParserOutput;
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
    .map((s) => `  - ${s.skillName} (weight: ${s.weight}, ${s.isRequired ? "required" : "nice-to-have"})`)
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
