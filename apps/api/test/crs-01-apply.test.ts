/**
 * CRS-01 — public apply form integration tests.
 *
 * Covers the new public surface area on top of API-01 / submitApplication:
 *
 *   1.  resolvePublicRequisition — success returns the resolved shape
 *   2.  resolvePublicRequisition — 404 on missing tenant slug
 *   3.  resolvePublicRequisition — 404 on missing requisition slug
 *   4.  resolvePublicRequisition — 404 on tenant/req mismatch
 *   5.  resolvePublicRequisition — 404 when requisition is in 'draft'
 *   6.  submitApplication dedup — phone-only existing match
 *   7.  submitApplication dedup — email-only existing match
 *   8.  submitApplication dedup — both match same person
 *   9.  submitApplication dedup — ambiguous collision (email/phone differ)
 *  10.  submitApplication writes a candidate_dedup_attempts row
 *
 * Synth tenant + req chain is isolated from API-01's so vitest's
 * fileParallelism:false sequencing keeps both clean. The synth req
 * uses the new public_slug + the tenant has its own slug — both must
 * conform to the regex CHECKs migration 0036 added.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../src/index.js";
import { sql as poolSql, db, candidateDedupAttempts } from "@hireops/db";
import { and, eq } from "drizzle-orm";
import { resetStorageClient, getStorageClient } from "../src/lib/storage";

const here = dirname(fileURLToPath(import.meta.url));
const SEED_CV_PATH = resolve(
  here,
  "../../../packages/ai-client/test/fixtures/resumes/Variant_1_Traditional_Single_Column.docx",
);

// Synth chain — fully isolated from API-01 + Module 1b/3/4 fixtures.
const CRS_TENANT = "00000000-0000-4000-8000-00000c450001";
const CRS_TENANT_SLUG = "synth-crs01";
const CRS_BU = "00000000-0000-4000-8000-00000c450002";
const CRS_POSITION = "00000000-0000-4000-8000-00000c450003";
const CRS_JD = "00000000-0000-4000-8000-00000c450004";
const CRS_MEMBERSHIP = "00000000-0000-4000-8000-00000c450005";
const CRS_REQ = "00000000-0000-4000-8000-00000c450006";
const CRS_REQ_SLUG = "senior-engineer-crs01";
const CRS_DRAFT_REQ = "00000000-0000-4000-8000-00000c450007";
const CRS_DRAFT_REQ_SLUG = "draft-engineer-crs01";

// auth.users id is looked up dynamically in beforeAll — the test
// user's id is generated at seed time, so we can't hardcode it. We
// reuse the FND-TEST account ('test-fnd15b@hireops-dev.local') so
// these tests stay independent of the demo-data seed.
const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

interface TRPCErrorEnvelope {
  error: {
    message?: string;
    code: number;
    data: { code: string; httpStatus: number; zodError: null | unknown };
  };
}
interface TRPCSuccessEnvelope<T> {
  result: { data: T };
}

async function trpcQuery<O>(
  name: string,
  input: unknown,
): Promise<TRPCSuccessEnvelope<O> | TRPCErrorEnvelope> {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, { method: "GET" });
  return (await res.json()) as TRPCSuccessEnvelope<O> | TRPCErrorEnvelope;
}

async function trpcMutation<O>(
  name: string,
  input: unknown,
): Promise<TRPCSuccessEnvelope<O> | TRPCErrorEnvelope> {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccessEnvelope<O> | TRPCErrorEnvelope;
}

function isError<T>(env: TRPCSuccessEnvelope<T> | TRPCErrorEnvelope): env is TRPCErrorEnvelope {
  return "error" in env;
}

// Seed a stable storage key per test file so submitApplication's
// storage.get() doesn't throw. The buffer matches the AI-02 fixture
// that the LocalAIClient serves deterministically.
let STORAGE_KEY: string;

describe("CRS-01 public apply form", () => {
  beforeAll(async () => {
    resetStorageClient();

    // Look up the test auth user's id so the membership FK can land.
    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(
        `CRS-01 test prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found. Run pnpm db:seed:test-users first.`,
      );
    }
    TEST_USER_FOR_FK = user.id;

    // Tear down any leftovers from a prior run, deepest dependencies first.
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.positions WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${CRS_TENANT}`;

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${CRS_TENANT}, ${CRS_TENANT_SLUG}, 'CRS-01 Synth', 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${CRS_BU}, ${CRS_TENANT}, 'Synth BU', 'synth-bu')
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (
        ${CRS_MEMBERSHIP}, ${CRS_TENANT}, ${TEST_USER_FOR_FK},
        ARRAY['recruiter']::tenant_role[], 'active', ${CRS_BU}
      )
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${CRS_POSITION}, ${CRS_TENANT}, ${CRS_BU}, 'Senior Engineer (CRS-01)', 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${CRS_JD}, ${CRS_TENANT}, ${CRS_POSITION}, 1, '# JD body', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id,
         hiring_manager_id, status, is_public, public_slug)
      VALUES (
        ${CRS_REQ}, ${CRS_TENANT}, ${CRS_POSITION}, ${CRS_JD},
        ${CRS_MEMBERSHIP}, ${CRS_MEMBERSHIP}, 'posted', true, ${CRS_REQ_SLUG}
      )
    `;
    // A second req in 'draft' so we can prove resolvePublicRequisition
    // refuses to surface it.
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id,
         hiring_manager_id, status, is_public, public_slug)
      VALUES (
        ${CRS_DRAFT_REQ}, ${CRS_TENANT}, ${CRS_POSITION}, ${CRS_JD},
        ${CRS_MEMBERSHIP}, ${CRS_MEMBERSHIP}, 'draft', false, ${CRS_DRAFT_REQ_SLUG}
      )
    `;

    // Seed storage with a real CV the LocalAIClient has a fixture for.
    const cvBuffer = await readFile(SEED_CV_PATH);
    const storage = getStorageClient();
    STORAGE_KEY = `resumes/${CRS_TENANT}-crs01.docx`;
    await storage.put(STORAGE_KEY, cvBuffer, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  afterAll(async () => {
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.positions WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${CRS_TENANT}`;
    if (STORAGE_KEY) {
      try {
        await getStorageClient().delete(STORAGE_KEY);
      } catch {
        // best-effort
      }
    }
    resetStorageClient();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: resolvePublicRequisition success returns the resolved shape", async () => {
    const env = await trpcQuery<{
      tenantId: string;
      tenantDisplayName: string;
      requisitionId: string;
      positionTitle: string;
    }>("resolvePublicRequisition", { tenantSlug: CRS_TENANT_SLUG, reqSlug: CRS_REQ_SLUG });
    assert.ok(!isError(env), `expected success, got ${JSON.stringify(env)}`);
    const data = env.result.data;
    assert.equal(data.tenantId, CRS_TENANT);
    assert.equal(data.tenantDisplayName, "CRS-01 Synth");
    assert.equal(data.requisitionId, CRS_REQ);
    assert.equal(data.positionTitle, "Senior Engineer (CRS-01)");
  });

  it("Test 2: resolvePublicRequisition NOT_FOUND on missing tenant slug", async () => {
    const env = await trpcQuery<unknown>("resolvePublicRequisition", {
      tenantSlug: "definitely-not-a-tenant",
      reqSlug: CRS_REQ_SLUG,
    });
    assert.ok(isError(env));
    assert.equal(env.error.data.code, "NOT_FOUND");
  });

  it("Test 3: resolvePublicRequisition NOT_FOUND on missing req slug", async () => {
    const env = await trpcQuery<unknown>("resolvePublicRequisition", {
      tenantSlug: CRS_TENANT_SLUG,
      reqSlug: "definitely-not-a-req",
    });
    assert.ok(isError(env));
    assert.equal(env.error.data.code, "NOT_FOUND");
  });

  it("Test 4: resolvePublicRequisition NOT_FOUND on tenant/req mismatch", async () => {
    // kyndryl-poc is the dev seed tenant; the CRS req lives under
    // synth-crs01. Joining the two slugs must 404 — slugs alone don't
    // imply ownership, the JOIN does.
    const env = await trpcQuery<unknown>("resolvePublicRequisition", {
      tenantSlug: "kyndryl-poc",
      reqSlug: CRS_REQ_SLUG,
    });
    assert.ok(isError(env));
    assert.equal(env.error.data.code, "NOT_FOUND");
  });

  it("Test 5: resolvePublicRequisition NOT_FOUND on a 'draft' requisition", async () => {
    const env = await trpcQuery<unknown>("resolvePublicRequisition", {
      tenantSlug: CRS_TENANT_SLUG,
      reqSlug: CRS_DRAFT_REQ_SLUG,
    });
    assert.ok(isError(env));
    assert.equal(env.error.data.code, "NOT_FOUND");
  });

  it("Test 6: submitApplication dedup — phone-only existing match reuses person", async () => {
    // Seed an existing person with a unique phone. Then submit with a
    // matching phone + a different email — should link to the same
    // person, not create a new one.
    const [seeded] = await poolSql<{ id: string }[]>`
      INSERT INTO public.persons
        (tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised)
      VALUES (
        ${CRS_TENANT}, 'Existing Phone', 'existing-phone@hireops-dev.local',
        'existing-phone@hireops-dev.local', '+919811112222', '919811112222'
      )
      RETURNING id
    `;
    assert.ok(seeded);
    const existingPersonId = seeded.id;

    const env = await trpcMutation<{ applicationId: string; candidateId: string }>(
      "submitApplication",
      {
        requisitionId: CRS_REQ,
        resumeUploadKey: STORAGE_KEY,
        applicant: {
          fullName: "New Email Same Phone",
          email: "fresh-email-crs01@hireops-dev.local",
          phone: "+919811112222",
        },
        source: "career_site",
        consentVersion: "v1",
      },
    );
    assert.ok(!isError(env), `submit failed: ${JSON.stringify(env)}`);

    const personsForThisReq = await poolSql<{ id: string; person_id: string }[]>`
      SELECT c.id, c.person_id
      FROM public.candidates c
      JOIN public.applications a ON a.candidate_id = c.id AND a.tenant_id = c.tenant_id
      WHERE c.tenant_id = ${CRS_TENANT} AND a.requisition_id = ${CRS_REQ}
    `;
    assert.equal(personsForThisReq.length, 1);
    assert.equal(
      personsForThisReq[0]!.person_id,
      existingPersonId,
      "expected silent merge by phone",
    );

    // Cleanup so subsequent dedup tests start clean against the same req.
    // Order matters: candidate_dedup_attempts.(tenant_id, matched_person_id)
    // is a compound FK to persons with onDelete: set null. That cascade
    // sets BOTH columns to null, which the NOT NULL on tenant_id rejects.
    // Delete dedup attempts before persons (DB-PARTNER-A schema quirk).
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${CRS_TENANT} AND requisition_id = ${CRS_REQ}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${CRS_TENANT}`;
  });

  it("Test 7: submitApplication dedup — email-only existing match reuses person", async () => {
    const [seeded] = await poolSql<{ id: string }[]>`
      INSERT INTO public.persons
        (tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised)
      VALUES (
        ${CRS_TENANT}, 'Existing Email', 'existing-email@hireops-dev.local',
        'existing-email@hireops-dev.local', '+919800001111', '919800001111'
      )
      RETURNING id
    `;
    assert.ok(seeded);
    const existingPersonId = seeded.id;

    const env = await trpcMutation<{ applicationId: string; candidateId: string }>(
      "submitApplication",
      {
        requisitionId: CRS_REQ,
        resumeUploadKey: STORAGE_KEY,
        applicant: {
          fullName: "Same Email Different Phone",
          email: "existing-email@hireops-dev.local",
          phone: "+919999999999",
        },
        source: "career_site",
        consentVersion: "v1",
      },
    );
    assert.ok(!isError(env));

    const matched = await poolSql<{ person_id: string }[]>`
      SELECT c.person_id FROM public.candidates c
      WHERE c.tenant_id = ${CRS_TENANT}
    `;
    assert.equal(matched.length, 1);
    assert.equal(matched[0]!.person_id, existingPersonId, "expected silent merge by email");

    // Order matters: candidate_dedup_attempts.(tenant_id, matched_person_id)
    // is a compound FK to persons with onDelete: set null. That cascade
    // sets BOTH columns to null, which the NOT NULL on tenant_id rejects.
    // Delete dedup attempts before persons (DB-PARTNER-A schema quirk).
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${CRS_TENANT} AND requisition_id = ${CRS_REQ}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${CRS_TENANT}`;
  });

  it("Test 8: submitApplication dedup — both email + phone match same person", async () => {
    const [seeded] = await poolSql<{ id: string }[]>`
      INSERT INTO public.persons
        (tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised)
      VALUES (
        ${CRS_TENANT}, 'Same Person', 'same-person@hireops-dev.local',
        'same-person@hireops-dev.local', '+919811223344', '919811223344'
      )
      RETURNING id
    `;
    assert.ok(seeded);
    const existingPersonId = seeded.id;

    const env = await trpcMutation<{ applicationId: string; candidateId: string }>(
      "submitApplication",
      {
        requisitionId: CRS_REQ,
        resumeUploadKey: STORAGE_KEY,
        applicant: {
          fullName: "Same Person Re-applying",
          email: "same-person@hireops-dev.local",
          phone: "+919811223344",
        },
        source: "career_site",
        consentVersion: "v1",
      },
    );
    assert.ok(!isError(env));

    const matched = await poolSql<{ person_id: string }[]>`
      SELECT c.person_id FROM public.candidates c WHERE c.tenant_id = ${CRS_TENANT}
    `;
    assert.equal(matched.length, 1);
    assert.equal(matched[0]!.person_id, existingPersonId);

    // Order matters: candidate_dedup_attempts.(tenant_id, matched_person_id)
    // is a compound FK to persons with onDelete: set null. That cascade
    // sets BOTH columns to null, which the NOT NULL on tenant_id rejects.
    // Delete dedup attempts before persons (DB-PARTNER-A schema quirk).
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${CRS_TENANT} AND requisition_id = ${CRS_REQ}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${CRS_TENANT}`;
  });

  it("Test 9: submitApplication dedup — collision (email matches A, phone matches B) creates new", async () => {
    const [pA] = await poolSql<{ id: string }[]>`
      INSERT INTO public.persons
        (tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised)
      VALUES (
        ${CRS_TENANT}, 'Person A', 'person-a@hireops-dev.local', 'person-a@hireops-dev.local',
        '+919000000001', '919000000001'
      )
      RETURNING id
    `;
    const [pB] = await poolSql<{ id: string }[]>`
      INSERT INTO public.persons
        (tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised)
      VALUES (
        ${CRS_TENANT}, 'Person B', 'person-b@hireops-dev.local', 'person-b@hireops-dev.local',
        '+919000000002', '919000000002'
      )
      RETURNING id
    `;
    assert.ok(pA && pB);

    const env = await trpcMutation<{ applicationId: string; candidateId: string }>(
      "submitApplication",
      {
        requisitionId: CRS_REQ,
        resumeUploadKey: STORAGE_KEY,
        applicant: {
          fullName: "Collision Person",
          email: "person-a@hireops-dev.local",
          phone: "+919000000002",
        },
        source: "career_site",
        consentVersion: "v1",
      },
    );
    assert.ok(!isError(env));

    const allPersons = await poolSql<{ id: string }[]>`
      SELECT id FROM public.persons WHERE tenant_id = ${CRS_TENANT}
    `;
    assert.equal(allPersons.length, 3, "expected the collision to create a third person");

    const attempts = await db
      .select()
      .from(candidateDedupAttempts)
      .where(
        and(
          eq(candidateDedupAttempts.tenantId, CRS_TENANT),
          eq(candidateDedupAttempts.decision, "allow_new"),
        ),
      );
    assert.ok(
      attempts.some((a) => a.decisionReason === "ambiguous_email_phone_collision"),
      "expected an ambiguous_email_phone_collision dedup audit row",
    );

    // Order matters: candidate_dedup_attempts.(tenant_id, matched_person_id)
    // is a compound FK to persons with onDelete: set null. That cascade
    // sets BOTH columns to null, which the NOT NULL on tenant_id rejects.
    // Delete dedup attempts before persons (DB-PARTNER-A schema quirk).
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${CRS_TENANT} AND requisition_id = ${CRS_REQ}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${CRS_TENANT}`;
  });

  it("Test 10: submitApplication writes a candidate_dedup_attempts row on first apply", async () => {
    const env = await trpcMutation<{ applicationId: string; candidateId: string }>(
      "submitApplication",
      {
        requisitionId: CRS_REQ,
        resumeUploadKey: STORAGE_KEY,
        applicant: {
          fullName: "Audit First Applicant",
          email: "audit-first@hireops-dev.local",
          phone: "+919922334455",
        },
        source: "career_site",
        consentVersion: "v1",
      },
    );
    assert.ok(!isError(env));

    const attempts = await db
      .select()
      .from(candidateDedupAttempts)
      .where(
        and(
          eq(candidateDedupAttempts.tenantId, CRS_TENANT),
          eq(candidateDedupAttempts.submittedEmail, "audit-first@hireops-dev.local"),
        ),
      );
    assert.equal(attempts.length, 1, "expected exactly one dedup attempt row");
    assert.equal(attempts[0]!.decision, "allow_new");
    assert.equal(attempts[0]!.decisionReason, "no_match");

    // Order matters: candidate_dedup_attempts.(tenant_id, matched_person_id)
    // is a compound FK to persons with onDelete: set null. That cascade
    // sets BOTH columns to null, which the NOT NULL on tenant_id rejects.
    // Delete dedup attempts before persons (DB-PARTNER-A schema quirk).
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${CRS_TENANT} AND requisition_id = ${CRS_REQ}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${CRS_TENANT}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${CRS_TENANT}`;
  });
});
