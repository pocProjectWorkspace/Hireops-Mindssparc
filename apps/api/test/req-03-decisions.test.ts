/**
 * REQ-03 (Wave A, closes it) — HR-head approval decisions + posting.
 *
 * Makes real the "Submit Decision" button the prototype left dead: the HR head
 * approves / sends back / rejects a submitted requisition, and the recruiter
 * side posts an approved req live.
 *
 * Exercised over real cloud-minted JWTs (reality #110 — sign in as the seeded
 * personas), NODE_ENV=test so no AI tokens are spent (the JD is set from
 * sections via updateRequisitionDraft — no generation needed):
 *
 *   Test 1: send_back WITHOUT a reason → clean 400.
 *   Test 2: hiring_manager + recruiter are FORBIDDEN from deciding.
 *   Test 3: send_back (with reason) → decision row (abstained, reason, step 0)
 *           + request cancelled + requisition draft + transition.
 *   Test 4: a resubmit after send_back creates a fresh pending request
 *           (partial-unique freed).
 *   Test 5: approve → decision row (approved) + request approved (+ decided_at)
 *           + requisition approved + transition.
 *   Test 6: deciding an already-decided request → clean CONFLICT.
 *   Test 7: postRequisition from approved → posted, human public_slug set, and
 *           the public apply page (resolvePublicRequisition) resolves it;
 *           posting a non-approved req → CONFLICT.
 *   Test 8: reject requires a reason, then terminalises the requisition
 *           (decision rejected + request rejected + requisition cancelled).
 *
 * Requires `pnpm db:seed:test-users` (hiringmanager1 / hrhead1 / recruiter1).
 * Cleans up its own rows in afterAll.
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
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const RUN = Date.now().toString(36);
const TITLE_A = `REQ-03 Platform Engineer ${RUN}`;
const DEPARTMENT_A = `REQ-03 Platform ${RUN}`;
const TITLE_B = `REQ-03 Data Analyst ${RUN}`;
const DEPARTMENT_B = `REQ-03 Analytics ${RUN}`;

let recruiterJwt: string;
let hiringManagerJwt: string;
let hrHeadJwt: string;
let tenantId: string;

// reqA walks send_back → resubmit → approve → post; reqB is rejected.
let reqA = "";
let reqAApprovalId = "";
let reqAResubmitApprovalId = "";
let reqB = "";
let reqBApprovalId = "";

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
  error: { message?: string; data: { code: string; httpStatus?: number } };
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
async function trpcQueryNoAuth<O>(name: string, input: unknown) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, { method: "GET" });
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

/** Drive a requisition all the way to pending_approval with no AI: create the
 *  draft, set JD sections + a skill via updateRequisitionDraft, then submit. */
async function createPendingReq(title: string, department: string): Promise<string> {
  const create = await trpcMutation<{ requisitionId: string }>(
    "createRequisitionDraft",
    { title, department, locationType: "onsite", primaryLocation: "Bengaluru" },
    hiringManagerJwt,
  );
  assert.ok(!isErr(create), `createDraft: ${JSON.stringify(create)}`);
  const id = create.result.data.requisitionId;

  const upd = await trpcMutation(
    "updateRequisitionDraft",
    {
      requisitionId: id,
      sections: {
        summary: `Own the ${department} platform and its quality.`,
        responsibilities: ["Design systems.", "Ship reliably."],
        requirements: ["5+ years experience.", "Strong fundamentals."],
      },
      skills: [{ skillName: "TypeScript", weight: 1, isRequired: true }],
    },
    hiringManagerJwt,
  );
  assert.ok(!isErr(upd), `update: ${JSON.stringify(upd)}`);
  return id;
}

async function submitReq(id: string): Promise<string> {
  const submit = await trpcMutation<{ approvalRequestId: string }>(
    "submitRequisitionForApproval",
    { requisitionId: id },
    hiringManagerJwt,
  );
  assert.ok(!isErr(submit), `submit: ${JSON.stringify(submit)}`);
  return submit.result.data.approvalRequestId;
}

