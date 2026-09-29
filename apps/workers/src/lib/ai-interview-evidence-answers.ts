/**
 * AI-INT-2 (build plan N4.4) — WHAT DID THE CANDIDATE SAY, PER QUESTION.
 *
 * The implementation moved to `@hireops/api-types` (ai-interview-answers.ts)
 * in AI-INT-3, so the API's recruiter evidence read shows exactly the answer
 * text this drain grounds its quotes in. This path stays as a re-export so
 * the drain, the prompt, the verifier and their tests keep their imports.
 */

export {
  assembleAnswers,
  coerceEvidenceAnswers,
  sliceVoiceAnswer,
  type AssembledAnswer,
  type EvidenceAnswerRecord,
  type EvidenceTranscriptSegment,
  type SlicedVoiceAnswer,
} from "@hireops/api-types";
