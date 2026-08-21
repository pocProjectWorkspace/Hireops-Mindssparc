/**
 * N3.4b — reading the transcript + the notes.
 *
 * THE POINT OF THIS FILE is Tests 1–3: the access question. Every other
 * notetaker ticket gated on INTERVIEW_MANAGE_ROLES, which is right for
 * *managing* a recording and wrong for *reading* what was said — the
 * panellists who sat in the round are the primary audience and `panel_member`
 * is deliberately outside that set. So the gate is two conditions, and this
 * file pins both halves:
 *
 *   1. A panellist ON the interview reads it.
 *   2. A panellist NOT on it — a real panel_member, on a different round of
 *      the same requisition — is FORBIDDEN. This is the assertion that
 *      matters: had the ticket been implemented by widening the role set,
 *      every panel member in the tenant could read every candidate's
 *      transcript, and only this test would have caught it.
 *   3. A recruiter, who is on nobody's panel, reads it on role alone.
 *
 * Then the shape and the states:
 *
 *   4. The payload parses against the card schemas the procedure claims to
 *      return, AND the notes carry no score / rating / recommendation key —
 *      0116's product stance, asserted rather than assumed.
 *   5. A PURGED recording returns the transcript WITH the purged marker
 *      rather than an error. Retention deleting the audio on schedule is the
 *      system working; a read that threw would turn that into an incident.
 *   6. A round with no recording returns nulls, not a 404.
 *   7. Transcript present + notes absent + the tenant's `interview_notes`
 *      switch off — the "transcripts without notes" configuration, which a
 *      surface can only describe honestly if `notesEnabled` is on the wire.
 *
 * Pure reads against seeded rows: no storage, no ASR, no drain, no model.
 * Synthetic tenant (n34b namespace, RUN-suffixed slugs/emails). REQUIRES
 * migrations 0116/0117/0118, and at least three distinct users to borrow ids
 * from (`pnpm db:seed:test-users`).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import {
  getInterviewNotesOutputSchema,
  interviewNotesCardSchema,
  interviewTranscriptCardSchema,
} from "@hireops/api-types";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";

// Fixed synthetic ids (n34b namespace — hex only; raw SQL, no Zod in the way).
const T = "00000000-0000-4000-8000-00000034b001";
const BU = "00000000-0000-4000-8000-00000034b002";
const POSITION = "00000000-0000-4000-8000-00000034b003";
const JD = "00000000-0000-4000-8000-00000034b004";
const REQ = "00000000-0000-4000-8000-00000034b005";
const PERSON = "00000000-0000-4000-8000-00000034b006";
const CANDIDATE = "00000000-0000-4000-8000-00000034b007";
const APP = "00000000-0000-4000-8000-00000034b008";

/** Three memberships, three DIFFERENT users — the whole file turns on this. */
const MEM_RECRUITER = "00000000-0000-4000-8000-00000034b010";
const MEM_PANEL_ON = "00000000-0000-4000-8000-00000034b011";
const MEM_PANEL_OFF = "00000000-0000-4000-8000-00000034b012";

/** One interview per state — 0116 allows exactly one recording per interview. */
const IV_READY = "00000000-0000-4000-8000-00000034b020";
const IV_OTHER_ROUND = "00000000-0000-4000-8000-00000034b021";
const IV_PURGED = "00000000-0000-4000-8000-00000034b022";
const IV_NO_RECORDING = "00000000-0000-4000-8000-00000034b023";
const IV_TRANSCRIPT_ONLY = "00000000-0000-4000-8000-00000034b024";

const REC_READY = "00000000-0000-4000-8000-00000034b030";
const REC_PURGED = "00000000-0000-4000-8000-00000034b031";
const REC_TRANSCRIPT_ONLY = "00000000-0000-4000-8000-00000034b032";

const TR_READY = "00000000-0000-4000-8000-00000034b040";
const TR_PURGED = "00000000-0000-4000-8000-00000034b041";
const TR_TRANSCRIPT_ONLY = "00000000-0000-4000-8000-00000034b042";

