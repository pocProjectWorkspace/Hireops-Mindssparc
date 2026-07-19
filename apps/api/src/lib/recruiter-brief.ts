/**
 * RECR-03 — recruiter AI-brief prompts + schemas. Real-AI companion to the
 * recruiter AI Brief drawer — same honest pattern as interview-prep.ts /
 * req-revision.ts (getAIClient + completeStructured + usage-log, cost-logged,
 * kill-switchable via the `recruiter_brief` CONF-01 feature key).
 *
 * Exactly THREE grounded prompts, all reasoning ONLY from real inputs — the JD
 * text + skills, the parsed resume, the deterministic skills-match, and the
 * application's own data (stage, expected salary presence). None invents facts,
 * none infers demographic / protected characteristics, none makes any
 * sentiment / psychometric claim:
 *
 *   (a) strengths_risks    — top 3 strengths + 2 risks vs the JD.
 *   (b) screen_script      — a ~10-minute structured phone-screen script.
 *   (c) availability_draft — DRAFT notice-period / availability confirmation
 *       message. DRAFT ONLY — the router returns it for the recruiter to send
 *       through the human/agent-approval path; it is NEVER auto-sent.
 *
 * Pure builders (plain strings) so the test can reconstruct the exact prompt to
 * seed a LocalAIClient fixture (the interview-prep / hrops-02 technique).
 */

import { z } from "zod";
import {
  strengthsRisksAiSchema,
  screenScriptAiSchema,
  availabilityDraftAiSchema,
  type RecruiterBriefKind,
} from "@hireops/api-types";

export const RECRUITER_BRIEF_PROMPT_VERSION = "recr-03-v1";

/** The feature label recorded on every ai_usage_logs row this path writes. */
export const RECRUITER_BRIEF_FEATURE = "recruiter_brief";

/** Structured-output tool names for the forced-tool-use path (per kind). */
export const RECRUITER_BRIEF_SCHEMA_NAME: Record<RecruiterBriefKind, string> = {
  strengths_risks: "recruiter_brief_strengths_risks",
  screen_script: "recruiter_brief_screen_script",
  availability_draft: "recruiter_brief_availability_draft",
};

/** JSON-schema forms handed to the AI client's structured-output call. */
export const recruiterBriefJsonSchema = {
  strengths_risks: z.toJSONSchema(strengthsRisksAiSchema, { target: "draft-2020-12" }),
  screen_script: z.toJSONSchema(screenScriptAiSchema, { target: "draft-2020-12" }),
  availability_draft: z.toJSONSchema(availabilityDraftAiSchema, { target: "draft-2020-12" }),
} satisfies Record<RecruiterBriefKind, unknown>;

/** Bounds so the prompt input can't balloon regardless of caller state. */
const SKILL_CAP = 40;
const HIGHLIGHT_CAP = 12;
const JD_TEXT_CAP = 4000;

export interface RecruiterBriefSkillContext {
  skillName: string;
  isRequired: boolean;
  /** Deterministic resume-vs-JD match for this skill (from computeSkillsMatch). */
  matched: boolean;
}

export interface BuildRecruiterBriefPromptInput {
  candidateName: string | null;
  roleTitle: string;
  stageLabel: string;
  jdText: string | null;
  skills: RecruiterBriefSkillContext[];
  parsedResumeSkills: string[];
  yearsOfExperience: number | null;
  resumeHighlights: string[];
  /** Deterministic weighted coverage % of JD skills (for grounding only). */
  coveragePct: number;
  companyName: string;
}

export interface BuiltRecruiterBriefPrompt {
  system: string;
  user: string;
}

const HONESTY_CLAUSE =
  "Reason ONLY from the facts you are given — the job description and skills, the " +
  "candidate's parsed resume, and the deterministic skills-match. Do NOT invent facts " +
  "about the candidate, their employers, or the market. NEVER infer or reference any " +
  "demographic or protected characteristic (age, gender, ethnicity, nationality, " +
  "religion, disability, family status, etc.). Do NOT make any sentiment, emotion, " +
  "personality, or psychometric claim — assess only demonstrable skills and experience " +
  "relevant to the role. Return a JSON object only — no prose outside the JSON.";

function skillsBlock(skills: RecruiterBriefSkillContext[]): string {
  if (skills.length === 0) return "  (none specified)";
  return skills
    .slice(0, SKILL_CAP)
    .map(
      (s) =>
        `  - ${s.skillName} (${s.isRequired ? "must-have" : "nice-to-have"}; resume match: ${
          s.matched ? "yes" : "no"
        })`,
    )
    .join("\n");
}

