/**
 * AI-INT-2 (N4.4) — the evidence drain against a real database.
 *
 * Companion to ai-interview-04a (the pure half). Drives
 * `drainAiInterviewEvidenceOnce` against seeded, already-submitted AI rounds,
 * with the LocalAIClient fixture tier (NODE_ENV=test) standing in for the
 * model. The fixture is keyed by a sha256 of (system + prompt + model +
 * schema), so beforeAll RECONSTRUCTS the exact prompt the drain will send —
 * via the same `assembleAnswers` + `toEvidencePromptQuestions` +
 * `buildAiInterviewEvidencePrompt` the drain uses — and writes the fixture at
 * that key. A prompt change shows up here as a fixture miss, not a silent pass.
 *
 * What each case protects:
 *
 *   1. A mixed round (one spoken answer recovered from the transcript, one
 *      typed, one unanswered) → 'done': the stored evidence validates against
 *      `aiInterviewEvidenceSchema`, the spoken answer carries its seek point,
 *      a FABRICATED quote the "model" returned is dropped and counted,
 *      provenance is stamped, and exactly one ai_usage_logs row exists under
 *      feature 'ai_interview_evidence' keyed to the evidence row.
 *   2. Kill switch off → 'skipped' / 'feature disabled', no usage row.
 *   3. Transcript still coming (outbox 'processing') → DEFERRED without spending an attempt and
 *      parked (not re-claimable on the next pass); once the transcript
 *      pipeline has FAILED the row proceeds, and with no usable text at all it
 *      lands 'skipped' with a deterministic report marking the spoken answer
 *      transcriptUnavailable — no model call.
 *   4. A model failure (fixture miss) is retried with backoff: back to
 *      'pending', one attempt spent, not immediately re-claimable.
 *   5. No score anywhere: ai_interview_evidence has no score / rating /
 *      recommendation column.
 *
 * Synthetic tenant (44b namespace, RUN-suffixed slugs/emails) via raw poolSql —
 * touches no demo data and needs no JWT. REQUIRES migrations 0116–0121.
 *
 * NOTE: the drain claims across tenants (it is a service-role worker), so a
 * pending evidence row left in the shared DB by something else could be
 * claimed by these passes. Assertions are therefore on THIS tenant's rows'
 * state rather than on the pass's aggregate counts.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import {
  AI_DEFAULT_MODEL,
  aiInterviewEvidenceSchema,
  type AiInterviewEvidence,
} from "@hireops/api-types";
import { hashStructuredOptions } from "@hireops/ai-client";
import { drainAiInterviewEvidenceOnce } from "../../../apps/workers/src/lib/ai-interview-evidence-drain.js";
import {
  assembleAnswers,
  coerceEvidenceAnswers,
} from "../../../apps/workers/src/lib/ai-interview-evidence-answers.js";
import {
  AI_INTERVIEW_EVIDENCE_FEATURE,
  AI_INTERVIEW_EVIDENCE_PROMPT_VERSION,
  AI_INTERVIEW_EVIDENCE_SCHEMA_NAME,
  aiInterviewEvidenceAiJsonSchema,
  buildAiInterviewEvidencePrompt,
  toEvidencePromptQuestions,
} from "../../../apps/workers/src/lib/ai-interview-evidence-prompt.js";

// Fixed synthetic ids (44b namespace — hex only).
const T = "00000000-0000-4000-8000-00000044b001";
const BU = "00000000-0000-4000-8000-00000044b002";
const POSITION = "00000000-0000-4000-8000-00000044b003";
const JD = "00000000-0000-4000-8000-00000044b004";
const REQ = "00000000-0000-4000-8000-00000044b005";
const PERSON = "00000000-0000-4000-8000-00000044b006";
const CANDIDATE = "00000000-0000-4000-8000-00000044b007";
const APP = "00000000-0000-4000-8000-00000044b008";
const MEMBERSHIP = "00000000-0000-4000-8000-00000044b009";

const IV_MIXED = "00000000-0000-4000-8000-00000044b010";
const IV_OFF = "00000000-0000-4000-8000-00000044b011";
const IV_WAIT = "00000000-0000-4000-8000-00000044b012";
const IV_RETRY = "00000000-0000-4000-8000-00000044b013";

const REC_MIXED = "00000000-0000-4000-8000-00000044b020";
const REC_WAIT = "00000000-0000-4000-8000-00000044b021";

const RUN = Date.now().toString(36);

/** Index into an array, failing loudly instead of a non-null assertion. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected an element at index ${i}`);
  return v;
}

const drainLog = createLogger({ base: { service: "n44-evidence-test" } });

const RUBRIC = [
  { key: "role_competence", label: "Role competence" },
  { key: "problem_solving", label: "Problem solving" },
  { key: "communication", label: "Communication" },
];
const QUESTIONS = [
  { key: "q1", prompt: "Walk me through an escalation you owned.", rubricKey: "role_competence" },
  {
    key: "q2",
    prompt: "Describe a problem where the obvious fix was wrong.",
    rubricKey: "problem_solving",
  },
  {
    key: "q3",
    prompt: "Tell me about explaining an outage to a customer.",
    rubricKey: "communication",
  },
];
const KNOCKOUTS = ["Do you hold a valid work permit for India?", "Can you work UK hours?"];

const SEGMENTS = [
  {
    speaker: "speaker_0",
    startMs: 500,
    endMs: 4_000,
    text: "I owned the escalation bridge for the billing outage.",
  },
  {
    speaker: "speaker_0",
    startMs: 4_000,
    endMs: 9_000,
    text: "First I paged the database on-call and froze deploys.",
  },
  // Outside every voice window — must not leak into q1.
  {
    speaker: "speaker_0",
    startMs: 12_000,
    endMs: 15_000,
    text: "Unrelated room noise transcribed.",
  },
];
const Q2_TYPED =
  "The obvious fix was restarting the queue, but the real cause was a clock skew. I have a work permit for India.";

const TURN_MIXED = {
  version: 1,
  answers: [
    {
      questionKey: "q1",
      mode: "voice",
      answeredAt: "2026-09-29T10:00:00.000Z",
      startMs: 0,
      endMs: 10_000,
      text: null,
    },
    {
      questionKey: "q2",
      mode: "typed",
      answeredAt: "2026-09-29T10:02:00.000Z",
      startMs: null,
      endMs: null,
      text: Q2_TYPED,
    },
  ],
  mediaSizeBytes: 2048,
  mediaContentType: "audio/webm",
};
const TURN_TYPED = {
  version: 1,
  answers: [
    {
      questionKey: "q1",
      mode: "typed",
      answeredAt: "2026-09-29T10:00:00.000Z",
      startMs: null,
      endMs: null,
      text: "I ran the incident call.",
    },
  ],
  mediaSizeBytes: null,
  mediaContentType: null,
};
/** A different answer from TURN_TYPED, so its prompt has NO fixture — case 4. */
const TURN_RETRY = {
  ...TURN_TYPED,
  answers: [{ ...at(TURN_TYPED.answers, 0), text: "No fixture exists for this answer." }],
};
const TURN_VOICE_ONLY = {
  version: 1,
  answers: [
    {
      questionKey: "q1",
      mode: "voice",
      answeredAt: "2026-09-29T10:00:00.000Z",
      startMs: 0,
      endMs: 5_000,
      text: null,
    },
  ],
  mediaSizeBytes: 1024,
  mediaContentType: "audio/webm",
};

