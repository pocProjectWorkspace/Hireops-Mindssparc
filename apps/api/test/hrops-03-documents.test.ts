/**
 * HROPS-03 — pre-offer application documents lifecycle.
 *
 * Coverage:
 *   1. requestApplicationDocuments — creates 'requested' rows; idempotent
 *      re-request skips existing (tenant, application, type) rows.
 *   2. listApplicationDocumentCandidates — the candidate appears with per-doc
 *      statuses + a 'partial' rollup + hero stats.
 *   3. Guard — verify/reject on a still-'requested' doc is BAD_REQUEST;
 *      download of a blob-less doc 404s.
 *   4. Candidate upload → attach: REST blob upload with the candidate's own
 *      JWT, then candidateAttachApplicationDocument moves the row to
 *      'uploaded'. Cross-person attach is NOT_FOUND.
 *   5. verifyApplicationDocument — 'verified', reviewer stamped; the rollup
 *      moves; rejectApplicationDocument requires a reason and records it.
 *   6. PII logging — the hr-side download writes a pii_access_log row
 *      (reason download_application_document) before the bytes leave.
 *   7. Role gate — recruiter FORBIDDEN on list + request.
 *   8. hr_ops role (same tenant, hr_ops1) passes the gate and sees the row.
 *   9. RLS — the document row is invisible under another tenant's
 *      withTenantContext (current_tenant_id() mismatch).
 *
 * Fixtures live in the fnd15b test user's own tenant (same shape as
 * onboarding.test.ts) under the '0d03' UUID namespace; cleaned in afterAll.
 * Requires db:seed:test-users (recruiter1 / hr_ops1) for the gate tests.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { eq } from "drizzle-orm";
import {
  sql as poolSql,
  withTenantContext,
  applicationDocuments,
  type JwtClaims,
} from "@hireops/db";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
}

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HR_OPS_USER = "hr_ops1@kyndryl-poc.test";

// '0d03' namespace — valid v4-format fixed UUIDs for this suite's fixtures.
const D3_BU = "00000000-0000-4000-8000-00000d030001";
const D3_POSITION = "00000000-0000-4000-8000-00000d030002";
const D3_JD = "00000000-0000-4000-8000-00000d030003";
const D3_REQ = "00000000-0000-4000-8000-00000d030004";
const D3_PERSON = "00000000-0000-4000-8000-00000d030005";
const D3_CAND = "00000000-0000-4000-8000-00000d030006";
const D3_APP = "00000000-0000-4000-8000-00000d030007";
const D3_PERSON_B = "00000000-0000-4000-8000-00000d030008";
const SYNTH_TENANT = "00000000-0000-4000-8000-00000d03f001";

const CAND_EMAIL = "cand-hrops03@hireops-dev.local";
const CAND_B_EMAIL = "cand-b-hrops03@hireops-dev.local";
const CAND_PASSWORD = "hrops03-test-password-do-not-reuse";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let jwt: string;
let realClaims: JwtClaims;
let tenantId: string;
let membershipId: string;
let recruiterJwt: string;
let hrOpsJwt: string;
let candJwt: string;
let candAuthId: string;
let candBJwt: string;
let candBAuthId: string;
let typeIdA: string;
let typeIdB: string;
let docIdA = "";
let docIdB = "";

async function signIn(email: string, password: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

async function createCandidateUser(email: string): Promise<{ id: string; jwt: string }> {
  const created = await admin.auth.admin.createUser({
    email,
    password: CAND_PASSWORD,
    email_confirm: true,
  });
  let id = created.data?.user?.id ?? null;
  if (!id) {
    const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    id = list.data?.users.find((u) => u.email === email)?.id ?? null;
  }
  if (!id) throw new Error(`could not create/find auth user ${email}`);
  return { id, jwt: await signIn(email, CAND_PASSWORD) };
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
async function trpcQuery<O>(name: string, input: unknown, tok: string) {
  const inputParam =
    input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(`/trpc/${name}${inputParam}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${tok}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcMutation<O>(name: string, input: unknown, tok: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${tok}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

/** Upload a small PDF blob through the candidate REST route; returns storageKey. */
async function candidateUpload(tok: string): Promise<{ storageKey: string; sizeBytes: number }> {
  const fd = new FormData();
  fd.append(
    "file",
    new File([Buffer.from("%PDF-1.4 hrops-03 test document")], "pan-card.pdf", {
      type: "application/pdf",
    }),
  );
  const res = await app.request("/api/candidate-documents/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}` },
    body: fd,
  });
  assert.equal(res.status, 200, `candidate upload status ${res.status}`);
  return (await res.json()) as { storageKey: string; sizeBytes: number };
}

