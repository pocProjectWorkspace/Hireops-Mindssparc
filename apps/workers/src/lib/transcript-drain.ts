/**
 * Drains pending transcript_outbox rows (N3.3a + N3.3b) — MEDIA → TRANSCRIPT
 * → NOTES.
 *
 * Shape follows ai-score-drain: batch claim via
 * UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED), attempt caps, an
 * orphan sweep for rows stuck in 'processing', per-row try/catch so one bad
 * row cannot kill the pass, and a structured completion log. Per claimed row:
 *
 *   1. Load the interview_recordings row; skip cleanly when it is not in a
 *      transcribable state.
 *   2. Advance the recording to 'transcribing'.
 *   3. Mint a signed READ url for storage_key and fetch the media out-of-band
 *      (N3.2 built that path for exactly this).
 *   4. getASRClient(tenantId).transcribe(...).
 *   5. Validate segments against the api-types schema, INSERT
 *      interview_transcripts, advance the recording to 'transcribed'.
 *   6. N3.3b — derive interview_notes from that transcript, then mark the
 *      outbox row 'completed'.
 *
 * NO ASR COST LOGGING HERE. The ASR client writes its own ai_usage_logs row
 * (feature 'asr_transcription') per call, success or failure, because the
 * minutes are billed whether or not this worker likes the result. Logging
 * again from the drain would double-count the platform's only non-token COGS
 * line. The notes call logs itself the same way, under feature
 * 'interview_notes' — a per-TOKEN line, distinct from the per-MINUTE one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TWO STAGES ARE SEPARATE COSTS AND MUST FAIL SEPARATELY
 * ─────────────────────────────────────────────────────────────────────────
 * Transcription is ASR, billed per audio minute; note generation is an LLM,
 * billed per token, behind its own `interview_notes` kill switch. A tenant can
 * legitimately buy transcripts without notes, so a disabled switch leaves the
 * transcript standing and COMPLETES the row cleanly — no retries, no error,
 * exactly what ai_scoring does when disabled.
 *
 * Failure isolation runs the same way. A transcript is a complete artefact on
 * its own and it is the expensive half; a notes failure must never destroy it,
 * and re-running a cheap summary must never mean paying for the audio again.
 * So on a notes failure the row stays retryable, the transcript stays written,
 * and — the part that actually costs money if it is wrong — the recording is
 * LEFT at 'transcribed' rather than being reverted to 'uploaded'. The next
 * pass therefore takes the already-transcribed branch, skips media fetch and
 * ASR entirely, and re-attempts only the notes. See the guarded status writes
 * in the catch: reverting a transcribed recording would send the retry back
 * through the vendor for audio that has already been paid for and stored.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE LEASE AND THE POLL INTERVAL LOOK NOTHING LIKE THE OTHER DRAINS
 * ─────────────────────────────────────────────────────────────────────────
 * Every other drain in this worker calls something that returns in seconds.
 * The ASR vendor is ASYNCHRONOUS: AssemblyAI is upload → create job → poll
 * until complete, with a 20-minute hard wall-clock ceiling inside the adapter
 * and 2–5 minutes expected for a 60-minute interview.
 *
 * That changes the economics of the claim lease. With ai-score-drain a
 * premature reclaim wasted a worker slot. Here, if the lease expires while the
 * adapter is still polling, the row is reclaimed and THE SAME AUDIO IS
 * TRANSCRIBED TWICE — and AssemblyAI bills both jobs. The constants below are
 * sized against that, not against latency. See the WALL-CLOCK BUDGET block at
 * the top of packages/ai-client/src/asr/assemblyai.ts, which names the same
 * 30 / 45 minute pair from the vendor side.
 */

import { randomUUID } from "node:crypto";
import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import { z } from "zod";
import {
  coerceScorecardCriteria,
  transcriptSegmentsSchema,
  type ScorecardCriterion,
} from "@hireops/api-types";
import {
  getAIClient,
  getASRClient,
  maskPiiIf,
  resolveTenantAiSettings,
  ASRError,
} from "@hireops/ai-client";
import {
  getStorageClient,
  resolveLocalSignedUrl,
  StorageNotFoundError,
  type SignedUrl,
} from "@hireops/api/storage";
import {
  buildInterviewNotesPrompt,
  interviewNotesAiJsonSchema,
  interviewNotesAiSchema,
  INTERVIEW_NOTES_FEATURE,
  INTERVIEW_NOTES_PROMPT_VERSION,
  INTERVIEW_NOTES_SCHEMA_NAME,
  type InterviewNotesAiResponse,
} from "./interview-notes-prompt";

/**
 * How long a claimed row is treated as legitimately in flight.
 *
 * DO NOT TIDY THIS DOWN. It sits above the ASR adapter's 20-minute whole-call
 * budget on purpose. Anything at or below that budget means a still-running
 * transcription can have its row reclaimed by another pass, and the vendor
 * bills the second job as happily as the first — a premature reclaim here is a
 * real money line, not a wasted worker slot.
 */
export const TRANSCRIPT_CLAIM_LEASE_MS = 30 * 60_000;

