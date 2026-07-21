/**
 * T1.3 (G13), OPTION (b) — configurable approval routing.
 *
 * Proves the two halves of the ticket:
 *
 *   Test A (authoring gate): admin `upsertApprovalMatrix` succeeds; recruiter
 *     and hr_head are FORBIDDEN. The write is admin-only.
 *
 *   Test B (derive from the effective matrix): with an admin-authored, effective-
 *     now single-step matrix naming `admin` as the approver, the requisition
 *     resolver builds a chain whose `resolved_steps` is that single admin step —
 *     i.e. changing WHO approves in the admin surface reroutes the chain. This is
 *     the fix for the config-lie where the resolver hardcoded a single hr_head
 *     step regardless of the matrix.
 *
 *   Test C (fallback): when the effective matrix has no usable steps (deriving
 *     null), the resolver falls back to creating the literal single-step hr_head
 *     chain. Exercised by inserting an empty-steps matrix as the newest-effective
 *     policy, then submitting — the chain comes out single-step hr_head.
 *
 * fileParallelism:false (vitest.config) means no other test file runs while this
 * one does, so the "newest effective matrix" the resolver picks is deterministic.
 * afterAll deletes EVERY matrix + chain this file creates (chains first — the
 * approval_chains → approval_matrices FK is ON DELETE RESTRICT), so kyndryl-poc
 * stays clean for req-03 / hrops-02.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / hrhead1 / recruiter1 /
 * hiringmanager1). Real cloud-minted JWTs (reality #110), NODE_ENV=test.
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
const ADMIN = "admin1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const RUN = Date.now().toString(36);
const TITLE_B = `T13 Derive ${RUN}`;
const DEPARTMENT_B = `T13 Derive Dept ${RUN}`;
const TITLE_C = `T13 Fallback ${RUN}`;
const DEPARTMENT_C = `T13 Fallback Dept ${RUN}`;

let adminJwt: string;
let recruiterJwt: string;
let hrHeadJwt: string;
let hiringManagerJwt: string;
let tenantId: string;

// Everything this file authors, for a precise afterAll cleanup.
const createdMatrixIds = new Set<string>();
const createdReqIds: string[] = [];
const createdChainIds = new Set<string>();

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

async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

/** Drive a requisition to pending_approval with no AI (JD from sections). */
async function createPendingReq(title: string, department: string): Promise<string> {
  const create = await trpcMutation<{ requisitionId: string }>(
    "createRequisitionDraft",
    { title, department, locationType: "onsite", primaryLocation: "Bengaluru" },
    hiringManagerJwt,
  );
  assert.ok(!isErr(create), `createDraft: ${JSON.stringify(create)}`);
  const id = create.result.data.requisitionId;
  createdReqIds.push(id);

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

/** Submit + return the chain's id + resolved_steps for the requisition. */
async function submitAndReadChain(reqId: string): Promise<{
  chainId: string;
  resolvedSteps: { step_index: number; approver_kind: string; approver_ref: string }[];
}> {
  const submit = await trpcMutation<{ approvalRequestId: string }>(
    "submitRequisitionForApproval",
    { requisitionId: reqId },
    hiringManagerJwt,
  );
  assert.ok(!isErr(submit), `submit: ${JSON.stringify(submit)}`);
  const requestId = submit.result.data.approvalRequestId;

  const [req] = await poolSql<{ chain_id: string }[]>`
    SELECT chain_id FROM public.approval_requests WHERE id = ${requestId}
  `;
  assert.ok(req?.chain_id, "approval_request carries a chain_id");
  createdChainIds.add(req.chain_id);

  const [chain] = await poolSql<{ resolved_steps: unknown }[]>`
    SELECT resolved_steps FROM public.approval_chains WHERE id = ${req.chain_id}
  `;
  assert.ok(chain, "the chain row exists");
  return {
    chainId: req.chain_id,
    resolvedSteps: chain.resolved_steps as {
      step_index: number;
      approver_kind: string;
      approver_ref: string;
    }[],
  };
}

describe("T1.3 configurable approval routing (option b)", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt, hrHeadJwt, hiringManagerJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(RECRUITER),
      signIn(HR_HEAD),
      signIn(HIRING_MANAGER),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
  });

  afterAll(async () => {
    // Chains first (FK restrict), gathering the matrices they reference so the
    // fallback-created matrices get cleaned too.
    const matrixIds = new Set<string>(createdMatrixIds);
    try {
      for (const id of createdReqIds) {
        const [row] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
          SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${id}
        `;
        const chainRows = await poolSql<{ chain_id: string | null }[]>`
          SELECT chain_id FROM public.approval_requests WHERE tenant_id = ${tenantId} AND subject_id = ${id}
        `;
        for (const c of chainRows) if (c.chain_id) createdChainIds.add(c.chain_id);

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
      }
      // Collect the matrices our chains reference, then drop the chains.
      for (const chainId of createdChainIds) {
        const [ch] = await poolSql<{ matrix_id: string | null }[]>`
          SELECT matrix_id FROM public.approval_chains WHERE id = ${chainId}
        `;
        if (ch?.matrix_id) matrixIds.add(ch.matrix_id);
        await poolSql`DELETE FROM public.approval_chains WHERE id = ${chainId}`;
      }
      for (const matrixId of matrixIds) {
        try {
          await poolSql`DELETE FROM public.approval_matrices WHERE id = ${matrixId} AND tenant_id = ${tenantId}`;
        } catch {
          // A concurrent chain we didn't create references it — leave it.
        }
      }
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${tenantId} AND name IN (${DEPARTMENT_B.trim()}, ${DEPARTMENT_C.trim()})`;
    } catch {
      // best-effort — leave residue for the groom sweep rather than fail.
    }
  });

  it("Test A: upsertApprovalMatrix is admin-only", async () => {
    const ok = await trpcMutation<{ id: string }>(
      "upsertApprovalMatrix",
      {
        subjectType: "requisition",
        name: `T13 admin-routes ${RUN}`,
        approverRole: "admin",
        effectiveFrom: new Date().toISOString(),
      },
      adminJwt,
    );
    assert.ok(!isErr(ok), `admin upsert should succeed, got ${JSON.stringify(ok)}`);
    assert.ok(ok.result.data.id, "returns the matrix id");
    createdMatrixIds.add(ok.result.data.id);

    const asRec = await trpcMutation(
      "upsertApprovalMatrix",
      {
        subjectType: "requisition",
        name: "T13 recruiter attempt",
        approverRole: "hr_head",
        effectiveFrom: new Date().toISOString(),
      },
      recruiterJwt,
    );
    assert.ok(isErr(asRec) && asRec.error.data.code === "FORBIDDEN", "recruiter forbidden");

    const asHrHead = await trpcMutation(
      "upsertApprovalMatrix",
      {
        subjectType: "requisition",
        name: "T13 hr_head attempt",
        approverRole: "hr_head",
        effectiveFrom: new Date().toISOString(),
      },
      hrHeadJwt,
    );
    assert.ok(isErr(asHrHead) && asHrHead.error.data.code === "FORBIDDEN", "hr_head forbidden");
  });

  it("Test B: the resolver derives resolved_steps from the effective admin matrix", async () => {
    // A fresh admin-authored matrix, effective now — the newest in force, so the
    // resolver must pick it over any pre-existing hr_head default.
    const authored = await trpcMutation<{ id: string }>(
      "upsertApprovalMatrix",
      {
        subjectType: "requisition",
        name: `T13 derive-admin ${RUN}`,
        approverRole: "admin",
        effectiveFrom: new Date().toISOString(),
      },
      adminJwt,
    );
    assert.ok(!isErr(authored), `author: ${JSON.stringify(authored)}`);
    createdMatrixIds.add(authored.result.data.id);

    const reqB = await createPendingReq(TITLE_B, DEPARTMENT_B);
    const { resolvedSteps } = await submitAndReadChain(reqB);

    assert.equal(resolvedSteps.length, 1, "single-step chain (option b)");
    assert.equal(
      resolvedSteps[0]?.approver_ref,
      "admin",
      "chain routes to the authored admin role",
    );
    assert.equal(resolvedSteps[0]?.approver_kind, "role", "approver_kind role");
    assert.equal(Number(resolvedSteps[0]?.step_index), 0, "single step at index 0");
  });

  it("Test C: a matrix with no usable steps falls back to the single-step hr_head chain", async () => {
    // Insert an empty-steps matrix as the newest-effective policy — deriving null,
    // which drives the resolver into its literal hr_head create path.
    const emptyId = "00000000-0000-4000-8000-0000000013ff";
    createdMatrixIds.add(emptyId);
    await poolSql`DELETE FROM public.approval_matrices WHERE id = ${emptyId}`;
    await poolSql`
      INSERT INTO public.approval_matrices (id, tenant_id, subject_type, name, rules, effective_from)
      VALUES (
        ${emptyId}, ${tenantId}, 'requisition', ${`T13 empty-steps ${RUN}`},
        ${JSON.stringify({ version: 1, steps: [] })}::jsonb, now()
      )
    `;

    const reqC = await createPendingReq(TITLE_C, DEPARTMENT_C);
    const { resolvedSteps } = await submitAndReadChain(reqC);

    assert.equal(resolvedSteps.length, 1, "fallback yields a single-step chain");
    assert.equal(resolvedSteps[0]?.approver_ref, "hr_head", "fallback routes to hr_head");
    assert.equal(resolvedSteps[0]?.approver_kind, "role", "approver_kind role");
    assert.equal(Number(resolvedSteps[0]?.step_index), 0, "single step at index 0");
  });
});
