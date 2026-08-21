/**
 * N3.3b — note generation in the transcript drain (transcript → notes).
 *
 * Companion to notetaker-04, which covers the transcription half with
 * `interview_notes` switched OFF. This file switches it ON and exercises the
 * derivation stage against the LOCAL tiers throughout: LocalStorageClient,
 * LocalASRClient and LocalAIClient, so a full media → transcript → notes drain
 * runs with no network, no Supabase, no vendor minute and no token.
 *
 * The LocalAIClient fixture is keyed by a sha256 of (system + prompt + model +
 * schema), so beforeAll RECONSTRUCTS the exact prompt the drain will send —
 * run the deterministic local ASR over the same bytes, feed the segments
 * through `buildInterviewNotesPrompt`, hash it — and writes the fixture at that
 * key. Reconstructing rather than harvesting the hash out of an error is the
 * whole reason the prompt module is a pure builder; it also means a change to
 * the prompt text shows up here as a fixture miss rather than silently passing.
 *
 * What each case protects:
 *
 *   1. A full drain writes BOTH artefacts in one pass — transcript and notes —
 *      and the notes row carries `model` + `prompt_version` provenance.
 *   2. `interview_notes` DISABLED → the transcript is still written, no notes
 *      row exists, no interview_notes usage row was logged (the drain got out
 *      before the model call), and the outbox row completes cleanly with ONE
 *      attempt spent. Transcription and note generation are separate costs
 *      behind separate switches; a tenant may buy the first without the second.
 *   3. A notes failure leaves the row RETRYABLE without destroying the
 *      transcript — and the retry does NOT re-transcribe. That last assertion
 *      is the money line: ASR is billed per audio minute, so a retry that goes
 *      back through the vendor to re-attempt a token-priced summary would
 *      double-bill for bytes already stored. It is asserted on the
 *      ai_usage_logs row count keyed to the attempt, not inferred.
 *   4. Regeneration REPLACES rather than appends — one notes row per interview,
 *      same row id, refreshed content (0116's per-interview unique).
 *   5. The product stance is enforced structurally: interview_notes has no
 *      score / rating / recommendation column, the response schema rejects one,
 *      and the prompt carries the anonymous speaker labels through verbatim
 *      instead of asserting who the interviewer is.
 *
 * Synthetic tenant (n33b namespace, RUN-suffixed slugs/emails) driven by raw
 * poolSql, so it touches no demo data and needs no JWT. REQUIRES migration 0116.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { AI_DEFAULT_MODEL, transcriptSegmentsSchema } from "@hireops/api-types";
import { getASRClient, hashStructuredOptions, resetASRClient } from "@hireops/ai-client";
import { getStorageClient, resetStorageClient } from "../src/lib/storage";
import { drainTranscriptOutboxOnce } from "../../../apps/workers/src/lib/transcript-drain.js";
import {
  buildInterviewNotesPrompt,
  interviewNotesAiJsonSchema,
  interviewNotesAiSchema,
  INTERVIEW_NOTES_FEATURE,
  INTERVIEW_NOTES_PROMPT_VERSION,
  INTERVIEW_NOTES_SCHEMA_NAME,
} from "../../../apps/workers/src/lib/interview-notes-prompt.js";

// Fixed synthetic ids (n33b namespace — hex only; raw SQL, no Zod in the way).
const T = "00000000-0000-4000-8000-00000033b001";
const BU = "00000000-0000-4000-8000-00000033b002";
const POSITION = "00000000-0000-4000-8000-00000033b003";
const JD = "00000000-0000-4000-8000-00000033b004";
const REQ = "00000000-0000-4000-8000-00000033b005";
const PERSON = "00000000-0000-4000-8000-00000033b006";
const CANDIDATE = "00000000-0000-4000-8000-00000033b007";
const APP = "00000000-0000-4000-8000-00000033b008";
const MEMBERSHIP = "00000000-0000-4000-8000-00000033b009";

/** One interview + one recording per case — the schema allows exactly one of each. */
const IV_FULL = "00000000-0000-4000-8000-00000033b00a";
const IV_OFF = "00000000-0000-4000-8000-00000033b00b";
const IV_FAIL = "00000000-0000-4000-8000-00000033b00c";

