/**
 * P2.2 — partner commercials: the MSA, the claim window it sizes, and the fee
 * each partner-sourced hire accrues under it.
 *
 * Five tests, in dependency order — they share fixtures and run in file order:
 *
 *   1. upsertPartnerMsa is close-and-reopen, not an edit: the first upsert
 *      creates the live row, the second stamps effective_to on it and becomes
 *      live itself. Operand pairing (percentage with no percent) is a
 *      BAD_REQUEST from the zod refinement, not a 23514 from the DB CHECK, and
 *      the whole thing is PARTNER_ADMIN_ROLES.
 *   2. The exclusivity window is now REAL: an org with an MSA gets its
 *      exclusivity_window_days, an org without one still gets the hardcoded 90.
 *   3. Accrual on offer-accept: 20% of a ₹25,00,000 base is ₹5,00,000, the
 *      terms are frozen into msa_snapshot, holdback_release_at is the
 *      acceptance plus the replacement guarantee — and a retried accept, a
 *      direct application and a partner org with no MSA all accrue nothing.
 *   4. partnerGetCommercials is org-admin only and org-scoped: org B's admin
 *      sees org B's (empty) ledger, never org A's rows.
 *   5. The internal read's rollups match the rows, and another tenant's org is
 *      NOT_FOUND.
 *
 * Harness is partner-attribution.test.ts's verbatim: real appRouter via
 * createCaller, PARTNER ctx (bare sub) + INTERNAL ctx (tenantId + roles),
 * poolSql fixtures, and the offer path driven by calling
 * runOfferAcceptSideEffects directly — that function IS the shared accept path,
 * so driving it exercises exactly what production runs.
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

// a13 synth namespace (a08 partner-attribution was the last partner one).
const PC_TENANT = "00000000-0000-4000-8000-0000000a13a1";
const PC_TENANT_B = "00000000-0000-4000-8000-0000000a13a2";
const PC_BU = "00000000-0000-4000-8000-0000000a13c1";
const PC_MEMBERSHIP = "00000000-0000-4000-8000-0000000a13c2";
const PC_POSITION = "00000000-0000-4000-8000-0000000a13c3";
const PC_JD = "00000000-0000-4000-8000-0000000a13c4";
const PC_REQ = "00000000-0000-4000-8000-0000000a13d1";
const PC_ORG_A = "00000000-0000-4000-8000-0000000a13b1";
const PC_ORG_B = "00000000-0000-4000-8000-0000000a13b2";
const PC_ORG_OTHER_TENANT = "00000000-0000-4000-8000-0000000a13b3";
const PC_PARTNER_ADMIN_A = "00000000-0000-4000-8000-0000000a13e1";
const PC_PARTNER_USER_A = "00000000-0000-4000-8000-0000000a13e2";
const PC_PARTNER_ADMIN_B = "00000000-0000-4000-8000-0000000a13e3";

// The direct (non-partner) applicant — the negative control for accrual.
const PC_PERSON_DIRECT = "00000000-0000-4000-8000-0000000a13f1";
const PC_CANDIDATE_DIRECT = "00000000-0000-4000-8000-0000000a13f2";
const PC_APP_DIRECT = "00000000-0000-4000-8000-0000000a13f3";
const PC_OFFER_DIRECT = "00000000-0000-4000-8000-0000000a1303";

const PC_OFFER_A = "00000000-0000-4000-8000-0000000a1301";
const PC_OFFER_B = "00000000-0000-4000-8000-0000000a1302";

const TENANT_SLUG = "synth-partner-comm";
const COMPANY_NAME = "Partner-Commercials Synth";
const ORG_A_NAME = "Northwind Synth A";
const ORG_B_NAME = "Southgate Synth B";
const PARTNER_ADMIN_A_EMAIL = "leela@northwind-a.example";
const PARTNER_USER_A_EMAIL = "raj@northwind-a.example";
const PARTNER_ADMIN_B_EMAIL = "sunil@southgate-b.example";

const PARTNER_ADMIN_A_AUTH = randomUUID();
const PARTNER_USER_A_AUTH = randomUUID();
const PARTNER_ADMIN_B_AUTH = randomUUID();

const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

/** The live terms Tests 2–5 all lean on. */
const WINDOW_DAYS = 30;
const GUARANTEE_DAYS = 45;
const FEE_PERCENT = 20;
/** ₹25,00,000 in paise — the offer base every accrual test uses. */
const BASE_SALARY_PAISE = 2_500_000_00;
/** 20% of the above, rounded down (it divides exactly). */
const EXPECTED_FEE_MINOR = 500_000_00;

