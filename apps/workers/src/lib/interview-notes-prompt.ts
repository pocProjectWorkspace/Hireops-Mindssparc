/**
 * Interview notes prompt + response schema (N3.3b) — TRANSCRIPT → NOTES.
 *
 * The derivation half of the notetaker chain. N3.3a stops at a transcript;
 * this is what turns one into the structured summary the panellist reads,
 * behind the `interview_notes` feature key (kill switch, model allowlist, BYO
 * key and ai_usage_logs cost attribution all come from that key for free).
 *
 * WHY IT LIVES IN apps/workers RATHER THAN apps/api. The transcript drain is
 * the only caller today, and apps/workers already reaches into apps/api
 * through two narrow subpath exports ("./reports/executive-summary",
 * "./storage") — a debt c14033b flagged explicitly. A third one to buy a
 * builder with a single consumer would deepen it for nothing.
 *
 * PROMOTION PATH, for when there IS a second caller: N3.4's "regenerate
 * notes" procedure will want this from the tRPC surface. At that point lift
 * this file into a shared package (packages/interview-notes, following
 * packages/ai-scoring — pure builders, no db, no io, depended on by BOTH the
 * worker and the api) rather than exporting it out of apps/api. That is the
 * shape ai-scoring already proved for exactly this drain/procedure split.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO PRODUCT STANCES THIS PROMPT ENFORCES (they are not preferences)
 * ─────────────────────────────────────────────────────────────────────────
 * 1. SPEAKER ROLES ARE INFERRED, NEVER ASSUMED. Every ASR adapter emits
 *    anonymous labels (speaker_0, speaker_1) because no vendor can know which
 *    voice is the candidate — packages/api-types/src/interview-transcripts.ts
 *    says so at the schema level and both live adapters honour it. So the
 *    prompt is TOLD the labels are anonymous and asked to infer role from
 *    CONTENT (whoever asks "tell me about your experience with Kafka" is
 *    evidently interviewing). It is never told, and must never guess, that
 *    speaker_0 is the interviewer because it happens to be first.
 *
 * 2. NO SCORE, NO RATING, NO RECOMMENDATION. 0116's header: "Notes assist the
 *    panellist; they never auto-fill a hire/no-hire. That is a product stance,
 *    not an unfinished schema." The prompt forbids one AND the response schema
 *    has nowhere to put one — a model that produced a rating anyway would fail
 *    the strict parse rather than quietly land in a jsonb column. The same
 *    clause extends interview-prep.ts's existing ban on sentiment, confidence,
 *    fluency, personality, psychometric and demographic inference. This is the
 *    GDPR Art. 22 / EU AI Act Annex III posture, and it is a differentiator
 *    rather than a limitation.
 *
 * Pure builders, deliberately: no db, no io, no client. That is what lets the
 * N3.3b test reconstruct the exact prompt (and therefore the LocalAIClient
 * fixture hash) the drain will send — the technique panel-02 / hrops-02 use.
 */

import { z } from "zod";

/**
 * Stamped onto every interview_notes row this prompt produces.
 *
 * BUMP IT WHENEVER THE PROMPT TEXT OR THE RESPONSE SCHEMA CHANGES. Stored
 * rows reference the version that produced them, so a corpus regenerated
 * across a change is still legible: without the bump, two materially
 * different summaries claim the same provenance. Same convention as
 * AI_SCORING_PROMPT_VERSION ("ai-03-v1") and INTERVIEW_PREP_PROMPT_VERSION
 * ("panel-02-v1") — the ticket, then the revision.
 */
export const INTERVIEW_NOTES_PROMPT_VERSION = "n33b-v1";

/** Structured-output tool name for the forced-tool-use path. */
export const INTERVIEW_NOTES_SCHEMA_NAME = "interview_notes";

/**
 * The feature label on every ai_usage_logs row this path writes, and the
 * AI_FEATURE_KEYS entry whose `enabled` flag gates it. NOTE it is a different
 * line from the ASR side's "asr_transcription": transcription is billed per
 * MINUTE and note generation per TOKEN, they sit behind separate switches,
 * and a tenant may legitimately buy transcripts without notes.
 */
export const INTERVIEW_NOTES_FEATURE = "interview_notes";

/**
 * How much transcript text the prompt will carry.
 *
 * A 60-minute interview runs to roughly 9,000 words / 55,000 characters, so
 * 120,000 covers a long panel round with headroom while bounding the token
 * bill of a single call. Past the cap the tail is DROPPED AND SAID SO (see
 * TRUNCATION_NOTICE) rather than silently omitted — a summary of the first
 * two thirds of an interview presented as a summary of the interview would be
 * a quietly false artefact, which is the one failure mode notes cannot have.
 */
