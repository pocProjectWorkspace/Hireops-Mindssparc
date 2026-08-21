/**
 * N3.4a — recruiter media upload, and the enqueue producer.
 *
 * THE POINT OF THIS FILE is Test 9: after complete(), a real
 * `transcript_outbox` row exists and `drainTranscriptOutboxOnce` turns it
 * into a transcript. Until this ticket, every row the drain had ever seen was
 * hand-inserted by a test — the pipeline had a consumer and no producer. This
 * is the first time media → transcript runs end to end from the surface a
 * recruiter actually touches.
 *
 * Everything above that guards the gate the producer sits behind:
 *
 *   1. Role gating — a panel member is not a recruiter.
 *   2. No consent → refused.
 *   3. `recording_requested` false → refused, with a DIFFERENT message. The
 *      assertion that the two differ is deliberate: they are unrelated
 *      problems with unrelated fixes, and one generic "not available" would
 *      send a recruiter to the wrong place.
 *   4. A disallowed container is refused before any row is created.
 *   5. An over-cap declared size is refused.
 *   6. The happy path creates the recording and mints a signed upload url.
 *   7. complete() stamps the REAL size and inserts EXACTLY ONE outbox row.
 *   8. A double-complete absorbs 23505 and does not create a second row.
 *   9. The drain turns that row into a transcript.
 *  10. Purged media is refused at complete() rather than enqueued for the
 *      drain to discover and skip.
 *
 * Runs against the LOCAL tiers: NODE_ENV=test forces LocalStorageClient and
 * LocalASRClient, so the browser's direct PUT is stood in for by
 * writeLocalSignedUploadUrl() — the round trip N3.2 built for exactly this —
 * with no network, no Supabase and no vendor minute.
 *
 * Synthetic tenant (n34a namespace, RUN-suffixed slugs/emails), seeded with
 * `interview_notes` DISABLED so the drain does the transcription half and
 * stops; the notes half is notetaker-05's subject. REQUIRES migrations
 * 0116/0117/0118.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { resetASRClient } from "@hireops/ai-client";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";
import {
  getStorageClient,
  resetStorageClient,
  writeLocalSignedUploadUrl,
} from "../src/lib/storage";
import { drainTranscriptOutboxOnce } from "../../../apps/workers/src/lib/transcript-drain.js";

// Fixed synthetic ids (n34a namespace — hex only; raw SQL, no Zod in the way).
const T = "00000000-0000-4000-8000-00000034a001";
const BU = "00000000-0000-4000-8000-00000034a002";
const POSITION = "00000000-0000-4000-8000-00000034a003";
const JD = "00000000-0000-4000-8000-00000034a004";
const REQ = "00000000-0000-4000-8000-00000034a005";
const PERSON = "00000000-0000-4000-8000-00000034a006";
const CANDIDATE = "00000000-0000-4000-8000-00000034a007";
const APP = "00000000-0000-4000-8000-00000034a008";
const MEMBERSHIP = "00000000-0000-4000-8000-00000034a009";

/** One interview per case — 0116 allows exactly one recording per interview. */
const IV_HAPPY = "00000000-0000-4000-8000-00000034a010";
const IV_NO_CONSENT = "00000000-0000-4000-8000-00000034a011";
const IV_NOT_REQUESTED = "00000000-0000-4000-8000-00000034a012";
const IV_LIMITS = "00000000-0000-4000-8000-00000034a013";
const IV_PURGED = "00000000-0000-4000-8000-00000034a014";

const REC_PURGED = "00000000-0000-4000-8000-00000034a020";

const RUN = Date.now().toString(36);
const TENANT_SLUG = `synth-n34a-${RUN}`;
const log = createLogger({ level: "error" });
const drainLog = createLogger({ base: { service: "n34a-test" } });

/** Real bytes, so complete() has a real size to read back off storage. */
const MEDIA = Buffer.from(
  `n34a synthetic interview audio ${RUN} — long enough to have a size worth asserting on`,
);
const MEDIA_TYPE = "audio/webm";
/** What a browser actually sends: MediaRecorder attaches codec parameters. */
const DECLARED_TYPE = "audio/webm;codecs=opus";

let userId: string;