const CONSENT_VERSION = "partner-msa-v1-test";

let STORAGE_KEY: string;
/** Test 2's org-A submission; Tests 3–5 reuse it. */
let APP_A_ID: string;
/** Test 2's org-B submission (the org with no MSA). */
let APP_B_ID: string;

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
    requestId: `test-partner-comm-p-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

function makeInternalCaller(roles: string[]) {
  const ctx: HonoTRPCContext = {
    tenantId: PC_TENANT,
    userId: TEST_USER_FOR_FK,
    roles,
    claims: { sub: TEST_USER_FOR_FK, tid: PC_TENANT, tenant_slug: TENANT_SLUG, roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-comm-i-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

/** Whole days between two ISO instants, rounded — the windows are day-scale. */
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (new Date(toIso).getTime() - new Date(fromIso).getTime()) / (24 * 60 * 60 * 1000),
  );
}

async function cleanup(): Promise<void> {
  for (const t of [PC_TENANT, PC_TENANT_B]) {
    await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.workday_sync_outbox WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.onboarding_tasks WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.onboarding_documents WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.onboarding_cases WHERE tenant_id = ${t}`;
    // Fees FK partner_orgs / applications with ON DELETE RESTRICT (they are
    // financial records), so they have to go before either of those.
    await poolSql`DELETE FROM public.partner_fees WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.partner_msa WHERE tenant_id = ${t}`;
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

