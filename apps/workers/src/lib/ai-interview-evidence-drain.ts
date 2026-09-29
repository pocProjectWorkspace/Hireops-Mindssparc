/**
 * Drains pending ai_interview_evidence rows (AI-INT-2 / build plan N4.4) —
 * SUBMITTED AI ROUND → EVIDENCE REPORT.
 *
 * `submitSession` enqueues one row per submitted session (0121: UNIQUE per
 * session). Per claimed row:
 *
 *   1. Kill switch. `ai_interview_evidence` disabled → 'skipped', no model
 *      call, no usage row.
 *   2. Load the session (frozen questions + turn_state).
 *   3. READINESS. A round with any spoken answer needs its transcript. If the
 *      transcript has not landed and the round's transcript_outbox row is
 *      still pending/processing, the claim is RELEASED without spending an
 *      attempt and the row is parked for DEFER_MS (see the claim predicate —
 *      a pending row's lease_expires_at doubles as its not-before). If the
 *      transcript pipeline has given up (failed, or completed without a
 *      transcript, or there is no outbox row at all), the pass proceeds with
 *      those spoken answers marked `transcriptUnavailable` — the typed answers
 *      still deserve their evidence, and waiting would be waiting forever.
 *   4. Round context: rubric (snapshot, else the scorecard-path fallback),
 *      competency focus, knockout requirement TEXT (thresholds withheld).
 *   5. Assemble one answer per question (ai-interview-evidence-answers.ts).
 *      No usable answer text at all → 'skipped' with a deterministic report
 *      that says why; there is nothing for a model to read.
 *   6. One structured call under feature 'ai_interview_evidence' (usage row +
 *      cost ledger via the AI client, keyed to this row's id), strict parse.
 *   7. Reconcile + VERIFY QUOTES (ai-interview-evidence-verify.ts), validate
 *      the result against `aiInterviewEvidenceSchema`, write it, 'done'.
 *
 * Shape follows ai-score-drain / transcript-drain: batch claim via UPDATE …
 * WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED), attempt cap, per-row
 * try/catch so one bad row cannot kill the pass, structured logs. The one
 * structural difference: 0121 gave this table a LEASE (`lease_expires_at`)
 * rather than claimed_at + a separate orphan sweep, so an expired
 * 'processing' lease is simply claimable again in the same query.
 *
 * EVIDENCE ONLY. Nothing here computes, stores or logs a score, rating, rank,
 * pass/fail or recommendation — see the prompt module and 0121's header.
 */

import { randomUUID } from "node:crypto";
import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import { z } from "zod";
import {
  AI_INTERVIEW_EVIDENCE_VERSION,
  aiInterviewEvidenceSchema,
  coerceAiInterviewQuestions,
  coerceScorecardCriteria,
  resolveScorecardCriteria,
  transcriptSegmentsSchema,
  type AiInterviewEvidence,
  type ScorecardCriterion,
} from "@hireops/api-types";
import { getAIClient, maskPiiIf, resolveTenantAiSettings } from "@hireops/ai-client";
import {
  assembleAnswers,
  coerceEvidenceAnswers,
  type AssembledAnswer,
  type EvidenceTranscriptSegment,
} from "./ai-interview-evidence-answers";
import {
  AI_INTERVIEW_EVIDENCE_FEATURE,
  AI_INTERVIEW_EVIDENCE_PROMPT_VERSION,
  AI_INTERVIEW_EVIDENCE_SCHEMA_NAME,
  aiInterviewEvidenceAiJsonSchema,
  aiInterviewEvidenceAiSchema,
  buildAiInterviewEvidencePrompt,
  toEvidencePromptQuestions,
  type AiInterviewEvidenceAiResponse,
} from "./ai-interview-evidence-prompt";
import { emptyQuestionEvidence, reconcileEvidence } from "./ai-interview-evidence-verify";

/** Attempts before a row goes terminal — the ai_score / transcript default. */
export const AI_INTERVIEW_EVIDENCE_ATTEMPT_CAP = 3;

/**
 * How long a claim is treated as in flight. One structured call over at most
 * ten answers returns in well under a minute; ten minutes is generous without
 * letting a dead worker's row sit for long.
 */
export const AI_INTERVIEW_EVIDENCE_LEASE_MS = 10 * 60_000;

/** How long a row waiting on its transcript is parked before it is re-checked. */
export const AI_INTERVIEW_EVIDENCE_DEFER_MS = 2 * 60_000;

