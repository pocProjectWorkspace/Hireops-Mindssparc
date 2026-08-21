import { sql as poolSql } from "@hireops/db";
import { getStorageClient, StorageNotFoundError } from "@hireops/api/storage";
import type { Logger } from "@hireops/observability";

/**
 * N3.RET — interview-audio retention sweep.
 *
 * The client's decision, and what this job makes true: interview AUDIO is
 * retained for 30 days; TRANSCRIPTS AND NOTES ARE KEPT. Nothing in this file
 * touches interview_transcripts or interview_notes — the sweep deletes the
 * stored object, nulls storage_key and stamps interview_recordings
 * .media_purged_at (0118), and that is the whole of its blast radius.
 *
 * It lands BEFORE N3.4 deliberately. N3.4 is what starts producing real
 * recordings, and no real recording should ever exist without a purge path
 * behind it — otherwise "we keep audio for 30 days" is a claim with nothing
 * enforcing it.
 *
 * A SCHEDULED JOB, NOT A DRAIN LOOP. Registered in SCHEDULED_JOBS alongside
 * ownership_claim_sweep: cross-tenant, service-role poolSql, same run-vs-
 * helper split so the api test suite can drive the sweep against its own
 * handle. The worker already carries seven startLoop registrations and owes a
 * registry refactor (open-questions #26); this work needs no drain loop, so it
 * does not add an eighth.
 *
 * DAILY. Purging is not time-critical — a retention promise measured in days
 * is not falsified by a few hours — and a tighter tick would just re-scan the
 * same set for nothing, at the cost of an index scan per pass. The 24-hour
 * cadence is also what makes the batch cap below safe: whatever a pass does
 * not reach is picked up tomorrow.
 */

/**
 * The service-role postgres handle, taken as a parameter rather than closed
 * over — the ownership-claim-sweep pattern, so tests drive the same code.
 */
type SqlHandle = typeof poolSql;

/**
 * WINDOW 1 — the rule. Retention runs from INTERVIEW COMPLETION, not from
 * when the recording was made: the client's decision is "30 days after the
 * interview", and an interview whose media landed a week late is still the
 * same interview. `interviews.cancelled_at` counts the same as
 * `completed_at` — a cancelled round is over, and its audio has no longer a
 * claim on the tenant's storage than a completed one does.
 */
export const INTERVIEW_MEDIA_RETENTION_DAYS = 30;

/**
 * WINDOW 2 — the backstop, and it matters as much as the rule.
 *
 * Window 1 only fires for an interview that reached a terminal state. Plenty
 * never do: a NO-SHOW is the obvious one — markInterviewNoShow sets
 * status='no_show' and stamps nothing (0115 added completed_at and
 * cancelled_at, and no no_show_at), so GREATEST(completed_at, cancelled_at)
 * is NULL for it forever. A round that is simply abandoned behaves the same
 * way. Under window 1 alone their audio would be kept FOREVER, which would
 * make "we keep audio for 30 days" a false statement about the platform.
 *
 * So there is a hard ceiling on the recording's OWN created_at, regardless of
 * what the interview ever did. 90 days is deliberately generous relative to
 * the 30-day rule: it must never be the window that fires for a normally
 * completed interview (that would be the rule failing quietly), only the one
 * that catches rounds the state machine dropped. If a recording is being
 * purged by the ceiling, something upstream did not close the round — the
 * structured log below names which window fired precisely so that shows up.
 */
export const INTERVIEW_MEDIA_HARD_CEILING_DAYS = 90;

/**
 * PROMOTION PATH (not built, and deliberately not built now). If a tenant
 * ever needs a different retention period, these two numbers become the
 * DEFAULTS of a `tenants.settings.interviewMediaRetention` block resolved
 * over them — the resolveAiBudget / resolveRetentionPolicy house pattern: a
 * versioned zod schema, a `resolve*` that falls back to defaults on a
 * malformed block rather than throwing, and a per-tenant read inside the loop
 * below instead of the two constants. The sweep would then be per-tenant
 * rather than one cross-tenant query. Nothing about the schema or this job
 * blocks that; there is simply no second tenant asking for it, and shipping a
 * configuration surface nobody has requested for a compliance promise that is
 * currently uniform would be inventing a decision the client already made.
 */