function caller(roles: string[]) {
  const ctx: HonoTRPCContext = {
    tenantId: T,
    userId,
    roles,
    claims: { sub: userId, tid: T, tenant_slug: TENANT_SLUG, roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-n34a-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

/** The message off a thrown TRPCError, however it arrives. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function expectThrows(fn: () => Promise<unknown>, what: string): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail(`${what} should have thrown`);
}

async function grantConsent(interviewId: string): Promise<void> {
  await poolSql`
    INSERT INTO public.interview_recording_consents
      (tenant_id, interview_id, decision, consent_version, captured_via)
    VALUES (${T}, ${interviewId}, 'granted', 'n34a-test-v1', 'candidate_confirm_link')
  `;
}

async function outboxRows(recordingId: string): Promise<{ id: string; status: string }[]> {
  return poolSql<{ id: string; status: string }[]>`
    SELECT id, status FROM public.transcript_outbox
    WHERE tenant_id = ${T} AND recording_id = ${recordingId}
  `;
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () =>
      poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T} AND entity_type IN ('interview_recordings','interview_notes','interviews','applications','requisitions')`,
    () => poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`,
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
      console.warn("N3.4a cleanup step failed (continuing):", err);
    }
  }
}

describe("N3.4a — interview media upload + the enqueue producer", () => {
  beforeAll(async () => {
    const [existing] = await poolSql<{ user_id: string }[]>`
      SELECT user_id FROM public.tenant_user_memberships LIMIT 1
    `;
    assert.ok(existing, "no tenant_user_memberships row to borrow a user_id from");
    userId = existing.user_id;

    await cleanup();
    resetStorageClient();
    resetASRClient();

    // interview_notes OFF, deliberately: this file is scoped to getting media
    // into the pipeline and proving transcription runs. With the switch off
    // the drain writes the transcript and completes cleanly, which is exactly
    // the assertion Test 9 makes. Notes are notetaker-05's subject.
    const AI_SETTINGS_NO_NOTES = { aiSettings: { interview_notes: { enabled: false } } };
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings)
      VALUES (${T}, ${TENANT_SLUG}, ${`Media Upload Synth ${RUN}`}, 'ap-northeast-1', 'active',
              ${JSON.stringify(AI_SETTINGS_NO_NOTES)}::jsonb)
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, ${`N34A BU ${RUN}`}, ${`n34a-bu-${RUN}`})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${userId}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, ${`N34A Backend Engineer ${RUN}`}, 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# N34A JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PERSON}, ${T}, 'N34A Candidate', ${`n34a-cand-${RUN}@example.test`}, ${`n34a-cand-${RUN}@example.test`})
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

    // recording_requested per interview — the recruiter half of the gate.
    const rounds = [
      [IV_HAPPY, 1, true],
      [IV_NO_CONSENT, 2, true],
      [IV_NOT_REQUESTED, 3, false],
      [IV_LIMITS, 4, true],
      [IV_PURGED, 5, true],
    ] as const;
    for (const [id, round, requested] of rounds) {
      await poolSql`
        INSERT INTO public.interviews
          (id, tenant_id, application_id, requisition_id, round_number, round_name,
           status, duration_minutes, mode, created_by_membership_id, recording_requested)
        VALUES (${id}, ${T}, ${APP}, ${REQ}, ${round}, ${`N34A Round ${round}`},
                'scheduled', 60, 'video', ${MEMBERSHIP}, ${requested})
      `;
    }

    // Consent granted everywhere EXCEPT IV_NO_CONSENT, which is left never-asked.
    for (const id of [IV_HAPPY, IV_NOT_REQUESTED, IV_LIMITS, IV_PURGED]) {
      await grantConsent(id);
    }
  });

  afterAll(async () => {
    await cleanup();
    resetStorageClient();
    resetASRClient();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: role gating — a panel member cannot start an upload", async () => {
    // panel_member is the interviewer role. It is deliberately outside
    // INTERVIEW_MANAGE_ROLES: sitting on the panel is not running the round.
    const err = await expectThrows(
      () =>
        caller(["panel_member"]).startInterviewMediaUpload({
          interviewId: IV_HAPPY,
          contentType: DECLARED_TYPE,
          sizeBytes: MEDIA.byteLength,
        }),
      "a panel member starting an upload",
    );
    assert.match(messageOf(err), /Only hiring managers, recruiters and admins/);

    // And no row was created as a side effect of the refusal.
    const [row] = await poolSql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM public.interview_recordings
      WHERE tenant_id = ${T} AND interview_id = ${IV_HAPPY}
    `;
    assert.equal(row?.n, "0", "a refused caller must not create a recording row");
  });

  it("Test 2 + 3: no consent and no request are BOTH refused, with different messages", async () => {
    const noConsent = await expectThrows(
      () =>
        caller(["recruiter"]).startInterviewMediaUpload({
          interviewId: IV_NO_CONSENT,
          contentType: DECLARED_TYPE,
          sizeBytes: MEDIA.byteLength,
        }),
      "an upload with no consent",
    );
    const notRequested = await expectThrows(
      () =>
        caller(["recruiter"]).startInterviewMediaUpload({
          interviewId: IV_NOT_REQUESTED,
          contentType: DECLARED_TYPE,
          sizeBytes: MEDIA.byteLength,
        }),
      "an upload for a round recording was not requested for",
    );

    const a = messageOf(noConsent);
    const b = messageOf(notRequested);
    assert.match(a, /has not been asked for recording consent/);
    assert.match(b, /recording has not been requested for this round/);
    // The whole reason the diagnosis exists: two different problems, two
    // different fixes. A shared "not available" would send someone wrong.
    assert.notEqual(a, b, "the two refusals must not read the same");

    for (const id of [IV_NO_CONSENT, IV_NOT_REQUESTED]) {
      const [row] = await poolSql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM public.interview_recordings
        WHERE tenant_id = ${T} AND interview_id = ${id}
      `;
      assert.equal(row?.n, "0", `a refused gate must not create a recording row (${id})`);
    }
  });

  it("Test 4: a disallowed container is refused", async () => {
    const err = await expectThrows(
      () =>
        caller(["recruiter"]).startInterviewMediaUpload({
          interviewId: IV_LIMITS,
          contentType: "video/mp4",
          sizeBytes: MEDIA.byteLength,
        }),
      "an upload declaring video/mp4",
    );
    assert.match(messageOf(err), /not a supported interview-audio type/);
  });

  it("Test 5: an over-cap declared size is refused", async () => {
    const err = await expectThrows(
      () =>
        caller(["recruiter"]).startInterviewMediaUpload({
          interviewId: IV_LIMITS,
          contentType: DECLARED_TYPE,
          // 400MB — above the 250MB media ceiling, well below anything the
          // browser would let through by accident.
          sizeBytes: 400 * 1024 * 1024,
        }),
      "an upload declaring 400MB",
    );
    assert.match(messageOf(err), /the limit is \d+ bytes/);

    const [row] = await poolSql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM public.interview_recordings
      WHERE tenant_id = ${T} AND interview_id = ${IV_LIMITS}
    `;
    assert.equal(row?.n, "0", "neither refusal may leave a recording row behind");
  });

  it("Test 6: the happy path creates a pending recording and mints an upload url", async () => {
    const started = await caller(["recruiter"]).startInterviewMediaUpload({
      interviewId: IV_HAPPY,
      // Codec parameters attached, exactly as MediaRecorder reports them —
      // normaliseMediaContentType has to strip them or the platform's own
      // capture path is rejected by its own allow-list.
      contentType: DECLARED_TYPE,
      sizeBytes: MEDIA.byteLength,
    });

    assert.equal(started.method, "PUT");
    assert.equal(started.provider, "local", "NODE_ENV=test must select the local tier");
    assert.equal(started.contentType, MEDIA_TYPE, "the stored type is the normalised one");
    assert.ok(started.storageKey.startsWith("interview-media/"), started.storageKey);
    assert.ok(started.uploadUrl.startsWith("local://signed/"), "local tier mints a fake url");

    const [rec] = await poolSql<
      { id: string; status: string; source: string; media_type: string; requested_by: string }[]
    >`
      SELECT id, status, source, media_type, requested_by_membership_id AS requested_by
      FROM public.interview_recordings
      WHERE tenant_id = ${T} AND interview_id = ${IV_HAPPY}
    `;
    assert.ok(rec, "the recording row must exist after start");
    assert.equal(rec.id, started.recordingId);
    assert.equal(rec.status, "pending", "no bytes have landed yet");
    assert.equal(rec.source, "manual_upload");
    assert.equal(rec.media_type, MEDIA_TYPE);
    assert.equal(rec.requested_by, MEMBERSHIP, "provenance: who asked for this recording");

    // Nothing is enqueued by start() — the drain must not see a recording
    // with no media.
    assert.equal((await outboxRows(rec.id)).length, 0, "start() must not enqueue");
  });

  it("Test 7: complete() stamps the REAL size and inserts exactly one outbox row", async () => {
    // Stand in for the browser's direct PUT. Deliberately re-derive the url
    // rather than reuse Test 6's, so this test also proves start() is
    // idempotent over a 'pending' row.
    const started = await caller(["recruiter"]).startInterviewMediaUpload({
      interviewId: IV_HAPPY,
      contentType: DECLARED_TYPE,
      sizeBytes: MEDIA.byteLength,
    });
    writeLocalSignedUploadUrl(started.uploadUrl, MEDIA, { contentType: MEDIA_TYPE });

    const done = await caller(["recruiter"]).completeInterviewMediaUpload({
      interviewId: IV_HAPPY,
      durationSeconds: 1800,
    });

    assert.equal(done.enqueued, true, "the first complete() enqueues");
    assert.equal(done.recording.status, "uploaded");
    assert.equal(
      done.recording.sizeBytes,
      MEDIA.byteLength,
      "size comes from the object in storage, not from the client's declaration",
    );
    assert.equal(done.recording.durationSeconds, 1800);
    assert.equal(done.recording.queueStatus, "pending");

    const rows = await outboxRows(started.recordingId);
    assert.equal(rows.length, 1, "EXACTLY ONE transcript_outbox row — the missing producer");
    assert.equal(rows[0]?.status, "pending");

    // The object really is where the recording says it is.
    const stat = await getStorageClient().stat(started.storageKey);
    assert.equal(stat.sizeBytes, MEDIA.byteLength);
  });

  it("Test 8: a double-complete absorbs 23505 and does not create a second row", async () => {
    const [before] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.interview_recordings
      WHERE tenant_id = ${T} AND interview_id = ${IV_HAPPY}
    `;
    assert.ok(before);

    const again = await caller(["recruiter"]).completeInterviewMediaUpload({
      interviewId: IV_HAPPY,
    });
    assert.equal(again.enqueued, false, "already queued — success, not an error");

    const rows = await outboxRows(before.id);
    assert.equal(rows.length, 1, "UNIQUE (tenant_id, recording_id) held, and we absorbed it");
  });

  it("Test 9: the drain turns that row into a transcript — media → transcript, end to end", async () => {
    const [rec] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.interview_recordings
      WHERE tenant_id = ${T} AND interview_id = ${IV_HAPPY}
    `;
    assert.ok(rec);

    // A few passes: the default batch is small and this is the only producer
    // in the platform, so nothing else should be competing — but looping
    // keeps the assertion about the transcript rather than about scheduling.
    let claimedTotal = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      const result = await drainTranscriptOutboxOnce({ log: drainLog, batchSize: 5 });
      claimedTotal += result.claimed;
      const [done] = await poolSql<{ status: string }[]>`
        SELECT status FROM public.transcript_outbox
        WHERE tenant_id = ${T} AND recording_id = ${rec.id}
      `;
      if (done?.status === "completed") break;
    }
    assert.ok(claimedTotal >= 1, "the drain must have claimed the row we produced");

    const [transcript] = await poolSql<{ id: string; full_text: string; recording_id: string }[]>`
      SELECT id, full_text, recording_id FROM public.interview_transcripts
      WHERE tenant_id = ${T} AND interview_id = ${IV_HAPPY}
    `;
    assert.ok(transcript, "a transcript row must exist — this is the ticket's real deliverable");
    assert.equal(transcript.recording_id, rec.id);
    assert.ok(transcript.full_text.length > 0, "the transcript must not be empty");

    const [after] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.interview_recordings WHERE tenant_id = ${T} AND id = ${rec.id}
    `;
    assert.equal(after?.status, "transcribed");

    const rows = await outboxRows(rec.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "completed");
  });

  it("Test 10: purged media is refused at complete(), not enqueued for the drain to skip", async () => {
    const key = `interview-media/${T}/${IV_PURGED}.webm`;
    await getStorageClient().put(key, MEDIA, { contentType: MEDIA_TYPE });
    await poolSql`
      INSERT INTO public.interview_recordings
        (id, tenant_id, interview_id, source, status, storage_key, media_type,
         requested_by_membership_id, media_purged_at)
      VALUES (${REC_PURGED}, ${T}, ${IV_PURGED}, 'manual_upload', 'pending', ${key},
              ${MEDIA_TYPE}, ${MEMBERSHIP}, now())
    `;

    const err = await expectThrows(
      () => caller(["recruiter"]).completeInterviewMediaUpload({ interviewId: IV_PURGED }),
      "completing a purged recording",
    );
    assert.match(messageOf(err), /deleted under the retention policy/);

    // The drain would have completed it cleanly as "media purged" — correct,
    // and a claim, a lease and an attempt spent to learn what we already knew.
    assert.equal((await outboxRows(REC_PURGED)).length, 0, "nothing may be enqueued for it");
  });
});