/**
 * Slack between "the lease expired" and "we are willing to reclaim". Keeping
 * the sweep strictly later than the lease means a worker that is merely at the
 * edge of its budget is never raced by the sweep.
 */
export const TRANSCRIPT_ORPHAN_GRACE_MS = 15 * 60_000;

/**
 * The threshold the sweep actually uses: 45 minutes. DERIVED, not typed as a
 * separate number, so the two constants cannot drift apart — the invariant
 * "sweep strictly after the lease" is structural rather than a comment someone
 * has to notice. Same warning as above: lowering either constant re-introduces
 * double billing.
 */
export const TRANSCRIPT_ORPHAN_SWEEP_MS = TRANSCRIPT_CLAIM_LEASE_MS + TRANSCRIPT_ORPHAN_GRACE_MS;

/**
 * ONE row per pass.
 *
 * The batch claim stamps claimed_at on every row it takes, but the rows are
 * processed sequentially — so with a batch of N, row N's lease clock starts
 * while rows 1…N-1 are still talking to the vendor. At 20 minutes worst case
 * per row, a batch of 2 already puts the second row's work at the far edge of
 * the 45-minute sweep. A batch of 1 makes the lease clock and the work clock
 * the same clock, which is the only version of this that is obviously correct.
 */
const DEFAULT_BATCH = 1;

export interface TranscriptDrainOpts {
  batchSize?: number;
  workerId?: string;
  log: Logger;
  /**
   * Override for the orphan-sweep threshold. Exists so a test can prove the
   * sweep works without waiting 45 minutes; production never passes it.
   */
  orphanSweepMs?: number;
}

export interface TranscriptDrainResult {
  claimed: number;
  completed: number;
  /**
   * Rows whose recording was already 'transcribed' — a completed outbox row,
   * not an error. Also covers the idempotent 23505 landing (see below).
   */
  skipped: number;
  /**
   * Rows whose recording has not received its bytes yet ('pending'). Returned
   * to the queue WITHOUT consuming an attempt — nothing was tried.
   */
  deferred: number;
  retried: number;
  failed: number;
  /** Rows the orphan sweep pulled back out of 'processing' this pass. */
  recovered: number;
  /**
   * N3.3b — rows that wrote (or replaced) an interview_notes row this pass.
   * Counted SEPARATELY from `completed`/`skipped` because the two stages are
   * separate costs: "the transcript landed" and "the notes landed" are
   * different questions, and a pass where every row completed with notes
   * skipped is a very different bill from one where they did not.
   */
  noted: number;
  /**
   * Rows that completed cleanly WITHOUT notes — the tenant has the
   * `interview_notes` switch off, or the transcript carries no speech. Neither
   * is an error and neither is retried; the reason is on the outbox row.
   */
  notesSkipped: number;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  recording_id: string;
  attempt_count: number;
  attempt_cap: number;
}

interface RecordingRow {
  id: string;
  interview_id: string;
  status: string;
  storage_key: string | null;
  media_type: string | null;
  duration_seconds: number | null;
  /** 0118. Non-null means the audio was deleted ON PURPOSE, ON SCHEDULE — the
   * retention sweep got here first. Distinguishing that from media that is
   * merely missing is the whole reason the column exists: one is the system
   * working, the other is a defect, and an ops dashboard must not see them as
   * the same red row. */
  media_purged_at: Date | string | null;
}

/**
 * A media fetch that failed at the transport, carrying the same explicit
 * retryability verdict ASRError carries. Without it the drain would be back to
 * inspecting HTTP status codes at the call site, which is precisely what
 * ASRError.retryable exists to avoid on the vendor side.
 */
class MediaFetchError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly underlying?: unknown,
  ) {
    super(message);
    this.name = "MediaFetchError";
  }
}

