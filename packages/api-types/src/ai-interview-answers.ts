/**
 * AI-INT-2 (build plan N4.4) — WHAT DID THE CANDIDATE SAY, PER QUESTION.
 *
 * AI-INT-3 moved this module here from apps/workers/src/lib so the API's
 * recruiter evidence read can show the SAME answer text the evidence drain
 * grounded its quotes in (the api cannot import from apps/workers). The
 * worker path re-exports it unchanged; one implementation, two readers.
 *
 * Pure: no db, no io, no client. The evidence drain loads the session's
 * `turn_state`, the frozen `questions` and (for voice rounds) the stored
 * `interview_transcripts.segments`; this module turns those into one answer
 * per question — the ONLY text the evidence prompt is ever grounded in, and
 * the text every quote is verified against afterwards.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW A SPOKEN ANSWER IS RECOVERED
 * ─────────────────────────────────────────────────────────────────────────
 * An AI round is ONE cumulative recording (0119: one round, one recording),
 * and `turn_state.answers[].startMs/endMs` are offsets into it — the same
 * millisecond vocabulary `interview_transcripts.segments` uses. So a voice
 * answer is the transcript segments that OVERLAP its window:
 *
 *     segment.endMs > answer.startMs && segment.startMs < answer.endMs
 *
 * ordered by start, text joined with single spaces. Strict inequalities, so a
 * segment that merely touches a boundary (ends exactly where the next answer
 * starts) belongs to one side only. A segment the ASR vendor stretched across
 * a boundary belongs to BOTH answers — there are no word timings to split it
 * on, and duplicating a sentence into the neighbouring answer is the honest
 * failure (a reviewer sees it twice) where dropping it would be the silent one.
 *
 * `answerStartMs` is the FIRST overlapping segment's start — what the review
 * surface seeks to when a recruiter clicks an answer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * "UNAVAILABLE" IS A FACT ABOUT THE PIPELINE, NEVER ABOUT THE CANDIDATE
 * ─────────────────────────────────────────────────────────────────────────
 * A voice answer whose words cannot be recovered — the transcript failed, or
 * the browser never reported where the answer sits on the recording — gets
 * `text: null` and `transcriptUnavailable: true`. It is NOT rendered as an
 * empty answer: the candidate spoke, the platform lost it, and the evidence
 * report must say exactly that rather than imply silence.
 */

import type { AiInterviewQuestion } from "./ai-interview";
import type { ScorecardCriterion } from "./procedures";

/** One diarised turn, exactly as `interview_transcripts.segments` stores it. */
export interface EvidenceTranscriptSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * The subset of `turn_state.answers[]` the evidence pass reads.
 *
 * MIRRORS `AiInterviewAnswerRecord` / `coerceTurnState` in
 * apps/api/src/lib/ai-interview-session.ts rather than importing them: this
 * package cannot depend on the api app. If the turn_state shape moves, move
 * both — `version: 1` on the stored object is the branch point.
 */
export interface EvidenceAnswerRecord {
  questionKey: string;
  mode: "voice" | "typed";
  startMs: number | null;
  endMs: number | null;
  text: string | null;
}

/**
 * The stored `turn_state` → its answers, tolerating anything malformed (an
 * entry that does not parse is dropped, as `coerceTurnState` does — a
 * half-understood answer is not evidence).
 */
export function coerceEvidenceAnswers(turnState: unknown): EvidenceAnswerRecord[] {
  if (!turnState || typeof turnState !== "object" || Array.isArray(turnState)) return [];
  const raw = (turnState as Record<string, unknown>).answers;
  if (!Array.isArray(raw)) return [];
  const out: EvidenceAnswerRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const a = item as Record<string, unknown>;
    if (typeof a.questionKey !== "string") continue;
    if (a.mode !== "voice" && a.mode !== "typed") continue;
    out.push({
      questionKey: a.questionKey,
      mode: a.mode,
      startMs: typeof a.startMs === "number" && Number.isFinite(a.startMs) ? a.startMs : null,
      endMs: typeof a.endMs === "number" && Number.isFinite(a.endMs) ? a.endMs : null,
      text: typeof a.text === "string" ? a.text : null,
    });
  }
  return out;
}

