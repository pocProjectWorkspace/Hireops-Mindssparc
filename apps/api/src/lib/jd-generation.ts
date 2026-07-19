/**
 * JD generation prompt + response schema (REQ-02).
 *
 * The requisition wizard's "Generate with AI" step calls the tenant's
 * configured LLM through `@hireops/ai-client`'s `completeStructured`, the
 * same pluggable path AI scoring and the agent draft executor use. Structured
 * output — strict JSON schema, no free-form prose — so the sections land in a
 * predictable shape the UI can render + edit.
 *
 * The `jd_versions` schema models a single `jd_text` blob plus a `summary`
 * column and an `ai_metadata` jsonb. We keep the structured sections
 * (summary / responsibilities / requirements) in `ai_metadata.sections` so
 * the wizard can edit them field-by-field, and render them down into the
 * canonical `jd_text` blob (what downstream scoring + the apply page read)
 * via `composeJdText`.
 *
 * Prompt version is stamped into `ai_metadata.prompt_version` so a later
 * prompt evolution is traceable across the historical JD corpus. Bump
 * `JD_GENERATION_PROMPT_VERSION` whenever the prompt text or response shape
 * changes meaningfully.
 *
 * Exported pure builders (`buildJdGenerationPrompt`, `jdGenerationResponseSchema`)
 * so the req-02 test can reconstruct the exact prompt + schema and hash them
 * to seed a LocalAIClient fixture (mirrors the AI-03 scoring test).
 */

import { z } from "zod";

export const JD_GENERATION_PROMPT_VERSION = "req-02-v1";

/** Bounds so the prompt input can't balloon regardless of caller state. */
const SKILL_CAP = 30;
const CONTEXT_CHAR_CAP = 2000;

/** Structured-output tool name for the Anthropic forced-tool-use path. */
export const JD_GENERATION_SCHEMA_NAME = "job_description";

/** The feature label recorded on every ai_usage_logs row this path writes. */
export const JD_GENERATION_FEATURE = "jd_generation";

/**
 * The JD the model must return. Bounded arrays + string lengths keep a
 * runaway generation from producing an unusable wall of text and keep the
 * structured-output schema strict.
 */
export const jdGenerationResponseSchema = z.object({
  summary: z.string().min(1).max(1200),
  responsibilities: z.array(z.string().min(1).max(400)).min(3).max(10),
  requirements: z.array(z.string().min(1).max(400)).min(3).max(10),
});

export type JdGenerationResponse = z.infer<typeof jdGenerationResponseSchema>;

/** JSON-schema form handed to the AI client's structured-output call. */
export const jdGenerationResponseJsonSchema = z.toJSONSchema(jdGenerationResponseSchema, {
  target: "draft-2020-12",
});

export interface JdSkillContext {
  skillName: string;
  weight: number;
  isRequired: boolean;
}

export interface BuildJdGenerationPromptInput {
  positionTitle: string;
  locationType: string;
  primaryLocation: string | null;
  seniority: string | null;
  employmentType: string | null;
  companyName: string;
  skills: JdSkillContext[];
  /** Optional free-text steer from the hiring manager. */
  extraContext: string | null;
}

export interface BuiltJdPrompt {
  system: string;
  user: string;
}

/**
 * Build the system + user messages for the JD generation call. Pure — returns
 * plain strings; the AI client wrapper owns the provider envelope. The caller
 * passes `jdGenerationResponseJsonSchema` as the structured-output schema and
 * `JD_GENERATION_SCHEMA_NAME` as the schema name.
 */
export function buildJdGenerationPrompt(input: BuildJdGenerationPromptInput): BuiltJdPrompt {
  const system =
    "You are an experienced technical recruiter and hiring manager writing a clear, " +
    "inclusive job description for a real open role. Write in plain, specific language. " +
    "No hype, no discriminatory or age/gender-coded phrasing, no invented compensation " +
    "numbers. Return a JSON object only — no prose outside the JSON.";

  const skillBullets = input.skills
    .slice(0, SKILL_CAP)
    .map(
      (s) =>
        `  - ${s.skillName} (${s.isRequired ? "must-have" : "nice-to-have"}, weight ${s.weight})`,
    )
    .join("\n");
  const skillsBlock = input.skills.length > 0 ? skillBullets : "  (none specified yet)";

  const extra = input.extraContext
    ? input.extraContext.slice(0, CONTEXT_CHAR_CAP).trim()
    : "(none provided)";

  const user = [
    "Write a job description for this role:",
    `- Title: ${input.positionTitle}`,
    `- Company: ${input.companyName}`,
    `- Seniority: ${input.seniority ?? "(unspecified)"}`,
    `- Employment type: ${input.employmentType ?? "(unspecified)"}`,
    `- Location type: ${input.locationType}`,
    `- Primary location: ${input.primaryLocation ?? "(unspecified)"}`,
    "- Key skills:",
    skillsBlock,
    `- Extra context from the hiring manager: ${extra}`,
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "summary": "<2-4 sentence overview of the role and its impact>",',
    '  "responsibilities": ["<what the person will do>", ...],  // 3-10 items',
    '  "requirements": ["<what the person needs>", ...]          // 3-10 items',
    "}",
  ].join("\n");

  return { system, user };
}

/**
 * The composable JD shape: the AI-backed core (summary / responsibilities /
 * requirements) plus RO-02's optional manual sections. The AI generator only
 * ever produces the core three; the wizard v2 editor lets the requirement
 * owner add the rest by hand, and they render here when present.
 */
export interface ComposableJdSections extends JdGenerationResponse {
  niceToHave?: string[];
  toolsTech?: string[];
  education?: string[];
  softSkills?: string[];
}

/**
 * Render the structured sections into the canonical `jd_text` blob stored on
 * `jd_versions.jd_text` (what AI scoring + the apply page read). Deterministic
 * so a re-render of unchanged sections produces identical text. RO-02's
 * optional sections are appended only when they carry non-blank items, so a
 * pre-RO-02 (three-section) JD renders byte-identically to before.
 */
export function composeJdText(sections: ComposableJdSections, positionTitle: string): string {
  const lines: string[] = [`# ${positionTitle}`, "", sections.summary, "", "## Responsibilities"];
  for (const r of sections.responsibilities) lines.push(`- ${r}`);
  lines.push("", "## Requirements");
  for (const r of sections.requirements) lines.push(`- ${r}`);

  const extra: [string, string[] | undefined][] = [
    ["Nice to have", sections.niceToHave],
    ["Tools & technology", sections.toolsTech],
    ["Education", sections.education],
    ["Soft skills", sections.softSkills],
  ];
  for (const [heading, items] of extra) {
    const clean = (items ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
    if (clean.length === 0) continue;
    lines.push("", `## ${heading}`);
    for (const item of clean) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}
