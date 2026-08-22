/**
 * N4.3a — the AI first round as the CANDIDATE experiences it: issuing the
 * link, the disclosure, the consent, one question at a time, per-answer
 * capture, and the submit that hands the round to the transcript pipeline.
 *
 * N4.2 stopped at a recruiter having approved a frozen question set. This is
 * everything between that approval and `transcript_outbox`. The tRPC side of
 * it is one procedure (`issueSession`); everything else is called from the
 * UNAUTHENTICATED routes in `apps/api/src/routes/interviews.ts`, where the
 * signed link is the only authorisation there is.
 *
 * Client shape follows interview-media-upload.ts / ai-interview-questions.ts:
 * a postgres.js tagged-template client (ctx.sql, the service-role pool) with
 * an EXPLICIT tenant_id predicate on every statement, because that client
 * BYPASSES RLS. The one deliberate exception is `loadSessionByTokenHash`,
 * which cannot carry a tenant predicate — resolving the tenant FROM the token
 * hash is the whole point of the unauthenticated surface, exactly as
 * `loadInterviewByHash` does it for the confirm route.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE CANDIDATE IS ALLOWED TO SEE
 * ─────────────────────────────────────────────────────────────────────────
 * ONE QUESTION. The one they are on, and never the ones after it. This is not
 * a UI preference that a "load them all and hide the rest" implementation
 * could satisfy more cheaply: a candidate who can read ahead is being
 * interviewed under materially different conditions from one who cannot, and
 * two candidates on the same requisition would then be producing evidence
 * that is not comparable. The question set is walked server-side and the
 * unanswered remainder never leaves this process.
 *
 * NEVER `rubricKey`. It is internal scoring vocabulary — the criterion a
 * HUMAN panellist is scored against on the same round (0102) — and telling a
 * candidate which box an answer is being filed under is handing them the
 * marking scheme one level up from the "ideal answer" field the schema
 * already refuses to have. `toCandidateQuestion` is the only place a stored
 * question is turned into something wire-bound, and it copies two fields.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A DECLINE ENDS THE ROUND — and why that is not the same refusal a
 * human round gives
 * ─────────────────────────────────────────────────────────────────────────
 * `RECORDING_CONSENT_DISCLOSURE` (N2a) promises, correctly for a human round,
 * that "the interview goes ahead exactly the same way if you say no". That
 * sentence is FALSE here and must not be shown here: this round IS the
 * recording. There is no interviewer to proceed without it and no artefact
 * left if it is refused. So this surface carries its OWN disclosure copy and
 * its own version stamp (`AI_INTERVIEW_DISCLOSURE`), and a decline is
 * answered honestly — the round stops, nothing is kept, the decision is on
 * the record where a recruiter can see it, and a human picks it up.
 *
 * What this module deliberately does NOT do is quietly fall back to a
 * text-only round when consent is refused. Running an unrecorded variant of a
 * round the candidate declined is a different product decision — one about
 * what a candidate is agreeing to — and it is not this ticket's to make.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MEDIA CONTRACT: ONE OBJECT PER ROUND, UPLOADED CUMULATIVELY
 * ─────────────────────────────────────────────────────────────────────────
 * 0119 is explicit that ONE AI round produces ONE `interview_recordings` row
 * and that per-question boundaries live in `interview_transcripts.segments`,
 * which carries startMs/endMs. The N3.3 drain reads exactly one
 * `storage_key`, fetches exactly one object and hands exactly one buffer to
 * the ASR client. So the round's audio has to be ONE object.
 *
 * THE OBVIOUS DESIGN — one object per answer, concatenated on submit — DOES
 * NOT WORK, and its failure mode is the worst kind. A WebM/Matroska file is
 * an EBML header followed by one Segment, and an MP4 is a moov/mdat pair;
 * appending a second complete file of either kind produces a stream whose
 * demuxer reads the FIRST answer and stops. Nothing throws. The transcript
 * would simply be one answer long, the evidence report would show every other
 * rubric line as "not covered", and a recruiter would read that as a fact
 * about the CANDIDATE. Those two containers are what Chrome/Edge and Safari
 * actually produce from `MediaRecorder`, so this is the normal path, not an
 * edge case. Concatenation is only well-defined for chained Ogg and for
 * frame-aligned MP3, neither of which we can require of a browser.
 * Transcoding needs ffmpeg, which the API does not have and which is not this
 * ticket's to add.
 *
 * So the contract is the one `MediaRecorder` makes natural anyway: ONE
 * recorder runs for the whole round, and at each answer boundary the browser
 * uploads the blob of EVERYTHING RECORDED SO FAR to the SAME key. Each
 * checkpoint is a complete, valid, self-contained file; the last one is the
 * round. Per-answer boundaries are reported as millisecond offsets into that
 * single timeline and stored in `turn_state` — the same startMs/endMs
 * vocabulary the transcript segments already use.
 *
 * The contract is ENFORCED, not documented and hoped for: a checkpoint whose
 * object is SMALLER than the previous one means the browser uploaded only the
 * latest answer, which would silently discard everything before it, and
 * `recordAnswer` refuses it. `roundAudio: 'cumulative'` is on the wire so
 * N4.3b cannot get it wrong by accident.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AN ALL-TYPED ROUND ENQUEUES NOTHING
 * ─────────────────────────────────────────────────────────────────────────
 * The typed fallback is a first-class answer mode (build plan §8 decision 2 —
 * it is also the accessibility answer and the bad-bandwidth answer), and a
 * candidate may legitimately type every answer. Then there is no audio, and
 * submit creates NO recording row and NO outbox row: enqueueing an empty
 * recording would burn a drain claim and an ASR call to discover nothing, and
 * would leave a recording row asserting the existence of media that does not
 * exist. The answers are in `turn_state`, with their mode on each one, which
 * is where N4.4 reads them from.
 *
 * RECORDING THE MODE PER ANSWER IS NOT BOOKKEEPING. An evidence report built
 * on a typed answer must never be described as something the candidate said
 * aloud — the two are different evidence about different things, and the
 * distinction has to survive into the report.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EXPIRY IS STAMPED LAZILY, ON ACCESS
 * ─────────────────────────────────────────────────────────────────────────
 * There is no sweep. Every entry point below calls `expireIfLapsed` first,
 * which moves an `issued`/`in_progress` session past `expires_at` to
 * `expired` and then refuses. The reason to prefer it over a scheduled job is
 * that the REFUSAL never depends on the job having run: a sweep that is late,
 * wedged or unregistered would leave a lapsed session accepting answers,
 * whereas a lazy check cannot be out of date because it runs on the same
 * request that would have accepted them. The cost is that a session nobody
 * ever opens keeps `status = 'issued'` with a past `expires_at`, which reads
 * honestly — "issued, never opened" — and which any recruiter surface can
 * render from `expires_at` without needing the status to have caught up.
 *
 * The signed link and the session share ONE expiry instant, minted together
 * in `issueSession`, so `verifyLink`'s own expiry and this one cannot drift
 * into disagreeing about whether a round is still open.
 */