const TRANSCRIPT_CHAR_CAP = 120_000;

const TRUNCATION_NOTICE =
  "[TRANSCRIPT TRUNCATED — the tail of this recording is not included above. " +
  "Say so in the summary and do not characterise the parts you cannot see.]";

/** Bounds so the rubric block can't balloon regardless of tenant config. */
const CRITERIA_CAP = 24;
const COMPETENCY_CAP = 16;

/**
 * The model's output — and, just as importantly, the SHAPE OF WHAT IT CANNOT
 * SAY. Five content fields, each mapping 1:1 onto a column 0116 actually
 * created:
 *
 *   summary        → interview_notes.summary        (text)
 *   keyPoints      → interview_notes.key_points     (jsonb)
 *   topicsCovered  → interview_notes.topics_covered (jsonb)
 *   questionsAsked → interview_notes.questions_asked(jsonb)
 *   followUps      → interview_notes.follow_ups     (jsonb)
 *
 * There is no sixth field, and adding one is not a schema tidy-up: `.strict()`
 * is what makes "no rating, no recommendation, no sentiment read" enforceable
 * instead of merely requested. A model that returns `overallRating` fails the
 * parse, the drain records a terminal error, and nothing is written — which is
 * the correct outcome for output the product has no lawful place to put.
 *
 * Bounds are generous but present: an unbounded array is how a jsonb column
 * ends up holding a 900-item "key points" list nobody will read.
 */
export const interviewNotesAiSchema = z
  .object({
    /** Factual recap of what was discussed. Never a verdict on the candidate. */
    summary: z.string().min(1).max(4000),
    /** Concrete things that were actually said, each attributable to the transcript. */
    keyPoints: z.array(z.string().min(1).max(500)).min(1).max(12),
    /** What the conversation covered — rubric criterion labels where they fit. */
    topicsCovered: z.array(z.string().min(1).max(200)).max(20),
    /** Questions the interviewer(s) asked, in the order they were asked. */
    questionsAsked: z.array(z.string().min(1).max(500)).max(30),
    /** Ground left unexplored — a prompt for the panel, never a judgement. */
    followUps: z.array(z.string().min(1).max(500)).max(10),
  })
  .strict();
export type InterviewNotesAiResponse = z.infer<typeof interviewNotesAiSchema>;

/** JSON-schema form handed to the AI client's structured-output call. */
export const interviewNotesAiJsonSchema = z.toJSONSchema(interviewNotesAiSchema, {
  target: "draft-2020-12",
});

/** One diarised turn, exactly as `interview_transcripts.segments` stores it. */
export interface NotesTranscriptSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface BuildInterviewNotesPromptInput {
  /**
   * The diarised turns. PREFERRED over fullText because the anonymous speaker
   * labels are what make role inference possible at all — `full_text` is
   * flattened by both adapters and carries no labels whatsoever.
   */
  segments: NotesTranscriptSegment[];
  /**
   * The flattened transcript. Used ONLY as the fallback when diarisation
   * produced no turns (AssemblyAI can return text with no utterances), which
   * is a real case rather than a defensive one.
   */
  fullText: string;
  /**
   * The round's resolved rubric — interviews.scorecard_criteria_snapshot, the
   * ordered [{key,label}] frozen at schedule time. Empty for rounds scheduled
   * before 0102, and the prompt says "not recorded" rather than inventing one.
   */
  criteria: { key: string; label: string }[];
  /** interview_plans.competency_focus for this round. Often empty. */
  competencyFocus: string[];
}

export interface BuiltInterviewNotesPrompt {
  system: string;
  user: string;
}

/**
 * Build the system + user messages for the note-generation call. Pure —
 * returns plain strings; the AI client wrapper owns the provider envelope.
 * The caller passes `interviewNotesAiJsonSchema` as the structured-output
 * schema and `INTERVIEW_NOTES_SCHEMA_NAME` as the schema name.
 */
