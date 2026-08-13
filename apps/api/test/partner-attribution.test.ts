/**
 * P0.5 — partner attribution readable + offer-outcome partner emails.
 *
 * Three loose ends this ticket ties off, each with its own test:
 *
 *   1. `applications.source_partner_id` was written on every partner
 *      submission and read by NOTHING — recruiters saw a generic "Partner"
 *      chip with no idea WHICH partner. `listCandidatesByRequisition` and
 *      `getCandidateById` now carry `partnerOrgName` (null for direct
 *      applications), and the chips render "Partner · <name>".
 *   2. `candidate_dedup_attempts` was a write-only audit trail. The new
 *      PARTNER_ADMIN_ROLES read `listPartnerOrgDedupAttempts` surfaces an
 *      org's rejected/deduped submissions for dispute triage.
 *   3. The raw-SQL offer accept path (lib/offer-accept.ts, shared by the
 *      signed link and candidateAcceptOffer) bypassed
 *      transitionApplicationStage, so the P0.4 partner stage email never
 *      fired for offer_accepted — the outcome a partner cares most about.
 *      runOfferAcceptSideEffects now calls the extracted
 *      enqueuePartnerStageChangedEmail helper.
 *
 * Harness follows partner-notifications.test.ts exactly: real appRouter via
 * createCaller, PARTNER ctx (bare sub) + INTERNAL ctx (tenantId + roles),
 * poolSql fixtures, per-fixture assertions only. The offer path is driven by
 * calling runOfferAcceptSideEffects directly — that function IS the shared
 * accept path (cand-02-docs-offer.test.ts / onboarding.test cover its two
 * entry points), so driving it exercises exactly what production runs.
 *
 * Tests run in file order and share fixtures: Test 1's submission creates the
 * partner application Tests 2–3 use.
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
import { runOfferAcceptSideEffects } from "../src/lib/offer-accept";

const here = dirname(fileURLToPath(import.meta.url));
const SEED_CV_PATH = resolve(
  here,
  "../../../packages/ai-client/test/fixtures/resumes/Variant_1_Traditional_Single_Column.docx",
);

// a08 synth namespace (a02 partner-auth, a03 partner-submission, a04
// partner-admin, a05 partner-invite-accept, a06 partner-claims, a07
// partner-notifications).
const PT_TENANT = "00000000-0000-4000-8000-0000000a08a1";
const PT_TENANT_B = "00000000-0000-4000-8000-0000000a08a2";
const PT_BU = "00000000-0000-4000-8000-0000000a08c1";
const PT_MEMBERSHIP = "00000000-0000-4000-8000-0000000a08c2";
const PT_POSITION = "00000000-0000-4000-8000-0000000a08c3";
const PT_JD = "00000000-0000-4000-8000-0000000a08c4";
const PT_REQ = "00000000-0000-4000-8000-0000000a08d1";
const PT_ORG_A = "00000000-0000-4000-8000-0000000a08b1";
const PT_ORG_B = "00000000-0000-4000-8000-0000000a08b2";
const PT_ORG_OTHER_TENANT = "00000000-0000-4000-8000-0000000a08b3";
const PT_PARTNER_USER_A = "00000000-0000-4000-8000-0000000a08e1";
const PT_PARTNER_USER_B = "00000000-0000-4000-8000-0000000a08e2";

// The direct (non-partner) applicant — the negative control throughout.
const PT_PERSON_DIRECT = "00000000-0000-4000-8000-0000000a08f1";
const PT_CANDIDATE_DIRECT = "00000000-0000-4000-8000-0000000a08f2";
const PT_APP_DIRECT = "00000000-0000-4000-8000-0000000a08f3";

const PT_OFFER = "00000000-0000-4000-8000-0000000a0801";

const TENANT_SLUG = "synth-partner-attr";
const COMPANY_NAME = "Partner-Attr Synth";
const ORG_A_NAME = "BrightPath Synth A";
const ORG_B_NAME = "SwiftHire Synth B";
const PARTNER_A_EMAIL = "asha@brightpath-a.example";
const PARTNER_B_EMAIL = "vikram@swifthire-b.example";

const PARTNER_A_AUTH = randomUUID();
const PARTNER_B_AUTH = randomUUID();

const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

const CANDIDATE_NAME = "Meera Attribution";
const CANDIDATE_EMAIL = "meera.attribution@example.com";
const CONSENT_VERSION = "partner-msa-v1-test";

let STORAGE_KEY: string;
/** Test 1's partner submission; Tests 2–3 reuse it. */
let PARTNER_APP_ID: string;
let PARTNER_CANDIDATE_ID: string;

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
    requestId: `test-partner-attr-p-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

function makeInternalCaller(roles: string[]) {
  const ctx: HonoTRPCContext = {
    tenantId: PT_TENANT,
    userId: TEST_USER_FOR_FK,
    roles,
    claims: { sub: TEST_USER_FOR_FK, tid: PT_TENANT, tenant_slug: TENANT_SLUG, roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-attr-i-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function cleanup(): Promise<void> {
  for (const t of [PT_TENANT, PT_TENANT_B]) {
    await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.workday_sync_outbox WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.onboarding_tasks WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.onboarding_documents WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.onboarding_cases WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.offers WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.candidate_ownership_claims WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${t}`;
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