import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { hashToken, signLink } from "@hireops/notifications";
import {
  coerceAiInterviewQuestions,
  type AiInterviewQuestion,
  type AiInterviewSessionCard,
} from "@hireops/api-types";
import { getSession as getAiInterviewSession } from "./ai-interview-questions";
import {
  recordRecordingConsent,
  resolveRecordingConsent,
  type EffectiveRecordingConsent,
} from "./interview-recording-consent";
import { interviewMediaStorageKey } from "./interview-media-upload";
import { getStorageClient, StorageNotFoundError, type StorageObjectStat } from "./storage";
import {
  ALLOWED_AUDIO_TYPES,
  isAllowedAudioType,
  maxMediaBytes,
  normaliseMediaContentType,
} from "./upload-limits";

/** postgres.js tagged-template client (same shape as ctx.sql / poolSql). */
type PgSqlClient = typeof poolSql;

/**
 * The signed-link action string. DISTINCT from
 * `candidate.confirm_interview`: both routes live on the same public router
 * and both verify the same HMAC, so the action is the only thing stopping a
 * confirm token from being replayed against the interview surface (and vice
 * versa). Every route below checks it before it touches the database.
 */
export const AI_INTERVIEW_LINK_ACTION = "candidate.ai_interview";

/**
 * `interview_recording_consents.captured_via` for this surface. Widened into
 * the CHECK by 0119 for the reason 0117 widened it for `internal_revocation`
 * — honesty of provenance. Consent given on the AI interview entry screen,
 * under the copy below, must never be indistinguishable from consent given by
 * clicking the interview confirm page: different wording, different moment,
 * different thing agreed to.
 */
export const CONSENT_VIA_AI_INTERVIEW_LINK = "ai_interview_link";

/**
 * The disclosure version stamped onto every consent row this surface writes.
 * Same rule as RECORDING_CONSENT_VERSION: changing ANY word of
 * AI_INTERVIEW_DISCLOSURE below MUST bump this in the same commit, because a
 * stored row references the version it was captured under and a new wording
 * under an old version is an unanswerable audit question.
 */
export const AI_INTERVIEW_DISCLOSURE_VERSION = "ai-interview-2026-08-v1";

export interface AiInterviewDisclosure {
  /** Always AI_INTERVIEW_DISCLOSURE_VERSION — served together so they can't drift. */
  version: string;
  title: string;
  /** Paragraphs, in order. */
  body: string[];
  grantLabel: string;
  declineLabel: string;
  /** What the candidate is told when they decline. Copy, not a code path. */
  declinedTitle: string;
  declinedBody: string[];
  /**
   * Hard-coded true. The surfaces do not read it; it exists so this object
   * cannot be copied into a UI without the reader tripping over the fact.
   */
  legalReviewRequired: true;
}

/**
 * ⚠️ PLACEHOLDER COPY — NOT LEGALLY REVIEWED, NOT FOR PRODUCTION. ⚠️
 *
 * Same posture as RECORDING_CONSENT_DISCLOSURE: honest plain-English drafting
 * so N4.3b has something real to render and so the version-stamping mechanism
 * is exercised end to end. The client's legally-approved wording is a PENDING
 * INPUT; when it arrives, replace these strings AND bump
 * AI_INTERVIEW_DISCLOSURE_VERSION.
 *
 * The first paragraph is not optional and is not marketing. EU AI Act Art. 50
 * requires that a person be told they are interacting with an AI system, and
 * the build plan (§5) puts that obligation in this disclosure rather than in a
 * settings page precisely so it cannot be switched off. The Art. 50
 * transparency duty is untouched by the Digital Omnibus deferral of the
 * Annex III obligations.
 *
 * The rest states only promises the schema actually keeps: no score column
 * exists (0119), no inference beyond the words is performed (the N4.2 prompt
 * forbids asking for one and N4.4 forbids deriving one), a named human
 * approved the questions (`approved_by_membership_id`, NOT NULL before a
 * session may leave 'draft'), and the consent log is append-only and
 * withdrawable (0116).
 */
export const AI_INTERVIEW_DISCLOSURE: AiInterviewDisclosure = {
  version: AI_INTERVIEW_DISCLOSURE_VERSION,
  title: "This first-round interview is run by AI",
  body: [
    "You are about to take a first-round interview that is conducted by software, not by a " +
      "person. Nobody is on the other side of it: you will be shown a fixed set of questions " +
      "one at a time, and you answer each one in your own time.",
    "Your answers are recorded — the audio you speak, or the text you type — and written up " +
      "so that a recruiter can read and hear exactly what you said.",
    "A person makes the decision. The software asks the questions and gathers what you said; " +
      "it does not score you, rank you, or decide whether you go forward. Nothing is judged " +
      "or inferred about your personality, confidence, accent or fluency — only the content " +
      "of your answers is used.",
    "The questions were drafted with AI and were reviewed and approved by a named member of " +
      "the hiring team before this round was sent to you.",
    "Because this round IS the recording, it cannot go ahead without your permission to " +
      "record. If you would rather not be recorded, say so below — nothing will be kept and " +
      "a recruiter will pick it up with you.",
    "You can stop at any point, and you can ask us to delete your recording afterwards by " +
      "contacting your recruiter.",
  ],
  grantLabel: "I understand — you may record my answers",
  declineLabel: "I would rather not be recorded",
  declinedTitle: "That's fine — this round won't go ahead",
  declinedBody: [
    "Nothing has been recorded and nothing has been kept.",
    "Unlike an interview with a person, there is no version of this round that can run " +
      "without recording — the recording is the whole of it. So it stops here rather than " +
      "continuing in a way you did not agree to.",
    "Your decision has been recorded against this round and your recruiter can see it. They " +
      "will be in touch about another way to complete this stage. Saying no does not take " +
      "you out of the process.",
  ],
  legalReviewRequired: true,
};

