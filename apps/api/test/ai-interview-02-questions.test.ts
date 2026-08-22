/**
 * N4.2 — AI interview question generation + the recruiter approval gate.
 *
 * Coverage:
 *   Test 1: generate writes a DRAFT session whose every question cites a REAL
 *           rubric key — checked against the round's own
 *           `scorecard_criteria_snapshot` read back from the database, not
 *           against a constant this file also chose. Keys are server-assigned
 *           q1..qN, provenance is stamped, and no stored question carries a
 *           score / rating / ideal-answer field.
 *   Test 2: a question citing a rubric key the round does NOT have is
 *           REJECTED and nothing is saved (fixture-driven — the fixture is the
 *           hallucination). The ai_usage_logs row still lands, because the
 *           call happened and the cost ledger must not lie.
 *   Test 3: the `ai_interview_questions` kill switch refuses BEFORE any model
 *           call — clean BAD_REQUEST, zero usage-log delta — and the read
 *           surface reports the disabled state. Settings restored.
 *   Test 4: approve moves draft → approved and stamps ALL THREE approval
 *           columns (approver, approved_at, questions_frozen_at) together,
 *           with the DB audit trigger recording the change.
 *   Test 5: regeneration after approval is REFUSED and the approved questions
 *           are left byte-identical.
 *   Test 6: the database CHECK, not the procedure, is what stops an
 *           unapproved session reaching the candidate — a hand-crafted
 *           `UPDATE … SET status='issued'` without the approval columns is
 *           rejected 23514, and the same statement WITH them succeeds.
 *
 * NODE_ENV=test forces LocalAIClient (fixtures) — no real tokens are spent.
 * The two generation fixtures are written on the fly from the harvested prompt
 * hash (the panel-02 / hrops-02 technique) and unlinked in afterAll.
 *
 * Runs against the REAL seeded tenant (procedures need real JWTs), so every
 * fixture id lives in the a420 namespace and cleanup is groom-safe. Requires
 * `pnpm db:seed:test-users` and migration 0119.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, unlink } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import { targetQuestionCount, validateRubricKeys } from "../src/lib/ai-interview-questions";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@mindssparc.com";
const ADMIN = "admin1@mindssparc.com";

// Fixed fixture ids (a420 namespace — N4.2 test rows, groom-safe cleanup).
const N42_BU = "00000000-0000-4000-8000-000000a42001";
const N42_POSITION = "00000000-0000-4000-8000-000000a42002";
const N42_JD = "00000000-0000-4000-8000-000000a42003";
const N42_REQ = "00000000-0000-4000-8000-000000a42004";
const N42_PERSON = "00000000-0000-4000-8000-000000a42005";
const N42_CANDIDATE = "00000000-0000-4000-8000-000000a42006";
const N42_APP = "00000000-0000-4000-8000-000000a42007";
/** The happy path: generate → approve → regenerate refused. */
const N42_IV_GOOD = "00000000-0000-4000-8000-000000a42008";
/** The hallucinated-rubric-key round. Its rubric differs from GOOD's so the
 * prompt — and therefore the fixture hash — is a different one. */
const N42_IV_BAD = "00000000-0000-4000-8000-000000a42009";
/** Never generated on: exists purely to prove the DB CHECK (test 6). */
const N42_IV_CHECK = "00000000-0000-4000-8000-000000a4200a";

/** The rubric frozen onto the GOOD round — the general code default. */
const GOOD_RUBRIC = [
  { key: "role_competence", label: "Role competence" },
  { key: "problem_solving", label: "Problem solving" },
  { key: "communication", label: "Communication" },
  { key: "collaboration", label: "Collaboration" },
  { key: "motivation", label: "Motivation" },
];
/** The rubric frozen onto the BAD round — deliberately a different set. */
const BAD_RUBRIC = [
  { key: "problem_solving", label: "Problem solving" },
  { key: "technical_depth", label: "Technical depth" },
  { key: "code_quality", label: "Code quality & craft" },
  { key: "system_design", label: "System design" },
  { key: "communication", label: "Communication" },
];