/** Retry backoff base: attempt n waits BASE × 2^(n-1) (30s, 60s, …). */
const RETRY_BACKOFF_BASE_MS = 30_000;

const DEFAULT_BATCH = 3;

/** The requirement text is stored verbatim; this bounds it to the stored schema. */
const KNOCKOUT_TEXT_MAX = 1000;

export interface AiInterviewEvidenceDrainOpts {
  batchSize?: number;
  workerId?: string;
  log: Logger;
}

export interface AiInterviewEvidenceDrainResult {
  claimed: number;
  done: number;
  /** Released WITHOUT spending an attempt — the transcript is still coming. */
  deferred: number;
  /** Feature disabled, or no usable answer text. No model call. */
  skipped: number;
  retried: number;
  failed: number;
  /** Rows whose lease expired AT the attempt cap, retired to 'failed' this pass. */
  retired: number;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  session_id: string;
  interview_id: string;
  attempt_count: number;
}

interface SessionRow {
  status: string;
  questions: unknown;
  turn_state: unknown;
}

/** An error no retry can fix. */
class TerminalEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalEvidenceError";
  }
}

export async function drainAiInterviewEvidenceOnce(
  opts: AiInterviewEvidenceDrainOpts,
): Promise<AiInterviewEvidenceDrainResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const workerId = opts.workerId ?? `ai-evidence-${randomUUID().slice(0, 8)}`;
  const log = opts.log;

  const retired = await retireExhaustedLeases(log);

  // Claimable: a pending row whose not-before has passed (NULL = immediately),
  // or a processing row whose lease expired below the cap (a dead worker's).
  const rows = await poolSql<ClaimedRow[]>`
    UPDATE public.ai_interview_evidence
    SET status = 'processing',
        attempt_count = attempt_count + 1,
        lease_expires_at = now() + (${AI_INTERVIEW_EVIDENCE_LEASE_MS}::int * interval '1 millisecond'),
        updated_at = now()
    WHERE id IN (
      SELECT id FROM public.ai_interview_evidence
      WHERE (status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= now()))
         OR (status = 'processing' AND lease_expires_at < now()
             AND attempt_count < ${AI_INTERVIEW_EVIDENCE_ATTEMPT_CAP})
      ORDER BY created_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, session_id, interview_id, attempt_count
  `;

  const result: AiInterviewEvidenceDrainResult = {
    claimed: rows.length,
    done: 0,
    deferred: 0,
    skipped: 0,
    retried: 0,
    failed: 0,
    retired,
  };
  if (rows.length === 0) return result;

  for (const row of rows) {
    const child = log.child({
      ai_interview_evidence_id: row.id,
      tenant_id: row.tenant_id,
      session_id: row.session_id,
      interview_id: row.interview_id,
      attempt: row.attempt_count,
      worker_id: workerId,
    });
    try {
      const outcome = await processRow(row, child);
      result[outcome] += 1;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // A strict-parse failure is the stance working (an extra key such as a
      // score is exactly what it rejects) and the same prompt will not fix
      // it — the ai-score-drain precedent. Data problems likewise.
      const terminal =
        err instanceof z.ZodError ||
        err instanceof TerminalEvidenceError ||
        row.attempt_count >= AI_INTERVIEW_EVIDENCE_ATTEMPT_CAP;
      if (terminal) {
        await poolSql`
          UPDATE public.ai_interview_evidence
          SET status = 'failed', last_error = ${errMsg}, lease_expires_at = NULL,
              updated_at = now()
          WHERE id = ${row.id}
        `;
        result.failed += 1;
        child.error({ err: errMsg, terminal: true }, "ai_interview_evidence.failed");
      } else {
        const backoffMs = RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, row.attempt_count - 1);
        await poolSql`
          UPDATE public.ai_interview_evidence
          SET status = 'pending', last_error = ${errMsg},
              lease_expires_at = now() + (${backoffMs}::int * interval '1 millisecond'),
              updated_at = now()
          WHERE id = ${row.id}
        `;
        result.retried += 1;
        child.warn({ err: errMsg, backoff_ms: backoffMs }, "ai_interview_evidence.retry");
      }
    }
  }
  return result;
}

/**
 * A 'processing' row whose lease expired at the cap was abandoned by a worker
 * on its last attempt. Re-claiming it would exceed the cap, so retire it —
 * a row that keeps orphaning is a worker that keeps dying.
 */