export interface SlicedVoiceAnswer {
  /** Overlapping segments' text, joined with spaces. Null when nothing overlaps. */
  text: string | null;
  /** The first overlapping segment's startMs — the click-to-seek target. */
  firstStartMs: number | null;
}

/**
 * The transcript segments that overlap [startMs, endMs], as one string.
 * See the module header for the overlap rule and why it is strict.
 */
export function sliceVoiceAnswer(
  segments: readonly EvidenceTranscriptSegment[],
  startMs: number,
  endMs: number,
): SlicedVoiceAnswer {
  const overlapping = segments
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.endMs > startMs && s.startMs < endMs)
    // Stable: equal starts keep their stored order.
    .sort((a, b) => a.s.startMs - b.s.startMs || a.i - b.i)
    .map(({ s }) => s);

  const parts = overlapping.map((s) => s.text.trim()).filter((t) => t.length > 0);
  const first = overlapping[0];
  if (parts.length === 0 || !first) return { text: null, firstStartMs: null };
  return { text: parts.join(" "), firstStartMs: first.startMs };
}

/** One question with the candidate's answer to it, as the evidence pass sees it. */
export interface AssembledAnswer {
  questionKey: string;
  prompt: string;
  rubricKey: string;
  /** The rubric label, or the key itself when the round's rubric lacks it. */
  rubricLabel: string;
  /** Null when the candidate never answered this question. */
  answerMode: "voice" | "typed" | null;
  /** The answer's words. Null = no usable text (see transcriptUnavailable). */
  text: string | null;
  /** voice only — see sliceVoiceAnswer. */
  answerStartMs: number | null;
  /** A spoken answer whose words could not be recovered. */
  transcriptUnavailable: boolean;
}

/**
 * Pair every question (in the frozen order) with its answer.
 *
 * `segments` is null when the round has no usable transcript — every voice
 * answer is then `transcriptUnavailable`. Typed answers never depend on it.
 *
 * Duplicate answer records for one question: the LAST wins, matching the
 * turn state's append order (the most recent capture is the one that stood).
 */
export function assembleAnswers(args: {
  questions: readonly AiInterviewQuestion[];
  answers: readonly EvidenceAnswerRecord[];
  segments: readonly EvidenceTranscriptSegment[] | null;
  rubric: readonly ScorecardCriterion[];
}): AssembledAnswer[] {
  const byKey = new Map<string, EvidenceAnswerRecord>();
  for (const a of args.answers) byKey.set(a.questionKey, a);
  const labelOf = new Map(args.rubric.map((c) => [c.key, c.label]));

  return args.questions.map((q) => {
    const base = {
      questionKey: q.key,
      prompt: q.prompt,
      rubricKey: q.rubricKey,
      rubricLabel: labelOf.get(q.rubricKey) ?? q.rubricKey,
    };
    const answer = byKey.get(q.key);
    if (!answer) {
      return {
        ...base,
        answerMode: null,
        text: null,
        answerStartMs: null,
        transcriptUnavailable: false,
      };
    }

    if (answer.mode === "typed") {
      const text = answer.text?.trim() ?? "";
      return {
        ...base,
        answerMode: "typed",
        text: text.length > 0 ? text : null,
        answerStartMs: null,
        transcriptUnavailable: false,
      };
    }

    // voice
    const { startMs, endMs } = answer;
    if (args.segments === null || startMs === null || endMs === null || endMs <= startMs) {
      return {
        ...base,
        answerMode: "voice",
        text: null,
        answerStartMs: null,
        transcriptUnavailable: true,
      };
    }
    const sliced = sliceVoiceAnswer(args.segments, startMs, endMs);
    return {
      ...base,
      answerMode: "voice",
      // Nothing overlapping is NOT "unavailable": the transcript exists and
      // simply holds no speech in this window.
      text: sliced.text,
      answerStartMs: sliced.firstStartMs,
      transcriptUnavailable: false,
    };
  });
}
