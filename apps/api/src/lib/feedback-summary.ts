/**
 * Scorecard note-summary prompt + schema (PANEL-01). Real-AI companion to the
 * panel scorecard — the honest "Summarise my notes" assist.
 *
 * `summarizeMyFeedbackNotes` (in the tRPC surface) calls the tenant's configured
 * LLM through @hireops/ai-client's `completeStructured` (NODE_ENV=test →
 * LocalAIClient fixtures) to tidy the PANELLIST'S OWN draft text — the
 * strengths, concerns, and free-text notes they have already typed — into
 * clearer prose, returned into the same three editable fields. It is an
 * ephemeral assist: nothing is persisted or submitted here (the panellist
 * reviews/edits, then Save/Submit through the normal path). The system prompt
 * FORBIDS inventing any claim not present in the provided text, rewriting a
 * score/recommendation, or inferring any demographic attribute; it must
 * summarise ONLY the words it is given.
 *
 * This module owns the AI-facing concerns (JSON schema, prompt text, version
 * stamp) as pure builders — the same pattern as comp-recommendation.ts — so
 * panel-01.test.ts can reconstruct the exact prompt if it ever seeds a fixture.
 */

import { feedbackSummarySchema } from "@hireops/api-types";
import { z } from "zod";

export const FEEDBACK_SUMMARY_PROMPT_VERSION = "panel-01-v1";

/** Structured-output tool name for the forced-tool-use path. */
export const FEEDBACK_SUMMARY_SCHEMA_NAME = "feedback_summary";

/** The feature label recorded on every ai_usage_logs row this path writes. */
export const FEEDBACK_SUMMARY_FEATURE = "feedback_summary";

/** JSON-schema form handed to the AI client's structured-output call. */
export const feedbackSummaryJsonSchema = z.toJSONSchema(feedbackSummarySchema, {
  target: "draft-2020-12",
});

export interface BuildFeedbackSummaryPromptInput {
  strengths: string | null;
  concerns: string | null;
  notes: string | null;
}

export interface BuiltFeedbackSummaryPrompt {
  system: string;
  user: string;
}

/**
 * Build the system + user messages for the note-summary call. Pure — returns
 * plain strings; the AI client wrapper owns the provider envelope. The caller
 * passes `feedbackSummaryJsonSchema` as the structured-output schema and
 * `FEEDBACK_SUMMARY_SCHEMA_NAME` as the schema name.
 */
export function buildFeedbackSummaryPrompt(
  input: BuildFeedbackSummaryPromptInput,
): BuiltFeedbackSummaryPrompt {
  const system =
    "You are helping an interview panellist tidy up THEIR OWN interview notes. " +
    "You will be given up to three blocks of text the panellist wrote: strengths, " +
    "concerns, and general notes. Rewrite EACH block into clearer, more concise " +
    "professional prose. Summarise ONLY the text you are given — never add a claim, " +
    "observation, skill, or judgement that is not already present in the panellist's " +
    "words. Do NOT invent or infer anything about the candidate. Do NOT reference or " +
    "infer any demographic attribute (age, gender, ethnicity, nationality, religion, " +
    "disability, or similar). Do NOT assign or mention a score or a hire recommendation. " +
    "Keep the panellist's own meaning and tone. If a block is empty, return an empty " +
    "string for it. Return a JSON object only, with `strengths`, `concerns`, and " +
    "`notes` string fields — no prose outside the JSON.";

  const block = (label: string, text: string | null): string =>
    `${label}:\n${text && text.trim() ? text.trim() : "(none)"}`;

  const user = [
    "Tidy the following interview notes. Keep to the meaning already written.",
    "",
    block("STRENGTHS", input.strengths),
    "",
    block("CONCERNS", input.concerns),
    "",
    block("NOTES", input.notes),
    "",
    'Return JSON only: { "strengths": "...", "concerns": "...", "notes": "..." }',
  ].join("\n");

  return { system, user };
}
