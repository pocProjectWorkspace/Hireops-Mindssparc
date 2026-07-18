/**
 * Requisition feasibility prompt + benchmark matching (HRHEAD-02).
 *
 * `generateRequisitionFeasibility` calls the tenant's configured LLM through
 * @hireops/ai-client's `completeStructured` — the same pluggable path AI
 * scoring / JD generation use (NODE_ENV=test / AI_CLIENT_MODE=local →
 * LocalAIClient fixtures). The prompt is built HONESTLY from real inputs: the
 * requisition's JD skills, the position's comp band, and the matching curated
 * `market_benchmarks` row (or an explicit "no benchmark" mode when no row
 * matches the title). The structured verdict is validated against
 * `feasibilityAssessmentSchema` (api-types) and cached in
 * requisition_feasibility.
 *
 * The response schema lives in api-types (it crosses the wire to the card UI);
 * this module owns the AI-facing concerns: the JSON schema handed to the
 * structured-output call, the prompt text, the prompt version stamp, and the
 * pure fuzzy title matcher. Exported pure builders so hrhead-02.test.ts can
 * reconstruct the exact prompt + schema to seed a LocalAIClient fixture (the
 * same technique the req-02 / ai-03 tests use).
 *
 * MONEY: benchmark medians arrive here in MAJOR units (rupees) — the caller
 * converts the stored paise minor → major before building the prompt — so the
 * prompt and the comp band speak the same units. The card UI does its own
 * minor↔major handling for display.
 */

import { z } from "zod";
import { feasibilityAssessmentSchema } from "@hireops/api-types";

export const REQ_FEASIBILITY_PROMPT_VERSION = "hrhead-02-v1";

/** Structured-output tool name for the Anthropic forced-tool-use path. */
export const REQ_FEASIBILITY_SCHEMA_NAME = "requisition_feasibility";

/** The feature label recorded on every ai_usage_logs row this path writes. */
export const REQ_FEASIBILITY_FEATURE = "req_feasibility";

/** Bounds so the prompt input can't balloon regardless of caller state. */
const SKILL_CAP = 30;
const TRENDING_CAP = 20;

/** JSON-schema form handed to the AI client's structured-output call. */
export const feasibilityAssessmentJsonSchema = z.toJSONSchema(feasibilityAssessmentSchema, {
  target: "draft-2020-12",
});

export interface FeasibilitySkillContext {
  skillName: string;
  weight: number;
  isRequired: boolean;
}

/** The matched benchmark, in MAJOR currency units (rupees). */
export interface FeasibilityBenchmarkInput {
  roleTitle: string;
  medianSalaryMajor: number;
  currency: string;
  ttfDays: number;
  availability: string;
  competitorDemand: string;
  recommendedRounds: number;
  trendingSkills: string[];
}

export interface BuildFeasibilityPromptInput {
  positionTitle: string;
  seniority: string | null;
  locationType: string;
  primaryLocation: string | null;
  /** Comp band in MAJOR units (rupees), straight off the position. Nullable. */
  compBandMinMajor: number | null;
  compBandMaxMajor: number | null;
  compCurrency: string | null;
  skills: FeasibilitySkillContext[];
  /** null → the honest "no benchmark" mode. */
  benchmark: FeasibilityBenchmarkInput | null;
}

export interface BuiltFeasibilityPrompt {
  system: string;
  user: string;
}

function formatMajor(amount: number, currency: string): string {
  // Plain grouped number — the model reasons about magnitude, not locale.
  return `${currency} ${Math.round(amount).toLocaleString("en-IN")}`;
}

/**
 * Build the system + user messages for the feasibility call. Pure — returns
 * plain strings; the AI client wrapper owns the provider envelope. The caller
 * passes `feasibilityAssessmentJsonSchema` as the structured-output schema and
 * `REQ_FEASIBILITY_SCHEMA_NAME` as the schema name.
 */
export function buildRequisitionFeasibilityPrompt(
  input: BuildFeasibilityPromptInput,
): BuiltFeasibilityPrompt {
  const system =
    "You are a pragmatic talent-market analyst advising an enterprise HR head on " +
    "how fillable a requisition is. Reason ONLY from the requisition details and the " +
    "curated market benchmark you are given — do NOT invent market data, and never " +
    "infer or reference any demographic attribute of candidates. When no benchmark is " +
    "provided, say so honestly in your reasoning and lower your confidence rather than " +
    "fabricating numbers. skillsFit and expCompFit are 0–100 integer percentages. " +
    "recommendedSalaryAdjustmentPct is a signed percentage to move the budget toward the " +
    "market median (positive = raise the budget), or null when no change is warranted or " +
    "no benchmark exists. Return a JSON object only — no prose outside the JSON.";

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
    "Assess the feasibility of filling this requisition.",
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
      `- Recommended interview rounds: ${b.recommendedRounds}`,
      `- Trending skills for this role: ${
        b.trendingSkills.slice(0, TRENDING_CAP).join(", ") || "(none listed)"
      }`,
    );
  } else {
    lines.push(
      "MARKET BENCHMARK",
      "- No curated benchmark exists for this role. Assess from the requisition alone,",
      "  state the absence of benchmark data in your recommendation, and set",
      "  recommendedSalaryAdjustmentPct to null.",
    );
  }

  lines.push(
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "skillsFit": <0-100>,                        // how attainable the required skills are in the market',
    '  "expCompFit": <0-100>,                       // how well the budget matches the experience being asked for',
    '  "difficulty": "low" | "medium" | "high",     // overall difficulty to fill',
    '  "recommendedSalaryAdjustmentPct": <number|null>,',
    '  "recommendation": "<2-4 sentence recommendation for the HR head>",',
    '  "supplyNote": "<one sentence on talent supply for this role>"',
    "}",
  );

  return { system, user: lines.join("\n") };
}

/**
 * Fuzzy-match a requisition title to one of the tenant's benchmark role titles.
 * Pure + deterministic. Strategy, in order: exact (normalised) → containment →
 * best token-overlap (Jaccard) above a threshold. Returns the matched
 * candidate's original title, or null when nothing clears the bar (→ the
 * honest no-benchmark mode).
 */
export function matchBenchmarkTitle(
  reqTitle: string,
  benchmarkTitles: readonly string[],
): string | null {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const target = norm(reqTitle);
  if (!target) return null;

  const tokens = (s: string) => new Set(norm(s).split(" ").filter(Boolean));
  const targetTokens = tokens(reqTitle);

  let best: { title: string; score: number } | null = null;
  for (const title of benchmarkTitles) {
    const cand = norm(title);
    if (!cand) continue;
    // Exact normalised match wins immediately.
    if (cand === target) return title;

    let score: number;
    if (cand.includes(target) || target.includes(cand)) {
      score = 0.9;
    } else {
      const candTokens = tokens(title);
      let inter = 0;
      for (const t of targetTokens) if (candTokens.has(t)) inter += 1;
      const union = new Set([...targetTokens, ...candTokens]).size;
      score = union === 0 ? 0 : inter / union;
    }
    if (!best || score > best.score) best = { title, score };
  }

  // Require a meaningful overlap — a single shared "engineer" token shouldn't
  // match "Product Designer" to "Senior Backend Engineer".
  return best && best.score >= 0.5 ? best.title : null;
}
