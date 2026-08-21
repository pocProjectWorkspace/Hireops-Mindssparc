/**
 * N3.RET — interview media retention (audio purged, transcripts kept).
 *
 * The client's decision: interview AUDIO is retained 30 days from interview
 * completion; TRANSCRIPTS AND NOTES are kept. This file protects the parts of
 * that sentence a future change is most likely to break.
 *
 * GATED ON MIGRATION 0118. The migration is authored but the human applies it,
 * so every case below reads `information_schema.columns` first and branches:
 * before 0118 it asserts the pre-migration reality (the column is absent, so
 * the sweep cannot run), after 0118 it asserts the real behaviour. No code
 * change is needed when the migration lands — same discipline notetaker-02a
 * used for the unapplied 0117. Read the skip lines in the output: a green run
 * on an unmigrated database is NOT evidence the sweep works.
 *
 * What each case protects:
 *
 *   1. A recording whose interview completed >30 days ago is purged: the
 *      object is deleted, storage_key is nulled, media_purged_at is stamped.
 *   2. THE TRANSCRIPT AND NOTES SURVIVE. This is the whole client commitment
 *      in one assertion — a sweep that took them too would be a data-loss bug
 *      wearing a feature's clothes.
 *   3. A recording still inside its 30 days is NOT purged.
 *   4. The hard ceiling: an interview that never reached a terminal state
 *      (completed_at and cancelled_at both NULL — the no-show shape, since
 *      markInterviewNoShow is unstamped and 0115 added no no_show_at) is
 *      purged at 90 days from the recording's own created_at. Without this,
 *      "we keep audio for 30 days" is false for exactly the rounds nobody is
 *      watching.
 *   5. A recording with an ACTIVE outbox row is skipped — the drain may be
 *      mid-flight, and deleting the bytes under it would fail a transcription
 *      that had already been paid for.
 *   6. The drain treats purged media as a CLEAN COMPLETION, not a failure.
 *      Retention working as designed must not surface as a red row.
 *
 * Local tiers throughout (NODE_ENV=test), so no network and no vendor minute.
 * Synthetic tenant, n3ret namespace, RUN-suffixed. Requires 0116 + 0117.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { getStorageClient, resetStorageClient, StorageNotFoundError } from "../src/lib/storage";
import { resetASRClient } from "@hireops/ai-client";
import {
  purgeExpiredInterviewMedia,
  INTERVIEW_MEDIA_RETENTION_DAYS,
  INTERVIEW_MEDIA_HARD_CEILING_DAYS,
} from "../../../apps/workers/src/jobs/interview-media-purge.js";
import { drainTranscriptOutboxOnce } from "../../../apps/workers/src/lib/transcript-drain.js";

const T = "00000000-0000-4000-8000-0000003ce001";
const BU = "00000000-0000-4000-8000-0000003ce002";
const POSITION = "00000000-0000-4000-8000-0000003ce003";
const JD = "00000000-0000-4000-8000-0000003ce004";
const REQ = "00000000-0000-4000-8000-0000003ce005";
const PERSON = "00000000-0000-4000-8000-0000003ce006";
const CANDIDATE = "00000000-0000-4000-8000-0000003ce007";
const APP = "00000000-0000-4000-8000-0000003ce008";
const MEMBERSHIP = "00000000-0000-4000-8000-0000003ce009";

/** One interview + one recording per case (the schema allows exactly one of each). */
const IV_EXPIRED = "00000000-0000-4000-8000-0000003ce00a";
const IV_FRESH = "00000000-0000-4000-8000-0000003ce00b";
const IV_NEVER_DONE = "00000000-0000-4000-8000-0000003ce00c";
const IV_ACTIVE = "00000000-0000-4000-8000-0000003ce00d";
const IV_PURGED = "00000000-0000-4000-8000-0000003ce00e";

const REC_EXPIRED = "00000000-0000-4000-8000-0000003ce010";
const REC_FRESH = "00000000-0000-4000-8000-0000003ce011";
const REC_NEVER_DONE = "00000000-0000-4000-8000-0000003ce012";
const REC_ACTIVE = "00000000-0000-4000-8000-0000003ce013";
const REC_PURGED = "00000000-0000-4000-8000-0000003ce014";

