/**
 * AI-INT-3 — the recruiter's evidence review: `getEvidence` (behind
 * getAiInterviewEvidence) and `regenerateEvidence` (behind
 * regenerateAiInterviewEvidence), against a real database.
 *
 * Calls the lib directly (the 04b technique): the router wrappers are a role
 * gate + withAudit around these two functions, and the lib is where the
 * tenant predicate, the answer assembly and the reset live.
 *
 * Evidence rows are SEEDED DIRECTLY in their terminal state ('done' /
 * 'failed') rather than produced by the drain: a deployed worker drains the
 * shared test DB and would race a 'pending' row. The one place a row goes
 * back to 'pending' (the regenerate case) asserts tolerantly for the same
 * reason — see Test 4.
 *
 *   1. done → shape: the stored report round-trips, provenance is on the
 *      wire, lastError is null, and the answers are the DRAIN'S answers (voice
 *      = the transcript slice with its seek point; typed = as typed;
 *      unanswered = null). The PII-read callback fires with the candidate.
 *      No score / rating / recommendation anywhere in the payload.
 *   2. no row → 'none', answers still returned; a non-submitted session →
 *      'none' with NO answers.
 *   3. tenant isolation: another tenant's id cannot read or regenerate this
 *      tenant's interview (NOT_FOUND), and the row is left untouched.
 *   4. failed → the raw error never reaches the wire; regenerate resets the
 *      row (attempt_count 0, no lease, no error); a missing row is inserted.
 *   5. regenerate refuses a non-submitted round (CONFLICT) and a disabled
 *      kill switch (BAD_REQUEST with the admin hint).
 *
 * Synthetic tenant (44c namespace, RUN-suffixed slugs/emails) via raw poolSql.
 * REQUIRES migrations 0116–0121.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { aiInterviewEvidenceSchema, type AiInterviewEvidence } from "@hireops/api-types";
import { getEvidence, regenerateEvidence } from "../src/lib/ai-interview-evidence-read";

const T = "00000000-0000-4000-8000-00000044c001";
const BU = "00000000-0000-4000-8000-00000044c002";
const POSITION = "00000000-0000-4000-8000-00000044c003";
const JD = "00000000-0000-4000-8000-00000044c004";
const REQ = "00000000-0000-4000-8000-00000044c005";
const PERSON = "00000000-0000-4000-8000-00000044c006";
const CANDIDATE = "00000000-0000-4000-8000-00000044c007";
const APP = "00000000-0000-4000-8000-00000044c008";
const MEMBERSHIP = "00000000-0000-4000-8000-00000044c009";
/** Never inserted — a tenant id that is simply not T. */
const OTHER_TENANT = "00000000-0000-4000-8000-00000044c0ff";

const IV_DONE = "00000000-0000-4000-8000-00000044c010";
const IV_NONE = "00000000-0000-4000-8000-00000044c011";
const IV_FAILED = "00000000-0000-4000-8000-00000044c012";
const IV_ISSUED = "00000000-0000-4000-8000-00000044c013";
const REC_DONE = "00000000-0000-4000-8000-00000044c020";

const RUN = Date.now().toString(36);

