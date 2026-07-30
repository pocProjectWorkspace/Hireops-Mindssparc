/**
 * Iris Requisitions — hold_requisition / resume_requisition through the
 * transactional assistant (honesty test). Over real cloud-minted JWTs (the
 * seeded personas):
 *
 *   Test 1 (guards, server-side): the ONLY two transitions are enforced. Holding
 *     a `draft` requisition is a BAD_REQUEST ("Only an approved or posted…"), and
 *     resuming a requisition that is NOT on hold is a BAD_REQUEST ("Only a
 *     requisition on hold can be resumed.") — both THROUGH Iris.
 *
 *   Test 2 (HONESTY, happy path): as admin1, irisExecute(hold_requisition) flips a
 *     REAL seeded requisition (posted → on_hold) via the SAME gated procedure a
 *     recruiter uses (setRequisitionHold), stores reason_for_hold, AND persists an
 *     assistant_actions provenance row (entity_type "requisition") read back by
 *     irisGetProvenance. Then irisExecute(resume_requisition) flips it back to
 *     `posted` (the seeded req has a non-null public_slug → it was live) and clears
 *     reason_for_hold. No side write-path.
 *
 *   Test 3 (HONESTY, PER-ACTION gate fires THROUGH Iris — IRIS-B1.1): a persona
 *     WITHOUT REQUISITION_POST_ROLES (hr_ops1) is FORBIDDEN on hold_requisition /
 *     resume_requisition (preview + execute) and both are absent from its menu,
 *     while admin1 (in the set) sees them.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / hr_ops1). Seeds its own FK chain
 * and cleans it up (child-first) in afterAll; restores no external state (the
 * requisition is created + dropped by this test).
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
const HR_OPS = "hr_ops1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// Unique per run so a shared-DB rerun never collides.
const RUN = Date.now().toString(36);
const BU = randomUUID();
const POSITION = randomUUID();
const JD = randomUUID();
const REQ = randomUUID();

let adminJwt: string;
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
  await poolSql`DELETE FROM public.assistant_actions WHERE tenant_id = ${tenantId} AND entity_id = ${REQ}`;
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

describe("Iris requisition hold / resume through Iris (honesty)", () => {
  beforeAll(async () => {
    [adminJwt, hrOpsJwt] = await Promise.all([signIn(ADMIN), signIn(HR_OPS)]);
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
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${tenantId}, ${`IRIS-HOLD BU ${RUN}`}, ${`iris-hold-bu-${RUN}`})`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${tenantId}, ${BU}, ${`IRIS-HOLD Engineer ${RUN}`}, 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${tenantId}, ${POSITION}, 1, '# JD', 'approved')
    `;
    // Seed at `posted` (public_slug defaults to a non-null value), so resume flips
    // it back to `posted` per the posted_at rule — a genuinely live req has
    // posted_at set (public_slug is NOT NULL for every req, so posted_at is the
    // real "was it live" signal the resume transition keys off).
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, posted_at)
      VALUES (${REQ}, ${tenantId}, ${POSITION}, ${JD}, ${membershipId}, ${membershipId}, 'posted', now())
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

  it("Test 1 (guards): only approved/posted → hold, only on_hold → resume, enforced THROUGH Iris", async () => {
    // Holding a DRAFT requisition is rejected (temporarily flip to draft, attempt,
    // restore). The reason is valid so the failure is the STATUS rule, not schema.
    await poolSql`UPDATE public.requisitions SET status = 'draft' WHERE id = ${REQ}`;
    const holdDraft = await trpcMutation(
      "irisExecute",
      { actionId: "hold_requisition", params: { requisitionId: REQ, reason: "budget freeze" } },
      adminJwt,
    );
    assert.ok(
      isErr(holdDraft) && holdDraft.error.data.code === "BAD_REQUEST",
      `holding a draft req is BAD_REQUEST, got ${JSON.stringify(holdDraft)}`,
    );
    // Restore to posted for the rest of the suite.
    await poolSql`UPDATE public.requisitions SET status = 'posted' WHERE id = ${REQ}`;

    // Resuming a requisition that is NOT on hold (it's posted) is rejected.
    const resumeNotHeld = await trpcMutation(
      "irisExecute",
      { actionId: "resume_requisition", params: { requisitionId: REQ } },
      adminJwt,
    );
    assert.ok(
      isErr(resumeNotHeld) && resumeNotHeld.error.data.code === "BAD_REQUEST",
      `resuming a non-held req is BAD_REQUEST, got ${JSON.stringify(resumeNotHeld)}`,
    );

    // The requisition is untouched by the rejected attempts.
    const [row] = await poolSql<{ status: string; reason_for_hold: string | null }[]>`
      SELECT status, reason_for_hold FROM public.requisitions WHERE id = ${REQ}
    `;
    assert.equal(row?.status, "posted", "req still posted after rejected transitions");
    assert.equal(row?.reason_for_hold, null, "no hold reason written by rejected attempts");
  });

  it("Test 2 (HONESTY): hold flips posted → on_hold with a reason + provenance; resume flips it back to posted and clears the reason", async () => {
    const REASON = `On hold for budget review ${RUN}`;
    const hold = await trpcMutation<IrisExecuteOutput>(
      "irisExecute",
      { actionId: "hold_requisition", params: { requisitionId: REQ, reason: REASON } },
      adminJwt,
    );
    assert.ok(!isErr(hold), `hold should succeed, got ${JSON.stringify(hold)}`);
    assert.equal(hold.result.data.ok, true);
    assert.equal(hold.result.data.entityType, "requisition");
    assert.equal(hold.result.data.entityId, REQ, "provenance lands on the requisition");
    assert.ok(hold.result.data.resultSummary.length > 0, "resultSummary is non-empty");

    // The REAL requisition moved to on_hold and stored the reason — the gated
    // procedure ran, not a side path.
    const [heldRow] = await poolSql<{ status: string; reason_for_hold: string | null }[]>`
      SELECT status, reason_for_hold FROM public.requisitions WHERE id = ${REQ}
    `;
    assert.equal(heldRow?.status, "on_hold", "status really flipped to on_hold");
    assert.equal(heldRow?.reason_for_hold, REASON, "reason_for_hold really stored");

    // A provenance row was persisted, stamped iris + the confirming user, on
    // entity_type "requisition".
    const [prov] = await poolSql<
      { assistant: string; action_id: string; entity_type: string; confirmed_by_user_id: string }[]
    >`
      SELECT assistant, action_id, entity_type, confirmed_by_user_id
      FROM public.assistant_actions
      WHERE tenant_id = ${tenantId} AND entity_id = ${REQ} AND action_id = 'hold_requisition'
    `;
    assert.ok(prov, "assistant_actions provenance row exists for the hold");
    assert.equal(prov.assistant, "iris");
    assert.equal(prov.action_id, "hold_requisition");
    assert.equal(prov.entity_type, "requisition");
    assert.equal(prov.confirmed_by_user_id, adminUserId, "confirming user is the caller");

    // irisGetProvenance reads it back (RLS-scoped) for the "requisition" surface.
    const prv = await trpcQuery<IrisProvenanceOutput>(
      "irisGetProvenance",
      { entityType: "requisition", entityIds: [REQ] },
      adminJwt,
    );
    assert.ok(!isErr(prv), `getProvenance should succeed, got ${JSON.stringify(prv)}`);
    const p = prv.result.data.rows.find((r) => r.entityId === REQ);
    assert.ok(p, "the requisition's provenance row is read back");
    assert.equal(p!.assistant, "iris");
    assert.equal(p!.actionId, "hold_requisition");
    assert.equal(p!.confirmedByUserId, adminUserId, "confirming user read back");

    // ── resume — back to posted (the seeded req has a non-null public_slug) ──
    const resume = await trpcMutation<IrisExecuteOutput>(
      "irisExecute",
      { actionId: "resume_requisition", params: { requisitionId: REQ } },
      adminJwt,
    );
    assert.ok(!isErr(resume), `resume should succeed, got ${JSON.stringify(resume)}`);
    assert.equal(resume.result.data.entityType, "requisition");
    assert.equal(resume.result.data.entityId, REQ);

    const [resumedRow] = await poolSql<{ status: string; reason_for_hold: string | null }[]>`
      SELECT status, reason_for_hold FROM public.requisitions WHERE id = ${REQ}
    `;
    assert.equal(resumedRow?.status, "posted", "resume returns it to posted (was live)");
    assert.equal(resumedRow?.reason_for_hold, null, "reason_for_hold cleared on resume");

    // The latest provenance on the requisition is now the resume.
    const prvAfter = await trpcQuery<IrisProvenanceOutput>(
      "irisGetProvenance",
      { entityType: "requisition", entityIds: [REQ] },
      adminJwt,
    );
    assert.ok(!isErr(prvAfter), `getProvenance ok, got ${JSON.stringify(prvAfter)}`);
    const latest = prvAfter.result.data.rows.find((r) => r.entityId === REQ);
    assert.ok(latest, "provenance read back after resume");
    assert.equal(latest!.actionId, "resume_requisition", "latest provenance is the resume");
  });

  it("Test 3 (IRIS-B1.1): a persona WITHOUT REQUISITION_POST_ROLES is FORBIDDEN on hold/resume through Iris", async () => {
    // hr_ops1 is NOT in REQUISITION_POST_ROLES (admin / hiring_manager / recruiter).
    // Its Iris menu OMITS both lifecycle actions.
    const hrOpsList = await trpcQuery<{ actions: { id: string }[] }>(
      "irisListActions",
      {},
      hrOpsJwt,
    );
    assert.ok(!isErr(hrOpsList), `hr_ops can list, got ${JSON.stringify(hrOpsList)}`);
    const hrOpsIds = new Set(hrOpsList.result.data.actions.map((a) => a.id));
    assert.ok(!hrOpsIds.has("hold_requisition"), "hr_ops menu OMITS hold_requisition");
    assert.ok(!hrOpsIds.has("resume_requisition"), "hr_ops menu OMITS resume_requisition");

    // hr_ops CANNOT preview hold_requisition — FORBIDDEN on that action.
    const hrOpsHoldPreview = await trpcQuery(
      "irisPreview",
      { actionId: "hold_requisition", params: { requisitionId: REQ, reason: "no" } },
      hrOpsJwt,
    );
    assert.ok(
      isErr(hrOpsHoldPreview) && hrOpsHoldPreview.error.data.code === "FORBIDDEN",
      `hr_ops hold preview forbidden, got ${JSON.stringify(hrOpsHoldPreview)}`,
    );

    // hr_ops CANNOT execute hold_requisition either — FORBIDDEN before commit.
    const hrOpsHoldExec = await trpcMutation(
      "irisExecute",
      { actionId: "hold_requisition", params: { requisitionId: REQ, reason: "no" } },
      hrOpsJwt,
    );
    assert.ok(
      isErr(hrOpsHoldExec) && hrOpsHoldExec.error.data.code === "FORBIDDEN",
      `hr_ops hold execute forbidden, got ${JSON.stringify(hrOpsHoldExec)}`,
    );

    // hr_ops CANNOT execute resume_requisition either — FORBIDDEN before commit.
    const hrOpsResumeExec = await trpcMutation(
      "irisExecute",
      { actionId: "resume_requisition", params: { requisitionId: REQ } },
      hrOpsJwt,
    );
    assert.ok(
      isErr(hrOpsResumeExec) && hrOpsResumeExec.error.data.code === "FORBIDDEN",
      `hr_ops resume execute forbidden, got ${JSON.stringify(hrOpsResumeExec)}`,
    );

    // admin (in the set) sees both actions in its menu.
    const adminList = await trpcQuery<{ actions: { id: string }[] }>(
      "irisListActions",
      {},
      adminJwt,
    );
    assert.ok(!isErr(adminList), `admin can list, got ${JSON.stringify(adminList)}`);
    const adminIds = new Set(adminList.result.data.actions.map((a) => a.id));
    assert.ok(adminIds.has("hold_requisition"), "admin menu has hold_requisition");
    assert.ok(adminIds.has("resume_requisition"), "admin menu has resume_requisition");
  });
});
