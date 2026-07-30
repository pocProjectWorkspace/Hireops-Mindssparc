/**
 * Iris Tier-A contextual actions — request_documents / request_offer_approval /
 * cancel_interview through the transactional assistant (honesty test). Over real
 * cloud-minted JWTs (the seeded personas):
 *
 *   Test 1 (request_documents, HONESTY): as admin1 (HR_OPS_DOC_ROLES),
 *     irisExecute(request_documents) on a REAL seeded application runs the SAME
 *     gated `requestApplicationDocuments` procedure an HR-ops user uses by hand →
 *     a REAL application_documents 'requested' row is inserted per document type,
 *     AND an assistant_actions provenance row (entity_type 'application') is
 *     persisted + read back by irisGetProvenance. No side write-path.
 *
 *   Test 2 (request_documents gate, IRIS-B1.1): a role WITHOUT HR_OPS_DOC_ROLES
 *     (recruiter1) is FORBIDDEN on BOTH irisPreview and irisExecute for
 *     request_documents, and the action is absent from its Iris menu.
 *
 *   Test 3 (cancel_interview, HONESTY): as admin1 (INTERVIEW_MANAGE_ROLES),
 *     irisExecute(cancel_interview) on a REAL seeded scheduled interview runs the
 *     SAME gated `cancelInterview` procedure → the interview really flips to
 *     'cancelled', AND an assistant_actions provenance row (entity_type
 *     'interview') is persisted + read back by irisGetProvenance.
 *
 *   Test 4 (cancel_interview gate, IRIS-B1.1): a role WITHOUT INTERVIEW_MANAGE_ROLES
 *     (hr_ops1) is FORBIDDEN on BOTH irisPreview and irisExecute for
 *     cancel_interview, and the action is absent from its Iris menu.
 *
 *   Test 5 (request_offer_approval gate + menu, IRIS-B1.1): a role WITHOUT
 *     COMP_DESK_ROLES (recruiter1) is FORBIDDEN on preview + execute; admin1 sees
 *     it in its menu (group "Offers") and can preview it. The FULL offer-chain
 *     effect (a real approval_request routed) is DEFERRED here — seeding an
 *     above-band offer chain is heavy; the registry + preview/gate honesty is
 *     covered and the effect path is exercised by the comp-desk suites.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / recruiter1 / hr_ops1). Seeds its
 * own FK chain (incl. a run-unique document_type + a scheduled interview) and
 * cleans it up (child-first) in afterAll.
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
const ADMIN = "admin1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HR_OPS = "hr_ops1@kyndryl-poc.test";
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
const INTERVIEW = randomUUID();
const DOC_TYPE = randomUUID();
// A syntactically-valid offer id for the request_offer_approval gate/preview
// checks (buildPreview is read-only; no offer row is touched by those paths).
const FAKE_OFFER = randomUUID();

let adminJwt: string;
let recruiterJwt: string;
let hrOpsJwt: string;
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
  await poolSql`DELETE FROM public.assistant_actions WHERE tenant_id = ${tenantId} AND entity_id IN (${APPLICATION}, ${INTERVIEW})`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${tenantId} AND recipient_candidate_id = ${CANDIDATE}`;
  await poolSql`DELETE FROM public.application_documents WHERE tenant_id = ${tenantId} AND application_id = ${APPLICATION}`;
  await poolSql`DELETE FROM public.interviews WHERE id = ${INTERVIEW}`;
  await poolSql`DELETE FROM public.applications WHERE id = ${APPLICATION}`;
  await poolSql`DELETE FROM public.candidates WHERE id = ${CANDIDATE}`;
  await poolSql`DELETE FROM public.persons WHERE id = ${PERSON}`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${BU}`;
  await poolSql`DELETE FROM public.document_types WHERE id = ${DOC_TYPE}`;
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

describe("Iris Tier-A contextual actions through Iris (honesty)", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt, hrOpsJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(RECRUITER),
      signIn(HR_OPS),
    ]);
    adminUserId = decodeJwt(adminJwt).sub as string;
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    // A membership to hang the requisition + interview off (any active member works).
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
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${tenantId}, ${`IRIS-TIERA BU ${RUN}`}, ${`iris-tiera-bu-${RUN}`})`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${tenantId}, ${BU}, ${`IRIS-TIERA Engineer ${RUN}`}, 'remote', true)
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
      VALUES (${PERSON}, ${tenantId}, ${`IRIS-TIERA Candidate ${RUN}`}, ${`iris-tiera-${RUN}@example.com`}, ${`iris-tiera-${RUN}@example.com`})
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${CANDIDATE}, ${tenantId}, ${PERSON}, 'career_site', 'v1')
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${APPLICATION}, ${tenantId}, ${CANDIDATE}, ${REQ}, 'career_site', 'tech_interview', now())
    `;
    // A run-unique document type for the request_documents happy path — the
    // tenant-agnostic reference catalogue listRequestableDocumentTypes reads.
    await poolSql`
      INSERT INTO public.document_types (id, code, name, geography_code)
      VALUES (${DOC_TYPE}, ${`iris_tiera_passport_${RUN}`}, ${`IRIS-TIERA Passport ${RUN}`}, 'IN')
    `;
    // A REAL scheduled interview for the cancel_interview happy path.
    await poolSql`
      INSERT INTO public.interviews
        (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
         scheduled_start, scheduled_end, duration_minutes, mode, created_by_membership_id)
      VALUES (${INTERVIEW}, ${tenantId}, ${APPLICATION}, ${REQ}, 1, 'Technical Screen', 'scheduled',
         now() + interval '30 days', now() + interval '30 days' + interval '60 minutes', 60, 'video', ${membershipId})
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

  it("Test 1 (request_documents HONESTY): irisExecute inserts a REAL application_documents 'requested' row + persists provenance read back by irisGetProvenance", async () => {
    const exec = await trpcMutation<IrisExecuteOutput>(
      "irisExecute",
      {
        actionId: "request_documents",
        params: { applicationId: APPLICATION, documentTypeIds: [DOC_TYPE] },
      },
      adminJwt,
    );
    assert.ok(!isErr(exec), `request_documents should succeed, got ${JSON.stringify(exec)}`);
    assert.equal(exec.result.data.ok, true);
    assert.equal(exec.result.data.entityType, "application");
    assert.equal(exec.result.data.entityId, APPLICATION, "provenance lands on the application");
    assert.ok(exec.result.data.resultSummary.length > 0, "resultSummary is non-empty");

    // A REAL application_documents row was inserted for this type, status 'requested'.
    const [doc] = await poolSql<{ status: string; document_type_id: string }[]>`
      SELECT status, document_type_id
      FROM public.application_documents
      WHERE tenant_id = ${tenantId} AND application_id = ${APPLICATION} AND document_type_id = ${DOC_TYPE}
      LIMIT 1
    `;
    assert.ok(doc, "a real application_documents row was inserted");
    assert.equal(doc.status, "requested", "the document is in 'requested' state");

    // A provenance row was persisted, stamped iris + the confirming user, on
    // entity_type "application".
    const [prov] = await poolSql<
      { assistant: string; action_id: string; entity_type: string; confirmed_by_user_id: string }[]
    >`
      SELECT assistant, action_id, entity_type, confirmed_by_user_id
      FROM public.assistant_actions
      WHERE tenant_id = ${tenantId} AND entity_id = ${APPLICATION} AND action_id = 'request_documents'
    `;
    assert.ok(prov, "assistant_actions provenance row exists for the request");
    assert.equal(prov.assistant, "iris");
    assert.equal(prov.action_id, "request_documents");
    assert.equal(prov.entity_type, "application");
    assert.equal(prov.confirmed_by_user_id, adminUserId, "confirming user is the caller");

    // irisGetProvenance reads it back (RLS-scoped) for the "application" surface.
    const prv = await trpcQuery<IrisProvenanceOutput>(
      "irisGetProvenance",
      { entityType: "application", entityIds: [APPLICATION] },
      adminJwt,
    );
    assert.ok(!isErr(prv), `getProvenance should succeed, got ${JSON.stringify(prv)}`);
    const p = prv.result.data.rows.find((r) => r.actionId === "request_documents");
    assert.ok(p, "the request_documents provenance row is read back");
    assert.equal(p!.assistant, "iris");
    assert.equal(p!.confirmedByUserId, adminUserId, "confirming user read back");
  });

  it("Test 2 (request_documents gate, IRIS-B1.1): recruiter1 is FORBIDDEN on preview + execute, and the action is absent from its menu", async () => {
    // recruiter1 is NOT in HR_OPS_DOC_ROLES (admin / hr_ops). Its menu OMITS it.
    const recList = await trpcQuery<{ actions: { id: string }[] }>(
      "irisListActions",
      {},
      recruiterJwt,
    );
    assert.ok(!isErr(recList), `recruiter can list, got ${JSON.stringify(recList)}`);
    const recIds = new Set(recList.result.data.actions.map((a) => a.id));
    assert.ok(!recIds.has("request_documents"), "recruiter menu OMITS request_documents");

    const recPreview = await trpcQuery(
      "irisPreview",
      {
        actionId: "request_documents",
        params: { applicationId: APPLICATION, documentTypeIds: [DOC_TYPE] },
      },
      recruiterJwt,
    );
    assert.ok(
      isErr(recPreview) && recPreview.error.data.code === "FORBIDDEN",
      `recruiter request_documents preview forbidden, got ${JSON.stringify(recPreview)}`,
    );

    const recExec = await trpcMutation(
      "irisExecute",
      {
        actionId: "request_documents",
        params: { applicationId: APPLICATION, documentTypeIds: [DOC_TYPE] },
      },
      recruiterJwt,
    );
    assert.ok(
      isErr(recExec) && recExec.error.data.code === "FORBIDDEN",
      `recruiter request_documents execute forbidden, got ${JSON.stringify(recExec)}`,
    );
  });

  it("Test 3 (cancel_interview HONESTY): irisExecute really flips the interview to 'cancelled' + persists provenance read back by irisGetProvenance", async () => {
    const REASON = `Panel unavailable ${RUN}`;
    const exec = await trpcMutation<IrisExecuteOutput>(
      "irisExecute",
      { actionId: "cancel_interview", params: { interviewId: INTERVIEW, reason: REASON } },
      adminJwt,
    );
    assert.ok(!isErr(exec), `cancel_interview should succeed, got ${JSON.stringify(exec)}`);
    assert.equal(exec.result.data.ok, true);
    assert.equal(exec.result.data.entityType, "interview");
    assert.equal(exec.result.data.entityId, INTERVIEW, "provenance lands on the interview");
    assert.ok(exec.result.data.resultSummary.length > 0, "resultSummary is non-empty");

    // The REAL interview flipped to 'cancelled' — the gated procedure ran.
    const [row] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.interviews WHERE id = ${INTERVIEW}
    `;
    assert.equal(row?.status, "cancelled", "interview status really flipped to cancelled");

    // A provenance row was persisted, stamped iris + the confirming user, on
    // entity_type "interview".
    const [prov] = await poolSql<
      { assistant: string; action_id: string; entity_type: string; confirmed_by_user_id: string }[]
    >`
      SELECT assistant, action_id, entity_type, confirmed_by_user_id
      FROM public.assistant_actions
      WHERE tenant_id = ${tenantId} AND entity_id = ${INTERVIEW} AND action_id = 'cancel_interview'
    `;
    assert.ok(prov, "assistant_actions provenance row exists for the cancel");
    assert.equal(prov.assistant, "iris");
    assert.equal(prov.action_id, "cancel_interview");
    assert.equal(prov.entity_type, "interview");
    assert.equal(prov.confirmed_by_user_id, adminUserId, "confirming user is the caller");

    // irisGetProvenance reads it back (RLS-scoped) for the "interview" surface.
    const prv = await trpcQuery<IrisProvenanceOutput>(
      "irisGetProvenance",
      { entityType: "interview", entityIds: [INTERVIEW] },
      adminJwt,
    );
    assert.ok(!isErr(prv), `getProvenance should succeed, got ${JSON.stringify(prv)}`);
    const p = prv.result.data.rows.find((r) => r.entityId === INTERVIEW);
    assert.ok(p, "the interview's provenance row is read back");
    assert.equal(p!.assistant, "iris");
    assert.equal(p!.actionId, "cancel_interview");
    assert.equal(p!.confirmedByUserId, adminUserId, "confirming user read back");
  });

  it("Test 4 (cancel_interview gate, IRIS-B1.1): hr_ops1 is FORBIDDEN on preview + execute, and the action is absent from its menu", async () => {
    // hr_ops1 is NOT in INTERVIEW_MANAGE_ROLES (admin / hiring_manager / recruiter).
    const hrList = await trpcQuery<{ actions: { id: string }[] }>("irisListActions", {}, hrOpsJwt);
    assert.ok(!isErr(hrList), `hr_ops can list, got ${JSON.stringify(hrList)}`);
    const hrIds = new Set(hrList.result.data.actions.map((a) => a.id));
    assert.ok(!hrIds.has("cancel_interview"), "hr_ops menu OMITS cancel_interview");

    const hrPreview = await trpcQuery(
      "irisPreview",
      { actionId: "cancel_interview", params: { interviewId: INTERVIEW, reason: "nope" } },
      hrOpsJwt,
    );
    assert.ok(
      isErr(hrPreview) && hrPreview.error.data.code === "FORBIDDEN",
      `hr_ops cancel_interview preview forbidden, got ${JSON.stringify(hrPreview)}`,
    );

    const hrExec = await trpcMutation(
      "irisExecute",
      { actionId: "cancel_interview", params: { interviewId: INTERVIEW, reason: "nope" } },
      hrOpsJwt,
    );
    assert.ok(
      isErr(hrExec) && hrExec.error.data.code === "FORBIDDEN",
      `hr_ops cancel_interview execute forbidden, got ${JSON.stringify(hrExec)}`,
    );
  });

  it("Test 5 (request_offer_approval gate + menu, IRIS-B1.1): recruiter1 FORBIDDEN on preview + execute; admin1 sees it (group Offers) and can preview it", async () => {
    // recruiter1 is NOT in COMP_DESK_ROLES (admin / hr_ops). Its menu OMITS it.
    const recList = await trpcQuery<{ actions: { id: string }[] }>(
      "irisListActions",
      {},
      recruiterJwt,
    );
    assert.ok(!isErr(recList), `recruiter can list, got ${JSON.stringify(recList)}`);
    const recIds = new Set(recList.result.data.actions.map((a) => a.id));
    assert.ok(!recIds.has("request_offer_approval"), "recruiter menu OMITS request_offer_approval");

    const recPreview = await trpcQuery(
      "irisPreview",
      { actionId: "request_offer_approval", params: { offerId: FAKE_OFFER } },
      recruiterJwt,
    );
    assert.ok(
      isErr(recPreview) && recPreview.error.data.code === "FORBIDDEN",
      `recruiter request_offer_approval preview forbidden, got ${JSON.stringify(recPreview)}`,
    );

    const recExec = await trpcMutation(
      "irisExecute",
      { actionId: "request_offer_approval", params: { offerId: FAKE_OFFER } },
      recruiterJwt,
    );
    assert.ok(
      isErr(recExec) && recExec.error.data.code === "FORBIDDEN",
      `recruiter request_offer_approval execute forbidden, got ${JSON.stringify(recExec)}`,
    );

    // admin (COMP_DESK_ROLES): the action is present in its menu, group "Offers",
    // and previewable (buildPreview is read-only — no offer row is touched).
    const adminList = await trpcQuery<{ actions: { id: string; group: string }[] }>(
      "irisListActions",
      {},
      adminJwt,
    );
    assert.ok(!isErr(adminList), `admin can list, got ${JSON.stringify(adminList)}`);
    const adminEntry = adminList.result.data.actions.find((a) => a.id === "request_offer_approval");
    assert.ok(adminEntry, "admin menu contains request_offer_approval");
    assert.equal(adminEntry!.group, "Offers", "request_offer_approval is in the Offers group");

    const adminPreview = await trpcQuery<{ summary: string; details: string[] }>(
      "irisPreview",
      { actionId: "request_offer_approval", params: { offerId: FAKE_OFFER } },
      adminJwt,
    );
    assert.ok(!isErr(adminPreview), `admin preview ok, got ${JSON.stringify(adminPreview)}`);
    assert.ok(adminPreview.result.data.summary.length > 0, "preview has a summary");
    assert.ok(
      adminPreview.result.data.summary.toLowerCase().includes("approval"),
      "preview summary names approval",
    );
  });
});
