/**
 * N3.4a — recruiter media upload, and THE ENQUEUE.
 *
 * Everything the notetaker had before this file was a consumer with no
 * producer: `transcript_outbox` is drained by
 * apps/workers/src/lib/transcript-drain.ts, but nothing outside a test ever
 * inserted a row into it. This module is the producer. `completeUpload`'s
 * INSERT is the seam where media → transcript → notes actually starts.
 *
 * Two steps, because the bytes do not come through the API:
 *
 *   1. startUpload  — authorise, create/reuse the interview_recordings row,
 *                     hand back a short-lived signed PUT url.
 *   2. completeUpload — the browser says the PUT finished; verify the object
 *                     is really there, stamp the true size, enqueue.
 *
 * The API is deliberately OUT OF THE BYTE PATH. A one-hour panel recording
 * is ~60MB and the ceiling is 250MB (upload-limits.ts derives both); pushing
 * that through a tRPC procedure would mean buffering it in the heap of a
 * container sized for JSON, and then doing it again when the drain fetches
 * it. The API authorises and records; storage carries.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GATE IS canRecordInterview AND NOTHING ELSE
 * ─────────────────────────────────────────────────────────────────────────
 * No upload starts unless BOTH the recruiter's `recording_requested` toggle
 * and an effective 'granted' consent are present. That resolution lives in
 * interview-recording-consent.ts and is not re-implemented here — a second
 * implementation is exactly how a consent gate silently drifts open. What
 * this module adds is only the DIAGNOSIS: "the candidate has not consented"
 * and "recording was not requested for this round" are different problems
 * with different fixes, so the refusal says which one it is.
 *
 * Client shape follows the consent lib: a postgres.js tagged-template client
 * (ctx.sql, the service-role pool) with an EXPLICIT tenant_id predicate on
 * every statement, because that client BYPASSES RLS.
 */

import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import type { InterviewRecordingMedia } from "@hireops/api-types";
import { canRecordInterview, type RecordingGate } from "./interview-recording-consent";
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
 * File extension per accepted container. COSMETIC ONLY — the ASR client is
 * handed `media_type`, never the key, so a wrong extension changes nothing
 * downstream. It exists so a human staring at the bucket during an incident
 * can tell what they are looking at.
 */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

/**
 * Object key for an interview's media.
 *
 * Keyed on the INTERVIEW, not the recording, and that is deliberate: 0116
 * puts UNIQUE (tenant_id, interview_id) on interview_recordings, so there is
 * exactly one recording per interview and the interview id is therefore just
 * as unique — but unlike the recording id it is known BEFORE the row exists,
 * which is what lets the key be computed and the row be upserted in one
 * statement rather than two round trips with a race between them.
 *
 * The tenant segment buys nothing technically (uuids are unique on their
 * own); it is there so the bucket is navigable by a human during an
 * incident.
 */
export function interviewMediaStorageKey(
  tenantId: string,
  interviewId: string,
  normalisedContentType: string,
): string {
  const ext = EXTENSION_BY_TYPE[normalisedContentType] ?? "bin";
  return `interview-media/${tenantId}/${interviewId}.${ext}`;
}

/** The recording statuses a fresh upload may overwrite. See startUpload. */
const RESTARTABLE_STATUSES = new Set(["pending", "uploaded"]);

/**
 * Postgres unique-violation. CODE-BASED, never a substring match on the
 * message: drizzle (and, on some paths, postgres.js itself) wraps the driver
 * error, so the code can sit one level down on `.cause` while the outer
 * message says nothing about a constraint at all.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const causeCode = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

interface RecordingRow {
  id: string;
  source: string;
  status: string;
  storage_key: string | null;
  media_type: string | null;
  duration_seconds: number | null;
  size_bytes: string | number | null;
  uploaded_at: Date | string | null;
  media_purged_at: Date | string | null;
  queue_status: string | null;
  queue_error: string | null;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** bigint columns arrive from postgres.js as strings — a JSON number is what the wire needs. */
function toIntOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toView(row: RecordingRow): InterviewRecordingMedia {
  return {
    recordingId: row.id,
    source: row.source as InterviewRecordingMedia["source"],
    status: row.status as InterviewRecordingMedia["status"],
    mediaType: row.media_type,
    sizeBytes: toIntOrNull(row.size_bytes),
    durationSeconds: row.duration_seconds,
    uploadedAt: toIso(row.uploaded_at),
    mediaPurgedAt: toIso(row.media_purged_at),
    queueStatus: row.queue_status as InterviewRecordingMedia["queueStatus"],
    queueError: row.queue_error,
  };
}

