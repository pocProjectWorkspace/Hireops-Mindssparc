/**
 * PARTNER-02 — partner candidate submission (dedup + ownership + pipeline).
 *
 * Drives the real appRouter via createCaller with a synthetic partner
 * HonoTRPCContext (same harness as partner-auth.test.ts): a verified `userId`
 * (JWT sub) is all partnerProcedure needs — it resolves tenant/org/role from
 * partner_users itself. Storage is the in-memory client seeded with a real CV
 * fixture so the ingest's parse step doesn't throw.
 *
 * Coverage:
 *   1. Unassigned req → FORBIDDEN (assignment IS the authorization).
 *   2. Internal user (membership, no partner row) → FORBIDDEN.
 *   3. Outcome (a) created — person + candidate + application (source
 *      partner_empanelled, attributed to the org/user) + active ownership
 *      claim + dedup-attempt(allow_new) + ai_score_outbox enqueued.
 *   4. Outcome (c) added_to_existing — same partner, second req: a SECOND
 *      application under the SAME single active claim; no new claim.
 *   5. Outcome (b) duplicate_blocked — a candidate owned by ANOTHER partner:
 *      rejected, dedup-attempt(block_active_claim) recorded, nothing created
 *      for the blocked org.
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

// a03 synth namespace (partner-auth owns a02). Valid v4-format UUIDs.
const PS_TENANT = "00000000-0000-4000-8000-0000000a03a1";
const PS_BU = "00000000-0000-4000-8000-0000000a03c1";
const PS_MEMBERSHIP = "00000000-0000-4000-8000-0000000a03c2";
const PS_POSITION = "00000000-0000-4000-8000-0000000a03c3";
const PS_JD = "00000000-0000-4000-8000-0000000a03c4";
const PS_REQ_1 = "00000000-0000-4000-8000-0000000a03d1"; // assigned to ORG_1
const PS_REQ_2 = "00000000-0000-4000-8000-0000000a03d2"; // assigned to ORG_1
const PS_REQ_UNASSIGNED = "00000000-0000-4000-8000-0000000a03d3"; // NOT assigned to ORG_1
const PS_ORG_1 = "00000000-0000-4000-8000-0000000a03b1";
const PS_ORG_2 = "00000000-0000-4000-8000-0000000a03b2";
const PS_PARTNER_USER_1 = "00000000-0000-4000-8000-0000000a03e1";
const PS_PERSON_OWNED_BY_2 = "00000000-0000-4000-8000-0000000a03f1";
const PS_CLAIM_ORG2 = "00000000-0000-4000-8000-0000000a03f2";

const PARTNER_AUTH_1 = randomUUID(); // active partner_admin in ORG_1

const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

const CANDIDATE_EMAIL = "priya.candidate@example.com";
const CANDIDATE_PHONE = "+919812345670";
const BLOCKED_EMAIL = "already.owned@example.com";
const CONSENT_VERSION = "partner-msa-v1-test";

let STORAGE_KEY: string;

const log = createLogger({ level: "error" });

function makeCaller(userId: string | null) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: userId ? { sub: userId } : null,
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-submit-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.candidate_ownership_claims WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.partner_assignments WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.partner_users WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.partner_orgs WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${PS_TENANT}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${PS_TENANT}`;
}

describe("PARTNER-02 partner candidate submission", () => {
  beforeAll(async () => {
    resetStorageClient();

    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(
        `PARTNER-02 prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found. Run pnpm db:seed:test-users first.`,
      );
    }
    TEST_USER_FOR_FK = user.id;

    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PS_TENANT}, 'synth-partner-submit', 'Partner-Submit Synth', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PS_BU}, ${PS_TENANT}, 'PS BU', 'ps-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${PS_MEMBERSHIP}, ${PS_TENANT}, ${TEST_USER_FOR_FK}, ARRAY['recruiter']::tenant_role[], 'active', ${PS_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${PS_POSITION}, ${PS_TENANT}, ${PS_BU}, 'Synth Engineer', 'remote', 'Remote-India', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${PS_JD}, ${PS_TENANT}, ${PS_POSITION}, 1, '# JD', 'approved')`;
    for (const rq of [PS_REQ_1, PS_REQ_2, PS_REQ_UNASSIGNED]) {
      await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${rq}, ${PS_TENANT}, ${PS_POSITION}, ${PS_JD}, ${PS_MEMBERSHIP}, ${PS_MEMBERSHIP}, 'posted', true)`;
    }

    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PS_ORG_1}, ${PS_TENANT}, 'TalentBridge Synth', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PS_ORG_2}, ${PS_TENANT}, 'Rival Partners', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PS_PARTNER_USER_1}, ${PS_TENANT}, ${PS_ORG_1}, ${PARTNER_AUTH_1}, 'Asha Synth', 'asha@talentbridge.example', 'partner_admin', true)`;

    // ORG_1 assigned to REQ_1 + REQ_2 only. REQ_UNASSIGNED stays unassigned.
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PS_TENANT}, ${PS_ORG_1}, ${PS_REQ_1}, ${PS_MEMBERSHIP}, 'active')`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PS_TENANT}, ${PS_ORG_1}, ${PS_REQ_2}, ${PS_MEMBERSHIP}, 'active')`;

    // A person already owned by ORG_2 (an active claim) for the block test.
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PS_PERSON_OWNED_BY_2}, ${PS_TENANT}, 'Owned Already', ${BLOCKED_EMAIL}, ${BLOCKED_EMAIL}, '+919800000000', '919800000000')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_at, expires_at, status) VALUES (${PS_CLAIM_ORG2}, ${PS_TENANT}, ${PS_PERSON_OWNED_BY_2}, ${PS_ORG_2}, now() - interval '10 days', now() + interval '80 days', 'active')`;

    const cvBuffer = await readFile(SEED_CV_PATH);
    STORAGE_KEY = `resumes/${PS_TENANT}-ps02.docx`;
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

  function baseInput(requisitionId: string, email: string) {
    return {
      requisitionId,
      resumeUploadKey: STORAGE_KEY,
      candidate: {
        fullName: "Priya Candidate",
        email,
        phone: CANDIDATE_PHONE,
        locationCountry: "IN",
      },
      consentAttested: true as const,
      ownershipAcknowledged: true as const,
      consentVersion: CONSENT_VERSION,
    };
  }

  async function expectCode(fn: () => Promise<unknown>, code: string, label: string) {
    let thrown: unknown;
    try {
      await fn();
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof TRPCError, `${label}: expected a TRPCError, got ${String(thrown)}`);
    assert.equal((thrown as TRPCError).code, code, `${label}: wrong code`);
  }

  it("Test 1: submitting against an UNASSIGNED req → FORBIDDEN", async () => {
    await expectCode(
      () =>
        makeCaller(PARTNER_AUTH_1).partnerSubmitCandidate(
          baseInput(PS_REQ_UNASSIGNED, CANDIDATE_EMAIL),
        ),
      "FORBIDDEN",
      "unassigned req",
    );
    // Nothing created for the unassigned attempt.
    const countRows = await poolSql<{ count: string }[]>`
      SELECT count(*)::text FROM public.applications WHERE tenant_id = ${PS_TENANT} AND requisition_id = ${PS_REQ_UNASSIGNED}
    `;
    assert.equal(countRows[0]!.count, "0", "unassigned submit must not create an application");
  });

  it("Test 2: internal user (membership, no partner row) → FORBIDDEN", async () => {
    await expectCode(
      () =>
        makeCaller(TEST_USER_FOR_FK).partnerSubmitCandidate(baseInput(PS_REQ_1, CANDIDATE_EMAIL)),
      "FORBIDDEN",
      "internal user",
    );
  });

  it("Test 3: outcome created — full pipeline entry + claim + dedup + scoring", async () => {
    const out = await makeCaller(PARTNER_AUTH_1).partnerSubmitCandidate(
      baseInput(PS_REQ_1, CANDIDATE_EMAIL),
    );
    assert.equal(out.outcome, "created", "fresh candidate → created");
    if (out.outcome !== "created") return;

    // Person + candidate + application all exist and are partner-attributed.
    const [app] = await poolSql<
      {
        id: string;
        source: string;
        source_partner_id: string | null;
        submitted_by_partner_user_id: string | null;
      }[]
    >`
      SELECT id, source, source_partner_id, submitted_by_partner_user_id
      FROM public.applications WHERE id = ${out.applicationId}
    `;
    assert.ok(app, "application row exists");
    assert.equal(app.source, "partner_empanelled", "source is partner_empanelled");
    assert.equal(app.source_partner_id, PS_ORG_1, "attributed to ORG_1");
    assert.equal(app.submitted_by_partner_user_id, PS_PARTNER_USER_1, "attributed to the user");

    // Exactly one ACTIVE claim for this person, owned by ORG_1.
    const claims = await poolSql<{ id: string; partner_org_id: string; status: string }[]>`
      SELECT id, partner_org_id, status FROM public.candidate_ownership_claims
      WHERE tenant_id = ${PS_TENANT} AND person_id = ${out.personId} AND status = 'active'
    `;
    assert.equal(claims.length, 1, "exactly one active claim");
    assert.equal(claims[0]!.partner_org_id, PS_ORG_1, "claim owned by ORG_1");
    assert.equal(claims[0]!.id, out.claimId);

    // Dedup attempt recorded as allow_new (brand-new person).
    const [dedup] = await poolSql<{ decision: string }[]>`
      SELECT decision FROM public.candidate_dedup_attempts
      WHERE tenant_id = ${PS_TENANT} AND matched_person_id IS NULL AND submitted_email = ${CANDIDATE_EMAIL}
      ORDER BY attempted_at DESC LIMIT 1
    `;
    assert.ok(dedup, "dedup attempt row exists");
    assert.equal(dedup.decision, "allow_new", "decision is allow_new");

    // AI scoring enqueued — same downstream treatment as a direct applicant.
    const countRows = await poolSql<{ count: string }[]>`
      SELECT count(*)::text FROM public.ai_score_outbox
      WHERE tenant_id = ${PS_TENANT} AND application_id = ${out.applicationId}
    `;
    assert.equal(countRows[0]!.count, "1", "ai_score_outbox row enqueued for the application");
  });

  it("Test 4: outcome added_to_existing — same partner, second req, one claim", async () => {
    // Depends on Test 3 having created the candidate + claim.
    const out = await makeCaller(PARTNER_AUTH_1).partnerSubmitCandidate(
      baseInput(PS_REQ_2, CANDIDATE_EMAIL),
    );
    assert.equal(out.outcome, "added_to_existing", "same partner, other req → added_to_existing");
    if (out.outcome !== "added_to_existing") return;
    assert.equal(out.alreadyOnThisReq, false, "this is a new req for the candidate");

    // Two applications now (REQ_1 + REQ_2), still ONE active claim.
    const apps = await poolSql<{ requisition_id: string }[]>`
      SELECT requisition_id FROM public.applications
      WHERE tenant_id = ${PS_TENANT} AND candidate_id = ${out.candidateId}
      ORDER BY requisition_id
    `;
    assert.equal(apps.length, 2, "two applications under the same candidate");
    const reqIds = apps.map((a) => a.requisition_id).sort();
    assert.deepEqual(reqIds, [PS_REQ_1, PS_REQ_2].sort());

    const claims = await poolSql<{ id: string }[]>`
      SELECT id FROM public.candidate_ownership_claims
      WHERE tenant_id = ${PS_TENANT} AND status = 'active' AND partner_org_id = ${PS_ORG_1}
    `;
    assert.equal(claims.length, 1, "still exactly one active claim (no second claim added)");
    assert.equal(claims[0]!.id, out.claimId, "same claim id returned");
  });

  it("Test 5: outcome duplicate_blocked — owned by another partner", async () => {
    const out = await makeCaller(PARTNER_AUTH_1).partnerSubmitCandidate(
      baseInput(PS_REQ_1, BLOCKED_EMAIL),
    );
    assert.equal(out.outcome, "duplicate_blocked", "owned by ORG_2 → blocked");
    if (out.outcome !== "duplicate_blocked") return;
    assert.ok(out.blockedDaysAgo >= 9 && out.blockedDaysAgo <= 11, "≈10 days ago");

    // No application created for ORG_1 against the blocked person.
    const countRows = await poolSql<{ count: string }[]>`
      SELECT count(*)::text FROM public.applications a
      JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = a.tenant_id
      WHERE a.tenant_id = ${PS_TENANT} AND c.person_id = ${PS_PERSON_OWNED_BY_2} AND a.source_partner_id = ${PS_ORG_1}
    `;
    assert.equal(countRows[0]!.count, "0", "blocked submission created no application for ORG_1");

    // The block is recorded as a dedup attempt.
    const [dedup] = await poolSql<{ decision: string }[]>`
      SELECT decision FROM public.candidate_dedup_attempts
      WHERE tenant_id = ${PS_TENANT} AND submitted_email = ${BLOCKED_EMAIL}
      ORDER BY attempted_at DESC LIMIT 1
    `;
    assert.ok(dedup, "dedup attempt row exists for the block");
    assert.equal(dedup.decision, "block_active_claim", "decision is block_active_claim");
  });
});
