/**
 * CAND-02 — candidate documents + in-portal offer.
 *
 * Covers the four new candidateProcedure procedures + the candidate document
 * REST route:
 *   1. Person-scoping: candidate B cannot see A's offer / onboarding case /
 *      documents, and cannot accept A's offer (NOT_FOUND) or attach to A's case.
 *   2. candidateAcceptOffer twin: accepts THEIR extended offer with the SAME
 *      side-effects as the public link route (Workday outbox row + onboarding
 *      case), double-accept is a clean CONFLICT.
 *   3. candidateAttachDocument: upload (REST) → attach progresses the matching
 *      document_collection task pending → in_progress.
 *   4. Candidate self-download writes a pii_access_log row
 *      (reason candidate_self_download); a cross-person document id 404s.
 *
 * Two candidates are REAL Supabase auth users (A + B) so the REST route's own
 * candidate-resolution middleware (which verifies a real JWT) can be exercised;
 * candidateProcedure reads go through appRouter.createCaller with a synthetic
 * HonoTRPCContext whose userId is the candidate's auth user id.
 *
 * The public signed-link accept path is regression-covered by onboarding.test
 * (which drives /api/offers/accept) — both now share lib/offer-accept.ts.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { app } from "../src/index.js";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
}

// CAND-02 synth namespace ('a042' marker) — valid v4-format UUIDs, distinct
// from cand-01's 'a04'.
const CT_TENANT = "00000000-0000-4000-8000-0000000a042a";
const CT_BU = "00000000-0000-4000-8000-0000000a042b";
const CT_MEMBERSHIP = "00000000-0000-4000-8000-0000000a042c";
const CT_POSITION = "00000000-0000-4000-8000-0000000a042d";
const CT_JD = "00000000-0000-4000-8000-0000000a042e";
const CT_REQ = "00000000-0000-4000-8000-0000000a042f";
const PERSON_A = "00000000-0000-4000-8000-0000000a0421";
const PERSON_B = "00000000-0000-4000-8000-0000000a0422";
const CAND_A = "00000000-0000-4000-8000-0000000a0423";
const CAND_B = "00000000-0000-4000-8000-0000000a0424";
const APP_A = "00000000-0000-4000-8000-0000000a0425";
const APP_B = "00000000-0000-4000-8000-0000000a0426";
const OFFER_A = "00000000-0000-4000-8000-0000000a0427";
const OFFER_B = "00000000-0000-4000-8000-0000000a0428";

const EMAIL_A = "cand-a-cand02@hireops-dev.local";
const EMAIL_B = "cand-b-cand02@hireops-dev.local";
const CAND_PASSWORD = "cand02-test-password-do-not-reuse";

const log = createLogger({ level: "error" });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let recruiterUserId: string;
let authIdA: string;
let authIdB: string;
let jwtA: string;
let jwtB: string;

async function getRecruiterUserId(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
  return decodeJwt(data.session.access_token).sub as string;
}

/** Create (or reuse) a real candidate auth user and return { id, jwt }. */
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
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: CAND_PASSWORD,
  });
  if (error || !data.session) throw new Error(`candidate signin failed: ${error?.message}`);
  return { id, jwt: data.session.access_token };
}