export function buildInterviewNotesPrompt(
  input: BuildInterviewNotesPromptInput,
): BuiltInterviewNotesPrompt {
  const system =
    "You are taking notes on a recorded job interview for the panellist who ran it. " +
    "Work ONLY from the transcript below and the round's rubric. Do NOT invent facts " +
    "about the candidate, their employers, the role or the market, and do not assume " +
    "anything that was not said out loud. " +
    // (a) — roles are inferred from content, never from label order.
    "The speaker labels are ANONYMOUS diarisation labels (speaker_0, speaker_1, …). " +
    "They carry NO role information: the transcription vendor cannot know which voice " +
    "is the candidate, and the numbering is arbitrary. INFER who is interviewing and " +
    "who is being interviewed from what each speaker SAYS — whoever asks about " +
    "someone's experience is evidently the interviewer, whoever describes their own " +
    "work is evidently the candidate. Do NOT assume speaker_0 is the interviewer " +
    "because it comes first. Where a turn's role is genuinely unclear, attribute it to " +
    "nobody rather than guessing. Never name a speaker. " +
    // (b) — no verdict, and no inference beyond the words spoken.
    "You must NOT score, rate, rank or recommend. Produce no hire/no-hire signal, no " +
    "numeric or letter grade, no 'strong candidate' style verdict, and no advice on " +
    "whether to advance. Assess nothing: you are recording what was said, not judging " +
    "it. NEVER infer or reference any demographic or protected characteristic (age, " +
    "gender, ethnicity, nationality, accent, religion, disability, family status, " +
    "etc.). Make NO sentiment, emotion, confidence, fluency, personality or " +
    "psychometric claim about anyone — those are inferences beyond the words spoken " +
    "and this product does not make them. Report only demonstrable content: what was " +
    "asked, what was answered, what was covered, what was left open. " +
    "Return a JSON object only — no prose outside the JSON.";

  const lines: string[] = [
    "Write structured notes for this interview round.",
    "",
    "ROUND RUBRIC (what this round was meant to cover — use it to organise the",
    "notes; a criterion the conversation never touched should simply be absent",
    "from topicsCovered, which is itself useful to the panellist):",
    renderCriteria(input.criteria),
    "",
    "COMPETENCY FOCUS FOR THIS ROUND",
    renderCompetencyFocus(input.competencyFocus),
    "",
    "TRANSCRIPT",
    ...renderTranscript(input),
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "summary": "<factual recap of what was discussed — no verdict, no rating>",',
    '  "keyPoints": [ "<something that was actually said>" ],          // 1-12 items',
    '  "topicsCovered": [ "<topic, preferring a rubric label>" ],      // 0-20 items',
    '  "questionsAsked": [ "<question the interviewer asked>" ],       // 0-30 items, in order',
    '  "followUps": [ "<ground left unexplored, for a later round>" ]  // 0-10 items',
    "}",
  ];

  return { system, user: lines.join("\n") };
}

function renderCriteria(criteria: { key: string; label: string }[]): string {
  if (criteria.length === 0) {
    // Rounds scheduled before 0102 have no snapshot. Saying so beats
    // back-filling a plausible-looking rubric the round was never scored on.
    return "  (no rubric recorded for this round)";
  }
  return criteria
    .slice(0, CRITERIA_CAP)
    .map((c) => `  - ${c.label} (${c.key})`)
    .join("\n");
}

function renderCompetencyFocus(focus: string[]): string {
  if (focus.length === 0) return "  (not specified)";
  return `  ${focus.slice(0, COMPETENCY_CAP).join(", ")}`;
}

/**
 * Renders the transcript as a labelled, timestamped dialogue.
 *
 * The labels go in VERBATIM — speaker_0 stays speaker_0. Rewriting them to
 * "Interviewer" / "Candidate" here would be this layer inventing the very
 * provenance the ASR layer refused to invent, and the model would then have no
 * way to tell an inference from a fact.
 */
function renderTranscript(input: BuildInterviewNotesPromptInput): string[] {
  if (input.segments.length === 0) {
    const flat = input.fullText.trim();
    if (flat.length === 0) {
      // The drain never calls with an empty transcript (it completes the row
      // cleanly instead), so this is belt-and-braces rather than a live path.
      return ["(the recording contains no speech)"];
    }
    return [
      "(diarisation produced no speaker turns for this recording — the text below",
      "is the flattened transcript, so you cannot tell the speakers apart at all.",
      "Attribute nothing to a speaker; describe what was discussed.)",
      "",
      ...capped(flat),
    ];
  }

  const body = input.segments
    .map((s) => `[${formatTimestamp(s.startMs)} ${s.speaker}] ${s.text.trim()}`)
    .join("\n");
  return [
    "(Speaker labels are anonymous. Infer roles from what is said — see above.)",
    "",
    ...capped(body),
  ];
}

/** Applies TRANSCRIPT_CHAR_CAP, announcing the cut when it bites. */
function capped(text: string): string[] {
  if (text.length <= TRANSCRIPT_CHAR_CAP) return [text];
  return [text.slice(0, TRANSCRIPT_CHAR_CAP), "", TRUNCATION_NOTICE];
}

/** mm:ss (or h:mm:ss past an hour) from the start of the media. */
function formatTimestamp(startMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(startMs / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