/**
 * Typed-answer budget. Generous — a candidate typing instead of speaking is
 * already at a disadvantage on effort, and a cramped box would make the
 * fallback a penalty rather than an accommodation — but bounded, because this
 * is unauthenticated candidate input landing in jsonb.
 */
export const AI_INTERVIEW_ANSWER_TEXT_MAX = 5000;

/** Default life of an issued link, in days, and the bounds an input is clamped to. */
export const AI_INTERVIEW_DEFAULT_EXPIRY_DAYS = 7;
export const AI_INTERVIEW_MIN_EXPIRY_DAYS = 1;
export const AI_INTERVIEW_MAX_EXPIRY_DAYS = 30;

/* ─────────────────────────────── turn state ─────────────────────────────── */

/**
 * How an answer was given. STORED PER ANSWER, never inferred later from the
 * presence of audio — see the module header. `voice` and `typed` are
 * different evidence and the report has to be able to say which it has.
 */
export type AiInterviewAnswerMode = "voice" | "typed";

export interface AiInterviewAnswerRecord {
  /** `questions[].key` — q1..qN, server-assigned by N4.2. */
  questionKey: string;
  mode: AiInterviewAnswerMode;
  /** ISO, server clock. */
  answeredAt: string;
  /**
   * voice only — millisecond offsets into the round's single continuous
   * recording, the same vocabulary interview_transcripts.segments uses.
   * Null when the browser could not report them; the answer still stands.
   */
  startMs: number | null;
  endMs: number | null;
  /** typed only. */
  text: string | null;
}

/**
 * `ai_interview_sessions.turn_state`.
 *
 * 0119 wrote this column as jsonb specifically because its shape would move
 * during N4.3 and none of it is worth a migration. This is that shape.
 * `version` is here so a later change is a branch rather than a guess.
 *
 * `mediaSizeBytes` is the size of the round object at the last ACCEPTED
 * checkpoint, and it is what makes the cumulative-upload contract
 * enforceable rather than merely stated (module header).
 */
export interface AiInterviewTurnState {
  version: 1;
  answers: AiInterviewAnswerRecord[];
  mediaSizeBytes: number | null;
  mediaContentType: string | null;
}

/** The honest empty state — what 0119's `'{}'::jsonb` default means. */
export function emptyTurnState(): AiInterviewTurnState {
  return { version: 1, answers: [], mediaSizeBytes: null, mediaContentType: null };
}

/**
 * A stored `turn_state` coerced back to the typed shape, tolerating anything
 * malformed by falling back to empty. `coerceAiInterviewQuestions`' posture:
 * a read path must not throw because a row written by an older shape went
 * stale. An answer entry that does not parse is DROPPED rather than repaired
 * — a half-understood answer is not evidence.
 */
export function coerceTurnState(value: unknown): AiInterviewTurnState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyTurnState();
  const raw = value as Record<string, unknown>;
  const answers: AiInterviewAnswerRecord[] = [];
  if (Array.isArray(raw.answers)) {
    for (const item of raw.answers) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const a = item as Record<string, unknown>;
      if (typeof a.questionKey !== "string") continue;
      if (a.mode !== "voice" && a.mode !== "typed") continue;
      answers.push({
        questionKey: a.questionKey,
        mode: a.mode,
        answeredAt: typeof a.answeredAt === "string" ? a.answeredAt : new Date(0).toISOString(),
        startMs: typeof a.startMs === "number" ? a.startMs : null,
        endMs: typeof a.endMs === "number" ? a.endMs : null,
        text: typeof a.text === "string" ? a.text : null,
      });
    }
  }
  return {
    version: 1,
    answers,
    mediaSizeBytes: typeof raw.mediaSizeBytes === "number" ? raw.mediaSizeBytes : null,
    mediaContentType: typeof raw.mediaContentType === "string" ? raw.mediaContentType : null,
  };
}

/* ──────────────────────────────── loading ───────────────────────────────── */

export interface AiInterviewSessionRow {
  session_id: string;
  tenant_id: string;
  interview_id: string;
  status: string;
  questions: unknown;
  turn_state: unknown;
  approved_by_membership_id: string | null;
  link_token_hash: string | null;
  started_at: Date | string | null;
  submitted_at: Date | string | null;
  expires_at: Date | string | null;
  interview_status: string;
  interview_mode: string;
  round_name: string;
  candidate_full_name: string | null;
  company_name: string;
  position_title: string;
}

/**
 * The session, its round and the context the candidate screen renders, by
 * TOKEN HASH.
 *
 * NO TENANT PREDICATE, and that is the design rather than an omission: this
 * is the unauthenticated surface, there is no session and no JWT to read a
 * tenant from, and the tenant is RESOLVED from the row the hash finds —
 * exactly what `loadInterviewByHash` does for the confirm route. The hash
 * column carries a partial index (0119) for precisely this lookup.
 */
export async function loadSessionByTokenHash(
  sql: PgSqlClient,
  tokenHash: string,
): Promise<AiInterviewSessionRow | null> {
  const [row] = await sql<AiInterviewSessionRow[]>`
    SELECT
      s.id                AS session_id,
      s.tenant_id,
      s.interview_id,
      s.status,
      s.questions,
      s.turn_state,
      s.approved_by_membership_id,
      s.link_token_hash,
      s.started_at,
      s.submitted_at,
      s.expires_at,
      iv.status           AS interview_status,
      iv.mode             AS interview_mode,
      iv.round_name,
      p.full_name         AS candidate_full_name,
      pos.title           AS position_title,
      t.display_name      AS company_name
    FROM public.ai_interview_sessions s
    JOIN public.interviews iv ON iv.tenant_id = s.tenant_id AND iv.id = s.interview_id
    JOIN public.applications a ON a.tenant_id = iv.tenant_id AND a.id = iv.application_id
    JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
    JOIN public.persons p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
    JOIN public.requisitions r ON r.tenant_id = iv.tenant_id AND r.id = iv.requisition_id
    JOIN public.positions pos ON pos.tenant_id = r.tenant_id AND pos.id = r.position_id
    JOIN public.tenants t ON t.id = s.tenant_id
    WHERE s.link_token_hash = ${tokenHash}
    LIMIT 1
  `;
  return row ?? null;
}