export async function drainTranscriptOutboxOnce(
  opts: TranscriptDrainOpts,
): Promise<TranscriptDrainResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const workerId = opts.workerId ?? `transcript-${randomUUID().slice(0, 8)}`;
  const log = opts.log;

  // Sweep first, so a row a dead worker abandoned is back in 'pending' before
  // this pass claims — one loop covers both, and the sweep is a single
  // indexed write against idx_transcript_outbox_orphan_sweep.
  const recovered = await recoverTranscriptOrphans(log, opts.orphanSweepMs);

  const rows = await poolSql<ClaimedRow[]>`
    UPDATE public.transcript_outbox
    SET status = 'processing', claimed_by = ${workerId}, claimed_at = now(),
        attempt_count = attempt_count + 1, last_attempt_at = now()
    WHERE id IN (
      SELECT id FROM public.transcript_outbox
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, recording_id, attempt_count, attempt_cap
  `;

  if (rows.length === 0) {
    return {
      claimed: 0,
      completed: 0,
      skipped: 0,
      deferred: 0,
      retried: 0,
      failed: 0,
      recovered,
      noted: 0,
      notesSkipped: 0,
    };
  }

  let completed = 0;
  let skipped = 0;
  let deferred = 0;
  let retried = 0;
  let failed = 0;
  let noted = 0;
  let notesSkipped = 0;

  for (const row of rows) {
    const child = log.child({
      transcript_outbox_id: row.id,
      tenant_id: row.tenant_id,
      recording_id: row.recording_id,
      attempt: row.attempt_count,
    });

    try {
      const [recording] = await poolSql<RecordingRow[]>`
        SELECT id, interview_id, status, storage_key, media_type, duration_seconds,
               media_purged_at
        FROM public.interview_recordings
        WHERE tenant_id = ${row.tenant_id} AND id = ${row.recording_id}
      `;
      if (!recording) {
        // Unreachable by construction — the outbox FKs to the recording with
        // CASCADE — so if it happens the row is corrupt, not slow.
        throw new TerminalDrainError(
          `interview_recording ${row.recording_id} not found for tenant ${row.tenant_id}`,
        );
      }

      // ── 0. Has the audio already been purged? ───────────────────────────
      // 0118's retention sweep deletes the bytes once the interview is past
      // its tenant's audio-retention window (A2 —
      // settings.retentionPolicy.interviewAudioDays, 30 days by default,
      // measured from completion). It skips recordings with an active outbox row,
      // so reaching here means the row was enqueued (or re-enqueued) after the
      // purge — a late manual re-run, most likely.
      //
      // This COMPLETES CLEANLY rather than failing. The distinction is the
      // point of media_purged_at: retention working as designed is not a
      // defect, and if it failed the row instead, every ops dashboard would
      // show a red row for a system doing exactly what the client asked for.
      // Media that is missing WITHOUT this stamp still fails, via
      // StorageNotFoundError — that one is a real problem and must stay loud.
      //
      // Note the ordering: this precedes the status checks because a purged
      // recording is unreadable whatever its status says. If a transcript
      // already exists, notes can still be derived from it — the transcript is
      // retained, so there is real work left to do even with the audio gone.
      if (recording.media_purged_at) {
        const existing = await loadTranscript(row.tenant_id, recording.interview_id);
        if (existing) {
          const notes = await runNoteGeneration({
            tenantId: row.tenant_id,
            interviewId: recording.interview_id,
            transcript: existing,
            outboxId: row.id,
            log: child,
          });
          await completeOutbox(
            row.id,
            notes.kind === "generated"
              ? "media purged — notes derived from the retained transcript"
              : notes.note,
          );
          if (notes.kind === "generated") noted += 1;
          else notesSkipped += 1;
        } else {
          await completeOutbox(row.id, "media purged by retention — nothing to transcribe");
        }
        skipped += 1;
        child.info(
          { recording_status: recording.status, media_purged: true },
          "transcript.skipped_media_purged",
        );
        continue;
      }

      // ── 1. Is this recording transcribable? ─────────────────────────────
      if (recording.status === "transcribed") {
        // The audio is already paid for and stored. That is a COMPLETED
        // outbox row, not an error: a reclaimed lease, a manual re-enqueue or
        // — the common case since N3.3b — a previous attempt whose NOTES
        // failed all land here.
        //
        // NO ASR CALL ON THIS PATH, deliberately. This is the branch that
        // makes a notes retry cheap: the transcript is loaded from the table
        // and only the summary is re-attempted. Re-transcribing to reach the
        // same bytes would bill the vendor a second time for an artefact
        // sitting in the row below.
        const existing = await loadTranscript(row.tenant_id, recording.interview_id);
        if (!existing) {
          // 'transcribed' with no transcript row. Genuinely odd — 0118's
          // retention sweep deletes AUDIO ONLY and never touches
          // interview_transcripts, so this is not the purge path. Most likely
          // a manual deletion. There is nothing left to derive from, and no
          // retry produces it — complete cleanly, as N3.3a always did here.
          await completeOutbox(row.id, "recording already transcribed — nothing to do");
          skipped += 1;
          child.info({ recording_status: recording.status }, "transcript.skipped_already_done");
          continue;
        }

        const notes = await runNoteGeneration({
          tenantId: row.tenant_id,
          interviewId: recording.interview_id,
          transcript: existing,
          outboxId: row.id,
          log: child,
        });
        await completeOutbox(
          row.id,
          notes.kind === "generated"
            ? "recording already transcribed — notes refreshed"
            : notes.note,
        );
        skipped += 1;
        if (notes.kind === "generated") noted += 1;
        else notesSkipped += 1;
        child.info(
          { recording_status: recording.status, notes: notes.kind },
          "transcript.skipped_already_done",
        );
        continue;
      }
      if (recording.status === "pending") {
        // The bytes have not landed yet. Nothing was attempted, so the claim's
        // attempt increment is given back — otherwise a recording that sits
        // un-uploaded for a few minutes would burn its whole cap and be dead
        // before the recruiter finished the upload.
        await deferOutbox(row.id, "recording has no media yet (status=pending)");
        deferred += 1;
        child.info({ recording_status: recording.status }, "transcript.deferred_no_media");
        continue;
      }
      if (recording.status === "failed") {
        await failOutbox(row.id, `recording is terminal (status=failed)`);
        failed += 1;
        child.warn({ recording_status: recording.status }, "transcript.failed_recording_terminal");
        continue;
      }
      // 'uploaded' is the normal entry state. 'transcribing' is only reachable
      // when a PREVIOUS attempt died after step 2, and holding this row's
      // outbox claim is what makes resuming it safe — the claim, not the
      // recording status, is the mutual exclusion. Refusing it here would
      // deadlock every crashed attempt forever.
      if (recording.status !== "uploaded" && recording.status !== "transcribing") {
        await failOutbox(row.id, `recording is in unexpected status '${recording.status}'`);
        failed += 1;
        child.warn({ recording_status: recording.status }, "transcript.failed_bad_status");
        continue;
      }
      if (!recording.storage_key) {
        // An 'uploaded' row without a key is inconsistent data; no number of
        // retries produces the bytes.
        throw new TerminalDrainError(
          `interview_recording ${row.recording_id} is '${recording.status}' but has no storage_key`,
        );
      }

      // ── 2. Advance the recording ────────────────────────────────────────
      await setRecordingStatus(row.tenant_id, recording.id, "transcribing");

      // ── 3. Fetch the media out-of-band via a signed read URL ────────────
      // Default TTL (15 min) deliberately: the URL is dereferenced within
      // seconds, here, before the vendor call even starts — we hand the ASR
      // client BYTES, not a URL. The 30-minute lease is about how long the
      // vendor takes; it has nothing to do with how long this credential
      // needs to live, and stretching the URL to match would widen the blast
      // radius of the most sensitive artefact the platform holds for no gain.
      const storage = getStorageClient();
      const signed = await storage.createSignedReadUrl(recording.storage_key);
      const media = await fetchSignedMedia(signed);

      // ── 4. Transcribe ───────────────────────────────────────────────────
      const contentType = recording.media_type ?? media.contentType ?? "application/octet-stream";
      const asr = getASRClient(row.tenant_id);
      const result = await asr.transcribe(media.buffer, {
        contentType,
        ...(recording.duration_seconds !== null
          ? { durationSecondsHint: recording.duration_seconds }
          : {}),
        // Correlates the ai_usage_logs row back to the outbox attempt that
        // paid for it, which is the only way to answer "what did this
        // recording cost" without guessing by timestamp.
        requestId: row.id,
      });

      // ── 5. Validate, then write ─────────────────────────────────────────
      // BEFORE the insert, not after: jsonb accepts anything, the transcript
      // is insert-once (UNIQUE on tenant_id, interview_id), and a malformed
      // blob written here is permanent until a human deletes the row and pays
      // for the audio a second time. A parse failure is terminal by design —
      // the same bytes will map the same wrong way on every retry.
      const segments = transcriptSegmentsSchema.parse(result.segments);

      const inserted = await insertTranscript({
        tenantId: row.tenant_id,
        interviewId: recording.interview_id,
        recordingId: recording.id,
        segments,
        fullText: result.fullText,
        language: result.language,
        provider: result.provider,
        providerModel: result.providerModel,
        wordCount: result.wordCount,
      });

      await setRecordingStatus(row.tenant_id, recording.id, "transcribed");

      // ── 6. Derive the notes (N3.3b) ─────────────────────────────────────
      // BOTH landings continue here — the fresh insert AND the 23505. N3.3a
      // completed the duplicate row right at this point; leaving it that way
      // once notes exist would mean a row whose lease was reclaimed mid-flight
      // gets a transcript and never any notes, silently and forever (nothing
      // re-enqueues it). So the duplicate falls through: the transcript it
      // collided with is the artefact the notes are derived from.
      //
      // Re-read rather than reusing `result`: on the 23505 path the stored row
      // is the one that won, and it is what a regeneration must be consistent
      // with. On the insert path it is the same content either way.
      const transcript = await loadTranscript(row.tenant_id, recording.interview_id);
      if (!transcript) {
        // We just wrote it (or absorbed a conflict with it). Its absence means
        // something deleted it inside this attempt — retryable, not terminal.
        throw new Error(
          `interview_transcript for interview ${recording.interview_id} vanished after write`,
        );
      }
      const notes = await runNoteGeneration({
        tenantId: row.tenant_id,
        interviewId: recording.interview_id,
        transcript,
        outboxId: row.id,
        log: child,
      });

      // last_error doubles as the ops-legible "why is this row not the plain
      // happy path" note. Nothing to say on a clean full drain, so it stays
      // NULL there; each non-default outcome adds one clause.
      const clauses: string[] = [];
      if (!inserted) clauses.push("transcript already existed for this interview (23505 absorbed)");
      if (notes.kind !== "generated") clauses.push(notes.note);
      await completeOutbox(row.id, clauses.length > 0 ? clauses.join("; ") : null);

      if (notes.kind === "generated") noted += 1;
      else notesSkipped += 1;

      if (inserted) {
        completed += 1;
        child.info(
          {
            provider: result.provider,
            provider_model: result.providerModel,
            segments: segments.length,
            word_count: result.wordCount,
            duration_seconds: result.durationSeconds,
            notes: notes.kind,
          },
          "transcript.completed",
        );
      } else {
        skipped += 1;
        child.info(
          { provider: result.provider, notes: notes.kind },
          "transcript.completed_duplicate",
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const verdict = retryabilityOf(err);
      // An explicit `false` short-circuits the cap. Retrying an undecodable
      // file (or a purged object, or a payload that failed the schema) pays
      // the vendor again for a guaranteed failure, so the remaining attempts
      // are not spent proving it. `true` and "no opinion" both defer to the
      // cap, which is what the cap is for.
      const terminal = verdict === false || row.attempt_count >= row.attempt_cap;

      if (terminal) {
        await failOutbox(row.id, errMsg);
        // GUARDED (N3.3b): only a recording that never got a transcript is
        // 'failed'. A notes failure on an already-transcribed recording must
        // not relabel a stored, paid-for artefact as failed — the transcript
        // is independently valuable and the panel-side surface reads it.
        await setRecordingStatusIfTranscribing(row.tenant_id, row.recording_id, "failed").catch(
          () => undefined,
        );
        failed += 1;
        child.error({ err: errMsg, terminal: true, retryable: verdict }, "transcript.failed");
      } else {
        // Nothing is transcribing any more, so the recording should not claim
        // to be. Reverting to 'uploaded' keeps 'transcribing' meaning exactly
        // one thing: a crashed attempt, which is the case the transcribable
        // set above allows back in.
        //
        // SAME GUARD, AND HERE IT IS A MONEY LINE. If the throw came from note
        // generation the recording is already 'transcribed'; reverting it to
        // 'uploaded' would send the next pass back through the signed-URL
        // fetch and the ASR vendor for audio already transcribed and stored —
        // billing the same minutes twice to retry a token-priced summary.
        // Left at 'transcribed', the retry takes the already-transcribed
        // branch and re-attempts only the notes.
        await setRecordingStatusIfTranscribing(row.tenant_id, row.recording_id, "uploaded").catch(
          () => undefined,
        );
        await poolSql`
          UPDATE public.transcript_outbox
          SET status = 'pending', last_error = ${errMsg}
          WHERE id = ${row.id}
        `;
        retried += 1;
        // `attempt` is already on the child logger — don't emit it twice.
        child.warn({ err: errMsg }, "transcript.retry");
      }
    }
  }

  return {
    claimed: rows.length,
    completed,
    skipped,
    deferred,
    retried,
    failed,
    recovered,
    noted,
    notesSkipped,
  };
}

/**
 * Pulls rows whose worker died mid-transcription back out of 'processing'.
 *
 * Threshold is TRANSCRIPT_ORPHAN_SWEEP_MS (45 min) — read the constants above
 * before changing it. A row already at its cap is retired rather than
 * re-queued: an attempt that keeps orphaning is a worker that keeps dying, and
 * looping it forever would bill the vendor on every lap.
 *
 * Exported for the test that proves the sweep exists without waiting 45
 * minutes for it.
 */
export async function recoverTranscriptOrphans(log: Logger, staleMs?: number): Promise<number> {
  // ISO string — postgres-js rejects raw Date objects as bind params
  // (HANDOVER #96).
  const cutoff = new Date(Date.now() - (staleMs ?? TRANSCRIPT_ORPHAN_SWEEP_MS)).toISOString();
  const rows = await poolSql<{ id: string; status: string }[]>`
    UPDATE public.transcript_outbox
    SET status = CASE WHEN attempt_count >= attempt_cap THEN 'failed' ELSE 'pending' END,
        claimed_by = NULL, claimed_at = NULL,
        last_error = COALESCE(last_error, '') || ' [orphan_recovered]'
    WHERE status = 'processing'
      -- claimed_at IS NULL is unreachable (the claim always stamps it), but a
      -- processing row without a lease timestamp would otherwise be stuck
      -- forever, which is the exact failure this sweep exists to prevent.
      AND (claimed_at IS NULL OR claimed_at < ${cutoff})
    RETURNING id, status
  `;
  if (rows.length > 0) {
    log.warn(
      {
        recovered: rows.length,
        requeued: rows.filter((r) => r.status === "pending").length,
        retired: rows.filter((r) => r.status === "failed").length,
      },
      "transcript.orphans_recovered",
    );
  }
  return rows.length;
}

/**
 * A drain-side data problem that no retry can fix (missing recording, an
 * 'uploaded' row with no storage key). Distinct from ASRError/MediaFetchError
 * only in where it originates; it carries the same `retryable: false` verdict.
 */
class TerminalDrainError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "TerminalDrainError";
  }
}

