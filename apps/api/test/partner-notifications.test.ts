/**
 * P0.4 — partner-facing notifications (submission received, stage change,
 * claim-expiry warning).
 *
 * Before this ticket a sourcing partner received exactly one email ever: their
 * invitation. They submitted a candidate into a black box. These three emails
 * are the whole feedback loop, and the thing that makes them safe to send is
 * what they DON'T carry — requirements.md §6.3 allows stage + date + candidate
 * name to a partner and nothing else, so Test 5 asserts the ABSENCE of the
 * fields (reason, score, feedback, interviewer) that would make this a leak.
 *
 * What is under test is the ENQUEUE, not the delivery: every assertion reads
 * notification_outbox, which is where the api's obligation ends (the worker's
 * dispatch is its own suite). dedup_key is asserted explicitly on every row
 * because the partial unique on (tenant_id, dedup_key) is the only thing
 * standing between "one email per event" and a partner being spammed every
 * time a recruiter bounces a candidate between two stages.
 *
 * Harness: the real appRouter via createCaller with two synthetic contexts —
 * a PARTNER one (a bare verified `sub`; partnerProcedure resolves org + tenant
 * from partner_users) and an INTERNAL one (tenantId + roles + claims, so
 * protectedProcedure opens withTenantContext and RLS/audit behave as they do
 * behind a JWT). Fixtures follow partner-submission.test.ts; the worker half
 * is imported over the relative path, the convention partner-claims.test.ts
 * documents (apps/workers has no vitest setup of its own).
 *
 * Cross-tenant caveat, inherited from the sweep it extends:
 * warnExpiringOwnershipClaims is service-role and global BY DESIGN, so a run
 * here can also warn about ambient claims in other tenants. Every assertion is
 * therefore per-fixture (by dedup_key / tenant), never a global count.
 *
 * Tests run in file order and share fixtures (house convention): Test 1's
 * submission creates the application Tests 2–5 transition.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";
import { resetStorageClient, getStorageClient } from "../src/lib/storage";
import { warnExpiringOwnershipClaims } from "../../../apps/workers/src/jobs/ownership-claim-sweep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SEED_CV_PATH = resolve(
  here,
  "../../../packages/ai-client/test/fixtures/resumes/Variant_1_Traditional_Single_Column.docx",
);

// a07 synth namespace (a02 partner-auth, a03 partner-submission, a04
// partner-admin, a05 partner-invite-accept, a06 partner-claims).
const PN_TENANT = "00000000-0000-4000-8000-0000000a07a1";
const PN_BU = "00000000-0000-4000-8000-0000000a07c1";
const PN_MEMBERSHIP = "00000000-0000-4000-8000-0000000a07c2";
const PN_POSITION = "00000000-0000-4000-8000-0000000a07c3";
const PN_JD = "00000000-0000-4000-8000-0000000a07c4";
const PN_REQ = "00000000-0000-4000-8000-0000000a07d1";
const PN_ORG = "00000000-0000-4000-8000-0000000a07b1";
const PN_PARTNER_USER = "00000000-0000-4000-8000-0000000a07e1";

// The direct (non-partner) application — the negative control for Test 4.
const PN_PERSON_DIRECT = "00000000-0000-4000-8000-0000000a07f1";
const PN_CANDIDATE_DIRECT = "00000000-0000-4000-8000-0000000a07f2";
const PN_APP_DIRECT = "00000000-0000-4000-8000-0000000a07f3";

// Claim-expiry fixtures (Test 6). One person per claim — the partial unique
// index allows only one ACTIVE claim per (tenant, person).
const PN_PERSON_SOON = "00000000-0000-4000-8000-0000000a0791";
const PN_PERSON_LATER = "00000000-0000-4000-8000-0000000a0792";
const PN_CLAIM_SOON = "00000000-0000-4000-8000-0000000a0793";
const PN_CLAIM_LATER = "00000000-0000-4000-8000-0000000a0794";

const TENANT_SLUG = "synth-partner-notify";
const COMPANY_NAME = "Partner-Notify Synth";
const POSITION_TITLE = "Synth Notify Engineer";
const PARTNER_EMAIL = "nisha@brightsource.example";
const PARTNER_NAME = "Nisha Synth";

// No auth.users FK on partner_users.user_id, so a random uuid is a legitimate
// partner identity (same reasoning as partner-auth.test.ts).
const PARTNER_AUTH = randomUUID();

const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

const CANDIDATE_NAME = "Rahul Notify";
const CANDIDATE_EMAIL = "rahul.notify@example.com";
const CANDIDATE_PHONE = "+919812345678";
const CONSENT_VERSION = "partner-msa-v1-test";

let STORAGE_KEY: string;
/** The application Test 1 creates; Tests 2–5 transition it. */
let PARTNER_APP_ID: string;