/**
 * Re-read the row after a write, BY THE SAME HASH the caller arrived with
 * rather than by a second copy of that long join. The hash is a unique lookup
 * (0119's partial index) and every row on this surface was found by it in the
 * first place, so there is no case where the two disagree. Falls back to the
 * pre-write row if the re-read misses, which can only happen if the round was
 * deleted mid-request.
 */
async function reloadSession(
  sql: PgSqlClient,
  row: AiInterviewSessionRow,
): Promise<AiInterviewSessionRow> {
  if (!row.link_token_hash) return row;
  return (await loadSessionByTokenHash(sql, row.link_token_hash)) ?? row;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * THE EXPIRY CHECK. Lazy, on access — see the module header for why there is
 * no sweep.
 *
 * Returns the row as it now stands: unchanged when the session has not
 * lapsed, and status 'expired' when it has. The guarded WHERE means a session
 * that reached 'submitted' a millisecond before the deadline is never
 * retro-expired out of a completed round.
 */
export async function expireIfLapsed(
  sql: PgSqlClient,
  row: AiInterviewSessionRow,
): Promise<AiInterviewSessionRow> {
  const expiresAt = toDate(row.expires_at);
  if (!expiresAt) return row;
  if (expiresAt.getTime() > Date.now()) return row;
  if (row.status !== "issued" && row.status !== "in_progress") return row;

  await sql`
    UPDATE public.ai_interview_sessions
    SET status = 'expired', updated_at = now()
    WHERE tenant_id = ${row.tenant_id}
      AND id = ${row.session_id}
      AND status IN ('issued', 'in_progress')
      AND expires_at IS NOT NULL
      AND expires_at <= now()
  `;
  return { ...row, status: "expired" };
}

/* ─────────────────────────── the question walk ──────────────────────────── */

/**
 * A question as the CANDIDATE sees it. TWO FIELDS, copied explicitly.
 *
 * Not a spread with `rubricKey` deleted, and not `Omit<>` on the stored type:
 * both of those leak the day someone adds a field to the stored shape. An
 * explicit copy fails to compile instead of quietly widening.
 */
export interface CandidateQuestion {
  key: string;
  prompt: string;
  /** 1-based, for "Question 3 of 6". Never a handle on the ones after it. */
  index: number;
  of: number;
}

function toCandidateQuestion(q: AiInterviewQuestion, index: number, of: number): CandidateQuestion {
  return { key: q.key, prompt: q.prompt, index: index + 1, of };
}

/**
 * The first question with no answer, or null when the set is finished.
 * Answers are matched BY KEY rather than by count so a stored state with a
 * dropped or duplicated entry resolves to a real question rather than an
 * off-by-one one.
 */
function currentQuestionIndex(
  questions: AiInterviewQuestion[],
  turnState: AiInterviewTurnState,
): number | null {
  const answered = new Set(turnState.answers.map((a) => a.questionKey));
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    if (q && !answered.has(q.key)) return i;
  }
  return null;
}

/* ───────────────────────── issuing (authenticated) ──────────────────────── */

export interface IssueSessionInput {
  tenantId: string;
  interviewId: string;
  /** Clamped to [AI_INTERVIEW_MIN_EXPIRY_DAYS, AI_INTERVIEW_MAX_EXPIRY_DAYS]. */
  expiresInDays?: number;
  /** Portal origin the candidate URL is built on. */
  portalBaseUrl: string;
}

export interface IssueSessionResult {
  session: AiInterviewSessionCard;
  /**
   * The RAW candidate URL, returned ONCE and never stored — only its hash
   * goes in the database. It is on the wire because staging Resend is in test
   * mode and a recruiter has to be able to copy the link to a candidate by
   * hand; the partner-invitation `acceptUrl` set that precedent for the same
   * reason.
   */
  interviewUrl: string;
  expiresAt: string;
}

interface IssueRow {
  session_id: string | null;
  status: string | null;
  started_at: Date | string | null;
  interview_status: string;
  interview_mode: string;
}

/**
 * `approved → issued`: mint the link, store ONLY its hash, set the deadline.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE mode = 'ai_async' GUARD LIVES HERE
 * ─────────────────────────────────────────────────────────────────────────
 * N4.2 left it open, so a recruiter can currently generate questions for a
 * `video` round, which is nonsense. This is the right place to refuse rather
 * than the generation call: generating is a discardable draft, while ISSUING
 * is the irreversible step — it is the moment a link exists that a candidate
 * can open and answer into. A draft on the wrong round costs one regeneration
 * and can simply be cancelled; an issued one has been put to a person.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RE-ISSUE IS ALLOWED ONLY BEFORE THE CANDIDATE HAS STARTED
 * ─────────────────────────────────────────────────────────────────────────
 * The raw token exists exactly once, in the response to this call, so a lost
 * link would otherwise be a dead round. Re-issuing while nothing has started
 * mints a NEW token and replaces the hash, which INVALIDATES the old link —
 * acceptable, because nobody has used it. Once `started_at` is stamped it is
 * refused: replacing the token under a candidate mid-round would strand them
 * on a link that stops working between two answers, with a session that
 * cannot tell them why.
 *
 * `interviews.recording_requested` is set to true here as part of issuing.
 * That is not a convenience: `canRecordInterview` requires the recruiter's
 * intent as well as the candidate's consent, and for an AI round the act of
 * issuing IS the request to record — there is no separate recruiter moment
 * later. Leaving it false would mean the platform's own gate disagreed with a
 * round whose entire content is a recording.
 */
