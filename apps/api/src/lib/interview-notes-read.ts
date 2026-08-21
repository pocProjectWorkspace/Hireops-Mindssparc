/**
 * N3.4b — reading one round's transcript + AI notes.
 *
 * The notetaker chain has had a producer since N3.4a and a consumer since
 * N3.3b, but nothing that hands the result to a human. This is that read, and
 * it is the ONLY thing this module does: no regeneration, no edit, no delete.
 * A transcript is insert-once and the notes are a derived cache the drain
 * owns; a read path that could also write is how "who changed what a hiring
 * decision was based on" stops being answerable.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ACCESS QUESTION, WHICH IS NOT THE SAME AS N3.4a's
 * ─────────────────────────────────────────────────────────────────────────
 * N3.4a gates on INTERVIEW_MANAGE_ROLES because attaching media to a round is
 * running the hiring process. Reading the notes is a different question with a
 * different answer: the PANELLISTS who sat in the room are the primary
 * audience, and `panel_member` is deliberately outside that set.
 *
 * So the gate is TWO conditions, not one widened role set:
 *
 *   hasManageRole  — admin / hiring_manager / recruiter pass on role alone,
 *                    exactly as they do for every other interview surface.
 *   membershipId   — anyone else must be a panellist ON THIS INTERVIEW. Not
 *                    "a panel member somewhere in the tenant": the row must
 *                    exist in interview_panelists for this interview.
 *
 * Widening the role set instead would let any panel_member in the tenant read
 * any round's transcript — every candidate, every requisition — which is the
 * single worst thing this feature could do. The per-interview membership check
 * is the real boundary; the role set is only the coarse filter in front of it.
 * This mirrors the panel procedures' own `isAdmin || myPanelist` posture
 * (getPanelInterviewBrief), stated the same way and enforced in one place so
 * the two cannot drift.
 *
 * Client shape follows interview-media-upload.ts: a postgres.js tagged-template
 * client (ctx.sql, the service-role pool) with an EXPLICIT tenant_id predicate
 * on every statement, because that client BYPASSES RLS.
 */

import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { resolveTenantAiSettingsDb } from "@hireops/ai-client";
import {
  transcriptSegmentsSchema,
  type GetInterviewNotesOutput,
  type InterviewNotesCard,
  type InterviewTranscriptCard,
} from "@hireops/api-types";
import { readRecordingMedia } from "./interview-media-upload";

/** postgres.js tagged-template client (same shape as ctx.sql / poolSql). */
type PgSqlClient = typeof poolSql;

export interface InterviewNotesAccess {
  tenantId: string;
  interviewId: string;
  /**
   * True when the caller holds one of INTERVIEW_MANAGE_ROLES (admin included
   * — it is the super-role). Resolved by the router from ctx.roles; this
   * module never re-derives roles, it only decides what they buy.
   */
  hasManageRole: boolean;
  /**
   * The caller's tenant_user_memberships.id, or null when they have none.
   * Only consulted when `hasManageRole` is false — it is what the
   * per-interview panellist check is made against.
   */
  membershipId: string | null;
  /**
   * Called with the candidate's id once authorisation has PASSED, so the router
   * can write the ADR-002 §7 PII access record. A callback rather than the
   * logging itself because that record needs request context (actor, request
   * id) this module deliberately does not take — it gets a sql handle and an
   * access decision, nothing else.
   *
   * Optional so a non-request caller (a worker, a test) can read without
   * inventing an actor. Nothing that serves a human should omit it.
   */
  onPiiRead?: (candidateId: string) => Promise<void> | void;
}