const RUN = Date.now().toString(36);

let recruiterJwt: string;
let adminJwt: string;
let tenantId: string;
let recruiterMembershipId: string;
const writtenFixtures: string[] = [];

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}
function data<T>(e: TRPCSuccess<T> | TRPCErr): T {
  assert.ok(!isErr(e), `unexpected tRPC error: ${JSON.stringify(e)}`);
  return (e as TRPCSuccess<T>).result.data;
}

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url =
    input === undefined
      ? `/trpc/${name}`
      : `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

interface SessionCard {
  sessionId: string;
  interviewId: string;
  status: string;
  questions: { key: string; prompt: string; rubricKey: string }[];
  rubric: { key: string; label: string }[];
  questionsFrozenAt: string | null;
  approvedByMembershipId: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Call the generator; on a LocalAI fixture miss, write a fixture keyed by the
 * harvested prompt hash and retry. The retry's response is returned AS IS —
 * test 2 needs the (rejected) second attempt, not a happy path.
 */
async function generateWithFixture(
  interviewId: string,
  jwt: string,
  questions: { prompt: string; rubricKey: string }[],
) {
  const first = await trpcMutation<{ session: SessionCard }>(
    "generateAiInterviewQuestions",
    { interviewId },
    jwt,
  );
  if (!isErr(first)) return first;
  const match = /prompt hash ([a-f0-9]{64})/.exec(first.error.message ?? "");
  if (!match) return first; // a real refusal (kill switch, conflict) — pass it back.
  const path = resolve(FIXTURE_DIR, `${match[1]!}.json`);
  writtenFixtures.push(path);
  await writeFile(
    path,
    JSON.stringify({
      json: { questions },
      inputTokens: 1100,
      outputTokens: 320,
      costMicros: 7400,
      latencyMs: 380,
    }),
  );
  return trpcMutation<{ session: SessionCard }>(
    "generateAiInterviewQuestions",
    { interviewId },
    jwt,
  );
}

/** postgres.js surfaces the SQLSTATE on `.code` and the constraint on
 * `.constraint_name`; 23514 = check_violation. */
function pgCode(err: unknown): string {
  return (err as { code?: string }).code ?? "";
}
function pgConstraint(err: unknown): string {
  return (err as { constraint_name?: string }).constraint_name ?? "";
}

async function cleanup(): Promise<void> {
  const ivs = [N42_IV_GOOD, N42_IV_BAD, N42_IV_CHECK];
  // The session ids BEFORE anything is deleted. `ai_interview_sessions` carries
  // an audit trigger, so deleting a session writes one more audit row — which
  // means the audit sweep has to run AFTER the delete and therefore cannot
  // derive the ids from the table it just emptied. This test runs against the
  // real seeded tenant, so the sweep is scoped to exactly these ids: a
  // tenant-wide audit delete would take demo history with it.
  let sessionIds: string[] = [];
  try {
    const rows = await poolSql<{ id: string }[]>`
      SELECT id FROM public.ai_interview_sessions
      WHERE tenant_id = ${tenantId} AND interview_id = ANY(${ivs})
    `;
    sessionIds = rows.map((r) => r.id);
  } catch (err) {
    console.warn("N4.2 cleanup: could not read session ids (continuing):", err);
  }

  const stmts: (() => Promise<unknown>)[] = [
    () => poolSql`
      DELETE FROM public.ai_interview_sessions
      WHERE tenant_id = ${tenantId} AND interview_id = ANY(${ivs})
    `,
    // Now the audit rows the whole lifecycle wrote — insert, update AND the
    // delete above.
    () =>
      sessionIds.length === 0
        ? Promise.resolve()
        : poolSql`
            DELETE FROM public.audit_logs
            WHERE tenant_id = ${tenantId}
              AND entity_type = 'ai_interview_sessions'
              AND entity_id = ANY(${sessionIds})
          `,
    () => poolSql`DELETE FROM public.interviews WHERE id = ANY(${ivs})`,
    () => poolSql`DELETE FROM public.interview_plans WHERE requisition_id = ${N42_REQ}`,
    () =>
      poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${N42_APP}`,
    () => poolSql`DELETE FROM public.applications WHERE id = ${N42_APP}`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ${N42_CANDIDATE}`,
    () => poolSql`DELETE FROM public.persons WHERE id = ${N42_PERSON}`,
    () => poolSql`DELETE FROM public.requisition_knockouts WHERE requisition_id = ${N42_REQ}`,
    () => poolSql`DELETE FROM public.jd_skills WHERE jd_version_id = ${N42_JD}`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${N42_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${N42_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${N42_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${N42_BU}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("N4.2 cleanup step failed (continuing):", err);
    }
  }
}

async function seedFixtures(): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${N42_BU}, ${tenantId}, ${`N4.2 QA ${RUN}`}, ${`n42-qa-${RUN}`})
  `;
  await poolSql`
    INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${N42_POSITION}, ${tenantId}, ${N42_BU}, ${`N4.2 Support Engineer ${RUN}`}, 'hybrid', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${N42_JD}, ${tenantId}, ${N42_POSITION}, 1,
            '# N4.2 JD — support engineer. Owns customer escalations and incident response.',
            'approved')
  `;
  await poolSql`
    INSERT INTO public.jd_skills (tenant_id, jd_version_id, skill_name, weight, is_required)
    VALUES
      (${tenantId}, ${N42_JD}, 'Incident response', 2.00, true),
      (${tenantId}, ${N42_JD}, 'SQL', 1.00, true),
      (${tenantId}, ${N42_JD}, 'Customer communication', 1.00, false)
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${N42_REQ}, ${tenantId}, ${N42_POSITION}, ${N42_JD},
            ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')
  `;
  // A knockout whose THRESHOLD must never reach the prompt (the pass mark is
  // withheld on purpose — see the lib header).
  await poolSql`
    INSERT INTO public.requisition_knockouts
      (tenant_id, requisition_id, question_text, type, threshold_value, source, order_index)
    VALUES (${tenantId}, ${N42_REQ}, 'Years of production on-call experience',
            'numeric_min', ${JSON.stringify({ min: 3 })}::jsonb, 'candidate_asserted', 0)
  `;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${N42_PERSON}, ${tenantId}, 'N4.2 Test Candidate',
            ${`n42-cand-${RUN}@example.test`}, ${`n42-cand-${RUN}@example.test`}, 'IN')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${N42_CANDIDATE}, ${tenantId}, ${N42_PERSON}, 'career_site', 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${N42_APP}, ${tenantId}, ${N42_CANDIDATE}, ${N42_REQ}, 'career_site',
            'tech_interview', now())
  `;
  // Two plan rounds with DIFFERENT competency focus, so the two prompts (and
  // therefore the two fixture hashes) cannot collide.
  await poolSql`
    INSERT INTO public.interview_plans
      (tenant_id, requisition_id, round_number, round_name, duration_minutes, mode,
       scorecard_template, competency_focus)
    VALUES
      (${tenantId}, ${N42_REQ}, 1, 'AI First Round', 30, 'ai_async', 'general',
       ${JSON.stringify(["customer empathy", "incident handling"])}::jsonb),
      (${tenantId}, ${N42_REQ}, 2, 'AI Technical Round', 30, 'ai_async', 'technical',
       ${JSON.stringify(["system design"])}::jsonb)
  `;
  await seedInterview(N42_IV_GOOD, 1, "AI First Round", "general", GOOD_RUBRIC);
  await seedInterview(N42_IV_BAD, 2, "AI Technical Round", "technical", BAD_RUBRIC);
  await seedInterview(N42_IV_CHECK, 3, "AI Constraint Round", "general", GOOD_RUBRIC);
}

async function seedInterview(
  id: string,
  round: number,
  roundName: string,
  template: string,
  rubric: { key: string; label: string }[],
): Promise<void> {
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scorecard_template, scorecard_criteria_snapshot, scheduled_start, scheduled_end,
       duration_minutes, mode, created_by_membership_id)
    VALUES (${id}, ${tenantId}, ${N42_APP}, ${N42_REQ}, ${round}, ${roundName}, 'scheduled',
            ${template}, ${JSON.stringify(rubric)}::jsonb,
            now() + interval '390 days', now() + interval '390 days' + interval '30 minutes',
            30, 'ai_async', ${recruiterMembershipId})
  `;
}