export async function issueSession(
  sql: PgSqlClient,
  input: IssueSessionInput,
): Promise<IssueSessionResult> {
  const [row] = await sql<IssueRow[]>`
    SELECT s.id AS session_id, s.status, s.started_at,
           iv.status AS interview_status, iv.mode AS interview_mode
    FROM public.interviews iv
    LEFT JOIN public.ai_interview_sessions s
      ON s.tenant_id = iv.tenant_id AND s.interview_id = iv.id
    WHERE iv.tenant_id = ${input.tenantId} AND iv.id = ${input.interviewId}
    LIMIT 1
  `;
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });

  if (row.interview_mode !== "ai_async") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `This round's mode is '${row.interview_mode}', not 'ai_async'. An AI interview link ` +
        "can only be issued for a round that is set up to be conducted by AI — a human round " +
        "needs a panel and a scheduled slot, not a question set the candidate answers alone.",
    });
  }
  if (row.interview_status === "cancelled") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This interview has been cancelled — a candidate link cannot be issued for it.",
    });
  }
  if (!row.session_id || !row.status) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No questions have been generated for this round yet.",
    });
  }
  if (row.status === "draft") {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "These questions have not been approved yet. A named human has to approve the " +
        "question set before it can be put to a candidate.",
    });
  }
  if (row.status !== "approved" && row.status !== "issued") {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        row.status === "cancelled"
          ? "This AI interview session was cancelled."
          : `This session is '${row.status}' — a new link can no longer be issued for it.`,
    });
  }
  if (row.started_at) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "The candidate has already started this round. Issuing a new link would break the " +
        "one they are using part-way through.",
    });
  }

  const days = clampExpiryDays(input.expiresInDays);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  // Mint AFTER the session row is known to exist so subjectId is the real row
  // id — the scheduleInterview precedent. Only the hash is stored; the raw
  // token goes back to the caller and lives nowhere else.
  const token = signLink({
    action: AI_INTERVIEW_LINK_ACTION,
    subjectId: row.session_id,
    expiresAt,
  });

  const [updated] = await sql<{ id: string }[]>`
    UPDATE public.ai_interview_sessions
    SET status = 'issued',
        link_token_hash = ${hashToken(token)},
        expires_at = ${expiresAt.toISOString()},
        updated_at = now()
    WHERE tenant_id = ${input.tenantId}
      AND id = ${row.session_id}
      AND status IN ('approved', 'issued')
      AND started_at IS NULL
    RETURNING id
  `;
  if (!updated) {
    // The WHERE excluded the row — it was started, cancelled or advanced
    // between the read and the write.
    throw new TRPCError({
      code: "CONFLICT",
      message: "This session changed while the link was being issued. Reload and try again.",
    });
  }

  // The recruiter half of the recording gate. See the header.
  await sql`
    UPDATE public.interviews
    SET recording_requested = true, updated_at = now()
    WHERE tenant_id = ${input.tenantId} AND id = ${input.interviewId}
  `;

  const after = await getAiInterviewSession(sql, {
    tenantId: input.tenantId,
    interviewId: input.interviewId,
  });
  if (!after.session) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "ai_interview_sessions issue returned no row",
    });
  }

  return {
    session: after.session,
    interviewUrl: `${input.portalBaseUrl.replace(/\/+$/, "")}/interviews/ai/${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

function clampExpiryDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return AI_INTERVIEW_DEFAULT_EXPIRY_DAYS;
  return Math.min(
    Math.max(Math.floor(days), AI_INTERVIEW_MIN_EXPIRY_DAYS),
    AI_INTERVIEW_MAX_EXPIRY_DAYS,
  );
}

/* ──────────────────────── the candidate-facing reads ────────────────────── */

export interface CandidateSessionView {
  sessionId: string;
  interviewId: string;
  status: string;
  candidateName: string;
  companyName: string;
  positionTitle: string;
  roundName: string;
  questionCount: number;
  answeredCount: number;
  /** ONLY the question they are on. Null before start and after finish. */
  currentQuestion: CandidateQuestion | null;
  disclosure: AiInterviewDisclosure;
  recordingConsent: EffectiveRecordingConsent;
  startedAt: string | null;
  submittedAt: string | null;
  expiresAt: string | null;
  /** Capture rules, served with the round so N4.3b cannot guess them. */
  answerTextMax: number;
  maxUploadBytes: number;
  allowedContentTypes: string[];
  /** The media contract — see the module header. */
  roundAudio: "cumulative";
}

/**
 * What the candidate screen renders.
 *
 * The current question is served only once the round has actually STARTED
 * (consent captured, `in_progress`). Before that the candidate is looking at
 * the disclosure and has agreed to nothing, and handing them the first
 * question early would mean they could read it, decline, and have seen a
 * question they never consented to be asked.
 */
export function toCandidateView(row: AiInterviewSessionRow, consent: EffectiveRecordingConsent) {
  const questions = coerceAiInterviewQuestions(row.questions);
  const turnState = coerceTurnState(row.turn_state);
  const idx = row.status === "in_progress" ? currentQuestionIndex(questions, turnState) : null;
  const current = idx === null ? null : (questions[idx] ?? null);

  const view: CandidateSessionView = {
    sessionId: row.session_id,
    interviewId: row.interview_id,
    status: row.status,
    candidateName: row.candidate_full_name ?? "there",
    companyName: row.company_name,
    positionTitle: row.position_title,
    roundName: row.round_name,
    questionCount: questions.length,
    answeredCount: turnState.answers.length,
    currentQuestion:
      current === null || idx === null ? null : toCandidateQuestion(current, idx, questions.length),
    disclosure: AI_INTERVIEW_DISCLOSURE,
    recordingConsent: consent,
    startedAt: toIso(row.started_at),
    submittedAt: toIso(row.submitted_at),
    expiresAt: toIso(row.expires_at),
    answerTextMax: AI_INTERVIEW_ANSWER_TEXT_MAX,
    maxUploadBytes: maxMediaBytes(),
    allowedContentTypes: [...ALLOWED_AUDIO_TYPES],
    roundAudio: "cumulative",
  };
  return view;
}

/* ───────────────────────────── consent + start ──────────────────────────── */

/**
 * The refusal vocabulary the routes map to HTTP codes. Strings rather than
 * exceptions because these are candidate-facing outcomes, not faults — the
 * route turns each into copy the candidate can act on.
 */
export type CandidateRefusal =
  | "not_issued"
  | "expired"
  | "cancelled"
  | "already_submitted"
  | "not_started"
  | "consent_required"
  | "no_current_question"
  | "not_current_question"
  | "invalid_answer"
  | "invalid_content_type"
  | "too_large"
  | "media_missing"
  | "media_shrank"
  | "content_type_changed";

/** A refusal, on its own, so the guards below can return it without a value. */
export interface CandidateRefusalResult {
  ok: false;
  refusal: CandidateRefusal;
  message: string;
}

/**
 * A DISCRIMINATED union rather than an all-optional bag: `ok: true` has to
 * imply `value` is there, or every caller ends up writing `result.value!` and
 * the lint rule that forbids that is the one thing standing between a typo
 * and a 500 on a candidate's last answer.
 */
export type CandidateResult<T> = { ok: true; value: T } | CandidateRefusalResult;

function refuse(refusal: CandidateRefusal, message: string): CandidateRefusalResult {
  return { ok: false, refusal, message };
}

/**
 * Is this session in a state that can accept candidate ACTIVITY (start,
 * answer, submit)? Read-only access is deliberately more permissive — the GET
 * has to be able to show an expired or submitted session its own state, which
 * is the whole reason it does not consume the link.
 */
function assertActionable(row: AiInterviewSessionRow): CandidateRefusalResult | null {
  if (row.interview_status === "cancelled" || row.status === "cancelled") {
    return refuse(
      "cancelled",
      "This interview has been cancelled. Your recruiter will be in touch.",
    );
  }
  if (row.status === "expired") {
    return refuse(
      "expired",
      "This interview link has expired. Contact your recruiter and they can send you a new one.",
    );
  }
  if (row.status === "submitted") {
    return refuse(
      "already_submitted",
      "You have already submitted this interview — thank you. There is nothing more to do.",
    );
  }
  if (row.status !== "issued" && row.status !== "in_progress") {
    return refuse("not_issued", "This interview is not open for answers.");
  }
  return null;
}

export interface StartSessionInput {
  consentGranted: boolean;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface StartSessionResult {
  view: CandidateSessionView;
}

/**
 * Capture consent, then start the round.
 *
 * ONE candidate interaction, not two — the confirm route's argument for
 * carrying `recordingConsent` on the confirmation itself. The consent row is
 * written FIRST and unconditionally, including for a decline: a refusal is a
 * fact about what the candidate was asked and what they said, and it belongs
 * in the append-only log whether or not the round proceeds. Only then does
 * the status move.
 *
 * A DECLINE IS NOT AN ERROR IN THE ROUND. It is refused, honestly, with the
 * declined copy — see the module header. The session is deliberately left at
 * `issued` rather than cancelled: the consent log is append-only and a
 * candidate who declines and changes their mind can grant on the same link,
 * and a recruiter who wants the round pulled can cancel it explicitly.
 */
export async function startSession(
  sql: PgSqlClient,
  row: AiInterviewSessionRow,
  input: StartSessionInput,
): Promise<CandidateResult<StartSessionResult>> {
  const blocked = assertActionable(row);
  if (blocked) return blocked;

  const consent = await recordRecordingConsent(sql, {
    tenantId: row.tenant_id,
    interviewId: row.interview_id,
    decision: input.consentGranted ? "granted" : "declined",
    capturedVia: CONSENT_VIA_AI_INTERVIEW_LINK,
    consentVersion: AI_INTERVIEW_DISCLOSURE_VERSION,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  if (!consent.permitted) {
    return refuse("consent_required", AI_INTERVIEW_DISCLOSURE.declinedBody.join(" "));
  }

  // `WHERE status IN ('issued','in_progress')` keeps a resume idempotent: a
  // candidate re-granting consent part-way through does not restart the round
  // or re-stamp started_at (COALESCE), and cannot rewind a submitted one.
  await sql`
    UPDATE public.ai_interview_sessions
    SET status = 'in_progress',
        started_at = COALESCE(started_at, now()),
        updated_at = now()
    WHERE tenant_id = ${row.tenant_id}
      AND id = ${row.session_id}
      AND status IN ('issued', 'in_progress')
  `;

  const after = await reloadSession(sql, row);
  return { ok: true, value: { view: toCandidateView(after, consent) } };
}

/* ───────────────────────────── per-answer capture ───────────────────────── */

export interface AnswerUploadUrlInput {
  questionKey: string;
  /** Raw, as the browser reported it — "audio/webm;codecs=opus" is normal. */
  contentType: string;
  /** The browser's DECLARED cumulative size. Re-checked against reality later. */
  sizeBytes: number;
}

export interface AnswerUploadUrlResult {
  storageKey: string;
  uploadUrl: string;
  method: "PUT";
  token: string | null;
  expiresAt: string;
  provider: "supabase" | "local";
  /** The normalised type we recorded — what the browser must send. */
  contentType: string;
  /** Restated per call so the browser cannot drift off the contract. */
  roundAudio: "cumulative";
}

/**
 * Mint the signed PUT for this answer's checkpoint.
 *
 * The key is the ROUND's key, not the answer's — one object per round (module
 * header) — and it is derived from the interview, so it is knowable before
 * any row exists. `upsert: true` because every checkpoint legitimately
 * overwrites the previous one with a longer recording.
 *
 * THE RECORDING ROW IS CREATED HERE, at the first checkpoint, rather than at
 * submit. If it were created at submit, an abandoned round would leave audio
 * in the bucket that no row points at — and 0118's retention sweep only finds
 * objects a recording row points at, so those bytes would sit there past
 * their retention with nothing able to delete them. A 'pending' recording for
 * a round that is never finished is the honest record of exactly that.
 */
export async function createAnswerUploadUrl(
  sql: PgSqlClient,
  row: AiInterviewSessionRow,
  input: AnswerUploadUrlInput,
): Promise<CandidateResult<AnswerUploadUrlResult>> {
  const blocked = await assertAnswerable(sql, row, input.questionKey);
  if (blocked) return blocked;

  const contentType = normaliseMediaContentType(input.contentType);
  if (!isAllowedAudioType(contentType)) {
    return refuse(
      "invalid_content_type",
      `${input.contentType} is not a supported audio format for this interview.`,
    );
  }
  const cap = maxMediaBytes();
  if (input.sizeBytes > cap) {
    return refuse("too_large", `That recording is ${input.sizeBytes} bytes; the limit is ${cap}.`);
  }

  const turnState = coerceTurnState(row.turn_state);
  // A container switch mid-round would mean the next checkpoint is a
  // different file rather than a longer one, and the earlier answers would be
  // gone. Refused rather than silently accepted.
  if (turnState.mediaContentType && turnState.mediaContentType !== contentType) {
    return refuse(
      "content_type_changed",
      "This round's recording started in a different audio format. Reload the page and start " +
        "the round again from where you left off.",
    );
  }

  const storageKey = interviewMediaStorageKey(row.tenant_id, row.interview_id, contentType);

  // ON CONFLICT so a second checkpoint updates rather than 23505s. Guarded to
  // the pre-transcription states for the same reason startUpload is: once a
  // transcript exists, new media would describe an artefact that is no longer
  // there.
  const [recording] = await sql<{ id: string }[]>`
    INSERT INTO public.interview_recordings
      (tenant_id, interview_id, source, status, storage_key, media_type,
       requested_by_membership_id)
    VALUES (${row.tenant_id}, ${row.interview_id}, 'ai_interview', 'pending',
            ${storageKey}, ${contentType}, ${row.approved_by_membership_id})
    ON CONFLICT (tenant_id, interview_id) DO UPDATE
      SET source = 'ai_interview',
          storage_key = EXCLUDED.storage_key,
          media_type = EXCLUDED.media_type,
          updated_at = now()
      WHERE interview_recordings.status IN ('pending', 'uploaded')
        AND interview_recordings.media_purged_at IS NULL
    RETURNING id
  `;
  if (!recording) {
    return refuse(
      "media_missing",
      "This round's recording can no longer be added to. Contact your recruiter.",
    );
  }

  const signed = await getStorageClient().createSignedUploadUrl(storageKey, { upsert: true });
  return {
    ok: true,
    value: {
      storageKey,
      uploadUrl: signed.url,
      method: signed.method,
      token: signed.token,
      expiresAt: signed.expiresAt.toISOString(),
      provider: signed.provider,
      contentType,
      roundAudio: "cumulative",
    },
  };
}

export interface RecordAnswerInput {
  questionKey: string;
  mode: AiInterviewAnswerMode;
  /** typed only. */
  text?: string | null;
  /** voice only — offsets into the round's single timeline. */
  startMs?: number | null;
  endMs?: number | null;
}

export interface RecordAnswerResult {
  view: CandidateSessionView;
  /** The answer as it was recorded, mode included. */
  answer: AiInterviewAnswerRecord;
}

/**
 * Accept ONE answer and advance the turn.
 *
 * A TYPED ANSWER NEEDS NO UPLOAD AND TOUCHES NO STORAGE. It is not a degraded
 * voice answer with an empty media leg — it is its own mode, stored as such,
 * and the round can be entirely typed (see the module header). A voice answer
 * is only accepted after the object it claims has been verified: the browser
 * saying the PUT finished is not evidence that it did.
 */
export async function recordAnswer(
  sql: PgSqlClient,
  row: AiInterviewSessionRow,
  input: RecordAnswerInput,
): Promise<CandidateResult<RecordAnswerResult>> {
  const blocked = await assertAnswerable(sql, row, input.questionKey);
  if (blocked) return blocked;

  const turnState = coerceTurnState(row.turn_state);
  let nextMediaSize = turnState.mediaSizeBytes;
  let nextMediaType = turnState.mediaContentType;

  const answer: AiInterviewAnswerRecord = {
    questionKey: input.questionKey,
    mode: input.mode,
    answeredAt: new Date().toISOString(),
    startMs: null,
    endMs: null,
    text: null,
  };

  if (input.mode === "typed") {
    const text = (input.text ?? "").trim();
    if (text.length === 0) {
      return refuse("invalid_answer", "Type an answer before moving on.");
    }
    if (text.length > AI_INTERVIEW_ANSWER_TEXT_MAX) {
      return refuse(
        "invalid_answer",
        `That answer is ${text.length} characters; the limit is ${AI_INTERVIEW_ANSWER_TEXT_MAX}.`,
      );
    }
    answer.text = text;
  } else {
    const [recording] = await sql<
      { storage_key: string | null; media_type: string | null; status: string }[]
    >`
      SELECT storage_key, media_type, status FROM public.interview_recordings
      WHERE tenant_id = ${row.tenant_id} AND interview_id = ${row.interview_id}
      LIMIT 1
    `;
    if (!recording?.storage_key) {
      return refuse("media_missing", "We didn't receive that recording. Please record it again.");
    }

    // The object, not the browser's word about it — completeUpload's rule.
    let stat: StorageObjectStat;
    try {
      stat = await getStorageClient().stat(recording.storage_key);
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        return refuse("media_missing", "We didn't receive that recording. Please record it again.");
      }
      throw err;
    }

    const cap = maxMediaBytes();
    if (stat.sizeBytes > cap) {
      return refuse(
        "too_large",
        `This round's recording is ${stat.sizeBytes} bytes; the limit is ${cap}. ` +
          "Switch to typing your answers to finish the round.",
      );
    }
    if (stat.sizeBytes === 0) {
      return refuse("media_missing", "That recording was empty. Please record it again.");
    }
    // THE CUMULATIVE-UPLOAD ENFORCEMENT (module header). A checkpoint smaller
    // than the last one means the browser uploaded only the newest answer over
    // the top of the round, which would silently destroy every answer before
    // it. Refused, and the previous checkpoint is left standing.
    if (turnState.mediaSizeBytes !== null && stat.sizeBytes < turnState.mediaSizeBytes) {
      return refuse(
        "media_shrank",
        "That upload was shorter than the recording we already have for this round, so it was " +
          "not accepted — it would have replaced your earlier answers. Reload the page and " +
          "continue from where you left off.",
      );
    }
    if (!isAllowedAudioType(recording.media_type ?? "")) {
      return refuse("invalid_content_type", "That recording is not in a supported audio format.");
    }

    nextMediaSize = stat.sizeBytes;
    nextMediaType = normaliseMediaContentType(recording.media_type ?? "");
    answer.startMs =
      typeof input.startMs === "number" ? Math.max(0, Math.trunc(input.startMs)) : null;
    answer.endMs = typeof input.endMs === "number" ? Math.max(0, Math.trunc(input.endMs)) : null;
  }

  // Re-answering the same question REPLACES its entry: a retry after a failed
  // upload is the normal way this happens, and stacking two answers to one
  // question would leave N4.4 choosing between them with no basis to.
  const answers = turnState.answers.filter((a) => a.questionKey !== input.questionKey);
  answers.push(answer);
  const nextState: AiInterviewTurnState = {
    version: 1,
    answers,
    mediaSizeBytes: nextMediaSize,
    mediaContentType: nextMediaType,
  };

  await sql`
    UPDATE public.ai_interview_sessions
    SET turn_state = ${JSON.stringify(nextState)}::jsonb, updated_at = now()
    WHERE tenant_id = ${row.tenant_id} AND id = ${row.session_id} AND status = 'in_progress'
  `;

  const after = await reloadSession(sql, row);
  const consent = await resolveRecordingConsent(sql, row.tenant_id, row.interview_id);
  return { ok: true, value: { view: toCandidateView(after, consent), answer } };
}