function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected an element at index ${i}`);
  return v;
}

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
  { speaker: "speaker_0", startMs: 12_000, endMs: 15_000, text: "Unrelated room noise." },
];
const Q2_TYPED = "The obvious fix was restarting the queue, but the real cause was a clock skew.";
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

const EVIDENCE: AiInterviewEvidence = {
  version: 1,
  questions: [
    {
      questionKey: "q1",
      answerMode: "voice",
      answerStartMs: 500,
      transcriptUnavailable: false,
      relevance: "addresses",
      relevanceNote: "Describes owning an escalation bridge and the first actions taken.",
      rubric: [
        {
          rubricKey: "role_competence",
          coverage: "covered",
          note: "Names the first steps: paging on-call and freezing deploys.",
          quotes: ["First I paged the database on-call and froze deploys."],
        },
      ],
    },
    {
      questionKey: "q2",
      answerMode: "typed",
      answerStartMs: null,
      transcriptUnavailable: false,
      relevance: "partially_addresses",
      relevanceNote: "Names the root cause; does not describe how it was found.",
      rubric: [
        {
          rubricKey: "problem_solving",
          coverage: "partial",
          note: "Identifies clock skew as the cause.",
          quotes: ["the real cause was a clock skew"],
        },
      ],
    },
    {
      questionKey: "q3",
      answerMode: null,
      answerStartMs: null,
      transcriptUnavailable: false,
      relevance: "no_answer",
      relevanceNote: "",
      rubric: [],
    },
  ],
  knockouts: [
    {
      question: "Do you hold a valid work permit for India?",
      status: "not_mentioned",
      quote: null,
      questionKey: null,
    },
  ],
  summary: "The answers covered an escalation's first steps and a root cause.",
  meta: { quotesDropped: 1, answeredCount: 2, questionCount: 3 },
};

async function sessionIdFor(interviewId: string): Promise<string> {
  const [row] = await poolSql<{ id: string }[]>`
    SELECT id FROM public.ai_interview_sessions WHERE tenant_id = ${T} AND interview_id = ${interviewId}
  `;
  assert.ok(row, `no session for ${interviewId}`);
  return row.id;
}

interface EvidenceRow {
  status: string;
  attempt_count: number;
  lease_expires_at: Date | string | null;
  last_error: string | null;
}

async function evidenceRowFor(interviewId: string): Promise<EvidenceRow | null> {
  const [row] = await poolSql<EvidenceRow[]>`
    SELECT status, attempt_count, lease_expires_at, last_error
    FROM public.ai_interview_evidence WHERE tenant_id = ${T} AND interview_id = ${interviewId}
  `;
  return row ?? null;
}

async function setEvidenceEnabled(enabled: boolean): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = ${JSON.stringify({ aiSettings: { ai_interview_evidence: { enabled } } })}::jsonb
    WHERE id = ${T}
  `;
}

async function expectTrpcError(p: Promise<unknown>, code: TRPCError["code"]): Promise<TRPCError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof TRPCError, `expected TRPCError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return err;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () => poolSql`DELETE FROM public.ai_interview_evidence WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_transcripts WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.ai_interview_sessions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_recordings WHERE tenant_id = ${T}`,
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
    () => poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenants WHERE id = ${T}`,
    () => poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("AI-INT-3 cleanup step failed (continuing):", err);
    }
  }
}