const REC_FULL = "00000000-0000-4000-8000-00000033b010";
const REC_OFF = "00000000-0000-4000-8000-00000033b011";
const REC_FAIL = "00000000-0000-4000-8000-00000033b012";

const ROUND_OF: Record<string, number> = { [IV_FULL]: 1, [IV_OFF]: 2, [IV_FAIL]: 3 };

const RUN = Date.now().toString(36);
const drainLog = createLogger({ base: { service: "n33b-test" } });

const MEDIA_TYPE = "audio/webm";
const DURATION_SECONDS = 180;

/**
 * IDENTICAL BYTES FOR EVERY RECORDING, on purpose. LocalASRClient synthesises
 * its transcript from a hash of (bytes, contentType, duration hint), so one set
 * of bytes means one transcript, one prompt and therefore ONE LocalAIClient
 * fixture covering every case in the file.
 */
const MEDIA = Buffer.from(
  "n33b synthetic interview audio — one payload, one deterministic transcript",
);

/** The round rubric every interview here shares — see the media note above. */
const CRITERIA = [
  { key: "technical_depth", label: "Technical depth" },
  { key: "communication", label: "Communication" },
];
const COMPETENCY_FOCUS = ["system_design", "ownership"];

/**
 * What the "model" returns. Note what is NOT here: no score, no rating, no
 * recommendation, no read on how the candidate seemed. The response schema has
 * nowhere to put one — case 5 proves that — and the fixture matches the shape
 * a compliant answer takes.
 */
const NOTES_JSON = {
  summary:
    "One speaker asked about distributed systems work and the other described a Kafka " +
    "consumer rewrite and a partitioning change. The conversation covered failure modes " +
    "and on-call handling; compensation and availability were not discussed.",
  keyPoints: [
    "Described rewriting a Kafka consumer group to be idempotent after duplicate deliveries.",
    "Said the partitioning change was made to even out a hot partition.",
    "Walked through a cascading failure and the runbook change that followed it.",
  ],
  topicsCovered: ["Technical depth", "Communication"],
  questionsAsked: [
    "Tell me about your experience with Kafka.",
    "How did you decide on that partition key?",
    "What did you change after the incident?",
  ],
  followUps: ["Testing strategy for the consumer rewrite was not discussed."],
};

const here = dirname(fileURLToPath(import.meta.url));
const AI_FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");
const writtenFixtures: string[] = [];

let userId: string;
/** The fixture key the drain's notes call will hash to — computed in beforeAll. */
let notesFixtureHash: string;

interface OutboxRow {
  id: string;
  status: string;
  attempt_count: number;
  attempt_cap: number;
  last_error: string | null;
  completed_at: Date | string | null;
}

interface NotesRow {
  id: string;
  transcript_id: string;
  summary: string | null;
  key_points: unknown;
  topics_covered: unknown;
  questions_asked: unknown;
  follow_ups: unknown;
  model: string | null;
  prompt_version: string | null;
  generated_at: Date | string | null;
}

function storageKeyFor(recordingId: string): string {
  return `n33b/${RUN}/${recordingId}.webm`;
}

