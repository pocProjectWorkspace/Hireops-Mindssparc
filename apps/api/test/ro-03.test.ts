/**
 * RO-03 — the hiring-manager persona surfaces (/jd-library, /panel-setup,
 * /insights). Real cloud-minted JWTs (reality #110) as the seeded kyndryl-poc
 * personas; a small self-seeded fixture in the a903 id namespace, cleaned up in
 * afterAll.
 *
 * Coverage:
 *   1. Role gating — hiring_manager + admin allowed; recruiter FORBIDDEN.
 *   2. JD-library scoping — a requisition whose hiring_manager_id is NOT the
 *      caller's membership is excluded for the hiring manager but visible to
 *      admin (the super-role).
 *   3. Insights funnel + score distribution correctness on the fixture.
 *   4. Skill-gap computation correctness (deterministic % missing).
 *   5. Panel-feedback aggregate — correct avg score + pass rate, and NO
 *      panellist identity leaves the procedure.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// a903 namespace — RO-03 fixture ids (deterministic, afterAll-cleaned).
const NS = "a9030000-0000-0000-0000-0000000000";
const PERSON_A = `${NS}01`;
const PERSON_B = `${NS}02`;
const CAND_A = `${NS}11`;
const CAND_B = `${NS}12`;
const APP_A = `${NS}21`;
const APP_B = `${NS}22`;
const INTERVIEW = `${NS}31`;

const RUN = Date.now().toString(36);
const REQ_TITLE = `RO-03 Fixture Role ${RUN}`;
const DEPT = `RO-03 QA ${RUN}`;

let hmJwt: string;
let recruiterJwt: string;
let adminJwt: string;
let tenantId: string;
let reqId = "";
let positionId = "";
let jdVersionId = "";
let hmMembership = "";
let recruiterMembership = "";
let adminMembership = "";

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

interface Insights {
  scope: string;
  selectedRequisitionId: string | null;
  reqOptions: { id: string; title: string | null }[];
  kpis: {
    avgTimeToHireDays: number | null;
    fillRate: { hires: number; openings: number };
    activeCandidates: number;
    offerAcceptRate: { accepted: number; extended: number };
  };
  funnel: { stage: string; count: number; dropOffPct: number | null }[];
  scoreDistribution: { key: string; count: number }[];
  skillGap: {
    skillName: string;
    isRequired: boolean;
    gapPct: number;
    candidatesMissing: number;
    totalCandidates: number;
  }[];
  salaryBand: unknown;
  slaTiles: { stage: string; count: number }[];
  bottleneckNote: string | null;
  panelFeedbackTrends: {
    roundNumber: number;
    roundName: string;
    avgScore: number | null;
    passRate: number | null;
    submittedCount: number;
  }[];
}

describe("RO-03 — JD library, panel setup, insights", () => {
  beforeAll(async () => {
    [hmJwt, recruiterJwt, adminJwt] = await Promise.all([
      signIn(HIRING_MANAGER),
      signIn(RECRUITER),
      signIn(ADMIN),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    const members = await poolSql<{ id: string; email: string }[]>`
      SELECT tum.id::text AS id, au.email AS email
      FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE tum.tenant_id = ${tenantId}
        AND au.email IN (${HIRING_MANAGER}, ${RECRUITER}, ${ADMIN})
    `;
    hmMembership = members.find((m) => m.email === HIRING_MANAGER)!.id;
    recruiterMembership = members.find((m) => m.email === RECRUITER)!.id;
    adminMembership = members.find((m) => m.email === ADMIN)!.id;

    // reqA — created by the hiring manager (owned by hmMembership), with skills.
    const draft = await trpcMutation<{ requisitionId: string }>(
      "createRequisitionDraft",
      {
        title: REQ_TITLE,
        department: DEPT,
        locationType: "hybrid",
        primaryLocation: "Bengaluru",
        seniority: "Senior",
      },
      hmJwt,
    );
    assert.ok(!isErr(draft), `createRequisitionDraft: ${JSON.stringify(draft)}`);
    reqId = draft.result.data.requisitionId;
    const upd = await trpcMutation(
      "updateRequisitionDraft",
      {
        requisitionId: reqId,
        skills: [
          { skillName: "Go", weight: 1, isRequired: true },
          { skillName: "Kubernetes", weight: 0.8, isRequired: false },
        ],
      },
      hmJwt,
    );
    assert.ok(!isErr(upd), `updateRequisitionDraft: ${JSON.stringify(upd)}`);

    const [reqRow] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
      SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${reqId}
    `;
    positionId = reqRow!.position_id;
    jdVersionId = reqRow!.jd_version_id;

    // Candidates: A has Go+Kubernetes, B has Go but NOT Kubernetes.
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary)
      VALUES (${PERSON_A}, ${tenantId}, 'RO03 Candidate A', 'ro03a@example.test'),
             (${PERSON_B}, ${tenantId}, 'RO03 Candidate B', 'ro03b@example.test')
      ON CONFLICT (id) DO NOTHING
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, parsed_skills, years_of_experience)
      VALUES
        (${CAND_A}, ${tenantId}, ${PERSON_A}, 'referral',
         ${JSON.stringify({ skills: ["Go", "Kubernetes", "Docker"] })}::jsonb, 8),
        (${CAND_B}, ${tenantId}, ${PERSON_B}, 'career_site',
         ${JSON.stringify({ skills: ["Go", "Java"] })}::jsonb, 4)
      ON CONFLICT (id) DO NOTHING
    `;
    // Applications: A in tech_interview (score 88 → excellent), B in
    // recruiter_review (score 62 → partial).
    await poolSql`
      INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage, ai_score)
      VALUES
        (${APP_A}, ${tenantId}, ${CAND_A}, ${reqId}, 'referral', 'tech_interview', 88),
        (${APP_B}, ${tenantId}, ${CAND_B}, ${reqId}, 'career_site', 'recruiter_review', 62)
      ON CONFLICT (id) DO NOTHING
    `;
    // One completed interview on reqA round 1 with two submitted scorecards:
    // means 4 and 2 → avg 3.0; recommendations yes + no → pass rate 50%.
    await poolSql`
      INSERT INTO public.interviews
        (id, tenant_id, application_id, requisition_id, round_number, round_name, status, scorecard_template, mode, created_by_membership_id)
      VALUES
        (${INTERVIEW}, ${tenantId}, ${APP_A}, ${reqId}, 1, 'Technical round', 'completed', 'technical', 'video', ${hmMembership})
      ON CONFLICT (id) DO NOTHING
    `;
    await poolSql`
      INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
      VALUES (${tenantId}, ${INTERVIEW}, ${hmMembership}, true),
             (${tenantId}, ${INTERVIEW}, ${adminMembership}, false)
      ON CONFLICT DO NOTHING
    `;
    await poolSql`
      INSERT INTO public.interview_feedback
        (tenant_id, interview_id, membership_id, scorecard, recommendation, submitted_at)
      VALUES
        (${tenantId}, ${INTERVIEW}, ${hmMembership}, ${JSON.stringify({ a: 4, b: 4 })}::jsonb, 'yes', now()),
        (${tenantId}, ${INTERVIEW}, ${adminMembership}, ${JSON.stringify({ a: 2, b: 2 })}::jsonb, 'no', now())
      ON CONFLICT DO NOTHING
    `;
  }, 60_000);

  afterAll(async () => {
    try {
      await poolSql`DELETE FROM public.interview_feedback WHERE interview_id = ${INTERVIEW}`;
      await poolSql`DELETE FROM public.interview_panelists WHERE interview_id = ${INTERVIEW}`;
      await poolSql`DELETE FROM public.interviews WHERE id = ${INTERVIEW}`;
      await poolSql`DELETE FROM public.applications WHERE id IN (${APP_A}, ${APP_B})`;
      await poolSql`DELETE FROM public.candidates WHERE id IN (${CAND_A}, ${CAND_B})`;
      await poolSql`DELETE FROM public.persons WHERE id IN (${PERSON_A}, ${PERSON_B})`;
      if (reqId) {
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${reqId}`;
        await poolSql`DELETE FROM public.requisitions WHERE id = ${reqId}`;
      }
      if (jdVersionId) await poolSql`DELETE FROM public.jd_versions WHERE id = ${jdVersionId}`;
      if (positionId) await poolSql`DELETE FROM public.positions WHERE id = ${positionId}`;
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${tenantId} AND name = ${DEPT.trim()}`;
    } catch {
      // best-effort — leave residue for the groom sweep rather than fail.
    }
  });

  it("Test 1: role gating — recruiter FORBIDDEN, hiring_manager + admin allowed", async () => {
    const asRecruiter = await trpcQuery<Insights>("getRequisitionInsights", {}, recruiterJwt);
    assert.ok(isErr(asRecruiter), "recruiter should be denied");
    assert.equal(asRecruiter.error.data.code, "FORBIDDEN");

    const asHm = await trpcQuery<{ rows: unknown[] }>("listJdLibrary", { limit: 100 }, hmJwt);
    assert.ok(!isErr(asHm), `hiring_manager listJdLibrary: ${JSON.stringify(asHm)}`);
    const asAdmin = await trpcQuery<Insights>("getRequisitionInsights", {}, adminJwt);
    assert.ok(!isErr(asAdmin), `admin getRequisitionInsights: ${JSON.stringify(asAdmin)}`);
  });

  it("Test 2: JD library is scoped to my requisitions (other-HM excluded, admin sees all)", async () => {
    const mine = await trpcQuery<{ rows: { requisitionId: string }[] }>(
      "listJdLibrary",
      { limit: 200 },
      hmJwt,
    );
    assert.ok(!isErr(mine));
    assert.ok(
      mine.result.data.rows.some((r) => r.requisitionId === reqId),
      "hiring manager sees their own requisition",
    );

    // Reassign the requisition to a DIFFERENT membership (the recruiter's).
    await poolSql`UPDATE public.requisitions SET hiring_manager_id = ${recruiterMembership} WHERE id = ${reqId}`;
    try {
      const afterReassign = await trpcQuery<{ rows: { requisitionId: string }[] }>(
        "listJdLibrary",
        { limit: 200 },
        hmJwt,
      );
      assert.ok(!isErr(afterReassign));
      assert.ok(
        !afterReassign.result.data.rows.some((r) => r.requisitionId === reqId),
        "another HM's requisition is excluded for the hiring manager",
      );

      const asAdmin = await trpcQuery<{ rows: { requisitionId: string }[] }>(
        "listJdLibrary",
        { limit: 200 },
        adminJwt,
      );
      assert.ok(!isErr(asAdmin));
      assert.ok(
        asAdmin.result.data.rows.some((r) => r.requisitionId === reqId),
        "admin (super-role) sees every requisition in the tenant",
      );
    } finally {
      // Restore ownership so the insights tests run in scope for the HM.
      await poolSql`UPDATE public.requisitions SET hiring_manager_id = ${hmMembership} WHERE id = ${reqId}`;
    }
  });

  it("Test 3: insights funnel + score distribution correctness", async () => {
    const res = await trpcQuery<Insights>(
      "getRequisitionInsights",
      { requisitionId: reqId },
      hmJwt,
    );
    assert.ok(!isErr(res), `getRequisitionInsights: ${JSON.stringify(res)}`);
    const d = res.result.data;
    assert.equal(d.scope, "single");
    assert.equal(d.selectedRequisitionId, reqId);

    const byStage = Object.fromEntries(d.funnel.map((f) => [f.stage, f.count]));
    assert.equal(byStage.tech_interview, 1, "one candidate in tech_interview");
    assert.equal(byStage.recruiter_review, 1, "one candidate in recruiter_review");
    assert.equal(d.kpis.activeCandidates, 2, "both fixture candidates are active");

    const byBucket = Object.fromEntries(d.scoreDistribution.map((b) => [b.key, b.count]));
    assert.equal(byBucket.excellent, 1, "score 88 → excellent");
    assert.equal(byBucket.partial, 1, "score 62 → partial");
    assert.equal(byBucket.good, 0);
    assert.equal(byBucket.low, 0);
  });

  it("Test 4: skill-gap computation is deterministic and correct", async () => {
    const res = await trpcQuery<Insights>(
      "getRequisitionInsights",
      { requisitionId: reqId },
      hmJwt,
    );
    assert.ok(!isErr(res));
    const gaps = res.result.data.skillGap;
    const go = gaps.find((g) => g.skillName === "Go");
    const k8s = gaps.find((g) => g.skillName === "Kubernetes");
    assert.ok(go && k8s, "both JD skills are present in the gap analysis");
    assert.equal(go!.totalCandidates, 2, "two candidates with parsed skills");
    assert.equal(go!.candidatesMissing, 0, "both candidates have Go");
    assert.equal(go!.gapPct, 0);
    assert.equal(go!.isRequired, true, "Go is a must-have");
    assert.equal(k8s!.candidatesMissing, 1, "candidate B is missing Kubernetes");
    assert.equal(k8s!.gapPct, 50);
  });

  it("Test 5: panel-feedback aggregate is correct and leaks no panellist identity", async () => {
    const res = await trpcQuery<Insights>(
      "getRequisitionInsights",
      { requisitionId: reqId },
      hmJwt,
    );
    assert.ok(!isErr(res));
    const trends = res.result.data.panelFeedbackTrends;
    assert.equal(trends.length, 1, "one completed round with submitted feedback");
    const r = trends[0]!;
    assert.equal(r.roundNumber, 1);
    assert.equal(r.submittedCount, 2);
    assert.equal(r.avgScore, 3, "mean of (4, 2) scorecards = 3.0");
    assert.equal(r.passRate, 50, "1 of 2 recommendations is a pass");

    // No panellist identity: the shape carries only aggregate keys, and the
    // serialized round contains none of the seeded membership ids.
    assert.deepEqual(
      Object.keys(r).sort(),
      ["avgScore", "passRate", "roundName", "roundNumber", "submittedCount"],
      "panel trend exposes only aggregate keys — no membershipId / name",
    );
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(hmMembership), "no lead membership id leaked");
    assert.ok(!serialized.includes(adminMembership), "no panellist membership id leaked");
  });
});
