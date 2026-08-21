/**
 * N3.3a — the validation contract for `interview_transcripts.segments`.
 *
 * `packages/db/src/schema/interview-transcripts.ts` stores `segments` as jsonb
 * and states that the payload is "validated by the api-types zod schema, as
 * interview_prep does". This file is that schema. It lands here rather than in
 * the worker because the shape is a WIRE contract, not a worker detail: the
 * transcript drain writes it, and the panel-side read path (and N3.3b's
 * summariser) read it back.
 *
 * WHY IT MATTERS MORE THAN THE USUAL ZOD PARSE. jsonb accepts literally any
 * JSON. Nothing in the database rejects `segments: {"oops": true}` or a
 * segment whose `endMs` precedes its `startMs`. There is exactly one writer
 * (the drain) and exactly one chance to get it right, because a transcript is
 * insert-once — the UNIQUE on (tenant_id, interview_id) means a malformed blob
 * is permanent until a human deletes the row and re-runs a paid ASR job. So
 * the drain validates BEFORE the insert and fails the outbox row terminally
 * rather than persisting something the read path will trip over later.
 *
 * SPEAKER IS A LABEL, NOT A ROLE. Every ASR adapter emits `speaker_0`,
 * `speaker_1`, … — diarisation tells you "these turns came from the same
 * voice" and never "this voice is the candidate". The schema deliberately does
 * NOT constrain the value to a role vocabulary; mapping a label to a panellist
 * is a later step with a human in the loop.
 */

import { z } from "zod";

/**
 * One diarised turn. Mirrors `ASRSegment` in @hireops/ai-client exactly — that
 * interface is the producer side, this is the persisted/validated side, and
 * the two are kept 1:1 on purpose so the drain needs no translation layer.
 *
 * STRICT, deliberately. Both live adapters (AssemblyAI, Deepgram) map their
 * vendor payloads down to exactly these four fields, so an unexpected key
 * means an adapter started leaking vendor shape into a column that is supposed
 * to survive a provider swap without a migration. Better to fail the one row
 * loudly than to accrete provider-specific keys nobody validates.
 *
 * Bounds:
 *  - `speaker` is capped at 120 chars — a diarisation label, not free text.
 *  - `startMs`/`endMs` are non-negative integer milliseconds from the start of
 *    the media, and `endMs >= startMs` (a turn cannot end before it begins).
 *  - `text` may not be empty: both adapters already filter empty turns, so an
 *    empty one is a mapping bug rather than silence.
 *
 * NOT enforced: monotonic ordering ACROSS segments. Overlapping speech is real
 * — two people talking at once legitimately produces a segment that starts
 * before its predecessor ended — and rejecting it would fail a valid recording.
 */
export const transcriptSegmentSchema = z
  .object({
    speaker: z.string().min(1).max(120),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    text: z.string().min(1),
  })
  .strict()
  .refine((s) => s.endMs >= s.startMs, {
    message: "segment endMs must not precede startMs",
    path: ["endMs"],
  });
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

/**
 * The whole `segments` column.
 *
 * EMPTY IS VALID. A recording of a meeting nobody spoke in transcribes to zero
 * segments, and both adapters return `[]` for it rather than throwing. That is
 * a true (if useless) transcript, and failing the outbox row over it would
 * turn "the room was silent" into an ops alert that no retry can clear.
 */
export const transcriptSegmentsSchema = z.array(transcriptSegmentSchema);
export type TranscriptSegments = z.infer<typeof transcriptSegmentsSchema>;

/**
 * The transcript as the API hands it to a reader — the wire shape for the
 * panel-side surface and the input N3.3b's summariser is grounded in.
 *
 * Nullability tracks the columns: `language` / `provider` / `provider_model` /
 * `word_count` are nullable in 0116 because they are provenance of a call that
 * may have reported none of them, while `segments` and `full_text` are NOT
 * NULL — a transcript without them is not a transcript.
 *
 * `fullText` is stored rather than recomputed from `segments` (see the table
 * header): the summariser prompt has to be byte-stable across reruns, so the
 * flattening happens once, at write time, and everything downstream reads the
 * same string.
 */
export const interviewTranscriptCardSchema = z.object({
  interviewId: z.string().uuid(),
  recordingId: z.string().uuid(),
  segments: transcriptSegmentsSchema,
  fullText: z.string(),
  language: z.string().nullable(),
  /** ASR-side provenance — distinct from interview_notes' LLM provenance. */
  provider: z.string().nullable(),
  providerModel: z.string().nullable(),
  wordCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string().nullable(),
});
export type InterviewTranscriptCard = z.infer<typeof interviewTranscriptCardSchema>;

/**
 * N3.4b — the NOTES as the API hands them to a reader, alongside the
 * transcript card above because the two are read together and by the same
 * people.
 *
 * The five content fields map 1:1 onto the columns 0116 created, and there is
 * no sixth: no score, no rating, no recommendation. That omission is repeated
 * here rather than assumed, because this is the layer a UI reads — if a wire
 * shape had somewhere to put a verdict, a surface would eventually render one
 * next to the `strong_yes | yes | hold | no` control the panellist is supposed
 * to fill in themselves. The table header, the prompt and this schema all say
 * the same thing on purpose.
 *
 * ARRAYS ARE NON-NULL HERE while the columns are nullable. A model that
 * returned no follow-ups and a row written before a section existed are the
 * same thing to a reader — "nothing to show" — and making every consumer
 * handle `null` as well as `[]` buys nothing. `summary` stays nullable
 * because absent prose is visibly different from empty prose.
 *
 * `model` / `promptVersion` / `generatedAt` are the LLM-side provenance and
 * they are on the wire DELIBERATELY: notes are a derived artefact and the
 * person reading them has to be able to tell that at a glance, with the
 * ability to see which model and which prompt revision produced them. They
 * are nullable because the columns are.
 */
export const interviewNotesCardSchema = z.object({
  interviewId: z.string().uuid(),
  /** The transcript these notes were derived from — the provenance leg. */
  transcriptId: z.string().uuid(),
  summary: z.string().nullable(),
  keyPoints: z.array(z.string()),
  topicsCovered: z.array(z.string()),
  questionsAsked: z.array(z.string()),
  followUps: z.array(z.string()),
  /** LLM-side provenance — distinct from the transcript's ASR provenance. */
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  generatedAt: z.string().nullable(),
  // NOTE: no score / rating / recommendation field, deliberately. See above.
});
export type InterviewNotesCard = z.infer<typeof interviewNotesCardSchema>;