const NOTES_READY = "00000000-0000-4000-8000-00000034b050";
const NOTES_PURGED = "00000000-0000-4000-8000-00000034b051";

const RUN = Date.now().toString(36);
const TENANT_SLUG = `synth-n34b-${RUN}`;
const log = createLogger({ level: "error" });

/**
 * Anonymous diarisation labels, exactly as every ASR adapter emits them. The
 * read path must hand these through untouched — mapping speaker_0 to a person
 * is the one thing the transcript is not allowed to claim.
 */
const SEGMENTS = [
  {
    speaker: "speaker_0",
    startMs: 0,
    endMs: 4200,
    text: "Thanks for making the time. Talk me through the ingestion pipeline you owned.",
  },
  {
    speaker: "speaker_1",
    startMs: 4200,
    endMs: 15000,
    text: "It was a Kafka pipeline feeding a warehouse; I ran it for about three years.",
  },
  {
    speaker: "speaker_0",
    startMs: 15000,
    endMs: 19500,
    text: "What broke most often, and what did you change?",
  },
];
const FULL_TEXT = SEGMENTS.map((s) => s.text).join(" ");

const NOTE_FIELDS = {
  summary: "Discussed a Kafka ingestion pipeline the candidate owned for three years.",
  keyPoints: ["Owned a Kafka ingestion pipeline for ~3 years", "Fed a downstream warehouse"],
  topicsCovered: ["Technical depth", "Ownership"],
  questionsAsked: ["Talk me through the ingestion pipeline you owned.", "What broke most often?"],
  followUps: ["Probe on schema-evolution handling in a later round."],
};

/** Users borrowed from the DB — memberships FK to auth.users. */
let recruiterUserId: string;
let panelOnUserId: string;
let panelOffUserId: string;

function caller(roles: string[], userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: T,
    userId,
    roles,
    claims: { sub: userId, tid: T, tenant_slug: TENANT_SLUG, roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-n34b-${randomUUID()}`,
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

/** The tenant's `interview_notes` kill switch, as a whole settings blob. */
function aiSettings(notesEnabled: boolean): string {
  return JSON.stringify({ aiSettings: { interview_notes: { enabled: notesEnabled } } });
}

async function setNotesEnabled(enabled: boolean): Promise<void> {
  await poolSql`
    UPDATE public.tenants SET settings = ${aiSettings(enabled)}::jsonb WHERE id = ${T}
  `;
}

async function seedRecording(
  id: string,
  interviewId: string,
  status: string,
  purged: boolean,
): Promise<void> {
  // ISO string, not a Date: the parameter is nullable, so postgres.js has no
  // column type to infer from on the null pass and serialises it as text.
  const purgedAt = purged ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() : null;
  await poolSql`
    INSERT INTO public.interview_recordings
      (id, tenant_id, interview_id, source, status, storage_key, media_type,
       duration_seconds, size_bytes, requested_by_membership_id, uploaded_at, media_purged_at)
    VALUES (${id}, ${T}, ${interviewId}, 'manual_upload', ${status},
            ${`interview-media/${T}/${interviewId}.webm`}, 'audio/webm',
            1200, 4096, ${MEM_RECRUITER}, now() - interval '31 days', ${purgedAt})
  `;
}

async function seedTranscript(id: string, interviewId: string, recordingId: string): Promise<void> {
  await poolSql`
    INSERT INTO public.interview_transcripts
      (id, tenant_id, interview_id, recording_id, segments, full_text,
       language, provider, provider_model, word_count)
    VALUES (${id}, ${T}, ${interviewId}, ${recordingId},
            ${JSON.stringify(SEGMENTS)}::jsonb, ${FULL_TEXT},
            'en', 'local', 'local-asr-v1', ${FULL_TEXT.split(/\s+/).length})
  `;
}

async function seedNotes(id: string, interviewId: string, transcriptId: string): Promise<void> {
  await poolSql`
    INSERT INTO public.interview_notes
      (id, tenant_id, interview_id, transcript_id, summary, key_points,
       topics_covered, questions_asked, follow_ups, model, prompt_version, generated_at)
    VALUES (${id}, ${T}, ${interviewId}, ${transcriptId}, ${NOTE_FIELDS.summary},
            ${JSON.stringify(NOTE_FIELDS.keyPoints)}::jsonb,
            ${JSON.stringify(NOTE_FIELDS.topicsCovered)}::jsonb,
            ${JSON.stringify(NOTE_FIELDS.questionsAsked)}::jsonb,
            ${JSON.stringify(NOTE_FIELDS.followUps)}::jsonb,
            'claude-test-model', 'n33b-v1', now())
  `;
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () => poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.transcript_outbox WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_notes WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_transcripts WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_recordings WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_recording_consents WHERE tenant_id = ${T}`,
    // Before the memberships it RESTRICT-FKs to.
    () => poolSql`DELETE FROM public.interview_panelists WHERE tenant_id = ${T}`,
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
      console.warn("N3.4b cleanup step failed (continuing):", err);
    }
  }
}

