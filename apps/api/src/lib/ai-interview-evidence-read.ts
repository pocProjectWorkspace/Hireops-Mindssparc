/**
 * AI-INT-3 — the recruiter's EVIDENCE REVIEW of a submitted AI round: the
 * read behind the evidence panel, and the one mutation next to it.
 *
 * The drain in apps/workers (AI-INT-2) writes `ai_interview_evidence`; this
 * module only reads it back, pairs it with the candidate's own answers, and
 * lets a recruiter put the row back in the queue.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ANSWERS ARE THE DRAIN'S ANSWERS
 * ─────────────────────────────────────────────────────────────────────────
 * The answer text on this wire comes from `assembleAnswers` in
 * @hireops/api-types — the SAME pure function the drain grounds its prompt in
 * and verifies every quote against. A reviewer reading a quote and the answer
 * beside it is therefore reading two views of one string, not two
 * reconstructions that could disagree at a segment boundary. (The drain may
 * PII-mask what it sends to the model; the reviewer sees the unmasked words,
 * exactly as the transcript view already shows them.)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVIDENCE ONLY
 * ─────────────────────────────────────────────────────────────────────────
 * Nothing here computes or returns a score, rating, rank, pass/fail or
 * recommendation. The panel's decision stays in the human scorecard flow.
 *
 * Client shape follows ai-interview-questions.ts: the postgres.js service-role
 * pool (ctx.sql) with an EXPLICIT tenant_id predicate on every statement,
 * because that client BYPASSES RLS.
 */

import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { resolveTenantAiSettingsDb } from "@hireops/ai-client";
import {
  aiInterviewEvidenceSchema,
  assembleAnswers,
  coerceAiInterviewQuestions,
  coerceEvidenceAnswers,
  transcriptSegmentsSchema,
  type AiInterviewEvidence,
  type AiInterviewEvidenceAnswer,
  type AiInterviewEvidenceReadStatus,
  type EvidenceTranscriptSegment,
} from "@hireops/api-types";

/** postgres.js tagged-template client (same shape as ctx.sql / poolSql). */
type PgSqlClient = typeof poolSql;

const STORED_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "processing",
  "done",
  "failed",
  "skipped",
]);

interface EvidenceReadRow {
  interview_id: string;
  candidate_id: string | null;
  session_id: string | null;
  session_status: string | null;
  questions: unknown;
  turn_state: unknown;
  evidence_status: string | null;
  evidence: unknown;
  model: string | null;
  prompt_version: string | null;
  generated_at: Date | string | null;
  last_error: string | null;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * The interview, its session and its evidence row in ONE read. LEFT JOINs: a
 * round with no session, or a session with no evidence row, are normal states.
 */
async function loadEvidenceRow(
  sql: PgSqlClient,
  tenantId: string,
  interviewId: string,
): Promise<EvidenceReadRow | null> {
  const [row] = await sql<EvidenceReadRow[]>`
    SELECT
      iv.id               AS interview_id,
      a.candidate_id,
      s.id                AS session_id,
      s.status            AS session_status,
      s.questions,
      s.turn_state,
      e.status            AS evidence_status,
      e.evidence,
      e.model,
      e.prompt_version,
      e.generated_at,
      e.last_error
    FROM public.interviews iv
    LEFT JOIN public.applications a
      ON a.tenant_id = iv.tenant_id AND a.id = iv.application_id
    LEFT JOIN public.ai_interview_sessions s
      ON s.tenant_id = iv.tenant_id AND s.interview_id = iv.id
    LEFT JOIN public.ai_interview_evidence e
      ON e.tenant_id = s.tenant_id AND e.session_id = s.id
    WHERE iv.tenant_id = ${tenantId} AND iv.id = ${interviewId}
    LIMIT 1
  `;
  return row ?? null;
}

/**
 * The stored `last_error` → a short, FIXED string safe to put on screen.
 *
 * The raw column can carry a provider's error text, a stack-ish message or an
 * internal id; none of that belongs in front of a recruiter. Only the reasons
 * the drain writes deliberately are translated; anything else collapses to a
 * generic line (failed) or to nothing.
 */
export function toSafeLastError(status: string | null, raw: string | null): string | null {
  if (!raw) return status === "failed" ? "The evidence report could not be generated." : null;
  if (status === "skipped") {
    if (raw.startsWith("feature disabled")) {
      return "Evidence reports are switched off for this tenant.";
    }
    if (raw.startsWith("no usable answer text")) {
      return "No usable answer text — the questions were unanswered or the transcript was unavailable.";
    }
    return null;
  }
  if (status === "pending" || status === "processing") {
    return raw.startsWith("waiting for transcript") ? "Waiting for the transcript." : null;
  }
  if (status === "failed") return "The evidence report could not be generated.";
  return null;
}

/**
 * The round's diarised transcript segments, or null when there is no usable
 * transcript — the drain's own rule: absent, unparseable or zero segments all
 * mean "a spoken answer cannot be recovered".
 */
async function loadSegments(
  sql: PgSqlClient,
  tenantId: string,
  interviewId: string,
): Promise<EvidenceTranscriptSegment[] | null> {
  const [row] = await sql<{ segments: unknown }[]>`
    SELECT segments FROM public.interview_transcripts
    WHERE tenant_id = ${tenantId} AND interview_id = ${interviewId}
  `;
  if (!row) return null;
  const parsed = transcriptSegmentsSchema.safeParse(row.segments);
  if (!parsed.success || parsed.data.length === 0) return null;
  return parsed.data;
}

export interface GetEvidenceInput {
  tenantId: string;
  interviewId: string;
  /**
   * ADR-002 §7 — fired with the candidate id when answer text (the
   * candidate's own words) is actually returned. The router records the PII
   * access; the lib stays free of the audit plumbing.
   */
  onPiiRead?: (candidateId: string) => void;
}

export interface GetEvidenceResult {
  status: AiInterviewEvidenceReadStatus;
  evidence: AiInterviewEvidence | null;
  model: string | null;
  promptVersion: string | null;
  generatedAt: string | null;
  lastError: string | null;
  answers: AiInterviewEvidenceAnswer[];
}

/**
 * The recruiter's evidence read.
 *
 * Answers are returned only for a SUBMITTED session — before that the round
 * is still the candidate's, and the panel is only mounted on submitted rounds.
 */
export async function getEvidence(
  sql: PgSqlClient,
  input: GetEvidenceInput,
): Promise<GetEvidenceResult> {
  const row = await loadEvidenceRow(sql, input.tenantId, input.interviewId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });

  const status: AiInterviewEvidenceReadStatus =
    row.evidence_status && STORED_STATUSES.has(row.evidence_status)
      ? (row.evidence_status as AiInterviewEvidenceReadStatus)
      : "none";

  // A stored report that no longer parses is shown as absent rather than
  // thrown — the coerce posture of every other read on this table family.
  const parsed = row.evidence === null ? null : aiInterviewEvidenceSchema.safeParse(row.evidence);
  const evidence = parsed?.success ? parsed.data : null;

  let answers: AiInterviewEvidenceAnswer[] = [];
  if (row.session_id && row.session_status === "submitted") {
    const questions = coerceAiInterviewQuestions(row.questions);
    const turnAnswers = coerceEvidenceAnswers(row.turn_state);
    const segments = turnAnswers.some((a) => a.mode === "voice")
      ? await loadSegments(sql, input.tenantId, input.interviewId)
      : null;
    answers = assembleAnswers({ questions, answers: turnAnswers, segments, rubric: [] }).map(
      (a) => ({
        questionKey: a.questionKey,
        prompt: a.prompt,
        rubricKey: a.rubricKey,
        mode: a.answerMode,
        text: a.text,
        answerStartMs: a.answerStartMs,
        transcriptUnavailable: a.transcriptUnavailable,
      }),
    );
    if (row.candidate_id && answers.some((a) => a.text !== null)) {
      input.onPiiRead?.(row.candidate_id);
    }
  }

  return {
    status,
    evidence,
    model: row.model,
    promptVersion: row.prompt_version,
    generatedAt: toIso(row.generated_at),
    lastError: toSafeLastError(row.evidence_status, row.last_error),
    answers,
  };
}

export interface RegenerateEvidenceInput {
  tenantId: string;
  interviewId: string;
}

/**
 * Put the round's evidence report back in the queue.
 *
 * Order of refusals:
 *   1. interview exists                     → NOT_FOUND
 *   2. session exists and is 'submitted'    → CONFLICT (nothing to report on)
 *   3. tenant kill switch                   → BAD_REQUEST, with the admin hint
 *   4. reset the row to a clean 'pending', or insert it if it is missing.
 *
 * The reset touches only the queue fields (status, attempt_count, lease,
 * last_error). A previous report stays in `evidence` until the drain
 * overwrites it — the panel keys off `status`, so it is not shown while the
 * row is pending, and a failed regeneration does not destroy the last good
 * one. A row the drain currently holds ('processing' under a
 * live lease) is reset as well: the drain's final UPDATE is keyed on the row
 * id, so at worst the in-flight result lands and is then regenerated again —
 * never a lost row.
 */
export async function regenerateEvidence(
  sql: PgSqlClient,
  input: RegenerateEvidenceInput,
): Promise<{ status: AiInterviewEvidenceReadStatus }> {
  const row = await loadEvidenceRow(sql, input.tenantId, input.interviewId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
  if (!row.session_id || row.session_status !== "submitted") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "An evidence report can only be generated once the candidate has submitted.",
    });
  }

  const aiSettings = await resolveTenantAiSettingsDb(input.tenantId);
  if (!aiSettings.ai_interview_evidence.enabled) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "AI interview evidence reports are disabled for this tenant. An admin can re-enable them in Admin → AI settings.",
    });
  }

  // Upsert on the one-row-per-session unique. INSERT … ON CONFLICT DO UPDATE
  // makes "missing" and "present" one statement, so a concurrent submit's
  // own enqueue cannot race this into a 23505.
  const [out] = await sql<{ status: string }[]>`
    INSERT INTO public.ai_interview_evidence (tenant_id, session_id, interview_id, status)
    VALUES (${input.tenantId}, ${row.session_id}, ${row.interview_id}, 'pending')
    ON CONFLICT (tenant_id, session_id) DO UPDATE
    SET status = 'pending',
        attempt_count = 0,
        lease_expires_at = NULL,
        last_error = NULL,
        updated_at = now()
    RETURNING status
  `;
  return { status: out?.status === "pending" ? "pending" : "none" };
}
