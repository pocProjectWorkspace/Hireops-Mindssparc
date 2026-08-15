/**
 * P1.1 — partnerGetRequisitionDetail (the partner portal's req detail read).
 *
 * Wireflows §3.4 promise the partner a FULL requisition view — JD, comp band,
 * logistics, knockout questions — and requirements.md §6.3 fences what they
 * must never see: internal identities (hiring manager, recruiter), other
 * partners, or the req's total candidate count. Test 3 asserts the fence at
 * the payload level (absent KEYS, not just empty values) so a future field
 * addition has to answer the privacy question in review.
 *
 * Authorization is assignment-is-authorization, same as partnerSubmitCandidate:
 * an unassigned req, another tenant's req, and a nonexistent req all raise the
 * IDENTICAL FORBIDDEN — a partner must not be able to probe what exists.
 *
 * Harness follows partner-auth/partner-submission exactly (real appRouter via
 * createCaller, bare-sub partner ctx, poolSql fixtures, per-fixture asserts).
 * Tests run in file order and share fixtures.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";
import { resetStorageClient, getStorageClient } from "../src/lib/storage";

const here = dirname(fileURLToPath(import.meta.url));
const SEED_CV_PATH = resolve(
  here,
  "../../../packages/ai-client/test/fixtures/resumes/Variant_1_Traditional_Single_Column.docx",
);

// a09 synth namespace (a02 partner-auth … a08 partner-attribution).
const PR_TENANT = "00000000-0000-4000-8000-0000000a09a1";
const PR_TENANT_B = "00000000-0000-4000-8000-0000000a09a2";
const PR_BU = "00000000-0000-4000-8000-0000000a09c1";
const PR_MEMBERSHIP = "00000000-0000-4000-8000-0000000a09c2";
const PR_POSITION = "00000000-0000-4000-8000-0000000a09c3";
const PR_JD = "00000000-0000-4000-8000-0000000a09c4";
// req 1 = actively assigned; req 2 = never assigned; req 3 = assignment ended.
const PR_REQ_ASSIGNED = "00000000-0000-4000-8000-0000000a09d1";
const PR_REQ_UNASSIGNED = "00000000-0000-4000-8000-0000000a09d2";
const PR_REQ_ENDED = "00000000-0000-4000-8000-0000000a09d3";
const PR_ORG = "00000000-0000-4000-8000-0000000a09b1";
const PR_PARTNER_USER = "00000000-0000-4000-8000-0000000a09e1";
const PR_KO_1 = "00000000-0000-4000-8000-0000000a09f1";
const PR_KO_2 = "00000000-0000-4000-8000-0000000a09f2";
// Other tenant: same-shaped req the partner must not be able to distinguish
// from a nonexistent one.
const PR_B_BU = "00000000-0000-4000-8000-0000000a0991";
const PR_B_POSITION = "00000000-0000-4000-8000-0000000a0992";
const PR_B_JD = "00000000-0000-4000-8000-0000000a0993";
const PR_B_REQ = "00000000-0000-4000-8000-0000000a0994";

const TENANT_SLUG = "synth-partner-reqs";
const POSITION_TITLE = "Synth Reqs Engineer";
const JD_TEXT = "# Role\nBuild synthetic requisitions end to end.";

const PARTNER_AUTH = randomUUID();
const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

let STORAGE_KEY: string;

const log = createLogger({ level: "error" });

function makePartnerCaller(userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: { sub: userId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-reqs-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function cleanup(): Promise<void> {
  for (const t of [PR_TENANT, PR_TENANT_B]) {
    await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.candidate_ownership_claims WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.requisition_knockouts WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.partner_assignments WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.partner_users WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.partner_orgs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.positions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${t}`;
  }
}

describe("P1.1 partnerGetRequisitionDetail", () => {
  beforeAll(async () => {
    resetStorageClient();

    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(
        `P1.1 prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found. Run pnpm db:seed:test-users first.`,
      );
    }
    TEST_USER_FOR_FK = user.id;

    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PR_TENANT}, ${TENANT_SLUG}, 'Partner-Reqs Synth', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PR_BU}, ${PR_TENANT}, 'PR BU', 'pr-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${PR_MEMBERSHIP}, ${PR_TENANT}, ${TEST_USER_FOR_FK}, ARRAY['admin']::tenant_role[], 'active', ${PR_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, level, function, location_type, primary_location, comp_band_min, comp_band_max, comp_currency, is_active) VALUES (${PR_POSITION}, ${PR_TENANT}, ${PR_BU}, ${POSITION_TITLE}, 'L4', 'Engineering', 'remote', 'Remote-India', 2500000, 4200000, 'INR', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${PR_JD}, ${PR_TENANT}, ${PR_POSITION}, 1, ${JD_TEXT}, 'approved')`;
    for (const req of [PR_REQ_ASSIGNED, PR_REQ_UNASSIGNED, PR_REQ_ENDED]) {
      await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, number_of_openings, is_public, posted_at) VALUES (${req}, ${PR_TENANT}, ${PR_POSITION}, ${PR_JD}, ${PR_MEMBERSHIP}, ${PR_MEMBERSHIP}, 'posted', 2, true, now())`;
    }
    await poolSql`
      INSERT INTO public.requisition_knockouts
        (id, tenant_id, requisition_id, question_text, type, threshold_value, source, order_index)
      VALUES
        (${PR_KO_1}, ${PR_TENANT}, ${PR_REQ_ASSIGNED}, 'At least 5 yrs experience?',
         'numeric_min', ${JSON.stringify({ field_path: "total_years_experience", min: 5 })}::jsonb,
         'parsed_cv', 0),
        (${PR_KO_2}, ${PR_TENANT}, ${PR_REQ_ASSIGNED}, 'Java in technical skills?',
         'enum', ${JSON.stringify({ field_path: "skills.technical", allowed: ["Java"] })}::jsonb,
         'parsed_cv', 1)
    `;

    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PR_ORG}, ${PR_TENANT}, 'ReqView Synth', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PR_PARTNER_USER}, ${PR_TENANT}, ${PR_ORG}, ${PARTNER_AUTH}, 'Reena Synth', 'reena@reqview.example', 'partner_admin', true)`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PR_TENANT}, ${PR_ORG}, ${PR_REQ_ASSIGNED}, ${PR_MEMBERSHIP}, 'active')`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status, ended_at) VALUES (${PR_TENANT}, ${PR_ORG}, ${PR_REQ_ENDED}, ${PR_MEMBERSHIP}, 'ended', now())`;

    // The other tenant's fully-formed req — must be indistinguishable from
    // a nonexistent id for our partner.
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PR_TENANT_B}, 'synth-partner-reqs-b', 'Reqs Other Tenant', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PR_B_BU}, ${PR_TENANT_B}, 'PRB BU', 'prb-bu')`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active) VALUES (${PR_B_POSITION}, ${PR_TENANT_B}, ${PR_B_BU}, 'Other-Tenant Role', 'remote', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${PR_B_JD}, ${PR_TENANT_B}, ${PR_B_POSITION}, 1, '# Other', 'approved')`;
    const [bMembership] = await poolSql<{ id: string }[]>`
      INSERT INTO public.tenant_user_memberships (tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${PR_TENANT_B}, ${TEST_USER_FOR_FK}, ARRAY['admin']::tenant_role[], 'active', ${PR_B_BU})
      RETURNING id
    `;
    if (!bMembership) throw new Error("tenant-B membership fixture insert returned no row");
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${PR_B_REQ}, ${PR_TENANT_B}, ${PR_B_POSITION}, ${PR_B_JD}, ${bMembership.id}, ${bMembership.id}, 'posted', true)`;

    const cvBuffer = await readFile(SEED_CV_PATH);
    STORAGE_KEY = `resumes/${PR_TENANT}-p11.docx`;
    await getStorageClient().put(STORAGE_KEY, cvBuffer, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  afterAll(async () => {
    await cleanup();
    resetStorageClient();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: unassigned, other-tenant, and nonexistent reqs raise the identical FORBIDDEN", async () => {
    const caller = makePartnerCaller(PARTNER_AUTH);
    const cases: [string, string][] = [
      [PR_REQ_UNASSIGNED, "unassigned req in own tenant"],
      [PR_B_REQ, "another tenant's req"],
      [randomUUID(), "nonexistent req"],
    ];
    for (const [reqId, label] of cases) {
      await assert.rejects(
        caller.partnerGetRequisitionDetail({ requisitionId: reqId }),
        (err: unknown) =>
          err instanceof TRPCError &&
          err.code === "FORBIDDEN" &&
          err.message === "requisition_not_assigned",
        `${label} → identical FORBIDDEN`,
      );
    }
  });

  it("Test 2: assigned req returns JD, comp band, ordered knockouts; submission count moves 0 → 1", async () => {
    const caller = makePartnerCaller(PARTNER_AUTH);
    const before = await caller.partnerGetRequisitionDetail({ requisitionId: PR_REQ_ASSIGNED });

    assert.equal(before.title, POSITION_TITLE);
    assert.equal(before.status, "posted");
    assert.equal(before.numberOfOpenings, 2);
    assert.equal(before.jdText, JD_TEXT, "the requisition's jd_version text");
    assert.equal(before.compCurrency, "INR");
    assert.ok(before.compBandMin !== null && before.compBandMax !== null, "comp band disclosed");
    assert.equal(before.knockouts.length, 2);
    assert.deepEqual(
      before.knockouts.map((k) => k.orderIndex),
      [0, 1],
      "knockouts in order",
    );
    assert.equal(before.knockouts[0]?.questionText, "At least 5 yrs experience?");
    assert.equal(before.yourSubmissionCount, 0, "no submissions yet");

    const submitted = await caller.partnerSubmitCandidate({
      requisitionId: PR_REQ_ASSIGNED,
      resumeUploadKey: STORAGE_KEY,
      candidate: {
        fullName: "Kiran Reqs",
        email: "kiran.reqs@example.com",
        phone: "+919812340909",
        locationCountry: "IN",
      },
      consentAttested: true,
      ownershipAcknowledged: true,
      consentVersion: "partner-msa-v1-test",
    });
    assert.equal(submitted.outcome, "created");

    const after = await caller.partnerGetRequisitionDetail({ requisitionId: PR_REQ_ASSIGNED });
    assert.equal(after.yourSubmissionCount, 1, "the org's OWN submission count");
  });

  it("Test 3: the payload carries no internal identities and no total counts (§6.3 fence)", async () => {
    const out = await makePartnerCaller(PARTNER_AUTH).partnerGetRequisitionDetail({
      requisitionId: PR_REQ_ASSIGNED,
    });
    const keys = Object.keys(out as Record<string, unknown>);
    for (const forbidden of [
      "hiringManagerId",
      "hiringManager",
      "primaryRecruiterId",
      "recruiter",
      "recruiterName",
      "totalApplications",
      "applicationCount",
      "candidateCount",
      "otherPartners",
    ]) {
      assert.ok(!keys.includes(forbidden), `payload must not carry ${forbidden}`);
    }
    // Whole-payload allowlist: a new field must consciously pass this test.
    const allowed = new Set([
      "requisitionId",
      "status",
      "numberOfOpenings",
      "postedAt",
      "targetStartDate",
      "assignedAt",
      "title",
      "level",
      "jobFunction",
      "locationType",
      "primaryLocation",
      "compBandMin",
      "compBandMax",
      "compCurrency",
      "jdText",
      "jdSummary",
      "knockouts",
      "yourSubmissionCount",
    ]);
    for (const k of keys) {
      assert.ok(allowed.has(k), `unexpected payload key ${k} — update the §6.3 review`);
    }
  });

  it("Test 4: an ENDED assignment no longer authorizes the detail read", async () => {
    await assert.rejects(
      makePartnerCaller(PARTNER_AUTH).partnerGetRequisitionDetail({
        requisitionId: PR_REQ_ENDED,
      }),
      (err: unknown) =>
        err instanceof TRPCError &&
        err.code === "FORBIDDEN" &&
        err.message === "requisition_not_assigned",
      "ended assignment → FORBIDDEN",
    );
  });
});