/**
 * How many recordings one pass will purge.
 *
 * Each row is a sequential network DELETE against object storage, and the
 * scheduler awaits the whole job — an unbounded first pass over a backlog
 * would hold the scheduler tick for as long as the backlog takes. A daily
 * cadence makes the cap free: the remainder is purged tomorrow, and nothing
 * about a retention window measured in days cares which of the next 24 hours
 * it happened in. Ordered oldest-first so the backlog drains in the order it
 * aged.
 */
const PURGE_BATCH_LIMIT = 500;

interface PurgeCandidate {
  id: string;
  tenant_id: string;
  storage_key: string;
  /** Which window selected this row — 'retention_window' | 'hard_ceiling'. */
  reason: string;
}

export interface InterviewMediaPurgeResult {
  /** Recordings whose media is gone and whose row now says so. */
  purged: number;
  /** Purged by the 30-day rule (a subset of `purged`). */
  byRetentionWindow: number;
  /** Purged by the 90-day backstop (a subset of `purged`) — see WINDOW 2. */
  byHardCeiling: number;
  /** Rows this pass could not purge. Left alone; the next pass retries them. */
  failed: number;
}

/**
 * Purge every recording whose media is past retention, across all tenants.
 *
 * The candidate query, clause by clause:
 *
 *   media_purged_at IS NULL AND storage_key IS NOT NULL — the purgeable
 *   population, and exactly the predicate of
 *   idx_interview_recordings_media_purge_sweep. A recording with no key has
 *   no object to delete, and stamping media_purged_at on it would assert a
 *   purge that never happened.
 *
 *   GREATEST(completed_at, cancelled_at) — postgres GREATEST ignores NULLs,
 *   so this is "whenever this round ended" and is NULL only when it never
 *   did. `NULL <= x` is NULL, i.e. not true, so such a row falls through to
 *   the ceiling leg rather than being purged early or never.
 *
 *   NOT EXISTS (active transcript_outbox row) — DO NOT DELETE MEDIA A DRAIN
 *   IS ABOUT TO READ OR IS READING. A recording sitting at 'transcribing'
 *   has a worker holding its claim and a signed URL pointing at these bytes;
 *   deleting them mid-flight turns a paid-for vendor call into a failure and
 *   loses the transcript we were about to keep. Cheap: 0116's
 *   uniq_transcript_outbox_per_recording UNIQUE (tenant_id, recording_id)
 *   makes this a single index probe, and there is at most one outbox row per
 *   recording. Terminal outbox rows ('completed' / 'failed') are no
 *   obstacle — nothing is going to read them again.
 *
 * DELETE FIRST, THEN STAMP. The other order would let a failed delete leave a
 * row asserting that media is gone while the bytes are still sitting in the
 * bucket — a false compliance claim, which is strictly worse than the
 * converse. This way a crash between the two leaves a row that still points
 * at an object which no longer exists; the next pass re-selects it, the
 * delete 404s, and a 404 counts as SUCCESS here because the object being
 * absent IS the goal. So the failure mode is self-healing and errs towards
 * "the bytes are really gone".
 *
 * Per-row try/catch, the discipline every other sweep uses: one unreachable
 * bucket or one bad key cannot kill the pass, and the row is simply left for
 * tomorrow.
 */
