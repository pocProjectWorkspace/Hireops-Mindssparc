/**
 * N4.2 — the wire + storage contract for `ai_interview_sessions.questions`.
 *
 * `packages/db/src/schema/ai-interview-sessions.ts` stores `questions` as
 * jsonb and describes it as "an ordered array, one entry per question, each
 * carrying the question text AND THE RUBRIC KEY IT PROBES". This file is that
 * shape, and it lands here rather than beside the prompt because it is a WIRE
 * contract: the generation call writes it, the recruiter's review screen
 * (N4.3) reads it, the candidate surface (N4.3) walks it one question at a
 * time, and the evidence report (N4.4) joins on its `rubricKey`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY `rubricKey` IS THE LOAD-BEARING FIELD
 * ─────────────────────────────────────────────────────────────────────────
 * It is not decoration and it is not free text. It names a criterion in
 * `interviews.scorecard_criteria_snapshot` (0102) — the resolved, ordered
 * [{key,label}] a HUMAN panellist is scored against on that same round,
 * frozen at schedule time. Reusing that vocabulary instead of inventing a
 * parallel one is what lets the evidence report speak in the same terms as a
 * human scorecard.
 *
 * The consequence is that a key which does not exist on the round is not a
 * cosmetic defect: it is a question whose evidence has nowhere to land, and it
 * would surface in N4.4 as a rubric line that silently never gets covered. So
 * the generation path VALIDATES every key against the round's rubric and
 * discards the whole set if one does not match, rather than storing it and
 * discovering the mismatch two tickets downstream. The schema here cannot do
 * that check (it has no rubric to check against) — it only guarantees the
 * field is present and shaped like a key.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NOTE THE ABSENCE — the same one the table and 0116 declare
 * ─────────────────────────────────────────────────────────────────────────
 * A question carries text and a rubric key. It carries NO score, NO weight,
 * NO difficulty, NO "ideal answer", NO "what good looks like", NO model
 * answer and NO pass mark, and `.strict()` is what makes that enforceable
 * rather than merely intended. An ideal-answer field is an answer key: the
 * next ticket would grade against it, and the platform's position is that the
 * AI round produces EVIDENCE while a human advances or rejects (GDPR Art. 22,
 * EU AI Act Annex III). Questions probe; humans judge. A future ticket must
 * not read this omission as a gap to fill.
 */

import { z } from "zod";

/**
 * How many questions one AI round asks.
 *
 * The floor is 5 because all four code-default rubrics
 * (`SCORECARD_CRITERIA`) carry exactly five criteria, and a set smaller than
 * the rubric guarantees a criterion the round never had a chance to cover —
 * which reads in the evidence report as a gap in the CANDIDATE rather than in
 * the question set. The ceiling is 10 because an async answer runs ~2–3
 * minutes of recorded speech, so ten questions is a ~30-minute first round:
 * the same duration the build plan's §6 costs ASR against, and about as much
 * unattended recording as it is fair to ask of a candidate.
 *
 * These bound BOTH the model's output and what may be stored, so a settings
 * change or a chatty provider cannot land a 40-question round in a jsonb
 * column nobody re-reads.
 */
export const AI_INTERVIEW_QUESTION_COUNT_MIN = 5;
export const AI_INTERVIEW_QUESTION_COUNT_MAX = 10;

/** A single question's text budget. Long enough for a scenario stem, short
 * enough that a candidate can hold it in their head while recording. */
export const AI_INTERVIEW_QUESTION_PROMPT_MAX = 600;

/**
 * One question in the frozen set.
 *
 * `key` is assigned SERVER-SIDE (`q1`, `q2`, …) rather than by the model. It
 * is the stable id N4.3's turn state and N4.4's evidence rows point at, so it
 * must be predictable and collision-free; a model-chosen slug is neither.
 * Ordering is the array's, not the key's — the key exists to be referenced,
 * not sorted on.
 *
 * `rubricKey` matches `scorecard_criteria_snapshot[].key`, which 0102 writes
 * from `ScorecardCriterion.key` — snake_case identifiers like
 * `technical_depth`. The pattern is enforced here so a label ("Technical
 * depth") can never be stored where a key belongs.
 */