async function waitForPiiRow(documentId: string): Promise<number> {
  for (let i = 0; i < 30; i++) {
    const [row] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.pii_access_log
      WHERE entity_type = 'application_document'
        AND entity_id = ${documentId}
        AND reason = 'download_application_document'
    `;
    if (Number(row?.n ?? 0) > 0) return Number(row?.n);
    await new Promise((r) => setTimeout(r, 100));
  }
  return 0;
}

async function cleanup(): Promise<void> {
  await poolSql`
    DELETE FROM public.pii_access_log
    WHERE tenant_id = ${tenantId} AND entity_type = 'application_document'
  `;
  // application_documents + candidates cascade off applications/persons.
  await poolSql`DELETE FROM public.applications WHERE id = ${D3_APP}`;
  await poolSql`DELETE FROM public.candidate_accounts WHERE tenant_id = ${tenantId} AND person_id IN (${D3_PERSON}, ${D3_PERSON_B})`;
  await poolSql`DELETE FROM public.candidates WHERE id = ${D3_CAND}`;
  await poolSql`DELETE FROM public.persons WHERE id IN (${D3_PERSON}, ${D3_PERSON_B})`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${D3_REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${D3_JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${D3_POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${D3_BU}`;
}

describe("HROPS-03 application documents lifecycle", () => {
  beforeAll(async () => {
    jwt = await signIn(TEST_EMAIL, TEST_PASSWORD);
    realClaims = decodeJwt(jwt) as JwtClaims;
    tenantId = realClaims.tid as string;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${realClaims.sub as string} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (!m) throw new Error("test user membership missing");
    membershipId = m.id;

    [recruiterJwt, hrOpsJwt] = await Promise.all([
      signIn(RECRUITER, PASSWORD),
      signIn(HR_OPS_USER, PASSWORD),
    ]);
    ({ id: candAuthId, jwt: candJwt } = await createCandidateUser(CAND_EMAIL));
    ({ id: candBAuthId, jwt: candBJwt } = await createCandidateUser(CAND_B_EMAIL));

    const types = await poolSql<{ id: string }[]>`
      SELECT id FROM public.document_types ORDER BY code LIMIT 2
    `;
    if (types.length < 2) throw new Error("need at least two document_types (run migrations)");
    typeIdA = types[0]!.id;
    typeIdB = types[1]!.id;

    await cleanup();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${D3_BU}, ${tenantId}, 'HROPS3 BU', 'hrops3-bu')`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${D3_POSITION}, ${tenantId}, ${D3_BU}, 'HROPS3 Platform Engineer', 'onsite', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${D3_JD}, ${tenantId}, ${D3_POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${D3_REQ}, ${tenantId}, ${D3_POSITION}, ${D3_JD}, ${membershipId}, ${membershipId}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_country)
      VALUES (${D3_PERSON}, ${tenantId}, 'Hrops Three Candidate', ${CAND_EMAIL}, ${CAND_EMAIL}, 'IN')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_country)
      VALUES (${D3_PERSON_B}, ${tenantId}, 'Hrops Three Other', ${CAND_B_EMAIL}, ${CAND_B_EMAIL}, 'IN')
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${D3_CAND}, ${tenantId}, ${D3_PERSON}, 'career_site', 'v1')
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${D3_APP}, ${tenantId}, ${D3_CAND}, ${D3_REQ}, 'career_site', 'tech_interview', now())
    `;
    // Candidate accounts wired to the REAL auth users (A owns the application's
    // person; B is a different person → cross-person probe).
    await poolSql`
      INSERT INTO public.candidate_accounts (tenant_id, person_id, user_id, status, activated_at)
      VALUES (${tenantId}, ${D3_PERSON}, ${candAuthId}, 'active', now())
    `;
    await poolSql`
      INSERT INTO public.candidate_accounts (tenant_id, person_id, user_id, status, activated_at)
      VALUES (${tenantId}, ${D3_PERSON_B}, ${candBAuthId}, 'active', now())
    `;
  });

  afterAll(async () => {
    await cleanup();
    await admin.auth.admin.deleteUser(candAuthId).catch(() => undefined);
    await admin.auth.admin.deleteUser(candBAuthId).catch(() => undefined);
    await poolSql.end({ timeout: 10 });
  });

  it("1. request creates 'requested' rows; re-request is idempotent", async () => {
    const req1 = await trpcMutation<{ requested: number; skipped: number }>(
      "requestApplicationDocuments",
      { applicationId: D3_APP, documentTypeIds: [typeIdA, typeIdB] },
      jwt,
    );
    assert.ok(!isErr(req1), `request: ${JSON.stringify(req1)}`);
    assert.equal(req1.result.data.requested, 2);
    assert.equal(req1.result.data.skipped, 0);

    const req2 = await trpcMutation<{ requested: number; skipped: number }>(
      "requestApplicationDocuments",
      { applicationId: D3_APP, documentTypeIds: [typeIdA, typeIdB] },
      jwt,
    );
    assert.ok(!isErr(req2), `re-request: ${JSON.stringify(req2)}`);
    assert.equal(req2.result.data.requested, 0, "no duplicates on re-request");
    assert.equal(req2.result.data.skipped, 2);

    const rows = await poolSql<{ id: string; document_type_id: string; status: string }[]>`
      SELECT id, document_type_id, status FROM public.application_documents
      WHERE tenant_id = ${tenantId} AND application_id = ${D3_APP}
      ORDER BY requested_at, id
    `;
    assert.equal(rows.length, 2, "exactly two document rows");
    assert.ok(rows.every((r) => r.status === "requested"));
    docIdA = rows.find((r) => r.document_type_id === typeIdA)!.id;
    docIdB = rows.find((r) => r.document_type_id === typeIdB)!.id;
  });

  it("2. list shows the candidate with per-doc statuses + partial rollup + stats", async () => {
    const list = await trpcQuery<{
      items: { applicationId: string; overall: string; documents: { status: string }[] }[];
      stats: { candidates: number; pendingDocs: number; totalDocs: number };
    }>("listApplicationDocumentCandidates", { limit: 100 }, jwt);
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    const mine = list.result.data.items.find((i) => i.applicationId === D3_APP);
    assert.ok(mine, "the fixture application appears");
    assert.equal(mine!.documents.length, 2);
    assert.equal(mine!.overall, "partial", "all-requested rolls up as partial");
    assert.ok(list.result.data.stats.totalDocs >= 2);
    assert.ok(list.result.data.stats.pendingDocs >= 2);
  });

  it("3. verify/reject before upload is BAD_REQUEST; blob-less download 404s", async () => {
    const v = await trpcMutation("verifyApplicationDocument", { documentId: docIdA }, jwt);
    assert.ok(isErr(v) && v.error.data.code === "BAD_REQUEST", "cannot verify an un-uploaded doc");
    const r = await trpcMutation(
      "rejectApplicationDocument",
      { documentId: docIdA, rejectionReason: "premature" },
      jwt,
    );
    assert.ok(isErr(r) && r.error.data.code === "BAD_REQUEST", "cannot reject an un-uploaded doc");

    const dl = await app.request(`/api/application-documents/${docIdA}/download`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    assert.equal(dl.status, 404, "no blob yet → 404");
  });

  it("4. candidate uploads + attaches THEIR doc; cross-person attach is NOT_FOUND", async () => {
    const blob = await candidateUpload(candJwt);
    const attach = await trpcMutation<{ status: string }>(
      "candidateAttachApplicationDocument",
      {
        documentId: docIdA,
        storageKey: blob.storageKey,
        fileName: "pan-card.pdf",
        mimeType: "application/pdf",
        sizeBytes: blob.sizeBytes,
      },
      candJwt,
    );
    assert.ok(!isErr(attach), `attach: ${JSON.stringify(attach)}`);
    assert.equal(attach.result.data.status, "uploaded");

    // Candidate B (different person) cannot attach to A's document.
    const blobB = await candidateUpload(candBJwt);
    const cross = await trpcMutation(
      "candidateAttachApplicationDocument",
      {
        documentId: docIdB,
        storageKey: blobB.storageKey,
        fileName: "x.pdf",
        mimeType: "application/pdf",
        sizeBytes: blobB.sizeBytes,
      },
      candBJwt,
    );
    assert.ok(isErr(cross) && cross.error.data.code === "NOT_FOUND", "cross-person attach 404s");

    // Candidate's own listing shows the uploaded doc.
    const myDocs = await trpcQuery<{
      groups: { applicationId: string; documents: { documentId: string; status: string }[] }[];
    }>("candidateListMyApplicationDocuments", undefined, candJwt);
    assert.ok(!isErr(myDocs), `candidate list: ${JSON.stringify(myDocs)}`);
    const group = myDocs.result.data.groups.find((g) => g.applicationId === D3_APP);
    assert.ok(group, "candidate sees their application group");
    assert.equal(group!.documents.find((d) => d.documentId === docIdA)?.status, "uploaded");
  });

  it("5. verify stamps the reviewer; reject requires + records a reason", async () => {
    const v = await trpcMutation<{ status: string }>(
      "verifyApplicationDocument",
      { documentId: docIdA },
      jwt,
    );
    assert.ok(!isErr(v), `verify: ${JSON.stringify(v)}`);
    assert.equal(v.result.data.status, "verified");
    const [row] = await poolSql<{ verified_by_membership_id: string | null }[]>`
      SELECT verified_by_membership_id FROM public.application_documents WHERE id = ${docIdA}
    `;
    assert.equal(row?.verified_by_membership_id, membershipId, "reviewer membership stamped");

    // Upload doc B as the candidate, then reject it with a reason.
    const blob = await candidateUpload(candJwt);
    const attach = await trpcMutation(
      "candidateAttachApplicationDocument",
      {
        documentId: docIdB,
        storageKey: blob.storageKey,
        fileName: "aadhaar.pdf",
        mimeType: "application/pdf",
        sizeBytes: blob.sizeBytes,
      },
      candJwt,
    );
    assert.ok(!isErr(attach), `attach B: ${JSON.stringify(attach)}`);

    const rej = await trpcMutation<{ status: string; rejectionReason: string | null }>(
      "rejectApplicationDocument",
      { documentId: docIdB, rejectionReason: "Scan is illegible — please re-upload" },
      jwt,
    );
    assert.ok(!isErr(rej), `reject: ${JSON.stringify(rej)}`);
    assert.equal(rej.result.data.status, "rejected");
    assert.equal(rej.result.data.rejectionReason, "Scan is illegible — please re-upload");

    // Rollup is now 'rejected' (rejected wins over verified).
    const list = await trpcQuery<{ items: { applicationId: string; overall: string }[] }>(
      "listApplicationDocumentCandidates",
      { limit: 100 },
      jwt,
    );
    assert.ok(!isErr(list));
    assert.equal(
      list.result.data.items.find((i) => i.applicationId === D3_APP)?.overall,
      "rejected",
    );
  });

  it("6. hr-side download streams the blob and writes a pii_access_log row", async () => {
    const dl = await app.request(`/api/application-documents/${docIdA}/download`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    assert.equal(dl.status, 200, "download succeeds");
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert.ok(bytes.length > 0, "blob bytes returned");
    const n = await waitForPiiRow(docIdA);
    assert.ok(n >= 1, "pii_access_log row written for the download");
  });

  it("7. role gate — recruiter FORBIDDEN on list + request", async () => {
    const list = await trpcQuery("listApplicationDocumentCandidates", { limit: 10 }, recruiterJwt);
    assert.ok(isErr(list) && list.error.data.code === "FORBIDDEN");
    const req = await trpcMutation(
      "requestApplicationDocuments",
      { applicationId: D3_APP, documentTypeIds: [typeIdA] },
      recruiterJwt,
    );
    assert.ok(isErr(req) && req.error.data.code === "FORBIDDEN");
  });

  it("8. hr_ops role (same tenant) can read the surface", async () => {
    // hr_ops1 shares the kyndryl-poc tenant with the fnd15b fixtures — a
    // positive check that the plain hr_ops role passes HR_OPS_DOC_ROLES.
    const list = await trpcQuery<{ items: { applicationId: string }[] }>(
      "listApplicationDocumentCandidates",
      { limit: 200 },
      hrOpsJwt,
    );
    assert.ok(!isErr(list), `hr_ops list: ${JSON.stringify(list)}`);
    assert.ok(
      list.result.data.items.some((i) => i.applicationId === D3_APP),
      "same-tenant hr_ops sees the fixture application",
    );
  });

  it("9. RLS — the document row is invisible from another tenant's context", async () => {
    // Visible from the owning tenant's RLS context.
    const ownVisible = await withTenantContext(realClaims, async ({ db }) =>
      db
        .select({ id: applicationDocuments.id })
        .from(applicationDocuments)
        .where(eq(applicationDocuments.id, docIdA)),
    );
    assert.equal(ownVisible.length, 1, "owning tenant sees the row");

    // Invisible when current_tenant_id() is a different (synthetic) tenant.
    const synthClaims: JwtClaims = {
      sub: "00000000-0000-4000-8000-00000d03f0aa",
      tid: SYNTH_TENANT,
      roles: ["hr_ops"],
    };
    const crossVisible = await withTenantContext(synthClaims, async ({ db }) =>
      db
        .select({ id: applicationDocuments.id })
        .from(applicationDocuments)
        .where(eq(applicationDocuments.id, docIdA)),
    );
    assert.equal(crossVisible.length, 0, "cross-tenant context sees nothing");
  });
});