/**
 * The recording plus its outbox status in one read. LEFT JOIN because a
 * recording that has never been completed has no outbox row — and that is a
 * normal state ("uploaded but never enqueued" is what a crashed browser
 * leaves behind), not a missing parent.
 */
async function loadRecording(
  sql: PgSqlClient,
  tenantId: string,
  interviewId: string,
): Promise<RecordingRow | null> {
  const [row] = await sql<RecordingRow[]>`
    SELECT r.id, r.source, r.status, r.storage_key, r.media_type, r.duration_seconds,
           r.size_bytes, r.uploaded_at, r.media_purged_at,
           o.status AS queue_status, o.last_error AS queue_error
    FROM public.interview_recordings r
    LEFT JOIN public.transcript_outbox o
      ON o.tenant_id = r.tenant_id AND o.recording_id = r.id
    WHERE r.tenant_id = ${tenantId} AND r.interview_id = ${interviewId}
    LIMIT 1
  `;
  return row ?? null;
}

export interface InterviewMediaState {
  gate: RecordingGate;
  recording: InterviewRecordingMedia | null;
  maxBytes: number;
  allowedContentTypes: string[];
}

/**
 * Everything the upload control renders from, in one round trip. Returns
 * null when the interview does not exist in this tenant so the caller can
 * map that to its own not-found posture (same contract as
 * canRecordInterview).
 */
export async function getInterviewMediaState(
  sql: PgSqlClient,
  tenantId: string,
  interviewId: string,
): Promise<InterviewMediaState | null> {
  const gate = await canRecordInterview(sql, tenantId, interviewId);
  if (!gate) return null;
  const row = await loadRecording(sql, tenantId, interviewId);
  return {
    gate,
    recording: row ? toView(row) : null,
    maxBytes: maxMediaBytes(),
    allowedContentTypes: [...ALLOWED_AUDIO_TYPES],
  };
}

/**
 * THE GATE, with a diagnosis attached.
 *
 * canRecordInterview's `canRecord` is a single boolean because that is the
 * only thing an enforcement point should branch on. But a recruiter looking
 * at a greyed-out upload button needs to know which of the two independent
 * facts is missing, because the fixes are unrelated: one is "ask the
 * candidate", the other is "flip the toggle". So the refusal names it.
 */
function assertCanRecord(gate: RecordingGate): void {
  if (gate.canRecord) return;

  const reasons: string[] = [];
  if (!gate.recordingRequested) {
    reasons.push("recording has not been requested for this round");
  }
  if (!gate.consent.permitted) {
    reasons.push(
      gate.consent.decision === null
        ? "the candidate has not been asked for recording consent"
        : gate.consent.decision === "declined"
          ? "the candidate declined recording"
          : "the candidate withdrew their recording consent",
    );
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message: `Cannot upload a recording for this interview: ${reasons.join("; ")}.`,
  });
}

export interface StartUploadInput {
  tenantId: string;
  interviewId: string;
  /** Raw, as the browser reported it — "audio/webm;codecs=opus" is normal. */
  contentType: string;
  /** The browser's DECLARED size. Re-checked against reality on complete. */
  sizeBytes: number;
  /** tenant_user_memberships.id of the caller — the provenance leg. */
  requestedByMembershipId: string;
}

export interface StartUploadResult {
  recordingId: string;
  storageKey: string;
  uploadUrl: string;
  method: "PUT";
  token: string | null;
  expiresAt: string;
  provider: "supabase" | "local";
  /** The normalised type we stored — what the browser should send. */
  contentType: string;
}

/**
 * Step 1: authorise and mint the signed PUT url.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RE-UPLOAD, AND WHY THIS REFUSES AFTER TRANSCRIPTION
 * ─────────────────────────────────────────────────────────────────────────
 * UNIQUE (tenant_id, interview_id) means a second upload attempt cannot just
 * INSERT — it would 23505. There are three honest answers and we take a
 * different one per state:
 *
 *   pending / uploaded → REUSE THE ROW. Nothing has been derived from this
 *     media yet, so replacing it costs nothing and loses nothing. The row is
 *     reset to 'pending', which is not cosmetic: the drain DEFERS a pending
 *     recording without burning an attempt, so if an outbox row is already
 *     queued from a previous complete() it will simply wait rather than
 *     transcribe half-written bytes.
 *
 *   transcribing / transcribed / failed → REFUSE. Once a transcript exists,
 *     new media makes the transcript and the notes derived from it describe
 *     an artefact that is no longer there, and there is no coherent answer to
 *     "which of these two is the record of the interview?" that this ticket
 *     is scoped to give. Re-transcription — invalidate the transcript,
 *     regenerate the notes, re-enqueue — is a deliberate later ticket, not
 *     something to fall into by accident. 'failed' joins them because its
 *     outbox row is terminal: replacing the media would leave a row nothing
 *     will ever drain, which looks like success and is not.
 *
 *   media_purged_at set → REFUSE. Clearing it to accept new bytes would erase
 *     the record that retention ran on schedule.
 */