export const aiInterviewQuestionSchema = z
  .object({
    key: z.string().regex(/^q[1-9][0-9]*$/),
    prompt: z.string().min(1).max(AI_INTERVIEW_QUESTION_PROMPT_MAX),
    rubricKey: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/),
  })
  .strict();
export type AiInterviewQuestion = z.infer<typeof aiInterviewQuestionSchema>;

/**
 * The whole `questions` column.
 *
 * EMPTY IS NOT VALID, unlike `interview_transcripts.segments`. The row is
 * created BY the generation call, so an empty array could only ever be a lie
 * — the table header says exactly that about the NOT NULL with no default.
 */
export const aiInterviewQuestionsSchema = z
  .array(aiInterviewQuestionSchema)
  .min(1)
  .max(AI_INTERVIEW_QUESTION_COUNT_MAX);
export type AiInterviewQuestions = z.infer<typeof aiInterviewQuestionsSchema>;

/**
 * A stored `questions` jsonb coerced back to the typed shape, tolerating a
 * malformed value (returns []). The `coerceScorecardCriteria` posture: a read
 * path must not throw because a row written by an older shape went stale, and
 * the caller can tell "no questions" from "questions" perfectly well.
 */
export function coerceAiInterviewQuestions(value: unknown): AiInterviewQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: AiInterviewQuestion[] = [];
  for (const item of value) {
    const parsed = aiInterviewQuestionSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * The session status ladder, mirroring `ai_interview_sessions_status_check`.
 * Kept in lockstep with the CHECK by hand — the 0119 header's reasoning for
 * text + CHECK over a pgEnum (HANDOVER reality #114) applies to the zod side
 * too: a stale enum here means the API rejects what the database accepts.
 */
export const AI_INTERVIEW_SESSION_STATUSES = [
  "draft",
  "approved",
  "issued",
  "in_progress",
  "submitted",
  "expired",
  "cancelled",
] as const;
export const aiInterviewSessionStatusSchema = z.enum(AI_INTERVIEW_SESSION_STATUSES);
export type AiInterviewSessionStatus = z.infer<typeof aiInterviewSessionStatusSchema>;

/**
 * The session as the API hands it to the recruiter's review screen.
 *
 * `rubric` rides along deliberately. Every question names a criterion by KEY,
 * and a reviewer needs the LABEL to judge whether the question actually
 * probes what it claims to — resolving that mapping in the browser would mean
 * a second round trip whose answer could disagree with the one the questions
 * were validated against.
 *
 * The approval legs (`approvedByMembershipId` / `approvedByName` /
 * `approvedAt` / `questionsFrozenAt`) are on the wire because they are the
 * point of the surface: a human's name against the question set a candidate
 * was asked is precisely the fact a regulator or a rejected candidate would
 * ask about, and it should be visible rather than only auditable.
 *
 * `model` / `promptVersion` stamp the GENERATION call. They are nullable
 * because the columns are.
 *
 * There is no score, rating or recommendation field here either. See the
 * header.
 */
export const aiInterviewSessionCardSchema = z.object({
  sessionId: z.string().uuid(),
  interviewId: z.string().uuid(),
  status: aiInterviewSessionStatusSchema,
  questions: aiInterviewQuestionsSchema,
  /** The round's resolved rubric — what `questions[].rubricKey` points into. */
  rubric: z.array(z.object({ key: z.string(), label: z.string() })),
  questionsFrozenAt: z.string().nullable(),
  approvedByMembershipId: z.string().uuid().nullable(),
  approvedByName: z.string().nullable(),
  approvedAt: z.string().nullable(),
  /** Generation provenance — the model that answered, not the one requested. */
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AiInterviewSessionCard = z.infer<typeof aiInterviewSessionCardSchema>;