/**
 * The shared gate for both halves of answering: the session must be running,
 * the candidate must have consented, and the question must be THE ONE THEY
 * ARE ON.
 *
 * The last check is what stops answering ahead. A candidate cannot see a
 * later question (the read never returns one), but the key is guessable —
 * they are q1..qN — so the enforcement has to be here rather than relying on
 * the read having withheld it.
 */
async function assertAnswerable(
  sql: PgSqlClient,
  row: AiInterviewSessionRow,
  questionKey: string,
): Promise<CandidateRefusalResult | null> {
  const blocked = assertActionable(row);
  if (blocked) return blocked;
  if (row.status !== "in_progress") {
    return refuse("not_started", "Start the interview before answering.");
  }

  // Re-resolved on every answer, not trusted from start: consent is
  // withdrawable at any time (0116 is append-only precisely so it is), and a
  // withdrawal mid-round must stop the recording rather than be discovered
  // after the fact.
  const consent = await resolveRecordingConsent(sql, row.tenant_id, row.interview_id);
  if (!consent.permitted) {
    return refuse("consent_required", AI_INTERVIEW_DISCLOSURE.declinedBody.join(" "));
  }

  const questions = coerceAiInterviewQuestions(row.questions);
  const idx = currentQuestionIndex(questions, coerceTurnState(row.turn_state));
  const current = idx === null ? null : (questions[idx] ?? null);
  if (!current) {
    return refuse("no_current_question", "You have answered every question — submit to finish.");
  }
  if (current.key !== questionKey) {
    return refuse(
      "not_current_question",
      "That is not the question you are on. Reload the page to see where you are.",
    );
  }
  return null;
}

