/**
 * P1.2 — partnerGetSubmissionDetail (+ the partnerListMySubmissions stage
 * filter behind the /submissions surface).
 *
 * Wireflows §3.8 promise the submitting partner a candidate detail view: the
 * ownership lock and its expiry, the live stage, the immutable snapshot of
 * what they submitted, and an event timeline. requirements.md §6.3 fences what
 * that timeline may carry — stage and date, never the recruiter's reason, the
 * actor's identity, or the transition metadata. Test 2 asserts that fence at
 * the row level (an exact key allowlist per timeline entry, plus a top-level
 * payload allowlist) so a future field addition has to answer the privacy
 * question in review.
 *
 * Authorization is ownership: another org's claim, another tenant's claim and
 * a claimId that doesn't exist all raise the IDENTICAL FORBIDDEN — the same
 * posture partnerGetRequisitionDetail takes, for the same reason (a partner
 * must not be able to probe who is in the platform).
 *
 * Harness follows partner-reqs.test.ts exactly (real appRouter via
 * createCaller, bare-sub partner ctx + internal ctx for the stage advance,
 * poolSql fixtures). Tests run in file order and share fixtures.
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

// a10 synth namespace (a09 = partner-reqs).
const SD_TENANT = "00000000-0000-4000-8000-0000000a10a1";
const SD_TENANT_B = "00000000-0000-4000-8000-0000000a10a2";
const SD_BU = "00000000-0000-4000-8000-0000000a10c1";
const SD_MEMBERSHIP = "00000000-0000-4000-8000-0000000a10c2";
const SD_POSITION = "00000000-0000-4000-8000-0000000a10c3";
const SD_JD = "00000000-0000-4000-8000-0000000a10c4";
const SD_REQ = "00000000-0000-4000-8000-0000000a10d1";
// Our org, plus a second org in the SAME tenant whose claim we must not read.
const SD_ORG = "00000000-0000-4000-8000-0000000a10b1";
const SD_ORG_OTHER = "00000000-0000-4000-8000-0000000a10b2";
const SD_PARTNER_USER = "00000000-0000-4000-8000-0000000a10e1";
const SD_OTHER_PERSON = "00000000-0000-4000-8000-0000000a10f1";
const SD_OTHER_CLAIM = "00000000-0000-4000-8000-0000000a10f2";
// Another tenant's claim — must be indistinguishable from a nonexistent one.
const SD_B_ORG = "00000000-0000-4000-8000-0000000a1091";
const SD_B_PERSON = "00000000-0000-4000-8000-0000000a1092";
const SD_B_CLAIM = "00000000-0000-4000-8000-0000000a1093";

const TENANT_SLUG = "synth-partner-subdetail";
const POSITION_TITLE = "Synth Submissions Engineer";
const JD_TEXT = "# Role\nTrack synthetic submissions end to end.";
const CANDIDATE_NAME = "Anjali Synth";
const CANDIDATE_EMAIL = "anjali.synth@example.com";
const NOTE_TO_RECRUITER = "Available in three weeks; strong on Java.";
const CURRENT_COMPANY = "Synth Systems";
const CONSENT_VERSION = "partner-msa-v1-test-p12";

const PARTNER_AUTH = randomUUID();
const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

let STORAGE_KEY: string;
let CLAIM_ID: string;

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
    requestId: `test-partner-subdetail-p-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

function makeInternalCaller(roles: string[]) {
  const ctx: HonoTRPCContext = {
    tenantId: SD_TENANT,
    userId: TEST_USER_FOR_FK,
    roles,
    claims: { sub: TEST_USER_FOR_FK, tid: SD_TENANT, tenant_slug: TENANT_SLUG, roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-subdetail-i-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function cleanup(): Promise<void> {
  for (const t of [SD_TENANT, SD_TENANT_B]) {
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

describe("P1.2 partnerGetSubmissionDetail", () => {
  beforeAll(async () => {
    resetStorageClient();

    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(
        `P1.2 prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found. Run pnpm db:seed:test-users first.`,
      );
    }
    TEST_USER_FOR_FK = user.id;

    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${SD_TENANT}, ${TENANT_SLUG}, 'Submission-Detail Synth', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${SD_BU}, ${SD_TENANT}, 'SD BU', 'sd-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${SD_MEMBERSHIP}, ${SD_TENANT}, ${TEST_USER_FOR_FK}, ARRAY['admin','recruiter']::tenant_role[], 'active', ${SD_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, level, function, location_type, primary_location, is_active) VALUES (${SD_POSITION}, ${SD_TENANT}, ${SD_BU}, ${POSITION_TITLE}, 'L4', 'Engineering', 'remote', 'Remote-India', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${SD_JD}, ${SD_TENANT}, ${SD_POSITION}, 1, ${JD_TEXT}, 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, number_of_openings, is_public, posted_at) VALUES (${SD_REQ}, ${SD_TENANT}, ${SD_POSITION}, ${SD_JD}, ${SD_MEMBERSHIP}, ${SD_MEMBERSHIP}, 'posted', 1, true, now())`;

    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${SD_ORG}, ${SD_TENANT}, 'SubmitView Synth', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${SD_ORG_OTHER}, ${SD_TENANT}, 'Rival Synth Partners', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${SD_PARTNER_USER}, ${SD_TENANT}, ${SD_ORG}, ${PARTNER_AUTH}, 'Sunil Synth', 'sunil@submitview.example', 'partner_admin', true)`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${SD_TENANT}, ${SD_ORG}, ${SD_REQ}, ${SD_MEMBERSHIP}, 'active')`;

    // A claim belonging to the OTHER org in our own tenant. No application —
    // authorization is decided on the claim row alone, so this is enough.
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised) VALUES (${SD_OTHER_PERSON}, ${SD_TENANT}, 'Rival Candidate', 'rival.candidate@example.com', 'rival.candidate@example.com')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, expires_at, status) VALUES (${SD_OTHER_CLAIM}, ${SD_TENANT}, ${SD_OTHER_PERSON}, ${SD_ORG_OTHER}, now() + interval '90 days', 'active')`;

    // Another tenant's fully-formed claim.
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${SD_TENANT_B}, 'synth-partner-subdetail-b', 'Submissions Other Tenant', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${SD_B_ORG}, ${SD_TENANT_B}, 'Other-Tenant Partners', 'empanelled', true)`;
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised) VALUES (${SD_B_PERSON}, ${SD_TENANT_B}, 'Other Tenant Candidate', 'other.tenant@example.com', 'other.tenant@example.com')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, expires_at, status) VALUES (${SD_B_CLAIM}, ${SD_TENANT_B}, ${SD_B_PERSON}, ${SD_B_ORG}, now() + interval '90 days', 'active')`;

    const cvBuffer = await readFile(SEED_CV_PATH);
    STORAGE_KEY = `resumes/${SD_TENANT}-p12.docx`;
    await getStorageClient().put(STORAGE_KEY, cvBuffer, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  afterAll(async () => {
    await cleanup();
    resetStorageClient();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: own claim returns candidate, req, stage and snapshot; the timeline grows on an internal advance", async () => {
    const partner = makePartnerCaller(PARTNER_AUTH);
    const submitted = await partner.partnerSubmitCandidate({
      requisitionId: SD_REQ,
      resumeUploadKey: STORAGE_KEY,
      candidate: {
        fullName: CANDIDATE_NAME,
        email: CANDIDATE_EMAIL,
        phone: "+919812341010",
        locationCountry: "IN",
        currentCompany: CURRENT_COMPANY,
        noteToRecruiter: NOTE_TO_RECRUITER,
      },
      consentAttested: true,
      ownershipAcknowledged: true,
      consentVersion: CONSENT_VERSION,
    });
    assert.equal(submitted.outcome, "created");
    if (submitted.outcome !== "created") return;
    CLAIM_ID = submitted.claimId;

    const before = await partner.partnerGetSubmissionDetail({ claimId: CLAIM_ID });

    assert.equal(before.claim.claimId, CLAIM_ID);
    assert.equal(before.claim.status, "active", "the ownership lock is live");
    assert.equal(before.claim.releasedAt, null, "an active claim has not been released");
    assert.ok(
      new Date(before.claim.expiresAt).getTime() > new Date(before.claim.claimedAt).getTime(),
      "the exclusivity window ends after it starts",
    );

    assert.equal(before.candidate.fullName, CANDIDATE_NAME, "the name THEY submitted");
    assert.equal(before.candidate.email, CANDIDATE_EMAIL);

    assert.equal(before.requisition?.requisitionId, SD_REQ);
    assert.equal(before.requisition?.title, POSITION_TITLE);
    assert.equal(before.requisition?.status, "posted");

    assert.equal(before.application?.applicationId, submitted.applicationId);
    assert.ok(before.application?.currentStage, "the live pipeline stage");
    assert.ok(before.application?.stageEnteredAt, "when it entered that stage");

    assert.ok(before.submittedSnapshot, "the partner's own submitted data comes back");
    assert.equal(before.submittedSnapshot?.noteToRecruiter, NOTE_TO_RECRUITER);
    assert.equal(before.submittedSnapshot?.currentCompany, CURRENT_COMPANY);
    assert.equal(before.submittedSnapshot?.consentVersion, CONSENT_VERSION);

    // An internal stage advance the partner had no part in must show up as one
    // more timeline entry — stage and date, nothing else.
    await makeInternalCaller(["recruiter"]).advanceApplication({
      applicationId: submitted.applicationId,
      targetStage: "shortlisted",
      reason: "Internal note the partner must never read",
    });

    const after = await partner.partnerGetSubmissionDetail({ claimId: CLAIM_ID });
    assert.equal(
      after.timeline.length,
      before.timeline.length + 1,
      "the advance added exactly one timeline entry",
    );
    assert.equal(after.application?.currentStage, "shortlisted", "the live stage moved");
    const last = after.timeline[after.timeline.length - 1];
    assert.equal(last?.toStage, "shortlisted", "the newest entry is the stage it moved into");

    const times = after.timeline.map((t) => new Date(t.transitionedAt).getTime());
    assert.deepEqual(
      [...times].sort((a, b) => a - b),
      times,
      "timeline is oldest-first",
    );
  });

  it("Test 2: timeline rows carry ONLY toStage + transitionedAt (§6.3 fence)", async () => {
    const out = await makePartnerCaller(PARTNER_AUTH).partnerGetSubmissionDetail({
      claimId: CLAIM_ID,
    });
    assert.ok(out.timeline.length > 0, "there is something to fence");

    for (const entry of out.timeline) {
      // Whole-object allowlist: a new timeline field must consciously pass this.
      assert.deepEqual(
        Object.keys(entry as Record<string, unknown>).sort(),
        ["toStage", "transitionedAt"],
        "a timeline entry is stage + date and nothing else",
      );
    }

    const keys = Object.keys(out as Record<string, unknown>);
    for (const forbidden of [
      "score",
      "aiScore",
      "topFactors",
      "recruiter",
      "recruiterName",
      "hiringManager",
      "feedback",
      "interviews",
      "rejectionReason",
      "otherPartners",
    ]) {
      assert.ok(!keys.includes(forbidden), `payload must not carry ${forbidden}`);
    }
    assert.deepEqual(
      keys.sort(),
      ["application", "candidate", "claim", "requisition", "submittedSnapshot", "timeline"],
      "unexpected top-level payload key — update the §6.3 review",
    );
  });

  it("Test 3: another org's claim, another tenant's claim and a nonexistent id raise the identical FORBIDDEN", async () => {
    const caller = makePartnerCaller(PARTNER_AUTH);
    const cases: [string, string][] = [
      [SD_OTHER_CLAIM, "another org's claim in the same tenant"],
      [SD_B_CLAIM, "another tenant's claim"],
      [randomUUID(), "nonexistent claim"],
    ];
    for (const [claimId, label] of cases) {
      await assert.rejects(
        caller.partnerGetSubmissionDetail({ claimId }),
        (err: unknown) =>
          err instanceof TRPCError &&
          err.code === "FORBIDDEN" &&
          err.message === "submission_not_found",
        `${label} → identical FORBIDDEN`,
      );
    }
  });

  it("Test 4: partnerListMySubmissions stage filter returns only matching rows; capped survives", async () => {
    const caller = makePartnerCaller(PARTNER_AUTH);

    const all = await caller.partnerListMySubmissions();
    assert.equal(all.capped, false, "the cap contract is unchanged");
    assert.equal(all.items.length, 1, "one submission, and no other org's");
    assert.equal(all.items[0]?.claimId, CLAIM_ID);

    const shortlisted = await caller.partnerListMySubmissions({ stage: "shortlisted" });
    assert.equal(shortlisted.items.length, 1, "the shortlisted submission matches");
    assert.equal(shortlisted.items[0]?.claimId, CLAIM_ID);
    assert.equal(shortlisted.capped, false, "`capped` is still reported when filtering");

    const techInterview = await caller.partnerListMySubmissions({ stage: "tech_interview" });
    assert.equal(techInterview.items.length, 0, "no submission sits at tech_interview");
    assert.equal(techInterview.capped, false);
  });
});
