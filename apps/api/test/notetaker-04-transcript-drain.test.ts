/**
 * N3.3a — the transcript drain worker (media → transcript, transcription only).
 *
 * Runs entirely against the LOCAL tiers: NODE_ENV=test forces LocalStorageClient
 * and LocalASRClient, so the whole path — mint a signed read URL, dereference
 * it, transcribe the bytes, validate, insert — exercises with no network, no
 * Supabase and no vendor minute. That round trip is exactly what N3.2's
 * resolveLocalSignedUrl() was built for.
 *
 * What each case protects:
 *
 *   1. A pending row drains to 'completed' and the transcript it writes
 *      satisfies the api-types segment schema — the schema is the contract for
 *      a jsonb column that would otherwise accept anything.
 *   2. A NON-RETRYABLE ASR failure fails the row IMMEDIATELY with attempt_count
 *      still at 1. The assertion is the point: retrying an undecodable file
 *      pays the vendor again for a guaranteed failure, so the remaining
 *      attempts must not be burned proving it.
 *   3. A RETRYABLE failure leaves the row 'pending' with attempt_count
 *      incremented, and a second pass increments it again — the cap, not the
 *      error, decides when to give up.
 *   4. A transcript that already exists for the interview (23505 — what a
 *      reclaimed lease produces) resolves as SUCCESS. The work is done; failing
 *      the row over the artefact being present would be absurd.
 *   5. A recording already 'transcribed' is skipped cleanly, and — the strong
 *      form of that claim — writes NO ai_usage_logs row, i.e. the drain got out
 *      before it could spend a minute.
 *   6. The lease / sweep constants still sit above the ASR adapter's 20-minute
 *      wall-clock budget. A no-DB guard against someone "tidying" them down to
 *      match the other drains, which would re-introduce double billing.
 *
 * Synthetic tenant (n334 namespace, RUN-suffixed slugs/emails) driven by raw
 * poolSql, so it touches no demo data and needs no JWT. REQUIRES migration 0116.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { transcriptSegmentsSchema } from "@hireops/api-types";
import { hashTranscribeInput, resetASRClient } from "@hireops/ai-client";
import { getStorageClient, resetStorageClient } from "../src/lib/storage";
import {
  drainTranscriptOutboxOnce,
  TRANSCRIPT_CLAIM_LEASE_MS,
  TRANSCRIPT_ORPHAN_SWEEP_MS,
} from "../../../apps/workers/src/lib/transcript-drain.js";

// Fixed synthetic ids (n334 namespace — hex only; raw SQL, no Zod in the way).
const T = "00000000-0000-4000-8000-000000334001";
const BU = "00000000-0000-4000-8000-000000334002";
const POSITION = "00000000-0000-4000-8000-000000334003";
const JD = "00000000-0000-4000-8000-000000334004";
const REQ = "00000000-0000-4000-8000-000000334005";
const PERSON = "00000000-0000-4000-8000-000000334006";
const CANDIDATE = "00000000-0000-4000-8000-000000334007";
const APP = "00000000-0000-4000-8000-000000334008";
const MEMBERSHIP = "00000000-0000-4000-8000-000000334009";

/** One interview + one recording per case — the schema allows exactly one of each. */
const IV_OK = "00000000-0000-4000-8000-00000033400a";
const IV_NONRETRY = "00000000-0000-4000-8000-00000033400b";
const IV_RETRY = "00000000-0000-4000-8000-00000033400c";
const IV_DUP = "00000000-0000-4000-8000-00000033400d";
const IV_DONE = "00000000-0000-4000-8000-00000033400e";

const REC_OK = "00000000-0000-4000-8000-000000334010";
const REC_NONRETRY = "00000000-0000-4000-8000-000000334011";
const REC_RETRY = "00000000-0000-4000-8000-000000334012";
const REC_DUP = "00000000-0000-4000-8000-000000334013";
const REC_DONE = "00000000-0000-4000-8000-000000334014";

