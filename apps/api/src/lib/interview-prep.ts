/**
 * Interview prep prompt + schema (PANEL-02). Real-AI companion to the panel
 * candidate brief — same honest pattern as req-feasibility / comp-rationale.
 *
 * `generateInterviewPrep` (in the tRPC surface) calls the tenant's configured
 * LLM through @hireops/ai-client's `completeStructured` (NODE_ENV=test /
 * AI_CLIENT_MODE=local → LocalAIClient fixtures) to suggest what a panellist
 * should probe in THIS round. The prompt is built HONESTLY from real inputs
 * only: the JD text + skills, the parsed resume (skills + years of experience),
 * prior-round recommendations + qualitative strengths/concerns (NEVER numeric
 * scores — the anti-anchoring convention), and the round objective. The system
 * prompt FORBIDS inventing facts, inferring any demographic / protected
 * characteristic, and making any sentiment or psychometric claim.
 *
 * This module owns the AI-facing concerns (JSON schema, prompt text, version
 * stamp) as pure builders so panel-02.test.ts can reconstruct the exact prompt
 * to seed a LocalAIClient fixture (the technique the req-feasibility /
 * comp-rationale tests use).
 */

import { z } from "zod";
import { interviewPrepAiSchema } from "@hireops/api-types";

export const INTERVIEW_PREP_PROMPT_VERSION = "panel-02-v1";

/** Structured-output tool name for the forced-tool-use path. */
export const INTERVIEW_PREP_SCHEMA_NAME = "interview_prep";

/** The feature label recorded on every ai_usage_logs row this path writes. */
export const INTERVIEW_PREP_FEATURE = "interview_prep";

/** Bounds so the prompt input can't balloon regardless of caller state. */
const SKILL_CAP = 40;
const PRIOR_CAP = 10;
const JD_TEXT_CAP = 4000;

/** JSON-schema form handed to the AI client's structured-output call. */
export const interviewPrepAiJsonSchema = z.toJSONSchema(interviewPrepAiSchema, {
  target: "draft-2020-12",
});

export interface PrepSkillContext {
  skillName: string;
  isRequired: boolean;
}

/** Prior-round qualitative signal — recommendation + text, NEVER scores. */
export interface PrepPriorRound {
  roundNumber: number;
  roundName: string;
  recommendation: string | null;
  strengths: string | null;
  concerns: string | null;
}

export interface BuildInterviewPrepPromptInput {
  candidateName: string | null;
  roleTitle: string;
  roundName: string;
  /** The round's competency focus (the "round objective"). May be empty. */
  competencyFocus: string[];
  jdText: string | null;
  skills: PrepSkillContext[];
  parsedResumeSkills: string[];
  yearsOfExperience: number | null;
  priorRounds: PrepPriorRound[];
}

export interface BuiltInterviewPrepPrompt {
  system: string;
  user: string;
}

/**
 * Build the system + user messages for the interview-prep call. Pure — returns
 * plain strings; the AI client wrapper owns the provider envelope. The caller
 * passes `interviewPrepAiJsonSchema` as the structured-output schema and
 * `INTERVIEW_PREP_SCHEMA_NAME` as the schema name.
 */
export function buildInterviewPrepPrompt(
  input: BuildInterviewPrepPromptInput,
): BuiltInterviewPrepPrompt {
  const system =
    "You are an experienced interview coach helping a panellist prepare for ONE " +
    "interview round. Reason ONLY from the facts you are given — the job description " +
    "and skills, the candidate's parsed resume, the prior-round recommendations and " +
    "qualitative notes, and the round objective. Do NOT invent facts about the " +
    "candidate, their employers, or the market. NEVER infer or reference any " +
    "demographic or protected characteristic (age, gender, ethnicity, nationality, " +
    "religion, disability, family status, etc.). Do NOT make any sentiment, emotion, " +
    "personality, or psychometric claim about the candidate — assess only demonstrable " +
    "skills and experience relevant to the role. Produce 3–5 focus areas to probe " +
    "(each a short title plus one or two sentences on WHY it matters for this round, " +
    "grounded in a gap or strength you can point to) and 6–8 concrete, open probing " +
    "questions a panellist can ask. Prefer areas the prior rounds flagged as concerns " +
    "or left unexplored. Return a JSON object only — no prose outside the JSON.";

  const skillBullets = input.skills
    .slice(0, SKILL_CAP)
    .map((s) => `  - ${s.skillName} (${s.isRequired ? "must-have" : "nice-to-have"})`)
    .join("\n");
  const skillsBlock = input.skills.length > 0 ? skillBullets : "  (none specified)";

  const resumeSkills =
    input.parsedResumeSkills.length > 0
      ? input.parsedResumeSkills.slice(0, SKILL_CAP).join(", ")
      : "(no parsed resume skills on file)";

  const lines: string[] = [
    "Prepare a panellist for this interview round.",
    "",
    "ROUND",
    `- Role: ${input.roleTitle}`,
    `- This round: ${input.roundName}`,
    `- Round objective (competencies this round owns): ${
      input.competencyFocus.length > 0 ? input.competencyFocus.join(", ") : "(not specified)"
    }`,
    "",
    "CANDIDATE (parsed resume — facts only)",
    `- Name: ${input.candidateName ?? "(withheld)"}`,
    `- Years of experience: ${input.yearsOfExperience != null ? input.yearsOfExperience : "(not parsed)"}`,
    `- Parsed resume skills: ${resumeSkills}`,
    "",
    "JOB DESCRIPTION — key skills",
    skillsBlock,
  ];

  if (input.jdText && input.jdText.trim().length > 0) {
    lines.push("", "JOB DESCRIPTION — text", input.jdText.slice(0, JD_TEXT_CAP));
  }

  if (input.priorRounds.length > 0) {
    lines.push(
      "",
      "PRIOR ROUNDS (recommendation + qualitative notes only — numeric scores are",
      "deliberately withheld to avoid anchoring; do NOT ask for or infer them):",
    );
    for (const p of input.priorRounds.slice(0, PRIOR_CAP)) {
      lines.push(
        `- Round ${p.roundNumber} (${p.roundName}): recommendation ${p.recommendation ?? "n/a"}`,
        `    Strengths: ${p.strengths?.trim() || "(none recorded)"}`,
        `    Concerns: ${p.concerns?.trim() || "(none recorded)"}`,
      );
    }
  } else {
    lines.push("", "PRIOR ROUNDS", "- None on record — this is the first round with feedback.");
  }

  lines.push(
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "focusAreas": [ { "title": "<short title>", "why": "<1-2 sentences grounded in the inputs>" } ],  // 3-5 items',
    '  "probingQuestions": [ "<open question>" ]                                                          // 6-8 items',
    "}",
  );

  return { system, user: lines.join("\n") };
}
