/**
 * Comp rationale prompt + schema (HROPS-02). Real-AI companion to the
 * deterministic comp rule engine — same honest pattern as req-feasibility.
 *
 * `generateCompRationale` (in the tRPC surface) calls the tenant's configured
 * LLM through @hireops/ai-client's `completeStructured` (NODE_ENV=test →
 * LocalAIClient fixtures) to write a SHORT narrative around a verdict the RULE
 * ENGINE already decided. The prompt is built HONESTLY from real numbers only:
 * the candidate's expected salary, the role's comp band, the deterministic
 * verdict + suggested number, the matching curated market_benchmarks row, and a
 * terse interview-signal summary. The system prompt FORBIDS inventing market
 * data or referencing any demographic attribute, and instructs the model to
 * cite only the numbers it is given and to NOT contradict the verdict.
 *
 * This module owns the AI-facing concerns (JSON schema, prompt text, version
 * stamp) as pure builders so hrops-02.test.ts can reconstruct the exact prompt
 * to seed a LocalAIClient fixture (the technique the req-feasibility / ai-03
 * tests use). MONEY: all amounts arrive in MAJOR units (rupees) — the caller
 * converts paise → major before building the prompt.
 */

import { z } from "zod";
import { compRationaleAiSchema } from "@hireops/api-types";
import type { CompVerdict } from "@hireops/api-types";

export const COMP_RATIONALE_PROMPT_VERSION = "hrops-02-v1";

/** Structured-output tool name for the forced-tool-use path. */
export const COMP_RATIONALE_SCHEMA_NAME = "comp_recommendation";

/** The feature label recorded on every ai_usage_logs row this path writes. */
export const COMP_RATIONALE_FEATURE = "comp_recommendation";

/** JSON-schema form handed to the AI client's structured-output call. */
export const compRationaleJsonSchema = z.toJSONSchema(compRationaleAiSchema, {
  target: "draft-2020-12",
});

export interface CompRationaleBenchmarkInput {
  roleTitle: string;
  medianSalaryMajor: number;
  currency: string;
  availability: string;
  competitorDemand: string;
  sourceNote: string;
}

export interface BuildCompRationalePromptInput {
  candidateName: string;
  roleTitle: string;
  /** Deterministic verdict — the model must NOT contradict it. */
  verdict: CompVerdict;
  /** All money in MAJOR units (rupees per annum). */
  expectedMajor: number;
  bandMinMajor: number;
  bandMidMajor: number;
  bandMaxMajor: number;
  suggestedMajor: number;
  currency: string;
  /** null → honest "no benchmark" mode. */
  benchmark: CompRationaleBenchmarkInput | null;
  /** e.g. ["2× strong_yes", "1× yes"] — empty when no interview feedback. */
  interviewSignal: string[];
}

export interface BuiltCompRationalePrompt {
  system: string;
  user: string;
}

function fmt(amount: number, currency: string): string {
  return `${currency} ${Math.round(amount).toLocaleString("en-IN")}`;
}

const VERDICT_GLOSS: Record<CompVerdict, string> = {
  proceed: "PROCEED — the ask is within band; offer at or near it",
  negotiate: "NEGOTIATE — the ask is in the upper half of the band; meet partway",
  need_approval: "NEED_APPROVAL — the ask exceeds the band ceiling and requires HR-head sign-off",
};

/**
 * Build the system + user messages for the comp-rationale call. Pure — returns
 * plain strings; the AI client wrapper owns the provider envelope. The caller
 * passes `compRationaleJsonSchema` as the structured-output schema and
 * `COMP_RATIONALE_SCHEMA_NAME` as the schema name.
 */
export function buildCompRationalePrompt(
  input: BuildCompRationalePromptInput,
): BuiltCompRationalePrompt {
  const system =
    "You are a compensation partner advising an HR ops recruiter on a single offer. " +
    "A deterministic rule engine has ALREADY decided the verdict; your ONLY job is to " +
    "write a short (2–4 sentence) rationale that explains it in plain language. Reason " +
    "ONLY from the numbers you are given — the expected salary, the comp band, the " +
    "suggested figure, and the curated benchmark. Do NOT invent market data, do NOT cite " +
    "external sources, and NEVER infer or reference any demographic attribute of the " +
    "candidate. Do NOT contradict or override the verdict. When no benchmark is provided, " +
    "say so honestly rather than fabricating a market number. Return a JSON object only " +
    "with a single `rationale` string — no prose outside the JSON.";

  const c = input.currency;
  const lines: string[] = [
    `Write the rationale for this offer decision. Verdict (authoritative): ${VERDICT_GLOSS[input.verdict]}.`,
    "",
    "INPUTS",
    `- Candidate: ${input.candidateName}`,
    `- Role: ${input.roleTitle}`,
    `- Candidate expected salary: ${fmt(input.expectedMajor, c)} per year`,
    `- Role comp band: ${fmt(input.bandMinMajor, c)} (min) · ${fmt(input.bandMidMajor, c)} (mid) · ${fmt(input.bandMaxMajor, c)} (max) per year`,
    `- Suggested offer (from the rule engine): ${fmt(input.suggestedMajor, c)} per year`,
    `- Interview signal: ${input.interviewSignal.length > 0 ? input.interviewSignal.join(", ") : "(no interview feedback on record)"}`,
  ];

  if (input.benchmark) {
    const b = input.benchmark;
    lines.push(
      "",
      "CURATED MARKET BENCHMARK (reference data — not a live feed)",
      `- Benchmark role: ${b.roleTitle}`,
      `- Market median: ${fmt(b.medianSalaryMajor, b.currency)} per year`,
      `- Talent availability: ${b.availability}`,
      `- Competitor demand: ${b.competitorDemand}`,
      `- Source: ${b.sourceNote}`,
    );
  } else {
    lines.push(
      "",
      "CURATED MARKET BENCHMARK",
      "- No curated benchmark matched this role. Reason from the band + expected salary alone",
      "  and state the absence of benchmark data.",
    );
  }

  lines.push(
    "",
    'Return JSON only: { "rationale": "<2-4 sentences explaining the verdict, citing the given numbers only>" }',
  );

  return { system, user: lines.join("\n") };
}