async function retireExhaustedLeases(log: Logger): Promise<number> {
  const rows = await poolSql<{ id: string }[]>`
    UPDATE public.ai_interview_evidence
    SET status = 'failed',
        last_error = COALESCE(last_error || ' ', '') || '[lease expired at attempt cap]',
        lease_expires_at = NULL,
        updated_at = now()
    WHERE status = 'processing'
      AND lease_expires_at < now()
      AND attempt_count >= ${AI_INTERVIEW_EVIDENCE_ATTEMPT_CAP}
    RETURNING id
  `;
  if (rows.length > 0) {
    log.warn({ retired: rows.length }, "ai_interview_evidence.leases_retired");
  }
  return rows.length;
}

type RowOutcome = "done" | "deferred" | "skipped";

async function processRow(row: ClaimedRow, log: Logger): Promise<RowOutcome> {
  // ── 1. Kill switch, BEFORE anything that could cost a token ────────────
  const aiSettings = await resolveTenantAiSettings(poolSql, row.tenant_id);
  const feature = aiSettings.ai_interview_evidence;
  if (!feature.enabled) {
    await poolSql`
      UPDATE public.ai_interview_evidence
      SET status = 'skipped', last_error = 'feature disabled', lease_expires_at = NULL,
          updated_at = now()
      WHERE id = ${row.id}
    `;
    log.info({ reason: "feature_disabled" }, "ai_interview_evidence.skipped");
    return "skipped";
  }

  // ── 2. The session ─────────────────────────────────────────────────────
  const [session] = await poolSql<SessionRow[]>`
    SELECT status, questions, turn_state
    FROM public.ai_interview_sessions
    WHERE tenant_id = ${row.tenant_id} AND id = ${row.session_id}
  `;
  if (!session) {
    // Unreachable by construction — the row FKs to the session with CASCADE.
    throw new TerminalEvidenceError(`ai_interview_session ${row.session_id} not found`);
  }
  if (session.status !== "submitted") {
    throw new TerminalEvidenceError(
      `ai_interview_session ${row.session_id} is '${session.status}', not 'submitted'`,
    );
  }
  const questions = coerceAiInterviewQuestions(session.questions);
  if (questions.length === 0) {
    throw new TerminalEvidenceError(`ai_interview_session ${row.session_id} has no questions`);
  }
  const answers = coerceEvidenceAnswers(session.turn_state);

  // ── 3. Readiness ───────────────────────────────────────────────────────
  let segments: EvidenceTranscriptSegment[] | null = null;
  if (answers.some((a) => a.mode === "voice")) {
    const transcript = await loadTranscriptSegments(row.tenant_id, row.interview_id);
    if (transcript.kind === "present") {
      segments = transcript.segments;
    } else {
      const outboxStatus = await loadTranscriptOutboxStatus(row.tenant_id, row.interview_id);
      if (outboxStatus === "pending" || outboxStatus === "processing") {
        await deferRow(row.id, `waiting for transcript (transcript_outbox ${outboxStatus})`);
        log.info({ transcript_outbox_status: outboxStatus }, "ai_interview_evidence.deferred");
        return "deferred";
      }
      // failed / completed-without-transcript / never enqueued / unparseable
      // segments: the spoken answers will not get words. Proceed without them.
      log.warn(
        { transcript_outbox_status: outboxStatus, transcript: transcript.kind },
        "ai_interview_evidence.transcript_unavailable",
      );
    }
  }

  // ── 4. Round context ───────────────────────────────────────────────────
  const round = await loadRoundContext(row.tenant_id, row.interview_id);

  // ── 5. Answers ─────────────────────────────────────────────────────────
  // Masked per answer (not over the whole prompt) so the text quotes are
  // verified against is EXACTLY the text the model was shown.
  const assembled: AssembledAnswer[] = assembleAnswers({
    questions,
    answers,
    segments,
    rubric: round.rubric,
  }).map((a) => (a.text === null ? a : { ...a, text: maskPiiIf(aiSettings.piiMasking, a.text) }));

  const answeredCount = assembled.filter((a) => a.text !== null).length;
  if (answeredCount === 0) {
    const evidence = aiInterviewEvidenceSchema.parse({
      version: AI_INTERVIEW_EVIDENCE_VERSION,
      questions: assembled.map(emptyQuestionEvidence),
      knockouts: round.knockouts.map((question) => ({
        question,
        status: "not_mentioned",
        quote: null,
        questionKey: null,
      })),
      summary: "No answer text was available to review for this round.",
      meta: { quotesDropped: 0, answeredCount: 0, questionCount: questions.length },
    } satisfies AiInterviewEvidence);
    await poolSql`
      UPDATE public.ai_interview_evidence
      SET status = 'skipped',
          last_error = 'no usable answer text (unanswered, or transcript unavailable)',
          evidence = ${JSON.stringify(evidence)}::jsonb,
          model = NULL, prompt_version = NULL, generated_at = now(),
          lease_expires_at = NULL, updated_at = now()
      WHERE id = ${row.id}
    `;
    log.info({ reason: "no_answer_text" }, "ai_interview_evidence.skipped");
    return "skipped";
  }

  // ── 6. The model call ──────────────────────────────────────────────────
  const built = buildAiInterviewEvidencePrompt({
    questions: toEvidencePromptQuestions(assembled),
    rubric: round.rubric,
    competencyFocus: round.competencyFocus,
    knockouts: round.knockouts,
  });

  const client = await getAIClient(row.tenant_id);
  const response = await client.completeStructured<AiInterviewEvidenceAiResponse>({
    system: built.system,
    prompt: built.user,
    model: feature.model,
    temperature: feature.temperature,
    maxTokens: feature.maxTokens,
    schema: aiInterviewEvidenceAiJsonSchema,
    schemaName: AI_INTERVIEW_EVIDENCE_SCHEMA_NAME,
    feature: AI_INTERVIEW_EVIDENCE_FEATURE,
    // Correlates the ai_usage_logs row to this evidence row.
    requestId: row.id,
  });
  const raw = aiInterviewEvidenceAiSchema.parse(response);

  // ── 7. Verify, validate, write ─────────────────────────────────────────
  const reconciled = reconcileEvidence({
    raw,
    answers: assembled,
    rubric: round.rubric,
    knockouts: round.knockouts,
  });
  const evidence = aiInterviewEvidenceSchema.parse({
    version: AI_INTERVIEW_EVIDENCE_VERSION,
    questions: reconciled.questions,
    knockouts: reconciled.knockouts,
    summary: reconciled.summary,
    meta: {
      quotesDropped: reconciled.quotesDropped,
      answeredCount: reconciled.answeredCount,
      questionCount: questions.length,
    },
  } satisfies AiInterviewEvidence);

  const model = await resolveUsedModel(row.tenant_id, row.id, feature.model);
  await poolSql`
    UPDATE public.ai_interview_evidence
    SET status = 'done',
        evidence = ${JSON.stringify(evidence)}::jsonb,
        model = ${model},
        prompt_version = ${AI_INTERVIEW_EVIDENCE_PROMPT_VERSION},
        generated_at = now(),
        last_error = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = ${row.id}
  `;
  log.info(
    {
      model,
      prompt_version: AI_INTERVIEW_EVIDENCE_PROMPT_VERSION,
      question_count: questions.length,
      answered_count: reconciled.answeredCount,
      quotes_dropped: reconciled.quotesDropped,
      transcript_unavailable: assembled.filter((a) => a.transcriptUnavailable).length,
    },
    "ai_interview_evidence.done",
  );
  return "done";
}