describe("N3.4b — transcript + notes read", () => {
  beforeAll(async () => {
    // Memberships FK to auth.users, so the ids have to be real ones.
    const [u1, u2, u3] = await poolSql<{ user_id: string }[]>`
      SELECT DISTINCT user_id FROM public.tenant_user_memberships ORDER BY user_id LIMIT 3
    `;
    const need = "need three distinct users to borrow ids from — run pnpm db:seed:test-users";
    assert.ok(u1, need);
    assert.ok(u2, need);
    assert.ok(u3, need);
    recruiterUserId = u1.user_id;
    panelOnUserId = u2.user_id;
    panelOffUserId = u3.user_id;

    await cleanup();

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings)
      VALUES (${T}, ${TENANT_SLUG}, ${`Notes Read Synth ${RUN}`}, 'ap-northeast-1', 'active',
              ${aiSettings(true)}::jsonb)
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, ${`N34B BU ${RUN}`}, ${`n34b-bu-${RUN}`})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEM_RECRUITER}, ${T}, ${recruiterUserId}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEM_PANEL_ON}, ${T}, ${panelOnUserId}, ARRAY['panel_member']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEM_PANEL_OFF}, ${T}, ${panelOffUserId}, ARRAY['panel_member']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, ${`N34B Backend Engineer ${RUN}`}, 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# N34B JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEM_RECRUITER}, ${MEM_RECRUITER}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PERSON}, ${T}, 'N34B Candidate', ${`n34b-cand-${RUN}@example.test`}, ${`n34b-cand-${RUN}@example.test`})
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

    const rounds = [
      [IV_READY, 1],
      [IV_OTHER_ROUND, 2],
      [IV_PURGED, 3],
      [IV_NO_RECORDING, 4],
      [IV_TRANSCRIPT_ONLY, 5],
    ] as const;
    for (const [id, round] of rounds) {
      await poolSql`
        INSERT INTO public.interviews
          (id, tenant_id, application_id, requisition_id, round_number, round_name,
           status, duration_minutes, mode, created_by_membership_id, recording_requested)
        VALUES (${id}, ${T}, ${APP}, ${REQ}, ${round}, ${`N34B Round ${round}`},
                'completed', 60, 'video', ${MEM_RECRUITER}, true)
      `;
    }

    // THE FIXTURE THE ACCESS TESTS TURN ON: MEM_PANEL_ON sits on the round
    // with the notes; MEM_PANEL_OFF sits on a DIFFERENT round of the SAME
    // requisition. Both are genuine panel members of this tenant, so only the
    // per-interview check can tell them apart.
    await poolSql`
      INSERT INTO public.interview_panelists (id, tenant_id, interview_id, membership_id, is_lead)
      VALUES (${randomUUID()}, ${T}, ${IV_READY}, ${MEM_PANEL_ON}, true),
             (${randomUUID()}, ${T}, ${IV_OTHER_ROUND}, ${MEM_PANEL_OFF}, true)
    `;

    await seedRecording(REC_READY, IV_READY, "transcribed", false);
    await seedTranscript(TR_READY, IV_READY, REC_READY);
    await seedNotes(NOTES_READY, IV_READY, TR_READY);

    // Retention ran: audio gone, transcript and notes retained. Status stays
    // 'transcribed' — purge is a separate axis, not a status.
    await seedRecording(REC_PURGED, IV_PURGED, "transcribed", true);
    await seedTranscript(TR_PURGED, IV_PURGED, REC_PURGED);
    await seedNotes(NOTES_PURGED, IV_PURGED, TR_PURGED);

    // Transcribed, no notes row — the "transcripts without notes" tenant.
    await seedRecording(REC_TRANSCRIPT_ONLY, IV_TRANSCRIPT_ONLY, "transcribed", false);
    await seedTranscript(TR_TRANSCRIPT_ONLY, IV_TRANSCRIPT_ONLY, REC_TRANSCRIPT_ONLY);
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: a panellist ON the interview can read its transcript and notes", async () => {
    const out = await caller(["panel_member"], panelOnUserId).getInterviewNotes({
      interviewId: IV_READY,
    });

    assert.equal(out.interviewId, IV_READY);
    assert.ok(out.transcript, "the panellist on the round must get the transcript");
    assert.ok(out.notes, "the panellist on the round must get the notes");
    assert.equal(out.notes.summary, NOTE_FIELDS.summary);
    assert.deepEqual(out.notes.keyPoints, NOTE_FIELDS.keyPoints);
    assert.equal(out.transcript.segments.length, SEGMENTS.length);
  });

  it("Test 2: a panellist NOT on the interview is FORBIDDEN", async () => {
    // MEM_PANEL_OFF is a real panel_member on round 2 of this very
    // requisition. The role gate alone would let them through; the
    // per-interview membership check is the only thing that stops them.
    const err = await expectThrows(
      () => caller(["panel_member"], panelOffUserId).getInterviewNotes({ interviewId: IV_READY }),
      "a panel member reading another round's transcript",
    );
    assert.match(messageOf(err), /not a panellist on this interview/i);

    // ...and their OWN round is still readable, so this is scoping, not a
    // broken panel path.
    const own = await caller(["panel_member"], panelOffUserId).getInterviewNotes({
      interviewId: IV_OTHER_ROUND,
    });
    assert.equal(own.interviewId, IV_OTHER_ROUND);
    assert.equal(own.transcript, null, "round 2 was never recorded");
  });

  it("Test 3: a recruiter can read, on role alone", async () => {
    // The recruiter is on nobody's panel. INTERVIEW_MANAGE_ROLES is what
    // carries them — running the round is its own reason to read the notes.
    const out = await caller(["recruiter"], recruiterUserId).getInterviewNotes({
      interviewId: IV_READY,
    });
    assert.ok(out.notes, "a recruiter must be able to read the notes");
    assert.ok(out.recording, "the recording state comes back with them");
    assert.equal(out.recording.status, "transcribed");

    // And a role outside BOTH sets is refused. hr_ops can action a consent
    // withdrawal (N2a) — that duty does not carry a reason to read what the
    // candidate said.
    const err = await expectThrows(
      () => caller(["hr_ops"], recruiterUserId).getInterviewNotes({ interviewId: IV_READY }),
      "hr_ops reading a transcript",
    );
    assert.match(messageOf(err), /don't have access to interview transcripts/i);
  });

  it("Test 4: the payload matches the card schemas, and carries no verdict", async () => {
    const out = await caller(["recruiter"], recruiterUserId).getInterviewNotes({
      interviewId: IV_READY,
    });

    // The whole envelope, then each card on its own — the cards are the
    // contract N3.3a defined and this ticket is what finally consumes them.
    getInterviewNotesOutputSchema.parse(out);
    const transcript = interviewTranscriptCardSchema.parse(out.transcript);
    const notes = interviewNotesCardSchema.parse(out.notes);

    assert.equal(transcript.provider, "local");
    assert.equal(transcript.providerModel, "local-asr-v1");
    assert.equal(transcript.language, "en");
    assert.equal(transcript.fullText, FULL_TEXT);
    // Speaker labels come back exactly as stored: anonymous, un-renamed.
    assert.deepEqual(
      transcript.segments.map((s) => s.speaker),
      ["speaker_0", "speaker_1", "speaker_0"],
    );

    // Provenance is on the wire, because a surface has to be able to say
    // "AI-generated, by this model, from this prompt revision".
    assert.equal(notes.model, "claude-test-model");
    assert.equal(notes.promptVersion, "n33b-v1");
    assert.ok(notes.generatedAt, "generatedAt must survive the read");
    assert.equal(notes.transcriptId, TR_READY, "notes must name the transcript they came from");

    // 0116's product stance, asserted rather than trusted: there is nowhere on
    // this wire shape to put a hire/no-hire signal, so nothing downstream can
    // render one next to the panellist's own recommendation.
    const asRecord = notes as unknown as Record<string, unknown>;
    for (const banned of [
      "score",
      "rating",
      "overallRating",
      "recommendation",
      "verdict",
      "sentiment",
    ]) {
      assert.ok(!(banned in asRecord), `interview notes must not expose "${banned}"`);
    }
  });

  it("Test 5: a purged recording returns the transcript WITH the purged marker", async () => {
    const out = await caller(["recruiter"], recruiterUserId).getInterviewNotes({
      interviewId: IV_PURGED,
    });

    // The audio is gone and the derived artefacts are not. That is retention
    // doing its job, so it is a normal payload — not a throw, and not an
    // empty one.
    assert.ok(out.recording, "the recording row survives the purge");
    assert.ok(out.recording.mediaPurgedAt, "media_purged_at must reach the surface");
    assert.equal(
      out.recording.status,
      "transcribed",
      "purge is a separate axis from status — it must not overwrite it",
    );
    assert.ok(out.transcript, "the transcript is retained past the audio");
    assert.ok(out.notes, "so are the notes derived from it");
  });

  it("Test 6: a round with no recording returns nulls, not a 404", async () => {
    const out = await caller(["recruiter"], recruiterUserId).getInterviewNotes({
      interviewId: IV_NO_RECORDING,
    });
    assert.equal(out.recording, null);
    assert.equal(out.transcript, null);
    assert.equal(out.notes, null);
    // The interview exists; only an interview that does not is NOT_FOUND.
    assert.equal(out.interviewId, IV_NO_RECORDING);

    const err = await expectThrows(
      () =>
        caller(["recruiter"], recruiterUserId).getInterviewNotes({
          interviewId: "00000000-0000-4000-8000-00000034bfff",
        }),
      "reading a nonexistent interview",
    );
    assert.ok(messageOf(err).length > 0, "a nonexistent interview must be refused");
  });

  it("Test 7: transcript kept, notes off for the tenant — and the wire says so", async () => {
    const before = await caller(["recruiter"], recruiterUserId).getInterviewNotes({
      interviewId: IV_TRANSCRIPT_ONLY,
    });
    assert.ok(before.transcript, "the transcript exists");
    assert.equal(before.notes, null, "no notes row was ever written for this round");
    assert.equal(before.notesEnabled, true, "the switch starts on");

    try {
      await setNotesEnabled(false);
      const after = await caller(["recruiter"], recruiterUserId).getInterviewNotes({
        interviewId: IV_TRANSCRIPT_ONLY,
      });
      // Same absent notes, different REASON. Without notesEnabled on the wire
      // a surface cannot tell "the tenant bought transcripts only" from "the
      // pipeline stalled", and would show the same blank box for both.
      assert.equal(after.notes, null);
      assert.equal(after.notesEnabled, false, "the tenant kill switch must reach the surface");
    } finally {
      await setNotesEnabled(true);
    }
  });
});
