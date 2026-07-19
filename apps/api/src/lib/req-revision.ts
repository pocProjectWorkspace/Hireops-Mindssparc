/**
 * Requisition revision-suggestions prompt + schema (RO-01). Real-AI companion
 * for the requirement-owner persona — same honest pattern as req-feasibility /
 * comp-recommendation.
 *
 * `generateReqRevisionSuggestions` (in the tRPC surface) calls the tenant's
 * configured LLM through @hireops/ai-client's `completeStructured` (NODE_ENV=test
 * → LocalAIClient fixtures) to produce 3–5 CONCRETE revision suggestions for a
 * REJECTED requisition. The prompt is built HONESTLY from real inputs only: the
 * rejection reason text, the req's own fields (title, seniority, location, budget
 * band, skills), and the matching curated `market_benchmarks` row. The system
 * prompt FORBIDS inventing market data, citing external sources, and referencing
 * ANY demographic attribute. Nothing auto-applies — the suggestions are advisory
 * and the requirement owner resubmits through the normal edit path.
 *
 * This module owns the AI-facing concerns (JSON schema, prompt text, version
 * stamp) as pure builders so ro-01-req-revision.test.ts can reconstruct the exact
 * prompt to seed a LocalAIClient fixture (the technique the req-feasibility /
 * comp-recommendation tests use). MONEY: budget arrives in MAJOR units (rupees).
 */

import { z } from "zod";
import { reqRevisionAiSchema } from "@hireops/api-types";

export const REQ_REVISION_PROMPT_VERSION = "ro-01-v1";

/** Structured-output tool name for the forced-tool-use path. */
export const REQ_REVISION_SCHEMA_NAME = "req_revision_suggestions";

/** The feature label recorded on every ai_usage_logs row this path writes. */
export const REQ_REVISION_FEATURE = "req_revision";

const SKILL_CAP = 30;
const TRENDING_CAP = 20;

/** JSON-schema form handed to the AI client's structured-output call. */
export const reqRevisionJsonSchema = z.toJSONSchema(reqRevisionAiSchema, {
  target: "draft-2020-12",
});

export interface RevisionSkillContext {
  skillName: string;
  weight: number;
  isRequired: boolean;
}

/** The matched benchmark, in MAJOR currency units (rupees). */
export interface RevisionBenchmarkInput {
  roleTitle: string;
  medianSalaryMajor: number;
  currency: string;
  ttfDays: number;
  availability: string;
  competitorDemand: string;
  trendingSkills: string[];
}

export interface BuildReqRevisionPromptInput {
  positionTitle: string;
  seniority: string | null;
  locationType: string;
  primaryLocation: string | null;
  /** Comp band in MAJOR units (rupees). Nullable. */
  compBandMinMajor: number | null;
  compBandMaxMajor: number | null;
  compCurrency: string | null;
  skills: RevisionSkillContext[];
  /** The HR-head rejection reason — the primary grounding for the suggestions. */
  rejectionReason: string | null;
  /** null → honest "no benchmark" mode. */
  benchmark: RevisionBenchmarkInput | null;
}

export interface BuiltReqRevisionPrompt {
  system: string;
  user: string;
}

function formatMajor(amount: number, currency: string): string {
  return `${currency} ${Math.round(amount).toLocaleString("en-IN")}`;
}

/**
 * Build the system + user messages for the revision-suggestions call. Pure —
 * returns plain strings; the AI client wrapper owns the provider envelope. The
 * caller passes `reqRevisionJsonSchema` as the structured-output schema and
 * `REQ_REVISION_SCHEMA_NAME` as the schema name.
 */
export function buildReqRevisionPrompt(input: BuildReqRevisionPromptInput): BuiltReqRevisionPrompt {
  const system =
    "You are a pragmatic talent-acquisition advisor helping a hiring manager REVISE a " +
    "requisition that an HR head REJECTED, so it can be resubmitted successfully. Produce " +
    "3 to 5 CONCRETE, actionable revision suggestions. Ground EVERY suggestion strictly in: " +
    "the rejection reason, the requisition's own fields (budget, skills, seniority, location), " +
    "and the curated market benchmark you are given. Do NOT invent market data, do NOT cite " +
    "external sources, and NEVER infer or reference any demographic attribute of candidates. " +
    "When no benchmark is provided, reason from the requisition + rejection reason alone and do " +
    "not fabricate market numbers. Each suggestion has an `area` (one of budget, skills, " +
    "seniority, location, scope, other), a short `title`, and an actionable `detail`. Address " +
    "the rejection reason directly. Return a JSON object only — no prose outside the JSON.";

  const skillBullets = input.skills
    .slice(0, SKILL_CAP)
    .map(
      (s) =>
        `  - ${s.skillName} (${s.isRequired ? "must-have" : "nice-to-have"}, weight ${s.weight})`,
    )
    .join("\n");
  const skillsBlock = input.skills.length > 0 ? skillBullets : "  (none specified)";

  const currency = input.compCurrency ?? input.benchmark?.currency ?? "INR";
  const budgetLine =
    input.compBandMinMajor != null && input.compBandMaxMajor != null
      ? `${formatMajor(input.compBandMinMajor, currency)} – ${formatMajor(input.compBandMaxMajor, currency)} per year`
      : "(no comp band set on the position)";

  const lines: string[] = [
    "Revise this REJECTED requisition so it can be resubmitted for approval.",
    "",
    "REJECTION REASON (from the HR head — the primary thing to address)",
    input.rejectionReason && input.rejectionReason.trim().length > 0
      ? `- ${input.rejectionReason.trim()}`
      : "- (no explicit reason was recorded; infer likely gaps from the fields below)",
    "",
    "REQUISITION",
    `- Title: ${input.positionTitle}`,
    `- Seniority: ${input.seniority ?? "(unspecified)"}`,
    `- Location: ${input.locationType}${input.primaryLocation ? ` — ${input.primaryLocation}` : ""}`,
    `- Budget (comp band): ${budgetLine}`,
    "- Key skills:",
    skillsBlock,
    "",
  ];

  if (input.benchmark) {
    const b = input.benchmark;
    lines.push(
      "MARKET BENCHMARK (curated reference data for the closest role)",
      `- Benchmark role: ${b.roleTitle}`,
      `- Market median salary: ${formatMajor(b.medianSalaryMajor, b.currency)} per year`,
      `- Typical time-to-fill: ${b.ttfDays} days`,
      `- Talent availability: ${b.availability}`,
      `- Competitor demand: ${b.competitorDemand}`,
      `- Trending skills for this role: ${
        b.trendingSkills.slice(0, TRENDING_CAP).join(", ") || "(none listed)"
      }`,
    );
  } else {
    lines.push(
      "MARKET BENCHMARK",
      "- No curated benchmark exists for this role. Reason from the requisition + rejection",
      "  reason alone and state the absence of benchmark data where relevant.",
    );
  }

  lines.push(
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "suggestions": [',
    '    { "area": "budget|skills|seniority|location|scope|other",',
    '      "title": "<short imperative title>",',
    '      "detail": "<1-3 sentence concrete, actionable revision grounded in the inputs>" }',
    "  ]",
    "}",
    "Provide between 3 and 5 suggestions.",
  );

  return { system, user: lines.join("\n") };
}
