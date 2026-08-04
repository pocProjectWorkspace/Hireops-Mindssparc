/**
 * IRIS-B1 — pipeline / onboarding actions through the transactional assistant
 * (honesty test). Over real cloud-minted JWTs (the seeded personas):
 *
 *   Test 1 (HONESTY, happy path): as admin1, irisExecute(advance_application)
 *     moves a REAL seeded application's stage via the SAME gated procedure a
 *     recruiter uses (advanceApplication → transitionApplicationStage): a real
 *     application_state_transitions row is written, applications.current_stage
 *     changes, AND an assistant_actions provenance row (entity_type
 *     "application") is persisted, AND irisGetProvenance reads it back with
 *     assistant='iris' + the confirming user's id. No side write-path.
 *
 *   Test 2 (HONESTY, PER-ACTION gate fires THROUGH Iris — IRIS-B1.1): the Iris
 *     menu/preview/execute path is gated PER ACTION to the app-surface roles a
 *     human needs for that action. As recruiter1 (recruiter) advance/reject are
 *     ALLOWED (preview + a real execute) and appear in the recruiter's
 *     irisListActions, but create_requisition_jd is FORBIDDEN and absent from the
 *     recruiter's menu. As hiringmanager1 (hiring_manager) create_requisition_jd
 *     is present but reject_application is FORBIDDEN and absent from the menu.
 *     admin1 (super-role) sees + can preview everything. (NOTE: the underlying
 *     advance/reject transition has no role gate of its own — applications RLS is
 *     tenant-isolation FOR ALL — so the role gate that fires through Iris is this
 *     per-action menu/preview/execute gate, mirroring the app-surface roles.)
 *
 * The advance is a BACKWARD move (shortlisted → recruiter_review) on purpose:
 * backward transitions skip the forward-only gates (HR-round assessment,
 * candidate-field policy) that are unrelated to what this test proves, and
 * recruiter_review is not a candidate-visible stage so no email is enqueued.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / recruiter1). Seeds its own FK
 * chain and cleans it up (child-first) in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
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
const ADMIN = "admin1@mindssparc.com";
const RECRUITER = "recruiter1@mindssparc.com";
const HIRING_MANAGER = "hiringmanager1@mindssparc.com";
const TENANT_SLUG = "kyndryl-poc";

// Unique per run so a shared-DB rerun never collides.
const RUN = Date.now().toString(36);
const BU = randomUUID();
const POSITION = randomUUID();
const JD = randomUUID();
const REQ = randomUUID();
const PERSON = randomUUID();
const CANDIDATE = randomUUID();
const APPLICATION = randomUUID();

let adminJwt: string;
let recruiterJwt: string;
let hiringManagerJwt: string;
let adminUserId: string;
let tenantId: string;

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

async function cleanupChain(): Promise<void> {
  await poolSql`DELETE FROM public.assistant_actions WHERE tenant_id = ${tenantId} AND entity_id = ${APPLICATION}`;
  await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${APPLICATION}`;
  await poolSql`DELETE FROM public.applications WHERE id = ${APPLICATION}`;
  await poolSql`DELETE FROM public.candidates WHERE id = ${CANDIDATE}`;
  await poolSql`DELETE FROM public.persons WHERE id = ${PERSON}`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${BU}`;
}

interface IrisExecuteOutput {
  ok: true;
  entityType: string;
  entityId: string | null;
  resultSummary: string;
}
interface IrisProvenanceOutput {
  rows: {
    entityId: string;
    assistant: string;
    actionId: string;
    confirmedByUserId: string | null;
    createdAt: string;
  }[];
}

describe("IRIS-B1 pipeline actions through Iris (honesty)", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt, hiringManagerJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
    ]);
    adminUserId = decodeJwt(adminJwt).sub as string;
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    // A membership to hang the requisition off (any active member works).
    const [m] = await poolSql<{ id: string }[]>`
      SELECT tum.id
      FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE au.email = ${ADMIN} AND tum.tenant_id = ${tenantId}
      LIMIT 1
    `;
    if (!m) throw new Error(`admin membership for ${ADMIN} not found`);
    const membershipId = m.id;

    await cleanupChain();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${tenantId}, ${`IRIS-B1 BU ${RUN}`}, ${`iris-b1-bu-${RUN}`})`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${tenantId}, ${BU}, ${`IRIS-B1 Engineer ${RUN}`}, 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${tenantId}, ${POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${tenantId}, ${POSITION}, ${JD}, ${membershipId}, ${membershipId}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PERSON}, ${tenantId}, ${`IRIS-B1 Candidate ${RUN}`}, ${`iris-b1-${RUN}@example.com`}, ${`iris-b1-${RUN}@example.com`})
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${CANDIDATE}, ${tenantId}, ${PERSON}, 'career_site', 'v1')
    `;
    // Seed at shortlisted so the advance is a backward move (no forward gates).
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${APPLICATION}, ${tenantId}, ${CANDIDATE}, ${REQ}, 'career_site', 'shortlisted', now())
    `;
  });

  afterAll(async () => {
    try {
      await cleanupChain();
    } catch {
      // best-effort — leave residue for the groom sweep rather than fail.
    }
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1 (HONESTY): irisExecute(advance_application) moves a real application + persists provenance read back by irisGetProvenance", async () => {
    const exec = await trpcMutation<IrisExecuteOutput>(
      "irisExecute",
      {
        actionId: "advance_application",
        params: { applicationId: APPLICATION, targetStage: "recruiter_review" },
      },
      adminJwt,
    );
    assert.ok(!isErr(exec), `advance should succeed, got ${JSON.stringify(exec)}`);
    assert.equal(exec.result.data.ok, true);
    assert.equal(exec.result.data.entityType, "application");
    assert.equal(exec.result.data.entityId, APPLICATION, "provenance lands on the application");
    assert.ok(exec.result.data.resultSummary.length > 0, "resultSummary is non-empty");

    // The REAL application moved — the gated procedure ran, not a side path.
    const [appRow] = await poolSql<{ current_stage: string }[]>`
      SELECT current_stage FROM public.applications WHERE id = ${APPLICATION}
    `;
    assert.ok(appRow, "application row exists");
    assert.equal(appRow.current_stage, "recruiter_review", "current_stage was really updated");

    // A real transition row was written (shortlisted → recruiter_review).
    const [transition] = await poolSql<{ from_stage: string; to_stage: string }[]>`
      SELECT from_stage, to_stage
      FROM public.application_state_transitions
      WHERE application_id = ${APPLICATION}
      ORDER BY transitioned_at DESC
      LIMIT 1
    `;
    assert.ok(transition, "a real state-transition row exists");
    assert.equal(transition.from_stage, "shortlisted");
    assert.equal(transition.to_stage, "recruiter_review");

    // A provenance row was persisted, stamped iris + the confirming user, on
    // entity_type "application".
    const [prov] = await poolSql<
      { assistant: string; action_id: string; entity_type: string; confirmed_by_user_id: string }[]
    >`
      SELECT assistant, action_id, entity_type, confirmed_by_user_id
      FROM public.assistant_actions
      WHERE tenant_id = ${tenantId} AND entity_id = ${APPLICATION}
    `;
    assert.ok(prov, "assistant_actions provenance row exists");
    assert.equal(prov.assistant, "iris");
    assert.equal(prov.action_id, "advance_application");
    assert.equal(prov.entity_type, "application");
    assert.equal(prov.confirmed_by_user_id, adminUserId, "confirming user is the caller");

    // irisGetProvenance reads it back (RLS-scoped) for the "application" surface.
    const prv = await trpcQuery<IrisProvenanceOutput>(
      "irisGetProvenance",
      { entityType: "application", entityIds: [APPLICATION] },
      adminJwt,
    );
    assert.ok(!isErr(prv), `getProvenance should succeed, got ${JSON.stringify(prv)}`);
    assert.equal(prv.result.data.rows.length, 1, "exactly one provenance row read back");
    const p = prv.result.data.rows[0]!;
    assert.equal(p.entityId, APPLICATION);
    assert.equal(p.assistant, "iris");
    assert.equal(p.actionId, "advance_application");
    assert.equal(p.confirmedByUserId, adminUserId, "confirming user read back");
  });

  it("Test 2 (HONESTY): the PER-ACTION gate fires THROUGH Iris — recruiter runs pipeline actions but not requisition creation; hiring_manager is the mirror", async () => {
    // ── recruiter: advance/reject ALLOWED, create_requisition_jd FORBIDDEN ──

    // The recruiter's menu is role-appropriate: the pipeline/onboarding actions
    // appear; the requisition-creation action does NOT (per-action filtering, not
    // a blanket lockout).
    const recruiterList = await trpcQuery<{
      actions: { id: string; group: string; destructive: boolean; roles: string[] }[];
    }>("irisListActions", {}, recruiterJwt);
    assert.ok(!isErr(recruiterList), `recruiter can list, got ${JSON.stringify(recruiterList)}`);
    const recruiterIds = new Set(recruiterList.result.data.actions.map((a) => a.id));
    assert.ok(recruiterIds.has("advance_application"), "recruiter menu has advance_application");
    assert.ok(recruiterIds.has("reject_application"), "recruiter menu has reject_application");
    assert.ok(recruiterIds.has("open_onboarding_case"), "recruiter menu has open_onboarding_case");
    assert.ok(
      !recruiterIds.has("create_requisition_jd"),
      "recruiter menu OMITS create_requisition_jd",
    );

    // recruiter CAN preview reject_application (the gate opens for this action).
    const recruiterRejectPreview = await trpcQuery<{ summary: string; details: string[] }>(
      "irisPreview",
      {
        actionId: "reject_application",
        params: { applicationId: APPLICATION, reason: "not a fit" },
      },
      recruiterJwt,
    );
    assert.ok(
      !isErr(recruiterRejectPreview),
      `recruiter reject preview allowed, got ${JSON.stringify(recruiterRejectPreview)}`,
    );
    assert.ok(
      recruiterRejectPreview.result.data.summary.length > 0,
      "reject preview has a summary",
    );

    // recruiter CAN preview advance_application too.
    const recruiterAdvancePreview = await trpcQuery<{ summary: string; details: string[] }>(
      "irisPreview",
      {
        actionId: "advance_application",
        params: { applicationId: APPLICATION, targetStage: "ai_screening" },
      },
      recruiterJwt,
    );
    assert.ok(
      !isErr(recruiterAdvancePreview),
      `recruiter advance preview allowed, got ${JSON.stringify(recruiterAdvancePreview)}`,
    );

    // recruiter CAN irisExecute advance_application — a REAL backward move
    // (recruiter_review → ai_screening; backward skips forward-only gates). This
    // proves the gate opens for the write path, not just the preview.
    const recruiterAdvance = await trpcMutation<IrisExecuteOutput>(
      "irisExecute",
      {
        actionId: "advance_application",
        params: { applicationId: APPLICATION, targetStage: "ai_screening" },
      },
      recruiterJwt,
    );
    assert.ok(
      !isErr(recruiterAdvance),
      `recruiter advance execute allowed, got ${JSON.stringify(recruiterAdvance)}`,
    );
    assert.equal(recruiterAdvance.result.data.entityType, "application");
    const [movedRow] = await poolSql<{ current_stage: string }[]>`
      SELECT current_stage FROM public.applications WHERE id = ${APPLICATION}
    `;
    assert.equal(movedRow?.current_stage, "ai_screening", "recruiter's advance really moved it");

    // recruiter CANNOT preview create_requisition_jd — FORBIDDEN on that action.
    const recruiterCreatePreview = await trpcQuery(
      "irisPreview",
      { actionId: "create_requisition_jd", params: { title: "Staff Eng", locationType: "remote" } },
      recruiterJwt,
    );
    assert.ok(
      isErr(recruiterCreatePreview) && recruiterCreatePreview.error.data.code === "FORBIDDEN",
      `recruiter create_requisition_jd preview forbidden, got ${JSON.stringify(recruiterCreatePreview)}`,
    );

    // recruiter CANNOT execute create_requisition_jd either — FORBIDDEN before commit.
    const recruiterCreateExec = await trpcMutation(
      "irisExecute",
      { actionId: "create_requisition_jd", params: { title: "Staff Eng", locationType: "remote" } },
      recruiterJwt,
    );
    assert.ok(
      isErr(recruiterCreateExec) && recruiterCreateExec.error.data.code === "FORBIDDEN",
      `recruiter create_requisition_jd execute forbidden, got ${JSON.stringify(recruiterCreateExec)}`,
    );

    // ── hiring_manager: the mirror — create_requisition_jd yes, reject no ──
    const hmList = await trpcQuery<{
      actions: { id: string }[];
    }>("irisListActions", {}, hiringManagerJwt);
    assert.ok(!isErr(hmList), `hiring_manager can list, got ${JSON.stringify(hmList)}`);
    const hmIds = new Set(hmList.result.data.actions.map((a) => a.id));
    assert.ok(hmIds.has("create_requisition_jd"), "hiring_manager menu has create_requisition_jd");
    assert.ok(!hmIds.has("reject_application"), "hiring_manager menu OMITS reject_application");
    assert.ok(!hmIds.has("advance_application"), "hiring_manager menu OMITS advance_application");

    // hiring_manager CANNOT preview reject_application — FORBIDDEN on that action.
    const hmRejectPreview = await trpcQuery(
      "irisPreview",
      { actionId: "reject_application", params: { applicationId: APPLICATION, reason: "no" } },
      hiringManagerJwt,
    );
    assert.ok(
      isErr(hmRejectPreview) && hmRejectPreview.error.data.code === "FORBIDDEN",
      `hiring_manager reject preview forbidden, got ${JSON.stringify(hmRejectPreview)}`,
    );

    // ── admin (super-role): sees + can preview everything ──
    const adminPreview = await trpcQuery<{ summary: string; details: string[] }>(
      "irisPreview",
      {
        actionId: "reject_application",
        params: { applicationId: APPLICATION, reason: "Salary expectations out of band" },
      },
      adminJwt,
    );
    assert.ok(!isErr(adminPreview), `admin reject preview ok, got ${JSON.stringify(adminPreview)}`);
    assert.ok(adminPreview.result.data.summary.length > 0, "reject preview has a summary");
    assert.ok(
      adminPreview.result.data.details.join(" ").includes("Salary expectations out of band"),
      "reject preview names the reason",
    );

    // admin's menu carries all four actions (super-role).
    const adminList = await trpcQuery<{
      actions: { id: string; group: string; destructive: boolean }[];
    }>("irisListActions", {}, adminJwt);
    assert.ok(!isErr(adminList), `admin can list, got ${JSON.stringify(adminList)}`);
    const byId = new Map(adminList.result.data.actions.map((a) => [a.id, a]));
    assert.ok(byId.has("advance_application"), "menu contains advance_application");
    assert.ok(byId.has("reject_application"), "menu contains reject_application");
    assert.ok(byId.has("open_onboarding_case"), "menu contains open_onboarding_case");
    assert.ok(byId.has("create_requisition_jd"), "menu contains create_requisition_jd");
    assert.equal(byId.get("reject_application")!.destructive, true, "reject flagged destructive");
    assert.equal(byId.get("advance_application")!.destructive, false);
  });

  it("Test 3 (IRIS-B1.1): irisSearchApplications is gated to the pipeline personas and returns the seeded application", async () => {
    // recruiter (a pipeline persona) CAN search and finds the seeded candidate.
    const recruiterSearch = await trpcQuery<{
      rows: {
        applicationId: string;
        candidateId: string;
        candidateName: string | null;
        positionTitle: string | null;
        currentStage: string;
      }[];
    }>("irisSearchApplications", { query: `IRIS-B1 Candidate ${RUN}` }, recruiterJwt);
    assert.ok(
      !isErr(recruiterSearch),
      `recruiter search allowed, got ${JSON.stringify(recruiterSearch)}`,
    );
    const hit = recruiterSearch.result.data.rows.find((r) => r.applicationId === APPLICATION);
    assert.ok(hit, "recruiter search returns the seeded application");
    assert.equal(hit!.candidateId, CANDIDATE, "row carries the candidate id for deep-linking");
    assert.ok(
      (hit!.candidateName ?? "").includes(`IRIS-B1 Candidate ${RUN}`),
      "row carries the candidate name",
    );
    assert.ok(
      (hit!.positionTitle ?? "").includes(`IRIS-B1 Engineer ${RUN}`),
      "row carries the position title",
    );

    // hr_ops (an onboarding persona, NOT in listCandidates' triage read set) can
    // also use the picker read — the whole point of the purpose-built gate.
    const hrOpsJwt = await signIn("hr_ops1@mindssparc.com");
    const hrOpsSearch = await trpcQuery("irisSearchApplications", { query: "" }, hrOpsJwt);
    assert.ok(!isErr(hrOpsSearch), `hr_ops search allowed, got ${JSON.stringify(hrOpsSearch)}`);
  });
});