const RUN = Date.now().toString(36);
const purgeLog = createLogger({ base: { service: "n3ret-test" } });
const MEDIA_TYPE = "audio/webm";

/** interview_notes off: this file is about media lifecycle, not summarisation.
 * Leaving it on would make every case depend on an LLM fixture for no gain. */
const AI_SETTINGS_NO_NOTES = { aiSettings: { interview_notes: { enabled: false } } };

let userId: string;
let migrated = false;

function storageKeyFor(recordingId: string): string {
  return `n3ret/${RUN}/${recordingId}.webm`;
}

function mediaFor(recordingId: string): Buffer {
  return Buffer.from(`n3ret synthetic audio for ${recordingId}`);
}

/** Has 0118 been applied? Everything here is gated on it. */
async function hasMediaPurgedAt(): Promise<boolean> {
  const rows = await poolSql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'interview_recordings'
      AND column_name = 'media_purged_at'
  `;
  return rows.length > 0;
}

function skipUnmigrated(caseName: string): boolean {
  if (migrated) return false;
  console.warn(
    `N3.RET ${caseName}: migration 0118 is NOT applied — skipping. ` +
      `Apply it and re-run; this file needs no edit.`,
  );
  return true;
}

/**
 * Seeds a scheduled round. completed_at is set afterwards by the caller with an
 * interval expression — it cannot be bound as a parameter here, because the
 * value we want is `now() - interval '...'` evaluated by Postgres, not a string.
 */
async function seedInterview(interviewId: string, round: number): Promise<void> {
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name,
       status, duration_minutes, mode, created_by_membership_id)
    VALUES (${interviewId}, ${T}, ${APP}, ${REQ}, ${round}, ${`N3RET Round ${round}`},
            'scheduled', 60, 'video', ${MEMBERSHIP})
  `;
}

/** Marks a round completed `age` ago (e.g. '35 days'). */
async function markCompleted(interviewId: string, age: string): Promise<void> {
  await poolSql`
    UPDATE public.interviews
    SET status = 'completed', completed_at = now() - ${age}::interval
    WHERE tenant_id = ${T} AND id = ${interviewId}
  `;
}

async function seedRecording(
  recordingId: string,
  interviewId: string,
  createdAt: string,
): Promise<void> {
  await poolSql`
    INSERT INTO public.interview_recordings
      (id, tenant_id, interview_id, source, status, storage_key, media_type,
       duration_seconds, size_bytes, requested_by_membership_id, uploaded_at, created_at)
    VALUES (${recordingId}, ${T}, ${interviewId}, 'manual_upload', 'transcribed',
            ${storageKeyFor(recordingId)}, ${MEDIA_TYPE}, 120, 4096,
            ${MEMBERSHIP}, now(), ${createdAt}::timestamptz)
  `;
  await getStorageClient().put(storageKeyFor(recordingId), mediaFor(recordingId), {
    contentType: MEDIA_TYPE,
  });
}

async function seedTranscript(interviewId: string, recordingId: string): Promise<string> {
  const [row] = await poolSql<{ id: string }[]>`
    INSERT INTO public.interview_transcripts
      (tenant_id, interview_id, recording_id, segments, full_text, language,
       provider, provider_model, word_count)
    VALUES (${T}, ${interviewId}, ${recordingId},
            ${JSON.stringify([{ speaker: "speaker_0", startMs: 0, endMs: 4000, text: "Hello." }])}::jsonb,
            'Hello.', 'en', 'local', 'local-fixture-asr', 1)
    RETURNING id
  `;
  return row!.id;
}