/**
 * Release the claim WITHOUT charging an attempt (nothing was tried) and park
 * the row: back to 'pending' with lease_expires_at as its not-before, so the
 * next passes skip it instead of spinning on a transcript that is minutes away.
 */
async function deferRow(id: string, reason: string): Promise<void> {
  await poolSql`
    UPDATE public.ai_interview_evidence
    SET status = 'pending',
        attempt_count = GREATEST(attempt_count - 1, 0),
        lease_expires_at = now() + (${AI_INTERVIEW_EVIDENCE_DEFER_MS}::int * interval '1 millisecond'),
        last_error = ${reason},
        updated_at = now()
    WHERE id = ${id}
  `;
}

type TranscriptLoad =
  | { kind: "present"; segments: EvidenceTranscriptSegment[] }
  | { kind: "absent" }
  /** A row exists but its segments do not parse, or diarisation produced none. */
  | { kind: "unusable" };

async function loadTranscriptSegments(
  tenantId: string,
  interviewId: string,
): Promise<TranscriptLoad> {
  const [row] = await poolSql<{ segments: unknown }[]>`
    SELECT segments FROM public.interview_transcripts
    WHERE tenant_id = ${tenantId} AND interview_id = ${interviewId}
  `;
  if (!row) return { kind: "absent" };
  const parsed = transcriptSegmentsSchema.safeParse(row.segments);
  // Zero segments with speech in full_text (AssemblyAI can return text with no
  // utterances) has no timings to slice by, so per-answer recovery is
  // impossible — "unusable", not "silence".
  if (!parsed.success || parsed.data.length === 0) return { kind: "unusable" };
  return { kind: "present", segments: parsed.data };
}