export async function startUpload(
  sql: PgSqlClient,
  input: StartUploadInput,
): Promise<StartUploadResult> {
  const gate = await canRecordInterview(sql, input.tenantId, input.interviewId);
  if (!gate) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
  assertCanRecord(gate);

  const contentType = normaliseMediaContentType(input.contentType);
  if (!isAllowedAudioType(contentType)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${input.contentType} is not a supported interview-audio type. ` +
        `Accepted: ${[...ALLOWED_AUDIO_TYPES].join(", ")}.`,
    });
  }
  const cap = maxMediaBytes();
  if (input.sizeBytes > cap) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Recording is ${input.sizeBytes} bytes; the limit is ${cap} bytes.`,
    });
  }

  const existing = await loadRecording(sql, input.tenantId, input.interviewId);
  if (existing) {
    if (existing.media_purged_at) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "The audio for this interview has already been deleted under the retention policy. " +
          "A new recording cannot be attached to it.",
      });
    }
    if (!RESTARTABLE_STATUSES.has(existing.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          `This interview already has a recording (status: ${existing.status}). ` +
          "Replacing media after transcription has started is not supported yet.",
      });
    }
  }

  const storageKey = interviewMediaStorageKey(input.tenantId, input.interviewId, contentType);

  // ON CONFLICT rather than "read, then branch": the read above is for the
  // DIAGNOSIS, not for the race. Two recruiters starting an upload at the
  // same instant both see no row and both INSERT; one of them must land on
  // an UPDATE instead of a 23505 the caller has no useful response to.
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO public.interview_recordings
      (id, tenant_id, interview_id, source, status, storage_key, media_type,
       requested_by_membership_id)
    VALUES (${randomUUID()}, ${input.tenantId}, ${input.interviewId}, 'manual_upload', 'pending',
            ${storageKey}, ${contentType}, ${input.requestedByMembershipId})
    ON CONFLICT (tenant_id, interview_id) DO UPDATE
      SET source = 'manual_upload',
          status = 'pending',
          storage_key = EXCLUDED.storage_key,
          media_type = EXCLUDED.media_type,
          -- The previous attempt's measurements describe bytes that are
          -- about to be overwritten. Keeping them would make the row claim a
          -- size and duration for media it no longer holds.
          size_bytes = NULL,
          duration_seconds = NULL,
          uploaded_at = NULL,
          requested_by_membership_id = EXCLUDED.requested_by_membership_id,
          updated_at = now()
      WHERE interview_recordings.status IN ('pending', 'uploaded')
        AND interview_recordings.media_purged_at IS NULL
    RETURNING id
  `;
  if (!row) {
    // The DO UPDATE's WHERE excluded the row — i.e. it moved into a
    // protected state between the read above and this statement. Rare, and
    // the same refusal either way.
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This interview's recording changed while the upload was being authorised. Reload and try again.",
    });
  }

  // A previous attempt with a DIFFERENT container left an object at a
  // different key. Nothing points at it any more, so delete it rather than
  // leave audio nobody can reach lying in the bucket past its retention.
  // Best-effort: an orphan is a tidiness problem, a failed upload is not.
  if (existing?.storage_key && existing.storage_key !== storageKey) {
    await getStorageClient()
      .delete(existing.storage_key)
      .catch(() => undefined);
  }

  // upsert:true because the key is derived from the interview and a
  // re-upload legitimately overwrites it. Not a widening: the url grants
  // write access to exactly one path, chosen by the API, for a recording row
  // we have just authorised.
  const signed = await getStorageClient().createSignedUploadUrl(storageKey, { upsert: true });

  return {
    recordingId: row.id,
    storageKey,
    uploadUrl: signed.url,
    method: signed.method,
    token: signed.token,
    expiresAt: signed.expiresAt.toISOString(),
    provider: signed.provider,
    contentType,
  };
}

export interface CompleteUploadInput {
  tenantId: string;
  interviewId: string;
  /** Optional hint from MediaRecorder / <audio>. Null when unknown. */
  durationSeconds?: number | null;
}

export interface CompleteUploadResult {
  recording: InterviewRecordingMedia;
  /** false when an outbox row already existed — a double-complete, absorbed. */
  enqueued: boolean;
}

/**
 * Step 2: verify, stamp, and ENQUEUE.
 *
 * This is the producer the notetaker has been missing. Everything before it
 * exists to make the INSERT below legitimate.
 */
export async function completeUpload(
  sql: PgSqlClient,
  input: CompleteUploadInput,
): Promise<CompleteUploadResult> {
  const gate = await canRecordInterview(sql, input.tenantId, input.interviewId);
  if (!gate) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
  // Re-checked, not assumed from startUpload. The two calls are separated by
  // however long the PUT took, and a consent withdrawal in that window must
  // stop the recording entering the pipeline — the bytes are in storage
  // either way, and 0118's retention sweep is what removes them.
  assertCanRecord(gate);

  const existing = await loadRecording(sql, input.tenantId, input.interviewId);
  if (!existing || !existing.storage_key) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No upload has been started for this interview.",
    });
  }
  // REFUSE TO ENQUEUE PURGED MEDIA. The drain handles this state correctly —
  // it completes the row cleanly as "media purged by retention" — but that is
  // a claim, a lease and an outbox row spent to discover something we already
  // know here. Enqueueing it would be pointless work dressed as progress.
  if (existing.media_purged_at) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "The audio for this interview has already been deleted under the retention policy.",
    });
  }
  if (existing.status === "transcribing" || existing.status === "transcribed") {
    throw new TRPCError({
      code: "CONFLICT",
      message: `This recording is already ${existing.status}; there is nothing to complete.`,
    });
  }
  if (existing.status === "failed") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This recording is in a failed state. Re-transcription is not supported yet.",
    });
  }

  // ── The object, not the client's word about it ──────────────────────────
  const storage = getStorageClient();
  let stat: StorageObjectStat;
  try {
    stat = await storage.stat(existing.storage_key);
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "No uploaded file was found in storage for this interview. Try the upload again.",
      });
    }
    throw err;
  }

  // The cap is enforced HERE as well as at start, because start only saw a
  // number the browser typed. This is the only check that sees the file.
  const cap = maxMediaBytes();
  if (stat.sizeBytes > cap) {
    // Delete it: nothing will ever reference an object we refuse to record,
    // and 0118's retention sweep only finds objects a recording row points
    // at. Best-effort — the refusal matters more than the tidy-up.
    await storage.delete(existing.storage_key).catch(() => undefined);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The uploaded file is ${stat.sizeBytes} bytes; the limit is ${cap} bytes.`,
    });
  }
  if (stat.sizeBytes === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The uploaded file is empty. Try the upload again.",
    });
  }

  const [updated] = await sql<{ id: string }[]>`
    UPDATE public.interview_recordings
    SET status = 'uploaded',
        uploaded_at = now(),
        size_bytes = ${stat.sizeBytes},
        duration_seconds = COALESCE(${input.durationSeconds ?? null}, duration_seconds),
        updated_at = now()
    WHERE tenant_id = ${input.tenantId} AND id = ${existing.id}
    RETURNING id
  `;
  if (!updated) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Recording not found" });
  }

  // ── THE ENQUEUE ─────────────────────────────────────────────────────────
  // The first and only place in the platform that produces a
  // transcript_outbox row. Everything downstream — the drain, the ASR call,
  // the notes — has been waiting on this statement.
  let enqueued = true;
  try {
    await sql`
      INSERT INTO public.transcript_outbox (tenant_id, recording_id, status)
      VALUES (${input.tenantId}, ${existing.id}, 'pending')
    `;
  } catch (err) {
    // UNIQUE (tenant_id, recording_id). A double-complete — a retried
    // request, an impatient second click — is SUCCESS: the work is already
    // queued, and the caller wanted it queued. Detected by CODE, because the
    // driver error may be wrapped and its outer message need not mention the
    // constraint at all.
    if (!isUniqueViolation(err)) throw err;
    enqueued = false;
  }

  const after = await loadRecording(sql, input.tenantId, input.interviewId);
  if (!after) throw new TRPCError({ code: "NOT_FOUND", message: "Recording not found" });
  return { recording: toView(after), enqueued };
}
