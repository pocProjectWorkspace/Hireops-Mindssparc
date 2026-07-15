/**
 * ONBOARD-02 — onboarding case lifecycle: idempotent creation, checklist
 * generation, task/case mutations, and RLS tenant isolation.
 *
 * Coverage:
 *   1.  createOnboardingCaseForApplication (IN hire) → case + full checklist
 *       (10 document tasks + 7 standard tasks), check-in metadata + due dates,
 *       probation_ends_at = start + 90 days.
 *   2.  Idempotency — a second create for the same application is a no-op
 *       (created:false, same case, no duplicate tasks).
 *   3.  Geography scoping — a PH hire gets the common + PH document set (9).
 *   4.  Geography reconciliation — a null location_country defaults to 'IN'.
 *   5.  Offer-accept hook — POST /api/offers/accept opens the case automatically.
 *   6.  updateOnboardingTaskStatus — → completed sets completed_at + writes an
 *       audit_logs row; → blocked requires a reason.
 *   7.  updateOnboardingCase — a geography change soft-adds the newly-applicable
 *       document tasks (GB → IN adds the 5 India-specific ones, no common dupes).
 *   8.  updateOnboardingCase — case status transition guard (illegal rejected,
 *       legal accepted).
 *   9.  RLS — a case is invisible from another tenant's context.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import {
  sql as poolSql,
  db as poolDb,
  withTenantContext,
  onboardingCases,
  onboardingTasks,
  auditLogs,
  type JwtClaims,
} from "@hireops/db";
import { and, eq } from "drizzle-orm";
import { signLink, hashToken } from "@hireops/notifications";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY)
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");

// ONB-02 fixed fixtures (hex-only, UUIDv4-valid; '0b02' ~ "onboard-02").
const ONB_BU = "00000000-0000-4000-8000-00000b020001";
const ONB_POSITION = "00000000-0000-4000-8000-00000b020002";
const ONB_JD = "00000000-0000-4000-8000-00000b020003";
const ONB_REQ = "00000000-0000-4000-8000-00000b020004";
const SYNTH_TENANT = "00000000-0000-4000-8000-00000b02f001";
const EMAIL_MARKER = "@onb02.test";

let jwt: string;
let realClaims: JwtClaims;
let testTenantId: string;
let testMembershipId: string;

async function getTestJwt(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErrorEnv {
  error: { data: { code: string; httpStatus: number } };
}
function isError<T>(env: TRPCSuccess<T> | TRPCErrorEnv): env is TRPCErrorEnv {
  return "error" in env;
}
async function trpcMutation<O>(name: string, input: unknown, opts: { jwt?: string } = {}) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {}),
    },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErrorEnv;
}
async function trpcQuery<O>(name: string, input: unknown = undefined, opts: { jwt?: string } = {}) {
  const inputParam =
    input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(`/trpc/${name}${inputParam}`, {
    method: "GET",
    headers: { ...(opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {}) },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErrorEnv;
}

interface SeedHireOpts {
  suffix: string;
  country: string | null;
  acceptedJoiningDate?: string; // YYYY-MM-DD → inserts an accepted offer
  stage?: string;
}
interface Hire {
  personId: string;
  candidateId: string;
  applicationId: string;
}

async function seedHire(opts: SeedHireOpts): Promise<Hire> {
  const personId = randomUUID();
  const candidateId = randomUUID();
  const applicationId = randomUUID();
  const email = `${opts.suffix}${EMAIL_MARKER}`;
  await poolSql`
    INSERT INTO public.persons
      (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${personId}, ${testTenantId}, ${"Onb " + opts.suffix}, ${email}, ${email}, ${opts.country})
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${candidateId}, ${testTenantId}, ${personId}, 'career_site', 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${applicationId}, ${testTenantId}, ${candidateId}, ${ONB_REQ}, 'career_site',
            ${opts.stage ?? "offer_accepted"}, now())
  `;
  if (opts.acceptedJoiningDate) {
    await poolSql`
      INSERT INTO public.offers
        (tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status)
      VALUES (${testTenantId}, ${applicationId}, ${testMembershipId}, ${4_200_000 * 100},
              ${opts.acceptedJoiningDate}, 'Bengaluru', now() + interval '7 days', 'accepted')
    `;
  }
  return { personId, candidateId, applicationId };
}

async function docTaskCount(applicationId: string): Promise<number> {
  const [row] = await poolSql<{ n: string }[]>`
    SELECT count(*) AS n
    FROM public.onboarding_tasks t
    JOIN public.onboarding_cases c ON c.id = t.case_id
    WHERE c.application_id = ${applicationId} AND t.task_type = 'document_collection'
  `;
  return Number(row?.n ?? 0);
}

/**
 * POST a small file to the authenticated onboarding upload route. Returns the
 * raw Response so callers can assert on status (401 without a JWT) or read the
 * storageKey out of the body.
 */