const RUN = Date.now().toString(36);
const drainLog = createLogger({ base: { service: "n334-test" } });

const MEDIA_TYPE = "audio/webm";
const DURATION_SECONDS = 120;

/**
 * LocalASRClient's fixture directory. It ships empty (a missing fixture just
 * means synthesis), so the failure cases create it and afterAll removes it —
 * the tree is left exactly as found. Same writeFile/unlink discipline as
 * ai-03-scoring.test.ts uses for LLM fixtures.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ASR_FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/asr/fixtures");
const writtenFixtures: string[] = [];

let userId: string;

interface OutboxRow {
  id: string;
  status: string;
  attempt_count: number;
  attempt_cap: number;
  last_error: string | null;
  completed_at: Date | string | null;
}

/** Media bytes are per-recording so each one hashes to its own fixture key. */
function mediaFor(recordingId: string): Buffer {
  return Buffer.from(`n334 synthetic interview audio for ${recordingId}`);
}

function storageKeyFor(recordingId: string): string {
  return `n334/${RUN}/${recordingId}.webm`;
}

/**
 * Writes a LocalASRClient fixture that throws with an explicit retryability
 * verdict. The key is the hash of exactly the arguments the drain passes —
 * bytes, contentType and the duration hint — so getting it wrong shows up as
 * a synthesised transcript rather than the expected throw.
 */
async function writeThrowingFixture(recordingId: string, retryable: boolean): Promise<void> {
  const hash = hashTranscribeInput(mediaFor(recordingId), {
    contentType: MEDIA_TYPE,
    durationSecondsHint: DURATION_SECONDS,
  });
  const path = resolve(ASR_FIXTURE_DIR, `${hash}.json`);
  await writeFile(
    path,
    JSON.stringify({
      durationSeconds: DURATION_SECONDS,
      throw: {
        message: retryable ? "vendor 503 — try again" : "unsupported codec in container",
        code: retryable ? "provider_unavailable" : "unsupported_media",
        retryable,
      },
    }),
  );
  writtenFixtures.push(path);
}

async function seedRecording(
  recordingId: string,
  interviewId: string,
  status: string,
): Promise<void> {
  await poolSql`
    INSERT INTO public.interview_recordings
      (id, tenant_id, interview_id, source, status, storage_key, media_type,
       duration_seconds, size_bytes, requested_by_membership_id, uploaded_at)
    VALUES (${recordingId}, ${T}, ${interviewId}, 'manual_upload', ${status},
            ${storageKeyFor(recordingId)}, ${MEDIA_TYPE}, ${DURATION_SECONDS}, 4096,
            ${MEMBERSHIP}, now())
  `;
  await getStorageClient().put(storageKeyFor(recordingId), mediaFor(recordingId), {
    contentType: MEDIA_TYPE,
  });
}

/** Enqueue is per-test so exactly one row is claimable at a time (batch = 1). */
async function enqueue(recordingId: string): Promise<string> {
  const [row] = await poolSql<{ id: string }[]>`
    INSERT INTO public.transcript_outbox (tenant_id, recording_id, status)
    VALUES (${T}, ${recordingId}, 'pending')
    RETURNING id
  `;
  return row!.id;
}

async function outbox(id: string): Promise<OutboxRow> {
  const [row] = await poolSql<OutboxRow[]>`
    SELECT id, status, attempt_count, attempt_cap, last_error, completed_at
    FROM public.transcript_outbox WHERE id = ${id}
  `;
  assert.ok(row, `transcript_outbox row ${id} disappeared`);
  return row;
}

async function recordingStatus(recordingId: string): Promise<string> {
  const [row] = await poolSql<{ status: string }[]>`
    SELECT status FROM public.interview_recordings
    WHERE tenant_id = ${T} AND id = ${recordingId}
  `;
  assert.ok(row, `interview_recording ${recordingId} disappeared`);
  return row.status;
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    // Audit rows first — interview_recordings carries an audit trigger, so the
    // drain's own status writes land in the partitioned audit_logs.
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
      console.warn("N3.3a cleanup step failed (continuing):", err);
    }
  }
}