interface TranscriptNotesRow {
  transcript_id: string | null;
  recording_id: string | null;
  segments: unknown;
  full_text: string | null;
  language: string | null;
  provider: string | null;
  provider_model: string | null;
  word_count: number | null;
  transcript_created_at: Date | string | null;
  notes_transcript_id: string | null;
  summary: string | null;
  key_points: unknown;
  topics_covered: unknown;
  questions_asked: unknown;
  follow_ups: unknown;
  model: string | null;
  prompt_version: string | null;
  generated_at: Date | string | null;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * A nullable jsonb array of strings, as a reader wants it.
 *
 * The columns are nullable and the wire shape is not (see
 * interviewNotesCardSchema): "the model returned no follow-ups" and "this row
 * predates the section" are the same thing to somebody reading the notes, and
 * making every consumer branch on null as well as [] buys nothing. Non-string
 * members are dropped rather than coerced — jsonb accepts anything, and a
 * `[object Object]` bullet in a panellist's notes is worse than a missing one.
 */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Is this membership a panellist on this interview?
 *
 * Same semantics as the router's `findPanelistRow`, expressed against the
 * service-role client this module uses — hence the explicit tenant predicate,
 * which the RLS-bound drizzle handle gets for free and this one does not. Hits
 * uniq_interview_panelists_interview_membership directly.
 */
async function isPanelistOnInterview(
  sql: PgSqlClient,
  tenantId: string,
  interviewId: string,
  membershipId: string,
): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM public.interview_panelists
    WHERE tenant_id = ${tenantId}
      AND interview_id = ${interviewId}
      AND membership_id = ${membershipId}
    LIMIT 1
  `;
  return Boolean(row);
}

/**
 * The transcript and the notes in ONE round trip.
 *
 * LEFT JOIN because a transcript with no notes is a normal state (the tenant's
 * `interview_notes` switch is off, or the notes half of the drain pass has not
 * run yet), not a missing child. Joined on transcript_id rather than
 * interview_id so the notes returned are provably derived from the transcript
 * returned alongside them — the two are separately denormalised onto the
 * interview, and joining on that would let a stale pair look consistent.
 */
async function loadTranscriptAndNotes(
  sql: PgSqlClient,
  tenantId: string,
  interviewId: string,
): Promise<TranscriptNotesRow | null> {
  const [row] = await sql<TranscriptNotesRow[]>`
    SELECT t.id            AS transcript_id,
           t.recording_id  AS recording_id,
           t.segments      AS segments,
           t.full_text     AS full_text,
           t.language      AS language,
           t.provider      AS provider,
           t.provider_model AS provider_model,
           t.word_count    AS word_count,
           t.created_at    AS transcript_created_at,
           n.transcript_id AS notes_transcript_id,
           n.summary       AS summary,
           n.key_points    AS key_points,
           n.topics_covered AS topics_covered,
           n.questions_asked AS questions_asked,
           n.follow_ups    AS follow_ups,
           n.model         AS model,
           n.prompt_version AS prompt_version,
           n.generated_at  AS generated_at
    FROM public.interview_transcripts t
    LEFT JOIN public.interview_notes n
      ON n.tenant_id = t.tenant_id AND n.transcript_id = t.id
    WHERE t.tenant_id = ${tenantId} AND t.interview_id = ${interviewId}
    LIMIT 1
  `;
  return row ?? null;
}

function toTranscriptCard(
  interviewId: string,
  row: TranscriptNotesRow,
): InterviewTranscriptCard | null {
  if (!row.transcript_id || !row.recording_id) return null;

  // The drain validates segments against this same schema BEFORE the insert,
  // so a parse failure here means a row that did not come through the drain.
  // Fall back to no turns rather than 500ing the whole read: `fullText` is
  // NOT NULL, so the reader still gets the transcript, just without the
  // speaker turns — which is the same degraded rendering as a recording
  // diarisation produced no utterances for.
  const parsed = transcriptSegmentsSchema.safeParse(row.segments);

  return {
    interviewId,
    recordingId: row.recording_id,
    segments: parsed.success ? parsed.data : [],
    fullText: row.full_text ?? "",
    language: row.language,
    provider: row.provider,
    providerModel: row.provider_model,
    wordCount: row.word_count,
    createdAt: toIso(row.transcript_created_at),
  };
}

function toNotesCard(interviewId: string, row: TranscriptNotesRow): InterviewNotesCard | null {
  if (!row.notes_transcript_id) return null;
  return {
    interviewId,
    transcriptId: row.notes_transcript_id,
    summary: row.summary,
    keyPoints: toStringArray(row.key_points),
    topicsCovered: toStringArray(row.topics_covered),
    questionsAsked: toStringArray(row.questions_asked),
    followUps: toStringArray(row.follow_ups),
    model: row.model,
    promptVersion: row.prompt_version,
    generatedAt: toIso(row.generated_at),
  };
}

/**
 * Authorise, then read. Throws NOT_FOUND when the interview does not exist in
 * this tenant and FORBIDDEN when the caller is neither running the round nor
 * on its panel.
 *
 * The interview lookup comes FIRST and is deliberately not merged into the
 * transcript query: "this interview isn't yours" and "this interview has no
 * transcript yet" are different answers, and a surface that shows the empty
 * state for a round in another business unit would be quietly wrong about
 * whose data it is showing.
 */
export async function getInterviewNotes(
  sql: PgSqlClient,
  access: InterviewNotesAccess,
): Promise<GetInterviewNotesOutput> {
  const { tenantId, interviewId } = access;

  // candidate_id comes along for the PII access record (see onPiiRead below) —
  // the transcript is this candidate's own words, so the log has to name them.
  const [interview] = await sql<{ id: string; candidate_id: string | null }[]>`
    SELECT i.id, a.candidate_id
    FROM public.interviews i
    LEFT JOIN public.applications a
      ON a.tenant_id = i.tenant_id AND a.id = i.application_id
    WHERE i.tenant_id = ${tenantId} AND i.id = ${interviewId}
    LIMIT 1
  `;
  if (!interview) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });

  if (!access.hasManageRole) {
    const permitted =
      access.membershipId !== null &&
      (await isPanelistOnInterview(sql, tenantId, interviewId, access.membershipId));
    if (!permitted) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You are not a panellist on this interview.",
      });
    }
  }

  // ADR-002 §7. Fired AFTER authorisation, so a refused read is not recorded as
  // an access — a FORBIDDEN is an attempt, and conflating the two makes the log
  // useless as evidence of who actually read what.
  //
  // A transcript is the most PII-dense artefact this platform holds: it is the
  // candidate's own unedited speech, not a curated field. getPanelInterviewBrief
  // already logs for name/location/parsed_skills, so a read of everything the
  // candidate SAID must be at least as accountable.
  if (access.onPiiRead && interview.candidate_id) {
    await access.onPiiRead(interview.candidate_id);
  }

  const [recording, row, aiSettings] = await Promise.all([
    readRecordingMedia(sql, tenantId, interviewId),
    loadTranscriptAndNotes(sql, tenantId, interviewId),
    resolveTenantAiSettingsDb(tenantId),
  ]);

  return {
    interviewId,
    recording,
    transcript: row ? toTranscriptCard(interviewId, row) : null,
    notes: row ? toNotesCard(interviewId, row) : null,
    notesEnabled: aiSettings.interview_notes.enabled,
  };
}