describe("P2.2 partner commercials — MSA, claim window, fee accrual", () => {
  beforeAll(async () => {
    resetStorageClient();

    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(
        `P2.2 prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found. Run pnpm db:seed:test-users first.`,
      );
    }
    TEST_USER_FOR_FK = user.id;

    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PC_TENANT}, ${TENANT_SLUG}, ${COMPANY_NAME}, 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PC_BU}, ${PC_TENANT}, 'PC BU', 'pc-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${PC_MEMBERSHIP}, ${PC_TENANT}, ${TEST_USER_FOR_FK}, ARRAY['admin','hr_ops','recruiter']::tenant_role[], 'active', ${PC_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${PC_POSITION}, ${PC_TENANT}, ${PC_BU}, 'Synth Commercials Engineer', 'remote', 'Remote-India', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${PC_JD}, ${PC_TENANT}, ${PC_POSITION}, 1, '# JD', 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${PC_REQ}, ${PC_TENANT}, ${PC_POSITION}, ${PC_JD}, ${PC_MEMBERSHIP}, ${PC_MEMBERSHIP}, 'posted', true)`;

    // Two orgs: A signs an MSA, B never does — the whole point of Tests 2–4.
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PC_ORG_A}, ${PC_TENANT}, ${ORG_A_NAME}, 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PC_ORG_B}, ${PC_TENANT}, ${ORG_B_NAME}, 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PC_PARTNER_ADMIN_A}, ${PC_TENANT}, ${PC_ORG_A}, ${PARTNER_ADMIN_A_AUTH}, 'Leela Synth', ${PARTNER_ADMIN_A_EMAIL}, 'partner_admin', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PC_PARTNER_USER_A}, ${PC_TENANT}, ${PC_ORG_A}, ${PARTNER_USER_A_AUTH}, 'Raj Synth', ${PARTNER_USER_A_EMAIL}, 'partner_user', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PC_PARTNER_ADMIN_B}, ${PC_TENANT}, ${PC_ORG_B}, ${PARTNER_ADMIN_B_AUTH}, 'Sunil Synth', ${PARTNER_ADMIN_B_EMAIL}, 'partner_admin', true)`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PC_TENANT}, ${PC_ORG_A}, ${PC_REQ}, ${PC_MEMBERSHIP}, 'active')`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PC_TENANT}, ${PC_ORG_B}, ${PC_REQ}, ${PC_MEMBERSHIP}, 'active')`;

    // Direct applicant on the same req — must accrue nothing on accept.
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PC_PERSON_DIRECT}, ${PC_TENANT}, 'Direct Comm Applicant', 'direct.comm@example.com', 'direct.comm@example.com', '+919800001301', '919800001301')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${PC_CANDIDATE_DIRECT}, ${PC_TENANT}, ${PC_PERSON_DIRECT}, 'career_site')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${PC_APP_DIRECT}, ${PC_TENANT}, ${PC_CANDIDATE_DIRECT}, ${PC_REQ}, 'career_site', 'recruiter_review')`;

    // The OTHER tenant, holding an org the tenant-A caller must not see.
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PC_TENANT_B}, 'synth-partner-comm-b', 'Commercials Other Tenant', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PC_ORG_OTHER_TENANT}, ${PC_TENANT_B}, 'Other-Tenant Commercials Org', 'empanelled', true)`;

    const cvBuffer = await readFile(SEED_CV_PATH);
    STORAGE_KEY = `resumes/${PC_TENANT}-p22.docx`;
    await getStorageClient().put(STORAGE_KEY, cvBuffer, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  afterAll(async () => {
    await cleanup();
    resetStorageClient();
    await poolSql.end({ timeout: 10 });
  });

  function submitInput(candidate: { fullName: string; email: string; phone: string }) {
    return {
      requisitionId: PC_REQ,
      resumeUploadKey: STORAGE_KEY,
      candidate: { ...candidate, locationCountry: "IN" },
      consentAttested: true as const,
      ownershipAcknowledged: true as const,
      consentVersion: CONSENT_VERSION,
    };
  }

  it("Test 1: upsertPartnerMsa closes and reopens; operand pairing and the role gate hold", async () => {
    const admin = makeInternalCaller(["admin"]);

    // First terms: a flat fee, so the second upsert is a real model change.
    const first = await admin.upsertPartnerMsa({
      partnerOrgId: PC_ORG_A,
      feeModel: "flat_per_hire",
      flatFeeMinor: 300_000_00,
      feeCurrency: "INR",
      exclusivityWindowDays: 60,
      exclusivityScope: "org_wide",
      probationHoldbackPercent: 25,
      replacementGuaranteeDays: 90,
    });
    assert.equal(first.closedMsaId, null, "nothing to close on the first agreement");

    const afterFirst = await admin.getPartnerOrgCommercials({ partnerOrgId: PC_ORG_A });
    assert.equal(afterFirst.msa?.msaId, first.msaId, "the first row is live");
    assert.equal(afterFirst.msa?.feeModel, "flat_per_hire");
    assert.equal(afterFirst.msa?.flatFeeMinor, 300_000_00);
    assert.equal(afterFirst.msa?.feePercent, null, "the unused operand is stored NULL");
    assert.equal(afterFirst.msa?.effectiveTo, null, "a live row has no effective_to");

    // Re-agreed terms — these are the ones Tests 2-5 run against.
    const second = await admin.upsertPartnerMsa({
      partnerOrgId: PC_ORG_A,
      feeModel: "percentage_ctc",
      feePercent: FEE_PERCENT,
      feeCurrency: "INR",
      exclusivityWindowDays: WINDOW_DAYS,
      exclusivityScope: "org_wide",
      probationHoldbackPercent: 25,
      replacementGuaranteeDays: GUARANTEE_DAYS,
    });
    assert.equal(second.closedMsaId, first.msaId, "the second upsert closed the first row");
    assert.notEqual(second.msaId, first.msaId, "a new row, not an edit of the old one");

    const afterSecond = await admin.getPartnerOrgCommercials({ partnerOrgId: PC_ORG_A });
    assert.equal(afterSecond.msa?.msaId, second.msaId, "the new row is the live one");
    assert.equal(afterSecond.msa?.feePercent, FEE_PERCENT);
    assert.equal(afterSecond.msa?.flatFeeMinor, null, "the flat operand is cleared by the switch");
    assert.equal(afterSecond.msa?.exclusivityWindowDays, WINDOW_DAYS);

    // The superseded row is still there, stamped — history, not a deletion.
    const [closedRow] = await poolSql<{ effective_to: string | null }[]>`
      SELECT effective_to FROM public.partner_msa WHERE id = ${first.msaId}
    `;
    assert.ok(closedRow?.effective_to, "the superseded row carries an effective_to");

    // Operand pairing is the zod refinement (BAD_REQUEST), not the DB CHECK.
    await assert.rejects(
      admin.upsertPartnerMsa({
        partnerOrgId: PC_ORG_A,
        feeModel: "percentage_ctc",
        feeCurrency: "INR",
        exclusivityWindowDays: 30,
        exclusivityScope: "org_wide",
        probationHoldbackPercent: 25,
        replacementGuaranteeDays: 90,
      }),
      (err: unknown) => err instanceof TRPCError && err.code === "BAD_REQUEST",
      "percentage model with no percent → BAD_REQUEST",
    );

    // hr_ops may; recruiter may not (PARTNER_ADMIN_ROLES).
    await makeInternalCaller(["hr_ops"]).getPartnerOrgCommercials({ partnerOrgId: PC_ORG_A });
    await assert.rejects(
      makeInternalCaller(["recruiter"]).upsertPartnerMsa({
        partnerOrgId: PC_ORG_A,
        feeModel: "flat_per_hire",
        flatFeeMinor: 100_000_00,
        feeCurrency: "INR",
        exclusivityWindowDays: 30,
        exclusivityScope: "org_wide",
        probationHoldbackPercent: 25,
        replacementGuaranteeDays: 90,
      }),
      (err: unknown) => err instanceof TRPCError && err.code === "FORBIDDEN",
      "recruiter is FORBIDDEN",
    );

    // The failed writes changed nothing.
    const unchanged = await admin.getPartnerOrgCommercials({ partnerOrgId: PC_ORG_A });
    assert.equal(unchanged.msa?.msaId, second.msaId, "the live row survived both rejections");
  });

  it("Test 2: the claim window comes from the live MSA, and falls back to 90 without one", async () => {
    const outA = await makePartnerCaller(PARTNER_ADMIN_A_AUTH).partnerSubmitCandidate(
      submitInput({
        fullName: "Anita Commercials",
        email: "anita.commercials@example.com",
        phone: "+919812341301",
      }),
    );
    assert.equal(outA.outcome, "created", "fresh candidate → created");
    if (outA.outcome !== "created") return;
    APP_A_ID = outA.applicationId;
    const windowA = daysBetween(new Date().toISOString(), outA.claimExpiresAt);
    assert.equal(windowA, WINDOW_DAYS, "org A's window is its MSA's exclusivity_window_days");

    // Org B has no MSA at all — the hardcoded PARTNER_CLAIM_WINDOW_DAYS stands.
    const outB = await makePartnerCaller(PARTNER_ADMIN_B_AUTH).partnerSubmitCandidate(
      submitInput({
        fullName: "Bala Commercials",
        email: "bala.commercials@example.com",
        phone: "+919812341302",
      }),
    );
    assert.equal(outB.outcome, "created", "a second, different candidate → created");
    if (outB.outcome !== "created") return;
    APP_B_ID = outB.applicationId;
    const windowB = daysBetween(new Date().toISOString(), outB.claimExpiresAt);
    assert.equal(windowB, 90, "no MSA → the 90-day fallback");
  });

  it("Test 3: offer-accept accrues the fee once, with the terms frozen; no MSA accrues nothing", async () => {
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status, extended_at, accepted_at)
      VALUES
        (${PC_OFFER_A}, ${PC_TENANT}, ${APP_A_ID}, ${PC_MEMBERSHIP}, ${BASE_SALARY_PAISE},
         (now() + interval '30 days')::date, 'Remote-India', now() + interval '7 days',
         'accepted', now(), now())
    `;

    await runOfferAcceptSideEffects(poolSql, {
      tenantId: PC_TENANT,
      applicationId: APP_A_ID,
      offerId: PC_OFFER_A,
      log,
    });

    const fees = await poolSql<
      {
        id: string;
        fee_minor: string;
        fee_currency: string;
        status: string;
        msa_snapshot: Record<string, unknown>;
        // Timestamps come off the raw postgres.js client as strings, not Dates
        // (reality #113's read-side twin) — daysBetween parses them anyway.
        holdback_release_at: string | null;
        hired_at: string;
      }[]
    >`
      SELECT id, fee_minor, fee_currency, status, msa_snapshot, holdback_release_at, hired_at
      FROM public.partner_fees
      WHERE tenant_id = ${PC_TENANT} AND application_id = ${APP_A_ID}
    `;
    assert.equal(fees.length, 1, "exactly one fee accrued for the hire");
    const fee = fees[0];
    assert.ok(fee, "the fee row is readable");
    assert.equal(Number(fee.fee_minor), EXPECTED_FEE_MINOR, "20% of the annual base, in paise");
    assert.equal(fee.fee_currency, "INR");
    assert.equal(fee.status, "accrued", "a fresh accrual starts in the holdback window");
    assert.equal(fee.msa_snapshot.feeModel, "percentage_ctc", "the model is frozen on the row");
    assert.equal(Number(fee.msa_snapshot.feePercent), FEE_PERCENT, "the percent is frozen too");
    assert.equal(
      Number(fee.msa_snapshot.replacementGuaranteeDays),
      GUARANTEE_DAYS,
      "the guarantee is frozen",
    );
    assert.ok(fee.holdback_release_at, "the holdback release is stamped");
    assert.equal(
      daysBetween(fee.hired_at, fee.holdback_release_at),
      GUARANTEE_DAYS,
      "holdback releases the guarantee period after the hire",
    );

    // A retried accept must not double-accrue (uniq_partner_fees_application).
    await runOfferAcceptSideEffects(poolSql, {
      tenantId: PC_TENANT,
      applicationId: APP_A_ID,
      offerId: PC_OFFER_A,
      log,
    });
    const [again] = await poolSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM public.partner_fees
      WHERE tenant_id = ${PC_TENANT} AND application_id = ${APP_A_ID}
    `;
    assert.equal(again?.count, "1", "the unique index absorbs the retry");

    // A DIRECT application accrues nothing — there is no partner to pay.
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status, extended_at, accepted_at)
      VALUES
        (${PC_OFFER_DIRECT}, ${PC_TENANT}, ${PC_APP_DIRECT}, ${PC_MEMBERSHIP}, ${BASE_SALARY_PAISE},
         (now() + interval '30 days')::date, 'Remote-India', now() + interval '7 days',
         'accepted', now(), now())
    `;
    await runOfferAcceptSideEffects(poolSql, {
      tenantId: PC_TENANT,
      applicationId: PC_APP_DIRECT,
      offerId: PC_OFFER_DIRECT,
      log,
    });

    // A partner org with NO agreed terms accrues nothing either.
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status, extended_at, accepted_at)
      VALUES
        (${PC_OFFER_B}, ${PC_TENANT}, ${APP_B_ID}, ${PC_MEMBERSHIP}, ${BASE_SALARY_PAISE},
         (now() + interval '30 days')::date, 'Remote-India', now() + interval '7 days',
         'accepted', now(), now())
    `;
    await runOfferAcceptSideEffects(poolSql, {
      tenantId: PC_TENANT,
      applicationId: APP_B_ID,
      offerId: PC_OFFER_B,
      log,
    });

    const [total] = await poolSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM public.partner_fees WHERE tenant_id = ${PC_TENANT}
    `;
    assert.equal(total?.count, "1", "the direct app and the MSA-less org accrued nothing");
  });

  it("Test 4: partnerGetCommercials is org-admin only and never crosses orgs", async () => {
    const mine = await makePartnerCaller(PARTNER_ADMIN_A_AUTH).partnerGetCommercials();
    assert.equal(mine.fees.length, 1, "org A's admin sees their one accrued fee");
    const row = mine.fees[0];
    assert.ok(row, "the fee row is on the wire");
    assert.equal(row.feeMinor, EXPECTED_FEE_MINOR);
    assert.equal(row.candidateName, "Anita Commercials", "name-only privacy join");
    assert.equal(
      row.feeModel,
      "percentage_ctc",
      "the frozen terms ride along — it's their contract",
    );
    assert.equal(row.feePercent, FEE_PERCENT);
    assert.equal(mine.rollups.accruedMinor, EXPECTED_FEE_MINOR, "the rollup matches the row");
    assert.equal(mine.rollups.payableMinor, 0);
    assert.equal(mine.rollups.paidMinor, 0);
    assert.equal(mine.rollups.currency, "INR");
    // The internal-only fields are absent from the partner wire.
    assert.ok(!("msaId" in row), "no msa_id on the partner wire");
    assert.ok(!("notes" in row), "no internal notes on the partner wire");

    // A plain partner_user in the SAME org may not read commercials at all.
    await assert.rejects(
      makePartnerCaller(PARTNER_USER_A_AUTH).partnerGetCommercials(),
      (err: unknown) => err instanceof TRPCError && err.code === "FORBIDDEN",
      "partner_user is FORBIDDEN",
    );

    // Org B's admin sees org B's ledger — which is empty, not org A's.
    const theirs = await makePartnerCaller(PARTNER_ADMIN_B_AUTH).partnerGetCommercials();
    assert.equal(theirs.fees.length, 0, "org B has no fees of its own");
    assert.equal(theirs.rollups.accruedMinor, 0, "and no other org's totals");
  });

  it("Test 5: the internal read's rollups match its rows; another tenant's org is NOT_FOUND", async () => {
    const admin = makeInternalCaller(["admin"]);
    const out = await admin.getPartnerOrgCommercials({ partnerOrgId: PC_ORG_A });
    assert.equal(out.fees.length, 1, "one fee on the internal view too");
    const row = out.fees[0];
    assert.ok(row, "the internal fee row is readable");
    assert.equal(row.msaId, out.msa?.msaId, "the fee points at the terms it was computed from");
    assert.equal(row.requisitionTitle, "Synth Commercials Engineer");
    assert.equal(
      out.rollups.accruedMinor,
      out.fees.reduce((sum, f) => (f.status === "accrued" ? sum + f.feeMinor : sum), 0),
      "the accrued rollup is the sum of the accrued rows",
    );

    // Org B has terms-free honesty: no MSA, no fees, zeroed rollups.
    const orgB = await admin.getPartnerOrgCommercials({ partnerOrgId: PC_ORG_B });
    assert.equal(orgB.msa, null, "org B never agreed terms");
    assert.equal(orgB.fees.length, 0);
    assert.equal(orgB.rollups.accruedMinor, 0);

    await assert.rejects(
      admin.getPartnerOrgCommercials({ partnerOrgId: PC_ORG_OTHER_TENANT }),
      (err: unknown) => err instanceof TRPCError && err.code === "NOT_FOUND",
      "another tenant's org is indistinguishable from a nonexistent one",
    );
  });
});