async function uploadDoc(opts: {
  jwt?: string;
  type?: string;
  bytes?: Buffer;
  name?: string;
}): Promise<Response> {
  const fd = new FormData();
  const type = opts.type ?? "application/pdf";
  const bytes = opts.bytes ?? Buffer.from("%PDF-1.4 onboard-05 test document");
  fd.append("file", new File([bytes], opts.name ?? "id-document.pdf", { type }));
  return app.request("/api/onboarding-documents/upload", {
    method: "POST",
    headers: { ...(opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {}) },
    body: fd,
  });
}

/** The documentTypeId carried in the first document_collection task's metadata. */
async function firstDocTypeIdForCase(caseId: string): Promise<string> {
  const [row] = await poolSql<{ document_type_id: string }[]>`
    SELECT metadata->>'documentTypeId' AS document_type_id
    FROM public.onboarding_tasks
    WHERE case_id = ${caseId} AND task_type = 'document_collection'
    ORDER BY created_at, id
    LIMIT 1
  `;
  if (!row?.document_type_id) throw new Error("no document_collection task for case");
  return row.document_type_id;
}

/** Poll for the fire-and-forget pii_access_log row a download writes. */
async function waitForDownloadPiiRow(documentId: string): Promise<number> {
  for (let i = 0; i < 30; i++) {
    const [row] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.pii_access_log
      WHERE entity_type = 'onboarding_document'
        AND entity_id = ${documentId}
        AND reason = 'download_onboarding_document'
    `;
    if (Number(row?.n ?? 0) > 0) return Number(row?.n);
    await new Promise((r) => setTimeout(r, 100));
  }
  return 0;
}

async function cleanup(): Promise<void> {
  // ONBOARD-05 download tests append pii_access_log rows (append-only, no
  // cascade) — clear this tenant's onboarding-document read log so reruns and
  // the demo groom stay clean.
  await poolSql`
    DELETE FROM public.pii_access_log
    WHERE tenant_id = ${testTenantId} AND entity_type = 'onboarding_document'
  `;
  // The accept-path test drives two side-effects that FK to applications
  // without a cascade — a workday_sync_outbox row and an
  // application_state_transitions row — so clear both (scoped to this
  // requisition's applications) before deleting the applications.
  await poolSql`
    DELETE FROM public.workday_sync_outbox
    WHERE subject_application_id IN (SELECT id FROM public.applications WHERE requisition_id = ${ONB_REQ})
  `;
  await poolSql`
    DELETE FROM public.application_state_transitions
    WHERE application_id IN (SELECT id FROM public.applications WHERE requisition_id = ${ONB_REQ})
  `;
  // Cascades: deleting applications removes onboarding_cases → onboarding_tasks
  // and offers (both onDelete cascade).
  await poolSql`DELETE FROM public.applications WHERE requisition_id = ${ONB_REQ}`;
  await poolSql`
    DELETE FROM public.candidates
    WHERE tenant_id = ${testTenantId}
      AND person_id IN (SELECT id FROM public.persons WHERE email_normalised LIKE ${"%" + EMAIL_MARKER})
  `;
  await poolSql`
    DELETE FROM public.persons
    WHERE tenant_id = ${testTenantId} AND email_normalised LIKE ${"%" + EMAIL_MARKER}
  `;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${ONB_REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${ONB_JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${ONB_POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${ONB_BU}`;
}

describe("ONBOARD-02 — onboarding case lifecycle", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    realClaims = decodeJwt(jwt) as JwtClaims;
    testTenantId = realClaims.tid as string;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${realClaims.sub as string} AND tenant_id = ${testTenantId} LIMIT 1
    `;
    if (!m) throw new Error("test user membership missing");
    testMembershipId = m.id;

    await cleanup();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${ONB_BU}, ${testTenantId}, 'ONB BU', 'onb-bu')`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${ONB_POSITION}, ${testTenantId}, ${ONB_BU}, 'ONB Engineer', 'onsite', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${ONB_JD}, ${testTenantId}, ${ONB_POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${ONB_REQ}, ${testTenantId}, ${ONB_POSITION}, ${ONB_JD}, ${testMembershipId}, ${testMembershipId}, 'posted')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("1. creates a case + full checklist for an IN hire", async () => {
    const start = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const hire = await seedHire({ suffix: "in-hire", country: "IN", acceptedJoiningDate: start });

    const env = await trpcMutation<{ caseId: string; created: boolean; geographyCode: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env), `create error: ${JSON.stringify(env)}`);
    const data = (env as TRPCSuccess<{ caseId: string; created: boolean; geographyCode: string }>)
      .result.data;
    assert.equal(data.created, true);
    assert.equal(data.geographyCode, "IN");

    // 10 document tasks (5 common + 5 IN).
    assert.equal(await docTaskCount(hire.applicationId), 10);

    const tasks = await poolDb
      .select()
      .from(onboardingTasks)
      .where(eq(onboardingTasks.caseId, data.caseId));
    const byType = (t: string) => tasks.filter((x) => x.taskType === t);
    assert.equal(byType("it_provisioning").length, 1);
    assert.equal(byType("buddy_assignment").length, 1);
    assert.equal(byType("training").length, 1);
    assert.equal(byType("probation_review").length, 1);

    const checkIns = byType("check_in");
    assert.equal(checkIns.length, 3);
    const checkInDays = checkIns
      .map((c) => (c.metadata as { checkInDay?: number } | null)?.checkInDay)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    assert.deepEqual(checkInDays, [7, 14, 30]);
    // due_at is populated because the expected start date is known.
    assert.ok(checkIns.every((c) => c.dueAt !== null));

    // probation_ends_at = start + 90 days.
    const [caseRow] = await poolDb
      .select()
      .from(onboardingCases)
      .where(eq(onboardingCases.id, data.caseId));
    const expectedProbationEnd = new Date(`${start}T00:00:00.000Z`);
    expectedProbationEnd.setUTCDate(expectedProbationEnd.getUTCDate() + 90);
    assert.equal(caseRow?.probationEndsAt, expectedProbationEnd.toISOString().slice(0, 10));
    assert.equal(caseRow?.expectedStartDate, start);
  });

  it("2. is idempotent — a second create is a no-op", async () => {
    const hire = await seedHire({ suffix: "idem", country: "IN" });

    const first = await trpcMutation<{ caseId: string; created: boolean }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    const second = await trpcMutation<{ caseId: string; created: boolean }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(first) && !isError(second));
    const d1 = (first as TRPCSuccess<{ caseId: string; created: boolean }>).result.data;
    const d2 = (second as TRPCSuccess<{ caseId: string; created: boolean }>).result.data;
    assert.equal(d1.created, true);
    assert.equal(d2.created, false);
    assert.equal(d1.caseId, d2.caseId);

    // Exactly one case for this application; document tasks not duplicated.
    const cases = await poolDb
      .select()
      .from(onboardingCases)
      .where(eq(onboardingCases.applicationId, hire.applicationId));
    assert.equal(cases.length, 1);
    assert.equal(await docTaskCount(hire.applicationId), 10);
  });

  it("3. scopes documents to geography — a PH hire gets common + PH", async () => {
    const hire = await seedHire({ suffix: "ph-hire", country: "PH" });
    const env = await trpcMutation<{ geographyCode: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    assert.equal((env as TRPCSuccess<{ geographyCode: string }>).result.data.geographyCode, "PH");
    // 5 common + 4 PH = 9.
    assert.equal(await docTaskCount(hire.applicationId), 9);
  });

  it("4. defaults a null location_country to 'IN'", async () => {
    const hire = await seedHire({ suffix: "no-geo", country: null });
    const env = await trpcMutation<{ geographyCode: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    assert.equal((env as TRPCSuccess<{ geographyCode: string }>).result.data.geographyCode, "IN");
    assert.equal(await docTaskCount(hire.applicationId), 10);
  });

  it("5. auto-creates a case when an offer is accepted (accept hook)", async () => {
    const start = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
    const hire = await seedHire({ suffix: "accept", country: "IN", stage: "offer_drafted" });

    // Extend an offer directly (status='extended' + token hash), then POST accept.
    const [offer] = await poolSql<{ id: string; expiry_at: Date | string }[]>`
      INSERT INTO public.offers
        (tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status)
      VALUES (${testTenantId}, ${hire.applicationId}, ${testMembershipId}, ${4_200_000 * 100},
              ${start}, 'Bengaluru', now() + interval '7 days', 'extended')
      RETURNING id, expiry_at
    `;
    assert.ok(offer);
    const expiresAt = offer.expiry_at instanceof Date ? offer.expiry_at : new Date(offer.expiry_at);
    const token = signLink({
      action: "candidate.accept_offer",
      subjectId: offer.id,
      expiresAt,
    });
    await poolSql`
      UPDATE public.offers SET accept_signed_link_token_hash = ${hashToken(token)} WHERE id = ${offer.id}
    `;

    const res = await app.request(`/api/offers/accept/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName: "Onb accept" }),
    });
    assert.equal(res.status, 200);

    const cases = await poolDb
      .select()
      .from(onboardingCases)
      .where(eq(onboardingCases.applicationId, hire.applicationId));
    assert.equal(cases.length, 1);
    assert.equal(cases[0]?.geographyCode, "IN");
    assert.equal(cases[0]?.expectedStartDate, start);
    assert.equal(await docTaskCount(hire.applicationId), 10);
  });

  it("6. updateOnboardingTaskStatus → completed sets completed_at + audit row; blocked needs a reason", async () => {
    const hire = await seedHire({ suffix: "task", country: "IN" });
    const env = await trpcMutation<{ caseId: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    const caseId = (env as TRPCSuccess<{ caseId: string }>).result.data.caseId;

    const [task] = await poolDb
      .select({ id: onboardingTasks.id })
      .from(onboardingTasks)
      .where(
        and(eq(onboardingTasks.caseId, caseId), eq(onboardingTasks.taskType, "it_provisioning")),
      )
      .limit(1);
    assert.ok(task);

    const done = await trpcMutation<{ status: string; completedAt: string | null }>(
      "updateOnboardingTaskStatus",
      { taskId: task.id, status: "completed" },
      { jwt },
    );
    assert.ok(!isError(done), `status update error: ${JSON.stringify(done)}`);
    const doneData = (done as TRPCSuccess<{ status: string; completedAt: string | null }>).result
      .data;
    assert.equal(doneData.status, "completed");
    assert.ok(doneData.completedAt !== null);

    // The audit_record_change() trigger (migration 0047) logs the update.
    const audits = await poolDb
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, testTenantId),
          eq(auditLogs.entityType, "onboarding_tasks"),
          eq(auditLogs.entityId, task.id),
          eq(auditLogs.action, "update"),
        ),
      );
    assert.ok(audits.length >= 1, "expected an audit_logs update row for the task");

    // Blocked without a reason is rejected.
    const blockedNoReason = await trpcMutation(
      "updateOnboardingTaskStatus",
      { taskId: task.id, status: "blocked" },
      { jwt },
    );
    assert.ok(isError(blockedNoReason));
    assert.equal((blockedNoReason as TRPCErrorEnv).error.data.code, "BAD_REQUEST");

    const blocked = await trpcMutation<{ blockedReason: string | null }>(
      "updateOnboardingTaskStatus",
      { taskId: task.id, status: "blocked", blockedReason: "Awaiting laptop stock" },
      { jwt },
    );
    assert.ok(!isError(blocked));
    assert.equal(
      (blocked as TRPCSuccess<{ blockedReason: string | null }>).result.data.blockedReason,
      "Awaiting laptop stock",
    );
  });

  it("7. updateOnboardingCase geography change soft-adds the missing document tasks", async () => {
    // A hire whose person carries a common-only geography (GB → 5 common docs).
    const hire = await seedHire({ suffix: "geo-change", country: "GB" });
    const env = await trpcMutation<{ caseId: string; geographyCode: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    const { caseId, geographyCode } = (
      env as TRPCSuccess<{ caseId: string; geographyCode: string }>
    ).result.data;
    assert.equal(geographyCode, "GB");
    assert.equal(await docTaskCount(hire.applicationId), 5);

    const upd = await trpcMutation<{ geographyCode: string; documentTasksAdded: number }>(
      "updateOnboardingCase",
      { caseId, geographyCode: "IN" },
      { jwt },
    );
    assert.ok(!isError(upd), `update error: ${JSON.stringify(upd)}`);
    const updData = (upd as TRPCSuccess<{ geographyCode: string; documentTasksAdded: number }>)
      .result.data;
    assert.equal(updData.geographyCode, "IN");
    // The 5 India-specific types are added; the 5 common ones are not duplicated.
    assert.equal(updData.documentTasksAdded, 5);
    assert.equal(await docTaskCount(hire.applicationId), 10);
  });

  it("8. updateOnboardingCase enforces the status transition guard", async () => {
    const hire = await seedHire({ suffix: "status", country: "IN" });
    const env = await trpcMutation<{ caseId: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    const caseId = (env as TRPCSuccess<{ caseId: string }>).result.data.caseId;

    // pre_boarding → in_progress skips day_zero — illegal.
    const illegal = await trpcMutation(
      "updateOnboardingCase",
      { caseId, status: "in_progress" },
      { jwt },
    );
    assert.ok(isError(illegal));
    assert.equal((illegal as TRPCErrorEnv).error.data.code, "BAD_REQUEST");

    // pre_boarding → day_zero is legal.
    const legal = await trpcMutation<{ status: string }>(
      "updateOnboardingCase",
      { caseId, status: "day_zero" },
      { jwt },
    );
    assert.ok(!isError(legal));
    assert.equal((legal as TRPCSuccess<{ status: string }>).result.data.status, "day_zero");
  });

  it("9. RLS — a case is invisible from another tenant's context", async () => {
    const hire = await seedHire({ suffix: "rls", country: "IN" });
    const env = await trpcMutation<{ caseId: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    const caseId = (env as TRPCSuccess<{ caseId: string }>).result.data.caseId;

    // Visible from the owning tenant's context.
    const ownVisible = await withTenantContext(realClaims, async ({ db }) =>
      db
        .select({ id: onboardingCases.id })
        .from(onboardingCases)
        .where(eq(onboardingCases.id, caseId)),
    );
    assert.equal(ownVisible.length, 1);

    // Invisible from a different tenant's context (current_tenant_id() = synth tid).
    const synthClaims: JwtClaims = {
      sub: "00000000-0000-4000-8000-00000b02f0aa",
      tid: SYNTH_TENANT,
      roles: ["recruiter"],
    };
    const crossVisible = await withTenantContext(synthClaims, async ({ db }) =>
      db
        .select({ id: onboardingCases.id })
        .from(onboardingCases)
        .where(eq(onboardingCases.id, caseId)),
    );
    assert.equal(crossVisible.length, 0);
  });

  it("10. getOnboardingCaseDetail resolves buddy/manager names + document type names (ONBOARD-04)", async () => {
    const hire = await seedHire({ suffix: "names", country: "IN" });
    const env = await trpcMutation<{ caseId: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    const caseId = (env as TRPCSuccess<{ caseId: string }>).result.data.caseId;

    // Assign buddy + manager to the caller's own membership, then confirm the
    // detail payload reflects the assignment WITH resolved names.
    const upd = await trpcMutation(
      "updateOnboardingCase",
      { caseId, buddyMembershipId: testMembershipId, managerMembershipId: testMembershipId },
      { jwt },
    );
    assert.ok(!isError(upd), `assign error: ${JSON.stringify(upd)}`);

    // Seed one onboarding_document so documentTypeName resolution is exercised.
    const [dt] = await poolSql<{ id: string; name: string }[]>`
      SELECT id, name FROM public.document_types WHERE code = 'pan_card' LIMIT 1
    `;
    assert.ok(dt, "expected the pan_card reference document_type to exist");
    await poolSql`
      INSERT INTO public.onboarding_documents
        (tenant_id, case_id, document_type_id, storage_ref, verification_status)
      VALUES (${testTenantId}, ${caseId}, ${dt.id}, 'seed://onb04-doc', 'pending')
    `;

    const detail = await trpcQuery<{
      case: {
        buddyMembershipId: string | null;
        managerMembershipId: string | null;
        buddyName: string | null;
        buddyEmail: string | null;
        managerName: string | null;
        managerEmail: string | null;
      };
      documents: { documentTypeId: string; documentTypeName: string | null }[];
    }>("getOnboardingCaseDetail", { caseId }, { jwt });
    assert.ok(!isError(detail), `detail error: ${JSON.stringify(detail)}`);
    const d = (
      detail as TRPCSuccess<{
        case: {
          buddyMembershipId: string | null;
          managerMembershipId: string | null;
          buddyName: string | null;
          buddyEmail: string | null;
          managerName: string | null;
          managerEmail: string | null;
        };
        documents: { documentTypeId: string; documentTypeName: string | null }[];
      }>
    ).result.data;

    assert.equal(d.case.buddyMembershipId, testMembershipId);
    assert.equal(d.case.managerMembershipId, testMembershipId);
    // email always resolves (auth.users); display_name may be null.
    assert.equal(d.case.buddyEmail, TEST_EMAIL);
    assert.equal(d.case.managerEmail, TEST_EMAIL);

    const doc = d.documents.find((x) => x.documentTypeId === dt.id);
    assert.ok(doc, "expected the seeded document in the detail payload");
    assert.equal(doc.documentTypeName, dt.name);
  });

  it("11. listTenantMemberships returns this tenant's active members, tenant-scoped (ONBOARD-04)", async () => {
    const env = await trpcQuery<{
      items: { membershipId: string; email: string | null; roles: string[] }[];
    }>("listTenantMemberships", undefined, { jwt });
    assert.ok(!isError(env), `list error: ${JSON.stringify(env)}`);
    const items = (
      env as TRPCSuccess<{
        items: { membershipId: string; email: string | null; roles: string[] }[];
      }>
    ).result.data.items;

    const mine = items.find((m) => m.membershipId === testMembershipId);
    assert.ok(mine, "expected the caller's own membership in the list");
    assert.equal(mine.email, TEST_EMAIL);
    assert.ok(Array.isArray(mine.roles));

    // Tenant-scoping: every returned id resolves to a membership in THIS
    // tenant (a cross-tenant leak would leave some ids unmatched).
    const ids = items.map((m) => m.membershipId);
    const [countRow] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.tenant_user_memberships
      WHERE tenant_id = ${testTenantId} AND id::text = ANY(${ids})
    `;
    assert.equal(countRow?.n, ids.length);
  });

  // ─────────────── ONBOARD-05 — document upload + verification ───────────────

  it("12. upload route rejects an unauthenticated request (401)", async () => {
    const res = await uploadDoc({}); // no jwt
    assert.equal(res.status, 401);
  });

  it("13. upload → attach shows the document row + moves the task to in_progress", async () => {
    const hire = await seedHire({ suffix: "attach", country: "IN" });
    const env = await trpcMutation<{ caseId: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    const caseId = (env as TRPCSuccess<{ caseId: string }>).result.data.caseId;
    const documentTypeId = await firstDocTypeIdForCase(caseId);

    const up = await uploadDoc({ jwt });
    assert.equal(up.status, 200);
    const upBody = (await up.json()) as {
      storageKey: string;
      sizeBytes: number;
      contentType: string;
    };
    assert.ok(upBody.storageKey.startsWith("onboarding-documents/"));

    const attach = await trpcMutation<{
      documentId: string;
      created: boolean;
      taskId: string | null;
      taskStatus: string | null;
    }>(
      "attachOnboardingDocument",
      {
        caseId,
        documentTypeId,
        storageKey: upBody.storageKey,
        fileName: "id-document.pdf",
        mimeType: upBody.contentType,
        sizeBytes: upBody.sizeBytes,
      },
      { jwt },
    );
    assert.ok(!isError(attach), `attach error: ${JSON.stringify(attach)}`);
    const aData = (
      attach as TRPCSuccess<{ documentId: string; created: boolean; taskStatus: string | null }>
    ).result.data;
    assert.equal(aData.created, true);
    assert.equal(aData.taskStatus, "in_progress");

    // The detail payload now carries the document row (pending) and the task
    // reads in_progress.
    const detail = await trpcQuery<{
      tasks: { taskType: string; status: string; metadata?: unknown }[];
      documents: { id: string; documentTypeId: string; verificationStatus: string }[];
    }>("getOnboardingCaseDetail", { caseId }, { jwt });
    assert.ok(!isError(detail));
    const dData = (
      detail as TRPCSuccess<{
        tasks: { taskType: string; status: string; metadata?: unknown }[];
        documents: { id: string; documentTypeId: string; verificationStatus: string }[];
      }>
    ).result.data;
    const docRow = dData.documents.find((d) => d.documentTypeId === documentTypeId);
    assert.ok(docRow, "expected the attached document in the detail payload");
    assert.equal(docRow.verificationStatus, "pending");
    const docTask = dData.tasks.find(
      (t) =>
        t.taskType === "document_collection" &&
        (t.metadata as { documentTypeId?: string } | null)?.documentTypeId === documentTypeId,
    );
    assert.ok(docTask);
    assert.equal(docTask.status, "in_progress");
  });

  it("14. verify → document verified + matching task completed", async () => {
    const hire = await seedHire({ suffix: "verify", country: "IN" });
    const env = await trpcMutation<{ caseId: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    const caseId = (env as TRPCSuccess<{ caseId: string }>).result.data.caseId;
    const documentTypeId = await firstDocTypeIdForCase(caseId);

    const up = await uploadDoc({ jwt });
    const upBody = (await up.json()) as {
      storageKey: string;
      sizeBytes: number;
      contentType: string;
    };
    const attach = await trpcMutation<{ documentId: string }>(
      "attachOnboardingDocument",
      {
        caseId,
        documentTypeId,
        storageKey: upBody.storageKey,
        fileName: "id.pdf",
        mimeType: upBody.contentType,
        sizeBytes: upBody.sizeBytes,
      },
      { jwt },
    );
    assert.ok(!isError(attach));
    const documentId = (attach as TRPCSuccess<{ documentId: string }>).result.data.documentId;

    const verify = await trpcMutation<{ verificationStatus: string; taskStatus: string | null }>(
      "verifyOnboardingDocument",
      { documentId },
      { jwt },
    );
    assert.ok(!isError(verify), `verify error: ${JSON.stringify(verify)}`);
    const vData = (verify as TRPCSuccess<{ verificationStatus: string; taskStatus: string | null }>)
      .result.data;
    assert.equal(vData.verificationStatus, "verified");
    assert.equal(vData.taskStatus, "completed");

    // verified_at + verifier stamped; detail exposes the verifier name.
    const detail = await trpcQuery<{
      documents: {
        id: string;
        verificationStatus: string;
        verifiedAt: string | null;
        verifierName: string | null;
      }[];
    }>("getOnboardingCaseDetail", { caseId }, { jwt });
    assert.ok(!isError(detail));
    const doc = (
      detail as TRPCSuccess<{
        documents: {
          id: string;
          verificationStatus: string;
          verifiedAt: string | null;
          verifierName: string | null;
        }[];
      }>
    ).result.data.documents.find((d) => d.id === documentId);
    assert.ok(doc);
    assert.equal(doc.verificationStatus, "verified");
    assert.ok(doc.verifiedAt !== null);
    // verifierName resolves via the piggy-backed membership lookup — the test
    // user's display_name ("FND-15b Test User") when set, else its email. We
    // only assert it resolved (non-null), not which of the two.
    assert.ok(doc.verifierName !== null, "expected the verifier name to resolve");
  });

  it("15. reject requires a reason (400 without); with one → rejected + task pending", async () => {
    const hire = await seedHire({ suffix: "reject", country: "IN" });
    const env = await trpcMutation<{ caseId: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    const caseId = (env as TRPCSuccess<{ caseId: string }>).result.data.caseId;
    const documentTypeId = await firstDocTypeIdForCase(caseId);

    const up = await uploadDoc({ jwt });
    const upBody = (await up.json()) as {
      storageKey: string;
      sizeBytes: number;
      contentType: string;
    };
    const attach = await trpcMutation<{ documentId: string }>(
      "attachOnboardingDocument",
      {
        caseId,
        documentTypeId,
        storageKey: upBody.storageKey,
        fileName: "id.pdf",
        mimeType: upBody.contentType,
        sizeBytes: upBody.sizeBytes,
      },
      { jwt },
    );
    assert.ok(!isError(attach));
    const documentId = (attach as TRPCSuccess<{ documentId: string }>).result.data.documentId;

    // No reason → 400 (zod min(1) rejects the missing field).
    const noReason = await trpcMutation("rejectOnboardingDocument", { documentId }, { jwt });
    assert.ok(isError(noReason));
    assert.equal((noReason as TRPCErrorEnv).error.data.code, "BAD_REQUEST");

    const rejected = await trpcMutation<{ verificationStatus: string; taskStatus: string | null }>(
      "rejectOnboardingDocument",
      { documentId, rejectionReason: "Aadhaar photo is blurred — please re-scan." },
      { jwt },
    );
    assert.ok(!isError(rejected), `reject error: ${JSON.stringify(rejected)}`);
    const rData = (
      rejected as TRPCSuccess<{ verificationStatus: string; taskStatus: string | null }>
    ).result.data;
    assert.equal(rData.verificationStatus, "rejected");
    assert.equal(rData.taskStatus, "pending");
  });

  it("16. download streams the blob AND writes a pii_access_log row", async () => {
    const hire = await seedHire({ suffix: "download", country: "IN" });
    const env = await trpcMutation<{ caseId: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    const caseId = (env as TRPCSuccess<{ caseId: string }>).result.data.caseId;
    const documentTypeId = await firstDocTypeIdForCase(caseId);

    const bytes = Buffer.from("%PDF-1.4 downloadable onboarding blob");
    const up = await uploadDoc({ jwt, bytes });
    const upBody = (await up.json()) as {
      storageKey: string;
      sizeBytes: number;
      contentType: string;
    };
    const attach = await trpcMutation<{ documentId: string }>(
      "attachOnboardingDocument",
      {
        caseId,
        documentTypeId,
        storageKey: upBody.storageKey,
        fileName: "blob.pdf",
        mimeType: upBody.contentType,
        sizeBytes: upBody.sizeBytes,
      },
      { jwt },
    );
    assert.ok(!isError(attach));
    const documentId = (attach as TRPCSuccess<{ documentId: string }>).result.data.documentId;

    // Unauthenticated download is rejected.
    const anon = await app.request(`/api/onboarding-documents/${documentId}/download`);
    assert.equal(anon.status, 401);

    const res = await app.request(`/api/onboarding-documents/${documentId}/download`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    assert.equal(res.status, 200);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.toString(), bytes.toString());

    const piiRows = await waitForDownloadPiiRow(documentId);
    assert.ok(piiRows >= 1, "expected a pii_access_log row for the download");
  });

  it("17. attach is tenant-isolated — a cross-tenant case is invisible (404)", async () => {
    const hire = await seedHire({ suffix: "attach-rls", country: "IN" });
    const env = await trpcMutation<{ caseId: string }>(
      "createOnboardingCaseForApplication",
      { applicationId: hire.applicationId },
      { jwt },
    );
    assert.ok(!isError(env));
    const caseId = (env as TRPCSuccess<{ caseId: string }>).result.data.caseId;
    const documentTypeId = await firstDocTypeIdForCase(caseId);

    const up = await uploadDoc({ jwt });
    const upBody = (await up.json()) as {
      storageKey: string;
      sizeBytes: number;
      contentType: string;
    };

    // A JWT for THIS tenant cannot attach to a case it can't see — but there is
    // no second real tenant JWT here, so we assert the inverse: an unknown
    // caseId (as any other tenant's case would appear) resolves to NOT_FOUND.
    const bogus = await trpcMutation(
      "attachOnboardingDocument",
      {
        caseId: SYNTH_TENANT, // a well-formed uuid that is not this tenant's case
        documentTypeId,
        storageKey: upBody.storageKey,
        fileName: "id.pdf",
        mimeType: upBody.contentType,
        sizeBytes: upBody.sizeBytes,
      },
      { jwt },
    );
    assert.ok(isError(bogus));
    assert.equal((bogus as TRPCErrorEnv).error.data.code, "NOT_FOUND");
  });
});
