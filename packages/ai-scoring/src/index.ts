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
  JD_CHAR_CAP,
  CV_BLOCK_BEGIN,
  CV_BLOCK_END,
  buildAIScoringPrompt,
  composeScreeningJd,
  extractCvBlock,
  aiScoringResponseSchema,
  type AIScoringResponse,
  type BuildAIScoringPromptInput,
  type ScoringEmphasisInput,
} from "./prompt";

// PC-6 — evidence-based screening (criteria, CV text, quote verification,
// verdict reconciliation, deterministic ordering).
export {
  SCREENING_VERDICTS,
  MAX_QUOTES_PER_CRITERION,
  CV_TEXT_CHAR_CAP,
  buildScreeningCriteria,
  jdRequirementsFromMetadata,
  renderCvForScreening,
  reconcileScreeningEvidence,
  countScreeningVerdicts,
  screeningSortKey,
  compareScreeningSummaries,
  type ScreeningVerdict,
  type ScreeningCriterion,
  type ScreeningCriterionKind,
  type ScreeningCriterionEvidence,
  type ScreeningEvidenceCounts,
  type RawScreeningCriterion,
  type ReconciledScreeningEvidence,
} from "./screening-evidence";

// Verbatim-quote matcher shared with the AI-interview evidence engine.
export { normaliseForQuoteMatch, cleanQuote, isVerbatimQuote } from "./quote-verify";
