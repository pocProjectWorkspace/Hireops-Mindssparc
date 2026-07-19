/**
 * HROPS-01 — HR Ops cases workspace + HR round assessment integration tests.
 *
 * Coverage:
 *   1. saveHrRoundAssessment (hr_ops) saves + UPSERTS in place (one row per
 *      application; a re-save updates, never appends).
 *   2. The deterministic stage-advance gate: advancing an application FORWARD
 *      out of hr_round (→ offer_drafted) is BLOCKED without a saved assessment,
 *      BLOCKED with a hold/reject assessment, and ALLOWED with a 'proceed'
 *      assessment. A tech_interview → hr_round advance is NOT gated.
 *   3. listHrCases / getHrCaseDetail scoping: hr_ops sees the tenant's HR cases;
 *      recruiter is FORBIDDEN on every HR-Ops procedure. RLS scopes rows to the
 *      tenant on top of the persona gate.
 *
 * Requires `pnpm db:seed:test-users` (hr_ops1 / recruiter1). Cleans up its own
 * rows in beforeAll + afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const HR_OPS = "hr_ops1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";

// Final UUID group: 10-char prefix + 2-char suffix (12 hex total).
const P = "00000000-0000-4000-8000-0000000ac0";
const BU = `${P}01`;
const POSITION = `${P}02`;
const JD = `${P}03`;
const REQ = `${P}04`;
// APP_HR — an hr_round case used for save/upsert + list/detail.
const PERSON_HR = `${P}05`;
const CAND_HR = `${P}06`;
const APP_HR = `${P}07`;
// APP_GATE — a second hr_round case used for the advance gate.
const PERSON_GATE = `${P}08`;
const CAND_GATE = `${P}09`;
const APP_GATE = `${P}0a`;
// APP_TECH — a tech_interview case: the un-gated advance + list membership.
const PERSON_TECH = `${P}0b`;
const CAND_TECH = `${P}0c`;
const APP_TECH = `${P}0d`;

const ALL_APPS = [APP_HR, APP_GATE, APP_TECH];
const ALL_PERSONS = [PERSON_HR, PERSON_GATE, PERSON_TECH];
const ALL_CANDS = [CAND_HR, CAND_GATE, CAND_TECH];

let hrOpsJwt: string;
let recruiterJwt: string;
let tenantId: string;
let recruiterMembershipId: string;

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
function errCode<T>(e: TRPCSuccess<T> | TRPCErr): string {
  assert.ok(isErr(e), `expected tRPC error, got: ${JSON.stringify(e)}`);
  return (e as TRPCErr).error.data.code;
}

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
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

const ASSESSMENT_BASE = {
  motivationDiscussed: true,
  salaryExpectationDiscussed: true,
  cultureFitAssessed: true,
  workAuthorizationVerified: true,
  noticePeriodConfirmed: true,
  relocationWillingness: false,
  notes: "Strong motivation; comp expectation within band; 30-day notice.",
};

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () =>
      poolSql`DELETE FROM public.hr_round_assessments WHERE application_id = ANY(${ALL_APPS}::uuid[])`,
    () =>
      poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ANY(${ALL_APPS}::uuid[])`,
    () => poolSql`DELETE FROM public.applications WHERE id = ANY(${ALL_APPS}::uuid[])`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ANY(${ALL_CANDS}::uuid[])`,
    () => poolSql`DELETE FROM public.persons WHERE id = ANY(${ALL_PERSONS}::uuid[])`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${BU}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("HROPS-01 cleanup step failed (continuing):", err);
    }
  }
}

async function seedFixtures(): Promise<void> {
  await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${tenantId}, 'HROPS BU', 'hrops-bu')`;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, is_active,
       comp_band_min, comp_band_max, comp_currency)
    VALUES (${POSITION}, ${tenantId}, ${BU}, 'HROPS Staff Engineer', 'hybrid', true,
            2400000, 3200000, 'INR')`;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${JD}, ${tenantId}, ${POSITION}, 1, '# JD', 'approved')`;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${REQ}, ${tenantId}, ${POSITION}, ${JD}, ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')`;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES
      (${PERSON_HR}, ${tenantId}, 'Aisha Khan', 'aisha.hrops@example.com', 'aisha.hrops@example.com', 'IN'),
      (${PERSON_GATE}, ${tenantId}, 'Vikram Rao', 'vikram.hrops@example.com', 'vikram.hrops@example.com', 'IN'),
      (${PERSON_TECH}, ${tenantId}, 'Neha Gupta', 'neha.hrops@example.com', 'neha.hrops@example.com', 'IN')`;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version, parsed_skills, years_of_experience)
    VALUES
      (${CAND_HR}, ${tenantId}, ${PERSON_HR}, 'career_site', 'v1', ${JSON.stringify(["Java", "Kafka"])}::jsonb, 7.0),
      (${CAND_GATE}, ${tenantId}, ${PERSON_GATE}, 'career_site', 'v1', ${JSON.stringify(["Go", "AWS"])}::jsonb, 8.0),
      (${CAND_TECH}, ${tenantId}, ${PERSON_TECH}, 'career_site', 'v1', ${JSON.stringify(["Python"])}::jsonb, 5.0)`;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at, ai_score,
       assigned_recruiter_membership_id)
    VALUES
      (${APP_HR}, ${tenantId}, ${CAND_HR}, ${REQ}, 'career_site', 'hr_round', now(), 84, ${recruiterMembershipId}),
      (${APP_GATE}, ${tenantId}, ${CAND_GATE}, ${REQ}, 'career_site', 'hr_round', now(), 88, ${recruiterMembershipId}),
      (${APP_TECH}, ${tenantId}, ${CAND_TECH}, ${REQ}, 'career_site', 'tech_interview', now(), 79, ${recruiterMembershipId})`;
}

async function assessmentRowCount(applicationId: string): Promise<number> {
  const [row] = await poolSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public.hr_round_assessments WHERE application_id = ${applicationId}`;
  return Number(row?.n ?? 0);
}
async function stageOf(applicationId: string): Promise<string> {
  const [row] = await poolSql<{ stage: string }[]>`
    SELECT current_stage AS stage FROM public.applications WHERE id = ${applicationId}`;
  return row?.stage ?? "";
}

describe("HROPS-01 HR round assessment + case workspace", () => {
  beforeAll(async () => {
    [hrOpsJwt, recruiterJwt] = await Promise.all([signIn(HR_OPS), signIn(RECRUITER)]);
    const hrClaims = decodeJwt(hrOpsJwt);
    const rClaims = decodeJwt(recruiterJwt);
    tenantId = (hrClaims as { tid?: string }).tid as string;
    const recruiterUserId = rClaims.sub as string;
    const [rm] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships WHERE user_id = ${recruiterUserId} AND tenant_id = ${tenantId} LIMIT 1`;
    if (!rm) throw new Error("recruiter membership missing — run pnpm db:seed:test-users");
    recruiterMembershipId = rm.id;

    await cleanup();
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("1. saveHrRoundAssessment saves + upserts in place (one row per application)", async () => {
    const first = await trpcMutation<{ assessment: { recommendation: string; rating: number } }>(
      "saveHrRoundAssessment",
      { applicationId: APP_HR, ...ASSESSMENT_BASE, rating: 3, recommendation: "hold" },
      hrOpsJwt,
    );
    const saved = data(first);
    assert.equal(saved.assessment.recommendation, "hold");
    assert.equal(saved.assessment.rating, 3);
    assert.equal(await assessmentRowCount(APP_HR), 1, "one assessment row after first save");

    // Re-save (upsert) — recommendation + rating change, still exactly one row.
    const second = await trpcMutation<{ assessment: { recommendation: string; rating: number } }>(
      "saveHrRoundAssessment",
      { applicationId: APP_HR, ...ASSESSMENT_BASE, rating: 5, recommendation: "proceed" },
      hrOpsJwt,
    );
    const resaved = data(second);
    assert.equal(resaved.assessment.recommendation, "proceed");
    assert.equal(resaved.assessment.rating, 5);
    assert.equal(await assessmentRowCount(APP_HR), 1, "still one row after upsert");
  });

  it("2. stage-advance gate: hr_round → offer blocked without proceed, allowed with", async () => {
    // No assessment yet on APP_GATE → forward advance is blocked.
    const blockedNoAssessment = await trpcMutation(
      "advanceApplication",
      { applicationId: APP_GATE, targetStage: "offer_drafted" },
      hrOpsJwt,
    );
    assert.equal(errCode(blockedNoAssessment), "BAD_REQUEST", "blocked with no assessment");
    assert.equal(await stageOf(APP_GATE), "hr_round", "still at hr_round");

    // A hold assessment still blocks the forward advance.
    data(
      await trpcMutation(
        "saveHrRoundAssessment",
        { applicationId: APP_GATE, ...ASSESSMENT_BASE, rating: 2, recommendation: "hold" },
        hrOpsJwt,
      ),
    );
    const blockedHold = await trpcMutation(
      "advanceApplication",
      { applicationId: APP_GATE, targetStage: "offer_drafted" },
      hrOpsJwt,
    );
    assert.equal(errCode(blockedHold), "BAD_REQUEST", "blocked with a hold assessment");
    assert.equal(await stageOf(APP_GATE), "hr_round", "still at hr_round");

    // A proceed assessment unlocks the advance.
    data(
      await trpcMutation(
        "saveHrRoundAssessment",
        { applicationId: APP_GATE, ...ASSESSMENT_BASE, rating: 5, recommendation: "proceed" },
        hrOpsJwt,
      ),
    );
    data(
      await trpcMutation(
        "advanceApplication",
        { applicationId: APP_GATE, targetStage: "offer_drafted" },
        hrOpsJwt,
      ),
    );
    assert.equal(await stageOf(APP_GATE), "offer_drafted", "advanced to offer_drafted");

    // The gate is specific to hr_round: a tech_interview → hr_round advance is
    // NOT gated (no assessment required).
    data(
      await trpcMutation(
        "advanceApplication",
        { applicationId: APP_TECH, targetStage: "hr_round" },
        hrOpsJwt,
      ),
    );
    assert.equal(await stageOf(APP_TECH), "hr_round", "tech → hr_round un-gated");
  });

  it("3. listHrCases / getHrCaseDetail: hr_ops scoped; recruiter FORBIDDEN", async () => {
    const list = data<{ rows: { applicationId: string }[]; stats: { total: number } }>(
      await trpcQuery("listHrCases", {}, hrOpsJwt),
    );
    const ids = new Set(list.rows.map((r) => r.applicationId));
    assert.ok(ids.has(APP_HR), "APP_HR appears in the hr_ops case list");
    assert.ok(list.stats.total >= 3, "stats count the seeded HR cases");

    const detail = data<{
      candidate: { name: string | null };
      assessment: { recommendation: string } | null;
      advanceRequiresAssessment: boolean;
    }>(await trpcQuery("getHrCaseDetail", { applicationId: APP_HR }, hrOpsJwt));
    assert.equal(detail.candidate.name, "Aisha Khan");
    assert.equal(detail.assessment?.recommendation, "proceed");
    assert.equal(detail.advanceRequiresAssessment, true, "hr_round case still requires assessment");

    // Recruiter is FORBIDDEN on every HR-Ops procedure.
    assert.equal(errCode(await trpcQuery("listHrCases", {}, recruiterJwt)), "FORBIDDEN");
    assert.equal(
      errCode(await trpcQuery("getHrCaseDetail", { applicationId: APP_HR }, recruiterJwt)),
      "FORBIDDEN",
    );
    assert.equal(
      errCode(
        await trpcMutation(
          "saveHrRoundAssessment",
          { applicationId: APP_HR, ...ASSESSMENT_BASE, rating: 4, recommendation: "proceed" },
          recruiterJwt,
        ),
      ),
      "FORBIDDEN",
    );
  });
});
