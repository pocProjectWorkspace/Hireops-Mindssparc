/**
 * @hireops/ai-scoring — AI-03.
 *
 * Two evaluations on application submit:
 *   1. Knockout eval — synchronous, deterministic, no AI call.
 *      `evaluateKnockouts(parsedCv, knockouts)` returns the verdict
 *      and a structured failure list.
 *   2. Fit scoring — async, AI call. The prompt builder + result
 *      typings live in ./prompt.ts; the worker that orchestrates
 *      the call lives in apps/workers (close to the outbox poller).
 */

export {
  evaluateKnockouts,
  getByPath,
  type KnockoutInput,
  type KnockoutEvaluation,
  type KnockoutFailureEntry,
  type KnockoutFailureReason,
  type KnockoutType,
  type KnockoutResult,
} from "./knockouts";

export {
  AI_SCORING_PROMPT_VERSION,
  buildAIScoringPrompt,
  aiScoringResponseSchema,
  type AIScoringResponse,
  type BuildAIScoringPromptInput,
  type ScoringEmphasisInput,
} from "./prompt";