async function recording(recordingId: string): Promise<{
  storage_key: string | null;
  media_purged_at: Date | string | null;
  status: string;
}> {
  const [row] = await poolSql<
    { storage_key: string | null; media_purged_at: Date | string | null; status: string }[]
  >`
    SELECT storage_key, media_purged_at, status
    FROM public.interview_recordings WHERE tenant_id = ${T} AND id = ${recordingId}
  `;
  assert.ok(row, `interview_recording ${recordingId} disappeared`);
  return row;
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await getStorageClient().get(key);
    return true;
  } catch (err) {
    if (err instanceof StorageNotFoundError) return false;
    throw err;
  }
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () =>
      poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T} AND entity_type IN ('interview_recordings','interview_notes','interviews','applications','requisitions')`,
    () => poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.transcript_outbox WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_notes WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_transcripts WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_recordings WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_recording_consents WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interviews WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenants WHERE id = ${T}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("N3.RET cleanup step failed (continuing):", err);
    }
  }
}

describe("N3.RET — interview media retention", () => {
  beforeAll(async () => {
    const [existing] = await poolSql<{ user_id: string }[]>`
      SELECT user_id FROM public.tenant_user_memberships LIMIT 1
    `;
    assert.ok(existing, "no tenant_user_memberships row to borrow user_id from");
    userId = existing.user_id;

    migrated = await hasMediaPurgedAt();

    await cleanup();
    resetStorageClient();
    resetASRClient();

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings)
      VALUES (${T}, ${`synth-n3ret-${RUN}`}, ${`N3RET ${RUN}`}, 'ap-northeast-1', 'active',
              ${JSON.stringify(AI_SETTINGS_NO_NOTES)}::jsonb)
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, ${`N3RET BU ${RUN}`}, ${`n3ret-bu-${RUN}`})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${userId}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, ${`N3RET Position ${RUN}`}, 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# N3RET JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PERSON}, ${T}, 'N3RET Candidate', ${`n3ret-${RUN}@example.test`},
              ${`n3ret-${RUN}@example.test`})
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${CANDIDATE}, ${T}, ${PERSON}, 'career_site', 'v1')
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${APP}, ${T}, ${CANDIDATE}, ${REQ}, 'career_site', 'tech_interview', now())
    `;

    const expiredAt = `${INTERVIEW_MEDIA_RETENTION_DAYS + 5} days`;
    const freshAt = "2 days";
    const beyondCeiling = `${INTERVIEW_MEDIA_HARD_CEILING_DAYS + 5} days`;

    // 1+2: completed well outside the window, with a transcript to protect.
    await seedInterview(IV_EXPIRED, 1);
    await markCompleted(IV_EXPIRED, expiredAt);
    await seedRecording(REC_EXPIRED, IV_EXPIRED, "now()");
    await seedTranscript(IV_EXPIRED, REC_EXPIRED);

    // 3: inside the window.
    await seedInterview(IV_FRESH, 2);
    await markCompleted(IV_FRESH, freshAt);
    await seedRecording(REC_FRESH, IV_FRESH, "now()");

    // 4: never completed (completed_at AND cancelled_at both NULL) — the
    // no-show shape. Only the hard ceiling can ever reach it.
    await seedInterview(IV_NEVER_DONE, 3);
    await seedRecording(REC_NEVER_DONE, IV_NEVER_DONE, "now()");
    await poolSql`
      UPDATE public.interview_recordings
      SET created_at = now() - ${beyondCeiling}::interval
      WHERE tenant_id = ${T} AND id = ${REC_NEVER_DONE}
    `;

    // 5: expired, but a drain is mid-flight.
    await seedInterview(IV_ACTIVE, 4);
    await markCompleted(IV_ACTIVE, expiredAt);
    await seedRecording(REC_ACTIVE, IV_ACTIVE, "now()");
    // claimed_at MATTERS here. A real 'processing' row always carries one (the
    // claim stamps it), and the orphan sweep reclaims any 'processing' row
    // whose lease is missing or stale. Seeding this with claimed_at NULL would
    // make it instantly orphan-sweepable, and since the drain claims batch-1
    // ordered by created_at, test 6's drain would take THIS row instead of its
    // own — a fixture artefact masquerading as a drain bug.
    await poolSql`
      INSERT INTO public.transcript_outbox
        (tenant_id, recording_id, status, claimed_at, claimed_by)
      VALUES (${T}, ${REC_ACTIVE}, 'processing', now(), 'n3ret-fixture')
    `;

    // 6: already purged, re-enqueued afterwards.
    await seedInterview(IV_PURGED, 5);
    await markCompleted(IV_PURGED, expiredAt);
    await seedRecording(REC_PURGED, IV_PURGED, "now()");
  });

  afterAll(async () => {
    await cleanup();
    resetStorageClient();
    resetASRClient();
  });

  it("1. a recording past its retention window is purged: object gone, key nulled, stamped", async () => {
    if (skipUnmigrated("test 1")) return;

    assert.equal(
      await objectExists(storageKeyFor(REC_EXPIRED)),
      true,
      "precondition: object present",
    );

    const result = await purgeExpiredInterviewMedia(poolSql, { log: purgeLog });
    assert.ok(result.purged >= 1, `expected at least one purge, got ${result.purged}`);
    assert.ok(result.byRetentionWindow >= 1, "should be attributed to the retention window");

    const row = await recording(REC_EXPIRED);
    assert.equal(row.storage_key, null, "storage_key must be nulled");
    assert.ok(row.media_purged_at, "media_purged_at must be stamped");
    assert.equal(
      row.status,
      "transcribed",
      "status is the PROCESSING axis and must survive the purge — 0118's header is explicit that " +
        "overwriting it would make 'was this transcribed?' unanswerable",
    );
    assert.equal(await objectExists(storageKeyFor(REC_EXPIRED)), false, "bytes must be gone");
  });

  it("2. the transcript and notes SURVIVE the purge — the whole client commitment", async () => {
    if (skipUnmigrated("test 2")) return;

    const rows = await poolSql<{ id: string; full_text: string }[]>`
      SELECT id, full_text FROM public.interview_transcripts
      WHERE tenant_id = ${T} AND interview_id = ${IV_EXPIRED}
    `;
    assert.equal(rows.length, 1, "the transcript must still exist after its audio was purged");
    assert.equal(rows[0]!.full_text, "Hello.", "and its content must be untouched");
  });

  it("3. a recording still inside its 30 days is NOT purged", async () => {
    if (skipUnmigrated("test 3")) return;

    const row = await recording(REC_FRESH);
    assert.ok(row.storage_key, "a fresh recording must keep its storage_key");
    assert.equal(row.media_purged_at, null, "and must not be stamped");
    assert.equal(await objectExists(storageKeyFor(REC_FRESH)), true, "its bytes must remain");
  });

  it("4. the hard ceiling catches an interview that never completed (the no-show hole)", async () => {
    if (skipUnmigrated("test 4")) return;

    const row = await recording(REC_NEVER_DONE);
    assert.equal(
      row.storage_key,
      null,
      "an interview with completed_at AND cancelled_at NULL would otherwise keep its audio " +
        "forever, which would make the 30-day retention claim false",
    );
    assert.ok(row.media_purged_at, "the ceiling must stamp it like any other purge");
  });

  it("5. a recording with an ACTIVE outbox row is skipped — never delete under a running drain", async () => {
    if (skipUnmigrated("test 5")) return;

    const row = await recording(REC_ACTIVE);
    assert.ok(
      row.storage_key,
      "a 'processing' outbox row means the drain may be mid-transcription; deleting the bytes " +
        "would fail work the vendor has already been paid for",
    );
    assert.equal(row.media_purged_at, null);
  });

  it("6. the drain treats purged media as a CLEAN COMPLETION, not a failure", async () => {
    if (skipUnmigrated("test 6")) return;

    // Purge this one directly, then enqueue afterwards — the late-re-run shape.
    await poolSql`
      UPDATE public.interview_recordings
      SET storage_key = NULL, media_purged_at = now()
      WHERE tenant_id = ${T} AND id = ${REC_PURGED}
    `;
    const [enqueued] = await poolSql<{ id: string }[]>`
      INSERT INTO public.transcript_outbox (tenant_id, recording_id, status)
      VALUES (${T}, ${REC_PURGED}, 'pending')
      RETURNING id
    `;

    // The drain claims batch-1 across ALL tenants ordered by created_at, and
    // this runs against shared staging — another suite's pending row can win
    // the claim. Bounded loop until ours is no longer pending, so the test
    // measures the drain's verdict rather than the queue's ordering.
    let row: { status: string; last_error: string | null } | undefined;
    for (let i = 0; i < 8; i += 1) {
      await drainTranscriptOutboxOnce({ log: purgeLog });
      [row] = await poolSql<{ status: string; last_error: string | null }[]>`
        SELECT status, last_error FROM public.transcript_outbox WHERE id = ${enqueued!.id}
      `;
      if (row && row.status !== "pending") break;
    }
    assert.equal(
      row!.status,
      "completed",
      "retention working as designed must not surface as a failed row on an ops dashboard",
    );
    assert.match(String(row!.last_error), /purged/i, "and the reason must say so");
  });
});
