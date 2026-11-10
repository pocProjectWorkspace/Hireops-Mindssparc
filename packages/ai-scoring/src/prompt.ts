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
 *
 * PC-6 (prompt `pc6-v1`): the same call now also returns per-criterion
 * screening EVIDENCE (`criteria`: verdict + reason + verbatim CV quotes), which
 * the drain verifies (./screening-evidence.ts) and stores in
 * application_screening_evidence. The score stays for ordering / back-compat.
 * PP6 fixed: the model now sees the FULL JD (capped at JD_CHAR_CAP), not its
 * first 500 characters. The candidate block is the rendered CV text between
 * explicit markers — the only text a quote may be copied from — and carries no
 * contact details, location or spoken languages.
 */

import { z } from "zod";
import type { ParserOutput } from "@hireops/ai-client";
import {
  SCREENING_VERDICTS,
  renderCvForScreening,
  type ScreeningCriterion,
} from "./screening-evidence";

// ai-03-v1 → ai-03-v2 (CONF-03, optional grading-emphasis block) → pc6-v1
// (PC-6: full JD, screening criteria + verbatim-quote evidence in the same
// call, CV rendered as quotable text). The emphasis block is still opt-in:
// rendered only for a NON-default weight profile.
export const AI_SCORING_PROMPT_VERSION = "pc6-v1";

/**
 * The JD is sent whole up to this many characters (PP6 — it used to be cut at
 * 500, so the model never saw most requirements). 12k chars ≈ 3k tokens.
 */
export const JD_CHAR_CAP = 12_000;

/** Delimiters around the CV text. No digits, so PII masking never touches them. */
export const CV_BLOCK_BEGIN = "----- BEGIN CV -----";
export const CV_BLOCK_END = "----- END CV -----";

const screeningCriterionResponseSchema = z.object({
  criterion_key: z.string(),
  verdict: z.enum(SCREENING_VERDICTS),
  reason: z.string(),
  quotes: z.array(z.string()),
});

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
  // PC-6: per-criterion evidence. Defaults to [] on parse so a response
  // without it (an older fixture) still scores — every criterion then reads
  // "unclear" rather than failing the whole application.
  criteria: z.array(screeningCriterionResponseSchema).default([]),
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
  /** The JD body. Sent whole up to JD_CHAR_CAP (see composeScreeningJd). */
  jdDescription: string | null;
  jdSkills: JdSkillInput[];
  parsedCv: ParserOutput;
  /**
   * PC-6 — the criteria to assess (buildScreeningCriteria). Omitted → the
   * required jd_skills alone, in the order given.
   */
  criteria?: ScreeningCriterion[];
  /**
   * Optional grading-emphasis guidance. When present and non-empty the prompt
   * renders an explicit "weight your judgement toward these categories"
   * block. The drain passes this only for a NON-default weight profile.
   */
  scoringWeights?: ScoringEmphasisInput[];
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

/**
 * The JD text the screener sees: the stored jd_text, with the summary put in
 * front when jd_text does not already contain it (seeded / imported JDs often
 * carry the substance only in `summary`). Capped at JD_CHAR_CAP.
 */
export function composeScreeningJd(jdText: string | null, summary: string | null): string | null {
  const body = jdText?.trim() ?? "";
  const sum = summary?.trim() ?? "";
  const joined = sum && !body.includes(sum) ? (body ? `${sum}\n\n${body}` : sum) : body;
  if (!joined) return null;
  return joined.length > JD_CHAR_CAP ? joined.slice(0, JD_CHAR_CAP) : joined;
}

/**
 * The CV block out of a built (and possibly PII-masked) user prompt — exactly
 * the text the model was shown, and therefore the text quotes are verified
 * against. Null if the markers are missing.
 */
export function extractCvBlock(user: string): string | null {
  const start = user.indexOf(`${CV_BLOCK_BEGIN}\n`);
  const end = user.indexOf(`\n${CV_BLOCK_END}`, start);
  if (start === -1 || end === -1) return null;
  return user.slice(start + CV_BLOCK_BEGIN.length + 1, end);
}