/**
 * What the "model" returns for the mixed round. One quote is FABRICATED (not
 * in the answer) — the drain must drop it. Note what is NOT here: no score,
 * rating or recommendation.
 */
const EVIDENCE_JSON = {
  questions: [
    {
      questionKey: "q1",
      relevance: "addresses",
      relevanceNote: "Describes owning an escalation bridge and the first actions taken.",
      rubric: [
        {
          rubricKey: "role_competence",
          coverage: "covered",
          note: "Names the first steps: paging on-call and freezing deploys.",
          quotes: [
            "First I paged the database on-call and froze deploys.",
            "I personally rewrote the billing service overnight.", // fabricated
          ],
        },
      ],
    },
    {
      questionKey: "q2",
      relevance: "addresses",
      relevanceNote: "Contrasts the obvious fix with the root cause found.",
      rubric: [
        {
          rubricKey: "problem_solving",
          coverage: "covered",
          note: "Identifies clock skew as the real cause.",
          quotes: ["the real cause was a clock skew"],
        },
      ],
    },
  ],
  knockouts: [
    {
      question: at(KNOCKOUTS, 0),
      status: "confirmed",
      quote: "I have a work permit for India.",
      questionKey: "q2",
    },
    { question: at(KNOCKOUTS, 1), status: "not_mentioned", quote: null, questionKey: null },
  ],
  summary:
    "The answers covered an escalation's first steps and a root-cause investigation. No answer spoke to communication with a customer.",
};