/**
 * The round's transcript_outbox status, or null when none exists. One AI
 * round is one recording (0119), so there is at most one row.
 */
async function loadTranscriptOutboxStatus(
  tenantId: string,
  interviewId: string,
): Promise<string | null> {
  const [row] = await poolSql<{ status: string }[]>`
    SELECT o.status
    FROM public.transcript_outbox o
    JOIN public.interview_recordings r
      ON r.tenant_id = o.tenant_id AND r.id = o.recording_id
    WHERE r.tenant_id = ${tenantId} AND r.interview_id = ${interviewId}
    ORDER BY o.created_at DESC
    LIMIT 1
  `;
  return row?.status ?? null;
}

/**
 * The rubric, competency focus and knockout requirement TEXT — mirroring
 * apps/api/src/lib/ai-interview-questions.ts (`resolveRoundRubric`,
 * `competencyFocusOf`, the knockouts query) so the evidence speaks the same
 * vocabulary the questions were validated against. Thresholds are never read.
 */
async function loadRoundContext(
  tenantId: string,
  interviewId: string,
): Promise<{ rubric: ScorecardCriterion[]; competencyFocus: string[]; knockouts: string[] }> {
  const [row] = await poolSql<
    {
      requisition_id: string;
      scorecard_template: string | null;
      scorecard_criteria_snapshot: unknown;
      competency_focus: unknown;
    }[]
  >`
    SELECT iv.requisition_id, iv.scorecard_template, iv.scorecard_criteria_snapshot,
           pl.competency_focus
    FROM public.interviews iv
    LEFT JOIN public.interview_plans pl
      ON pl.tenant_id = iv.tenant_id
     AND pl.requisition_id = iv.requisition_id
     AND pl.round_number = iv.round_number
    WHERE iv.tenant_id = ${tenantId} AND iv.id = ${interviewId}
  `;
  if (!row) throw new TerminalEvidenceError(`interview ${interviewId} not found`);

  let rubric = coerceScorecardCriteria(row.scorecard_criteria_snapshot);
  if (rubric.length === 0) {
    // SAME fallback as resolveRoundRubric / saveInterviewFeedback.
    const custom = await poolSql<{ scorecard_key: string; criteria: unknown }[]>`
      SELECT scorecard_key, criteria
      FROM public.tenant_scorecard_template
      WHERE tenant_id = ${tenantId}
    `;
    const tenantCriteria = new Map<string, readonly ScorecardCriterion[]>();
    for (const c of custom) {
      const criteria = coerceScorecardCriteria(c.criteria);
      if (criteria.length > 0) tenantCriteria.set(c.scorecard_key, criteria);
    }
    rubric = [...resolveScorecardCriteria(row.scorecard_template ?? "general", tenantCriteria)];
  }

  const competencyFocus = Array.isArray(row.competency_focus)
    ? row.competency_focus.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];

  // question_text only — the threshold is withheld on purpose.
  const knockoutRows = await poolSql<{ question_text: string }[]>`
    SELECT question_text
    FROM public.requisition_knockouts
    WHERE tenant_id = ${tenantId} AND requisition_id = ${row.requisition_id}
    ORDER BY order_index, question_text
  `;
  const knockouts = knockoutRows
    .map((k) => k.question_text.trim().slice(0, KNOCKOUT_TEXT_MAX))
    .filter((k) => k.length > 0);

  return { rubric, competencyFocus, knockouts };
}

/**
 * Which model actually answered — read back off the ai_usage_logs row the call
 * just wrote, keyed on this row's id (the transcript-drain precedent). Falls
 * back to the model we asked for.
 */
async function resolveUsedModel(
  tenantId: string,
  evidenceId: string,
  requestedModel: string,
): Promise<string> {
  const [usage] = await poolSql<{ model: string }[]>`
    SELECT model FROM public.ai_usage_logs
    WHERE tenant_id = ${tenantId}
      AND feature = ${AI_INTERVIEW_EVIDENCE_FEATURE}
      AND request_id = ${evidenceId}
      AND succeeded = true
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return usage?.model ?? requestedModel;
}