async function seedRecording(recordingId: string, interviewId: string): Promise<void> {
  await poolSql`
    INSERT INTO public.interview_recordings
      (id, tenant_id, interview_id, source, status, storage_key, media_type,
       duration_seconds, size_bytes, requested_by_membership_id, uploaded_at)
    VALUES (${recordingId}, ${T}, ${interviewId}, 'manual_upload', 'uploaded',
            ${storageKeyFor(recordingId)}, ${MEDIA_TYPE}, ${DURATION_SECONDS}, 4096,
            ${MEMBERSHIP}, now())
  `;
  await getStorageClient().put(storageKeyFor(recordingId), MEDIA, { contentType: MEDIA_TYPE });
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

async function notesFor(interviewId: string): Promise<NotesRow[]> {
  return poolSql<NotesRow[]>`
    SELECT id, transcript_id, summary, key_points, topics_covered, questions_asked,
           follow_ups, model, prompt_version, generated_at
    FROM public.interview_notes
    WHERE tenant_id = ${T} AND interview_id = ${interviewId}
  `;
}

async function transcriptFor(interviewId: string): Promise<{ id: string; full_text: string }> {
  const [row] = await poolSql<{ id: string; full_text: string }[]>`
    SELECT id, full_text FROM public.interview_transcripts
    WHERE tenant_id = ${T} AND interview_id = ${interviewId}
  `;
  assert.ok(row, `no transcript for interview ${interviewId}`);
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

/** ai_usage_logs rows for one feature keyed to one drain attempt. */
async function usageCount(feature: string, outboxId: string): Promise<number> {
  const [row] = await poolSql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM public.ai_usage_logs
    WHERE tenant_id = ${T} AND feature = ${feature} AND request_id = ${outboxId}
  `;
  return row?.n ?? 0;
}

/** Flip the tenant's interview_notes switch. The resolver caches nothing. */
async function setNotesEnabled(enabled: boolean): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = ${JSON.stringify({ aiSettings: { interview_notes: { enabled } } })}::jsonb
    WHERE id = ${T}
  `;
}

/**
 * Reconstructs the notes prompt the drain will build and writes the
 * LocalAIClient fixture at its hash.
 *
 * The reconstruction is faithful because every input is deterministic: the
 * local ASR synthesises from the media bytes, and the rubric is what we seeded.
 * If the drain's call ever diverges from this — a changed prompt, a changed
 * schema, a changed model default — the tests fail with a fixture miss naming
 * the hash it wanted, which is the intended signal rather than a silent pass.
 */
async function primeNotesFixture(): Promise<void> {
  const asr = await getASRClient(T).transcribe(MEDIA, {
    contentType: MEDIA_TYPE,
    durationSecondsHint: DURATION_SECONDS,
  });
  const built = buildInterviewNotesPrompt({
    segments: transcriptSegmentsSchema.parse(asr.segments),
    fullText: asr.fullText,
    criteria: CRITERIA,
    competencyFocus: COMPETENCY_FOCUS,
  });
  notesFixtureHash = hashStructuredOptions({
    system: built.system,
    prompt: built.user,
    model: AI_DEFAULT_MODEL,
    schema: interviewNotesAiJsonSchema,
    schemaName: INTERVIEW_NOTES_SCHEMA_NAME,
    feature: INTERVIEW_NOTES_FEATURE,
  });
  await mkdir(AI_FIXTURE_DIR, { recursive: true });
  const path = resolve(AI_FIXTURE_DIR, `${notesFixtureHash}.json`);
  await writeFile(
    path,
    JSON.stringify({
      json: NOTES_JSON,
      inputTokens: 3400,
      outputTokens: 320,
      costMicros: 14200,
      latencyMs: 610,
    }),
  );
  writtenFixtures.push(path);
}

/** Removes the fixture so the next notes call misses — case 3's failure. */
async function unprimeNotesFixture(): Promise<void> {
  await unlink(resolve(AI_FIXTURE_DIR, `${notesFixtureHash}.json`)).catch(() => undefined);
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    // Audit rows first — interview_recordings AND interview_notes both carry
    // audit triggers, so the drain's own writes land in the partitioned
    // audit_logs.
    () =>
      poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T} AND entity_type IN ('interview_recordings','interview_notes','interviews','applications','requisitions')`,
    () => poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.transcript_outbox WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_notes WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_transcripts WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_recordings WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_recording_consents WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interviews WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_plans WHERE tenant_id = ${T}`,
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
      console.warn("N3.3b cleanup step failed (continuing):", err);
    }
  }
}