const here = dirname(fileURLToPath(import.meta.url));
const AI_FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");
const writtenFixtures: string[] = [];

interface EvidenceRow {
  id: string;
  status: string;
  attempt_count: number;
  lease_expires_at: Date | string | null;
  last_error: string | null;
  evidence: unknown;
  model: string | null;
  prompt_version: string | null;
  generated_at: Date | string | null;
}

function ms(v: Date | string | null): number | null {
  if (v === null) return null;
  return (v instanceof Date ? v : new Date(v)).getTime();
}

async function sessionIdFor(interviewId: string): Promise<string> {
  const [row] = await poolSql<{ id: string }[]>`
    SELECT id FROM public.ai_interview_sessions WHERE tenant_id = ${T} AND interview_id = ${interviewId}
  `;
  assert.ok(row, `no session for ${interviewId}`);
  return row.id;
}

/** Enqueue exactly as submitSession does. */
async function enqueueEvidence(interviewId: string): Promise<string> {
  const sessionId = await sessionIdFor(interviewId);
  const [row] = await poolSql<{ id: string }[]>`
    INSERT INTO public.ai_interview_evidence (tenant_id, session_id, interview_id, status)
    VALUES (${T}, ${sessionId}, ${interviewId}, 'pending')
    RETURNING id
  `;
  assert.ok(row, "evidence insert returned no row");
  return row.id;
}

async function evidenceRow(id: string): Promise<EvidenceRow> {
  const [row] = await poolSql<EvidenceRow[]>`
    SELECT id, status, attempt_count, lease_expires_at, last_error, evidence, model,
           prompt_version, generated_at
    FROM public.ai_interview_evidence WHERE id = ${id}
  `;
  assert.ok(row, `ai_interview_evidence ${id} disappeared`);
  return row;
}

async function usageCount(evidenceId: string): Promise<number> {
  const [row] = await poolSql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM public.ai_usage_logs
    WHERE tenant_id = ${T} AND feature = ${AI_INTERVIEW_EVIDENCE_FEATURE}
      AND request_id = ${evidenceId}
  `;
  return row?.n ?? 0;
}

async function setEvidenceEnabled(enabled: boolean): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = ${JSON.stringify({ aiSettings: { ai_interview_evidence: { enabled } } })}::jsonb
    WHERE id = ${T}
  `;
}

async function primeFixture(turnState: unknown, segments: typeof SEGMENTS | null, json: unknown) {
  const assembled = assembleAnswers({
    questions: QUESTIONS,
    answers: coerceEvidenceAnswers(turnState),
    segments,
    rubric: RUBRIC,
  });
  const built = buildAiInterviewEvidencePrompt({
    questions: toEvidencePromptQuestions(assembled),
    rubric: RUBRIC,
    competencyFocus: [],
    knockouts: KNOCKOUTS,
  });
  const hash = hashStructuredOptions({
    system: built.system,
    prompt: built.user,
    model: AI_DEFAULT_MODEL,
    schema: aiInterviewEvidenceAiJsonSchema,
    schemaName: AI_INTERVIEW_EVIDENCE_SCHEMA_NAME,
    feature: AI_INTERVIEW_EVIDENCE_FEATURE,
  });
  await mkdir(AI_FIXTURE_DIR, { recursive: true });
  const path = resolve(AI_FIXTURE_DIR, `${hash}.json`);
  await writeFile(
    path,
    JSON.stringify({
      json,
      inputTokens: 2100,
      outputTokens: 480,
      costMicros: 13500,
      latencyMs: 700,
    }),
  );
  writtenFixtures.push(path);
}