function commonContext(input: BuildRecruiterBriefPromptInput): string[] {
  const resumeSkills =
    input.parsedResumeSkills.length > 0
      ? input.parsedResumeSkills.slice(0, SKILL_CAP).join(", ")
      : "(no parsed resume skills on file)";
  const highlights =
    input.resumeHighlights.length > 0
      ? input.resumeHighlights
          .slice(0, HIGHLIGHT_CAP)
          .map((h) => `  - ${h}`)
          .join("\n")
      : "  (none parsed)";

  const lines: string[] = [
    "ROLE",
    `- Role: ${input.roleTitle}`,
    `- Current stage: ${input.stageLabel}`,
    "",
    "CANDIDATE (parsed resume — facts only)",
    `- Name: ${input.candidateName ?? "(withheld)"}`,
    `- Years of experience: ${
      input.yearsOfExperience != null ? input.yearsOfExperience : "(not parsed)"
    }`,
    `- Parsed resume skills: ${resumeSkills}`,
    "- Resume highlights:",
    highlights,
    "",
    "JOB DESCRIPTION — key skills (with deterministic resume match)",
    skillsBlock(input.skills),
    "",
    `DETERMINISTIC SKILLS COVERAGE: ${input.coveragePct}% of weighted JD skills matched.`,
  ];
  if (input.jdText && input.jdText.trim().length > 0) {
    lines.push("", "JOB DESCRIPTION — text", input.jdText.slice(0, JD_TEXT_CAP));
  }
  return lines;
}

/** (a) Summarize top 3 strengths + 2 risks vs the JD. */
export function buildStrengthsRisksPrompt(
  input: BuildRecruiterBriefPromptInput,
): BuiltRecruiterBriefPrompt {
  const system =
    "You are an experienced recruiter writing a quick screening reference. " +
    "Summarise the candidate's TOP 3 strengths and TOP 2 risks strictly relative to " +
    "THIS job description. Each strength/risk is one concise sentence grounded in a " +
    "specific JD skill, resume fact, or a gap the skills-match shows. " +
    HONESTY_CLAUSE;
  const lines = [
    "Summarise this candidate's top 3 strengths and 2 risks vs the JD.",
    "",
    ...commonContext(input),
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "strengths": ["<one sentence>"],  // exactly up to 3, most relevant first',
    '  "risks": ["<one sentence>"]       // exactly up to 2, most material first',
    "}",
  ];
  return { system, user: lines.join("\n") };
}

/** (b) Generate a ~10-minute structured phone-screen script. */
export function buildScreenScriptPrompt(
  input: BuildRecruiterBriefPromptInput,
): BuiltRecruiterBriefPrompt {
  const system =
    "You are an experienced recruiter preparing a structured 10-minute phone screen. " +
    "Produce 3–5 timed sections whose minutes sum to roughly 10, each with 1–4 concrete, " +
    "open questions grounded in the JD skills, the resume, and the gaps the skills-match " +
    "shows. Prefer probing the must-have skills the resume does NOT evidence. " +
    HONESTY_CLAUSE;
  const lines = [
    "Generate a ~10-minute structured phone-screen script for this candidate.",
    "",
    ...commonContext(input),
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "sections": [ { "title": "<short>", "minutes": <int>, "prompts": ["<open question>"] } ]',
    "}",
  ];
  return { system, user: lines.join("\n") };
}

/** (c) Draft a notice-period / availability confirmation message (DRAFT ONLY). */
export function buildAvailabilityDraftPrompt(
  input: BuildRecruiterBriefPromptInput,
): BuiltRecruiterBriefPrompt {
  const system =
    "You are an experienced recruiter drafting a short, warm, professional message to a " +
    "candidate to confirm their notice period, earliest availability / join date, and " +
    "current-vs-expected compensation if not already on file. This is a DRAFT the " +
    "recruiter will review before sending — do NOT claim it has been sent. Keep it under " +
    "150 words, address the candidate by first name if known, sign off from the " +
    `recruitment team at ${input.companyName}. ` +
    HONESTY_CLAUSE;
  const lines = [
    "Draft a notice-period / availability confirmation message for this candidate.",
    "",
    ...commonContext(input),
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "subject": "<email subject>",',
    '  "body": "<message body, plain text, <150 words>"',
    "}",
  ];
  return { system, user: lines.join("\n") };
}

export function buildRecruiterBriefPrompt(
  kind: RecruiterBriefKind,
  input: BuildRecruiterBriefPromptInput,
): BuiltRecruiterBriefPrompt {
  switch (kind) {
    case "strengths_risks":
      return buildStrengthsRisksPrompt(input);
    case "screen_script":
      return buildScreenScriptPrompt(input);
    case "availability_draft":
      return buildAvailabilityDraftPrompt(input);
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      throw new Error(`unknown recruiter brief kind: ${String(kind)}`);
    }
  }
}
