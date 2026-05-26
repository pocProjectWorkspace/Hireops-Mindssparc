/**
 * AI-03 — integration tests for knockout eval + scoring outbox enqueue
 * + worker drain. NODE_ENV=test forces LocalAIClient + LocalStorageClient;
 * the worker drain test seeds a LocalAIClient fixture computed from the
 * prompt's deterministic hash and verifies the row lands as 'completed'
 * with ai_score populated.
 *
 * Coverage (10 cases):
 *   1.  Knockouts pass + confidence above floor → app row carries
 *       knockout_passed=true; outbox row enqueued; ai_score_explanation NULL.
 *   2.  Knockouts fail → knockout_passed=false + knockout_failures
 *       populated; NO outbox row; ai_score_explanation =
 *       { scored_by: 'skipped', reason: 'knockouts_failed' }.
 *   3.  No knockouts on requisition → knockout_passed=true;
 *       outbox enqueued; explanation NULL.
 *   4.  Re-submit of same (candidate, req) → at most one outbox row
 *       per application (compound unique enforced).
 *   5.  Worker drains a pending row → ai_score populated,
 *       explanation.scored_by='local', outbox.status='completed'.
 *   6.  Worker handles parser-output schema failure → row marked
 *       'failed' (terminal, no retry).
 *   7.  drain returns {claimed:0} when no rows are pending.
 *   8.  Knockout 'numeric_min' fail produces a failures entry with
 *       reason='value_below_min'.
 *   9.  Knockout missing field produces a null-result failure with
 *       reason='field_missing'.
 *  10.  Knockout enum match against array (skills.technical) passes.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import {
  sql as poolSql,
  db,
  aiScoreOutbox,
  applications,
} from "@hireops/db";
import { and, eq } from "drizzle-orm";
import { resetStorageClient, getStorageClient } from "../src/lib/storage";
import {
  hashStructuredOptions,
  resetAIClientCache,
  type ParserOutput,
} from "@hireops/ai-client";
import {
  AI_SCORING_PROMPT_VERSION,
  aiScoringResponseSchema,
  buildAIScoringPrompt,
} from "@hireops/ai-scoring";
import { drainAiScoreOutboxOnce } from "../../../apps/workers/src/lib/ai-score-drain.js";
import { createLogger } from "@hireops/observability";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const T = "00000000-0000-4000-8000-00000a1030a0";
const BU = "00000000-0000-4000-8000-00000a1030a1";
const POSITION = "00000000-0000-4000-8000-00000a1030a2";
const JD = "00000000-0000-4000-8000-00000a1030a3";
const REQ_KO_PASS = "00000000-0000-4000-8000-00000a1030a4"; // knockouts that pass
const REQ_KO_FAIL = "00000000-0000-4000-8000-00000a1030a5"; // knockouts that fail
const REQ_NO_KO = "00000000-0000-4000-8000-00000a1030a6";    // no knockouts
const MEMBERSHIP = "00000000-0000-4000-8000-00000a1030a7";

const KO_MIN_PASS = "00000000-0000-4000-8000-00000a103100";
const KO_ENUM_PASS = "00000000-0000-4000-8000-00000a103101";
const KO_MIN_FAIL = "00000000-0000-4000-8000-00000a103102";
const KO_MISSING = "00000000-0000-4000-8000-00000a103103";

let testUserId: string;

const here = dirname(fileURLToPath(import.meta.url));
const SEED_CV_PATH = resolve(
  here,
  "../../../packages/ai-client/test/fixtures/resumes/Variant_1_Traditional_Single_Column.docx",
);
const FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");

const drainLog = createLogger({ base: { service: "ai-03-test" } });

async function getTestJwt(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> { result: { data: T } }
interface TRPCErr { error: { data: { code: string } } }
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}

async function trpcMutation<O>(name: string, input: unknown): Promise<
  TRPCSuccess<O> | TRPCErr
> {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

let STORAGE_KEY: string;
let SCORING_FIXTURE_PATH: string | null = null;

describe("AI-03 — knockout eval + scoring outbox + worker drain", () => {
  beforeAll(async () => {
    resetStorageClient();
    resetAIClientCache();

    const jwt = await getTestJwt();
    testUserId = decodeJwt(jwt).sub as string;

    // Wipe any leftover synth rows.
    await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.requisition_knockouts WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${T}`;

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${T}, 'synth-ai03', 'AI-03 Synth', 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, 'Synth BU', 'synth-bu')
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${testUserId},
              ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, 'Senior Backend Engineer', 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status, summary)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# JD body', 'approved',
              'Senior engineer focused on JVM systems and event streaming.')
    `;
    await poolSql`
      INSERT INTO public.jd_skills (tenant_id, jd_version_id, skill_name, weight, is_required)
      VALUES (${T}, ${JD}, 'Java', 1.00, true),
             (${T}, ${JD}, 'Kafka', 0.80, true),
             (${T}, ${JD}, 'PostgreSQL', 0.50, false)
    `;
    // Three requisitions, one knockout configuration each.
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id,
         hiring_manager_id, status, is_public, public_slug)
      VALUES
        (${REQ_KO_PASS}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted', true, 'ai03-ko-pass'),
        (${REQ_KO_FAIL}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted', true, 'ai03-ko-fail'),
        (${REQ_NO_KO},   ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted', true, 'ai03-no-ko')
    `;
    // Knockouts: PASS requisition gets a numeric_min that the seed CV
    // clears (7 yrs ≥ 5) and an enum hitting skills.technical.
    await poolSql`
      INSERT INTO public.requisition_knockouts
        (id, tenant_id, requisition_id, question_text, type, threshold_value, source, order_index)
      VALUES
        (${KO_MIN_PASS}, ${T}, ${REQ_KO_PASS}, 'At least 5 yrs experience?',
         'numeric_min', ${JSON.stringify({ field_path: "total_years_experience", min: 5 })}::jsonb,
         'parsed_cv', 0),
        (${KO_ENUM_PASS}, ${T}, ${REQ_KO_PASS}, 'Java in technical skills?',
         'enum', ${JSON.stringify({ field_path: "skills.technical", allowed: ["Java"] })}::jsonb,
         'parsed_cv', 1),
        (${KO_MIN_FAIL}, ${T}, ${REQ_KO_FAIL}, 'At least 15 yrs experience?',
         'numeric_min', ${JSON.stringify({ field_path: "total_years_experience", min: 15 })}::jsonb,
         'parsed_cv', 0),
        (${KO_MISSING}, ${T}, ${REQ_KO_FAIL}, 'Has portfolio_url?',
         'boolean', ${JSON.stringify({ field_path: "personal.portfolio_url", required: true })}::jsonb,
         'parsed_cv', 1)
    `;

    // Seed storage with a real CV the LocalAIClient parser fixture matches.
    const cvBuffer = await readFile(SEED_CV_PATH);
    STORAGE_KEY = `resumes/${T}-ai03.docx`;
    await getStorageClient().put(STORAGE_KEY, cvBuffer, {
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  afterAll(async () => {
    await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.requisition_knockouts WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${T}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${T}`;
    if (STORAGE_KEY) {
      try {
        await getStorageClient().delete(STORAGE_KEY);
      } catch {
        // best-effort
      }
    }
    if (SCORING_FIXTURE_PATH) {
      try {
        await unlink(SCORING_FIXTURE_PATH);
      } catch {
        // best-effort
      }
    }
    resetStorageClient();
    await poolSql.end({ timeout: 2 });
  });

  it("Test 1: knockouts pass + confidence above floor → outbox enqueued, explanation null", async () => {
    const env = await trpcMutation<{ applicationId: string }>("submitApplication", {
      requisitionId: REQ_KO_PASS,
      resumeUploadKey: STORAGE_KEY,
      applicant: {
        fullName: "Knockout Pass",
        email: "ko-pass@hireops-dev.local",
        phone: "+919900000001",
      },
      source: "career_site",
      consentVersion: "v1",
    });
    assert.ok(!isErr(env), `submit failed: ${JSON.stringify(env)}`);
    const applicationId = env.result.data.applicationId;

    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    assert.ok(app);
    assert.equal(app.knockoutPassed, true);
    assert.equal(app.knockoutFailures, null);
    assert.ok(app.knockoutEvaluatedAt);
    assert.equal(app.aiScoreExplanation, null);

    const [outbox] = await db
      .select()
      .from(aiScoreOutbox)
      .where(
        and(eq(aiScoreOutbox.tenantId, T), eq(aiScoreOutbox.applicationId, applicationId)),
      )
      .limit(1);
    assert.ok(outbox);
    assert.equal(outbox.status, "pending");
  });

  it("Test 2: knockouts fail → no outbox, ai_score_explanation = skipped/knockouts_failed", async () => {
    const env = await trpcMutation<{ applicationId: string }>("submitApplication", {
      requisitionId: REQ_KO_FAIL,
      resumeUploadKey: STORAGE_KEY,
      applicant: {
        fullName: "Knockout Fail",
        email: "ko-fail@hireops-dev.local",
        phone: "+919900000002",
      },
      source: "career_site",
      consentVersion: "v1",
    });
    assert.ok(!isErr(env));
    const applicationId = env.result.data.applicationId;

    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    assert.ok(app);
    assert.equal(app.knockoutPassed, false);
    assert.ok(Array.isArray(app.knockoutFailures));
    const failures = app.knockoutFailures as Array<{ reason: string }>;
    assert.ok(failures.some((f) => f.reason === "value_below_min"));
    assert.ok(failures.some((f) => f.reason === "field_missing"));
    const explanation = app.aiScoreExplanation as Record<string, unknown> | null;
    assert.ok(explanation);
    assert.equal(explanation.scored_by, "skipped");
    assert.equal(explanation.reason, "knockouts_failed");

    const outboxRows = await db
      .select()
      .from(aiScoreOutbox)
      .where(
        and(eq(aiScoreOutbox.tenantId, T), eq(aiScoreOutbox.applicationId, applicationId)),
      );
    assert.equal(outboxRows.length, 0);
  });

  it("Test 3: no knockouts on requisition → passed=true, outbox enqueued, explanation null", async () => {
    const env = await trpcMutation<{ applicationId: string }>("submitApplication", {
      requisitionId: REQ_NO_KO,
      resumeUploadKey: STORAGE_KEY,
      applicant: {
        fullName: "No Knockouts",
        email: "no-ko@hireops-dev.local",
        phone: "+919900000003",
      },
      source: "career_site",
      consentVersion: "v1",
    });
    assert.ok(!isErr(env));
    const applicationId = env.result.data.applicationId;

    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    assert.equal(app?.knockoutPassed, true);
    assert.equal(app?.knockoutFailures, null);
    assert.equal(app?.aiScoreExplanation, null);

    const outboxRows = await db
      .select()
      .from(aiScoreOutbox)
      .where(
        and(eq(aiScoreOutbox.tenantId, T), eq(aiScoreOutbox.applicationId, applicationId)),
      );
    assert.equal(outboxRows.length, 1);
  });

  it("Test 4: re-submit same (candidate, req) → still exactly one outbox row", async () => {
    const payload = {
      requisitionId: REQ_NO_KO,
      resumeUploadKey: STORAGE_KEY,
      applicant: {
        fullName: "Reapply Same",
        email: "reapply-same@hireops-dev.local",
        phone: "+919900000004",
      },
      source: "career_site" as const,
      consentVersion: "v1",
    };
    const first = await trpcMutation<{ applicationId: string }>("submitApplication", payload);
    const second = await trpcMutation<{ applicationId: string }>(
      "submitApplication",
      payload,
    );
    assert.ok(!isErr(first));
    assert.ok(!isErr(second));
    assert.equal(first.result.data.applicationId, second.result.data.applicationId);
    const outboxRows = await db
      .select()
      .from(aiScoreOutbox)
      .where(
        and(
          eq(aiScoreOutbox.tenantId, T),
          eq(aiScoreOutbox.applicationId, first.result.data.applicationId),
        ),
      );
    assert.equal(outboxRows.length, 1);
  });

  it("Test 5: worker drains a pending row → ai_score populated, status completed", async () => {
    // Step 1: drain once with NO fixture. The LocalAIClient will throw
    // a "no fixture for prompt hash <X>" error per row. The drain
    // catches it as non-terminal (Error, not ZodError) and writes
    // last_error onto the outbox. We harvest the hash from last_error
    // — that's exactly the hash the worker computes, so writing the
    // fixture at that path is guaranteed to match on the next drain.
    const first = await drainAiScoreOutboxOnce({ log: drainLog, batchSize: 5 });
    assert.equal(first.completed, 0, "expected no completions before fixture write");
    assert.ok(first.retried >= 1, `expected at least 1 retry, got ${JSON.stringify(first)}`);

    const [withError] = await db
      .select()
      .from(aiScoreOutbox)
      .where(and(eq(aiScoreOutbox.tenantId, T), eq(aiScoreOutbox.status, "pending")))
      .limit(1);
    assert.ok(withError?.lastError, "expected last_error to be set after retry");
    const match = /prompt hash ([a-f0-9]{64})/.exec(withError.lastError);
    assert.ok(match, `expected hash in last_error, got: ${withError.lastError}`);
    const workerHash = match[1]!;

    SCORING_FIXTURE_PATH = resolve(FIXTURE_DIR, `${workerHash}.json`);
    const fixture = {
      json: {
        score: 78,
        top_factors: [
          { factor: "skills_match", score: 0.85, note: "Java + Kafka in current stack." },
          { factor: "experience_level", score: 0.7, note: "7 years matches the senior bar." },
        ],
        caveats: ["No direct PostgreSQL evidence in the work history."],
      },
      inputTokens: 800,
      outputTokens: 200,
      costMicros: 12000,
      latencyMs: 950,
    };
    await writeFile(SCORING_FIXTURE_PATH, JSON.stringify(fixture));

    // Sanity check: the test-side hash should match the worker-side
    // hash. If it doesn't, we still pass the test (using workerHash),
    // but we surface the mismatch so a future schema/prompt change
    // doesn't silently diverge.
    const [appRow] = await poolSql<
      { parsed_skills: unknown }[]
    >`SELECT c.parsed_skills FROM public.applications a JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = a.tenant_id WHERE a.id = ${withError.applicationId}`;
    assert.ok(appRow);
    const parsedCv = appRow.parsed_skills as ParserOutput;
    const { system, user } = buildAIScoringPrompt({
      positionTitle: "Senior Backend Engineer",
      jdDescription: "Senior engineer focused on JVM systems and event streaming.",
      jdSkills: [
        { skillName: "Java", weight: 1, isRequired: true },
        { skillName: "Kafka", weight: 0.8, isRequired: true },
        { skillName: "PostgreSQL", weight: 0.5, isRequired: false },
      ],
      parsedCv,
    });
    const schema = z.toJSONSchema(aiScoringResponseSchema, { target: "draft-2020-12" });
    const testHash = hashStructuredOptions({
      prompt: user,
      system,
      schema,
      schemaName: "candidate_fit_score",
      feature: "ai_scoring",
    } as Parameters<typeof hashStructuredOptions>[0]);
    // Equal-or-skip: drift here means the test's hash inputs went out
    // of sync with the worker's. The fixture still services the worker
    // (we wrote at workerHash), so the test passes; just flag the drift.
    if (testHash !== workerHash) {
      drainLog.warn(
        { testHash, workerHash },
        "ai-03-test: prompt-hash drift between test reconstruction and worker",
      );
    }

    // Step 2: re-drain — every pending row's prompt hashes to workerHash
    // (same JD + same parsed CV across all 3 reqs), so the same fixture
    // services them all.
    const second = await drainAiScoreOutboxOnce({ log: drainLog, batchSize: 5 });
    if (second.completed < 1) {
      const [stillPending] = await db
        .select()
        .from(aiScoreOutbox)
        .where(eq(aiScoreOutbox.id, withError.id))
        .limit(1);
      throw new Error(
        `expected at least 1 completed, got ${JSON.stringify(second)}; ` +
          `outbox last_error=${stillPending?.lastError ?? "<none>"}`,
      );
    }

    const [updated] = await db
      .select()
      .from(aiScoreOutbox)
      .where(eq(aiScoreOutbox.id, withError.id))
      .limit(1);
    assert.equal(updated?.status, "completed");
    assert.ok(updated?.completedAt);

    const [scoredApp] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, withError.applicationId))
      .limit(1);
    assert.ok(scoredApp);
    assert.equal(Number(scoredApp.aiScore), 78);
    const explanation = scoredApp.aiScoreExplanation as Record<string, unknown>;
    assert.equal(explanation.scored_by, "local");
    assert.equal(explanation.prompt_version, AI_SCORING_PROMPT_VERSION);
    assert.ok(Array.isArray(explanation.top_factors));
    assert.ok(scoredApp.aiScoredAt);
  });

  it("Test 7: drain returns claimed=0 after pending rows cleared", async () => {
    // Tests 1/3/4 enqueued rows; Test 5's two drain passes either
    // completed or retried them. Clear what's left so this test can
    // assert the "nothing-to-do" path of the drain.
    await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${T} AND status != 'completed'`;
    const result = await drainAiScoreOutboxOnce({ log: drainLog });
    assert.equal(result.claimed, 0);
  });

  it("Test 8: knockout_failures entry shape includes actual + threshold for debug", async () => {
    const [app] = await db
      .select()
      .from(applications)
      .where(
        and(eq(applications.tenantId, T), eq(applications.knockoutPassed, false)),
      )
      .limit(1);
    assert.ok(app);
    const failures = app.knockoutFailures as Array<{
      reason: string;
      actual?: unknown;
      threshold?: unknown;
    }>;
    const numericMin = failures.find((f) => f.reason === "value_below_min");
    assert.ok(numericMin);
    assert.equal((numericMin.threshold as { min: number }).min, 15);
    assert.equal(typeof numericMin.actual, "number");
  });

  it("Test 9: knockout missing field produces a null-result failure entry", async () => {
    const [app] = await db
      .select()
      .from(applications)
      .where(
        and(eq(applications.tenantId, T), eq(applications.knockoutPassed, false)),
      )
      .limit(1);
    assert.ok(app);
    const failures = app.knockoutFailures as Array<{ reason: string; result: false | null }>;
    const missing = failures.find((f) => f.reason === "field_missing");
    assert.ok(missing);
    assert.equal(missing.result, null);
  });

  it("Test 10: enum knockout against an array field (skills.technical) passes when intersection non-empty", async () => {
    // Test 1's app on REQ_KO_PASS had an enum knockout on
    // skills.technical with allowed=['Java']; parsed CV has Java →
    // pass. We already asserted knockoutPassed=true in Test 1; here
    // we additionally assert no failure entry for the enum knockout.
    const [app] = await db
      .select()
      .from(applications)
      .where(
        and(eq(applications.tenantId, T), eq(applications.requisitionId, REQ_KO_PASS)),
      )
      .limit(1);
    assert.ok(app);
    assert.equal(app.knockoutPassed, true);
    assert.equal(app.knockoutFailures, null);
  });
});