const log = createLogger({ level: "error" });

/** Partner-portal caller: partnerProcedure resolves everything from userId. */
function makePartnerCaller(userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: { sub: userId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-notify-p-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

/** Internal-staff caller: the ctx protectedProcedure would build from a JWT. */
function makeInternalCaller(roles: string[]) {
  const ctx: HonoTRPCContext = {
    tenantId: PN_TENANT,
    userId: TEST_USER_FOR_FK,
    roles,
    claims: { sub: TEST_USER_FOR_FK, tid: PN_TENANT, tenant_slug: TENANT_SLUG, roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-notify-i-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

interface OutboxRow {
  id: string;
  recipient_type: string;
  recipient_email: string;
  template_key: string;
  dedup_key: string | null;
  template_data: Record<string, unknown>;
}

/** Every outbox row this tenant holds for a given dedup key. */
async function outboxByDedupKey(dedupKey: string): Promise<OutboxRow[]> {
  return poolSql<OutboxRow[]>`
    SELECT id, recipient_type, recipient_email, template_key, dedup_key, template_data
    FROM public.notification_outbox
    WHERE tenant_id = ${PN_TENANT} AND dedup_key = ${dedupKey}
  `;
}

/** Every partner-addressed row this tenant holds, for the negative controls. */
async function partnerOutboxRows(templateKey: string): Promise<OutboxRow[]> {
  return poolSql<OutboxRow[]>`
    SELECT id, recipient_type, recipient_email, template_key, dedup_key, template_data
    FROM public.notification_outbox
    WHERE tenant_id = ${PN_TENANT} AND template_key = ${templateKey}
    ORDER BY created_at
  `;
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.candidate_ownership_claims WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.partner_assignments WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.partner_users WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.partner_orgs WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${PN_TENANT}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${PN_TENANT}`;
}

describe("P0.4 partner-facing notifications", () => {
  beforeAll(async () => {
    resetStorageClient();

    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(
        `P0.4 prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found. Run pnpm db:seed:test-users first.`,
      );
    }
    TEST_USER_FOR_FK = user.id;

    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PN_TENANT}, ${TENANT_SLUG}, ${COMPANY_NAME}, 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PN_BU}, ${PN_TENANT}, 'PN BU', 'pn-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${PN_MEMBERSHIP}, ${PN_TENANT}, ${TEST_USER_FOR_FK}, ARRAY['admin','hr_ops','recruiter']::tenant_role[], 'active', ${PN_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${PN_POSITION}, ${PN_TENANT}, ${PN_BU}, ${POSITION_TITLE}, 'remote', 'Remote-India', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${PN_JD}, ${PN_TENANT}, ${PN_POSITION}, 1, '# JD', 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${PN_REQ}, ${PN_TENANT}, ${PN_POSITION}, ${PN_JD}, ${PN_MEMBERSHIP}, ${PN_MEMBERSHIP}, 'posted', true)`;

    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PN_ORG}, ${PN_TENANT}, 'BrightSource Synth', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PN_PARTNER_USER}, ${PN_TENANT}, ${PN_ORG}, ${PARTNER_AUTH}, ${PARTNER_NAME}, ${PARTNER_EMAIL}, 'partner_admin', true)`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PN_TENANT}, ${PN_ORG}, ${PN_REQ}, ${PN_MEMBERSHIP}, 'active')`;

    // The direct applicant — same req, no partner attribution at all.
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PN_PERSON_DIRECT}, ${PN_TENANT}, 'Direct Applicant', 'direct.applicant@example.com', 'direct.applicant@example.com', '+919800000501', '919800000501')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${PN_CANDIDATE_DIRECT}, ${PN_TENANT}, ${PN_PERSON_DIRECT}, 'career_site')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${PN_APP_DIRECT}, ${PN_TENANT}, ${PN_CANDIDATE_DIRECT}, ${PN_REQ}, 'career_site', 'recruiter_review')`;

    const cvBuffer = await readFile(SEED_CV_PATH);
    STORAGE_KEY = `resumes/${PN_TENANT}-p04.docx`;
    await getStorageClient().put(STORAGE_KEY, cvBuffer, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  afterAll(async () => {
    await cleanup();
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

  function submitInput() {
    return {
      requisitionId: PN_REQ,
      resumeUploadKey: STORAGE_KEY,
      candidate: {
        fullName: CANDIDATE_NAME,
        email: CANDIDATE_EMAIL,
        phone: CANDIDATE_PHONE,
        locationCountry: "IN",
      },
      consentAttested: true as const,
      ownershipAcknowledged: true as const,
      consentVersion: CONSENT_VERSION,
    };
  }

  it("Test 1: a `created` submission enqueues the receipt to the submitting partner user", async () => {
    const out = await makePartnerCaller(PARTNER_AUTH).partnerSubmitCandidate(submitInput());
    assert.equal(out.outcome, "created", "fresh candidate → created");
    if (out.outcome !== "created") return;
    PARTNER_APP_ID = out.applicationId;

    const rows = await outboxByDedupKey(`partner_submission:${PARTNER_APP_ID}`);
    assert.equal(rows.length, 1, "exactly one receipt enqueued");
    const row = rows[0]!;
    assert.equal(row.template_key, "partner.submission_received", "the P0.4 receipt template");
    assert.equal(row.recipient_type, "partner", "addressed as a partner recipient");
    assert.equal(row.recipient_email, PARTNER_EMAIL, "addressed to the SUBMITTING partner user");

    // The copy carries the candidate, the req and the client — and the client
    // is the tenant's display name, not the partner org's.
    assert.equal(row.template_data.candidateName, CANDIDATE_NAME, "candidate name bound");
    assert.equal(row.template_data.requisitionTitle, POSITION_TITLE, "requisition title bound");
    assert.equal(row.template_data.companyName, COMPANY_NAME, "hiring company bound");
    assert.equal(
      row.template_data.partnerContactName,
      PARTNER_NAME,
      "greets the submitting partner user by name",
    );
    assert.ok(
      typeof row.template_data.submittedAtFormatted === "string" &&
        row.template_data.submittedAtFormatted.length > 0,
      "a human submission date is bound",
    );
  });

  it("Test 2: re-submitting the same candidate on the same req does NOT duplicate the receipt", async () => {
    // Same partner, same req: the ownership claim is theirs and the
    // application already exists, so the dedup key is the same one — a second
    // enqueue must be a clean no-op, not a second email and not a 23505 that
    // takes the submission down with it.
    const out = await makePartnerCaller(PARTNER_AUTH).partnerSubmitCandidate(submitInput());
    assert.equal(out.outcome, "added_to_existing", "same partner, same req → added_to_existing");
    if (out.outcome !== "added_to_existing") return;
    assert.equal(out.applicationId, PARTNER_APP_ID, "the SAME application, not a new one");
    assert.equal(out.alreadyOnThisReq, true, "recognised as already on this req");

    const rows = await outboxByDedupKey(`partner_submission:${PARTNER_APP_ID}`);
    assert.equal(rows.length, 1, "still exactly one receipt");
  });

  it("Test 3: a NON-allowlisted stage transition tells the partner nothing", async () => {
    const internal = makeInternalCaller(["recruiter"]);
    const moved = await internal.advanceApplication({
      applicationId: PARTNER_APP_ID,
      targetStage: "recruiter_review",
    });
    assert.equal(moved.toStage, "recruiter_review", "the transition itself happened");

    const rows = await outboxByDedupKey(`partner_stage:${PARTNER_APP_ID}:recruiter_review`);
    assert.equal(rows.length, 0, "recruiter_review is internal workflow — no partner email");
    assert.equal(
      (await partnerOutboxRows("partner.stage_changed")).length,
      0,
      "no partner stage email exists at all yet",
    );
  });

  it("Test 4: an allowlisted transition emails the partner; a direct application does not", async () => {
    const internal = makeInternalCaller(["recruiter"]);
    await internal.advanceApplication({
      applicationId: PARTNER_APP_ID,
      targetStage: "shortlisted",
    });

    const rows = await outboxByDedupKey(`partner_stage:${PARTNER_APP_ID}:shortlisted`);
    assert.equal(rows.length, 1, "exactly one stage email for (application, shortlisted)");
    const row = rows[0]!;
    assert.equal(row.template_key, "partner.stage_changed", "the P0.4 stage template");
    assert.equal(row.recipient_type, "partner", "addressed as a partner recipient");
    assert.equal(row.recipient_email, PARTNER_EMAIL, "addressed to the submitting partner user");
    assert.equal(
      row.template_data.stageLabel,
      "Shortlisted",
      "the HUMAN stage label, not the enum",
    );
    assert.equal(row.template_data.isTerminal, false, "shortlisted is progress, not an ending");
    assert.equal(row.template_data.candidateName, CANDIDATE_NAME, "candidate name bound");

    // The direct applicant on the same requisition has no partner behind them,
    // so the same transition must produce nothing.
    await internal.advanceApplication({
      applicationId: PN_APP_DIRECT,
      targetStage: "shortlisted",
    });
    assert.equal(
      (await outboxByDedupKey(`partner_stage:${PN_APP_DIRECT}:shortlisted`)).length,
      0,
      "a direct (non-partner) application emails no partner",
    );
    assert.equal(
      (await partnerOutboxRows("partner.stage_changed")).length,
      1,
      "still only the partner-sourced application's email",
    );
  });

  it("Test 5: the stage email carries stage + date + name and NO internal detail", async () => {
    // The privacy contract (requirements.md §6.3) as an executable assertion:
    // a rejection reason is the single most likely thing to leak into partner
    // mail, so the terminal transition is the one worth checking.
    const internal = makeInternalCaller(["recruiter"]);
    await internal.rejectApplication({
      applicationId: PARTNER_APP_ID,
      reason: "Weak system-design depth; panel preferred another candidate",
    });

    const rows = await outboxByDedupKey(`partner_stage:${PARTNER_APP_ID}:recruiter_rejected`);
    assert.equal(rows.length, 1, "the terminal transition is partner-visible");
    const data = rows[0]!.template_data;

    assert.equal(data.isTerminal, true, "rejection is flagged terminal → neutral copy");
    assert.equal(data.stageLabel, "Not moving forward", "the neutral human label");

    const forbidden = [
      "reason",
      "rejectReason",
      "rejectionReason",
      "decisionReason",
      "score",
      "aiScore",
      "aiScoreExplanation",
      "topFactors",
      "feedback",
      "interviewerName",
      "interviewers",
      "panel",
      "notes",
      "internalNotes",
      "otherPartners",
    ];
    for (const key of forbidden) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(data, key),
        false,
        `partner template_data must not carry "${key}"`,
      );
    }
    // And nothing in the payload quotes the recruiter's private reason.
    assert.equal(
      JSON.stringify(data).includes("system-design"),
      false,
      "the recruiter's rejection reason never reaches the partner payload",
    );

    // Whole-payload allowlist: if a future edit adds a field to this template,
    // this fails and forces the privacy question to be answered deliberately.
    assert.deepEqual(
      Object.keys(data).sort(),
      [
        "candidateName",
        "changedAtFormatted",
        "companyName",
        "isTerminal",
        "partnerContactName",
        "requisitionTitle",
        "stageLabel",
      ],
      "the partner stage payload is exactly these seven fields",
    );
  });

  it("Test 6: warnExpiringOwnershipClaims warns once per claim, inside the window only", async () => {
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PN_PERSON_SOON}, ${PN_TENANT}, 'Expiring Soon', 'expiring.soon@example.com', 'expiring.soon@example.com', '+919800000601', '919800000601')`;
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PN_PERSON_LATER}, ${PN_TENANT}, 'Expiring Later', 'expiring.later@example.com', 'expiring.later@example.com', '+919800000602', '919800000602')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_via_partner_user_id, claimed_at, expires_at, status) VALUES (${PN_CLAIM_SOON}, ${PN_TENANT}, ${PN_PERSON_SOON}, ${PN_ORG}, ${PN_PARTNER_USER}, now() - interval '87 days', now() + interval '3 days', 'active')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_via_partner_user_id, claimed_at, expires_at, status) VALUES (${PN_CLAIM_LATER}, ${PN_TENANT}, ${PN_PERSON_LATER}, ${PN_ORG}, ${PN_PARTNER_USER}, now() - interval '60 days', now() + interval '30 days', 'active')`;

    const warned = await warnExpiringOwnershipClaims(poolSql);
    // Global count (the job is cross-tenant on purpose), so the only safe
    // assertion on it is that our row was in the batch.
    assert.ok(warned >= 1, `at least this file's expiring claim was warned (got ${warned})`);

    const soon = await outboxByDedupKey(`claim_expiry_warn:${PN_CLAIM_SOON}`);
    assert.equal(soon.length, 1, "the 3-days-out claim produced one warning");
    const row = soon[0]!;
    assert.equal(row.template_key, "partner.claim_expiry_warning", "the P0.4 warning template");
    assert.equal(row.recipient_type, "partner", "addressed as a partner recipient");
    assert.equal(row.recipient_email, PARTNER_EMAIL, "addressed to the CLAIMING partner user");
    assert.equal(row.template_data.candidateName, "Expiring Soon", "candidate name bound");
    assert.equal(row.template_data.companyName, COMPANY_NAME, "hiring company bound");
    assert.ok(
      typeof row.template_data.expiresAtFormatted === "string" &&
        row.template_data.expiresAtFormatted.length > 0,
      "a human expiry date is bound",
    );

    assert.equal(
      (await outboxByDedupKey(`claim_expiry_warn:${PN_CLAIM_LATER}`)).length,
      0,
      "a claim 30 days out is outside the 7-day window — no warning",
    );

    // Once per claim, EVER: the job re-runs every 15 minutes for the whole
    // seven days, and the dedup key is what stops that becoming 672 emails.
    await warnExpiringOwnershipClaims(poolSql);
    assert.equal(
      (await outboxByDedupKey(`claim_expiry_warn:${PN_CLAIM_SOON}`)).length,
      1,
      "a second pass adds nothing",
    );
    assert.equal(
      (await partnerOutboxRows("partner.claim_expiry_warning")).length,
      1,
      "still exactly one warning in this tenant",
    );
  });
});