/* ────────────────────────────── submit + enqueue ────────────────────────── */

export interface SubmitSessionInput {
  /** Optional whole-round duration hint from the browser. */
  durationSeconds?: number | null;
}

export interface SubmitSessionResult {
  view: CandidateSessionView;
  /** Null for an all-typed round — there is no audio artefact. See below. */
  recordingId: string | null;
  /** false when no audio was captured, or when an outbox row already existed. */
  enqueued: boolean;
  answeredCount: number;
  questionCount: number;
}

/**
 * Postgres unique-violation. CODE-BASED, never a substring match on the
 * message: the driver error may be wrapped and its outer message need not
 * mention the constraint at all. Same helper, same reason, as
 * interview-media-upload.ts.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const causeCode = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

/**
 * Finish the round: one recording row, `submitted`, and THE ENQUEUE.
 *
 * The recording row is the one 0119 insists on — `uniq_interview_recordings
 * _per_interview` is deliberately unchanged, one AI round is one recording,
 * and per-question boundaries live in `turn_state` (and, after the drain, in
 * `interview_transcripts.segments`) rather than in sibling rows.
 *
 * AN ALL-TYPED ROUND ENQUEUES NOTHING. There is no audio, so there is nothing
 * to transcribe: no recording row is completed, no outbox row is written, and
 * the result says so (`recordingId: null`, `enqueued: false`). Enqueueing
 * anyway would spend a drain claim and an ASR call to discover the absence,
 * and would leave a recording row asserting media that does not exist.
 *
 * The session moves to `submitted` FIRST and independently of the enqueue.
 * The candidate has finished either way, and a transient storage or outbox
 * failure must not leave them looking at a round that will not close.
 */