describe("P0.5 partner attribution + offer-outcome emails", () => {
  beforeAll(async () => {
    resetStorageClient();

    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(
        `P0.5 prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found. Run pnpm db:seed:test-users first.`,
      );
    }
    TEST_USER_FOR_FK = user.id;

    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PT_TENANT}, ${TENANT_SLUG}, ${COMPANY_NAME}, 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PT_BU}, ${PT_TENANT}, 'PT BU', 'pt-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${PT_MEMBERSHIP}, ${PT_TENANT}, ${TEST_USER_FOR_FK}, ARRAY['admin','hr_ops','recruiter']::tenant_role[], 'active', ${PT_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${PT_POSITION}, ${PT_TENANT}, ${PT_BU}, 'Synth Attr Engineer', 'remote', 'Remote-India', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${PT_JD}, ${PT_TENANT}, ${PT_POSITION}, 1, '# JD', 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${PT_REQ}, ${PT_TENANT}, ${PT_POSITION}, ${PT_JD}, ${PT_MEMBERSHIP}, ${PT_MEMBERSHIP}, 'posted', true)`;

    // Two orgs in the tenant: A owns the claim, B trips the dedup.
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PT_ORG_A}, ${PT_TENANT}, ${ORG_A_NAME}, 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PT_ORG_B}, ${PT_TENANT}, ${ORG_B_NAME}, 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PT_PARTNER_USER_A}, ${PT_TENANT}, ${PT_ORG_A}, ${PARTNER_A_AUTH}, 'Asha Synth', ${PARTNER_A_EMAIL}, 'partner_admin', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PT_PARTNER_USER_B}, ${PT_TENANT}, ${PT_ORG_B}, ${PARTNER_B_AUTH}, 'Vikram Synth', ${PARTNER_B_EMAIL}, 'partner_admin', true)`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PT_TENANT}, ${PT_ORG_A}, ${PT_REQ}, ${PT_MEMBERSHIP}, 'active')`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PT_TENANT}, ${PT_ORG_B}, ${PT_REQ}, ${PT_MEMBERSHIP}, 'active')`;

    // Direct applicant on the same req — must stay partnerOrgName: null.
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PT_PERSON_DIRECT}, ${PT_TENANT}, 'Direct Attr Applicant', 'direct.attr@example.com', 'direct.attr@example.com', '+919800000801', '919800000801')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${PT_CANDIDATE_DIRECT}, ${PT_TENANT}, ${PT_PERSON_DIRECT}, 'career_site')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${PT_APP_DIRECT}, ${PT_TENANT}, ${PT_CANDIDATE_DIRECT}, ${PT_REQ}, 'career_site', 'recruiter_review')`;

    // The OTHER tenant, holding an org the tenant-A caller must not see.
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PT_TENANT_B}, 'synth-partner-attr-b', 'Attr Other Tenant', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PT_ORG_OTHER_TENANT}, ${PT_TENANT_B}, 'Other-Tenant Org', 'empanelled', true)`;

    const cvBuffer = await readFile(SEED_CV_PATH);
    STORAGE_KEY = `resumes/${PT_TENANT}-p05.docx`;
    await getStorageClient().put(STORAGE_KEY, cvBuffer, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  afterAll(async () => {
    await cleanup();
    resetStorageClient();
    await poolSql.end({ timeout: 10 });
  });

  function submitInput() {
    return {
      requisitionId: PT_REQ,
      resumeUploadKey: STORAGE_KEY,
      candidate: {
        fullName: CANDIDATE_NAME,
        email: CANDIDATE_EMAIL,
        phone: "+919812340808",
        locationCountry: "IN",
      },
      consentAttested: true as const,
      ownershipAcknowledged: true as const,
      consentVersion: CONSENT_VERSION,
    };
  }

  it("Test 1: partnerOrgName rides the recruiter list and the drawer read; direct stays null", async () => {
    const out = await makePartnerCaller(PARTNER_A_AUTH).partnerSubmitCandidate(submitInput());
    assert.equal(out.outcome, "created", "fresh candidate → created");
    if (out.outcome !== "created") return;
    PARTNER_APP_ID = out.applicationId;

    const [appRow] = await poolSql<{ candidate_id: string }[]>`
      SELECT candidate_id FROM public.applications WHERE id = ${PARTNER_APP_ID}
    `;
    assert.ok(appRow, "partner application row exists");
    PARTNER_CANDIDATE_ID = appRow.candidate_id;

    // Recruiter list: the partner row names the agency, the direct row doesn't.
    const list = await makeInternalCaller(["recruiter"]).listCandidatesByRequisition({});
    const allRows = list.groups.flatMap((g) => g.rows);
    const partnerRow = allRows.find((r) => r.applicationId === PARTNER_APP_ID);
    const directRow = allRows.find((r) => r.applicationId === PT_APP_DIRECT);
    assert.ok(partnerRow, "partner-sourced application in the recruiter list");
    assert.equal(partnerRow.partnerOrgName, ORG_A_NAME, "list names the sourcing agency");
    assert.ok(directRow, "direct application in the recruiter list");
    assert.equal(directRow.partnerOrgName, null, "direct application carries null");

    // Drawer read: same attribution on the application facet.
    const drawer = await makeInternalCaller(["admin"]).getCandidateById({
      id: PARTNER_CANDIDATE_ID,
    });
    assert.equal(
      drawer.application?.partnerOrgName,
      ORG_A_NAME,
      "drawer names the sourcing agency",
    );
    const directDrawer = await makeInternalCaller(["admin"]).getCandidateById({
      id: PT_CANDIDATE_DIRECT,
    });
    assert.equal(directDrawer.application?.partnerOrgName, null, "direct drawer carries null");
  });

  it("Test 2: listPartnerOrgDedupAttempts surfaces org B's blocked submission; gated + tenant-scoped", async () => {
    // Org B trips the dedup on the candidate org A owns.
    const blocked = await makePartnerCaller(PARTNER_B_AUTH).partnerSubmitCandidate(submitInput());
    assert.equal(blocked.outcome, "duplicate_blocked", "org A's claim blocks org B");

    const outAdmin = await makeInternalCaller(["admin"]).listPartnerOrgDedupAttempts({
      partnerOrgId: PT_ORG_B,
    });
    const attempt = outAdmin.items[0];
    assert.ok(attempt, "org B has at least the blocked attempt");
    assert.equal(attempt.decision, "block_active_claim", "the attempt records the block");
    assert.equal(outAdmin.capped, false, "nowhere near the cap");

    // hr_ops may read it too (PARTNER_ADMIN_ROLES); recruiter may not.
    await makeInternalCaller(["hr_ops"]).listPartnerOrgDedupAttempts({ partnerOrgId: PT_ORG_B });
    await assert.rejects(
      makeInternalCaller(["recruiter"]).listPartnerOrgDedupAttempts({ partnerOrgId: PT_ORG_B }),
      (err: unknown) => err instanceof TRPCError && err.code === "FORBIDDEN",
      "recruiter is FORBIDDEN",
    );

    // Another tenant's org is indistinguishable from a nonexistent one.
    await assert.rejects(
      makeInternalCaller(["admin"]).listPartnerOrgDedupAttempts({
        partnerOrgId: PT_ORG_OTHER_TENANT,
      }),
      (err: unknown) => err instanceof TRPCError && err.code === "NOT_FOUND",
      "other tenant's org → NOT_FOUND",
    );
  });

  it("Test 3: the offer-accept path emails the sourcing partner once; direct apps stay silent", async () => {
    // A minimal extended offer on the partner application.
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status, extended_at)
      VALUES
        (${PT_OFFER}, ${PT_TENANT}, ${PARTNER_APP_ID}, ${PT_MEMBERSHIP}, 250000000,
         (now() + interval '30 days')::date, 'Remote-India', now() + interval '7 days',
         'extended', now())
    `;

    // Drive the SHARED accept path (what both the signed link and
    // candidateAcceptOffer call after flipping the offer row).
    await runOfferAcceptSideEffects(poolSql, {
      tenantId: PT_TENANT,
      applicationId: PARTNER_APP_ID,
      offerId: PT_OFFER,
      log,
    });

    const dedupKey = `partner_stage:${PARTNER_APP_ID}:offer_accepted`;
    const rows = await poolSql<
      { template_key: string; recipient_email: string; template_data: Record<string, unknown> }[]
    >`
      SELECT template_key, recipient_email, template_data
      FROM public.notification_outbox
      WHERE tenant_id = ${PT_TENANT} AND dedup_key = ${dedupKey}
    `;
    assert.equal(rows.length, 1, "exactly one offer-accepted email for the partner");
    const row = rows[0];
    assert.ok(row, "the enqueued row is readable");
    assert.equal(row.template_key, "partner.stage_changed", "the P0.4 stage template");
    assert.equal(row.recipient_email, PARTNER_A_EMAIL, "addressed to the SUBMITTING partner user");
    // Privacy posture: stage + date + name, nothing internal.
    for (const forbidden of ["reason", "score", "feedback", "interviewer", "declineReason"]) {
      assert.ok(!(forbidden in row.template_data), `template_data must not carry ${forbidden}`);
    }

    // Re-running the side effects (retry semantics) must not duplicate.
    await runOfferAcceptSideEffects(poolSql, {
      tenantId: PT_TENANT,
      applicationId: PARTNER_APP_ID,
      offerId: PT_OFFER,
      log,
    });
    const after = await poolSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM public.notification_outbox
      WHERE tenant_id = ${PT_TENANT} AND dedup_key = ${dedupKey}
    `;
    assert.equal(after[0]?.count, "1", "dedup absorbs the retry");

    // The direct application goes through the same path and emails nobody.
    await runOfferAcceptSideEffects(poolSql, {
      tenantId: PT_TENANT,
      applicationId: PT_APP_DIRECT,
      offerId: randomUUID(),
      log,
    });
    const direct = await poolSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM public.notification_outbox
      WHERE tenant_id = ${PT_TENANT}
        AND dedup_key = ${`partner_stage:${PT_APP_DIRECT}:offer_accepted`}
    `;
    assert.equal(direct[0]?.count, "0", "no partner attached → no email");
  });
});