async function seedSubmittedSession(interviewId: string, turnState: unknown): Promise<void> {
  await poolSql`
    INSERT INTO public.ai_interview_sessions
      (tenant_id, interview_id, status, questions, approved_by_membership_id, approved_at,
       questions_frozen_at, link_token_hash, started_at, submitted_at, turn_state,
       model, prompt_version)
    VALUES (${T}, ${interviewId}, 'submitted', ${JSON.stringify(QUESTIONS)}::jsonb,
            ${MEMBERSHIP}, now(), now(), ${`n44b-${RUN}-${interviewId}`}, now(), now(),
            ${JSON.stringify(turnState)}::jsonb, 'local-test', 'n42-v1')
  `;
}

async function seedRecording(
  recordingId: string,
  interviewId: string,
  status: string,
  outboxStatus: string,
): Promise<void> {
  await poolSql`
    INSERT INTO public.interview_recordings
      (id, tenant_id, interview_id, source, status, storage_key, media_type,
       duration_seconds, size_bytes, requested_by_membership_id, uploaded_at)
    VALUES (${recordingId}, ${T}, ${interviewId}, 'ai_interview', ${status},
            ${`n44b/${RUN}/${recordingId}.webm`}, 'audio/webm', 30, 2048, ${MEMBERSHIP}, now())
  `;
  await poolSql`
    INSERT INTO public.transcript_outbox (tenant_id, recording_id, status, claimed_by, claimed_at)
    VALUES (${T}, ${recordingId}, ${outboxStatus},
            ${outboxStatus === "processing" ? "n44b-test" : null},
            ${outboxStatus === "processing" ? new Date().toISOString() : null}::timestamptz)
  `;
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () => poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.ai_interview_evidence WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.transcript_outbox WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_transcripts WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.ai_interview_sessions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_recordings WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interviews WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.requisition_knockouts WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenants WHERE id = ${T}`,
    () => poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("N4.4 cleanup step failed (continuing):", err);
    }
  }
}

describe("AI-INT-2 — the AI interview evidence drain", () => {
  beforeAll(async () => {
    const [existing] = await poolSql<{ user_id: string }[]>`
      SELECT user_id FROM public.tenant_user_memberships LIMIT 1
    `;
    assert.ok(existing, "no tenant_user_memberships row to borrow a user_id from");
    const userId = existing.user_id;

    await cleanup();

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${T}, ${`synth-n44b-${RUN}`}, ${`AI Evidence Synth ${RUN}`}, 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, ${`N44B BU ${RUN}`}, ${`n44b-bu-${RUN}`})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${userId}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, ${`N44B Support Engineer ${RUN}`}, 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# N44B JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted')
    `;
    for (const [i, text] of KNOCKOUTS.entries()) {
      await poolSql`
        INSERT INTO public.requisition_knockouts
          (tenant_id, requisition_id, question_text, type, threshold_value, source, order_index)
        VALUES (${T}, ${REQ}, ${text}, 'boolean', ${JSON.stringify({ equals: true })}::jsonb,
                'candidate_asserted', ${i})
      `;
    }
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PERSON}, ${T}, 'N44B Candidate', ${`n44b-cand-${RUN}@example.test`}, ${`n44b-cand-${RUN}@example.test`})
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
      [IV_MIXED, 1, TURN_MIXED],
      [IV_OFF, 2, TURN_TYPED],
      [IV_WAIT, 3, TURN_VOICE_ONLY],
      [IV_RETRY, 4, TURN_RETRY],
    ] as const;
    for (const [id, round, turn] of rounds) {
      // No interview_plans row: competency focus renders as "not specified".
      await poolSql`
        INSERT INTO public.interviews
          (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
           scorecard_template, scorecard_criteria_snapshot, duration_minutes, mode,
           created_by_membership_id, recording_requested)
        VALUES (${id}, ${T}, ${APP}, ${REQ}, ${round}, ${`N44B Round ${round}`}, 'scheduled',
                'general', ${JSON.stringify(RUBRIC)}::jsonb, 30, 'ai_async', ${MEMBERSHIP}, false)
      `;
      await seedSubmittedSession(id, turn);
    }

    // The mixed round's transcript has landed.
    await seedRecording(REC_MIXED, IV_MIXED, "transcribed", "completed");
    await poolSql`
      INSERT INTO public.interview_transcripts
        (tenant_id, interview_id, recording_id, segments, full_text, language, provider,
         provider_model, word_count)
      VALUES (${T}, ${IV_MIXED}, ${REC_MIXED}, ${JSON.stringify(SEGMENTS)}::jsonb,
              ${SEGMENTS.map((s) => s.text).join(" ")}, 'en', 'local', 'local-fixture', 30)
    `;
    // The waiting round's transcript is still in flight. 'processing' with a
    // fresh claim rather than 'pending': a transcript drain deployed against the
    // shared DB would claim a 'pending' row (and fail it — the media does not
    // exist), while a fresh 'processing' claim is left alone for the 45-minute
    // orphan window. Both statuses take the same "defer" branch.
    await seedRecording(REC_WAIT, IV_WAIT, "transcribing", "processing");

    await primeFixture(TURN_MIXED, SEGMENTS, EVIDENCE_JSON);
  });

  afterAll(async () => {
    for (const path of writtenFixtures) await unlink(path).catch(() => undefined);
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: a mixed round → verified evidence, provenance, one usage row", async () => {
    const id = await enqueueEvidence(IV_MIXED);
    await drainAiInterviewEvidenceOnce({ log: drainLog, batchSize: 10 });

    const row = await evidenceRow(id);
    assert.equal(row.status, "done", `expected done, got ${row.status}: ${row.last_error}`);
    assert.equal(row.attempt_count, 1);
    assert.equal(row.lease_expires_at, null);
    assert.equal(row.last_error, null);
    assert.equal(row.model, AI_DEFAULT_MODEL);
    assert.equal(row.prompt_version, AI_INTERVIEW_EVIDENCE_PROMPT_VERSION);
    assert.ok(row.generated_at);

    const ev: AiInterviewEvidence = aiInterviewEvidenceSchema.parse(row.evidence);
    assert.equal(ev.version, 1);
    assert.deepEqual(
      ev.questions.map((q) => q.questionKey),
      ["q1", "q2", "q3"],
    );

    const q1 = at(ev.questions, 0);
    const q2 = at(ev.questions, 1);
    const q3 = at(ev.questions, 2);
    assert.equal(q1.answerMode, "voice");
    assert.equal(q1.answerStartMs, 500, "seek point = first overlapping segment");
    assert.equal(q1.transcriptUnavailable, false);
    assert.deepEqual(
      at(q1.rubric, 0).quotes,
      ["First I paged the database on-call and froze deploys."],
      "the fabricated quote is dropped; the verbatim one stays",
    );
    assert.equal(q2.answerMode, "typed");
    assert.equal(q2.answerStartMs, null);
    assert.deepEqual(at(q2.rubric, 0).quotes, ["the real cause was a clock skew"]);
    assert.equal(q3.relevance, "no_answer");
    assert.equal(q3.answerMode, null);

    assert.deepEqual(
      ev.knockouts.map((k) => [k.question, k.status, k.quote, k.questionKey]),
      [
        [KNOCKOUTS[0], "confirmed", "I have a work permit for India.", "q2"],
        [KNOCKOUTS[1], "not_mentioned", null, null],
      ],
    );
    assert.deepEqual(ev.meta, { quotesDropped: 1, answeredCount: 2, questionCount: 3 });

    assert.equal(await usageCount(id), 1, "exactly one evidence call, logged under its feature");
  });

  it("Test 2: kill switch off → skipped, no model call, no usage row", async () => {
    await setEvidenceEnabled(false);
    try {
      const id = await enqueueEvidence(IV_OFF);
      await drainAiInterviewEvidenceOnce({ log: drainLog, batchSize: 10 });
      const row = await evidenceRow(id);
      assert.equal(row.status, "skipped");
      assert.equal(row.last_error, "feature disabled");
      assert.equal(row.evidence, null);
      assert.equal(await usageCount(id), 0, "a disabled feature must not reach the model");
    } finally {
      await setEvidenceEnabled(true);
    }
  });

  it("Test 3: transcript in flight → deferred (no attempt spent, parked); failed → proceeds", async () => {
    const id = await enqueueEvidence(IV_WAIT);
    await drainAiInterviewEvidenceOnce({ log: drainLog, batchSize: 10 });

    let row = await evidenceRow(id);
    assert.equal(row.status, "pending");
    assert.equal(row.attempt_count, 0, "waiting is not an attempt");
    assert.ok(row.last_error?.includes("waiting for transcript"));
    const parkedUntil = ms(row.lease_expires_at);
    assert.ok(parkedUntil && parkedUntil > Date.now() + 60_000, "parked ~2 minutes out");

    // An immediate second pass must not pick it up again.
    await drainAiInterviewEvidenceOnce({ log: drainLog, batchSize: 10 });
    row = await evidenceRow(id);
    assert.equal(row.status, "pending");
    assert.equal(ms(row.lease_expires_at), parkedUntil, "the parked row was not re-claimed");

    // The transcript pipeline gives up; un-park the row.
    await poolSql`
      UPDATE public.transcript_outbox SET status = 'failed', last_error = 'n44b: vendor gave up'
      WHERE tenant_id = ${T} AND recording_id = ${REC_WAIT}
    `;
    await poolSql`
      UPDATE public.ai_interview_evidence SET lease_expires_at = now() - interval '1 second'
      WHERE id = ${id}
    `;
    await drainAiInterviewEvidenceOnce({ log: drainLog, batchSize: 10 });

    row = await evidenceRow(id);
    assert.equal(row.status, "skipped", "the only answer was spoken and has no words");
    assert.ok(row.last_error?.includes("no usable answer text"));
    assert.equal(row.model, null, "no model was called");
    assert.equal(await usageCount(id), 0);
    const ev = aiInterviewEvidenceSchema.parse(row.evidence);
    assert.equal(at(ev.questions, 0).transcriptUnavailable, true);
    assert.equal(at(ev.questions, 0).relevance, "no_answer");
    assert.match(at(ev.questions, 0).relevanceNote, /transcript .* unavailable/);
    assert.equal(ev.meta.answeredCount, 0);
    assert.deepEqual(
      ev.knockouts.map((k) => k.status),
      ["not_mentioned", "not_mentioned"],
    );
  });

  it("Test 4: a model failure is retried with backoff, one attempt spent", async () => {
    const id = await enqueueEvidence(IV_RETRY);
    await drainAiInterviewEvidenceOnce({ log: drainLog, batchSize: 10 });

    const row = await evidenceRow(id);
    assert.equal(row.status, "pending", `expected retry, got ${row.status}: ${row.last_error}`);
    assert.equal(row.attempt_count, 1);
    assert.ok(row.last_error, "the failure is recorded");
    const notBefore = ms(row.lease_expires_at);
    assert.ok(notBefore && notBefore > Date.now(), "backoff: not immediately re-claimable");

    await drainAiInterviewEvidenceOnce({ log: drainLog, batchSize: 10 });
    assert.equal((await evidenceRow(id)).attempt_count, 1, "not re-claimed inside the backoff");
  });

  it("Test 5: no score anywhere in the table", async () => {
    const columns = await poolSql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_interview_evidence'
    `;
    const offenders = columns
      .map((c) => c.column_name)
      .filter((n) => /score|rating|rank|recommend|verdict|pass|sentiment/i.test(n));
    assert.deepEqual(offenders, []);
  });
});