function makeCaller(userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: { sub: userId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-cand02-${randomUUID()}`,
    userAgent: "cand02-test",
    ipAddress: "127.0.0.1",
  };
  return appRouter.createCaller(ctx);
}

async function expectCode(fn: () => Promise<unknown>, code: string, label: string) {
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof TRPCError, `${label}: expected a TRPCError`);
  assert.equal((thrown as TRPCError).code, code, `${label}: expected ${code}`);
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.pii_access_log WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.workday_sync_outbox WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.candidate_accounts WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.onboarding_documents WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.onboarding_tasks WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.onboarding_cases WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.offers WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${CT_TENANT}`;
}

describe("CAND-02 candidate documents + in-portal offer", () => {
  beforeAll(async () => {
    recruiterUserId = await getRecruiterUserId();
    ({ id: authIdA, jwt: jwtA } = await createCandidateUser(EMAIL_A));
    ({ id: authIdB, jwt: jwtB } = await createCandidateUser(EMAIL_B));
    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${CT_TENANT}, 'synth-cand-02', 'Candidate-02 Synth', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${CT_BU}, ${CT_TENANT}, 'CT2 BU', 'ct2-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${CT_MEMBERSHIP}, ${CT_TENANT}, ${recruiterUserId}, ARRAY['recruiter']::tenant_role[], 'active', ${CT_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${CT_POSITION}, ${CT_TENANT}, ${CT_BU}, 'Senior Platform Engineer', 'hybrid', 'Bengaluru', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${CT_JD}, ${CT_TENANT}, ${CT_POSITION}, 1, '# JD', 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${CT_REQ}, ${CT_TENANT}, ${CT_POSITION}, ${CT_JD}, ${CT_MEMBERSHIP}, ${CT_MEMBERSHIP}, 'posted', true)`;

    // Persons + candidates (location_country IN → India document set on accept).
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, location_country) VALUES (${PERSON_A}, ${CT_TENANT}, 'Aanya Rao', ${EMAIL_A}, ${EMAIL_A}, '+919812340001', 'IN')`;
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, location_country) VALUES (${PERSON_B}, ${CT_TENANT}, 'Bharat Singh', ${EMAIL_B}, ${EMAIL_B}, '+919812340002', 'IN')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_A}, ${CT_TENANT}, ${PERSON_A}, 'career_site')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_B}, ${CT_TENANT}, ${PERSON_B}, 'career_site')`;

    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_A}, ${CT_TENANT}, ${CAND_A}, ${CT_REQ}, 'career_site', 'offer_drafted')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_B}, ${CT_TENANT}, ${CAND_B}, ${CT_REQ}, 'career_site', 'offer_drafted')`;

    // Extended offers for A + B (future joining + expiry).
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         variable_target_inr_paise, joining_date, location, expiry_at, terms_html, status, extended_at)
      VALUES (${OFFER_A}, ${CT_TENANT}, ${APP_A}, ${CT_MEMBERSHIP}, ${(4_200_000 * 100).toString()}::bigint,
              ${(600_000 * 100).toString()}::bigint, (now() + interval '30 days')::date, 'Bengaluru',
              (now() + interval '7 days'), 'Welcome aboard.', 'extended', now())
    `;
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status, extended_at)
      VALUES (${OFFER_B}, ${CT_TENANT}, ${APP_B}, ${CT_MEMBERSHIP}, ${(3_600_000 * 100).toString()}::bigint,
              (now() + interval '30 days')::date, 'Pune', (now() + interval '7 days'), 'extended', now())
    `;

    // Active candidate accounts wired to the REAL auth users.
    await poolSql`INSERT INTO public.candidate_accounts (tenant_id, person_id, user_id, status, activated_at) VALUES (${CT_TENANT}, ${PERSON_A}, ${authIdA}, 'active', now())`;
    await poolSql`INSERT INTO public.candidate_accounts (tenant_id, person_id, user_id, status, activated_at) VALUES (${CT_TENANT}, ${PERSON_B}, ${authIdB}, 'active', now())`;
  });

  afterAll(async () => {
    await cleanup();
    await admin.auth.admin.deleteUser(authIdA).catch(() => undefined);
    await admin.auth.admin.deleteUser(authIdB).catch(() => undefined);
    await poolSql.end({ timeout: 10 });
  });

  it("1. candidateGetMyOffer is person-scoped (each sees only their own offer)", async () => {
    const a = await makeCaller(authIdA).candidateGetMyOffer();
    const b = await makeCaller(authIdB).candidateGetMyOffer();
    assert.ok(a.offer, "A has an offer");
    assert.equal(a.offer.offerId, OFFER_A, "A sees offer A");
    assert.equal(a.offer.positionTitle, "Senior Platform Engineer");
    assert.equal(a.offer.baseSalaryInrPaise, 4_200_000 * 100);
    assert.ok(b.offer, "B has an offer");
    assert.equal(b.offer.offerId, OFFER_B, "B sees offer B (not A's)");
  });

  it("2. candidateAcceptOffer accepts THEIR offer + fires side-effects", async () => {
    const res = await makeCaller(authIdA).candidateAcceptOffer({ offerId: OFFER_A });
    assert.equal(res.ok, true);
    assert.equal(res.status, "accepted");

    const [offer] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.offers WHERE id = ${OFFER_A}`;
    assert.equal(offer?.status, "accepted", "offer A now accepted");

    const [wd] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.workday_sync_outbox
      WHERE tenant_id = ${CT_TENANT} AND subject_application_id = ${APP_A}
        AND event_type = 'hire_employee'`;
    assert.ok(Number(wd?.n) >= 1, "workday hire outbox row enqueued");

    const [oc] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.onboarding_cases
      WHERE tenant_id = ${CT_TENANT} AND application_id = ${APP_A}`;
    assert.equal(Number(oc?.n), 1, "onboarding case auto-created for app A");
  });

  it("3. candidateAcceptOffer cannot accept another person's offer (NOT_FOUND)", async () => {
    await expectCode(
      () => makeCaller(authIdB).candidateAcceptOffer({ offerId: OFFER_A }),
      "NOT_FOUND",
      "B accepting A's offer",
    );
  });

  it("4. double-accept is a clean CONFLICT", async () => {
    await expectCode(
      () => makeCaller(authIdA).candidateAcceptOffer({ offerId: OFFER_A }),
      "CONFLICT",
      "A re-accepting A's offer",
    );
  });

  it("5. candidateGetMyOnboarding is person-scoped", async () => {
    const a = await makeCaller(authIdA).candidateGetMyOnboarding();
    assert.ok(a.case, "A has an onboarding case");
    assert.equal(a.case.positionTitle, "Senior Platform Engineer");
    assert.ok(a.documents.length > 0, "A has document-collection slots");

    const b = await makeCaller(authIdB).candidateGetMyOnboarding();
    assert.equal(b.case, null, "B has no case (never accepted an offer)");
  });

  it("6. upload + candidateAttachDocument progresses the task; self-download logs PII", async () => {
    const [caseRow] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.onboarding_cases WHERE tenant_id = ${CT_TENANT} AND application_id = ${APP_A} LIMIT 1`;
    const caseId = caseRow!.id;
    const [taskRow] = await poolSql<{ document_type_id: string; status: string }[]>`
      SELECT metadata->>'documentTypeId' AS document_type_id, status
      FROM public.onboarding_tasks
      WHERE tenant_id = ${CT_TENANT} AND case_id = ${caseId} AND task_type = 'document_collection'
      ORDER BY created_at, id LIMIT 1`;
    const documentTypeId = taskRow!.document_type_id;
    assert.equal(taskRow!.status, "pending", "task starts pending");

    // Upload via the candidate REST route with A's real JWT.
    const fd = new FormData();
    fd.append(
      "file",
      new File([Buffer.from("%PDF-1.4 cand-02 test doc")], "id.pdf", { type: "application/pdf" }),
    );
    const upRes = await app.request("/api/candidate-documents/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwtA}` },
      body: fd,
    });
    assert.equal(upRes.status, 200, "candidate upload ok");
    const upBody = (await upRes.json()) as {
      storageKey: string;
      sizeBytes: number;
      contentType: string;
    };
    assert.ok(upBody.storageKey.startsWith("onboarding-documents/"));

    const attach = await makeCaller(authIdA).candidateAttachDocument({
      caseId,
      documentTypeId,
      storageKey: upBody.storageKey,
      fileName: "id.pdf",
      mimeType: upBody.contentType,
      sizeBytes: upBody.sizeBytes,
    });
    assert.equal(attach.verificationStatus, "pending");
    assert.equal(attach.taskStatus, "in_progress", "task nudged pending → in_progress");

    // Self-download → 200 + a pii_access_log row (reason candidate_self_download).
    const dlRes = await app.request(`/api/candidate-documents/${attach.documentId}/download`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    assert.equal(dlRes.status, 200, "candidate self-download ok");
    let piiCount = 0;
    for (let i = 0; i < 30; i++) {
      const [row] = await poolSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.pii_access_log
        WHERE entity_type = 'onboarding_document' AND entity_id = ${attach.documentId}
          AND reason = 'candidate_self_download'`;
      piiCount = Number(row?.n ?? 0);
      if (piiCount > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(piiCount >= 1, "self-download wrote a pii_access_log row");
  });

  it("7. candidate cannot attach to another person's case (NOT_FOUND)", async () => {
    const [caseRow] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.onboarding_cases WHERE tenant_id = ${CT_TENANT} AND application_id = ${APP_A} LIMIT 1`;
    const caseId = caseRow!.id;
    const [taskRow] = await poolSql<{ document_type_id: string }[]>`
      SELECT metadata->>'documentTypeId' AS document_type_id
      FROM public.onboarding_tasks
      WHERE tenant_id = ${CT_TENANT} AND case_id = ${caseId} AND task_type = 'document_collection'
      ORDER BY created_at, id LIMIT 1`;
    await expectCode(
      () =>
        makeCaller(authIdB).candidateAttachDocument({
          caseId,
          documentTypeId: taskRow!.document_type_id,
          storageKey: "onboarding-documents/should-not-matter",
          fileName: "x.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
        }),
      "NOT_FOUND",
      "B attaching to A's case",
    );
  });

  it("8. candidate cannot download another person's document (404)", async () => {
    const [doc] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.onboarding_documents WHERE tenant_id = ${CT_TENANT} LIMIT 1`;
    assert.ok(doc, "a document exists (A's, from test 6)");
    const res = await app.request(`/api/candidate-documents/${doc.id}/download`, {
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    assert.equal(res.status, 404, "B cannot download A's document");
  });
});