describe("N3.3b — interview notes generation", () => {
  beforeAll(async () => {
    const [existing] = await poolSql<{ user_id: string }[]>`
      SELECT user_id FROM public.tenant_user_memberships LIMIT 1
    `;
    assert.ok(existing, "no tenant_user_memberships row to borrow a user_id from");
    userId = existing.user_id;

    await cleanup();
    resetStorageClient();
    resetASRClient();

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${T}, ${`synth-n33b-${RUN}`}, ${`Interview Notes Synth ${RUN}`}, 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, ${`N33B BU ${RUN}`}, ${`n33b-bu-${RUN}`})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${userId}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, ${`N33B Backend Engineer ${RUN}`}, 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# N33B JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PERSON}, ${T}, 'N33B Candidate', ${`n33b-cand-${RUN}@example.test`}, ${`n33b-cand-${RUN}@example.test`})
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

    // One plan round per interview, all with the SAME competency focus — the
    // prompt (and therefore the fixture hash) must be identical across cases.
    for (const round of [1, 2, 3]) {
      await poolSql`
        INSERT INTO public.interview_plans
          (tenant_id, requisition_id, round_number, round_name, duration_minutes, mode,
           scorecard_template, competency_focus)
        VALUES (${T}, ${REQ}, ${round}, ${`N33B Round ${round}`}, 60, 'video', 'technical',
                ${JSON.stringify(COMPETENCY_FOCUS)}::jsonb)
      `;
    }
    for (const id of [IV_FULL, IV_OFF, IV_FAIL]) {
      await poolSql`
        INSERT INTO public.interviews
          (id, tenant_id, application_id, requisition_id, round_number, round_name,
           status, duration_minutes, mode, created_by_membership_id,
           scorecard_template, scorecard_criteria_snapshot)
        VALUES (${id}, ${T}, ${APP}, ${REQ}, ${ROUND_OF[id]!}, ${`N33B Round ${ROUND_OF[id]!}`},
                'completed', 60, 'video', ${MEMBERSHIP}, 'technical',
                ${JSON.stringify(CRITERIA)}::jsonb)
      `;
    }

    await seedRecording(REC_FULL, IV_FULL);
    await seedRecording(REC_OFF, IV_OFF);
    await seedRecording(REC_FAIL, IV_FAIL);

    await primeNotesFixture();
  });

  afterAll(async () => {
    for (const path of writtenFixtures) {
      await unlink(path).catch(() => undefined);
    }
    await cleanup();
    resetStorageClient();
    resetASRClient();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: one pass writes BOTH the transcript and the notes, with provenance", async () => {
    const outboxId = await enqueue(REC_FULL);

    const result = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(result.claimed, 1, "exactly one row claimed (batch size is 1 by design)");
    assert.equal(result.completed, 1, "the transcription half completed");
    assert.equal(result.noted, 1, "and the derivation half wrote notes");
    assert.equal(result.notesSkipped, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.retried, 0);

    const row = await outbox(outboxId);
    assert.equal(row.status, "completed");
    assert.ok(row.completed_at, "completed_at must be stamped");
    assert.equal(row.attempt_count, 1, "one attempt, one success");
    assert.equal(
      row.last_error,
      null,
      "a clean full drain has nothing to explain — last_error stays null",
    );
    assert.equal(await recordingStatus(REC_FULL), "transcribed");

    const transcript = await transcriptFor(IV_FULL);

    const notes = await notesFor(IV_FULL);
    assert.equal(notes.length, 1, "exactly one notes row per interview");
    const note = notes[0]!;
    assert.equal(
      note.transcript_id,
      transcript.id,
      "notes point at the transcript they derive from",
    );
    assert.equal(note.summary, NOTES_JSON.summary, "the model's summary is stored verbatim");
    assert.deepEqual(note.key_points, NOTES_JSON.keyPoints);
    assert.deepEqual(note.topics_covered, NOTES_JSON.topicsCovered);
    assert.deepEqual(note.questions_asked, NOTES_JSON.questionsAsked);
    assert.deepEqual(note.follow_ups, NOTES_JSON.followUps);

    // Provenance: which model, which prompt. A regenerated corpus is only
    // legible if every row says which version produced it.
    assert.equal(note.model, AI_DEFAULT_MODEL, "the model that answered is stamped");
    assert.equal(
      note.prompt_version,
      INTERVIEW_NOTES_PROMPT_VERSION,
      "the prompt version is stamped",
    );
    assert.ok(note.generated_at, "generated_at is stamped");

    // Both cost lines were spent exactly once, and they are SEPARATE features:
    // asr_transcription is billed per audio minute, interview_notes per token.
    assert.equal(await usageCount("asr_transcription", outboxId), 1, "one ASR call");
    assert.equal(await usageCount(INTERVIEW_NOTES_FEATURE, outboxId), 1, "one notes call");
  });

  it("Test 2: interview_notes DISABLED — transcript written, no notes, row completes cleanly", async () => {
    await setNotesEnabled(false);
    try {
      const outboxId = await enqueue(REC_OFF);

      const result = await drainTranscriptOutboxOnce({ log: drainLog });
      assert.equal(result.claimed, 1);
      assert.equal(
        result.completed,
        1,
        "the transcript still happened — it is a separate purchase",
      );
      assert.equal(result.noted, 0);
      assert.equal(result.notesSkipped, 1);
      assert.equal(result.retried, 0, "a disabled switch is not an error and must not retry");
      assert.equal(result.failed, 0);

      const row = await outbox(outboxId);
      assert.equal(row.status, "completed");
      assert.ok(row.completed_at, "completed_at must be stamped");
      assert.equal(row.attempt_count, 1, "one attempt, no churn");
      assert.ok(
        row.last_error?.includes("interview_notes disabled"),
        `the reason should be legible to ops, got: ${row.last_error}`,
      );

      // The transcript stands on its own.
      const transcript = await transcriptFor(IV_OFF);
      assert.ok(transcript.full_text.length > 0);
      assert.equal(await recordingStatus(REC_OFF), "transcribed");

      assert.equal((await notesFor(IV_OFF)).length, 0, "no notes row is written");

      // The strong form: the drain bailed out BEFORE the model call, so there
      // is no token cost at all — not a cheap call, no call.
      assert.equal(
        await usageCount(INTERVIEW_NOTES_FEATURE, outboxId),
        0,
        "a disabled feature must not reach the model",
      );
      assert.equal(await usageCount("asr_transcription", outboxId), 1, "the ASR half still ran");
    } finally {
      await setNotesEnabled(true);
    }
  });

  it("Test 3: a notes failure is retryable, keeps the transcript, and does NOT re-transcribe", async () => {
    await unprimeNotesFixture();
    const outboxId = await enqueue(REC_FAIL);

    // ── Pass 1: transcription succeeds, note generation misses its fixture ──
    const first = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(first.claimed, 1);
    assert.equal(first.retried, 1, "a notes failure below the cap goes back on the queue");
    assert.equal(first.completed, 0);
    assert.equal(first.noted, 0);

    let row = await outbox(outboxId);
    assert.equal(row.status, "pending");
    assert.equal(row.attempt_count, 1);

    // The transcript is the expensive artefact and it survives the failure.
    const transcript = await transcriptFor(IV_FAIL);
    assert.ok(transcript.full_text.length > 0);
    assert.equal((await notesFor(IV_FAIL)).length, 0, "no half-written notes row");

    // And the recording is LEFT at 'transcribed' rather than reverted to
    // 'uploaded' — that status is what routes the retry away from the vendor.
    assert.equal(
      await recordingStatus(REC_FAIL),
      "transcribed",
      "a notes failure must not relabel a recording whose audio is already transcribed",
    );
    assert.equal(await usageCount("asr_transcription", outboxId), 1, "one ASR call so far");

    // ── Pass 2: still no fixture. The retry must skip transcription. ────────
    const second = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(second.claimed, 1, "the row is claimable again");
    assert.equal(second.retried, 1);

    row = await outbox(outboxId);
    assert.equal(row.status, "pending");
    assert.equal(row.attempt_count, 2, "each attempt is counted against the cap");

    // THE money assertion. ASR is billed per audio minute; a retry that went
    // back through the vendor to re-attempt a token-priced summary would bill
    // the same minutes twice. The count keyed to this attempt must not move.
    assert.equal(
      await usageCount("asr_transcription", outboxId),
      1,
      "the retry must NOT re-transcribe — the audio is already paid for and stored",
    );
    assert.equal(
      (await transcriptFor(IV_FAIL)).id,
      transcript.id,
      "and the transcript row is the same one, not a rewrite",
    );

    // ── Pass 3: put the fixture back; only the notes are attempted. ─────────
    await primeNotesFixture();
    const third = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(third.claimed, 1);
    assert.equal(third.noted, 1, "the notes finally land");
    assert.equal(third.retried, 0);
    assert.equal(third.failed, 0);

    row = await outbox(outboxId);
    assert.equal(row.status, "completed");
    assert.equal(row.attempt_count, 3);
    assert.equal(
      await usageCount("asr_transcription", outboxId),
      1,
      "three attempts, exactly one ASR call across all of them",
    );

    const notes = await notesFor(IV_FAIL);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.summary, NOTES_JSON.summary);
  });

  it("Test 4: regeneration REPLACES the notes row rather than appending", async () => {
    const before = await notesFor(IV_FULL);
    assert.equal(before.length, 1, "test 1 left exactly one row");
    const originalId = before[0]!.id;

    // Mark the stored row so a replacement is distinguishable from a no-op.
    await poolSql`
      UPDATE public.interview_notes
      SET summary = 'STALE — superseded by regeneration', model = 'stale-model',
          prompt_version = 'stale-v0'
      WHERE tenant_id = ${T} AND interview_id = ${IV_FULL}
    `;

    // Stand in for N3.4's "regenerate notes": the recording is already
    // 'transcribed', so this re-runs the derivation half only. The outbox has a
    // UNIQUE on (tenant_id, recording_id), so the existing row is re-armed
    // rather than a second one inserted.
    const [existing] = await poolSql<{ id: string }[]>`
      UPDATE public.transcript_outbox
      SET status = 'pending', attempt_count = 0, completed_at = NULL, last_error = NULL
      WHERE tenant_id = ${T} AND recording_id = ${REC_FULL}
      RETURNING id
    `;
    const outboxId = existing!.id;

    const result = await drainTranscriptOutboxOnce({ log: drainLog });
    assert.equal(result.claimed, 1);
    assert.equal(result.noted, 1, "the notes were regenerated");
    assert.equal(result.completed, 0, "nothing was transcribed — that half was already done");
    assert.equal(result.skipped, 1);
    assert.equal(await usageCount("asr_transcription", outboxId), 1, "still one ASR call, ever");

    const after = await notesFor(IV_FULL);
    assert.equal(after.length, 1, "STILL exactly one notes row — replaced, never appended");
    assert.equal(after[0]!.id, originalId, "the same row was updated in place (ON CONFLICT)");
    assert.equal(after[0]!.summary, NOTES_JSON.summary, "the stale content is gone");
    assert.equal(after[0]!.model, AI_DEFAULT_MODEL, "provenance is re-stamped, not left stale");
    assert.equal(after[0]!.prompt_version, INTERVIEW_NOTES_PROMPT_VERSION);

    const row = await outbox(outboxId);
    assert.equal(row.status, "completed");
  });

  it("Test 5: no score anywhere — not in the table, not in the schema, not in the prompt", async () => {
    // 0116: "Notes assist the panellist; they never auto-fill a hire/no-hire.
    // That is a product stance, not an unfinished schema." Assert the absence
    // structurally so a later ticket cannot add one quietly.
    const columns = await poolSql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'interview_notes'
    `;
    const offenders = columns
      .map((c) => c.column_name)
      .filter((n) => /score|rating|recommend|verdict|sentiment/i.test(n));
    assert.deepEqual(offenders, [], "interview_notes must carry no score/rating/recommendation");

    // The schema is the enforcement, not the request: an extra key fails the
    // strict parse, so a model that returned a rating writes nothing at all.
    const withRating = { ...NOTES_JSON, overallRating: 4 };
    assert.equal(
      interviewNotesAiSchema.safeParse(withRating).success,
      false,
      "a rating field must not survive the response schema",
    );
    assert.equal(interviewNotesAiSchema.safeParse(NOTES_JSON).success, true);

    // And the prompt: anonymous labels go through VERBATIM. Rewriting them to
    // "Interviewer" / "Candidate" here would be inventing the provenance the
    // ASR layer deliberately refused to invent.
    const built = buildInterviewNotesPrompt({
      segments: [
        { speaker: "speaker_0", startMs: 0, endMs: 4000, text: "Tell me about Kafka." },
        { speaker: "speaker_1", startMs: 4200, endMs: 9000, text: "I rewrote our consumer group." },
      ],
      fullText: "Tell me about Kafka. I rewrote our consumer group.",
      criteria: CRITERIA,
      competencyFocus: COMPETENCY_FOCUS,
    });
    assert.ok(built.user.includes("speaker_0"), "labels are passed through as-is");
    assert.ok(built.user.includes("speaker_1"));
    assert.ok(
      /anonymous/i.test(built.system),
      "the system prompt must say the labels are anonymous",
    );
    assert.ok(
      /INFER who is interviewing/.test(built.system),
      "roles are inferred from content, never from label order",
    );
    assert.ok(
      /NOT score, rate, rank or recommend/.test(built.system),
      "the system prompt must forbid a verdict",
    );
    assert.ok(
      /sentiment/i.test(built.system) && /psychometric/i.test(built.system),
      "and must forbid inference beyond the words spoken",
    );
  });
});