export async function submitSession(
  sql: PgSqlClient,
  row: AiInterviewSessionRow,
  input: SubmitSessionInput = {},
): Promise<CandidateResult<SubmitSessionResult>> {
  const blocked = assertActionable(row);
  if (blocked) return blocked;
  if (row.status !== "in_progress") {
    return refuse("not_started", "This interview has not been started.");
  }

  const questions = coerceAiInterviewQuestions(row.questions);
  const turnState = coerceTurnState(row.turn_state);
  if (turnState.answers.length === 0) {
    return refuse("invalid_answer", "Answer at least one question before submitting.");
  }

  const hasVoice = turnState.answers.some((a) => a.mode === "voice");

  // Guarded on 'in_progress' so a concurrent second submit does not re-stamp
  // submitted_at. Its absence is NOT treated as a failure and the enqueue
  // below still runs: the loser of that race must still reach the INSERT, or
  // a crash between the status move and the enqueue would leave a submitted
  // round that nothing ever transcribes. The 23505 absorption is what makes
  // running it twice safe.
  await sql`
    UPDATE public.ai_interview_sessions
    SET status = 'submitted', submitted_at = now(), updated_at = now()
    WHERE tenant_id = ${row.tenant_id} AND id = ${row.session_id} AND status = 'in_progress'
  `;

  let recordingId: string | null = null;
  let enqueued = false;

  if (hasVoice) {
    const [recording] = await sql<{ id: string }[]>`
      UPDATE public.interview_recordings
      SET status = 'uploaded',
          uploaded_at = COALESCE(uploaded_at, now()),
          size_bytes = ${turnState.mediaSizeBytes},
          duration_seconds = COALESCE(${input.durationSeconds ?? null}, duration_seconds),
          updated_at = now()
      WHERE tenant_id = ${row.tenant_id}
        AND interview_id = ${row.interview_id}
        AND status IN ('pending', 'uploaded')
        AND media_purged_at IS NULL
      RETURNING id
    `;
    if (recording) {
      recordingId = recording.id;
      enqueued = true;
      try {
        // THE ENQUEUE. The AI round's producer for the pipeline N3.4a built
        // the recruiter-upload producer for — same table, same drain, one
        // more source.
        await sql`
          INSERT INTO public.transcript_outbox (tenant_id, recording_id, status)
          VALUES (${row.tenant_id}, ${recording.id}, 'pending')
        `;
      } catch (err) {
        // UNIQUE (tenant_id, recording_id). A double-submit — a retried
        // request, an impatient second tap — is SUCCESS: the work is already
        // queued and that is what the caller wanted. Detected by CODE.
        if (!isUniqueViolation(err)) throw err;
        enqueued = false;
      }
    }
  }

  const after = await reloadSession(sql, row);
  const consent = await resolveRecordingConsent(sql, row.tenant_id, row.interview_id);
  return {
    ok: true,
    value: {
      view: toCandidateView(after, consent),
      recordingId,
      enqueued,
      answeredCount: turnState.answers.length,
      questionCount: questions.length,
    },
  };
}