export async function purgeExpiredInterviewMedia(
  sql: SqlHandle,
  opts: { limit?: number; log?: Logger } = {},
): Promise<InterviewMediaPurgeResult> {
  const limit = opts.limit ?? PURGE_BATCH_LIMIT;

  const candidates = await sql<PurgeCandidate[]>`
    SELECT r.id,
           r.tenant_id::text AS tenant_id,
           r.storage_key,
           CASE
             WHEN GREATEST(iv.completed_at, iv.cancelled_at)
                  <= now() - make_interval(days => ${INTERVIEW_MEDIA_RETENTION_DAYS})
             THEN 'retention_window'
             ELSE 'hard_ceiling'
           END AS reason
      FROM public.interview_recordings r
      JOIN public.interviews iv
        ON iv.tenant_id = r.tenant_id
       AND iv.id = r.interview_id
     WHERE r.media_purged_at IS NULL
       AND r.storage_key IS NOT NULL
       AND (
             GREATEST(iv.completed_at, iv.cancelled_at)
               <= now() - make_interval(days => ${INTERVIEW_MEDIA_RETENTION_DAYS})
          OR r.created_at <= now() - make_interval(days => ${INTERVIEW_MEDIA_HARD_CEILING_DAYS})
       )
       AND NOT EXISTS (
             SELECT 1
               FROM public.transcript_outbox o
              WHERE o.tenant_id = r.tenant_id
                AND o.recording_id = r.id
                AND o.status IN ('pending', 'processing')
       )
     ORDER BY r.created_at
     LIMIT ${limit}
  `;

  const storage = getStorageClient();
  const result: InterviewMediaPurgeResult = {
    purged: 0,
    byRetentionWindow: 0,
    byHardCeiling: 0,
    failed: 0,
  };

  for (const row of candidates) {
    try {
      try {
        await storage.delete(row.storage_key);
      } catch (err) {
        // Already gone is the outcome we wanted. Both tiers' delete() is a
        // no-op on a missing key, so this is belt-and-braces for a tier that
        // ever decides to be stricter.
        if (!(err instanceof StorageNotFoundError)) throw err;
      }

      // media_purged_at IS NULL keeps this idempotent against a concurrent
      // pass. The audit trigger on interview_recordings records the write, so
      // the purge is visible in audit_logs like every other governed change.
      //
      // NOTE WHAT IS NOT HERE: no touch of interview_transcripts, no touch of
      // interview_notes, and no change to `status`. The transcript is the
      // artefact the retention decision explicitly keeps, and status is the
      // processing axis (see 0118's header).
      await sql`
        UPDATE public.interview_recordings
           SET storage_key = NULL,
               media_purged_at = now(),
               updated_at = now()
         WHERE tenant_id = ${row.tenant_id}
           AND id = ${row.id}
           AND media_purged_at IS NULL
      `;

      result.purged += 1;
      if (row.reason === "retention_window") result.byRetentionWindow += 1;
      else result.byHardCeiling += 1;
    } catch (err) {
      // One row's storage transport is not the pass's problem. Left exactly
      // as it was (key intact, media_purged_at still NULL), so tomorrow's
      // pass re-selects it.
      result.failed += 1;
      // Never log storage_key alongside anything that identifies the
      // candidate — the recording id is enough to find the row.
      log_failed(err, row);
    }
  }

  return result;
}

/**
 * Held apart from the loop only so the catch stays one line and the logger is
 * not threaded through the helper signature. Uses console.warn because
 * purgeExpiredInterviewMedia takes no Logger (the run-vs-helper split keeps
 * the helper driveable from a test); the per-pass structured line below is
 * what ops reads.
 */
function log_failed(err: unknown, row: PurgeCandidate): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    `interview_media_purge: recording ${row.id} (tenant ${row.tenant_id}) not purged: ${msg}`,
  );
}

/** ScheduledJob entrypoint — returns void, the counts land in the log line. */
export async function interviewMediaPurgeSweep(log: Logger): Promise<void> {
  const r = await purgeExpiredInterviewMedia(poolSql);
  log.info(
    {
      purged: r.purged,
      by_retention_window: r.byRetentionWindow,
      // A non-zero count here means a round never reached a terminal state —
      // see WINDOW 2. Worth noticing, not worth failing the pass over.
      by_hard_ceiling: r.byHardCeiling,
      failed: r.failed,
      retention_days: INTERVIEW_MEDIA_RETENTION_DAYS,
      hard_ceiling_days: INTERVIEW_MEDIA_HARD_CEILING_DAYS,
    },
    "interview_media_purge.complete",
  );
}