describe("AI-INT-3 — the recruiter's AI interview evidence review", () => {
  beforeAll(async () => {
    const [existing] = await poolSql<{ user_id: string }[]>`
      SELECT user_id FROM public.tenant_user_memberships LIMIT 1
    `;
    assert.ok(existing, "no tenant_user_memberships row to borrow a user_id from");
    const userId = existing.user_id;

    await cleanup();

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${T}, ${`synth-n44c-${RUN}`}, ${`AI Evidence Review Synth ${RUN}`}, 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, ${`N44C BU ${RUN}`}, ${`n44c-bu-${RUN}`})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${userId}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, ${`N44C Support Engineer ${RUN}`}, 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# N44C JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PERSON}, ${T}, 'N44C Candidate', ${`n44c-cand-${RUN}@example.test`}, ${`n44c-cand-${RUN}@example.test`})
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
      [IV_DONE, 1, "submitted", TURN_MIXED],
      [IV_NONE, 2, "submitted", TURN_TYPED],
      [IV_FAILED, 3, "submitted", TURN_TYPED],
      [IV_ISSUED, 4, "issued", { version: 1, answers: [] }],
    ] as const;
    for (const [id, round, status, turn] of rounds) {
      await poolSql`
        INSERT INTO public.interviews
          (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
           scorecard_template, scorecard_criteria_snapshot, duration_minutes, mode,
           created_by_membership_id, recording_requested)
        VALUES (${id}, ${T}, ${APP}, ${REQ}, ${round}, ${`N44C Round ${round}`}, 'scheduled',
                'general', ${JSON.stringify(RUBRIC)}::jsonb, 30, 'ai_async', ${MEMBERSHIP}, false)
      `;
      await poolSql`
        INSERT INTO public.ai_interview_sessions
          (tenant_id, interview_id, status, questions, approved_by_membership_id, approved_at,
           questions_frozen_at, link_token_hash, started_at, submitted_at, turn_state,
           model, prompt_version)
        VALUES (${T}, ${id}, ${status}, ${JSON.stringify(QUESTIONS)}::jsonb,
                ${MEMBERSHIP}, now(), now(), ${`n44c-${RUN}-${id}`},
                ${status === "submitted" ? new Date().toISOString() : null}::timestamptz,
                ${status === "submitted" ? new Date().toISOString() : null}::timestamptz,
                ${JSON.stringify(turn)}::jsonb, 'local-test', 'n42-v1')
      `;
    }

    // The done round's transcript. A 'transcribed' recording with no outbox
    // row: nothing here is pending, so no deployed drain has work to claim.
    await poolSql`
      INSERT INTO public.interview_recordings
        (id, tenant_id, interview_id, source, status, storage_key, media_type,
         duration_seconds, size_bytes, requested_by_membership_id, uploaded_at)
      VALUES (${REC_DONE}, ${T}, ${IV_DONE}, 'ai_interview', 'transcribed',
              ${`n44c/${RUN}/${REC_DONE}.webm`}, 'audio/webm', 30, 2048, ${MEMBERSHIP}, now())
    `;
    await poolSql`
      INSERT INTO public.interview_transcripts
        (tenant_id, interview_id, recording_id, segments, full_text, language, provider,
         provider_model, word_count)
      VALUES (${T}, ${IV_DONE}, ${REC_DONE}, ${JSON.stringify(SEGMENTS)}::jsonb,
              ${SEGMENTS.map((s) => s.text).join(" ")}, 'en', 'local', 'local-fixture', 30)
    `;

    // Evidence rows seeded directly in TERMINAL states (see header).
    await poolSql`
      INSERT INTO public.ai_interview_evidence
        (tenant_id, session_id, interview_id, status, attempt_count, evidence, model,
         prompt_version, generated_at)
      VALUES (${T}, ${await sessionIdFor(IV_DONE)}, ${IV_DONE}, 'done', 1,
              ${JSON.stringify(EVIDENCE)}::jsonb, 'claude-test-model', 'n44-v1', now())
    `;
    await poolSql`
      INSERT INTO public.ai_interview_evidence
        (tenant_id, session_id, interview_id, status, attempt_count, last_error)
      VALUES (${T}, ${await sessionIdFor(IV_FAILED)}, ${IV_FAILED}, 'failed', 3,
              'provider 529: internal upstream detail req_abc123')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: a done report → stored evidence, provenance, the drain's answers", async () => {
    const piiReads: string[] = [];
    const out = await getEvidence(poolSql, {
      tenantId: T,
      interviewId: IV_DONE,
      onPiiRead: (id) => piiReads.push(id),
    });

    assert.equal(out.status, "done");
    assert.ok(out.evidence);
    assert.deepEqual(aiInterviewEvidenceSchema.parse(out.evidence), EVIDENCE);
    assert.equal(out.model, "claude-test-model");
    assert.equal(out.promptVersion, "n44-v1");
    assert.ok(out.generatedAt && !Number.isNaN(Date.parse(out.generatedAt)));
    assert.equal(out.lastError, null);

    assert.deepEqual(
      out.answers.map((a) => a.questionKey),
      ["q1", "q2", "q3"],
    );
    const q1 = at(out.answers, 0);
    assert.equal(q1.mode, "voice");
    assert.equal(q1.prompt, at(QUESTIONS, 0).prompt);
    assert.equal(q1.rubricKey, "role_competence");
    assert.equal(
      q1.text,
      "I owned the escalation bridge for the billing outage. First I paged the database on-call and froze deploys.",
      "voice answer = overlapping transcript segments, noise outside the window excluded",
    );
    assert.equal(q1.answerStartMs, 500);
    assert.equal(q1.transcriptUnavailable, false);
    const q2 = at(out.answers, 1);
    assert.equal(q2.mode, "typed");
    assert.equal(q2.text, Q2_TYPED);
    assert.equal(q2.answerStartMs, null);
    const q3 = at(out.answers, 2);
    assert.equal(q3.mode, null);
    assert.equal(q3.text, null);

    // Every stored quote is a substring of the answer shown beside it.
    for (const qe of out.evidence.questions) {
      const text = out.answers.find((a) => a.questionKey === qe.questionKey)?.text ?? "";
      for (const r of qe.rubric) for (const quote of r.quotes) assert.ok(text.includes(quote));
    }

    assert.deepEqual(piiReads, [CANDIDATE], "the PII read is reported once, for the candidate");

    // Evidence only — no verdict-shaped key anywhere on the wire.
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) {
          keys.add(k.toLowerCase());
          walk(child);
        }
      }
    };
    walk(out);
    for (const k of keys) {
      assert.ok(
        !/score|rating|rank|recommend|pass|fail|hire|verdict/.test(k),
        `unexpected verdict-shaped key on the wire: ${k}`,
      );
    }
  });

  it("Test 2: no evidence row → 'none'; a non-submitted session → 'none' with no answers", async () => {
    const none = await getEvidence(poolSql, { tenantId: T, interviewId: IV_NONE });
    assert.equal(none.status, "none");
    assert.equal(none.evidence, null);
    assert.equal(none.model, null);
    assert.equal(none.lastError, null);
    assert.equal(at(none.answers, 0).text, "I ran the incident call.");

    const piiReads: string[] = [];
    const issued = await getEvidence(poolSql, {
      tenantId: T,
      interviewId: IV_ISSUED,
      onPiiRead: (id) => piiReads.push(id),
    });
    assert.equal(issued.status, "none");
    assert.deepEqual(issued.answers, []);
    assert.deepEqual(piiReads, [], "no answers returned → no PII read recorded");
  });

  it("Test 3: another tenant cannot read or regenerate this tenant's evidence", async () => {
    await expectTrpcError(
      getEvidence(poolSql, { tenantId: OTHER_TENANT, interviewId: IV_DONE }),
      "NOT_FOUND",
    );
    await expectTrpcError(
      regenerateEvidence(poolSql, { tenantId: OTHER_TENANT, interviewId: IV_FAILED }),
      "NOT_FOUND",
    );
    const row = await evidenceRowFor(IV_FAILED);
    assert.ok(row);
    assert.equal(row.status, "failed", "a cross-tenant regenerate must not touch the row");
    assert.equal(row.attempt_count, 3);
  });

  it("Test 4: failed → safe error on the wire; regenerate resets it; a missing row is inserted", async () => {
    const before = await getEvidence(poolSql, { tenantId: T, interviewId: IV_FAILED });
    assert.equal(before.status, "failed");
    assert.equal(before.lastError, "The evidence report could not be generated.");
    assert.ok(!JSON.stringify(before).includes("req_abc123"), "raw error must not leak");

    const res = await regenerateEvidence(poolSql, { tenantId: T, interviewId: IV_FAILED });
    assert.equal(res.status, "pending");
    const row = await evidenceRowFor(IV_FAILED);
    assert.ok(row);
    // A deployed drain may claim the row between the reset and this read, so
    // accept 'pending' with a clean slate, or a FRESH claim of it — never the
    // seeded failure (attempt 3, the original error).
    if (row.status === "pending") {
      assert.equal(row.attempt_count, 0);
      assert.equal(row.lease_expires_at, null);
      assert.equal(row.last_error, null);
    } else {
      assert.ok(row.attempt_count < 3, `row not reset: ${row.status}/${row.attempt_count}`);
      assert.notEqual(row.last_error, "provider 529: internal upstream detail req_abc123");
    }

    assert.equal(await evidenceRowFor(IV_NONE), null);
    const inserted = await regenerateEvidence(poolSql, { tenantId: T, interviewId: IV_NONE });
    assert.equal(inserted.status, "pending");
    const newRow = await evidenceRowFor(IV_NONE);
    assert.ok(newRow, "regenerate inserts the missing evidence row");
  });

  it("Test 5: regenerate refuses a non-submitted round, and a disabled kill switch", async () => {
    await expectTrpcError(
      regenerateEvidence(poolSql, { tenantId: T, interviewId: IV_ISSUED }),
      "CONFLICT",
    );
    assert.equal(await evidenceRowFor(IV_ISSUED), null);

    await setEvidenceEnabled(false);
    try {
      const err = await expectTrpcError(
        regenerateEvidence(poolSql, { tenantId: T, interviewId: IV_DONE }),
        "BAD_REQUEST",
      );
      assert.match(err.message, /Admin → AI settings/);
      const row = await evidenceRowFor(IV_DONE);
      assert.equal(row?.status, "done", "a refused regenerate leaves the report alone");
    } finally {
      await setEvidenceEnabled(true);
    }
  });
});