describe("N4.2 — AI interview questions (generation + approval gate)", () => {
  beforeAll(async () => {
    [recruiterJwt, adminJwt] = await Promise.all([signIn(RECRUITER), signIn(ADMIN)]);
    const rClaims = decodeJwt(recruiterJwt);
    tenantId = (rClaims as { tid?: string }).tid as string;

    const [rm] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${rClaims.sub as string} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (!rm) throw new Error("recruiter membership missing — run pnpm db:seed:test-users");
    recruiterMembershipId = rm.id;

    await cleanup();
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
    for (const path of writtenFixtures) {
      try {
        await unlink(path);
      } catch {
        /* already gone */
      }
    }
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: generate writes a draft whose every question cites a REAL rubric key", async () => {
    // The count policy, stated as an assertion rather than left implicit: one
    // question per rubric criterion (else N4.4 reports an uncoverable gap as a
    // fact about the candidate) plus one for the round's competency focus,
    // clamped to [5, 10].
    assert.equal(targetQuestionCount(5, 2), 6);
    assert.equal(targetQuestionCount(3, 0), 5, "clamped up to the rubric-sized floor");
    assert.equal(targetQuestionCount(14, 0), 10, "clamped down to ~30 minutes of answers");

    const res = await generateWithFixture(N42_IV_GOOD, recruiterJwt, [
      {
        prompt: "Walk me through an escalation you owned end to end. What did you do first?",
        rubricKey: "role_competence",
      },
      {
        prompt:
          "Describe a problem where the obvious fix was wrong. How did you find the real one?",
        rubricKey: "problem_solving",
      },
      {
        prompt: "Tell me about explaining an outage to a frustrated customer. What did you say?",
        rubricKey: "communication",
      },
      {
        prompt: "Describe a time you needed help from another team mid-incident.",
        rubricKey: "collaboration",
      },
      {
        prompt: "What draws you to a role that owns customer escalations day to day?",
        rubricKey: "motivation",
      },
      {
        prompt: "Describe your production on-call experience and how it has been structured.",
        rubricKey: "role_competence",
      },
    ]);
    const session = data(res).session;

    assert.equal(session.status, "draft", "generation lands in draft — nothing is approved yet");
    assert.equal(session.questions.length, 6);
    assert.equal(session.promptVersion, "n42-v1");
    assert.ok(session.model, "the generation call's model is stamped");
    assert.equal(session.approvedByMembershipId, null);
    assert.equal(session.approvedAt, null);
    assert.equal(session.questionsFrozenAt, null, "a draft is not frozen");

    // Server-assigned, ordered, collision-free — NOT model-chosen.
    assert.deepEqual(
      session.questions.map((q) => q.key),
      ["q1", "q2", "q3", "q4", "q5", "q6"],
    );

    // THE POINT: every rubricKey exists in THIS ROUND'S snapshot, read back
    // from the database rather than from the constant this file seeded with.
    const [ivRow] = await poolSql<{ snapshot: { key: string; label: string }[] }[]>`
      SELECT scorecard_criteria_snapshot AS snapshot FROM public.interviews
      WHERE tenant_id = ${tenantId} AND id = ${N42_IV_GOOD}
    `;
    const snapshotKeys = new Set((ivRow?.snapshot ?? []).map((c) => c.key));
    assert.ok(snapshotKeys.size > 0, "precondition: the round carries a rubric snapshot");
    for (const q of session.questions) {
      assert.ok(
        snapshotKeys.has(q.rubricKey),
        `question ${q.key} cites '${q.rubricKey}', which is not in this round's rubric`,
      );
    }
    // Every criterion got at least one question — the coverage the prompt asks
    // for, and what makes N4.4's per-rubric report meaningful.
    const covered = new Set(session.questions.map((q) => q.rubricKey));
    for (const key of snapshotKeys) {
      assert.ok(covered.has(key), `rubric criterion '${key}' has no question`);
    }

    // Exactly one persisted session, and its stored questions carry NOTHING
    // that could become an answer key. Questions probe; humans judge.
    const stored = await poolSql<
      { status: string; questions: Record<string, unknown>[]; prompt_version: string | null }[]
    >`
      SELECT status, questions, prompt_version FROM public.ai_interview_sessions
      WHERE tenant_id = ${tenantId} AND interview_id = ${N42_IV_GOOD}
    `;
    assert.equal(stored.length, 1, "one session per interview");
    assert.equal(stored[0]!.status, "draft");
    for (const q of stored[0]!.questions) {
      assert.deepEqual(
        Object.keys(q).sort(),
        ["key", "prompt", "rubricKey"],
        "a stored question carries text + rubric key and nothing else",
      );
    }

    // The read surface returns the same session plus the round's rubric.
    const got = await trpcQuery<{
      session: SessionCard | null;
      rubric: { key: string; label: string }[];
      questionsEnabled: boolean;
    }>("getAiInterviewSession", { interviewId: N42_IV_GOOD }, recruiterJwt);
    const view = data(got);
    assert.ok(view.session, "the draft is readable for review");
    assert.equal(view.session!.questions.length, 6);
    assert.equal(view.rubric.length, snapshotKeys.size);
    assert.equal(view.questionsEnabled, true);
  });

  it("Test 2: a hallucinated rubric key is REJECTED and nothing is saved", async () => {
    // The pure rule first — 'leadership' is plausible, is not on this round,
    // and duplicates collapse to one reported offender.
    assert.deepEqual(
      validateRubricKeys(
        [{ rubricKey: "system_design" }, { rubricKey: "leadership" }, { rubricKey: "leadership" }],
        BAD_RUBRIC,
      ),
      ["leadership"],
    );

    const [{ before } = { before: 0 }] = await poolSql<{ before: number }[]>`
      SELECT count(*)::int AS before FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'ai_interview_questions'
    `;

    const res = await generateWithFixture(N42_IV_BAD, recruiterJwt, [
      {
        prompt: "Walk me through a system you designed and the trade-offs.",
        rubricKey: "system_design",
      },
      { prompt: "Describe the hardest bug you have diagnosed.", rubricKey: "problem_solving" },
      { prompt: "How do you decide when code is ready to review?", rubricKey: "code_quality" },
      {
        prompt: "Explain a technical decision to a non-technical stakeholder.",
        rubricKey: "communication",
      },
      { prompt: "Describe the deepest technical area you own.", rubricKey: "technical_depth" },
      // THE HALLUCINATION: plausible, absent from this round's rubric.
      {
        prompt: "Tell me about a time you led a team through a difficult delivery.",
        rubricKey: "leadership",
      },
    ]);

    assert.ok(isErr(res), "a question citing an unknown rubric key must be rejected");
    assert.equal(res.error.data.code, "BAD_REQUEST");
    const message = res.error.message ?? "";
    assert.ok(message.includes("leadership"), `the offending key is named: ${message}`);
    assert.ok(
      message.toLowerCase().includes("discarded"),
      `the refusal says the set was discarded: ${message}`,
    );

    // NOTHING was saved — not a partial set, not a session in any state.
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.ai_interview_sessions
      WHERE tenant_id = ${tenantId} AND interview_id = ${N42_IV_BAD}
    `;
    assert.equal(Number(n), 0, "a rejected generation writes no session row");

    // …but the call DID happen and DID cost money, and the ledger says so.
    const [{ after } = { after: 0 }] = await poolSql<{ after: number }[]>`
      SELECT count(*)::int AS after FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'ai_interview_questions'
    `;
    assert.ok(
      Number(after) > Number(before),
      "the discarded generation is still attributed in ai_usage_logs",
    );
  });

  it("Test 3: the kill switch refuses BEFORE any model call", async () => {
    interface Settings {
      [k: string]: unknown;
      ai_interview_questions: { enabled: boolean };
    }
    const current = await trpcQuery<Settings>("getTenantAiSettings", {}, adminJwt);
    assert.ok(!isErr(current), `getTenantAiSettings: ${JSON.stringify(current)}`);
    const original = current.result.data;
    assert.equal(
      original.ai_interview_questions.enabled,
      true,
      "precondition: the feature key exists and defaults to enabled",
    );

    const [{ before } = { before: 0 }] = await poolSql<{ before: number }[]>`
      SELECT count(*)::int AS before FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'ai_interview_questions'
    `;

    const off = await trpcMutation(
      "updateTenantAiSettings",
      {
        ...original,
        ai_interview_questions: { ...original.ai_interview_questions, enabled: false },
      },
      adminJwt,
    );
    assert.ok(!isErr(off), `disable: ${JSON.stringify(off)}`);

    try {
      const refused = await trpcMutation(
        "generateAiInterviewQuestions",
        { interviewId: N42_IV_GOOD },
        recruiterJwt,
      );
      assert.ok(isErr(refused), "a disabled feature refuses rather than silently no-opping");
      assert.equal(refused.error.data.code, "BAD_REQUEST");
      assert.ok(
        (refused.error.message ?? "").toLowerCase().includes("disabled"),
        `clean disabled message: ${refused.error.message}`,
      );

      const [{ after } = { after: 0 }] = await poolSql<{ after: number }[]>`
        SELECT count(*)::int AS after FROM public.ai_usage_logs
        WHERE tenant_id = ${tenantId} AND feature = 'ai_interview_questions'
      `;
      assert.equal(
        Number(after),
        Number(before),
        "no usage row — the refusal happened before the model call",
      );

      // The read surface reports the disabled state next to the questions.
      const got = await trpcQuery<{ questionsEnabled: boolean; session: SessionCard | null }>(
        "getAiInterviewSession",
        { interviewId: N42_IV_GOOD },
        recruiterJwt,
      );
      const view = data(got);
      assert.equal(view.questionsEnabled, false);
      assert.ok(view.session, "an existing draft stays readable while the feature is off");
    } finally {
      const restore = await trpcMutation("updateTenantAiSettings", original, adminJwt);
      assert.ok(!isErr(restore), `restore settings: ${JSON.stringify(restore)}`);
    }
  });

  it("Test 4: approve moves draft → approved and stamps all three approval columns", async () => {
    const res = await trpcMutation<{ session: SessionCard }>(
      "approveAiInterviewQuestions",
      { interviewId: N42_IV_GOOD },
      recruiterJwt,
    );
    const session = data(res).session;

    assert.equal(session.status, "approved");
    assert.equal(session.approvedByMembershipId, recruiterMembershipId, "a NAMED human approved");
    assert.ok(session.approvedAt, "approvedAt stamped");
    assert.ok(session.questionsFrozenAt, "the question set froze at approval");

    // All three columns are set TOGETHER — there is no window in which the
    // session is approved-but-unfrozen or frozen-but-unattributed.
    const [row] = await poolSql<
      {
        id: string;
        status: string;
        approved_by_membership_id: string | null;
        approved_at: Date | string | null;
        questions_frozen_at: Date | string | null;
      }[]
    >`
      SELECT id, status, approved_by_membership_id, approved_at, questions_frozen_at
      FROM public.ai_interview_sessions
      WHERE tenant_id = ${tenantId} AND interview_id = ${N42_IV_GOOD}
    `;
    assert.equal(row!.status, "approved");
    assert.equal(row!.approved_by_membership_id, recruiterMembershipId);
    assert.ok(row!.approved_at);
    assert.ok(row!.questions_frozen_at);

    // The DB audit trigger recorded the approval — synchronous, inside the
    // caller's transaction, unlike the fire-and-forget api_audit_logs row.
    const audits = await poolSql<{ action: string; changed_columns: string[] | null }[]>`
      SELECT action, changed_columns FROM public.audit_logs
      WHERE tenant_id = ${tenantId}
        AND entity_type = 'ai_interview_sessions'
        AND entity_id = ${row!.id}
      ORDER BY created_at DESC
    `;
    assert.ok(audits.length > 0, "the approval is auditable at the database level");
    const changed = audits.flatMap((a) => a.changed_columns ?? []);
    for (const col of [
      "status",
      "approved_by_membership_id",
      "approved_at",
      "questions_frozen_at",
    ]) {
      assert.ok(changed.includes(col), `audit trail records the '${col}' change`);
    }

    // A second approval is refused rather than re-stamping a different name.
    const again = await trpcMutation(
      "approveAiInterviewQuestions",
      { interviewId: N42_IV_GOOD },
      recruiterJwt,
    );
    assert.ok(isErr(again));
    assert.equal(again.error.data.code, "CONFLICT");
  });

  it("Test 5: regeneration after approval is REFUSED and the questions are untouched", async () => {
    const [before] = await poolSql<{ questions: unknown }[]>`
      SELECT questions FROM public.ai_interview_sessions
      WHERE tenant_id = ${tenantId} AND interview_id = ${N42_IV_GOOD}
    `;

    const refused = await trpcMutation(
      "generateAiInterviewQuestions",
      { interviewId: N42_IV_GOOD },
      recruiterJwt,
    );
    assert.ok(isErr(refused), "an approved set can no longer be regenerated");
    assert.equal(refused.error.data.code, "CONFLICT");
    assert.ok(
      /approved|frozen/i.test(refused.error.message ?? ""),
      `the refusal explains the freeze: ${refused.error.message}`,
    );

    const [after] = await poolSql<{ questions: unknown; status: string }[]>`
      SELECT questions, status FROM public.ai_interview_sessions
      WHERE tenant_id = ${tenantId} AND interview_id = ${N42_IV_GOOD}
    `;
    assert.equal(after!.status, "approved");
    assert.deepEqual(
      after!.questions,
      before!.questions,
      "the approved questions are byte-identical — a candidate may already have seen them",
    );
  });

  it("Test 6: the DATABASE, not the procedure, blocks an unapproved 'issued'", async () => {
    // Hand-crafted, deliberately bypassing every line of application code —
    // the approval gate is a CHECK precisely so a later ticket cannot route
    // around it.
    await poolSql`
      INSERT INTO public.ai_interview_sessions (tenant_id, interview_id, questions)
      VALUES (${tenantId}, ${N42_IV_CHECK},
              ${JSON.stringify([
                { key: "q1", prompt: "Hand-crafted draft.", rubricKey: "role_competence" },
              ])}::jsonb)
    `;

    let code = "";
    let constraint = "";
    try {
      await poolSql`
        UPDATE public.ai_interview_sessions
        SET status = 'issued', link_token_hash = ${`n42-${RUN}-hash`}
        WHERE tenant_id = ${tenantId} AND interview_id = ${N42_IV_CHECK}
      `;
      assert.fail("the database accepted an issued session with no human approval");
    } catch (err) {
      code = pgCode(err);
      constraint = pgConstraint(err);
    }
    assert.equal(code, "23514", "an unapproved issue must be a check violation");
    if (constraint) {
      assert.equal(
        constraint,
        "ai_interview_sessions_approval_check",
        "and specifically the APPROVAL check, not some other constraint",
      );
    }

    // With the approver, the timestamp and the freeze in place, the same
    // statement is legal — the CHECK gates on the approval, not on the status.
    await poolSql`
      UPDATE public.ai_interview_sessions
      SET status = 'issued',
          approved_by_membership_id = ${recruiterMembershipId},
          approved_at = now(),
          questions_frozen_at = now(),
          link_token_hash = ${`n42-${RUN}-hash`}
      WHERE tenant_id = ${tenantId} AND interview_id = ${N42_IV_CHECK}
    `;
    const [row] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.ai_interview_sessions
      WHERE tenant_id = ${tenantId} AND interview_id = ${N42_IV_CHECK}
    `;
    assert.equal(row!.status, "issued");
  });
});