describe("N3.3a — transcript drain worker", () => {
  beforeAll(async () => {
    const [existing] = await poolSql<{ user_id: string }[]>`
      SELECT user_id FROM public.tenant_user_memberships LIMIT 1
    `;
    assert.ok(existing, "no tenant_user_memberships row to borrow a user_id from");
    userId = existing.user_id;

    await cleanup();
    resetStorageClient();
    resetASRClient();
    await mkdir(ASR_FIXTURE_DIR, { recursive: true });

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${T}, ${`synth-n334-${RUN}`}, ${`Transcript Drain Synth ${RUN}`}, 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, ${`N334 BU ${RUN}`}, ${`n334-bu-${RUN}`})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${userId}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, ${`N334 Backend Engineer ${RUN}`}, 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# N334 JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PERSON}, ${T}, 'N334 Candidate', ${`n334-cand-${RUN}@example.test`}, ${`n334-cand-${RUN}@example.test`})
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
    const interviews = [
      [IV_OK, 1],
      [IV_NONRETRY, 2],
      [IV_RETRY, 3],
      [IV_DUP, 4],
      [IV_DONE, 5],
    ] as const;
    for (const [id, round] of interviews) {
      await poolSql`
        INSERT INTO public.interviews
          (id, tenant_id, application_id, requisition_id, round_number, round_name,
           status, duration_minutes, mode, created_by_membership_id)
        VALUES (${id}, ${T}, ${APP}, ${REQ}, ${round}, ${`N334 Round ${round}`},
                'scheduled', 60, 'video', ${MEMBERSHIP})
      `;
    }

    await seedRecording(REC_OK, IV_OK, "uploaded");
    await seedRecording(REC_NONRETRY, IV_NONRETRY, "uploaded");
    await seedRecording(REC_RETRY, IV_RETRY, "uploaded");
    await seedRecording(REC_DUP, IV_DUP, "uploaded");
    // Already done — the drain must get out before it spends a vendor minute.
    await seedRecording(REC_DONE, IV_DONE, "transcribed");

    await writeThrowingFixture(REC_NONRETRY, false);
    await writeThrowingFixture(REC_RETRY, true);
  });

  afterAll(async () => {
    for (const path of writtenFixtures) {
      await unlink(path).catch(() => undefined);
    }
    // Only succeeds if we left it empty, which is the intent.
    await rmdir(ASR_FIXTURE_DIR).catch(() => undefined);
    await cleanup();
    resetStorageClient();
    resetASRClient();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: a pending row drains to completed and writes a schema-valid transcript", async () => {
    const outboxId = await enqueue(REC_OK);

    const result = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(result.claimed, 1, "exactly one row claimed (batch size is 1 by design)");
    assert.equal(result.completed, 1, "the row should have completed");
    assert.equal(result.failed, 0);
    assert.equal(result.retried, 0);

    const row = await outbox(outboxId);
    assert.equal(row.status, "completed");
    assert.ok(row.completed_at, "completed_at must be stamped");
    assert.equal(row.attempt_count, 1, "one attempt, one success");

    assert.equal(await recordingStatus(REC_OK), "transcribed");

    const [transcript] = await poolSql<
      {
        interview_id: string;
        recording_id: string;
        segments: unknown;
        full_text: string;
        language: string | null;
        provider: string | null;
        provider_model: string | null;
        word_count: number | null;
      }[]
    >`
      SELECT interview_id, recording_id, segments, full_text, language, provider,
             provider_model, word_count
      FROM public.interview_transcripts
      WHERE tenant_id = ${T} AND interview_id = ${IV_OK}
    `;
    assert.ok(transcript, "a transcript row must exist");
    assert.equal(transcript.recording_id, REC_OK, "denormalised legs must agree");
    assert.equal(transcript.provider, "local", "ASR-side provenance is stamped");
    assert.ok(transcript.provider_model, "provider_model is stamped");
    assert.ok(transcript.full_text.length > 0, "full_text is stored, not recomputed downstream");
    assert.ok((transcript.word_count ?? 0) > 0, "word_count is stamped");

    // THE contract assertion: the jsonb we wrote satisfies the api-types
    // schema. jsonb would have accepted anything, and the row is insert-once.
    const segments = transcriptSegmentsSchema.parse(transcript.segments);
    assert.ok(segments.length > 0, "a synthesised transcript has segments");
    for (const s of segments) {
      assert.ok(s.endMs >= s.startMs, "a turn cannot end before it begins");
      assert.ok(s.speaker.startsWith("speaker_"), "labels are anonymous, never roles");
    }
  });

  it("Test 2: a NON-RETRYABLE ASR failure fails the row immediately, attempts unspent", async () => {
    const outboxId = await enqueue(REC_NONRETRY);

    const result = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(result.claimed, 1);
    assert.equal(result.failed, 1, "a non-retryable error is terminal on the first attempt");
    assert.equal(result.retried, 0);

    const row = await outbox(outboxId);
    assert.equal(row.status, "failed");
    assert.equal(row.attempt_cap, 5, "the cap is still 5 …");
    assert.equal(
      row.attempt_count,
      1,
      "… and only ONE attempt was spent — retrying an undecodable file " +
        "pays the vendor again for a guaranteed failure",
    );
    assert.ok(
      row.last_error?.includes("unsupported codec"),
      `last_error should carry the vendor reason, got: ${row.last_error}`,
    );

    assert.equal(await recordingStatus(REC_NONRETRY), "failed", "the recording is terminal too");

    // No transcript may be written on the failure path.
    const [written] = await poolSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public.interview_transcripts
      WHERE tenant_id = ${T} AND interview_id = ${IV_NONRETRY}
    `;
    assert.equal(written?.n, 0);
  });

  it("Test 3: a RETRYABLE failure leaves the row retryable with attempt_count incremented", async () => {
    const outboxId = await enqueue(REC_RETRY);

    const first = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(first.claimed, 1);
    assert.equal(first.retried, 1, "a retryable error must not be terminal below the cap");
    assert.equal(first.failed, 0);

    let row = await outbox(outboxId);
    assert.equal(row.status, "pending", "the row goes back on the queue");
    assert.equal(row.attempt_count, 1);
    assert.ok(row.last_error?.includes("vendor 503"), `got: ${row.last_error}`);
    assert.equal(
      await recordingStatus(REC_RETRY),
      "uploaded",
      "nothing is transcribing any more, so the recording must not claim to be",
    );

    // Second pass: the same fixture throws again and the count climbs. It is
    // the CAP that eventually stops this, not the error.
    const second = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(second.claimed, 1, "the row is claimable again");
    assert.equal(second.retried, 1);

    row = await outbox(outboxId);
    assert.equal(row.status, "pending");
    assert.equal(row.attempt_count, 2, "each attempt is counted against the cap");

    // Wind the row to one below its cap and drain once more. The SAME
    // retryable error is now terminal — proving it is the cap that stops the
    // retry loop, not the error's own verdict. It also clears the queue, which
    // the later tests need: batch size is 1 and this row is the oldest pending.
    await poolSql`
      UPDATE public.transcript_outbox
      SET attempt_count = attempt_cap - 1 WHERE id = ${outboxId}
    `;
    const atCap = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(atCap.claimed, 1);
    assert.equal(atCap.failed, 1, "at the cap, the same retryable error is terminal");

    row = await outbox(outboxId);
    assert.equal(row.status, "failed");
    assert.equal(row.attempt_count, row.attempt_cap, "the cap was reached, not exceeded");
    assert.equal(await recordingStatus(REC_RETRY), "failed", "terminal on the recording too");
  });

  it("Test 4: a duplicate transcript (23505) resolves as SUCCESS, not an error", async () => {
    // Stand in for what a reclaimed lease produces: the transcript is already
    // there when this attempt goes to write its own.
    await poolSql`
      INSERT INTO public.interview_transcripts
        (tenant_id, interview_id, recording_id, segments, full_text, language,
         provider, provider_model, word_count)
      VALUES (${T}, ${IV_DUP}, ${REC_DUP},
              ${JSON.stringify([
                { speaker: "speaker_0", startMs: 0, endMs: 4000, text: "Pre-existing transcript." },
              ])}::jsonb,
              'Pre-existing transcript.', 'en', 'local', 'local-fixture-asr', 3)
    `;

    const outboxId = await enqueue(REC_DUP);

    const result = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(result.claimed, 1);
    assert.equal(result.failed, 0, "a 23505 here is not a failure — the work is done");
    assert.equal(result.retried, 0);
    assert.equal(result.skipped, 1, "counted as skipped: nothing new was written");

    const row = await outbox(outboxId);
    assert.equal(row.status, "completed");
    assert.ok(
      row.last_error?.includes("23505"),
      `the absorbed conflict should be recorded, got: ${row.last_error}`,
    );
    assert.equal(await recordingStatus(REC_DUP), "transcribed");

    const rows = await poolSql<{ full_text: string }[]>`
      SELECT full_text FROM public.interview_transcripts
      WHERE tenant_id = ${T} AND interview_id = ${IV_DUP}
    `;
    assert.equal(rows.length, 1, "still exactly one transcript for the interview");
    assert.equal(
      rows[0]?.full_text,
      "Pre-existing transcript.",
      "the existing artefact is left alone — absorbed, not overwritten",
    );
  });

  it("Test 5: a recording already 'transcribed' is skipped cleanly and spends no minute", async () => {
    const outboxId = await enqueue(REC_DONE);

    const result = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(result.claimed, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 0, "already-done is a completed row, not an error");
    assert.equal(result.completed, 0);

    const row = await outbox(outboxId);
    assert.equal(row.status, "completed");
    assert.ok(
      row.last_error?.includes("already transcribed"),
      `the reason should be legible to ops, got: ${row.last_error}`,
    );
    assert.equal(await recordingStatus(REC_DONE), "transcribed", "status is left alone");

    const [fabricated] = await poolSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public.interview_transcripts
      WHERE tenant_id = ${T} AND interview_id = ${IV_DONE}
    `;
    assert.equal(fabricated?.n, 0, "no transcript is fabricated for a skipped row");

    // The strong form: the drain passes the outbox id as the ASR request_id,
    // so a usage row keyed to this attempt would prove it called the vendor.
    const [usage] = await poolSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public.ai_usage_logs
      WHERE tenant_id = ${T} AND request_id = ${outboxId}
    `;
    assert.equal(usage?.n, 0, "the drain must bail out BEFORE spending an ASR minute");
  });

  it("Test 6: the claim lease and orphan sweep stay above the ASR wall-clock budget", async () => {
    // No DB — a guard against someone aligning these with the other drains'
    // seconds-scale thresholds. AssemblyAI's whole-call budget is 20 minutes;
    // a lease that expires inside it gets the same audio transcribed AND
    // BILLED twice.
    const ASR_WALL_CLOCK_BUDGET_MS = 20 * 60_000;
    assert.ok(
      TRANSCRIPT_CLAIM_LEASE_MS > ASR_WALL_CLOCK_BUDGET_MS,
      "the claim lease must outlive the ASR adapter's 20-minute budget",
    );
    assert.ok(
      TRANSCRIPT_ORPHAN_SWEEP_MS > TRANSCRIPT_CLAIM_LEASE_MS,
      "the sweep must fire strictly after the lease expires, never race it",
    );
    assert.equal(TRANSCRIPT_CLAIM_LEASE_MS, 30 * 60_000, "30 minutes, per the adapter's header");
    assert.equal(TRANSCRIPT_ORPHAN_SWEEP_MS, 45 * 60_000, "45 minutes, per the adapter's header");
  });
});