/**
 * Does this error carry an explicit verdict on whether a retry could help?
 * `undefined` means "no opinion" — an unrecognised throw, where the attempt
 * cap is the right arbiter.
 */
function retryabilityOf(err: unknown): boolean | undefined {
  if (err instanceof ASRError) return err.retryable;
  if (err instanceof MediaFetchError) return err.retryable;
  if (err instanceof TerminalDrainError) return false;
  // The object is gone (purged media, or a key that never existed). The bytes
  // are not coming back.
  if (err instanceof StorageNotFoundError) return false;
  // A segments payload that fails the schema will fail it identically next
  // time — the ai-score-drain precedent for a schema-parse failure.
  if (err instanceof z.ZodError) return false;
  return undefined;
}

/**
 * Dereferences the signed read URL.
 *
 * The local storage tier mints a deliberately non-network `local://` URL that
 * `fetch` cannot resolve; resolveLocalSignedUrl is its round-trip half, and it
 * is what lets this whole path — mint a URL, fetch the media, transcribe it —
 * be tested with no network and no Supabase. The branch is on the tier's own
 * `provider` field rather than on the URL string, so nothing here is
 * pattern-matching on a format.
 */
async function fetchSignedMedia(
  signed: SignedUrl,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  if (signed.provider === "local") {
    const object = resolveLocalSignedUrl(signed.url);
    return { buffer: object.buffer, contentType: object.contentType };
  }

  let res: Response;
  try {
    res = await fetch(signed.url);
  } catch (err) {
    // Transport blip: worth another pass.
    throw new MediaFetchError(`media fetch failed for key ${signed.key}`, true, err);
  }
  if (!res.ok) {
    // 5xx / 408 / 429 are the vendor or the CDN having a moment; anything else
    // (404 on a purged object, 403 on an expired signature we somehow raced)
    // will answer the same way next time. Never log the URL itself — it is a
    // bearer credential for the recording.
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    throw new MediaFetchError(
      `media fetch for key ${signed.key} returned HTTP ${res.status}`,
      retryable,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: res.headers.get("content-type") };
}

/**
 * Writes the transcript. Returns false when one already existed.
 *
 * IDEMPOTENCY. The UNIQUE on (tenant_id, interview_id) is what makes a
 * double-transcription — the exact outcome a reclaimed lease produces —
 * harmless: the second insert is a 23505 and the work is already done, so it
 * resolves as SUCCESS rather than as an error that would fail a row whose
 * artefact is sitting right there. Detection is CODE-BASED (P0.6 / the
 * ai-budget-scan tryEnqueue precedent): a driver error can be wrapped, so the
 * constraint name is not reliably in the message and a substring match does
 * not work.
 */
async function insertTranscript(args: {
  tenantId: string;
  interviewId: string;
  recordingId: string;
  segments: unknown;
  fullText: string;
  language: string | null;
  provider: string;
  providerModel: string;
  wordCount: number;
}): Promise<boolean> {
  try {
    await poolSql`
      INSERT INTO public.interview_transcripts
        (tenant_id, interview_id, recording_id, segments, full_text, language,
         provider, provider_model, word_count)
      VALUES (${args.tenantId}, ${args.interviewId}, ${args.recordingId},
              ${JSON.stringify(args.segments)}::jsonb, ${args.fullText}, ${args.language},
              ${args.provider}, ${args.providerModel}, ${args.wordCount})
    `;
    return true;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    if (e?.code === "23505" || e?.cause?.code === "23505") return false;
    throw err;
  }
}

async function setRecordingStatus(
  tenantId: string,
  recordingId: string,
  status: string,
): Promise<void> {
  await poolSql`
    UPDATE public.interview_recordings
    SET status = ${status}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${recordingId}
  `;
}

/**
 * The error-path status write: moves a recording ONLY if it is still
 * 'transcribing', i.e. only if this attempt's own transcription is what
 * failed.
 *
 * The predicate is the point. A recording that reached 'transcribed' has a
 * paid-for artefact in the table, and neither error branch may touch it:
 * 'failed' would be a lie about a transcript that exists, and 'uploaded' would
 * send the next pass back to the ASR vendor for bytes already transcribed.
 * Both were correct in N3.3a, where nothing could throw after 'transcribed';
 * with note generation on the far side of it, both would be bugs.
 */
async function setRecordingStatusIfTranscribing(
  tenantId: string,
  recordingId: string,
  status: string,
): Promise<void> {
  await poolSql`
    UPDATE public.interview_recordings
    SET status = ${status}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${recordingId} AND status = 'transcribing'
  `;
}

async function completeOutbox(id: string, note: string | null): Promise<void> {
  await poolSql`
    UPDATE public.transcript_outbox
    SET status = 'completed', completed_at = now(), last_error = ${note}
    WHERE id = ${id}
  `;
}

async function failOutbox(id: string, reason: string): Promise<void> {
  await poolSql`
    UPDATE public.transcript_outbox
    SET status = 'failed', last_error = ${reason}
    WHERE id = ${id}
  `;
}

/**
 * Returns a row to the queue WITHOUT charging it an attempt. Used only where
 * nothing was tried — see the 'pending' recording branch. GREATEST(...,0)
 * because attempt_count is a smallint and an underflow would be a worse bug
 * than the one it is guarding.
 */
async function deferOutbox(id: string, reason: string): Promise<void> {
  await poolSql`
    UPDATE public.transcript_outbox
    SET status = 'pending', last_error = ${reason},
        attempt_count = GREATEST(attempt_count - 1, 0)
    WHERE id = ${id}
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// N3.3b — TRANSCRIPT → NOTES
//
// The derivation stage. Everything above this line is transcription and knows
// nothing about the model; everything below runs only after a transcript
// exists, and throws rather than swallowing so the caller's attempt cap stays
// the single arbiter of when to give up.
// ═══════════════════════════════════════════════════════════════════════════

/** The stored transcript, as the notes stage consumes it. */
interface TranscriptRow {
  id: string;
  segments: unknown;
  full_text: string;
}

async function loadTranscript(
  tenantId: string,
  interviewId: string,
): Promise<TranscriptRow | null> {
  const [row] = await poolSql<TranscriptRow[]>`
    SELECT id, segments, full_text
    FROM public.interview_transcripts
    WHERE tenant_id = ${tenantId} AND interview_id = ${interviewId}
  `;
  return row ?? null;
}

/**
 * What the notes stage did. `generated` is the only outcome that spent a
 * token; the other two are CLEAN COMPLETIONS carrying an ops-legible reason,
 * never errors — the row is done and re-running it would change nothing.
 */
interface NotesOutcome {
  kind: "generated" | "disabled" | "empty_transcript";
  /** Recorded on the outbox row for the non-generated outcomes. */
  note: string;
}

/**
 * Generates and stores the interview_notes row for one transcript.
 *
 * THROWS on failure, by design — the caller's catch decides retry-vs-terminal
 * against the attempt cap, and (per the guarded status writes) leaves the
 * transcript and the recording's 'transcribed' status untouched, so the retry
 * re-attempts only this function and never the ASR vendor.
 */
async function runNoteGeneration(args: {
  tenantId: string;
  interviewId: string;
  transcript: TranscriptRow;
  /** Correlates the ai_usage_logs row back to the attempt that paid for it. */
  outboxId: string;
  log: Logger;
}): Promise<NotesOutcome> {
  // ── Kill switch, BEFORE anything that could cost a token ───────────────
  // Transcription (per-minute ASR) and note generation (per-token LLM) are
  // separate costs behind separate switches, and this one is off for any
  // tenant that bought transcripts alone. Disabled is not an error and not a
  // retry: the transcript stands, the row completes, exactly the discipline
  // ai_scoring uses (CONF-01).
  const aiSettings = await resolveTenantAiSettings(poolSql, args.tenantId);
  if (!aiSettings.interview_notes.enabled) {
    args.log.info({}, "interview_notes.skipped_disabled");
    return {
      kind: "disabled",
      note: "interview_notes disabled in tenant AI settings — transcript kept, no notes generated",
    };
  }

  // The drain validates segments before every insert, so a stored payload is
  // well-formed — but this row may predate that (or have been written by a
  // future producer), and a summary is not worth failing a transcript over.
  // A parse miss degrades to the flattened text, which the prompt handles as
  // its no-diarisation case rather than pretending it has speakers.
  const parsedSegments = transcriptSegmentsSchema.safeParse(args.transcript.segments);
  const segments = parsedSegments.success ? parsedSegments.data : [];
  const fullText = args.transcript.full_text;

  if (segments.length === 0 && fullText.trim().length === 0) {
    // A recording of a room nobody spoke in. 0116 and the segments schema both
    // treat that as a valid transcript, so there is nothing to fail — but
    // there is also nothing to summarise, and paying a model to say so on
    // every attempt would be spending tokens on silence.
    args.log.info({}, "interview_notes.skipped_empty_transcript");
    return { kind: "empty_transcript", note: "transcript has no speech — nothing to summarise" };
  }

  const round = await loadRoundContext(args.tenantId, args.interviewId);
  const built = buildInterviewNotesPrompt({
    segments,
    fullText,
    criteria: round.criteria,
    competencyFocus: round.competencyFocus,
  });

  const client = await getAIClient(args.tenantId);
  const response = await client.completeStructured<InterviewNotesAiResponse>({
    system: built.system,
    // Deterministic redaction of emails / phones / URLs when the tenant has it
    // on — a transcript is candidate-derived text like any other prompt input.
    prompt: maskPiiIf(aiSettings.piiMasking, built.user),
    model: aiSettings.interview_notes.model,
    temperature: aiSettings.interview_notes.temperature,
    maxTokens: aiSettings.interview_notes.maxTokens,
    schema: interviewNotesAiJsonSchema,
    schemaName: INTERVIEW_NOTES_SCHEMA_NAME,
    feature: INTERVIEW_NOTES_FEATURE,
    requestId: args.outboxId,
  });

  // Strict parse — see interview-notes-prompt.ts. This is what makes "no
  // rating, no recommendation" enforced rather than merely requested: an extra
  // key fails here, the row goes terminal (ZodError is non-retryable) and
  // nothing is written.
  const validated = interviewNotesAiSchema.parse(response);

  const model = await resolveUsedModel(
    args.tenantId,
    args.outboxId,
    aiSettings.interview_notes.model,
  );
  await upsertInterviewNotes({
    tenantId: args.tenantId,
    interviewId: args.interviewId,
    transcriptId: args.transcript.id,
    notes: validated,
    model,
  });

  args.log.info(
    {
      model,
      prompt_version: INTERVIEW_NOTES_PROMPT_VERSION,
      key_points: validated.keyPoints.length,
      questions_asked: validated.questionsAsked.length,
    },
    "interview_notes.generated",
  );
  return { kind: "generated", note: "notes generated" };
}

/**
 * The round's rubric — the ONLY context beyond the transcript that the prompt
 * is grounded in.
 *
 * `scorecard_criteria_snapshot` is the resolved, ordered [{key,label}] frozen
 * at schedule time (T2.2 / 0102), so the notes are organised against the
 * rubric the panellist is actually scored against rather than a live template
 * that may have drifted since. `competency_focus` comes off the plan round and
 * is a LEFT JOIN because a manually-scheduled interview may have no plan row —
 * absent context is rendered as "not specified", never invented.
 */
async function loadRoundContext(
  tenantId: string,
  interviewId: string,
): Promise<{ criteria: ScorecardCriterion[]; competencyFocus: string[] }> {
  const [row] = await poolSql<
    { scorecard_criteria_snapshot: unknown; competency_focus: unknown }[]
  >`
    SELECT iv.scorecard_criteria_snapshot, p.competency_focus
    FROM public.interviews iv
    LEFT JOIN public.interview_plans p
      ON p.tenant_id = iv.tenant_id
     AND p.requisition_id = iv.requisition_id
     AND p.round_number = iv.round_number
    WHERE iv.tenant_id = ${tenantId} AND iv.id = ${interviewId}
  `;
  const focus = Array.isArray(row?.competency_focus)
    ? row.competency_focus.filter((c): c is string => typeof c === "string")
    : [];
  return {
    criteria: coerceScorecardCriteria(row?.scorecard_criteria_snapshot),
    competencyFocus: focus,
  };
}

/**
 * Which model actually answered.
 *
 * completeStructured doesn't return it, so — the ai-score-drain precedent —
 * we read it back off the ai_usage_logs row the call just wrote. Keyed on
 * request_id (the outbox row) rather than "latest for the tenant", so a
 * concurrent pass on another interview cannot hand this row someone else's
 * provenance. succeeded = true excludes the failure rows a previous attempt
 * left behind. Falls back to the model we ASKED for, which is the honest
 * answer when the log write is the thing that went missing.
 */
async function resolveUsedModel(
  tenantId: string,
  outboxId: string,
  requestedModel: string,
): Promise<string> {
  const [usage] = await poolSql<{ model: string }[]>`
    SELECT model FROM public.ai_usage_logs
    WHERE tenant_id = ${tenantId}
      AND feature = ${INTERVIEW_NOTES_FEATURE}
      AND request_id = ${outboxId}
      AND succeeded = true
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return usage?.model ?? requestedModel;
}

/**
 * Writes the notes. REPLACES on conflict — never appends.
 *
 * 0116 puts a UNIQUE on (tenant_id, interview_id) precisely so a regeneration
 * overwrites: interview_notes is a derived cache, not an audit log (the same
 * rationale interview_prep carries). The history that matters is preserved
 * elsewhere — the table has an audit trigger, so the superseded row is in
 * audit_logs, and model + prompt_version stamp which prompt produced whatever
 * is current.
 *
 * generated_at is passed as an ISO string cast to timestamptz: postgres-js
 * does not coerce a Date bind param to wire format (HANDOVER #96).
 */
async function upsertInterviewNotes(args: {
  tenantId: string;
  interviewId: string;
  transcriptId: string;
  notes: InterviewNotesAiResponse;
  model: string;
}): Promise<void> {
  const generatedAtIso = new Date().toISOString();
  await poolSql`
    INSERT INTO public.interview_notes
      (tenant_id, interview_id, transcript_id, summary, key_points, topics_covered,
       questions_asked, follow_ups, model, prompt_version, generated_at)
    VALUES (${args.tenantId}, ${args.interviewId}, ${args.transcriptId},
            ${args.notes.summary},
            ${JSON.stringify(args.notes.keyPoints)}::jsonb,
            ${JSON.stringify(args.notes.topicsCovered)}::jsonb,
            ${JSON.stringify(args.notes.questionsAsked)}::jsonb,
            ${JSON.stringify(args.notes.followUps)}::jsonb,
            ${args.model}, ${INTERVIEW_NOTES_PROMPT_VERSION}, ${generatedAtIso}::timestamptz)
    ON CONFLICT (tenant_id, interview_id) DO UPDATE
    SET transcript_id = EXCLUDED.transcript_id,
        summary = EXCLUDED.summary,
        key_points = EXCLUDED.key_points,
        topics_covered = EXCLUDED.topics_covered,
        questions_asked = EXCLUDED.questions_asked,
        follow_ups = EXCLUDED.follow_ups,
        model = EXCLUDED.model,
        prompt_version = EXCLUDED.prompt_version,
        generated_at = EXCLUDED.generated_at,
        updated_at = now()
  `;
}