describe("REQ-03 approval decisions + posting", () => {
  beforeAll(async () => {
    [recruiterJwt, hiringManagerJwt, hrHeadJwt] = await Promise.all([
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
      signIn(HR_HEAD),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    reqA = await createPendingReq(TITLE_A, DEPARTMENT_A);
    reqAApprovalId = await submitReq(reqA);
    reqB = await createPendingReq(TITLE_B, DEPARTMENT_B);
    reqBApprovalId = await submitReq(reqB);
  });

  afterAll(async () => {
    for (const id of [reqA, reqB]) {
      if (!id) continue;
      try {
        const [row] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
          SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${id}
        `;
        await poolSql`
          DELETE FROM public.approval_decisions d
          USING public.approval_requests r
          WHERE d.request_id = r.id AND r.tenant_id = ${tenantId} AND r.subject_id = ${id}
        `;
        await poolSql`DELETE FROM public.approval_requests WHERE tenant_id = ${tenantId} AND subject_id = ${id}`;
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${id}`;
        await poolSql`DELETE FROM public.requisitions WHERE id = ${id}`;
        if (row?.jd_version_id) {
          await poolSql`DELETE FROM public.jd_versions WHERE id = ${row.jd_version_id}`;
        }
        if (row?.position_id) {
          await poolSql`DELETE FROM public.positions WHERE id = ${row.position_id}`;
        }
      } catch {
        // best-effort — leave residue for the groom sweep rather than fail.
      }
    }
    try {
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${tenantId} AND name IN (${DEPARTMENT_A.trim()}, ${DEPARTMENT_B.trim()})`;
      await poolSql`
        DELETE FROM public.approval_chains c
        WHERE c.tenant_id = ${tenantId}
          AND NOT EXISTS (SELECT 1 FROM public.approval_requests r WHERE r.chain_id = c.id)
          AND c.created_at >= now() - interval '30 minutes'
      `;
    } catch {
      // best-effort.
    }
  });

  it("Test 1: send_back without a reason → clean 400", async () => {
    const res = await trpcMutation(
      "decideRequisitionApproval",
      { approvalRequestId: reqAApprovalId, decision: "send_back" },
      hrHeadJwt,
    );
    assert.ok(isErr(res), `expected BAD_REQUEST, got ${JSON.stringify(res)}`);
    assert.equal(res.error.data.code, "BAD_REQUEST");
  });

  it("Test 2: hiring_manager + recruiter are FORBIDDEN from deciding", async () => {
    const asHm = await trpcMutation(
      "decideRequisitionApproval",
      { approvalRequestId: reqAApprovalId, decision: "approve" },
      hiringManagerJwt,
    );
    assert.ok(isErr(asHm) && asHm.error.data.code === "FORBIDDEN", "HM forbidden");
    const asRec = await trpcMutation(
      "decideRequisitionApproval",
      { approvalRequestId: reqAApprovalId, decision: "approve" },
      recruiterJwt,
    );
    assert.ok(isErr(asRec) && asRec.error.data.code === "FORBIDDEN", "recruiter forbidden");
  });

  it("Test 3: send_back returns the requisition to draft + writes a decision", async () => {
    const res = await trpcMutation<{ requisitionStatus: string; requestStatus: string }>(
      "decideRequisitionApproval",
      {
        approvalRequestId: reqAApprovalId,
        decision: "send_back",
        reason: "Tighten the required skills and confirm the comp band.",
      },
      hrHeadJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.requisitionStatus, "draft");
    assert.equal(res.result.data.requestStatus, "cancelled");

    const [dec] = await poolSql<{ outcome: string; comment: string; step_index: number }[]>`
      SELECT outcome::text AS outcome, comment, step_index
      FROM public.approval_decisions WHERE request_id = ${reqAApprovalId}
    `;
    assert.equal(dec?.outcome, "abstained", "send_back records an abstained outcome");
    assert.equal(Number(dec?.step_index), 0, "decision recorded against step 0");
    assert.ok(dec?.comment && dec.comment.length > 0, "reason stored on the decision");

    const [ar] = await poolSql<{ status: string; decided_at: string | null }[]>`
      SELECT status, decided_at FROM public.approval_requests WHERE id = ${reqAApprovalId}
    `;
    assert.equal(ar?.status, "cancelled", "request moved off pending");
    assert.ok(ar?.decided_at, "decided_at stamped");

    const [req] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.requisitions WHERE id = ${reqA}
    `;
    assert.equal(req?.status, "draft", "requisition returned to draft");
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.requisition_state_transitions
      WHERE requisition_id = ${reqA} AND from_status = 'pending_approval' AND to_status = 'draft'
    `;
    assert.ok(Number(n) >= 1, "a pending_approval→draft transition exists");
  });

  it("Test 4: a resubmit after send_back creates a fresh pending request", async () => {
    reqAResubmitApprovalId = await submitReq(reqA);
    assert.ok(reqAResubmitApprovalId, "resubmit returns a request id");
    assert.notEqual(reqAResubmitApprovalId, reqAApprovalId, "a new request, not the old one");

    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.approval_requests
      WHERE tenant_id = ${tenantId} AND subject_type = 'requisition'
        AND subject_id = ${reqA} AND status = 'pending'
    `;
    assert.equal(Number(n), 1, "exactly one pending request after resubmit");

    const [req] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.requisitions WHERE id = ${reqA}
    `;
    assert.equal(req?.status, "pending_approval", "requisition back to pending_approval");
  });

  it("Test 5: approve moves request + requisition to approved + writes a decision", async () => {
    const res = await trpcMutation<{ requisitionStatus: string; requestStatus: string }>(
      "decideRequisitionApproval",
      { approvalRequestId: reqAResubmitApprovalId, decision: "approve" },
      hrHeadJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.requisitionStatus, "approved");
    assert.equal(res.result.data.requestStatus, "approved");

    const [dec] = await poolSql<{ outcome: string }[]>`
      SELECT outcome::text AS outcome FROM public.approval_decisions
      WHERE request_id = ${reqAResubmitApprovalId}
    `;
    assert.equal(dec?.outcome, "approved", "approve records an approved outcome");

    const [ar] = await poolSql<{ status: string; decided_at: string | null }[]>`
      SELECT status, decided_at FROM public.approval_requests WHERE id = ${reqAResubmitApprovalId}
    `;
    assert.equal(ar?.status, "approved");
    assert.ok(ar?.decided_at, "decided_at stamped");

    const [req] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.requisitions WHERE id = ${reqA}
    `;
    assert.equal(req?.status, "approved", "requisition approved");
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.requisition_state_transitions
      WHERE requisition_id = ${reqA} AND from_status = 'pending_approval' AND to_status = 'approved'
    `;
    assert.ok(Number(n) >= 1, "a pending_approval→approved transition exists");
  });

  it("Test 6: deciding an already-decided request → clean CONFLICT", async () => {
    const res = await trpcMutation(
      "decideRequisitionApproval",
      { approvalRequestId: reqAResubmitApprovalId, decision: "approve" },
      hrHeadJwt,
    );
    assert.ok(isErr(res), `expected CONFLICT, got ${JSON.stringify(res)}`);
    assert.equal(res.error.data.code, "CONFLICT");
  });

  it("Test 7: postRequisition takes an approved req live + the apply page resolves it", async () => {
    // Posting a non-approved req (reqB is still pending) → CONFLICT.
    const early = await trpcMutation("postRequisition", { requisitionId: reqB }, recruiterJwt);
    assert.ok(
      isErr(early) && early.error.data.code === "CONFLICT",
      "cannot post a non-approved req",
    );

    const res = await trpcMutation<{ status: string; publicSlug: string }>(
      "postRequisition",
      { requisitionId: reqA },
      recruiterJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.status, "posted");
    const slug = res.result.data.publicSlug;
    assert.ok(slug.startsWith("req-03-platform-engineer"), `human slug, got ${slug}`);
    assert.ok(!slug.startsWith("r-"), "not the uuid default slug");

    const [req] = await poolSql<{ status: string; is_public: boolean; posted_at: string | null }[]>`
      SELECT status, is_public, posted_at FROM public.requisitions WHERE id = ${reqA}
    `;
    assert.equal(req?.status, "posted");
    assert.equal(req?.is_public, true, "is_public set");
    assert.ok(req?.posted_at, "posted_at stamped");
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.requisition_state_transitions
      WHERE requisition_id = ${reqA} AND from_status = 'approved' AND to_status = 'posted'
    `;
    assert.ok(Number(n) >= 1, "an approved→posted transition exists");

    // The public apply page resolves the new slug (crs-01's resolver).
    const env = await trpcQueryNoAuth<{ requisitionId: string }>("resolvePublicRequisition", {
      tenantSlug: TENANT_SLUG,
      reqSlug: slug,
    });
    assert.ok(!isErr(env), `apply page should resolve, got ${JSON.stringify(env)}`);
    assert.equal(env.result.data.requisitionId, reqA, "resolves to the posted requisition");
  });

  it("Test 8: reject requires a reason, then terminalises the requisition", async () => {
    const noReason = await trpcMutation(
      "decideRequisitionApproval",
      { approvalRequestId: reqBApprovalId, decision: "reject" },
      hrHeadJwt,
    );
    assert.ok(
      isErr(noReason) && noReason.error.data.code === "BAD_REQUEST",
      "reject needs a reason",
    );

    const res = await trpcMutation<{ requisitionStatus: string; requestStatus: string }>(
      "decideRequisitionApproval",
      { approvalRequestId: reqBApprovalId, decision: "reject", reason: "Headcount not funded." },
      hrHeadJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.requestStatus, "rejected");
    assert.equal(res.result.data.requisitionStatus, "cancelled");

    const [dec] = await poolSql<{ outcome: string }[]>`
      SELECT outcome::text AS outcome FROM public.approval_decisions WHERE request_id = ${reqBApprovalId}
    `;
    assert.equal(dec?.outcome, "rejected", "reject records a rejected outcome");
    const [req] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.requisitions WHERE id = ${reqB}
    `;
    assert.equal(req?.status, "cancelled", "rejected requisition terminalises to cancelled");
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.requisition_state_transitions
      WHERE requisition_id = ${reqB} AND from_status = 'pending_approval' AND to_status = 'cancelled'
    `;
    assert.ok(Number(n) >= 1, "a pending_approval→cancelled transition exists");
  });
});