const KIND_LABEL: Record<ScreeningCriterion["kind"], string> = {
  must_have: "must-have skill",
  requirement: "required qualification",
};

/**
 * Build the system + user messages for the AI scoring call. Returns
 * plain strings — the AI client wrapper handles provider-specific
 * envelope shape. Caller passes `aiScoringResponseSchema` as the
 * structured-output schema.
 */
export function buildAIScoringPrompt(input: BuildAIScoringPromptInput): BuiltPrompt {
  const system =
    "You are an experienced recruiter screening a candidate's CV against a specific role. " +
    "Judge ONLY job-relevant evidence written in the CV. Never consider, infer or mention age, gender, " +
    "race, ethnicity, caste, nationality, religion, marital or family status, disability, health, or any " +
    "other protected characteristic, and never draw conclusions from names, places or institutions as " +
    "proxies for them. Return a JSON object only — no prose, no explanation outside the JSON.";

  const jdBody = input.jdDescription
    ? input.jdDescription.slice(0, JD_CHAR_CAP).trim()
    : "(no JD body provided)";

  const skillBullets = input.jdSkills
    .map(
      (s) =>
        `  - ${s.skillName} (weight: ${s.weight}, ${s.isRequired ? "required" : "nice-to-have"})`,
    )
    .join("\n");
  const skillsBlock = input.jdSkills.length > 0 ? skillBullets : "  (no required skills listed)";

  const criteria: ScreeningCriterion[] =
    input.criteria ??
    input.jdSkills
      .filter((s) => s.isRequired)
      .map((s, i) => ({ key: `mh-${i + 1}`, kind: "must_have" as const, label: s.skillName }));
  const criteriaBlock =
    criteria.length > 0
      ? criteria.map((c) => `  - ${c.key} [${KIND_LABEL[c.kind]}]: ${c.label}`).join("\n")
      : "  (no screening criteria defined for this requisition — return an empty criteria array)";

  const cvText = renderCvForScreening(input.parsedCv) || "(nothing could be extracted from the CV)";

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
    "- Job description:",
    jdBody,
    "",
    "Screening criteria (assess EVERY one, by key):",
    criteriaBlock,
    "",
    "Candidate parsed CV:",
    "The text between the markers is the ONLY information about the candidate. Every quote you",
    "return must be copied from it exactly.",
    CV_BLOCK_BEGIN,
    cvText,
    CV_BLOCK_END,
    ...emphasisLines,
    "",
    "For each screening criterion return one entry in `criteria`:",
    '  - criterion_key: the exact key shown above (e.g. "mh-1").',
    '  - verdict: "met" (the CV clearly shows it), "partially_met" (the CV shows part of it,',
    '    or a close but weaker equivalent), "not_met" (the CV covers the relevant area and this',
    '    is absent or contradicted), or "unclear" (the CV does not say enough to tell).',
    "  - reason: one factual sentence about what the CV does or does not show.",
    "  - quotes: 0-2 short excerpts copied character-for-character from the CV text between the",
    "    markers. No paraphrase, no joining two passages, no added words. A met or partially_met",
    "    verdict without a verbatim quote will be treated as unclear.",
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "score": <number 0-100>,',
    '  "top_factors": [',
    '    { "factor": "skills_match" | "experience_level" | "education" | "industry_relevance" | "other",',
    '      "score": <0-1>,',
    '      "note": "<one sentence>" }',
    "  ],   // 2-4 factors",
    '  "caveats": [<short note>, ...],  // 0-3 items',
    '  "criteria": [',
    '    { "criterion_key": "<key>", "verdict": "met" | "partially_met" | "not_met" | "unclear",',
    '      "reason": "<one sentence>", "quotes": ["<verbatim CV excerpt>", ...] }',
    "  ]   // one per screening criterion",
    "}",
  ].join("\n");

  return { system, user };
}
